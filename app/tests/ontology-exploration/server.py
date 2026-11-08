"""지도 탐색 화면용 합성 자료를 새 임시 서버에만 만든다."""

from pathlib import Path
from io import BytesIO
import json
import socket
import sys
from uuid import uuid4

import uvicorn
from tools.initialize_server import initialize_new_server
from core.api.dependencies import access_value
from core.modules.access.auth import AuthService
from core.modules.access.policy import AccessPolicy
from core.modules.documents.metadata import parse_document, render_document
from core.modules.documents.store import WikiStore
from core.modules.knowledge.catalogue import list_catalogue
from core.modules.knowledge.concepts import ConceptStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.sources.store import SourceStore
from core.runtime.application import create_application


LOGIN = "지도 탐색 검증"


def isolated_root(value):
    """실행기가 새로 만든 표식·경로가 없으면 사용자 자료를 초기화하지 않는다."""
    root = Path(value)
    parent = root.parent
    if (parent.resolve() != parent or parent.parent != Path("/private/tmp")
            or not parent.name.startswith("wiki-exploration-ui-") or root.name != "server"
            or (parent / "exploration-test-root").read_text() != "isolated-exploration-ui-only"):
        raise RuntimeError("Only a new isolated ontology exploration test directory is permitted")
    return root


def save_graph(wiki, ontology, document, title, body, entities, relations, *, candidates=None, attributes=None, schema_version=3, source=None):
    """원문 전체 저장과 기존 추출 검증을 거쳐 실제 현재 그래프를 준비한다."""
    wiki.save(document, render_document(body, title=title, source=source), expected_revision=None)
    ontology.generate(document, wiki.read(document).revision, entities, relations,
                      relation_candidates=candidates or [], attributes=attributes or [], schema_version=schema_version)


