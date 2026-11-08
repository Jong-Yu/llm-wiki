"""사람이 명시한 독립 관계를 원문 추출과 분리해 보존한다.

기존 review/policy 이벤트와 그래프는 재작성하지 않는다. 원문 근거 추가는
실제 인용을 검증하고, 업무 판단 추가는 정확한 관점과 Action log를 사용한다.
"""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from uuid import uuid4

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes, canonical_json_hash as digest
from core.modules.ontology.context import _context_selection
from .contracts import ReviewConflictError, ReviewValidationError, ReviewCorruptError, ReviewLimitError
from . import contracts
from .values import _actor, _reason, _token, _target_entities
from .state import _epoch, _scope
from .cleanup_state import identifier

FIELDS = {"id", "action", "kind", "request_id", "request_hash", "claim_id", "value", "entities", "scope",
          "reason", "actor", "timestamp", "source_revision", "graph_revision", "history_revision",
          "base_state_revision", "undo_of", "previous_hash", "hash"}


def validate(owner, ledger):
    """별도 전체 체인·근거 snapshot·역이벤트를 읽기와 저장 전에 대조한다."""
    entries = ledger.get("relation_events", [])
    if not isinstance(entries, list) or ("relation_events" in ledger and not entries):
        raise ReviewValidationError("Invalid authored relation journal")
    if len(entries) + len(ledger['events']) + len(ledger.get('cleanup_events', [])) > contracts.MAX_REVIEW_EVENTS:
        raise ReviewValidationError("Combined event limit exceeded")
    seen, requests, undone, previous = {}, set(), set(), None
    reserved = {event['id'] for event in ledger['events'] + ledger.get('cleanup_events', [])}
    for event in entries:
        if not isinstance(event, dict) or set(event) != FIELDS:
            raise ReviewValidationError("Invalid authored relation fields")
        for name in ('id', 'request_id'):
            identifier(event[name])
        for name in ('request_hash', 'claim_id', 'source_revision', 'graph_revision', 'history_revision', 'base_state_revision', 'hash'):
            _token(event[name], name)
        _actor(event['actor'])
        _reason(event['reason'])
        stamp = datetime.fromisoformat(event['timestamp'])
        request = (event['actor']['user_id'], event['request_id'])
        if (stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0 or event['id'] in seen
                or event['id'] in reserved or request in requests or event['scope'] != _scope(event['actor'])
                or event['previous_hash'] != previous
                or digest({key: value for key, value in event.items() if key != 'hash'}) != event['hash']):
            raise ReviewValidationError("Invalid authored relation identity or chain")
        if not isinstance(event['entities'], list) or not event['entities']:
            raise ReviewValidationError("Existing source endpoints are required")
        from core.modules.ontology.snapshots import _stored_graph
        _stored_graph(canonical_json_bytes({'schema_version': 3, 'document': ledger['document'], 'source_revision': event['source_revision'], 'entities': event['entities'], 'relations': [], 'attributes': [], 'relation_candidates': []}), ledger['document'])
        ids = {entity['id'] for entity in event['entities']}
        if len(ids) != len(event['entities']) or any(not isinstance(event['value'].get(key), str) or event['value'][key] not in ids for key in ('subject', 'object')):
            raise ReviewValidationError("Invalid authored endpoints")
        if event['kind'] == 'source':
            owner._check_saved_value(ledger['document'], event['value'], 'relations', event['entities'], event['source_revision'])
        elif event['kind'] == 'policy':
            owner._policy_value(event['value'], 'relations', ids, event['scope'], stored=True)
        else:
            raise ReviewValidationError("Unknown authored relation kind")
        if event['action'] == 'relation_create':
            if event['undo_of'] is not None or event['claim_id'] != digest({'authored_relation': event['id']}):
                raise ReviewValidationError("Invalid authored relation identity")
            if event['kind'] == 'policy' and event['value']['provenance']['event_id'] != event['id']:
                raise ReviewValidationError("Invalid authored policy provenance")
        elif event['action'] == 'relation_undo':
            original = seen.get(event['undo_of'])
            if (original is None or original['action'] != 'relation_create' or original['id'] in undone
                    or _epoch(original) != _epoch(event)
                    or any(event[key] != original[key] for key in ('kind', 'claim_id', 'value', 'entities'))
                    or (event['kind'] == 'policy' and original['scope'] != event['scope'])):
                raise ReviewValidationError("Invalid authored relation inverse")
            undone.add(original['id'])
        else:
            raise ReviewValidationError("Unknown authored relation action")
        seen[event['id']] = event
        requests.add(request)
        previous = event['hash']


