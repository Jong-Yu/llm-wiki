"""원문 판본에 연결된 기계 그래프의 검증·저장·제한된 조회.

서비스 import와 파일 접근은 호출자가 명시적으로 수행한다.
"""

# 읽는 순서: store.py의 OntologyStore → snapshots.py(기존 그래프 확인) → context.py/connections.py(조회 조합).
# constants.py는 허용 어휘/한도, values.py는 작은 값과 한정어, validation.py는 전체 추출 구조/인용, anchors.py는 인용 위치를 검사한다.
# 이 네 검증 파일의 원래 바이트는 extraction_rules.content.validator_fingerprint의 배포 지문에 포함된다.
# 그래프는 기계 추출 결과다. 사람의 검토·업무 판단을 반영한 답이 필요하면 reviews의 조회 결과도 확인한다.