def seed(policy, root):
    """세 문서·동명 개체·페이지를 넘는 직접 관계와 한정어를 실제 저장한다."""
    account = AuthService(policy).signup(LOGIN)
    scope = policy.authorize(account["token"], account["default_tenant"], "read")
    wiki = WikiStore(root / "data" / scope.tenant)
    ontology = OntologyStore(wiki)
    reviews = ReviewStore(wiki)
    targets = [
        "결제 서비스", "대기열 서비스", "예외 승인 서비스", "일정 조회 서비스", "재고 서비스",
        "고객 서비스", "알림 서비스", "쿠폰 서비스", "포인트 서비스", "세금 계산 서비스",
        "정산 서비스", "환불 서비스", "검색 서비스", "회원 인증 서비스", "주소 검증 서비스",
        "문서 발급 서비스", "감사 기록 서비스", "품질 지표 서비스", "요금 계산 서비스", "환율 서비스",
        "외부 연동 서비스", "채널 관리 서비스", "객실 배정 서비스", "체크인 서비스", "체크아웃 서비스",
        "대기 고객 서비스", "이용 약관 서비스", "분쟁 처리 서비스",
    ]
    lines = ["# 예약 플랫폼의 연결", "", "예약 서비스는 아래의 실제 업무 서비스를 연결한다."]
    entities = [dict(id="booking", label="예약 서비스", type="system", evidence=lines[2])]
    relations = []
    for index, label in enumerate(targets):
        identifier = f"svc{index + 1:02d}"
        qualifiers = {}
        if index == 0:
            quote = f"예약 서비스는 {label}를 사용하지 않는다."
            qualifiers = {"polarity": "negative"}
        elif index == 1:
            quote = f"예약 서비스는 {label}를 사용할 수 있다."
            qualifiers = {"modality": "possible"}
        elif index == 2:
            quote = f"운영자가 승인한 경우 예약 서비스는 {label}를 사용한다."
            qualifiers = {"condition": "운영자가 승인한 경우"}
        else:
            quote = f"예약 서비스는 {label}를 사용한다."
        lines.append(quote)
        entities.append(dict(id=identifier, label=label, type="system", evidence=quote))
        relations.append(dict(subject="booking", predicate="uses", object=identifier,
                              evidence=quote, qualifiers=qualifiers))
    future_quote = "차기 추천 서비스는 연결 여부를 추가 확인해야 한다."
    lines.extend([future_quote, "예약 서비스의 가용 시간은 24 시간이다.", "예약 서비스의 동시 처리량은 500 건이다."])
    entities.append(dict(id="future", label="차기 추천 서비스", type="system", evidence=future_quote))
    candidates = [dict(id="future_candidate", subject="booking", predicate="depends_on", object="future",
                       reason="추가 근거를 확인할 합성 후보", question="예약 서비스가 차기 추천 서비스에 의존하는가?", evidence=None)]
    attributes = [
        dict(id="availability", subject="booking", property="가용 시간", datatype="number", value="24", unit="시간", evidence=lines[-2]),
        dict(id="throughput", subject="booking", property="동시 처리량", datatype="number", value="500", unit="건", evidence=lines[-1]),
    ]
    save_graph(wiki, ontology, "예약-플랫폼.md", "예약 플랫폼 — 서비스 연결", "\n".join(lines) + "\n",
               entities, relations, candidates=candidates, attributes=attributes)

    quote = "파트너 문서의 예약 서비스는 파트너 재고 서비스를 사용한다."
    support = "파트너 재고 서비스는 파트너 정산 서비스에 의존한다."
    save_graph(wiki, ontology, "파트너-예약.md", "파트너 예약 — 별도 시스템", f"# 파트너 예약\n\n{quote}\n{support}\n", [
        dict(id="booking", label="예약 서비스", type="system", evidence=quote),
        dict(id="inventory", label="파트너 재고 서비스", type="system", evidence=quote),
        dict(id="settlement", label="파트너 정산 서비스", type="system", evidence=support),
    ], [dict(subject="booking", predicate="uses", object="inventory", evidence=quote),
        dict(subject="inventory", predicate="depends_on", object="settlement", evidence=support)])
    current = reviews.query("파트너-예약.md")
    reviews.review("파트너-예약.md", action="accept", claim_id=current["claims"][0]["claim_id"],
                   expected_state_revision=current["state_revision"], reason="격리 UI의 검토 반영 표시 확인", actor=access_value(scope))

    quote = "운영 승인 절차는 예약 서비스를 관리한다."
    save_graph(wiki, ontology, "운영-정책.md", "운영 정책 — 예약 예외 처리", f"# 운영 정책\n\n{quote}\n", [
        dict(id="approval", label="운영 승인 절차", type="process", evidence=quote),
        dict(id="booking", label="예약 서비스", type="system", evidence=quote),
    ], [dict(subject="approval", predicate="related_to", object="booking", evidence=quote)])

    # UI와 같은 현재 서비스에서 판본 참조·29개 직접 관계·2개 속성·동명 경계를 확인한다.
    concepts = ConceptStore(wiki, actor=access_value(scope))
    search = concepts.explore_search(text="예약 서비스", kind="concept")
    assert len(search["items"]) == 3
    first = next(item["concept"] for item in search["items"] if item["concept"]["document"] == "예약-플랫폼.md")
    neighbors = concepts.explore_neighbors(first["document"], first["entity_id"], first["ref"]["state_revision"], limit=20)
    assert neighbors["total"] == 29 and len(neighbors["edges"]) == 20 and neighbors["next_cursor"]
    assert first["attribute_count"] == 2
    assert len(concepts.explore_search(kind="document")["items"]) == 3


