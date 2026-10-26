# 문서 간 대응 결정

현재 구현 상태는 [PLAN](PLAN.md), 작업 시 지킬 상세 규칙은 도메인에 연결된 RULES를 따릅니다. 결정 번호·이유와 상세 계약을 보존합니다. 아래 결정 안의 날짜·시험 수·운영 상태는 기록 당시 값이며, 최신 구현 상태는 PLAN을 우선합니다. 필요한 D 번호·하위 절만 읽습니다.

### D-038 — 문서 간 조건·개념 대응 판단의 최소 계약 (2026-10-23)

상태: **대응 원장·복합 버전 검사·8개 MCP 도구를 구현**했습니다. [D-037]의 문서 간 연결 판단을 같은 tenant의 단일 보존 원장으로 다룹니다. 아래 상세 설계를 기존 저장/원장 모듈을 재사용해 구현했으며 실제 검증 결과와 한계는 [PLAN](../../history/2026-10-25-before-domain-split/PLAN.md#d-038-대응-원장복합-버전mcp-구현과-격리-검증-2026-10-23)을 따릅니다. v3 추출 스키마·기존 문서 원장·사용자 데이터·추출 프롬프트·UI·실제 연결 설정은 변경하지 않았습니다. 새 도구는 개인 인증 tenant 서버에만 등록되므로 구현 당시 legacy 연결에서는 사용할 수 없었습니다. 현재 로컬 읽기 연결 적용 상태는 [D-041]을 따릅니다. 완전한 합성 입력과 의미 예상 판정은 [PLAN의 예정 평가](../../history/2026-10-25-before-domain-split/PLAN.md#다음-평가-예정--상태-조건과-공통-개념-연결)에서 한 번만 관리합니다.

#### 판단 대상과 연결의 의미

- 최소 단위는 **같은 워크스페이스의 ‘문서 A에 있는 조건’ → ‘문서 B에서 사용하는 개념’이라는 한 대응 판단**입니다. A의 이름 없는 조건을 참조할 수 있으며 ‘매진 임박’이라는 가짜 개체를 A의 기계 추출에 추가하지 않습니다. 문서·개체 자체를 합치거나 원문을 수정하는 작업과 구분합니다. 공통 개념 전체 등록부를 먼저 구축하는 것은 이 계약의 전제가 아닙니다.
- ‘수량 1~5개’와 ‘매진 임박 상품은 출고를 우선한다’만 있으면 수량의 뜻과 연결 정의를 확인할 **후보**입니다. 두 끝점의 인용은 각 표현의 존재를 보여줄 뿐, 둘이 대응한다는 근거가 아닙니다. 예약 수량·주문 수량·남은 판매 가능 재고를 구분하며, 확인되지 않은 수량을 재고로 채우지 않습니다.
- ‘판매 가능 재고가 1개 이상 5개 이하이면 매진 임박’은 **조건→개념의 단방향 분류**입니다. 모든 매진 임박 상품의 재고가 그 범위라는 역방향·동치·범위 밖 상품의 부정 분류를 도출하지 않습니다. 동치는 양쪽 방향을 뒷받침하는 정의 또는 그 전체 내용을 명시한 전문가 판단이 있을 때만 별도로 기록합니다. 이 대응을 `same_as` 개체 동일성이나 기존 `part_of`로 대신하지 않습니다.
- 대응의 수용은 그 연결만 채택한 것입니다. 문서 B의 출고 방침과 모든 주변 주장을 승인하거나 특정 상품의 현재 재고를 확인한 것이 아닙니다. 답변에서 출고 방침까지 설명하려면 대응의 현재 상태와 B의 규칙·조건·예외·최신 전문가 판단을 함께 확인하고 각각의 출처를 제시합니다. 출고 실행·자동 분류·추론 엔진은 추가하지 않습니다.

#### 근거 종류와 권한

| 구분 | 대응 자체의 근거 | 검토와 사용 기준 |
| --- | --- | --- |
| AI의 대응 제안 | 두 표현을 비교한 이유, 불명확한 부분, 확인 질문. 끝점 인용과 연결 근거의 부재를 구분 | 미검토 후보로 보존. AI가 스스로 사람의 수용이나 업무 정책으로 표시하지 않음 |
| 원문에 근거한 대응 | A/B 또는 별도 정의 문서 D가 **두 의미를 실제로 연결하는** 정확한 구절·위치·원문 버전. 추가 조건·예외도 포함 | 근거의 존재와 의미적 지지·사람의 검토 여부는 별개. 원문 근거 검토 권한으로 수용/수정/거절/보류하되, 양끝점 인용만으로 근거 충족 처리하지 않음 |
| 전문가의 업무 판단 | 연결 정의가 원문에 없어도, 권한 있는 전문가가 실제 요청한 판단 내용·이유·적용 범위와 Action log | 원문 근거 검토와 별도 전문가 정책 권한 필요. A/B의 끝점 참조는 유지하지만 대응의 출처는 판단 이벤트이며 가짜 인용을 만들지 않음 |

권한 구분은 [D-026]·[D-028]·[D-031]의 `read`·`ontology_write`·`ontology_review`·`ontology_policy` 역할을 재사용합니다. 생성 권한만으로 수용하거나 원문 근거 검토 권한만으로 무인용 업무 정책을 만들 수 없습니다. 조회와 모든 변경 전에 인증·소속·행동 권한을 확인하며 다른 tenant 자료를 읽어 후보를 만들지 않습니다. 각 도구의 정적 권한 매핑을 유지하고 source/expert undo도 별도로 등록했습니다. 실제 클라이언트 연결 설정 전환은 별도 작업입니다.

전문가는 근거 없는 후보를 받아 업무 판단을 만들 수 있고, 현재 `ontology_policy`가 거부하는 후보/문서 간 대응을 다룰 새 경로가 필요합니다. 이때 원래 후보를 ‘원문이 지지한 관계’로 바꾸지 않고, **같은 대응 대상에 전문가 판단을 추가한 이력**을 남깁니다. 원문 해석과 업무 판단은 함께 보존합니다. 동일 대상·동일 적용 범위의 기존 판단을 대체하려면 대체 대상을 명시하며, 일반 검토로 전문가 정책을 조용히 덮어쓰지 않습니다. AI의 모의 판단은 simulation이고 인증 토큰 사용만으로 사람이 직접 확인했다고 증명하지 않습니다.

#### 판단 한 건에 남길 최소 정보

| 정보 | 보존할 내용 |
| --- | --- |
| 식별과 양쪽 대상 | 워크스페이스, 대응 판단의 안정된 식별자, A의 조건 구절과 B의 개념 구절, 각각의 문서·원문 revision·정확한 인용·위치. 표시 이름을 식별자로 사용하지 않음 |
| 연결의 뜻 | 사람이 읽을 대응 문장, 조건→개념 또는 명시적 동치의 방향, 수량 대상/단위/경계 포함 여부, 추가 조건·예외. 미확인은 미확인으로 유지 |
| 실제 근거 | 연결을 뒷받침하는 문서 D의 구절·버전 또는 전문가 판단 이벤트·이유. 후보는 연결 근거와 필요한 확인 질문의 부재/존재를 구분 |
| 적용 범위 | 업무/서비스·대상 집합·채널/지역 등 의미에 필요한 경계, 유효 시작·종료와 시간대, 추가 조건·예외. 출처 또는 전문가가 실제 정한 범위만 사용 |
| 기준 상태 | 양쪽 원문과 실제 의존하는 정의·그래프·검토/정책의 버전, 대응 판단 자신의 현재 상태 버전. 원문 내용이 같아진 중간 변경도 구분 |
| 검토 이력 | 제안·수용·수정·거절·보류·대체·되돌림의 전후 내용, 주체·권한/범위·시각·이유·기준/결과 버전·참조 이벤트. 접속 관점은 감사 정보로 별도 기록 |

이름 없는 조건은 원문 구절로 참조할 수 있습니다. 기존 개체·주장을 사용하면 `(문서, 문서 내 ID 또는 claim_id, graph/state revision)`과 당시 의미 스냅샷을 함께 보존합니다. LLM의 임시 ID·배열 위치·이름 일치만으로 재추출 후 같은 대상을 찾아 승인을 이식하지 않습니다. 과거 근거와 판단은 당시 내용을 설명할 수 있도록 보존하며, 현재 문서의 바뀐 구절을 옛 인용으로 표시하지 않습니다.

#### 적용 범위와 현재 판단

- **미확인·명시적으로 제한 없음·특정 범위**를 구분합니다. 빈 값이나 누락을 ‘전 워크스페이스에 적용’ 또는 ‘예외 없음’으로 취급하지 않습니다. 적용 여부에 필요한 수량 의미·범위·기간이 미확인인 후보는 유효한 대응으로 사용하지 않고 확인 질문을 남깁니다. 시작/종료가 있는 기간은 경계 포함 여부와 시간대를 함께 명시합니다. 모든 문서에 지역·채널·기간을 새 필수 입력으로 요구하지는 않습니다. 해당 판단에 필요한 축을 확인하고, 원문에 언급되지 않은 축을 임의로 전역 적용으로 확대하지 않습니다.
- 업무 범위는 정의나 전문가의 판단 내용에서 정합니다. 접속자의 현업/개발자 관점을 자동 복사하여 의미 범위를 바꾸거나 문서 접근을 제한하지 않습니다. 기존 [D-031] 정책을 근거로 참조한 경우에는 그 정책의 정확한 `domain/viewpoint` 적용 범위도 추가 제약으로 유지합니다. 연결을 만들었다는 이유로 그 범위를 넓히거나 `null`을 전체 관점으로 바꾸지 않습니다. 기존 정책 API의 범위 계약을 변경하는 결정이 아닙니다.
- 정의 문서 D에 ‘판매 중이고 단종 대상이 아님’이라는 조건이 있다면 ‘재고 1~5개’만으로 그 조건을 충족했다고 판단하지 않습니다. 필요한 조건을 포함하도록 대응을 한정하거나 보류합니다. 규칙을 알고 있다는 것과 개별 상품이 현재 규칙을 충족한다는 것도 구분합니다.
- 같은 대응·범위에서 전문가가 명시적으로 대체한 업무 기준은 적용 판단으로 사용하되 이전 원문 정의는 그 출처와 함께 남깁니다. 서로 다른 범위의 판단을 전역 최신값 하나로 덮어쓰지 않습니다. 같은 범위에서 상충하는 별도 판단이 확인되면 충돌을 드러내고 임의로 최근 작성자를 정답으로 고르지 않습니다. 모든 범위의 중첩·모순을 자동 계산하는 기능까지 약속하지 않습니다.

#### 검토 상태와 변경 후 처리

검토자가 **무엇을 결정했는지**와 **지금 적용할 수 있는지**는 별도입니다. 예를 들어 ‘수용됨 · 근거 변경으로 재검토 필요’는 유효한 조합이며, 과거 수용 이력을 지우지 않습니다.

아래 ‘현재 적용 가능’은 검토한 문서 간 공통 대응 판단의 상태입니다. 원문에 명시된 미검토 주장은 그 출처·검토 여부와 함께 조회할 수 있으며, [D-028]의 미검토 근거 주장이 `effective_graph`에 남는 계약을 유지합니다. 모든 기계 추출·조회에 사람의 사전 승인을 요구하는 것으로 확대하지 않습니다.

| 행위 또는 상태 | 의미 |
| --- | --- |
| 제안/미검토 | 확인 질문이 있는 후보 또는 아직 검토하지 않은 원문 근거 대응. 검토된 공통 연결로 표시하지 않음 |
| 수용 | 제시된 대응·방향·조건·범위를 채택. 주변 주장이나 신규 문서까지 일괄 승인하지 않음 |
| 수정 | 변경 전후를 새 이벤트로 남김. 수정만으로 승인됐다고 추정하지 않고 ‘수정 후 수용’인지 ‘수정 후 보류’인지 함께 명시. 새 AI 제안은 기존 수용을 유지한 채 덮어쓰지 않음 |
| 거절 | 해당 제안을 채택하지 않음. 반대 관계나 두 개념의 차이를 확정한 것이 아님 |
| 보류 | 근거·수량 뜻·범위 등의 확인이 더 필요함. 사유·질문을 유지 |
| 현재 적용 가능 | 수용 판단·근거가 현재 버전이고 질문의 업무 범위·기간에 맞으며 조건·예외가 보존되어 참조 가능한 상태. 개별 상품이 그 조건을 충족했다는 판정과는 별개 |
| 재검토 필요/확인 불가 | 의존 자료·정의·판단이 변경됐거나, 자료를 읽지 못해 현재성을 확인하지 못함. 과거 판단은 남기되 현재 유효 근거로 사용하지 않음 |
| 범위 밖/기간 밖/비활성 | 다른 범위의 판단이거나 아직 시작 전·기간 종료·거절/보류된 판단, 대체/되돌림으로 철회된 판단 내용. 되돌림 후 복원된 직전 판단의 적용 가능 여부는 별도로 확인. 다른 범위의 판단 자체가 틀렸다는 뜻은 아님 |

양쪽 원문, 실제 근거인 제3 정의 문서, 참조한 그래프·검토/전문가 정책 또는 해당 대응의 뜻·범위가 바뀌면 이전 판단의 현재 적용을 중단하고 재검토 대상으로 표시합니다. 의미가 같아 보인다는 이유로 버전만 바꿔 승인 상태를 이어 붙이지 않습니다. 변경 없는 no-op은 상태를 유지할 수 있지만 내용 A→B→A는 이력 버전으로 구분합니다. 기간 종료는 재추출 없이 조회 시 적용 범위 밖으로 표시합니다. 원문·그래프 저장과 영향 안내는 별도이며 이 과정에서 자동 재추출하지 않습니다.

#### 충돌·실패 보존·되돌림

- 검토/수정/되돌림은 **판단 자신의 기준 상태와 모든 실제 의존 자료의 기준 상태**를 함께 비교해야 합니다. 양쪽 A/B만 검사하고 정의 D나 참조 정책 이벤트를 빼지 않습니다. 현재 원문·그래프·원문 히스토리·검토 상태의 추적은 [D-028]·[D-031]을 재사용하며, 그래프를 참조하지 않은 원문 구절 대응에 임의의 그래프 ID를 요구하지 않습니다.
- 같은 워크스페이스의 일관된 읽기와 저장 경계에서 비교합니다. 그 사이 한 상태라도 달라졌으면 충돌로 거부하고 최신 내용·판단을 다시 대조합니다. 버전 token만 갈아 끼워 오래된 판단을 재전송하지 않습니다. 공개할 저장 API의 구체 인수·복합 상태 token 형식은 아래 상세 계약을 따릅니다.
- 한 대응에는 논리적으로 하나의 변경 이력을 둡니다. A/B 원장에 동일 판단을 중복 쓰고 일부만 성공하는 구조를 만들지 않습니다. 원자적 저장·저장 실패 시 이전 기록 보존·저장 성공 후 정리 경고 구분·손상 시 자동 초기화 금지는 기존 원장 원칙을 재사용합니다. 원문·히스토리·기계 그래프를 대응 저장의 부수 효과로 바꾸지 않습니다.
- 되돌림은 같은 대응·같은 적용 범위의 **가장 최근 변경을 대상으로 새 이벤트**를 남깁니다. 이전 이벤트를 삭제하거나 다른 판단을 연쇄 취소하지 않습니다. 되돌림에도 해당 근거 종류의 변경 권한과 최신 상태 검사가 필요합니다. 직전 판단 내용과 검토 상태를 복원하므로, 거절 후 수용을 취소하면 거절 상태로 돌아갑니다. 이전 판단 없이 처음 만든 전문가 결정을 취소하면 그 결정은 비활성이며, 남아 있는 원래 후보를 수용한 것으로 바꾸지 않습니다. 철회된 내용과 복원된 판단을 구분하고, 복원된 판단의 적용 가능 여부는 현재 근거·범위·기간으로 다시 확인합니다. 이전 수용을 복원하더라도 현재 의존 자료가 달라졌다면 재검토 상태로 둡니다. 오래된 버전의 승인이나 유효기간을 자동 복원하지 않습니다.
- 다른 대응이 되돌린 판단을 참조했다면 의존하는 판단은 재검토 대상으로 안내합니다. 그 판단 자체의 이력이나 문서를 함께 되돌리지 않습니다. 저장 성공 뒤 조회·영향 안내 실패를 이유로 같은 저장을 반복하지 않습니다.

#### 다음 문서에서의 재사용과 구현 경계

새 문서 C에서는 기존 대응의 현재 내용·근거·범위·버전·검토 상태를 조회해 비교합니다. 기존 판단을 참고했다는 연결은 남기되 **C에 대한 대응은 새 제안/판단**이며 기존 승인 상태를 복사하지 않습니다. 보류·거절·오래됨·범위 밖 판단과 되돌림으로 철회된 내용은 현재 적용 가능한 판단과 구분합니다. 후속 [D-040]에서 문자열 발견·명시 선택한 선례와 최신 지식의 통합 조회를 구현했습니다. 정의·수치의 의미를 자동 비교해 선례를 추천하거나 새 대응을 승인하는 기능은 제공하지 않습니다.

기존 `_reviews/`의 이벤트 보존·상태 CAS 원칙을 아래와 같이 재사용합니다. 현재 문서별 `claim_id` API가 문서 간 대응을 지원한다고 간주하지 않습니다. BC 등록 체계·검색 가중치·자동 개념 병합·새 논리 추론·UI를 이 최소 계약의 필수 조건으로 추가하지 않습니다.

#### 기존 원장의 재사용 판정과 저장 위치

결정: **저장 기계장치는 재사용하고, 문서별 원장의 파일·이벤트 스키마는 유지**합니다. 허용 tenant의 데이터 루트 안에 `_reviews/correspondences/<correspondence_id>.json`을 두며 대응 한 건의 제안·원문 검토·전문가 판단·되돌림을 그 파일 하나에 순서대로 보존합니다. A/B/D의 문서 원장에 대응 사본을 쓰거나 별도 정답·승인 인덱스를 관리하지 않습니다. 이 하위 원장도 보존 자료이며 파생 캐시로 삭제하지 않습니다.

| 기존 구성 | 재사용/변경 설계와 이유 |
| --- | --- |
| `WikiStore._write_lock()`·경로/일반 파일 검사·`_staged_file()` | 같은 tenant의 잠금, 심볼릭 링크 거부, staging·flush·fsync·임시 파일 정리를 재사용한다. 코드 구현 때 공통 경계를 분리하며 저장 순서를 복제하지 않는다. |
| `ReviewStore`의 정규 JSON/hash chain·전체 원장 교체·오류/정리 경고 | 대응 원장에도 같은 보존 방식과 엄격한 검증을 적용한다. 기존 `_commit_locked()`의 문서 경로와 parser를 인자만 바꿔 호출하지 않는다. |
| 원문·그래프·검토·히스토리 상태 캡처 | 같은 잠금 안의 공통 캡처·검증을 재사용한다. 원문 구절 참조와 그래프/정책 참조의 의존 범위는 아래에서 나눈다. |
| `_reviews/<document SHA-256>.json` v1/v2 | 기존 바이트·이벤트 hash를 수정하거나 이관하지 않는다. 현재 parser는 단일 document·collection·claim_id와 현재 v3를 요구하므로 새 대응을 기존 claim으로 위장하지 않는다. |
| 기존 `ontology_review*`·`ontology_policy*`와 v3 | 문서 내 관계·속성/후보 계약을 유지하고 대응 전용 도구·검증기를 추가했다. 기존 도구의 성공을 대응 저장 성공으로 해석하지 않는다. |

근거 코드는 [검토 원장](../../../core/modules/reviews/store.py)의 `_ledger`·`_captured_state`·`_mutate`·`_policy_mutate`와 [저장 모듈](../../../core/modules/documents/store.py)의 잠금·staging·신규 파일 공개입니다. 문서별 검토와 대응 저장은 같은 잠금을 사용하지만 한 요청이 두 원장을 함께 수정하는 거래는 만들지 않습니다. 기존 문서 검토 CAS에 대응 원장 전체를 추가하지도 않습니다. 문서 변경으로 대응이 오래되면 다음 대응 조회에서 의존 상태를 다시 계산합니다.

대응 원장은 독립 형식 `version=1`로 시작하며 최상위 필드는 `version, tenant, correspondence_id, documents, events`로 고정합니다. `documents={condition, concept}`는 정규화한 A/B 상대 `.md` 경로이며 한 대응 안에서는 고정합니다. 제3 정의 문서는 근거 목록에 둡니다. ID는 prepare 조회에서 서버가 발급하는 UUID4의 소문자 32자리 hex로, tenant 안에서만 의미가 있습니다. 이름·문장 hash·문서 내 entity ID와 구분합니다. 문서 이동/이름 변경 API는 현재 없으므로 옛 경로가 없어지면 missing으로 남기고 새 경로에 새 대응을 제안하며 `related_to`로 과거 판단을 참조할 수 있습니다. 이름이나 내용 hash로 자동 재연결·승인 이식하지 않습니다. 같은 문서 쌍도 범위와 뜻이 다를 수 있어 자동 중복 제거하지 않습니다.

기존 v1/v2 문서 원장의 reader는 그대로 유지하고, 대응은 전용 reader만 읽습니다. 지원하지 않는 대응 version·잘못된 hash chain·중복 JSON 키·중복 event ID·불일치 before/after는 자동 변환/초기화 없이 `correspondence_corrupt`로 거부합니다. 새 대응 디렉터리는 최초 propose 때 만들며 기존 원장을 마이그레이션하지 않습니다. 이번 실행의 파일 생성/실패 주입은 모두 임시 데이터에서 수행했습니다.

#### 대응 값·이벤트·판단 계층의 구체 형식

대응 값 `value`는 아래 필드 전체를 보존합니다. 없는 필드를 전역 적용이나 무조건 참으로 채우지 않으며, JSON의 알 수 없는 필드는 거부합니다. 원문 인용·기존 개체/주장의 스냅샷은 저장 전에 서버가 읽은 바이트와 대조합니다. 모든 source/expert replacement도 condition/concept의 document가 최상위 고정 documents와 같아야 하며, anchor 안의 경로를 바꿔 문서 쌍을 우회할 수 없습니다.

| 필드 | 형식과 의미 |
| --- | --- |
| `condition`, `concept` | 각각 `document, source_revision, quote, start_line, end_line`을 가진 원문 anchor. 동일한 줄에서 인용이 여러 번 나오면 0부터 세는 `occurrence`도 명시한다. 이름 없는 조건은 이 anchor만으로 충분하다. 선택 `graph_ref`는 `graph_revision, collection, entity_id 또는 claim_id`와 당시 의미 snapshot을 함께 보존한다. 배열 인덱스만 받지 않는다. |
| `statement`, `direction` | 사람이 읽는 전체 대응 문장과 `condition_to_concept` 또는 `equivalent_definition`. 역방향·동치의 근거를 별도로 확인한다. v3의 relation predicate나 entity 병합으로 저장하지 않는다. |
| `qualifiers` | `quantity, conditions, exceptions`를 모두 가진다. quantity는 `unknown/not_applicable/specified`와 원문 표현을 보존하고, specified이면 수량 대상·단위·하한/상한 및 각 경계 포함 여부를 명시한다. 미지원 복합 논리는 원래 문장으로 남기고 실행 가능한 수식으로 변환했다고 주장하지 않는다. |
| `business_scope` | `axes, validity`를 가진다. 각 업무/서비스·대상 집합·채널·지역 등 필요한 축은 이름과 `unknown/unrestricted/specified`, 값 및 출처를 보존한다. 조건/예외가 없다는 판단도 `unknown`과 명시적 `none`을 구분한다. validity 역시 미확인/명시적 무기한/기간을 구분하고 기간은 timezone·UTC offset이 있는 시작/종료와 경계 포함 여부를 명시한다. 접속 profile을 업무 범위로 복사하지 않는다. |
| `basis` | `candidate/source/expert` 중 하나. candidate에는 비교 이유·확인 질문과 연결 근거가 비어 있다는 사실을, source에는 실제 연결을 말하는 `link_evidence` anchor 1개 이상과 추가 조건 구절을 둔다. expert에는 연결 인용을 받지 않고 서버가 판단 event를 출처로 넣는다. A/B의 anchor는 모든 종류에서 계속 필요하다. |
| `references` | 실제 사용한 그래프/문서 검토·정책·다른 대응의 event 참조. 각 참조는 종류·문서 또는 대응 ID·event_id·당시 값·버전·정확한 적용 범위를 가진다. source 인용과 Action log 출처를 구분하며 끝점 인용만을 연결 근거로 바꾸지 않는다. |
| `questions`, `related_to` | 미확인 질문 목록과 비교/새 문서 재사용의 선례 참조. `related_to`는 자동 대체/수용이 아니며 판단을 실제로 의존하면 `references`에도 넣는다. |

수량·조건·범위의 자유문장도 보존합니다. schema 통과와 실제 인용 존재는 의미적 충분조건·동치·범위 충족의 증명이 아닙니다. 이 판단은 검토 및 별도 의미 평가에서 확인합니다. 원문 근거로 확정할 수 없는 candidate를 전문가 판단으로 채택할 때는 `basis=expert`인 별도 판단을 만들고 원래 source 제안을 그대로 남깁니다.

이벤트 공통 필드는 `id, sequence, action, lane, judgment_id, before, after, reason, actor, timestamp, basis_dependencies, observed_dependencies, base_state_revision, undo_of, supersedes_event_id, previous_hash, hash`입니다. `id`·`sequence`·UTC 시각·인증 user/tenant/profile/정의/access policy revision·출처는 서버가 채웁니다. sequence는 1부터 연속 증가하고 최초 previous_hash는 null, 이후는 직전 event hash입니다. 정규 JSON은 기존 원장의 UTF-8·키 정렬·compact 표현을 재사용하고 event hash는 hash 필드를 제외한 전체 event의 SHA-256입니다. `before/after`는 값·검토 상태·그 판단 당시 의존 기준을 포함한 전체 snapshot이며 최초 source propose의 before만 null입니다. 요청에서 actor·승인자·hash·시각·결과 token을 받지 않습니다. `basis_dependencies`는 복원된 판단을 포함한 실제 근거의 옛 기준, `observed_dependencies`는 이번 CAS에서 확인한 현재 상태로 서로 다릅니다. 자기 원장의 correspondence_revision/base_state_revision은 CAS·감사용이며 자신의 판단 근거 baseline으로 복사하지 않습니다. 그렇지 않으면 자기 event를 추가하는 순간 옛 판단을 stale로 오인할 수 있습니다. 해시 연결은 우발 손상 탐지이며 외부 서명/파일 관리자 변조 방지 장치가 아닙니다.

- `lane=source`에는 최초 `propose`와 `review/review_undo`를 기록합니다. 검토 상태는 `unreviewed/accepted/rejected/deferred`입니다. 수정은 전체 replacement와 `accepted` 또는 `deferred`를 함께 받습니다. 이미 검토된 값을 새 AI propose로 덮지 않습니다. 새 AI 대안은 새 대응 제안으로 남기며 원래 판단은 보존합니다.
- `lane=expert`에는 `policy/policy_undo`를 기록합니다. 서버가 발급한 `judgment_id`별로 명시한 업무 범위와 필요한 관점 제약을 고정하고 `active/inactive`의 정책 상태를 보존합니다. 첫 정책의 before는 inactive이며 source의 review 상태를 바꾸지 않습니다. 같은 judgment를 바꿀 때는 최신 정책 event를 명시합니다. 범위가 달라지면 별도 judgment로 기록합니다.
- 전문가 판단의 업무 범위는 profile에서 자동 생성하지 않습니다. 이 경로의 `policy_scope`는 허용 profile에서 서버가 얻은 정확한 `{domain, viewpoint}`로 고정하며 null도 wildcard로 넓히지 않습니다. 다른 profile 사용자가 같은 tenant의 이력을 읽을 수 있어도 현재 적용 범위를 넓히지 않습니다. 기존 D-031 정책을 참조하면 그 원래 exact scope도 추가 제약으로 보존합니다.
- 수용된 source 판단을 전문가가 대체하거나 같은 범위의 기존 정책을 변경하려면 `supersedes_event_id`로 해당 파일 안의 최신 판단을 명시합니다. source 문장/검토 이력은 남고 적용 우선순위만 명시됩니다. business scope의 정규화 값이 같아야 하며 expert끼리 대체할 때는 policy scope도 정확히 같아야 합니다. source 판단을 대체하는 정책은 자신의 policy scope 안에서만 우선하고 다른 관점의 source 적용을 바꾸지 않습니다. scope 비교는 축/미확인 여부/값/기간 경계의 구조적 일치이며 표현이 다른 범위의 의미 동등성을 자동 판정하지 않습니다. 일반 review로 expert 판단을 수정/취소하지 않습니다. 범위가 겹칠 수 있는 별도 판단은 공존 상태와 알려진 상충을 드러내며 시각이 최신이라는 이유로 선택하지 않습니다. 다른 대응 파일을 한꺼번에 대체하는 기능은 이번 계약 밖입니다.

조회는 `decision`과 `applicability`를 나눕니다. applicability는 `applicable/needs_review/unavailable/unknown_scope/other_scope/out_of_period/inactive/conflicting`과 이유 목록을 반환합니다. 수용됨과 재검토 필요를 함께 표시할 수 있습니다. source 후보·원문 근거 미검토·expert 판단을 별도로 반환하며, 알려진 상충은 `conflict_refs`로 드러냅니다. 모든 범위의 논리 모순을 자동 탐지했다고 보장하지 않습니다. 기존 `effective_graph`에 대응을 끼워 넣거나 미검토 원문 사실을 차단하지 않습니다.

#### 복합 상태 token과 변경 검사

결정: 대응 상세/prepare 조회는 `correspondence_revision`(원장 원시 바이트 SHA-256, 신규 준비만 null), `dependencies`와 `state_revision`을 반환합니다. `state_revision`은 정규 JSON의 `contract_version=1, tenant, correspondence_id, correspondence_revision, access_policy_revision, selected_profile, payload_digest, dependencies`를 SHA-256한 값입니다. payload_digest는 prepare의 draft 또는 기존 대응의 현재 전체 판단 snapshot을 식별합니다. token은 서버가 같은 상태를 다시 관측해 비교하는 CAS 값이며 서명·권한·사람 승인 증거가 아닙니다. event의 결과 원장 hash/token을 같은 event 안에 넣어 자기 참조시키지 않고, 응답의 결과 token과 event ID/sequence/hash로 결과 버전을 확인합니다.

| 의존 종류 | 검사할 기준 |
| --- | --- |
| 원문 anchor만 참조 | 문서 경로·`source_revision`·`history_revision`과 상태. 그래프를 사용하지 않으면 그래프 ID/생성은 요구하지 않고 무관한 graph/문서 원장의 부재·손상을 읽어 작업을 막지 않는다. |
| graph/entity/claim 참조 | 위 기준에 `graph_revision`·`review_revision`·D-028 `state_revision`을 더하고 참조 snapshot·인용을 검증한다. 사용한 검토층과 collection도 고정한다. |
| 문서 검토/전문가 정책 참조 | 해당 문서의 전체 상태와 `event_id`·정확한 scope·당시 판단 snapshot. event가 존재하는지만 보지 않고 현재 적용 판단인지 확인한다. |
| 다른 대응 판단 참조 | 대응 ID/event·원장 revision·그 대응의 실제 의존 closure를 포함한 현재 상태와 적용 여부. 원장이 그대로여도 그 정의 문서가 바뀌면 상위 판단도 재검토한다. |

검사 대상은 서버가 **저장된 현재 snapshot, 변경안, 되돌릴 before snapshot**의 실제 참조에서 합집합으로 도출합니다. 클라이언트가 제출한 dependencies만 믿거나 edit로 근거를 빼서 옛 근거 검사를 생략하지 않습니다. 삭제·missing·읽기 실패도 상태로 구분하며, 허용 tenant 밖 참조는 그 경로/존재를 읽기 전에 거부합니다. 참조 대응의 의존 순환은 거부하고 아래 closure 한도를 넘으면 불완전/한도 오류로 처리합니다.

한 번의 tenant 잠금에서 원문·히스토리 목록·사용한 그래프/문서 원장·대응 원장의 필요한 바이트를 확보해 검증합니다. 변경 요청은 인증/권한 확인 후 잠금 안에서 상태를 다시 캡처하고 token을 비교한 다음 검증·새 이벤트 생성·단일 파일 공개까지 마칩니다. 접근정책은 데이터 루트 밖의 기존 권한 모듈로 요청마다 다시 확인하고, 준비 때 policy revision/profile 정의가 달라졌으면 재조회하도록 conflict 처리합니다. 이 비교는 외부 접근정책 파일과 데이터 원장의 분산 원자 거래를 보장하지 않습니다.

신규 생성은 prepare가 발급한 ID의 **부재**도 검사합니다. 두 요청이 같은 준비 ID/token으로 경쟁하면 첫 공개만 성공하고 나머지는 conflict입니다. 서로 다른 준비 ID의 의미적 중복은 자동 병합하지 않습니다. 기존 대응에서는 어떤 lane의 이벤트라도 원장 hash가 달라지므로 같은 기준의 경쟁 저장은 하나만 성공합니다. 서로 다른 범위도 파일 단위 CAS로 보수적으로 직렬화하며 범위별 부분 병합은 하지 않습니다. 다른 의존 문서/정책/그래프의 동시 변경도 같은 잠금과 token으로 감지합니다.

원문 A→B→A는 히스토리 목록 revision, 그래프 A→B→A는 기존 generation_id 포함 graph revision, 검토·정책·대응의 변경/undo는 append된 원장으로 구분합니다. 원문 교체 실패 전에 히스토리만 늘어난 경우도 보수적으로 재검토할 수 있습니다. 내용이 같은 원문 저장·동일 그래프 재생성·조회는 실제 no-op을 유지합니다. 반면 동일 값이어도 명시적인 새 검토/정책 판단은 감사 이벤트이므로 append하며 token이 바뀝니다. 상태값만 최신으로 바꿔 옛 승인을 이어 붙이지 않습니다.

업무 범위/기간 적용 여부는 조회의 `application_context`와 `as_of`(생략하면 서버 현재 시각, 반환은 timezone 포함)로 별도 계산합니다. 지정하지 않은 업무 축은 unknown이며 profile로 채우지 않습니다. 시간이 지나 기간 밖이 된 것은 원장 변경이 아니므로 CAS token을 매초 바꾸지 않습니다. 적용 가능성은 참조 판단의 기간까지 조회/저장 시점에 다시 확인하며, 과거 as_of 조회를 과거 버전의 원장 복원으로 설명하지 않습니다.

#### MCP 인터페이스 상세 계약

결정: 아래 **8개 도구**를 개인 인증 tenant 모드에만 등록합니다. 공통 입력은 필수 `tenant`, 선택 `profile`이며 허용 소속/관점은 `access_context`에서 먼저 확인합니다. 권한·프로필 확인 후 그 tenant 저장소만 읽고 모든 변경에는 `read`도 요구합니다. `domain/viewpoint/actor/approved_by_user`를 클라이언트의 신원/권한 대체값으로 받지 않습니다. 기존 SDK·전송·`ok/error`·structured content를 재사용하며 프로토콜 버전을 바꾸지 않습니다.

| 도구 | 권한 | 핵심 입력과 결과 |
| --- | --- | --- |
| `ontology_correspondence_query` | read | 기존 조회는 `correspondence_id`, 신규 prepare는 `draft` 중 정확히 하나를 받는다. 기존이면 전체 값·판단·이력·의존/범위 상태·CAS를 반환한다. prepare는 원문/참조를 읽어 draft를 검사하고 새 ID·`correspondence_revision=null`·정규 draft/digest·의존 manifest·CAS를 반환한다. 준비만으로 파일/예약/승인 이력을 쓰지 않는다. 선택 `application_context, as_of`는 적용 여부 판단에만 사용한다. |
| `ontology_correspondence_propose` | ontology_write | prepare의 `correspondence_id, draft, expected_state_revision`과 `reason`. 부재 CAS 뒤 source 미검토 제안 한 건을 최초 공개한다. `basis=candidate/source`만 허용하며 검토/정책 상태 입력을 받지 않는다. ID는 prepare 결과를 그대로 전달하며 잠금 예약이나 신원 증거로 사용하지 않는다. |
| `ontology_correspondence_review` | ontology_review | `correspondence_id, action, expected_state_revision, reason`. action은 `accept/reject/defer/edit`; edit는 전체 `replacement`와 `decision=accepted/deferred`를 필수로 받는다. 다른 action에는 replacement를 거부한다. source를 수용할 때 실제 연결 인용을 요구하며 양끝점 인용만 있는 candidate는 accept할 수 없다. |
| `ontology_correspondence_review_undo` | ontology_review | `correspondence_id, event_id, expected_state_revision, reason`. 최신 source 검토만 역이벤트로 되돌린다. 최초 propose 자체를 삭제하는 도구가 아니며 제안을 채택하지 않으려면 reject/defer로 남긴다. |
| `ontology_correspondence_policy` | ontology_policy | `correspondence_id, expected_state_revision, reason, replacement`와 첫 정책이면 `judgment_id=null`, 기존 정책 변경이면 조회한 `judgment_id, supersedes_event_id`. source 판단을 대체하는 첫 정책도 그 event를 명시한다. replacement는 전체 대응 뜻·조건·범위이며 연결 evidence/provenance/actor를 받지 않는다. 서버가 A/B anchor를 검증하고 policy scope·새 event 출처를 기록한다. candidate에 전문가 판단을 더하는 새 경로이며 기존 ontology_policy를 우회 호출하지 않는다. |
| `ontology_correspondence_policy_undo` | ontology_policy | `correspondence_id, event_id, expected_state_revision, reason`. 같은 judgment/정확한 범위의 최신 expert 이벤트만 되돌린다. review undo로 이 권한을 대신할 수 없다. |
| `ontology_correspondence_find` | read | `documents` 1–8개와 선택 `text, application_context, as_of, limit`(기본 20, 최대 100). 선택 문서를 끝점/실제 근거/선례로 참조하는 대응 중 경로·statement·조건·개념 표현의 NFKC/casefold 부분 문자열로 찾는다. 자동 의미 검색이나 개념 통합 조회가 아니다. ID·근거 종류·결정/적용 상태·출처·버전과 `complete/truncated/skipped`를 반환하며 수정용 token은 상세 조회에서 받는다. |
| `ontology_correspondence_prepare` | read | 기존 대응 변경용 `correspondence_id, operation, change`를 받아 변경안 또는 undo 복원값까지 포함한 의존 합집합과 정규 변경 digest·CAS를 반환한다. operation은 review/review_undo/policy/policy_undo 중 하나이며 change는 해당 변경 도구의 token 제외 인자이다. 변경 권한은 실제 저장 시 별도로 검사한다. 신규는 query의 draft prepare를 사용한다. |

변경안이 새 정의 D/새 참조를 추가하거나 undo가 옛 의존성을 복원할 수 있으므로 기존 상세 조회 token은 **그때 조회한 현재 값만 다루는 accept/reject/defer**에 사용할 수 있습니다. 이 세 action은 변경안 prepare token도 허용합니다. replacement·policy·undo에는 마지막 도구의 변경안 prepare token만 허용합니다. payload_digest는 `kind=snapshot/draft/change`를 구분해 현재 snapshot, 신규 draft 또는 operation+전체 정규 change를 묶습니다. change는 공통 tenant/profile/대응 ID와 token을 제외한 해당 변경 도구의 인자이며, 이 공통 값은 상위 state token에 별도로 포함합니다. 실제 저장은 action별로 허용한 token 형태를 같은 canonical 규칙으로 재계산해 비교하고, token 해시에서 원래 형태를 추정하거나 caller가 선언한 종류를 신뢰하지 않습니다. 변경안과 token의 짝이 다르면 conflict/invalid_argument로 거부합니다. 불필요한 prepare를 피하려고 새 근거를 CAS 밖에서 추가하거나 호출자가 dependency token을 임의로 조립하지 않습니다.

단건 query/prepare와 변경 성공은 `ok=true, correspondence_id, correspondence_revision, dependencies, access, complete, truncated, skipped`를 기본으로 두고 변경 가능 기준을 확보했을 때만 `state_revision`을 반환합니다. 상세 조회에는 `source_proposal, reviews, policies, history, application_context, evaluated_at` 및 판단별 `decision/applicability/reasons`를 포함합니다. prepare는 `prepared_change`와 digest도 반환합니다. 변경 성공은 `changed=true, event_id, sequence, event_hash, state_revision, cleanup_failures`와 저장 직후의 핵심 상태를 반환하며 전체 검색/영향 스캔을 성공 경로에 붙이지 않습니다. find는 `ok=true, scope, results, access, complete, truncated, skipped`이며 단일 대응 ID/수정용 token을 응답 최상위에 요구하지 않습니다. 감사 hash의 결과 버전과 CAS 결과 token은 별개입니다. prepare/조회는 원문·히스토리·그래프·기존 원장·대응 원장을 쓰지 않으며 잠금 운영 파일 외 읽기 부수 효과를 만들지 않습니다.

`find`로 새 문서 C에서 선례를 찾아도 C의 대응은 새 query(draft)→propose→검토/정책 흐름입니다. 기존 event·정확한 scope·판단 근거를 references/related_to로 구분해 남기고 새 제안은 unreviewed로 시작합니다. 개념 통합 설명·관계 맵·자동 문서 선택은 후속 단계입니다. 기존 `ontology_connections`·`ontology_impact`의 machine/직접 연결 응답에 대응을 몰래 합치거나 그 도구가 새 대응의 영향을 이미 안내한다고 기록하지 않습니다.

도구 설명/초기 안내에는 최신 대응 조회와 문서 B의 최신 `ontology_review_query`를 함께 읽고 출처별로 답하도록 명시합니다. 조회 annotation은 read-only, 변경은 read-only false·destructive true·open-world false로 기존 분류를 따릅니다. D-038 설계·구현 당시 `.codex/config.toml`의 legacy 6개 도구 연결에는 추가하지 않았습니다. 후속 개인 인증 tenant 연결의 실제 적용은 [D-041]과 PLAN을 따릅니다.

#### 충돌·오류·한도와 공개 전후의 실패 경계

| 상황 | 응답/보존·재시도 계약 |
| --- | --- |
| 기준 원장/의존/접근정책/변경 digest 불일치, 준비 ID가 이미 존재 | `conflict`, retryable false. 허용 범위의 expected/current 상태와 바뀐 component를 알리고 상세/prepare를 다시 읽어 재판단한다. 최신 token만 교체해 같은 오래된 판단을 재전송하지 않는다. |
| tenant/권한 거부·정책 읽기 실패 | 기존 `access_denied/access_unavailable`. 없는 tenant와 비허용 tenant는 같은 오류이며 다른 저장소/legacy로 우회하지 않는다. |
| 형식/경로/부재 대상 | `invalid_argument/not_found`. 새 대응 값·근거·검토 방식 불충분은 `invalid_correspondence`. 오류가 semantic 진위 판정을 대신하지 않는다. |
| 손상·미지원 version | `correspondence_corrupt` 또는 의존 문서의 기존 review/ontology 손상 코드. 기존 바이트를 남기며 자동 초기화·강제 overwrite하지 않는다. |
| 잠금 대기 초과 | 기존 `storage_busy`, 이것만 retryable true. 같은 ID·변경안·기준 token으로 나중에 재시도할 수 있고 그 사이 변경됐으면 conflict가 된다. |
| 한도 초과 | `correspondence_limit`. 이력/인용/원문을 자르거나 옛 이벤트를 삭제하지 않는다. |
| staging 쓰기·flush/fsync·최초 공개/replace 이전 실패 | `storage_error`와 원래 error_type/errno. 이전 원장 또는 신규 부재, 모든 문서·히스토리·그래프·검토를 유지한다. 실패의 cleanup_failures도 원래 오류와 별도 반환한다. |
| 원장 공개 뒤 임시 정리 경고 | `ok=true`와 cleanup_failures. 저장은 완료이며 재전송하지 않는다. 후속 상세 조회/검색/영향 안내 실패도 완료된 저장의 실패로 바꾸지 않는다. |
| 응답 유실·클라이언트 timeout | 저장 여부 미확인으로 다룬다. 알고 있는 준비/대응 ID로 query하여 원장 event·before/after·기준 상태를 대조한다. 자동 새 ID 생성/판단 재전송을 하지 않는다. 부재/성공 여부가 확인되지 않으면 확인 불가를 보고한다. |

저장 순서는 같은 잠금 안에서 ①현재/변경안·권한/CAS 검증 ②전체 before/after와 hash chain의 새 원장을 메모리에서 검증 ③같은 디렉터리에 전체 staging·fsync ④신규는 no-clobber 공개(기존 신규 저장의 hard-link 방식), 기존은 원자 replace ⑤저장 receipt 반환입니다. 기존 파일을 먼저 비우거나 다른 원장을 먼저 수정하지 않습니다. 공개 이전 실패는 이전 바이트를 보존하고 공개 이후는 성공으로 취급합니다. 결과 receipt 구성에 필요한 핵심 값·직렬화·응답 크기도 공개 전에 확인하며 공개 후 부수 조회 예외를 쓰기 실패로 포장하지 않습니다. 단일 파일의 전체 chain이 과거 full before/after를 보유하므로 옛 대응 파일 사본을 원문 `_history/`에 중복 저장하지 않습니다. 전원 장애·파일 관리자 직접 교체·네트워크 파일시스템·디스크 고장 복구는 기존 보장 밖이며 fsync가 그 범위까지 보증한다고 하지 않습니다.

PoC 상한은 대응당 **8 MiB/1,000 events**, source 원문/graph는 기존 각각 1 MiB, anchor 인용 1,000자·자유 statement/이유/각 조건 2,000자, 조건·예외·질문 각각 50개로 둡니다. 한 대응 요청의 실제 의존 closure는 문서 8개·다른 대응 8개·대응 참조 깊이 4, 원문 히스토리는 문서당 10,000항목, 캡처 바이트 합계 32 MiB로 제한합니다. 모든 문서 원장·대응 원장·원문/graph 읽기를 바이트 예산에 포함합니다. 상세 응답은 16 MiB(MCP 이중 포장 제외)를 상한으로 하며 전체 이력/인용이 안 들어가면 잘린 값 대신 한도 오류를 반환합니다. 저장 성공 receipt는 전체 이력 없이 2 MiB 안의 핵심 값으로 반환하여 성공 뒤 응답 크기 초과를 저장 실패로 만들지 않습니다.

find는 대응 파일 최대 100개·파일시스템 항목 1,000개·총 읽기 32 MiB·결과 2 MiB를 제한하며 각 결과의 의존 closure 검사도 같은 예산에 포함합니다. 상세/prepare에서 필요한 자료가 빠지면 `complete=false`·`truncated/skipped`·`applicability=unavailable`을 알리고 **변경용 token은 반환하지 않습니다**. 쓰기는 전체 필수 의존을 확보하지 못하면 공개 전에 실패합니다. 예외로 아래의 거절/보류·undo 준비에서 **확인된 missing**은 획득 가능한 관측 상태로 manifest에 넣어 `complete=true`인 operation 전용 CAS를 줄 수 있습니다. 이는 의도한 철회/보류를 위한 상태 확인이 완전하다는 뜻이며, 자료가 존재하거나 복원한 판단을 적용할 수 있다는 뜻이 아닙니다. 일반 missing 상세 조회는 변경 token을 주지 않습니다. 읽기 실패·손상·한도·권한 부족은 이 예외를 사용할 수 없습니다. 빈 find/한도·읽기 실패를 대응 없음이나 영향 없음으로 단정하지 않습니다.

#### 되돌림과 의존 변경의 적용 절차

되돌림은 자신의 lane/judgment의 최신 변경 event만 대상으로 하며, 뒤의 변경을 건너뛰는 요청을 `invalid_correspondence`로 거부합니다. source와 expert의 undo 도구는 저장된 event 종류를 확인해 서로의 변경을 취소하지 못하게 합니다. 같은 파일의 다른 범위 judgment는 보존하되 파일 CAS가 바뀌므로 최신 상태에서 다시 요청해야 합니다. undo 자체도 새 event라 순차적으로 그 undo를 다시 되돌릴 수 있으며 임의 옛 event를 건너뛰는 rewind는 제공하지 않습니다.

직전 `before`의 값·검토 상태·근거 기준·명시 대체 관계를 복원합니다. 최초 수용 취소는 unreviewed, 거절 후 수용 취소는 rejected, 기존 expert 판단 없는 첫 policy 취소는 inactive로 돌아갑니다. source 후보를 expert 취소의 부수 효과로 accepted로 바꾸지 않습니다. source 판단을 명시 대체했던 expert 정책이 철회되면 source의 원래 검토 상태가 남지만 그 판단의 원래 기준으로 현재성을 재검사합니다. 복원한 옛 의존 baseline을 이번 observed manifest로 교체하지 않으므로 근거가 바뀐 옛 수용은 needs_review입니다.

원문이 삭제됐거나 graph/참조 event가 사라졌더라도, tenant 경계 안에서 그 **부재가 확인**되고 해당 대응 원장 자체는 온전하면 최신 부재 상태를 prepare/CAS하여 rejected/deferred 전환이나 undo 철회 이벤트를 남길 수 있습니다. 새 수용/활성화 판정을 하지는 않으며, undo로 이전 accepted/active의 결정 상태를 복원하더라도 현재 적용 상태는 unavailable/needs_review로 남습니다. 권한 거부·파일 읽기 실패·손상·한도 때문에 현재를 확인하지 못한 경우에는 변경을 진행하지 않습니다. 이 예외는 옛 바이트를 최신 원문 인용인 것처럼 재검증 통과시키는 절차가 아닙니다.

의존하는 다른 대응/정책을 바꾸거나 되돌리면 참조자는 다음 query에서 closure와 적용 여부를 재확인해 needs_review로 표시합니다. 참조자의 파일이나 원문을 연쇄 수정/삭제하지 않고 자동 재추출·정책 재적용·알림 큐를 만들지 않습니다. 참조 판단이 기간 밖/다른 scope이면 상위 대응도 그것을 현재 적용 근거로 쓰지 않습니다. 변경 뒤 필요하면 find로 해당 문서의 직접 관련 대응을 다시 조회하지만 그 제한된 결과를 전체 영향 없음으로 단정하지 않습니다.

#### 상세 설계의 완료와 구현 인계

상세 설계에서 확정한 보존·prepare/CAS·권한/입출력·실패/undo 계약을 `core/correspondences.py`와 `core/correspondence_schema.py`, tenant MCP 도구로 구현했습니다. 설계 당시 기록은 [상세 설계](../../history/2026-10-25-before-domain-split/PLAN.md#d-038-저장버전mcp-상세-설계-2026-10-23)에 보존하고 실제 기능 완료 조건·검증 결과는 [구현 검증](../../history/2026-10-25-before-domain-split/PLAN.md#d-038-대응-원장복합-버전mcp-구현과-격리-검증-2026-10-23)에만 기록합니다. 공통 개념 등록부·전역 의미 검색·UI·자동 처리와 운영 연결 전환은 이번 구현에 포함하지 않습니다.

구현에서 닫은 세부 계약은 다음과 같습니다. 상세 입력 형태는 도구 설명에도 포함해 원격 클라이언트가 저장소 문서를 읽지 않아도 필수 필드를 확인할 수 있게 했습니다.

- `graph_ref`는 `graph_revision, state_revision, collection, snapshot, layer`와 entity_id/claim_id 하나를 명시합니다. layer는 machine/reviewed이며 현재 source 검토층과 정확한 범위의 expert 값도 구분합니다. review/policy 참조는 `document, event_id, state_revision, snapshot=event.after, scope`, 대응 참조는 `correspondence_id, event_id, correspondence_revision, snapshot=event.after, scope`를 보존합니다. kind를 함께 명시하고 source review의 scope는 null입니다.
- quantity의 수치 경계는 유한 decimal 문자열, 조건/예외는 `{status: unknown/none/specified, items}`, 업무 축은 `{name, status, value, source}`이며 미확인 축의 값은 null입니다. validity는 status/source를 갖고 지정 기간에는 offset 시각·경계 포함 여부·IANA timezone을 함께 보존합니다. related_to는 대응/event ID의 계보 참조이며 실제 근거로 쓰려면 references에도 넣습니다.
- 의존 manifest는 참조의 존재·최신 event·실제 근거 버전이라는 구조적 현재성을 묶습니다. 조회의 application_context/as_of를 바꿔 근거 CAS나 옛 판단 baseline이 바뀌지 않습니다. 현재 범위·기간·정확한 정책 관점의 적용은 별도 계산합니다. 저장 시 선례 사용은 새 값에 명시한 업무 축과 조건/예외·기간으로 제한하며 선례 범위를 확대하는 입력은 거부합니다.
- closure는 root별 실제 참조 도달 집합으로 제한하고 같은 참조의 계산을 재사용합니다. find가 앞서 읽은 다른 root/계보 캐시는 한 대응의 closure 수로 세지 않으며 전체 읽기 바이트 예산은 공유합니다. 원장 reader는 writer와 같은 필수 대체/전후/범위 규칙을 검사하고 재계산된 hash만으로 잘못된 이벤트를 승인하지 않습니다.

[D-026]: ../access/DECISIONS.md#d-026--사용자-권한과-관점-프로필을-분리한-tenant-모드-2026-10-22-4-a
[D-028]: ../reviews/DECISIONS.md#d-028--원문추출과-분리한-검토-원장과-상태-충돌-검사-2026-10-22-4-c
[D-031]: ../reviews/DECISIONS.md#d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1
[D-037]: ../knowledge/DECISIONS.md#d-037--문서에서-발견한-개념상태-조건의-연결과-통합-조회-방향-2026-10-23
[D-040]: ../knowledge/DECISIONS.md#d-040--개념-중심-최신-지식-통합-조회-2026-10-23
[D-041]: ../access/DECISIONS.md#d-041--개인-인증-tenant-연결-전환과-보존복구-절차-2026-10-23
