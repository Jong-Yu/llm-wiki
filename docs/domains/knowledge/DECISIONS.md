# 개념 조회·연결·영향 결정

현재 구현 상태는 [PLAN](PLAN.md), 작업 시 지킬 상세 규칙은 도메인에 연결된 RULES를 따릅니다. 결정 번호·이유와 상세 계약을 보존합니다. 아래 결정 안의 날짜·시험 수·운영 상태는 기록 당시 값이며, 최신 구현 상태는 PLAN을 우선합니다. 필요한 D 번호·하위 절만 읽습니다.

### D-019 — 문서 간 명시 링크와 공통 개념 후보 (2026-10-22, 4단계 보완)

상태: 현재 문서 연결 조회 계약입니다. 명시 링크와 이름·유형 후보를 구분합니다.

- 범위: 기존 `OntologyStore`에 문서 중심 연결 조회를 추가하고 MCP `ontology_connections(document, limit=20)`으로 제공합니다. 명시 링크와 후보를 별도 목록으로 반환합니다. 기존 문서별 JSON 형식을 바꾸거나 문서 간 개체 ID를 합치지 않습니다. 연결 인덱스·별도 그래프 저장소는 없습니다. 이 조회는 `layer=machine`이며 전문가 판단을 반영한 영향 안내는 [D-032], 아직 구현하지 않은 의미 대응·공통 개념 연결 방향은 [D-037]로 구분합니다.
- 명시 링크: 최신 Markdown 원문을 조회할 때 파싱하므로 원문 저장 후 다음 조회에 추가·삭제가 반영됩니다. 나가는 링크뿐 아니라 스캔한 다른 문서에서 들어오는 링크도 반환합니다. `[이름](../../상대경로.md)`와 참조형 링크를 지원하며 `./`, 위키 내부의 `../`, URL 인코딩된 파일명과 fragment를 처리합니다. 외부 URL·절대 경로·쿼리·위키 경계 밖·이미지·코드·HTML 링크·자기 문서 링크는 제외합니다. `[[문서]]` 확장은 이번 범위에 없습니다.
- 파서 선택: 코드 예제나 이미지의 경로를 실제 문서 링크로 오인하지 않도록 `markdown-it-py==4.2.0`의 CommonMark 토큰을 사용합니다. 기존 프로젝트에 Markdown 파서는 없어 프로젝트 전용 환경과 의존성 파일에 추가했습니다. 렌더링·브라우저 실행·링크 대상 다운로드는 하지 않습니다. [공식 파서 사용 안내](https://markdown-it-py.readthedocs.io/en/latest/using.html).
- 링크 근거: 출발·도착 문서와 읽은 revision, 방향, 원문에서 파싱한 href 및 링크가 포함된 Markdown 블록의 줄 범위를 반환합니다. 블록 범위는 정확한 개별 링크 문자 위치가 아닙니다. fragment는 보존하지만 제목·앵커 존재는 검사하지 않습니다. 같은 출발·도착 문서의 중복 링크는 첫 연결로 묶습니다. 없는 대상은 `missing`, 읽지 못한 대상은 `unavailable`, 부분 스캔 때문에 확인하지 못한 대상은 `unscanned`로 구분합니다.
- 후보 규칙: 양쪽 온톨로지가 `ready`이고 개체 유형과 정규화 이름이 같을 때 `candidate`로만 반환합니다. 이름에는 NFKC·대소문자 접기·공백 정규화를 적용하며, 부분 일치·별칭 추론·벡터 유사도는 사용하지 않습니다. `concept` 유형에만 한정하지 않고 기존 유형 모두에 같은 규칙을 적용합니다. 동명이인·동음이의어일 수 있으므로 동일 개체 확정이나 자동 병합의 근거로 사용하지 않습니다.
- 후보 근거와 갱신: 양쪽 개체는 문서 경로·원문 revision·문서 내 ID·유형·원래 이름·인용 근거를 그대로 유지합니다. 원문 변경으로 한쪽이 `stale`이면 그 문서가 포함된 후보를 제외합니다. 원문을 재추출해 온톨로지를 갱신하면 다음 조회에서 후보를 다시 계산합니다. 기존 캐시가 없거나 손상돼도 최신 원문의 명시 링크 조회는 유지하며 온톨로지 상태를 별도로 반환합니다.
- 일관성과 한도: 기존 저장 잠금으로 원문·파생 JSON의 제한된 스냅샷을 읽고 링크를 파싱해 대상 파일까지 확인합니다. 그래프 검증·후보 비교는 확보한 스냅샷으로 수행합니다. 조회 중 원문·히스토리·파생 JSON을 수정하지 않습니다. 최대 문서 100개·파일시스템 항목 1000개·원문과 파생 JSON 합계 16 MiB, Markdown 링크 토큰 1000개·href 2048자를 처리합니다. 중심 문서를 먼저 읽고, 명시 연결과 후보 목록에는 각각 기본 20개·최대 100개 한도를 적용합니다. 상태 목록은 스캔한 문서 수로 제한합니다. 부분 결과는 `truncated`, 읽기 문제·초과 href는 `skipped`, 후보 비교 가능 여부는 `ontology_states`로 알립니다. 결과를 완전한 위키 전체 연결로 단정하지 않습니다.

### D-027 — 선택 문서의 자연어·전체 그래프를 보존하는 조회 맥락 (2026-10-22, 4-B)

상태: 현재 명시 선택 문서의 원문·기계 그래프 조회 계약입니다. 자동 문서 선택·개념 중심 통합 조회와 구분합니다.

- 목적과 범위: `ontology_context`는 명시한 1–8개 문서의 자연어 원문·전체 **기계 추출 그래프(`layer=machine`)**를 함께 전달합니다. 현재 검토·전문가 판단은 [D-028]·[D-031]의 `ontology_review_query`로 별도 확인합니다. 기존 검색·명시 링크 조회로 찾은 정의/조건/예외 문서를 호출자가 선택합니다. 요청 범위는 `scope.kind=explicit_documents`, `auto_expanded=false`, `requested_documents`로 드러냅니다. 필요한 자료를 자동으로 모두 찾았거나 tenant 전체를 의미 검색했다는 뜻이 아닙니다. 링크 재귀 수집·외부 URL 호출·이름만 같은 개체 병합·새 LLM 호출은 하지 않습니다.
- 보존 방식: 문장이나 한정어를 요약·재작성하지 않고 원문 전체와 유효한 그래프 전체를 유지합니다. 기존 v3의 개체/관계/속성/검토 후보·인용 위치·한정어·context·provenance를 재사용하고 새 추출 스키마는 만들지 않습니다. 공통 정의나 다른 관점의 제약이 선택 문서 안에 있다면 같은 응답에 남습니다. 해당 문서를 선택하지 않았다면 자동으로 보완하지 않습니다.
- 관점의 역할: 프로필의 domain/viewpoint로 각 주장 배열의 조회 인덱스를 `focus`, `other_context`, `unclassified`로 나눕니다. 선택 축에 필요한 태그가 없으면 미분류, 모두 알려져 일치하면 focus, 알려졌지만 불일치하면 other_context입니다. 필터가 없을 때는 두 축 모두 빈 주장만 미분류입니다. 태그 없음은 공통이라는 뜻이 아니며, 분류는 의미적 관련성/진위/중요도를 자동 판정하지 않습니다. 다른 관점 주장과 원문 조건·예외를 버리지 않으므로 답변 시 함께 검토할 수 있습니다.
- 출처·버전: 문서 경로·원문 content/revision·전체 줄 범위와 그래프 source/indexed revision·저장 JSON의 SHA-256 `graph_revision`을 구분합니다. 동일 원문의 다른 그래프 생성도 추적하며 인용·식별 범위·출처는 원래 값을 유지합니다. 인덱스는 `(document, graph_revision, collection, index)` 범위의 조회 참조로만 사용하며 수정용 영구 ID가 아닙니다. 다중 모드의 `access`는 실제 profile 정의와 관리자 정책 revision을 보존합니다. 단일 모드에는 요청의 domain/viewpoint만 있고 관리자 profile은 없습니다.
- 일관성과 부분 실패: 기존 저장 잠금 한 번으로 모든 선택 원문·파생 바이트를 확보하고 검증·분류는 그 스냅샷으로 수행합니다. 원문 변경 시 기존 stale 계약을 적용해 옛 주장을 비웁니다. 그래프 미생성·손상·읽기 실패가 읽을 수 있는 최신 원문까지 숨기지 않도록 `missing`/`stale`/`unavailable`과 `needs_reextraction`, `skipped.component`를 제공합니다. 파생 파일을 자동 복구하지 않습니다. `complete`는 선택 범위의 모든 원문과 현행 v3 그래프를 제공했는지이며 의미 검증 통과가 아닙니다. 구버전 그래프는 읽기 호환과 재추출 표시를 유지합니다.
- 한도: 문서 8개, 원문·파생 바이트 캡처 합계 4 MiB, compact JSON 문서 배열 8 MiB를 제한합니다. 응답 메타데이터와 MCP의 텍스트/구조화 이중 표현은 이 배열 예산과 별개입니다. 기존 원문·그래프 각각 1 MiB 제한도 유지합니다. 파일 descriptor 크기를 확인하고 필요한 범위만 읽어 합계 예산을 관리하며 변경 중인 파일은 부분 본문으로 반환하지 않습니다. 예산 초과 시 문서 또는 그래프 전체를 생략하고, 중간 문서 실패 후에도 뒤의 작은 문서를 처리할 수 있습니다. `truncated`·`skipped`·문서별 상태로 빠진 범위를 알립니다.
- 권한과 무변경: 4-A의 사용자→tenant 소속→read 권한 검사가 먼저 선택 저장소를 결정합니다. 다른 tenant 문서를 읽은 후 숨기는 방식이 아니며, 프로필은 접근 경계가 아닙니다. 권한/결과 캐시는 추가하지 않았습니다. 조회·관점 전환은 원문·히스토리·파생 그래프를 변경하지 않습니다. `ontology_generate`의 전체 교체 계약은 그대로이므로 focus 일부를 재생성 입력으로 보내면 안 됩니다. 관점별 부분 추출 병합은 제공하지 않습니다. 검토 저장은 [D-028]의 별도 API를 사용합니다.
- MCP와 검증: 기존 SDK 2.3.0 도구 등록·read-only annotation·구조화 결과를 재사용합니다([MCP 도구 명세](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). 새 합성 원문에 직접 적힌 정의·조건·예외·출처와 반환 값을 대조하는 보존 검증을 시행합니다. 자동 구조 검사, 보존/일관성 검사, LLM 의미 추출 정확도는 구분합니다. 추출 프롬프트를 개선하거나 새 LLM 생성 결과를 평가하는 작업은 아니며 4-D의 답변 품질 비교를 대신하지 않습니다.

실행 예시는 [README](../../../README.md#자연어-설명과-그래프를-함께-조회-4-b), 실제 결과와 남은 범위는 [PLAN](../../PLAN.md)을 따릅니다. 후속 사람 검토 계약은 [D-028]이며 제품 UI는 미구현입니다.

### D-032 — 변경 문서의 직접 연결과 재검토 후보 안내 (2026-10-23, 선행 2)

상태: 현재 읽기 전용 영향 안내 계약입니다. 자동 재추출·알림·관련 문서 갱신은 제공하지 않습니다.

- 실행 경계: 개인 인증 tenant 모드에 읽기 전용 `ontology_impact`를 추가합니다. 허용 tenant의 변경 문서와 관점을 지정해 필요할 때 조회합니다. 기존 연결 파서·스캔, 원문 히스토리, 검토 원장을 재사용하며 새 영구 영향 인덱스·알림 큐·원장을 만들지 않습니다. 자동 재추출·자동 승인·관련 문서 수정은 하지 않습니다. 저장 성공 응답에 전체 저장소 스캔을 결합하지 않아 영향 조회 실패를 이미 성공한 저장의 실패로 오인하지 않게 합니다.
- 기준값: 선택 `baseline`은 이전 조회의 `source_revision`, `graph_revision`, `review_revision`, `history_revision` 네 값을 사용합니다. 원문·그래프·검토 원장·원문 히스토리의 변화 여부를 비교하는 입력이며 권한이나 저장 CAS를 대신하지 않습니다. graph/review는 파일이 없을 때 null입니다. 기준값이 없으면 현재 연결만 확인하고 변경이 실제 발생했다고 단정하지 않습니다. 기준값은 서명된 과거 스냅샷이 아니며 과거 원문·그래프를 클라이언트가 직접 제공하는 입력도 받지 않습니다.
- 연결 의미: 현재 원문의 들어오는/나가는 상대 Markdown 링크를 명시 연결로 보존합니다. 공통 개념은 이름 정규화·유형 일치로만 추정하며 같은 개체·실제 업무 의존·잘못된 문서로 확정하거나 자동 병합하지 않습니다. 직접 연결만 안내하고 재귀적으로 위키 전체의 의미 영향을 계산하지 않습니다. 알려진 문서 상태와 연결 때문에 생긴 재검토 권고는 구분합니다. 연결된 문서의 자체 그래프가 ready이면 실제 stale인 것처럼 바꾸지 않습니다.
- 변경 전 근거: 기준 원문을 해당 문서의 `_history/`에서 실제 SHA-256으로 확인할 수 있을 때 삭제된 링크도 안내합니다. 보관본은 원본 교체 실패 전에 생성될 수도 있으므로 실제 공개된 직전 버전이라고 추정하지 않습니다. 이전 그래프는 전체 버전 저장 대상이 아니어서 덮어쓴 결과를 복원할 수 없습니다. 남아 있는 옛 그래프도 일치하는 원문과 인용을 확인한 경우만 근거로 사용합니다. 복원하지 못한 자료는 누락·불완전으로 표시합니다.
- 전문가 판단: 기존 원장에서 검증한 관계·속성의 변경 전후 끝점과 전문가 개체를 후보 근거로 재사용합니다. 원문 인용과 Action log 근거를 분리하고 이벤트·범위·버전을 유지합니다. 선택 범위의 현재 정책, 다른 범위 정책, 옛 판단·되돌린 판단은 같은 상태로 취급하지 않습니다. 이력에 이름이 남아 있다는 것만으로 그 판단을 현재 사실로 적용하지 않습니다.
- 일관성과 한도: 하나의 tenant 저장 잠금 안에서 읽은 원문·그래프·검토 원장·확보 가능한 이전 원문을 사용합니다. 기존 조회의 근거·원장·검토 계층 검사를 우회하지 않습니다. 문서 수·파일시스템 항목·바이트·반환 수에 상한을 두며 리뷰와 히스토리도 예산에 포함합니다. stale/missing, 검토 대기, 손상/읽기 실패, 기준 복원 실패, 스캔·출력 한도를 구분합니다. 범위 내 자료 확보가 완료됐다는 표시는 위키 전체의 의미 영향이 완전하다는 보장이 아닙니다.
- 권한: 기존 `read` 권한으로 조회하며 tenant/profile을 먼저 확인한 후 그 tenant의 저장소만 구성하고 읽습니다. 다른 tenant를 읽은 뒤 결과에서 가리는 구현이나 전역 캐시를 사용하지 않습니다. 프로필은 조회 문맥이며 같은 tenant의 이력 접근 경계가 아닙니다. 단일 저장소/공유 토큰 모드에는 새 도구를 등록하지 않습니다. 허용되지 않은 tenant와 존재하지 않는 tenant는 같은 오류로 처리합니다.
- 검증 범위: 원문·기계 관계·검토·전문가 판단·되돌림 뒤 안내 변화, 삭제된 링크, 옛 개념과 출처, 한도·읽기 실패·오래된 상태, 조회 중 경쟁과 파일 불변, tenant 격리와 기존 기능을 격리 자료로 검증합니다. 이름 일치 후보의 의미적 정확도를 새 LLM 평가로 입증하는 단계는 아닙니다. 실제 실행 결과와 제한은 PLAN에 기록하며 UI·실시간 알림은 진행하지 않습니다.

### D-037 — 문서에서 발견한 개념·상태 조건의 연결과 통합 조회 방향 (2026-10-23)

상태: 사용자와 합의한 후속 방향 중 **문서 간 대응 원장·버전 검사·MCP는 D-038, 개념 발견·명시 대상 중심 최신 지식 통합 조회는 D-040으로 구현**했습니다. 공통 개념 등록부는 만들지 않았습니다. 실제 구현/검증은 [대응 구현](../../history/2026-10-25-before-domain-split/PLAN.md#d-038-대응-원장복합-버전mcp-구현과-격리-검증-2026-10-23)과 [통합 조회 구현](../../history/2026-10-25-before-domain-split/PLAN.md#d-040-개념-발견통합-조회-구현과-격리-검증-2026-10-23), 새 원문 의미/전문가 평가는 [예정 평가](../../history/2026-10-25-before-domain-split/PLAN.md#다음-평가-예정--상태-조건과-공통-개념-연결)를 따릅니다.

- 목적과 표현: 문서별 원문·추출·검토 이력을 보존하면서 여러 문서의 개념과 주장을 연결해 지식 구조를 점진적으로 확장합니다. 공통 개념의 설명·조건·예외·관계·출처를 모아 자연어 개념 페이지와 관계 맵으로 제공하는 방향입니다. 두 표현을 서로 다른 정답으로 편집·관리하거나 공통 정의를 모든 원문에 복사하지 않습니다. 상세 조건을 표현할 수 없는 그래프에 억지로 축약하지 않습니다.
- 이름 없는 조건: “갯수가 1~5개인 상품”은 우선 상품에 붙은 수량 조건으로 보존합니다. 문맥으로 확인되지 않은 수량의 의미를 재고로 채우거나, 수식어마다 새로운 공통 개념을 자동 생성하지 않습니다. “매진 임박 상품은 출고를 우선한다”와의 연결은 동일 명칭 검색을 넘어 정의·조건·업무 범위를 비교하는 대상입니다. 두 표현만으로 대응을 확정하지 않습니다.
- 연결과 근거: 같은 워크스페이스에서 허용된 기존 정의·현재 전문가 판단을 찾아 대응을 제안합니다. 원문에 명시된 정의와 전문가가 정한 업무 판단은 서로 다른 출처로 유지합니다. 근거가 없으면 이유와 확인할 질문이 있는 후보로 남기며, “이 조건이면 해당 개념에 속한다”는 단방향 판단을 동치나 반대 방향 추론으로 확대하지 않습니다. 연결을 확인한 것이 연결된 모든 주장의 승인이나 원문 간 모순의 해소를 뜻하지 않습니다.
- 축적과 변경: 확인된 판단에는 대상·이유·적용 범위·시점·출처·버전을 남겨 다음 작업에서 조회할 수 있게 합니다. 신규 문서에서는 조건과 예외의 차이를 확인하며 기존 승인 상태를 그대로 이식하지 않습니다. 정의·원문·전문가 판단이 달라지면 영향 연결과 재검토 상태를 드러내고 과거 판단을 보존하는 방향입니다. 여러 업무 범위의 정의를 전역 최신값 하나로 덮어쓰지 않습니다.
- 현재 구현과 남은 설계: 기존 문서별 `effective_graph`·전문가 정책·상태 버전과 저장 보존 원칙을 재사용했습니다. 이름·유형 후보는 그대로이며 상태 조건의 의미 대응을 자동 생성/승인하지 않습니다. 문서 간 연결 판단의 보존·검토 도구는 [D-038]의 별도 대응 원장을 사용합니다. 통합 조회의 후속 계약은 [D-040]이며 공통 개념 전체 등록부를 선행 조건으로 추가하지 않습니다. 기존 문서 원장의 API를 대응 API로 바꾸지 않습니다.

### D-040 — 개념 중심 최신 지식 통합 조회 (2026-10-23)

상태: **구현·격리 검증 완료**입니다. D-037의 후속인 개념 중심 조회를 D-038 대응 원장과 D-028/031의 검토·전문가 판단으로 조립하는 계약입니다. 두 read 도구는 개인 인증 tenant 서버에 등록했으며 구현 당시 실제 연결은 legacy 설정 그대로였습니다. 이후 로컬 개인 인증 읽기 연결은 [D-041]에서 적용·확인했습니다. 기존 저장/검토/대응 구현·원장 형식·추출 스키마·사용자 데이터·UI·실제 연결 설정은 보존합니다. 설계 당시 기록은 [상세 설계](../../history/2026-10-25-before-domain-split/PLAN.md#개념-중심-통합-조회-상세-설계-2026-10-23), 실제 완료 조건·검증은 [구현 검증](../../history/2026-10-25-before-domain-split/PLAN.md#d-040-개념-발견통합-조회-구현과-격리-검증-2026-10-23)에서 관리합니다.

#### 조회 단위와 최신의 의미

결정: **버전이 붙은 대상 한 건을 중심으로, 출처별 주장과 판단을 함께 읽는 묶음**을 제공합니다. 공통 개념 등록부·영구 canonical ID·별도 정답 문서를 먼저 만들지 않습니다. 자연어 설명에 사용할 맥락과 관계 맵용 참조는 같은 묶음에서 파생합니다. 조회 결과나 그 일부를 위키/그래프에 자동 저장하지 않습니다.

‘최신’은 조회 시점에 확보한 원문·기계 추출·검토·정책·대응의 현재 상태를 뜻합니다. 가장 최근 시각의 주장 하나를 전역 정답으로 고르거나, 새 기계 추출이 옛 전문가 판단을 반박했다고 해석하지 않습니다. 현재 적용되는 정책이 있으면 해당 문서/주장/정확한 범위에만 반영하고 원래 주장·source 검토·옛 판단은 따로 남깁니다. 미검토 원문 주장이 포함된 `effective_graph`의 기존 계약도 유지합니다.

단방향 조건→개념, 명시적 동치, 원문 사실, 연결 후보, 업무 정책은 서로 다른 항목입니다. 대응 수용이 주변 규칙의 승인·개별 상품의 조건 충족·출고 실행을 뜻하지 않습니다. 같은 이름/유형·식별자 문자열·줄 범위 중첩은 개념 동일성의 증거로 승격하지 않습니다. 동치도 별도 연결이며 문서나 개체를 병합하지 않습니다.

#### 대상 참조와 발견의 분리

결정: 문자열 **발견**과 명시한 대상의 **상세 조회**를 나눕니다. 이름만 전달해 상세 조회가 임의의 대상을 선택하게 하지 않습니다. 발견 결과는 다음 중 하나의 typed `target`과 당시 snapshot을 반환하며, 상세 조회는 그 ref를 그대로 받습니다. tenant는 공통 입력/인증 범위에서 정하고 target 안에 다른 tenant를 지정하는 필드는 두지 않습니다.

| target.kind | 식별과 버전 | 의미와 제한 |
| --- | --- | --- |
| `anchor` | `anchor`는 기존 D-038의 `document, source_revision, quote, start_line, end_line`과 선택 occurrence/graph_ref. 바깥 `observation={source_revision, history_revision}` 필수 | 이름 없는 조건·정확한 원문 구절. 그래프가 없어도 시작 가능하며 인용을 발명하지 않음. wrapper는 통합 조회 참조이며 D-038 저장 anchor를 바꾸지 않음 |
| `entity` | `document, source_revision, graph_revision, state_revision, layer, entity_id, snapshot` | layer는 machine/reviewed. 전문가가 추가한 개체는 실제 정책의 최신 event와 판단 출처 event도 origin_ref로 유지하며 가짜 source anchor를 만들지 않음 |
| `document_claim` | `document, source_revision, graph_revision, state_revision, original_collection, claim_id, layer, snapshot`와 선택 `selector/origin_ref` | selector는 subject/object/attribute_subject/value 중 해당 collection에 가능한 위치만 허용. 속성값·정책에만 등장한 표현의 진입점이며 그 표현을 독립 개체로 등록했다는 뜻이 아님 |
| `correspondence_endpoint` | `correspondence_id, correspondence_revision, lane, judgment_id, latest_event_id, origin_event_id, endpoint, snapshot` | endpoint는 condition/concept. 최신 판단의 양끝점 중 명시 선택한 대상을 조회. 해당 대응의 방향·조건·범위도 함께 반환 |

entity/claim의 layer=reviewed는 현재 `effective_graph`와 검토/정책 provenance를 뜻하며 전부 승인됐다는 뜻은 아닙니다. 후보 수용 뒤 표시 배열이 relations가 되어도 식별용 original_collection은 relation_candidates로 보존합니다. `claim_id`는 기계 주장 의미의 식별값이므로 수정된 값의 고유 버전으로 사용하지 않습니다. 정책 출처는 문서·claim·exact scope·최신 이벤트와 적용값의 원래 decision event로 구분합니다.

anchor의 observation은 find에서 같은 잠금으로 확보하고 query에서 source/history revision을 모두 대조합니다. anchor와 observation의 source_revision도 같아야 합니다. 본문 hash가 같은 A→B→A도 history 관측 차이로 version_changed가 되며 확장을 멈춥니다. 이는 관측 기준의 변화이지 원문 교체 성공의 증명은 아닙니다. 순수 anchor에 무관한 graph/review 의존을 추가하지 않습니다. history 확인이 불완전하면 빈 목록 hash를 대신 넣지 않고 observation의 미확보 revision=null과 부분 상태를 반환하며 현재성/자동 확장을 허용하지 않습니다. 확인된 history 부재와 읽기 실패는 구분합니다.

target의 요청 revision/snapshot과 현재 상태를 대조합니다. 상태가 바뀌면 `target.status=version_changed/stale/missing/unavailable/ambiguous`와 차이를 반환하고 현재 이름을 찾아 조용히 재지정하지 않습니다. 가능한 현재 원문/상태는 별도 제공하되 target 중심 확장은 멈춥니다. 새 발견 결과를 다시 선택해야 하며 예전 승인을 새 대상으로 옮기지 않습니다. 없는 기본 문서/대응은 not_found, 읽을 수 있는 문서 안의 그래프/주장/선택 이벤트 문제는 부분 결과로 구분합니다.

`origin_ref`를 붙인 entity/document_claim은 `{kind: document_policy, document, original_collection, claim_id, latest_event_id, selected_event_id, decision_event_id, exact_scope, state_revision, snapshot}`로 정책 원장의 값을 지목할 수 있습니다. latest_event_id는 현재 관측한 scoped 최신 이벤트, selected_event_id는 선택한 현재/과거 이벤트, decision_event_id는 해당 값의 원래 판단 출처입니다. 서버는 전체 원장을 검증한 뒤 선택 이벤트의 after snapshot·개체/claim과 대조하며 selected profile의 effective 값인지 또는 진단용 정책값인지 구분합니다. 다른 관점/보류된 정책값이 effective_graph에 없더라도 사라진 개체로 단정하지 않고 `resolution_layer=policy_snapshot`, 원래 `policy_status=other_scope/pending/inactive`, `selectable_as_current=false`로 읽습니다. 실제 provenance가 없는 snapshot을 client가 임의로 만들어 해석하게 하지 않습니다. 진단 선택은 해당 정책/조건을 현재 적용하거나 graph에 삽입하지 않습니다. 과거 hit도 같은 진단 ref에 historical=true를 붙이며 현재 ref를 자동 대신 선택하지 않습니다.

발견 대상은 허용 범위의 원문 경로/구절, 현재 기계·검토 반영 개체/주장, 현재 문서 정책값·정책 개체 label, D-038 각 lane의 최신 값입니다. NFKC/casefold 부분 문자열만 사용하고 벡터·별칭·수치 포함관계·의미 동등성 추론은 하지 않습니다. `match_origin, matched_field, original_text, target_ref, currentness, review/policy/applicability, provenance`를 남깁니다. 숫자/속성값에서 찾은 결과는 해당 주장과 대상의 ref이지 새 개념 이름이 아닙니다.

`include_history=false`가 기본이며 이때도 최신 상태가 pending/other_scope/inactive인 판단은 그 상태와 현재 남아 있는 값을 구분해 발견할 수 있습니다. 옛 값·철회된 용어까지 찾으려면 include_history=true를 명시합니다. 과거 hit는 `historical=true, selectable_as_current=false`로 반환하며 현재 대상이 확인될 때만 별도 current_target_ref를 제공합니다. 검증한 원장 전체를 읽고 replay한 뒤 선택 이벤트를 출력하며 raw JSON 문자열이나 이유/질문의 단어를 현재 개념으로 승격하지 않습니다. 이유·감사 actor·임의 문서 지시는 기본 개념 검색 대상이 아닙니다.

#### 선택 범위와 직접 확장

결정: 상세 조회의 기본 `expansion=none`입니다. target이 속한 문서/대응과 호출자가 명시한 정의·조건·예외 문서 및 대응만 콘텐츠로 조립합니다. 필요한 자료를 호출자가 지정할 수 있고, 명시적 선택은 검토나 근거로 승인됐다는 뜻이 아닙니다. 선택된 거절/보류/오래된 대응도 진단용으로 남깁니다.

선택한 `expansion=direct_confirmed`는 **target과 정확히 연결된 현재 적용 가능한 D-038 대응 한 단계**만 콘텐츠 확장에 사용합니다. endpoint anchor의 문서/원문 버전/정확한 위치·구절·occurrence 또는 graph ref의 `document, graph_revision, state_revision, layer, collection, entity_id/claim_id, snapshot` 전체 키로 연결을 확인합니다. entity label이 endpoint 구절에 들어 있거나 두 인용이 겹친다는 이유로 일치 처리하지 않습니다. selector 없는 document_claim은 주장 전체 ref로 비교합니다. selector=subject/object/attribute_subject는 선택 snapshot의 정확한 entity ref로 해소할 수 있을 때 그 entity 키로만 비교하며 주장 전체 키와 비교하지 않습니다. selector=value는 D-038 graph_ref에 selector가 없으므로 주장 전체 ref가 같아도 자동 확장하지 않습니다. 값의 문자열을 anchor/개체로 자동 변환하지 않으며 필요한 대응을 명시 선택할 수 있습니다. 원장 탐색의 endpoint 일치·실제 evidence/reference 사용·단순 related_to를 별도 관계로 반환합니다.

- 자동 확장할 때는 수용/active와 현재 `applicability=applicable`, exact policy scope·업무 축·기간·의존 상태를 모두 확인합니다. 필요한 application_context가 없으면 추정하지 않으며 해당 대응은 unknown_scope 등으로 표시하고 확장하지 않습니다.
- 허용된 직접 대응의 다른 끝점 문서와 그 대응의 실제 연결 정의/근거 문서를 콘텐츠에 추가합니다. 연결 방향을 그대로 유지하고 반대 방향 탐색을 역방향 분류 추론으로 바꾸지 않습니다. 새로 들어온 끝점에서 또 다른 대응을 따라가지는 않습니다.
- 이름 후보, source 미검토, 거절/보류, needs_review/unavailable/other_scope/out_of_period/conflicting/inactive는 현재 연결로 확장하지 않습니다. 발견한 범위에서는 상태·이유·확인 질문·출처를 `unexpanded_connections`에 남깁니다. 미검토 원문 정의 자체를 현재 원문으로 읽는 것은 계속 가능합니다.
- `references`로 읽는 D-038 의존 closure는 **판단 평가용**입니다. 의존 자료를 읽었다는 이유만으로 모든 문서를 개념 콘텐츠로 확장하거나 별도 지식을 승인하지 않습니다. `related_to`는 비교 계보이며 실제 적용 근거와 구분합니다.
- 명시 Markdown 링크와 이름/유형 일치 후보는 발견 보조 자료입니다. D-019/D-032 결과를 확인된 의미 대응으로 바꾸지 않으며 필요한 문서는 별도 명시 선택하게 합니다. 선택 범위 밖에 필요한 정의·예외가 있을 가능성은 `not_guaranteed=semantic_coverage`로 알립니다.

scope에는 `requested_target, explicit_documents, explicit_correspondences, content_documents, content_correspondences, expanded_via, dependency_only_resources, unexpanded_connections, discovery_scope, auto_expanded, max_hops=1`을 반환합니다. 확장된 자료마다 어느 root/판단/event 때문에 들어왔는지 남깁니다. 선택 범위의 확보와 개념에 필요한 모든 지식의 망라는 다른 판정입니다.

새 문서 C의 재고 2개 조건을 기존 1~5개 판단과 비교할 때도 수치 포함관계를 새 대응으로 확정하지 않습니다. 선례를 명시 선택한 경우 `selected_precedent`로 함께 읽고, C의 새 판단은 D-038의 새 제안/검토 흐름으로 기록해야 합니다. 통합 조회가 C의 승인 상태나 새 관계를 만들지 않습니다.

#### 결과 묶음과 출처

결정: 문서별 전체 원문과 전체 기계/검토 반영 그래프를 보존하는 D-027의 원칙을 재사용합니다. target incident edge만 모아 나머지 조건·예외·다른 관점을 버리지 않습니다. 출력 예산에 맞지 않는 구성요소는 통째 생략하고 그 사실을 알립니다. 일반 v3 문장에서 정의/예외 역할을 새로 자동 판정하지 않으며 D-038의 basis/link_evidence/qualifiers처럼 명시된 역할만 표시합니다. 그 밖의 원문 제약은 원래 문자열과 미분류 맥락으로 유지합니다.

| 응답 항목 | 보존할 내용 |
| --- | --- |
| `target`, `scope` | 요청 ref·관측된 값·해석 상태, 명시/확장/평가용 범위와 제외 이유 |
| `documents` | 문서별 전체 source content/revision/줄 범위, history/graph/review/state revision, machine_graph/effective_graph, claims, policies, pending_history와 컴포넌트 상태 |
| `correspondences` | 선택/발견한 source_proposal·reviews·policies, decision/applicability/reasons/conflict_refs·dependencies와 현재/원래 판단 출처. D-038 상태를 재명명해 승인/논리적 진실로 만들지 않음 |
| `focus_refs`, `other_context`, `unclassified` | 전체 문서/그래프 안의 조회 참조. profile 태그 부재는 공통 사실이 아니며 다른 관점의 제약도 보존 |
| `possible_matches`, `unexpanded_connections` | 문자열/이름 후보와 현재 연결에 쓰지 않은 대응. 근거 주장과 별도 배열이며 개수도 분리 |
| `explanation_context`, `map_context` | 동일 claim/ref에 대한 설명 순서·원문/판단 참조와 노드/방향 edge 참조. 새 자연어 정의·정답을 저장하거나 LLM을 호출하지 않음 |
| `resource_manifest`, `evaluation` | 실제 읽은 구성요소/바이트 버전·누락·required_by, 단일 평가 시각·profile 정의·application_context |
| `complete`, `completeness`, `truncated`, `skipped` | 아래의 선택·캡처·출력별 확보 여부와 누락/손상/한도 사유. 의미 검증이나 사용자 승인의 지표가 아님 |

문서 주장 ref에는 `document, source_revision, graph_revision, review_revision, history_revision, state_revision, original_collection, display_collection, claim_id`를 유지합니다. source 인용은 quote/start_line/end_line과 원문 revision을, 정책값/새 개체는 Action log provenance와 exact scope를 유지합니다. `review_event_id, latest_policy_event_id/event_id`와 `policy_event_id/decision_event_id`를 구분하고 source_decision/source_reviewed_value도 남깁니다. 대응에는 correspondence_revision과 lane/judgment_id, 최신 event_id와 snapshot.origin_event_id를 함께 보존합니다. undo 뒤 최신 사건과 복원된 판단의 출처가 달라도 하나로 축약하지 않습니다.

배열 위치는 해당 버전의 조회 참조이며 영구 수정 ID가 아닙니다. 동일한 원시 ref를 결과 안에서 중복 제거할 수 있지만 의미가 비슷한 주장·속성값·개체는 합치지 않습니다. 표시용 bundle/node ID는 응답 내 참조일 뿐 새 영구 개념 ID가 아닙니다. 재추출/수정에는 각 기존 도구의 최신 조회/prepare와 해당 CAS를 다시 사용해야 합니다. 이 결과나 focus/map 일부를 ontology_generate에 재전송하지 않습니다.

#### 현재성·검토·적용·불완전성의 분리

다음 축을 각각 반환합니다. 한 개의 ready/approved 값으로 묶지 않습니다.

| 축 | 해석 |
| --- | --- |
| 원문/추출 현재성 | source·graph의 current/stale/missing/unavailable 및 needs_reextraction. stale graph의 옛 주장을 현재 effective 사실로 복원하지 않음 |
| source 검토 | unreviewed/accept/edit/reject/defer와 pending_history를 원래 값대로 유지. 미검토 근거 주장은 표시하고 거절/보류 값은 진단·이력으로 유지 |
| 문서 전문가 정책 | active/other_scope/pending/inactive, exact scope와 조건/시간 원문. active는 현재 generation/범위의 정책 상태이며 조건 충족 판정이 아님 |
| 대응 적용 | D-038 decision과 applicability를 그대로 보존. 규칙 가용성 평가이지 개별 대상의 현재 수량/조건 충족 판정이 아님 |
| 자료 확보 | 선택/캡처/출력의 complete와 skipped/truncated. 미검토·다른 범위가 있어도 자료 확보 자체는 완료일 수 있음 |

문서 정책·자유문장 조건/예외에는 `condition_evaluation=not_evaluated`, 개별 상품 등에는 `instance_satisfaction=not_evaluated`를 명시합니다. D-038에서 구조화된 업무 축·기간만 기존 계산을 재사용합니다. 분류 교체만으로 옛 분류의 부정을 추론하지 않으며 정책이 반영된 값을 원문에서 추출한 사실로 표시하지 않습니다.

서로 다른 문서의 주장이나 범위가 다른 정책은 각각 보존합니다. 명시 대체가 없는 판단을 최신 timestamp로 선택하지 않습니다. D-038의 conflicting은 원장이 보고한 구조적 차이/검토 경고와 refs를 그대로 반환하고 논리적 모순 확정으로 승격하지 않습니다. 특히 수량 1~3개/1~5개라는 두 단방향 충분조건의 차이만으로 모순이나 범위 밖 부정을 만들지 않습니다. `conflict_assessment`는 reported/needs_semantic_review로 한정합니다.

graph/review가 손상돼도 읽힌 원문은 반환할 수 있습니다. 다만 해당 component.status/policy_evaluation.status를 unavailable로 두고 machine 결과를 ‘최신 전문가 판단 반영 결과’로 대체하지 않습니다. 이는 문서 정책의 기존 active/other_scope/pending/inactive enum에 unavailable을 추가한다는 뜻이 아니며, 확인할 수 없는 현재 정책값은 생성하지 않습니다. 같은 문서의 graph/review 실패가 원문 anchor만 실제로 의존하는 D-038 대응까지 무효화하지 않게 컴포넌트별 purpose/required_by를 유지합니다. 반대로 그 파일을 실제 참조한 판단은 적용에 쓰지 않습니다.

#### 캡처·버전·예산

결정: 요청마다 인증→허용 tenant/read/profile 확인 후 **한 번의 tenant 잠금**에서 발견/선택과 실제 자료 캡처를 수행합니다. 단일 평가 시각도 한 번 정해 모든 대응에 사용합니다. 기존 공개 query/context/find를 순차 호출해 시점을 섞거나, 바깥 잠금 안에서 잠금을 다시 취득하는 public API를 호출하지 않습니다.

기존 [검토 캡처](../../../core/modules/reviews/store.py)의 _query_captured 및 원장 parser, [대응 캡처](../../../core/modules/correspondences/capture.py)·[검증](../../../core/modules/correspondences/evidence.py)·[적용 계산](../../../core/modules/correspondences/applicability.py)을 [통합 캡처](../../../core/modules/knowledge/capture.py)와 [조회 조립](../../../core/modules/knowledge/concepts.py)에서 재사용합니다. D-027의 _context_selection도 그대로 재사용해 부분 태그의 미분류 상태를 보존합니다. 원장은 항상 전체 크기/체인/replay를 검증한 뒤 선택 이벤트만 결과에 투영합니다. 공유 raw cache·바이트 예산과 대응 root별 docs/reached/순환 stack·8문서/8의존대응/깊이4 제한을 분리합니다. root마다 독립 32 MiB를 허용하거나 여러 root를 하나의 D-038 closure로 세지 않습니다.

resource_manifest는 각 source/graph/review/history/대응을 `kind, key, revision 또는 null, status, captured_bytes, purpose, required_by`로 기록합니다. source-only anchor는 source/history만 판단 필수 자료이며 같은 문서를 표시하기 위해 읽은 graph/review 상태와 구분합니다. 인용/주장을 검증할 근거가 빠지면 그 결과 단위를 current로 표시하지 않습니다.

- `snapshot_revision`은 contract_version·tenant·권한 정책 revision·명시 선택/확인된 target·실제 캡처 manifest·발견/선택 coverage를 정규화한 조회 hash입니다. 평가 시각 자체는 넣지 않습니다. 같은 선택/자료 집합에서 시각만 달라지면 유지되지만 direct_confirmed가 실제 확장 집합을 바꾸면 manifest/선택이 바뀌므로 달라질 수 있습니다.
- `evaluation={profile_id, profile_definition, policy_revision, application_context, requested_as_of, evaluated_at}`와 `view_revision=H(snapshot_revision, evaluation, projection_scope, eligibility/statuses)`를 별도로 반환합니다. 기간이 지난 결과나 다른 관점의 결과를 캐시에서 재사용하지 않습니다. PoC에는 영구 결과 캐시·페이지 간 snapshot 예약을 두지 않습니다.
- 두 조회 hash는 권한·저장 CAS·과거 이력 복원을 대신하지 않습니다. as_of는 **현재 캡처한 자료**를 해당 시각의 기간에 비추는 옵션입니다. 당시의 정책/원문 전체를 복원하지 않으며 실제 답변/수정 전에 최신 자료를 다시 확인합니다. 접근정책과 데이터 파일 사이의 분산 원자 거래도 약속하지 않습니다.

부분 결과의 hash는 `revision_scope=partial_manifest`로 표시하고 확보한 자료/불가 상태의 관측만 식별합니다. 미확보 component는 revision=null·명시 status로 남기며 hash가 같다고 그 자료의 내용이나 최신성이 같다고 증명하지 않습니다. 전체 의미 범위의 최신성·부재를 보장하는 token이나 불완전 결과를 재사용할 캐시 검증자로 쓰지 않습니다.

PoC 예산은 아래로 고정합니다. 개수는 중복 ref가 아닌 고유 자료를 세며 바이트는 원문/graph/문서 원장/대응 원장을 모두 포함합니다.

| 항목 | 상한과 처리 |
| --- | --- |
| 명시 선택 | target 1개, target 문서를 포함한 explicit 문서 8개, target 대응을 포함한 root 대응 8개 |
| 상세 query의 실제 읽기 | content 문서 16개, 평가/탐색 전용을 포함한 전체 문서 32개·전체 대응 32개. 명시 root 최대 8개이며 나머지 대응 24개에는 직접 확장/의존/scan-only를 모두 포함. 각 D-038 root의 기존 closure 제한도 유지 |
| 별도 find 요청의 발견 탐색 | 고유 문서 후보 100개·대응 파일 100개. 상세 query에 이 별도 100/100 예산을 더하지 않음. include_history도 해당 요청의 같은 예산 안에서 검증 후 탐색 |
| 디렉터리 탐색 | 각 find/query 요청의 위키/문서 검토·대응 디렉터리 탐색 항목 합계 1,000개. scan-only 파일도 요청의 고유 자료 수·공통 32 MiB에 포함 |
| 히스토리 목록 | 문서당 10,000개 및 요청 전체 합계 10,000개. 발견 디렉터리 항목 예산과 별도이며 공유 budget을 받는 캡처가 필요 |
| 바이트/출력 | 실제 캡처 32 MiB, 상세 응답 8 MiB·발견 응답 2 MiB(MCP 텍스트/구조화 이중 포장 제외), 결과 기본 20/최대 100. source/graph 각 1 MiB·원장 8 MiB 등 기존 단일 파일 한도 유지 |

target/명시 선택을 먼저 확보하고 허용된 직접 확장, 추가 발견/진단 순으로 처리하며 동일 우선순위는 정규 경로/ID 순으로 정합니다. 개별 claim·인용·조건·event snapshot을 중간에서 자르지 않습니다. 출력이 넘으면 선택된 전체 source/graph/판단 단위를 생략하고 component 상태와 빠진 ref·이유를 남깁니다. 선택 원장 전체 history를 항상 반환하는 계약은 아니며 최신/원래 판단·관련 pending event를 명시 ref로 출력합니다. `history_projection`에 검증한 이벤트 수·반환한 ref·생략 범위를 알리고 이력을 읽지 않고 최신이라고 추정하지 않습니다.

`completeness`는 `selection, capture, context, output` 네 축을 갖습니다. 최상위 complete는 요청한 제한 범위의 네 축이 모두 확보됐는지이며 current/approved와 별개입니다. 각 축의 범위/필수 component를 함께 반환하고 그래프 부재·손상/읽기 실패·원장 확인 불가·스캔/반환/closure 제한에는 complete=false와 구체 사유를 붙입니다. 자료를 모두 확보한 needs_review/unknown_scope/other_scope 자체는 실패가 아닙니다. 선택된 미검토·거절·보류 이력의 존재도 complete를 거짓으로 만들지 않습니다.

부재 확인은 missing, 읽기/검증 불가는 unavailable로 구분합니다. `skipped`에는 허용 tenant 안의 document/correspondence, component, phase, reason, required_by를 남기고 예산 중단은 truncated=true로 표시합니다. 빈 결과나 complete=true도 **명시한 탐색 규칙/범위 안**의 결과이며 위키 전체 의미 지식 없음·예외 없음·영향 없음의 증거가 아닙니다. 영구 cursor/자동 다음 페이지를 제공하지 않고 문서/대상 범위를 좁혀 새 조회하도록 안내합니다.

#### MCP 계약과 구현 경계

결정: 개인 인증 tenant 모드에 다음 read 도구 두 개를 추가했습니다. 공통 `tenant` 필수, `profile` 선택이며 기존 read 권한·요청별 소속/프로필 검사를 재사용합니다. profile은 조회/정책 적용 맥락이며 자료 접근 경계가 아닙니다. 같은 tenant의 다른 관점 자료는 상태를 붙여 보존하고 다른 tenant를 먼저 읽고 숨기지 않습니다.

| 도구 | 입력 | 결과 |
| --- | --- | --- |
| `ontology_concept_find` | `text`(1–200자), 선택 `documents`(1–8개), `include_history=false`, `application_context`, `as_of`, `limit`(20/최대100), 공통 tenant/profile | `scope, matches, resource_manifest, snapshot_revision, evaluation, view_revision, completeness, complete, truncated, skipped, access`. matches는 component/일치필드/원래 표현·typed target refs·출처·현재/과거·검토/정책/범위 상태를 포함. 문서 미지정은 제한된 tenant 탐색이며 이름을 자동 확정하지 않음 |
| `ontology_concept_query` | typed `target` 1개, 선택 `documents`, `correspondence_ids`(최대8개), `expansion=none/direct_confirmed`, `application_context`, `as_of`, `limit`(연결/후보 기본20·최대100), 공통 tenant/profile | 위 통합 묶음·실제 scope·target resolution·컴포넌트 상태·manifest·조회 hash와 평가 정보. limit은 전체 graph/원문을 자르는 인자가 아니며 넘친 구성요소는 부분 결과로 명시 |

target/ref·변경 시각·권한의 임의 위조는 입력으로 신뢰하지 않고 서버가 현재 저장 자료와 대조합니다. 알 수 없는 필드·encoded JSON 문자열·잘못된 경로/ID/offset 없는 as_of는 invalid_argument로 거부합니다. tenant/권한/정책 오류는 기존 access_denied/access_unavailable, 잠금은 storage_busy이며 이전 설정/다른 저장소로 우회하지 않습니다. root storage는 target의 문서 source 또는 target 대응 원장입니다. 이 root를 읽지 못하면 storage_error/해당 corrupt 오류로 실패합니다. source를 읽을 수 있는 entity/claim target의 graph/review 손상·선택 이벤트 문제와 그 밖의 부속 자료 실패는 정상 자료를 유지한 부분 결과입니다. 원장 손상을 초기화하거나 조회를 이유로 저장/재추출하지 않습니다.

두 도구는 `readOnlyHint=true, openWorldHint=false`이며 기존 SDK·전송·structured/text 결과·표준 출력 규칙을 유지합니다. legacy/공유 토큰에는 등록하지 않습니다. currentness 확인과 내부 캡처용 운영 잠금 파일 외 영구 파일·원장/인덱스·캐시·마이그레이션을 만들지 않습니다. ontology_generate 입력·기존 query/context/connections/impact 및 D-038 저장 계약은 바꾸지 않습니다. 개인 인증 tenant 도구의 구현·격리 검증만 수행하며 운영 연결 전환·UI·새 추출/모델 호출은 실행하지 않습니다.

[D-028]: ../reviews/DECISIONS.md#d-028--원문추출과-분리한-검토-원장과-상태-충돌-검사-2026-10-22-4-c
[D-031]: ../reviews/DECISIONS.md#d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1
[D-032]: DECISIONS.md#d-032--변경-문서의-직접-연결과-재검토-후보-안내-2026-10-23-선행-2
[D-037]: DECISIONS.md#d-037--문서에서-발견한-개념상태-조건의-연결과-통합-조회-방향-2026-10-23
[D-038]: ../correspondences/DECISIONS.md#d-038--문서-간-조건개념-대응-판단의-최소-계약-2026-10-23
[D-040]: DECISIONS.md#d-040--개념-중심-최신-지식-통합-조회-2026-10-23
[D-041]: ../access/DECISIONS.md#d-041--개인-인증-tenant-연결-전환과-보존복구-절차-2026-10-23
