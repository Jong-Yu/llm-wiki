"""등록 원본의 불변 판본·카탈로그·요청 영수증을 보존한다."""

# 원본 파일 등록 기능의 묶음이다. 사용은 SourceStore에서 시작한다.
# 수신은 staging.py, 공개 저장은 commands.py, 목록/다운로드는 queries.py가 맡는다.