def project(owner, source, snapshot, ledger, *, policies=True):
    """원시 claims/history를 보존하고 현재 유효 관계와 별도 추가 기록을 제공한다."""
    entries = ledger.get('relation_events', [])
    undone = {event['undo_of'] for event in entries if event['action'] == 'relation_undo'}
    requested = {key: snapshot['selection'][key] for key in ('domain', 'viewpoint')}
    summaries = []
    for event in entries:
        if event['action'] != 'relation_create':
            continue
        current = snapshot['status'] == 'ready' and _epoch(event) == _epoch(snapshot)
        status = ('inactive' if event['id'] in undone else 'pending' if not current else
                  'other_scope' if event['kind'] == 'policy' and event['scope'] != requested else 'active')
        summaries.append({'event_id': event['id'], 'claim_id': event['claim_id'], 'kind': event['kind'],
                          'status': status, 'scope': deepcopy(event['scope']), 'value': deepcopy(event['value'])})
        # 다른 관점의 현재 추가도 저장된 개체와 실제 근거의 무결성을 검사한다.
        if current:
            machine = snapshot['machine_graph']
            entities = {entity['id']: entity for entity in machine['entities']}
            if any(entities.get(entity['id']) != entity for entity in event['entities']):
                raise ReviewCorruptError('Authored endpoints differ from current generation')
            if event['kind'] == 'source':
                from .values import _input
                try:
                    normalized = owner._normalize(source, machine, 'relations', _input(event['value']))
                    if normalized != event['value']:
                        raise ValueError('Authored evidence differs from current source')
                except (ValueError, TypeError, KeyError) as error:
                    raise ReviewCorruptError('Authored relation evidence is invalid') from error
        if status != 'active' or (event['kind'] == 'policy' and not policies):
            continue
        value = deepcopy(event['value'])
        snapshot['effective_graph']['relations'].append(value)
        # 기존 claims는 추출/기존 검토 식별자 계약을 그대로 유지한다.
        snapshot['current_claims'].append({'claim_id': event['claim_id'], 'collection': 'relations',
            'value': value, 'reviewed_value': deepcopy(value), 'decision': 'policy' if event['kind'] == 'policy' else 'accept',
            'review_event_id': None, 'ambiguous': False, 'needs_review': False,
            'authored_event_id': event['id'], 'authored_kind': event['kind']})
    snapshot['authored_relations'] = summaries
    snapshot['relation_history'] = deepcopy(entries)
    snapshot['needs_review'] = snapshot['needs_review'] or any(item['status'] == 'pending' for item in summaries)
    snapshot['selection']['effective'] = _context_selection(snapshot['effective_graph'], **requested)


