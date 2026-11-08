# python -m core.runtime.http_cli로 시작하는 API+MCP 서버 실행 입구다.
# 실행 인자 → 현재 정책 검증 → 앱 조립 → Uvicorn 시작 순서이며, 다른 파일에서 import하는 것만으로 기동하지 않는다.

"""일반 읽기 API와 MCP를 제공하는 개인 인증 loopback 서버 실행."""

import argparse
import logging
from pathlib import Path
import uvicorn
from core.modules.access.policy import AccessPolicy, PolicyError
from core.modules.documents.store import DEFAULT_LOCK_TIMEOUT_SECONDS
from core.runtime.application import create_application
from core.runtime.http_security import HTTP_HOST
from core.runtime.http_metrics import enable_logging
from core.runtime.rulesets import configured_ruleset_paths, configured_rulesets


# argparse가 --port 같은 인자를 읽는다. 설정 검증을 마친 뒤에만 서버를 실행하며 로그에 접근 토큰을 출력하지 않는다.
def main():
    parser = argparse.ArgumentParser(description="Authenticated LLM Wiki API + MCP server (one worker).")
    parser.add_argument("--access-config", type=Path, required=True)
    parser.add_argument("--tenant-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--lock-timeout", type=float, default=DEFAULT_LOCK_TIMEOUT_SECONDS)
    parser.add_argument("--ruleset-root", type=Path)
    parser.add_argument("--ruleset-policy", type=Path)
    parser.add_argument("--ruleset-config", type=Path,
                        help="Explicit JSON file with absolute ruleset_root and ruleset_policy paths; cannot be combined with individual path options.")
    parser.add_argument("--credential-key-file", type=Path,
                        help="Protected credential encryption key outside tenant data; defaults to the auth service configuration.")
    parser.add_argument("--read-metrics", action="store_true",
                        help="Log privacy-safe HTTP timing, fixed stages and counters as JSON on stderr.")
    parser.add_argument("--tracked-read-index", action="store_true",
                        help="Use write-journal metadata snapshots with periodic full reconciliation; requires managed canonical writers.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be from 1 to 65535")
    logging.basicConfig(level=logging.WARNING)
    if args.read_metrics:
        enable_logging()
        logging.getLogger("core.ontology_index").setLevel(logging.INFO)
    try:
        ruleset_root, ruleset_policy = configured_ruleset_paths(
            args.ruleset_config, args.ruleset_root, args.ruleset_policy)
    except (OSError, ValueError, TypeError):
        parser.error("The explicit ruleset configuration is unavailable or invalid.")
    try:
        policy = AccessPolicy(args.access_config, args.tenant_root, lock_timeout_seconds=args.lock_timeout,
                              tracked_reads=args.tracked_read_index)
        policy.validate()
        app = create_application(policy, rulesets=configured_rulesets(ruleset_root, ruleset_policy, policy),
                                 credential_key_path=args.credential_key_file)
    except (PolicyError, OSError, ValueError, TypeError):
        parser.error("The current tenant policy or data root is unavailable.")
    uvicorn.run(app, host=HTTP_HOST, port=args.port, workers=1,
                log_level="warning", access_log=False, proxy_headers=False)


if __name__ == "__main__":
    main()
