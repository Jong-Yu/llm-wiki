"""검토/정책 이벤트의 UUID와 UTC 시계가 사용하는 단일 생성 지점이다."""

# 판단 이벤트 번호(uuid4)와 UTC 시각을 한곳에서 사용한다.
# 판단 내용이 같아도 서로 다른 실행 사건이므로 이벤트 번호를 내용 hash로 대신하지 않는다.

from datetime import datetime, timezone
from uuid import uuid4
