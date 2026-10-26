"""업무·실행·검증 도구가 공유하는 프로젝트 기본 경로.

파일 이동이 data나 .venv의 기준을 바꾸지 않도록 전송/runtime에 의존하지 않는
한 곳에서 계산한다. 경로만 제공하며 저장소·설정·서버를 초기화하지 않는다.
"""
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent.parent
# __file__은 이 파일의 위치다. resolve는 실제 경로, parent.parent는 두 단계 상위 폴더다.
# 이 기준을 공유하므로 명령 실행 폴더가 달라도 data/.venv 기본 위치가 흔들리지 않는다.
PROJECT_PYTHON = PROJECT_DIR / ".venv" / "bin" / "python"
DEFAULT_DATA_DIR = PROJECT_DIR / "data"