class RelationStore:
    """같은 WikiStore 잠금·복합 CAS·원자적 원장 저장을 사용한다."""
    def __init__(self, store, actor):
        from .store import ReviewStore
        _actor(actor)
        self.store, self.actor = store, deepcopy(actor)
        self.reviews = ReviewStore(store)
        self.scope = _scope(actor)

    def _find(self, ledger, request_id):
        return next((event for event in ledger.get('relation_events', []) if event['request_id'] == request_id and event['actor']['user_id'] == self.actor['user_id']), None)

    def _receipt(self, document, event, revision, *, replayed=True, failures=()):
        return {'document': document, 'request_id': event['request_id'], 'event_id': event['id'], 'claim_id': event['claim_id'],
                'saved': True, 'changed': not replayed, 'replayed': replayed, 'state_revision': revision,
                'cleanup_failures': cleanup_details(self.store.data_dir, failures)}

    def request(self, document, *, request_id):
        identifier(request_id)
        with self.store._write_lock():
            _, _, ledger, tokens = self.reviews._snapshot_locked(document)
            event = self._find(ledger, request_id)
            if event is None or event['scope'] != self.scope:
                raise FileNotFoundError('No relation receipt in this user and scope')
            return self._receipt(document, event, tokens['state_revision'])

    def create(self, document, *, kind, replacement, request_id, expected_state_revision, reason, before_commit=None):
        return self._mutate(document, 'relation_create', kind, request_id, expected_state_revision, reason,
                            replacement=replacement, before_commit=before_commit)

    def undo(self, document, *, kind, event_id, request_id, expected_state_revision, reason, before_commit=None):
        identifier(event_id)
        return self._mutate(document, 'relation_undo', kind, request_id, expected_state_revision, reason,
                            event_id=event_id, before_commit=before_commit)

    def _mutate(self, document, action, kind, request_id, expected_state_revision, reason, *, replacement=None, event_id=None, before_commit=None):
        identifier(request_id)
        _token(expected_state_revision, 'expected_state_revision')
        _reason(reason)
        if kind not in ('source', 'policy'):
            raise ReviewValidationError('Choose source evidence or expert policy')
        request_hash = digest(dict(document=document, action=action, kind=kind, scope=self.scope, reason=reason,
                                   expected_state_revision=expected_state_revision, replacement=replacement, event_id=event_id))
        failures = []
        try:
            with self.store._write_lock():
                source, raw, ledger, tokens = self.reviews._snapshot_locked(document)
                previous = self._find(ledger, request_id)
                if previous is not None:
                    if previous['request_hash'] != request_hash:
                        raise ReviewConflictError(document, request_hash, previous['request_hash'])
                    if before_commit is not None: before_commit()
                    return self._receipt(document, previous, tokens['state_revision'])
                if tokens['state_revision'] != expected_state_revision:
                    raise ReviewConflictError(document, expected_state_revision, tokens['state_revision'])
                if len(ledger['events']) + len(ledger.get('cleanup_events', [])) + len(ledger.get('relation_events', [])) >= contracts.MAX_REVIEW_EVENTS:
                    raise ReviewLimitError('Review history reached its event limit; nothing was discarded')
                snapshot = self.reviews._render(source, raw, ledger, tokens, **self.scope)
                machine = snapshot['machine_graph']
                if snapshot['status'] != 'ready' or machine.get('schema_version') not in (3, 4, 5, 6):
                    raise ReviewValidationError('A current extraction is required')
                identifier_value = uuid4().hex
                entries = ledger.setdefault('relation_events', [])
                if action == 'relation_create':
                    if not isinstance(replacement, dict) or any(not isinstance(replacement.get(key), str) for key in ('subject', 'object')):
                        raise ReviewValidationError('Select existing source entities')
                    ids = {entity['id'] for entity in machine['entities']}
                    if any(replacement[key] not in ids for key in ('subject', 'object')):
                        raise ReviewValidationError('Select existing source entities')
                    if kind == 'source':
                        value = self.reviews._normalize(source, machine, 'relations', replacement)
                    else:
                        self.reviews._policy_value(replacement, 'relations', ids, self.scope)
                        value = {**deepcopy(replacement), 'evidence': None, 'provenance': {'kind': 'expert_policy', 'event_id': identifier_value}}
                    entities = _target_entities(value, machine['entities'])
                    claim_id, undo_of = digest({'authored_relation': identifier_value}), None
                else:
                    original = next((event for event in entries if event['id'] == event_id), None)
                    if (original is None or original['action'] != 'relation_create' or original['kind'] != kind
                            or _epoch(original) != _epoch(tokens)
                            or (kind == 'policy' and original['scope'] != self.scope)
                            or any(event['undo_of'] == event_id for event in entries)):
                        raise ReviewValidationError('Select a current active addition in the authorized scope')
                    value, entities = deepcopy(original['value']), deepcopy(original['entities'])
                    claim_id, undo_of = original['claim_id'], original['id']
                event = {'id': identifier_value, 'action': action, 'kind': kind, 'request_id': request_id,
                         'request_hash': request_hash, 'claim_id': claim_id, 'value': value, 'entities': entities,
                         'scope': deepcopy(self.scope), 'reason': reason, 'actor': deepcopy(self.actor),
                         'timestamp': datetime.now(timezone.utc).isoformat(), 'base_state_revision': tokens['state_revision'],
                         **{key: tokens[key] for key in ('source_revision', 'graph_revision', 'history_revision')},
                         'undo_of': undo_of, 'previous_hash': entries[-1]['hash'] if entries else None}
                event['hash'] = digest(event)
                entries.append(event)
                self.reviews._ledger(canonical_json_bytes(ledger), document)
                self.reviews._validate_all_layers(source, raw, ledger, tokens)
                if before_commit is not None: before_commit()
                encoded = self.reviews._commit_locked(document, ledger, failures)
                tokens['review_revision'] = sha256(encoded).hexdigest()
                revision = digest({key: value for key, value in tokens.items() if key != 'state_revision'})
        except Exception as error:
            if failures: error.cleanup_failures = tuple(failures)
            raise
        return self._receipt(document, event, revision, replayed=False, failures=failures)