def seed_recent(policy, root):
    """승인 시안과 같은10문서·500개념을 실제 격리 저장소에 준비한다."""
    account = AuthService(policy).signup(LOGIN)
    scope = policy.authorize(account["token"], account["default_tenant"], "read")
    wiki = WikiStore(root / "data" / scope.tenant)
    ontology = OntologyStore(wiki)
    titles = ["예약 플랫폼 — 서비스 연결", "파트너 예약 — 별도 시스템", "운영 정책 — 예약 예외 처리",
              "정산 처리 — 계산과 환불", "사용자 권한 — 인증과 접근", "장애 복구 — 재시도 정책",
              "알림 전송 — 채널별 조건", "외부 연동 — 요청과 응답", "개인정보 — 보관과 삭제", "이력 관리 — 감사와 추적"]
    names = ["예약 서비스", "결제 서비스", "대기열 서비스", "예외 승인 서비스", "일정 조회 서비스",
             "재고 서비스", "고객 서비스", "알림 서비스", "쿠폰 서비스", "포인트 서비스",
             "세금 계산 서비스", "정산 서비스", "환불 서비스", "검색 서비스", "회원 인증 서비스",
             "주소 검증 서비스", "문서 발급 서비스", "감사 기록 서비스", "품질 지표 서비스", "요금 계산 서비스",
             "환율 서비스", "외부 연동 서비스", "채널 관리 서비스", "객실 배정 서비스", "체크인 서비스",
             "체크아웃 서비스", "대기 고객 서비스", "이용 약관 서비스", "분쟁 처리 서비스", "추천 서비스",
             "접근 정책", "승인 요청", "거절 사유", "취소 규칙", "만료 시점", "운영 시간", "이용 한도",
             "처리 상태", "고객 알림", "예약 변경", "중복 예약", "재시도 규칙", "인증 토큰", "권한 확인",
             "예약 이력", "장애 대응", "데이터 보관", "개인정보 처리", "배치 작업", "운영 지표"]
    for title in reversed(titles):
        entities, relations, lines = [], [], [f"# {title}", ""]
        for index, name in enumerate(names):
            for offset in (1, 7):
                other = (index + offset) % len(names)
                quote = f"{name}는 {names[other]}를 사용한다."
                lines.append(quote)
                relations.append(dict(subject=f"entity-{index}", predicate="uses",
                                      object=f"entity-{other}", evidence=quote))
                if offset == 1:
                    entities.append(dict(id=f"entity-{index}", label=name, type="system", evidence=quote))
        document = title.split(" — ")[0] + ".md"
        save_graph(wiki, ontology, document, title, "\n".join(lines) + "\n", entities, relations)
    concepts = ConceptStore(wiki, actor=access_value(scope))
    recent = concepts.explore_search(kind="document", limit=5)
    assert recent["total"] == 10 and len(recent["items"]) == 5 and recent["next_cursor"]
    assert all(item["concept_count"] == 50 for item in recent["items"])
    assert concepts.explore_search(kind="concept", limit=20)["total"] == 500


