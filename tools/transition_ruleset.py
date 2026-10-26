"""Reviewable local administrator ruleset allowance/default transitions and rollback."""

import argparse
import json
from pathlib import Path

from core.common.json_codec import canonical_json_bytes
from core.modules.extraction_rules import files
from core.modules.extraction_rules.administration import RulesetAdministration, MAX_PLAN_BYTES, write_new
from core.modules.extraction_rules.store import RulesetRegistry
from core.runtime.extraction_schema import build_submission_schema


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--tenant-root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="Read current policy and optional release compatibility.")
    inspect.add_argument("--tenant")
    inspect.add_argument("--ruleset-id")
    inspect.add_argument("--version")
    plan = commands.add_parser("plan", help="Write a new reviewable plan; does not change the policy.")
    plan.add_argument("--tenant", required=True)
    plan.add_argument("--ruleset-id", required=True)
    plan.add_argument("--version", required=True)
    plan.add_argument("--make-default", action="store_true")
    rollback = commands.add_parser("rollback", help="Prepare rollback of the exact current transition.")
    rollback.add_argument("--event-id", required=True)
    for sub in (plan, rollback):
        sub.add_argument("--expected-policy-revision", required=True, help="SHA256 from inspect, or absent for first installation.")
        sub.add_argument("--reason", required=True)
        sub.add_argument("--output", type=Path, required=True, help="New private plan file; never overwritten.")
    apply = commands.add_parser("apply", help="Apply the reviewed plan under CAS after preserving the full previous policy.")
    apply.add_argument("--plan", type=Path, required=True)
    status = commands.add_parser("status", help="Compare a retained transition with current policy after uncertain output.")
    status.add_argument("--event-id", required=True)
    args = parser.parse_args()
    try:
        admin = RulesetAdministration(RulesetRegistry(args.root, args.policy, args.tenant_root,
                                                     expected_schema=build_submission_schema()))
        if args.command == "inspect":
            if (args.ruleset_id is None) != (args.version is None):
                parser.error("ruleset-id and version must be specified together")
            key = {"ruleset_id": args.ruleset_id, "ruleset_version": args.version} if args.ruleset_id else None
            value = admin.inspect(args.tenant, key)
        elif args.command == "apply":
            value = admin.apply(files.json_bytes(files.raw_file(args.plan, MAX_PLAN_BYTES)))
        elif args.command == "status":
            value = admin.status(args.event_id)
        else:
            common = dict(expected_revision=args.expected_policy_revision, reason=args.reason)
            if args.command == "plan":
                value = admin.plan(tenant=args.tenant, key={"ruleset_id": args.ruleset_id,
                    "ruleset_version": args.version}, make_default=args.make_default, **common)
            else:
                value = admin.rollback_plan(event_id=args.event_id, **common)
            write_new(args.output, canonical_json_bytes(value))
            value = {"planned": True, "plan_file": str(args.output.absolute()),
                     "expected_policy_revision": value["expected_policy_revision"],
                     "after_revision": value["after_revision"], "releases": value["releases"]}
    except (OSError, ValueError, TypeError, KeyError) as error:
        # Never print policy bytes, token material, or arbitrary file exception strings.
        detail = {"code": getattr(error, "code", "transition_failed")}
        for key in ("transition_event_id", "cleanup_failures"):
            if hasattr(error, key):
                detail[key] = getattr(error, key)
        parser.error(json.dumps(detail))
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    main()
