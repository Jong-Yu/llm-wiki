"""Indexed, personal notifications; originals and conversion reports stay immutable.

The tenant source lock orders source/report checks and SQLite CAS transactions. Only
references, page decisions and execution grants are copied here, never source text.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import base64
import json
import os
import re
import sqlite3
from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.modules.analysis_jobs import contracts as limits, records
from core.modules.analysis_jobs.contracts import JobConflictError, JobValidationError
from core.modules.sources import files
from core.modules.sources.store import SourceStore

LOW = 'ocr_low_or_missing_confidence_text_retained_manual_review_required'
PAGE = re.compile(r'^page ([1-9][0-9]*): ' + LOW + r'$')
SOURCE_KEYS = ('source_id', 'source_version', 'source_sha256', 'registration_revision')


def identity(*values):
    return canonical_json_hash(list(values))[:32]


def review_pages(manifest, components):
    """Only retained low-confidence pages are human-approvable; gaps/errors are not."""
    if manifest.get('complete') or not manifest.get('unread_ranges'):
        return []
    pages = []
    for warning in manifest['unread_ranges']:
        match = PAGE.fullmatch(warning)
        if not match:
            return []
        page = int(match[1])
        units = [unit for unit in manifest['units'] if unit['location'].get('kind') == 'pages'
                 and unit['location'].get('start') == page and unit['location'].get('end') == page]
        if len(units) != 1 or not components.get(units[0]['unit_id'], '').strip():
            return []
        pages.append(page)
    return sorted(set(pages))


class NotificationStore:
    def __init__(self, store, actor, *, rulesets=None, clock=None):
        self.store, self.actor, self.rulesets = store, actor, rulesets
        self.sources = SourceStore(store)
        self.scope = (actor['tenant'], actor['user_id'], actor['profile_id'])
        self.root = store.data_dir / '_notifications'
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def now(self):
        return self.clock().isoformat()

    @contextmanager
    def database(self):
        files.mkdir(self.store, self.root)
        path = self.root / 'notifications.sqlite3'
        for suffix in ('', '-wal', '-shm', '-journal'):
            files.checked(self.store, path.with_name(path.name + suffix))
        connection = None
        try:
            connection = sqlite3.connect(path, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.executescript('''
              PRAGMA foreign_keys=ON;
              CREATE TABLE IF NOT EXISTS workflows (
                tenant TEXT NOT NULL, user_id TEXT NOT NULL, profile TEXT NOT NULL,
                workflow_id TEXT NOT NULL, job_id TEXT, state TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY(tenant,user_id,profile,workflow_id));
              CREATE INDEX IF NOT EXISTS workflow_job ON workflows(tenant,user_id,profile,job_id);
              CREATE INDEX IF NOT EXISTS workflow_state ON workflows(tenant,user_id,profile,state);
              CREATE TABLE IF NOT EXISTS notifications (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,
                user_id TEXT NOT NULL, profile TEXT NOT NULL, notification_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL, kind TEXT NOT NULL, read_at TEXT, change_sequence INTEGER NOT NULL, value TEXT NOT NULL,
                UNIQUE(tenant,user_id,profile,notification_id));
              CREATE INDEX IF NOT EXISTS notification_page ON notifications(tenant,user_id,profile,sequence DESC);
              CREATE INDEX IF NOT EXISTS notification_unread ON notifications(tenant,user_id,profile,read_at,sequence DESC);
              CREATE INDEX IF NOT EXISTS notification_kind ON notifications(tenant,user_id,profile,kind,sequence DESC);
              CREATE INDEX IF NOT EXISTS notification_changes ON notifications(tenant,user_id,profile,change_sequence);
              CREATE TABLE IF NOT EXISTS changes (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,user_id TEXT NOT NULL,profile TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS changes_scope ON changes(tenant,user_id,profile,sequence DESC);
              CREATE TABLE IF NOT EXISTS reconciliation (
                tenant TEXT NOT NULL,user_id TEXT NOT NULL,profile TEXT NOT NULL,after_workflow TEXT NOT NULL,
                PRIMARY KEY(tenant,user_id,profile));
              CREATE TABLE IF NOT EXISTS conversion_heads (
                tenant TEXT NOT NULL,user_id TEXT NOT NULL,profile TEXT NOT NULL,source_id TEXT NOT NULL,
                source_version TEXT NOT NULL,conversion_id TEXT NOT NULL,created_at TEXT NOT NULL,
                PRIMARY KEY(tenant,user_id,profile,source_id,source_version));
              CREATE TABLE IF NOT EXISTS events (
                tenant TEXT NOT NULL,user_id TEXT NOT NULL,profile TEXT NOT NULL,
                workflow_id TEXT NOT NULL,event_id TEXT NOT NULL,value TEXT NOT NULL,
                PRIMARY KEY(tenant,user_id,profile,workflow_id,event_id));
              CREATE TABLE IF NOT EXISTS requests (
                tenant TEXT NOT NULL,user_id TEXT NOT NULL,profile TEXT NOT NULL,
                request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,response TEXT NOT NULL,
                PRIMARY KEY(tenant,user_id,profile,request_id));
            ''')
            connection.execute('BEGIN IMMEDIATE')
            yield connection
            connection.commit()
        except sqlite3.Error as error:
            if connection:
                connection.rollback()
            raise OSError('Notification metadata is unavailable') from error
        finally:
            if connection:
                connection.close()

    def _get(self, db, workflow_id):
        limits.identifier(workflow_id)
        row = db.execute('SELECT value FROM workflows WHERE tenant=? AND user_id=? AND profile=? AND workflow_id=?',
                         (*self.scope, workflow_id)).fetchone()
        if row is None:
            raise FileNotFoundError(workflow_id)
        return json.loads(row['value'])

    def _changed(self, db):
        return db.execute('INSERT INTO changes(tenant,user_id,profile) VALUES(?,?,?)', self.scope).lastrowid

    def _put(self, db, value):
        value.pop('revision', None)
        value['revision'] = canonical_json_hash(value)
        execution = value.get('execution') or {}
        db.execute('INSERT INTO workflows VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant,user_id,profile,workflow_id) '
                   'DO UPDATE SET value=excluded.value,job_id=excluded.job_id,state=excluded.state',
                   (*self.scope, value['workflow_id'], execution.get('job_id'), value['state'], json.dumps(value)))
        db.execute('UPDATE notifications SET change_sequence=? WHERE tenant=? AND user_id=? AND profile=? AND workflow_id=?',
                   (self._changed(db), *self.scope, value['workflow_id']))
        return value

    def _event(self, db, workflow, kind, event_id, *, timestamp=None, notify=False, origin='server', details=None):
        created = timestamp or self.now()
        value = dict(event_id=event_id, kind=kind, created_at=created, actor=self.actor, origin=origin, details=details or {})
        db.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)',
                   (*self.scope, workflow['workflow_id'], event_id, json.dumps(value)))
        if notify:
            item = dict(notification_id=identity(workflow['workflow_id'], event_id, kind),
                        workflow_id=workflow['workflow_id'], kind=kind, created_at=created,
                        title=workflow['title'], state=workflow['state'], warning_count=len(workflow['pages']),
                        source_ref=workflow['source_ref'], conversion_ref=workflow['conversion_ref'], origin=origin)
            db.execute('INSERT OR IGNORE INTO notifications(tenant,user_id,profile,notification_id,workflow_id,kind,change_sequence,value) '
                       'VALUES(?,?,?,?,?,?,?,?)', (*self.scope, item['notification_id'], workflow['workflow_id'], kind, self._changed(db), json.dumps(item)))

    def _source(self, reference):
        catalog = self.sources._get_source_locked(reference['source_id'])
        current = catalog['versions'][-1]
        if (catalog['registration_revision'] != reference['registration_revision']
                or catalog['current_version'] != reference['source_version']
                or current['source_sha256'] != reference['source_sha256']):
            raise JobConflictError('source_basis_changed')
        return catalog

    def _conversion(self, reference):
        from core.modules.analysis_plans.store import PlanStore
        manifest, revision, components = PlanStore(self.store, self.actor)._load_locked(
            'conversions', reference['conversion_id'], reference['conversion_revision'])
        return dict(manifest=manifest, revision=revision, components=components)

    def _basis_reason(self, value, *, source=True, db=None, cache=None):
        """Observe only current source/head metadata, without scanning old reports."""
        if value.get('blocked_reason'):
            return value['blocked_reason']
        cache = {} if cache is None else cache
        if source:
            key = ('source', canonical_json_hash(value['source_ref']))
            if key not in cache:
                try:
                    self._source(value['source_ref'])
                    cache[key] = None
                except (FileNotFoundError, JobConflictError):
                    cache[key] = 'source_changed'
            if cache[key]:
                return cache[key]
        if value['conversion_ref']:
            # This tiny publication pointer is written before the report. Even if
            # SQLite delivery is down/backlogged, a newer published report blocks
            # approval of an older report. An unpublished intent changes nothing.
            head_path = self.root / 'heads' / identity(*self.scope, value['source_ref']['source_id'])
            key = ('head', str(head_path))
            if key not in cache:
                try:
                    cache[key] = files.read_json(self.store, head_path)
                except FileNotFoundError:
                    cache[key] = None
            hint = cache[key]
            if hint and hint['conversion_id'] != value['conversion_ref']['conversion_id']:
                from core.modules.analysis_plans.store import PlanStore
                key = ('manifest', hint['conversion_id'])
                if key not in cache:
                    path = PlanStore(self.store, self.actor)._path('conversions', hint['conversion_id']) / 'manifest.json'
                    try:
                        cache[key] = files.read_json(self.store, path)
                    except FileNotFoundError:
                        cache[key] = None
                newer = cache[key]
                if newer and newer['source_ref'] == value['source_ref']:
                    return 'report_changed'
            if db is not None:
                head = db.execute('SELECT conversion_id FROM conversion_heads WHERE tenant=? AND user_id=? AND profile=? '
                    'AND source_id=? AND source_version=?', (*self.scope, value['source_ref']['source_id'], value['source_ref']['source_version'])).fetchone()
                if head and head['conversion_id'] != value['conversion_ref']['conversion_id']:
                    return 'report_changed'
        return None

    def _check(self, value, *, source=True, db=None):
        records.check_access(value['actor'], self.actor)
        if value['actor']['profile_id'] != self.actor['profile_id']:
            raise JobConflictError('access_basis_changed')
        reason = self._basis_reason(value, source=source, db=db)
        if reason:
            raise JobConflictError('source_basis_changed' if reason == 'source_changed' else 'conversion_basis_changed',
                                   blocked_reason=reason)
        if value['conversion_ref']:
            report = self._conversion(value['conversion_ref'])
            if report['manifest']['source_ref'] != value['source_ref']:
                raise JobConflictError('conversion_basis_changed')

    def _obsolete(self, db, value, reason):
        """Keep the approval and decision history; withdraw only an unstarted request."""
        execution = value.get('execution') or {}
        unstarted_claim = value['state'] == 'claimed' and not execution.get('consumed')
        if value.get('blocked_reason') or (value['state'] not in ('review', 'approved') and not unstarted_claim):
            return value
        value.update(state='stopped', blocked_reason=reason, updated_at=self.now())
        self._put(db, value)
        self._event(db, value, 'approval_obsolete', identity(value['workflow_id'], 'approval_obsolete'),
                    details={'blocked_reason': reason, 'source_ref': value['source_ref'],
                             'conversion_ref': value['conversion_ref']})
        return value

    def _reconcile_approvals_locked(self):
        # The state index selects only live approval requests, never historical
        # events/completed workflows. Source/head reads are shared within this pass.
        with self.database() as db:
            waiting = db.execute("SELECT value FROM workflows WHERE tenant=? AND user_id=? AND profile=? "
                                 "AND state IN ('review','approved','claimed')", self.scope).fetchall()
            cache = {}
            for row in waiting:
                value = json.loads(row['value'])
                reason = self._basis_reason(value, db=db, cache=cache)
                if reason:
                    self._obsolete(db, value, reason)
            prelaunch = db.execute("SELECT value FROM workflows WHERE tenant=? AND user_id=? AND profile=? "
                                   "AND state='claimed'", self.scope).fetchall()
            for row in prelaunch:
                value = json.loads(row['value'])
                execution = value['execution']
                if execution.get('consumed'):
                    continue
                expires = datetime.fromisoformat(execution['claimed_at']) + timedelta(minutes=5)
                if expires <= self.clock():
                    value.update(state='stopped', updated_at=self.now())
                    self._put(db, value)
                    self._event(db, value, 'stopped', identity(execution['claim_id'], 'prelaunch_expired'),
                                timestamp=expires.isoformat(), notify=True,
                                details={'reason': 'execution_not_started', 'claim_id': execution['claim_id']})

    def _new(self, workflow_id, source_ref, conversion_ref, title, pages, target=None):
        now = self.now()
        return dict(workflow_id=workflow_id, source_ref=source_ref, conversion_ref=conversion_ref,
                    title=title, pages=[dict(page=page, state='pending') for page in pages],
                    state='review' if pages else 'running', target_document=target,
                    actor=self.actor, approval=None, execution=None,
                    resume_request_id=identity('resume', *self.scope, workflow_id), created_at=now, updated_at=now)

    def ensure_locked(self, reference, *, title=None, target=None, origin='existing_report'):
        report = self._conversion(reference)
        manifest = report['manifest']
        pages = review_pages(manifest, report['components'])
        if not pages:
            raise JobValidationError('Only retained low-confidence pages can enter approval.')
        with self.database() as db:
            try:
                value = self._get(db, reference['conversion_id'])
                if value['conversion_ref'] != reference or value['source_ref'] != manifest['source_ref']:
                    raise JobConflictError('conversion_basis_changed')
                reason = self._basis_reason(value, db=db)
                if reason:
                    return self._obsolete(db, value, reason)
                self._check(value, db=db)
                if title and value['title'] == '문자 변환 확인':
                    value['title'] = title
                    value['updated_at'] = self.now()
                    self._put(db, value)
                if target:
                    if value['target_document'] not in (None, target):
                        raise JobConflictError('target_changed')
                    if value['target_document'] is None:
                        value['target_document'] = self._target(target)
                        value['updated_at'] = self.now()
                        self._put(db, value)
                return value
            except FileNotFoundError:
                value = self._new(reference['conversion_id'], manifest['source_ref'], reference,
                                  title or '문자 변환 확인', pages, self._target(target) if target else None)
                self._put(db, value)
                self._event(db, value, 'approval_required', identity('review', value['workflow_id']), notify=True, details={'initialization': origin})
                reason = self._basis_reason(value, db=db)
                if reason:
                    self._obsolete(db, value, reason)
                return value

    def _target(self, value):
        records.validate_targets(type('TargetStore', (), {'store': self.store})(), [value], ['wiki'])
        return value

    def create(self, body, authorize):
        payload = body.model_dump(exclude={'profile'})
        with self.sources._coordination_lock(create=True):
            self.actor = records.authorized(authorize, *self.scope[:2])
            self.reconcile_locked()
            digest = canonical_json_hash(payload)
            with self.database() as db:
                previous = db.execute('SELECT * FROM requests WHERE tenant=? AND user_id=? AND profile=? AND request_id=?',
                    (*self.scope, body.request_id)).fetchone()
                if previous:
                    if previous['payload_hash'] != digest:
                        raise JobConflictError('request_conflict')
                    return dict(workflow=self._get(db, payload['conversion_ref']['conversion_id']), replayed=True)
            report = self._conversion(payload['conversion_ref'])
            if report['manifest']['source_ref'] != payload['source_ref']:
                raise JobConflictError('conversion_basis_changed')
            value = self.ensure_locked(payload['conversion_ref'], title=payload['title'], target=payload.get('target_document'))
            with self.database() as db:
                db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?)', (*self.scope, body.request_id, digest, '{}'))
            return dict(workflow=value, replayed=False)

    def detail(self, workflow_id):
        with self.sources._coordination_lock(create=True):
            self.reconcile_locked()
            with self.database() as db:
                value = self._get(db, workflow_id)
            if (value.get('execution') or {}).get('job_id'):
                self.sync_job_locked(value['execution']['job_id'])
            with self.database() as db:
                value = self._get(db, workflow_id)
                events = [json.loads(row['value']) for row in db.execute(
                    'SELECT value FROM events WHERE tenant=? AND user_id=? AND profile=? AND workflow_id=? ORDER BY rowid',
                    (*self.scope, workflow_id))]
            conversion = self._conversion(value['conversion_ref']) if value['conversion_ref'] else None
            return dict(workflow=value, events=events, conversion=conversion)

    def list(self, *, filter='all', limit=30, cursor=None, after_seq=None, after_change_seq=None):
        if filter not in ('all', 'unread', 'approval') or not 1 <= limit <= 100:
            raise JobValidationError('Invalid notification filter or limit.')
        before = 2**63 - 1
        if cursor:
            try:
                decoded = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
                if decoded['scope'] != identity(*self.scope, filter) or type(decoded['before']) is not int:
                    raise ValueError()
                before = decoded['before']
            except (ValueError, KeyError, TypeError):
                raise JobValidationError('Invalid notification cursor.') from None
        with self.sources._coordination_lock(create=True):
            self.reconcile_locked()
            with self.database() as db:
                clause = " AND read_at IS NULL" if filter == 'unread' else " AND kind='approval_required' AND workflow_id IN (SELECT workflow_id FROM workflows WHERE tenant=? AND user_id=? AND profile=? AND state='review')" if filter == 'approval' else ''
                rows = db.execute('SELECT * FROM notifications WHERE tenant=? AND user_id=? AND profile=? '
                                  'AND sequence<? AND sequence>? AND change_sequence>?' + clause + ' ORDER BY sequence DESC LIMIT ?',
                                  (*self.scope, before, after_seq or 0, after_change_seq or 0, *(self.scope if filter == 'approval' else ()), limit + 1)).fetchall()
                counts = db.execute('SELECT count(*) AS unread FROM notifications WHERE tenant=? AND user_id=? '
                                    'AND profile=? AND read_at IS NULL', self.scope).fetchone()
                approvals = db.execute("SELECT count(*) FROM workflows WHERE tenant=? AND user_id=? AND profile=? "
                                       "AND state='review'", self.scope).fetchone()[0]
                latest = db.execute('SELECT coalesce(max(sequence),0) FROM notifications WHERE tenant=? AND user_id=? '
                                    'AND profile=?', self.scope).fetchone()[0]
                latest_change = db.execute('SELECT coalesce(max(sequence),0) FROM changes WHERE tenant=? AND user_id=? AND profile=?', self.scope).fetchone()[0]
                items = []
                for row in rows[:limit]:
                    current = self._get(db, row['workflow_id'])
                    items.append(dict(json.loads(row['value']), read_at=row['read_at'], sequence=row['sequence'], change_sequence=row['change_sequence'],
                                      state=current['state'], title=current['title'],
                                      **({'blocked_reason': current['blocked_reason']} if current.get('blocked_reason') else {})))
                next_cursor = None if len(rows) <= limit else base64.urlsafe_b64encode(json.dumps(
                    dict(scope=identity(*self.scope, filter), before=rows[limit - 1]['sequence'])).encode()).decode().rstrip('=')
                return dict(items=items, next_cursor=next_cursor, unread_count=counts['unread'],
                            approval_count=approvals, latest_sequence=latest, latest_change_sequence=latest_change)

    def read_flags(self, body, authorize):
        with self.sources._coordination_lock(create=True):
            records.authorized(authorize, *self.scope[:2])
            with self.database() as db:
                updated = 0
                for identifier in set(body.notification_ids):
                    limits.identifier(identifier)
                    updated += db.execute('UPDATE notifications SET read_at=?,change_sequence=? WHERE tenant=? AND user_id=? AND profile=? '
                                          'AND notification_id=?', (self.now() if body.read else None, self._changed(db), *self.scope, identifier)).rowcount
                return dict(updated=updated)

    def mutate(self, workflow_id, operation, body, authorize):
        payload = body.model_dump(exclude={'profile'})
        digest = canonical_json_hash(dict(workflow_id=workflow_id, operation=operation, **payload))
        with self.sources._coordination_lock(create=True):
            self.actor = records.authorized(authorize, *self.scope[:2])
            self.reconcile_locked()
            with self.database() as db:
                previous = db.execute('SELECT * FROM requests WHERE tenant=? AND user_id=? AND profile=? AND request_id=?',
                                      (*self.scope, body.request_id)).fetchone()
                if previous:
                    if previous['payload_hash'] != digest:
                        raise JobConflictError('request_conflict')
                    return dict(workflow=self._get(db, workflow_id), replayed=True)
                value = self._get(db, workflow_id)
                self._check(value, db=db)
                if value['revision'] != body.expected_revision:
                    raise JobConflictError('conflict', current_revision=value['revision'])
                if operation == 'pages':
                    if value['state'] != 'review':
                        raise JobConflictError('approval_already_final')
                    decisions = {entry.page: entry.state for entry in body.decisions}
                    if len(decisions) != len(body.decisions) or set(decisions) - {p['page'] for p in value['pages']}:
                        raise JobValidationError('Only distinct warned pages may be reviewed.')
                    value['pages'] = [dict(page=p['page'], state=decisions.get(p['page'], p['state'])) for p in value['pages']]
                elif operation == 'approve':
                    if value['state'] != 'review' or not value['pages'] or any(p['state'] != 'usable' for p in value['pages']):
                        raise JobConflictError('page_approval_required')
                    if body.target_document:
                        if value['target_document'] not in (None, body.target_document):
                            raise JobConflictError('target_changed')
                        value['target_document'] = self._target(body.target_document)
                    if not value['target_document']:
                        raise JobValidationError('An explicit target document is required before approval.')
                    value['approval'] = dict(request_id=body.request_id, approved_at=self.now(), actor=self.actor,
                        device_id=body.device_id, device_name=body.device_name, source_ref=value['source_ref'],
                        conversion_ref=value['conversion_ref'], target_document=value['target_document'],
                        pages=[dict(page) for page in value['pages']])
                    value['state'] = 'approved'
                elif operation == 'claim':
                    if value['state'] == 'approved' and not body.reclaim:
                        pass
                    elif body.reclaim and value['state'] in ('claimed', 'failed', 'stopped', 'running'):
                        execution = value.get('execution') or {}
                        if execution.get('job_id'):
                            from core.modules.analysis_jobs.store import JobStore
                            from core.modules.analysis_jobs import queries
                            jobs = JobStore(self.store, rulesets=self.rulesets, clock=self.clock)
                            job = records.owned_state(jobs, execution['job_id'], *self.scope[:2])
                            if job['state'] == 'cancelled':
                                raise JobConflictError('job_cancelled')
                            status = queries.project(jobs, job)
                            if status['result_summary']['status'] == 'complete':
                                raise JobConflictError('already_completed')
                            if status['lease_status'] == 'active' and job['reported_status'] not in ('failed', 'stopped'):
                                raise JobConflictError('already_claimed')
                        else:
                            from datetime import timedelta
                            if datetime.fromisoformat(execution['claimed_at']) + timedelta(minutes=5) > self.clock():
                                raise JobConflictError('already_claimed')
                    else:
                        raise JobConflictError('already_claimed' if value.get('execution') else 'approval_required')
                    prior = value.get('execution') or {}
                    value['execution'] = dict(claim_id=uuid4().hex, device_id=body.device_id, device_name=body.device_name,
                        claimed_at=self.now(), job_id=prior.get('job_id'), consumed=False, run_id=None)
                    value['state'] = 'claimed'
                elif operation == 'execution':
                    execution = value.get('execution') or {}
                    if execution.get('claim_id') != body.claim_id:
                        raise JobConflictError('execution_claim_changed')
                    from core.modules.analysis_jobs.store import JobStore
                    from core.modules.analysis_jobs.registration import registration
                    jobs = JobStore(self.store, rulesets=self.rulesets, clock=self.clock)
                    job = records.owned_state(jobs, body.job_id, *self.scope[:2])
                    registered = registration(job)
                    if (not registered or registered['conversion_ref'] != value['conversion_ref']
                            or {k: job['source_ref'][k] for k in SOURCE_KEYS} != value['source_ref']
                            or job['request_id'] != value['resume_request_id']
                            or job['targets'][0]['document'] != value['target_document']):
                        raise JobConflictError('execution_basis_changed')
                    if execution.get('job_id') not in (None, body.job_id):
                        raise JobConflictError('execution_already_linked')
                    execution['job_id'] = body.job_id
                else:
                    raise JobValidationError('Unknown notification operation.')
                value['updated_at'] = self.now()
                self._put(db, value)
                self._event(db, value, operation, body.request_id, details={**payload,
                    'source_ref': value['source_ref'], 'conversion_ref': value['conversion_ref'],
                    'resulting_revision': value['revision']})
                response = dict(workflow=value, replayed=False)
                db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?)', (*self.scope, body.request_id, digest, json.dumps(response)))
                return response

    def require_approval_locked(self, manifest, reference, *, request_id=None, target=None):
        """New marked reports and explicitly adopted old reports share the same gate."""
        with self.database() as db:
            try:
                value = self._get(db, reference['conversion_id'])
            except FileNotFoundError:
                if manifest.get('approval_workflow_id'):
                    raise JobConflictError('approval_required', workflow_id=reference['conversion_id'])
                return None
            if not value['pages'] and not manifest.get('approval_workflow_id'):
                return None
            self._check(value, db=db)
            if value['conversion_ref'] != reference or not value['approval']:
                raise JobConflictError('approval_required', workflow_id=value['workflow_id'])
            if request_id is not None and request_id != value['resume_request_id']:
                raise JobConflictError('resume_request_required', workflow_id=value['workflow_id'])
            if target is not None and target != value['target_document']:
                raise JobConflictError('target_changed')
            return value

    def consume_claim_locked(self, job, claim_id, run_id=None):
        from core.modules.analysis_jobs.registration import registration
        registration_value = registration(job)
        if not registration_value or not registration_value['conversion_ref']:
            if claim_id:
                raise JobConflictError('execution_claim_invalid')
            return
        reference = registration_value['conversion_ref']
        report = self._conversion(reference)
        value = self.require_approval_locked(report['manifest'], reference,
            request_id=job['request_id'], target=job['targets'][0]['document'])
        if value is None:
            if claim_id:
                raise JobConflictError('execution_claim_invalid')
            return
        with self.database() as db:
            value = self._get(db, value['workflow_id'])
            execution = value.get('execution') or {}
            if not claim_id or execution.get('claim_id') != claim_id or execution.get('job_id') != job['job_id']:
                raise JobConflictError('execution_claim_required', workflow_id=value['workflow_id'])
            if execution.get('consumed'):
                raise JobConflictError('execution_claim_consumed', workflow_id=value['workflow_id'])
            if run_id is None:
                return
            execution.update(consumed=True, run_id=run_id)
            value['state'] = 'running'; value['updated_at'] = self.now()
            self._put(db, value)
            self._event(db, value, 'execution_started', identity(claim_id, run_id), details=dict(execution))

    def stage_conversion_head_locked(self, source_ref, conversion_id):
        path = self.root / 'heads' / identity(*self.scope, source_ref['source_id'])
        files.write_json(self.store, path, dict(conversion_id=conversion_id))

    def pending_path(self, kind, identifier, event_id=None):
        key = identity(*self.scope, kind, identifier, event_id or '')
        return self.root / 'outbox' / identity(*self.scope) / (key + '.json')

    def stage_locked(self, kind, identifier, *, event_id=None):
        """Write a small durable pointer before canonical publication, never raw text."""
        path = self.pending_path(kind, identifier, event_id)
        files.write_json(self.store, path, dict(actor=self.actor, kind=kind, identifier=identifier, event_id=event_id))
        return path

    def deliver_locked(self, path):
        """Notification delivery cannot turn a successful canonical save into failure."""
        try:
            pointer = files.read_json(self.store, path)
            service = NotificationStore(self.store, pointer['actor'], rulesets=self.rulesets, clock=self.clock)
            reason = service._deliver(pointer)
            if reason:
                settled = service.root / 'outbox_settled' / identity(*service.scope) / path.name
                try:
                    previous = files.read_json(self.store, settled)
                except FileNotFoundError:
                    files.write_json(self.store, settled, dict(outbox=pointer, delivery_state='obsolete',
                        blocked_reason=reason, settled_at=self.now()))
                else:
                    if previous['outbox'] != pointer:
                        raise JobValidationError('The settled notification intent must not be overwritten.')
            files.checked(self.store, path).unlink(missing_ok=True)
            return True
        except (OSError, ValueError, KeyError, JobConflictError):
            # Rotate failed delivery attempts so one stale pointer cannot starve newer events.
            try:
                os.utime(files.checked(self.store, path), None)
            except OSError:
                pass
            return False

    def reconcile_locked(self):
        directory = self.root / 'outbox' / identity(*self.scope)
        # Only pending metadata is scanned; canonical reports/history are never scanned.
        names = files.entries(self.store, directory, maximum=10001)
        names.sort(key=lambda name: (directory / name).stat(follow_symlinks=False).st_mtime_ns)
        for name in names[:100]:
            if re.fullmatch(r'[a-f0-9]{32}\.json', name):
                path = directory / name
                pointer = files.read_json(self.store, path)
                actor = pointer['actor']
                if (actor['tenant'], actor['user_id'], actor['profile_id']) == self.scope:
                    self.deliver_locked(path)

        self._reconcile_approvals_locked()
        with self.database() as db:
            cursor = db.execute('SELECT after_workflow FROM reconciliation WHERE tenant=? AND user_id=? AND profile=?', self.scope).fetchone()
            after = cursor['after_workflow'] if cursor else ''
            query = ("SELECT workflow_id,job_id FROM workflows WHERE tenant=? AND user_id=? AND profile=? "
                     "AND state IN ('running','claimed') AND job_id IS NOT NULL AND workflow_id>? ORDER BY workflow_id LIMIT 100")
            active = db.execute(query, (*self.scope, after)).fetchall()
            if not active and after:
                active = db.execute(query, (*self.scope, '')).fetchall()
            db.execute('INSERT INTO reconciliation VALUES(?,?,?,?) ON CONFLICT(tenant,user_id,profile) '
                       'DO UPDATE SET after_workflow=excluded.after_workflow', (*self.scope, active[-1]['workflow_id'] if active else ''))
        from core.modules.analysis_jobs.store import JobStore
        jobs = JobStore(self.store, rulesets=self.rulesets, clock=self.clock)
        for row in active:
            job = records.owned_state(jobs, row['job_id'], *self.scope[:2])
            lease = records.lease(jobs, job)
            if lease and limits.instant(lease['expires_at']) <= self.clock():
                self.sync_job_locked(row['job_id'])

    def _deliver(self, pointer):
        if pointer['kind'] == 'conversion':
            from core.modules.analysis_plans.store import PlanStore
            try:
                manifest, revision, _ = PlanStore(self.store, self.actor)._load_locked('conversions', pointer['identifier'])
            except FileNotFoundError:
                return  # Interrupted before publication; a retry stages its own intent.
            with self.database() as db:
                db.execute('INSERT INTO conversion_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant,user_id,profile,source_id,source_version) '
                           'DO UPDATE SET conversion_id=excluded.conversion_id,created_at=excluded.created_at '
                           'WHERE excluded.created_at>conversion_heads.created_at', (*self.scope, manifest['source_ref']['source_id'],
                           manifest['source_ref']['source_version'], manifest['id'], manifest.get('created_at', self.now())))
            if manifest.get('approval_workflow_id'):
                self.ensure_locked(dict(conversion_id=manifest['id'], conversion_revision=revision), origin='conversion_published')
            self._reconcile_approvals_locked()
            with self.database() as db:
                return self._basis_reason(dict(source_ref=manifest['source_ref'],
                    conversion_ref=dict(conversion_id=manifest['id'], conversion_revision=revision)), db=db)
        elif pointer['kind'] == 'job':
            self.sync_job_locked(pointer['identifier'], event_id=pointer.get('event_id'))

    def sync_job_locked(self, job_id, *, event_id=None):
        from core.modules.analysis_jobs.store import JobStore
        from core.modules.analysis_jobs.registration import registration
        from core.modules.analysis_jobs import queries
        jobs = JobStore(self.store, rulesets=self.rulesets, clock=self.clock)
        try:
            job = records.owned_state(jobs, job_id, *self.scope[:2])
        except FileNotFoundError:
            return
        registered = registration(job)
        if not registered:
            return
        observed = queries.project(jobs, job)
        expired = job['state'] == 'claimed' and observed['lease_status'] == 'expired'
        state = ('complete' if observed['result_summary']['status'] == 'complete' else
                 'stopped' if expired or job['state'] == 'cancelled' or job['reported_status'] == 'stopped' else
                 'failed' if job['reported_status'] == 'failed' else 'running')
        reference = registered['conversion_ref']
        workflow_id = reference['conversion_id'] if reference else identity('job', job_id)
        with self.database() as db:
            try:
                value = self._get(db, workflow_id)
            except FileNotFoundError:
                value = self._new(workflow_id, {k: job['source_ref'][k] for k in SOURCE_KEYS}, reference,
                                  registered['title'], [], job['targets'][0]['document'])
            if value['pages'] and value['state'] == 'claimed' and not (value.get('execution') or {}).get('job_id'):
                return
            previous = canonical_json_hash(value)
            grant = value.get('execution') or {}
            interrupted = grant.get('consumed') and grant.get('run_id') != job['run_id'] and job['state'] == 'awaiting_cli'
            if interrupted:
                state = 'stopped'
            execution = value.get('execution') or dict(claim_id=None, device_id=None, device_name=None,
                                                       claimed_at=None, consumed=False, run_id=None)
            execution['job_id'] = job_id
            value['execution'] = execution
            # Job registration before CLI claim retains the server-issued grant state.
            awaiting_current_executor = value['pages'] and not execution.get('consumed')
            if value.get('blocked_reason') or awaiting_current_executor:
                state = value['state']
            elif value['state'] not in ('review', 'approved', 'claimed') or state in ('complete', 'failed', 'stopped'):
                value['state'] = state
            if canonical_json_hash(value) != previous:
                value['updated_at'] = self.now()
                self._put(db, value)
            event = next((e for e in job['events'] if e['event_id'] == event_id), None)
            kind = ('stopped' if event and (event['kind'] == 'cancelled' or event['details'].get('reported_status') == 'stopped') else
                    'failed' if event and event['details'].get('reported_status') == 'failed' else
                    'completed' if state == 'complete' else 'stopped' if expired or interrupted else None)
            if kind:
                self._event(db, value, kind, (identity(job_id, 'complete') if kind == 'completed' else
                            identity(job_id, execution.get('claim_id'), 'start_unconfirmed') if interrupted else
                            event_id or identity(job_id, job['run_id'], 'expired')),
                            timestamp=event['timestamp'] if event else observed.get('lease_expires_at') if expired else None, notify=True)

    def reported_event(self, body, authorize):
        """Client failure reports remain labeled reports, never evidence of completion."""
        payload = body.model_dump(exclude={'profile'})
        with self.sources._coordination_lock(create=True):
            self.actor = records.authorized(authorize, *self.scope[:2])
            self._source(payload['source_ref'])
            if payload.get('job_id'):
                from core.modules.analysis_jobs.store import JobStore
                job = records.owned_state(JobStore(self.store), payload['job_id'], *self.scope[:2])
                if {key: job['source_ref'][key] for key in SOURCE_KEYS} != payload['source_ref']:
                    raise JobConflictError('execution_basis_changed')
            if payload.get('conversion_ref'):
                report = self._conversion(payload['conversion_ref'])
                if report['manifest']['source_ref'] != payload['source_ref']:
                    raise JobConflictError('conversion_basis_changed')
            with self.database() as db:
                digest = canonical_json_hash(payload)
                previous = db.execute('SELECT payload_hash FROM requests WHERE tenant=? AND user_id=? AND profile=? AND request_id=?',
                                      (*self.scope, body.request_id)).fetchone()
                if previous:
                    if previous['payload_hash'] != digest:
                        raise JobConflictError('request_conflict')
                    return dict(replayed=True)
                workflow_id = payload['conversion_ref']['conversion_id'] if payload.get('conversion_ref') else identity('reported', body.request_id)
                try:
                    value = self._get(db, workflow_id)
                except FileNotFoundError:
                    value = self._new(workflow_id, payload['source_ref'], payload.get('conversion_ref'), body.title, [])
                    value['state'] = body.kind
                    self._put(db, value)
                self._event(db, value, body.kind, body.request_id, notify=True, origin='client_reported', details=payload)
                db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?)', (*self.scope, body.request_id, digest, '{}'))
                return dict(replayed=False)