def seed_display_issues(policy, root):
    """범위가 다른 관계·긴 원문 위치·문서별 경고·원본 연결을 격리 재현한다."""
    account = AuthService(policy).signup(LOGIN)
    scope = policy.authorize(account["token"], account["default_tenant"], "read")
    wiki = WikiStore(root / "data" / scope.tenant)
    ontology = OntologyStore(wiki)
    reviews = ReviewStore(wiki)
    relation_quotes = [
        "Within household electricity, Energy Provider follows the reference to Energy Measure.",
        "Within commercial electricity, Energy Provider follows the reference to Energy Measure.",
    ]
    relation_scopes = ["household electricity", "commercial electricity"]
    annotation_quote = "Annotations is a standalone annotation concept."
    structured = json.dumps({"unit": "kWh", "precision": 3, "tags": ["sample", "fixture"]}, separators=(",", ":"))
    attribute_quote = "Annotations annotation_payload = " + structured
    lines = ["# Energy Provider", "", "## Reading context", ""]
    for index in range(1, 25):
        lines.extend([f"### Background {index:02d}",
            f"This isolated fixture paragraph {index:02d} explains the reading context before the evidence. "
            "The document keeps its introduction and every preceding paragraph so a later quotation must scroll to its actual location.", ""])
    lines.extend(["## Reference evidence", "", relation_quotes[0], "", relation_quotes[1], "", annotation_quote, attribute_quote, ""])
    energy_body = "\n".join(lines)
    originals = SourceStore(wiki)
    staged = originals.stage(BytesIO(energy_body.encode("utf-8")), kind="file", title="B07 원본 에너지 기록",
                             format="txt", filename="B07-energy-original.txt")
    registered = originals.commit(staged, tenant=scope.tenant, user_id=scope.user_id, request_id=uuid4().hex,
        authorize=lambda: access_value(policy.authorize(account["token"], scope.tenant, "source_write")))
    source_ref = {"id": registered["source_id"], "version": registered["source_version"]}
    save_graph(wiki, ontology, "energy-provider.md", "B07 에너지 공급 참조 명세", energy_body, [
        dict(id="energy_provider", label="Energy Provider", type="system", evidence=relation_quotes[0]),
        dict(id="energy_measure", label="Energy Measure", type="concept", evidence=relation_quotes[0]),
        dict(id="annotations", label="Annotations", type="concept", evidence=annotation_quote),
    ], [dict(subject="energy_provider", predicate="follows_reference", object="energy_measure", evidence=quote,
             qualifiers={"scope": selected_scope}) for quote, selected_scope in zip(relation_quotes, relation_scopes)],
        attributes=[dict(id="annotation_payload", subject="annotations", property="annotation_payload", datatype="text",
                         value=structured, unit=None, evidence=attribute_quote)], schema_version=6, source=source_ref)
    initial = reviews.query("energy-provider.md")
    relation = next(claim for claim in initial["claims"] if claim["value"].get("qualifiers", {}).get("scope") == relation_scopes[0])
    reviews.review("energy-provider.md", action="accept", claim_id=relation["claim_id"],
                   expected_state_revision=initial["state_revision"], reason="격리 incoming 검토 표시 확인", actor=access_value(scope))

    quote = json.dumps({
        "original_record_id": "B07", "original_sha256": "a" * 64,
        "original_json_schema_id": "https://json-schema.org/draft/2020-12/schema",
        "metadata_role": "original_record_metadata",
    }, separators=(",", ":"))
    original_lines = ["# 원본 JSON 메타데이터", "", "원본 JSON은 아래 메타데이터를 가진다.", ""]
    for index in range(1, 21):
        original_lines.extend([f"## 메타데이터 배경 {index:02d}",
            f"이 합성 설명 {index:02d}은 인용보다 앞에 있는 원문 문단이다. "
            "메타데이터를 확인할 때도 앞의 본문을 생략하거나 다른 판본의 줄 번호를 재사용하지 않는다.", ""])
    original_lines.extend(["## 원문 메타데이터", "", "```json", quote, "```", ""])
    body = "\n".join(original_lines)
    wiki.save("original-record.md", render_document(body, title="원본 JSON — 메타데이터 앵커"), expected_revision=None)
    source = wiki.read("original-record.md")
    offset = source.content.index(quote)
    line = source.content[:offset].count("\n") + 1
    anchor = dict(kind="source_anchor", document="original-record.md", source_revision=source.revision,
                  quote=quote, start_line=line, end_line=line, occurrence=0)
    ontology.generate("original-record.md", source.revision,
        [dict(id="original_json", label="원본 JSON", type="document", evidence="원본 JSON은 아래 메타데이터를 가진다.")],
        [dict(subject="original_json", predicate="has_source_metadata", object=anchor, evidence=quote)], schema_version=6)

    # 저장·조회 계약을 통과한 값만 UI에 사용한다. native object 속성은 지원하지 않아 JSON text로 보존한다.
    energy = reviews.query("energy-provider.md")
    original = reviews.query("original-record.md")
    assert energy["status"] == "ready" and original["status"] == "ready"
    assert len(energy["effective_graph"]["entities"]) == 3
    energy_source = wiki.read("energy-provider.md")
    parsed_energy = parse_document(energy_source.content)
    assert parsed_energy.metadata["title"] == "B07 에너지 공급 참조 명세"
    assert parsed_energy.metadata["source"] == source_ref
    assert energy["source_revision"] == energy_source.revision
    current_relations = [claim for claim in energy["current_claims"] if claim["value"].get("predicate") == "follows_reference"]
    assert len(current_relations) == 2 and len({claim["claim_id"] for claim in current_relations}) == 2
    assert {claim["value"]["qualifiers"]["scope"] for claim in current_relations} == set(relation_scopes)
    for claim in current_relations:
        evidence = claim["value"]["evidence"]
        assert evidence["start_line"] > 80
        assert energy_source.content.splitlines()[evidence["start_line"] - 1] == evidence["quote"]
        assert parsed_energy.body.splitlines()[evidence["start_line"] - parsed_energy.body_start_line] == evidence["quote"]
    accepted = next(claim for claim in current_relations if claim["value"]["qualifiers"]["scope"] == relation_scopes[0])
    assert accepted["decision"] == "accept"
    assert energy["effective_graph"]["attributes"][0]["value"] == structured
    saved_anchor = original["effective_graph"]["relations"][0]["object"]
    assert saved_anchor == anchor and source.content.splitlines()[line - 1] == quote and line > 60
    assert original["source_revision"] == source.revision == saved_anchor["source_revision"]
    concepts = ConceptStore(wiki, actor=access_value(scope))
    measure = next(item["concept"] for item in concepts.explore_search(text="Energy Measure", kind="concept")["items"])
    incoming = concepts.explore_neighbors("energy-provider.md", "energy_measure", measure["ref"]["state_revision"])
    assert incoming["total"] == 2 and {edge["origin"] for edge in incoming["edges"]} == {"machine", "reviewed"}
    assert incoming["coverage"]["complete"] and not incoming["coverage"]["skipped"]
    assert all(edge["ref"]["source_revision"] == energy_source.revision for edge in incoming["edges"])
    annotation = next(item["concept"] for item in concepts.explore_search(text="Annotations", kind="concept")["items"])
    isolated = concepts.explore_neighbors("energy-provider.md", "annotations", annotation["ref"]["state_revision"])
    assert isolated["total"] == 0 and annotation["attribute_count"] == 1
    documents = concepts.explore_search(kind="document")
    assert documents["total"] == 2
    assert documents["coverage"]["complete"] and not documents["coverage"]["skipped"]
    original_document = next(item for item in documents["items"] if item["ref"]["document"] == "original-record.md")
    assert original_document["relation_count"] == 1
    original_concept = next(item["concept"] for item in concepts.explore_search(text="원본 JSON", kind="concept")["items"])
    original_neighbors = concepts.explore_neighbors("original-record.md", "original_json", original_concept["ref"]["state_revision"])
    assert original_neighbors["total"] == 1 and len(original_neighbors["edges"]) == 1
    assert original_neighbors["coverage"]["complete"] and not original_neighbors["coverage"]["skipped"]
    assert len(original_neighbors["anchors"]) == 1
    projected_anchor = original_neighbors["anchors"][0]
    assert set(projected_anchor) == {"document", "anchor_id", "source_revision", "start_line", "end_line", "occurrence", "ref"}
    anchor_id = projected_anchor["anchor_id"]
    assert len(anchor_id) == 64 and all(character in "0123456789abcdef" for character in anchor_id)
    assert projected_anchor["ref"] == original_concept["ref"]
    for name in ("document", "source_revision", "start_line", "end_line", "occurrence"):
        assert projected_anchor[name] == saved_anchor[name]
    projected_edge = original_neighbors["edges"][0]
    assert projected_edge["subject"] == {"document": "original-record.md", "entity_id": "original_json"}
    assert projected_edge["object"] == {"document": "original-record.md", "anchor_id": anchor_id}
    assert projected_edge["label"] == "has_source_metadata"
    assert projected_edge["ref"]["source_revision"] == source.revision
    catalogue = list_catalogue(wiki, tenant=scope.tenant, scope_key="isolated-display-issues")["items"]
    linked = next(item for item in catalogue if item.get("document") == "energy-provider.md")
    assert linked["metadata"]["title"] == "B07 에너지 공급 참조 명세" and linked["source_status"] == "linked"
    assert any(item.get("kind") == "source" and item["title"] == "B07 원본 에너지 기록" for item in catalogue)


def main():
    """명시한 fixture를 준비한 뒤에만 새 loopback 서버를 연다."""
    modes = {
        (): (seed, "documents=3; booking_direct_relations=29; booking_attributes=2; same_name_concepts=3"),
        ("--recent-documents",): (seed_recent, "documents=10; concepts=500; concepts_per_document=50"),
        ("--display-issues",): (seed_display_issues, "documents=2; scoped_relations=2; evidence_after_line=80; linked_original=1; anchor=has_source_metadata; isolated=Annotations"),
    }
    selected = modes.get(tuple(sys.argv[2:]))
    if selected is None:
        raise RuntimeError("Unsupported isolated fixture mode")
    root = isolated_root(sys.argv[1])
    config = initialize_new_server(root)
    policy = AccessPolicy(config["access_config"], config["tenant_root"])
    prepare, description = selected
    prepare(policy, root)
    app = create_application(policy)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    print(f"READY http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
    print(f"FIXTURE login={LOGIN}; {description}", flush=True)
    uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])


if __name__ == "__main__":
    main()
