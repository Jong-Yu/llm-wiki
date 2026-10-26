"""Explicit administrator policy plans, CAS application and immutable rollback evidence.

This is a local administrator operation, never an authenticated user's MCP capability.
All policy writers must use the same lock. Existing releases and tenant data are untouched.
"""

from copy import deepcopy
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import os
from pathlib import Path
import stat
import time
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from . import content, files
from .contracts import (ID, MAX_POLICY_BYTES, RulesetCompatibilityError,
                        RulesetConfigurationError, RulesetConflictError, RulesetBusyError)
from .store import read_release, reference, validate_policy


EMPTY = {"version": 1, "tenants": {}}
MAX_PLAN_BYTES = MAX_POLICY_BYTES * 6


def digest(raw):
    return sha256(raw).hexdigest()


def write_new(path, raw):
    """Create a private complete file once; no existing evidence is overwritten."""
    descriptor = os.open(files.safe(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    descriptor = os.open(files.safe(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class RulesetAdministration:
    def __init__(self, registry):
        self.registry = registry
        self.path = registry.policy_path
        # Never place policy history inside an immutable release tree.
        if self.path.is_relative_to(registry.root) or registry.root.is_relative_to(self.path):
            raise RulesetConfigurationError("Policy and release paths must be separate.")
        self.history = self.path.with_name(self.path.name + ".history")
        files.disjoint(self.history, registry.tenant_root)
        if self.history.is_relative_to(registry.root) or registry.root.is_relative_to(self.history):
            raise RulesetConfigurationError("Policy history and releases must be separate.")

    def snapshot(self):
        files.safe(self.registry.root_anchor)
        files.safe(self.registry.policy_anchor)
        if (self.registry.root_anchor.resolve() != self.registry.root
                or self.registry.policy_anchor.resolve() != self.path):
            raise RulesetConfigurationError("Administration paths changed.")
        try:
            raw = files.raw_file(self.path, MAX_POLICY_BYTES)
        except FileNotFoundError:
            return None, deepcopy(EMPTY), "absent"
        try:
            policy = validate_policy(files.json_bytes(raw))
        except (ValueError, TypeError, KeyError) as error:
            raise RulesetConfigurationError("The current policy is invalid.") from error
        return raw, policy, digest(raw)

    def release(self, key):
        if content.validator_fingerprint() != self.registry.validator_revision:
            raise RulesetCompatibilityError("Restart after validator changes.")
        return read_release(self.registry.root, key["ruleset_id"], key["ruleset_version"],
                            expected_schema=self.registry.expected_schema,
                            validator_revision=self.registry.validator_revision)

    def inspect(self, tenant=None, key=None):
        _, policy, revision = self.snapshot()
        result = {"policy_revision": revision, "root": str(self.registry.root),
                  "policy": str(self.path), "tenant_root": str(self.registry.tenant_root), "tenant": tenant,
                  "entry": policy["tenants"].get(tenant),
                  "validator_revision": self.registry.validator_revision}
        if key is not None:
            release = self.release(key)
            schema = release["components"]["diagnostics.schema.json"]["content"].encode()
            versions = [1] if schema == canonical_json_bytes(content.diagnostics_schema(1)) else [1, 2]
            result["release"] = {**reference(release), "diagnostics_versions": versions,
                                 "separate_semantic_check": 2 in versions,
                                 "schema_sha256": release["manifest"]["schema_sha256"]}
        return result

    def plan(self, *, tenant, key, expected_revision, reason, make_default=False):
        raw, policy, revision = self.snapshot()
        if revision != expected_revision:
            raise RulesetConflictError("Policy changed; inspect and prepare a new plan.")
        if type(tenant) is not str or not ID.fullmatch(tenant) or type(make_default) is not bool:
            raise RulesetConfigurationError("A valid tenant and explicit default choice are required.")
        self.release(key)
        updated = deepcopy(policy)
        entry = updated["tenants"].setdefault(tenant, {"default": key, "allowed": [], "revoked": []})
        if key in entry["revoked"]:
            raise RulesetConfigurationError("A revoked release cannot be implicitly reallowed.")
        if key not in entry["allowed"]:
            entry["allowed"].append(dict(key))
        if make_default:
            entry["default"] = dict(key)
        if policy == updated:
            raise RulesetConflictError("The requested policy is already in effect.")
        return self._plan(raw, canonical_json_bytes(updated), revision, reason, tenant, None)

    def _plan(self, before, after, revision, reason, tenant, rollback_of):
        if type(reason) is not str or not reason.strip() or len(reason) > 1000:
            raise RulesetConfigurationError("A bounded transition reason is required.")
        policy = validate_policy(files.json_bytes(after))
        if len(after) > MAX_POLICY_BYTES:
            raise RulesetConfigurationError("Policy byte limit exceeded.")
        # Bind releases newly enabled or selected, including the rollback default.
        entry = policy["tenants"].get(tenant)
        releases = []
        if entry:
            for key in entry["allowed"]:
                if key not in entry["revoked"]:
                    releases.append(reference(self.release(key)))
            if entry["default"] in entry["revoked"]:
                raise RulesetConfigurationError("The planned default is revoked.")
        return {"format_version": 1, "root": str(self.registry.root), "policy": str(self.path),
                "tenant_root": str(self.registry.tenant_root),
                "expected_policy_revision": revision, "before_text": before.decode() if before is not None else None,
                "after_text": after.decode(), "after_revision": digest(after), "tenant": tenant,
                "reason": reason, "rollback_of": rollback_of, "releases": releases,
                "validator_revision": self.registry.validator_revision}

    def rollback_plan(self, *, event_id, expected_revision, reason):
        event = self.event(event_id)
        raw, _, revision = self.snapshot()
        if revision != expected_revision or revision != event["after_revision"]:
            raise RulesetConflictError("Rollback requires the exact currently applied policy.")
        # First installation rolls back to an empty valid policy, never deletes a file.
        before = event["before_text"]
        after = before.encode() if before is not None else canonical_json_bytes(EMPTY)
        return self._plan(raw, after, revision, reason, event["tenant"], event_id)

    def event(self, event_id):
        if type(event_id) is not str or len(event_id) != 32 or any(c not in "0123456789abcdef" for c in event_id):
            raise RulesetConfigurationError("Invalid transition event ID.")
        path = files.safe(self.history / event_id)
        plan_raw = files.raw_file(path / "plan.json", MAX_PLAN_BYTES)
        manifest = files.json_bytes(files.raw_file(path / "manifest.json", 4096))
        if manifest.get("plan_sha256") != digest(plan_raw) or manifest.get("event_id") != event_id:
            raise RulesetConfigurationError("Transition history is corrupt.")
        plan = files.json_bytes(plan_raw)
        if (plan.get("root") != str(self.registry.root) or plan.get("policy") != str(self.path)
                or plan.get("tenant_root") != str(self.registry.tenant_root)):
            raise RulesetConfigurationError("Transition history belongs to a different deployment.")
        return plan

    def status(self, event_id):
        plan = self.event(event_id)
        _, _, revision = self.snapshot()
        return {"event_id": event_id, "policy_revision": revision,
                "matches_after": revision == plan["after_revision"],
                "matches_before": revision == plan["expected_policy_revision"],
                "note": "Current byte comparison; no inference that a previous response was delivered."}

    def apply(self, plan, *, lock_timeout=5.0):
        files.safe(self.path.parent)
        lock_path = files.safe(self.path.with_name(self.path.name + ".lock"))
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        staged, event_id = None, None
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise RulesetConfigurationError("Policy lock must be regular.")
            deadline = time.monotonic() + lock_timeout
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RulesetBusyError("Policy lock busy; retry the same plan later.")
                    time.sleep(0.05)
            raw, _, revision = self.snapshot()
            if plan.get("expected_policy_revision") != revision:
                raise RulesetConflictError("Policy changed; do not replace the plan revision.")
            if plan.get("root") != str(self.registry.root) or plan.get("policy") != str(self.path):
                raise RulesetConfigurationError("Plan belongs to a different deployment.")
            checked = self._plan(raw, plan["after_text"].encode(), revision, plan["reason"],
                                 plan["tenant"], plan["rollback_of"])
            if checked != plan:
                raise RulesetCompatibilityError("Plan bytes or release compatibility changed.")
            # An edited plan cannot mutate another tenant or smuggle arbitrary policy operations.
            before_policy = files.json_bytes(raw) if raw is not None else deepcopy(EMPTY)
            after_policy = files.json_bytes(plan["after_text"].encode())
            before_other, after_other = deepcopy(before_policy), deepcopy(after_policy)
            before_other["tenants"].pop(plan["tenant"], None)
            after_other["tenants"].pop(plan["tenant"], None)
            if before_other != after_other:
                raise RulesetConfigurationError("A transition must affect only the named tenant.")
            if plan["rollback_of"] is not None:
                expected = self.rollback_plan(event_id=plan["rollback_of"], expected_revision=revision, reason=plan["reason"])
                if expected != plan:
                    raise RulesetConfigurationError("Rollback bytes do not match history.")
            event_id = uuid4().hex
            files.safe(self.history).mkdir(mode=0o700, exist_ok=True)
            directory = self.history / event_id
            directory.mkdir(mode=0o700)
            plan_raw = canonical_json_bytes(plan)
            write_new(directory / "plan.json", plan_raw)
            write_new(directory / "manifest.json", canonical_json_bytes({"event_id": event_id,
                "issued_at": datetime.now(timezone.utc).isoformat(), "plan_sha256": digest(plan_raw)}))
            sync_directory(directory)
            sync_directory(self.history)
            sync_directory(self.path.parent)
            # History persistence is mandatory before changing the current policy.
            staged = self.path.with_name(self.path.name + "." + event_id + ".tmp")
            write_new(staged, plan["after_text"].encode())
            # Detect uncoordinated edits immediately before replacement as well.
            if self.snapshot()[2] != revision:
                raise RulesetConflictError("Policy changed during preparation.")
            os.replace(staged, self.path)
            staged = None
            result = {"applied": True, "event_id": event_id, "policy_revision": plan["after_revision"],
                      "previous_policy_revision": revision, "cleanup_failures": []}
            try:
                sync_directory(self.path.parent)
            except OSError as error:
                result["durability_warning"] = type(error).__name__
            return result
        except BaseException as error:
            if event_id is not None:
                error.transition_event_id = event_id
            if staged is not None:
                try:
                    staged.unlink(missing_ok=True)
                except OSError as cleanup_error:
                    error.cleanup_failures = [{"path": staged.name, "error_type": type(cleanup_error).__name__}]
            raise
        finally:
            os.close(descriptor)
