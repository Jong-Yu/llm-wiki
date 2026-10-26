# 관리자가 불변 규약 한 버전을 발행하는 명령이다. 규약 발행과 tenant별 사용 허용 정책 변경은 별도다.
# 현재 서버의 제출 스키마를 함께 발행하므로 표시용 버전명만 맞추고 내용이 달라지는 것을 막는다.

"""서버 관리자용 공통 규약 발행 명령. tenant 정책은 자동으로 변경하지 않는다."""

import argparse
import json
from pathlib import Path

from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import reference
from core.runtime.extraction_schema import build_submission_schema


# 발행 경로·규약 ID/버전·이유를 명시한 요청만 처리하고 결과 참조를 JSON으로 출력한다.
def main():
    parser = argparse.ArgumentParser(description="Publish one immutable LLM Wiki extraction ruleset release.")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--tenant-root", type=Path, required=True)
    parser.add_argument("--ruleset-id", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--reason", required=True)
    args = parser.parse_args()
    schema = build_submission_schema()
    try:
        release = publish(args.root, tenant_root=args.tenant_root, ruleset_id=args.ruleset_id,
                          ruleset_version=args.version, reason=args.reason, schema=schema, expected_schema=schema)
    except (OSError, ValueError) as error:
        parser.error(getattr(error, "code", "publication_failed"))
    print(json.dumps({"published": True, **reference(release)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
