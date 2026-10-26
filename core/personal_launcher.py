"""기존 개인 MCP 등록의 실행 경로를 유지하는 얇은 CLI 진입점."""

from core.runtime.personal_launcher import main


# 예전 python -m core.personal_launcher 명령의 입구다. 실제 옵션 처리/실행 구성은 runtime에 있다.
# SystemExit는 main이 반환한 종료 코드를 운영체제에 전달한다.
if __name__ == "__main__":
    raise SystemExit(main())
