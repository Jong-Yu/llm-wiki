# 구현·검증 기록

## 2026-11-06 — 검토 원장의 동일 값 검증 재사용

- `ledger._ledger`의 non-policy branch에서 target 전체 값·claim ID 대조가 성공한 뒤 이벤트별 canonical bytes 집합을 만듭니다. 각 before/after의 구조·decision 검사는 항상 먼저 하고 같은 document/collection/entities/source_revision에서 이미 성공한 완전히 같은 값만 재사용합니다. 새로운 값은 검증 성공 후에만 추가하며 최대3개이고 다음 이벤트/다음 read에는 새로 시작합니다. 정책 branch·hash/chain·전후 상태·action/undo·cleanup/독립 관계 검증과 publication은 바꾸지 않았습니다.
- 새7개에서 동일 accept값1회·매read 재검사, edit/연쇄 context5회, candidate promotion의 다른 after값2회, Python ==으로 같은 true/1/1.0의 정확한 구분·거절, 잘못된 value/decision/hash/chain, policy state2회 유지와 실패 미저장을 확인했습니다. 최초 promotion fixture는 인용이 없어 기존 근거 검증에서 거절됐고 실제 본문 인용을 제공해 확인했습니다. 관련49개·전체65모듈653개·독립 storage/MCP 검토가 통과했습니다.
- 정확한 수정 전 함수와 비교한6문서×40entity×39relation×8review·각5회 median은 review9.089→9.029ms, history73.674→72.554ms, impact55.633→50.461ms입니다. canonical DTO와 원본 bytes가 같았습니다. 실제 profile의 saved-value 검사3441→1109회·검사 누적316.320→111.600ms는 시점별 확보 문서 수가21→22로 달라 고정 자료의 속도비와 구분합니다. [실제 결과](../platform/HISTORY.md#2026-11-06--검토-원장의-동일-값-검증-재사용)를 따릅니다.

## 2026-11-06 — 2초 목표의 영향 조회 조립·메타정보 해석 재사용

- `state._source_layer_matches`는 domain/viewpoint가모두None이고 모든 일반 정책·undo/과거 정책 및 kind=policy의 독립 관계 이력이 없을 때만 source/current 그래프가 같다고 판단합니다. public query와 같은 잠금의 captured query는 해당 경우 두번째 전체 render를 반복하지 않되 두 effective validation을 모두 수행합니다. 반환되는 source/current 별도 결과를 새로 공유하는 API는 없으며 검증기는 입력을 바꾸지 않습니다.
- `_apply_policies`의 기존 event/현재 target 검사 뒤 latest가 비었을 때는 검증된 기존 source effective/selection/needs_review를 유지하고 policies=[]로 반환합니다. source review·cleanup·source-authored 관계와 현재 source/graph/원장·관점/권한 검사는 유지됩니다. 정책 이력/다른 관점/legacy 및 unavailable 상태는 보수적으로 기존 경로를 사용합니다. 임의로 위조한 private snapshot/상태 있는 validator monkeypatch의 호출수까지 같은 계약으로 확장하지 않습니다.
- 새7개는 실제 accept/edit/defer/reject·Clean Up/undo·source-authored 최신화·정책/undo/과거/다른 scope·독립 정책·legacy1/2/6·첫/두번째 effective 실패를 public/captured 경로에서 전체 DTO bytes/원본 보존으로 대조했습니다. 초기 관련46개 중2개는 제거한 중복 snapshot/normalize 호출수에 대한 예전 기대였고 필수 검증이 실제1회 남음을 확인해 갱신했습니다. 최종 관련53개·전체646개·독립 검토가 통과했습니다.
- 요청 안 메타정보 해석 재사용과 함께, 동일6문서×40entity×39relation 각5회 median은 review9.743→6.626ms, history75.563→56.672ms, impact59.723→39.179ms였습니다. 정확한 수정 전 함수로 canonical DTO·원본 동일을 확인했습니다. [운영 2초 목표 측정](../platform/HISTORY.md#2026-11-06--2초-목표의-영향-조회-조립메타정보-해석-재사용)과 구분합니다.

## 2026-11-06 — 검토 응답의 복사 비용 감축

- `values._copy_value`에서 plain dict/list만 재귀 복사하고 문자열 키·불변 JSON scalar의 불필요한 처리를 생략합니다. 호출별 memo로 내부 공유/cycle을 유지하고 다른 타입은 표준 deepcopy로 돌립니다. render와 cleanup 투영의 복사 호출만 교체했으며 공개 DTO, codec/hash, 판단/원장 검증과 쓰기·CAS 계약은 변경하지 않았습니다.
- 새6개는 canonical bytes·스칼라/중첩·공유/cycle·subclass/비JSON fallback, 검토/정책/Clean Up/undo, stale/missing/corrupt, 그래프/주장/현재 주장/이력/다음 요청의 독립성, 집계/영향과 effective 두 번·오류를 대조합니다. 기존 render5·impact12를 포함한23개, 보존/journal 관련83개와 공통621개가 통과했습니다. 독립 검토는 복사 이름 정규화 뒤 기존 업무 함수19개 AST 동일과 추가 메모리 재현을 확인했습니다.
- 동일 격리6문서×40entity×39relation의 각5회 중앙값은 review12.379→9.875ms, history90.727→81.731ms, impact75.606→60.551ms입니다. DTO canonical bytes와 원본 파일을 보존했습니다. 실제 운영의 더 작은/변동 있는 효과는 [platform 기록](../platform/HISTORY.md#2026-11-06--검토-응답의-복사-비용-감축)을 따릅니다.

## 2026-11-06 — 같은 영향 관측의 검토 검증 재사용

- 영향 조회에서 처음 검증한 전체 ledger를 root/document/원문 전체 내용과 revision/raw graph/raw ledger/history 기준에 묶어 재사용합니다. 렌더별 새 dict를 복원하므로 source/policy on/off/captured graph 간 변경을 공유하지 않습니다. 기계 그래프 재사용도 성공한 정확한 관측에만 한정하고 실패·형식/무결성 불일치는 원래 원장/그래프 검증을 실행합니다.
- 현재 정책과 active event, 독립 관계의 현재 대상·다른 문서, 정책 전후 effective validation 두 번은 생략하지 않았습니다. 원장 hash chain·세대·근거·사람 판단/AI 출처·CAS·원문/전체 이력의 저장 계약은 변경하지 않았습니다. 공개 ReviewStore.query 및 쓰기의 검증 범위는 유지합니다.
- 기존 지식/관계/render 회귀40개와 새 영향12개, 공통587개가 통과했습니다. baseline 복원·v1/v6·stale/missing/corrupt·한도·관측 변조·alias·정책/다른 문서 freshness·오류 우선순위와 원본 보존을 검사했고 독립 검토에 차단 사항은 없었습니다. 같은20문서의 원장 검증40→20회, machine snapshot61→21회이며 정책 render/effective 검사40회는 유지합니다. [실제 운영 결과와 남은 비용](../platform/HISTORY.md#2026-11-06--통합-이력과-변경-영향의-반복-검증-감축)을 따릅니다.

## 2026-11-06 — render 내 개체 정규화 재사용

- 현재 기계 그래프의 개체 정의를 주장마다 다시 정규화하던 부분을 첫 주장과 같은 시점에 한 번 계산해 같은 render 안에서만 공유합니다. 기존 `_claim_id` 호출은 유지하며 map을 변경하거나 다음 render와 공유하지 않습니다. 원문·원장·세대·정책·현재 유효값의 검증과 canonical claim ID/hash를 유지합니다.
- 새5개와 지식113개가 통과했습니다. 수정 전 원문 함수로 비교한 unreviewed/accepted/policy/stale×정책 on/off의8 DTO·bytes/hash가 같았고 복합 손상2종의 오류 타입/메시지도 같았습니다. 독립 메모리 재현은 provenance/mapping/source anchor를 포함한64 claim의 해시와 입력 불변성을 확인했습니다. 최종 core581개도 통과했습니다.
- 격리6문서×60entity×120claim×3review의3회 중앙값은 queue320.484→209.850ms, comparison300.611→175.699ms, `_identity`87,894→2,214회였습니다. 실제 계정의 최종 검토함841.419→777.883ms·대조 상세571.594→483.156ms와 구분합니다. 큰 범위 영향 조회의 시간 이득은 확인하지 못했습니다. [운영/측정 범위](../platform/HISTORY.md#2026-11-06--실계정-재측정과-조회-반복-계산-개선)를 따릅니다.

## 2026-11-06 — 검토 조회에서 동일한 기계 주장의 중복 검사 감축

- 전체 API 점검에서 개념 검색·변경 영향·지식 대조·검토함·이력의 공통 비용을 확인했습니다. 실자료 개념 검색 프로파일에서 현재 검토 이벤트1780회를 확인하며 같은 기계 주장의 전후 값마다 원문·전체 개체를 다시 검사했습니다.
- `_validate_active_event()`는 현재 검증된 machine에서 실제 대상을 찾고 canonical 바이트까지 같은 값만 재사용합니다. 세대/대상/참조 개체 대조와 편집값의 원문 인용·위치 검사는 유지합니다. 전역 캐시·저장 포맷·정책·의미 ID·온톨로지 검증기/규약 지문은 변경하지 않았습니다.
- 신규 검사는 동일 기계 값의 중복 계산 생략, 잘못된 편집 인용·다른 대상 거부와 파일 보존을 확인합니다. 수정 후 지식108개+저장/HTTP/MCP60개 합168개 통과. 기존 회귀의 stale·재추출 후 과거 판단 보류·정책층·동시 CAS·실패 보존도 유지됐습니다. 초기 신규 시험의 evidence 필드명 오류는 바로잡고 재통과했습니다.
- 최종 실자료 ASGI 측정: 개념 검색7.561→2.746초, 변경 영향7.693→2.403초, 공간 검토함4.329→2.430초, 지식 대조 상세2.775→0.451초. 운영 자료에는 별도 분석이 계속 추가되므로 전후 전체 데이터가 고정됐다고 주장하지 않습니다. 누락/잘림 상태는 그대로 응답에 남기며 정상200을 전체 지식 조회 완료로 해석하지 않습니다. [전체 API 점검](../platform/HISTORY.md#2026-11-06--전체-http-api-경계와-조회-성능-점검)을 따릅니다. 설치 앱·운영 서버/터널은 유지했습니다.

## 2026-11-06 — 검토 HTTP 요청 조립 중복 제거

- review·review_undo·policy·policy_undo의 같은 JSON 수신→인가→업무 mutation 조립4곳을 router의 한 함수로 모았습니다. 공개6경로의 signature/decorator와 명시 profile·권한·before_commit 재인가는 유지했습니다.
- 정상/실패 회귀를 포함한 MCP/관련 HTTP 전체90개가 통과했습니다. 입력 검증의 전후 호환 대조와 복잡도 계수는 [실행 환경 기록](../platform/HISTORY.md#2026-11-06--입력-검증과-요청-조립의-복잡도보일러플레이트-감축)을 따릅니다. 저장·판단·CAS·전체 이력 계약과 운영 자료는 변경하지 않았습니다.

## 2026-10-29 — Queue A 관계 정정·검토 복원·독립 관계 추가

- 현재 `explore-ontology-map`에 관계·속성의 주어/목적어 정정, 원문 근거 검토, 전문가 업무 판단, 감사 기록과 되돌림을 연결했다. 관계 정보/검토 기록 두 탭은 초안을 유지하며, 관계 요약과 조건·근거·판단 섹션을 제공한다. 거절/보류/후보 및 과거·정리된 대상도 문서별로 접근한다. 저장 뒤 해당 문서를 재조회하고 사라진 선택 관계를 오래된 상태로 남기지 않는다. 기존 전체 그래프·레이아웃·이동/확대 컨트롤은 수정하지 않았다.
- 독립 관계는 `core/modules/reviews/relations.py`, `core/api/v1/reviews/relations_router.py`, 앱의 workspace/knowledge 계약과 `WorkspaceApiService.ts`를 통해 실제 저장한다. source/policy 권한·출처를 나누고, 원문/기계 그래프/원래 claims/history를 보존하며 별도 relation_events와 역이벤트·요청 영수증을 남긴다. 동일 잠금·복합 CAS·전체 층 검증·합산 한도를 적용했다. 영향 조회의 prefix/과거 행동 근거에도 새 원장을 반영했다. 결정은 D-078.
- 저장 검증: `.venv/bin/python -m unittest discover -s core/tests/poc_knowledge -q` — **49개 통과**. 신규 관계 8개는 실제 재조회, 동일 요청 재시도/변경 요청 충돌, 원문·기계층·원시 이력 보존, 정책 관점 분리, 무효 인용/개체, 파일 교체 실패·쓰기 직전 권한 거부, 경쟁 한 건 성공, 재생성 보호·pending, 손상/합산 한도, 저장 성공과 정리 경고 분리, Clean Up 공존과 과거 prefix/영향 복원을 포함한다.
- HTTP 검증: `.venv/bin/python -m unittest core.tests.poc_mcp.test_relation_transport core.tests.poc_mcp.test_cleanup_transport -q` — **9개 통과**. 실제 ASGI 왕복·재조회·영수증/역이벤트, 종류별 권한·tenant/profile 거부, 서버 actor·오래된 판본, 공개 직전 권한 재확인과 영수증 소유자를 확인했다. 폴더명은 기존 전송 fixture를 재사용한 것이며 새 MCP 변경 도구 검증을 뜻하지 않는다.
- 앱 검증: Node 24에서 앱 빌드 후 `cd app && node tests/ontology-review/run.mjs` — **12개 시나리오 통과**. 별도 임시 서버·실제 Electron main/preload/renderer/HTTP로 끝점 정정, 정책 저장·되돌림, 원문/전문가 새 관계, 추가 되돌림, 저장 응답 유실 후 영수증 조회(중복 없음), 근거 없는 후보 수용 거부·보류 후 근거 정정 수용, 키보드 탭과 초안 보존, 동시 검토 충돌, 기존 검토 응답 유실 후 명시 재조회, 과거 판단 쓰기 차단, 읽기 전용 로그인에서 이력 조회/변경 차단을 확인했다.
- 정적/화면 검증: main/preload/renderer/tools typecheck, lint, format:check, tokens:check(148 tokens/2 modes), Electron/Vite 빌드 통과. 1280×900 밝음/어두움, 480×740 좁은 창의 실제 캡처를 확인했으며 새 관계 폼/검토 기록은 가로 넘침 없이 내부 스크롤로 읽힌다. 숨겨진 창의 캡처가 이전 프레임을 잡던 검증기를 프레임 갱신 대기 방식으로 수정했다.
- 검증 중 수정: 추가 후 지도 재조회와 다음 검토 시작의 경쟁을 막고 문서별 새로고침을 연결했다. 새 추가의 이력 되돌림이 기존 claim 편집 가능 여부에 막히던 조건을 분리했다. 후보 수용 실패는 원장 변경 없이 거부됨을 확인했다. 충돌 뒤 최신 조회 없이 예전 목록을 다시 선택하던 테스트는 정상 충돌했으며, 명시 새로고침 후 재선택하도록 실제 사용자 동선을 바로잡았다. 테스트의 존재하지 않는 cleanup_history 필드 참조는 실제 보존 원장 비교로 수정했다.
- 제한: 모든 쓰기와 로그인은 실행기가 만든 임시 공간의 합성 자료/모의 판단에 한정했다. 운영 자료·실제 전문가 판단·LLM 추출 의미 평가는 실행하지 않았고 Windows 화면은 확인하지 않았다. 새 개체 생성·독립 추가의 직접 덮어쓰기·새 MCP 변경 도구는 범위 밖이다. 추가 변경은 역이벤트 후 새 관계로 기록한다. Queue B의 다른 화면/전역 테마·로고·UI PLAN/HISTORY는 이 작업에서 수정하지 않았다.

## 2026-10-28 — D-072/073/074 지식 저장 계약

구 원장 이벤트·hash·actor 보존과 새 원장 prefix 복원, 선택 access_revision, 동시 검토에서 한 건 저장/한 건 conflict, 공개 실패 시 이전 바이트 보존, 재생성 뒤 acceptance 및 모의 전문가 정책의 pending 전환을 확인했습니다.

- 실행: `.venv/bin/python -m unittest discover -s core/tests/poc_knowledge -q` — **26개 통과**(네 도메인을 함께 검증하는 공통 검사 수).
- 테스트는 TemporaryDirectory의 격리 자료만 사용했습니다. 실제 모델 의미 평가·실제 사람 판단·운영 서버·data/.local 쓰기는 하지 않았습니다. 전체 UI/MCP/분석 통합은 완료 범위에 포함하지 않습니다.


## 2026-10-29 — Clean Up 원장·현재 표시·복원

- 기존 v1/v2 검토 events와 hash/actor/원문 근거를 재작성하지 않고 cleanup_events의 별도 chain을 전체 검증한다. 합계 이벤트1,000·원장8MiB 한도를 지키며 적용과 영수증을 단일 교체로 공개한다. 읽기로 이관하거나 오래된 기록을 삭제하지 않는다.
- 서비스 신규15개와 기존 지식 저장26개가 통과했다. 원문/graph 변경·동시 작성·같은 요청의 동시 재요청·선택 중 일부 오류·원자 교체 실패·교체 실패와 임시 정리 실패 동시 발생·이벤트/바이트 한도·손상 거부를 확인했다. 저장 성공의 정리 경고 분리는 저장기 콜백에 경고를 주입한 모의 검사이며 실디스크 장애 복구 보장으로 확대하지 않는다.
- 명시 기각과 이전 세대 원문 검토만 정리하며 정책 및 보류 상태는 보존한다. undo는 추가 이벤트이고 후속 정리·새 검토를 덮지 않는다. 새 세대는 옛 수용/기각/정리를 자동 승계하지 않는다. 기존 원장과 cleanup 이후 원장의 과거 prefix 복원도 확인했다.
- 공개 상세 계약은 ontology PLAN, 중요한 선택은 D-075가 소유한다. 실제 사람의 전문가 판단과 운영 원장 쓰기는 미실행이다.


## 2026-11-06 — 해상 자료887관계의 위임 AI 팀 협의 적용

- 두 새 관계 검토자의 독립 분담·전량 교차 반론·17건 답변·변경값104건 최종 확인과 주 에이전트의7건 대안 검토 후, 동일 사용자/SDV/default의 공식 ontology_review로 수용729·정정100·반려16·보류42를 실제 저장했다. 각 이유에 사용자 위임 AI 팀 판단임을 명시했고 사람 승인·원문 밖 전문가 정책은 기록하지 않았다. 안정된 문서+claim ID·현재state CAS·새이벤트·전체이력을 사용했다. [판단별 실제 event887개](../../../evals/2026-11-06-maritime-corpus/execution/team-deliberation/applied-decisions.json).
- 98문서 적용 후 의미 제안829값 일치·기존 이력prefix·원문/기계그래프/정책/독립관계와 비대상주장 보존을 확인했고, 새 연결에서153문서를 전체 재조회했다. 적용 실패·응답 미확정·정리 경고0, 원래10,428이력은 유지되고11,315건이 됐다. 보류38개 정의/경계 질문과4개 단일인용 표현 한계를 분리해 남겼다. 당시 고정 평가·채팅 점수는 바꾸지 않았고 재추출·제품/발행 프롬프트 수정 없이 종료했다. [최종 기록](../../../evals/2026-11-06-maritime-corpus/execution/team-deliberation/FINAL_SUMMARY.json), [후속 확인 질문](../../../evals/2026-11-06-maritime-corpus/execution/team-deliberation/remaining-questions.json).
