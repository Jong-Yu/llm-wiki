# 결정 기록

이 문서는 **현재 적용할 정책·계약과 그 결정 이유**를 관리합니다. 실행 방법은 [README](../README.md), 작업 규칙은 [AGENTS](../AGENTS.md), 구현 상태·실제 검증 결과는 [PLAN](PLAN.md)이 담당합니다.

2026-10-23 정리에서 기존 D-001~D-037의 번호·제목·결정 이유를 보존하고 내용을 주제별로 모았습니다. 이후 결정도 같은 주제 안에 추가하며, D-038은 문서 간 대응 판단의 현행 계약입니다. 번호는 결정 순서이며 문서 배치 순서나 우선순위가 아닙니다. 초기 제약을 바꾼 경우에는 해당 절에서 후속 결정을 명시합니다. **합의한 설계 방향·설계 후보·UI 시안은 구현된 기능과 구분**합니다. 이 정리는 새 기능·권한·스키마를 도입하지 않습니다.

## 현재 기준 찾기

| 확인할 내용 | 현재 기준 | 후속 설계와 구분할 점 |
| --- | --- | --- |
| 제품 목적·작업 범위 | [D-034]·[D-003]·[D-004] | 한 번에 요청한 단계만 진행; 완료 상태는 PLAN |
| 파일 저장·충돌·실패 보존 | [D-006]·[D-009]·[D-010]·[D-011]·[D-014] | 원문 내용 버전과 검토 상태 버전은 다름 |
| MCP 연결·인증·워크스페이스 | [D-016]·[D-017]·[D-026]·[D-041] | 로컬 개인 인증 read 연결 완료; 첫 등록의 임시 쓰기·회수는 D-042, 원격 전환 미실행 |
| 첫 실자료 선정·등록 범위·최소 쓰기 | [D-042] | C01 앵커 형식 격리 구현/검증 완료·운영 A 유지; 기존 미표현/17업무 결론 대기·357미검토·read13 |
| Electron 일반 API와 개인 CLI의 MCP 연결 | [D-043] | 단일 ASGI 앱의 첫 읽기·원본 등록/판본/다운로드/영수증 구현·검증 완료; 분석 작업·Electron 실제 연결은 후속 |
| 다른 PC의 최초 연결·설정 변경·진단 | [D-047] | 서버 PC와 작업 PC의 역할, 공간 진입 전 설정 동선·API/MCP 확인을 정의; 설정 화면·신원 대조 계약·실제 두 PC 연결은 미구현/미검증 |
| Windows 서버 노트북과 중앙 저장 | [D-048] | 서버만 WSL2 사용, 각 PC는 Electron·개인 CLI로 접속. 운영 방향 채택·가이드 작성이며 실제 배포/이전은 미실행 |
| 백엔드 코드 구조·도메인별 탐색·스펙 주도 절차 | [D-046] | 기존 구조 이전·core/tests 정합 완료; R1의 api/runtime 결합 구현은 D-043 참조 |
| 추출 의미·현재 스키마 | [D-022]·[D-024]·[D-036] | v3 사용; 조회 관점으로 추출을 축소하지 않음 |
| 공통 추출 규약·맥락·입력 버전 | [D-044] | 서버가 같은 규약과 작업별 고정 맥락을 MCP로 제공하는 후속 설계; 배포·새 도구·실행 검증은 미구현 |
| 검색·원문과 그래프 조회 | [D-013]·[D-027] | 명시 선택 문서의 기계층; 현재 전문가 판단은 [D-031] |
| 문서 간 연결·변경 영향 | [D-019]·[D-032]·[D-038]·[D-040] | 명시 링크/이름·유형 후보와 대응 원장을 구분; 개념 중심 통합 조회는 tenant read 도구로 구현 |
| 사람의 정정·업무 판단 | [D-028]·[D-031] | 원문 근거 정정과 인용 없는 전문가 정책의 권한·출처를 분리 |
| 평가·품질 판단 | [D-021]·[D-029]·[D-036] | 형식·인용 검사, 의미 평가, 실제 사람 검증을 구분 |
| 등록 맥락·공통 개념 확장 | [D-035]·[D-037]·[D-038]·[D-040] | 대응 저장·명시 대상 중심 통합 조회는 구현; 등록 힌트·공통 개념 등록부·전역 의미 검색은 미구현 |
| 계정·UI·실시간 갱신 | [D-030]·[D-033]·[D-039] | 개인 토큰 기반 권한은 구현; 유스케이스 화면 구성은 설계 시안, 계정 발급/SSO·제품 UI·변경 알림은 미구현 |
| Electron 앱 위치·토큰·React 분해 | [D-045] | `app/`에 Electron 실행 골격·기본 화면 추가; 문서/API·CLI 제품 연결은 후속 |

## 1. 제품 목적과 작업 구조

### D-034 — 지식을 축적·활용·갱신하는 제품 목적 (2026-10-23)

상태: 사용자가 합의한 제품 목적입니다. 자료 축적 → 업무 질문·결과물 활용 → 지식 갱신의 방향이며, 아래 미결정 사용자 흐름이나 새 API의 구현 완료를 뜻하지 않습니다.

- 목적: 사람과 AI가 문서와 업무 판단을 함께 축적·활용·갱신하는 공동 지식 공간입니다. 대화나 AI 세션이 바뀌어도 허용된 자료와 적용 가능한 현재 판단을 찾아 다시 사용할 수 있어야 합니다. 미검토·오래됨·불확실함도 함께 드러내며 항상 완전하거나 정확한 지식을 보장한다고 표현하지 않습니다.
- 제품의 중심: 사용자는 **“LLM Wiki에 AI 온톨로지 도입”**을 화면 설계에서도 유지해야 한다고 명시했습니다. 원문에서 발견한 개체·개념·조건·관계·속성과 그 근거를 질문·탐색·수정·재사용에 연결하는 것을 기준으로 삼습니다. 화면 구성 제안은 D-039에서 관리합니다.
- 검토 기준: 자료 도입 → AI 정리·연결 → 사람 검토 → 질문·결과물 활용 → 결과의 위키 반영 → 변경 재검토의 연결을 기준으로 정책과 화면을 조사합니다. 사용자가 작업의 대상·현재 상태·다음 행동·완료 결과를 확인할 수 있는지, 다음 작업에서 그 결과를 다시 찾을 수 있는지가 중요합니다. 모든 자료와 답변에 새 사전 승인 단계를 추가한다는 뜻은 아닙니다.
- 지식과 판단: 원문·AI 해석·전문가 판단은 D-025·D-028·D-031의 출처와 상태를 유지합니다. 원문 정정, 근거에 따른 해석 정정, 전문가의 업무 정책 변경은 서로 다른 작업입니다. 사람의 판단을 현재 범위에 적용하는 것과 원문을 덮어쓰는 것을 구분합니다. AI 결과를 저장할 때의 출처 보존·재사용 계약은 아래 미결정 범위에 남깁니다.
- 화면과 연결 수단: D-033의 AI 대화 중심 및 필요할 때 여는 문서 뷰어 선택은 유지합니다. 문서 뷰어·그래프·검토함은 이 순환에서 맡는 업무로 평가하고, MCP·CLI·Electron은 지식에 접근하고 작업을 실행하는 수단으로 봅니다. 35개 화면의 존재만으로 순환 전체가 정의되거나 사용성이 검증됐다고 판단하지 않습니다.
- 후속 구체화와 남은 범위: 전문가 판단에 새로 등장한 용어의 서버 발견 경로는 [D-040], 첫 실자료의 선택·등록·부분 추출은 [D-042]에서 구체화했습니다. 일반 자료의 원격 등록·개인 CLI 요청·단계별 저장/화면 결과 계약은 [D-043]에서 설계했으며 제품 연결은 미구현입니다. 미검토·재검토 상태를 답변에 드러내는 기본 행동, AI 결과 문서의 원출처·버전·판단 이력 보존, 바뀌거나 사라진 옛 판단 및 영향 권고의 재검토 종료 조건은 남아 있습니다. 조사 결과와 우선순위 제안은 [PLAN](PLAN.md)에 기록하며 기존 API가 이 기능을 모두 제공한다고 표시하지 않습니다.

### D-001 — 작업 위치와 파일 역할

상태: 현재 적용하는 작업 원칙입니다.

- 결정: `/Users/jong-yu/Projects/LLM Wiki`를 작업 루트로 사용합니다. 기존 `core/`와 `data/`를 재사용하며, `core/`는 MCP 서버 코드, `data/wiki/`는 최신 위키 원본, `data/_history/`는 수정 전 전체 파일 버전에 사용합니다.
- 이유: 서버 코드와 사용자 데이터를 구분하고, 최신 원본과 과거 버전의 역할을 명확히 합니다.

### D-003 — 단계별 확장

상태: 현재 적용하는 작업 원칙입니다.

- 결정: 작업 규칙 → 파일 저장·버저닝 → MCP → Codex CLI → 온톨로지 → UI·실시간 갱신 → 통합 시연 순서로 진행합니다. 최초 요청은 0단계로 제한했으며, 이후에는 각 후속 요청에서 지정한 한 단계만 수행합니다.
- 이유: 각 단계의 완료 조건과 검증 결과를 확인한 뒤 다음 기능을 추가하기 위해서입니다. 진행 상태는 [PLAN.md](PLAN.md)에서 관리합니다.

### D-004 — 문서 책임 분리와 최소 구성

상태: 현재 적용하는 작업 원칙입니다.

- 결정: 소개·실행 안내, 에이전트 규칙, 구현 계획, 결정 기록, 단계 수행 절차를 각각 지정한 파일에서 관리합니다. 현재 필요하지 않은 보조 문서, 스크립트, 예제 파일은 만들지 않습니다.
- 이유: 중복된 설명이 서로 어긋나는 것을 줄이고 다음 작업자가 필요한 정보를 찾기 쉽게 합니다. 파일별 역할은 [AGENTS.md](../AGENTS.md)에 정의합니다.

### D-046 — 업무별 백엔드 모듈과 FastAPI·MCP 분리 및 스펙 주도 개발 (2026-10-25)

상태: **기존 백엔드의 업무·전송/실행·수동 도구 이전과 불필요 호환 정리·core/tests 정합·검증 완료**입니다. 이후 R1 첫 읽기의 API/runtime 결합도 구현했으며 현재 기능 계약은 [D-043]을 따릅니다. 사용자가 정한 core 전용 검사 위치를 채택했습니다. storage/access·런처·수동 도구까지 실제 배치했고 기본 data/.venv·MCP 등록·원장/권한 계약을 보존했습니다. 남긴 직속 파일의 이유와 의도한 명령 변경은 아래 마지막 절에 기록합니다.

#### 선택한 구성과 개발 방식

**업무별 모듈로 구성한 단일 백엔드(modular monolith) + FastAPI/MCP 어댑터 분리 + 스펙 주도 개발(SDD)**을 적용합니다. 배포 단위는 D-043의 한 Python 백엔드를 유지합니다. DDD는 문서·기계 추출·검토·대응 등 업무 용어와 소유 경계를 정하는 데 사용하며, 모든 폴더를 독립 Bounded Context나 마이크로서비스로 선언하지 않습니다. SDD는 폴더 구조의 대안이 아니라 요구·계약→계획·수용 조건→검사→구현→결과 기록의 절차로 함께 적용합니다.

| 검토한 방식 | 이 PoC에 대한 판단 |
| --- | --- |
| `routers/services/models/repositories`만 전역으로 나눈 계층 구조 | 작은 시작에는 단순하지만 업무 하나의 변경 위치가 여러 전역 폴더에 흩어지고 큰 서비스 파일이 다시 생길 수 있음 |
| 모든 모듈에 Entity/Aggregate/Repository/Unit of Work를 강제하는 전면 DDD/Clean Architecture | 현재 파일 저장·규칙·잠금의 실제 결합을 한 번에 바꿔야 하며 추상화·파일 수가 늘어남. 지금의 구조 정리 범위에는 채택하지 않음 |
| 업무별 모듈 + 외부 전송 어댑터 + 하나의 조립 지점 | **채택.** 업무 위치를 찾기 쉽고 HTTP/MCP의 처리 중복을 줄이며 기존 저장 의미를 점진적으로 보존할 수 있음 |
| 스펙 주도 개발 | **개발 절차로 병행.** 기존 D-043 API 계약·PLAN 수용 조건을 먼저 고정해 같은 규칙의 전송별 동작을 확인. 별도 Spec Kit 설치·문서 체계 복제는 필요 없음 |

참고한 1차 자료는 [DDD Reference](https://www.domainlanguage.com/ddd/reference/), [Ports and Adapters 원문](https://alistair.cockburn.us/hexagonal-architecture), [FastAPI의 APIRouter 분리 안내](https://fastapi.tiangolo.com/tutorial/bigger-applications/), [GitHub의 SDD 설명](https://github.com/github/spec-kit/blob/main/spec-driven.md), [Python 3.12 패키지 안내](https://docs.python.org/3.12/tutorial/modules.html#packages)입니다. 각 자료의 원칙을 현재 코드에 맞춰 선택한 설계이며 이 디렉토리 배치가 특정 표준의 필수 형식이라는 뜻은 아닙니다.

#### 목표 디렉토리와 책임

아래는 **전체 목표 지도**입니다. 기존 common·mcp·runtime CLI/개인 런처·modules 업무·core/tests·수동 tools는 실제 이전했습니다. 이후 R1에서 application/http_security/http_cli와 첫 세 API 폴더를 구현했습니다. 나머지 후속 폴더와 아직 필요하지 않은 services/paths는 만들지 않았으며 실제 전체 목록은 README를 따릅니다. `core/` 패키지와 등록된 실행 진입을 유지합니다. `src/` 전환·배포 패키징은 포함하지 않으며 새 패키지는 실제 구현이 있을 때만 만듭니다.

```text
core/
  paths.py                       기존 프로젝트·data·.venv의 순수 경로 기준 [구현됨]
  common/                        업무/SDK에 의존하지 않는 공용 기술 코드 [구현됨]
    json_codec.py                정규 JSON 저장 바이트·LF·hash 계약
    cleanup.py                   정리 경고의 순수 응답 변환
  paths.py                       부작용 없는 공통 프로젝트/기본 경로 기준
  runtime/                       실행·설정·의존성 조립
    application.py               FastAPI 루트와 MCP mount·lifespan 조립 [R1]
    services.py                  현재 인가된 scope의 공통 서비스 구성
    mcp_cli.py                   기존 stdio/HTTP MCP 인수와 실행 분기 [구현됨]
    paths.py                     추가 실행 경로 검증이 필요할 때 [R1]
    http_security.py             양쪽 HTTP 입구의 공통 인증·Host/Origin 보호
    personal_launcher.py         보호된 개인 연결의 stdio 실행 [이전 완료]
  api/                           FastAPI 전송 어댑터 [R1부터 실제 범위만]
    router.py                    v1 라우터 결합
    dependencies.py              인증 scope 전달·요청별 의존성
    errors.py                    도메인 결과/오류 → HTTP 응답
    v1/
      access/                    router.py + schemas.py
      documents/                 router.py + schemas.py
      knowledge/                 router.py + schemas.py
      reviews/                   후속 C계열 구현 시 추가
      correspondences/           후속 D계열 구현 시 추가
      sources/                   후속 원본 등록 구현 시 추가
      analysis_jobs/             후속 작업 계약 구현 시 추가
      extractions/               후속 추출물 조회 구현 시 추가
  mcp/                           MCP 전송 어댑터 [책임 분리 완료]
    server.py                    SDK 호출 방어·legacy 도구 결합
    tenant.py                    현재 정책 인가·profile·tenant dispatch
    request_context.py           요청별 권한 ContextVar·Bearer 읽기
    schemas.py                   MCP 입력 모델
    validation.py                SDK 전처리/타입 변환에 대한 계약 방어
    results.py                   MCP CallToolResult·오류 포장
    http.py                      MCP ASGI 전송·전용 제한 설정
    tools/
      documents.py               wiki 읽기·쓰기·검색 도구
      ontology.py                그래프·맥락·연결·영향 도구
      reviews.py                 문서별 검토·정책·되돌림 도구
      correspondences.py         문서 간 대응 도구
      concepts.py                개념 발견·통합 조회 도구
  modules/                       두 전송이 공유하는 업무 처리
    access/policy.py             사용자·tenant·행동·profile 정책 [이전 완료]
    documents/store.py           WikiStore·본문·전체 이력·CAS [이전 완료]
    documents/service.py         공통 문서 조회·검색 등 필요한 업무 호출
    documents/search.py          공통 문자열 검색·탐색 예산 [구현됨]
    ontology/                    온톨로지 업무 [책임 분리 완료]
      store.py                   원문/검토 CAS·그래프 공개·공용 진입
      validation.py, values.py   개체·관계·후보·속성·인용/한정어 검증
      snapshots.py               저장 형식과 현재성 판정
      capture.py                 안전한 파일 읽기·바이트 예산
      context.py                 전체 선택 맥락·관점별 참조 그룹
      connections.py             명시 링크·이름/유형 후보·연결
      constants.py, errors.py    스키마/상한·오류의 단일 소유
      anchors.py                 원문 위치·끝점 검증
    reviews/                    검토/전문가 정책 [책임 분리 완료]
      store.py                   공용 메서드·같은 잠금의 명시 조립
      contracts.py, values.py    한도/오류·actor/입력/claim ID
      state.py, events.py        관점/정책 상태·UUID/UTC 시계
      capture.py, ledger.py      안전 캡처·전체 원장 검사/공개
      render.py, validation.py   현재 유효 판단·근거/모든 층 검사
      commands.py                원문 검토·역이벤트
      policy_values.py, policy_commands.py  전문가 정책 값·변경/역이벤트
    correspondences/             문서 간 대응 [책임 분리 완료]
      store.py                   공용 메서드와 명시 협력 호출
      contracts.py, schema.py    상한/예외·값/범위/참조 검증
      state.py, identifiers.py   의존 상태·token·ID 발급
      capture.py                 대응별 의존 탐색·캡처 예산
      ledger.py                  원장 전체 검사·이벤트/파일 공개
      evidence.py                원문·그래프 근거 대조
      applicability.py           범위·기간·의존 상태의 적용 판단
      preparation.py             변경 계획·prepare token
      queries.py                 상세/준비 조회·발견
      commands.py                제안·검토·정책·역이벤트 저장
    knowledge/                  개념/영향 읽기 조합 [책임 분리 완료]
      concepts.py                개념 발견·선택 조회의 공용 진입
      discovery.py, references.py  발견·버전/출처/끝점 참조
      queries.py, projections.py, values.py  조회·결과/완전성·검색 값
      capture.py                 요청별 공유 상태·예산의 공용 진입
      capture_io.py, capture_documents.py, capture_correspondences.py
      capture_scan.py, capture_errors.py  안전 읽기·문서/대응·제한된 탐색
      schema.py, contracts.py    버전 있는 대상·한도/오류
      impact.py                  영향 조회의 공용 진입
      impact_snapshot.py, impact_capture.py, impact_history.py
      impact_links.py, impact_references.py, impact_result.py
                                  기준/캡처·복원·현재/과거 비교·부분 결과
  mcp_server.py                  기존 명령·공개 factory의 얇은 호환 진입점
  personal_launcher.py           실제 MCP 등록의 main 위임
  storage.py, anchors.py, reviews.py  고정 과거 fixture를 위한 명시 호환
  tests/                         core 전용 회귀·계약 검사
    modules/                      업무/저장·보존·경합·구조 검사 [이전 완료]
    mcp/                          실제 MCP 계약·stdio/HTTP 검사 [이전 완료]
    api/                          실제 구현된 HTTP 계약 검사 [R1]
    runtime/                      개인 런처·기존 진입점 호환 검사 [이전 완료]
    tools/                        수동 검증/전환 점검의 회귀 [이전 완료]
    common/                       공용 JSON/정리 경고 계약 [이전 완료]
    fixtures/                     v3/v4/v5 고정 구현 [바이트 그대로 이전]
tools/                           수동 평가·전환 확인 명령 [이전 완료]
  transition_check.py
  verify_codex.py
  verify_ontology.py
  verify_answers.py
  verify_transition.py
evals/                           기존 평가 자료·기록을 그대로 유지
docs/                            기존 결정·계획이 스펙과 수용 조건 관리
```

전역 `services.py`에 모든 업무를 모으지 않습니다. `runtime/services.py`는 객체 연결만 맡고 실제 처리 함수는 담당 업무 모듈에 둡니다. `service.py`·`schema.py`·`store.py`를 모든 모듈에 의무적으로 만들지 않으며 실제 책임이 있을 때만 분리합니다. `sources/analysis_jobs/extractions` 업무 모듈은 후속 기능 구현 시 `modules/` 아래에 추가합니다. 공통 추출 규약은 D-044의 책임이며 아직 없는 rules 모듈을 이번 구조 정리에서 생성하지 않습니다.

`store.py`는 업무의 공용 진입이며 순수 파일 저장 어댑터를 뜻하지 않습니다. 온톨로지·대응은 이미 검증·캡처·판단·조회/저장 협력 책임을 분리했고, 같은 저장소와 임계구역을 공용 Store에서 조립합니다. 남은 기존 Store도 실제 결합을 보존하며 분리하고 전부 `infrastructure/`로 옮기지 않습니다. DB를 선택할 때는 본문 보존 저장, tenant의 일관성 조회, 기준을 검사한 원장/그래프 공개에 맞는 작은 port를 설계합니다. 현재는 Markdown/JSON을 유지하며 DB/ORM·범용 Repository·별도 큐·이벤트 버스를 도입하지 않습니다.

#### 의존 방향과 도메인별 FastAPI 연결

```text
runtime: 설정·공통 HTTP 보호·서비스 구성·단일 ASGI/stdio 기동
                    ↓ 조립/주입
             api                mcp
              └───────┬─────────┘
                      ↓ 명시 입력 + 서버가 확인한 scope
           modules의 공용 업무 서비스/기존 Store facade
                      ↓
          같은 tenant의 파일 저장·전체 이력·원장
```

- `api`와 `mcp`는 서로 import하거나 내부 HTTP/MCP 호출을 하지 않습니다. 어댑터는 입력 변환·전송별 형식/상태 코드만 맡고 검색·승인·정책 적용·저장 규칙을 복제하지 않습니다.
- `modules`는 FastAPI Request/Depends, MCP CallToolResult/Context, `runtime`을 import하지 않습니다. 조립이 필요한 객체·scope는 호출 인자로 전달하고 현재 정책은 각 요청에서 확인합니다. 과거 scope·job 입력의 정책 revision을 다음 요청의 허가로 재사용하지 않습니다.
- `runtime`은 모듈과 양쪽 어댑터를 구성합니다. HTTP middleware는 이 조립 지점에서 양쪽 진입점을 감싸되 MCP 전용 JSON/메서드/8 MiB 제한과 파일/일반 API 제한은 각 어댑터에 남깁니다. FastAPI dependency가 mount된 MCP를 자동 보호한다고 가정하지 않습니다.
- `modules/knowledge`는 여러 업무의 읽기 조합 계층입니다. 다른 모듈이 이를 역으로 import해 순환하게 만들지 않습니다. 현재 `ontology↔reviews` 지연 import·private 함수 공유는 이전 중 명시한 과도기 의존으로 보존하며, 순수 검증/공개 업무 경계를 좁게 추출한 뒤 제거합니다. 폴더만 나눴다고 순환 의존이 해소됐다고 표시하지 않습니다.
- Pydantic HTTP/MCP 입력 모델은 전송 계약이고 업무 검증의 원본을 대신하지 않습니다. 이름이 같은 외부 입력 모델을 공유하려고 한 어댑터가 다른 어댑터의 schema를 import하지 않습니다. 재사용할 주장·revision 규칙은 담당 업무 모듈에 둡니다. `schema_version`은 온톨로지 형식, `api/v1`은 HTTP 계약 버전이므로 별개입니다.

| FastAPI 위치 | 담당 D-043 API·업무 | 공통 처리 |
| --- | --- | --- |
| `api/v1/access` | A01 소속·허용 행동 | access 정책 |
| `api/v1/documents` | A02/A03·B01, 후속 C01–C04의 목록·본문·검색·판본 | documents |
| `api/v1/knowledge` | A04, B02–B07의 유효 지식·기계층·개념·맥락·연결·영향 | reviews·ontology·knowledge의 명시 읽기 기능 |
| `api/v1/reviews` | C05–C10의 검토·업무 판단·역이벤트·이력 | reviews |
| `api/v1/correspondences` | D01–D09 | correspondences |
| `api/v1/sources`, `analysis_jobs`, `extractions` | S 원본·작업·추출물의 실제 구현 범위 | 같은 이름의 후속 업무 모듈 |

각 API 폴더는 APIRouter와 요청/응답 schema를 함께 둡니다. **도메인 소유와 URL prefix를 동일시하지 않습니다.** 예를 들어 `/documents/knowledge`는 knowledge 어댑터가 맡을 수 있으며 D-043의 URL을 폴더 이름에 맞추려고 바꾸지 않습니다. A01의 비-tenant 경로와 나머지 tenant 경로, 버전 prefix는 라우터 결합에서 정확히 한 번 적용합니다. E/F의 전역 조회·대화·결과·비교 후보는 계약 확정 후 소유를 정하며 R1 네 읽기 경로만으로 먼저 필요한 세 API 폴더를 구현합니다.

#### 현재 파일의 이전 지도와 보존 조건

| 이전 전 위치 | 실제 위치/유지하는 진입 |
| --- | --- |
| `core/storage.py`, `core/access.py` | `modules/documents/store.py`, `modules/access/policy.py`; 기존 Store/인가 로직 재사용 |
| `core/ontology.py`, `core/anchors.py`, `core/reviews.py` | `modules/ontology/store.py`, `ontology/anchors.py`, `reviews/store.py`; 첫 이동에서 형식·원장·규칙을 함께 보존 |
| `core/correspondences.py`, `core/correspondence_schema.py` | `modules/correspondences/store.py`, `schema.py` |
| `core/concepts.py`, `concept_capture.py`, `concept_schema.py`, `impact.py` | `modules/knowledge/concepts.py`, `capture.py`, `schema.py`, `impact.py` |
| `core/mcp_server.py` | 서버/입력/도구/결과는 `mcp/`, 검색은 `modules/documents/`, 실행/공통 HTTP 조립은 `runtime/` |
| `core/personal_launcher.py` | 구현은 `runtime/`, 기존 `-m core.personal_launcher` 진입은 보존 |
| `core/test_*.py`, `core/fixtures/` | 사용자 선택인 `core/tests/`와 `core/tests/fixtures/`; import·mock·경로·자동 발견 명령 갱신 |
| `core/verify_*.py`, `core/transition_check.py` | 구현과 명령은 `tools.*`; 옛 도구 파일은 제거하고 README·내부 소비자를 갱신 |

실제 이전은 [PLAN의 B0](PLAN.md#b0-백엔드-구조-정리의-선행-범위-2026-10-25)의 한 묶음씩 수행합니다. `core.mcp_server`의 공개 factory·`core.personal_launcher` 실행 경로와 기존 설정을 보존하는 동안 호환 모듈은 명시한 공개 심볼만 위임하며 새 업무 코드를 쌓지 않습니다. 이전 완료한 내부 import는 새 경로로 맞추고 구 경로·신 경로에 구현을 복제하지 않습니다.

특히 다음은 단순 파일 이동에도 검증해야 합니다.

1. `storage.py`·개인 런처의 `__file__` 부모 계산이 새 디렉토리 때문에 data/.venv 위치를 바꾸지 않게 합니다. 공통 기본 경로는 `core/paths.py`의 전송/runtime에 의존하지 않는 좁은 기준 모듈에 두고, `runtime/paths.py`가 실행 인수·설정을 검증해 실제 경로를 명시 주입합니다. 공개 `WikiStore()`의 무인자 기본 data 계약도 같은 기준을 사용해 보존하며 modules가 runtime을 역 import하지 않습니다. 기본/명시 데이터 루트·tenant 경계·CLI 인수·환경 해석을 유지하고 실제 data/.local·정책·토큰은 이동하지 않습니다.
2. MCP 도구 이름·설명·입력·annotation·SDK 전처리 방어, 현재 코드의 확정된 온톨로지 형식/소비자 제약을 보존합니다. 구조 정리와 새 스키마 도입을 같은 변경에 섞지 않습니다.
3. 본문 CAS·전체 파일 이력·그래프의 source/state guard·원장 hash/역이벤트·손상 차단·성공 cleanup 경고와 응답 유실을 보존합니다. revision/history ID/정규 JSON hash·generation 의미도 바꾸지 않습니다.
4. ConceptCapture와 대응 캡처의 같은 잠금·공유 예산·직접 내부 읽기를 단순 public query 여러 번으로 바꾸지 않습니다. 잠금 비재진입과 시점 일관성을 유지합니다.
5. 단순 re-export한 상수/함수는 기존 `patch('core.…')`가 새 구현에 작동한다는 보장이 아닙니다. 내부 검사는 실제 소유 모듈을 대상으로 갱신하고 공개 진입 호환 검사를 별도로 유지합니다. 로그 이름·fixture import·전체 검사 발견도 확인합니다.
6. import만으로 앱 생성·정책/자료 읽기·폴더 생성·서버 기동을 하지 않습니다. stdio가 미구현 FastAPI 초기화를 요구하지 않게 하며 HTTP 부모 lifespan의 MCP 시작/종료는 D-043대로 한 번입니다.

#### SDD 적용과 남은 결정

계약의 원본은 기존 D-043/D-044, 코드 배치·의존 규칙은 이 결정, 실제 작업 묶음·수용 조건·실행 결과는 PLAN입니다. 구현 전 해당 묶음의 입력·출력·필수/null·권한·CAS·상한·오류·실패 후 상태와 예시를 고정하고, 그 계약의 검사를 준비한 다음 구현합니다. OpenAPI는 실제 구현된 HTTP 계약에서 생성하며 독립 수기 스펙과 이중 관리하지 않습니다. 스펙 문서가 있다는 이유로 테스트·업무 의미 검증을 대신하지 않습니다.

파일 저장을 DB로 바꿀 때의 테이블·트랜잭션·마이그레이션, 배포 패키징, 일반 쓰기 영수증, E/F의 저장/공유 권한은 여전히 해당 후속 결정입니다. DB 전환은 현재 파일명 기반 history revision·정규 바이트 hash·같은 잠금의 상태 계산을 보존하거나 명시 이관해야 하므로 단순 Repository 교체만으로 해결된다고 약속하지 않습니다. 새로운 업무에서 필요한 세부 모듈 내부 분리는 실제 구현 범위에서 정합니다.

#### 공용 코드와 주석의 적용 기준 (2026-10-25)

사용자의 후속 요청으로 **동일 계약의 공용 기술 코드와 한국어 설명을 구현**했습니다. 이는 B0-1–3의 전체 파일 재배치나 FastAPI 구현 완료가 아닌 선행 코드 정리입니다. 실제 공용 위치는 [core/common/json_codec.py](../core/common/json_codec.py)·[cleanup.py](../core/common/cleanup.py)이며 검사는 후속 B0-3에서 [tests/common/test_common.py](../core/tests/common/test_common.py)로 이전했습니다.

- 같은 계약을 여러 곳이 사용하는 기술 기능만 공용화합니다. 정규 JSON 인코딩/hash는 검토 업무의 private 함수에서 독립시키고, 그래프·검토·대응·MCP가 같은 정리 경고 변환을 사용합니다. 기존 `reviews._encode/_hash` import는 호환 alias로 유지하되 실제 구현은 공용 모듈 하나에만 둡니다. 공용 모듈은 업무·전송 SDK·파일 접근에 의존하지 않습니다.
- JSON의 Unicode·키 정렬·구분자·UTF-8·마지막 LF를 보존합니다. 원장 hash는 LF까지 포함하고, 그래프 인코더의 기존 `allow_nan=True` 옵션도 명시해 유지합니다. 원문/raw hash·전송 JSON·응답 크기 계산·평가 기록은 계약이 다르므로 저장 인코더로 일괄 교체하지 않습니다.
- 정리 경고의 상대 POSIX 경로·오류 종류·errno와 예외 전파를 유지합니다. 공용 변환은 `CleanupFailure`·`SaveResult`나 파일을 변경하지 않으며 정리 경고 때문에 성공한 저장을 다시 실행하지 않습니다.
- 중복 키 검출·비유한수 처리·오류 종류가 연결된 엄격 파싱, 원문/앵커의 경로 허용 범위, 요청별 공유 캡처와 잠금은 외형이 비슷하다는 이유로 합치지 않습니다. 현재 검증 차이와 같은 임계구역을 보존하고 필요할 때 해당 업무 소유 아래에서 별도로 설계합니다. 과거 형식 fixture는 회귀 기준이므로 공용화 대상에서 제외합니다.
- 각 생산 모듈은 한국어 역할 설명을 두고, 주요 진입점에는 상태/범위·입출력·부작용을 설명합니다. 권한 확인 순서·CAS·전체 이력·원장·비재진입 잠금·정리 경고 등 이해하기 어려운 선택에는 **왜 필요한지**를 적습니다. 단순 문장을 반복하거나 매 줄을 풀이하는 주석은 늘리지 않습니다. AI에 노출되는 MCP 도구 docstring은 외부 계약이므로 이번 설명 보완에서 변경하지 않습니다.

실제 회귀·저장 바이트 대조·독립 검토 결과는 PLAN에서 관리합니다. 새 저장 형식·스키마·권한·DB·API를 도입한 변경으로 해석하지 않습니다.

#### 큰 MCP 파일의 실제 책임 분리 (2026-10-25)

사용자가 공용화 후에도 1,000줄 이상의 파일이 남아 있음을 지적해 **가장 큰 MCP 파일을 먼저 실제로 분해**했습니다. 공용 함수 추출과 주석 보완만으로 책임 분리가 끝났다고 표시하지 않습니다. 초기 B0-1 선행 순서는 MCP 분해 우선으로 조정했습니다. 당시 남긴 큰 ontology/correspondences 파일은 아래 후속 요청에서 분해했으며 다른 업무와 기존 검사/평가 도구 이전은 남깁니다.

| 현재 읽을 위치 | 맡는 책임 | 분리 후 줄 수 |
| --- | --- | --- |
| `core/mcp_server.py` | 기존 공개 factory·명령의 명시적 호환 진입 | 18 |
| `core/mcp/server.py` / `tenant.py` | SDK 호출 방어·legacy 조립 / 현재 정책·tenant/profile dispatch | 47 / 220 |
| `core/mcp/schemas.py` / `validation.py` | 입력 모델·설명 / SDK 변환 전 raw 인자 방어 | 213 / 215 |
| `core/mcp/results.py` / `http.py` | 결과·오류·로그 / MCP 인증·Host/Origin·전송 구성 | 143 / 110 |
| `core/mcp/request_context.py` | 한 곳의 요청별 권한 문맥과 자격증명 읽기 | 22 |
| `core/mcp/tools/` | 문서·온톨로지·검토·대응·개념의 실제 도구 등록 | 파일별 71–241 |
| `core/runtime/mcp_cli.py` | 기존 실행 인수와 stdio/HTTP 분기 | 80 |
| `core/modules/documents/search.py` | 공통 문서 검색·snippet·탐색 한도 | 93 |

기존 1,738줄을 다른 이름의 큰 파일로 옮기거나 동적 `exec`/전체 기호 재수출로 감추지 않았습니다. 호환 진입은 공개 factory와 main만 명시적으로 연결합니다. 내부 상수 mock과 로그 검사는 실제 새 소유 위치로 갱신하며 기존 CLI/외부 factory의 동작은 보존합니다. 검색의 per-file 오류 코드는 호출자가 명시한 분류 함수를 사용해 기존 값을 유지하고 업무 모듈에서 MCP를 역 import하지 않습니다.

줄 수만으로 완료를 판단하지 않습니다. 각 파일이 하나의 읽을 만한 책임을 갖고, 새 기능을 같은 거대 서버 파일에 다시 쌓지 않으며, 입력·도구 정의·현재 권한·같은 저장 계약을 유지해야 합니다. MCP 분리 당시 남겼던 `ontology.py`1,211줄·`correspondences.py`1,005줄은 아래 후속 요청에서 분해했습니다. 백엔드 전체의 남은 업무/검사 이전은 PLAN을 따릅니다.

#### 온톨로지·문서 간 대응의 실제 책임 분리 (2026-10-25)

사용자가 지정한 두 큰 업무 파일을 정한 `core/modules/ontology`·`core/modules/correspondences`로 **실제 분해·연결·회귀 검증**했습니다. 루트의 `ontology.py/anchors.py/correspondences.py/correspondence_schema.py`는 필요한 기호를 명시적으로 재노출하는 호환 진입점만 맡습니다. 내부 소비자인 검토·개념 캡처/조회·영향 조회·MCP·검증 도구는 새 실제 소유 모듈을 직접 참조합니다. 고정된 과거 fixture와 호환성 검사만 이전 진입을 유지할 수 있습니다.

| 업무 | 공용 진입과 실제 협력 책임 | 분리 후 크기 |
| --- | --- | --- |
| 온톨로지 | [store.py](../core/modules/ontology/store.py)가 source/state CAS·생성/공개 순서·공유 잠금 소유. 값/주장 검증·snapshot·capture·context·connections를 명시 협력 함수/객체로 분리 | 공용 Store156줄·최대313줄, 기존 호환62줄 |
| 문서 간 대응 | [store.py](../core/modules/correspondences/store.py)가 저장소·인증 actor와 공용 메서드를 소유. schema/contracts·state/capture·ledger·evidence/applicability·preparation·queries/commands로 분리 | 공용 Store122줄·최대251줄, 기존 호환45줄 |

기존 긴 검증 함수도 인용/끝점·개체·관계·후보·속성의 협력 처리로 나눴습니다. Mixin·동적 메서드 부착·exec/동적 로딩·별표 재수출로 길이를 감추지 않습니다. 한도/오류는 ontology의 constants/errors와 대응의 contracts가 각각 소유하고, 한도 mock은 이 실제 위치를 대상으로 합니다. 대응 ID 생성은 identifiers의 한 지점을 사용해 제안·판단의 기존 UUID4 순서를 유지합니다.

`OntologyStore.generate()`의 lazy review guard, 이미 잠긴 조회에서 쓰는 private 캡처, `_Capture`의 요청별 공유 바이트와 root별 탐색 상태, 대응 prepare/변경의 같은 잠금·의존 closure·lane·undo는 기존 경계를 유지합니다. 협력 함수가 public query를 다시 호출하거나 잠금을 추가하지 않습니다. 저장 JSON/LF·raw hash·generation·복합 CAS·손상 차단·성공 cleanup 경고도 변경하지 않습니다. schema1–6과 스키마 기본값/한정어/원문 근거를 보존하며 새 의미나 승인을 도입하지 않습니다.

새 경계 검사는 [tests/modules/test_domain_layout.py](../core/tests/modules/test_domain_layout.py)에 배치했습니다. 모든 새 업무 모듈의 import에 전송/runtime 또는 저장소/폴더 초기화가 없는지, 호환 기호가 같은 클래스인지, 실제 위임 경로가 tenant 잠금을 재획득하지 않는지 확인합니다. 기존 테스트의 assertion은 유지하고 내부 import·mock만 실제 소유에 맞춥니다. 기존 검사 전체 이전·다른 업무 모듈·일반 API·DB·운영 데이터 이관은 이번 범위에 포함하지 않으며 실제 결과는 PLAN에 기록합니다.

#### 검토·개념/영향 조회 분리와 테스트 이전 (2026-10-25)

후속 사용자 요청으로 [검토](../core/modules/reviews/store.py)와 [개념 조회](../core/modules/knowledge/concepts.py)·[공유 캡처](../core/modules/knowledge/capture.py)·[영향 조회](../core/modules/knowledge/impact.py)를 정한 업무 모듈로 분해했습니다. Store/Capture가 같은 요청 상태와 공용 계약을 소유하고 실제 협력 처리는 명시적으로 호출합니다. 기존 루트5파일은 필요한 클래스/오류/기호의 호환 import만 맡으며 내부 소비자는 실제 소유 모듈을 참조합니다.

검토는 값·actor/claim 식별, 관점/정책 상태, 원문/그래프/원장 캡처, 원장 replay/공개, 현재 판단 render, 근거/유효층 검증, 원문 검토와 전문가 정책 명령으로 나눴습니다. 공용 Store118줄·최대153줄이며 UUID/UTC 시계는 events가 소유합니다. 검토/정책의 모든 층 검증·역이벤트·복합 CAS·성공 cleanup 구분을 같은 잠금 안에서 유지합니다.

개념은 발견·선택 조회·버전/출처 참조·결과/완전성, 공유 캡처는 IO·문서·대응별 탐색·스캔·오류, 영향은 기준/캡처·과거 복원·연결/개체 비교·부분 결과로 나눴습니다. 공용 ConceptStore112줄·ConceptCapture155줄·ImpactStore42줄, 구현 최대218줄입니다. 공유 byte 예산과 root별 docs/reached/순환 stack, 한 번의 tenant 잠금, 전체 선택 맥락·현재/과거/다른 범위·조회 완전성·manifest를 보존합니다. 기준 없는 영향 변경 추정이나 자동 재추출/정책 재적용을 추가하지 않습니다.

`core/test_*.py`32파일은 책임별 `tests/{modules,mcp,runtime,tools,common}`으로 옮기고 기존32파일의 검증문을 유지합니다. v3/v4/v5 고정 fixture3개는 바이트를 바꾸지 않고 `tests/fixtures`로 이전합니다. 파일 위치를 전제로 한 프로젝트/fixture 경로·상호 import·내부 mock을 함께 갱신하고, 전체 검사는 `unittest discover -s tests -t . -v`로 자동 발견합니다. 업무/전송/실행 코드가 tests를 import하지 않도록 경계 검사도 확장합니다. 수동 검증 도구가 합성 입력을 참조하는 경로는 새 tests 위치를 사용하며 도구 구현 자체의 `tools/` 이전은 후속입니다.

온톨로지↔검토의 지연 guard와 개념 서비스의 capture 지연 import는 명시적으로 유지합니다. 폴더 분리만으로 모든 순환·결합이 제거됐다고 표시하지 않습니다. 접근 정책·WikiStore·개인 런처·수동 도구의 전체 이전과 FastAPI는 이번에 착수하지 않으며 실제 검사 결과와 남은 B0 상태는 PLAN에 기록합니다.

#### 저장·권한·런처·수동 도구 이전과 최소 호환 (2026-10-25)

남은 기존 구현을 [documents/store.py](../core/modules/documents/store.py)·[access/policy.py](../core/modules/access/policy.py)·[runtime/personal_launcher.py](../core/runtime/personal_launcher.py)·프로젝트 루트 [tools](../tools/)로 이전했습니다. 실제 처리·옵션·실패 계약을 유지하고 새 추상화·저장 방식·FastAPI는 도입하지 않습니다. [core/paths.py](../core/paths.py)는 프로젝트/data/.venv 기준만 계산하며 파일 생성·설정 읽기·서버 기동을 하지 않습니다. 무인자 WikiStore의 default data와 런처/수동 도구의 프로젝트 기준이 같은 위치를 사용합니다.

| core 직속에 남기는 파일 | 이유 |
| --- | --- |
| `mcp_server.py`, `personal_launcher.py` | 실제 등록된 개인 MCP 실행과 그 자식 실행 진입을 유지. 서버 factory/main과 런처 main만 명시 위임하며 `SystemExit(main())`로 기존 실패 종료 코드도 전달 |
| `storage.py`, `anchors.py`, `reviews.py` | 고정 과거 v3/v4/v5 fixture가 직접 import하는 저장 타입·원문 위치 함수·review guard의 동일 객체를 제공. 고정 fixture3개의 바이트를 바꾸거나 동적 모듈 alias로 우회하지 않음 |
| `paths.py` | 업무·실행·수동 도구가 공유하는 전송 독립적인 순수 기본 경로 |

호출처가 canonical owner로 전환된 `ontology.py`·`correspondences.py`·`correspondence_schema.py`·`concepts.py`·`concept_capture.py`·`concept_schema.py`·`impact.py` 호환7파일과 이전 access 구현을 제거했습니다. 새 업무·전송은 남은 저장/검토 호환을 거치지 않습니다. 옛 수동 도구5파일도 삭제하며 **수동 명령은 `python -m tools.verify_codex`·`tools.verify_ontology`·`tools.verify_answers`·`tools.transition_check`로 변경**합니다. `tools.verify_transition`은 직접 CLI가 없는 보조 모듈이고 실제 전환 명령은 `tools.verify_codex --transition`입니다. 현재 MCP 등록과 그 실행 명령은 그대로 유지하므로 운영 설정을 고칠 필요가 없습니다.

사용자가 테스트를 core 하위로 옮긴 뜻을 반영해 **`core/tests`를 현재 공식 검사 위치**로 정했습니다. 전체는 `.venv/bin/python -B -m unittest discover -s core/tests -t . -v`입니다. module import·subprocess의 프로젝트 cwd·고정 fixture 상대 경로·실제 구현의 mock·문서 링크/명령을 함께 맞춥니다. 기존 검증문·고정 fixture와 수동 평가의 논리/실행 조건은 유지합니다. 새 경로/등록 위임/import 부작용 검사와 실제 stdio/loopback HTTP를 포함한 결과는 PLAN 한 곳에 기록하며 기존 실제 data/.local·정책/토큰·등록/서버·의존성은 변경하지 않습니다.

### D-025 — 자연어 의미 설명·사용자별 관점·사람의 수정 이력 (2026-10-22, 4단계 후속 설계)

상태: **초기 통합 설계와 이유**입니다. 구체 계약은 tenant·권한 [D-026], 선택 문서 맥락 [D-027], 원문 근거 검토 [D-028], 전문가 정책 [D-031]로 구체화했습니다. 이 절은 그 계약을 중복 정의하지 않습니다.

#### 참고 자료와 적용 방향

- [데이터클리닉의 구축 절차](https://dataclinic.ai/blog/ontology-construction-methods)는 답해야 할 업무 질문을 먼저 정하고 개념·속성·규칙·제약·품질을 다루도록 설명합니다. 이를 질문 중심의 범위 설정과 검증에 참고합니다. 팔란티어 자체의 공식 구현 매뉴얼로 취급하지 않습니다.
- [제네시스랩 CTO 인터뷰](https://maily.so/josh/posts/10z37pnvolw)는 자연어로 용어와 시스템 간 연결을 설명하면서 목차는 DB로 관리하고, 형식적 처리는 다른 시스템과 결합한다고 설명합니다. 자연어 의미 설명과 구조화된 관리의 결합을 참고하며 성능 주장을 우리 PoC의 검증 결과로 옮기지 않습니다.
- [팔란티어 공식 개요](https://www.palantir.com/docs/foundry/ontology/overview)는 개체·속성·관계와 함께 업무 동작·함수·보안을 다룹니다. [권한 문서](https://www.palantir.com/docs/foundry/object-permissioning/overview)는 스키마 자원과 실제 개체·관계를 구분합니다. 이 프로젝트에는 업무 질문·변경 통제·접근 권한이라는 원칙을 적용하며 플랫폼 전체를 모방하지 않습니다.

자연어에는 용어의 뜻·조건·예외·사례·관계 설명을 보존하고, v3 구조에는 식별자·유형·관계·속성·관점·출처·revision을 유지합니다. 모든 문장을 관계로 강제 변환하지 않습니다. 구조로 표현하지 못한 설명도 출처와 미표현 범위를 드러내며 조회 맥락에 포함할 수 있어야 합니다. 자연어와 그래프를 서로 독립적인 정답으로 편집하지 않고, 어느 원문 버전과 검토에서 나왔는지 연결합니다. 그래프에서 만든 요약을 다시 원문 증거로 삼는 순환도 피합니다.

원문 문서로 관리할 업무 용어 정의나 추가 지식은 기존 위키 문서를 먼저 재사용합니다. 원문 밖 전문가 판단은 D-031의 정책 원장에 기록합니다. 새 영구 문서가 필요해져도 `WikiStore.save()`와 전체 버저닝을 사용합니다. 아직 빈 템플릿·샘플 위키·별도 저장소는 만들지 않습니다. 위키 속 지시문이나 자연어 금칙은 인증·서버 제한을 대체하거나 도구 실행 권한을 부여하지 않습니다.

#### tenant와 관점의 별도 축

접근 경계인 워크스페이스(tenant), 사용자 소속·행동 권한, 원문의 업무 맥락, 조회 관점을 분리합니다. 현재 용어와 PoC 인증·저장 배치는 [D-026], 원문의 업무 영역과 이해관계자 관점의 구분은 [D-023]에 모읍니다. 팀 시각이 다르다는 이유만으로 tenant를 나누지 않고 실제로 격리할 자료 공간을 기준으로 합니다. [팔란티어의 여러 팀과 온톨로지 설명](https://www.palantir.com/docs/foundry/ontologies/ontologies-overview)도 참고했습니다.

초기에는 관점에 집중한 추가 추출을 가설로 제안했으나, 현재 기준은 [D-036]의 **사용자 역할·조회 관점으로 추출 대상을 줄이지 않음**입니다. 필요한 다른 관점의 조건·예외와 미분류 자료를 유지하는 조회는 [D-027], 답변 품질 비교는 [D-029]를 따릅니다. 검색 가중치·순위 구현을 뜻하지 않습니다.

향후 결과 캐시를 도입한다면 tenant뿐 아니라 실제 권한 범위·프로필·원문/검토 버전과 권한 변경을 고려해야 합니다. 현재 구현은 [D-026]처럼 권한·응답 캐시 없이 요청마다 정책을 확인합니다.

#### 사람이 수정할 때의 보존 계약

[팔란티어 Actions](https://www.palantir.com/docs/foundry/action-types/overview)의 권한·검증을 거치는 변경 단위를 참고했습니다. 수정은 서버 API를 사용하며 파생 JSON을 직접 편집하지 않습니다.

| 수정 대상 | 현재 담당 계약 |
| --- | --- |
| 원문 내용 자체 | [D-009]의 원문 CAS·전체 히스토리; 그래프 갱신은 별도 요청 |
| 원문은 맞지만 AI 해석이 잘못됨 | [D-028]의 실제 인용에 근거한 검토·정정 |
| 원문에 없는 전문가 업무 판단 | [D-031]의 별도 권한·Action log; 현재는 기존 관계·속성 대상 |
| 독립 공통 정의·문서 간 대응 판단 | 독립 공통 정의 등록은 [D-037]의 후속 범위; 문서 간 대응 판단은 [D-038]의 별도 구현 경로이며 기존 문서 검토 API와 구분 |

되돌림·주장 식별·상태 CAS·재추출 후 이력 보존과 재검토의 단일 계약은 [D-028]·[D-031]을 따릅니다. 사람의 수용은 출처가 있는 판단이며 객관적 진실의 자동 증명이 아닙니다. 검토 화면의 상태는 [D-033]에서 관리합니다.

## 2. 저장과 버전 보존

### D-002 — 전체 파일 버저닝

상태: 현재 적용하는 작업 원칙입니다.

- 결정: 수정 전 내용을 차이분이 아닌 전체 파일로 보존합니다. 저장·읽기·버저닝을 1단계에서 먼저 구현하고 MCP 기능이 이를 사용하게 합니다.
- 이유: 각 버전을 독립적으로 확인할 수 있고, MCP 연결 전에 데이터 보존 동작을 검증할 수 있습니다.

### D-005 — Python 표준 라이브러리와 Markdown 경로 (2026-10-21, 1단계)

상태: 현재 적용하는 저장 계약입니다.

- 결정: 저장 모듈은 Python 3.9 이상과 macOS/Linux를 대상으로 구현합니다. 외부 의존성 없이 UTF-8 Markdown을 사용하고 문서 식별자는 `주제/문서.md` 같은 상대 경로로 정합니다. 절대 경로, 빈 경로 구성요소, `.`·`..`, 역슬래시, 심볼릭 링크를 거부합니다.
- 이유: 현재 작업 환경에서 바로 검증할 수 있고, 이후 MCP 도구에서 저장 모듈을 재사용할 수 있습니다. 문서를 파일로 직접 확인하면서 경로가 저장 영역 밖으로 연결되는 실수를 줄입니다.
- 범위: 지정한 데이터 루트는 이미 존재해야 합니다. 운영자만 데이터 디렉터리를 관리한다고 가정하며, 악의적인 외부 프로세스가 검사와 파일 접근 사이에 디렉터리를 바꾸는 공격까지 방어하는 격리 계층은 아닙니다.

### D-006 — 완성된 히스토리를 먼저 저장 (2026-10-21, 1단계)

상태: 현재 적용하는 저장 계약입니다.

- 결정: 원본을 읽고 D-009의 기준 버전 검사를 통과한 뒤 새 내용을 같은 디렉터리의 임시 파일에 기록하고 `flush`·`fsync`합니다. 기존 문서가 있으면 수정 전 바이트 전체를 히스토리 임시 파일에도 기록·동기화하고, 하드 링크로 최종 히스토리 이름을 생성한 뒤 `os.replace`로 원본을 교체합니다. 최초 저장 역시 하드 링크로 생성하여 기존 파일을 덮어쓰지 않습니다.
- 이유: 저장 중간의 불완전한 파일이 최신 원본이나 완성된 히스토리로 노출되는 것을 피하고, 히스토리 생성 실패 시 원본 교체에 도달하지 않도록 합니다. 하드 링크는 대상 이름이 존재하면 실패하므로 기존 히스토리를 덮어쓰지 않습니다.
- 실패 처리: 이 호출에서 만든 임시 파일만 정리합니다. 히스토리가 완성된 후 원본 교체가 실패하면 원본과 해당 히스토리를 모두 보존하고 오류를 전달합니다. 실패 후 재시도로 같은 내용의 히스토리가 추가될 수 있습니다. 저장 완료와 정리 실패의 구분은 보완 결정 D-010을 따릅니다.
- 범위: 일반 실행과 처리 가능한 예외에서의 보존을 검증합니다. 디렉터리 메타데이터까지 포함한 전원 장애 내구성이나 강제 종료 후 임시 파일 회수는 구현·검증하지 않았습니다.

### D-007 — 버전 이름과 동일 내용 처리 (2026-10-21, 1단계)

상태: 현재 적용하는 저장 계약입니다.

- 결정: `data/_history/<문서 상대 경로>/<UTC시각>-<UUID>.md`에 전체 파일 버전을 저장합니다. 이름 충돌은 오류로 처리하고 기존 파일을 보존합니다. D-009의 기준 버전 검사를 통과하고 최신 내용과 바이트가 같으면 쓰기를 생략합니다.
- 이유: 문서별 버전을 모아 확인하기 쉽고, 빠른 반복 수정에도 고유한 이름을 사용할 수 있습니다. 변경 없는 재저장으로 불필요한 버전을 만들지 않습니다. 파일 내용은 줄바꿈을 포함한 원래 바이트를 보존하며 파일 권한·소유자 등 메타데이터 백업은 범위에 포함하지 않습니다.

### D-008 — 데이터 루트 단위 쓰기 잠금 (2026-10-21, 1단계)

상태: 현재 적용하는 저장 계약입니다.

- 결정: `data/.storage.lock`의 `fcntl.flock`으로 읽기 전부터 원본 갱신까지 쓰기 작업을 직렬화합니다. 잠금 파일은 지우지 않고 운영 파일로 유지합니다. 읽기는 원자적으로 공개된 최신 파일을 읽습니다.
- 이유: 여러 인스턴스·프로세스가 같은 이전 버전을 기준으로 덮어쓰면서 중간 버전을 잃는 일을 방지합니다. 잠금 파일을 삭제하면 서로 다른 파일에 잠금을 잡을 수 있으므로 유지해야 합니다. PoC 규모에서는 문서별 잠금보다 단순한 전역 쓰기 잠금을 선택합니다.
- 범위: 모든 쓰기 작업이 이 저장 모듈을 사용해야 합니다. 외부 편집기의 직접 변경, Windows에서 저장 모듈을 직접 실행하는 구성, 네트워크 파일시스템은 지원·검증 범위 밖입니다. Windows 클라이언트의 원격 접속([D-017])과는 별개입니다. 잠금만으로는 오래된 내용을 읽은 클라이언트의 덮어쓰기를 막지 못하므로 D-009의 버전 검사를 함께 적용합니다.
- 후속 보완: 2단계에서 잠금 획득 대기를 제한했습니다. 시간과 오류 정책은 D-014를 따릅니다.

### D-009 — 필수 기준 버전 검사로 오래된 내용 덮어쓰기 방지 (2026-10-21, 1단계 보완)

상태: 현재 적용하는 저장 계약입니다.

- 문제: 최초 구현의 잠금은 파일 쓰기를 직렬화하고 모든 저장본을 히스토리에 남겼지만, 같은 원본을 읽은 두 사용자 중 나중에 저장한 사람이 먼저 저장한 사람의 변경을 최신 문서에서 지울 수 있었습니다. 다중 사용자 연결 전에 보완합니다.
- 결정: `read()`는 한 번 읽은 바이트에서 본문과 SHA-256을 함께 계산하여 불변 `DocumentSnapshot(content, revision)`으로 반환합니다. `save()`는 기본값 없는 키워드 인수 `expected_revision`을 필수로 받습니다. `None`은 문서가 없을 때만 허용하는 신규 생성 조건입니다.
- 검사 시점: 기존 쓰기 잠금 안에서 최신 바이트의 버전값과 비교합니다. 불일치하면 동일 내용 생략·문서 폴더 생성·임시 파일 작성·히스토리 저장보다 먼저 `RevisionConflictError`를 반환합니다. 충돌 요청은 원본·히스토리를 변경하지 않습니다. 기준 버전을 생략하는 예전 API나 강제 덮어쓰기 경로는 제공하지 않습니다.
- 충돌 처리: 호출자가 최신 문서를 다시 읽고 자신의 변경을 재반영해야 합니다. 예외의 `current_revision`만 복사해서 이전 전체 본문을 재전송하는 자동 재시도는 하지 않습니다. 서로 같은 부분을 수정한 경우의 판단과 자동 병합은 이번 보완에 포함하지 않습니다.
- 이유: 현재 파일과 잠금 구조를 유지하면서 변경 유실을 막습니다. 버전 메타데이터 파일이나 별도 데이터베이스가 필요하지 않으며, 원본과 버전 정보 두 파일을 함께 갱신하는 문제도 만들지 않습니다.
- 의미와 한계: 버전값은 수정 이벤트 번호가 아니라 정확한 내용의 식별값입니다. `A → B → A`로 되돌리면 처음과 같은 버전값이므로 A를 기준으로 한 저장을 허용합니다. 원문 저장에서는 동일 내용 복귀까지 모든 중간 수정 사실을 충돌로 취급하지 않습니다. 검토 판단은 중간 변경도 추적하는 [D-028]의 별도 상태 버전을 사용합니다. 히스토리 파일 이름의 UTC·UUID 버전과 이 내용 버전값은 용도가 다릅니다.

### D-010 — 저장 결과와 임시 파일 정리 실패 분리 (2026-10-21, R-001 보완)

상태: 현재 적용하는 저장 계약입니다.

- 결정: 성공한 `save()`는 항상 `SaveResult(revision, history_path, changed, cleanup_failures)`를 반환합니다. 기존 `Path` 또는 `None` 반환을 이 구조로 바꿉니다. 생성·수정은 `changed=True`, 변경 없는 재저장은 `False`이며 `history_path`는 새로 보존한 이전 파일의 경로 또는 `None`입니다.
- 정리 실패: 새 문서가 이미 공개됐거나 히스토리가 완성된 뒤 임시 파일 정리만 실패하면 이를 수집합니다. 히스토리 정리만 실패한 경우에는 원본 교체를 계속합니다. 모든 staging 처리가 끝난 뒤 성공 결과에 남은 경로와 원래 정리 오류를 포함합니다. 경고를 예외로 바꾸는 런타임 설정에 영향을 받는 `warnings.warn()`은 사용하지 않습니다.
- 실제 저장 실패: `fsync`, 파일 공개, 원본 교체 등이 실패하면 원래 예외 타입·원인을 유지합니다. 정리도 실패하면 예외의 `cleanup_failures`에 별도 정보를 붙여 주 오류가 가려지지 않게 합니다. 이미 보존한 히스토리는 지우지 않습니다.
- 소비된 임시 경로: `os.replace()`가 성공해 임시 이름이 사라졌다면 해당 경로를 다시 삭제하려 하지 않습니다. 실패한 정리는 다음 실행에서 자동으로 쓸어 지우지 않고 호출자가 결과를 확인할 수 있게 합니다.
- 이유: 사용자에게 실패라고 알리면서 실제 문서가 바뀌어 있는 상황을 피하고, 저장 결과를 유지하면서 정리가 필요한 파일을 숨기지 않기 위해서입니다. 이번 변경은 처리 가능한 파일 정리 오류를 다루며 강제 종료·전원 장애 복구 보장은 추가하지 않습니다.

### D-011 — 문서당 UTF-8 1 MiB 상한 (2026-10-21, R-002 보완)

상태: 현재 적용하는 저장 계약입니다.

- 결정: `MAX_DOCUMENT_BYTES = 1024 * 1024`로 정합니다. 새 본문과 읽거나 수정할 기존 문서 모두 UTF-8 바이트 기준 1,048,576바이트까지 허용하고 초과 시 `DocumentTooLargeError`를 발생시킵니다. 한글·이모지처럼 여러 바이트를 쓰는 문자도 실제 인코딩 크기로 판단합니다.
- 입력 검사: 문자 수 자체가 상한을 넘으면 거대한 추가 바이트 복사본을 만들기 전에 거부합니다. 그 외에는 UTF-8 인코딩 후 바이트 수를 검사합니다. 초과 요청은 잠금 파일·하위 문서 폴더·임시 파일·히스토리를 만들기 전에 거부합니다.
- 기존 파일 검사: 본문과 버전값에 쓸 바이트를 한 번에 최대 `상한 + 1`바이트만 읽습니다. 파일 크기 메타데이터만 믿고 전체를 읽지 않으므로 큰 파일이나 읽기 전 증가한 파일도 제한됩니다. 기존 초과 파일은 그대로 보존하고 읽기·수정을 거부합니다.
- 오류 정보: 오류의 `observed_bytes`는 확인한 최소 바이트 수이며 항상 전체 파일 크기라는 뜻은 아닙니다. 읽기를 제한하면서 정확한 전체 크기를 얻기 위해 추가로 전체 파일을 읽지는 않습니다.
- 이유와 범위: PoC의 텍스트 문서에는 여유를 주면서 큰 입력과 전체 파일 버저닝의 비용을 제한합니다. 문서 개수·전체 디스크 용량의 상한과 기존 히스토리 자동 삭제는 제공하지 않습니다. 이후 추가한 잠금 대기는 [D-014], HTTP 요청 본문 한도는 [D-017], 사용자 접근 권한은 [D-026]을 따릅니다. 문서 크기 상한과 각 요청·조회 예산은 별개입니다.

### D-014 — 잠금 획득 대기 제한 (2026-10-21, R-003 보완)

상태: 현재 적용하는 저장 계약입니다.

- 결정: 기본 `DEFAULT_LOCK_TIMEOUT_SECONDS=5.0`이며 `WikiStore(..., lock_timeout_seconds=...)` 또는 서버 `--lock-timeout`으로 조정합니다. 유한한 0 이상 숫자만 허용하고 0은 즉시 한 번 시도합니다.
- 구현: `LOCK_EX | LOCK_NB`와 단조 시계를 사용해 최대 50 ms 간격으로 재시도합니다. 경쟁이 계속되면 `StorageBusyError(timeout_seconds)`를 발생시키고 열린 잠금 파일을 닫습니다. 경쟁 외의 잠금 오류는 원래 예외·오류 번호를 보존합니다. 잠금 파일을 삭제하지 않습니다.
- 데이터 보존: 잠금을 얻기 전에는 문서·히스토리·문서 하위 디렉터리를 변경하지 않습니다. 시간 초과 요청은 MCP에서 `storage_busy`, `retryable: true`를 받고 나중에 같은 기준 버전으로 다시 시도할 수 있습니다. 그 사이 내용이 바뀌면 기존 충돌 검사가 적용됩니다. 서버가 자동 재시도하지 않습니다.
- 범위: 잠금 획득 대기만 제한합니다. 획득 후 디스크 I/O의 전체 실행 시간, 클라이언트 연결 종료 후 복구, 문서별 잠금이나 공정한 요청 순서는 추가하지 않습니다. 기본 5초는 PoC 설정값이며 실시간 처리 보장이 아닙니다.

## 3. MCP 연결과 접근 권한

### D-012 — 공식 Python MCP SDK와 로컬 stdio (2026-10-21, 2단계)

상태: 현재 SDK·stdio 운영 원칙과 2단계 도입 기록입니다. 후속 전송·인증은 [D-017]·[D-026]을 따릅니다.

- 결정: 공식 `mcp==2.3.0`을 프로젝트 `.venv`에 설치하고 `core/mcp_server.py`에서 `MCPServer`로 읽기·쓰기·검색 도구를 등록합니다. 의존성은 `requirements.txt`에 기록하고 SDK가 메시지 처리·입력 스키마·프로토콜 버전 호환을 맡습니다. 통신을 직접 구현하지 않습니다.
- 실행 환경: SDK는 Python 3.10 이상이 필요합니다. 현재 시스템 Python 3.9.6은 저장 모듈 검증에 유지하고, 이미 제공된 Python 3.12.14로 프로젝트 가상 환경을 만들었습니다. 전역 Python이나 패키지는 변경하지 않았습니다. 저장 모듈은 외부 의존성 없이 Python 3.9 호환을 유지합니다.
- 전송: 2단계 최초 실행 진입점은 로컬 stdio였습니다. 도구 함수는 기존 `WikiStore`를 사용하고 SDK가 동기 함수를 작업 스레드에서 실행하므로 잠금 대기가 이벤트 루프를 막지 않습니다. 표준 출력은 MCP 통신 전용, 로그는 표준 오류로 보냅니다.
- 이유와 범위: 2단계에서는 도구 기능과 실제 프로토콜을 먼저 검증하고 개인 서버 전송·인증·배포 결정을 미뤘습니다. 이후 CLI 연결은 [D-016], HTTP는 [D-017], 개인 인증 tenant 모드는 [D-026]에서 보완했습니다. SDK 클라이언트의 이전 `initialize` 방식과 새 기능 조회 방식의 검사 결과는 [PLAN](PLAN.md)에 보존합니다.
- 근거: [공식 Python SDK](https://github.com/modelcontextprotocol/python-sdk), [도구 개발](https://py.sdk.modelcontextprotocol.io/servers/tools/), [stdio·HTTP 전송 규약](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)을 확인하고 설치된 2.3.0의 API를 검사했습니다.

### D-015 — MCP 쓰기 계약과 오류 전달 (2026-10-21, 2단계)

상태: 현재 MCP 읽기·쓰기의 저장 결과·오류 계약입니다.

- 결정: 읽기는 본문과 버전을 함께 반환하고 쓰기는 필수 `expected_revision`을 받습니다. 신규 생성은 실제 JSON `null`, 수정은 읽기에서 받은 SHA-256 값입니다. `WikiStore.save()`의 버저닝·충돌 방지·크기 제한을 그대로 재사용합니다. 도구가 파일을 직접 덮어쓰지 않습니다.
- 입력 보완: SDK 2.3.0은 nullable 인수의 문자열 `"null"`을 실제 `null`로 사전 변환하는 동작이 확인됐습니다. `WikiMCPServer.call_tool()`의 공개 확장 지점에서 원시 값이 실제 `None` 또는 64자리 소문자 SHA-256 문자열인지 먼저 검사하고, 입력 스키마에도 형식을 표시합니다. SDK 내부 코드를 수정하지 않습니다.
- 결과: 구조화 결과와 텍스트 JSON에 같은 내용을 담습니다. 성공은 `ok: true`·`isError: false`이며 저장 후 정리만 실패해도 성공을 유지하고 `cleanup_failures`를 전달합니다. 이전 파일과 임시 파일 경로는 데이터 루트 기준 상대 경로입니다.
- 오류: 예상 가능한 도구 실행 오류는 `ok: false`·`isError: true` 및 오류 코드·설명·재시도 가능 여부로 전달합니다. SDK 입력 검증 실패는 SDK의 도구 오류 응답을 사용합니다. 저장 자체와 정리가 함께 실패하면 주 오류를 유지하고 정리 정보를 `error.cleanup_failures`에 넣습니다. 서버 내부 경로를 오류 설명으로 그대로 내보내지 않고 실제 저장 오류의 상세 로그는 stderr에 기록합니다.
- 재시도와 신뢰: 잠금 사용 중만 재시도 가능으로 표시합니다. 편집 충돌은 최신 내용 확인과 수정 재반영이 필요합니다. 저장 성공 후 정리 오류를 이유로 쓰기를 반복하지 않습니다. 읽은 위키 본문은 데이터이며 서버·에이전트 지침으로 취급하지 않습니다.

### D-016 — 맥북의 로컬 stdio 서버와 프로젝트 Codex CLI 연결 (2026-10-21, 3단계)

상태: legacy 로컬 stdio 연결의 결정·검증 당시 설정입니다. 개인 인증 tenant 모드는 [D-026]을 따릅니다.

- 사용자 확인: 별도 개인 서버가 없으므로 맥북을 임시 서버로 사용했습니다. 3단계 최초 연결에서는 로컬 stdio에 별도 MCP 인증을 두지 않았습니다.
- 실행 환경: 최초 연결 검증 당시 macOS 26.5.2 arm64, 프로젝트 Python 3.12.14, Codex CLI 0.163.0-alpha.11과 기존 ChatGPT 로그인을 사용합니다. 프로젝트의 실제 절대 경로를 지정해 Codex가 기존 `core.mcp_server`를 stdio로 실행하게 합니다. 이 로컬 연결 자체는 HTTP 포트가 필요하지 않습니다.
- 설정 범위: `.codex/config.toml`의 `mcp_servers.llm_wiki`에 연결을 둡니다. 프로젝트 전용 Python·작업 디렉터리·데이터 루트를 사용합니다. 최초 연결은 읽기·쓰기·검색 세 도구로 검증했으며, 현재 도구 목록과 실행 설정은 [README](../README.md)에서 관리합니다. 필요한 서버를 `required`로 지정하며 시작 대기는 20초, 도구 응답 대기는 30초로 둡니다. 전역 사용자 설정이나 다른 MCP 연결을 바꾸지 않습니다. 프로젝트 신뢰가 필요한 CLI 동작을 실행 안내에 설명합니다.
- 접근과 쓰기 확인: legacy 로컬 stdio 서버는 현재 macOS 계정 권한으로 실행하며 별도 MCP 로그인·토큰을 요구하지 않습니다. 네트워크 전송이 없기 때문에 이 구성을 인증 없는 원격 공개 서버로 해석하지 않습니다. Codex의 ChatGPT 로그인은 모델 사용 인증이며, `default_tools_approval_mode = "writes"`는 문서 쓰기 실행을 확인하는 별도 정책입니다. 이 legacy 구성은 사용자별 서버 권한이나 변경 작성자 추적을 제공하지 않습니다. 개인 인증은 [D-026], 검토·전문가 판단의 Action log는 [D-028]·[D-031]을 따르며, 이 로그가 모든 원문 저장의 작성자 추적을 제공하는 것은 아닙니다.
- 오류 경계: CLI의 도구 응답 시간 제한과 D-014의 저장 잠금 대기 제한은 다릅니다. 응답이 끊기거나 시간 초과됐을 때 서버의 저장이 취소됐다고 가정하지 않습니다. 다시 읽어 반영 여부를 확인하고 기존 충돌·재시도 규칙을 따릅니다.
- 검증 방식: 기존 저장·MCP 회귀 검증에 더해 `core/verify_codex.py`로 실제 Codex CLI의 임시 세션을 실행합니다. 검증 시에만 별도 임시 데이터 루트를 지정하고 실제 MCP 호출의 JSONL 입력·결과, 최신 내용, 수정 전 전체 히스토리 바이트와 충돌 후 보존을 검사합니다. 운영 위키에 샘플을 남기지 않으며 실제 결과는 [PLAN](PLAN.md)에서 관리합니다.
- 원격 방향의 후속 결정: 초기에는 소수 개발자용 SSH stdio와 여러 사용자용 HTTPS·개인 인증을 검토했습니다. 이후 임시 HTTPS는 [D-017], PoC 개인 토큰·권한은 [D-026]으로 구현했습니다. SSH 연결·MCP OAuth 2.1은 구현하지 않았으며 자체 계정/회사 SSO의 선택은 [D-030]의 미결정 범위입니다.
- 이유: 이미 검증한 저장 모듈과 MCP 도구를 그대로 연결하여 이번 단계의 CLI 호출·보존 동작에 집중할 수 있습니다. 토큰·키를 문서나 설정에 기록하지 않으며, 원격 접근 요구가 생기기 전에 인증 없는 네트워크 서비스를 열지 않습니다.
- 근거: 설치된 CLI의 명령 도움말·설정 스키마와 [공식 CLI MCP 안내](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)를 확인했습니다. 실행 명령과 설정 변경 위치는 [README](../README.md)에서 관리합니다.

### D-017 — Windows 원격 PoC와 임시 HTTPS 터널 (2026-10-21, 3단계 보완)

상태: legacy 공유 토큰 원격 PoC의 결정입니다. 개인 인증 tenant 모드는 [D-026]이며, 이 기록은 현재 터널 실행 상태를 보장하지 않습니다.

- 사용자 확인: Windows에서 접속하며 외부 인터넷에서도 사용할 수 있도록 준비합니다. 사용자는 사설 VPN 대신 Cloudflare 임시 HTTPS 주소를 선택했습니다. D-016의 인증 생략은 로컬 stdio에 한정하고 HTTP에는 토큰을 요구합니다. 이는 당시 원격 연결 보완의 범위이며 이후 단계의 진행 상태는 [PLAN](PLAN.md)을 따릅니다.
- 서버: 기존 도구와 `WikiStore`를 재사용하는 Streamable HTTP 실행 경로를 추가합니다. 기본 실행은 stdio로 유지합니다. HTTP는 `127.0.0.1:8765`에만 바인딩하고 HTTPS 터널이 연결합니다. 공유기 포트 전달이나 macOS 원격 로그인 설정은 변경하지 않습니다.
- 접근: 무작위 테스트용 Bearer 토큰을 환경변수로 전달합니다. 토큰 누락·오류·중복 Authorization 헤더는 401로 거부하며 상수 시간 비교를 사용합니다. 토큰 파일은 버전 관리 제외 `.local/mcp-token`에 0600 권한으로 보관하고 채팅·문서·프로세스 인수에 실제 값을 넣지 않습니다. 이 공유 토큰은 사용자별 신원·권한·작성자 추적을 제공하지 않습니다.
- 전송: Quick Tunnel의 SSE 미지원에 맞춰 JSON 응답과 stateless HTTP를 사용하고 `/mcp`의 비POST 요청은 인증·Host/Origin 검사 후 405로 반환합니다. SDK의 DNS rebinding 보호를 유지하고 터널이 로컬 Host 헤더를 전달합니다. HTTP 본문은 8 MiB로 제한하여 JSON 이스케이프로 커지는 입력을 수용하되 저장 모듈의 UTF-8 1 MiB 문서 제한은 그대로 적용합니다.
- HTTPS: 계정·도메인 없이 임시 `trycloudflare.com` 주소를 사용합니다. Cloudflare가 HTTPS를 종료하고 맥북으로 터널링하므로 트래픽은 이 서비스를 경유합니다. 프로세스 종료 시 주소가 동작하지 않으며 재실행 시 주소가 바뀔 수 있습니다. 상시 운영·고정 주소·가용성 보장은 이번 범위가 아닙니다. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
- 도구 설치: 공식 Cloudflare GitHub 릴리스의 `cloudflared 2026.10.3` macOS arm64 배포를 `.local/cloudflared`에만 설치했습니다. 아카이브 SHA-256 `1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55`를 릴리스 메타데이터와 대조했습니다. 시스템 전역 설치·자동 시작·자동 갱신은 추가하지 않습니다.
- 검증 데이터: 원격 확인은 `.local/remote-check/`로 격리하며 운영 `data/wiki/`·`data/_history/`를 사용하지 않습니다. Windows 확인에 필요한 실행 파일·토큰·접속 주소·프로세스 정보·테스트 저장소는 `.local/`에 모읍니다. 서버와 터널을 종료하고 검증을 마친 뒤 이 작업 소유의 런타임 산출물만 정리합니다.
- 완료 판정: 맥북에서 공개 HTTPS 주소를 호출한 결과와 별도 Windows 기기의 실제 접속 결과를 구분합니다. 후자가 없으면 원격 보완 전체를 완료로 표시하지 않습니다. 실행 방법은 [README](../README.md), 실제 검증 결과는 [PLAN](PLAN.md)에 기록합니다.

### D-026 — 사용자 권한과 관점 프로필을 분리한 tenant 모드 (2026-10-22, 4-A)

상태: 현재 개인 인증·워크스페이스 격리·행동 권한·조회 프로필의 계약입니다.

- 용어와 범위: 독립 프로젝트 자료 공간을 **워크스페이스**라고 부르고 기존 API의 `tenant`에 대응시킵니다. 한 사용자는 여러 워크스페이스에 소속될 수 있습니다. 행동 권한은 무엇을 읽고 변경·검토할 수 있는지 결정하고, 현업·개발자·아키텍처 등의 관점은 허용 자료를 어떤 질문 중심으로 조회하는지 나타냅니다. 관점 때문에 같은 tenant의 문서 내 접근을 제한하지 않습니다. 추출의 보조 자료도 선택한 허용 tenant 안에서 찾으며, 사용자 관점으로 원문 추출을 축소하지 않는 기준은 [D-036]을 따릅니다. 서비스/Bounded Context 힌트의 설계 후보는 [D-035]입니다.
- 격리 단위: 관리자 지정 `tenant_root/<tenant-id>`마다 기존 `WikiStore`를 사용합니다. `wiki/`, `_history/`, `_ontology/`, 저장 잠금이 각각 분리되며 검색·연결 탐색도 승인된 저장소 안에서만 실행합니다. tenant ID는 엄격한 식별자이고 임의 경로 매핑은 받지 않습니다. 기존 단일 저장소는 자동 이동하지 않으며 CLI에서 `--data-dir`과 `--access-config`는 배타적입니다. 관리자가 같은 저장소를 별도의 legacy 서버로 노출하지 않아야 합니다.
- 인증: PoC에서는 개인별 32~256자 URL-safe 고엔트로피 토큰과 정책에 저장한 SHA-256을 비교합니다. HTTP는 요청별 단일 Bearer 헤더, stdio는 서버 프로세스의 지정 환경변수를 사용합니다. 기존 공유 토큰 모드는 그대로 유지하지만 다중 모드에서 공유 토큰·무인증 경로로 되돌아가지 않습니다. 사용자·소속·권한·프로필 정책은 tenant 저장 루트 밖의 관리자 파일입니다. 사용자 토큰 원문은 정책/위키/문서에 저장하지 않습니다.
- 표준과 범위: [MCP HTTP 권한 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)는 OAuth 기반 방식을 정의하고 stdio는 환경에서 자격 증명을 받도록 구분합니다. 이번 전용 정적 Bearer 게이트는 완전한 MCP OAuth 구현이 아닙니다. IdP·OAuth·토큰 만료/발급 서비스·조직 디렉터리는 구현하지 않습니다. 설치된 SDK 2.3.0의 실제 요청 context와 스레드 전달 경로를 확인해 연결했습니다.
- 소속과 행동: 기본 행동 권한은 `read`, `write`, `ontology_write`이며 이후 [D-028]의 `ontology_review`, [D-031]의 `ontology_policy`를 별도로 추가했습니다. 쓰기·생성에는 읽기 권한도 있어야 합니다. 서버는 요청의 tenant 선택을 인증된 사용자의 소속과 대조하고 요청마다 권한을 검사합니다. 클라이언트가 `user_id`, `permissions`, 직접 필터 등 추가 인자로 권한을 바꾸지 못하게 거부합니다. 문서별 ACL·그룹 상속은 현재 범위 밖이며 같은 tenant 안의 읽기 범위는 전체입니다.
- 관점: tenant별 프로필에 `domain`과 `viewpoint`를 정의하고 사용자 소속별 허용 프로필·기본값을 지정합니다. 현업/개발팀의 다른 기본 관점은 같은 tenant 안에서 구성합니다. `ontology_query.profile`은 그 요청에만 적용하며 전역/세션의 현재 관점을 변경하지 않습니다. 프로필은 데이터 접근 권한이 아니며 원문·검색·연결 및 참조 개체는 같은 tenant의 읽기 범위를 유지합니다. 직접 `domain`/`viewpoint` 대신 관리자가 정의한 프로필을 사용합니다.
- 기존 의미 보존: 프로필 조회는 v3의 정확한 context 필터를 재사용하며 그래프를 쓰지 않습니다. 태그 없는 주장도 임의로 공통 사실로 승격하지 않습니다. 전체 그래프 생성은 현재 관점으로 축소하지 않고 기존 계약을 유지합니다. 공통 전제·다른 관점 제약·미분류 항목을 보존하는 조회는 [D-027]에서 구현했습니다. 현재 exact 필터·focus 구분은 검색 순위 가중치가 아니며, 사용자 관점별 부분 추출/자동 병합 계약은 제공하지 않습니다.
- 요청과 회수: 한 도구 dispatch는 정책 스냅샷 하나로 사용자·소속·권한·프로필·저장소를 고정합니다. 권한/응답 캐시는 두지 않고 매번 정책을 다시 읽습니다. HTTP 입구에서도 인증하되 실제 도구 dispatch에서 다시 검사합니다. 열린 클라이언트에서도 다음 호출은 변경된 권한을 적용하며 이미 승인되어 실행 중인 저장을 취소하지 않습니다. 원자적 정책 교체를 권장하고 손상·삭제·잘못된 참조·크기 초과 정책은 실패 차단합니다. 관리자에 의한 실행 중 파일시스템 변조까지 OS 격리로 막는 구조는 아닙니다.
- 응답: `access_context`는 자기 소속·허용 프로필만 반환합니다. 승인된 도구 응답은 `access`에 실제 사용자·tenant·프로필과 정책 SHA-256을 포함합니다. 비허용/없는 tenant는 동일 `access_denied`로 처리하고 다른 tenant의 존재·내용·revision·검색 수·연결 상태·저장 경로를 읽어 오류에 담지 않습니다. 정책 문제는 `access_unavailable`이며 HTTP 게이트에서는 503입니다. 이 식별정보는 향후 검토 주체의 기반이고, 기존 파일 히스토리에 사용자 감사 기록을 이미 추가했다는 뜻은 아닙니다.

실행 방법은 [README](../README.md#사용자테넌트관점-프로필-모드-4-a), 실제 테스트 결과와 미실행 범위는 [PLAN](PLAN.md)에 기록합니다. 이후 맥락 구성·검토/정책 API는 [D-027]·[D-028]·[D-031]로 보완했으며 제품 UI는 미구현입니다.

### D-041 — 개인 인증 tenant 연결 전환과 보존·복구 절차 (2026-10-23)

상태: **개인 인증 read 연결의 운영 계약·최초 전환 기록**입니다. 현재 자료 위치는 아래 [data 경로 전환](#워크스페이스-자료-경로를-data로-전환-2026-10-25)을 따르며 새 인증 SDK와 사용자 앱 재시작 후 현재 채팅의 조회 검증을 각각 완료했습니다. D-038의 대응 8도구와 D-040의 개념 발견/통합 조회를 개인 인증 연결에서 쓰기 위한 계약이며 현재는 조회 13개만 허용합니다. 원문·원장·원격 검증 자료와 제품 UI는 보존합니다. 설계·구현·실제 적용의 각 검증 결과는 [PLAN](PLAN.md), 실행 방법은 [README](../README.md#개인-인증-런처와-전환-점검-d-041)를 따릅니다.

#### 실제 로컬 적용 결정 (2026-10-24)

아래는 D-041 전환 당시의 빈 운영 자료·read13 적용 기록입니다. 이후 실제 첫 자료 등록과 임시 P1/P2 쓰기·회수는 [D-042](#d-042--첫-업무-자료의-선정등록-범위와-최소-쓰기-권한-2026-10-24)를 따릅니다. 현재도 상시 권한/앱 도구는 read13이며 전환 당시 빈 자료 결과를 현재 자료0으로 해석하지 않습니다.

- 사용자 확인에 따라 S는 프로젝트 `data/`, U는 `jong-yu`, T는 `personal`, profile은 `all`(domain=null, viewpoint=null), 행동 권한은 read만으로 확정했습니다. 빈 원본이므로 예제 Alice/acme나 원격 시험 자료를 운영 지식으로 채택하지 않았습니다. 향후 권한·관점은 정책을 검토해 바꿀 수 있지만, ID 변경을 이유로 과거 actor·tenant·hash를 재작성하지 않습니다.
- 전용 `.local/tenancy/tenants/personal/`을 유일한 운영 자료 경로로 삼고 원래 `data/`는 오프라인 보존합니다. 부모·credentials·backups·records는 0700, 개인 파일·정책·기록은 0600입니다. 보존 사본과 비공개 전환 기록의 ID는 `20261023T153700Z`(UTC)이며 백업은 tenant로 등록하지 않습니다. 토큰 원문은 credential 파일에만 있고 설정·보고서에는 넣지 않습니다.
- 동일한 `llm_wiki` 등록을 먼저 비활성화하고, 정확한 실행 명령과 원본 파일의 열린 작업이 없음을 확인한 legacy stdio 프로세스 5개를 종료했습니다. 원본·백업·staging·최종 사본 대조 후 해당 항목만 개인 런처/read13으로 원자 교체했습니다. 다른 MCP·역할·전역 설정을 보존했습니다. 조사한 로컬 등록·프로세스·자동 시작 경로와 전환 후 재실행 여부는 비공개 기록에 남깁니다. 다른 기기의 모든 등록까지 조사했다고 확대하지 않습니다.
- 서버는 Codex가 세션별로 자동 실행하는 stdio입니다. 사용자가 별도 상주 서버를 시작할 필요가 없습니다. 저장된 설정을 사용하는 새 CLI와 SDK의 실제 인증·빈 조회·다른 tenant/profile 거부를 확인했습니다. 실제 문서·원장이 없어 대응 상세/prepare·대상 중심 통합 조회의 실자료 재사용은 `not_applicable_empty`입니다. 실자료를 발명하여 검증하지 않습니다.
- `connection_ready.cli/sdk/app=true`, `write_ready=false`, `remote_verified=false`로 구분합니다. 앱 자동 조작의 접근 거부 이후 사용자가 앱을 다시 열었고, 현재 대화에서 read13 노출과 `access_context`·문서 검색·개념 발견의 실제 3호출을 확인했습니다. 소속은 `jong-yu`/`personal`/`all`·read이며 빈 조회의 누락/잘림은 없었습니다. 보존 대조와 로컬 legacy 재실행 없음도 확인하여 **G6의 로컬 읽기 연결을 완료**합니다. 13개 전체 실행이나 실자료 판단 재사용으로 확대하지 않으며 G5·제품 UI·업무 쓰기는 미실행입니다. 이전 재연결 실패 기록은 PLAN에 보존합니다.
- 복귀 자료에는 비활성 유지보수 구성과 검증된 개인 인증 구성을 분리 보관했습니다. 오류 시 새 연결을 닫고 최신 tenant·원본·백업을 유지하며 legacy 구성의 재활성화나 옛 자료 덮어쓰기를 하지 않습니다. 실제 복구 실행과 쓰기 권한 추가는 이번 범위에 포함하지 않습니다.

#### 현재 확인 범위와 전환 단위

설계 시점 프로젝트 `.codex/config.toml`의 `llm_wiki`는 절대 Python 경로·`-B -m core.mcp_server --data-dir <project>/data --lock-timeout 5`의 legacy stdio였습니다. enabled_tools는 wiki_read/write/search·ontology_generate/query/connections 6개이고 개인 토큰 주입은 없었습니다. required=true, startup20초/tool30초, default_tools_approval_mode=writes는 실제 전환에서도 유지했습니다. 당시 CLI는 0.163.0-alpha.11.1, 실제 전환 검증은 0.163.0-alpha.11.2입니다. 파일 관찰만으로 모든 대화의 메모리 내 도구/원격 프로세스가 같다고 확정하지 않습니다.

설계 당시 메타데이터 조사에서 `data/`는 원문/히스토리 0개, graph/review 부재였습니다. `.local/remote-check/`에는 원문 2개·히스토리 4개와 잠금 파일만 있고 graph/review가 없습니다. 후자는 기존 원격 검증 자료로 보존하며 실사용 지식으로 자동 편입하지 않습니다. 당시 없던 `.local/tenancy`는 위 적용 단계에서 새로 만들었습니다. 다른 저장소의 부재나 존재하지 않는 운영 원장의 재사용까지 검증한 것은 아닙니다.

결정: **첫 전환은 현재 맥북의 로컬 개인 인증 stdio, 전용 tenant 루트, 한 개의 실사용 자료 공간**으로 한정합니다. 원격 HTTPS/Windows·OAuth/SSO·계정 UI는 별도 단계입니다. 같은 `llm_wiki` 연결 항목을 교체하며 두 번째 이름으로 기존 legacy와 함께 활성화하지 않습니다. 다른 MCP 연결·역할 설정을 포함한 config 전체를 템플릿으로 덮지 않습니다.

| 후속 적용 입력 | 확정할 내용과 중단 조건 |
| --- | --- |
| 자료 공간 S | 현재 `data/`를 기본 후보로 명시하되 실제 채택할 원본 절대 경로·소유자·보존 대상 범위를 운영자가 확정. 검증 자료/다른 저장소를 임의 합치지 않음 |
| tenant T·사용자 U | 사람이 실제 사용할 안정된 ID와 자료 귀속을 기록. 원장 tenant가 있으면 그 ID를 유지하며, 여러 tenant가 섞이거나 불명확하면 전환 중단 |
| 관점·권한 | 허용 profile ID·정확한 domain/viewpoint·기본값과 U의 행동 권한을 확정. 예제 Alice/acme를 실사용자/조직으로 채택하지 않음 |
| 경로·시작 방식 | 실제 대상·정책·자격 증명·백업 위치와 Codex 실행 표면(CLI/앱)을 확정. 쓰기 후 복귀 가능한 개인 인증 구성과 비밀 없는 점검 기록 위치도 함께 확정 |

자료/ID가 확정되지 않아도 이 설계는 검토할 수 있지만 실제 복사·토큰 발급·연결 교체는 수행하지 않습니다. 설계 요청 자체를 실행 허가나 업무 판단 승인으로 해석하지 않습니다.

#### 워크스페이스 자료 경로를 data로 전환 (2026-10-25)

사용자가 본문 폴더 이름은 `wiki/`로 유지하고 업무 자료를 `data/<workspaceId>/`에 모으는 방향을 확정했습니다. 현재 workspace ID `personal`을 그대로 사용해 `.local/tenancy/tenants/personal/`의 문서·온톨로지·전체 이력·검토 원장을 `data/personal/`로 이관했습니다. 중간 `tenants/` 폴더는 두지 않으며 인증/권한 정책과 개인 토큰·비서비스 보존/작업 기록은 `.local/tenancy/`에 둡니다. 상태는 **자료/설정 이관·새 인증 SDK 및 현재 앱 조회 검증 완료**이며 실제 결과는 PLAN에 기록합니다.

- 같은 ID·원문 바이트/revision·graph generation/hash·전체 history·검토/정책/대응 원장 체인과 권한을 보존합니다. 기존 자료를 재등록·재추출·재직렬화하지 않습니다. `wiki/`를 `documents/`로 바꾸거나 FastAPI/새 업로드 기능을 구현하지 않습니다.
- 이전 D-041의 최초 복사 절차는 원본 S를 기존 위치에 보존하는 방식이었습니다. 이번에는 사용자의 실제 저장 경로 변경 요청과 기존 warm 서버의 옛 경로 재노출 방지를 위해 **현재 원본의 전체 바이트·디렉터리를 비서비스 백업 위치로 보존 이동**하는 것으로 개정합니다. 자료 자체는 삭제하지 않습니다. 기존 `data/`의 빈 보존 구조도 별도 백업으로 유지하고 합치거나 덮어쓰지 않습니다.
- 정확히 확인한 기존 MCP 세션과 진행 중 자료 접근을 동결하고, 동일 기준의 사본·독립 inode·원문/graph/state 조회 결과를 대조한 뒤 새 경로를 공개합니다. 현재 등록의 `--tenant-root`만 프로젝트 `data/`로 변경하며 다른 설정·현재 읽기 권한·정책·토큰은 유지합니다. 정책/설정 기준이 바뀌면 최신 내용을 다시 검토하고 덮어쓰지 않습니다.
- `data/`를 코드 추적에서 제외하고 새 루트/워크스페이스700·자료600과 소유자를 유지합니다. 서명/전체 byte 대조와 mode/owner/link 검사를 함께 수행합니다. 기존 경로를 symlink로 남기거나 같은 자료를 legacy 서버에 중복 노출하지 않습니다.
- 새 설정의 인증 SDK와 현재 앱의 실제 문서/판단 조회를 구분해 검증합니다. `access_context` 성공만으로 새 자료 경로 연결을 완료했다고 표시하지 않습니다. warm 세션에 재연결이 필요하면 실제 완료 범위를 명시하며 앱 전체 재시작이나 권한 확대를 임의로 수행하지 않습니다.
- 실제 이관은 `workspace-data-20261025T062306Z`의 비공개 기록에 보존했습니다. 현재 원본7파일·639,380바이트·ready3/422주장과 모든 source/graph/history/state revision·graph generation·빈 디렉터리·mode/소유자를 보존했습니다. 기존 원본은 `.local/tenancy/backups/<전환ID>/source-tenants/personal/`, 빈 기존data 구조는 같은 백업의 `preexisting-data/`에 있습니다. 새 자료 사본은 보존본과 독립 inode이고 옛 서비스 경로는 남기지 않았습니다.
- 저장된 `llm_wiki`의 `--tenant-root` 한 값만 프로젝트 `data`로 바꾸고 13개 읽기 도구·정책·토큰·사용자/프로필은 유지했습니다. 새 설정의 실제 개인 런처로 문서3·온톨로지/현재 판단422·맥락·연결·개념 발견/선택 조회와 비허용 tenant/profile 거부를 전후 대조해 동일했습니다. 현재 앱 조회는 처음에 연결 오류와 사용자 작업 때문에 보류했으나, 이후 사용자 앱 재시작 후 이 채팅에서 인증·검색·문서3의 본문/기계 그래프/현재 검토를 실제 조회해 이관 당시 결과와 같음을 확인했습니다. **현재 앱 재연결 대기는 완료**했으며 추가 운영 설정이나 권한은 변경하지 않았습니다. 상세 검증 범위는 PLAN에 기록합니다.

#### 저장 배치와 기존 원장 재사용

아래 배치는 최초 개인 인증 전환 당시의 기록입니다. 현재 업무 자료 위치는 위 data 경로 전환을 따르며, 정책·토큰·비서비스 백업은 계속 자료 루트 밖에 둡니다.

배치는 프로젝트의 비공개 `.local/tenancy/` 아래 `tenants/<T>/`(실사용 데이터), `access.json`(정책), `credentials/<U>.token`(개인 비밀), `backups/<전환ID>/`와 `staging/<전환ID>/`(비서비스 보존/준비 자료)입니다. 정책·토큰·백업은 `tenant_root=.../tenants` 밖에 둡니다. 부모/비밀 디렉터리는 0700, 토큰/정책/비공개 점검 기록은 0600을 적용합니다. 이번 적용에서는 staging을 검증 후 최종 경로로 공개했으며 중복 staging 자료를 남기지 않았습니다. 기존 경로가 있으면 새 작업 소유 여부·용도부터 확인하고 덮어쓰지 않습니다.

현재 [접근 정책](../core/modules/access/policy.py)은 기존 실제 디렉터리 `tenant_root/<T>`만 허용하고 tenant 루트/대상 symlink와 alias를 거부합니다. `data/`를 새 ID에 연결하는 symlink/임의 경로 매핑은 사용하지 않습니다. 대안으로 `tenant_root=<project>, T=data`인 제자리 사용은 가능하지만 정책이 프로젝트 밖이어야 하고 자료 공간 ID도 data에 고정됩니다. 기본안은 이를 선택하지 않으며 제자리 사용을 요청받으면 별도로 경로·정책 경계를 확정합니다.

복사는 모든 writer가 멈춘 한 시점의 **데이터셋 전체 보존 복사**입니다. 원본 S를 삭제/이동하거나 기존 파일을 최신 본문만 재등록하지 않습니다. staging에서 검증 후 비어 있는 최종 T 경로로 공개하고 기존 T와 병합하지 않습니다. 기존 T가 있으면 같은 데이터라는 추정으로 덮지 않고 경로 선택부터 다시 확인합니다.

| 자료 | 복사·백업 불변식 |
| --- | --- |
| `wiki/` | 문서 상대 경로·전체 파일 바이트 유지. 줄바꿈/Unicode/인용 위치를 변환하지 않음 |
| `_history/` | 모든 문서의 전체 이전 버전·디렉터리·파일명을 보존. 최신 파일만 복사하거나 이력을 재명명/정리하지 않음 |
| `_ontology/` | 기존 raw JSON·generation_id·source revision을 그대로 복사. 재생성/스키마 숫자 변경/JSON 재직렬화로 이관하지 않음 |
| `_reviews/` | 문서별 v1/v2 검토/정책과 `correspondences/` 하위 전체, ID·이벤트 순서·before/after·hash chain·tenant·actor·시각·원래 판단 출처 보존 |
| 잠금·기타 파일 | 원본 `.storage.lock`을 삭제/교체하지 않음. 대상 잠금은 writer 종료 후 독립 inode로 생성하며 lock bytes를 지식 revision으로 취급하지 않음. 알 수 없는 파일/임시 파일은 자동 삭제하지 않고 별도 목록과 보존 사유를 기록 |

파일 집합·유형·상대 경로·크기·SHA-256과 필요한 빈 디렉터리를 보존 manifest로 비교합니다. 원본/백업/대상은 독립 regular 파일이며 symlink·source와 같은 inode의 hardlink 복사는 금지합니다. OS의 독립 쓰기를 보장하는 복사만 사용합니다. 백업은 tenant로 등록/서비스하지 않습니다. 실제 민감 경로/파일명·내용을 포함한 manifest는 소유자 전용 점검 자료에 두고 공개 보고에는 개수/일치 여부만 적습니다. 정책/설정 사본은 데이터 manifest와 분리하고 토큰 원문·실제 운영 URL을 문서·명령 인수·보고서에 넣지 않습니다.

특히 `_history/` 누락은 ABA 뒤 옛 승인을 현재로 되살릴 수 있으므로 복사 실패와 동일하게 차단합니다. 한 파일이라도 누락/손상/변경/한도 초과이면 원본·기존 이력을 유지한 채 중단하고 자동 초기화·자르기·재추출로 통과시키지 않습니다. 복사 manifest만 맞아도 reader의 전체 원장 검증·현재성/범위 판정은 별도로 필요합니다.

대응 reader는 ledger.tenant=현재 T 및 모든 event.actor.tenant=ledger.tenant를 검사합니다. 문서 reader가 옛 actor.tenant와 현재 T를 대조하지 않는 점을 이용해 혼합 원장을 허용하지 않습니다. 이관 전 문서/대응 이력의 tenant 분포·원래 귀속을 함께 대조하고 다르면 원장 필드나 hash를 다시 써서 맞추지 않습니다. 같은 T를 유지할 수 없으면 별도 이관 계약이 필요합니다. 과거 사용자 ID를 새 토큰 소유자로 바꾸거나 옛 판단을 새 사람의 승인으로 재표시하지 않습니다.

완전한 바이트 복사와 같은 상대 경로/히스토리 이름은 source/graph/review/history 구성요소 revision을 유지합니다. D-038 prepare/state는 접근정책·선택 관점·변경안·실제 의존 기준을 포함하고 D-040 snapshot은 tenant/정책·실제 선택/캡처 기준을 포함하므로 전환 전과 같다고 가정하지 않습니다. 평가 시각 자체는 이 두 기준에 직접 넣지 않고 D-040 view에 포함합니다. direct_confirmed의 시각/범위 평가가 실제 선택 자료를 바꾸면 snapshot도 간접적으로 달라질 수 있습니다. 기존 정책의 domain/viewpoint·기간·한정어를 문자 그대로 유지해 상태를 다시 조회하며, 연결 전환만으로 pending/stale를 해소하거나 옛 판단을 다시 수용하지 않습니다. 새 세션은 최신 read/query/find/prepare부터 시작합니다.

#### 자격 증명과 Codex 설정 계약

개인 토큰은 서버용 고엔트로피 URL-safe 32–256자이며 사용자별로 분리합니다. 정책에는 hash만 기록하고 ChatGPT 로그인이나 legacy 공유 토큰을 대신 사용하지 않습니다. 사용자·소속·권한·프로필은 서버 정책이 정하며 client allowlist와 쓰기 확인은 별도입니다.

Codex의 stdio `env_vars`는 상위 환경의 허용 변수를 전달하며, HTTP의 `bearer_token_env_var`와 용도가 다릅니다. 프로젝트 설정의 `enabled_tools/disabled_tools`, `required`와 `writes` 확인 정책을 사용할 수 있습니다. 설정 문법은 [공식 MCP 안내](https://learn.chatgpt.com/docs/extend/mcp)와 [공식 설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference)를 실제 열람하고 현재 CLI/기존 검증 코드와 대조했습니다. GUI 앱이 터미널의 환경을 자동 상속한다고 가정하지 않습니다.

기본 실행안은 **보호된 토큰 파일을 읽어 exec하는 전용 stdio 런처**입니다. 서버 자체의 인자는 유지하고 [개인 런처](../core/personal_launcher.py)에 `--token-file`을 구현했습니다. 위 실제 적용 단계에서 새 CLI와 재시작한 앱 대화의 읽기 연결을 검증했습니다. 런처는 고정된 개인 파일의 regular/non-symlink·소유/권한·형식/크기를 확인하고 토큰을 `LLM_WIKI_PERSONAL_TOKEN` 환경에만 넣은 뒤, 프로젝트 절대 `.venv/bin/python`으로 `-B -m core.mcp_server --access-config <정책> --tenant-root <루트> --token-env LLM_WIKI_PERSONAL_TOKEN --lock-timeout 5`를 exec합니다. 원문 토큰을 argv·TOML env 값·stdout·shell trace·에러에 출력하지 않습니다. 실패하면 시작을 거부하며 legacy 변수/모드로 fallback하지 않습니다. 로컬 관리자/같은 계정 프로세스까지 비밀을 격리한다고 과장하지 않습니다.

CLI의 격리 검증에는 상위 프로세스가 같은 변수에 토큰을 주입하고 `env_vars=["LLM_WIKI_PERSONAL_TOKEN"]`로 직접 Python을 실행하는 경로도 사용할 수 있습니다. 이 대안과 파일 런처를 동시에 불명확하게 설정하지 않습니다. 환경 이름은 `--token-env`와 같아야 하며 TOML 문자열에서 `$(cat ...)`가 실행된다고 기대하지 않습니다. 비밀 전달이 확인되지 않으면 앱/CLI 연결은 미검증으로 남깁니다.

| `llm_wiki` 항목의 후속 변경 | 적용 계약 |
| --- | --- |
| command/args/cwd | 검증된 런처 또는 검증된 환경 주입 Python, 프로젝트 절대 cwd. `--access-config/--tenant-root`를 함께 사용하고 `--data-dir` 제거 |
| 인증 | 개인 토큰만 지정 변수에 전달. HTTP bearer/OAuth 설정을 stdio 토큰 주입으로 오해하지 않음 |
| 노출 도구 | 첫 실제 연결은 아래 조회 13개 allowlist. 변경 권한/도구는 별도 단계에서 필요한 것만 추가하며 wildcard/전체 자동 허용하지 않음 |
| 확인·시간 | required=true·startup20초/tool30초·writes를 시작 기준으로 유지. 짧은 응답 시간 때문에 성공 저장을 재시도하지 않고 필요하면 격리 실측 근거로 tool timeout만 조정 |
| 기존 항목 | 전역/관리 설정·다른 project 항목·disabled_tools·per-tool override까지 효과를 점검. 다른 MCP/역할/권한 정책을 통째 덮지 않음 |

stdio 토큰은 시작 시 프로세스에 고정되므로 교체에는 새 MCP 프로세스와 세션이 필요합니다. 소속·권한·profile·토큰 hash 회수는 정책의 원자적 교체 후 다음 dispatch에 반영되지만 이미 승인된 실행 중 저장을 취소하지 않습니다. 회전 시 구 토큰을 다시 살리는 정책 롤백을 하지 않으며 현재 회수 상태를 보존합니다. `codex mcp login`은 이 정적 개인 토큰 PoC의 발급/로그인 수단으로 사용하지 않습니다.

#### 도구 노출과 행동 권한

현재 tenant 서버의 정적 목록은 24개입니다. 첫 단계는 `access_context`와 read 12개를 client allowlist에 지정하고 서버 정책도 read만 허용합니다. 도구 목록에 보이는 것과 호출 권한이 있는 것은 다릅니다. 다음 변경 11개는 필요한 역할을 운영자가 확정한 뒤 추가합니다. 다섯 행동 권한을 모두 부여해야 하는 경우에도 그 배정을 실제 사용자별로 기록하며 자동 기본 권한으로 삼지 않습니다.

| 서버 권한 | 도구 |
| --- | --- |
| 인증된 자기 소속 조회 | `access_context` |
| read | `wiki_read`, `wiki_search`, `ontology_query`, `ontology_connections`, `ontology_context`, `ontology_impact`, `ontology_review_query`, `ontology_correspondence_query`, `ontology_correspondence_prepare`, `ontology_correspondence_find`, `ontology_concept_find`, `ontology_concept_query` |
| read + write | `wiki_write` |
| read + ontology_write | `ontology_generate`, `ontology_correspondence_propose` |
| read + ontology_review | `ontology_review`, `ontology_review_undo`, `ontology_correspondence_review`, `ontology_correspondence_review_undo` |
| read + ontology_policy | `ontology_policy`, `ontology_policy_undo`, `ontology_correspondence_policy`, `ontology_correspondence_policy_undo` |

허용 profile은 조회/정책의 정확한 맥락이며 read 경계가 아닙니다. 기존 null·업무 문자열·현업/개발자 관점을 임의 통합하지 않습니다. 서버 read 권한은 같은 tenant 전체이므로 문서별 비밀 분리가 필요하면 현재 profile로 해결하지 않습니다. `writes` 확인이나 토큰 사용은 사람이 판단 내용을 직접 승인했다는 증명이 아니며 실제 요청한 업무 결정만 기록합니다.

#### 전환 순서와 legacy 중복 노출 차단

원본 경로가 다른 복제본도 같은 논리적 자료 공간으로 관리합니다. client에서 도구를 숨기거나 같은 저장 잠금을 쓴다는 이유로 legacy 노출이 차단됐다고 판정하지 않습니다. 원본·대상·보존 복제본에 무인증/공유 토큰 legacy로 접근할 수 있는 경로가 없어야 합니다. 무관한 별도 검증 저장소는 전환 원본에 합치거나 임의 종료하지 않습니다.

| 단계 | 수행/통과 조건 | 실패 시 상태 |
| --- | --- | --- |
| G0 운영 입력·현황 고정 | S/T/U/권한/profile/비밀 경로·복귀 대상을 확정. 프로젝트/전역/앱/IDE/CLI/원격의 등록·실행 프로세스·재시작/자동 시작 경로와 각 real root를 비밀 없이 분류 | 확정 전 실제 준비/전환하지 않음 |
| G1 격리 예행 검증 | 새 임시 사용자·tenant·원장으로 PLAN의 A/격리 항목과 설정 예행만 수행. 실제 토큰/자료를 사용하지 않고 자동 승인 override와 사람 확인을 분리. 실제 B/C 확인은 G4/G5에서 수행 | 기존 연결 그대로, candidate는 폐쇄 |
| G2 원본 동결·구 노출 종료 | 모든 사용자가 저장을 마치고 진행 중 요청의 결과를 확인. 등록된 정확한 legacy 세션/서버/해당 터널·재실행 경로를 종료/비활성화하고 완전히 종료됐는지 확인. PID 파일만 믿거나 광범위 프로세스 종료를 하지 않음 | 미확인 프로세스/저장 결과가 있으면 복사·새 실자료 연결 중단 |
| G3 보존·복사·검증 | G2 유지 아래 원본 전체 백업·staging 복사·manifest/reader/tenant/참조 검사 후 T 공개. 원본은 보존하되 서비스하지 않고 T를 유일한 쓰기/조회 기준으로 기록 | source·backup·candidate 모두 보존, 어느 쪽도 자동 노출하지 않음 |
| G4 실제 read 연결 | read13·서버 read-only로 단일 llm_wiki 교체. 새 세션의 access_context와 실제 access/도구 목록, 원문/판단/대응/통합 조회를 확인. 실제 자료에는 쓰지 않음 | 오류면 연결을 닫고 유지보수. legacy/다른 저장소로 응답하지 않음 |
| G5 변경 기능 준비 | 격리 검증의 권한·CAS·승인·되돌림을 통과한 필요한 변경 도구/권한만 추가. 실제 업무 쓰기는 별도의 구체 요청으로 수행하고 첫 변경 시점/영수증을 보존 | 변경 시도/응답 유실은 쓰기 가능 상태로 취급, 옛 데이터 복원 금지 |
| G6 완료·운영 인계 | 새 CLI와 실제 사용할 앱의 토큰 주입·소속·도구 가용성·단일 서비스 경로·보존/복귀 자료를 확인. 이후 세션도 최신 scope/read/prepare부터 시작 | 미검증 표면은 완료로 묶지 않음 |

설정 파일은 최신 내용을 다시 읽고 예상 기준 hash와 대조한 뒤 해당 llm_wiki 부분만 원자적으로 교체합니다. 정책/클라이언트 설정/프로세스/데이터 공개를 하나의 원자 거래라고 주장하지 않습니다. 바뀐 설정을 덮거나 버전값만 새로 넣어 강행하지 않고 그 변경을 검토해 다시 준비합니다. 기존 stdio 프로세스·열린 대화의 도구 캐시와 다른 클라이언트는 설정 교체만으로 종료되지 않으므로 G2/G4를 건너뛰지 않습니다. 실제 적용 중에는 활성 도구를 스스로 끊는 세션에서 계속 쓰지 않고 별도 관리 경로와 재시작 순서를 준비합니다.

초기 범위에 HTTP/터널은 추가하지 않습니다. 이후 원격 사용을 요청받으면 같은 개인 정책·개별 Bearer·loopback/Host/Origin/요청 상한을 유지한 별도 경로로 검증합니다. 기존 공유 토큰 HTTP를 동일 자료에 남기는 방식으로 원격 기능을 유지하지 않습니다. 현재 모든 원격 노출이 종료됐다고 이번 문서 조사로 보고하지 않습니다.

#### 준비 도구의 구현 경계 (2026-10-24)

- [런처](../core/personal_launcher.py)는 POSIX의 no-follow directory/file descriptor로 개인 토큰·정책을 검사합니다. current UID·일반 파일·단일 link·0600와 직접 부모0700, 모든 부모의 symlink/쓰기 권한·bounded read를 확인하고 기존 정책 인증을 재사용합니다. stdio/env/프로젝트 Python을 고정하고 기존 LLM_WIKI/PYTHON 변수의 주입을 제거합니다. 인수 축약과 legacy fallback을 거부하며 비밀 없는 고정 오류만 stderr로 냅니다. 토큰 발급·클라이언트 등록·운영 정책 편집은 수행하지 않습니다.
- [전환 점검](../tools/transition_check.py)은 명시 source/target의 전체 파일·빈 디렉터리를 제한된 메모리로 캡처하고, frozen store에서 기존 graph/review/correspondence reader를 재사용합니다. 파일 시스템 디렉터리/lock 생성 없이 보존 manifest·independent inode·tenant/actor·전체 원장·history/ABA·검사 중 변경을 확인합니다. source/target 중첩·symlink·비일반 파일·손상·누락·한도는 차단합니다. 이중 관측은 writer 동결을 대신하지 않습니다.
- `--policy/--tenant-root`는 명시 대상 귀속과 기존 parser 검증, `--config`는 구문과 기준 hash의 검사입니다. baseline은 비교용 데이터이며 그 경로를 실행/재탐색하지 않습니다. source-only 기준 뒤 명시 target 추가는 가능하지만 기준에 있던 대상/정책/설정을 생략·교체할 수 없습니다. 새 report만 0600·no-clobber로 공개하며 성공 후 임시 정리 경고를 저장 실패와 구분합니다. 공개 요약에는 개수/상태/코드만, 경로·manifest·분포는 비공개 report에 둡니다.
- `inspection_passed`는 이 파일 점검의 통과이며 `ready_for_cutover=false`와 수동 미검증 gates를 유지합니다. `write_state`는 운영자의 선언으로 표시하고 실제 쓰기 유무를 입증하지 않습니다. 모든 경우 옛 복사본 덮어쓰기·legacy/옛 권한으로 복귀를 금지합니다. 서비스 종료·복사·설정 적용·롤백 실행기는 추가하지 않았습니다.
- [새 CLI 검증](../tools/verify_transition.py)은 기존 합성 fixture·저장 API로 준비한 임시 데이터만 사용합니다. personal launcher·read13 allowlist·read 권한으로 새 세션을 만들고 실제 MCP 호출/대상/출처/버전/범위와 전후 바이트를 검사합니다. 원문 검색·명시 대응에서 발견한 보조 근거 조회는 허용하되 주 대상의 최신 전문가 판단 조회를 대체하지 못합니다. 모델의 성공 자기보고로 통과하지 않으며 실제 원문 의미 평가·사람 승인·GUI/원격 전환으로 확대하지 않습니다.

#### 검증 증거와 되돌림

검증은 (A) 합성 임시 자료의 전체 기능/실패/새 CLI, (B) 실제 T의 read-only 연결·보존, (C) 사용자가 실제 요청한 업무 변경을 구분합니다. 기존 [CLI 검증](../tools/verify_codex.py)의 expert-policy 경로는 임시 tenant/env 전달/새 세션의 기반일 뿐 D-038·D-040 실제 CLI 전체나 수동 확인을 이미 검증하지 않습니다. legacy fixture의 per-tool approval_mode=approve는 수동 쓰기 승인 시험에 재사용하지 않습니다. `verify_codex --transition`은 보호된 개인 파일 런처를 통한 새 CLI의 read 흐름과 출처/ref·버전을 검사하며, 변경 CAS/원장/히스토리 실패 경계는 격리 회귀로 검증합니다. 실제 GUI·수동 확인·운영 권한 검증은 별도로 남깁니다.

실제 S/T가 비어 있으면 존재하지 않는 대응/전문가 판단을 만들어 실자료 재사용을 증명하지 않습니다. 인증·도구·빈 탐색 결과와 읽기 전용 보존은 확인하되 `data_reuse_verified=not_applicable_empty`로 남깁니다. 실제 판단이 있으면 전체 원장 검증과 대표 현재/보류/다른 범위/undo 출처를 원본과 대조합니다. `connection_ready`, `write_ready`, `data_reuse_verified`, `remote_verified`를 각각 기록하고 임시 자료 통과를 실제 자료·사람 승인·원격 완료로 합치지 않습니다.

비공개 전환 기록에는 상태 G0–G6, source/target·설정 기준 hash, 보존 manifest/검증 결과, 읽기만 했는지, 첫 변경 시도/영수증/event ID와 확인 불가 여부, 종료한 노출/복귀 경로를 남깁니다. 토큰/원문/실제 URL은 제외합니다. 기록 저장 실패도 성공한 업무 쓰기를 재전송할 근거가 아니며 해당 T/ID를 조회해 상태를 확인합니다.

| 되돌림 시점 | 허용 절차 |
| --- | --- |
| G2 전 | candidate 준비를 중단하고 원래 서비스는 당시 허용 상태 그대로 둠. 실패한 인증을 다른 경로로 우회한 성공으로 기록하지 않음 |
| G2 이후, 실사용 변경 없음 확인 | 새 연결을 닫고 source/target/backup·설정 사본을 보존. 기본 복귀는 유지보수 정지 또는 검증된 개인 인증 구성 재적용. legacy 설정 사본은 오프라인 보관하며 자동 재활성화하지 않음 |
| 실사용 쓰기 성공 또는 확인 불가 | 모든 writer를 멈추고 전환 후 전체 데이터도 추가 보존. 유일한 최신 T를 유지한 채 수정된/검증된 개인 인증 연결로 복귀하거나 정지 상태 수동 복구. 옛 S/backup을 덮어 복원하거나 옛 복제본을 조회 정답으로 사용하지 않음 |
| 개별 내용·판단 취소 | 연결 롤백과 분리. 원문은 최신 read/CAS와 WikiStore.save로 새 전체 이력을 추가하고, 문서/대응 판단은 최신 state/prepare와 각각의 undo 역이벤트 사용. 다른 사건을 건너뛰거나 과거 actor/hash를 수정하지 않음 |
| 정책/비밀 오류·권한 회수 | access_denied/access_unavailable·startup 실패로 닫힘 유지. 현재 회수/소속 결정을 보존하며 과거 정책·공유 토큰·무인증/다른 tenant로 우회하지 않음 |

timeout·응답 유실·저장 후 cleanup 경고는 무조건 쓰기 실패가 아닙니다. 새 T의 문서/알려진 correspondence ID/event를 먼저 조회하고 성공 저장을 반복하지 않습니다. 잠금 시간 초과 storage_busy만 같은 기준으로 나중에 재시도하며 conflict는 최신 내용/판단을 대조합니다. 되돌림 중 검증 실패도 원본·전환 후 원장·백업을 지우는 정리로 해결하지 않습니다.

### D-042 — 첫 업무 자료의 선정·등록 범위와 최소 쓰기 권한 (2026-10-24)

상태: **N1 표 원문3문서 실제 등록·AI 부분 추출·현재 앱 읽기 조회·분리 세션 의미 평가 완료 / 첫7대상·후속3기준 검증 정정안 운영 반영·조회·권한 회수 완료 / 우선9대상 검증 정정안 운영 반영·조회·권한 회수 완료 / C02 검증 정정안 운영 반영·조회·권한 회수 완료 / C01 A 검증안 운영 반영·조회·권한 회수 완료 / C01 앵커 끝점 격리 구현·의미/호환 검증 완료·운영 미반영 / 운영 독립 표현·업무 결론 미결·357미검토·read13 유지**입니다. 자료 종류 안내 뒤 사용자가 프로젝트에 Numbers 요구사항 원본을 제공했습니다. 원본을 고정하고 문서명·판본·후보 경로·표 전사 본문을 비공개 준비안에 구체화했습니다. D-041의 `jong-yu`/`personal`/`all`·read13은 유지하며 원문·전체 이력·검토/전문가 판단·대응 원장의 기존 계약을 재사용합니다. 업무 본문을 공개 결정 기록에 복사하거나 원문에 적힌 권한/수용을 이 시스템의 권한·승인으로 적용하지 않습니다.

#### 제공 원본 N1의 구체화 (2026-10-24)

비공개 준비 기록의 ID는 `source-prep-20261024T024339Z`입니다. 해당 기록의 `candidate-plan.md`는 검토안, `source-manifest.json`은 실제 원본 경로·제목·판본/작성일의 원본 셀과 hash, `source-cells.json`은 셀/본문의 대응입니다. `source.numbers`는 사용자가 준 원본 바이트의 고정 사본이며 운영 tenant나 백업 서비스에 등록하지 않습니다. 원래 사용자 파일도 그대로 보존합니다. 이 기록은 등록 준비 자료이며 `_reviews`의 판단 원장이 아닙니다.

| 항목 | 원본 확인·본문 준비 결과 |
| --- | --- |
| 원본 | 사용자 제공 Numbers 파일1개, 941,254바이트. 기존 파일명을 Unicode 정규화로 재작성하거나 원본을 저장/내보내기하지 않음 |
| 판본 | 파일명뿐 아니라 내부 `K4=v0.3`과 `K3=2026. 10. 21.`을 확인. 작성일과 최종 승인/현재 적용 여부를 구분 |
| 제안 문서명·경로 | 실제 제목은 비공개 manifest에 보존. 범위가 육상 운영의 시스템 요약/포탈/MLOps를 포함하므로 상대 경로 `business/land-operations/requirements.md`를 제안. 실제 read 결과는 not_found이며 후속 생성 전 다시 확인 |
| 준비 본문 | `prepared-source.md`, UTF-8 **191,842바이트**, SHA-256 `ad8883bdb6a4c960da5063d63719e05b012ddd5f3469e2be830af1f1b45a4539`. 문서1 MiB 한도 이내이며 변환 전 원본 hash와 구분 |
| 선택 범위 | 제공 시트1개·표1개의 **A2:O115**, 요구사항108개와 머리말/표제의 값 셀1,420개. 원래1000행×26열에서 값 없는 바깥 영역만 제외. 범위 안 빈 셀·병합 범위·원본 좌표는 JSON에 보존 |
| 원문 값 보존 | 표제 없는 A열21개 표시를 포함하고 상세 내용·처리 구분·상태·진행 이력·결론·비고를 모두 유지. 수용·결정 행만 필터링하거나 결론으로 과거 이력을 덮지 않음 |
| 첫 질문 | 로그인 계정별 작업공간·tenant/역할 분리의 요구사항과 미확정 사항을 확인하는 질문으로 한정. 정의/정정/예외가 여러 행에 흩어져 있어 표는 전체를 한 원문 후보로 보존 |
| 그림·외부 참조 | 삽입 도식과 이미지3개를 별도 보존하고 확인한 도식은 셀 원문과 구분해 전사. 정확한 삽입 위치/표와의 대응, 미제공 다른 시트/문서·후속 회의 결과는 미확인 |

Numbers에서 읽은 셀 문자열은 그대로 두고 숫자·날짜의 표시값과 원래 값/유형을 함께 기록했습니다. 원본 행·셀마다 코드 블록을 부여하고 각 값의 본문 바이트 위치/hash를 대조했습니다. 이는 **선택한 표 셀의 텍스트 전사**이며 서식·색·취소선·전체 그림 배치까지 보존한 완전한 Numbers 변환이라고 표시하지 않습니다. 원문의 수용/결정·확인중/미논의·가정·이관 등은 출처 문서의 값이며 인증된 검토/전문가 Action log나 구현 완료가 아닙니다.

원문과 후보 본문은 tenant 밖의 소유자 전용 준비 기록에 두며 파일0600·폴더0700을 유지합니다. 공개 공식 문서·합성 사례·프로젝트 요구사항을 대신 채택하지 않았습니다. 이 준비 단계는 원본 확인·변환 준비에 한정했습니다. 이후 승인된 P1/P2 실행은 다음 기록을 따르며 정책 판단·UI 변경은 포함하지 않습니다. 전체표가 크기 한도에 맞는 것과 이후 전체 그래프가 개체/관계/속성 수·JSON 한도 안에서 모든 의미를 보존하는지는 별도로 검증해야 합니다.

#### N1 실제 등록·AI 부분 추출·읽기 조회 (2026-10-24)

사용자가 실제 등록·AI 추출·조회를 요청해 P1과 P2를 실행했습니다. 비공개 실행 기록은 `register-20261024T030714Z`이며 원본/표 전사 준비 기록은 그대로 보존합니다. 위 준비 단계의 단일 후보 `requirements.md`는 생성하지 않았습니다. 실제 등록은 원문이 구분한 **시스템 요약·포탈·MLOps**의 세 문서로 정했습니다. 한 문서의 개체100/관계200/속성200 제한에 맞추려 요구사항 행을 생략하지 않기 위한 선택입니다. 최대3문서 범위를 적용했고 머리말만 반복하며 요구사항108행은 각각 한 문서에 보존했습니다. 그와 별개로 그래프 자체의 의미 표현은 아래와 같이 부분 결과입니다.

| 실제 신규 문서 | 원본 요구사항 행·건수 | 등록 본문 UTF-8 | AI 개체 / 관계 / 속성 / 후보 |
| --- | --- | --- | --- |
| `business/land-operations/overview.md` | 8–19, 12건 | 27,120바이트 | 34 / 9 / 33 / 1 |
| `business/land-operations/portal-requirements.md` | 20–95, 76건 | 151,399바이트 | 100 / 40 / 196 / 3 |
| `business/land-operations/mlops-requirements.md` | 96–115, 20건 | 15,557바이트 | 38 / 9 / 48 / 1 |

각 목적 경로의 실제 `wiki_read=not_found`를 확인했습니다. P1은 `read+write`와 read13+`wiki_write`만 적용하고, 명시적 null CAS로 문서별 신규 저장→직후 읽기 대조를 수행했습니다. 세 문서 모두 `changed=true`, `history_path=null`, 정리 경고 없음이며 본문과 반환 revision이 준비본의 SHA-256과 일치했습니다. 초기 생성이므로 수정 전 전체 버전은 생기지 않았으며 기존 이력의 삭제/정리로 해석하지 않습니다. P1의 write와 도구를 회수한 뒤 P2를 수행했습니다.

P2는 `read+ontology_write`와 read13+`ontology_generate`만 적용했습니다. 실제 `wiki_read`의 전체 본문·revision과 최신 `ontology_review_query.state_revision`에서 AI 추출을 작성하고 기존 v3 저장 검증을 격리 자료로 통과한 뒤 MCP로 저장했습니다. 그래프3개가 최신 원문과 일치하고 `needs_reextraction=false`이며, 다시 ontology_write와 해당 도구를 회수했습니다. write와 ontology_write를 동시에 부여하거나 검토·전문가 정책 권한을 부여하지 않았습니다. 기존 저장/검토/대응 모듈을 재사용하고 새 사용자 승인·정책·대응 이벤트는 만들지 않았습니다.

실제 쓰기는 저장된 개인 인증 런처의 command/args/cwd를 사용하는 새 stdio SDK 클라이언트에서 수행했습니다. 클라이언트는 저장된 allowlist를 각 호출에 적용하고 서버는 매 호출 최신 권한을 확인했습니다. 서버 `tools/list=24`와 클라이언트 허용14개는 구분하며 현재 앱의 도구 목록을 쓰기14개로 재연결했다고 주장하지 않습니다. **현재 앱의 읽기13개에서 access_context·검색·검토 조회·개념 find/query는 실제 성공**했습니다. 종료 후 정책/config의 원래 바이트 hash와 모드, `jong-yu/personal/all`·read13이 복귀했습니다. 무인증 legacy 노출이나 다른 저장소 우회는 추가하지 않았습니다.

원본의 전체 표 셀1,420개·A열 표시21개·처리/상태/이력/결론/비고는 원문으로 유지합니다. 그래프는 개체172·관계58·속성277·후보5의 **부분 AI 추출**이며, 전체 진행 이력·복합 논리·수치·미제공 참조를 모두 표현했다고 표시하지 않습니다. 각 원본108행의 대응·partial·생략 한계는 `extract/*-coverage.json`에 보존합니다. 원문의 수용/결정도 우리 시스템의 전문가 승인이 아닙니다. 검토 조회의 주장340개는 모두 `unreviewed`, `needs_review=true`이고 policies/history/pending_history는0이며 검토 원장 파일이 없는 초기 상태를 유지합니다.

조회는 literal 검색이라는 기존 계약을 따릅니다. '작업공간'은0건이었고 부재 사실로 해석하지 않았습니다. 실제 원문의 '워크스페이스' 검색은3문서 스캔 중2문서·skipped0·truncated=false입니다. 개념 find는100건 제한으로 `complete=false/truncated=true`와 result_limit을 보존했고, 반환된 버전 있는 workspace 대상을 명시 선택했습니다. 세 문서를 지정한 query는 `expansion=none`, `complete=true/truncated=false/skipped=[]`, 최신 source/graph/state와 전체 원문·그래프·미검토 주장·unclassified340개를 반환했습니다. 이는 선택 범위의 포착 완료이며 의미 추출의 완전성이나 tenant 전체 지식의 완전성을 뜻하지 않습니다. 같은 이름의 문서 간 개체를 병합하거나 대응을 자동 수용하지 않았습니다.

등록 당시 독립 의미 평가는 미실행이었습니다. 최초 분리 검증 세션은 자동 주입된 프로젝트 규칙 노출을 보고하고 질문 고정 전에 중단했습니다. 지침·도구·이전 대화 없는 별도 세션으로의 재시작은 업무 원문을 별도 Codex 세션에 전송할 목적지 승인이 없다는 사유로 **자동 승인 심사가 거부**했습니다. 해당 등록 실행에서는 그 전송을 재시도하지 않았으며, 이미 승인된 현재 대화의 AI가 원문을 검토하고 명시적 추출 매핑을 작성했습니다. 이후 사용자의 명시적 추가 승인으로 수행한 독립 평가 결과는 아래 별도 기록합니다. 구조·인용 검사와 자체 원문 대조를 독립 의미 정확도 승인으로 합산하지 않습니다. 그림 배치·미제공 외부 참조도 여전히 미확인입니다.

제품 코드·UI는 이번 작업에서 편집하지 않았습니다. 원래 사용자 파일·준비본·기존 원문/전체 이력/문서·대응 원장·원격 시험 자료·백업을 보존합니다. 이후 중요한 미검토 주장 검토나 더 충실한 그래프 추출은 별도 작업이며 이 단계에서 UI 구현·자동 정책 승인을 시작하지 않습니다. 실제 검증 수·보존 결과는 [PLAN](PLAN.md)의 실행 기록을 따릅니다.

#### N1 추가 승인 후 원문 분리 의미 평가 (2026-10-24)

사용자가 요구사항정의서를 별도 Codex 세션으로 전달하는 것을 명시적으로 승인해, 위 등록 시점에 중단됐던 원문 분리 평가를 수행했습니다. 비공개 실행 기록은 `semantic-audit-20261024T034423Z`이며 기존 등록·준비 기록은 수정하지 않았습니다. 평가만 수행했으며 운영 원문·그래프·원장·권한·연결 설정·UI에는 쓰지 않았습니다.

기존 인증 런처의 읽기 도구로 세 문서의 전체 원문·실제 revision·검토 반영 그래프를 고정했습니다. 새 원본 보유 검증 세션 세 개가 제출을 보기 전에 원문 인용과 확인 질문48개를 고정했습니다. 그 뒤 별도 생성 세션 두 개에는 전체 원문·공개 스키마·고정 추출 지침만 제공했습니다. 기존 등록 제출과 새 제출을 익명으로 섞고, 각 원본 보유 검증 세션을 재개해 모든 개체·관계·속성·후보와 고정 질문을 대조했습니다. 후보의 설명/질문과 생성자의 생략 해설만 가리고 주장·인용·한정어·관점·식별자·출처는 그대로 유지했습니다. 생성자에게 평가 질문·기존 출력·기대 정답을 전달하거나 중간 판정을 다른 평가자에게 보내지 않았습니다.

프로젝트 지침 자동 주입을 피하려고 기존 D-029의 별도 CLI 방식을 재사용했습니다. 빈 작업 폴더, 프로젝트 문서 자동 읽기0, 사용자 설정 무시, 도구·메모리·앱·플러그인·웹을 끈 세션에 입력을 표준 입력으로 전달하고 파일은0600·폴더는0700으로 보존했습니다. 모델·추론 설정은 기존 사용자 설정을 따랐습니다. 구조/인용 검사와 개별 주장 의미, 핵심 누락·스키마 한계를 각각 기록했고 오류가 있는 제출도 수정하지 않았습니다. 판정이 모두 고정된 뒤 원시 출력·투영·질문·프롬프트 hash와 인용·평가 누락·기존 데이터 보존을 확인했습니다.

세 문서의 독립 AI 의미 평가를 완료했으나 기존 등록 추출에는 조건 손실·모호함·핵심 누락이 남았습니다. 새 추출도 구조/인용 오류와 의미 모순·누락이 있어 운영에 반영하지 않았습니다. 실제 수치·출처·보존 검사와 남은 문제는 [PLAN](PLAN.md)의 별도 실행 기록을 따릅니다. 같은 모델 계열의 분리 입력 세션이며 운영체제 권한 격리·외부 전문가 독립 심사·사람 승인·동일 조건 반복 일관성을 증명하지 않습니다. 그림 배치·미제공 외부 참조와 외부 규정의 실제 유효성도 이번 원문 충실성 평가에 포함하지 않습니다. 판정에 맞춘 프롬프트 조정·재추출·자동 승인은 실행하지 않았고 모든 운영 주장은 미검토로 유지합니다.

#### N1 평가 발견의 정정 범위와 검토 우선순위 (2026-10-24)

이번 요청은 **설계만** 수행합니다. 비공개 기록 `correction-scope-20261024T044335Z`의 `inventory.json`은 고정 평가와 현재 버전/검토 대상을 연결하고, `scope-plan.json`은 작업군·우선순위·첫 후속 범위를 관리합니다. 기존 평가의 원시 제출·질문·판정·점수와 등록 기록을 수정하지 않습니다. 이 목록은 검토 원장이나 전문가 판단이 아니며, 모든 운영 주장은 미검토·권한은 read13 그대로입니다. 실제 정정·추출·권한/연결 설정·UI·프롬프트 변경은 수행하지 않습니다.

운영 그래프의 문제 주장, 원문에 이미 있지만 빠진 의미, 미제공 근거/원문 내부 미결, 미배포 대조 제출의 결함을 구분합니다. 문제 주장·누락·질문은 서로 겹치는 평가 축이므로 합계를 독립 결함 수나 쓰기 횟수로 쓰지 않습니다. 각 대상은 문서·원문/그래프/검토/히스토리/상태 버전과 원문 인용·셀/줄 위치, 고정 판정으로 추적합니다. 동일 인용이 여러 셀에 있으면 모든 위치를 남기고 특정 셀이라고 임의 확정하지 않습니다. 배열 위치는 해당 제출 버전의 평가 참조이며 실제 수정 대상은 최신 `ontology_review_query`의 `claim_id`입니다.

검토 우선도는 **R0 → R1 → R2**로 정합니다. 이는 앞선 P1/P2 임시 권한 단계와 별개이며 실행 가능 순서나 쓰기 승인이 아닙니다. 작업군별 실제 대상·건수·완료 조건은 [PLAN의 정정 범위 기록](PLAN.md#d-042-n1-정정-범위와-검토-우선순위-설계-2026-10-24)에 둡니다.

| 우선도 | 먼저 확인할 의미 | 이유 |
| --- | --- | --- |
| R0 | 관리·정책 적용 범위, 책임·권한, 필요조건/조건부 부정, 검사·인증·보안·미결의 지위 | 오답이 과업·권한·허용 여부나 충족 판단을 바꿀 수 있음. 다대다 권한 매핑은 일반 끝점 작업군에서도 R0로 올림 |
| R1 | 문서 처리·회의 이력·소관의 양태, 핵심 과정/연동/끝점, 사업 제안과 인수 조건 | 현재 상태와 미래 계획의 혼동·기능 누락을 줄임. 부하·측정 구간·백분위·최대 크기는 단순 숫자 보강보다 우선해 함께 검토 |
| R2 | 원문에 적힌 디자인/목업 일정, 조건별 대안·동의 수준 | 미확정 일정·이의 없음을 확정·명시 동의로 바꾸지 않음. 제품 UI 수정 작업을 뜻하지 않음 |

정정 방향은 원문 기재를 충실히 표현하는 것입니다. 현재 미정·상충·회의 처리 사실을 모두 possible/hypothetical/planned로 바꾸지 않으며, 해당 기재와 앞으로 수행할 계획을 나눕니다. 반대로 문서의 수용·확정을 구현 완료나 이 시스템의 사람 승인으로 바꾸지 않습니다. 필요조건을 충분조건으로, 권한 미정리를 권한 확보로 바꾸지 않고 조건부 부정의 결론을 정확히 보존합니다. 범위 한정은 해당 절에만 적용하며 한 속성의 다른 사실에 무심코 전파하지 않습니다. 두 원출처의 상충은 양쪽 출처·범위·미결을 유지하고 외부 규정 진위나 업무 결론을 대신 결정하지 않습니다.

**미래 정정 경로와 한도.** 기존 관계/속성 한 개의 뜻을 같은 주장 한 개로 충실히 바로잡을 수 있으면 `ontology_review(action="edit")`를 검토합니다. 전체 replacement와 실제 연속 인용·한정어·관점·출처가 필요하며 현재 그래프의 기존 개체만 참조합니다. 하나를 여러 주장으로 나누거나 새 개체·독립 관계·속성을 추가하려면 최신 **전체 원문**에 근거한 `ontology_generate`가 필요합니다. 누락의 일부가 기존 주장의 조건 보강으로 해결되는지는 대상과 1:1 의미를 먼저 확인하며, 검토 API를 append로 사용하지 않습니다. 앞선 I04의 propose는 `ontology_correspondence_propose`라는 문서 간 대응 제안이며 문서 내부 누락 추가 도구가 아닙니다.

후보의 `accept/edit`는 유효 그래프에서 근거 관계로 승격하는 결정입니다. 모호 후보를 고친 채 미검토 후보로 유지하는 부분 수정 API는 없습니다. 현재 근거가 부족한 학습권한 후보는 유지·추가 근거 대기 대상으로 남기며, 이번 설계만으로 수용·보류·거절을 저장하지 않습니다. 원문에 없는 새 업무 판단을 `ontology_policy`로 넣어 누락 추출을 우회하지 않습니다.

포탈 그래프는 현재 **개체100/100·속성196/200**입니다. 누락 보강 전에 전체 의미와 한도를 함께 충족할 수 있는지 확인해야 합니다. 인용1000자·속성값500자와 evidence 내부의 한정어 조건도 적용합니다. 떨어진 셀을 이어 가짜 연속 인용을 만들거나 기존 지지 사실 삭제·원문 임의 분할·새 문서 추가·상한/스키마 변경으로 우회하지 않습니다. 충실한 표현이 안 되면 용량/표현/근거 문제를 구분해 보류하고 별도 범위 결정을 남깁니다. 미배포 새 제출은 저장 검증 실패와 의미 모순이 있어 운영 교체본으로 채택하지 않습니다.

**후속 실행을 요청받았을 때의 순서.** 우선 R0의 명시 대상 정정안을 격리 자료에서 작성하고 1:1 교정·새 주장/분리 필요·추가 근거 대기를 분류합니다. 같은 문서의 전체 생성이 예정되면 전체 생성안·용량·보존 검증을 먼저 하고, 실제 반영 이후 최신 대상에 명시적 검토를 기록하는 순서를 기본안으로 둡니다. 먼저 개별 검토를 쌓아 바로 pending으로 만드는 순서를 기본값으로 삼지 않습니다. 구체 범위의 일괄 정정 요청을 받으면 그 범위 안에서 진행하며 건마다 같은 실행 승인을 반복 요청하는 절차를 추가하지 않습니다. 원문의 실제 미결이나 근거 부족은 별도 확인 항목으로 남깁니다.

이번에는 쓰기 권한을 바꾸지 않습니다. 미래에 개별 검토를 실제 요청받으면 `read+ontology_review`, 전체 생성을 요청받으면 `read+ontology_write`를 각각 필요한 단계에서만 적용·회수하는 기존 절차를 재사용합니다. 원문 정정용 write·새 전문가 판단용 ontology_policy는 기본 부여하지 않습니다. 권한은 tenant 전체 행동 범위이며 문서 ACL·자동 TTL·클라이언트 도구 숨김을 서버 권한 축소로 과장하지 않습니다.

미래 저장 직전에는 원문·전체 그래프·기존 검토/정책·미결/이력을 다시 읽고 최신 복합 상태를 사용합니다. review는 현재 claim_id, undo는 해당 주장의 최신 event_id를 사용하며 둘 다 최신 expected_state_revision을 지정합니다. generate는 expected_revision과 최신 expected_state_revision을 함께 지정하는 설계입니다. 한 문서에서 첫 저장 후 상태가 바뀌므로 여러 항목에 처음 token을 반복 사용하지 않습니다. 충돌은 원문·그래프·원장·히스토리를 대조해 정정안을 재검토하며 버전값만 교체하지 않습니다. 성공 후 정리 경고·응답 미확정·후속 조회 실패 때문에 저장을 자동 재전송하지 않고 성공·실패·미시도·확인 불가를 구분합니다. 영향 조회의 부분 결과·범위·stale/pending도 유지합니다.

review undo는 같은 원문/그래프/히스토리 세대의 해당 주장 최신 이벤트를 **새 이벤트로** 되돌립니다. 그래프 전체 생성의 undo/자동 그래프 이력 MCP는 없습니다. 보존 제출을 복원 후보로 쓸 때도 최신 전체 원문과 복합 버전을 대조한 새 생성이 필요하며 옛 generation_id·승인을 이식하지 않습니다. `_reviews`·대응 원장·히스토리를 삭제하는 되돌림은 허용하지 않습니다. 세부 계약은 [D-028]·[D-031]을 재사용합니다.

완료 기준은 실제 값/관계/한정어에 필요한 뜻이 남는지와 기존 지지 사실 보존, 핵심 질문의 부분/누락 해소 여부를 각각 확인하는 것입니다. evidence에만 남은 뜻이나 구조 검사 통과를 의미 보존 완료로 합산하지 않습니다. 해소·추가 근거 대기·용량/표현 한계는 구분하며 보류를 해결로 계산하지 않습니다. 기존 N1 질문을 활용한 정정 검사는 개발 회귀이고, 프롬프트를 개선한 뒤 새 독립 정확도를 주장하려면 새 원문·새 세션이 필요합니다. 이번에는 정정/재생성/새 의미 채점/실제 전문가 승인을 실행하지 않았습니다.

#### N1 첫7대상 정정안의 격리 작성과 검증 (2026-10-24)

사용자가 앞서 명시한7대상의 정정안 작성·격리 검증을 요청했습니다. 최신 인증 읽기와 기존 평가/정정 계획을 입력으로 사용하고, 실제 운영 반영·권한 변경·UI는 실행하지 않았습니다. 기존 원문·전체 이력·검토/전문가 판단·대응 원장과 이전 실행/평가 기록은 보존합니다. 비공개 `correction-seven-20261024T050745Z`가 입력·전후 주장·버전·근거·초안 이력·중립 검토·격리 저장 영수증을 담당하며 결과 수치와 실패 기록은 [PLAN](PLAN.md#d-042-n1-첫7대상-정정안-작성격리-검증-2026-10-24)에 둡니다.

**정정 경로의 구분.** 요약 관계1개·포탈 관계2개·MLOps 인증 선행 관계1개는 기존 끝점을 유지한1:1 교정 후보입니다. 요약/포탈의 넓은 운영 데이터 속성2개와 MLOps 권한 필요조건 관계1개는 다른 사실 보존·조건부 결론·미정 상태를 독립 주장으로 남겨야 하므로 전체 생성 후보로 작성했습니다. 총4개1:1·3개분리/추가이며 review edit를 append API로 쓰지 않습니다. 운영 반영 순서와 최소 권한은 위 계약을 그대로 적용하며, 이번에는 어떤 권한도 추가하지 않았습니다.

**표현과 보존.** 관리 범위를 해당 절에만 적용하고 다른 데이터의 정본/목적지·협의 가능성을 분리했습니다. 통신 정책 집행과 일반 정책을 혼동하지 않고, 권한 필요조건과 미정리 때 성립 불가를 구분해 실제 관계/속성·조건에 남겼습니다. 조건부 부정은 부정 depends_on이나 충분조건 enables로 바꾸지 않고 텍스트 상태와 조건으로 표현했습니다. 이 문자열 조건은 실행 가능한 업무/권한 규칙이 아닙니다. 인증 선행조건을 실제 분할/인증 완료로 승격하지 않았습니다. 후보5개는 기존대로 미검토이며 가짜 전문가 판단·원문 인용을 만들지 않았습니다.

3문서의 기존 전체 배열에7대상 정정과 새 속성10개만 반영했고 비대상505항목은 그대로입니다. 전체 생성 입력이라는 것은 모든 배열을 제출한다는 뜻이며, 전체 원문의 모든 의미를 새로 추출/해결했다는 뜻은 아닙니다. 새 개체 없이 포탈100개·속성199개로 기존 한도를 지켰습니다. 남은 누락을 추가하려면 용량·기존 지지 사실 보존을 다시 검토해야 합니다. 기존 지지 사실 삭제·상한/스키마 변경·임의 문서 분할로 우회하지 않습니다.

**검토와 후속안.** 알려진 오류의 개발 동료검토를 수행했습니다. 고정 기준과 작성자 설명을 가린 투영을 사용했고, 최초 포탈 추가 속성 하나에서 실제 값의 목적지·방향 모호함이 발견돼 원시 초안·판정을 보존한 채 그 속성의 property/value만 보완했습니다. 최종7대상·변경/추가17주장은 지지됐으나 더 넓은15기준 중3개는 부분으로 남습니다. 통신 미답변·정책 생애주기·분할 미논의/인증 상충 등은 후속 범위이며 실제 업무 결론을 대신 확정하지 않습니다. 이 결과는 새 독립 정확도나 사람 승인, 전체80문제의 해결이 아닙니다.

**적용·되돌림 경계.** 격리 저장소는 자체 read/query의 최신 claim_id·복합 상태를 사용했고 행동 주체/이유를 simulation으로 표시했습니다. 운영 버전을 임시 저장소에 이식하거나 그 모의 이벤트를 운영 승인으로 사용하지 않습니다. 실제 반영을 요청받았을 때에도 현재3문서는 분리/추가가 있어 문서별 전체 생성 후보를 먼저 검토하고 이후 최신 주장에 명시 검토하는 순서를 유지합니다. 원문/그래프/원장/히스토리 충돌은 내용 재검토가 필요하며 버전값만 교체하지 않습니다. 동일 세대의 검토 undo는 새 이벤트를 남기고, 전체 생성 후 옛 세대 undo는 거부됩니다. 전체 생성의 직접 undo는 제공하지 않으며 복원 후보도 최신 원문·복합 버전을 대조한 새 생성이 필요합니다. 저장 성공의 정리 경고는 실패/자동 재전송으로 처리하지 않습니다.

#### N1 부분 해결3기준의 보완 범위와 추가 근거 (2026-10-24)

이번 범위는 고정 기준 `P-R13-2`·`P-R14-2`·`M-R6-2`의 **후속 보완 설계**입니다. 원래15기준의12보존·3부분 판정과 첫7대상 정정안 v2는 그대로 보존합니다. 현재 원문과 검토 상태를 다시 확인하되 새 정정 payload·원문 등록·그래프 생성·검토/정책/대응 이벤트·권한 변경·UI는 실행하지 않습니다. 정확한 원문 인용·셀/줄·버전·기존 claim_id와 추가 근거 질문은 비공개 `partial-three-scope-20261024T053124Z`에 두고, 공개 문서는 아래 보완 원칙을 담당합니다.

**미결 상태의 표현과 업무 결론 확정은 별개입니다.** 기존 N1 판본에 적힌 미답변·미논의·충돌 자체는 추가 자료 없이 원문 근거로 보완할 수 있습니다. 이를 가정으로 약화하거나, 자료가 없다는 이유로 표현까지 미루지 않습니다. 그 미결을 해소해 합의·귀속·인증 결론을 확정하려면 해당 범위의 새 근거가 필요합니다. N1의 기재를 현재 시점에도 계속 사실이라고 추정하지 않으며 판본·관측 시점을 함께 유지합니다.

| 기준 | 기존 근거로 보완할 범위 | 업무 결론 확정에 필요한 추가 근거 |
| --- | --- | --- |
| P-R13-2 — 설정·집행·미답변 | 포탈의 권한 내 설정/이력과 선상·게이트웨이의 실제 적용을 구분. 설정 범위 확인중, 첫 검토 블록 합의 확인 필요, 5G/위성 구분 미답변을 해당 상태로 보존 | 현업 회신/합의 기록과 게이트웨이·라우팅 설계의 대응 항목. 변경 요청→권한 확인→변경→기록/조회 중 합의한 범위, 채널·해역 해석, 포탈이 설정할 항목과 집행 주체를 확인 |
| P-R14-2 — 정책 종류·전달·승인 | 통신 정책·선박 데이터 처리 정책·전역 공통 정책을 구분. 등록/설정→OTA 전달→선상 적용, 새 브로커 선배포 조건, 웹 전용/선박 배포 분기와 정책 정본·버전 관리를 보존. 문서상 사내 거버넌스 신설 요구 제거와 설계 단계의 승인 절차를 구분 | 공통 정책/OTA 설계서와 현업·IoT/게이트웨이 확인 기록. 전송 단계·채널, 필터링/샘플링 정의, 선박/항로/계약별 적용 단위, 수정·승인·배포·복귀의 책임과 시점을 확인 |
| M-R6-2 — 분할·요구 공백·인증 경계 | 43건 분할 미확정·육상 요구 범위 미정, 해당 선행조건 행의 미논의, 원문에 병기된 인증 경계 상충을 출처별로 보존. 분할 확정 후 이관이라는 향후 조건을 현재 미확정 상태에 전파하지 않음 | 43건 전문과 선상/육상 귀속 결정·이슈 B-01 처리 이력, 참조된 기능단위 상세·통합시트2.6·4시트2.4-④2/④8의 판본·전체 문맥. 같은 대상/시점/범위를 비교한 인증 범위 검토/판정 자료로 충돌 해소 여부를 확인 |

두 포탈 기준의 N30 미결 항목과 확인 자료는 공통 목록으로 재사용합니다. 기준이2개라는 이유로 같은 근거 요청·주장을 두 번 만들지 않습니다. N31/N35/N82는 현재 선택 원문에 있고, 다른 시트·이슈 대장·후속 설계/회신의 전문은 **이번에 확인한 등록 범위에서 미제공**입니다. 원본 통합문서나 다른 위치에 실제로 없다고 단정하지 않습니다. 필요한 연속 구절과 앞뒤 정의·예외만 지정하며 같은 자료의 중복 등록을 기본안으로 삼지 않습니다.

**기존 표현 재사용과 용량.** 포탈의 첫 블록 합의 확인 필요·미답변 문구는 이미 기존 속성에 있고 양태가 hypothetical입니다. 원판정은 보존하면서 이번 대상은 ‘문구 전체 누락’과 ‘기존 문구의 상태 약화’를 구별합니다. 같은 주장의 양태·범위 교정으로 충실히 표현할 수 있는지 먼저 검토합니다. 새로운 독립 상태/정책 과정이나 현재 상태와 향후 조건의 분리가 필요하면 전체 생성 경로로 분류하며, 서로 다른 사실을 한 속성에 억지로 넣어 상한을 피하지 않습니다.

운영 포탈은 개체100·속성196이고 미반영 첫7대상 v2 후보는100·199입니다. 후속안을 합칠 기준은 후자이며 새 개체 여유0·속성 여유1입니다. 추가 수는 표현안을 정하기 전 확정하지 않습니다. 기존 주장 보강·조건 분리와 중복 여부를 확인한 뒤 전체 입력에서 한도·인용·실제 값의 의미·비대상 사실 보존을 함께 검증해야 합니다. 여유를 넘으면 용량/표현 문제로 보류하고 기존 지지 사실 삭제·원문 절단·상한 변경·임의 문서 추가로 우회하지 않습니다. 요약 문서와 나머지 작업군은 보호 대상으로 유지합니다.

**추가 근거의 최소 입력.** 자료명/안정된 ID·관리 주체, 판본·발행/개정일·관측 시각, 문서상 결정/검토 상태, 연결할 요구 ID·행/절, 실제 연속 인용·선택 범위와 원본/본문 hash를 확인합니다. 적용 대상·기간·예외와 이전 기재를 대체하는 범위는 원문이 말한 만큼만 기록하며 최신 날짜만으로 옛 자료를 폐기하지 않습니다. 확인 역할은 현업·게이트웨이/IoT 설계 담당·공통 정책 담당·AI 요구/인증 담당 등의 **확인 요청 대상 제안**이며 실제 승인자·서버 권한 부여가 아닙니다. 자료에 이름/수용 표시가 있어도 이 시스템의 인증 주체나 사람 승인 이벤트로 바꾸지 않습니다.

근거를 받지 못하면 N1 판본의 미답변/미논의/미정/상충과 추가 근거 대기를 유지합니다. 이후 출처를 실제 등록할 경우 원본·옛 원문·원장을 보존하고 중복/판본 관계를 확인한 뒤 기존 저장 경로를 사용합니다. 원문 근거 보완은 검토/전체 생성, 새 출처는 write 후 해당 원문의 추출과 필요한 기존 주장 재검토, 인용 없는 실제 전문가 업무 결정은 별도 명시 요청과 ontology_policy로 구분하는 기존 계약을 재사용합니다. 이번 설계는 어느 경로의 쓰기도 승인/실행하지 않습니다.

**완료 경계.** 후속 표현 보완에서는 같은3기준의 알려진 상태·조건·출처가 실제 주장에 남는지, 기존7대상/지지 사실·후보·이력이 보존되는지를 검증합니다. 원문의 미결을 정확히 표현하는 완료와 업무 미결 자체의 해소를 따로 기록하며 자료 대기·용량 한계를 해결로 세지 않습니다. 현재는 보완 범위·근거 요청·검증 기준의 설계이며15기준을 재채점하거나 운영 반영한 결과가 아닙니다. 실제 검사 범위와 보존 결과는 [PLAN](PLAN.md#d-042-n1-부분3기준의-보완-범위추가-근거-설계-2026-10-24)을 따릅니다.

#### N1 부분3기준 정정안의 격리 작성과 검증 (2026-10-24)

사용자 요청에 따라 기존 원문으로 가능한3기준의 표현 보완을 격리 정정안으로 작성·검증했습니다. 앞선 첫7대상 v2의 전체 배열을 재사용하고 현재 원문/그래프·검토 상태와 같은 입력임을 다시 확인했습니다. 비공개 `partial-three-correction-20261024T054957Z`에 정확한 전후 값·원문 근거·이동된 의미의 새 위치·전체 입력·기준/중립 제출·실제 격리 저장 영수증을 남겼습니다. 수치·실패 경로·보존 검사는 [PLAN](PLAN.md#d-042-n1-부분3기준-정정안-작성격리-검증-2026-10-24)이 담당합니다.

**같은 범위의 복합값과 독립 상태 분리.** 포탈의 인접한 미결 문구는 같은 요구의 현재 상태 보고로 보강했습니다. N35에서는 같은 적용 범위와 planned 양태를 가진 설계/설명 계획 두 문구를 실제 값에 함께 남기고, 확인 시점 미정·승인 프로세스 설계라는 별도 상태를 분리하는2→2 전체 재구성을 사용했습니다. 원래 지지된 설명 계획은 다른 속성의 값으로 이동하며 삭제되지 않습니다. N82의 웹 전용/선박행 분기와 내부 승인 설계는 같은 설계 지위로 보존했고 사내 거버넌스 신설 요구 제거와 섞지 않았습니다. N31의 정책 정본·버전/선박 인지 요구는 새 속성으로 두었습니다. 서로 다른 원문을 가짜 연속 인용으로 합치지 않았습니다.

H102의 현재 미확정·전문 위치 보고·분할 확정 후 이관은1→3으로 분리했습니다. 향후 조건이 현재 미확정 상태 전체에 걸리지 않게 하고, 미제공 시트 전문을 읽은 사실이나 실제 이관 완료로 바꾸지 않았습니다. L108의 미논의와 해당 행의 소관/회의 처리 기재, 출처별 인증 경계 상충은 문서가 보고한 상태로 보존합니다. 기재의 asserted 양태는 출처에 대한 주장 방식이며 이 시스템의 사람 승인·실제 기능 구현·인증 적용성 검증을 뜻하지 않습니다.

**전체 생성과 보존.** 기존 항목의 양태만 바로잡는1:1 교정 가능안과, 값 보강·의미 이동/분리·새 주장을 구분했습니다. 이번 합성 후보는 문서별 전체 생성 경로이며 원래의 개별 claim_id에 새 뜻을 직접 덮어쓴 검토 이벤트가 아닙니다. 원시 값이 바뀐 항목은 명시한 범위로 한정하고 이전7대상 정정 의미·비대상 사실·전체 개체/관계·후보를 유지했습니다. 포탈 개체100·속성200 한도 안에서 의미가 남는지는 구조 검사와 별도로 검토했습니다. 이후 추가 독립 주장/개체가 필요하면 기존 용량 gate를 다시 적용하며 지지 사실 삭제·한도 변경·임의 문서 분할로 우회하지 않습니다.

**판정의 범위와 미결.** 새 정정안은 고정한3기준의 문서 의미 보존을 충족했다는 개발 동료검토 결과를 얻었습니다. 이전15기준 판정을 새 결과로 덮어쓰지 않고 제출별 기록으로 보존합니다. 원문의 미답변·미논의·상충을 정확히 표현한 것이 실제 통신 합의·정책 승인 상세·AI 분할/귀속·인증 결론을 확정한 것은 아닙니다. 위 추가 근거 목록과 문서별 출처/판본/시점·적용 범위 대기는 유지합니다. 새 독립 정확도나 실제 전문가 승인으로 해석하지 않습니다.

실제 운영 데이터·원장·권한·연결·UI는 이번 작업에서 변경하지 않았고 read13을 유지합니다. 격리 모의 판단의 actor·이유·이력은 simulation이며 운영 승인으로 이식하지 않습니다. 후속 실제 반영을 요청받으면 최신 전체 원문·전문가 판단/보류·복합 상태를 다시 대조해야 합니다. 전체 생성 후 옛 검토 이력은 재검토 대상으로 남고, 검토 undo는 같은 세대 최신 이벤트에 새 이벤트를 남기는 기존 계약을 사용합니다. 전체 생성의 직접 undo나 자동 승인 복원은 제공하지 않습니다.

#### N1 검증된7대상·3기준 정정안의 실제 운영 반영 (2026-10-24)

사용자가 실제 운영 반영과 최소 권한의 일시 적용·회수를 승인했습니다. 현재 원문·기계/effective 그래프와 검토/정책/보류·복합5버전이 고정 검증 입력과 같음을 확인하고, 검증된 통합 후보의 전체4배열을3문서에 각각 한 번 저장했습니다. 전체 생성 경로를 택한 이유는 독립 상태·누락 보강·의미 이동을 포함한 후보이며 모든 주장을 미검토로 유지해야 하기 때문입니다. 원문 정정·전문가 승인이나 정책 판단을 대신 실행하지 않았습니다. 후보·실제 전송·새 버전·기존 주장ID의 세대별 대조·현재 앱 조회는 비공개 `apply-corrections-20261024T064045Z`에 보존하며 수치와 실제 검증은 [PLAN](PLAN.md#d-042-n1-7대상3기준-정정안-운영-반영조회권한-회수-2026-10-24)을 따릅니다.

**일시 권한과 설정 보존.** 서버 정책에 ontology_write만 잠시 추가하고 기존 개인 인증 런처를 사용하는 전용 SDK 호출 목록을 read13+generate로 제한했습니다. 앱 config/도구 노출은13개 그대로이며 새 legacy 서버나 다른 tenant/저장소 우회를 만들지 않았습니다. 서버의 해당 권한은 tenant 범위·대응 propose 허용·자동 TTL 부재라는 기존 한계가 있으므로 이를 문서 단위 권한이라고 표시하지 않습니다. 완료/예외 finally에서 최신 정책의 이번 권한만 회수하고 같은 warm 세션과 현재 앱의 read 복귀를 확인했습니다. 기존 정책 전체 복사로 병행 변경을 되돌리는 방식은 쓰지 않습니다.

**최신성·저장 결과·판단의 경계.** 문서별 직전 전체 원문·그래프·검토/원장 상태를 다시 대조하고 실제 source/state CAS로 저장했습니다. 기존 판단 원장은 보존되며 이전 검토가 있었다면 새 세대에서 재검토해야 한다는 계약도 유지합니다. 현재 운영의 기존 원장은 비어 있었고 결과354주장은 모두 미검토입니다. 신규 사람 승인·검토·전문가/대응 이벤트는 없습니다. 저장 후 정리 경고는 저장 실패로 취급하지 않으며 응답 불명·후속 조회 실패도 자동 재전송의 근거가 아닙니다. 이번3저장은 모두 성공·정리 경고0이었습니다.

**보존·복구·부분 결과.** 쓰기 전에 기존 WikiStore 잠금 아래 전체 tenant7파일·디렉터리를 독립 보존했습니다. 이전 그래프의 전체 바이트·세대·revision은 보존하지만 복구 시 직접 덮어쓰지 않습니다. 기존 `_stored_graph`로 입력 인용/후보를 복원하고 최신 원문에서 다시 근거·전체 상태를 확인한 뒤 새 인증 generate를 수행합니다. source/state가 달라졌다면 버전값만 바꾸지 않고 재대조하며 old generation_id/옛 승인 이식을 금지합니다. 운영 복구를 실제 실행한 결과는 아닙니다. impact의 과거 그래프 자동 복원은 이 비공개 보존본을 소비하지 않아 이번3조회가 부분 결과라는 사실을 그대로 남깁니다. 현재 통합 조회의 선택3문서 완료와 전체 의미/영향 망라를 구분합니다.

원문의 미답변·미논의·상충과 추가 근거가 필요한 업무 결론은 유지합니다. 이전 원판정·독립 평가·격리 의미 검증을 새 점수로 덮지 않았고 다른 정정 작업군·원격/Windows·UI 구현·실제 전문가 검토로 진행하지 않았습니다. 제품 코드·원문·이력·검토/전문가 판단·대응 원장·UI는 이번 작업에서 편집하지 않았으며 권한은 읽기 전용입니다.

#### N1 운영 정정 이후 다음 범위와 우선순위 (2026-10-24)

이번 요청은 다음 범위의 설계입니다. 앞선7대상·3기준의 검증된 실제 반영을 현재 기준으로 보호하고 기존13작업군·원판정·중첩 참조를 재사용했습니다. 원판정80주장의15값 변경/65동일은 버전 간 대조이며 해결/실패의 새 점수가 아닙니다. 과거 claim_id를 새 수정 대상으로 사용하지 않고 현재5버전/고유ID·원문 인용/셀/줄에 다시 연결했습니다. 누락은 새 ID를 발명하지 않습니다. 정확한 범위·검토 순서·개별 수용기준·검사 결과는 [PLAN](PLAN.md#d-042-n1-다음-정정-범위검토-우선순위-설계-2026-10-24)과 비공개 `next-correction-scope-20261024T090243Z`를 따릅니다.

**다음9우선과2조건부.** R0의 권리/정본 현재 상태 보고2개, 검사 한계/개발 요구·OTA 관측 주체/이슈3개, 전체 요청 기록·보류/미정의3개, 권한 N:M/논리 이전/후속 책임 누락1범위를 우선 구체화합니다. 모델 정본 파편화와 학습 동의/귀속 미정은 기존 근거로 보고 지위를 보완할 수 있으므로, 실제 업무 결론에 추가 자료가 필요하다는 이유로 그 상태 표현까지 보류하지 않습니다. 미제공 참조의 전문과 실제 권리 결론은 계속 대기합니다. compliance 정의/육상 앱 능력과 표준 부재 시 세션 대응의 선행 대상 연결2개는 같은 R0의 조건부 범위입니다. 위험도와 실제 표현/용량 준비 상태를 분리하며9개도 실행가능 확정/쓰기 횟수로 표시하지 않습니다.

**용량·의미와 판단.** 포탈 개체100·속성200 한도를 현재 기준으로 적용합니다. 조건이 다른 독립 사실을 하나에 묶거나 문서 간 이관·지지 사실 삭제·임의 분할/상한 변경으로 우회하지 않습니다. 요약 검사 보고/미래 요구의 분리와 N9의 누락 보강은 전체 생성 후보/용량 검증을 요구합니다. 포탈의 우선 대상도 분리가 필요하면 gate로 남깁니다.1:1은 뜻을 충실히 표현할 가능성이지 검토 결정이 아닙니다. 이후 AI 정정도 미검토로 유지하는 요청에는 격리 검증한 전체 생성 경로를 사용하고, 검토 이벤트를 남기는 review edit는 별도 실제 검토 요청과 구분합니다. 이번에는 둘 다 실행하지 않습니다.

**확정하지 않을 결론.** 제공 문서가 보고한 현재 한계·미정·보류·요구/계획과 외부 기술 진위·인증/규정 적용·실제 구현/권한/법적 소유권을 구분합니다. 기존17근거 대기와 권한 후보 c1을 유지하고 다른 미검토 후보도 수용/거절하지 않습니다. 기존 근거로 보완 가능·자료 대기·표현/용량 한계·선택하지 않은 후속 범위를 따로 기록합니다. 앞선7/3반영이나 다음11참조의 설계로 작업군 전체·모든 질문/누락·업무 미결을 해결했다고 쓰지 않습니다.

고정 기준과 별도 역할의 설계 검토를 수행했지만 새 독립 의미 평가/정정안 검증·사람 승인은 아닙니다. 운영 데이터·원장·UI·권한·연결은 그대로이며354주장은 미검토·read13입니다. 미래 실행 시의 전체 최신성 재확인·충돌/실패 보존·부분 성공·권한 회수·새 세대 되돌림은 위 D-042 계약을 재사용합니다. 이번에는 payload·실제 정정·권한 변경을 하지 않았습니다.

#### N1 우선9대상 정정안의 격리 작성과 검증 (2026-10-24)

이번 요청은 우선9대상의 정정안 작성과 격리 검증입니다. 기존 운영의 전체 원문·4배열·검토/정책·5버전을 다시 확인하고 앞선7/3반영 결과를 기준으로 재사용했습니다. 비공개 `correction-nine-20261024T094459Z`에 원시 v1·전후 변경/의미 이동·출처/버전·작성 입력/프롬프트 hash·고정 기준·중립 제출·별도 의미 판정·격리 저장 영수증을 보존합니다. 실제 수치·실패 경로·범위와 보존 검사는 [PLAN](PLAN.md#d-042-n1-우선9대상-정정안-작성격리-검증-2026-10-24)을 따릅니다. 실제 운영 정정·권한·UI 변경은 포함하지 않습니다.

**표현을 나누는 이유와 범위.** 현재 검사 한계/확인 보고와 앱 개발 단계 준수 요구는 양태가 달라 한 속성에서 분리했습니다. N9의 권한 다중성·물리 이관 없는 논리 변경·후속 담당은 원문의 단일 후속 업무 기재로 보강하되 독립 planned 속성으로 두었습니다. 관계 기반 책임 조회·기수성 실행·실제 소유권/권한 변경을 구현한 것으로 읽지 않습니다. 원문의 현재 미정·보류를 가상 상황으로 약화하지 않으면서 해당 보고를 외부 기술/규정의 진위·구현 완료·실제 전문가 승인으로 승격하지 않습니다.

**한도와 보호.** 포탈의 기존 관계/속성만 교체해100개체·200속성을 유지했고 기존 전체 사실을 삭제·이관하거나 문서를 분할·추가하지 않았습니다. 우선9개 중8기존 주장 교체와 요약2속성 추가만 포함합니다. 조건부2개의 복합 양태/선행 대상 문제는 현재 raw 값 그대로 남기며 이번 의미 검토의 해결 범위에서 제외했습니다. 기존7/3의35주장·비대상518요소·모든 개체/후보5개는 보존합니다. 추가 근거17항목과 미제공 참조·권한 후보·인증 상충은 계속 미결입니다.

**검증의 경계.** 질문25개를 먼저 고정한 별도 개발 동료검토에서 선택9대상/10변경·추가 주장의 원문 의미 보존을 확인했고, 기존 모듈의 실제 격리 저장·원장/전체 history·CAS·실패·정리 경고·새 세대 복구도 따로 검증했습니다. 모의 검토/actor는 simulation이며 실제 전문가 판단이 아닙니다. 이 결과를 새 독립 의미 정확도·전체 문제 해소·반복 일관성이나 실제 전문가 조정 통과로 표시하지 않습니다. 운영 원장/정책 이력이 비어 있었으므로 실제 기존 전문가 판단의 재사용을 검증한 것으로 과장하지 않습니다.

현재 운영은 여전히354개 미검토 주장·read13이며 후보356개와 구분합니다. 이번에는 운영 쓰기·권한/연결·제품 코드·UI를 바꾸지 않았습니다. 향후 실제 반영은 최신 전체 자료와 상태를 다시 대조한 별도 범위이며 기존 최소 권한·전체 보존·충돌/부분 성공·회수·새 세대 되돌림 계약을 그대로 적용합니다. 옛 승인을 이식하거나 전체 생성의 직접 undo로 보존 그래프를 덮어쓰지 않습니다.

#### N1 우선9대상 정정안의 실제 운영 반영 (2026-10-24)

사용자가 고정 검증 후보의 실제 반영과 최소 권한 일시 적용·회수를 승인했습니다. 전체 원문·기존 판단과 복합5버전을 대조하고, 고정 후보의 전체4배열을 기존3문서에 한 번씩 저장했습니다. 비공개 `apply-nine-20261024T101528Z`에 원래7파일 전체 보존본·입력 hash·직전 버전·단회 전송/저장 영수증·새 버전과 주장 계보·현재 앱 조회를 남겼습니다. 수치와 실제 검증은 [PLAN](PLAN.md#d-042-n1-우선9대상-정정안-운영-반영조회권한-회수-2026-10-24)을 따릅니다.

전체 생성 경로는 이미 검증한8교체·2추가 후보를 그대로 반영하고 미검토 상태를 유지하기 위해 재사용했습니다. 조건부2·기존 정정35주장·후보5개와 추가 근거17범위는 보존했습니다. 결과356주장은 모두 미검토이며 원문·검토/전문가 판단·대응 원장을 수정하거나 사람 승인으로 승격하지 않았습니다. 실제 운영 원장은 비어 있던 상태로 유지됐으므로 채워진 기존 전문가 판단을 재사용한 시험으로 표시하지 않습니다.

기존 개인 인증 런처의 전용 SDK만 read13+generate로 제한해 사용했고 서버 ontology_write만 잠시 적용했습니다. 완료/예외 finally에서 최신 정책의 이번 권한만 회수하며 앱 설정·13도구 노출은 그대로입니다. 원래 정책 바이트/모드·revision으로 복귀했고 warm 세션 및 현재 앱 조회에서도 read를 확인했습니다. 권한 범위·byte-CAS·응답 불명/정리 경고의 재송신 금지·부분 성공은 앞선 [운영 계약](#n1-검증된7대상3기준-정정안의-실제-운영-반영-2026-10-24)을 유지합니다.

복구는 독립 보존본을 직접 덮는 방식이 아니라 이전 전체4배열을 입력 형태로 변환하고 최신 원문·판단·상태를 재검증해 새 세대로 저장하는 별도 작업입니다. 복구 입력화만 검증했고 실제 운영 되돌림은 실행하지 않았습니다. 현재 앱의 선택3문서 통합 조회는 완료였지만 impact의 과거 그래프 복원 불가에 따른 부분 결과도 그대로 남겼습니다. 의미 평가·원판정을 갱신하거나 다른 정정 작업군·UI/제품 구현·추가 권한·원격 전환으로 진행하지 않았습니다.

#### N1 조건부2대상의 보완 범위와 기존 근거 재사용 (2026-10-24)

이번 단계는 앞선 우선9 반영 후 남긴 C01/C02의 상세 설계입니다. 현재 원문·전체 그래프·검토/전문가 판단·5버전을 다시 확인하고 기존 검토 원판정과 보호 범위를 재사용했습니다. 원문24셀의 실제 연속 인용·줄/바이트·문서/revision, 현재 claim_id/state_revision, 전문 의미 범위와 별도 설계 검토를 비공개 `conditional-two-scope-20261024T103508Z`에 보존합니다. 실제 상태·산술·수용기준·실행한 검사는 [PLAN](PLAN.md#d-042-n1-조건부2대상-보완-범위기존-근거-재사용-설계-2026-10-24)을 따릅니다. 두 대상 모두 현재 운영에서 정정되거나 승인된 상태는 아닙니다.

**C01의 의미는 근거 충분, 표현 대안의 충실성 검증은 대기입니다.** 문서 내 compliance 정의와 육상 앱의 개발자 워크스페이스 시험 능력은 서로 다른 양태로 보존해야 합니다. 정의에는 문서 내 사용 범위와 법률 의미를 배제한 원문 취지를, 능력에는 육상 앱·시험 환경 제한과 실제 시험 성공을 뜻하지 않는 지위를 유지합니다. r41의 문서해설 맥락에 두 독립 텍스트 속성을 두는 안은 새 앱 개체 없이 검토할 수 있지만 현재 속성200개에서201개가 되므로 실행 가능한 안으로 확정하지 않습니다. 고객사/선단 워크스페이스·개발자/파트너 워크스페이스·선상 샌드박스를 이름만으로 같은 시험 환경으로 합치지 않으며 정확한 앱/시험 관계 끝점도 발명하지 않습니다. 1:1 복합 텍스트도 실제 값·한정어 해석에서 정의와 능력·범위를 충실히 보존할 가능성을 열어두며, 불가능 또는 완료라고 아직 판정하지 않습니다. 분리된 주장 개수를 정답으로 삼지 않습니다. 양태 하나의 변경이나 인용 검사만으로 전체 해결을 인정하지 않으며 후속 의미 검증이 필요합니다.

**C02는 다음 격리 작성의 우선 범위로 정합니다.** 같은 셀의 선행 문장과 Seq60의 B67/C67/G67·N67을 대조하면 기존 r67의 세션 대응 기능을 사용할 수 있습니다. r69→r67의 조건부 planned uses 관계를 추가하고 기존 a194는 별도의 범위 미정 보고로 좁히는 안을 우선 검토합니다. 고객/현업 내부 로그 표준의 부재 조건·사용자 행위 로그 관리와 세션 대응의 결합·관리자 개입/비활성화 선택을 모두 보존해야 합니다. a100의 전체 요청 기록이 모든 로그 관리를 대신하지 않으며, 새 관계의 범위와 원문·기존 a192를 함께 읽어 결합 의미가 남는지 검증에 실패하면 부분/미결로 남깁니다. 상관분석/자동 탐지의 범위 미정은 표준 부재에 종속시키지 않습니다. 수치상 관계1개를 늘리고 속성 순증 없이 표현할 여지가 있다는 판단이며 실제 정정 입력·정규화·격리 저장 성공 판정은 아닙니다.

기존 국소 의미를 보완하는 데 새 업무 문서가 필수인 것은 아닙니다. 실제 시험/구현 성공·검사 정책/서비스·업무 합의, 로그 표준의 존재/부재와 적용 판본·로그 이관 아키텍처·탐지 시나리오·세션 시간/권한 위임은 실제 근거를 기다립니다. 원문의 현재 미정·전언·제안·보류를 해당 업무 결론으로 승격하지 않습니다. 기존17근거 대기·미검토 후보·비대상 주장은 보존합니다.

별도 설계 검토에서 최초안의 현업 표준을 산업계 일반 표준으로 넓히는 번역과 모든1:1 표현을 배제하는 단정2곳을 지적받아 보완했습니다. 최초안·판정과 보완본을 함께 보존하며 이전 의미 점수를 바꾸지 않습니다.

이번에는 전체356주장과 원장·UI·읽기 권한을 그대로 유지합니다. 이후 C02만 격리 작성할 경우 선택한 a194의 의미 재배치 외 다른355개 값·이전 정정 결과를 보존하고 새 주장도 미검토로 시작해야 합니다. C01의 용량을 확보한다며 지지 사실 삭제·타 문서 이관·임의 분할·상한 변경을 전제하지 않습니다. 알려진 개발 사례의 설계 검토를 새 분리 의미 정확도 평가·사람 승인으로 해석하지 않으며 원문/그래프 수정·권한 변경·후속 격리 검증은 이번 범위에서 실행하지 않습니다.

#### N1 C02 세션 대응 정정안의 격리 작성·검증 (2026-10-24)

사용자가 C02만의 격리 정정안 작성·검증을 요청했습니다. 현재 전체 원문·기계/effective 그래프와 검토/정책/보류·5버전을 재확인하고 앞선 v2 범위 설계를 사용했습니다. 비공개 `correction-c02-20261024T105841Z`에 원시 v1/v2 후보·입력/프롬프트 hash·정확 delta/의미 이동·사전 기준·중립 제출·별도 의미 검토와 실제 격리 영수증을 보존합니다. 수치·검증 방법·한계는 [PLAN](PLAN.md#d-042-n1-c02-세션-대응-정정안-작성격리-검증-2026-10-24)을 따릅니다. 실제 운영 반영·권한/연결·UI 변경은 이번 범위가 아닙니다.

**결합 대응과 독립 미정의 재표현.** 기존 두 개체의 조건부 planned uses 관계1개와 기존 a194의 명시적 문서 보고를 사용해 속성을 늘리지 않았습니다. 고객/현업 내부 로그 표준의 부재를 조건으로 남기며 현재 충족 사실로 만들지 않습니다. 원문의 대명사는 같은 셀 선행 문장의 Seq60과 B67/C67/G67의 r67로 확인했고, 로그 관리와 관리자 세션 대응을 함께 쓰는 범위를 실제 관계/한정어에 남겼습니다. 기존 전체 요청 기록 a100이 모든 로그 관리 기능을 대신한다고 가정하지 않았고, a192의 관리자 강제 만료·선택적 계정 비활성화도 유지했습니다. a194의 실제 값에는 Seq60의 선행 설명·조건부 결합 대응·독립 미정 문장을 연속 원문 그대로 함께 보존했습니다. 보고의 전역 condition은 null이고 실제 조건부 수단 사용은 새 planned 관계가 제한합니다. 상관분석/자동 탐지 범위 미정은 독립 보고이며 위 조건에 종속되거나 실제 기능 구현의 증거가 되지 않습니다.

v1의 관계/범위만으로는 로그 관리가 결합 성분인지 적용 맥락인지 모호하다는 별도 의미 판정을 받아 한 번 보완했습니다. v1 제출·20보존/2부분 판정·저장 검사와 보완본의 판정을 버전별로 보존하며 이전 결과를 새 점수로 덮어쓰지 않습니다.

**보호와 판단의 지위.** C02의 한 속성 교체·한 관계 추가 외 기존355주장·45정정·C01·전체 개체/후보 값을 보존합니다. 후보357주장은 모두 미검토로 시작하며 실제 운영은356미검토 그대로입니다. C01의 표현/용량 문제와 기존17추가 근거 범위, 표준 존재 여부·전언 로그 이관·탐지 시나리오·세션 수치/권한 위임·정책/구현 결론을 확정하지 않았습니다. 비대상 a99를 포함해 N69 전체나 이전 평가의 모든 문제를 해결한 것으로 계산하지 않습니다.

실제 임시 저장소에서 전체3문서 저장·조회·CAS·실패 보존·모의 원장 보류·정리 경고 성공·새 세대 복구와 전체 원문 이력을 확인했고, 원문 의미 검토는 따로 수행했습니다. 실제 운영 원장이 비어 있으므로 source-review simulation을 채워진 전문가 판단 재사용이나 사람 승인으로 과장하지 않습니다. 이전 원판정/설계 v1·v2·격리 기록은 수정하지 않았고 제품 코드·운영 원문/그래프·이력/원장·설정·권한·UI를 편집하지 않았습니다. 실제 반영은 최신 전체 자료·상태를 다시 확인하는 별도 후속 범위로 남깁니다.

#### N1 C02 정정안의 운영 반영·조회·권한 회수 (2026-10-24)

사용자가 검증 C02의 운영 반영과 최소 권한 일시 적용·회수를 승인했습니다. 최신 전체3문서·검토 상태·복합5버전과 고정 v2를 대조한 뒤 변경이 필요한 포탈만 전체4배열로 한 번 생성했습니다. 나머지2문서는 재생성하지 않았습니다. 실행·수치·조회와 한계는 [PLAN](PLAN.md#d-042-n1-c02-정정안-운영-반영조회권한-회수-2026-10-24), 고정 후보와 의미 판단은 앞선 격리 기록을 따릅니다.

**조건과 판단 지위.** 내부 로그 표준 부재는 미확정 적용 조건입니다. 로그 관리와 관리자 대응을 함께 쓰는 planned 관계와 기존 설명의 결합 보고, 독립적인 탐지 범위 미정을 그대로 저장했습니다. C01·기존17업무 근거 대기·비대상355주장·기존45정정과 미검토 상태를 유지하며 전체357주장을 사람 승인이나 구현 완료로 승격하지 않았습니다. 검토/전문가/대응 이벤트는 추가하지 않았습니다.

**권한·보존·되돌림.** 기존 개인 인증 런처와 정책 편집 CAS를 재사용했습니다. 전용 SDK는 read13+generate만 호출하고 앱 설정은 read13 그대로이며 원문/검토/전문가 권한은 부여하지 않았습니다. ontology_write의 tenant 범위·대응 propose 허용·자동 TTL 부재 한계는 그대로입니다. 성공/예외 finally에서 최신 정책의 이번 권한만 회수했고 warm SDK/현재 앱에서 read와 원래 policy revision을 확인했습니다. 변경 전 tenant 전체7파일과 그래프를 독립 보존하며 사용자 원문/히스토리·기존 검토/판단/대응 원장과 병행 UI 변경을 유지했습니다. 복구가 필요하면 최신 자료/상태를 대조하고 보존 배열을 새 generation으로 제출하며 직접 파일 복원·옛 승인 이식·성공/ACK 불명 후 자동 재시도는 하지 않습니다. 실제 되돌림·운영 실패 주입은 이번에 수행하지 않았습니다.

#### N1 C01 표현 충실성과 속성 용량의 보완 설계 (2026-10-24)

이번에는 C02 적용 뒤 남은 C01의 표현 충실성과 개수 제약을 검토했습니다. 최신 전체3원문·기계/effective 그래프·검토 상태와5버전은 직전 적용 영수증과 같고 전체357주장은 미검토·read13입니다. 현재 r41/a44의 정확한 두 문장은 유지돼 있으나 전체 hypothetical 양태가 문서 내 용어 정의와 육상 앱 시험 가능 설명을 구분하지 못합니다. N41/M41의 국소 뜻을 해석하는 데 필요한 근거는 있으며 실제 시험 결과·최종 업무 합의를 요구하는 결론과 구분합니다. 상세 비교·수용기준·실행한 읽기 검증은 [PLAN](PLAN.md#d-042-n1-c01-표현-충실성속성-용량-보완-설계-2026-10-24)을 따릅니다.

**개수 중립인 해설 보고와 절별 구조화.** A는 현재87자 복합 문장을 실제 값/근거에 유지하고 문서가 정의와 특정 범위의 능력을 설명한다는 해석을 우선 후속 검토합니다. 이때 asserted는 보고의 지위이며 기능 구현·시험 실행을 확정하지 않습니다. 보고를 새 스키마 필드나 원문에 없는 property로 만들지 않고, 법률 의미 배제·육상 앱/개발자 워크스페이스 범위·해당 문장의 검토 근거를 절 안에 보존합니다. 전역 부정·범위·조건·시각·basis로 다른 절에 전파하지 않습니다. 문장 뜻을 보존할 가능성과 독립 capability 주장으로 구조화하지 못하는 한계를 함께 기록하며 단순 양태 변경이나 형식 통과로 정정 완료를 인정하지 않습니다.

B는 같은 r41의 텍스트2속성으로 서로 다른 양태를 독립 보존할 수 있는 설계지만201/200이 됩니다. 이 경로의 용량 차단이 C01의 모든 표현 불가능이나 원문 근거 부족을 뜻하지 않습니다. 관계안 C도159개 여유만으로 채택하지 않으며 기존 회사/파트너 워크스페이스·선상 샌드박스의 이름을 N41 시험 환경의 동일성 근거로 쓰지 않습니다. 정확한 끝점·술어/방향·연속 인용과 필요한 개체 용량을 먼저 확인합니다.

**판단과 보호.** 기존357주장·45정정과 적용C02·전체 개체/후보·원문/히스토리·검토/전문가/대응 원장·UI·정책/설정을 그대로 유지합니다. 추가 근거가 필요한17업무 결론과 실제 시험/서비스 제공·책임·정책·환경 동일성은 미결입니다. 알려진 사례의 설계 동료검토이며 실제 정정 payload/격리 검증·원문 분리 의미 평가·사람 승인·운영 쓰기·권한 변경을 수행하지 않았습니다. 다음은 요청된 경우에만 A의 제한된 해석을 실제 후보로 검증하며, 충실성이 부족하거나 독립 구조화가 필수이면 B/C의 별도 보존 설계를 검토합니다.

#### N1 C01 A안의 격리 작성·의미 검증 (2026-10-24)

사용자가 C01 A안의 격리 작성과 의미 검증을 요청했습니다. 현재 원문·기계/effective 그래프·검토 상태와5버전을 확인하고 전체 baseline에서 포탈 a44의 전역 양태 한 필드만 hypothetical→asserted로 바꿨습니다. 실제 두 문장87자는 property/value/evidence에 그대로 두었으며 문서가 용어 정의와 육상 앱의 제한된 시험 가능 범위를 설명한다는 보고 해석입니다. 새 source/property/개체/관계·스키마 필드나 승인 이벤트를 만들지 않았습니다. 고정 제출·검증 수치·오류/한계와 보존은 [PLAN](PLAN.md#d-042-n1-c01-a안-작성격리-검증-2026-10-24), 비공개 correction-c01-a-20261024T120810Z를 따릅니다.

**문장 충실성과 독립 구조를 별도로 판정합니다.** 생성자 설명을 가린 제출을 사전 원문 질문과 대조한 별도 개발 동료검토에서 문장 충실성12와 보존9는 보존됐고 변경 주장1은 지지됐습니다. 이는 실제 value가 정의의 법률 의미 배제와 업로드 기준 뜻, 육상 앱/개발자 워크스페이스 시험 가능·해당 문장의 검토 근거를 담는다는 판정입니다. 전역 asserted가 실제 구현·시험 완료/성공을 뜻하지 않으며 전역 부정·scope·조건·시각·basis를 다른 절에 퍼뜨리지 않습니다. 독립 양태·절별 범위·절별 출처 구조3항목은 미표현으로 남깁니다. 두 내용을 독립된 주장으로 표현해야 하는 목표의 부분 상태를 숨기거나 텍스트 검색을 typed capability 조회로 대신 승인하지 않습니다.

기존 모듈로 임시 전체3문서 저장·조회·복합 state 거부/보존과 새 세대 복구를 실행했습니다. 이 구조/보존 검증을 의미 판정과 구분하며, 같은 모델 개발 동료검토를 새 blind 평가·실제 전문가 승인으로 과장하지 않습니다. 추가 근거17결론과 실제 시험/서비스/책임/정책/환경 동일성은 미결이고 B/C 대안도 자동 실행하지 않았습니다.

운영357주장은 모두 기존 미검토 그대로이며 C01 운영 값도 바꾸지 않았습니다. 기존47정정(C02포함)·나머지356주장·개체/후보·원문/전체 이력/검토·전문가·대응 원장·UI·정책/설정/코드를 유지합니다. 이번 완료는 격리 후보와 한계를 포함한 검증 범위에 한정되며 실제 반영·권한 변경은 별도 요청 전 실행하지 않습니다.

#### N1 C01 A안의 운영 반영과 한계 유지 (2026-10-24)

사용자가 검증된 C01 A안의 최소 쓰기 운영 반영·조회·권한 회수를 요청해 실행했습니다. 승인한 전체 후보와 현재 원문/전체 그래프·5버전을 대조한 뒤 a44의 전역 보고 양태 한 필드만 반영했습니다. 앞선 C02와 기존47정정·비대상356주장·전체357미검토를 보존합니다. 입력/보존본·정확한 변경·실행 수치와 실패/회수의 실제 결과는 [PLAN](PLAN.md#d-042-n1-c01-a안-운영-반영조회권한-회수-2026-10-24), 비공개 apply-c01-a-20261024T122730Z에서 관리합니다.

**운영 반영의 뜻과 한계를 함께 유지합니다.** 복합 설명의 두 문장을 그대로 두고 문서가 정의와 육상 앱의 개발자 워크스페이스 시험 가능 범위를 설명한다는 보고로 asserted를 사용합니다. 실제 시험 성공·구현/법률 준수·서비스 제공/책임 합의나 사람 승인으로 해석하지 않습니다. 절별 독립 양태·범위·출처3항목은 미표현이며 독립 주장 표현 목표의 partial을 유지합니다. capability 전용 조회·분리 용량·환경 동일성 문제와 기존17추가 근거 결론은 해결 처리하지 않았습니다.

**최소 쓰기와 보존.** 기존 개인 인증 연결과 read13 앱 설정을 유지하고 전용 호출에서 ontology_write만 일시 부여해 포탈 전체 그래프를 한 번 생성했습니다. source/state CAS·전체 독립 보존본과 조회 대조를 사용했으며 성공 쓰기 뒤 자동 재시도하지 않았습니다. finally로 권한을 회수하고 원래 read 정책의 바이트/모드·같은 연결/현재 앱 조회를 확인했습니다. 원문·전체 히스토리·검토/전문가/대응 원장·UI를 편집하거나 새 승인 이벤트를 만들지 않았습니다. 이번 완료는 운영 반영/조회/회수 범위이며 독립 의미 정확도나 실제 기능 시험의 새 승인이 아닙니다.

#### N1 C01 독립 주장 표현의 최소 보완안 (2026-10-24)

이번 요청은 독립 양태·절별 범위·절별 출처3한계의 **최소 보완 설계**입니다. 현재 A안의 문장 충실성과 운영357미검토·read13은 그대로이며, 실제 구조 보완 완료·새 스키마 지원·운영 적용으로 확정하지 않습니다. 최신 원문/전체 그래프·버전과 실제 설계 검증·보존 결과는 [PLAN](PLAN.md#d-042-n1-c01-독립-주장-표현의-최소-보완-설계-2026-10-24), 비공개 c01-independent-design-20261024T123559Z에서 관리합니다.

**현 v3에서 바로 쓸 수 있는 보존안은 확인하지 못했습니다.** a44를2속성으로 나누면201/200이며 개체도100/100입니다. 기존 일반 workspace·r37·선상 sandbox를 정확한 육상 앱/개발자 시험 환경과 동일시하지 않습니다. a43의 보류/통합 이슈 상태·a174와 a36의 제안/수동·자동검토 범위·a170의 단계 범위를 관계 하나로 옮기면 의미가 빠집니다. 기존 사실 삭제·타 문서 이관·임의 분할·개체 재지정·상한 변경이나 새로운 중첩/주장 배열로201속성을 숨기는 안은 채택하지 않습니다. 이 국소 검토를 현 스키마의 모든 표현 가능성에 대한 불가능성 증명으로 과장하지 않습니다.

**우선 후보는 기존 속성1개와 원문 구절을 끝점으로 하는 관계1개입니다.** 별도 속성/주장 collection이나 새 개체를 만들지 않고 기존 relations의 제한적 끝점 확장을 후속 설계합니다.

| 독립 주장 | 최소 표현과 각 주장에 붙는 메타데이터 | 해석 경계 |
| --- | --- | --- |
| 문서 내 용어 정의 | 기존 r41/a44의 첫 연속 문장46자를 text 값/근거로 유지. positive/asserted, scope는 원문의 업로드 시, provenance basis·source_entity·attributed_to와 조건/시점은 null | 법률 의미 배제·업로드 기준 준수 뜻을 실제 값에 남김. r41은 문서의 요구 해설이며 앱 실행 주체가 아님. 전역 법률 사실이나 전체 negative로 바꾸지 않음 |
| 육상 앱의 시험 가능 범위 | 같은 둘째 문장40자 안의 개발자 워크스페이스 구절→실행·테스트 구절을 enables/capability로 표현하는 관계1개. positive, scope는 육상용 앱, provenance basis는 엑셀 현업 검토, source_entity·attributed_to와 조건/시점은 null | 환경에서 해당 앱의 실행·시험이 가능하다는 문서 보고. 실제 인스턴스/환경 존재·시험 수행/성공·일반 인과·사람 승인을 뜻하지 않음. 앱→환경 uses는 사용 행위로 뜻을 바꿀 위험 때문에 우선안에서 제외 |

두 주장은 각자의 정확한 인용·문서/source revision·양태·scope·provenance를 가지며 능력절의 검토 근거를 정의절로 전파하지 않습니다. 두 주장 모두 positive이며 불명 context는 domain=null/viewpoints=[]로 유지합니다. 개발자라는 시험환경 명칭만으로 developer 조회관점을 부여하지 않습니다. enables의 방향·의미는 후속 의미 검증 대상이고 모호하면 설계를 보류하며 이번 범위 밖인 앵커 후보나 기존 후보의 수용으로 우회하지 않습니다. 원문87자는46+분리 공백1+40으로 손실 없이 보존하고, 미래 재표현 전에는 현재 A의 전체 그래프도 독립 보존합니다. 미래 산술은 속성200−1+1=200·관계41+1=42·개체100+0=100·전체 주장357−1+2=358이며 전부 미검토로 시작해야 합니다. 현재 값이나 검토 완료 수로 보고하지 않습니다. 앱이 typed entity 끝점이 아닌 scope 문자열에 남는 점과 전용 capability 조회·강한 객체 동일성이 구현되지 않은 점도 숨기지 않습니다.

**새 참조의 필요한 경계.** 원문 앵커는 개체 ID나 특정 인스턴스/유형 선언이 아니라 같은 허용 tenant·같은 문서/source revision의 정확한 구절 참조입니다. 현재 v3는 이를 거부하므로 별도의 명시적 지원 형식이 필요하며 숫자/최종 wire grammar는 미구현입니다. 기존 문자열 끝점은 그대로 유지하고 우선 확장은 relations에만 제한합니다. candidates·속성 subject·provenance·전문가 정책의 entity 권한을 함께 넓히지 않습니다. 원문앵커에 graph_ref·actor·approval·외부 의존/중첩 참조를 넣지 않으며 새 관계도 기존200관계·그래프1MiB 한도에 포함합니다.

정규 참조는 문서/source revision·1기준 양끝 포함 줄·정확 quote·0기준 occurrence로 구별합니다. UTF8바이트 위치는 계산한 진단값이며 시작 포함/끝 제외입니다. 가장 작은 후속 범위에서는 새 앵커 관계의 전체 evidence가 원문에서 유일한 실제 연속 구절이어야 하며, 반복 전체 인용을 임의 첫 위치에 붙이지 않고 거부합니다. 두 끝점의 해당 occurrence 모두 그 evidence 범위 안에 있어야 합니다. 기존 D-038 위치 검증을 참고할 수 있지만 인용 내 포함 검사를 추가해야 하며 기존 correspondence의 graph_ref까지 통째로 허용하지 않습니다. 원문 변경 시 stale/CAS·재추출/검토를 유지하고 구절 자동 재매칭·revision 숫자 교체로 재사용하지 않습니다.

**실행 전 호환성과 판정.** endpoint 타입 하나만 넓히면 현재 중복 집합·entity 기반 claim_id·검토 원장의 v3/가상 revision 검증·버전별 전체 배열 검증·개념 끝점 선택이 깨집니다. 새형식의 저장/조회·형식 선택·정확 위치 검증, 기존356주장 값/ID와 옛 그래프/원장 이벤트/해시의 불변·변경 C01 승인 미이식, 채워진 격리 원장의 재생/보류·복합 CAS·실패 보존을 먼저 확인합니다. 읽기·전체 context·concept·connections/impact·correspondence 참조는 새 주장을 지원하거나 미지원/불완전을 명시해야 하며 가짜 entity ID나 조용한 생략으로 호환시키지 않습니다. 이름/유형 기반 연결과 영향 안내에 앵커의 동일성/전체 의미 의존성을 추론하지 않습니다. 소스 코드 조사와 설계 검토만으로 enables 해석의 충실성·실제 capability 조회·제품 UI 호환을 통과 처리하지 않으며 후속 격리 후보의 별도 의미 검증이 필요합니다.

이번에는 기존 데이터·원문/전체 이력·검토/전문가/대응 원장·UI·읽기 권한을 보존했습니다. 기존47정정/C02·비대상356주장·172개체/5후보와 추가 근거17결론을 유지합니다. 실제 시험 환경/판본/결과·검사 서비스/책임·최종 정책·환경 동일성은 추가 근거가 필요하며 이 설계로 승인하지 않습니다. 운영 쓰기·권한 변경·core/스키마 구현·새 정정/전체 그래프 payload·격리 저장은 실행하지 않았습니다.

#### N1 C01 원문 앵커 끝점의 격리 구현과 검증 (2026-10-24)

사용자가 앞선 최소안을 **운영과 분리한 구현·관계 의미/저장/조회/원장 호환 검증**으로 진행하도록 요청했습니다. 운영 core나 접근 정책을 바꾸지 않고 별도 격리 코드에서 명시적 v4 형식만 검증했습니다. 실제 파일/검사/의미 판정의 분모·오류와 보존은 [PLAN](PLAN.md#d-042-n1-c01-원문-앵커-끝점의-격리-구현의미호환-검증-2026-10-24), 비공개 c01-anchor-isolated-20261024T130512Z을 따릅니다. 이것은 운영 스키마의 전역 승격이나 UI 적용 결정이 아닙니다.

**격리 형식의 구체화.** 기존 문자열 EntityId는 그대로 두며, schema_version=4를 명시한 relations의 subject/object에만 flat `{kind:"source_anchor",document,source_revision,quote,start_line,end_line,occurrence}`를 허용합니다. kind는 source_anchor 고정이고 필드 추가·누락/다른 kind를 거부합니다. 같은 허용 문서/source revision·정규 상대 .md 경로·정확한 비어 있지 않은 구절, 1기준 양끝 포함 줄·0기준 occurrence를 검사합니다. 전체 관계 evidence는 원문에서 유일한 실제 연속 구절이어야 하고 두 끝점의 선택된 발생 위치가 그 안에 있어야 합니다. v3 기본/옛 읽기와 속성200·개체100·관계200·1MiB 한도를 유지하고 후보/속성 subject/provenance/전문가 정책 entity 참조를 넓히지 않습니다.

source_anchor는 원문표현 참조이며 개체 ID·특정 인스턴스·유형·실제 시험·사람 승인을 만들지 않습니다. 기존 workspace/r37/선상 sandbox와 병합하거나 이름·유형의 공통 개념 후보로 추가하지 않습니다. 기존 문자열 끝점의 정규화·중복 판정·claim_id는 유지하고 앵커는 문서/revision/정확 위치를 포함한 별도 키로 구별합니다. 현재 저장/조회는 실제 source SHA/위치·인용 포함을 재검증하고 source 변경은 stale/CAS·재추출/검토를 요구합니다. 오래된 앵커의 revision 교체·자동 구절 재매칭으로 재사용하지 않습니다. 옛 reader가 새 형식을 읽지 못하면 명시적으로 거부하며 가짜 entity ID나 조용한 생략으로 호환시키지 않습니다.

**원장 호환을 과거와 현재로 구분합니다.** 과거 이벤트는 이벤트 당시 source revision으로 구조/바인딩을 검사합니다. 옛 원문이 없는 구조 검사를 역사 인용의 실제 존재/의미 검증으로 과장하지 않으며 현재 원문으로 대체하지 않습니다. 기존 이벤트/원장 해시·원문/그래프 바이트를 다시 쓰지 않습니다. 현재 유효 주장/정책은 실제 현재 원문에서 다시 검증하고 새 C01 세대에 옛 승인을 자동 이식하지 않습니다. 채워진 합성 원장으로 재생·pending·검토/정책·되돌림/CAS/실패 보존을 시험한 것과 현재 운영 원장0의 불변 관측을 구분합니다. context/concept/대응 snapshot은 새 주장을 보존하고 앵커 선택을 entity lookup으로 넘기지 않으며 연결/영향의 기존 bounded 의미는 유지합니다.

**C01의 좁은 보완 성공과 넓은 미결.** 별도 개발 동료검토에서 정의의 asserted/문서 내 업로드 범위·법률 의미 배제, 능력의 enables/capability·육상 앱/개발자 환경/실행·테스트·해당 절의 검토 basis가 원문에 지지됐고 세 메타데이터 분리가 제출에 표현됐습니다. 두 주장은 positive·불명 context null/[]이며 환경 명칭으로 developer 관점을 부여하지 않았습니다. 실제 수행/성공·구현/법률 준수·서비스/책임 합의·인과 입증·사람 승인으로 승격하지 않았습니다. 기존 서비스/정책 등의2미표현 질문·추가 근거17결론과 앱이 scope 문자열이라는 한계를 유지합니다. 자동 형식/인용 검사나 같은 모델의 판정을 독립 실문서 정확도·전체 품질 승인으로 계산하지 않습니다.

운영에는 A안과357미검토·read13을 유지합니다. 격리에서만 전체358미검토와200속성 유지·비대상356값/ID·기존47정정/C02·172개체/5후보 보존을 확인했으며 새 검토/전문가 승인을 운영에 기록하지 않았습니다. 운영 반영·권한/설정 변경·UI 구현은 별도 요청 전 실행하지 않습니다. 격리 결과를 운영에 적용하려면 그 시점의 전체 원문/그래프/검토·5버전을 다시 대조하고 소비자 지원·전체 보존본·새 source/state CAS·최소 권한과 회수 절차를 별도 실행해야 합니다.

#### N1 C01 원문 앵커 끝점의 운영 반영 (2026-10-24)

사용자가 승인된 격리 구현과 C01 정정안을 운영에 적용하고 최소 쓰기 권한을 회수하도록 명시적으로 요청했습니다. 따라서 위 격리 기록의 운영 미반영 상태는 당시 기록으로 보존하고, 현재는 승인 runtime7파일과 선택된 portal의 v4 한 번 적용을 허용한 범위로 갱신합니다. 기본 v3와 속성200 한도는 유지하며 전체 그래프·검토5버전을 재확인한 뒤 source/state CAS를 사용했습니다. 옛 형식의 개체/claim_id·원장 해시는 다시 쓰지 않고 새 두 주장은 미검토로 남겼습니다.

임시 권한은 ontology_write만 부여하고 새 인증 SDK의 저장·조회 후 finally에서 원래 read 정책 바이트로 복원했습니다. 앱 read13과 원문/히스토리/검토·전문가 정책·대응 원장·UI는 바꾸지 않았습니다. 현재 빈 운영 원장의 보존과 채워진 합성 원장의 호환 시험은 구분합니다. 재현성 문제를 발견한 기존 시험의 입력 순서와 옛 reader 시험의 상대 fixture만 보완했으며 runtime 승인 바이트는 유지했습니다. 단계별 수치·실패·보존·잔여 검증은 [PLAN 운영 기록](PLAN.md#d-042-n1-c01-앵커-운영-반영조회권한-회수-2026-10-24) 한 곳에서 관리합니다.

소비자는 새 코드로 연결해야 합니다. 새 SDK 및 새 앱 하위세션은 v4/ready 조회를 통과했으나 기존 대화의 warm reader는 구형의 명시적 거부를 반환했습니다. 이를 실제 데이터 손상으로 바꿔 말하거나 자동 초기화·쓰기 재시도로 우회하지 않습니다. 개별 연결 reload 도구가 없고 앱 조작 도구의 접근 제한이 있으므로 다른 작업에 영향을 줄 host 전체 재시작이나 임의 IPC/PID 조작을 하지 않았습니다. 기존 연결을 다시 시작한 뒤 재조회할 때까지 그 항목은 대기로 기록합니다.

정의와 capability의 분리·메타데이터 보존은 실제 앱의 실행/성공, 실제 서비스·책임·정책 합의나 법률 준수의 증거가 아닙니다. 추가 근거·주변 미표현 질문·기존 지적의 재검토 상태와 출처/판본 범위를 유지합니다. 자동 검사 통과를 전체 의미 정확도·전문가 승인·남은 검증0으로 확대하지 않습니다.

#### N1 잔여 항목의 일괄 검증 범위 (2026-10-24)

사용자가 남은 검증을 한 번에 진행하도록 요청했습니다. 이번 한 단계는 현행 N1 원문·저장 주장의 일괄 재검토, 추가 근거와 미표현 질문의 현재 상태 대조, 연결 및 후속 검증의 실행 가능성 분류로 정합니다. 운영 정정·새 권한 부여나 미구현 제품 단계의 자동 착수로 확대하지 않습니다. 기존 원문·그래프·전체 원장·UI와 미검토/근거 대기 상태를 보존한 채 독립 작업을 병행합니다.

의미 재검토는 원문을 먼저 읽은 새 세션에서 질문·연속 인용·출처 SHA를 고정한 뒤 현재 주장만 전달합니다. 과거 판정과 후보 reason/question을 가리고 구조/인용 검사와 의미 판정을 분리하며, 불확실성과 필요한 후속 조치를 그대로 남깁니다. 기존 저장값의 선택 재검토이므로 새 수집·추출 세대의 blind 정확도나 외부 심사로 명명하지 않습니다. 검토 의견은 AI 분석이며 기존 unreviewed 상태나 실제 사람의 승인 원장을 바꾸지 않습니다. 반복된 조회의 바이트 일치는 LLM 반복 일관성·전문가 조정·새 판단 지속성 실험을 대신하지 않습니다.

추가 근거 목록의 과거 claim_id나 설명은 현행 판단으로 재사용하지 않고 현재 effective 값과 판본에 다시 연결합니다. 문서의 미합의·미논의·제안이 보존됐다는 확인과 실제 업무 합의·귀속·인증·구현 결론의 확정은 구분합니다. 조건부로만 필요한 후속 근거를 지금 당장 발생한 결함으로 세지 않으며, 확인하지 못한 참조를 조직 전체에 없는 자료로 확대하지 않습니다. 원문에 근거한 미표현 보고의 보완 가능성과 속성200·기존 값 보존을 만족하는 정정 경로의 구현/검증도 별개입니다.

새 앱 연결의 읽기 성공과 기존 대화의 warm 연결 상태는 따로 기록합니다. 지원되는 연결 갱신 표면이 없다는 이유로 임의 IPC/PID 종료·host 전체 재시작·이전 정책/legacy 저장소 우회를 실행하지 않습니다. 미구현 후속 수용조건은 선행 구현·실제 CLI/UI/PC·전문가 과제의 필요 여부를 목록화하되 미실행을 통과로 표시하지 않습니다. 결과와 분모·남은 상태는 [PLAN의 일괄 검증 기록](PLAN.md#d-042-n1-잔여-항목의-일괄-재검증-2026-10-24) 한 곳에서 관리하며 단위가 다른 목록을 하나의 검증 총수로 합산하지 않습니다.

#### N1 50개 보완안의 격리 작성·검증 (2026-10-25)

사용자가 원문 기반 보완50개를 일괄 작성하고 운영과 분리해 검증하도록 요청했습니다. 같은50개 안의 반복 인용 위치36개도 함께 보완하며 별도 대상 수로 더하지 않습니다. 운영 source/graph·전체 원장·UI·권한·연결 설정은 보존하고 기존 모듈의 임시 저장소로만 후보를 생성합니다. 운영 적용을 위한 쓰기 lease나 미래 단계의 구현은 이번 범위가 아닙니다.

기록된 이관/제거·처리 이력의 보고 양태와 실제 기능의 계획/가정을 구분합니다. 대상에서 원문이 지지하는 필드만 수정하고 모든 planned를 일괄 asserted로 바꾸지 않습니다. 복합 주장은 기재된 정의·기록과 제안·미래 필요를 분리하며 필요할 때 이미 구현된 명시적 v4 원문 앵커 관계를 사용합니다. 속성200·개체100을 넘기거나 비대상 값을 삭제/이관해 공간을 확보하지 않습니다. source_anchor는 정확한 원문 언급이며 새 실제 개체·사건·구현/시험·인증·합의·사람 승인 선언이 아닙니다. 약한 관련성과 정량 구조/대상 역할/참조 의무를 형식화한 수준은 구분해 한계로 남깁니다.

인용 위치는 실제 자기 요구사항 행을 구별하도록 고유 연속 구절을 사용합니다. 원문에 포함된 cell 제목과 본문을 함께 인용할 수 있으나1000자 한도와 실제 줄·원문 SHA를 지킵니다. 원문의 반복 문구가 다른 행에 존재한다는 확인을 자기 대상 인용으로 대신하지 않습니다. 비대상308주장과 기존 개체/후보·47정정·C02/C01은 보존하며 후보와 추가 근거 대기를 새 사실로 승격하지 않습니다.

원문·중립 스키마를 읽은 새 검토자가 질문/인용을 먼저 고정하고, 별도 새 생성자에게는 현재 전체 baseline과 제한된 대상 식별자·원문만 제공합니다. 생성자의 설명·기대 답·이전 점수·후보 reason/question은 의미 판정 입력에서 가리고 고정 뒤 별도 기록으로 연결합니다. 실제 저장/조회 결과를 포함한 구조·인용·CAS/실패 보존과 의미 지지·핵심 보존·남은 표현력 한계를 따로 판정합니다. 알려진 개발 원문의 보완이므로 새 blind 실문서 정확도·실제 전문가 승인으로 명명하지 않습니다. 수치·후보/운영 구분·실패와 보존·잔여 한계는 [PLAN의 이번 격리 기록](PLAN.md#d-042-n1-50개-보완안의-일괄-작성격리-검증-2026-10-25)에 기록합니다.

#### N1 부분4·누락5와 격리 v5 표현 (2026-10-25)

사용자가 직전 보완의 부분4범위와 원문 누락5질문을 함께 보완·격리 검증하도록 요청했습니다. 이 범위의 끝점 역할·캠페인별 다항 대응·참조/절차 필요를 기존 related_to의 문자열/인용에만 남기면 이전 표현 한계가 반복되므로, 운영 코드와 분리한 복사본에서만 명시적 schema_version=5를 구현했습니다. 기본3과 운영 v4의 전역 승격·제품 UI 적용·새 권한 부여 결정은 포함하지 않습니다. 정확한 제출/수치·실행 실패와 보존·넓은 원문 한계는 [PLAN의 이번9범위 기록](PLAN.md#d-042-n1-부분4누락5의-격리-보완검증-2026-10-25)이 담당합니다.

**최소 형식과 의미.** 새 관계 maps_to/targets/follows_reference/requires/includes_step/delivered_to/recommends만 추가합니다. maps_to에만 기존 같은 문서 entity ID를 가리키는 mapping.within 및 양끝 many/many를 허용해 캠페인 안의 패키지↔선박 대응을 표현합니다. within은 제3참조로 claim_id·문맥/개념 투영·대응 snapshot에서 빠뜨리지 않습니다. 임의 실제 할당/개별 수량을 만들거나 다대다를 전체 조합의 실제 관계로 추론하지 않습니다. 그 밖의 관계에 mapping을 붙이거나, 옛3/4 형식에 새 술어/mapping을 넣는 입력은 거부합니다. 옛 주장에 mapping:null을 일괄 주입해 ID/원장 계약을 바꾸지 않습니다. v4 원문 앵커의 정확 인용·발생 위치·source revision 바인딩과 속성/개체/관계/바이트 한도는 유지합니다.

**원문 기재와 업무 결론.** 사용 수단과 작업 대상, 이미 기재된 적용/전달 보고와 제안/미래 필요·권고, MLOps의 목표/역할을 각각의 실제 관계/속성과 한정어에 보존합니다. requires/includes_step은 원문의 planned 절차 필요 범위이며 법률 의무·시험 수행/성공·인증 취득을 자동 선언하지 않습니다. 전달 사실도 표준 준수나 최종 합의를 증명하지 않습니다. 진행률 숫자는 원문의 예시이며 실제 운영 통계가 아닙니다. 자동 학습/배포 지원/감시·트리거의 목표와 역할은 실제 구동·배포·드리프트 발생·재학습 결과로 승격하지 않습니다. 원문 앵커를 실제 객체/사건으로 자동 병합하지 않고 후보와 추가 근거 대기를 유지합니다.

**보존과 완료 경계.** 이전 격리 전체 baseline에서 지정 수정분만 교체하고 비대상 값/claim_id·전체 개체/후보·기존 정정/C02/C01을 보존합니다. 포탈 속성은 늘리거나 지지 사실을 지워 용량을 만들지 않습니다. 원문을 먼저 읽어 기준을 고정한 새 검토자와 별도 생성자의 입력을 분리하며 작성자의 설명·옛 점수·후보 이유/질문은 판정 후 연결합니다. 지정 보완 범위의 완성과 원문 행 전체의 핵심 보존·더 넓은 누락은 별도 판정으로 기록합니다. 넓은 발견을 이번 작업의 자동 추가 범위로 만들거나 전체 의미 품질/외부 인증·사람 승인으로 확대하지 않습니다.

실제 원문 기반 임시 저장/조회·실패 보존과 합성 자료의 전체 회귀/채워진 원장 호환, 별도 원문 의미 검토를 수행했습니다. 운영의 빈 원장 불변을 채워진 운영 판단 재사용으로 과장하지 않습니다. 운영 원문·전체 이력·그래프·검토/전문가 정책/대응 원장·권한/연결·UI와 미검토 상태는 그대로이며, 실제 운영 반영·권한 변경은 별도 요청 전 실행하지 않습니다.

#### N1 남은 원문 누락의 격리 보완과 원문 보존 경계 (2026-10-25)

사용자가 직전 기록에 남긴 원문 누락의 일괄 보완·격리 검증을 요청했습니다. 같은 선정 원문 행의 중요한 누락을 실제 값/관계/한정어에 보완하고, 운영에 미반영한 이전 전체 후보를 baseline으로 이어갑니다. 기존 격리 v5로 표현할 수 있으므로 runtime/스키마/추출 프롬프트를 새로 바꾸지 않습니다. 정확한 범위·제출/판정 hash·실행/실패·보존 수치와 남은 표현 수준은 [PLAN의 이번 기록](PLAN.md#d-042-n1-원문-누락8그룹의-일괄-보완격리-검증-2026-10-25)에 둡니다.

**용량과 기존 의미를 함께 유지합니다.** 포탈의 기존 속성을 실제 연속 원문 값으로 최소 확장하고 원래 값을 그대로 남기며, 그 속성의 주체·식별자·양태·맥락·출처는 유지합니다. 과정/활동·원문에 명시된 연계·조건부 필요·후속 설계·소관 부정은 기존 술어로 구분하고 evidence에만 새 뜻을 붙여 성공 처리하지 않습니다. 지지 사실 삭제·다른 문서 이관·개체 추가·한도 확대로 용량을 만들지 않습니다. 자유 text의 별도 절을 보존하는 것과 절마다 독립 질의/추론을 구현하는 수준은 구분합니다. 문장의 배제 부정이나 가능/논의 중을 실제 권한·부재 확정·대안 채택·기능 수행/성공으로 바꾸지 않습니다. 심사 범위 조건의 필요는 원문 취득 목표 범위이며 일반적 법률 의무나 취득 승인으로 확대하지 않습니다.

**완료 판정의 분모를 고정합니다.** 새 검토자가 원문에서 질문을 먼저 고정하고 별도 작성자에게 기준/옛 점수/기대 답을 주지 않습니다. 고정 결과의 핵심 누락 보완, 보조 이력·메타데이터의 그래프 부분 보존, 원문 자체의 전체 보존을 별도 기록합니다. 형식 통과·인용 존재를 의미 완전성으로 세지 않고 이전 평가의 점수를 새 기준으로 덮지 않습니다. 남겨 둔 보조/메타 질문을 원래 중요 누락 목록과 단순 합산해 새 검증 총수로 만들지 않으며 문서 전체의 무손실 모델링·LLM 반복 일관성·외부 전문가 승인으로 일반화하지 않습니다.

**조회 메타데이터와 승인 상태.** 저장 조회가 원시 evidence를 줄 위치가 붙은 wrapper로 반환하고 후보에 needs_review를 붙이는 관측을 원시 제출과 구분합니다. 엄격 JSON 모양의 차이와 원래 주장 값/인용/한정어의 동일 여부를 각각 보고하며 원시 자료를 재작성하지 않습니다. 후보의 서버 상태는 사람 승인이나 근거 관계 승격이 아닙니다. 실제 임시 저장/조회·실패 보존·이전 후보의 새 세대 복구와 합성 집중 회귀를 수행하되, 운영 원문/그래프·전체 이력·검토/전문가 정책/대응 원장·UI·읽기 권한과 업무 추가 근거 대기는 유지합니다. 운영 반영·권한 변경은 이번에 실행하지 않습니다.

#### N1 보조이력3·메타데이터7의 출처 관계와 고정 완료 범위 (2026-10-25)

사용자가 직전 기록의 보조 이력/메타 항목을 일괄 보완하도록 요청하면서 검증이 계속 늘어나는 문제를 지적했습니다. 이번에는 요청한 item_id·원문 fragment와 완료 조건을 먼저 고정하고 같은 항목 안의 세부 검사/코드 회귀 수와 완료 대상을 분리합니다. 범위 밖 발견을 자동으로 새 필수 완료 조건으로 넣거나 원래 총수에 합산하지 않습니다. 각 항목의 완료·부분·표현 한계를 한 표로 확정하고 그 단계에서 종료합니다. 정확한 수·판정/제출 hash·실제 시험·실패·미실행 범위는 [PLAN의 고정10항목 기록](PLAN.md#d-042-n1-보조이력3메타데이터7의-고정10항목-보완격리-검증-2026-10-25)에 둡니다.

**기존 속성/주장을 보존하는 출처 모델.** 기존 전체 후보를 그대로 두고, 격리 사본의 명시적 schema_version=6에서 has_source_metadata/has_source_history 두 관계만 추가합니다. 기존 같은 문서 EntityId가 정확한 source_anchor fragment를 참조하며, 새 collection/endpoint 형식/업무 속성/개체는 만들지 않습니다. 이들은 업무 관계나 추가 도메인 속성을 이름만 바꾸어 넣는 것이 아니라 문서상의 literal 기재·연혁의 출처 연결입니다. 관계 한도와 인용/문서 제한에도 그대로 포함합니다. 기존 문자열/앵커·mapping·형식3/4/5·값/ID·원장 해시/이벤트·기본3을 보존하고 새 관계는 구형 형식/후보/전문가 정책에서 거부합니다.

**기록 존재와 기록 내용의 사실 지위를 구분합니다.** 새 관계의 positive/asserted는 이 원문에 해당 메타/이력이 기재됐다는 뜻입니다. 조건/범위/시점은 null이고 당시 날짜·발언 귀속·이해·질문·미결은 인용 그대로 남습니다. 과거의 질문/가정을 현재 구현 사실로 만들지 않고 source_history를 이 시스템의 review/policy Action log로 쓰지 않습니다. 문서 수용/결정/TBD나 원문 인물의 발언은 시스템 권한·사람 승인·업무 합의/인증 완료가 아닙니다. source revision/정확 줄/인용 발생 위치를 바꾸어 옛 추출을 재사용하지 않으며 변경 시 stale/CAS·재추출·미검토 경계를 유지합니다.

**완료와 보류의 분리.** 별도 원문 우선 검토자는 고정한 같은 항목과 하위 기준만 판정하며 생성자 설명/옛 점수/기대 답을 보지 않습니다. 실제 임시 저장/조회·기존 값/CID·실패 보존·새 세대 복구와 코드 호환은 의미 판정과 별도로 확인합니다. literal/이력의 출처 보존 완료를 모든 셀/날짜/화자의 독립 업무 유형화나 외부 품질 인증으로 확대하지 않습니다. 기존 원문·전체 이력·검토/전문가 판단·대응 원장·UI·운영 코드/설정·미검토와 추가 근거 대기를 보존합니다. 운영 반영·권한 변경 및 다음 단계는 별도 요청 전 실행하지 않습니다.

#### 남은 모든 구분의 검증과 실제 완료의 경계 (2026-10-25)

사용자의 모든 잔여 구분 검증 요청을 원문 표현, 실제 업무 근거, 운영 연계, 제품/실환경/실제 전문가의 네 범주로 고정합니다. 실행할 수 있는 검증은 실제 수행하고, 근거/구현/사람이 없거나 운영 보류 중인 부분은 그 이유와 필요한 입력을 기록합니다. 전수 현황 확인·문서 대조·복사본 예행을 전체 기능/업무 검증 완료로 확대하지 않으며 단위가 겹치는 항목/계획/회귀 수를 하나의 총잔여로 합산하지 않습니다. 세부 결과와 판정/실행 근거는 [PLAN의 이번 네 구분 기록](PLAN.md#d-042-남은-모든-구분의-검증선행조건-전수-확인-2026-10-25)이 담당합니다.

**기존401을 보존하는 원문 보완.** 기존 동결 v6의 관계/한정어/출처 모델로 같은 row41의 M18/M19를 추가하고 기존 배열/ID/속성 한도와 미검토·근거 대기를 유지합니다. 서비스 제공 조건은 실제 호출/결과 존재와 구분하고, 우리의 미합의 의견·아이디어·예시·남은 정책/조사/제공 여부를 확정 책임/정책/구현으로 바꾸지 않습니다. 원문 기재 링크는 배경/귀속 보존이며 조건부 업무 행위는 별도 관계의 실제 한정어에 둡니다. 새 entity/attribute/candidate·스키마/코드 변경 없이 source expression의 별도 의미 검토와 실제 임시 저장을 확인합니다.

**자료와 사람을 대체하지 않습니다.** 현재 원문에 미결이 적혔음을 확인한 결과와 실제 미결을 해소한 업무 결론은 다릅니다. 조건부 후속은 해당 변경을 주장할 때 필요한 근거이며 전부 현재 오류가 아닙니다. 실제 참조 원본/판본·담당자 답변·실제 사람 검토가 없으면 AI가 만든 답이나 일반 표준 지식으로 승인/결론을 채우지 않습니다. 압축 구조·문자열 인벤토리 확인과 전체 원본 의미/참조의 검증도 구분합니다. 현재 tenant 밖 자료를 먼저 읽거나 정책/legacy 경로로 우회하지 않습니다.

**보류·선행 구현·형식 호환의 경계.** 기존 운영 반영/권한 변경 보류는 일반적인 모든 검증 요청만으로 취소하지 않습니다. 실제 데이터의 private 복사본에서 새 reader 호환·CAS 적용·새 세대 복구를 확인하되 실제 운영 적용과 적용 후 새 소비자의 확인은 별도 상태로 둡니다. 없는 FastAPI/Electron/CLI/공통 규약 기능을 모의 실행/문서 검사로 통과 처리하지 않고, 필요한 제품 구현 범위와 실제 기기/사람의 실행 전제를 명시합니다. 현재 문서 계약의 고유 ID를 고정하며 새 계획 개정/별도 Rule 정의를 무심코 더해 잔여를 늘리지 않습니다. 이 작업으로 운영 데이터·원장·UI·실제 권한/설정은 바꾸지 않고 기존 미검토·추가 근거 대기를 유지합니다.

#### 구현 이후 검증으로 이관한 항목의 재개 조건 (2026-10-25)

사용자는 현재 추가 근거 자료가 없으며, 구현이 필요한 검증은 따로 분류해 구현된 뒤 검증하도록 요청했습니다. 이번 작업은 분류와 재개 조건 정리로 한정하고 제품 구현을 자동 착수하지 않습니다. 업무 근거/실제 사람 검토는 새 자료·명시 판단을 기다리는 상태를 유지합니다. 자료가 조직 전체에 없다고 단정하거나 이 답변을 업무 결론·전문가 승인으로 기록하지 않습니다.

구현 의존 검증은 기존 ID/수용 조건을 유지한 별도 대기 목록으로 관리하며, 현재 수행한 검증의 잔여 총수나 실패로 합산하지 않습니다. 해당 기능의 구현 요청을 수행할 때 관련 검증 ID·환경·정상/실패 조건을 구현 완료 기준에 포함하고 실제 실행 결과를 함께 기록합니다. 선행 구현이 준비됐다는 사실만으로 통과 처리하지 않으며, 실제 기기/CLI/사람이 필요한 조건은 그대로 유지합니다. Q1의 독립 준비/검증은 R1 등록 구현 때문에 막지 않고 각 구현 범위의 가능한 검사는 먼저 수행합니다.

현재 대기 목록·시작 조건의 단일 원본은 [PLAN의 구현 후 검증 대기 목록](PLAN.md#구현-후-실행할-검증-대기-목록)입니다. 이전 전수 실사/판정/manifest는 당시 기록으로 보존하고 이번 사용자 답변은 새 분류 근거로 연결합니다. 기존 운영 반영·권한 변경 보류와 데이터·원장·UI·미검토 상태는 유지하며 이 분류 작업에서 기능 구현·운영 검증을 실행한 것으로 표시하지 않습니다.

#### 최신422 보완안의 운영 적용과 연결별 확인 (2026-10-25)

사용자가 검증된 최신422주장 보완안의 실제 적용·조회와 최소 쓰기 권한의 임시 적용/회수를 명시 승인했습니다. 그 전의 운영 보류는 이 보완안에 한해 해제하며 업무 근거17·실제 사람 검토·미구현 제품61 검증의 대기는 유지합니다. 기존358과 원장/원문/전체 이력은 독립 복구본·바이트 보존으로 보호하고 고정422의 의미 값을 재작성하거나 검토 승인으로 바꾸지 않습니다.

v6 형식의 검증안을 읽고 저장하려면 검증된 reader/저장 코드5파일이 필요하므로 동결 바이트를 그대로 승격합니다. 기존시험2·새시험5·불변 reader fixture2도 같은 검증 버전으로 반영하고 실제636회귀를 통과한 뒤 저장합니다. 기존 인증 launcher/토큰/앱 read13은 유지하고 정책의 ontology_write만 실제 저장 구간에 일시 적용합니다. 변경 문서인 포탈·MLOps만 원문/state CAS로 단회 저장하고 overview는 무제출로 보존합니다. 성공/응답 불명/정리 경고 뒤 자동 재전송하지 않고 finally 회수와 원래 정책 바이트를 확인합니다.

새 SDK/새 앱의422 전체 배열/CID·미검토·원문/복합버전·선택맥락 확인과 기존 부모 연결의 구형 reader 캐시를 구분합니다. 옛 연결의 두 문서는 정상 재연결이 필요하며 프로세스 강제 종료/설정 우회를 하지 않습니다. 영향 API의 과거 파생 그래프 복원 불가와 private backup의 실제 보존도 별개로 보고합니다. 적용/조회 완료를 실제 전문가 승인·추가 근거 해소·전체 제품 완료로 승격하지 않으며 세부 실행과 연결 범위는 [PLAN의 최신422 운영 기록](PLAN.md#d-042-최신422주장-운영-반영조회권한-회수-2026-10-25)을 따릅니다.

#### 최초 자료 미제공 당시의 후보 확인 (2026-10-24)

다음은 원본 제공 전의 확인 기록입니다. 당시 범위는 프로젝트의 기존 파일 목록과 사용자가 밝힌 자료 보유 여부였습니다. 문서/텍스트는 README·AGENTS·PLAN·DECISIONS·poc-step과 requirements뿐이었고 별도의 업무 원본 후보는 **0개**였습니다. 운영 원본·원격 시험 자료·백업·합성 평가를 실제 업무 원본으로 대신하지 않았고 다른 개인 폴더 전체를 조사했다고 기록하지 않습니다.

| 준비 항목 | 당시 확인 결과 |
| --- | --- |
| 실제 문서명·원본 경로 | 미제공: 현재 프로젝트에서 적합 후보를 확보하지 못했으며 다른 위치의 원본 존재/범위는 미확인 |
| 판본·원본 SHA-256 | 미확보: 파일 수정일·예문·프로젝트 버전으로 대신하지 않음 |
| 등록할 전체 본문·본문 hash | 미준비: 존재하지 않는 원문을 AI로 작성하거나 요약해 채우지 않음 |
| 위키 목적 경로 | 미확정: 원본·문서 역할이 정해진 뒤 신규 경로를 확인하며 placeholder를 실제 경로로 기록하지 않음 |
| 문서 종류 권고 | 요건정의서 우선, 필요할 때 관련 아키텍처 설계서 추가. 요건정의서 없이 RFP만 있다면 RFP로 시작 가능. 실제 어느 파일도 아직 선택·준비하지 않음 |

이 시점에는 보유 업무 문서 기준의 실제 본문 준비를 완료로 표시하지 않았습니다. 이후 사용자 원본 N1을 제공받아 위 범위를 준비했습니다. 공개 문서 또는 이 프로젝트 요구사항을 사용하는 연습안은 채택하지 않았으며 아래 기존 프로젝트 자료 제외 범위도 유지합니다. 자료 종류 안내 자체가 등록·쓰기 권한 적용을 허용하지 않습니다.

#### 제공하면 좋은 문서 종류

| 문서 종류 | 첫 후보에서 확인할 내용 | 사용 시 구분할 상태 |
| --- | --- | --- |
| 요건정의서, 우선 권고 | 하나의 기능에서 업무 용어·대상/행위자·처리 조건·행동·권한·예외가 함께 있는 부분 | 요구하는 동작과 이미 운영/구현된 동작을 구분. 초안도 가능하나 판본·초안 상태를 표시 |
| 아키텍처 설계서, 관련 시 추가 | 선택한 기능의 서비스/시스템 경계·책임·데이터·연결 흐름과 용어 정의 | 계획/제안 구조와 적용된 구조를 구분. 기술 구성만으로 업무 조건·용어 동치·접근 권한을 추정하지 않음 |
| RFP, 요건정의서가 없을 때도 가능 | 발주/사업 목적·업무 요구·대상 범위·제약·인수 조건 | 발주 요구와 수주 제안·합의된 요건·구현 완료 사실을 구분. 요청된 기능을 운영 사실로 승격하지 않음 |
| 용어집·업무 절차서, 이미 있으면 참조 | 위 자료의 필수 정의·수량/단위·조건·예외를 보충하는 기존 원문 | 첫 묶음의 R2/R3에 필요한 것만 선택하며 새 문서 작성을 요구하지 않음 |

새 문서를 작성할 필요는 없습니다. 먼저 현재 보유한 위 종류 중 **파일1개 또는 문서 링크1개**를 확인하고, 그 안에서 조건·처리·예외가 포함된 **한 기능의 완결된 범위**를 고릅니다. 요건정의서에 필요한 정의·예외가 모두 있으면 그것만으로 시작하며 RFP·설계서를 일괄 필수로 받지 않습니다. 원본이 길면 제목/목차/판본부터 확인한 뒤 관련 정의·참조·표·각주를 포함한 범위를 정하며, 임의 페이지 수나 분량에 맞춰 내용을 자르지 않습니다. 문서 종류의 우선순위는 추천이며 실제 본문의 적합성과 원문 확보를 대신하지 않습니다.

#### 첫 묶음의 자료와 목적

첫 질문은 **“이 업무 문서에서 어떤 상태·조건일 때 어떤 처리를 하며, 적용 범위·예외와 확인되지 않은 연결은 무엇인가?”**로 좁힙니다. 처음부터 업무 폴더 전체를 수집하지 않고 한 업무 흐름의 **기본 1문서, 필수 정의·예외를 더해 최대 3문서**를 제안합니다. 작은 묶음에서 원문 보존과 출처 추적을 직접 확인한 뒤 범위를 늘리기 위한 선택이며 서버의 문서 수 제한은 아닙니다.

| 역할 | 우선 선정할 실제 자료 | 등록 범위와 제외 조건 |
| --- | --- | --- |
| R1 주 문서, 필수 1개 | 담당자가 실제 사용하는 운영 기준·처리 절차 중 상태/조건과 처리 행위가 함께 있는 문서 | 하나의 현행 판본 전체. 제목·정의·표·각주·예외·기간을 함께 보존하며 AI 요약이나 시안의 예문으로 대체하지 않음 |
| R2 정의, 필요 시 1개 | R1이 참조하는 핵심 용어·수량·단위·식별 범위의 실제 정의 문서 | R1 자체에 충분하면 추가하지 않음. 같은 용어 이름만으로 다른 업무의 정의를 채택하지 않음 |
| R3 예외·연결 근거, 필요 시 1개 | R1/R2의 적용 제외·특수 운영·조건→개념 연결을 명시하는 실제 문서 | 실제 존재하고 필요한 경우에만 포함. 정의/연결을 못 찾으면 미확정으로 남기며 새 업무 기준을 대신 작성하지 않음 |

역할 둘 이상을 한 원본이 충족하면 한 문서로 등록합니다. 실제 필수 참조가 셋을 넘으면 누락을 숨기지 말고 더 작은 질문/완결된 업무 단위로 다시 선정하거나 다음 묶음의 범위를 정합니다. 자료 등록은 가능해도 필요한 정의·예외가 빠진 상태에서 업무 판단의 완결성을 선언하지 않습니다. 기존 ‘재고·매진 임박’은 역할 설명용 PoC 사례이며 실제 업무 분야·수치·정책으로 채택하지 않습니다. `evals/`의 합성 입력, UI 시안, 원격 시험 자료와 프로젝트 결정 기록은 이번 실자료 묶음에 편입하지 않습니다.

선정 기준은 담당자가 원본과 현재 사용 판본을 식별할 수 있고, 한정된 업무 질문에 유용하며, 그 tenant의 읽기 범위에 맞는 자료입니다. 현행성·적용 채널·조직·기간이 불명확하면 미확인으로 기록합니다. 수정일이 가장 늦다는 이유만으로 권위나 정책 대체를 추정하지 않습니다. 현재 `all` 프로필은 비밀 분리 수단이 아니므로 문서 일부를 다른 관점에만 숨겨야 하는 자료는 이 등록안의 대상으로 고르지 않습니다.

#### 등록 전 확정할 표와 원문 보존

다음 항목을 **등록할 정확한 문서와 본문을 보여주는 작업 입력표**로 채웁니다. N1의 실제 확인값은 위 비공개 준비 기록에 두며 민감한 경로·본문은 공개 결정 문서에 넣지 않습니다. 기존 D-041 비공개 작업 기록 방식에 자료별 목록과 영수증을 덧붙이는 방향이고, 새 등록 DB·MCP 입력 필드·등록 힌트 기능을 구현하지 않습니다.

| 입력 | 확정할 내용 |
| --- | --- |
| 업무 질문·묶음 | 하나의 질문, R1/R2/R3의 실제 파일 대응, 포함·제외 이유와 빠진 필수 참조 |
| 원본과 귀속 | 실제 문서명·원본 경로 또는 안정된 문서 ID·관리 주체, `personal`에 등록할 범위 |
| 판본과 적용 | 원본의 판본/발행·개정 시각과 관측 시각, 업무 영역·채널·기간·대체 관계. 원문에 없는 값은 미확인 |
| 내용과 변환 | 원본 파일 SHA-256·형식·선택 범위, 등록할 UTF-8 본문 SHA-256·바이트 수와 변환 여부 |
| 목적 경로 | `business/<업무 식별값>/rules.md` 및 필요한 `definitions.md`·`exceptions.md`를 후보로 하고 실제 경로는 미확정. 같은 원본/같은 판본은 중복 등록하지 않음 |
| 쓰기와 확인 | 대상 존재 여부·기준 revision, 예정 전체 본문, 완료 시 반환 revision/changed/history_path/cleanup_failures와 읽기 확인 결과 |

첫 후보는 그대로 대조하기 쉬운 UTF-8 Markdown/텍스트를 우선합니다. 등록 본문은 원본의 선택한 전체 문서 바이트를 유지하고 확장자만 `.md`로 정할 수 있습니다. 문서가 이미 크기 한도에 맞으면 제목·메타정보를 덧붙이거나 줄바꿈/Unicode를 정규화하지 않습니다. 원본 출처와 등록 준비 메모는 위 작업 입력표에서 구분하며 원문 인용이나 전문가 판단의 근거로 승격하지 않습니다. 등록 후 서버가 반환한 위키 revision은 등록 본문의 hash이며 외부 원본의 판본 ID나 변환 전 파일 hash와 구분합니다.

PDF·Word·스캔·복잡한 표는 첫 실행에서 조용히 텍스트로 바꾸지 않습니다. 해당 자료를 선택하면 **등록 전 본문 준비**를 별도 작업으로 정해 원본 파일을 보존하고 페이지/절/표·각주 대응과 본문 차이를 확인합니다. 변환 전후 hash·선택 범위를 구분하고 읽지 못한 표·그림을 누락 없음으로 기록하지 않습니다. 문서당 UTF-8 **1 MiB**를 넘으면 자르지 않으며, 독립적으로 의미가 완결된 절을 선택할 경우 범위·제외 부분·참조를 먼저 확정합니다. 실제 원본 확보·변환·본문 준비도 이번에는 실행하지 않습니다.

원본 파일은 이동·덮어쓰기·삭제하지 않고 기존 운영 원본 `data/`, 원격 시험 자료·백업을 새 등록 입력으로 사용하지 않습니다. 등록은 D-041의 유일한 운영 tenant 아래 `wiki/`에 기존 `wiki_write`→`WikiStore.save()`로만 수행합니다. `_history/`, `_ontology/`, `_reviews/` 및 대응 원장에 직접 파일을 만들거나 기존 ID·actor·tenant·이벤트·hash를 재작성하지 않습니다. 신규 원문만 등록한 상태에서는 그래프 없음·미검토가 정상이며 내용 저장을 사람의 수용이나 업무 정책 확정으로 표시하지 않습니다.

#### 필요한 최소 권한과 실제 권한 범위

현재 권한과 실제 연결은 **read·조회 13개**입니다. 이번 실제 등록 요청에서는 아래 P1과 P2를 순차 적용하고 매 단계 직후 read13으로 회수했습니다. 토큰·주체·tenant·관점·런처 경로는 유지했습니다. 임시 정책/allowlist 적용과 실제 호출 표면은 다음 실행 기록을 따릅니다.

| 후속 작업 | 서버 소속 권한 | 현재 read13에 대한 도구 차이 | 완료 경계 |
| --- | --- | --- | --- |
| 현재 설계·원본 선정/읽기 점검 | `read` | 추가 없음, 13개 | 원문 쓰기 불가 유지 |
| P1 최초 원문 등록 | `read`, `write` | `wiki_write`만 추가, 총 14개 | 선택한 신규 경로의 전체 본문 저장·읽기 대조까지. 추출/검토/정책 저장은 포함하지 않음 |
| P1 종료 후 조회 | `read` | `wiki_write` 제거, 다시 13개 | 최신 정책에서 write를 회수하며 자료·이력은 보존 |
| P2 별도 AI 추출 저장 | `read`, `ontology_write` | read13 + `ontology_generate`, 총 14개 | 원문 수정이 끝났다면 `write`는 회수. 기존 원문 전체와 최신 revision에서 추출하고 미검토 상태로 조회 |
| 두 작업을 함께 요청한 경우만 | `read`, `write`, `ontology_write` | read13 + 위 두 도구, 총 15개 | 실제로 원문 수정과 추출이 모두 필요한 경우만 사용하며 기본안으로 삼지 않음 |

P1에는 `ontology_write`, `ontology_review`, `ontology_policy`가 필요 없습니다. 대응 제안 저장·수용/거절·전문가 업무 판단·undo도 첫 등록에 포함하지 않습니다. 이후 원문 근거 정정/전문가 판단이 실제 요청되면 D-028/031/038의 별도 권한과 새 상태 기준을 사용하며 기존 승인을 이식하지 않습니다.

현재 서버의 `write`는 **tenant 전체 원문 생성·수정 권한**이며 문서/폴더별 ACL, 신규 생성 전용 권한, 사용 횟수·자동 만료 제한은 없습니다. 위 1~3문서 목록과 “신규만”은 작업 범위이고 서버가 강제하는 제한이라고 표현하지 않습니다. `expected_revision=null`은 한 호출의 신규 생성 CAS이지 계정의 create-only 권한이 아닙니다. `ontology_write`는 tenant 전체 문서 그래프의 생성·전체 교체와 `ontology_correspondence_propose`를 허용합니다. 이를 client allowlist에서 숨겨도 토큰의 서버 권한이 해당 행위를 금지하는 것은 아닙니다. 생성만 허용하는 강제 권한이 필요하면 별도 권한 모델 설계가 필요하며 이번 범위에서 추가하지 않습니다.

후속 권한 적용은 기존 사용자·tenant·토큰과 `all` 관점을 유지하고 최신 정책/설정의 기준 hash를 재확인해 해당 소속과 도구 차이만 반영합니다. 완료뿐 아니라 부분 실패·취소·결과 불명확으로 중단할 때도 진행 중 호출의 상태를 확인하고 이번 작업에서 추가한 권한(P1의 write, P2의 ontology_write)과 해당 변경 도구를 회수해 read13으로 복귀합니다. 결과를 확인할 수 없으면 미확정 상태를 보존하고 회수/유지보수 조치를 따로 기록합니다. 회수 때 옛 정책 파일을 통째 복원하여 다른 소속·회수·토큰 회전을 되살리지 않습니다. 실제 적용 전/후 `access_context`, 실제 노출 목록과 호출 결과를 확인합니다. 작업 종료 회수는 운영 절차이며 서버의 자동 TTL이 아닙니다. 이미 승인된 실행 중 저장을 권한 회수로 취소했다고 간주하지 않습니다. D-041의 연결/쓰기 준비 상태는 실제 후속 검증 전까지 바꾸지 않습니다.

#### 후속 실행 순서와 부분 완료

1. 자료 입력표와 정확한 등록 본문을 확정합니다. 하나의 업무 질문·최대 3개의 실제 파일·출처/판본/조건/예외·목적 경로가 검토 가능한 상태여야 합니다. 등록 설계를 자료/권한 변경 요청으로 해석하지 않습니다.
2. 새 세션은 `access_context`로 허용 tenant/관점을 재확인하고 관련 자료를 검색합니다. 검색의 `skipped/truncated`를 확인하며 검색 결과 없음만으로 경로 부재를 선언하지 않습니다. **각 예정 경로를 `wiki_read`해 명시적인 `not_found`를 확인**하고, 다른 오류는 부재로 취급하지 않습니다. 이미 있으면 신규 등록을 멈추고 본문·revision·중복 원본을 대조합니다. 기존 문서 수정은 별도 범위이며 이 단계에서 revision만 바꿔 덮어쓰지 않습니다.
3. 기존 읽기 연결·단일 tenant 서비스 경로·원본/전체 이력/원장 보존 기준을 확인하고, 선택한 P1 권한 차이만 준비합니다. 실제 운영 적용 전 아래 격리 검증을 수행하고 허용된 실행 표면에서 최소 권한을 확인합니다.
4. R1부터 한 문서씩 `tenant=personal`, 상대 `.md` 경로·정확한 전체 `content`·명시적인 `expected_revision=null`로 신규 저장합니다. 각 성공 직후 같은 경로를 읽어 본문 바이트/반환 revision을 대조한 뒤 다음 문서로 진행합니다. 여러 문서를 하나의 원자 거래로 취급하지 않습니다. 저장한 문서는 그때부터 조회 가능하며, 미완료 묶음의 자동 비노출 기능은 없습니다. 부분 실패 시 업무 답변의 전체 범위 확인을 멈추고 부족한 자료를 밝힙니다.
5. 작업 기록은 문서별 **미시도·저장 성공/읽기 확인·실패·결과 확인 불가**를 구분합니다. 성공 응답과 `access`의 주체/tenant/policy revision, 기준/결과 revision·정리 경고를 남기되 토큰과 본문을 공개 로그에 넣지 않습니다. 원문 히스토리는 actor 감사 원장이 아니며 이 영수증을 전문가 Action log나 사람이 직접 승인했다는 증명으로 과장하지 않습니다.
6. 선택 원문이 읽기까지 확인되면 **원문 등록 완료**로만 기록하고 write를 최신 정책에서 회수해 read13과 거부를 확인합니다. 그래프 없음·미검토와 누락된 참조를 보고합니다. AI 추출 저장·대응 판단·업무 정책·제품 UI는 다음 명시 작업으로 둡니다.
7. P2를 요청받은 경우에만 각 문서를 다시 읽어 전체 원문에서 추출합니다. graph/검토 원장이 이미 있으면 최신 원문과 검토 상태를 함께 확인하고 `expected_revision`·필요한 `expected_state_revision`을 사용합니다. 성공 후 `ontology_review_query`의 effective_graph/policies/미검토·pending을 읽습니다. 개념은 find의 버전 있는 대상을 명시 선택해 query하고, 필요한 정의/예외 문서를 함께 지정하며 미검토·partial·출처를 보존합니다. 등록한 일부나 조회 focus를 전체 그래프 입력으로 재전송하지 않습니다.

#### 충돌·실패·되돌림의 경계

| 상태 | 후속 처리와 보존 |
| --- | --- |
| 신규 경로 경쟁/기존 경로 발견 | `expected_revision=null`의 conflict를 유지. 최신 본문·원본 대응을 대조하며 자동 다른 이름 생성이나 기존 revision으로의 단순 교체를 하지 않음 |
| `storage_busy` | 같은 본문·같은 기준으로 나중에 재시도 가능. 충돌과 구분하고 기준을 바꾸지 않음 |
| 저장 예외·이력 보존 실패 | 기존 원문·전체 이력·원장을 유지하고 원래 실패와 정리 오류를 구분. 이미 공개된 전체 history가 남더라도 삭제하지 않음 |
| 저장 성공 + `cleanup_failures` | 저장 완료로 기록하고 읽기 확인. 임시 파일 정리 때문에 같은 쓰기를 재전송하지 않음 |
| 응답 유실/후속 읽기 실패 | 추가 쓰기를 멈추고 같은 tenant의 해당 경로를 재조회. 예정 hash와 같아도 관측된 상태로만 기록하며 이 요청의 작성 주체/성공 영수증을 발명하지 않음. 다르거나 불명확하면 최신 본문·기록을 대조한 뒤 다음 작업을 정함 |
| 묶음 도중 실패 | 성공한 문서는 그대로 보존하고 나머지 실패/미시도를 보고. 전체 재등록·이미 성공한 원문 저장 재시도·묶음 자동 rollback 없음 |
| 등록 취소·잘못된 등록 | 신규 생성에는 이전 파일이 없어 `history_path=null`. 현재 delete/원문 undo/history-read MCP가 없으므로 생성 전 부재 복원을 약속하지 않고, 자동 삭제·빈 본문 저장·옛 데이터셋 덮어쓰기를 하지 않음. 쓰기를 멈추고 필요 시 최신 원문 CAS로 정정하거나 검증된 보존본을 새 버전으로 반영하는 별도 요청을 받음 |

원문 정정은 최신 `wiki_read` 본문/revision에서 재작성하고 `WikiStore.save()`로 이전 전체 파일을 보존합니다. 과거 내용 복구도 오래된 revision으로 재전송하지 않고 최신 기준에 새 버전을 남기는 별도 작업입니다. 실제 과거 내용의 확보는 현재 MCP에 history-read가 없으므로 권한 있는 운영자의 검증된 보존 자료가 필요합니다. 이미 성공한 원문 저장 뒤 추출/영향 조회가 실패해도 원문 저장을 반복하지 않습니다. 원장 되돌림은 D-028/031/038의 새 역이벤트를 사용하며 원본·검토·대응 원장의 파일 삭제나 history 초기화로 대신하지 않습니다.

설계·원본 N1 준비 뒤 사용자 요청으로 표 원문3문서의 등록·AI 부분 추출·현재 앱 읽기 조회와 임시 쓰기 회수까지 수행했습니다. 추가 승인 후 분리 세션 의미 평가도 완료했으나 조건 손실·모호함·누락이 남아 미검토를 유지하며 전문가 판단은 기록하지 않았습니다. 그림 배치·미제공 외부 참조·전체 그래프 의미 완전성도 미확인/부분입니다. 기능 검증과 의미 한계는 [PLAN](PLAN.md#첫-업무-자료-등록의-검증-범위)과 위 별도 평가 기록을 따릅니다.

### D-043 — 원격 문서 등록과 개인 CLI 분석·MCP 저장·UI 결과 연결 (2026-10-24)

상태: **사용자가 합의한 흐름의 상세 설계와 R1 첫 읽기·원본 등록 구현**입니다. Electron 내부 터미널의 로그인된 CLI를 유지하며, **Electron은 일반 HTTP API로 원본을 업로드하고 목록·결과를 조회하고, 개인 CLI는 MCP로 공통 지침·파일 참조를 받아 파일을 읽고 본문·온톨로지를 추출해 저장**하는 것을 목표로 합니다. 하나의 위키 백엔드가 `/api/...`와 `/mcp`를 함께 제공하고 같은 인증·권한 정책·자료 서비스·저장 모듈을 사용합니다. 첫 네 읽기와 원본 등록/판본/다운로드/요청 확인은 구현·검증했습니다. 새 MCP 도구·분석 작업·추출물과 화면 연결은 후속 계약입니다. 운영 read13 변경, 새 권한 부여, 원본 이관, 서버 배포 또는 5단계 업무 기능 착수는 포함하지 않습니다. 현재 연결/자료는 [D-041]·[D-042], 터미널 기술 기준은 [D-033]을 유지합니다.

2026-10-24 사용자 보완 결정: 앞선 서버 `source_prepare` 중심의 파일 변환 설계를 **개인 CLI의 파일 읽기·변환·AI 본문 구성**으로 바꿉니다. 이유는 개인 로그인 AI를 활용하는 실행 주체와 파일 해석을 일치시키고, Electron의 일반 화면 조회를 AI 세션/MCP 호출에 의존시키지 않기 위해서입니다. 위키 백엔드는 원본·지침·추출물·결과를 보관/제공하고 제출을 검증하며 AI를 별도로 호출하지 않습니다. 이번 개정은 문서 설계이며 기존 UI 시안의 실제 일반 API/CLI 연결을 검증했다는 뜻이 아닙니다.

여러 사용자의 CLI가 받는 공통 추출 지침·스키마·맥락과 그 불변 버전은 [D-044]를 따릅니다. 아래 작업 입력·저장 래퍼·영수증에 단계별 입력 묶음을 연결하며 규약/맥락 계약을 이 절에 중복 정의하지 않습니다.

#### FastAPI 백엔드 채택과 구현 경계 (2026-10-24)

상태: **2026-10-25 사용자 구현 요청으로 R1 첫 네 읽기 API와 단일 ASGI 결합을 구현·검증했습니다. R1 전체는 진행 중이며 운영 전환은 실행하지 않았습니다.** Python을 유지하고 일반 API에 얇은 FastAPI 계층을 추가해 기존 MCP ASGI 앱과 하나의 Uvicorn 프로세스에서 제공합니다. 초기 구성은 worker 1개이며 일반 API와 개인 CLI의 MCP가 같은 인증·tenant 정책·업무 서비스·파일 저장 모듈을 사용합니다. 첫 구현의 정확한 계약은 다음 절을 따릅니다.

| 비교한 구성 | 재사용·유지보수 판단 | 결정 |
| --- | --- | --- |
| 기존 Python·Starlette 확장 | 추가 프레임워크 없이 기존 ASGI와 저장 모듈을 재사용할 수 있지만, 늘어날 일반 API의 요청·응답 검증과 문서 계약을 직접 연결해야 함 | 가능한 대안으로 검토 |
| Python·FastAPI 추가 | 기존 Starlette·Pydantic·MCP·저장 모듈을 재사용하면서 요청·응답 모델과 OpenAPI로 Electron 계약을 관리. 새 의존성·HTTP 오류 매핑·lifespan 합성 검증이 필요 | **채택** |
| 별도 Node/TypeScript 백엔드 | Python 내부 서비스 호출이나 저장·권한 이식이 필요하고 두 런타임의 배포·장애 경계가 늘어남 | 현재 도입하지 않음 |

선택 이유는 일반 API의 규모에 맞는 계약 관리와 기존 Python 보존 로직의 재사용입니다. FastAPI의 검증·OpenAPI 기능은 [공식 기능 안내](https://fastapi.tiangolo.com/features/), MCP의 기존 앱 합성은 [공식 ASGI 안내](https://py.sdk.modelcontextprotocol.io/run/asgi/)를 근거로 삼았습니다. 프레임워크가 tenant 권한·CAS·영수증·의미 정확도를 대신 보장하는 것은 아닙니다.

조사 당시 설치 환경은 Python 3.12.14, MCP 2.3.0, Starlette 1.9.0, Uvicorn 0.54.0, Pydantic 2.14.1이며 FastAPI는 미설치입니다. [requirements.txt](../requirements.txt)는 MCP와 Markdown 파서만 직접 고정합니다. [FastAPI 0.162.0의 공식 의존성 선언](https://raw.githubusercontent.com/fastapi/fastapi/0.162.0/pyproject.toml)과 설치 메타데이터를 대조했을 때 기존 주요 버전은 요구 범위에 들며 기본 의존성 중 FastAPI와 annotated-doc가 추가로 필요합니다. 이는 **선언상 호환성 조사**이며 설치·결합 실행 통과나 최종 고정 버전의 확정이 아닙니다. [MCP 2.3.0의 공식 의존성](https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/v2.3.0/pyproject.toml)과 함께 구현 시 검증할 조합을 정합니다.

```text
Electron 화면 → 제한된 preload → main HTTP client → /api/v1
Electron main → 사용자 PC의 PTY → 개인 로그인 CLI → /mcp
                                                   ↓
                  단일 ASGI 앱 → 공통 인증·업무 서비스 → 같은 tenant 저장소
```

- 앱 조립·전송: FastAPI 루트가 일반 API 라우트와 기존 MCP 앱을 합성합니다. `/api/v1` 라우트 뒤에 내부 기본 경로 `/mcp`인 MCP 앱을 루트 mount로 배치해 외부 `/mcp`를 유지하는 방식을 기준으로 합니다. 부모 lifespan이 MCP session manager를 정확히 한 번 시작·종료하며 하위 lifespan의 자동 실행이나 `/mcp/mcp` 경로를 전제하지 않습니다. 기존 stdio 계약도 유지합니다.
- 공통 서비스: [MCP 도구](../core/mcp/tools/)와 [응답 포장](../core/mcp/results.py) 아래에서 필요한 업무 함수를 분리하고, HTTP/MCP 어댑터가 같은 결과·도메인 오류를 각 전송 형식으로 표현합니다. 공통 검색은 [문서 서비스](../core/modules/documents/search.py)로 분리했습니다. 일반 API를 임의 MCP 도구 실행 프록시로 만들지 않습니다. HTTP 모델·OpenAPI에는 현재 구현한 범위만 공개하고 필드 누락·추가·타입 변환과 오류 의미를 계약으로 검증합니다.
- 접근·조회: 양쪽 모두 [AccessPolicy](../core/modules/access/policy.py)의 현재 사용자·tenant·행동·허용 profile 검사를 자료 접근 전에 수행합니다. HTTP 입구 인증·Host/Origin 보호와 각 업무 동작의 인가를 분리하며 FastAPI dependency가 mount된 MCP까지 자동 보호한다고 가정하지 않습니다. 본문은 [WikiStore](../core/modules/documents/store.py), 현재 유효 지식은 [ReviewStore.query()](../core/modules/reviews/store.py)를 재사용합니다. `effective_graph/policies`·미검토·pending·출처/버전을 보존하고 [OntologyStore](../core/modules/ontology/store.py)의 machine층으로 전문가 판단을 대신하지 않습니다.
- 저장·실행: 기존 파일 저장·CAS·전체 본문 이력·검토/정책 원장을 유지합니다. 신규 원본·카탈로그·추출물·작업/영수증은 아래 D-043 저장 계약, 고정 입력과 저장 임계구역은 D-044를 따릅니다. 서버는 개인 AI·로컬 변환기를 실행하지 않습니다. 동기 저장·정책 조회는 제한된 작업 스레드 경계에서 처리하며, 기존 MCP SDK의 동기 도구 실행도 이미 스레드를 사용한다는 점을 보존합니다.
- 전송·운영: 기존 MCP의 JSON·stateless·8 MiB 요청 계약과 별개로 파일 API의 스트리밍·실제 바이트·형식·누적 한도를 구현합니다. 초기 폴링과 단일 서버의 영속 로컬 파일 저장으로 시작하며 DB·별도 큐·추가 백엔드 서비스는 기본 구성에 넣지 않습니다. 측정된 목록 비용·잠금 경합·복구 부담 또는 다중 호스트 요구가 생길 때 별도 결정합니다. macOS 임시 서버와 향후 상시 운영의 주소·인증·프로세스 관리·백업/복구는 실제 배포 전에 검증합니다.

첫 구현은 일반 API의 읽기 경계부터 준비하며, 정확한 포함·제외 범위와 완료 검사는 [PLAN의 R1 첫 구현 묶음](PLAN.md#r1-첫-구현-묶음과-검증-조건-fastapi-채택-2026-10-24)에 둡니다. 첫 묶음만으로 R1 전체·업로드·CLI/AI·Electron 연결이 완료된 것으로 표시하지 않습니다.

#### R1 첫 읽기 API의 구현 계약 (2026-10-25)

첫 범위는 아래 A01–A04입니다. `core/api/v1/{access,documents,knowledge}`가 전송 모델과 라우터를 맡고, `core/runtime/application.py`가 공통 보호와 MCP를 조립합니다. API와 MCP는 서로 import/호출하지 않으며 AccessPolicy·WikiStore·ReviewStore를 직접 재사용합니다. 기존 저장 의미·전체 이력·원장과 도구 인자를 변경하지 않습니다. 새 서비스 객체 연결만을 위한 빈 `services.py`는 만들지 않습니다.

- 의존성: FastAPI **0.162.0**, 기존 MCP **2.3.0**, Starlette **1.9.0**, Pydantic **2.14.1**, Uvicorn **0.54.0**. Python3.12.14/macOS의 별도 임시 환경에서 기존 버전 제약으로 해결·설치하고 `pip check`를 통과한 뒤 `.venv`에는 FastAPI와 annotated-doc만 추가했습니다. 모든 해결 버전을 `requirements.lock`으로 고정합니다. 다른 OS의 실제 배포 검증은 별도입니다. [공식 mount 안내](https://fastapi.tiangolo.com/advanced/sub-applications/)·[query 모델 안내](https://fastapi.tiangolo.com/tutorial/query-param-models/)와 설치 SDK의 실제 ASGI/lifespan 구현을 확인했습니다.
- 조립: 부모 FastAPI lifespan이 MCP 앱의 lifespan을 한 번 소유합니다. API 라우트 다음에 MCP 앱을 `/`로 mount하여 공개 `/mcp`를 유지하고 부모/자식 slash redirect를 끕니다. MCP JSON/stateless·POST·8MiB는 유지합니다. `core.runtime.http_cli`는 명시 정책/tenant-root가 필수이고 loopback·worker1·프록시 헤더 해석 비활성으로 시작합니다. 기존 stdio 런처·MCP HTTP 명령과 실제 연결 설정은 유지합니다.
- 인증: runtime의 공통 middleware가 양쪽 모든 HTTP 입구에서 단일 Bearer·Host/Origin을 검사합니다. API dependency와 MCP 도구 실행은 현재 정책의 tenant/read/profile을 저장소 생성 전에 다시 검사합니다. 정책 오류·회수에 캐시/legacy fallback은 없습니다. 입구와 MCP 내부 정책 읽기는 제한된 작업 스레드에서 실행하고, API 동기 업무/인가도 FastAPI의 작업 스레드로 처리합니다. 요청별 scope의 ContextVar 수명은 기존 호출 문맥에 유지합니다.
- 입력/공개: 네 GET만 노출하며 추가/중복 query·위조 actor/user_id·GET 본문을 거부합니다. `limit`는 ASCII 정수 문자열1–50만 파싱합니다. query 전체32KiB, document4096자, cursor16384자, profile은 기존 ID 규칙입니다. `/openapi.json`은 Bearer/Host/Origin 보호를 받으며 실제 네 API의 요청·응답·오류만 포함합니다. `/docs`·`/redoc`은 비활성화합니다. 동작하지 않는 쓰기·등록 경로를 OpenAPI에 미리 만들지 않습니다.
- 응답: 위 envelope와 `Cache-Control: no-store`를 적용하고 `data.access`에 현재 user/tenant/profile·policy_revision을 반환합니다. 본문은 WikiStore.read의 전체 content/revision, 지식은 ReviewStore.query의 **전체** machine/effective graph·claims·policies·history·pending_history·selection·원문/그래프/검토/이력/상태 revision을 모델에 보존합니다. 그래프 세대별 의미 필드는 JsonValue 객체로 그대로 전달하며 응답에서 일부를 조용히 생략하지 않습니다. 완성 JSON의 상한16MiB를 넘으면 전체를 `response_limit`500으로 거부하고 저장/재추출/원장 초기화를 실행하지 않습니다. 이 예산은 후속 고정 페이지와 별개입니다.
- 오류: 인증401, tenant/read/profile403, 문서없음404, 메서드405, 목록 기준 변경409(`retry=read_again`, `requires_refresh=true`), GET본문/query·문서크기413, Host421·Origin403, 입력/cursor422, busy503(`same_basis`), 정책불가503, 읽기/원장손상/한도500을 구분합니다. 원래 ReviewStore 계약에 따라 그래프 미생성·stale·손상은200 payload의 missing/stale/unavailable로 보존하고 빈 승인 사실로 바꾸지 않습니다. 오류는 토큰·설정 내용·서버 절대 경로와 입력값을 반사하지 않습니다.
- 목록: `documents/listing.py`는 문서1000·탐색항목10000(비md 포함)·깊이100·탐색오류50의 제한 탐색을 같은 저장 잠금 안에서 수행합니다. symlink·비정규 파일은 따라가지 않고 skipped로 남깁니다. 전체 상대 경로의 사전순으로 기본20/최대50개의 본문만 읽어 실제 revision을 얻고 `source_status=unlinked`로 반환합니다. `scanned`는 탐색한 항목 수이며 정확한 total이 아닙니다. catalog_revision은 경로·device/inode·크기·mtime_ns·ctime_ns와 탐색 상태의 hash입니다. 모든 문서 본문을 읽어 요청당1000MiB를 소비하지 않도록 파일 관측 기준을 채택했으며 저장 CAS/전역 snapshot/외부 메타데이터 위조 방어를 약속하지 않습니다.
- cursor: tenant·현재 user/profile/policy 범위 hash·catalog 기준·마지막 경로에 묶습니다. 매 페이지 현재 인가 후 다시 탐색하며 WikiStore 직접 추가·수정·삭제로 기준이 바뀌면409로 첫 페이지 재조회를 요구합니다. 다른 범위/잘못된 cursor는422입니다. 다음 페이지가 있거나 skipped/한도이면 complete=false입니다. 탐색이 잘렸으면 truncated=true·next_cursor=null로 반환하며 한도 안의 부분 결과를 전체 목록으로 표시하지 않습니다. 페이지 읽기 실패는 skipped에 남기고 전체 저장/이력은 보존합니다.

이 선택의 이유는 CLI/AI 없이 같은 tenant의 기존 지식을 읽으면서 권한·최신성·의미 보존을 유지하고, 등록/작업 계약을 첫 범위에 섞지 않기 위해서입니다. 실제 검증과 다음 범위는 [PLAN](PLAN.md#r1-첫-읽기-api-구현검증-2026-10-25), 실행은 [README](../README.md#fastapi-첫-읽기-api와-mcp-함께-실행)에 둡니다.

아래 선택은 아직 미결입니다. 첫 읽기 구현을 이 항목들의 확정으로 확대하지 않습니다.

| 미결 사항 | 확정할 시점·조건 |
| --- | --- |
| 후속 HTTP 모델·등록 카탈로그/추출·작업 결과의 예산·페이지 | 첫 읽기 계약은 위 절에서 확정. 원본만 있는 항목과1:N 파생 문서·파일 스트리밍/다운로드는 해당 후속 구현에서 고정 |
| 원본 공개·카탈로그·영수증 사이 실패의 복구 증거·파일 내구성 범위 | R1 등록/영수증 범위에서 실패 주입·응답 유실 검증 후 확정. 같은 내용 hash만으로 요청 주체·정확히 한 번의 성공을 확정하지 않음 |
| 입력 의존 최종 대조와 save/generate의 공용 내부 실행 경계 | R2/Q2에서 조정 잠금 → 저장 잠금 순서와 비재진입 계약을 유지하며 경합 검증 후 확정 |
| 실제 배포 주소·인증 발급/회수·데이터 위치/복구, CLI별 bridge·세션 어댑터·OS별 패키징 | 해당 배포·R3/R4·Q3 범위에서 별도 결정/검증. source_write 구현과 운영 부여도 분리 |

#### 유스케이스별 FastAPI API 설계 (2026-10-24)

상태: **UC-01–19·UI 가이드를 대조한 API 목록과 설계안 / A01–A04의 첫 읽기 구현·검증 완료, 나머지 미구현**입니다. 입력은 [D-039]가 연결한 시안의 `cases`, [화면·컴포넌트 가이드](../app/docs/component-architecture.md), [디자인 토큰의 출처·상태 규칙](../app/docs/design-tokens.md), 현행 PLAN·결정 기록입니다. 화면별로 같은 자료를 복제하는 API 대신 문서·지식·검토·대응·작업 자원별 계약을 공유합니다. A01–A04 외 아래의 ‘기존 처리’는 Python/MCP 내부 기능이 있다는 뜻이며 HTTP 제공을 뜻하지 않습니다. UI 연결·쓰기 권한 부여는 별도입니다.

**공통 요청·응답 설계.** A01 외 모든 경로의 접두사는 `/api/v1/tenants/{tenant}`입니다. Bearer 전달·비밀 보관은 Electron main이 담당하고 서버의 현재 `AccessPolicy`로 인증·tenant·행동을 자료 접근 전에 검사합니다. 프로필이 필요한 조회는 허용 `profile`을 명시하며 `domain/viewpoint`는 서버가 해석합니다. `actor/user_id`를 요청으로 받지 않습니다. `document`는 기존 검증된 상대 경로 참조이며 UI의 `documentId`나 서버 절대 경로와 혼용하지 않습니다. 경로에 문서 경로를 끼워 넣지 않고 GET은 query, 변경/복합 조회는 JSON body로 받습니다. ID·revision·hash는 서로 다른 필드/타입으로 다루며 unknown 필드와 임의 타입 변환을 거부하는 요청 모델을 둡니다.

- JSON 성공 응답은 `{data: <업무 결과>, meta: {trace_id: ...}}`, 오류는 `{error: {code, message, retry, details}, meta: {trace_id: ...}}`를 기준으로 합니다. `trace_id`는 진단용이며 멱등 키/저장 영수증이 아닙니다. 실제 본문·주장·근거·한정어·정책 이벤트·버전·`cleanup_failures`는 `data`에서 보존합니다. 파일은 인증 스트리밍 응답으로 따로 취급합니다.
- 단건 읽기/기존 결과는 200, 실제 자원 생성은 201, 실제로 접수되어 조회할 수 있는 미완료 작업만 202를 사용합니다. 작업 생성 응답은 개인 AI 실행 성공이 아닙니다. 인증 실패401, tenant/행동/profile 거부403, 허용 범위의 대상 없음404, CAS/기준 버전/cursor 충돌409, 요청 바이트 초과413, 미지원 media type415, 스키마/도메인 입력 오류422, `storage_busy`503을 기준으로 매핑합니다. 정책 손상·읽기/저장 장애는 기존 오류 종류를 보존한 5xx이며 빈 성공으로 바꾸지 않습니다. 세부 매핑은 R1 계약 테스트로 고정합니다.
- `retry`는 자동 재실행 지시가 아닌 `none/read_again/same_basis/reconcile` 등 다음 조치의 분류입니다. conflict는 최신 자료와 재대조, busy는 같은 기준으로 나중에 재시도, 성공 후 정리 경고는 성공으로 유지합니다. 응답 자체를 잃은 변경 요청은 클라이언트가 `outcome_unknown`으로 표시하고 확인 전 재전송하지 않습니다.
- 새 문서·원본·작업·이력 목록은 `items/next_cursor/scope/complete/truncated/skipped`와 목록 기준 revision을 제공합니다. 기존 B04/B05·D01 등 발견/통합 조회의 `matches/results`·상한·무페이지 계약은 유지하며 cursor를 임의로 붙이지 않습니다. 제한된 발견 결과는 범위를 좁혀 다시 조회합니다. 기본20/최대50은 문서·새 일반 목록의 기준이며 기존 검색/개념 서비스의 별도 상한을 축소·확대하지 않습니다. cursor는 tenant·인가 범위·필터·정렬·목록 기준에 결합하고 재사용 시 현재 권한도 검사합니다. 다음 페이지가 있거나 탐색 실패/한도가 있으면 전체 범위 완료로 표시하지 않습니다. 변경된 기준은 재조회 필요로 반환하며 offset으로 조용히 이어붙이지 않습니다. 전체 snapshot/정확한 전역 total은 보장하지 않습니다.
- 복합 조회의 POST는 배열·버전 있는 참조·baseline을 전달하기 위한 **읽기 전용 요청**입니다. 서버 저장·AI 실행·권한 상승이 없으며 `read`만 요구합니다. OpenAPI operation에 이 성격을 표시합니다. POST/GET이라는 이유만으로 재시도·쓰기 권한을 일괄 판단하지 않습니다.
- 일반 API 응답은 공유 캐시에 저장하지 않는 `Cache-Control: no-store`를 기준으로 하고, 앱의 자료 캐시는 인증 주체·tenant·profile·조회 범위별로 구분합니다. 원문·지식·검토를 따로 읽은 결과의 revision이 다르면 혼합 snapshot으로 승인하지 않습니다. 각 서비스의 `scope/complete/truncated/skipped`·현재성·한도를 그대로 유지하며, 누락한 필드를 `complete=true`로 보충하지 않습니다. 큰 그래프/원장은 필드별 응답 예산을 정한 뒤 명시 실패 또는 버전에 묶인 출력 페이지로 전달하고 의미 필드를 조용히 자르지 않습니다.

**A. 첫 읽기 API — R1 첫 묶음.** 전체 완료 조건은 [PLAN](PLAN.md#r1-첫-구현-묶음과-검증-조건-fastapi-채택-2026-10-24)이 관리합니다.

| ID / HTTP | 입력 → 주요 반환 | 처리·권한 |
| --- | --- | --- |
| A01 `GET /api/v1/access-context` | 사용자 입력 없음 → 현재 인증 주체·허용 tenant/행동/profile·policy revision | 기존 `AccessPolicy.describe`; 인증 필요 |
| A02 `GET /documents` | `cursor?, limit?` → 문서 참조·현재 revision·원본 연결 상태·페이지/완전성 | **전용 목록 서비스 신규**, `read`; 먼저 기존 Wiki만, 원본 카탈로그 결합은 뒤 R1 |
| A03 `GET /documents/content` | `document` → 전체 `content/revision` | 기존 `WikiStore.read`, `read`; 표시 편의를 위한 요약/줄바꿈 변환 없음 |
| A04 `GET /documents/knowledge` | `document, profile` → `effective_graph/claims/policies/pending_history/history/selection`와 source·graph·review·history·state revision | 기존 `ReviewStore.query`, `read`; 미검토/보류/다른 범위도 보존 |

A02의 원본 연결 없음은 후속 등록 자료에 대한 추정 연결이 아닙니다. A04는 문서별 현재 판단의 기준 조회이며 그래프가 없거나 오래된 상태, 계산 실패를 빈 승인 그래프로 반환하지 않습니다. R1에서 전체 응답 상한을 먼저 고정하고 초과 시 수정 불가·명시 오류로 처리합니다. 후속 C09/C10의 출력 페이지가 준비되지 않았는데 이력을 생략해 정상 전체 응답처럼 표시하지 않습니다.

**B. 탐색·질문 근거 조회 — 기존 서비스의 후속 HTTP 어댑터.** 모두 `read`; 프로필을 받는 서비스는 허용 profile을 서버의 domain/viewpoint로 변환합니다.

| ID / HTTP | 입력 → 주요 반환·보존할 의미 |
| --- | --- |
| B01 `GET /documents/search` | `query, limit?` → 원문 문자열 검색·snippet·`truncated/skipped`; 기존 `wiki_search` 처리 재사용, 문서 목록/의미 검색과 구분 |
| B02 `GET /documents/ontology` | `document, profile` → **machine층** 그래프·후보·현재성/재추출 표시·source/graph revision; 현재 전문가 판단은 A04 |
| B03 `POST /knowledge/context/query` | `documents[1..8], profile` → 선택 문서의 전체 원문/전체 machine 그래프, `focus/other_context/unclassified`·출처·범위·완전성; 전문가 판단은 A04/B05와 함께 확인 |
| B04 `POST /concepts/find` | `text, profile, documents?, include_history?, application_context?, as_of?, limit?` → 버전 있는 `target_ref`·일치 출처·현재성·부분 결과; 원문에 없는 정책 용어도 기존 계약대로 구분 |
| B05 `POST /concepts/query` | `target, profile, documents?, correspondence_ids?, expansion, application_context?, as_of?, limit?` → 현재 유효 주장·정책·지도용 맥락·`resource_manifest`·snapshot/view revision·완전성 |
| B06 `GET /documents/connections` | `document, limit?` → 명시 링크/이름·유형 후보·양쪽 문서/개체/revision·근거·`ontology_states`; 검토된 의미 대응은 D계열 |
| B07 `POST /documents/impact/query` | `document, profile, baseline?, limit?` → 직접 영향 권고·변경/복원 상태·`restoration/complete/truncated/skipped`; baseline 없으면 변경을 추정하지 않음 |

B04/B05의 문서·대응 선택 상한, 직접 확인된 대응 한 단계 확장, `as_of`·판정/적용 상태는 [D-040]을 그대로 따릅니다. snapshot/view revision·영향 baseline은 쓰기 CAS가 아닙니다. UC-08은 두 명시 대상을 B03/B05로 읽어 UI에서 방향·조건·기간·근거를 병렬 표시하는 것으로 시작합니다. 자동 동치/모순 판정용 API나 단순 diff를 의미 판정으로 사용하는 API는 추가하지 않습니다.

**C. 본문 편집·판본·문서별 검토 — R1 첫 범위 밖.** 요청에서 `document`를 명시하고 검토/정책에는 허용 profile을 연결합니다. 기존 저장 의미와 일반 쓰기의 응답 유실은 아래 경계를 함께 적용합니다.

| ID / HTTP | 입력 → 결과 | 재사용·새 작업 / 권한 |
| --- | --- | --- |
| C01 `PUT /documents/content` | `document, content, expected_revision` → 저장 revision·보관 결과·정리 경고. null은 신규 생성에만 허용 | 기존 `WikiStore.save`; `write` |
| C02 `GET /documents/versions` | `document, cursor?, limit?` → 현재 본문과 과거 보관 파일의 별도 참조·hash·보관 시각·완전성 | 공개 이력 서비스 **신규**; `read` |
| C03 `GET /documents/versions/{history_id}` | `document` → 검증된 과거 전체 본문·content revision·보관 정보 | **신규**; `read`; 문서 소속·안전한 경로·크기/UTF-8 검사 |
| C04 `POST /documents/restorations` | `document, history_id, expected_revision` → 과거 전체 본문을 새 저장으로 적용한 결과 | 새 서비스가 `WikiStore.save` 재사용; `write` |
| C05 `POST /documents/reviews` | `document, profile, claim_id, action, expected_state_revision, reason, replacement?` → 새 `event_id/state_revision/changed/cleanup_failures` | 기존 원문 근거 검토; `ontology_review` |
| C06 `POST /documents/review-undos` | `document, profile, event_id, expected_state_revision, reason` → 정확한 검토의 새 역이벤트/상태 | 기존 검토 되돌림; `ontology_review` |
| C07 `POST /documents/policies` | `document, profile, claim_id, expected_state_revision, reason, replacement, entities?` → 전문가 판단 이벤트·적용 상태 | 기존 업무 판단; `ontology_policy` |
| C08 `POST /documents/policy-undos` | `document, profile, event_id, expected_state_revision, reason` → 해당 관점 판단의 새 역이벤트/상태 | 기존 정책 되돌림; `ontology_policy` |
| C09 `GET /documents/events` | `document, cursor?, limit?` → 문서 검토/정책 이벤트 목록·원장 기준·완전성 | 원장 조회 재사용, 출력 페이지 **신규**; `read` |
| C10 `GET /documents/events/{event_id}` | `document` → 당시 target/before/after·이유·인증 주체·인용·기준 revision | 단건 projection **신규**; `read`; 현재값으로 과거를 덮지 않음 |

- 판본의 `history_id`는 보관 파일의 식별자이며 내용 hash와 다릅니다. A→B→A나 중복 보관에서도 hash가 재등장할 수 있고, 보관 파일이 있다는 사실이 원본 교체 성공을 증명하지 않습니다. 기존 이력에는 작성자/편집 이유가 없으므로 null/미기록을 유지하고 보관 시각을 본문 작성 시각으로 표시하지 않습니다. 최초 생성 전 부재 복원·삭제는 제공하지 않습니다. 두 고정 본문의 텍스트 diff는 UI에서 계산하며 별도 diff API를 우선 만들지 않습니다.
- C04는 최신 `expected_revision`에서 현재 전체 파일도 이력에 남기는 새 저장입니다. 과거 그래프/승인 자동 복원은 없습니다. 검토 이벤트가 옛 전체 원문/그래프를 모두 갖고 있다고 가정하지 않으며 과거 근거 복원에 실패하면 명시합니다. 원장을 먼저 페이지로 잘라 현재 판단을 계산하지 않고, 전체 제한된 원장을 검증·계산한 뒤 출력만 페이지화합니다.
- C05의 `action=accept/edit/reject/defer`, edit는 실제 인용·모든 한정어/맥락/출처를 포함한 전체 주장 교체입니다. C07은 기존 **관계·속성 claim**의 업무 판단으로, `relation_candidates`의 정책 승격·독립 새 주장 생성은 지원하지 않습니다. 이 경로는 가짜 evidence/provenance를 받지 않고 인증 주체와 Action log를 서버가 기록합니다. 두 경로의 권한·근거·undo를 통합하지 않습니다. 새 독립 관계 생성·claim 분리·중요 누락 복구는 전체 재추출 경로와 구분합니다.
- **일반 쓰기의 멱등 영수증은 미구현·미확정**입니다. D-043의 원본/job `request_id` 계약을 C/D 쓰기에 자동 적용하지 않습니다. 현재 서비스 CAS만 노출한다면 응답 유실 후 본문/원장을 조회하되 같은 hash·actor·내용만으로 해당 요청 성공을 확정하지 않고 미확인을 유지해야 합니다. 제품 쓰기 연결 전 이 방식의 확인 절차 또는 별도 일반 mutation intent/receipt·`pending_reconcile` 계약을 결정·실패 검증합니다. 조회로 해결되지 않은 미확인을 자동 재전송으로 없애지 않습니다.

**D. 문서 간 의미 대응 — [D-038]의 별도 원장과 prepare 계약.** D01–D09는 공통 입력으로 허용 `profile`을 받고 준비→변경까지 같은 관점을 유지합니다. prepare의 CAS는 선택 관점·정책 revision에도 결합하며 관점 전환 시 새로 준비합니다. 상세 필드는 D-038을 재사용하며 source proposal·검토·업무 판단, `decision`과 `applicability`를 분리합니다.

| ID / HTTP | 입력·동작 | 권한 |
| --- | --- | --- |
| D01 `POST /correspondences/find` | `documents[1..8], text?, application_context?, as_of?, limit?`의 제한된 발견 | `read` |
| D02 `POST /correspondences/{id}/query` | `application_context?, as_of?`로 상세/의존 버전·검토/정책/이력 조회 | `read` |
| D03 `POST /correspondences/drafts/prepare` | 전체 `draft` 정규화·ID·부재 CAS 반환, **저장/예약 없음** | `read` |
| D04 `POST /correspondences` | prepare의 `correspondence_id, draft, expected_state_revision, reason`으로 제안 저장 | `ontology_write` |
| D05 `POST /correspondences/{id}/changes/prepare` | `operation, change`의 정확한 변경 내용·의존 버전에 묶인 token, **저장 없음** | `read` |
| D06 `POST /correspondences/{id}/reviews` | `action, expected_state_revision, reason, replacement?, decision?`으로 검토 | `ontology_review` |
| D07 `POST /correspondences/{id}/review-undos` | `event_id, expected_state_revision, reason`으로 검토 역이벤트 | `ontology_review` |
| D08 `POST /correspondences/{id}/policies` | `replacement, expected_state_revision, reason, judgment_id?, supersedes_event_id?`로 업무 판단 | `ontology_policy` |
| D09 `POST /correspondences/{id}/policy-undos` | `event_id, expected_state_revision, reason`으로 판단 역이벤트 | `ontology_policy` |

값 변경 없는 accept/reject/defer는 완전한 상세 조회 token도 사용할 수 있으나 edit·policy·두 undo는 정확한 변경 prepare를 요구합니다. 불완전 조회에는 변경 token이 없고 prepare의 read 권한이 변경 권한을 부여하지 않습니다. 응답 유실 때 같은 대응 ID를 조회하며 새 ID로 다시 제안하지 않습니다. D-038 condition/concept anchor와 D-040 `target.kind=anchor` 계약을 관계 subject/object의 명시 v4 `source_anchor`와 구분합니다. [D-042의 격리 구현·검증](#n1-c01-원문-앵커-끝점의-격리-구현과-검증-2026-10-24) 이후, 이번 조사 도중 공유 core에도 v4 끝점·검토·개념 조회 처리 코드가 동시 반영된 것을 확인했습니다. 이는 이번 문서 작업의 변경이 아니며 최종 검증·실행 서버 적용·운영 자료 반영 여부는 별도 기록으로 확인해야 합니다. API 구현 시 확정된 schema_version과 소비자 지원을 다시 고정하고 앵커를 개체 ID로 바꾸거나 응답에서 생략하지 않습니다. 문서 정책의 replacement는 재확인 시점에도 문자열 개체 끝점만 허용하므로 v4 지원을 모든 쓰기에 확대하지 않습니다. 일반 HTTP 경로는 아직 미구현입니다.

**S. 자료 등록·개인 AI 작업·결과.** 실제 HTTP 경로·입출력·권한의 목록은 바로 아래 [업로드·목록·작업 API와 권한](#업로드목록작업-api와-권한)에 한 번만 둡니다. 원본 등록/새 판본/파일, 원본·문서 목록, job 생성·목록·상태·heartbeat·취소·요청 영수증, extraction manifest/고정 내용 페이지·artifact 전송이 필요합니다. 원본 등록과 실제 AI 분석, 추출물과 Wiki/그래프 저장의 완료는 각각 조회합니다. `GET /analysis-jobs`를 작업 목록에 추가 설계하며 상세와 같은 서버 관측 상태를 반환하고 목록의 필터·주체별 노출·페이지 예산은 구현 전에 고정합니다. 실제 개인 CLI 시작/로그인/PTY·로컬 파일 선택은 Electron main의 동작으로 남기며 일반 API에 셸/AI 실행 경로를 만들지 않습니다. 전체 그래프 제출·규약/입력 bundle은 D-043/D-044의 작업용 MCP가 담당합니다.

**E/F. 화면에 필요하지만 새 제품 계약이 먼저 필요한 후보.** 아래 경로는 최종 OpenAPI에 선등록하지 않습니다. 기존 문서별 기능만으로 전역 조회·대화 영속화가 완성됐다고 표시하지 않습니다.

| ID / 후보 HTTP | 필요한 설계·미결 사항 |
| --- | --- |
| E01 `POST /review-queue/query` | 명시 문서/대응 또는 허용 tenant 범위·상태/profile 필터의 검토 대기열. `read` 기반 신규 집계, 문서/원장 탐색 예산·cursor·partial 상태·현재/과거/pending 구분 필요. 빈 페이지는 전체 검토 완료가 아님 |
| E02 `POST /history/query` | 본문 보관·검토·정책·대응·job을 종류별 ref로 모은 이력. `read` 기반 신규 집계, 범위·정렬·예산·복원 불가 표시 필요. 없는 본문 편집자나 옛 전체 그래프를 발명하지 않음 |
| F01 `POST /question-context/prepare` | 명시 문서/주장/원본·profile·필수 정의/예외에서 질문용 자료/판본 manifest를 읽기 전용으로 구성. B/A/S를 재사용하는 새 조합 서비스 후보. 누락·오래된 지정 대상을 조용히 제외하지 않으며 준비는 AI 실행/영구 snapshot 저장이 아님 |
| F02 `GET /conversations`, `POST /conversations`, `GET /conversations/{id}`, `POST /conversations/{id}/turns` | 대화 목록/생성/읽기/질문·개인 CLI 답변의 명시 제출 후보. 개인/tenant 공유 범위·별도 권한·append CAS·보관/삭제·질문 당시 원문/정책 근거 snapshot·실패한 turn 상태를 먼저 정함. 클라이언트의 AI 답변을 서버 생성이나 전문가 승인으로 표시하지 않음 |
| F03 `GET /saved-results`, `GET /saved-results/{id}`, `POST /saved-results` | Wiki와 별도로 저장할 답변/작성 결과 및 당시 출처 계보가 필요한 경우의 후보. 별도 자원이 필요한지, Wiki 저장과의 연결/부분 실패·권한·원문 보존 용량을 먼저 결정. 단순 초안을 자동 Wiki 저장하지 않음 |
| F04 비교/재검토 완료 자원 — 경로 미확정 | UC-15/16의 고정 이전/새 제안·버전·옛 claim↔새 claim 명시 대응·판본별 제외·복구 초안·실제 새 claim 검토/저장 확인을 영속할지 먼저 결정. 미발견을 삭제/AI 누락으로 단정하지 않으며 명시 비교 범위의 완료만 계산. B07·C계열·job 결과는 기반일 뿐 전체 기능을 대신하지 않음 |

F02/F03의 변경을 기존 `write`나 `source_write`로 허용한다고 미리 결정하지 않습니다. 당시 답변의 snapshot은 현재값으로 교체하지 않고 새 질문은 현재 허용 자료를 다시 조회합니다. 저장하지 않은 질문/편집 초안·지도 배치·접힘·선택 관점·테마는 앱 상태로 유지할 수 있어 각각의 서버 API를 만들지 않습니다. 소속 표시 A01과 계정 발급/SSO/토큰 관리·자동 알림은 별개이며 후자는 이번 API 설계의 구현 범위가 아닙니다.

**유스케이스 추적.** UI의 같은 대상/관점/판본을 API 사이에서 유지하며 다음 대응은 구현 완료를 뜻하지 않습니다.

| UC | 필요한 API / 화면 동작 |
| --- | --- |
| UC-01 자료 축적 | S 등록·작업·결과 → A02/A03/A04 |
| UC-02 경험 문서화 | F01/F02/F03 후보·개인 CLI → 명시 C01 저장; 경험/제안 구분 |
| UC-03 자료 이해 | A03/A04·B02/B03·S 추출물/경고 |
| UC-04 문서 찾기 | A02·B01 → A03 |
| UC-05 근거 있는 질문 | A01/A04·B03/B05 → F01/F02·개인 CLI |
| UC-06 개념 종합 이해 | B04 → B05·D02 |
| UC-07 관점별 이해 | A01의 허용 profile → A04/B03/B04/B05; 앱의 질문 범위 재확인 |
| UC-08 기준 비교 | B03/B05·D02의 명시 두 기준 → UI 병렬 비교; 자동 의미 판정 없음 |
| UC-09 결과물 작성 | F01/F02/F03 후보·C01; 결과와 당시 출처 보관 |
| UC-10 연결 탐색 | B06·B05·D01/D02; 링크/이름 후보/검토 대응 분리 |
| UC-11 연결 검토·선례 | D01–D09; 새 문서는 별도 제안/판단 |
| UC-12 원문 정정 | A03·C01–C04·S 새 원본 판본; 원본 교체와 Wiki 수정 구분 |
| UC-13 AI 해석 정정 | A03/A04·C05/C06; 누락/새 주장 복구는 S의 전체 재추출 |
| UC-14 전문가 판단 | A04·C07/C08·D08/D09; Action log·범위별 적용 |
| UC-15 지식 갱신 | S 작업/전체 저장·A03/A04·C계열·F04 후보 |
| UC-16 변경 후 재검토 | B07·D02·E01·C계열·F04 후보; 전역 종료로 확대하지 않음 |
| UC-17 추적·되돌림 | C02/C03/C04/C06/C08/C09/C10·D02/D07/D09·E02 |
| UC-18 다음 작업 재사용 | A01·B01/B04/B05·A04·F01/F02; 최신 판단 재조회 |
| UC-19 작업 범위 확인 | A01과 각 요청 인가; 개인 CLI/MCP 준비 상태는 호스트에서 별도 확인 |

추가 미결은 **일반 변경 요청의 영수증/미확인 해소**, **본문/원장 이력·전역 집계의 페이지와 예산**, **질문/대화/결과/비교 자원의 저장·공유·권한·완료 계약**입니다. 이들은 위 FastAPI 미결 표의 R1 항목과 구분하며 R1 첫 읽기 구현을 전체 제품 API 구현으로 확대하지 않습니다.

#### 실행 주체와 두 가지 등록 입력

| 주체 | 담당 동작 |
| --- | --- |
| Electron renderer / preload / main | 제한된 preload API를 거쳐 main의 일반 HTTP API 클라이언트가 업로드·목록·본문/그래프·작업 결과를 조회. main이 사용자 PC의 PTY에서 새 개인 CLI 터미널을 열거나 명시 선택 세션에 요청을 준비하며 파일 전송 bridge를 관리 |
| 각 사용자의 로그인된 CLI | MCP로 고정 지침·원본 참조·작업 입력을 읽고, 작업용 파일을 검증된 로컬 도구/이미지 입력과 AI로 읽어 충실한 본문을 구성한 뒤 온톨로지를 추출. 추출물 제출·본문/그래프 저장은 허용된 MCP 도구로 요청 |
| 같은 위키 백엔드의 일반 API `/api/...` | Electron의 서버 사용자/권한 확인·원본 업로드/다운로드·페이지 목록·최신 본문/유효 그래프·작업 결과 조회와 호스트 bridge의 작업용 파일 전송 |
| 같은 위키 백엔드의 MCP `/mcp` | 개인 CLI의 `access_context`·공통 지침/고정 입력·원본 참조 조회, 작업 접수·추출물 제출·위키/온톨로지 저장. 일반 API와 같은 서비스·저장 모듈을 재사용 |

파일 업로드·목록/결과 조회에는 모델 호출이 필요하지 않으며 CLI가 꺼져 있어도 동작해야 합니다. 원본에서 문자/셀/페이지를 읽는 도구 실행과, 표·이미지·문맥을 해석해 본문을 구성하는 AI 작업은 개인 CLI가 담당합니다. **본문 준비와 온톨로지 추출 모두 AI가 참여할 수 있으므로 AI 호출이 한 번이라고 약속하지 않습니다.** ChatGPT 로그인은 CLI의 AI 이용 인증이고, 서버 Bearer 인증은 위키 tenant 접근 인증입니다. 둘의 사용자 식별자나 권한을 서로 대신하지 않으며 AI 인증정보를 공유 위키 서버·작업 manifest·문서에 저장하지 않습니다. 개인 계정 CLI의 사용 범위를 상용/호스팅 AI 서비스 허용으로 확대 해석하지 않습니다.

Electron의 문서 화면은 `/api/...`를 호출하며 renderer/main의 MCP 클라이언트를 필수로 두지 않습니다. 새 터미널·CLI 프로세스는 Electron main이 사용자 PC에서 실행하고, 그 CLI가 서버 MCP에 접속합니다. 원격 MCP 서버가 다른 PC의 터미널을 직접 생성하거나 셸 명령을 밀어 넣는 구조로 설계하지 않습니다.

파일 등록은 선택한 원본 바이트를 먼저 서버에 보관합니다. 본문 직접 입력도 `kind=text`의 원본 판본으로 입력 문자열의 UTF-8 바이트·줄바꿈을 보관한 뒤 같은 분석 경로로 합칩니다. 두 입력 모두 등록 완료만으로 위키 본문·그래프가 생성됐다고 표시하지 않습니다. 기존 위키 본문을 직접 편집하는 동작은 종전 `wiki_read`/`wiki_write` 흐름이며 새 원본 등록과 구분합니다.

#### 서버 저장 위치와 자료 계보

서버 관리자가 기동 시 검증한 `tenant-root/<T>/`를 유일한 서비스 저장소로 사용합니다. D-041의 이관 이후 현재 개발/운영 확인 경로는 `<project>/data/personal/`입니다. 원본 등록도 명시 정책이 허용한 같은 tenant 경계 안에 보관합니다. 실제 배포에서는 코드 checkout 밖의 전용 데이터 루트를 설정할 수 있게 하되, 실제 서버·절대 경로·이관 시점은 별도 배포 결정입니다. 프로젝트 최상위·사용자의 다운로드 폴더·CLI 작업 디렉터리를 공식 서버 보관소로 사용하지 않습니다.

```text
<tenant-root>/<T>/
  _sources/<source_id>/<source_version>/original       원본 전체 바이트, 불변
  _sources/<source_id>/<source_version>/manifest.json  형식·hash·주체·시각, 불변
  _extractions/<extraction_id>/                        CLI 제출 본문·표·이미지·출처 대응과 manifest
  _registrations/<source_id>.json                     판본 목록·현재 원본·파생 문서 연결
  _registrations/_requests/<owner-request-hash>.json   원본 등록 intent·예약 ID·영수증
  _jobs/<job_id>/                                     입력 기준·시도·단계별 영수증·결과 참조
  _incoming/                                         원본/CLI 산출물 공개 전 staging, 비서비스
  wiki/<relative-document>.md                         최신 위키 본문, 기존 모듈
  _history/<relative-document>.md/                    수정 전 전체 본문, 기존 모듈
  _ontology/<SHA256(document)>.json                    현재 파생 그래프, 기존 모듈
  _reviews/                                          검토/정책/대응 보존 원장, 기존 모듈
```

이 트리는 전체 목표입니다. 원본 등록 범위의 `_sources`·`_registrations`·`_incoming`과 `.registration.lock`은 실제 등록 시 생성하며 `_extractions`·`_jobs`는 아직 생성하지 않습니다. 원본 보관과 요청 기록은 `_history`·`_reviews`를 대체하지 않습니다. 기존 프로젝트 최상위 Numbers 원본과 `records/source-prep-20261024T024339Z`의 보존본·준비 자료는 현재 위치에서 보존합니다. 이관을 요청받으면 원본/이력/원장·계보의 전체 보존 대조를 별도로 수행하며 등록 기능이 기존 자료를 자동 이동·중복 등록하지 않습니다.

- `source_id`는 한 등록 자료의 서버 발급 ID입니다. 파일명은 표시용 값이며 저장 경로로 쓰지 않습니다. `source_version`은 불변 판본 ID, `source_sha256`은 원본 바이트 상태값으로 서로 구분합니다. 같은 이름 재업로드는 새 판본이며 옛 파일을 덮어쓰지 않습니다. 본문 입력도 같은 원칙을 적용합니다.
- CLI의 읽기·변환 실행 제출마다 서버가 `extraction_id`를 발급하고 원본 판본/hash·job/run·도구/버전·설정·모델 자기보고·선택 범위·경고·누락/미확인 범위·입출력 hash를 불변으로 보존합니다. 원본의 페이지·절·표/셀·이미지와 준비 본문의 대응, 도구 원시 출력과 AI의 전사/재구성을 구분하고 재서술/요약을 원본 문장으로 위장하지 않습니다. 서버의 제출 수신·구조/hash 검증은 실제 파일 전체 읽기나 의미 정확도의 증명이 아닙니다. 변환물은 위키 편집과 함께 바뀌지 않습니다.
- 등록 카탈로그는 원본 판본 → 변환 실행 → 위키 `document/revision`의 명시적 1:N 연결을 보존합니다. 원본 하나를 여러 문서로 나누려면 의미가 완결된 범위와 누락/참조·목적 경로를 작업 입력에 명시하며 자동 이름 유사도 병합/분할은 하지 않습니다. 현재 원본 판본을 바꿔도 기존 본문/그래프의 기준 판본을 함께 바꾸지 않습니다.
- 그래프의 `source_revision`은 **실제 `wiki_read` 본문 revision**입니다. 원본 파일 hash·추출물 hash·원본 판본 번호를 대신 넣지 않습니다. 그래프 `graph_revision/generation_id`, 검토 `state_revision`, 작업 `job_revision`을 각각 유지하며 SHA-256 내용값을 작업 고유 ID로 사용하지 않습니다.
- `_ontology`는 현재 그래프 저장소입니다. 모든 이전 그래프가 자동 보존된다고 약속하지 않습니다. 새 분석 작업의 전체 원시 제출과 저장된 그래프/영수증을 `_jobs`의 결과 산출물로 보존해 해당 작업의 결과를 추적하도록 구현하되, 옛 그래프/승인을 현재로 복원하는 기능은 아닙니다. 영수증의 graph_revision과 일치하는 바이트만 당시 저장 스냅샷으로 기록하며 이미 다른 세대로 교체됐으면 그 현재 그래프를 옛 결과로 대신하지 않고 스냅샷 미확인을 구분합니다.
- 원본은 임시 파일에 수신·hash/형식/크기를 검증한 뒤 불변 판본으로 공개하고 마지막에 카탈로그를 갱신합니다. 동일 디스크의 staging 공개와 카탈로그/영수증 갱신은 별도 저장 단계입니다. 파일/폴더 symlink·클라이언트 절대 경로·경로 탈출을 거부하고 정책·비밀은 tenant-root 밖에 둡니다.

#### R1 원본 등록·업로드의 구현 계약 (2026-10-25)

사용자가 요청한 R1의 다음 범위를 **원본 신규 등록·새 판본·등록 목록/상세·선택 판본 다운로드·본인 요청 영수증**과 기존 문서 목록의 원본 발견으로 한정합니다. 업무는 `modules/sources`의 store·staging·commands·queries·files·validation·contracts, 전송은 `api/v1/sources`가 맡습니다. `modules/knowledge/catalogue.py`는 원본과 위키 목록의 읽기 조합입니다. 원본 수신에 python-multipart0.0.32를 직접 의존성으로 명시했으며 기존 lock/설치 버전과 같습니다. 실제 [FastAPI 파일 수신 안내](https://fastapi.tiangolo.com/tutorial/request-files/)와 설치 Starlette1.9.0의 spool/예외 정리 구현을 확인했습니다.

- 입력: `POST /sources`는 JSON `{request_id,title,format,content}` 또는 multipart의 `request_id,title,file` 하나를 받습니다. JSON은 kind=text, multipart는 kind=file이며 첫 형식은 유효한 UTF-8 md/txt입니다. 원본의 줄바꿈·BOM·UTF-8 바이트를 그대로 보존합니다. versions POST에는 양쪽 모두 `expected_registration_revision`이 필수입니다. source/version/request ID는 소문자hex32, revision/hash는hex64입니다. 같은 파일명은 표시 정보이며 신규 POST의 등록을 자동 병합하지 않습니다. 특정 등록의 새 판본은 source_id가 명시된 versions 경로만 사용합니다.
- 전송: 실제 수신 byte를 세어 전체24MiB, 원본20MiB를 각각 적용합니다. JSON escape/multipart overhead도24MiB에 포함되어 내용20MiB와 별개입니다. 파일 하나·일반 필드 최대3개·필드4096바이트·파트 헤더16KiB·완결 boundary를 검사합니다. 추가/중복 필드·중복 JSON key·원시 filename 경로/drive·지원하지 않는 형식을 거부하고 filename으로 저장 경로·명령을 만들지 않습니다. multipart는 디스크 spool과64KiB 저장 읽기를 사용하며 원본 전체를 base64/대화/MCP에 넣지 않습니다. JSON 본문은 별도24MiB의 제한된 메모리 입력이며 파싱은 작업 스레드로 보냅니다. 동시 수신은 단일 worker의4개 슬롯, 대기5초이며 초과 시 `upload_busy`503/same_basis입니다.
- 접근: 정책 version1에 `source_write`를 추가하되 기존 모든 쓰기 권한처럼 read가 필수입니다. 원본 등록/판본 추가는 source_write, 읽기/다운로드/본인 영수증은 read입니다. 기존 write·ontology_write·검토/정책 권한을 대신하지 않으며 기존 MCP 인자/도구 목록과 운영 read13을 자동 변경하지 않습니다. 수신 전에 tenant/source_write를 확인하고 공개 조정 잠금 안에서 현재 권한·인증 주체를 다시 확인합니다. 응답 access와 manifest actor는 서버가 확인한 범위를 사용하며 토큰·클라이언트 경로·임의 actor는 기록하지 않습니다.
- 저장 순서: tenant의 `.registration.lock`으로 조정하며 필요한 기존 문서 캡처는 조정→storage 잠금 순서를 지킵니다. 수신 staging·UTF-8/hash/크기 검증 후 현재 권한·CAS·한도를 대조하고 요청 intent를 먼저 원자 기록합니다. 그 intent의 예약 source/version ID·actor·payload hash·원본 manifest를 고정한 다음 불변 판본 디렉터리를 공개하고, 전체 이전 판본을 포함한 등록 카탈로그를 갱신하고, 마지막에 완료 영수증을 기록합니다. 파일은 fsync·같은 저장 루트 내 rename/원자 교체를 사용하지만 여러 파일 전체의 원자 거래·전원 장애 내구성을 보장하지 않습니다. WikiStore.save/그래프 생성은 이 등록 경로에서 호출하지 않습니다.
- 멱등/미확인: 키는 tenant·인증 주체·request_id이며 payload hash는 동작/대상·기준 revision·전체 metadata·실제 원본 hash/크기를 포함합니다. 같은 키/같은 입력의 확인된 완료는 기존 ID/영수증200, 다른 입력은409입니다. 새 등록 완료201, 영구 intent 이후 중간 실패는202와 pending_reconcile로 구분합니다. 공개 원본·옛 판본·카탈로그를 삭제하거나 자동 재저장하지 않습니다. 같은 pending POST도 예약 ID를 유지하며 자료를 다시 공개하지 않습니다. 응답 유실 시 본인 `GET /requests/{request_id}`를 먼저 읽습니다.
- 복구 증거: 원본 공개 뒤 카탈로그 연결 실패는 pending으로 남기며 다른 자료의 hash 일치로 성공을 만들지 않습니다. 완료 영수증 기록만 실패했으면 GET이 영구 intent·동일 actor/request/payload manifest·카탈로그 내 정확한 판본 연결·실제 원본 hash/크기를 대조해 `confirmation=intent_manifest_catalog`인 완료 증거를 반환할 수 있습니다. 이 GET은 저장 파일이나 pending 기록을 수정하지 않으며, 자료 재저장/새 ID/기준값 교체로 복구하지 않습니다. 카탈로그 연결이 없어 확정하지 못한 경우의 운영 조정 기능은 후속 계약입니다. 그 상태를 전체 등록 완료나 분석 성공으로 표시하지 않습니다.
- 한도: 영구 원본200MiB/tenant(공개됐지만 카탈로그가 없는 orphan도 합산), 별도 `_incoming`64MiB, 등록1000·판본100/source·요청10000/tenant·파일 탐색50000항목·개별 JSON1MiB·전체 카탈로그 metadata16MiB를 적용합니다. 원본 수신 예산과 영구 quota를 분리해 보관량이 가득 차도 같은 요청의 재확인을 막지 않습니다. 한도 초과 시 기존 자료를 삭제·잘라내거나 원장을 초기화하지 않습니다. 무제한 보관/자동 수집이 아니며 설정/확대는 별도 결정입니다.
- 조회: source 목록은 ID 순·기본20/최대50·현재 인가 범위와 카탈로그 기준에 묶인 cursor를 사용합니다. 빈 저장소의 조회는 폴더/조정 lock을 만들지 않습니다. 자료 손상·unsafe path·한도는 명시 오류로 반환하며 빈 성공으로 바꾸지 않습니다. `documents`는 등록 원본이 있으면 source 항목과 기존 unlinked wiki 항목을 함께 안정 정렬하고 두 기준을 묶습니다. 원본 등록 전의 유효한 Wiki cursor도 최초 등록 뒤에는409 재조회가 필요합니다. 계보 없는 문서는 유지하고 이름/내용 유사도로 파생 문서를 추측하지 않습니다. 아직 분석/위키 연결이 없으므로 source의 documents는빈배열·analysis_status는not_started입니다.
- 다운로드/정리: 허용 tenant의 정확한 source/version을 카탈로그·manifest·실제 원본의 hash/크기로 검증한 후 열린 descriptor에서 스트리밍합니다. 서버 경로/영구 공개 URL·redirect는 없으며 UTF-8 text MIME·attachment·크기/hash·nosniff·no-store 헤더를 제공합니다. 원본20MiB 스트림은 JSON16MiB 응답 버퍼와 분리합니다. 수신 중단/초과/취소와 전송 중단에도 이 요청의 spool·staging·열린 descriptor를 정리하며 이미 공개된 원본과 영수증은 보존합니다. 정리 실패는 저장 성공 또는 원래 오류와 구분하고 안전한 상대 경로·오류 종류·errno만 전달합니다. 기존 파일을 임의로 일괄 청소하지 않습니다.

원본 등록·판본 변경·위키 저장·AI 분석은 각각 별도 완료입니다. 새 판본 추가는 기존 본문/그래프/검토 승인과 그 기준 판본을 자동 변경하지 않습니다. 이번 구현에서 `_jobs`·추출물·공통 규약·MCP 새 도구·CLI/PTY·Electron 화면·운영 권한 부여는 시작하지 않습니다. 실행은 [README](../README.md#원본-등록업로드), 실제 검증과 남은 범위는 [PLAN](PLAN.md#r1-원본-등록업로드-구현검증-2026-10-25)에 둡니다.

#### 업로드·목록·작업 API와 권한

**일반 API와 MCP는 같은 위키 백엔드의 두 진입점**입니다. 별도 파일 서버·다른 데이터 사본·UI 전용 무인증 조회 경로를 만들지 않습니다. 현재 `core/mcp_server.py`의 HTTP 실행은 MCP 전송이며 아래 일반 API가 이미 구현됐다는 뜻은 아닙니다.

바이너리는 Electron main이 같은 서버의 인증된 HTTPS 파일 API로 전송합니다. MCP의 JSON 인자/대화 컨텍스트에 원본 전체 base64를 넣거나 원격 PC의 `C:\\...` 경로만 보내지 않습니다. HTTP와 MCP는 같은 자료 서비스·저장 모듈·접근 정책을 재사용하며 별도 무인증 파일 서버를 만들지 않습니다. 아래 이름/경로는 **후속 구현의 계약 이름**이며 현재 명령이나 도구 목록에 추가됐다는 뜻이 아닙니다.

| 표면 | 설계할 요청과 반환 |
| --- | --- |
| HTTP `GET /api/v1/access-context` | Electron이 현재 서버 인증 주체·허용 tenant/관점·행동을 조회. MCP `access_context`와 같은 `AccessPolicy.describe()` 계약을 사용하며 사용자 ID를 요청 인자로 대체하지 않음 |
| HTTP `POST /api/v1/tenants/{tenant}/sources` | 파일 multipart 또는 직접 입력 JSON을 수신. `request_id`, 제목/형식과 입력 바이트를 검증하고 `source_id/source_version/source_sha256/registration_revision` 및 원본 저장 영수증 반환 |
| HTTP `POST .../sources/{source_id}/versions` | `expected_registration_revision`에서 새 원본 판본 추가. 같은 request_id의 중복 전송과 원본 교체 충돌을 구분. 기존 판본/파생 본문은 보존 |
| HTTP `GET .../sources` 및 `GET .../sources/{source_id}` | 페이지 있는 등록 목록과 원본 판본/변환/파생 문서·처리 상태 조회. 아래 목록 계약을 적용 |
| HTTP `GET .../documents` | 등록 원본과 기존 위키 문서를 함께 발견하는 Electron 문서 목록. 원본만 있는 항목·1:N 파생 문서·원본 연결 없는 기존 문서를 포함하며 아래 페이지/완전성 계약을 적용 |
| HTTP `GET .../documents/content?document=...`, `GET .../documents/knowledge?document=...` | 서버가 검증한 상대 문서 참조로 최신 본문/revision 및 그래프/검토 상태를 조회. 기존 WikiStore·ReviewStore 조회를 재사용해 `effective_graph/policies`·미검토·pending·source/graph/state revision·완전성을 반환하며 machine층을 현재 유효 지식으로 대신하지 않음 |
| HTTP `GET .../sources/{source_id}/versions/{source_version}/file` | 권한 확인 후 해당 판본의 원본 스트리밍. 서버 파일 경로/영구 공개 URL을 응답하지 않음 |
| HTTP `POST .../analysis-jobs`, `GET .../analysis-jobs`, `GET .../analysis-jobs/{job_id}` | 분석할 원본 판본·예정 문서/범위·원하는 산출물에서 작업 생성, 허용 작업의 페이지 목록/단건 상태 조회. 목록은 주체·대상·상태 필터와 서버 관측 상태/영수증을 사용하며 필터별 노출·cursor/예산은 구현 전에 고정. 생성 자체로 CLI/AI를 실행하거나 성공 판정하지 않음 |
| HTTP `POST .../analysis-jobs/{job_id}/heartbeat`, `POST .../analysis-jobs/{job_id}/cancel` | heartbeat는 인증 주체·run_id·expected_lease_revision으로 서버 시각의 lease 갱신. cancel은 expected_job_revision으로 후속 단계 중단을 기록. 만료/취소된 시도의 새 저장은 거부하며 완료된 저장을 되돌리지 않음 |
| HTTP `GET .../requests/{request_id}` | 응답을 받기 전에 끊겨 source/job ID를 모를 때 인증 주체·tenant에 묶인 요청 영수증과 예약 ID/처리 상태 조회. request_id만 알아도 다른 주체의 요청을 읽을 수 있는 기능이 아님 |
| HTTP `POST .../analysis-jobs/{job_id}/artifacts` | 호스트 bridge가 CLI의 큰 표/페이지 이미지 등 산출물 파일을 같은 서버에 업로드. 현재 권한·본인 job/run·입력 묶음·job 기준·lease/취소를 검사하고 불변 artifact ID/hash·영수증 반환. 업로드만으로 본문/그래프 저장이나 입력 묶음 교체를 하지 않음 |
| HTTP `GET .../extractions/{extraction_id}`, `GET .../extractions/{extraction_id}/content` | Electron이 불변 extraction의 manifest·원본/실행 계보·범위/경고/완전성과 문자/표 내용을 조회. MCP `source_extraction_read`와 같은 자료 서비스·현재 tenant read 검사를 사용. 내용은 extraction/hash·구성에 묶인 고정 페이지/cursor로 읽고 next/complete/truncated/skipped를 반환하며 일부 페이지만 읽고 전체로 표시하지 않음 |
| HTTP `GET .../extractions/{extraction_id}/artifacts/{artifact_id}` | 허용 tenant의 공개된 불변 extraction에 실제 연결된 산출물만 인증 스트리밍. 미제출 staging 파일/다른 extraction 참조를 허용하지 않고 호스트가 반환 hash와 실제 바이트를 대조 |
| 새 MCP `source_read`, `source_extraction_read` | 고정 원본 metadata/판본/hash·파일 참조와 이미 제출된 불변 추출물의 범위/완전성·출처를 읽음. 파일 참조는 같은 서버의 인증된 파일 API로 호스트가 받으며 서버 변환을 실행하지 않음 |
| 새 MCP `source_extraction_submit` | 본인 job/run·파일 읽기 입력 묶음·`expected_job_revision`에서 CLI의 문자/표·산출물 참조·읽기/변환 manifest를 제출. 서버가 원본 기준·범위·hash·형식/한도·artifact 소속을 검증하고 불변 extraction ID/hash·새 job_revision·영수증 반환. 본문/그래프 저장과 구분 |
| 새 MCP `analysis_job_claim`, `analysis_job_query` | 해당 인증 사용자의 작업을 CLI 실행에 원자적으로 연결하고 입력 기준/시도 ID/실행 상태 조회. 작업 ID를 권한으로 사용하지 않음 |
| 새 MCP `analysis_job_update` | run_id·expected_job_revision에서 CLI의 분석 시작/중단·오류/차단 사유를 제한된 상태로 보고. CLI 보고와 서버 저장 영수증을 구분하며 완료/저장 성공을 임의 선언할 수 없음 |
| 새 MCP `analysis_job_wiki_write`, `analysis_job_ontology_generate` | job/시도·원본/등록 기준에 결과를 연결하는 저장 래퍼. 본문은 기존 `WikiStore.save()`, 그래프는 기존 `OntologyStore.generate()`를 재사용하며 현재 `wiki_write`/`ontology_generate` 인자에 임의 필드를 추가하지 않음 |

원본 읽기·다운로드·문서/등록/작업 목록·본문/지식 조회는 허용 tenant의 `read`로 처리합니다. **`source_write` 권한**의 원본 등록/판본 추가 경로와 정책 parser를 구현했습니다. CLI 추출물/산출물 제출·보관은 후속 설계이며 canonical 위키/그래프/검토 쓰기를 부여하지 않습니다. 로컬 도구 실행 능력은 서버 쓰기 권한이 아니며 read만 가진 CLI가 추출물을 서버에 제출하지 못합니다. 위키 저장에는 기존 `write`, 그래프 저장에는 기존 `ontology_write`, 검토/전문가 판단에는 종전 별도 권한을 사용합니다. 작업 생성/claim/단계 진행은 본인 작업과 그 단계에서 필요한 권한을 검사하며 권한을 다른 실행자에게 양도하는 큐로 사용하지 않습니다. 새 권한의 실제 부여는 별도 운영 요청이며 현재 read13을 이 권한으로 해석하거나 자동 확장하지 않습니다.

HTTP의 입구 인증만으로 tenant/행동을 승인하지 않습니다. 각 HTTP·MCP 요청에서 현재 `AccessPolicy.authorize()`의 사용자·tenant·행동을 확인하고 프로필은 조회 관점으로만 사용합니다. 지식 조회는 허용 profile을 선택해 기존 검토/정책의 적용 범위를 보존합니다. CLI의 claim 주체와 이후 저장 주체가 다르면 거부합니다. 작업 생성 당시 권한은 다음 단계의 권한을 보장하지 않습니다. 새 HTTP 경로에는 Host/Origin·실제 수신 바이트·형식과 파일별 요청 한도를 별도로 적용하며 기존 `/mcp`의 보호·8 MiB 요청 한도가 파일 API에도 자동으로 적합하다고 가정하지 않습니다.

다른 PC의 Electron main과 그 안의 CLI는 **같은 위키 백엔드의 일반 API/MCP 주소**를 사용하도록 각각 연결합니다. UI는 HTTP access-context, CLI는 MCP `access_context`로 실제 서버 사용자/허용 tenant를 확인하고 작업 접수 주체를 대조합니다. 각 PC에서 별도 위키 서버/공식 자료 복사본을 만들어 동기화하지 않습니다. 위키 접근 비밀은 호스트의 보호된 저장소/설정에서 읽고 renderer·요청문·PTY 입력에 넣지 않습니다. 현재 Mac의 로컬 stdio 연결이 이 원격 설정으로 자동 전환됐다는 뜻은 아니며 실제 주소·인증 발급·원격 전환은 별도 구현/배포 gate입니다.

CLI가 파일을 읽어야 할 때 MCP에서 받은 `tenant/source_id/source_version/source_sha256`을 제한된 호스트 다운로드 bridge에 전달합니다. bridge는 설정된 같은 서버의 인증된 파일 API에서 해당 판본만 받아 실제 바이트 hash를 대조하고 사용자 PC의 앱 전용 비공개 작업 디렉터리에 둡니다. 임의 URL·다른 서버 리디렉션·서버 절대 경로·파일명으로 조립한 셸 명령을 실행하지 않습니다. 로컬 작업 경로는 CLI 도구 입력으로만 쓰고 서버 계보/규약/공유 문서에 넣지 않습니다. 같은 PC에서 방금 고른 파일도 서버 영수증의 판본/hash와 실제 바이트를 확인한 뒤에만 재사용합니다. 작업용 사본은 공유 저장소나 폴더 동기화본이 아니며, 실패/미확인 초안을 보존하고 서버 제출 영수증을 확인한 뒤 해당 작업의 임시 파일만 정리합니다.

초기 설계 상한은 원본 **20 MiB**, CLI 추출 출력 합계 **64 MiB**, 로컬 읽기/변환 도구 실행 **120초/500페이지**입니다. 로컬 실행 상한은 CLI 어댑터가 적용하고 서버는 실제 수신 크기·형식/범위·manifest를 검사하며 자기보고만으로 실행 시간을 증명하지 않습니다. 이 시간은 AI 전체 작업 시간 제한이 아닙니다. 원본/추출물 한도는 기존 위키 **문서당 UTF-8 1 MiB**·현 MCP HTTP 요청 **8 MiB**와 별개입니다. 큰 산출물은 같은 파일 API로 올린 뒤 MCP로 참조/manifest를 제출하며 요청 한도를 우회하는 거대한 base64를 만들지 않습니다. 한도 초과는 자르기/기존 자료 삭제 없이 중단/범위 확인으로 표시합니다.

서버는 원본 보관 가능 여부를, 공통 규약과 CLI 어댑터는 실제 파일 읽기 지원을 각각 표시합니다. 첫 구현은 `.md/.txt`의 유효한 UTF-8이며 PDF·Word·Excel·Numbers·이미지는 별도 검증 대상입니다. PDF 문자/페이지 읽기, Excel 시트/셀/수식 읽기, 스캔 OCR·이미지/도형 해석은 지원하는 로컬 도구와 CLI 이미지 입력을 연결해 검증해야 합니다. 서버에 파일이 있다는 이유만으로 CLI가 읽었다고 표시하지 않으며 지원/입력 한도가 확인되지 않으면 `conversion_required` 또는 범위 확인으로 멈춥니다. 본문 구성은 원문의 조건·표·인용 위치를 보존하고 원문을 요약문으로 대체하지 않습니다. 이 상한·형식 경로의 실제 성능/정확도는 미검증입니다.

#### 업로드 이후 CLI 요청과 MCP 저장 순서

1. **일반 API로 등록:** Electron이 파일 또는 직접 본문을 업로드하고 원본 저장 영수증을 확인합니다. 응답에는 인증 주체·tenant·원본 ID/판본/hash/크기·카탈로그 revision·저장 상태·정리 경고를 담으며 토큰/클라이언트 절대 경로를 기록하지 않습니다. 원본만 있는 등록 항목도 일반 목록 API로 바로 표시합니다. ‘등록만’은 여기서 끝나고 ‘등록 후 추출’은 이 성공 확인 뒤 같은 후속 작업을 시작합니다. 두 동선을 별도 추출 구현으로 나누지 않습니다.
2. **일반 API로 요청 준비:** 사용자가 기존 등록의 ‘추출 시작’을 누르거나 ‘등록 후 추출’로 이어오면 Electron이 고정 원본 판본과 원하는 본문/전체 그래프·명시적 분할 범위로 작업을 만듭니다. 입력 manifest에는 `job_id`, tenant, source 참조, 관측한 registration revision, 기존 `document/source_revision/graph_revision/state_revision`, 요구 산출물과 요청 범위를 묶습니다. profile은 답변/검토 우선순위이며 전체 원문 추출 범위를 줄이지 않습니다.
3. **Electron이 로컬 터미널 인계:** 기존 xterm → 제한된 preload → main의 node-pty → 개인 CLI를 사용합니다. main이 사용자 PC에서 새 CLI 세션을 열거나 사용자가 명시 선택한 세션에 작업 ID를 포함한 요청을 준비합니다. 초기 동선은 사용자가 CLI에 제출하며 자동 전송은 해당 CLI의 입력 대기 상태를 확인하는 어댑터를 검증한 뒤에만 추가합니다. 따라서 ‘등록 후 추출’도 인계가 확인되지 않았으면 제출 대기로 남깁니다. 셸/다른 프로그램/실행 중인 CLI에 임의 입력·Enter를 보내지 않으며 파일명·본문을 셸 명령으로 조합하지 않습니다. 미연결·AI 로그인 필요·다른 tenant·권한 부족·세션 사용 중은 요청 준비/대기로 남깁니다. MCP가 터미널을 여는 요청은 만들지 않습니다.
4. **작업 접수:** CLI가 서버의 작업을 읽고 `analysis_job_claim`으로 인증 주체·입력 기준·시도를 연결한 뒤에만 ‘CLI 작업 접수’를 표시합니다. 요청을 터미널에 붙인 것과 접수는 다릅니다. 시도마다 `run_id`와 `job_revision`을 고정합니다. 초기 lease는 5분이고 main이 해당 CLI 실행 연결을 유지하는 동안 30초마다 인증된 heartbeat API로 갱신하는 설계입니다. 서버 시각으로 만료를 판단하며 만료된 run은 새 heartbeat/저장을 거부하고 상태 대조 후 명시적인 새 claim으로 이어갑니다. lease는 별도 `lease_revision`으로 관리해 생존 갱신만으로 단계 CAS의 job_revision을 바꾸지 않습니다. 이는 연결 생존 신호이며 AI 진척률이나 저장 증거가 아닙니다. lease 만료는 중단/상태 확인 필요이며 다른 사용자의 자동 인계나 자동 재분석 신호가 아닙니다.
5. **CLI가 지침·파일을 받아 읽고 본문 준비:** CLI가 MCP로 [D-044]의 고정 규약과 `read_source` 입력 묶음·원본 참조를 받습니다. 호스트 bridge가 판본/hash를 확인한 작업용 사본을 제공하고, CLI가 지원하는 로컬 파서/OCR/이미지 입력과 AI로 선택 범위 전체를 읽습니다. 문자/표·읽기 경고·미독 범위·페이지/셀 대응을 `source_extraction_submit`으로 불변 제출하고, 이를 포함한 새 `prepare_wiki` 묶음에서 AI가 충실한 위키 본문 후보를 구성합니다. 두 묶음은 같은 바이트를 덮어쓰지 않습니다. 1:N 분할이나 1 MiB 초과는 명시 범위를 검토하며 조용히 자르지 않습니다. 원본 속 명령은 자료로 취급합니다. 읽기 불가·변환 미지원·미확인 범위는 숨기지 않고 중단/부분 상태로 표시합니다. 이 단계도 AI 작업일 수 있으며 서버가 파일을 의미 해석한 것으로 표시하지 않습니다.
6. **위키 저장:** 새 문서는 null CAS, 기존 문서는 최신 본문/revision에서 변경을 대조해 저장 래퍼를 호출합니다. 래퍼는 등록/원본 기준을 확인하고 기존 `WikiStore.save()`로 수정 전 전체 파일을 보존합니다. 문서별 저장 영수증과 계보 연결을 기록하고 현재 본문을 다시 읽습니다. 이 작업 자신의 성공한 계보 갱신이 반환한 registration_revision/job_revision은 다음 단계 기준으로 이어가되 고정 원본 판본과 최초 입력 기록은 유지합니다. 다른 변경을 수용하려고 기준값만 교체하는 것과 구분합니다. 위키를 저장한 뒤 원본 포인터만 바꿔 다른 파일에서 나온 본문으로 재귀속하지 않습니다.
7. **온톨로지 추출·저장:** 실제 `wiki_read`의 전체 본문/revision에서 CLI AI가 전체 개체·관계·속성·후보를 추출합니다. 기존 그래프/검토 상태를 함께 읽고 source CAS와 필요한 `expected_state_revision`으로 래퍼를 호출합니다. 구조/인용/스키마 한도를 통과한 저장과 의미 정확도/전문가 승인은 구분합니다. 실패 때문에 이미 성공한 위키 저장을 반복하지 않습니다.
8. **Electron이 일반 API로 결과 확인:** 서버가 요청한 각 문서·단계의 영수증/실제 revision을 확인해 완료·부분 완료·결과 미확인을 구분합니다. Electron은 작업·문서 목록·본문·지식 조회 API로 화면을 갱신하며 MCP/AI 호출을 요구하지 않습니다. 백엔드가 기존 `ontology_review_query`와 같은 조회 모듈로 계산한 effective_graph/policies·미검토·pending을 사용하고, 터미널의 ‘완료’ 문구·CLI 종료 코드만으로 저장 성공/사람 승인을 만들지 않습니다.

#### 작업 상태·영수증·부분 실패

원본/본문/그래프/카탈로그의 저장을 하나의 원자 거래로 표현하지 않습니다. `_jobs`는 각 단계의 기준·payload hash·시작/결과·실제 actor·서버 시각·시도·영수증·경고를 보존하는 실행 기록이며 전문가 판단의 `_reviews` Action log가 아닙니다. 클라이언트의 완료 주장으로 저장 상태를 바꾸지 않습니다.

| 서버/화면 상태 | 뜻과 다음 동작 |
| --- | --- |
| 업로드 중 / 원본 보관 완료 | 로컬 전송 진행과 서버의 공개/영수증을 구분. 보관 완료여도 본문/그래프 없음 |
| CLI 요청 준비 / 접수 대기 | 작업 입력은 고정됐으나 CLI claim 없음. 미연결·로그인·권한·사용 중의 이유 표시 |
| CLI 작업 접수 / 본문 준비 / AI 분석 중 | 같은 인증 주체/run에 연결된 단계. 통신 유지와 의미 추출 진척률을 혼동하지 않음 |
| 본문 저장 / 그래프 저장 / 결과 확인 | 문서별 단계 영수증으로 표시. 요청의 전체 대상 수와 성공/실패/미시도 수를 함께 유지 |
| 완료·미검토 | 요청한 저장 단계를 확인한 결과. 그래프 ready는 원문 버전 일치이며 내용 정확도/전문가 승인이 아님 |
| 부분 완료 / 변환 필요 / 한도·범위 확인 필요 | 성공한 원본·본문·일부 문서를 유지. 실패/미시도 단계와 읽지 못한 범위를 표시하고 그 단계에서 재개 |
| 기준 변경 / conflict / 권한 차단 | 새 원본·본문·그래프/검토 또는 권한을 대조할 때까지 기존 초안 보존. 기준값만 갈아 끼우지 않음 |
| 실행 중단 / 취소 | CLI/PC 종료·사용자 취소 뒤 더 진행하지 않음. 완료된 서버 저장은 유지하며 자동 rollback/재실행 없음 |
| 결과 미확인 / pending_reconcile | 통신 유실 또는 자료 저장 뒤 영수증/카탈로그 갱신 실패. 재조회로 확인하기 전 쓰기 재전송 금지 |

`request_id`는 tenant·인증 주체·동작·payload hash에 연결하는 멱등 키로 구현합니다. 같은 키/같은 입력의 확인된 요청은 기존 ID/영수증을 반환하고, 같은 키/다른 입력은 거부합니다. **작업 ID만 추가한다고 정확히 한 번의 저장이 보장되지는 않습니다.** 단계별 intent를 먼저 기록하고 저장 결과를 기록하는 사이의 장애를 복구 대상으로 둡니다. 자료 저장 뒤 기록만 실패하면 자료를 되돌리거나 다시 쓰지 않고 `pending_reconcile`로 둡니다. 영수증이 없는데 현재 내용 hash가 같다는 이유만으로 이 요청의 성공/작성 주체를 확정하지 않습니다.

새 등록/작업 경로는 tenant별 별도 조정 잠금에서 원본 현재 판본 변경·claim·heartbeat·cancel과 저장 래퍼의 기준 확인/실행을 직렬화합니다. 잠금 순서는 항상 **등록/작업 조정 잠금 → 기존 저장 모듈의 잠금**이며 역순 획득을 금지합니다. 조정 잠금 안에서 현재 권한·registration/job 기준·run·취소·서버 시각의 lease를 확인하고 단계 intent를 기록한 뒤 기존 `save()`/`generate()`를 호출해 저장 결과를 기록합니다. `WikiStore.save()` 바깥에서 같은 비재진입 저장 잠금을 다시 잡는 중첩 호출로 구현하지 않습니다. 일반 기존 위키/검토 쓰기는 종전 저장 잠금과 source/state CAS로 경쟁을 검사합니다.

만료/취소/새 판본이 이 단계의 실행 승인 전에 반영됐으면 저장 호출을 거부합니다. 이미 승인해 시작한 저장은 도중 강제 rollback하지 않으며, 조정 잠금에서 기다리던 취소/새 판본은 해당 저장 결과 기록 뒤 적용해 후속 단계를 막습니다. lease 만료 직전에 시작한 저장도 실제 결과를 보존하고 다음 호출에서 만료를 검사합니다. 원본 공개·카탈로그·작업 기록과 기존 위키/그래프 저장 사이의 장애를 실제 실패 주입으로 검증하기 전에는 여러 파일의 원자성/자동 복구를 약속하지 않습니다. 오래된 실행이 새 원본/본문을 현재 결과로 덮지 않도록 registration/job 기준과 기존 source/state CAS를 함께 대조합니다.

`storage_busy`는 같은 기준으로 나중에 재시도할 수 있습니다. conflict는 최신 본문·그래프·검토와 초안을 대조해 재반영/재추출합니다. 성공의 `cleanup_failures`는 경고이며 쓰기 재전송 사유가 아닙니다. 원본 업로드·위키 저장이 성공한 뒤 그래프/영향/목록 조회가 실패해도 성공 단계를 반복하지 않습니다. 취소·앱 종료는 이미 완료된 저장을 지우지 않고, 재연결 시 job/자료를 읽어 실패/미시도만 명시적으로 재개합니다. 새 판본에서 옛 승인·후보 답·전문가 정책을 자동 이식하지 않습니다.

#### 문서 목록·결과 표시와 UI 인계

- 목록의 상위 항목은 등록 원본이며 하위에 파생 위키 문서를 펼칩니다. 제목·원본 종류·원본 판본·본문 기준 판본·작업 상태·그래프 최신/미생성/stale·미검토/재검토를 보여 줍니다. 원본만 등록된 항목과 1:N 문서도 발견 가능해야 합니다. 상세에서 원본 판본 다운로드, 준비 본문/변환 경고, 위키 전체 본문, 그래프·근거·현재 판단/이력으로 이어갑니다.
- 목록은 tenant 안의 등록 카탈로그와 기존 wiki 문서를 함께 발견합니다. 기존 세 위키처럼 원본 계보가 아직 없는 문서는 ‘원본 연결 없음’으로 표시하고 누락시키지 않습니다. 이름이 비슷하다고 기존 원본과 자동 연결하지 않습니다. `wiki_search(".md")`를 전용 전체 목록/페이지 API로 취급하지 않습니다.
- 기본 20/최대 50항목, 안정 정렬과 `catalog_revision`·마지막 키에 연결한 불투명 cursor를 설계합니다. 응답은 `next_cursor/complete/truncated/skipped`와 적용 필터를 반환합니다. 페이지 사이 자료/권한 변경은 재조회/부분 결과로 드러내며 전체 시점 고정이나 전체 영향 없음으로 과장하지 않습니다. 사용자/tenant별 캐시를 분리하고 프로필은 자료 접근 필터로 사용하지 않습니다.
- 초기 갱신은 일반 API로 실행 중 작업의 metadata를 5초 간격, 보이는 목록을 30초 간격/화면 복귀 시 다시 읽는 방식으로 설계합니다. 숨긴 화면의 불필요한 조회를 멈추고, 쓰기 직후 관련 항목을 무효화합니다. 알림 전송은 후속 선택이며 최초 구현에 SSE/WebSocket을 필수로 넣지 않습니다. 원본 파일을 주기적으로 다시 내려받아 PC 폴더와 동기화하지 않습니다. 선택한 본문/그래프의 바뀐 버전만 가져오고 편집 초안은 보존합니다. 개인 CLI를 종료해도 다른 허용 사용자의 목록·기존 결과 조회는 계속 동작해야 합니다.
- CLI 로그인/연결 상태, 서버 로그인/tenant/권한, 업로드/본문 준비/분석/저장 상태를 각각 표시합니다. 내부 ID·물리 파일 경로·프로토콜을 기본 사용자 화면에 반복하지 않고 상세/지원 정보로 제공합니다. 새 원본만 교체된 상태, 일부 문서 저장, 변환 미지원, 결과 미확인에서 다음 행동을 명확히 합니다.
- 등록 요청은 선택한 파일/입력 종류·본문·판본의 스냅샷에 묶습니다. 업로드 응답을 기다리는 동안 입력을 바꿔도 영수증을 새 입력의 결과로 붙이거나 초안을 잃지 않습니다. 파일 첨부에서 직접 본문 입력으로 전환할 때 이전 파일명/자동 읽기 본문을 새 텍스트 원본의 출처로 옮기지 않습니다. 결과 상세는 저장 당시 영수증과 현재 본문·그래프·검토 상태를 따로 보여 줍니다.
- UI 디자인 담당은 기존 **‘위키 사용 사례 목록화’** 채팅입니다. [D-039]의 1920×1080·UC-01~19·온톨로지/근거·전문가 판단 구분을 보존하면서 이 흐름을 적용합니다. 일반 API 등록/목록 → Electron의 로컬 CLI 요청 준비/접수 → CLI의 MCP 추출·저장 → 일반 API 작업/결과 → 문서/그래프/이력 이동을 기준으로 삼고 모의 연결과 실제 서버 영구 저장을 구분합니다. 앞선 시안 검증은 당시의 모의 동선이며 이번 API/CLI 책임 변경의 실제 연결 검증으로 재사용하지 않습니다. 이번 개정은 계획/결정 문서만 수정하며 다른 채팅 재지시·시안/앱 구현은 실행하지 않습니다. 구체 화면 검증 결과는 [PLAN](PLAN.md)에 통합하고 계약을 UI 코드/별도 문서에 중복 정의하지 않습니다.

구현 순서와 완료 조건은 [PLAN의 D-043 후속 범위](PLAN.md#d-043-원격-등록cli분석-후속-구현과-검증-계획)에서 관리합니다. 실제 배포 위치/계정 제공자·운영 권한 부여, CLI별 로컬 파일 읽기/이미지·다운로드 bridge·추출물 업로드·자동 인계 어댑터와 패키징은 미결/미구현이며 다음 단계를 자동 시작하지 않습니다.

### D-047 — 원격 PC의 최초 연결과 설정 수명주기 (2026-10-25)

상태: **사용자가 확인한 최종 작업 환경의 요구와 설정 동선 설계**입니다. 현재 같은 PC의 실행에서 끝내지 않고, 다른 작업 PC의 Electron이 서버 PC의 FastAPI 일반 API를 호출하며 같은 작업 PC의 개인 CLI가 서버 MCP에 접속합니다. D-043의 두 진입점·공통 인증/저장 경계를 유지합니다. 기존 시안은 연결 상태 표시만 있고 서버 미설정 상태에서 시작하는 설정 동선이 없었으므로 이를 별도 사용 사례로 보완합니다. 이번 변경은 문서 설계이며 실제 서버 배포·네트워크 공개·자격 증명 발급/입력·MCP 설정 적용·UI 구현을 실행하지 않습니다.

#### 두 PC의 역할과 설정 진입점

| 위치 | 책임 |
| --- | --- |
| 서버 PC | 하나의 위키 백엔드가 일반 API와 MCP를 제공하고 같은 tenant 자료·인증/행동 정책·저장 모듈을 사용. 데이터 위치·상시 실행·HTTPS 주소와 운영 관리는 서버 측 책임 |
| 작업 PC | Electron의 일반 API 연결, 개인 CLI/AI 실행과 MCP 연결, 필요한 작업용 파일의 수신. 서버 PC의 Python 환경·절대 파일 경로·위키 저장소를 작업 PC에 복제하는 것을 전제로 하지 않음 |

최초 실행·서버 미설정·인증 실패 때는 tenant 접근 확인 전에 **연결 설정**을 열 수 있어야 합니다. `WorkspaceBoundary` 안의 작업 공간 화면만을 진입점으로 두지 않습니다. API 연결만 완료한 사용자는 저장된 자료 조회를 시작할 수 있으며 개인 AI 준비를 나중에 이어갈 수 있습니다. 작업 공간 설정에서는 연결 관리로 돌아오는 경로를 제공합니다. 화면 배치·책임은 [앱 설계의 최초 연결](../app/docs/component-architecture.md#31-원격-pc의-최초-연결과-연결-관리)에서 관리합니다.

#### 최초 연결과 변경 사용 사례

기존 UC-19와 대화에서 정의한 ‘작업 범위 확인/개인 AI 준비’의 세부 흐름이며 기존 UC 번호를 바꾸지 않습니다. 아래 CON 번호는 이 설정 설계 안의 참조입니다.

| 참조 | 사용자 상황·목표 | 완료 결과 |
| --- | --- | --- |
| CON-01 처음 자료 서버 연결 | 새 작업 PC에서 원격 서버 주소와 서버용 개인 인증을 설정 | 일반 API에서 확인한 자기 소속·허용 행동·관점으로 작업 공간을 선택하고 읽기 시작. 인증/조회 실패를 빈 공간으로 표시하지 않음 |
| CON-02 개인 AI·MCP 연결 | 자료는 읽을 수 있으나 새 질문/분석을 실행하려 함 | 선택한 로컬 CLI의 실행/AI 로그인과 실제 MCP 인증·허용 행동을 각각 확인. API/MCP 대상 일치의 확인 수준을 표시하고 준비된 범위만 명시 실행 |
| CON-03 저장한 연결 다시 사용 | 앱 재시작·다른 PC의 새 설치·인증 변경 뒤 재접속 | 해당 PC의 연결/인증을 다시 확인하고 같은 허용 서버 자료를 읽음. 기기 간 인증정보 자동 복제·자료 동기화를 가정하지 않음 |
| CON-04 서버·인증·공간 변경 | 서버 주소나 사용자/소속이 달라짐 | 적용 전 변경 대상을 확인하고 이전 요청/캐시/초안과 분리. 성공한 기존 작업은 보존하고 새 연결을 검증한 뒤 전환 |
| CON-05 연결 진단·복구 | API만 연결됨, MCP 실패, 권한 회수, 지원 버전 불일치 등 | 실패한 계층과 다음 행동을 식별하고 다시 확인. 재연결로 새 분석·쓰기·권한 상승을 자동 실행하지 않음 |
| CON-06 원격 접속 준비·인계 | 운영자가 새 작업 PC에 접속 방법을 제공해야 함 | 서버 주소·지원 경로/클라이언트·자격 증명 전달/회수·허용 공간/행동과 운영 담당을 인계. 실제 값·배포 방법은 운영 준비 때 확정 |

#### 입력·확인·저장 경계

- **자료 서버 설정:** 연결 표시명, 서버 기본 주소와 일반 API/MCP의 실제 경로를 하나의 연결 대상으로 관리합니다. D-043의 `/api/v1`·`/mcp`를 기본 설계로 제시하되 reverse proxy의 경로 prefix 등 실제 배포 경로는 확인해야 합니다. 두 URL의 문자열 유사성만으로 같은 저장소라고 승인하지 않습니다. 원격에서는 검증된 HTTPS 연결을 사용하며 임시 legacy 터널 절차를 개인 인증 운영 연결로 그대로 간주하지 않습니다.
- **인증:** 현행 PoC의 개인 서버 자격 증명과 개인 AI 로그인을 구분합니다. 서버 인증은 Electron main/CLI의 각각 정한 보호된 경로에서 다루며 URL·채팅·작업 본문·위키·로그·일반 앱 상태에 비밀을 저장하지 않습니다. 보호 저장소의 구체 구현·CLI별 비밀 전달·발급/회전 방법은 후속 설계/검증 사항입니다. 같은 인증 주체를 확인하는 것과 같은 토큰 바이트를 공유하는 것은 다릅니다. OAuth/SSO·관리자 발급 UI가 구현됐다고 표시하지 않습니다.
- **공간 선택:** 일반 API의 예정된 access-context와 MCP의 실제 `access_context`로 자기 소속·허용 profile·행동을 각각 확인합니다. 입력한 tenant나 화면의 권한 체크박스가 권한을 부여하지 않습니다. 서버 권한 오류를 다른 주소/legacy/과거 정책으로 우회하지 않습니다.
- **CLI 설정:** 지원할 CLI/어댑터·설치 경로·개인 AI 로그인 상태를 확인하고 MCP 설정의 대상·변경 전후·적용 범위를 보여줍니다. 기존 다른 MCP 등록을 보존하고 확인되지 않은 셸/실행 중 CLI에 임의 입력을 보내지 않습니다. 자동 설정 편집의 지원 범위·백업/충돌·취소/복구·재시작 필요 여부는 어댑터별 구현 전에 고정합니다. 일반 API 연결 성공을 CLI의 실제 MCP 초기화/인증 성공으로 대신하지 않습니다.
- **연결 시험:** API 도달/인증/소속 확인, 실제 MCP 프로토콜 초기화·도구/접근 맥락 확인, 지원 계약·버전과 허용 행동을 분리해 표시합니다. 설정 검증은 기본적으로 읽기만 사용합니다. 쓰기 권한이 있다는 응답을 저장 성공 증거로 표시하지 않으며 실제 쓰기 시험은 격리 자료·별도 실행 범위로 다룹니다. 개인 AI 준비도 새 모델 호출이나 분석 실행과 구분합니다.
- **대상 일치:** API와 MCP의 동일 백엔드·인증 주체·tenant 여부를 확인하는 안정된 식별/호환성 handshake는 아직 제공되는 계약이 아닙니다. 구체 반환 필드·검증 방법을 후속으로 정하고 정책 hash나 hostname만으로 완료를 선언하지 않습니다. 필수 대조가 미확인이면 그 상태를 유지하고 새 AI 저장 실행을 허용하지 않습니다. 확인된 API 읽기는 별도로 이용할 수 있습니다.
- **수명주기:** 연결 저장·서버 변경·인증 교체·로그아웃/연결 해제·재시작 뒤 재확인을 설계합니다. 주체/서버/tenant가 달라지면 이전 요청의 늦은 응답과 자료를 새 공간에 표시하지 않습니다. 초안은 원래 범위에서 보존하며 연결 전환이 운영 자료를 이동/삭제하지 않습니다. 앱 자격 증명 제거와 서버의 실제 토큰 회수는 다른 동작입니다.

#### 설정 시안 반영 (2026-10-25)

이후 요청에 따라 기존 1920×1080 HTML에 최초 연결·연결 관리를 반영했습니다. 전역 진입점은 tenant 확인 전에도 열리며, API 확인 후 자료 읽기와 개인 AI 준비를 분기합니다. 서버 설정 초안/적용 연결·CLI/MCP 모의 등록과 확인 수준을 분리하고, 취소·주소 전환·실패·재연결에서 기존 초안/성공 작업과 다른 MCP 등록을 보존합니다. 새 연결에 옛 범위 자료를 섞지 않으며 대상 일치 계약이 미확인이면 새 AI 요청·저장을 허용하지 않습니다.

이는 화면과 메모리 상태의 시연입니다. 서버 인증 필드는 비활성화했고 실제 비밀 입력/저장·네트워크·CLI 설정 적용·권한 변경을 수행하지 않습니다. 실제 두 PC 연결 완료와 구분하며 확인한 동선·검사·소스 hash는 PLAN의 별도 시안 검증 기록을 따릅니다. 위 문서 설계 당시의 미실행 기록은 보존합니다.

#### 미결 계약과 실제 완료 기준

서버 공개 주소·배포/인증서 운영, 자격 증명 발급/회수·PC별 보호 저장/전달, API/MCP의 안정된 대상 식별과 호환성 handshake, 지원 CLI/OS별 설정 어댑터와 변경 복구, 작업용 파일 전송의 실제 연결은 미구현/미검증입니다. 이 목록은 각각 D-026/041/043/044의 계약을 연결하며 새 권한을 도입하지 않습니다.

설정 UI 시연, 같은 PC의 loopback 확인, 과거 공유 토큰의 Windows MCP 시험, 새 개인 인증의 실제 두 PC 통합을 각각 기록합니다. 최종 연결 완료는 **다른 작업 PC에서 개인 인증 API 읽기와 CLI의 MCP 연결을 실제로 확인**해야 합니다. AI 분석/저장·파일 전달의 완료는 그 후 별도 범위로 검증하며 초기 읽기 연결과 합산하지 않습니다. 검증 조건과 실행 결과는 [PLAN](PLAN.md#원격-pc-최초-연결의-후속-검증-조건)에서 관리합니다.

### D-048 — 서버 노트북의 WSL2와 Electron 중앙 저장 (2026-10-25)

상태: **사용자가 채택한 운영 방향과 가이드 문서화 / 서버 설치·배포·자료 이전·앱 연결은 미실행**입니다. 사용하지 않는 Windows 노트북을 서버로 두고 여러 작업 PC의 Electron 앱이 같은 서버 자료를 저장·활용하려는 요구에 따라 결정했습니다. 설치·운영 절차는 [WSL2 서버 가이드](WSL2_SERVER_GUIDE.md), 구현 순서·검증 결과는 [PLAN](PLAN.md#wsl2-서버-노트북과-중앙-저장의-후속-작업)에서 관리합니다.

- **실행 환경:** 서버 노트북에 WSL2·Ubuntu를 설치하고 기존 Python 백엔드를 Linux 환경에서 실행합니다. 작업 PC에는 서버용 WSL2/Python/tenant 자료의 복제를 요구하지 않습니다. 개인 AI CLI의 설치 환경은 해당 클라이언트 지원 조건을 따릅니다. 현재 POSIX 파일 잠금·안전한 파일 읽기·권한 검사를 유지해 Windows 네이티브 이식을 선행 조건으로 추가하지 않는 것이 선택 이유입니다.
- **중앙 자료와 서비스:** WSL의 Linux 파일시스템에 tenant별 자료와 전체 이력·검토/정책/대응 원장을 함께 보관합니다. D-043/D-046의 한 백엔드가 FastAPI와 MCP를 제공하고 같은 현재 인증/권한·업무 서비스·저장소를 사용합니다. Electron 일반 요청은 API, 개인 CLI의 AI 분석/제출은 MCP를 사용하며 저장된 자료 읽기는 개인 AI 실행과 독립적으로 구현합니다.
- **서버 로컬 LLM은 후속 검토:** 사용자는 로컬 LLM의 추가 구축·운영 부담을 고려해 현재 정책으로 먼저 진행하기로 했습니다. 추출·보완은 각 작업 PC의 개인 AI가 수행하고 서버는 공통 지침·맥락 제공과 저장·조회·검증을 맡는 기존 방향을 유지합니다. 서버 로컬 LLM의 1차 추출은 현재 구현 범위와 선행 조건에 추가하지 않으며, 추후 별도 요청에서 필요성·모델·자원·추출/보완 이력 계약을 검토합니다. 도입 시점과 제품은 아직 정하지 않았습니다.
- **배포와 접속:** 백엔드는 loopback과 HTTPS 프록시/터널 경계를 유지하고, 상시 접속에는 고정 HTTPS 주소와 부팅 후 자동 시작·장애 재시작을 준비합니다. Windows 작업 스케줄러가 WSL 전경 프로세스를 실행하는 배치 예시를 가이드에 둡니다. 실제 도메인·터널 제공자/계정·경로·운영 사용자·자격 증명/백업과 재부팅 후 도달 여부는 배포에서 확정·검증합니다.
- **보존과 권한:** 실제 Mac 연결은 이번에 바꾸지 않습니다. 이전 시 D-041의 쓰기 동결·전체 보존/대조·동일 tenant 귀속과 복구 기준을 지킵니다. 과거 data/원격 시험 자료를 운영 자료에 합치거나 read 정책을 자동 승격하지 않습니다. D-047의 최초 설정·개인 인증·API/MCP 대상 대조와 D-043의 저장 성공/실패 경계도 유지합니다.
- **완료의 범위:** 가이드·방향 합의를 WSL 실기기 실행, FastAPI/Electron 구현, 두 PC의 개인 인증 연결이나 AI/쓰기 성공으로 표시하지 않습니다. 실제 일반 API와 통합 실행 진입점은 R1에서 구현하며 현재 없는 명령/설치 파일을 배포된 기능으로 안내하지 않습니다.

## 4. 원문 추출과 업무 맥락

### D-018 — Codex 추출과 문서별 온톨로지 (2026-10-22, 4단계)

상태: 문서별 생성·보존의 기본 계약입니다. v1 표현은 [D-022]·[D-024], 검토 상태 충돌 보호는 [D-028]에서 보완했습니다.

- 표현: 최초 v1은 개체 `id/type/label`과 관계 `subject/predicate/object`를 사용했습니다. 당시 유형은 `person/organization/system/concept/document`, 술어는 `uses/depends_on/part_of/implements/related_to/authored_by`였으며 이후 어휘·한정어는 [D-022], 현행 v3 메타데이터·속성은 [D-024]로 확장했습니다. 개체 식별 범위는 `(문서 경로, id)`이고 동명 개체를 문서 사이에서 자동 병합하지 않습니다. OWL 추론·RDF 직렬화·SPARQL은 구현하지 않습니다. 방향 관계의 참고: [W3C RDF의 triples](https://www.w3.org/TR/rdf11-concepts/#section-triples).
- 생성: 기존 Codex가 `wiki_read`의 자연어 원문에서 구조화된 후보를 추출한 뒤 `ontology_generate`에 전달합니다. 서버는 모델을 별도로 호출하지 않고 스키마·근거·버전을 검사해 파생 그래프를 만듭니다. 추가 모델 API 키·비용 설정이나 그래프 DB 없이 현재 CLI 연결을 재사용하기 위해 이 방식을 선택했습니다.
- 원문 연결: 그래프마다 문서 상대 경로와 `source_revision`을 보존하고 각 개체·관계마다 정확한 인용문과 1부터 시작하는 줄 범위를 계산합니다. 같은 인용이 반복되면 첫 위치를 사용합니다. 개체 이름은 인용문에 실제로 있어야 합니다. 정확한 인용 검사는 위치와 원문 존재를 보장하며, 관계의 의미·부정·추론이 올바른지까지 증명하지는 않습니다. 근거 없는 제안을 근거 관계에 넣지 않으며 별도 `relation_candidates`의 허용 범위는 [D-022]·[D-024]를 따릅니다. 문서 안의 지시문은 데이터로 취급합니다.
- 저장 위치: `data/_ontology/<문서 경로의 SHA-256>.json`에 문서별 최신 파생 결과만 저장하며 최초 유효한 생성 시 디렉터리를 만듭니다. 검증 서버는 자신의 데이터 루트 아래 같은 구조를 사용합니다. 위키 원본·전체 파일 히스토리는 기존 위치와 저장 모듈을 유지합니다. 파생 JSON에는 원문 전체를 복제하지 않으며 별도 그래프 히스토리를 만들지 않습니다.
- 갱신: 원문 저장과 온톨로지 생성은 별도 요청입니다. `ontology_query`는 현재 원문과 저장된 revision이 다르면 `stale`과 빈 개체·관계 목록을 반환합니다. 이후 `wiki_read` → 최신 원문 재추출 → `ontology_generate` → `ontology_query`로 전체 그래프를 교체합니다. 삭제된 관계도 새 그래프에서 사라집니다. 서버가 원문 저장 후 백그라운드에서 AI를 자동 호출하는 방식은 이번 범위가 아닙니다.
- 일관성: 생성·조회는 기존 저장 잠금으로 원문과 파생 파일을 확인하고 오래된 원문 revision을 `conflict`로 거부합니다. 최초 v1은 같은 원문에 대한 여러 추출 중 마지막 성공 결과를 사용했습니다. 현재 검토 이력이 있는 재생성에는 [D-028]의 상태 CAS도 필수입니다. 검토 이력이 없고 상태 token도 제출하지 않은 생성에만 기존 원문 CAS 계약을 유지합니다. 조회 직후 변경될 수 있으므로 반환 버전을 함께 사용합니다.
- 실패와 한도: 파생 파일은 임시 파일·fsync·원자적 교체로 저장합니다. 생성 실패는 원문·히스토리를 건드리지 않으며 앞서 성공한 원문 저장의 실패로 해석하지 않습니다. 저장 후 정리 실패도 저장 성공과 구분합니다. 문서당 최대 개체 100개·관계 200개, 이름 120자·인용 1000자, 파생 JSON 1 MiB를 허용합니다. 심볼릭 링크·깨진 스키마·알 수 없는 필드·없는 관계 끝점·중복 ID/관계를 거부합니다. 깨진 캐시를 빈 그래프로 숨기지 않습니다. 크기 제한 이내의 손상된 JSON은 유효한 재생성으로 교체할 수 있지만, 상한 초과·비일반 파일·심볼릭 링크는 자동 교체하지 않고 운영자가 확인해야 합니다.
- 조회: `missing`은 미생성, `stale`은 원문 변경, `ready`는 해당 원문 버전의 유효한 추출입니다. `ready`에서 빈 목록이면 개체·관계가 없는 것으로 추출한 결과입니다. `ontology_query`는 문서별 기계 추출을 조회합니다. 전체 문서의 그래프 검색·자동 개체 통합은 제공하지 않으며, 문서 간 연결은 [D-019], 선택 문서 맥락은 [D-027], 검토·정책 반영 조회는 [D-028]·[D-031]로 구분합니다.

### D-022 — 조건을 보존하는 온톨로지 v2와 사용자 검토 후보 (2026-10-22, 4단계 보완)

상태: v2에서 도입한 의미·후보 규칙은 현재도 적용합니다. 기본 생성 버전은 [D-024]의 v3이며 검토 API는 [D-028]에서 추가했습니다.

- 이유와 범위: D-021 원문 검증에서 지지되는 일부 관계만으로 문서의 핵심 설명을 보존할 수 없었습니다. 분류·과정·조건·예측을 표현하도록 기존 저장·MCP 계약을 확장합니다. UI·논리 추론 엔진·자동 개체 병합은 이번 범위에 포함하지 않습니다. 앞선 원문 검증 자료는 이번 설계의 개발 자료로 취급하고 최종 평가는 새 원문과 새 세션을 사용합니다.
- 버전 호환: v2 도입 당시 새 생성은 `schema_version=2`였습니다. v1 파일은 당시의 유형·술어·필드로 엄격하게 읽고 디스크를 자동 변환하지 않습니다. v1 `ready`에는 `needs_reextraction=true`를 반환하여 느슨했던 `part_of`를 새 의미로 재해석하지 않도록 합니다. 현재 MCP 생성은 [D-024]의 v3이며, 구버전 생성·읽기 호환과 재추출 표시는 해당 계약을 따릅니다. 버전 숫자만 바꾸지 않고 최신 원문에서 의미를 다시 추출합니다.
- 개체: 기존 다섯 유형에 `process`(과정·사건), `physical_object`(물리 대상·구조), `substance`(물질), `place`(장소)를 추가합니다. `system`은 소프트웨어와 하드웨어 시스템을 포함합니다. 이름·유형의 존재만으로 종류와 개체를 구분할 수 없으므로 실제 분류 관계는 문맥과 인용으로 검토합니다. 가상의 과정 이름이나 원문에 없는 개체를 만들어 label 제약을 우회하지 않습니다.
- 분류·구성: `subclass_of`는 하위 종류→상위 종류, `instance_of`는 특정 개체→종류입니다. `part_of`는 문맥에서 식별한 **구조적 구성 부분·영역→전체**이며 재료 종류·분류·단순 위치·참여·사용·순서가 아닙니다. `composed_of`는 전체→구성 물질, `located_in`은 대상→위치입니다. 일반 물질과 특정 영역의 경계가 모호하면 후보로 남깁니다. 종류/개체의 구분은 [W3C OWL2 Primer](https://www.w3.org/TR/owl2-primer/), 부분과 분류·순서의 차이는 [W3C part-whole 설계 초안](https://www.w3.org/2001/sw/BestPractices/OEP/SimplePartWhole/)을 참고했습니다. 후자는 Editor's Draft이며 이 PoC가 OWL을 구현한다는 뜻은 아닙니다. 자동 추이·역관계 추론은 하지 않습니다.
- 과정·예측: `has_input`·`has_output`은 과정→입력·결과, `participates_in`은 참여자→과정, `precedes`는 앞 단계→뒤 단계입니다. `causes`·`enables`·`prevents`는 각각 원인·가능하게 하는 요인·방지 요인→해당 결과입니다. `measures`는 측정 주체→측정량, `observes`는 관측 주체→대상, `predicts`는 명시된 예측 지표·모델→예측 대상, `supports_prediction`은 예측을 돕는 자료·요인→예측 대상입니다. 순서·관측·예측은 인과나 결과 발생 확정으로 해석하지 않습니다. 기존 여섯 술어는 유지합니다.
- 한정어: 관계에 `qualifiers`를 추가합니다. `polarity`는 `positive/negative`, `modality`는 `asserted/possible/capability/planned/hypothetical`이며 원문의 주장 방식을 뜻합니다. `condition`·`scope`·`time`은 각각 조건, 대상·빈도·수량·비교 범위, 시점·기간의 정확한 원문 문자열 또는 null입니다. 기본값은 positive/asserted/null/null/null입니다. 비null 문자열은 같은 관계의 evidence 안에 있어야 합니다. 조건 하나에 if/unless·AND/OR와 적용 범위를 유지하며 이를 실행 가능한 논리식으로 평가하지 않습니다. 중복 판단에는 삼중항과 한정어 전체를 포함하여 다른 조건의 같은 관계를 잃지 않습니다. 복합 논리·정량 계산·확률 모델은 여전히 표현 한계입니다.
- 일반 연관: D-020의 엄격한 `related_to` 보류 정책을 v2에서 보완합니다. 직접 서술된 구체적 관계의 정확한 술어가 없을 때 제한적인 일반 연관은 남길 수 있지만, 생략된 방향·기능·정량 의미는 `omissions`에 명시합니다. 일반 연관을 추가했다고 원문의 의미를 완전히 보존한 것으로 평가하지 않습니다.
- 검토 후보: `relation_candidates`는 문서 연결의 이름 일치 `candidates`와 다른 컬렉션입니다. 각 후보는 `id/subject/predicate/object`, 선택적 실제 `evidence` 또는 null, 한정어, 필수 `reason/question`을 가집니다. 관계 끝점은 원문으로 확인한 개체만 참조합니다. 근거가 없으면 인용을 발명하지 않고 null을 사용하며 텍스트 한정어도 null이어야 합니다. 이유에는 모호함·가정·추가 자료를, 질문에는 사용자가 확인할 구체적 주장과 유지/수정/보류·거절 선택을 적습니다. 후보 수는 최대 50개, 이유 1000자·질문 500자입니다. 기존 개체 100개·근거 관계 200개·인용 1000자·파생 JSON 1 MiB 한도도 유지합니다.
- 후보의 상태와 갱신: 서버는 후보의 `status=needs_review`를 고정하고 입력의 status·승인·confidence 필드를 거부합니다. 동일 주장·한정어의 관계/후보 중복도 거부합니다. 조회는 후보를 관계와 분리하며 원문이 바뀌면 둘 다 stale로 숨깁니다. 원문 변경·CAS·히스토리·실패 시 보존은 기존 저장 모듈을 그대로 사용합니다. 후보를 자동 승격하지 않습니다. 이후 추가된 사용자 검토 저장 API는 [D-028]의 별도 원장을 사용하며 원시 후보의 `needs_review`를 승인 표시로 바꾸지 않습니다. 직접 생성 요청의 의미적 진위를 서버가 검증할 수 없다는 기존 제한은 유지됩니다.
- 사용자 확인의 후속 구현: 원문·revision·후보·한정어·모호한 이유를 제시하고 수용·수정·거절·보류를 별도 이력으로 남기는 계약은 [D-028]에서 구현했습니다. 원문 인용 없는 업무 정책은 [D-031]의 별도 권한·출처를 사용합니다. 후보를 근거 관계로 수용하는 것과 전문가 업무 정책을 만드는 것은 같은 작업이 아닙니다. 공유 토큰은 사람을 식별하지 못하며 모델의 `approved_by_user` 입력으로 확인을 대신하지 않습니다. 실제 검토 화면은 [D-033]의 시안입니다.
- 이번 모의 검토: 사용자의 요청에 따라 에이전트가 모호하거나 근거가 없는 관계를 후보로 제안하고 시험 답을 고를 수 있습니다. 답은 `simulation`으로 기록하며 실제 사용자 승인·원문 사실로 승격하지 않습니다. 후보의 검토 적절성과 원문 관계의 의미 보존을 별도로 평가합니다. 새 원문 검증자에게 후보의 이유·질문이나 생성자의 omissions를 먼저 보여주지 않고 후보 주장·근거·한정어만 전달합니다.

### D-023 — 업무 관점과 수식된 개념의 검증 범위 (2026-10-22, 4단계 보완)

상태: 현재 의미 구분 원칙과 v2 당시 한계의 기록입니다. 구조화 필드는 [D-024], 사용자 조회 관점과 추출 범위의 구분은 [D-036]을 따릅니다.

- 구분: 같은 대상의 다른 업무 관점, 같은 이름을 쓰는 서로 다른 업무 실체, 조건·시점에 따른 분류를 별도로 검토합니다. 예를 들어 상품의 카탈로그·배송·마케팅 속성은 같은 대상을 가리킬 수 있지만 제품모델·SKU·판매제안·출고 묶음은 문맥상 서로 다른 대상일 수 있습니다. 이름이나 상품id 문자열만으로 이를 합치지 않습니다. [Microsoft의 bounded context 설명](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/domain-analysis)은 같은 실세계 대상도 업무별 모델이 달라질 수 있음을 설명합니다. [Schema.org Product](https://schema.org/Product)와 [Offer](https://schema.org/Offer)는 제품의 규격·판매자별 SKU와 판매제안의 가격·가용 기간 등을 구분하는 참고 사례이며, 이번 PoC가 그 표준을 구현한다는 뜻은 아닙니다.
- 수식어: 할인·인기·매진 임박은 서로 배타적인 상품 종류로 고정하지 않습니다. 원문에 따라 조건부 분류·일시 상태·평가/광고 주장으로 취급하고, 기간·매장·채널·판단 주체·기준과 실제 조건 충족을 구분합니다. 인기 기준·재고 임계값을 모델이 임의로 정하거나 일반 규칙만 보고 특정 상품에 적용하지 않습니다. 광고가 직접 붙인 분류를 기록하는 것과 그 광고의 객관적 진실을 확인하는 것도 구분합니다. 기준 미상은 확인 질문의 대상이며, 원문의 명시 주장 자체를 지우는 이유는 아닙니다.
- 이번 범위: 기존 추출·검토 역할에 이 판단 절차를 추가하고 저장 경계 회귀와 합성 업무 사례의 별도 생성·검증을 수행합니다. 평가용 시나리오의 내용·선행 질문을 프롬프트 교정에 사용하지 않습니다. 시나리오는 합성 자료이며 외부 실제 문서·업무 전문가 검증이나 일반 정확성의 증거로 부르지 않습니다. 코드의 보존 검사가 통과한 것과 의미 표현이 충분한 것을 별도로 보고합니다.
- v2 당시 지원: 조건·범위·시간이 다른 분류와 복수 분류를 보존하고 문서별 ID·후보·stale 처리를 제공했습니다. 당시 관점은 scope 문자열로 남겼으며, 이후 구조화된 업무 영역·관점·식별 범위·속성은 [D-024]에서 추가했습니다.
- 후속 보완과 남은 한계: v2에서 없던 업무 관점 식별자·외부 식별자 발급 범위·속성 값/자료형/단위 및 같은 type+label의 구분은 [D-024]가 보완했습니다. 실행 가능한 분류 규칙·기간 만료·관점 간 자동 불일치 탐지와 의미적 진위 판정까지 구현한 것은 아닙니다.
- 후속 설계 위치: v3 저장 계약은 [D-024], 등록 힌트와 관리되는 Bounded Context는 [D-035], 이름 없는 상태 조건과 공통 개념의 대응은 [D-037]에서 관리합니다. 뒤의 두 항목은 현재 기능과 구분합니다.

#### 업무 영역과 이해관계자 관점의 분리

카탈로그·배송·마케팅은 **어떤 업무를 설명하는가**라는 영역 축이고, 현업·개발자·아키텍처는 **어떤 질문에 답하려는가**라는 관점 축입니다. 둘을 하나의 배타적인 분류 목록으로 섞지 않습니다. 예를 들어 배송 영역에도 현업의 출고 기준, 개발자의 규격 검증, 아키텍처의 물류 서비스 경계가 함께 존재합니다. 할인·인기·매진 임박의 조건부 분류와 적용 시점은 이 두 축과 별도로 보존합니다.

다음은 같은 할인 정책을 관점별로 읽는 예시이며, 필드·술어의 정의는 D-024를 따릅니다. 조회 관점으로 추출 대상을 줄이지 않는 원칙은 D-036을 따릅니다.

| 관점 | 확인할 질문 | 할인 정책의 표현 예 |
| --- | --- | --- |
| 현업 | 어떤 목적·기준으로 누구에게 적용하고 누가 결정하는가? | 대상 상품·고객, 할인 조건·예외·유효기간, 승인 담당 |
| 개발자 | 어떤 데이터와 동작으로 구현하고 어떻게 검증하는가? | 할인율 필드·자료형·단위, 입력 검증, 계산 함수·API·이벤트, 테스트 |
| 아키텍처 | 어느 시스템이 책임지고 다른 시스템과 어떻게 연결되는가? | 가격 정책·데이터의 소유 서비스, 서비스 경계·의존성, 변경 전파·일관성·성능 요구 |

- 관점 간 연결: 현업의 정책을 어떤 함수·API가 구현하고 어느 서비스가 소유하는지 근거를 따라 연결할 수 있어야 합니다. 동일 정책을 설명하는 표현과 정책·코드·서비스라는 서로 다른 개체를 구분합니다. 같은 용어나 상품 ID만으로 동일 개체로 병합하거나 구현 관계를 만들지 않으며, 근거 없는 대응은 검토 대상으로 남깁니다.
- 관점의 범위: 한 사람이나 문서에 관점 하나를 고정하지 않습니다. 같은 문서의 구절·주장마다 여러 업무 영역과 관점이 겹칠 수 있고 위 예시는 책임을 독점적으로 배정한 것이 아닙니다. 작성자·주장 주체·원문 revision은 관점과 별도로 추적해야 합니다. 관점 자체는 사실의 진위나 접근 권한을 결정하지 않습니다.
- 차이와 불일치: 현업 문서의 할인 종료가 자정이고 구현 설명은 23시라면, 같은 정책·적용 조건·시간대·버전 및 요구/계획/실제 동작 여부를 먼저 대조합니다. 대응이 확인된 차이를 단순한 관점 차이로 덮거나 어느 한쪽을 자동으로 정답 처리하지 않습니다. 원문 근거와 차이를 남겨 확인하고, 적용 범위가 다르거나 대응 자체가 불명확하면 그 불확실성도 구분합니다.
- 후속 검증 조건: 같은 업무 영역의 세 관점을 구분하면서 근거 있는 정책→구현→책임 서비스 연결을 보존하는지, 다른 업무 영역의 같은 이름을 합치지 않는지, 한 문서의 복수 관점·계획과 실제의 차이·정책 변경 후 오래된 연결을 식별하는지 확인해야 합니다. 모호한 대응은 사용자에게 근거와 대안을 제시하는 대상이며, 모델의 가상 확인을 사람의 판단으로 기록하지 않습니다.
- 구현 상태: 이 절의 초기 관점 설계는 이후 [D-024]의 메타데이터, [D-026]의 프로필, [D-027]의 조회 구성으로 구체화했습니다. 자동 대응 관리·불일치 탐지를 구현했다는 뜻은 아닙니다. 실제로 실행한 평가와 남은 범위는 [PLAN](PLAN.md)에 모읍니다.

### D-024 — 관점·식별 범위·속성 주장·출처를 보존하는 v3 (2026-10-22, 4단계 보완)

상태: 현재 AI 추출·원문 근거 해석의 v3 계약입니다. 전문가의 원문 밖 판단은 별도 [D-031]을 따릅니다.

- 이유: 심층 평가에서 이름이 같은 다른 실체와 속성·책임·주장 출처를 일반 연관으로 표현하면서 핵심 의미를 잃었습니다. D-023의 두 축을 실제 저장 계약으로 옮기고, 표현 가능한 부정·범위·완료 누락도 추출 지침에서 보완합니다. 이전 심층 평가 중 사용한 6개 사례는 개발 자료로 전환하며 최종 평가는 새 원문으로 수행합니다.
- 범위: 기존 `OntologyStore`·MCP 도구를 확장합니다. v3 스키마 확장에는 새 DB·외부 모델 API·논리 엔진·UI·자동 병합을 추가하지 않았습니다. 이후 사용자 검토는 [D-028], 전문가 정책은 [D-031]의 별도 계층으로 구현했습니다. 구조·정확한 인용·revision 검사는 의미적 지지나 사람의 확인을 대신하지 않습니다.
- 두 축: 개체 및 각 주장의 `context={domain,viewpoints}`에서 domain은 해당 evidence의 업무 영역 문자열 또는 null, viewpoints는 중복 없는 `business/developer/architecture` 배열입니다. 한 사람이나 문서를 하나의 관점으로 고정하지 않습니다. 태그는 정규화된 의미 분류이고 domain은 정확한 원문 문자열입니다. 태그의 진위는 별도 의미 평가 대상입니다.
- 식별 범위: 개체의 `identifiers=[{namespace,value,evidence}]`는 최대8개입니다. namespace/value는 각 식별자 evidence의 정확한 문자열이며 각각 최대120자입니다. 전역 ID를 발명하지 않습니다. v3의 같은 type/label은 context나 식별자 범위·값이 구별될 때 별도 로컬 ID로 보존할 수 있습니다. 근거 위치나 배열 순서만 바꿔 중복 제약을 우회할 수 없습니다. 관점 차이 자체를 다른 실제 실체의 증거로 보지 않습니다.
- 대응과 책임: `view_of`는 표현·뷰→원대상, `same_as/different_from`은 원문이 명시한 동일성/차이 주장입니다. 어느 경우에도 개체를 병합하거나 역관계·추이관계를 생성하지 않습니다. `responsible_for`는 책임 주체→대상, `approves`는 승인 주체→대상이며 저작·소속·단순 관여를 이 관계로 바꾸지 않습니다. 기존 `part_of` 의미는 D-022 그대로입니다.
- 속성: `attributes`는 최대200개의 `{id,subject,property,datatype,value,unit,evidence,qualifiers,context,provenance}`입니다. property 최대120자·value 최대500자·unit 최대120자 또는 null이며 해당 evidence에 그대로 등장해야 합니다. datatype은 `text/number`, 숫자 value도 JSON 문자열입니다. number는 유한 십진수 표기이며 부호·소수점·선행0을 그대로 유지합니다. 지수·천단위 쉼표 등 지원하지 않는 표기는 text로 보존할 수 있으며 자동 환산·반올림·분류 판정은 하지 않습니다. 동일 속성의 서로 다른 시점·관점·주장 주체는 별도 주장으로 유지합니다.
- 주장 출처: 관계·후보·속성의 `provenance={source_entity,attributed_to,basis}`에서 source_entity는 document 개체, attributed_to는 person/organization/system 개체, basis는 해당 evidence의 근거 상태 구절입니다. 없는 값은 null입니다. 원문 문서와 revision은 그래프 수준에서 계속 유지합니다. 문서 저자·분석 담당자·주장 주체를 자동으로 같다고 보지 않으며 basis의 “검증” 문구는 이 시스템에서 승인했다는 뜻이 아닙니다.
- 후보: 명시된 추정·미검증 주장은 출처와 양태를 붙여 보존합니다. 원문에 없는 대응이나 규칙 적용으로 도출한 분류는 `relation_candidates`로 분리합니다. evidence=null 후보는 빈 context/provenance와 null 텍스트 한정어만 허용합니다. 서버 상태는 계속 `needs_review`이며 위조 승인 필드는 거부합니다. 속성값을 발명하거나 모호한 관계를 자동 승격하지 않습니다.
- 조회: domain과 viewpoint 필터는 exact domain과 viewpoint 포함 여부를 함께 적용해 관계·속성·후보를 고릅니다. 참조 해석용 개체 전체는 유지하고 `filtered`에 요청 범위를 돌려줍니다. 필터에서 빠진 항목은 부정 사실·미존재·접근 권한의 증거가 아닙니다. 문서 연결은 기존 이름·유형 후보를 유지하며 끝점의 context/identifiers도 제공합니다.
- MCP 문자열 경계: 설치된 SDK의 nullable 문자열 사전 파싱에서 `"null"`이 필터 없음으로 바뀌는 문제를 실제 재현했습니다. MCP 필터는 비nullable 문자열로 받고 생략 또는 빈 문자열만 미설정으로 취급합니다. JSON null·배열·객체·숫자는 거부하고 `"null"/"[]"/"{}"` 같은 도메인 이름은 그대로 보존합니다. Python 저장 API는 None을 미설정으로 받습니다.
- 호환·보존: 기본 생성은 v3이며 v1/v2의 읽기는 기존 어휘·필드를 엄격하게 유지합니다. 구버전 명시 생성은 Python `OntologyStore.generate()`에서만 지원하고 MCP 생성은 v3입니다. `ready` 조회에서 v1/v2는 `needs_reextraction=true`, v3는 false이며 `missing/stale`에는 이 필드가 없습니다. 자동 파일 변환은 없으므로 최신 원문에서 다시 추출해야 하고 버전 숫자만 바꿀 수 없습니다. 원문 변경 시 개체·관계·후보·속성 모두 stale로 숨깁니다. 새 배열과 메타데이터도 전체 JSON 1 MiB 제한, 기존 잠금·CAS·실패 보존 규칙에 포함합니다.
- 남은 범위: 사실의 자동 검증, 문서 간 전역 동일성·충돌 해결, 실행 가능한 복합 논리·단위 환산·수치 비교 질의, 속성 후보 전용 모델은 제공하지 않습니다. 사람의 검토 이력은 [D-028], 원문 인용 없는 정책은 [D-031]을 따릅니다. 이 절의 인용·provenance 제약은 AI 추출과 원문 근거 해석에 적용하며 전문가 정책의 Action log 출처와 혼동하지 않습니다.

### D-035 — 문서 등록의 맥락 힌트와 Bounded Context 간 대응 검토 (2026-10-23)

상태: 등록 힌트·관리되는 Bounded Context·문서 간 대응 검토의 **설계 후보**입니다. 비교 실험은 수행했지만 입력 필드·저장/버전·MCP 계약과 제품 기능은 미확정·미구현입니다.

이 중 공통 규약과 함께 명시 선택한 맥락을 전달하고 분석 입력 버전에 고정하는 계약은 이후 [D-044]에서 설계했습니다. 관리되는 Bounded Context 등록부·자동 맥락 선택·힌트의 독립 편집 API를 구현하거나 이 절의 후보 전체를 확정한 것은 아닙니다.

- 개념 근거: [Martin Fowler의 Bounded Context 설명](https://martinfowler.com/bliki/BoundedContext.html)은 내부적으로 일관된 모델의 범위와 범위 간 관계를 명시합니다. [Microsoft의 도메인 분석 설명](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/domain-analysis)은 같은 실세계 대상도 업무마다 별도 모델을 가질 수 있고, context map으로 모델 간 상호작용과 책임을 나타낼 수 있다고 설명합니다. D-023에서 참고한 상품의 업무별 차이를 문서 등록과 검토 흐름으로 구체화하는 제안입니다. 이후 공식 원문 네 구절의 비교 실험에서는 맞는 힌트의 우위를 확인하지 못했고, 로컬 정의의 인용만으로 시스템 간 대응을 과하게 확정하는 오류를 확인했습니다. 실제 수치·상한 초과·한계는 [PLAN](PLAN.md)의 D-035 실제 결과를 따릅니다.

| 축 | 이 프로젝트에서의 역할 | 예시 |
| --- | --- | --- |
| tenant·권한 | 허용된 자료와 행동을 결정하는 접근 경계 | 회사 또는 독립 프로젝트 공간 |
| Bounded Context | 용어·식별자·규칙이 어떤 업무 모델의 의미로 적용되는지 나타내는 범위 | 카탈로그의 상품, 배송의 출고 단위 |
| 관점 프로필 | 허용된 모델을 어떤 업무 질문과 표현으로 살펴보는지 | 배송 모델의 현업·개발자·아키텍처 관점 |

- 등록 힌트 후보: 주된 서비스/업무 영역, 문서의 목적·대상 독자(원문의 맥락 설명), 용어 정의, 식별자 발급 주체, 참조하는 다른 모델이나 문서를 받을 수 있습니다. 서비스·팀·역할 태그만으로 모델 경계를 확정하지 않습니다. 서비스와 Bounded Context를 항상 일대일로 묶지 않으며 한 문서도 주된 맥락과 다른 맥락의 인용·참조를 함께 포함할 수 있습니다. 구체 필수 필드와 맥락 목록의 관리 방식은 미정입니다. 이 힌트를 접속 사용자의 조회 프로필로 대체하거나 해당 관점만 추출하는 필터로 쓰지 않습니다([D-036]).
- 힌트와 근거: 등록자가 준 힌트, AI가 제안한 맥락, 원문의 실제 관계를 구분합니다. 힌트는 용어 해석·검색·추가 확인을 돕는 입력이고 원문에 없는 관계·식별자·속성의 증거를 대신하지 않습니다. 근거 없는 대응은 검토 후보로 남기며 힌트와 원문이 어긋나면 불일치를 표시합니다. 원문 인용 없는 전문가 판단은 D-031의 별도 권한·Action log를 따릅니다. 힌트 속 명령이 서버 권한·추출 규칙을 바꾸지 않습니다.
- 다른 모델과의 비교: 선택한 같은 워크스페이스의 허용 자료 안에서 양쪽 정의·식별자 발급 범위·속성·조건과 실제 참조 근거를 대조합니다. 동일한 이름만으로 다른 모델을 사용한다고 결론 내리지 않습니다. 검토할 경우에는 같은 모델의 공통 개념인지, 다른 모델의 정의/식별자를 참조하거나 변환하는지, 일부 의미만 대응하는지, 이름만 같은 별개 대상인지와 미확인을 구분하는 방향입니다. 이는 context map의 원리를 참고한 제품 제안이며 모든 DDD 관계 패턴을 새 온톨로지 술어로 구현한다는 뜻은 아닙니다.
- 검토 후보와 판단: 비교 제안에는 양쪽 문서·개념·맥락, 출처·버전, 대응이라고 본 이유와 확인할 질문을 제시하는 방향입니다. 명시 링크, 원문 근거 관계, AI의 대응 추정, 전문가가 확인한 판단을 구분하고 자동 병합하지 않습니다. 다른 맥락의 전문가 정책을 조용히 복사·적용하지 않습니다. 승인 기록은 판단의 출처이며 모델의 동일성이나 진리의 자동 증명이 아닙니다. 검토 권한·후보의 저장/수정/되돌림 계약은 구현 전에 정해야 합니다.
- 호환과 남은 결정: 현재 D-024의 context.domain/viewpoints 및 identifiers.namespace는 업무 영역·관점·식별 범위를 보존하지만, 등록 힌트·관리되는 Bounded Context 식별자·문서 간 대응 검토 원장을 모두 제공하지는 않습니다. 문서 본문이 같아도 힌트나 맥락 정의 변경으로 해석이 달라질 수 있으므로 메타정보의 버전·출처와 파생 결과의 재검토 기준을 별도로 설계해야 합니다. 기존 source_revision만으로 이 변경을 추적했다고 간주하거나 임의 필드를 현재 MCP 인자에 추가하지 않습니다.

원문 비교에서 동명 용어·명시 참조·잘못된 힌트·문서의 복수 모델 범위를 실험했습니다. 다른 tenant 비노출, 힌트/맥락 정의 변경의 버전·재검토와 대응 승인/되돌림은 아직 검증하지 않았습니다. 후속 계약에서는 대응 끝점의 문서·개체 ID·revision과 설명형 표기를 분리하고, AI의 `source_supported` 표시나 양쪽 인용만으로 대응을 확정하지 않아야 합니다. 기존 데이터 보존·버저닝·권한·최신 전문가 판단 조회 계약을 유지하며 이 기록은 여전히 설계 후보입니다. 실제 검증 범위는 [PLAN](PLAN.md)을 따릅니다.

### D-044 — MCP 공통 추출 규약·맥락과 분석 입력 버전 관리 (2026-10-24)

상태: **사용자가 요청한 설계 반영**입니다. 각 사용자의 로그인된 CLI가 파일 읽기·AI 본문 구성·온톨로지 추출을 수행하고, 같은 위키 백엔드의 MCP가 단계별 공통 지침·출력 스키마·필요 맥락을 버전과 함께 제공합니다. Electron의 업로드·목록·결과 조회는 [D-043]의 일반 API를 사용합니다. D-043의 작업·저장 래퍼를 확장하는 후속 계약이며 이번에 역할 프롬프트·서버 코드·현행 MCP 인자·운영 권한·원문/그래프/원장을 변경하지 않습니다. 새 도구·규약 배포·실제 AI 연결은 미구현이고 5단계는 미착수입니다.

- 이유: 저장 형식만 통일하면 개체 경계·관계 의미·조건 보존·참고한 정의와 판단이 실행자마다 달라질 수 있습니다. 공통 기준과 입력 출처를 서버에서 고정해야 결과 차이를 추적하고 검토할 수 있습니다. 같은 입력의 동일 JSON이나 의미 정확도를 보장하는 결정은 아닙니다.
- 적용 단위: 같은 tenant에서 승인한 동일 규약 릴리스를 사용합니다. 사용자 계정·조회 프로필을 이유로 의미 규칙이나 전체 원문 추출 범위를 바꾸지 않습니다. 업무 맥락 차이는 명시한 입력 데이터와 적용 범위로 남기며 다른 tenant의 정의·정책을 먼저 읽어 숨기는 방식은 사용하지 않습니다.

#### 공통 지침의 원본과 배포

초기 의미 지침은 현재 [.agent/wiki_ontology.toml](../.agent/wiki_ontology.toml)의 개체 유형·술어/방향·인용·조건/예외·식별 범위·속성·후보·출처·제출 전 점검을 재사용합니다. 스키마는 `core/modules/ontology/validation.py`·`values.py`·`constants.py`의 실제 검증 계약과 `core/mcp/schemas.py`의 입력 모델에 대조합니다. [D-024]·[D-036]의 원문 충실성·전체 추출 원칙을 유지하며 새 의미 규칙이나 작은 실험용 출력 상한을 이번에 추가하지 않습니다.

파일 읽기 단계에는 형식별 지원 도구/입력·원본 판본/hash 확인·페이지/시트/셀 대응·누락 보고를, 본문 구성 단계에는 원문 의미/조건·표·인용 위치의 보존과 AI 전사/재구성의 출처 구분을 포함하도록 후속 규약을 준비합니다. 온톨로지 의미 지침은 기존 기준을 유지합니다. 이 추가 단계 지침은 이번에 역할 프롬프트나 실행 규약으로 구현하지 않으며, 현재 온톨로지 역할 파일만으로 PDF/OCR/Excel 읽기까지 지원한다고 표시하지 않습니다.

후속 구현에서는 의미 지침을 `.agent/`의 공통 원본으로 한 번 분리하고, 역할 프롬프트와 서버 릴리스가 이 원본을 참조/조립하도록 합니다. 프로젝트 경로·AGENTS/PLAN 읽기·역할 호출·파일 담당·분리 평가 운영 절차는 로컬 역할에 남깁니다. 전체 역할 파일을 원격 AI의 작업 지침으로 배포하거나 같은 의미 지침을 역할/도구 설명/문서에 각각 수동 복제하지 않습니다. 도구 설명은 규약을 받는 진입점과 필수 보존 원칙을 안내합니다.

서버 관리자가 명시적으로 발행한 규약만 사용합니다. 규약에는 지침 본문, 실제 출력 스키마, 용어·관계 정의, 개발용 예시, 호환 조건과 변경 이유를 묶고 각 구성 바이트의 SHA-256을 manifest에 기록합니다. 릴리스 manifest의 정확한 UTF-8 바이트 hash를 `ruleset_revision`으로 사용하며 manifest 자체 안에 자기 hash를 넣지 않습니다. 규약 ID/버전 표시는 내용을 대신하지 않고, 같은 ID·버전의 내용을 덮어쓰지 않습니다. 스키마와 서버 검증기가 어긋난 릴리스는 발행/사용을 거부합니다. 개발용 예시와 비공개 평가 정답·검증 질문·옛 점수는 구분하며 후자를 배포물에 넣지 않습니다.

규약 릴리스와 tenant별 기본/사용 허용 규약 설정은 tenant 자료 루트 밖의 검증된 서버 설정·배포 영역에서 관리합니다. 다른 tenant의 업무 정의·비밀·토큰을 공통 릴리스에 넣지 않습니다. 읽기·원본 등록·그래프 쓰기·전문가 정책 권한은 규약 발행 권한이 아니며, 발행은 서버 관리 변경으로 분리합니다. 현재 권한 parser나 read13을 확장하지 않습니다. 불변 릴리스와 작업 입력의 보존 사본은 실행 이력이며 수동 편집하는 두 번째 지침 원본이 아닙니다.

#### 규약·맥락·작업 입력의 별도 버전

| 대상 | 보존할 식별·버전과 의미 |
| --- | --- |
| 출력 스키마 | 현행 `schema_version=3`과 정확한 스키마 hash. 지침 개정만으로 그래프 스키마 숫자를 올리지 않음 |
| 공통 규약 | `ruleset_id/ruleset_version/ruleset_revision`, 구성별 hash·호환 서버/스키마·발행 기록. 표시 버전과 내용 hash를 구분 |
| 작업별 입력 묶음 | 서버 발급 `bundle_id/bundle_revision`, `job_id/run_id/stage`, 실제 전달 내용과 참조 manifest. 원본/맥락/규약의 어느 하나가 달라도 새 묶음 |
| 원문과 변환 계보 | D-043의 원본 판본/hash·호스트 수신 바이트 hash·CLI의 읽기/변환 제출 extraction ID/hash·선택/미독 범위와, 그래프 단계의 실제 `document/source_revision`. 서버 수신 검증과 CLI 실행 자기보고를 구분하며 서로 대체하지 않음 |
| 정의·조건·예외 등 맥락 | 문서/원문 revision·인용 줄, 기계 그래프의 `graph_revision`, 검토의 `claim_id/state_revision`, 정책의 `event_id`·정확한 적용 범위와 상태 |
| 조회와 실행 정보 | 허용 profile 정의·접근정책 revision, 요청/포함/미포함 범위, 필수 여부·완전성, 서버 관측과 CLI 자기보고를 구분한 모델/설정·입력 조립 기록 |

`bundle_revision`은 전달할 불변 manifest 바이트의 SHA-256이며 구성별 내용 hash를 포함합니다. ID는 서버가 발급하고 hash를 권한·사람 승인·실제 모델 실행 증명으로 사용하지 않습니다. 입력 manifest/구성 바이트·원시 제출·실제 저장 영수증은 D-043의 tenant 내 `_jobs/<job_id>/`에 보존합니다. 현재 그래프가 바뀌어도 당시 규약·입력·제출을 재구성할 수 있어야 합니다. 위키 본문이나 v3 `provenance`에 규약 버전·외부 정책·실행 출처를 억지로 넣지 않으며 기존 `_history`·`_reviews`를 대체하지 않습니다.

#### 필요한 맥락의 선택과 출처 보존

- 대상 원문은 해당 단계의 명시 범위 전체를 제공합니다. 필요한 정의·조건·예외 문서는 요청자/검토자가 같은 tenant의 허용 문서에서 명시 선택하고, 각 문서가 필요한 이유와 필수 구성(원문·검토 상태 등)을 입력 목록에 고정합니다. 서버는 선택된 집합을 공통으로 제공하며 아직 선택하지 않은 관련 문서를 자동으로 모두 찾았다고 표시하지 않습니다. 목록 변경은 새 입력 묶음으로 준비합니다. 자동 선택·전역 의미 검색·관리되는 Bounded Context 등록부는 별도 후속 범위입니다.
- 원문/기계층은 [D-027]의 보존 캡처를 재사용하고, 현재 검토·전문가 판단은 [D-028]·[D-031]의 조회 로직으로 별도 캡처합니다. `effective_graph/policies`와 미검토·보류·`pending_history`, `active/other_scope/pending/inactive`, 실제 한정어·범위·출처를 함께 남깁니다. `ontology_context`의 machine층만으로 전문가 판단을 확보했다고 하지 않습니다. 명시적으로 이력 없음/해당 정책 없음이 확인된 상태와 조회 실패를 구분합니다.
- 선택 문서의 전체 원문과 다른 관점·미분류 제약을 유지합니다. profile의 `focus`만 뽑거나 기존 유효 그래프 일부를 새 전체 추출 결과로 재전송하지 않습니다. 기존 그래프가 없는 신규 문서는 그 사실을 기록하고, 필수 원문/검토 상태가 확보됐다면 선택적 machine 그래프 부재만으로 차단하지 않습니다.
- 외부 정의·기존 판단·등록 힌트는 해석 참고이며 대상 원문 사실의 evidence가 아닙니다. 원문과 어긋나면 차이·확인 질문을 남깁니다. 이전 거절/정책에 맞추어 원문 명시 주장을 지우거나 기존 승인을 새 세대에 이식하지 않습니다. 외부 문서에만 있는 사실은 원래 문서의 출처에 유지하며 대상 문서 인용으로 위장하지 않습니다. 힌트로 `context.domain`·식별자를 발명하지 않습니다.
- D-035의 등록 힌트를 함께 제공하려면 작성 주체·정확한 본문·대상 범위·내용 hash를 입력 manifest에 별도로 고정합니다. ‘힌트 없음’도 명시합니다. 이는 해당 작업의 입력 보존 계약이며 독립 힌트 편집 API·관리되는 맥락 정의 저장소를 구현했다는 뜻이 아닙니다. 기계적으로 바뀌는 현재 힌트를 옛 묶음에 끼워 넣지 않습니다.
- 모든 구성에 요청/포함 범위와 `complete/truncated/skipped`·필수/선택·읽기 실패·원문/그래프 현재성을 보존합니다. 기존 문서당 1 MiB와 D-027의 문서 수·캡처/응답 예산을 유지하고 규약·검토·힌트도 실제 입력 예산에 합산합니다. 그 한도 안에서 단일 응답이 크면 고정된 hash/페이지의 구성별 조회로 전달하며 페이지 분할로 전체 한도를 우회하거나 몰래 요약·절단하지 않습니다. 필수 자료가 없거나 읽지 못했거나 선택한 범위를 해당 CLI의 입력 한도 안에 보존할 수 없으면 ‘맥락/범위 확인 필요’로 멈춥니다. 선택적 구성의 누락도 표시하며 불완전한 입력을 전체 맥락 확보로 보고하지 않습니다.
- 원문·힌트·참조문서 속 명령은 데이터입니다. 서버 관리자가 발행한 규약 본문만 추출 지침으로 조립하고, 원문·참고 맥락은 종류와 출처가 있는 데이터 블록으로 전달합니다. 입력 자료가 tenant·권한·규약·저장 기준을 바꾸지 못합니다.

#### MCP 제공과 개인 CLI의 단계별 실행

아래 이름과 필드는 **후속 도구/작업 래퍼 설계**입니다. 현재 MCP 목록/인자나 실행 명령에 추가된 기능이 아닙니다.

| 표면 | 책임과 반환 |
| --- | --- |
| 새 `extraction_rules_read` | 허용 tenant의 기본 또는 명시한 사용 가능 규약 릴리스를 읽음. 정확한 지침·스키마·예시·구성별 hash와 호환/사용 상태 반환; 조회 중 최신 내용으로 바꿔 끼우지 않음 |
| 새 `analysis_job_input_prepare` | 본인 claim/run·stage·`expected_job_revision`에서 규약과 명시 입력/맥락을 캡처하고 불변 묶음을 발급. `read_source`는 원본/파일 참조, `prepare_wiki`는 성공한 불변 extraction, `extract_ontology`는 실제 저장 본문/revision을 입력으로 고정. **작업 metadata 변경**이며 read-only 도구가 아님. 고정 bundle과 새 job_revision을 반환 |
| 새 `analysis_job_input_read` | job에 연결된 정확한 bundle/구성을 고정 페이지로 읽음. 각 페이지가 같은 bundle revision과 구성 hash에 속함을 확인. 페이지 수신/클라이언트 확인은 실제 AI의 이해·준수 증명이 아님 |
| D-043의 단계 저장 래퍼 | `analysis_job_wiki_write`·`analysis_job_ontology_generate`에 해당 `bundle_id/bundle_revision`을 연결. 서버가 보관한 job/run/stage·규약·의존 버전·payload hash와 실제 저장 영수증을 대조 |

규약/묶음 읽기는 현재 tenant의 read와 작업 조회 범위를 검사합니다. 준비와 제출/저장은 매번 현재 인증 주체·본인 claim/run·lease·취소·등록/job 기준과 단계 권한을 확인합니다. `read_source` 입력 준비와 추출물 서버 제출에는 D-043의 새 `source_write`, `prepare_wiki` 입력 준비/본문 저장에는 `write`, `extract_ontology` 입력 준비/그래프 저장에는 `ontology_write`가 필요합니다. 로컬 읽기 능력이 이 권한을 대신하지 않습니다. 입력 묶음 발급은 저장 승인이나 권한 양도가 아니며 토큰·원격 PC 절대 경로를 지침/manifest에 넣지 않습니다. source_write로 본문/그래프를 저장하지 못하며 기존 직접 저장의 권한은 변경하지 않습니다.

1. **요청/접수:** D-043 작업 생성에서 사용할 규약 릴리스를 고정하고 맥락 문서 목록·필수 구성·힌트를 기록합니다. CLI는 access_context와 claim 후 정확한 서버 규약을 조회합니다. 로컬 파일·옛 대화의 규약을 기본값으로 대신하지 않습니다. 같은 릴리스가 없는 클라이언트도 서버에서 받아야 하며 미지원 스키마/입력 방식이면 분석 전에 차단합니다.
2. **파일 읽기 입력:** 원본 판본/hash·파일 참조·선택 범위와 단계 지침을 `stage=read_source`의 불변 묶음으로 발급합니다. 아직 생성하지 않은 extraction을 필수 입력으로 요구하지 않습니다. 호스트 bridge가 같은 서버의 파일 API에서 받은 실제 바이트를 확인하고 CLI에 작업용 파일을 제공합니다.
3. **CLI 파일 읽기·제출:** CLI가 지원하는 로컬 도구/OCR/이미지 입력과 AI로 원본을 읽고, 해당 read_source bundle에 연결해 D-043의 `source_extraction_submit`으로 문자/표/산출물 참조·manifest를 제출합니다. 서버는 이를 불변 extraction으로 보관하고 영수증/새 job_revision을 반환합니다. 읽지 못한 영역과 도구 출력/AI 전사·재구성을 구분하며 제출 성공을 원문 충실성 승인으로 해석하지 않습니다.
4. **위키 본문 준비·저장:** 성공한 extraction의 정확한 ID/hash·원본·선택 범위·맥락을 고정해 `stage=prepare_wiki`의 **새** 묶음을 발급합니다. CLI의 AI가 이 입력에서 충실한 본문과 원본 대응을 구성해 해당 묶음의 위키 저장 래퍼로 저장합니다. 앞 묶음에 새 추출물을 끼워 넣지 않으며 원본/추출물 hash를 위키 revision으로 사용하지 않습니다.
5. **온톨로지 준비:** 성공한 위키 영수증과 실제 wiki_read 본문/revision, 기존 그래프/검토 상태를 캡처해 `stage=extract_ontology`의 새 묶음을 발급합니다. 앞 단계 bundle/영수증을 선행 참조로 연결합니다. 신규 문서는 검토 이력 없음 상태를 보존합니다. 그래프 추출은 이 실제 전체 본문을 대상으로 합니다.
6. **개인 AI 실행:** CLI 어댑터는 각 AI 단계에 공통 규약·스키마·고정 원문/읽기 자료·구분된 맥락만 넣은 새 추출 세션을 준비하고 정확한 조립 입력 hash와 확인 가능한 실행 정보를 남깁니다. 사용자 요청은 문서/범위/원하는 산출물을 지정하며 공통 의미 기준을 조용히 덮어쓰지 않습니다. 기존 대화의 불필요한 지시·다른 tenant 내용은 전달하지 않습니다. 세션 분리·구조화 입력·필요한 파일/이미지 입력을 지원하지 않는 임의 터미널은 요청 준비/어댑터 확인 필요로 두며 그 경로를 공통 실행 검증 완료로 표시하지 않습니다.
7. **제출/확인:** 클라이언트가 원시 결과와 bundle 참조를 제출하면 서버는 현재 허용 규약·입력 연결·의존 버전·권한·source/state CAS 및 기존 구조/인용/한도를 검사합니다. 성공 영수증에 규약·단계 입력·원시 제출 hash·실제 document/source/graph/state revision을 연결합니다. 형식/인용 저장 성공은 ‘저장 완료·미검토’이며 사람 승인으로 올리지 않습니다. 그래프 실패 때문에 성공한 본문을 다시 쓰지 않습니다. Electron은 D-043의 일반 API로 이 영수증과 현재 결과를 조회합니다.

서버가 고정한 입력과 실제 모델에 들어간 입력은 구분합니다. CLI가 보고한 모델/설정/조립 hash는 자기보고로 표기하고, 서버 발급·전달 기록과 섞지 않습니다. 서버는 개인 AI의 숨은 시스템 지침·설정·과거 대화 제거·실제 지침 준수를 독립적으로 증명할 수 없습니다. 동일 규약은 결과 비교의 기준이며 계정/모델 간 동일 출력 보장이 아닙니다.

#### 기준 변경·경쟁·이력과 기존 기능의 경계

- 새 규약을 기본값으로 발행해도 진행 중 job의 고정 릴리스나 기존 그래프를 바꾸지 않습니다. 기존 허용 릴리스로 시작한 작업은 그 입력으로 마칠 수 있고, 새 작업은 새 기본값을 받습니다. 명시적으로 사용 철회한 릴리스는 이후 준비/저장을 차단하고 초안을 보존합니다. 관리자에 의한 옛 릴리스 재허용도 새 설정 변경으로 기록하며 자동 fallback하지 않습니다. 규약/묶음/제출 이력은 보존하고 이전 릴리스의 hash만 최신값으로 바꾸지 않습니다.
- 대상 원문·등록 판본·선택한 정의/예외·검토/정책·힌트 또는 사용한 profile 정의/정확한 적용 범위가 바뀌면 다음 저장에서 ‘입력 기준 변경’을 반환합니다. 해당 묶음의 모든 고정 의존 버전을 비교하고 초안을 보존한 뒤 새 입력으로 재대조/필요한 단계 재추출을 합니다. 필수 맥락을 빼거나 버전값만 바꾸어 기존 결과를 재전송하지 않습니다. 자기 위키 저장의 성공 영수증으로 다음 단계 묶음을 만드는 것은 외부 변경 수용과 구분합니다.
- 준비 캡처와 최종 저장의 일관성은 D-043의 **등록/작업 조정 잠금 → 기존 저장 잠금** 순서를 유지합니다. 최종 의존 대조와 저장은 기존 저장 모듈의 잠금 아래 같은 임계구역에서 수행하도록 공용 내부 실행 경계를 재사용/확장하며, 래퍼의 사전 검사와 실제 저장 사이에 다른 문서/검토 쓰기가 끼어들 수 있는 상태로 구현하지 않습니다. 잠금을 잡고 public save/generate를 다시 호출하는 중첩 잠금은 금지합니다. 규약 사용 철회도 단계 실행 승인과 직렬화하고, 이미 시작/성공한 저장은 결과를 보존하며 후속 단계만 막습니다. 이 경계의 실제 경합 검증 전에는 원자성을 검증했다고 하지 않습니다.
- 규약 구버전·참고 맥락 변경·입력 불완전·규약 출처 미기록은 원문/그래프 `stale`과 별도로 결과/작업 조회에 표시합니다. 이 설계에서 기존 stale 의미·`needs_reextraction` 판정을 바꾸지 않습니다. 과거 입력 출처가 없는 운영 그래프에 새 규약 버전을 소급 부착하거나 당시 준수로 인증하지 않습니다.
- 기존 wiki_write/ontology_generate 및 검토/정책 API 계약은 유지합니다. 기존 도구의 직접 저장에는 작업 규약 사용을 인증하지 않으며 ‘공통 입력 확인 없음’으로 구분합니다. 공동 추출의 규약 사용 표시는 새 작업 래퍼에서 영수증이 확인된 결과에만 부여합니다. 직접 저장 전체를 차단하는 권한/마이그레이션 정책은 별도 운영 결정이며 현재 권한을 자동 변경하지 않습니다.
- D-043의 intent/멱등 영수증·부분 실패·`pending_reconcile`·`storage_busy`·성공 정리 경고 처리를 재사용합니다. 입력 기록 공개 실패는 자료 저장 전에 멈추고, 실제 자료 저장 뒤 영수증만 실패하면 저장을 반복하지 않습니다. 규약/맥락 변경만으로 자동 재추출·옛 승인 이식·정책 전파를 하지 않습니다.

운영 공통 입력과 원문 분리 평가는 구분합니다. D-021의 생성자는 고정 원문·중립 스키마·고정 추출 지침만 받고 기존 그래프/정책·검증 질문·옛 점수·다른 세션 이력을 자동 첨부하지 않습니다. 공통 규약의 의미 조항을 평가용으로 고정할 수 있으나 평가 입력 제한을 운영 묶음으로 우회하지 않습니다. 비교 기준은 D-036의 의미 충실성·반복 일관성·전문가 조정·판단 지속성이며, ID/배열 순서와 의미 차이를 구분합니다.

구현 순서와 수용 검사는 [PLAN의 D-044 후속 범위](PLAN.md#d-044-공통-추출-규약맥락버전-후속-구현과-검증-계획)에서 관리합니다. 이번에는 설계 문서의 연결·일관성만 검증하며 실제 규약 배포·전송·추출 품질이나 여러 사람의 사용을 검증하지 않습니다.

#### Rule 분류·검증·위반 처리 (2026-10-25)

상태: **사용자가 요청한 상세 설계 반영 / 규약 배포·검증 보고·작업 래퍼 구현 및 실행 미착수**입니다. D-044의 공통 규약을 아래 자동 검사 규칙과 의미 검토 규칙으로 분류하고 위반 처리까지 정합니다. 기존 의미 지침의 판단 기준을 재사용하며 이번에는 코드·역할 프롬프트·그래프 스키마·운영 권한을 변경하지 않습니다. 아래 Rule ID·보고 항목·처리는 후속 규약/작업 계약이며 현재 MCP 인자에 추가된 기능이 아닙니다.

**보장 단위와 이유.** 자동 검사는 서버가 확인할 수 있는 형식·문자열·참조·고정 입력 조건에 한정합니다. 의미 검토는 원문이 주장을 지지하는지, 조건과 핵심 내용이 보존됐는지 판단합니다. 같은 Rule의 자동 부분과 의미 부분을 각각 판정하고 한쪽 통과로 다른 쪽을 통과시키지 않습니다. 보장할 수 있는 표시는 ‘이 입력·제출에 대해 지정한 자동 검사 통과’이며, 전체 Rule 준수·의미 정확도·누락률·모델 간 동일 결과 또는 실제 사람 승인을 인증하는 표시는 아닙니다. 이 표시는 새 작업 래퍼의 검사/저장 영수증이 있는 결과에만 붙입니다. 기존 직접 저장과 과거 그래프에는 ‘공통 입력 확인 없음’을 유지합니다.

**규약에 포함할 Rule 명세.** 각 Rule은 `rule_id`, 검사 분류(automatic/semantic), 적용 단계/스키마, 정확한 요구사항, 자동 검증기 ID/내용 hash 또는 의미 검토 질문, 위반 시 처리, 개발용 정상/실패 예시를 포함합니다. 발행 시 ID 고유성·참조 검증기/스키마 존재·검증 범위 일치를 검사합니다. 의미를 바꾼 개정은 새 불변 릴리스와 변경 이유로 발행하고 옛 명세를 보존합니다. AI에게 줄 지침과 서버 검사기가 같은 명세를 사용하며 비공개 평가 질문/정답은 포함하지 않습니다. 자동 검증기가 준비되지 않은 규칙을 automatic 통과로 발행하지 않습니다. 해당 기능이 필요한 규약 릴리스의 사용을 막거나, 검사 범위를 명시한 새 릴리스를 발행합니다.

##### 자동 검사 규칙

‘기존’은 현재 [온톨로지 검증기](../core/modules/ontology/validation.py), [MCP 입력 방어](../core/mcp/validation.py), [현재 권한 처리](../core/mcp/tenant.py)의 해당 검사 부분을 재사용한다는 뜻입니다. 규칙별 일괄 보고와 새 입력/규약 연결은 모두 후속 구현입니다. 자동 위반은 원칙적으로 현재 그래프 교체 전에 제출 전체를 거부하고 초안·원시 제출을 보존합니다. 통과한 항목만 골라 전체 그래프를 교체하지 않습니다.

| Rule ID | 자동으로 검사할 조건 | 위반 시 처리·구현 범위 |
| --- | --- | --- |
| R-A01 | 규약 ID/버전/revision·구성 hash·허용/철회 상태, 제출 스키마와 실제 검증기 호환 | 발행 또는 실행 차단. 사용 가능한 명시 릴리스로 새 입력 준비; 버전명만 교체하거나 옛 규약으로 자동 우회하지 않음. 신규 |
| R-A02 | 현재 인증 주체·tenant·단계 권한, 본인 job/run/claim·lease·취소, bundle의 단계/소속 일치 | 권한/작업 오류로 중단. 다른 tenant/legacy 서버/직접 저장으로 규약 검사 우회 금지. 인증·권한은 기존, job/bundle 검사는 신규 |
| R-A03 | 실제 대상 원문 revision과 저장 CAS, 검토 이력에 필요한 state CAS, 묶음의 맥락/정책/힌트/profile 의존 버전 | 기준 변경/conflict. 최신 원문·그래프·검토와 초안을 대조하고 필요한 단계부터 새 입력/재추출. token만 교체 금지. source/state는 기존, 복합 입력 검사는 신규 |
| R-A04 | 서버가 고정한 요청/포함 범위·필수 구성의 수신·hash·페이지·complete/truncated/skipped, 클라이언트가 신고한 미독 범위와 입력 한도 | 필수 자료 미확보·신고된 대상 원문 미독은 ‘범위/맥락 확인 필요’로 저장 차단. 선택 자료 누락은 명시하고 전체 확보로 표시하지 않음. 원본을 실제로 모두 읽고 이해했는지는 서버 검사로 증명하지 않음. 신규 |
| R-A05 | 적용 스키마의 필드/유형/enum·배열·문자열/바이트 한도, 미지원 술어/버전·알 수 없는 필드 거부 | 형식/한도 오류를 반환. 자동 절단·임의 문서 분할·스키마 숫자 변경 없이 초안 수정 또는 범위 설계 확인. 기존 검사 재사용 |
| R-A06 | 개체 ID 고유성·규정된 중복 기준, 관계/속성/출처의 문서 내 참조, 개체 label·식별자 namespace/value의 인용 내 존재 | 잘못된 ID/참조/중복/인용을 수정 후 새 제출. 동명 대상의 실제 동일성은 R-S06에서 별도 판단. 기존 검사 재사용 |
| R-A07 | 각 근거 인용이 고정 원문의 실제 연속 문자열인지, 적용 v4 source_anchor의 문서/revision/인용/정확 위치 일치 | 인용/앵커 오류로 거부. 실제 인용을 다시 확보하며 인용을 발명하지 않음. 일반 인용의 줄 위치는 첫 일치이므로 반복 문구 중 의도한 위치의 유일성은 보장하지 않음. 기존 검사 재사용 |
| R-A08 | 관계·후보·속성의 qualifiers에 polarity/modality/condition/scope/time 다섯 키를 명시하고, 허용 enum·null 또는 실제 인용 내 문자열 제약을 만족 | 새 공통 작업 경로의 원시 제출에서 생략을 거부하고 명시값으로 재제출. null 자체를 조건 없음의 증거로 취급하지 않음. 키 명시 요구는 신규, 값 검사는 기존 |
| R-A09 | context/provenance의 허용 필드·관점 enum·참조 유형·literal 인용, 속성 datatype/value 문자열·단위·property 인용 제약 | 형식/인용/참조 오류로 거부. 원문에 없는 값·단위 환산·관점을 자동 보충하지 않음. 값의 대상/의미 결합은 R-S07/08에서 확인. 기존 검사 재사용 |
| R-A10 | 관계 후보의 필수 ID/끝점/reason/question, evidence=null일 때 한정어/맥락 제약, 승인 필드 위조 거부와 근거 관계/후보의 규정된 중복 금지 | 후보 형식을 수정하거나 별도 미해결 기록으로 남김. 후보 구조 통과를 사실/승인으로 승격하지 않음. 기존 검사 재사용 |

R-A08을 두는 이유는 현재 `_qualifiers()`와 MCP 모델이 생략값을 `positive/asserted/null/null/null`로 채우기 때문입니다. 새 공통 래퍼는 **정규화 전에 원시 제출**을 검사해 선택값을 드러냅니다. 규약의 제출 스키마는 기존 그래프 스키마에서 필수 키를 좁혀 정의하고 실제 래퍼 검증기와 함께 발행합니다. 새로운 술어/필드를 그래프에 허용하는 변경은 아닙니다. 기존 직접 `ontology_generate`의 인자·기본값은 유지합니다. 모든 키를 명시했어도 올바른 값 선택·조건 누락 여부는 R-S04/05에서 판단합니다.

##### 의미 검토 규칙

아래 검토는 고정 원문과 제출을 함께 읽고 수행합니다. 키워드·문장 패턴·모델의 점수는 검토 대상을 찾는 신호이며 위반 확정용 자동 검증기가 아닙니다. 표의 처리는 원문 대조로 문제가 확인됐을 때의 수정 방향입니다. AI의 의심·확인된 오류·사람의 권한 있는 판단은 아래 처리 절차에서 구분합니다.

| Rule ID | 의미 검토 질문 | 위반 확인 시 처리 |
| --- | --- | --- |
| R-S01 | 개체의 경계·유형·대명사/약어 지시 대상과 종류/특정 개체 구별이 문맥에 맞는가? | 실제 지시 대상과 유형으로 수정. 경계가 모호하면 확인 질문을 남기고 가상 개체/구별 근거를 만들지 않음 |
| R-S02 | 인용이 관계의 두 끝점·술어·방향·행위 주체를 실제로 지지하는가? | 근거를 다시 읽어 전체 주장을 수정하거나 거절. 실제 인용이 있다는 이유만으로 관계를 유지하지 않음 |
| R-S03 | 분류·구조 부분·재료·위치·입출력·참여·순서·인과·예측을 구별했는가? | `part_of` 남용·순서→인과·예측→발생 확정을 수정. `related_to`로 약화해 사라진 핵심 의미도 별도 누락/표현 한계로 보고 |
| R-S04 | 부정·가능성·능력·계획·가정이 각 주장에 정확히 보존됐는가? | positive/negative와 양태를 원문에 맞게 수정. 계획/가능성을 실행/확인 사실로 승격하지 않음 |
| R-S05 | 조건·예외·적용 범위·시점과 AND/OR 분기가 올바른 주장에 붙었는가? | 해당 분기의 전체 한정어로 수정. 복합 논리를 표현할 수 없으면 잃는 의미와 영향 질문을 명시하고 확인/표현 보완 대기로 남김 |
| R-S06 | 업무 영역·관점과 실체·발급 범위·문서 간 동일성/상이성의 근거를 구별했는가? | 동명/같은 코드에 의한 자동 동일시·병합을 중단. 근거 있는 대응 주장과 문서 간 이름/유형 후보를 구별하고 원래 문서/ID/revision을 유지 |
| R-S07 | 속성의 대상·속성명·값·단위·기준 기간이 올바르게 결합됐는가? | 잘못된 귀속·계산·환산·반올림을 수정. 현행 속성 후보 모델이 없으므로 모호한 속성을 relation_candidates에 넣지 않고 별도 미해결 기록으로 남김 |
| R-S08 | 발화자·자료·미확인 상태, 원문 사실·외부 정의/힌트·전문가 판단의 출처를 구별했는가? | 저자=승인자 추론·외부 맥락의 원문 사실화·미확인의 확정을 수정. 원문 정정과 원문 밖 업무 결정은 각각 wiki_write와 별도 정책 경로로 분리 |
| R-S09 | 근거 관계·추론 후보·미표현 사실의 구분과 후보의 불확실성 분류가 적절한가? | 불확실한 관계는 스키마에 맞고 원문 끝점이 있을 때만 후보로 제안. 모든 명시 주장을 후보로 보내거나 후보 제출만으로 핵심 보존 통과 처리하지 않음 |
| R-S10 | 선택 원문 전체의 핵심 주장·조건·예외·수량·종료·부정과 표/주석 내용이 보존됐는가? | 표현 가능한 누락은 재추출/수정. 표현 불가는 실제 원문 위치·잃은 뜻·영향 질문·사유를 남기고 부분 보존으로 보고. 빈 그래프도 의미 검토 대상이며 원문 비공백만으로 자동 오류 확정하지 않음 |

의미 판정은 `지지됨/모순/근거 없음/조건 손실/모호함`과 `중요 누락/스키마 한계/미실행/판단 불가`를 구분합니다. 근거 관계·속성·후보의 적절성·핵심 질문 보존은 별도로 집계하고 분모/선택 범위를 표시합니다. 일부 지지 주장이나 평균 점수로 의미 반전·핵심 조건 손실·근거 발명을 상쇄하지 않습니다. ‘검토 의견 없음’은 전체 의미 통과가 아니며, 의미 충실성과 반복 일관성·전문가 조정·판단 지속성은 D-036대로 별도 평가합니다.

##### 검사 보고와 위반 시 처리

보고는 D-043의 tenant 내 `_jobs/<job_id>/`에 입력/원시 제출/저장 영수증과 연결해 보존합니다. 그래프 컬렉션이나 v3/v4 provenance, 위키 본문, `_reviews/`에 새 보고 필드를 억지로 넣지 않습니다. 읽기/기록은 같은 job·tenant의 권한을 따르며 권한 오류에 다른 tenant의 원문/존재/검사 세부를 반환하지 않습니다. 초안/보고 보존도 접근·수신/저장 한도를 따릅니다. 수신 거부·보고 기록 실패로 서버 보존을 확인하지 못하면 클라이언트 초안을 유지하고 보존 미확인을 표시하며, 무제한 원시 제출 보관을 약속하지 않습니다. 다음 항목은 **후속 작업 기록의 논리 계약**이며 기존 MCP에 임의 인자로 보내지 않습니다.

- 보고 식별·기준: 서버 발급 보고 ID, job/run/stage·bundle revision·ruleset revision, 적용 스키마/검증기 revision, 원시 제출 hash와 실제 저장 영수증/그래프·state revision의 연결을 유지합니다. 내용이 바뀐 제출은 새 hash/보고이며 옛 보고를 덮어쓰지 않습니다.
- 자동 항목 결과: Rule ID별 `pass/fail/not_run/not_applicable/error`와 검사 범위·이유를 남깁니다. 적용 안 됨에는 이유가 필요하고, 첫 오류 때문에 뒤 검사를 실행하지 못했으면 not_run입니다. fail·필수 검사의 not_run/error가 있으면 저장을 차단합니다. 진단 응답 한도로 보고가 잘렸으면 그 사실을 표시하고 검사 통과/전체 문제 보고로 해석하지 않습니다.
- 의미 항목 결과: Rule ID·판정·검토자 종류(AI 자기점검/별도 AI/실제 사람)·검토한 원문 범위·실제 연속 인용/줄·대상 주장·발견 이유·권고·미해결 이유를 기록합니다. 원문 없는 모델 점수/요약만으로 지지·위반을 확정하지 않습니다. AI 검토자·모델/설정/입력 조립 기록은 자기보고 여부를 표시하고 서버 인증 주체·기록 시각과 구분합니다.
- 대상 참조: 저장 전에는 문서/source revision·제출 hash·컬렉션/배열 위치를 함께 사용합니다. 저장 뒤에는 실제 graph revision을 연결하고, claim이 있는 관계/속성/후보에만 claim_id/state revision을 연결합니다. 개체나 누락 지적에 가짜 claim ID를 만들지 않으며, 새 세대에서 옛 위치/claim ID를 현재 대상으로 사용하지 않습니다. Rule 보고는 검토 제안이며 현재 claim 상태를 직접 바꾸지 않습니다.
- 누락/표현 한계: 대응 주장이 없어도 source revision·실제 원문 위치·관련 질문·생략 사유·영향 범위를 기록합니다. omissions와 보고는 job의 별도 자료이며 그래프 생성 인자에 추가하지 않습니다. ‘한도 때문에 버림’을 의미 보존 통과나 schema_limit의 자동 정당화로 삼지 않습니다.

| 발견/실행 상태 | 저장·다음 행동 | 보존·사용자 표시 |
| --- | --- | --- |
| 자동 검사 위반 | 대상 문서의 그래프 저장 전체 거부. 수정한 새 제출을 다시 검사 | 원시 제출·실패 보고·기존 그래프/원문/판단 보존. ‘자동 검사 위반·수정 필요’ |
| 자동 필수 검사 미실행/검증기 오류·필수 입력 불완전 | 검사를 실행/복구하거나 새 입력을 준비할 때까지 저장 보류. 성공으로 처리하지 않음 | ‘검사 미완료’ 또는 ‘범위/맥락 확인 필요’. 위반 확정과 구분 |
| 자동 검사 통과·의미 검토 미실행/실패 | 기존 설계대로 기계 결과를 미검토 저장할 수 있음. 의미 점검 실패를 기록하며 의미 확인 완료는 표시하지 않음 | ‘저장 완료·미검토 / 자동 검사 통과(범위) / 의미 점검 미실행·실패’ |
| 자동 검사 통과·AI의 의미상 의심/모호함만 존재 | 의심만으로 hard fail·주장 삭제·자동 후보 전환·승인/정책 이벤트를 만들지 않음. 유효한 제출은 미검토 저장하고 해당 검토 제안을 연결할 수 있음 | ‘저장 완료·미검토 / 의미 확인 필요’와 실제 근거·미해결 항목. AI의 지지 판정도 사람 승인으로 승격하지 않음 |
| 저장 전 원문 대조에서 오류를 확인하고 제출자가 수정 대상으로 인정함 | 현재 제출은 초안 보류. 전체 문맥을 보존해 수정·재검사·재제출; 오류 항목만 삭제한 부분 그래프로 자동 교체하지 않음 | 기존 그래프와 오류 초안·발견/수정 이유 보존. 이를 서버 자동 판정이나 사람 승인으로 기록하지 않음 |
| 저장 뒤 기존 관계/속성/후보의 원문 기반 오류/지지를 판단함 | D-028의 ontology_review 권한과 최신 claim_id/state_revision으로 수정/거절/보류/수용. 기존 개체 사이의 관계 끝점 수정도 실제 인용·전체 한정어/맥락/출처·이유를 기록 | 새 원장 이벤트와 현재 검토 상태. AI 제안 보고가 사람 판단 기록을 대신하지 않음 |
| 저장 뒤 개체 유형/경계 수정·새 개체·기존 claim 없는 누락 주장 추가가 필요함 | 기존 검토 API에 없는 대상을 넣지 않음. 전체 최신 원문·그래프·검토 상태에서 수정/재추출한 전체 제출을 source/state CAS와 ontology_write로 재생성 | 기존 원장과 옛 보고를 보존하고 새 세대 미검토·pending_history의 재검토를 표시. 옛 승인 자동 이식 금지 |
| 원문 근거 부족·속성 모호·스키마 표현 한계 | 적합한 관계 후보 또는 별도 미해결/부분 보존 기록으로 남김. 원문에 없는 답을 채우지 않음 | ‘추가 근거 필요/표현 한계’와 영향 범위. 새 사실은 출처 추가 후 재추출, 업무 판단은 D-031의 별도 권한/Action log |
| source/state·규약·맥락 기준 변경 | 새 기준을 읽고 기존 초안과 비교해 필요한 단계 재준비. 버전값만 교체하지 않음 | ‘기준 변경/재검토 필요’. 옛 검사/승인을 새 세대로 자동 이식하지 않음 |

미검토 주장은 `effective_graph`에 남고 보류(defer)/거절(reject)은 제외되므로 조회 결과를 ‘승인된 사실만’이라고 표시하지 않습니다. 이후 AI 응답은 ontology_review_query의 claims/검토 상태·policies·pending_history를 함께 읽어 미검토와 제외된 보류/거절을 구분합니다. AI 제안의 수용 여부와 실제 사람 확인 여부는 따로 기록하며, 인증된 API 호출 자체를 사람이 직접 승인한 증명으로 삼지 않습니다. 새 검토 제안만으로 기존 원장을 재작성하거나 effective_graph를 바꾸지 않습니다.

**실행 순서.** 규약/입력을 고정한 뒤 CLI가 추출·자기점검하고, 서버는 원시 제출 검사와 기존 검증기를 실행합니다. 유효한 제출의 저장은 D-043/D-044의 조정 잠금→저장 잠금 안에서 현재 권한·의존 revision·철회 상태를 다시 대조한 뒤 수행합니다. 사전 검사 보고만으로 이후 저장을 허용하지 않습니다. 성공하면 검사 범위와 실제 저장 영수증을 연결하고 ‘저장 완료·미검토’를 표시합니다. 의미 제안은 위 표대로 연결하며 원문 기반 정정·원문 정정·업무 판단을 각각의 기존 경로로 처리합니다. 별도 LLM 의미 검사 호출/제공자·예산·어댑터는 미구현이며 이번 설계가 서버의 자동 모델 호출을 추가하지 않습니다.

**실패·재시도.** `invalid_argument/invalid_ontology`는 같은 잘못된 제출을 반복하지 않고 수정합니다. `storage_busy`만 같은 기준으로 나중에 재시도할 수 있으며 conflict는 새 내용 대조가 필요합니다. 권한/정책 오류·원장 손상·한도·저장 예외는 기존 실패/보존 경계를 따르고 자동 초기화·다른 경로 우회로 해결하지 않습니다. 성공의 cleanup_failures는 저장 성공과 정리 경고로 나눠 표시하고 재저장하지 않습니다. 저장 후 영수증/검사 보고 연결 실패·응답 유실은 D-043의 pending_reconcile로 확인하며 hash 일치만으로 해당 요청의 성공을 발명하거나 쓰기를 재전송하지 않습니다. 그래프/보고 실패 때문에 성공한 원문 저장을 반복하지 않습니다.

**최소 예시.** 원문이 ‘승인된 경우에만 시스템 A가 장치 B를 사용한다.’이고 실제 전체 인용과 유효한 끝점으로 uses를 제출했다면, 다섯 qualifiers 키를 명시하고 condition=null로 낸 결과는 자동 검사상 유효할 수 있습니다. 의미 검토 R-S05에서는 조건 손실을 찾아 condition에 실제 구절 ‘승인된 경우에만’을 보존하도록 제안합니다. condition 키 자체를 생략했다면 새 공통 래퍼의 R-A08 위반이며, 원문에 없는 인용을 붙였다면 R-A07 위반입니다. ‘경우/만’ 키워드가 보인다는 사실만으로 조건 손실을 확정하지 않습니다.

이번 설계의 수용 조건과 실제 문서 검사 결과는 [PLAN의 D-044 후속 계획](PLAN.md#d-044-공통-추출-규약맥락버전-후속-구현과-검증-계획)에 둡니다. 다음 구현은 Q1 규약 원본/릴리스부터 별도 요청으로 진행하며 이번에 Q1–Q3의 구현·전송·품질 검사를 완료로 바꾸지 않습니다.

## 5. 검색과 문서·개념 연결

### D-013 — 최신 파일의 제한된 문자열 검색 (2026-10-21, 2단계)

상태: 현재 원문 검색 계약입니다. 그래프·전문가 정책 검색과는 별개입니다([D-031]).

- 결정: 별도 인덱스 없이 `wiki/`의 일반 `.md` 파일 경로와 본문에서 `casefold()` 부분 문자열 검색을 수행합니다. 앞뒤 공백을 제거한 비어 있지 않은 검색어를 사용합니다. 실제 본문은 기존 `WikiStore.read()`를 통해 크기·경로·인코딩 규칙을 지키며 읽습니다.
- 결과: 문서 경로, 읽은 내용의 버전값, 최대 200자 본문 일부를 반환합니다. 기본 20개·최대 50개 결과와 최대 200자 검색어를 허용합니다. 히스토리·임시 파일·심볼릭 링크는 검색에서 제외합니다. 각 디렉터리의 파일명 및 하위 디렉터리명을 정렬해 순회합니다.
- 제한과 부분 결과: 최대 1,000개 파일·성공적으로 읽은 본문 16 MiB·읽기 실패 50개에서 멈춥니다. 바이트 예산은 읽은 뒤 계산하므로 마지막 문서로 최대 1 MiB를 추가로 읽을 수 있습니다. 중단 시 `truncated`, 읽기 실패 시 문서 경로와 오류 코드를 `skipped`로 알립니다. 전체 저장소를 같은 시점에 고정하지 않으며 편집 전에 다시 읽어야 합니다.
- 이유: PoC에서 변경 즉시 검색에 반영되고 인덱스와 파일의 불일치가 생기지 않는 단순한 방식을 사용합니다. 문서 전체 반환과 무제한 탐색 비용을 줄이되 검색이 불완전할 때 숨기지 않습니다. 이 원문 검색에는 정규식·벡터 검색·온톨로지 기반 검색을 적용하지 않습니다.

### D-019 — 문서 간 명시 링크와 공통 개념 후보 (2026-10-22, 4단계 보완)

상태: 현재 문서 연결 조회 계약입니다. 명시 링크와 이름·유형 후보를 구분합니다.

- 범위: 기존 `OntologyStore`에 문서 중심 연결 조회를 추가하고 MCP `ontology_connections(document, limit=20)`으로 제공합니다. 명시 링크와 후보를 별도 목록으로 반환합니다. 기존 문서별 JSON 형식을 바꾸거나 문서 간 개체 ID를 합치지 않습니다. 연결 인덱스·별도 그래프 저장소는 없습니다. 이 조회는 `layer=machine`이며 전문가 판단을 반영한 영향 안내는 [D-032], 아직 구현하지 않은 의미 대응·공통 개념 연결 방향은 [D-037]로 구분합니다.
- 명시 링크: 최신 Markdown 원문을 조회할 때 파싱하므로 원문 저장 후 다음 조회에 추가·삭제가 반영됩니다. 나가는 링크뿐 아니라 스캔한 다른 문서에서 들어오는 링크도 반환합니다. `[이름](상대경로.md)`와 참조형 링크를 지원하며 `./`, 위키 내부의 `../`, URL 인코딩된 파일명과 fragment를 처리합니다. 외부 URL·절대 경로·쿼리·위키 경계 밖·이미지·코드·HTML 링크·자기 문서 링크는 제외합니다. `[[문서]]` 확장은 이번 범위에 없습니다.
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

실행 예시는 [README](../README.md#자연어-설명과-그래프를-함께-조회-4-b), 실제 결과와 남은 범위는 [PLAN](PLAN.md)을 따릅니다. 후속 사람 검토 계약은 [D-028]이며 제품 UI는 미구현입니다.

### D-037 — 문서에서 발견한 개념·상태 조건의 연결과 통합 조회 방향 (2026-10-23)

상태: 사용자와 합의한 후속 방향 중 **문서 간 대응 원장·버전 검사·MCP는 D-038, 개념 발견·명시 대상 중심 최신 지식 통합 조회는 D-040으로 구현**했습니다. 공통 개념 등록부는 만들지 않았습니다. 실제 구현/검증은 [대응 구현](PLAN.md#d-038-대응-원장복합-버전mcp-구현과-격리-검증-2026-10-23)과 [통합 조회 구현](PLAN.md#d-040-개념-발견통합-조회-구현과-격리-검증-2026-10-23), 새 원문 의미/전문가 평가는 [예정 평가](PLAN.md#다음-평가-예정--상태-조건과-공통-개념-연결)를 따릅니다.

- 목적과 표현: 문서별 원문·추출·검토 이력을 보존하면서 여러 문서의 개념과 주장을 연결해 지식 구조를 점진적으로 확장합니다. 공통 개념의 설명·조건·예외·관계·출처를 모아 자연어 개념 페이지와 관계 맵으로 제공하는 방향입니다. 두 표현을 서로 다른 정답으로 편집·관리하거나 공통 정의를 모든 원문에 복사하지 않습니다. 상세 조건을 표현할 수 없는 그래프에 억지로 축약하지 않습니다.
- 이름 없는 조건: “갯수가 1~5개인 상품”은 우선 상품에 붙은 수량 조건으로 보존합니다. 문맥으로 확인되지 않은 수량의 의미를 재고로 채우거나, 수식어마다 새로운 공통 개념을 자동 생성하지 않습니다. “매진 임박 상품은 출고를 우선한다”와의 연결은 동일 명칭 검색을 넘어 정의·조건·업무 범위를 비교하는 대상입니다. 두 표현만으로 대응을 확정하지 않습니다.
- 연결과 근거: 같은 워크스페이스에서 허용된 기존 정의·현재 전문가 판단을 찾아 대응을 제안합니다. 원문에 명시된 정의와 전문가가 정한 업무 판단은 서로 다른 출처로 유지합니다. 근거가 없으면 이유와 확인할 질문이 있는 후보로 남기며, “이 조건이면 해당 개념에 속한다”는 단방향 판단을 동치나 반대 방향 추론으로 확대하지 않습니다. 연결을 확인한 것이 연결된 모든 주장의 승인이나 원문 간 모순의 해소를 뜻하지 않습니다.
- 축적과 변경: 확인된 판단에는 대상·이유·적용 범위·시점·출처·버전을 남겨 다음 작업에서 조회할 수 있게 합니다. 신규 문서에서는 조건과 예외의 차이를 확인하며 기존 승인 상태를 그대로 이식하지 않습니다. 정의·원문·전문가 판단이 달라지면 영향 연결과 재검토 상태를 드러내고 과거 판단을 보존하는 방향입니다. 여러 업무 범위의 정의를 전역 최신값 하나로 덮어쓰지 않습니다.
- 현재 구현과 남은 설계: 기존 문서별 `effective_graph`·전문가 정책·상태 버전과 저장 보존 원칙을 재사용했습니다. 이름·유형 후보는 그대로이며 상태 조건의 의미 대응을 자동 생성/승인하지 않습니다. 문서 간 연결 판단의 보존·검토 도구는 [D-038]의 별도 대응 원장을 사용합니다. 통합 조회의 후속 계약은 [D-040]이며 공통 개념 전체 등록부를 선행 조건으로 추가하지 않습니다. 기존 문서 원장의 API를 대응 API로 바꾸지 않습니다.

### D-038 — 문서 간 조건·개념 대응 판단의 최소 계약 (2026-10-23)

상태: **대응 원장·복합 버전 검사·8개 MCP 도구를 구현**했습니다. [D-037]의 문서 간 연결 판단을 같은 tenant의 단일 보존 원장으로 다룹니다. 아래 상세 설계를 기존 저장/원장 모듈을 재사용해 구현했으며 실제 검증 결과와 한계는 [PLAN](PLAN.md#d-038-대응-원장복합-버전mcp-구현과-격리-검증-2026-10-23)을 따릅니다. v3 추출 스키마·기존 문서 원장·사용자 데이터·추출 프롬프트·UI·실제 연결 설정은 변경하지 않았습니다. 새 도구는 개인 인증 tenant 서버에만 등록되므로 구현 당시 legacy 연결에서는 사용할 수 없었습니다. 현재 로컬 읽기 연결 적용 상태는 [D-041]을 따릅니다. 완전한 합성 입력과 의미 예상 판정은 [PLAN의 예정 평가](PLAN.md#다음-평가-예정--상태-조건과-공통-개념-연결)에서 한 번만 관리합니다.

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

근거 코드는 [검토 원장](../core/modules/reviews/store.py)의 `_ledger`·`_captured_state`·`_mutate`·`_policy_mutate`와 [저장 모듈](../core/modules/documents/store.py)의 잠금·staging·신규 파일 공개입니다. 문서별 검토와 대응 저장은 같은 잠금을 사용하지만 한 요청이 두 원장을 함께 수정하는 거래는 만들지 않습니다. 기존 문서 검토 CAS에 대응 원장 전체를 추가하지도 않습니다. 문서 변경으로 대응이 오래되면 다음 대응 조회에서 의존 상태를 다시 계산합니다.

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

상세 설계에서 확정한 보존·prepare/CAS·권한/입출력·실패/undo 계약을 `core/correspondences.py`와 `core/correspondence_schema.py`, tenant MCP 도구로 구현했습니다. 설계 당시 기록은 [상세 설계](PLAN.md#d-038-저장버전mcp-상세-설계-2026-10-23)에 보존하고 실제 기능 완료 조건·검증 결과는 [구현 검증](PLAN.md#d-038-대응-원장복합-버전mcp-구현과-격리-검증-2026-10-23)에만 기록합니다. 공통 개념 등록부·전역 의미 검색·UI·자동 처리와 운영 연결 전환은 이번 구현에 포함하지 않습니다.

구현에서 닫은 세부 계약은 다음과 같습니다. 상세 입력 형태는 도구 설명에도 포함해 원격 클라이언트가 저장소 문서를 읽지 않아도 필수 필드를 확인할 수 있게 했습니다.

- `graph_ref`는 `graph_revision, state_revision, collection, snapshot, layer`와 entity_id/claim_id 하나를 명시합니다. layer는 machine/reviewed이며 현재 source 검토층과 정확한 범위의 expert 값도 구분합니다. review/policy 참조는 `document, event_id, state_revision, snapshot=event.after, scope`, 대응 참조는 `correspondence_id, event_id, correspondence_revision, snapshot=event.after, scope`를 보존합니다. kind를 함께 명시하고 source review의 scope는 null입니다.
- quantity의 수치 경계는 유한 decimal 문자열, 조건/예외는 `{status: unknown/none/specified, items}`, 업무 축은 `{name, status, value, source}`이며 미확인 축의 값은 null입니다. validity는 status/source를 갖고 지정 기간에는 offset 시각·경계 포함 여부·IANA timezone을 함께 보존합니다. related_to는 대응/event ID의 계보 참조이며 실제 근거로 쓰려면 references에도 넣습니다.
- 의존 manifest는 참조의 존재·최신 event·실제 근거 버전이라는 구조적 현재성을 묶습니다. 조회의 application_context/as_of를 바꿔 근거 CAS나 옛 판단 baseline이 바뀌지 않습니다. 현재 범위·기간·정확한 정책 관점의 적용은 별도 계산합니다. 저장 시 선례 사용은 새 값에 명시한 업무 축과 조건/예외·기간으로 제한하며 선례 범위를 확대하는 입력은 거부합니다.
- closure는 root별 실제 참조 도달 집합으로 제한하고 같은 참조의 계산을 재사용합니다. find가 앞서 읽은 다른 root/계보 캐시는 한 대응의 closure 수로 세지 않으며 전체 읽기 바이트 예산은 공유합니다. 원장 reader는 writer와 같은 필수 대체/전후/범위 규칙을 검사하고 재계산된 hash만으로 잘못된 이벤트를 승인하지 않습니다.

### D-040 — 개념 중심 최신 지식 통합 조회 (2026-10-23)

상태: **구현·격리 검증 완료**입니다. D-037의 후속인 개념 중심 조회를 D-038 대응 원장과 D-028/031의 검토·전문가 판단으로 조립하는 계약입니다. 두 read 도구는 개인 인증 tenant 서버에 등록했으며 구현 당시 실제 연결은 legacy 설정 그대로였습니다. 이후 로컬 개인 인증 읽기 연결은 [D-041]에서 적용·확인했습니다. 기존 저장/검토/대응 구현·원장 형식·추출 스키마·사용자 데이터·UI·실제 연결 설정은 보존합니다. 설계 당시 기록은 [상세 설계](PLAN.md#개념-중심-통합-조회-상세-설계-2026-10-23), 실제 완료 조건·검증은 [구현 검증](PLAN.md#d-040-개념-발견통합-조회-구현과-격리-검증-2026-10-23)에서 관리합니다.

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

기존 [검토 캡처](../core/modules/reviews/store.py)의 _query_captured 및 원장 parser, [대응 캡처](../core/modules/correspondences/capture.py)·[검증](../core/modules/correspondences/evidence.py)·[적용 계산](../core/modules/correspondences/applicability.py)을 [통합 캡처](../core/modules/knowledge/capture.py)와 [조회 조립](../core/modules/knowledge/concepts.py)에서 재사용합니다. D-027의 _context_selection도 그대로 재사용해 부분 태그의 미분류 상태를 보존합니다. 원장은 항상 전체 크기/체인/replay를 검증한 뒤 선택 이벤트만 결과에 투영합니다. 공유 raw cache·바이트 예산과 대응 root별 docs/reached/순환 stack·8문서/8의존대응/깊이4 제한을 분리합니다. root마다 독립 32 MiB를 허용하거나 여러 root를 하나의 D-038 closure로 세지 않습니다.

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

## 6. 전문가 검토와 변경 추적

### D-028 — 원문·추출과 분리한 검토 원장과 상태 충돌 검사 (2026-10-22, 4-C)

상태: 현재 원문 근거 검토와 원장·상태 버전의 기본 계약입니다. 인용 없는 전문가 정책은 [D-031]의 확장입니다.

- 권한과 주체: tenant 모드에 `ontology_review_query`(read), `ontology_review`·`ontology_review_undo`(read와 별도 ontology_review)를 추가합니다. 원문 쓰기·추출 생성 권한이 검토 권한을 포함하지 않습니다. 사용자·tenant·선택 profile/정의·정책 revision은 매 요청의 인증 범위에서 서버가 채우며 클라이언트 actor는 받지 않습니다. 프로필은 이력의 적용 관점을 기록하지만 별도 ACL이 아닙니다. 같은 tenant 읽기 사용자는 다른 관점의 검토 이력도 읽을 수 있습니다. 공유 토큰/legacy에는 개인 검토 도구를 제공하지 않습니다. MCP 자격 증명 사용을 실제 사람의 클릭/확인 증명으로 간주하지 않습니다.
- 계층: AI 원시 추출은 `_ontology/`, 검토는 `_reviews/<document SHA-256>.json`의 별도 원장입니다. 원장은 파생 캐시가 아니며 보존 대상입니다. 기존 query/context/connections의 `layer=machine`은 검토를 반영하지 않는다고 명시하고, `ontology_review_query`가 기계 그래프·검토 반영 그래프·주장별 판단·전체 이력과 관점별 참조를 함께 제공합니다. 미검토 근거 주장은 검토 반영 그래프에도 남으므로 전체 승인 그래프라는 뜻이 아닙니다. 거절/보류는 해당 계층의 사실 배열에서 제외하고 원시 값과 판단은 보존합니다. 후보 수용/수정은 유효한 원문 인용을 요구하며 원시 후보를 자동 승인 상태로 바꾸지 않습니다.
- 수정 의미: 원문 오류는 wiki_write와 전체 히스토리 후 재추출, 추출의 방향/유형/조건/속성 오류는 근거 있는 전체 claim 수정, AI가 새 사실을 추출하려면 출처를 추가한 뒤 재추출합니다. 원문 인용 없는 전문가의 업무 판단은 [D-031]의 별도 정책 API로 처리합니다. 수정은 기존 원문 개체만 참조하며 한정어·context·provenance 전체를 명시해야 합니다. 새 사실·개체를 옛 인용에 덧붙이는 API를 제공하지 않습니다. 인용·형식 검증은 의미 진위 판정이 아니며 사용자 수용도 출처가 있는 판단입니다. 시험 데이터의 검토는 simulation이며 실제 업무 담당자의 승인으로 보고하지 않습니다.
- 참조: `claim_id`는 collection과 주장·한정어·관점·출처·인용 및 참조 개체의 의미 정보를 정규화한 hash입니다. 배열 위치나 임시 추출 ID는 제외하고 provenance 참조 개체도 의미 정보로 치환합니다. 같은 hash가 유일하지 않으면 수정하지 않습니다. 이력에는 원래 주장과 참조 개체 snapshot도 보존합니다. ID가 안정적이어도 재추출 결과에 예전 판단을 자동 이식하지 않습니다.
- 충돌: 하나의 `state_revision`으로 문서 경로·원문 SHA·그래프 저장 SHA·검토 원장 SHA·원문 히스토리 이름 목록 SHA를 묶습니다. 읽기·검토·되돌림·생성의 비교와 저장은 기존 WikiStore의 동일 잠금에서 수행합니다. 검토/되돌림에는 반드시 상태 token이 필요합니다. 검토 이력이 있는 그래프 재생성도 이 token을 요구하며 누락/오래됨은 conflict입니다. 아직 검토 이력이 없고 token도 제출하지 않은 생성은 기존 원문 CAS 계약을 유지하므로 두 순수 재추출의 후속 교체까지 막는다고 주장하지 않습니다. 그 경우도 token을 제출하면 상태 CAS를 적용합니다.
- ABA와 재검토: 실제로 달라진 그래프를 publish할 때 `generation_id`를 넣어 A→B→A에서도 graph hash가 달라집니다. 옛 그래프 형식은 읽기 호환하며 사실/관계 스키마 의미는 바꾸지 않습니다. 동일 그래프의 no-op 생성은 token·검토 유효성을 유지합니다. 원문 A→B→A는 전체 히스토리 목록 변경으로 구분합니다. 원문 교체 실패 전에 히스토리만 남아도 안전을 위해 상태가 달라질 수 있습니다. 현재 원문·히스토리·그래프가 결정 당시와 다르면 옛 이벤트를 적용하지 않고 `pending_history`와 미검토 상태로 드러냅니다. 재추출은 원장을 쓰거나 지우지 않으므로 두 파일을 동시에 저장하다 일부만 성공하는 문제가 없습니다.
- 원장과 실패: 문서별 단일 JSON에 hash로 연결된 이벤트를 순서대로 보존하고 새 이벤트를 포함한 전체 파일을 staging·fsync 후 원자 교체합니다. 전후 값·판단·이유·인증 주체/범위·UTC 시각·기준 버전·되돌림 대상을 기록합니다. 저장 실패 전후의 원장·기계 그래프·원문은 보존하고, 성공의 임시 정리 경고는 별도로 보고합니다. 되돌림도 새 이벤트이며 현재 원문/그래프에서 그 주장의 가장 최근 이벤트만 되돌릴 수 있습니다. 옛 이벤트를 삭제하거나 후속 결정을 덮어쓰지 않습니다. 원장 손상은 자동 초기화하지 않습니다. hash 연결은 일관성 검사이며 파일 관리자의 변조를 막는 서명/외부 감사 시스템은 아닙니다. 전원 장애·디스크 고장·관리자의 직접 파일 교체까지 복구 보장으로 확대하지 않습니다.
- 한도와 범위: 원장 8 MiB·이벤트 1,000개·문서의 원문 히스토리 목록 10,000개를 PoC 상한으로 두며 초과 시 기존 기록을 자르지 않습니다. 분산 저장/감사 DB/이력 보관 주기/대규모 pagination은 후속 운영 설계입니다. 새 의존성·추출 프롬프트 변경·LLM 호출·UI는 추가하지 않습니다. SDK 2.3.0의 기존 등록·구조화 결과를 재사용하며, 읽기와 변경 도구를 [MCP 도구 명세](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)에 맞춰 구분합니다.

사용 방법은 [README](../README.md#관계속성-검토와-되돌림-4-c), 실행한 검증과 남은 제한은 [PLAN](PLAN.md)을 따릅니다.

### D-030 — 전문가의 업무 판단과 Action log·계정/연결 방향 (2026-10-22)

상태: **후속 방향의 합의와 구현 연결**입니다. 전문가 정책·최신 판단 조회는 [D-031], 변경 영향 안내는 [D-032]에서 구현했습니다. 계정 발급/회사 SSO와 UI 변경 감지는 설계 방향이며 미구현입니다. 순서·완료 조건은 [PLAN](PLAN.md#ui-착수-전-선행-보완과-5단계-적용-순서)에서 관리합니다.

- 전문가 판단의 이유: AI 추출에는 실제 원문 근거를 요구하지만, 권한 있는 전문가는 프로젝트의 정책·상황에 따라 원문에 없는 업무 판단도 기록할 수 있어야 합니다. 옛 인용을 꾸미는 대신 판단의 주체·이유·적용 범위·시점·변경 이력을 출처로 남깁니다. 현재 입력·권한·적용·되돌림 범위는 [D-031]이 정합니다. 독립적인 새 정의·문서 간 대응 관리까지 구현한 것은 아니며 그 확장은 [D-037]을 따릅니다.
- Action log의 이유: [팔란티어의 사용자 수정](https://www.palantir.com/docs/foundry/object-edits/overview)과 [Action log](https://www.palantir.com/docs/foundry/action-types/action-log)를 참고해 누가 왜 무엇을 바꿨는지 추적합니다. 별도 중복 로그 대신 [D-028]의 원장을 [D-031]에서 확장했습니다. 책임 추적 자료이며 내용의 무오류·실제 사람의 클릭·관리자 변조 방지의 증명은 아닙니다.
- 활용과 영향의 구현 위치: 새 AI 작업의 최신 유효 판단 조회·출처 표시는 [D-031], 자동 재추출 없이 명시 연결과 추정 후보를 구분한 영향 안내는 [D-032]를 따릅니다. 이력 보존과 현재 판단 적용을 구분하며, 전체 승인 그래프나 위키 전체 의미 영향 계산으로 확대하지 않습니다.
- 계정과 배포: Wiki 내부 사용자·tenant 소속·행동 권한·관점은 AI 도구 계정과 분리합니다. 설치형 환경의 자체 계정 발급 또는 회사 환경의 기존 SSO를 선택할 수 있는 방향입니다. 두 로그인 방식을 모두 첫 PoC에 구현한다는 뜻은 아니며 실제 배포 조건에 맞는 하나를 먼저 선택합니다. 회사 이메일 문자열이나 도메인만으로 소속을 확정하지 않고 검증된 로그인 신원을 관리자가 허용한 내부 사용자·소속에 연결합니다. 개인 인증 검토 경로를 공유 토큰 모드로 대체하지 않습니다. 제공자·발급/복구 방식·정확한 로그인 프로토콜·설치 패키지는 아직 미결정입니다.
- 화면 갱신: Electron 클라이언트에서 변경을 감지하고 필요한 내용을 다시 조회하는 방향입니다. MCP와 UI의 저장·관계 수정이 모두 알림 대상이어야 하며 권한 있는 대상에게만 변경 정보를 제공합니다. 편집 중 초안을 보존하고 저장 충돌을 처리하며, 재접속 뒤 버전을 확인해 최신 상태를 복구합니다. 반복 AI 호출은 필요하지 않습니다. SSE·WebSocket·주기적 버전 확인 중 구체 전송 방식과 다중 프로세스 변경 전달 방식은 구현 시 결정합니다.

### D-031 — 전문가 정책을 기존 검토 원장에 보존하고 최신 판단으로 조회 (2026-10-22, 선행 1)

상태: 현재 인용 없는 전문가 정책과 최신 판단 조회의 계약입니다. 기존 문서의 관계·속성에 적용하는 범위입니다.

- 권한 분리: AI 추출과 원문 해석 정정은 기존 인용 검증을 유지합니다. 업무 전문가의 원문 밖 판단에는 별도 `ontology_policy` 권한을 두고 `ontology_policy`·`ontology_policy_undo`를 개인 인증 tenant 모드에만 제공합니다. 기존 `ontology_review`·`ontology_write`·`write`로 대체하지 않으며 모든 변경 권한은 `read`도 요구합니다. 접근 권한 정책과 업무 정책은 서로 다른 대상입니다.
- 입력과 최소 범위: 현재 v3의 기존 관계·속성 `claim_id`를 대상으로 전체 수정값·한정어·관점·이유를 받습니다. source evidence나 클라이언트의 provenance는 받지 않습니다. 새 관계 끝점은 최소 개체 입력으로 받아 서버가 ID를 부여하고 정책 계층에만 둡니다. AI 원문 그래프의 검증기를 약화하거나 원문에 가짜 인용을 삽입하지 않습니다. 기존 주장과 무관한 새 정책 생성, 후보의 정책 승격, 자동 분류 추론은 이번 범위 밖입니다.
- 적용 범위: 인증 정책에서 얻은 tenant 저장소와 정확한 `domain/viewpoint` 조합에 적용합니다. 프로필 ID는 감사 정보이고 같은 조합을 가리키면 같은 판단을 봅니다. `null`은 그 조합 자체이며 전체 범위 와일드카드가 아닙니다. 원문 근거 검토 위에 전문가 정책을 적용하고 일반 검토는 이 정책을 덮어쓰지 않습니다. 다른 관점의 정책과 과거 이력은 같은 tenant의 읽기 사용자에게 보이되 적용 상태를 구분합니다. 관점은 비밀 정보 경계가 아닙니다.
- 원장과 Action log: 문서별 기존 `_reviews/` 원장을 재사용합니다. v1은 그대로 읽으며 전문가 이벤트가 생기면 v2에 기존 이벤트 값·해시를 보존합니다. 정책/되돌림 이벤트에는 대상 주장, 전후 정책 상태와 실제 적용값, 서버가 정한 사용자·tenant·프로필·접근정책 revision·시각, 이유, 원문/그래프/원문 히스토리 버전, 기준 `state_revision`, 되돌림 대상과 해시 체인을 남깁니다. 저장된 정책의 출처는 이 이벤트이며 `effective_graph`의 `provenance.kind=expert_policy`와 `event_id`로 구분합니다. 해시 체인은 우발 손상 탐지용이며 파일 관리자에게서 변조를 막거나 누락을 외부 증명하는 서명 원장은 아닙니다.
- 경쟁과 실패: 기존 문서 잠금·상태 CAS·전체 원장 원자적 교체를 재사용합니다. 저장 전에 정책 아래의 원문 검토층과 현재 모든 정책 적용 범위를 검증하여 한 관점의 변경이 다른 관점의 조회를 깨뜨리지 않게 합니다. 저장/동기화/교체 실패 시 이전 원장과 원문·그래프·히스토리를 보존하고, 저장 성공 뒤 정리 실패는 별도 경고로 처리합니다. 되돌림은 같은 주장·범위의 최신 이벤트를 대상으로 새 이벤트를 추가합니다. 일반 검토 되돌림으로 정책을 취소할 수 없습니다. 원장 크기·이벤트 한도는 유지하며 오래된 이력을 자동 삭제하지 않습니다.
- 재추출과 최신 판단: 원문·그래프·원문 히스토리 상태가 바뀌면 옛 판단을 원장에 보존하고 `pending`으로 돌립니다. 동일 내용의 변경 없는 재생성은 판단을 유지합니다. 과거 이벤트를 새 추출에 자동 매칭하거나 승인 이력을 자동 이식하지 않습니다. 재검토 대기는 최신 기계 추출이 옛 전문가 판단을 반박했다는 뜻이 아닙니다.
- AI 조회 계약: 새 작업은 허용 tenant/관점 확인 → 원문에서 관련 문서 검색 → `ontology_review_query`로 최신 `effective_graph`, `policies`, `pending_history`를 확인합니다. 원문 또는 `layer=machine` 조회만으로 현재 업무 판단에 답하지 않도록 MCP 초기 안내·도구 설명·에이전트 규칙을 맞춥니다. 전문가 판단은 이벤트와 상태 버전을 출처로 인용하며 가짜 원문 인용을 붙이지 않습니다. 정책의 `active/other_scope/pending/inactive`를 구분하고 분류 교체에서 옛 분류의 부정을 자동 도출하지 않습니다. `wiki_search`는 원문 검색이므로 정책에만 새로 등장한 단어를 역검색하지 못합니다. 정책에만 등장하는 용어의 검색·관련 문서 자동 수정이나 정책 전파는 제공하지 않습니다. 후속 [D-032]는 읽기 전용 영향 안내만 추가합니다.
- 검증 범위: 격리 fixture의 모의 전문가로 저장·권한·실패 경로를 검사하고, 정답·문서 경로·claim ID를 주지 않은 새 Astra 세션이 실제 MCP를 통해 최신 수정과 되돌림을 사용하는지 확인합니다. 이 검증은 조회·활용 통합 검사이며 새로운 원문 추출 정확도 평가나 실제 업무 전문가의 승인이 아닙니다. 모든 AI 클라이언트의 필수 조회를 기술적으로 강제하는 장치는 없으며, 실제 수행 결과·실패·한계는 PLAN에 별도로 기록합니다. 공식 [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)과 [Codex MCP 연결 안내](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)를 참고하며 프로토콜·SDK·실행 중 서버 설정은 바꾸지 않습니다.

사용법은 [README](../README.md#원문-인용-없는-전문가-판단-선행-1), 단계 완료 여부는 [PLAN](PLAN.md)을 따릅니다. 선행 2의 후속 계약은 D-032이며 UI는 미착수입니다.

이 절의 원문 검색 한계는 유지합니다. 정책에만 등장하는 표현의 발견은 이후 [D-040]의 전용 도구로 구현했으며 `wiki_search`의 검색 범위를 바꾼 것은 아닙니다. 관련 문서의 자동 수정·정책 전파도 제공하지 않습니다.

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

## 7. 협업과 품질 평가

### D-020 — 역할별 협업과 근거·의미를 구분한 추출 평가 (2026-10-22, 4단계 보완)

상태: 역할별 협업과 초기 v1 회귀 평가의 기록입니다. 원문 분리 평가는 [D-021], 현재 품질 기준은 [D-036]을 따릅니다.

- 범위: UI 이전의 4단계 보완입니다. 기존 저장·MCP·온톨로지 스키마를 재사용하고 자료 조사, 온톨로지 추출, 독립 검증, 프롬프트 개선, 저장, MCP의 여섯 역할을 `.agent/`에 둡니다. 표준 `.codex/agents/` 탐색 경로는 이 폴더의 상대 심볼릭 링크로 연결하며, `.agents/skills/poc-step/`는 기존 절차로 유지합니다. 등록 형식은 `name`, `description`, `developer_instructions`의 TOML입니다. [Codex 공식 서브에이전트 문서](https://learn.chatgpt.com/docs/agent-configuration/subagents)를 확인했습니다.
- 협업: 부모가 단계·파일 담당을 정하고 전문 역할끼리 필요한 질문·검토를 요청할 수 있습니다. 기존 담당자의 메시지/후속 작업을 우선 재사용하고, 없을 때만 한정된 하위 작업을 만듭니다. 역할을 선택하지 못하는 도구 환경에서는 해당 TOML 지침을 읽어 전달합니다. 호출 고리와 같은 파일의 동시 수정을 피합니다. 동시 하위 작업은 최대 3개이며 모델·권한·MCP는 부모를 상속합니다. 별도 모델 선택이나 권한 격리, 무한 자동 실행 서비스는 추가하지 않습니다.
- 평가 자료: 9분야의 공식 1차 출처 10개를 실제 검색·본문 확인한 짧은 한국어 재서술과 합성 사례 8개를 사용합니다. [사례 파일](../evals/ontology_cases.json)에 URL·제목·확인일·재서술 표시·기대값을 함께 두고 별도 중복 문서를 만들지 않습니다. 개발 9개와 별도 검증 9개를 구분하고 모델에는 본문만 전달합니다. 원문 전체를 복제하거나 운영 위키에 평가 자료를 섞지 않습니다.
- 초기 v1의 표현 정책: 당시에는 구체적 술어가 없으면 일반 `related_to`로 약화하지 않고 `omissions`에 남겼습니다. 그래서 당시 FP에는 사실적 거짓뿐 아니라 표현 정책 불일치도 포함됐습니다. v2부터는 [D-022]의 제한적 일반 연관을 허용하되 구체 의미의 손실을 보고합니다. 현재 표현의 충실성은 [D-036]을 따르며 초기 회귀 기대값을 현행 전체 의미 기준으로 확대하지 않습니다.
- 개체·근거: 관계가 부정·조건부여서 저장되지 않아도 원문이 뒷받침하는 개체를 버리지 않습니다. 문서 안에서 명시적으로 풀어 쓴 별칭·약어는 해석할 수 있지만 문서 사이의 동일성 확정·자동 병합은 하지 않습니다. 원문에서 더 긴 명칭도 같은 대상을 가리키면 평가의 명시적 alias로 인정합니다. 지시어 해석에 앞 문장이 필요하면 해당 연속 구절을 근거에 포함합니다. 당시 v1의 물리 대상·분류 등 표현 한계는 [D-022]·[D-024]에서 일부 보완했습니다. 여전히 표현하지 못하는 의미를 임의 유형·술어로 숨기지 않습니다. `omissions`는 검토 보고에만 있고 MCP 인자는 그대로입니다.
- 평가 방법: `core/verify_ontology.py`가 기존 CLI 도우미와 `WikiStore`·`OntologyStore`를 재사용합니다. 임시 작업 폴더와 실제 프로세스 cwd를 일치시키고 도구·MCP·위임을 비활성화한 실제 Codex 추출을 실행합니다. 이전 MCP 지침을 고정한 baseline과 현재 추출 역할을 동일 본문으로 비교하며 모델을 별도 지정하지 않습니다. 형식·인용·revision 검사는 임시 저장소의 생성·조회로, 의미 평가는 고정한 기대 개체·관계와 독립 근거 검토로 나눕니다. 운영 원본·히스토리는 건드리지 않습니다.
- 판정: 실행 성공, 구조 검증, 중요 개체·관계 회수율, 허용 표현과의 부합률, 금지 관계, 중복을 별도로 기록합니다. 이 초기 회귀 집합에 한해 회수율 각각 95% 이상·비허용/금지 관계 0·중복 0을 수용 기준으로 두었습니다. 인용문이 원문에 있다는 자동 검사는 그 인용이 관계를 의미적으로 지지하는지 증명하지 않으므로 원시 출력도 검토합니다. 작은 한국어 재서술·합성 사례 한 번의 비교는 전체 문서·언어·분야의 성능 보장이 아닙니다.
- 개선 절차: 개발 사례의 재현 오류만 프롬프트 담당에게 전달합니다. 정답을 외우는 문구 대신 판단 기준을 최소 수정하고 최대 두 번까지만 재평가합니다. 별도 검증 결과로 수정하면 그 자료를 미사용 검증으로 부르지 않습니다. 프롬프트·입력 hash와 실제 출력·실패를 보존하고, 아직 남은 문제를 통과로 숨기지 않습니다. 최종 실행 결과는 [PLAN](PLAN.md)에 기록합니다.

### D-021 — 원본 보유 세션과 관계 생성 세션의 분리 검증 (2026-10-22, 4단계 보완)

상태: 현재 원문 분리 평가의 기본 절차입니다. 개별 실행 조건·예외는 [D-029]와 [PLAN](PLAN.md)에 기록합니다.

- 이유: 기존 재서술·합성 사례는 작성자가 정한 정답·표현 정책을 검사합니다. 별도 검토 역할도 부모 대화 이력을 상속했으므로 이를 원본 이해의 독립 검증으로 부른 것은 부정확했습니다. 기존 결과는 회귀 기록으로 보존하며 실제 원문 검증과 구분합니다.
- 순서: 원본 보유 검증자는 새로운 대화에서 공식 원문을 직접 확보하고 출처·조회시점·연속 구간·본문 hash와 중요한 사실·조건의 확인 질문을 제출 결과를 보기 전에 고정합니다. 질문은 생성자에게 공개하지 않습니다. 수집·관계 생성자도 이전 이력 없이 시작하여 원문과 고정된 추출 지침·스키마만 받고 결과를 제출합니다. 결과 hash를 고정한 후에만 원본 보유 세션이 판정합니다.
- 전달 경계: 평가 세션은 허용 입력만 읽습니다. 부모는 필요한 작업 규칙을 직접 전달하고 정답·점수가 있는 PLAN·기존 평가 결과를 시작 지침으로 읽히지 않습니다. 검증자에게는 생성자의 추출 프롬프트·기대 정답·이전 점수·해설을 주지 않으며 공개 스키마와 제출 그래프만 전달합니다. 두 결과가 고정될 때까지 서로 호출하거나 답을 맞추지 않습니다. 일반 개발 협업은 기존 규칙을 유지합니다.
- 판정: 원문이 지지하는 관계, 모순, 근거 부족, 조건 손실, 모호함과 중요 누락을 구분합니다. 스키마의 표현 한계와 추출 실수도 구분하며 정답표 일치율로 대체하지 않습니다. 부모는 의미 판정을 원하는 결과로 고치지 않고 이견과 한계를 그대로 보고합니다. 구조·인용 검사는 기존 저장·온톨로지 모듈로 별도로 수행합니다.
- 이후 개선: 판정에 노출된 자료로 프롬프트를 개선하면 개발 자료로 전환한 것입니다. 개선 효과의 최종 확인에는 새로운 원문과 새 세션이 필요합니다. 같은 평가에서 틀린 항목을 교정한 뒤 독립 검증 통과로 바꾸지 않습니다.
- 한계와 보존: 이번 분리는 대화 컨텍스트와 전달 자료의 분리이며 공유 파일시스템의 접근 권한 격리는 아닙니다. 동일 모델 계열의 상관 오류와 문서 선택 편향도 남습니다. 확인한 공개 이용 가능 원문의 명시된 구간만 사용하며 전체 페이지·전 분야 성능을 주장하지 않습니다. 원문·제출·비공개 선행 확인 사항·판정·hash는 검증 종료 뒤 [한 결과 파일](../evals/source_audit.json)에 함께 보존합니다. 운영 위키·히스토리에는 평가 문서를 넣지 않습니다.

### D-029 — 질문을 고정한 자연어·그래프·결합 비교 (2026-10-22, 4-D)

상태: 수행한 고정 질문 비교의 설계·실행 기록입니다. 점수와 한계는 [PLAN](PLAN.md), 원시 결과는 비교 기록에서 관리하며 일반 성능 보장으로 사용하지 않습니다.

- 평가 단위: 앞서 논의한 상품 업무를 이어 Odoo 19.0 공식 문서의 청구 정책·반품/환불·재고 예약 원문 3개를 사용합니다. 현업·개발자·아키텍처 관점의 질문을 각 2개, 총 6개 먼저 고정합니다. 실제 업무에서 가능한 질문이지만 사내 운영 사건이나 실제 tenant 상태를 확보한 것은 아닙니다. 원문은 재서술하지 않은 전체 RST 바이트·선택 범위·URL·SHA-256으로 보존하며 CC BY-SA 4.0 출처와 변경 표시를 기록합니다.
- 비교 조건: 원문, 인증 사용자, tenant 읽기 권한, 허용 관점과 질문을 공유합니다. 기존 MCP의 ontology_context로 세 관점의 전체 원문/그래프 보존과 다른 tenant·없는 tenant의 동일 거부, 읽기 사용자의 쓰기 거부를 검사한 뒤 입력을 만듭니다. 관점은 권한이 아니며 다른 관점의 공통 정의·예외를 삭제하지 않습니다. 자연어 방식에는 원문, 그래프 방식에는 같은 원문에서 한 번 추출한 미검토 그래프, 결합 방식에는 둘 다 줍니다. 그래프에도 원문 인용이 들어 있으므로 순수한 기호 그래프와 자연어의 대조라고 부르지 않습니다.
- 예산: 세 방식 모두 입력 192 KiB, 출력 JSON 32 KiB, 질문당 답변+불확실성 1,600자·인용 5개·인용문당 240자, 6질문/실행·1,800초의 동일 상한을 적용합니다. 방식당 두 번의 새 실행을 사용합니다. 실제 입력 길이·토큰 소비가 같다는 뜻은 아니며 그래프 생성 전처리 비용도 별도로 공개합니다. 추가 검색·도구 호출·완성 답변의 재시도는 허용하지 않습니다. 그래프 형식 오류는 최대 한 번만 구조 수정을 허용하되 실제 실행에서는 사용하지 않았습니다. 의미 점수를 보고 프롬프트나 제출을 수정하지 않습니다.
- 분리: 원문 보유자가 답변 전에 질문별 근거·조건·필수 내용·관점 채점 기준을 고정합니다. 그래프 생성자는 원문·추출 계약만 받고 업무 질문과 검증 기준은 받지 않습니다. 답변 생성자는 해당 방식의 자료와 질문만 받습니다. 검증에는 원문·고정 기준·익명 제출만 주며 방식명·추출 프롬프트·생성자 해설·이전 점수는 가립니다. 생성/검증은 새로운 CLI 세션의 gpt-6-astra / xhigh로 실행하고 실제 session ID·실행 옵션·토큰 소비를 보존합니다. 두 채점 세션은 각각 세 방식의 제출 하나씩을 무작위 순서로 평가하며 동일 답변에 대한 평가자 일치도 검사는 아닙니다.
- 실행 분리 보완: 최초 fork_turns=none 협업 세션에도 프로젝트 지침이 자동 주입됐고 원문 수집 담당이 과거 에이전트 목록/점수를 잘못 조회했습니다. 해당 세션은 채점 기준·답변 생성 전에 폐기했습니다. 노출 전에 확보한 공개 원문 바이트만 재사용합니다. 새 ephemeral CLI는 빈 임시 cwd, 프로젝트 문서 자동 읽기 0, 사용자 설정 제외, 메모리·스킬 검색·쉘·앱·플러그인·웹·다중 에이전트 도구 차단으로 실행합니다. 기존 사용자의 모델/추론 설정만 호출 옵션에 복사하며 실제 사용자 설정은 바꾸지 않습니다. 공식 [비대화형 CLI](https://learn.chatgpt.com/docs/non-interactive-mode)와 [설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference)를 확인했습니다. 이것은 입력 분리이며 독립적인 외부 심사나 완전한 보안 격리 인증이 아닙니다.
- 판정: 근거·조건/예외·중요 내용 보존(누락)·관점 적합성 각각 0–2점으로 분리합니다. 원문에 없는 운영 사실에 적절히 답변을 유보하는 것도 평가합니다. 정확한 인용/버전/예산/원문과 그래프 보존은 코드로 재생하고 의미 판정과 구분합니다. 동일 모델의 상관 오류, 한 공급사의 작은 원문 표본, 2회 반복, 문체로 방식이 추측될 수 있는 불완전한 익명화가 남습니다. 실제 사람의 승인은 수행하지 않습니다.
- 실행 예외 보존: 답변 생성 전 전체 그래프 추출과 한 문서 추출이 완성 출력 없이 각각 900초에 종료되어 원문별 세 호출로 나누고 제한을 1,800초로 늘렸습니다. 같은 의미 지침과 원문으로 성공한 각 문서 제출을 그대로 합쳐 모든 방식에 같은 그래프를 사용합니다. 자연어 첫 실행은 용량 부족으로 완성 답변 없이 실패하여 같은 입력·모델로 재시도했습니다. 실패 원시 기록·알 수 없는 사용량·프로토콜 변경 전후 hash를 보존하며 실패 사용량을 0으로 처리하지 않습니다. CLI의 알려진 실험 기능 시작 경고만 성공 실행과 구분하고 다른 오류는 통과시키지 않습니다.

실행 명령은 [README](../README.md), 고정 입력·원시 결과·판정은 [비교 기록](../evals/answer_comparison.json), 실제 실행 결과와 남은 작업은 [PLAN](PLAN.md)에 기록합니다. 런타임·추출 역할 프롬프트·운영 위키와 히스토리·연결 설정·UI는 이번 단계의 변경 대상이 아닙니다.

### D-036 — 추출 신뢰성·반복 일관성과 전문가 조정의 판정 기준 (2026-10-23)

상태: 현재 추출 지침·평가에 적용하는 품질 기준입니다. 자동 의미 오류 차단이나 품질 달성의 보장은 아니며 실제 결과·미검증 범위는 [PLAN](PLAN.md)을 따릅니다.

| 기준 | 판정할 내용 | 검증 방법 |
| --- | --- | --- |
| 의미 충실성 | 주장의 대상·방향·구체적 의미·조건·예외·부정·시점·출처와 중요한 내용이 보존되는가 | 개별 주장의 원문 지지와 사전 고정한 핵심 질문의 보존을 따로 평가한다. 인용에만 남은 의미, 후보, 일반 연관만으로 핵심 보존을 통과시키지 않는다. |
| 반복 일관성 | 같은 원문·지침·모델 설정·예산에서 핵심 의미가 유지되는가 | 독립된 새 생성 세션의 개체 지시 대상과 관계·속성·조건을 비교한다. ID·배열 순서·표현 차이와 의미 차이를 구분하며, 반복된 오류는 정확성과 별도로 기록한다. |
| 전문가의 이해·수정 가능성 | 전문가가 원문과 해석을 대조해 오류를 찾고 관계·조건·적용 범위를 고칠 수 있는가 | 원문·해석 문장·조건·출처·현재 검토 상태·변경 전후를 묶어 검토한다. 실제 전문가의 과제 수행과 AI의 문장 검토·모의 조정을 구분한다. |
| 수정의 지속성과 추적성 | 변경 이유·범위·주체·이력이 남고 다음 AI 작업이 최신 유효 판단을 사용하는가 | 기존 검토/정책·Action log·되돌림 계약과 새 세션의 실제 조회를 확인한다. 원문 변경 뒤 옛 판단을 자동 승인 이식하지 않으며 pending·재검토를 드러낸다. |

- 판단 순서: 원문 근거와 핵심 의미 보존 → 현행 스키마 안의 충실한 표현 → 힌트·기존 모델과의 대응 검토입니다. 기존 정의에 맞지 않는 새 원문은 불일치로 남기며 강제로 교정하지 않습니다. 표현할 수 없는 의미는 한계로 보고하고 다른 술어로 바꾸어 완전 보존이라고 하지 않습니다. 근거 발명·의미 반전·핵심 조건/예외 손실·전문가 판단의 조용한 소실은 해당 항목의 재검토 사유이며 평균 점수로 상쇄하지 않습니다. 이것은 평가 판정 기준이며 서버가 의미 오류를 자동 차단하는 새 기능이 아닙니다.
- 관점과 자료 범위: 사용자 역할·조회 관점으로 추출 대상을 줄이지 않습니다. 원문이 실제로 구분하는 업무 맥락·모델·주장 주체는 그대로 보존합니다. v3의 `context.viewpoints` 메타데이터를 사용자 조회 프로필과 동일시하지 않습니다. 이 PoC에서 독립 자료 공간을 워크스페이스로 부르고 기존 `tenant` 경계에 대응시키되, 이번 보완은 API 이름·권한 정책·운영 연결을 변경하지 않습니다.
- 전문가 조정: 원문에 근거한 해석 정정은 D-028, 원문 인용 없는 업무 정책은 D-031을 재사용합니다. 전문가는 해석 문장과 실제 인용 또는 Action log 출처, 한정어·범위·변경 전후를 확인할 수 있어야 합니다. 판단 이력은 모델 재학습·기억에 의존하지 않고 저장·조회하며, 사람의 승인과 AI의 simulation을 구분합니다. 실제 전문가가 참여하지 않은 실행으로 이해도·수정 시간·업무 정답을 검증했다고 기록하지 않습니다.
- 평가 순서: 생성 결과 전에 원문 보유 검증자가 핵심 질문을 고정하고, 생성자는 고정 원문·추출 지침·중립 스키마만 받습니다. 생성/검증은 D-021의 새 세션·입력 제한을 따르고 원시 제출·검증용 그래프·원문·지침 hash를 보존합니다. 작은 실험용 배열 상한이나 문서쌍별 강제 연결을 추가하지 않습니다. 구조/인용, 개별 의미 지지, 핵심 누락, 반복 일관성, 전문가 조정·지속성의 결과와 분모를 각각 보고합니다. 임의 가중치로 단일 점수를 만들지 않습니다.
- 개선 경계: 기존 개발 오류를 근거로 최소 교정하고 새 평가 원문을 본 뒤 지침을 맞추지 않습니다. 평가 발견을 교정에 쓰면 개발 자료로 전환하고 최종 평가는 다시 새 원문·새 세션으로 수행합니다. 작은 표본·같은 모델의 상관 오류·실제 전문가 미참여를 일반 성능 또는 사람의 승인으로 확대하지 않습니다.

## 8. UI 설계

### D-033 — 정책을 추적한 UI 시안과 구현 경계 (2026-10-23)

상태: **UI 설계 시안**입니다. 사용자는 AI 대화 중심 배치와 필요할 때 나타나고 닫을 수 있는 문서 뷰어를 선택했습니다. 나머지 세부 화면은 검토할 제안이며, 5단계 구현 완료나 계정 방식 확정을 뜻하지 않습니다.

현행 화면 데이터 경로는 [D-043]의 일반 API/CLI 분리를 따릅니다. 아래 라이브러리 조사 당시의 Electron main MCP 클라이언트 권고는 일반 화면 조회의 필수 구성에서 제외하며, UI는 main의 일반 HTTP API client를 사용하고 개인 CLI가 MCP에 접속합니다. 컴포넌트/adapter 경계는 [D-045]와 연결한 앱 설계를 따릅니다.

- 기본 작업 공간: 대화만 표시하다가 출처 또는 결과 문서를 선택하면 옆에 뷰어를 엽니다. 닫아도 대화 입력·초안을 유지합니다. Fumadocs에서 참고한 문서 탐색·본문·목차 구성은 별도 문서 화면에 둡니다. 기본 기술은 아래 2026-10-24의 사용자 선택을 따르며, 추가 UI 라이브러리는 조사 권고안입니다.
- 화면 추적: 접근 4개, AI 대화 7개, 문서 6개, 온톨로지 8개, 검토·이력 5개, 설정 5개로 총 35개 화면·패널을 구성합니다. 시안의 화면 지도와 화면별 정책 근거에 기존 D-005~D-032의 관련 계약·지원 범위·예외 상태를 연결합니다. 정상 화면 외에 권한 부족, 불완전 조회, 오래된 자료, 충돌, 저장 실패, 저장 후 정리 경고, 응답 유실, 원장 문제와 재연결 상태를 구분합니다.
- 판단의 표시: 개념 그래프와 문서 연결, 문서 내부 관계 후보와 문서 간 이름 일치 후보, 원문 근거 검토와 전문가 업무 판단을 구분합니다. 검토 이벤트와 정책 이벤트는 별도 상세를 가지며 현재/다른 관점/대기/비활성을 유지합니다. 재추출 결과 반영은 원문 저장과 다른 화면에서 검토합니다. D-028·D-031의 수정·되돌림 범위를 확장하지 않습니다.
- AI와 기록: 대화·실행 기록·미저장 결과 초안·저장된 Wiki·판단 Action log를 구분합니다. 과거 답변은 당시 관점과 출처를 보존하고 최신 판단 변경을 조용히 덮어쓰지 않습니다. Custom CLI와 선택 터미널은 기존 MCP를 사용하는 실행 연결의 설계이며 실제 CLI·PTY·AI 계정 연결은 구현하지 않았습니다.
- 신규 계약 표시: 계정 발급/SSO/복구 및 관리자 권한·소속 매핑, 문서 목록/트리와 원문 히스토리 읽기, 사용자·tenant별 대화·초안 보관, 로컬 AI 실행 연결, 경량 변경 감지/알림/재연결은 추가 구현이 필요합니다. 현재 문서별 검토 API를 전역 검토함·전역 Action log 검색으로 과장하지 않습니다. 소속 관리 화면은 후속 설계이며 전문가 정책 권한으로 접근 관리를 허용하지 않습니다.
- 시안의 한계: 모든 문서·사용자·이벤트·버전은 가상 예시입니다. 로컬 화면 전환과 상태 시뮬레이션만 제공하며 실제 인증·AI 실행·MCP 변경·저장은 수행하지 않습니다. 화면에서 보여주는 조건을 서버 검증이나 운영 보안의 증거로 사용하지 않습니다.

시안 검증 범위와 다음 작업은 [PLAN](PLAN.md)의 UI 설계 기록을 따릅니다.

#### Electron PoC 기술 기준과 라이브러리 조사 (2026-10-24)

사용자는 **UI 디자인을 여기서 멈추고 Electron·React·React Router·Jotai·TypeScript를 기반으로 필요한 라이브러리를 조사**하도록 요청했습니다. 이 다섯 기술은 사용자 지정 기준입니다. 아래 추가 패키지는 공식 문서·저장소를 확인한 권고안이며 최종 채택·설치·제품 구현 완료를 뜻하지 않습니다. 이번에는 시안이나 실행 코드를 편집하지 않습니다.

| 역할 | 추가 권고 패키지 | 이 프로젝트에서 맡을 일과 선택 이유 |
| --- | --- | --- |
| 개발·빌드 | `electron-vite`, `vite`, `@vitejs/plugin-react` | main·preload·React renderer를 한 빌드 설정에서 관리하고 개발 중 변경을 반영합니다. [electron-vite 가이드](https://electron-vite.org/guide/)의 React TypeScript 구성을 기준으로 삼습니다. |
| 설치 패키지 | `electron-builder` | macOS·Windows·Linux 설치 산출물을 만듭니다. [안정판 v26 문서](https://www.electron.build/v26/)와 다음 v27 문서를 구분하며, 개발 도구와 패키징 도구를 각각 하나씩 사용합니다. |
| 공통 UI | `@mantine/core`, `@mantine/hooks` | 입력·탭·트리·대화상자·상태 표시를 재사용해 PoC 제작 범위를 줄입니다. 알림은 필요할 때 `@mantine/notifications`, 복잡한 폼은 `@mantine/form`을 추가하며 다른 UI·폼 체계를 함께 기본 의존성으로 넣지 않습니다. [Vite 구성](https://mantine.dev/guides/vite/) |
| 작업 영역 크기 조절 | `react-resizable-panels` | 문서·지도·근거 영역을 사용자가 조절하고 접을 수 있게 합니다. 1920×1080의 작업 영역을 고정 카드 높이 대신 활용합니다. [공식 저장소](https://github.com/bvaughn/react-resizable-panels) |
| 온톨로지 지도·자동 배치 | `@xyflow/react`, `elkjs` | React 관계 상자·직접 편집·개별 handle과 ELK의 방향·port 순서를 연결합니다. [커스텀 노드](https://reactflow.dev/learn/customization/custom-nodes)·[다중 연결점 배치](https://reactflow.dev/examples/layout/elkjs-multiple-handles) |
| Markdown 읽기 | `react-markdown`, `remark-gfm` | 위키 본문·표·체크 목록을 표시합니다. 초기 PoC에서는 raw HTML 확장을 추가하지 않습니다. [react-markdown](https://github.com/remarkjs/react-markdown)·[GFM](https://github.com/remarkjs/remark-gfm) |
| 원문 편집·줄 선택 | `@uiw/react-codemirror`, `@codemirror/lang-markdown` | Markdown 편집과 근거 줄 선택·강조에 같은 편집기를 사용합니다. [공식 React 래퍼](https://github.com/uiwjs/react-codemirror) |
| 이전·새 원문 비교 | `@codemirror/merge` | CodeMirror와 함께 텍스트 전후 비교를 제공합니다. [공식 패키지 안내](https://github.com/codemirror/merge)·[현재 변경 기록](https://codemirror.net/docs/changelog/). 텍스트 차이는 관계의 의미 변경·삭제·AI 누락을 판정하지 않습니다. |
| 서버 조회·갱신 | `@tanstack/react-query` | [D-043]의 일반 HTTP API를 감싼 조회 함수로 문서·그래프·검토·작업 상태 캐시와 무효화를 관리합니다. [조회 기본 동작](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)을 작업 흐름에 맞춰 설정합니다. |
| 실행 시 입력·응답 검사 | `zod` | IPC와 편집 입력·서버 응답의 구조를 검사하고 TypeScript 타입과 연결합니다. 원문 의미 정확도·서버 권한 검증을 대신하지 않습니다. [공식 문서](https://zod.dev/) |
| MCP 직접 연결·진단(조건부) | `@modelcontextprotocol/client` | 앞선 조사에서 확인한 TypeScript SDK v2 클라이언트/Node 전용 stdio 후보입니다. [D-043] 개정에 따라 제품 UI 조회의 필수 의존성으로 채택하지 않으며 개인 CLI가 MCP를 사용합니다. 별도 진단/직접 클라이언트가 필요할 때만 검토합니다. [공식 클라이언트 예제](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-client) |
| 터미널 표시·입력 | `@xterm/xterm` | React 화면 안에 CLI의 ANSI 출력·커서·대화형 입력을 표시합니다. 별도 React 래퍼 없이 컴포넌트 수명에 맞춰 인스턴스를 연결합니다. [xterm.js 공식 안내](https://github.com/xtermjs/xterm.js) |
| 터미널 영역 맞춤 | `@xterm/addon-fit` | 분할 패널 크기에 맞는 열·행 수를 계산합니다. 계산 결과를 실행 중인 PTY에도 전달합니다. [공식 addon 예제](https://xtermjs.org/docs/guides/using-addons/) |
| 대화형 CLI 실행 | `node-pty` | Electron main이 관리하는 로컬 PTY에서 CLI·셸을 실행하고 입력·출력·크기 변경·종료를 연결합니다. [공식 저장소](https://github.com/microsoft/node-pty) |
| 아이콘 | `lucide-react` | 공통 버튼·상태·파일 아이콘을 사용합니다. [공식 React 안내](https://lucide.dev/guide/react) |

선택과 구현 경계는 다음과 같습니다.

- 상태의 담당: Jotai에는 선택한 문서/주장, 묶음의 접힘, 패널과 미저장 초안을 둡니다. Query에는 서버 조회 결과를 두고 같은 최신 그래프를 두 저장소의 별도 원본으로 관리하지 않습니다. 조회 범위의 tenant·관점·문서를 캐시 키에 반영하고 refetch가 편집 초안을 덮지 않게 합니다. 쓰기·재추출·검토는 명시적 실행이며 자동 재전송하지 않습니다. 저장 결과 미확인에서는 현행 상태를 먼저 조회하고 기존 CAS 계약을 유지합니다. `jotai-tanstack-query`는 [공식 확장](https://jotai.org/docs/extensions/query)이지만 초기 필수 의존성은 아닙니다.
- 지도 선택: 관계 유형별 접힘과 전체 구조의 유지는 원본 그래프에서 표시 그래프를 계산하는 앱 로직입니다. 경계 연결·숨긴 관계 수·주장 ID·근거·전문가 이력을 보존하며 MiniMap만으로 전체 저장 그래프가 보인다고 가정하지 않습니다. 개별 handle을 ELK port에 대응시키되 교차 제거를 보장하지 않습니다. React Flow 내부 상태 의존성 때문에 앱의 Jotai 선택을 바꾸지 않습니다. [Cytoscape.js](https://js.cytoscape.org/)는 단순 노드·선의 대규모 탐색과 알고리즘이 우선될 때 대안입니다. 유지보수 중단을 명시한 `cytoscape-expand-collapse`를 기본 패키지로 채택하지 않습니다.
- 프로세스 경계(2026-10-24 사용자 보완 반영): React renderer → 제한된 preload API → Electron main의 일반 HTTP API 클라이언트 → 같은 위키 백엔드의 자료 서비스/저장 모듈로 연결합니다. 개인 CLI는 main의 로컬 PTY에서 실행돼 별도로 MCP에 접속합니다. [Electron 기본 IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)·파일 대화상자를 활용하고 renderer에서 위키·히스토리·검토 원장을 직접 덮어쓰지 않습니다. 추가 IPC 프레임워크나 `file-saver`는 초기 필수 항목이 아닙니다. 원격 서버의 Python 실행 환경을 각 사용자 PC에 복제하는 것을 전제로 두지 않으며 CLI별 로컬 파일 읽기 도구의 설치/패키징은 별도 검증합니다. API/MCP 상세 계약은 [D-043]을 따릅니다.
- 터미널 연결 보완: 기존 Custom CLI·선택 터미널 요구를 앞선 패키지 목록에서 누락해 사용자의 후속 질문에 따라 위 세 패키지를 기본 권고 구성에 추가했습니다. 연결은 xterm → 제한된 preload IPC → main이 관리하는 node-pty → 로컬 CLI입니다. 생성/입력/출력/resize/종료 이벤트와 세션 ID를 연결하고, 화면을 숨기거나 다시 렌더링하는 것과 CLI 프로세스 종료를 구분합니다. Jotai에는 활성 세션·상태를 두고 출력 버퍼는 xterm이 관리합니다. CLI 실행 경로·작업 디렉터리·환경은 명시적으로 확인하며 GUI가 사용자의 셸 환경을 자동 상속한다고 가정하지 않습니다. 터미널 PTY 채널과 기존 MCP의 구조화된 stdio 채널은 각각 유지하며 터미널 텍스트를 저장 성공·유효 검토 결과로 승격하지 않습니다. 이 구성은 로컬 연결 권고이며 SSH·세션 복원·AI 실행/응답 파싱을 구현했다는 뜻이 아닙니다.
- 터미널 배포 확인: `node-pty`는 네이티브 모듈이므로 대상 Electron 버전·OS·CPU에 맞춰 빌드해야 합니다. 패키징 도구의 재빌드 절차를 사용하고 필요하면 개발 도구 `@electron/rebuild`로 확인합니다. [Electron 네이티브 모듈 안내](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules). 실제 패키지 설치·터미널 시작/입출력·한글 입력·Ctrl+C·패널 resize·앱 종료 시 프로세스 정리와 macOS/Windows 설치 산출물 검증은 미실행입니다.
- 조건부 추가: PDF 원본을 앱 안에서 읽을 때 [`react-pdf`](https://github.com/wojtekmaj/react-pdf), 문서/검토 목록이 길어질 때 [`@tanstack/react-virtual`](https://tanstack.com/virtual/latest/docs/introduction), 허용된 로컬 파일의 외부 변경을 감지할 때 [`chokidar`](https://github.com/paulmillr/chokidar)를 추가합니다. 파일 감지는 재조회 신호이며 자동 재추출·저장 성공의 증거가 아닙니다. PDF 표시·원본 교체·Markdown 변환도 각각 다른 책임입니다. 실제 AI 실행 연결을 정하기 전에 별도 AI SDK·에이전트 프레임워크를 추가하지 않습니다.
- 검증 도구: 구현 시 [`vitest`](https://vitest.dev/guide/)·[`@testing-library/react`](https://testing-library.com/docs/react-testing-library/intro/)와 `@testing-library/user-event`·`jsdom`으로 편집/충돌 흐름을 확인하고, 실제 앱의 시작·일반 API 왕복·로컬 CLI의 별도 MCP 연결·종료는 [`@playwright/test`](https://playwright.dev/docs/api/class-electron)로 확인하는 방안을 권고합니다. Playwright의 Electron 자동화는 조사 당시 실험 지원입니다. 이번 조사에서는 테스트 코드를 추가하거나 실행하지 않았습니다.
- 버전·배포 확인: [Mantine 9](https://mantine.dev/changelog/9-0-0/)는 React 19.2+를 요구하며 electron-vite는 Node 20.19+/22.12+ 조건을 명시합니다. 선택할 React-PDF 배포 버전의 Node 조건도 별도로 맞춰야 합니다. 저장소 main·다음 버전 문서를 배포 최신 안정판과 혼동하지 않고, 구현 착수 시 실제 배포 버전의 peer 의존성을 해결한 lockfile로 고정합니다. [elkjs 배포 메타데이터](https://registry.npmjs.org/elkjs/latest)의 라이선스는 `EPL-2.0 OR GPL-3.0-or-later`입니다. 전체 조합의 설치·Electron 패키징·worker 경로·Python MCP 왕복·성능·라이선스 배포 조건의 검증은 이번에 수행하지 않았습니다.

조사 완료와 구현 완료는 구분합니다. 다음 별도 작업은 이 권고안과 [D-043] 개정을 바탕으로 최소 Electron 골격·의존성 호환·일반 API 읽기와 개인 CLI의 MCP 연결 범위를 정하는 것이며, 이번 요청에서는 설치·화면 이전·기능 구현을 시작하지 않습니다.

### D-045 — Electron 앱의 디자인 토큰과 React 컴포넌트 경계 (2026-10-24)

상태: 처음에는 **사용자가 요청한 구현 전 준비**로 `app/` 위치·디자인 값·React 책임 경계를 정했습니다. 이후 2026-10-25 요청으로 아래 실행 골격에 착수했습니다. 앞선 문서 설계의 검증과 실행 골격의 검증은 구분하며, 전체 5단계 완료 상태는 PLAN이 관리합니다.

- 디자인 값은 `app/design/tokens.json` 한 곳에 두고 생성기로 CSS 변수와 타입 있는 TypeScript 값을 만듭니다. 이유는 React 일반 UI·그래프/SVG·터미널의 색/치수를 별도로 복사하지 않기 위해서입니다. 시안의 최종 적용 규칙과 두 테마를 보존하고 추출값·의미 별칭·새 구현 제안을 출처로 구분합니다. 상세 값/사용법은 [디자인 토큰 문서](../app/docs/design-tokens.md)가 담당합니다.
- 화면은 page 합성 → 기능 container/hook → 표시/편집 UI로 분리하고 원문 근거·판본·주장 UI를 공유합니다. URL 선택, Jotai의 UI/초안, Query의 서버 조회, main의 PTY 수명을 각각 하나의 원본으로 관리합니다. 이유는 시안의 전역 state·DOM 교체를 한 TSX로 감싸지 않고 같은 대상/근거를 화면 사이에서 유지하기 위해서입니다. 초기 라우팅은 HashRouter 기준으로 설계하되 실제 Electron 로드/탐색 검증은 후속입니다.
- `app/src/main`·`preload`·`renderer`의 역할과 feature별 파일 배치는 [컴포넌트 설계](../app/docs/component-architecture.md)에서 관리합니다. 현재는 토큰 산출물 외 제품 디렉터리/빈 컴포넌트·새 패키지를 미리 만들지 않습니다. 기본 기술/추가 라이브러리의 채택·버전 호환은 D-033을 유지하고 구현 착수 때 검증합니다.
- 후속 명명 규칙: 사용자의 추가 요청으로 컴포넌트/파일은 PascalCase 일치, hook·props·이벤트·상태와 업무별 역할 접미사를 정했습니다. `Claim/Relation`, `Review/Policy/Correspondence`, 원본/Wiki, 작업/세션의 의미를 이름에서도 유지합니다. 상세 규칙은 [명명 규칙](../app/docs/component-architecture.md#11-명명-규칙) 한 곳에서 관리하고 [app 작업 규칙](../app/AGENTS.md)이 이를 참조합니다. 실제 React 파일 분리는 아직 수행하지 않았습니다.
- 초기 프로젝트 구조 보완(2026-10-25): `app/` 단일 패키지 안에서 Electron의 main/preload/contracts와 기능별 React renderer, 계약/타입·검사·명명 규칙을 정의했습니다. 아래 domain/feature 경계 결정이 당시 단일 domain 타입 폴더·업무 영역별 feature·shared/knowledge 목표 배치를 대체합니다. 현행 위치/규칙은 [앱 설계 2절](../app/docs/component-architecture.md#2-구현-위치와-의존-방향)과 [11.6절](../app/docs/component-architecture.md#116-electron-계약과-코드-작성)이 담당합니다. 기존 React Router/Jotai/Query·D-043 API/CLI·D-046 서버와 D-047 연결 설정의 책임을 유지하며 실제 설정·검사·버전 고정은 골격 구현에서 수행합니다.
- 백엔드 추가 반영: 사용자가 문서 목록·추출 데이터 조회용 서버 추가를 알렸고, 현행 D-043의 일반 API/MCP 분리를 앱 설계에도 적용했습니다. 화면 조회/등록은 제한된 preload → main HTTP client → 일반 API, 개인 CLI는 MCP의 입력 조회·제출/저장을 사용합니다. CLI가 없어도 기존 자료를 조회하며 유효 그래프/검토 상태·목록 페이지/완전성을 보존합니다. 백엔드 읽기 API를 UI 실제 연결보다 먼저 구현하도록 이관 순서를 조정했고, 실제 계약이 없는 HTTP 쓰기를 기존 MCP로 자동 우회하지 않습니다. 구체 서버 계약은 D-043을 따르며 이번에는 문서 정합성만 수정합니다.
- 원문/그래프/검토/정책·후보·동일 대상/판본과 D-043 작업/영수증·D-044 고정 입력 출처의 의미는 기존 계약을 따릅니다. 새 관계 직접 저장·전역 목록/완료·계정 발급·D-043/044 신규 도구가 현재 구현돼 있다고 표시하지 않습니다. 이번 설계는 서버·자료·원장·권한·실제 연결과 시안 HTML을 변경하지 않습니다.

#### domain과 feature의 작업 경계 (2026-10-25)

사용자가 검토한 구조를 기준으로 **domains는 업무 모델·공통 규칙·재사용 표현, features는 입력부터 결과 확인까지의 한 사용자 흐름**으로 설계 문서에 반영합니다. documents/knowledge/review 등 업무 영역을 사용자 작업과 구분하고, 상위 page가 기능의 공개 입력/결과를 연결합니다. 특정 FSD 계층을 따르기 위해 폴더를 늘리지 않습니다. 선택 이유는 같은 모델의 소유자를 명확히 하면서 사용자 목적별 수정 위치·상태 수명·완료 기준을 독립적으로 찾기 위해서입니다.

모델/근거/판본과 재사용 UI의 상세 소유권은 [domain별 표](../app/docs/component-architecture.md#25-domain별-모델-소유권), 검토한 12개 feature의 입력·완료 결과는 [feature별 표](../app/docs/component-architecture.md#26-feature별-입력과-완료-결과)가 단일 원본입니다. 작은 feature는 평평하게 시작하고 ui/model/api는 실제 책임이 커졌을 때만 나눕니다. 흐름 조정/UI의 일부 중복은 허용하되 domain 공통 규칙·HTTP/IPC 계약·전송 오류 변환을 복제하지 않습니다. 다른 feature/domain 실행 코드의 직접 참조와 역참조를 막고 식별/판본 참조는 공통 contracts로 전달합니다. 서버의 인가·정책·원장/CAS·저장 규칙은 기존 백엔드가 계속 소유합니다.

등록/분석·원문 검토/전문가 판단·비교/적용·CLI 시작/AI·MCP 확인의 완료를 각각 구분합니다. 기존 질문/대화/결과물·본문 직접 등록·대응/되돌림·미발견 처리의 기능은 삭제하지 않고 미결 계약과 함께 후속 feature 경계를 정합니다. 이번 선택은 문서 설계이며 제품 파일/폴더·설정/의존성·React/Electron·일반 API·CLI 연결·운영 자료 변경을 시작하지 않습니다. 5단계 기능 구현은 미착수로 유지합니다.

#### Electron 실행 골격의 착수 (2026-10-25)

사용자가 Wiki UI App 구현을 Electron 구성부터 시작하도록 요청했습니다. 일반 API의 선행 요구는 **실제 자료 연결에 적용**하며, 서버 없이 실행할 수 있는 앱 골격을 먼저 준비합니다. 기존 시안 전체나 샘플 문서는 이식하지 않고 시작/앱 정보 화면만 둡니다. 다음 API·문서·CLI 기능을 이번 구현에 포함하지 않습니다.

- `app/` 단일 npm 패키지와 electron-vite를 채택했습니다. 현재 안정 배포의 Electron 45·electron-vite 6·Vite 8·React 19.3·React Router 8·Jotai 3을 lockfile에 고정하고 Node 24를 개발 기준으로 정했습니다. typescript-eslint가 지원하는 TypeScript 6.0.3을 사용하며 최신 TypeScript 7을 자동 선택하지 않습니다. 다른 기능의 Mantine·지도·PTY·Query·파서·패키징 도구는 필요할 때 추가합니다.
- main/preload/renderer/contracts를 분리하고 공개 앱 정보 조회 하나만 IPC로 노출합니다. 호출 창·최상위 frame·정확한 문서 URL·무인자 입력을 확인합니다. renderer는 Node 접근을 끄고 context isolation·sandbox를 유지하며 preload는 단일 CJS로 번들합니다. 정확한 제품 파일 또는 고정 loopback 개발 서버만 허용하고 외부 탐색·팝업·권한 요청을 차단합니다. 개발용 스크립트/CSP 예외는 제품 빌드에서 제외합니다.
- 기존 토큰을 재사용해 HashRouter와 테마를 조립합니다. main/preload/renderer/도구의 strict 타입 검사, ESLint의 경계·순환·Hooks 검사와 Prettier·토큰 검사를 실행 가능한 명령으로 구성합니다. 이번 실행 범위는 Playwright의 실제 Electron 검사로 검증하며, Vitest/Testing Library는 편집·조회 등 해당 검사가 필요한 기능을 구현할 때 추가합니다.

선택 이유는 사용자 지정 기술과 D-045의 경계를 실제 실행으로 확인하면서 서버·위키·인증·CLI 설정을 변경하지 않기 위해서입니다. 실행 방법은 [app README](../app/README.md), 실제 검증 결과·플랫폼 한계와 다음 범위는 [PLAN](PLAN.md#d-045-electron-실행-골격-2026-10-25)이 담당합니다.

#### 설정 위치와 Oxc 도구 전환 (2026-10-25)

사용자가 루트 파일·설정 복잡성을 줄이고 ESLint·Prettier를 Oxc로 교체하도록 요청했습니다. 앱 루트에는 npm/Node·패키지/lockfile·README/AGENTS 진입점만 유지하고 빌드·검사 설정은 `app/config/`, 분리 타입 설정은 그 아래 `typescript/`로 모읍니다. npm 명령에서 설정 경로를 명시하고 빌드 alias·타입 include·Playwright의 테스트/출력 경로를 새 위치에 맞춥니다. 앱 소스의 기능 경계와 기존 토큰 경로는 유지합니다.

Oxlint 1.89.0과 Oxfmt 0.74.0을 exact 의존성/lockfile로 고정하고 이전 ESLint·Prettier 및 관련 플러그인을 제거합니다. TypeScript 6.0.3의 별도 타입 검사는 유지합니다. 일반 correctness·순환·절대경로 import 금지·타입 import·Hooks·Node/React 및 bridge 접근 제한은 Oxlint 내장 규칙을 사용합니다. 기존 해결된 경로의 계층 제한은 대응 내장 규칙이 없어 앱 전용 JS 규칙으로 옮기며, 알려진 alias/상대경로를 정규화해 검사하고 절대경로 참조는 금지합니다. 정적/동적/타입 import·re-export·require 형태와 다른 feature/domain의 직접 참조를 함께 확인합니다.

선택 이유는 설정 진입점을 줄이면서 도구 교체로 기존 경계를 느슨하게 만들지 않기 위해서입니다. formatter의 검사 범위는 수기 앱 코드/설정/시험으로 한정하고 생성 토큰은 npm 명령에서 명시적으로 제외합니다. Oxc JS plugin API를 사용하는 작은 규칙은 고정한 버전의 실제 CLI fixture 회귀로 검증합니다. 앞선 ESLint·Prettier 선택을 이 결정으로 대체하며, 실행 명령/현재 배치는 앱 README, 실제 검증은 [PLAN](PLAN.md#d-045-설정-정리와-oxc-전환-2026-10-25)에 기록합니다.

#### 도메인 중립 공통 UI의 순차 구현 (2026-10-25)

사용자가 업무 도메인에 속하지 않는 공통 요소부터 하나씩 구현하도록 요청했습니다. 현재 테마 버튼이라는 실제 사용처가 있는 `Button`을 먼저 구현하고, 후속 요소는 [PLAN의 순서](PLAN.md#5단계-공통-ui의-구현)에 따라 각 요청에서 하나씩 진행합니다. 이유는 화면마다 기본 스타일/입력 동작을 복제하지 않으면서 실제 사용처로 공통 계약을 확인하기 위해서입니다. 후속 컴포넌트의 빈 파일·시연 페이지·모의 데이터는 만들지 않습니다.

첫 Button은 `shared/ui/`의 named export와 CSS Module로 구성하고 기존 테마 토큰만 사용합니다. 네이티브 props/ref·disabled와 키보드 의미를 전달하며 의도하지 않은 폼 제출을 막도록 기본 type은 button으로 둡니다. primary/secondary 외에 업무 상태·전송·권한·태그 다형성을 추가하지 않습니다. 테마 상태는 기존 AppShell이 계속 소유하고 공통 버튼은 이벤트만 전달합니다. 공통 UI 라이브러리와 새 시험 의존성을 추가하지 않고 기존 실제 Electron 검사에 키보드 경로를 보완합니다. 구체 계약은 [앱 설계](../app/docs/component-architecture.md#4-공용-컴포넌트의-계약), 실제 검증은 PLAN에서 관리합니다.

#### 공통 UI 묶음 구현으로 전환 (2026-10-25)

사용자가 요소별 중단/확인 대신 공통 기반을 빠르게 묶어 구현하도록 요청했습니다. 위의 하나씩 중단하는 진행 방식은 대체하며, 기존 토큰·native 버튼/입력/dialog를 재사용해 공통 묶음을 구현하고 마지막에 한 번 통합 검증합니다. 입력·탭·대화상자는 서로 독립된 파일 담당으로 병행하며 새 UI 의존성이나 제품 갤러리는 추가하지 않습니다. 현재 계약은 앱 설계, 범위/실제 검증은 PLAN이 관리합니다.

### D-039 — 유스케이스에 따른 AI 온톨로지 중심 화면 구성 (2026-10-23)

Electron의 일반 API 원본/본문 등록·목록 → 로컬 개인 CLI 요청 → CLI의 MCP 지침 조회·파일 읽기·추출/저장 → 일반 API 결과 표시의 계약은 [D-043]을 따릅니다. ‘위키 사용 사례 목록화’ 채팅이 앞선 등록/CLI 흐름으로 기존 시안을 갱신했으며 [당시 동선/보존 검증과 한계](PLAN.md#d-043-원격-등록개인-cli-분석mcp-저장ui-연결-설계-2026-10-24)는 PLAN에서 관리합니다. 이번 API/CLI 책임 개정으로 시안/제품 연결을 다시 검증했다고 표시하지 않으며 아래 모의 동작·제품 미구현 경계는 유지합니다.

상태: 사용자가 요청한 **1920×1080 연결 지도 시안**을 ‘개념 선택 → 연결 확인 → 수정 또는 새 연결’의 작업 중심으로 단순화했습니다. 지도의 관계 상자 클릭과 ‘+ 연결 추가’에서 즉시 입력창을 열고, 필터·집계·검토 큐는 기본 화면에서 제거했습니다. 원문 대조·작성 이유·이력·되돌림은 선택 연결에 붙입니다. 실제 전문가의 사용성·서버 저장·지속성은 검증하지 않았으며 D-034의 제품 목적과 D-033의 AI 작업·문서 뷰어를 유지합니다. 5단계 제품 구현·실제 AI/MCP 연결 완료로 표시하지 않습니다.

#### 저장된 자료 조회와 새 AI 분석의 분리 (2026-10-24)

사용자가 요청한 문서 목록·자료 등록·연결된 지식 탭을 기존 HTML 시안에 반영했습니다. 1920×1080 배치와 지도 코드는 유지하고 첫 화면을 저장된 자료 읽기로 바꿉니다. 이유는 D-043의 일반 API 조회를 개인 CLI의 새로운 분석 실행으로 오해하지 않게 하기 위해서입니다.

- 목록은 제목 선택으로 읽기, 검색·폴더/원본 종류 필터와 원본→파생 Wiki 계층을 제공합니다. 파일 등록은 이름·원본만, 직접 입력은 본문을 받습니다. 등록 완료와 분석 미요청을 표시하고 사용자가 별도로 AI 분석을 요청합니다.
- 연결된 지식은 저장된 결과·근거·본문/그래프/검토 판본과 미검토 상태부터 표시합니다. 새 분석은 별도 요청창에서 준비/명시 실행하며 CLI 미연결 중에도 자료 조회는 가능합니다. 조회 실패는 재분석이나 결과 없음으로 해석하지 않고 문서·관점별 직전 snapshot을 보존합니다.
- 요청 기준에는 원본 판본·본문/그래프/검토 버전·관점을 고정합니다. 기준 변경이나 CLI 연결 변경 때 기존 결과를 덮어쓰지 않으며 새 요청 준비 시 이전 요청과 이유를 이력에 남깁니다. 모의 AI 결과에 전문가 승인 이력을 자동 이식하지 않습니다.
- 초기 세 문서의 저장 결과는 모의 fixture이며 분석 실행·실제 서버 자료로 표시하지 않습니다. 일반 API·파일 전송·AI/CLI·Electron 연결과 지속 저장은 이번에 구현하지 않았습니다. 실제 확인 범위와 시안 hash는 [검증 기록](PLAN.md#d-039-저장된-자료-조회등록새-분석-시안-2026-10-24)을 따릅니다. 공용 토큰 값 135개는 유지하고 변경된 시안의 출처 hash와 생성 산출물을 동기화합니다.

#### AI 작업·전문가 검토·변경 이력의 조회 경계 (2026-10-24)

같은 문서·관계·원문 근거를 유지하도록 사용자가 요청한 세 화면을 위 조회 중심 시안에 연결합니다. AI 작업은 저장된 결과를 기본으로 표시하고 분석 요청 목록/새 요청을 분리합니다. 새 질문도 명시 AI 요청이며 CLI 미연결 중에는 기존 결과를 읽을 수 있습니다. 원본만 등록된 상태는 원본 ref를 유지하고 실제 파생 Wiki를 선택해 이어가며 이전 기본 문서로 대체하지 않습니다.

전문가 검토는 저장된 현재 주장과 근거를 대조하고 명시 저장합니다. 조회 실패·확정 저장 실패·저장 결과 미확인을 구분하며 결과 미확인은 재저장 대신 이벤트 조회로 확인합니다. 재추출로 claim이 교체되면 현재 목록으로 전환하고 옛 초안은 보관해 볼 수 있게 하며 신규 주장에 복사하지 않습니다. 변경 이력은 이벤트 당시 값·이유·인용·원문 판본을 고정해 표시하고 현재 관계는 별도로 조회합니다. 옛 claim을 새 claim과 자동 대응하지 않으며 되돌림에는 조회한 state 기준을 사용합니다.

이 선택의 이유는 자료 조회·AI 실행·전문가 판단·과거 기록을 같은 저장 처리로 오해하지 않게 하고 근거 계보를 보존하기 위해서입니다. 상세 컴포넌트 책임은 [앱 설계](../app/docs/component-architecture.md#5-화면별-분해와-책임), 실제 시안 검증은 PLAN에서 관리합니다. 현재는 메모리 시안이며 일반 API·CLI/AI·React/Electron·지속 저장은 구현하지 않았고 D-043/044의 미구현 계약을 완료로 바꾸지 않습니다.

#### 지식 탐색·질문·작업 공간의 조회 경계 (2026-10-24)

남은 세 화면도 저장된 지식 조회와 명시 새 AI 요청을 분리합니다. 1920×1080 지도 배치·접기/펼치기·개념 선택은 유지하고, 지도 렌더링으로 관계를 생성하지 않습니다. 원시 지도 주장을 문서·claim·판본에 연결해 같은 근거로 공용 검토/이력에 이동합니다. 조회 실패는 같은 관점의 직전 지도임을 표시하고 stale·보류·후보를 구분하며, 접근 거부 상태에서는 캐시 자료를 표시하지 않습니다. 초기 지도 인용 예시와 고정 모의 전문가 이벤트는 실제 서버 원문/사람 승인으로 간주하지 않습니다.

질문은 요청한 문서·관계를 조용히 줄이거나 다른 문서로 대체하지 않습니다. 원문/추출/검토 판본·관점을 확인한 뒤 명시 실행하며 변경 시 초안·이전 답변을 보존하고 재확인합니다. 인용이 있는 미검토 원문 주장도 상태와 함께 읽을 수 있고, 후보·보류·오래된 판단은 확정 규칙으로 적용하지 않습니다. 이유는 LLM Wiki의 원문 활용을 막지 않으면서 검토/근거 계보를 보존하기 위해서입니다.

작업 공간은 자료 서비스, 개인 CLI/AI, MCP 준비·행동 권한을 분리합니다. 일반 API 조회는 CLI 로그인 없이 가능하고 AI 요청은 별도 실행 준비를 요구합니다. 연결 상태가 실행 중 바뀌면 저장 전 중단하며 재연결로 자동 실행하지 않습니다. 영수증 조회는 새 AI 요청과 별도입니다. 상세 컴포넌트 책임은 앱 설계에, 실제 검사·화면 증거는 PLAN에 기록합니다. 현재는 메모리 시안이며 실제 일반 API/CLI/AI/인증·Electron/React·지속 저장은 미구현입니다.

#### 결과물 초안 편집과 명시 Wiki 반영 (2026-10-25)

추가 누락 동선 재대조에서 답변의 저장 행동이 편집 전 자동 구성 본문을 즉시 Wiki로 만들던 점을 우선 보완합니다. 답변→결과물 초안 작성→제목/서술 편집·처음 초안/질문 당시 근거 대조→명시 반영으로 연결합니다. 이유는 초안 완성과 문서 저장을 분리하고 편집 서술이 원래 인용·전문가 판단의 승인으로 보이지 않게 하기 위해서입니다.

질문 당시 원문·문서별 추출/검토 기준과 전체 claim/한정어·판단 이유를 보존합니다. 기준이 없는 옛 질문은 미보유로 표시하고 최신 숫자를 소급하지 않습니다. 편집 본문과 고정 출처 부록을 나누며, 원자료가 다시 바뀌면 이전 확인을 재사용하지 않습니다. 최종 전체 크기 검사·초안 보존·성공 문서의 중복 방지를 메모리 시안에서 검증합니다. 실제 결과물/대화 API·권한·응답 미확인/영수증·재시작/공유와 출처 영속화는 D-043 F02/F03의 미결 계약으로 유지합니다. 다른 누락의 상태/우선순위와 이번 확인 결과는 PLAN이 담당합니다.

#### 분석 범위·산출물 설정과 원본 근거 추적 (2026-10-25)

사용자가 요청한 다음 한 단계로 범위 선택 → 만들 문서별 제목·목적·사용 구간 → 필수 정의·조건·예외 선택 → 실행 기준 확인 → 당시 원본·준비 본문·추출 인용을 연결합니다. 기존 1920×1080 배치와 지도·원문·판단은 유지하고 새 최상위 메뉴를 만들지 않습니다. 문서/등록 원본의 기존 분석 진입점과 원본 정보, AI 작업 요청 목록에서 같은 범위 작업으로 이어갑니다.

원본 페이지·셀 대응을 설명하는 PDF/Excel은 별도 합성 화면 예시입니다. 기존 Wiki에는 보유한 줄 위치만 표시하고 과거 원본 페이지·셀·불변 추출물/hash는 미보유로 남깁니다. 실제 파일 hash를 만들거나 실제 파서를 실행했다고 표시하지 않습니다. 도구 문자/셀 출력·AI 전사/재구성 예시와 미독 그림, 선택 범위 밖을 구분합니다. 필수 미선택·미독·본문 미확보, 범위 오류·입력 한도 초과·판본/관점/연결 변경은 실행을 차단하고 초안을 보존합니다. 선택 참고의 미독과 미배정 구간은 부분 확인으로 남기며 확인 전 자동 제외하지 않습니다.

처음 읽은 원문과 참고 문서의 원문/추출/검토 기준을 고정합니다. 선택/필수/목적 편집은 실행 확인을 무효화하고, 외부 판본 변경은 이전 입력을 보존한 명시 새 준비를 요구합니다. 새 준비 때 사라진 필수 문서를 조용히 제거하지 않고 확인 불가로 남깁니다. 시안은 처음 읽은 참고 목록 전체의 변경을 보수적으로 감지하므로 미선택 자료 변경에도 재준비가 필요할 수 있습니다. 과거 요청은 당시 선택·인용·예시 결과를 유지하며 현재값으로 갱신하지 않습니다.

이번 분석 시연은 선택 구간의 준비 본문과 인용 대조 보고를 메모리에 만들며 **Wiki·그래프 저장 전**으로 끝납니다. 기존 전체 그래프 일부를 덮거나 검토 승인을 이식하지 않습니다. 이유는 선택한 산출물과 원본 계보를 검토할 수 있게 하면서 미구현 파서/실제 AI·저장 계약을 완료로 오해하지 않게 하기 위해서입니다. [D-043]·[D-044]의 실제 작업/규약·bundle·불변 제출·hash·영수증·서버 검사·의미 검사·영구 출처 저장은 후속 범위이며 이번 UI 모의 보고가 이를 대신하지 않습니다. 실행 검증과 남은 항목은 [PLAN](PLAN.md#d-039-분석-범위산출물원본-근거-추적-시안-2026-10-25)을 따릅니다.

#### 지도 구성 추가 조사 (2026-10-24)

다음은 재구성 전에 수행한 비교 조사 기록입니다. 관찰한 제품 기능과 당시의 설계 후보를 구분하며, 현재 시안의 적용 범위는 아래 구성 기록을 따릅니다.

- 개념 모델과 실제 지식 연결: [WebVOWL의 설계 논문](https://journals.sagepub.com/doi/10.3233/SW-150200)은 주로 클래스·속성·자료형의 구조를 시각화하고 개별 개체의 상세는 별도 영역에 두는 이유를 설명합니다. [공식 저장소가 안내한 데모](https://service.tib.eu/webvowl/)의 FOAF 전체 지도·개념 선택 상세를 실제로 열었습니다. ‘Person’ 선택에서 동치·서로소·설명·정의 출처가 오른쪽에 나타납니다. 이 데모의 표시는 1.1.7이며 최신 버전 일반 동작이나 대규모 가독성까지 검증한 것은 아닙니다. [Microsoft Fabric의 온톨로지 탐색](https://learn.microsoft.com/en-us/fabric/iq/ontology/tutorial-3-preview-ontology)은 전체 모델·상속·관계 보기와 개체 목록·실제 그래프 탐색을 구분합니다. 기능은 preview이며 제품 내 실행 대신 공식 문서/학습 화면을 확인했습니다.
- 지도 안의 그룹: [Linkurious 노드 그룹](https://doc.linkurious.com/user-manual/latest/nodegrouping/)은 속성 기반 그룹을 지도 안에 유지하며 접힌 대표 노드·개수에서 다시 펼칩니다. [관계 그룹](https://doc.linkurious.com/user-manual/latest/edgegrouping/)은 같은 끝점·방향·유형의 병렬 관계를 묶고 개수를 표시합니다. 서로 다른 출발 개념을 합쳐 같은 관계로 만드는 기능으로 해석하지 않습니다. [선택 확장](https://doc.linkurious.com/user-manual/latest/expand/)과 [증분 배치·고정](https://doc.linkurious.com/user-manual/latest/layout/)도 확인했습니다. 유형별 건수 카드나 서로 떨어진 관계 카드만으로는 노드 간 공간 구조와 연결 경로를 대신하지 못한다는 것이 이번 시안에 대한 설계 판단입니다.
- 전체 맥락의 범위: [Neo4j Aura/Bloom](https://neo4j.com/docs/aura/explore/explore-visual-tour/scene-interactions/)은 관계 유형·방향별 확장, 노드/관계 그룹, 미니맵과 필터 후 흐리게 남기기를 제공합니다. 미니맵의 전체는 데이터베이스 전체가 아니라 현재 Scene입니다. [GraphDB 11.5](https://graphdb.ontotext.com/documentation/11.5/visualize-and-explore.html)는 클래스 계층, 실제 개체 연결을 집계한 클래스 간 연결, 개별 리소스 그래프를 구분합니다. 가지를 접어도 다른 펼친 노드에 연결된 개체는 남깁니다. 클래스 간 연결 집계는 온톨로지 스키마 자체와 다릅니다. 문서에 구버전 안내가 있어 최신 출시 상태로 일반화하지 않습니다.
- 선의 경로와 지도 탐색: [TopBraid EDG Diagram](https://docs.topquadrant.com/latest/user_guide/working_with_asset_collections/index.html#edg-diagram-hierarchic-routing-vs-straight-line-routing)은 계층 경로가 선과 공통 포트를 묶는 반면 직선 경로는 그러지 않는다고 명시하며 선택 선만 재배치할 수 있습니다. Focus Node는 관련 없는 요소를 숨기고 Zoom To Node는 선택 위치로 이동하므로 서로 다른 동작입니다. [Protégé OntoGraf](https://protegewiki.stanford.edu/wiki/Pr4_UG_rt_OntoGraf)는 클래스 트리와 그래프를 함께 두고 관계/노드 종류·배치를 조절합니다. 모든 도구가 ‘전체 개체·관계·조건’을 한 화면에 동시에 읽게 하는 것은 아닙니다.
- 출처·검토 구분: Protégé의 Asserted/Inferred는 명시 공리와 추론 결과를 구분하며 AI 추출/전문가 승인과 같지 않습니다. TopBraid의 [변경 이력](https://docs.topquadrant.com/latest/reference/ChangeHistoryPanel.html)과 [검토 workflow](https://docs.topquadrant.com/latest/user_guide/workflows/index.html)는 작성자·변경 전후·절차 상태를 다루지만 원문 인용과 다른 정보입니다. 확인한 지도에서 AI/전문가 배지나 문서 인용을 보지 못했다는 관찰을 해당 제품 전체의 기능 부재로 확대하지 않습니다. OntoGraf의 공식 화면은 오래된 문서의 예시이므로 최신 UX라는 근거로 사용하지 않습니다.
- 다음 설계에서 검토할 후보: 연결된 하나의 지도, 접어도 외부 연결이 남는 대표 그룹, 위치를 유지하는 부분 확장, 전체 범위가 명시된 개요, 선택 관계의 원문·조건·AI/전문가 이력을 함께 보는 방식입니다. 고정 여섯 유형·대표 그룹 기준·선 경로·패널 크기는 아직 확정하지 않았습니다. 다른 도구의 노드 크기나 선 굵기를 AI 신뢰도 또는 전문가 승인으로 옮기지 않습니다. 기존 시안은 이번 조사에서 변경하지 않습니다.

#### 재구성한 지도 시안의 구성과 경계

- 구성 이유: 사용자가 지적한 제품의 중심을 실제 동선에 드러내기 위해 문서 → 개념·조건·관계·속성 → 근거 확인 → 사람의 수정 → 다음 질문의 재사용을 연결합니다. AI 답변에는 사용한 지식과 각 주장의 현재 상태를 표시합니다. 자연어 개념 설명과 관계 맵은 같은 지식의 두 표현이며 별도 정답으로 편집하지 않습니다.
- 공식 도구 조사와 선택: 첫 조사에서는 [Protégé 계층 탐색](https://protegeproject.github.io/protege/views/class-hierarchy/)·[개별 공리 편집](https://protegeproject.github.io/protege/views/class-description/)과 [VOWL](https://journals.sagepub.com/doi/10.3233/SW-150200)을 참고했습니다. 2026-10-24 재조사에서는 [Neo4j Aura/Bloom의 방향별 배치·장면 탐색](https://neo4j.com/docs/aura/explore/explore-visual-tour/scene-interactions/), [Linkurious의 계층·방사형·증분 배치](https://doc.linkurious.com/user-manual/latest/layout/)·[선택 확장](https://doc.linkurious.com/user-manual/latest/expand/)·[동일 끝점 관계 그룹](https://doc.linkurious.com/user-manual/latest/edgegrouping/), [GraphDB 11.2의 선택 상세와 확장](https://graphdb.ontotext.com/documentation/11.2/visualize-and-explore.html)을 공식 문서 본문에서 확인했습니다. GraphDB 문서는 구버전 표시가 있습니다. 작은 개념 노드·선 위의 짧은 관계명·선택한 관계의 별도 상세를 채택하며 서로 다른 출발 개념을 합쳐 버리지 않습니다. 이는 본 제품의 설계 판단이며 여러 도구의 공통 표준 또는 사용성 입증으로 주장하지 않습니다.
- 기준 화면과 배치: 사용자가 지정한 **1920×1080 데스크톱**을 유지합니다. 공통 내비게이션 148px, 개념 목록 280px, 중앙 지도 1100px, 오른쪽 연결 보기·수정 390px를 배치합니다(외곽 선 2px 제외). 상단 도구 58px 아래 각 패널 높이는 968px이며 개념 목록·수정 내용만 필요한 경우 독립적으로 스크롤합니다. 저장·취소는 수정 패널 하단에 고정합니다. 기본 화면의 중복 개요·미니맵·필터·상태 집계·검토 큐를 덜어냈습니다. 작업 공간·조회 관점은 공통 상단에 두고 좁은 미리보기는 같은 배치를 축소하며 ‘실제 크기’로 전환할 수 있습니다. 모바일·태블릿 재배치는 이번 설계 범위에 넣지 않습니다.
- 전체 맥락과 점진적 펼치기: 중앙은 선택 개념을 한 번만 표시하는 1단계 연결 지도입니다. 접힌 유형의 고유 이웃·개별 주장선·넓은 영역 경계를 숨기고 대표 묶음과 들어옴/나감 요약 연결을 남깁니다. 대표에는 유형·개념/연결 수·방향별 건수와 ‘펼치기’를 표시합니다. 들어옴/나감의 별도 떠 있는 박스를 없애고 대표 카드 안에 넣어 지도에는 요약선만 남깁니다. 이는 표시용 집계이며 서로 다른 끝점을 하나의 실제 주장이나 개체로 병합하지 않습니다. 펼치면 원래 개념과 클릭 가능한 관계 상자가 같은 위치에 복원되며 다른 묶음·남아 있는 개념·화면 이동/배율은 유지합니다. 펼친 다른 유형이 쓰는 공유 개념은 한 번만 남기고 표시 묶음과의 소속 연결을 구분합니다. 기존 여섯 탐색 유형과 새 연결용 ‘그 밖의 관계’는 표시 구조이며 온톨로지 개체·주장이 아닙니다.
- 표시와 조회 범위: 원시 예시는 33개 개체·개념/54개 주장(관계·후보48개, 속성6개)이며 새 연결 초안은 여기에 포함하지 않습니다. 저장한 새 모의 연결만 현재 관점의 별도 주장으로 지도·검색·질문 범위에 추가합니다. 중앙은 선택 개념의 직접 연결이고 ‘전체 구조 보기’는 업무 영역별 실제 연결을 집계한 별도 개요입니다. 속성은 전체 보기의 조건값 경로에서 확인합니다. ‘연결 찾기’는 필요할 때만 열며 현재 개념/전체 범위를 선택합니다. 찾기는 일치 결과와 지도 강조만 바꾸며 현재 직접 연결과 AI 질문 범위를 줄이지 않습니다. 전체에서 찾은 관계를 고르면 새 중심으로 이동합니다. 접기·확대·이동은 주장 ID나 질문 범위를 바꾸지 않으며 펼침/화면 위치·배율은 개념별로 보존합니다.
- 지도 표시와 상세 이력: AI 추출은 파랑 실선, 전문가 관여는 보라 실선, AI 후보는 금색 점선과 공통 범례로 구분합니다. 개별 관계와 접힌 대표의 반복 AI/전문가 문구는 제거합니다. 펼친 관계명은 선택 전에도 회색 바탕·테두리를 두며 관계 이름만 표시하고 상자 전체를 누르면 해당 연결 편집을 바로 엽니다. 클릭 동작과 중복되는 상자 안의 ‘수정’ 표시는 제거합니다. 선택 상세의 문장·조건·원문/전문가 이유가 지도와 같은 주장 ID로 연결됩니다. 전문가 확인/수정/직접 작성의 세부 종류는 지도 구분을 늘리는 기준으로 쓰지 않고 선택한 연결의 출처·‘누가 어떻게 바꿨나요?’에 보존합니다. 찾기 중에는 다른 구조를 흐리게 남기고 접힌 묶음의 일치 건수를 표시하며 요약선도 일치하는 주장을 우선 선택합니다. 접어도 선택한 연결의 상세는 유지합니다.
- 수정과 근거: k02는 AI가 원문의 판매 중지 제외 조건을 누락했다가 전문가가 AI 해석을 정정한 모의 사례이며, 원문 자체 편집과 구분합니다. 오른쪽 패널에 최초 AI 추출·원문 판본·전문가 주체/이벤트·수정 이유·조건 전후를 보여줍니다. k04는 내용 변경 없는 확인입니다. k42는 k02에서 시작한 별도 업무 판단으로 ‘AI 추출 → 전문가 판단’과 Action log를 표시하며 원문 근거 정정과 합치지 않습니다. 원문 수정 뒤 AI 재추출도 전문가 직접 작성으로 표시하지 않습니다. 원문에 명시된 제안(k44)의 채택 미확인과 대응 자체의 근거 미확인 후보를 구분합니다.
- 직접 작성의 설계 경계: k54/E09는 기존 개체를 끝점으로 하는 고정 직접 작성 예시입니다. 새 ‘+ 연결 추가’는 시작 개념 → 연결 내용 → 도착 개념과 작성 이유를 입력하고 ‘연결 만들기’를 누르는 동선입니다. 지도나 왼쪽 개념을 선택해 도착 개념을 넣을 수 있습니다. 필요할 때 조건·범위·시점·지도 묶음을 더 적으며 빈 한정어는 ‘미기재’로 보존합니다. 새 연결은 ui-N/UI-N의 별도 ID·현재 관점·작성 이벤트·이유를 출처로 두고 기존 주장과 합치지 않습니다. AI 추출 이력이나 원문 인용을 만들지 않습니다. 독립적인 직접 생성은 현행 D-031의 기존 주장 정정 API와 다르며 **설계 시안 / 직접 생성 API 미구현**입니다. 모든 전문가 이력은 모의 기록이며 실제 사람의 승인으로 간주하지 않습니다.
- 오류 수정·새 연결 시연: 기존 k02는 이미 정정된 예시이므로, 시안 바깥 미리보기 줄의 ‘오류 수정·새 연결 시연’에서만 고정 이력의 수정 전 AI 조건(온라인 판매, 제외 조건 누락)을 재현합니다. 원시 주장/인용/고정 이력은 바꾸지 않고 시연에서 k02의 기존 정정 이력만 분리해 표시합니다. 일반 ‘연결 수정’→조건·이유 입력→수정안 저장→원문 대조 확인과 ‘연결 추가’→대상·내용·이유/범위 입력→연결 만들기를 실제 화면에서 조작합니다. 시연 종료는 시작 전 선택·미저장 초안·모달의 현재 입력/선택까지 복원합니다. 시연 상태는 실제 원장/전문가 승인으로 저장하지 않으며 원래 화면의 영구 상호작용 상태도 덮지 않습니다.
- 개념 상자의 표시: 현재 개념과 주변 개념 모두 이름만 표시합니다. 반복된 ‘연결 보기’와 연결 대상 선택 안내, 현재 개념 표식·상자 안의 중복 연결 추가 버튼을 제거합니다. 개념 클릭의 중심 이동과 새 연결의 도착 개념 선택은 유지하고 연결 추가는 지도 머리말에서 시작합니다. 동작 설명과 전체 이름은 접근성 이름·tooltip에 보존합니다.
- 긴 텍스트와 원문 읽기: 지도 관계명은 두 줄, 문서 목록/제목과 파일명은 정해진 줄 수 안에서 줄임 표시하고 전체 텍스트를 tooltip·접근성 이름·선택 상세에서 확인합니다. 실제 문자열은 잘라 저장하지 않습니다. 상세와 Markdown의 긴 식별자는 줄바꿈하고 표·코드는 자기 영역에서 읽습니다. 원문 근거는 별도 바깥 콜아웃을 제거해 인용선 하나와 문서명을 함께 읽도록 합니다.
- 문서 탐색과 파일 입력: 문서 목록 316px·가운데 본문 1120px·원본/연결 정보 334px의 1920×1080 배치를 사용합니다. 제목·파일명·본문 검색, 폴더/파일 종류 선택과 문서 행 직접 열기를 제공하며 읽는 화면의 불필요한 ‘문서 열기’ 단계는 제거합니다. 파일 첨부와 직접 본문 입력, 원본·Markdown 내려받기를 조작할 수 있습니다. .md/.txt는 UTF-8 텍스트를 읽고 다른 파일은 원본으로만 첨부하며 PDF/Word/Excel 자동 변환·AI 추출을 실행한 것으로 표시하지 않습니다.
- 원본 교체와 본문 판본: 원본 파일은 판본별로 보관하고 읽고 편집하는 본문은 Markdown으로 별도 관리하는 설계입니다. ‘새 원본 올리기’에서 현재/새 본문을 비교하고 함께 반영 여부를 선택합니다. 원본만 교체하면 본문이 이전 원본 기준임을 표시하며 이전 파일·본문 전체와 그때의 원본 판본 연결을 유지합니다. 본문 초안은 문서별로 분리하고 본문/원본 기준 판본이 달라지면 보존한 채 저장을 막습니다. 원본 첨부·본문 반영·AI 재추출·전문가 판단 재검토는 서로 다른 단계입니다. 기존 그래프 예시 D01–D07과 문서 목록의 고정 네 문서는 별도 사례이므로 제목 유사성으로 연결하지 않습니다.
- 문서 연결 표시의 선택: 사용자가 목록/지도 중 판단을 맡겨 현재 문서를 중심으로 한 작은 연결 지도를 채택했습니다. 본문의 명시 참조는 실선·방향, 본문에 공통 표현이 있는 후보는 점선으로 표시하고 동일 개념으로 확정하지 않습니다. 문서 제목을 누르면 바로 읽으며 ‘문서 연결’ 탭에서는 큰 지도로 표시합니다. 큰 지도를 열 때 오른쪽 작은 지도는 반복하지 않습니다.
- 파일 시안의 경계: 선택한 File은 직렬화 상태와 분리해 현재 페이지에서만 유지합니다. 새로고침·다음 세션의 지속 보관, 실제 위키 파일/히스토리/API 쓰기와 서버의 원자적 버전 보존을 구현한 것으로 보지 않습니다. 파일 읽기 오류·UTF-8/본문 1 MiB 초과·기준 판본 충돌은 원본/본문을 덮어쓰지 않으며 다른 파일을 고르면 이전 자동 읽기 본문을 새 파일 출처로 옮기지 않습니다. 새 등록/AI 결과 문서에는 고정 예시 관계를 대신 표시하지 않습니다.
- 병렬 주장과 범위: 같은 끝점의 원문 규칙·미확정 후보·전문가 판단·새 작성 연결은 독립 주장 ID·조건·출처·상태를 유지합니다. 기본 매진 임박은 모두 펼치면 중심 포함10개 개체·개념/관계12개/속성2개이고, 모두 접으면 중심 개념1개와 대표 묶음3개·방향별 요약선5개가 관계12개와 질문14개를 보존합니다. 분류는 들어옴4/나감1, 규칙은 나감3, 시스템은 들어옴3/나감1입니다. 현재33개 개체의147개 접힘 조합에서 주장 누락/중복·질문 범위 변경·기준 좌표 변경이 없음을 재확인했습니다. 이번 새 연결 브라우저 시험은 기존 예약 판매 개념을 다른 표시 묶음에서도 한 번 유지했습니다. 자기루프는 추가 입력에서 차단하고 대규모 그래프·새 유형 자동 분류·실제 AI 전달은 구현/검증 범위에 넣지 않습니다.

- 필요한 관계 찾기: 개념 목록과 지도를 기본으로 두고 ‘연결 찾기’를 누를 때만 검색창·범위 선택·문장형 결과를 엽니다. 결과의 ‘수정’도 바로 편집창으로 연결되며 선택하면 검색창을 닫습니다. ‘AI 연결 검토’는 아직 확인하지 않은 AI 연결을 같은 임시 검색창에 보여줍니다. 이전의 상시 목적/유형/방향 필터와 검토 큐·이전/다음 단계는 기본 동선에서 제거해 무엇을 눌러 작업하는지 드러냅니다.
- 연결 수정 동선: 지도 관계 상자를 누르거나 선택 상세에서 수정을 선택하면 시작 개념·연결 내용·도착 개념·조건/예외·수정 이유가 바로 입력 가능한 같은 패널을 엽니다. 범위·시점은 추가로 펼칩니다. 원시 인용·출처·판본·종류와 나머지 필드는 보존하며 내용만 별도 상태에 반영합니다. 미입력 이유·기존 한정어 삭제·자기 연결·내용 변화 없는 저장을 차단하고 지도 묶음만 바꾸어 의미 검토가 수용되지 않게 합니다. 수정/작성에는 ‘수정안 저장’ 또는 ‘연결 만들기’, 취소, 저장 후 되돌리기를 명시합니다. 되돌림은 새 모의 이벤트로 남기고 내용과 그 내용의 유효한 작성 이유를 함께 복원합니다.
- 검토 경계와 구현 한계: 문서 기반 수정은 원문 의미를 자동 검증한 것으로 수용하지 않고 보류된 수정안으로 반영합니다. 값이 바뀌면 인용을 ‘기존 AI가 사용한 원문’으로 표시하며 근거 재확인을 안내합니다. 별도 ‘맞는 연결’에서 현재 내용·조건·원문과 확인 이유를 명시해야 모의 확인 상태로 바뀝니다. 후보 수정은 후보 종류/기존 상태를 유지하고 이 확인으로 승격할 수 없습니다. 전문가 판단은 작성 이유와 Action log를 사용하며 수정 후에도 문서 추출로 표시하지 않습니다. 다른 관점의 판단은 그 관점으로 명시 전환해야 수정합니다. 초안·수정값·이벤트·새 연결은 현재 화면 메모리에만 두고 원시 주장/고정 이력과 분리합니다. 서버의 의미 검증·원장 저장·실제 전문가 승인·재로드/다음 세션 지속성·권한·원자성·CAS를 이 시안이 구현하거나 검증한 것은 아닙니다.

| 화면 | 중심 작업 | 유스케이스 |
| --- | --- | --- |
| AI 작업 | 질문·업무 설명, 자료·대상·관점 재확인, 답변의 지식 연결·근거 확인, 초안·저장 문서 이동, 최신 판단 재조회 | UC-02·03·05·07·09·18 |
| 지식 탐색 | 원문/전문가 용어 발견·명시 대상 선택, 개념·관계 탐색, 근거 대조·선택 수정·선례 확인 | UC-06·07·08·10·11·16 |
| 위키 문서 | 자료 등록·검색·원문·AI 정리 상태, 관계·속성·후보, 원문 편집·비교·버전 | UC-01·03·04·09·12·15 |
| 검토함 | 연결/속성/관계별 원문 대조, 수용·수정·거절·보류, 별도 전문가 업무 판단, 변경 후 재검토 | UC-11·13·14·15·16 |
| 변경 이력 | 원문·검토·전문가 판단의 전후·이유·범위와 최신 판단 되돌림 | UC-17 |
| 작업 공간 | 소속·행동 권한 확인과 조회 관점 선택 | UC-19 |

- 판단과 활용: 개별 속성·관계·의미 대응 후보의 검토 상태를 분리합니다. 수용은 선택한 주장 한 건에 적용하고 거절·보류를 다른 주장으로 전파하지 않습니다. 예외 조건이 미확인인 개별 상품의 출고 우선을 단정하지 않으며, 조건→개념 분류를 동치·역방향·부정 분류로 확대하지 않습니다. 이름·유형 일치 후보, 의미 대응 제안, 원문 명시 링크도 별도로 표시합니다.
- 맥락과 출처: 조회 관점과 원문 주장의 맥락을 구분합니다. 전문가 판단은 선택한 정확한 범위의 모의 이벤트를 출처로 표시하고 다른 관점에 자동 적용하지 않습니다. 원문·판단 변경 후 과거 답변은 당시 내용·관점·원문 판본을 유지하며 재확인 행동으로 새 예시 답변을 구성합니다. 저장 전 초안과 저장된 문서를 구분하고 닫기 후에도 초안 내용을 유지합니다.
- 상태와 완료: 자료 등록 완료와 AI 정리 전/실행/결과 확인, 원문 저장과 재추출·기존 판단 재검토를 구분합니다. 근거 없는 후보는 수용할 수 없으며 근거 추가나 별도 전문가 판단 설계를 안내합니다. 권한 부족·일부 조회·편집 충돌·저장 결과 미확인 화면도 포함합니다. 미실행된 재추출이나 재검토를 화면 이동만으로 완료 처리하지 않습니다.
- 구현 경계: 원문 저장·검색, 문서별 추출/검토, 기존 주장에 대한 전문가 정정·직접 연결 영향 안내에 더해 [D-038]의 대응 원장·검토/정책·되돌림과 [D-040]의 개념 발견·통합 조회는 서버에 구현되어 있습니다. [D-041]의 로컬 개인 인증 연결은 읽기 13개 도구로 확인했고 [D-042]의 첫 등록·추출용 임시 쓰기는 회수했습니다. 자료 자동 처리·실제 AI/화면 연결, 문서 목록, 결과물 출처 계보, 전역 검토함·이력, 계정 발급/SSO·변경 감지는 추가 구현 대상입니다. UC-02·08은 고정 시뮬레이션이며 실제 경험 문서화·임의 비교를 검증하지 않았습니다. UC-18의 서버/CLI 조회 검증과 이 시안의 모의 새 대화도 구분합니다.
- 시안: [온톨로지 중심 화면 구성](/Users/jong-yu/.codex/visualizations/2026/10/25/01a171cd-06a1-7ad3-83b4-a442528f7f8d/ontology-wiki-workspace.html). 가상 자료·모의 판단·브라우저 내부 상태만 사용하며 실제 AI·MCP·저장·권한을 실행하지 않습니다. 전체 UC-01~19 대응은 시안의 ‘화면 구성 지도’에서 관리하며 기존 35개 화면 시안은 보존합니다. 실제 점검 결과와 미검증 범위는 [PLAN](PLAN.md)에 기록합니다.

#### 현행 정책과 유스케이스 정합성 갱신 (2026-10-24)

기존 UC-01~19의 목적은 현행 정책에 모두 남아 있어 번호와 목적을 유지합니다. 새 정책의 하위 동선을 관련 사례에 추가하고, 정책 근거·완료 기준·예외와 서버 구현/현재 운영 권한/화면 연동의 경계를 각 행에 명시합니다. use-case 본문은 위 시안의 `cases`와 ‘화면 구성 지도’에서 한 번만 관리하며, 아래는 변경 이유입니다. 정책·권한·API를 새로 정의하거나 UX-01~07의 해결을 선언하지 않습니다.

| 대상 | 반영한 변경과 이유 | 근거 |
| --- | --- | --- |
| UC-01·03 | 첫 원본·판본·선택 범위/hash·변환 한계 확인과 등록 후 대조, 부분 추출·중요 누락·품질 판정의 하위 동선을 추가. 등록·형식 통과와 의미 승인을 분리 | [D-036]·[D-042] |
| UC-04·06 | 원문 문자열 검색과 전문가 용어도 찾는 전용 개념 발견을 구분. 버전 있는 대상 명시 선택, 과거/다른 범위의 진단 선택과 변경 시 재선택을 추가. ‘통합 조회 추가’ 표기는 제거 | [D-013]·[D-031]·[D-040] |
| UC-05·07·18 | 원문·최신 판단·대기 이력을 정확한 범위로 재조회. 관점/대상 변경을 재확인하고 다른 맥락의 제약·부분 결과·출처를 유지. 현재 개인 읽기 연결과 모의 화면을 구분 | [D-026]·[D-027]·[D-031]·[D-040]·[D-041] |
| UC-08·10·11 | 방향·조건·범위 비교, 링크/이름 후보/의미 대응을 구분. 새 문서의 선례 활용 하위 동선을 추가하고 승인 복사를 금지. ‘D-038 저장 계약 추가’ 표기는 구현된 전용 경로로 정정 | [D-019]·[D-038]·[D-040] |
| UC-12·13·15 | 원문 CAS·전체 이전판 보존·충돌 재대조, 전체 주장 정정과 누락 보강 재생성/추가 근거 대기를 분기. 최신 전체 원문 재추출과 옛 판단의 재검토를 명시 | [D-006]·[D-009]·[D-028]·[D-031]·[D-042] |
| UC-14·17 | 기존 주장 정책과 문서 간 대응 정책·각 되돌림을 구분. 지도 독립 새 연결 생성과 전체 그래프 undo는 구현된 API로 표시하지 않음 | [D-028]·[D-031]·[D-038] |
| UC-16·19 | 직접 영향과 대응 의존 변경을 구분하고 부분/복원 불가를 명시. 개인 연결 확인·임시 권한 회수의 하위 동선을 추가. 전역 재검토 종료·관리 UI는 후속으로 유지 | [D-026]·[D-032]·[D-038]·[D-041]·[D-042] |
| UC-02·09 및 공통 경계 | 경험 문서화·결과물 작성은 제품 목적상 유지. 대화/초안 보관·결과물 출처 계보·실제 화면 연동은 추가 정의·구현으로 표시 | [D-034]·[D-039] |

삭제한 것은 폐기된 목적이 아니라 **이미 구현된 대응·통합 조회를 미구현으로 표시한 문구**입니다. 범용 자료 변환·등록 맥락 힌트·공통 개념 등록부·의미 검색·자동 승인/전파는 구현된 문자열 발견·대응 저장과 구분합니다. 미검토 원문 주장도 상태와 함께 조회할 수 있으며 새 사전 승인 절차를 추가하지 않습니다. 아래 UX 검수는 갱신 전 화면에서 확인한 기록으로 그대로 보존합니다.


#### 유스케이스·UX 검수 (2026-10-24)

현재 대화 시안의 AI 작업·지도·문서·검토함·이력·작업 공간·구성 지도와 UC-01~19를 대조했습니다. 아래 ‘있음’은 그려진 화면/진입 동선의 존재를 뜻하며 실제 서버 실행이나 유스케이스 전체 통과가 아닙니다. 개념 표시 정리만 이번에 반영했고, 다음 발견은 개선 대상으로 남깁니다.

| UC | 현재 화면/동선 | 보완이 필요한 지점 |
| --- | --- | --- |
| 01 자료 축적 | 등록·파일 첨부·본문 준비 있음 | 추출 작업 상태 및 올바른 검토 대상으로의 이동 |
| 02 경험 문서화 | 입력 진입·초안 편집·저장 있음 | 경험을 모으는 후속 질문/목차는 고정 예시 수준 |
| 03 자료 이해 | 본문·연결된 지식·근거 패널 있음 | 새 자료의 대기 상태에서 고정 예제로 잘못 이동함 |
| 04 문서 찾기 | 검색·폴더·종류·행 직접 열기 있음 | 이번 범위의 신규 막힘은 확인하지 않음 |
| 05 근거 있는 질문 | 예시 답변·사용한 지식·인용 있음 | 문서 질문에 이전 지도 선택 범위가 남음 |
| 06 개념 종합 이해 | 개념 탐색·관계 지도·조건/근거 상세 있음 | 자연어 종합 설명은 고정 개념 예시 수준 |
| 07 관점별 이해 | 공통 관점 전환 있음 | 작성 중 질문의 관점과 상단 관점이 달라질 수 있음 |
| 08 기준 비교 | 현재 화면의 전용 비교 동선 미작성 | 두 기준의 정의·조건·범위·근거를 함께 고정할 영역 필요 |
| 09 결과물 작성 | 초안·저장·문서 재열기 있음 | 작성 당시 원자료 판본/판단 상태를 저장 결과에서 추적할 수 없음 |
| 10 연결 탐색 | 개념/관계 선택·명시 참조/후보 구분 있음 | 이번 범위의 신규 막힘은 확인하지 않음 |
| 11 조건과 개념 연결 | 고정 연결 검토 예시 있음 | 후보에 근거를 추가한 뒤 같은 대상으로 돌아오는 동선 부족 |
| 12 원문 정정 | 편집·비교·판본·원본 교체 있음 | 기준 판본 충돌 후 초안을 보존하며 다시 시작하는 동선 없음 |
| 13 AI 해석 정정 | 지도/검토함의 수정 입력 있음 | 이력 연결 및 검토함의 현재 수정값 재편집 보완 필요 |
| 14 전문가 판단 | 이유·범위·시점을 입력하는 예시 있음 | 다른 화면의 상태와 연결, 시점 재편집 보완 필요 |
| 15 지식 갱신 | 새 원본 미반영·재추출 필요 표시 있음 | 처리 중/실패/재시도와 새 결과 대조 화면 미작성 |
| 16 변경 후 재검토 | 고정 재검토 예시만 있음 | 변경 영향 대상·미처리 목록·처리 완료 조건 미작성 |
| 17 추적·되돌림 | 검토함의 전역 이력 및 지도 내부 이력 있음 | 지도 변경이 전역 이력에 없고 조건/범위 변경 비교가 부족함 |
| 18 다음 작업 재사용 | 새 AI 작업·이전 예시 답변 있음 | 질문 대상/관점의 재확인과 화면 간 현재 판단 연결 필요 |
| 19 작업 범위 확인 | 소속/권한 설명·관점 선택 있음 | 실제 소속·허용 행동 조회는 연결되지 않은 설계 범위 |

우선순위는 시안에서 사용자가 잘못된 대상/현재값으로 작업할 가능성과 작업을 끝낼 수 있는지를 기준으로 잡았습니다.

| 항목 | 우선순위·근거 | 재현과 개선 방향 |
| --- | --- | --- |
| UX-01 새 문서와 다른 검토 대상 혼합 | 우선 1 · 브라우저 재현 · UC-01/03/15 | 회의실 예약 문서 등록 → 연결된 지식 → AI 정리 확인 → 기존 판단과 대조에서 ‘1~5개 → 매진 임박’과 새 문서 제목 줄이 함께 나옴. 같은 문서의 처리 대기/결과/검토로 이어져야 함. |
| UX-02 질문 대상·관점 전환 누락 | 우선 1 · 브라우저 재현 · UC-05/07/18 | 지도에서 질문 초안 생성 → 문서의 ‘이 문서로 질문’에도 선택 지식 14개가 남음. 현업 초안에서 아키텍처로 바꿔도 질문에는 ‘조회 관점: 현업’이 남음. 초안을 보존하되 대상·관점의 재확인/갱신을 명시해야 함. |
| UX-03 지도 변경과 전역 이력 단절 | 우선 1 · 브라우저 재현 · UC-13/17 | 지도에서 조건 수정안을 저장한 뒤 변경 이력은 ‘기록 없음’을 표시함. 지도 내부 모의 이벤트를 같은 작업 공간의 이력에서 추적할 경로가 필요함. |
| UX-04 결과물의 출처 판본 추적 누락 | 우선 1 · 브라우저 재현·저장 필드 확인 · UC-09 | 업무 정의를 2판으로 바꿔도 초안 원자료는 ‘각 1판’이고, 저장 결과는 본문만 남고 원자료/판단 판본 영역이 없음. 작성 당시 문서·인용·관점·판단의 출처를 결과와 함께 열 수 있어야 함. 공통 표현 후보는 작성 근거를 대신하지 않음. |
| UX-05 현재 수정값과 변경 내용의 재확인 부족 | 우선 2 · 코드/메모리 검수 · UC-13/14/17 | 검토함의 재편집은 현재 수정값 대신 고정 초기값을 채우며 업무 판단의 시점도 빈칸으로 시작함. 지도 내부 이력은 조건만 바뀌었을 때 전후의 동일한 양끝점/관계명만 표시함. 현재 유효값으로 시작하고 조건·범위·시점의 차이를 읽게 해야 함. |
| UX-06 편집 충돌 후 복구 동선 없음 | 우선 2 · 코드 검수 · UC-12/15 | 문서 초안을 취소해 보존한 뒤 원본이 교체되면 옛 기준 판본 때문에 저장이 계속 차단됨. 초안을 보존한 최신 본문 대조/합치기 또는 명시적 초안 폐기·새 편집 시작이 필요함. 기준 버전만 바꾸어 충돌을 우회해서는 안 됨. |
| UX-07 질문창에 내부 전달 데이터 노출 | 우선 2 · 브라우저 관찰 · UC-05/18 | ‘이 개념으로 AI 질문’이 주장 ID·출처 ID·이벤트·긴 전달 지침을 질문 입력칸에 채움. 사용자의 질문과 선택한 개념/근거 요약을 구분하고 상세 전달 정보는 필요할 때만 펼쳐 읽게 하는 편이 적절함. |

추가 설계가 필요한 영역은 **두 기준 비교**, **자료 처리 중·실패·재시도**, **변경 영향·재검토 대상/완료 결과**입니다. 각각 기존 화면의 패널/동선으로 해결할 수 있는지 먼저 판단하며 별도 최상위 메뉴를 추가하는 것으로 확정하지 않습니다. 현재 표시된 고정 예시·실제 AI/서버 미연결 자체는 UX 결함으로 집계하지 않았습니다. 문서 목록의 shipping과 지도 D03처럼 별도로 만든 사례를 제목만으로 같은 원문이라고 가정한 관찰도 제외했습니다. 실제 사용자 실험이나 원문 의미 정확도 평가는 수행하지 않았습니다.

#### 문서·관계·근거를 잇는 작업 흐름 (2026-10-24)

사용자가 우선순위 높은 문제의 실제 화면 반영을 요청해 UX-01~07의 대상·판본·관점 연결부터 보완했습니다. 위의 이전 k02 격리 시연/패널 편집 동선은 이번 **문서 → AI 추출 → 전문가 검토 → 변경 이력 → 다음 질문** 흐름으로 대체합니다. 원시 54개 주장·고정 모의 이력과 갱신된 UC-01~19는 유지합니다.

- 같은 작업 대상: 문서 ID·본문/원본 판본·관계 ID·추출 판본·검토 원장 판본·조회 관점을 공통 화면 상태로 연결합니다. 지도 관계명을 누르면 같은 관계의 원문과 현재 수정 칸을 나란히 엽니다. 변경 이력에서 조건·범위·시점과 판단 이유를 비교하고 그 관계로 질문하거나 현재 관계로 돌아갈 수 있습니다. 본문·검토의 오래된 입력은 보관한 뒤 최신 값에서 새로 편집하며 기준 판본만 바꾸어 이전 입력을 저장하지 않습니다.
- 근거와 검토: 고정 출고 문서는 제외 조건을 빠뜨린 AI 추출 **예시**에서 시작합니다. 원문을 대조해 수정안을 저장하면 재확인 상태이고 별도 일치 확인으로 모의 검토를 남깁니다. 후보는 종류를 유지하고 확정할 수 없습니다. 원문 변경·원본만 교체·재추출 뒤의 이전 주장은 오래된 근거로 남으며 이전 승인을 새 주장에 이식하지 않습니다. 기존 한정어 삭제·판본 충돌·다른 관점 판단의 수정을 차단합니다.
- 자료 분리: base4와 지도 D01~D07은 정확한 출처 ID로 분리합니다. 지도의 원문 전문은 없으므로 기존 인용을 모은 문서를 **지도 인용 예시 · 전문 아님**으로 표시하고 그 행 위치를 실제 전문의 줄 번호라고 하지 않습니다. 임의 등록 문서에는 다른 자료의 AI 결과를 표시하지 않습니다. 실제 모델 연결 전인 문서는 정확한 원문 구절을 붙인 직접 입력 초안으로 별도 표시합니다.
- 업무 판단과 새 연결: E08/E09 및 새 연결은 원문 인용 없는 Action log 이유·관점·조건을 사용합니다. 새 모의 연결은 지도·검토·이력·질문에서 같은 ID를 사용하고 독립 새 연결 API가 구현됐다고 표시하지 않습니다. 업무 판단 수정 저장은 명시적 모의 판단으로 유지하며 추출 승인과 구분합니다. 문서 검토에서 추가한 연결만 그 문서에 명시적으로 연결하고, 지도에서 추가한 연결에 마지막 방문 문서를 암묵적으로 붙이지 않습니다.
- 다음 질문과 결과 보관: 문서에서 질문하면 이전 지도 선택을 해제하고 문서 범위를 새로 만듭니다. 사용자 질문과 문서/관계 선택 요약을 분리하며 원시 ID·전달 지침을 입력칸에 넣지 않습니다. 관점 전환 후 다음 질문은 새 관점의 현재 판단을 사용하고 이전 답변은 당시 관점을 유지합니다. 답변 예시는 확인 전·보류·후보·거절·다른 관점·오래된 관계를 확정 사실로 적용하지 않습니다. 미검토 원문은 상태와 함께 조회할 수 있으며 서버에 새로운 사전 승인 정책을 추가하지 않습니다.
- 출처 계보: 질문 시점의 전체 선택 원문·본문/원본 판본·유효 관계/한정어·검토 상태·이벤트 참조·판단 이유를 불변 스냅샷으로 보관합니다. 결과 문서에는 같은 출처 계보와 인용을 함께 저장하고 Markdown에도 당시 판본·인용·판단 이유를 포함합니다. 이후 원문을 바꾸면 현재 판본과 다름을 표시하며 과거 원문을 펼쳐 읽을 수 있습니다.

이는 현재 페이지 메모리의 화면 시안입니다. 실제 AI 추출/응답·서버 저장·권한·영구 원장·재접속 지속성·의미 정확도 검증을 구현한 것이 아닙니다. 실제 운영 정책과 5단계 제품 UI의 상태는 바꾸지 않습니다. 두 기준의 전용 비교, 실제 자료 처리 중/실패/재시도, 변경 영향 대상·재검토 종료, 경험 문서화 및 UC-01~19의 전체 서버 연결은 후속 범위입니다. 실제 검증 결과는 [PLAN](PLAN.md)의 같은 날짜 기록을 따릅니다.

#### 원문 변경의 영향·추출 비교·선택 재검토 흐름 (2026-10-24)

사용자가 원문 변경 뒤 필요한 관계만 재검토하는 동선과 처리 실패·재시도·완료 상태를 요청했습니다. 기존 문서 흐름 안에 **영향 확인 → 추출·비교 → 선택 재검토 → 완료**를 추가하며 1920×1080 기준을 유지합니다. 별도 최상위 메뉴는 추가하지 않습니다. 위 절에서 후속 범위로 남긴 처리·영향·재검토 동선 중 이번에 구현한 것은 현재 페이지 메모리의 시안입니다.

- 변경 기준과 보존: 본문 저장·원본 파일 교체 직전에 기존 원문/원본 판본·전체 추출·관점별 유효 판단을 포착합니다. 변경 후 원문과 비교 작업의 기준을 고정하고 과거 원문·관계·전문가 이력·답변을 보존합니다. 파일과 본문이 함께 바뀌어도 교체 전 기준을 사용하며, 원본만 교체한 경우에는 본문 정합성 확인 상태를 유지합니다. 이 시안의 메모리 내 과거 전체 그래프 보관은 실제 서버가 과거 전체 그래프 저장 API를 제공한다는 뜻이 아닙니다.
- 영향 확인: 이전 근거를 참조하는 관계와 변경 전후 원문을 나란히 보여줍니다. 관련 문서는 본문 명시 참조와 공통 표현 후보를 구분하고 각 문서의 현재 상태를 유지합니다. 이전 판본을 참조한다는 사실만으로 관계의 의미 변경이나 다른 문서의 stale를 판정하지 않습니다. 시안은 현재 페이지의 직접 연결만 사용하며 실제 [D-032]의 전체 영향 조회·복원·제한·대응 의존 조회와 연결하지 않았습니다. 모의 영향 확인 실패/일부 확인은 원문 저장 성공과 구분합니다.
- 저장 전 비교: 현재 원문에서 준비한 전체 새 추출 초안을 먼저 비교합니다. 이전 원시 AI 추출과 전문가가 반영한 당시 유효값을 분리하고, 내용 변경·표현상 차이 없음·새로 발견·새 추출에서 미발견으로 표시합니다. 대응은 예시의 명시된 짝 또는 사용자가 직접 지정한 짝만 사용합니다. 같은 이름의 자동 병합·ID 유지·옛 승인 이식은 하지 않으며 미발견을 사실의 삭제/부정으로 확정하지 않습니다. 임의 문서는 실제 모델 연결 전이므로 현재 원문의 정확한 연속 인용을 붙인 직접 입력 초안으로 비교합니다.
- 전체 추출과 검토 선택: 새 추출은 문서의 전체 초안을 한 번 저장하고, 체크한 관계만 새 ID의 재검토 목록에 올립니다. 선택하지 않은 관계를 추출에서 삭제하거나 승인하지 않습니다. 0건 선택으로 전체 초안을 저장할 수도 있지만 검토 완료가 되지는 않습니다. 저장 후 다른 관계를 추가 선택할 때는 같은 추출에서 목록만 바꾸며 재추출을 반복하지 않습니다. 1:N 분리/통합은 자동 대응하지 않고 비교 짝의 중복을 차단합니다.
- 검토와 완료: 새 원문 전체와 선택 관계의 편집 칸을 나란히 보여주고 조건·범위·시점·이유를 이어서 수정합니다. 수정안·보류·후보·미검토는 완료로 세지 않으며 현재 원문으로 확인 또는 적용 제외한 선택 범위만 완료합니다. 완료 화면에 미선택·미발견·영향 확인 제한을 남기고, 같은 관계·현재 원문·판단을 다음 질문과 결과의 출처 스냅샷으로 연결합니다. 선택 범위를 늘리거나 완료 뒤 판단을 되돌리면 완료 상태를 다시 확인합니다.
- 실패와 재시도: 추출 준비 실패와 확인된 저장 전 실패는 실패한 단계에서 이어갑니다. 저장 결과 미확인은 실패와 구분하고 먼저 현재 저장 상태를 확인하며, 성공한 추출을 다시 보내지 않습니다. 처리 도중/재시도/검토 저장 전에 원문·원본·그래프·검토 원장의 기준을 대조합니다. 기준이 달라졌거나 다른 관점의 작업이면 기존 비교와 입력은 남기고 저장을 차단하며 새 비교 또는 원래 관점으로 안내합니다. 기준 버전만 최신으로 바꾸는 우회는 제공하지 않습니다.

시연은 별도 출고 문서의 이전 관계 6건과 새 관계 6건을 사용합니다. 명시 대응 비교는 변경 3·차이 없음 2·새 관계 1·미발견 1의 7행이며, 과거 확인 2건도 **모의 이력**입니다. 실제 AI/서버 저장·영구 원장·실제 응답 유실·의미 정확도·사람의 승인을 검증하지 않았습니다. 실제 위키·원장·운영 인증/연결·D-042 자료와 4단계 보완/5단계 제품 UI 상태는 바꾸지 않습니다. 검증 결과는 [PLAN](PLAN.md)의 같은 날짜 기록을 따릅니다.

#### 미발견 관계의 근거 대조와 유지·제외·재추출 (2026-10-24)

사용자가 새 추출의 미발견이 원문 변경인지 AI 누락인지 대조하고 결정하는 동선을 요청했습니다. 비교 목록의 미발견 행에서 **이전 관계·실제 인용·당시 전문가 판단 ↔ 현재 원문 전체 → 유지/이번 판본 제외/재추출**를 이어갑니다. 문구의 일치/불일치는 탐색 보조이며 의미 판정이나 원인 확정이 아닙니다. 1920×1080의 기존 문서 흐름을 사용합니다.

- 근거 대조: 이전 AI 원시 주장과 당시 전문가의 유효값·이유·이벤트를 분리해 보존합니다. 현재 원문은 전체를 읽고 검색하거나 문장을 눌러 새 인용으로 선택합니다. 같은 문구가 사라져도 같은 의미가 남을 수 있으며, 같은 문구가 남아도 조건·예외가 달라질 수 있으므로 자동으로 삭제/누락을 확정하지 않습니다.
- 새 근거로 유지: 현재 원문에 있는 연속 구절과 이유, 관계의 양 끝·내용·조건·범위·시점을 명시한 **입력 복구 초안**을 만듭니다. 전체 새 추출 초안에 추가한 뒤 비교·저장하고 별도로 원문 일치 확인을 해야 유지 확인이 끝납니다. 원시 AI 추출을 소급 수정하거나 옛 ID·승인을 이식하지 않습니다. 후보는 복구해도 후보로 남습니다. 저장 전 복구는 미저장 전체 초안을 이어가고 저장 후 복구는 현재 전체 원시 추출을 기준으로 새 비교를 시작합니다. 일부만 새 전체 그래프로 저장하지 않습니다.
- 이번 판본에서 제외: 현재 원문 전체를 대조했다는 확인과 이유를 요구합니다. 철회/변경 구절이 있으면 실제 구절을 붙이고, 현재 지지 구절이 없으면 빈 상태를 그대로 남깁니다. 이는 **이번 원문 판본의 추출에 복구하지 않음**이라는 모의 결정이며 원문 사실의 삭제·논리적 부정·과거 검토 거절이 아닙니다. 이전 관계·인용·전문가 판단은 바꾸지 않습니다. 이미 복구한 새 관계를 제외하려면 해당 관계의 적용 제외 절차를 사용합니다.
- 재추출로 확인: 요청만으로 미발견을 해소하지 않습니다. 문서 전체의 새 초안을 비교하고 명시 대응으로 찾은 결과를 새 관계로 검토합니다. 이름/유사 문장으로 ID를 병합하거나 자동 연결하지 않습니다. 과거 주장이 후속 기준 그래프에 없으면 사용자가 새 결과의 대응 관계를 직접 지정할 수 있으며, 이 연결은 대조 이력의 연결이지 개체 병합이나 승인 승계가 아닙니다. 일반 자료의 실제 모델 연결은 없으므로 전체 입력 초안으로 이어갑니다.
- 기준·이력·실패: 결정은 문서·이전 주장·이전/현재 원문 스냅샷·추출/검토 판본·관점과 연결됩니다. 초안 행의 삭제/이동/재작성 뒤에는 명시 대응과 전체 초안 기준을 다시 확인합니다. 오래된 배열 위치로 다른 관계를 유지 완료로 만들지 않으며, 명시 짝이 없어진 결과나 변경된 수동 대응은 재지정 대상으로 남깁니다. 같은 작업의 새 초안도 기존 제외 판단을 재확인하고 입력 충돌은 보관 후 최신 대조로 안내합니다. 재추출 실패·저장 결과 미확인은 기존 결정과 초안을 보존하고 해당 단계에서 재시도/상태 확인을 수행합니다.
- 결과의 범위: 미발견 대조의 유지 확인/이번 판본 제외와 복구 초안/확인 전/재추출 대기/재미발견/기준 변경을 구분합니다. 선택한 새 관계의 검토 완료, 미발견 대조의 결정 건수, 미선택 관계를 별도로 표시합니다. 새 추출이 기존 결정에 영향을 주면 다시 확인하며, 변경 이력과 다음 질문은 현재 새 관계·근거를 이어갑니다. 과거 질문/결과의 출처는 바꾸지 않습니다.

별도 반품·교환 시연은 표현이 바뀐 근거·원문에서 명시적으로 제외한 업무·그대로 남았지만 빠뜨린 근거를 포함합니다. 모의 이력과 추출 예시이며 실제 사람 승인·AI 누락 원인 진단·의미 정확도 검증이 아닙니다. 이 대조 원장은 현재 페이지 메모리에만 있으며 독립 미발견 복구/제외 API·실제 저장 원장을 추가하지 않았습니다. 운영 서버·위키·검토/대응 원장·인증/연결과 D-042 자료, 5단계 제품 UI 상태는 유지합니다. 실제 검증은 [PLAN](PLAN.md)의 같은 날짜 기록을 따릅니다.

## 미결정 사항

아래는 현재 계약을 다시 정하는 목록이 아니라, 아직 확정하거나 구현하지 않은 범위의 안내입니다. 세부 내용은 담당 결정 한 곳에서 관리하고, 실행 순서는 [PLAN](PLAN.md)을 따릅니다.

| 남은 범위 | 담당 결정 |
| --- | --- |
| 서버 노트북 WSL2의 실제 설치/배포·고정 HTTPS 주소/경로·백업/복구, 운영 사용자/워크스페이스 배정, 외부 인증 제공자·자체 계정 또는 SSO·발급/회수·설치 패키지; 다른 PC의 최초 연결·진단·대상 일치 확인 | [D-016]·[D-017]·[D-026]·[D-030]·[D-047]·[D-048] |
| 기본 기술 외 추가 UI 라이브러리의 최종 채택, 대화·문서·그래프·검토 화면의 실제 연결, AI 실행 연결/Custom CLI·문서 목록/히스토리 조회·전역 검토함, 변경 감지 전송과 재연결 | [D-030]·[D-033] |
| 원본 보관/판본/다운로드·요청 확인 및 source_write parser는 구현. 남은 분석 작업/추출물·CLI 인계·결과 UI·실제 source_write 부여·pending 카탈로그 운영 조정/복구·배포 | [D-043] |
| 공통 의미 지침의 원본 분리·불변 릴리스 발행, 단계별 규약/맥락 MCP 제공·작업 입력/저장 영수증 연결·CLI 어댑터·실제 품질 검증; 계약은 설계 완료 | [D-044] |
| 일반 자료의 자동 정리·처리 상태 화면, 답변에 상태를 드러내는 기본 행동, AI 결과 출처 계보, 재검토 종료; 전문가 용어의 서버 발견은 D-040에서 구현 | [D-034]·[D-040] |
| 등록 힌트와 관리되는 맥락의 입력·버전, BC 간 대응 탐색의 입력 계약 | [D-035] |
| D-038/D-040의 업무 쓰기·원격 연결(로컬 개인 인증 읽기 연결 완료), 공통 개념 등록·별도 의미 평가·실제 전문가 과제 | [D-037]·[D-038]·[D-040]·[D-041] |
| 첫 등록·AI 분리 평가 이후의 실제 전문가 검토와 운영 정정; 원본/본문 준비·첫 등록·임시 쓰기 회수는 완료 기록으로 구분 | [D-042] |
| 질문에 필요한 문서 선택 자동화, 부분 추출의 안전한 병합, 대규모 검토 원장 보관·페이지 조회 등 운영 확장 | [D-025]·[D-027]·[D-028] |

자동 재추출·후보 자동 승인/병합·완전한 논리 추론·위키 전체의 재귀적 의미 영향 계산은 현행 범위 밖입니다. 미결정 목록에 있다는 이유로 이들을 다음 단계의 필수 구현으로 추가하지 않습니다.

[D-003]: #d-003--단계별-확장
[D-004]: #d-004--문서-책임-분리와-최소-구성
[D-046]: #d-046--업무별-백엔드-모듈과-fastapimcp-분리-및-스펙-주도-개발-2026-10-25
[D-006]: #d-006--완성된-히스토리를-먼저-저장-2026-10-21-1단계
[D-009]: #d-009--필수-기준-버전-검사로-오래된-내용-덮어쓰기-방지-2026-10-21-1단계-보완
[D-010]: #d-010--저장-결과와-임시-파일-정리-실패-분리-2026-10-21-r-001-보완
[D-011]: #d-011--문서당-utf-8-1-mib-상한-2026-10-21-r-002-보완
[D-013]: #d-013--최신-파일의-제한된-문자열-검색-2026-10-21-2단계
[D-014]: #d-014--잠금-획득-대기-제한-2026-10-21-r-003-보완
[D-016]: #d-016--맥북의-로컬-stdio-서버와-프로젝트-codex-cli-연결-2026-10-21-3단계
[D-017]: #d-017--windows-원격-poc와-임시-https-터널-2026-10-21-3단계-보완
[D-019]: #d-019--문서-간-명시-링크와-공통-개념-후보-2026-10-22-4단계-보완
[D-021]: #d-021--원본-보유-세션과-관계-생성-세션의-분리-검증-2026-10-22-4단계-보완
[D-022]: #d-022--조건을-보존하는-온톨로지-v2와-사용자-검토-후보-2026-10-22-4단계-보완
[D-023]: #d-023--업무-관점과-수식된-개념의-검증-범위-2026-10-22-4단계-보완
[D-024]: #d-024--관점식별-범위속성-주장출처를-보존하는-v3-2026-10-22-4단계-보완
[D-025]: #d-025--자연어-의미-설명사용자별-관점사람의-수정-이력-2026-10-22-4단계-후속-설계
[D-026]: #d-026--사용자-권한과-관점-프로필을-분리한-tenant-모드-2026-10-22-4-a
[D-027]: #d-027--선택-문서의-자연어전체-그래프를-보존하는-조회-맥락-2026-10-22-4-b
[D-028]: #d-028--원문추출과-분리한-검토-원장과-상태-충돌-검사-2026-10-22-4-c
[D-029]: #d-029--질문을-고정한-자연어그래프결합-비교-2026-10-22-4-d
[D-030]: #d-030--전문가의-업무-판단과-action-log계정연결-방향-2026-10-22
[D-031]: #d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1
[D-032]: #d-032--변경-문서의-직접-연결과-재검토-후보-안내-2026-10-23-선행-2
[D-033]: #d-033--정책을-추적한-ui-시안과-구현-경계-2026-10-23
[D-034]: #d-034--지식을-축적활용갱신하는-제품-목적-2026-10-23
[D-035]: #d-035--문서-등록의-맥락-힌트와-bounded-context-간-대응-검토-2026-10-23
[D-036]: #d-036--추출-신뢰성반복-일관성과-전문가-조정의-판정-기준-2026-10-23
[D-037]: #d-037--문서에서-발견한-개념상태-조건의-연결과-통합-조회-방향-2026-10-23

[D-038]: #d-038--문서-간-조건개념-대응-판단의-최소-계약-2026-10-23
[D-039]: #d-039--유스케이스에-따른-ai-온톨로지-중심-화면-구성-2026-10-23
[D-040]: #d-040--개념-중심-최신-지식-통합-조회-2026-10-23
[D-041]: #d-041--개인-인증-tenant-연결-전환과-보존복구-절차-2026-10-23
[D-042]: #d-042--첫-업무-자료의-선정등록-범위와-최소-쓰기-권한-2026-10-24
[D-043]: #d-043--원격-문서-등록과-개인-cli-분석mcp-저장ui-결과-연결-2026-10-24
[D-044]: #d-044--mcp-공통-추출-규약맥락과-분석-입력-버전-관리-2026-10-24
[D-045]: #d-045--electron-앱의-디자인-토큰과-react-컴포넌트-경계-2026-10-24
[D-047]: #d-047--원격-pc의-최초-연결과-설정-수명주기-2026-10-25
[D-048]: #d-048--서버-노트북의-wsl2와-electron-중앙-저장-2026-10-25
