"""Clean Up 화면 검증용 실제 서버. 새 임시 폴더의 합성 자료만 사용한다."""
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
        or not root.parent.name.startswith('wiki-cleanup-ui-')
        or (root.parent / 'cleanup-test-root').read_text() != 'isolated-cleanup-ui-only'):
    raise RuntimeError('Only a new isolated Clean Up test directory is permitted')
config = initialize_new_server(root)
policy = AccessPolicy(config["access_config"], config["tenant_root"])
AuthService(policy).signup("Clean Up 검증")
wiki = WikiStore(root / "data/sdv-platform")
ontology = OntologyStore(wiki)
reviews = ReviewStore(wiki)
actor = dict(user_id="fixture", tenant="sdv-platform", profile_id="default",
             domain=None, viewpoint=None, policy_revision="0" * 64)
body = "Alpha uses Beta.\nBeta depends on Alpha.\n"
entities = [dict(id=name.lower(), label=name, type="system", evidence=body.splitlines()[0])
            for name in ("Alpha", "Beta")]
relations = [dict(subject="alpha", predicate="uses", object="beta", evidence=body.splitlines()[0])]
candidate = dict(id="uncertain", subject="beta", predicate="depends_on", object="alpha",
                 reason="연관성은 제안되었으나 근거가 부족함", question="의존 관계인지 확인 필요")
for name in ("cleanup.md", "past.md", "empty.md"):
    wiki.save(name, body, expected_revision=None)
    ontology.generate(name, wiki.read(name).revision, entities, relations,
                      relation_candidates=[candidate] if name == "cleanup.md" else [])
    if name != "empty.md":
        current = reviews.query(name)
        reviews.review(name, action="reject" if name == "cleanup.md" else "accept",
                       claim_id=current["claims"][0]["claim_id"],
                       expected_state_revision=current["state_revision"],
                       reason="격리 검증용 모의 판단", actor=actor)
    if name == "past.md":
        current = wiki.read(name)
        wiki.save(name, current.content + "새 판본입니다.\n", expected_revision=current.revision)

# 미리보기 한도를 넘는 과거 검토를 만들어 실제 cursor 경로를 검사한다.
wiki.save('many.md', body, expected_revision=None)
ontology.generate('many.md', wiki.read('many.md').revision, entities, relations)
for index in range(53):
    current = reviews.query('many.md')
    reviews.review('many.md', action='accept' if index % 2 == 0 else 'reject',
                   claim_id=current['claims'][0]['claim_id'],
                   expected_state_revision=current['state_revision'],
                   reason=f'격리 페이지 검증 {index}', actor=actor)
current = wiki.read('many.md')
wiki.save('many.md', current.content + '새 판본입니다.\n', expected_revision=current.revision)

wiki.save('candidate.md', body, expected_revision=None)
ontology.generate('candidate.md', wiki.read('candidate.md').revision, entities, [], relation_candidates=[candidate])
current = reviews.query('candidate.md')
reviews.review('candidate.md', action='reject', claim_id=current['claims'][0]['claim_id'],
               expected_state_revision=current['state_revision'], reason='추정을 별도 기각한 모의 판단', actor=actor)

app = create_application(policy)
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(128)
print(f"READY http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
