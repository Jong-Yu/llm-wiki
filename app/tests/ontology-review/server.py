"""관계 검토 화면 검증용 실제 서버. 새 임시 폴더의 합성 자료만 사용한다."""
from pathlib import Path
import socket
import sys

import uvicorn
from tools.initialize_server import initialize_new_server
from core.modules.access.auth import AuthService
from core.modules.access.policy import AccessPolicy
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.runtime.application import create_application

root = Path(sys.argv[1])
if (root.parent.resolve() != root.parent or root.parent.parent != Path('/private/tmp')
        or not root.parent.name.startswith('wiki-review-ui-')
        or (root.parent / 'review-test-root').read_text() != 'isolated-review-ui-only'):
    raise RuntimeError('Only a new isolated relation review test directory is permitted')
config = initialize_new_server(root)
policy = AccessPolicy(config["access_config"], config["tenant_root"])
AuthService(policy).signup("관계 검증")
wiki = WikiStore(root / "data/sdv-platform")
ontology = OntologyStore(wiki)
reviews = ReviewStore(wiki)
actor = dict(user_id="fixture", tenant="sdv-platform", profile_id="default",
             domain=None, viewpoint=None, policy_revision="0" * 64)
body = "# 예약 처리 흐름\n\n예약 서비스는 일정 조회 서비스를 사용한다.\n일정 조회 서비스는 재고 서비스에 의존한다.\n재고 서비스는 예약 서비스를 사용한다.\n"
body += """
## 예약 확인
사용자가 날짜와 객실 수를 선택하면 예약 서비스가 일정 조회 서비스에 가능 여부를 요청한다.
조회 시점의 재고와 결제 완료 시점의 재고는 다를 수 있으므로, 조회 결과만으로 예약을 확정하지 않는다.

## 재고 반영
재고 서비스는 객실과 숙박 날짜별 남은 수량을 관리한다. 취소된 예약은 처리 기록을 확인한 뒤 재고에 반영한다.
응답을 받지 못한 경우 같은 예약을 새로 만들지 않고, 기존 요청의 처리 상태부터 확인한다.

## 적용 범위
이 문서는 온라인 예약의 조회 흐름을 설명한다. 현장 접수와 외부 제휴사의 예약 처리는 별도 운영 절차를 따른다.
운영자가 예외를 허용한 경우에도 원문의 설명과 운영 판단은 별도의 기록으로 남긴다.

## 검토 기준
서비스의 역할이 달라지면 기존 문서와 처리 기록을 함께 대조한다. 이름이 비슷하다는 이유만으로 서로 다른 서비스를 합치지 않는다.
변경 이유와 적용 시점을 남기고 이전 판단은 이력에서 확인할 수 있어야 한다.
"""
entities = [dict(id=key, label=label, type="system", evidence=body)
            for key, label in (("alpha", "예약 서비스"), ("beta", "일정 조회 서비스"), ("gamma", "재고 서비스"))]
relations = [dict(subject="alpha", predicate="uses", object="beta", evidence="예약 서비스는 일정 조회 서비스를 사용한다.")]
for name in ("review.md", "candidate.md", "past.md"):
    wiki.save(name, body, expected_revision=None)
    ontology.generate(name, wiki.read(name).revision, entities, relations,
       relation_candidates=[dict(id="candidate", subject="beta", predicate="depends_on", object="gamma", reason="합성 후보", question="원문 확인 필요", evidence=None)] if name == 'candidate.md' else [])
    if name == 'past.md':
        state=reviews.query(name)
        reviews.review(name, action='accept', claim_id=state['claims'][0]['claim_id'], expected_state_revision=state['state_revision'], reason='격리 과거 판단', actor=actor)
        current=wiki.read(name)
        wiki.save(name,current.content+'Changed.\n',expected_revision=current.revision)

app = create_application(policy)
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(128)
print(f"READY http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
