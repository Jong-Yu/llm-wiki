# 실행 환경 작업 기록

## 2026-11-09 — 0.1.0 공개 준비와 전체 Python 회귀

- 프로젝트 Python 3.12.14로 `core/tests/**/test_*.py` 85모듈을 이름으로 수집해 1,018개 전체를 실행했습니다. 최초 실행은 1,016통과·오류2·실패/스킵0이며, stdin 실행기를 macOS multiprocessing spawn이 다시 열지 못한 `<stdin>` 오류가 인증 프로세스 검사 2개에 `BrokenProcessPool`을 일으켰습니다. 해당 2개만 표준 `python -B -m unittest` 진입점으로 재실행해 모두 통과했습니다. 고유 1,018개 최종 통과·미해결 오류/실패/스킵0, 재실행 포함 1,020회입니다. 첫 실패를 보존한 [전체 결과](../../../.local/releases/v0.1.0-20261109/core-tests-report.json)·[재실행 로그](../../../.local/releases/v0.1.0-20261109/core-tests-spawn-rerun.log)에 구분했습니다.
- 임시 정책·자료·키와 ASGI·stdio·실제 loopback HTTP를 사용했습니다. 가짜 어댑터를 유지하고 모의 대체 없는 Codex/Claude 실행은 차단했습니다. 이 검증에서 제품/테스트 소스·운영 자료·서버·전역 설정을 변경하지 않았으며 실제 외부 AI·Electron 화면·Windows 실기기는 이 Python 회귀 범위가 아닙니다.
- `CHANGELOG.md`에 0.1.0 공개 준비 상태와 다운로드 목적을 정리했습니다. 개인 PC용 runtime ZIP과 저장소 `v0.1.0` 서버 소스/고정 requirements를 구분하고 macOS Developer ID 서명/공증 없음·Windows 코드 서명 없음·Windows 실제 설치/OCR/보호 저장 미검증을 명시했습니다. 기존 앱 8묶음은 후속 지도 범위 전환 수정 후 모두 통과했으며, 온톨로지 검토 18개·Clean Up 14개와 수동 탐색 미리보기의 검증 경계는 [UI 기록](../ui/HISTORY.md#2026-11-09--010-공개-준비와-앱-회귀)을 따릅니다.
- 최종 앱 검사(5종 TypeScript·Oxc·441파일 포맷·194토큰×3모드)와 electron-vite 제품 빌드가 통과했고 Mac/Windows 패키지를 다시 생성했습니다. [패키지 결과](../../../.local/releases/v0.1.0-20261109/package-final.json)와 [ASAR 대조](../../../.local/releases/v0.1.0-20261109/asar-verification-final.json)에서 양쪽 버전0.1.0·제품 출력 10파일 일치·개인 자료 루트 미포함을 확인했습니다. 양쪽 ASAR SHA-256은 `9d0d5bf03b36084e6169e797712159ca367e746838fb1dd3630412f313ad151a`로 같습니다.
- 배포 11파일(체크섬 파일 포함)의 이름·해시와 `latest*.yml`을 [배포 파일 확인](../../../.local/releases/v0.1.0-20261109/publish-assets-final.json)에 기록했습니다. [최종 설치 파일 대조](../../../.local/releases/v0.1.0-20261109/installer-verification-final.json)에서 실제 Windows NSIS를 추출한 runtime 2,942파일·최종 제품 출력과 같은 ASAR, Mac ZIP의 버전0.1.0/ASAR·DMG의 hdiutil 체크섬, 개인 PC용 runtime ZIP의 현재 소스 306파일 일치를 확인했습니다. GitHub 공개는 아직 완료하지 않았습니다. 패키지 생성/내용 대조는 실제 Windows 설치·보호 저장·OCR 동작이나 운영 서버 갱신의 증거가 아닙니다.

## 2026-11-08 — 질문 전 근거 조회와 신규 v6 인계

허용 공간 검색과 실제 발언에 결합한 검색 prefix, 신규 v6 초기 결과의 실행별 제공 영수증·첫 입력을 연결했습니다. 같은 잠금의 배경 준비와 기존 v1~v5·현재 인가/판본/CAS/lease·재접수/재획득·제출 검증을 유지합니다. 격리 loopback을 포함한195개와 앱 검사는 [소유 기록](../knowledge/HISTORY.md#2026-11-08--질문용-색인과-첫-ai-호출-전-근거-제공-d-124)을 따릅니다. 실제 AI/비교 실험·전역 설정·외부 전송·설치/운영 변경은 없습니다.

## 2026-11-08 — 저장된 검색 정책과 실행 환경 보완 비교 (D-123)

- 신규 v5 생성의 명시 옵션만 검색 정책을 기록하고 후속 조회는 저장 정책을 따르도록 구현했습니다. defaultFalse·정책 없는 기존 실행/영수증·동일 인계/첫prompt/schema·6조회/7모델·권한/CAS를 유지했습니다. 관련99·검색47·합성41/정책7/계수20검사가 통과했습니다.
- 첫8CLI시작 실패를 원시/unknown8로 보존하고 의미 결과 없이 환경만 보완한 별도8시도를 사전 고정했습니다. 정상은18usage완전·모델9→9·입력57,712→54,396·출력1,128→1,168·합계5.57%감소입니다. 전체26CLI시도 중8사용량불명으로 전체 소비를 단정하지 않았습니다. 원래오류본문은hash만있어 정확한fatal 원인은 미확정이며 로그인 실패로 단정하지 않았습니다.
- 두 원문 평가가 전문항 동점이나 공통 설명 누락으로 사전 기준 실패해 기본 라우터/전역 설정은 유지했습니다. 원시266+498·실패765/정상1732대조·별도 합산과 모델ID/요금 미확인, 설치/운영 미반영 범위는 [소유 보고서](../../../evals/2026-11-08-ranked-search/REPORT.md)·[최종 확인](../../../evals/2026-11-08-ranked-search/FINAL-VERIFICATION.json)을 따릅니다.

## 2026-11-08 — 첫 검색어 정밀 안내의 명시 비교·도입 보류 (D-122)

- 양쪽현재v2/select_toolsTrue·동일공개store인계에서precise_searchFalse/True만비교했습니다. 8답변·16usage완전/실패·재시도0, 모델8→8·입력48,325→47,630·출력805→821·합계1.38%감소였습니다. rawDATA/schema같은첫입력은각44토큰늘었고품질양평가24→24였습니다. 실제모델ID미보고/같은provider-default확인·요금미측정한계를보존했습니다.
- 사전5%기준미달로기존Codex v5dispatch와프로필·전역설정을그대로두고내부기본False개발옵션만보존했습니다. 125시험·합성33/동결6·계수20와실제1572대조·원시466파일/스냅샷25씩의보존범위, native전부모reader/바인딩보완과미검증항목은 [소유 보고서](../../../evals/2026-11-08-precise-search/REPORT.md)·[최종 확인](../../../evals/2026-11-08-precise-search/FINAL-VERIFICATION.json)을따릅니다. 서버검색/커서·정책/원장·설치/운영과결과후추가AI변경은없습니다.

## 2026-11-08 — 첫 호출 도구 선택 안내의 Codex v5 연결 (D-121)

- 같은기존v2CLI옵션/격리v5불변인계의A/B8시도를실행했습니다. 첫search4→4는바로실제조회로사용됐고별도classifier/route-only0입니다. 새안내후모델9→8·입력55,734→49,375·출력830→811·합계11.28%감소, 17usage완전/실패·재시도0입니다. 첫입력은각100토큰만감소했고전체이득은q03추가read제거에집중됐으며q02/q04는늘었습니다. 실제모델ID미보고/실제요금미측정한계를유지합니다.
- 독립원문품질양평가24→24확정후 `_QuestionExecution.run_model`의Codex v5분기에만True를연결했습니다. Claude/unknown의기존인자와v3/v4기존fullprompt/schema/단일호출을관련66시험에서확인했습니다. helper기본False·기존CLI프로필/어댑터상태/전역설정과서버고정입력은유지합니다. 연결전2파일전체와기존baseline/runtime25파일·native482파일을보존했으며추가native0입니다.
- 최초비모델dry-run의명세limits초과키오류는원본명세/사유를보존하고모델실행전에키만바로잡았습니다. 실제사용량1635대조·원시독립합산·115구현검사·새4문항1회/인증noopfixture·미검증범위는 [소유 보고서](../../../evals/2026-11-08-question-tool-selection/REPORT.md)·[최종 검증](../../../evals/2026-11-08-question-tool-selection/FINAL-VERIFICATION.json)을따릅니다. 사용자자료·설치앱/운영서버교체는없습니다.

## 2026-11-08 — 짧은 질문의 로컬 비용 분해

- 새CLI/AI/하위에이전트·네트워크없이기존28시도/88호출을분해했습니다. 최근질문v2의짧은후속6호출은제공자입력53,062/저장prompt+schema로컬31,312로회당3,625차이가일정했고,별도CLI안내파일138로컬토큰/회는중복합산하지않았습니다. 이차이를확정된고정지시/제거가능량이나요금으로귀속하지않았습니다. 출력형식은저장입력6.73%로큰우선순위가아닙니다.
- 분석용파일과소유도메인기록만추가했습니다. 원시사용량독립합산·두인코딩/가역표현·실패1건unknown보존과입력481/제품26파일·전역설정불변을확인했습니다. 구체수치·초안보완·첫근거제공후보와실제품질/요금미검증은 [소유 보고서](../../../evals/2026-11-08-simple-question-token-audit/REPORT.md)를따릅니다. 질문동작/프롬프트·설치/운영변경은없습니다.

## 2026-11-08 — 신규 v5 질문 문맥의 개발본 연결 (D-120)

- 사용자 원문 우선 문맥/일반 조건 유지 안내의 새10회A/B비교가 양평가80→80/80·전체입력+출력36.47%감소로 사전 기준을 통과한 뒤POST `/question-runs`생성의단일생성자에만 `user_dialogue=True`를 연결했습니다. 생성자기본False와v3/v4·기존불변입력·재접수·다른읽기/명령경로는유지합니다. provider선택이전신규v5전체의문맥변경이며실제의미/사용량검증은Codex만입니다. 기존v2 CLI전용프로필과전역config는변경하지않았습니다.
- 신규HTTP양성1개를포함한관련18검사(26.423s)에서실제create→claim→input·기존30회입력상한·인가회수/타인/취소/이력/영수증/legacy경계를통과했습니다. 초안검사가동적access응답까지입력hash에넣어1회실패했고기존불변입력계약에맞춰테스트만수정했습니다. 제품연결은계속1줄이며추가모델0회입니다. 연결전API/검사전체원본을평가폴더adoption-baseline에보존했습니다.
- 비캐시입력+1.81%와출력+13.75%로실제요금절감은미확인입니다. 원시905파일/동결23파일·평가기준/기존사용자자료와설정을보존했으며이번작업의앱설치/서버배포는없습니다. [소유 보고서](../../../evals/2026-11-07-question-condition-timeline/REPORT.md)·[채택 결정](../../../evals/2026-11-07-question-condition-timeline/adoption-decision.json)·[최종 검증](../../../evals/2026-11-07-question-condition-timeline/FINAL-VERIFICATION.json)에실행과미검증범위를기록했습니다.

## 2026-11-08 — 속성 상세 선택 수정본의 앱 단독 설치

- 앞선 지도 개선 설치 후 제보된 속성 선택 무반응을 UI1파일에서 고친 수정본을 전체 검사/빌드하고 고정10파일·패키지/설치 ASAR·deep strict 서명을 대조했습니다. ASAR `edde34e8d0da69cfea8e230c7cccab20069363fe541db1d2bbc078724dd2fa83`를 `/Applications/LLM Wiki.app`에 설치하고 직전 `e2b239…` 앱은 새 release의 `previous-LLM Wiki.app`으로 보존했습니다. 설치 중 runtime-settings1·work-recovery10·question-sessions0·connection-protection2파일의 집합/해시가 같았습니다.
- 정상 Quit 후 남은 정확한 기존 main에 SIGTERM1회를 보냈고 새 설치 경로의 실행 프로세스를 확인했습니다. native 화면 조회 시간 초과 후 재연결에서 Mac 재잠금이 확인돼 마지막 직접 클릭 검증은 미실행입니다. 격리 실제 앱 전송의 클릭·키보드·원문 왕복과 설치 검증 범위는 [후속 확인서](../../../app/test-results/ontology-attribute-detail-20261108/verification.md), 패키지는 [설치 영수증](../../../app/release/ontology-attribute-install-20261108-zz023ug3/VERIFICATION.json)을 따릅니다. 서버·guardian·터널·기존 주소와 업무 자료를 다시 변경하지 않았습니다.

## 2026-11-08 — 개념 선택·원문 지도 앱과 서버의 동시 반영

- 사용자 승인으로 최종 전체 앱 검사/제품 빌드(5종 타입·lint·441파일 포맷·194토큰×3모드)를 통과한10파일을 고정하고 arm64/Electron45 앱을 준비했습니다. 설치/ASAR10파일 일치·ad-hoc deep strict 서명 검증 뒤 기존 앱을 복구용으로 옮기고 검증한 앱을 `/Applications/LLM Wiki.app`에 원자 교체했습니다. ASAR는 `e2b2397789539138942f16f62e579a71b1c8f95f08b0f5ba466228b766e3202a`이며 [패키지·설치 영수증](../../../app/release/ontology-map-install-20261107-cz1x4jv5/VERIFICATION.json)과 `previous-LLM Wiki.app`을 보존했습니다.
- 현재 Bash 런처가 서버 종료 때 터널까지 정리하므로 기존 Bash 지원 인계 helper를 재사용해 정확한 PID/시작시각/실행 파일/argv를 검사했습니다.17모의시험 후 현재 터널을 유지해 인수했고, 첫 tracked 기동이 정상 색인 준비12,398.864ms를 기존 약10초 확인 한도 안에 끝내지 못해 무tracking fallback으로 내려갔습니다. 기존 Python guardian 인계 helper의60초 deadline·18모의시험/독립 검토로 재인수해 최종 guardian78885/server78928/tunnel64855, status=updated·tracking/metrics=True·오류/잔여0을 확인했습니다. 인계 중 터널에는 신호를 보내지 않았습니다.
- 기존 공개 주소·터널 전체 identity, 새 PID의8766 소유와 loopback/공개 무인증401을 확인했습니다. 서버 source246·보호 설정23파일과 원문/이력/그래프/검토/등록 원본1,208파일의 집합·바이트 해시가 같았습니다. 현재 디스크 소스 관측이며 이전 프로세스가 시작 시 읽은 전체 바이트나 정확한 source rollback을 입증한 것은 아닙니다. 최종 운영 guardian은 계속 실행하며 [서버 근거](../../../.local/deployments/ontology-map-install-20261107-tracked-ylozhb_2/rollout-verification.json)와 첫 fallback 기록을 보존했습니다.
- 실제 사용자 설정 경로 `llm-wiki-app`의 runtime-settings1·work-recovery10·question-sessions0·connection-protection2파일은 앱 종료 후/교체 후/재시작 후 관측에서 해시가 같았습니다. 정상 Quit으로 창이 닫힌 뒤 남은 기존 main은 정확한 identity를 재검사해 SIGTERM1회로 종료했습니다. 잠긴 Mac은 사용자가 직접 해제했고 초기 native 실행 조회 시간 초과 뒤 설치 file URL·연결·새 지도 제어를 확인했습니다. 사용자가 지도 조작을 시작해 추가 UI 조작은 멈췄습니다. 실제 AI·실자료 쓰기·게시/공증·모든 업무 회귀는 수행하지 않았습니다. 상세 범위는 [설치 확인서](../../../app/test-results/installed-ontology-map-20261108/verification.md)를 따릅니다.

## 2026-11-07 — 원문 앵커 관계의 지도 전송 계약

- Python `exploration_schemas.py`와 앱 공통 계약에서 기존 개념 끝점과 원문 anchor_id 끝점을 구분하고 quote 없는 anchors 요약을 검사합니다. 원문/페이지 판본·문서·줄·끝점 집합을 대조하며 실제 개념 전용 입력과 기존 인가·페이지 제한은 유지합니다.
- HTTP4·앱 지도 전송16묶음(원문 관계 수락, quote/다른 문서·판본·역전 줄/혼합 끝점 거부 포함), 나머지 웹 전송 회귀와 실제 renderer/main/API 검증을 통과했습니다. 초기 Python 응답 스키마 누락은 출력 계약 확장으로 보완했습니다. 관련 지식38시험·앱34시험/제품 빌드·캡처·남은 범위는 [소유 보고서](../../../app/test-results/ontology-source-anchor-map-20261107/verification.md)를 따릅니다. 소유 임시 서버/자료만 정리했으며 운영 서버·설치 앱은 변경하지 않았습니다. 기존 설치본은 새 응답 필드를 받지 못하므로 실제 반영은 앱·서버를 함께 진행해야 합니다.

## 2026-11-07 — 완결성 안내를 보완한 질문 전용 옵션의 연결 (D-118)

- `question-only-v2`의816바이트 공통 안내에 같은 응답의 요청 항목·조건/예외/결과/후속 책임·미독 표시 점검을 넣었습니다. 안내 작성자가 새 질문을 읽기 전에 안내를 고정했으며 어댑터 실행/권한/스키마와 조회 한도는 바꾸지 않았습니다. 실제4쌍 비교의2452계수 검사·원시32완료 이벤트에서 모델17→15·입력+출력49.71% 감소, 두 독립 평가 모두40→40으로 사전 기준을 통과했습니다.
- 확정 후 `guarded_model`의 지원되는Codex v5 계약에만 호출별 옵션을 전달했습니다. 레거시/Claude/미확인 제공자/예전 어댑터·공유 객체/preview callback 보존을 포함한66검사가 통과했습니다. 후보15회에만 옵션이 있고 기존17회에는 없었으며 전역config 전·후·최종hash는 같습니다. 제품 안내/연결 변경은 개발본에만 있고 운영·설치·사용자 자료는 변경하지 않았습니다.
- 모델 호출 전 실행 명세의 허용 목록 불일치를 발견해 실패 기록을 보존한 뒤 목록만 바로잡았습니다. 전체 수치·실패/미실행·부분 인용·모델ID 미보고/v1 직접 대조 없음·새 자료/긴 대화 한계는 [소유 기록](../knowledge/HISTORY.md#2026-11-07--같은-호출의-완결성-안내와-새-원문-비교-d-118)·[보고서](../../../evals/2026-11-07-question-cli-completeness/REPORT.md)를 따릅니다. 확정 후 추가 모델 실행은 없습니다.

## 2026-11-07 — 온톨로지 후속 개선의 Mac 설치

- 사용자 요청으로 UI의 관련23시험·최종 제품 전체 검사/빌드와 실제 격리 화면 검증을 마친 출력을 고정했습니다. 기존 electron-builder26.18/Electron45 arm64와 설치된 Electron 배포본으로 `release/ontology-usability-20261107-w7YS5r/mac-arm64/LLM Wiki.app`을 만들었습니다. 패키지의10개 out 파일이 고정본과 일치하며 ad-hoc 서명과 `codesign --verify --deep --strict`를 통과했습니다. 게시/버전 증가는 하지 않았습니다.
- 앱을 정상 종료하고 실행 프로세스 부재를 대조한 뒤 준비한 앱의 서명·ASAR를 확인해 교체했습니다. 기존 앱은 같은 release 폴더의 `previous-LLM Wiki.app`으로 보존하고 실패 시 원위치 복구 경로를 두었습니다. 설치 후에도 ASAR SHA-256 `91aca644313b5a9791db29bb186ab24c3bec4970d45d589ce854eecad876d340`과 서명이 일치합니다. [설치 영수증](../../../app/release/ontology-usability-20261107-w7YS5r/VERIFICATION.json)을 보존했습니다.
- 실제 `/Applications/.../app.asar` 창의 연결된 작업 공간·원본/위키 구분, CO2 Measure 검색2건과 같은 연결 미리보기2건, 주제1/불러온 관계2 및 원문 위치1122–1126행 안내를 확인했습니다. native 앱 연결/AX 관찰 일부는 시간 초과되어 재연결했으며 최종 현재 문서 화면을 강제로 되돌리지 않았습니다. 같은 bundle ID의 복구본 등 여러 경로가 있어 앱 지정은 절대 설치 경로를 사용했습니다.
- 사전 설정 검사에 사용한 `Application Support/LLM Wiki`는 실제 경로가 아니었습니다. 실제 `llm-wiki-app`의 실행 후 runtime-settings1파일·work-recovery9파일·question-sessions0파일과 기존 연결을 확인했습니다. 사전 hash 비교가 없으므로 전후 바이트 동일성을 주장하지 않으며 설치기는 앱 번들만 교체했고 설정·인증 폴더를 삭제/대체하지 않았습니다. 사용자 원문/위키/원장·운영 서버·인증 정책은 변경하지 않았습니다.
- 임시 고정 출력·소유 웹 검증 서버/자료/번들은 정리했습니다. 기존 다른 세션 서버·배포물은 보존했습니다. Windows·게시/공증·실제 모델 실행·모든 업무 회귀를 수행했다는 뜻은 아닙니다. 화면 변경·동작과 검증 범위는 [UI 기록](../ui/HISTORY.md#2026-11-07--첫-사용-검토의-후속-개선과-mac-설치)을 따릅니다.

## 2026-11-07 — 질문 호출 전용 CLI 옵션과 자동 적용 철회

- `CodexAdapter.run(question_profile=False)`에 실행별 짧은 지시 파일·설명 생략·불필요 문맥 제외를 구현했습니다. 읽기 전용/권한/인증/스키마와 기본 인자 순서는 유지하며 session/resume/web 결합은 거부합니다. 기능 지원 확인은 비모델 호출로 수행하고 실패/취소를 기존 실행 원장에 남깁니다. 전역 설정·어댑터 실행 모드를 바꾸지 않습니다.
- 관련66검사와 기존 세션/Claude/웹 어댑터 회귀를 통과했고 실제 질문4쌍의36호출은 입력+출력50.25% 감소였습니다. 그러나 고정한 두 독립 평가 모두 q03 누락을 지적해 질문 자동 활성화만 제거했습니다. 최종66검사·실험 전 질문 코드 일치를 확인했습니다. 후보17호출에만 옵션이 있었고 기본19호출에는 새 파일/옵션이 없었습니다. 전역config 전/후/최종hash는 같습니다.
- 수치·실패·기준hash 확인 중 잔여 변수화 제거·독립 평가·2689계수 검사와 한계는 [소유 기록](../knowledge/HISTORY.md#2026-11-07--질문-전용-cli-입력-축소의-실제-비교-d-116)·[보고서](../../../evals/2026-11-07-question-cli-profile/REPORT.md)를 따릅니다. 기본False의 명시 개발 옵션만 보존하며 일반 질문 자동 도입·운영/설치 반영·사용자 자료 변경·추가AI는 없습니다.

## 2026-11-07 — 질문 CLI의 공통 입력 주입 경로와 설정 조사

- 기존117호출과 설치된 Codex0.167.0-alpha.3.2의 로컬 도움말·번들 모델 카탈로그·캐시 지시문·비밀값을 제외한 설정을 조사했습니다. 실제 명령의 ignore-user-config와 전역 모델 설정을 구분했고 auth파일/토큰을 복사하지 않았습니다.
- debug prompt-input을 네트워크와 원래 Codex폴더 읽기/쓰기가 차단된 진단 전용 설정 루트에서 실행했습니다. 별도 루트는 자식 프로세스에만 지정했고 부모 환경·전역 설정은 그대로입니다. 기본 코딩 지시4,212·스킬2,653·권한799·협업179·환경152 로컬토큰, 별도 코드 도구 정의를 확인했습니다. 실제 과거 모델/요청이 미보존이라9,758을 정확히 재구성한 것으로 과장하지 않았습니다.
- 짧은 model_instructions_file은기본 지시4,212→78로 대체했고, omit_skill_descriptions는스킬2,653→896으로 줄였습니다. 이름 특례 없는 범용 조합은공통 본문7,995→1,773, 발견19개 스킬 명시 제외의 진단 최소는877입니다. 모든9구성에서권한799와도구정의가같았습니다. code_mode/code_mode_host 토글만으로도구정의는 사라지지 않았습니다.
- 기존 skip_host_skill_discovery/skill_search 제한을 스킬목록 전송 제외로 넓게 해석했던 설명을 정정했습니다. 프로젝트 문서 제한·도구 실행 차단과 기본 지시/스킬 카탈로그 주입은 별개입니다. 원답변·사용량·평가 결과는 변경하지 않았습니다.
- 초기 중첩 보호 환경 거부·공유홈 초기화 권한·빈 MCP 조각 설정의 준비 실패를 각각 보존했습니다. 원래 폴더 접근을 풀지 않고 진단 전용 루트로 성공했으며 새모델/하위에이전트0입니다. 임시 자동 스킬/PATH51파일 등은 이번 소유 폴더 안에서만 정리했고 원시 출력은 보존했습니다.
- [보고서](../../../evals/2026-11-07-cli-input-audit/REPORT.md)·[요약/10검증](../../../evals/2026-11-07-cli-input-audit/SUMMARY.json)에 고정했습니다. 기존772파일·설치 바이너리·전역 설정 hash가 같았고 제품 코드·운영·사용자 데이터는 변경하지 않았습니다. 실제 제공자 절감/품질·질문 전용 옵션의 구현은 미실행입니다.

## 2026-11-07 — Mac 설치 앱의 테마·상태바 반영

- 사용자 요청으로 최신 개발본의 `npm run build`를 실행했습니다.5종 TypeScript·전체 lint·421파일 포맷·194토큰×3테마 및 main/preload/renderer 제품 빌드를 통과했습니다. 공식 Electron45.0.0 arm64와 기존 electron-builder 설정으로 로컬 실행 앱을 만들었으며 게시/버전 증가는 하지 않았습니다. 기존 `/Applications`·`~/Applications`에는 앱이 없고 예전 release/마운트 이미지에만 남아 있어, 검증한 앱을 `/Applications/LLM Wiki.app`에 새로 설치했습니다. 기존 앱 파일·Dock 항목·사용자 자료는 삭제하지 않았습니다.
- 첫 패키지의 가이드 reference HTML에서 끝37바이트 차이를 발견해 설치하지 않았습니다. 고정 빌드 snapshot을 사용한 두 번째 시도는 패키징 도구가 외부 `/private/tmp` 경로를 거부했고, 허용되는 프로젝트 내부 임시 snapshot으로 재생성했습니다. 최종10개 out 파일 모두 SHA256이 같고 설치 ASAR도 같은 `108624fd096362f78a84994325942b4bff997ffc096ec48c3fa431f842915d46`입니다. 로컬 ad-hoc 서명과 설치 후 `codesign --verify --deep --strict`를 통과했습니다. [패키지/설치 검증](../../../app/release/theme-update-20261107-verified/VERIFICATION.json)을 보존하고 불완전 패키지2개·중간 snapshot·임시 로그는 정리했습니다. 서명/공증 정책을 해제하지 않았습니다.
- 실제 창의 `file:///Applications/LLM Wiki.app/...` 경로와4테마 선택지·크림 적용·잔여96% 문구/막대의 같은 줄 정렬을 확인했습니다. 검증 뒤 원래 선택인 화이트로 복원하고 앱을 열어 두었습니다. 초기 저장 주소의 로그인 복원이 실패했고 '연결 다시 확인'은 외부 인증정보 전송의 구체적 승인 부족으로 자동 검토가 차단했습니다. 해당 동작을 우회/재시도하지 않았으며 사용자가 현재 주소로 직접 로그인한 뒤 연결됨·실제 작업 공간을 확인했습니다. [설치 앱 크림](../../../app/test-results/installed-theme-update/cream.png)·[화이트 복원](../../../app/test-results/installed-theme-update/white.png)을 보존했습니다.
- 설치/첫 실행 직후 기존 runtime-settings1파일·work-recovery9파일과 question-sessions 폴더는 동일했습니다. connection-protection2파일은 앱 시작/사용자의 새 주소 로그인 과정에서 갱신됐으며 전체 설정의 바이트 동일성을 주장하지 않습니다. 설정 폴더를 삭제/대체하지 않았고 운영 원문·위키·분석/질문을 쓰거나 실행하지 않았습니다. 실제 모델 호출·Windows 설치·모든 업무 회귀는 이번 설치 검증에 포함하지 않습니다.

## 2026-11-06 — ID 인용 렌더와 단계 preview 보호

- 개인 질문의 `guarded_model(..., allow_preview=False)`로 원시 ID/초안을 숨기고 최종 검증·렌더된 답변만 기존 saved=false preview 계약으로 전달합니다. 명시 callback 인자와 adapter property의 fallback을 함께 차단/복원하며 레거시 기본 동작은 유지합니다. 새 HTTP/MCP 인증 입구나 공개 답변 형식 변경은 없습니다.
- 관련119개와 실제 callback 경계·동결 모델108호출/새 기본2호출의 격리 검증은 [소유 기록](../knowledge/HISTORY.md#2026-11-06--인용과-읽기-방식-개선-및-추가-검사-기본-도입-보류-d-109)을 따릅니다. 추가 모델 검사는 기본 비활성이고 운영 서버·설치 앱·실사용 자료는 변경하지 않았습니다.

## 2026-11-06 — 질문별 선택 근거 조회와 영수증

- D-108의 선택 mode 준비/개인 질문 접수와 v5 작업에 `POST /question-runs/{id}/evidence`, 동일 요청 결과의 `GET /question-runs/{id}/evidence/{request_id}`를 연결했습니다. 요청·실제 응답·hash·실행 ID를 개인 원장에 보관하며 전송 손실 때 GET 확인만 수행합니다. 현재 인증/소유권·근거 판본·lease·기준 revision·제출 직전 검사를 유지합니다. 생략 mode의 기존 요청 hash와 v3/v4는 보존합니다.
- 격리 ASGI17개·새 저장18개와 기존 문맥/세션·클라이언트 합계53개 검사를 확인했습니다. 정확한 범위·중복 수·실패 수정·실제 모델 및 운영 미반영은 [소유 기록](../knowledge/HISTORY.md#2026-11-06--필요한-근거만-읽는-채팅-d-108)을 따릅니다. 신규 외부 서비스·서버 인증 우회·운영 자료 쓰기나 서버/설치 앱 교체는 없습니다.

## 2026-11-06 — 온톨로지 색인 준비의 운영 반영

- 사용자 승인 후 직전 운영 검증273개 runtime과 현재 코드를 대조해 이번 검증의4개 변경만 확인했습니다. `core/runtime/http_cli.py`의 read-metrics에서 정제된 준비 logger를 활성화하고 임시 HTTP 검사의 표준 로그 접두어 파싱을 보완했습니다. 최종 준비12개·인계 모의18개가 통과했습니다. 추가 로그 검사는 접두어 때문에1건 실패해 파서만 수정한 뒤 단독 및12개 전체를 통과했습니다. 기존497개는 반복하지 않았습니다.
- 인계 helper는 기존 절차를 새 폴더에 복사해 감시자 경로/주소를 명시하고, 기동 준비30초에 맞춰 readiness45초 deadline을 적용했습니다. deadline/정확한 포트 소유를 모의 검증했습니다. 현재 허용 read 범위1개/manifest154개·정책/규약 SHA와 mode·private lock2개를 확인했습니다. 수동 복구용4소스는 직전 운영 hash와 정확히 같고 최종274개 runtime SHA를 기동 전/후 대조했습니다. tracking 없이 기동하는 fallback과 source 수동 복원을 구분합니다.
- 최초 인계는 guardian43700을 멈추고 server43743을 종료하던 중 `old_server_stop_identity_changed`로 보수적으로 중단됐습니다. 이전 서버/감시자가 사라지고8766 포트가 비었음을 재확인한 뒤 실패 감시자19817의 정확한 identity를 검증해 `recover.py`가 새 서버를 기동하고 감시를 인계받았습니다. 검증하지 않은 PID나 터널에는 신호를 보내지 않았습니다. 최종 guardian21162/server21189·기존tunnel62720·status=updated·tracking/metrics=true·오류/잔여 없음입니다. 초기 실패는 RUN의 `failed-handover.json`에 보존하며 현재 guardian 경로는 `recover.py`입니다.
- 기동 준비202.401ms·문서 갱신/본문 읽기0회로 기존 SQLite를 재사용했습니다. 같은 정상 계정의 현재 read/기본 profile을 확인하고 정확한 `text=""/kind=document/cursor=null/limit=5` 첫 세 호출64.981/63.845/58.830ms·본문/색인 갱신0회를 관측했습니다. 개념338.313ms·관계75.117ms·본문16.019ms·목록85.727ms·분석 목록528.673ms를 포함한 timed8건은 모두200입니다. 인증/발견은 이 수에서 제외합니다. 배경 준비의 후속 실행도 관측됐고 준비 경고/반영 후 내부5xx는0입니다. 고정 자료·SLA·공개 HTTPS·화면 표시 시간으로 확대하지 않습니다.
- 공개 기존 주소에는 인증정보 없이 `/mcp`를 요청해 예상401을 확인했습니다. 공개 인증 요청 시간은 미측정입니다. 기존 터널 PID/시작 시각/명령·URL, 정책/규약 SHA와 mode는 그대로입니다. 운영 원문/그래프/원장·권한/토큰 변경·AI·쓰기 시험·설치 앱 교체는 없었습니다. 변경 후 자동 갱신/충돌/전체 이력은 격리12개 검증을 따르며 기존 coverage의 누락/관계 제외를 유지했습니다.
- 상태·복구 준비물은 `.local/deployments/2026-11-06-ontology-eager-gxq78y6t/`, 최종 근거는 `.local/diagnostics/ontology-eager-rollout-20261106-wwn147zl/rollout-verification.json`과 같은 폴더의 검사·preflight·source SHA·live-reads·coverage·public readiness입니다. 이전 운영 폴더와 사용자 이력은 보존했습니다.

## 2026-11-06 — Python 온톨로지 색인 준비 수명 연결

- D-106 작업자를 `create_application()`의 tracking 모드에 연결해 기동 첫 순회 최대30초 대기·종료 시 중단/대기를 구현했습니다. strict 모드·기존 API/MCP 인증은 유지합니다. README에 실행 동작을 추가했습니다.
- 기존485개+신규12개를 확인하고 실제 임시 loopback 첫 요청의 본문/색인 갱신0회와 격리100문서의 첫 API1673.067→263.376ms(기동 준비1513.640ms)를 확인했습니다. 실행기/검사 import 보완·재검사 범위·원문/전체 이력 보존·한계는 [소유 기록](../knowledge/HISTORY.md#2026-11-06--python의-기동-전저장-후-온톨로지-색인-준비)을 따릅니다. 운영/설치 교체·사용자 자료 쓰기는 미실행입니다.

## 2026-11-06 — 온톨로지 최근 문서5개의 정확한 요청 재측정

- 사용자가 현재 화면은 전체 개체를 표시하지 않는다고 지적해 UI 입력과 서버 실행 순서를 대조했습니다. `useOntologyExploration`의 첫 요청은 `text=""/kind=document/limit=5/cursor=null`인데 직전 측정기는 `kind=all/limit=5`를 사용했습니다. 따라서 앞서8236.641ms를 현재 화면의 첫 진입 시간으로 표현한 것은 부정확했습니다. 최초 관측은 보존하고 보고서에 요청 차이·해석 범위를 명시했습니다.
- 같은 정상 계정·기본 허용 profile의 현재 화면과 정확히 같은 loopback API를3회 읽었습니다.232.913/66.096/67.346ms, 모두200·반환 문서5개/전체154개·약24.8KB이며 앱 캐시/인위 지연/서버 재시작/색인 초기화는 없습니다. 세 요청 모두 canonical read0/index sync0으로, 이미 준비된 색인을 사용했습니다. 따라서0.233초를 색인이 없는 최초 구축 비용으로 확대하지 않습니다.
- 서버 `explore_search()`는 `_ensure()`로 전체 문서의 색인 상태를 확인/필요 문서 재투영한 뒤 `_page()`에서 limit을 적용합니다. 문서5개만 화면에 보이는 현재 동작과 색인 준비 범위는 다릅니다. 직전 혼합 요청의 색인 갱신98회·8.24초는 그 경로의 비용 근거지만, 정확한 문서5개 입력의 cold 지연은 이번에도 강제 재현하지 않았습니다. UI가 전체 개체를 먼저 내려받는다고 판단하거나 두 조건의 시간을 동일시하지 않습니다.
- coverage는 기존 `ontology_missing/source_anchor_relation_not_projected`로 complete=false이며 잘림은 없었습니다. 의미 완전성을 선언하지 않습니다. 변경은 진단 산출물과 platform PLAN/HISTORY의 정정뿐입니다. `exact_screen.py`, `exact-screen/observations.json`, `exact-screen-report.json`을 `.local/diagnostics/first-api-20261106-k1pr9u0m/`에 추가하고 기존 `report.json`에 정정 값을 연결했습니다. 제품 코드·업무 자료·배포를 변경하지 않았습니다.

## 2026-11-06 — 앱 캐시를 제외한 첫 API 응답 재측정

- 사용자가 반복 캐시 효과를 제외한 첫 API 시간을 요청해 기존 측정기의 정상 로그인·계측 로그 대조를 재사용했습니다. 현재 계정/허용 read·기본 profile을 확인하고 `127.0.0.1:8766`만 호출했습니다. 매 요청 새 HTTP 연결, 인위 지연/renderer 캐시 없음이며 응답 전체 수신·gzip 해제·JSON 파싱까지 측정합니다. 서버·인덱스를 강제 재시작/초기화하지 않았으므로 이번 진단의 경로별 첫 성공 요청과 서버 cold start를 구별합니다. 토큰/본문·실제 사용자/문서/원본/작업 ID는 산출물에 보관하지 않았습니다.
- 첫 응답(ms): 문서 목록85.858, 원본 목록58.874, 분석 목록490.379, 질문 목록238.464, 대조 목록21.593, 문서 검색181.625, 본문3.322, 문서 판본 목록4.295, 지식57.236, 기계층10.985, 연결951.134, 변경 영향1543.385, 검토함485.519, 통합 이력1092.110, 원본 상세2.789, 분석 상세15.906, 대조 상세497.708, 온톨로지 최근 항목8236.641·개념389.017·직접 관계37.693입니다. 상세는 허용된 문서/원본/작업 각 한 개의 관측입니다. 전체 자료와 부하는 동결하지 않았습니다.
- 온톨로지 첫 요청은 서버8235.800ms·lock hold8233.506ms·lock wait0.007ms, 색인 갱신98회/1043.703ms와 canonical read196회를 기록했습니다. 같은 조건의 다음 직접 API 요청은97.853/95.219ms이며 canonical read/index sync가 없어졌습니다. `_ensure()`의 전체 문서 signature 대조 및 변경 문서 투영/색인 교체 경로와 함께 보면 첫 색인 준비/갱신이 주된 원인이라는 근거입니다. 세부 단계 시간은 중첩되므로 합산하지 않으며, 통제한 최초 구축 반복 시험이나 매번8초라는 보장값으로 해석하지 않습니다. 운영 색인을 지워 재현하거나 코드 수정·서버 교체를 하지 않았습니다.
- AI 세션 catalog가 동시에 요청하는 상위 목록3개만 별도로 실행해 batch543.764ms(분석499.140·질문222.319·대조543.070ms)를 확인했습니다. 질문별 상세 후속 요청·완료 작업 복구·main/IPC/스키마 검증·renderer 표시는 이 값에 포함하지 않습니다. 서버 통합 이력 API와 해당 화면의 목록 묶음도 구분합니다.
- 정상 측정45건은 모두200이며, 그중 단독42건은 각각 하나의 서버 계측 로그와 일치했습니다. 초기 측정기가 원본/분석 목록에 지원하지 않는 `profile` query를 추가해422가4건 발생했습니다. 이 네 건은 정상 응답 수치에서 제외하고 측정 인자만 현행 엄격 스키마에 맞춘 보완 검사에서 두 목록/상세 모두200을 확인했습니다. 인증·권한·입력 검사를 변경하거나 다른 계정으로 우회하지 않았습니다. API의5xx/전송 실패는 관측하지 않았습니다.
- 통합 이력은 total2000상한·capture/output limit, 영향은 byte budget/scan incomplete/review unavailable, 검토함은 capture limit에 따른 기존 불완전/잘림 결과였습니다. 빠른200을 전체 이력/전체 영향 확보로 간주하지 않습니다. 같은 API의 추가 표본은 변동 확인용이며 첫 값은 따로 보존했습니다. 공개 HTTPS·설치 앱·서버 재시작 cold start는 미측정입니다.
- 근거: `.local/diagnostics/first-api-20261106-k1pr9u0m/report.json`, 최초 `observations/summary/semantics/scope.json`, `supplemental/`, `session-list-batch.json`, 재현용 `measure.py`/`supplement.py`. 변경은 이 진단 산출물과 platform PLAN/HISTORY뿐이며 사용자 원문/이력·제품 코드·배포 설정·AI 실행을 변경하지 않았습니다. 일반 조회의 재생성 가능한 파생 색인 갱신은 서버의 기존 동작대로 발생했습니다. 우선 후속 검토 대상은 온톨로지 첫 색인 준비이며 이번 요청에서는 측정만 완료했습니다.

## 2026-11-06 — 영향 조회 1.2초 목표의 가능성 측정

- 운영 변경 없이 현재 계정의 loopback 읽기5회(모두200, 중앙값1527.597ms)와 별도 프로세스의 구문 재사용을 측정했습니다. 입력 관측/결과 hash가 같은3쌍에서 내부 query1415.207→1144.229ms, 쌍별 절감 중앙값265.949ms였습니다. HTTP/계측·영구 구문 자료 비용을 포함한 최적화 응답은 미측정이며 계획용 산술 추정은 약1.23–1.26초입니다. 첫 조회/본문 변경·동시 대기와 추가 여유는 남습니다.
- 공개 HTTPS 측정은 인증 정보를 보내는 공개 목적지의 구체적 승인이 없다는 자동 검토 거절로 실행하지 않았습니다. 외부 통신을 제외한 loopback 대안만 실행했고 서버 재시작·배포·권한/원문 변경이나 제품 회귀는 수행하지 않았습니다. 재현 수치·실험 경계와 D-032를 유지하는 후속 설계 조건은 [knowledge 기록](../knowledge/HISTORY.md#2026-11-06--영향-조회-12초-목표의-가능성-측정)을 따릅니다.

## 2026-11-06 — 검토 원장의 동일 값 검증 재사용

- 추가 개선 요청에서 실제 profile을 다시 확인했습니다. 링크 해석 조기 종료는 관측69개 본문 모두에 잠재 링크 구문이 있어 도입하지 않았습니다. production 수정은 `core/modules/reviews/ledger.py` 한 파일과 새 `core/tests/poc_knowledge/test_review_value_reuse.py`입니다. non-policy event의 동일한 target/before/after 값 검증을 이벤트 내에서만 성공 후 재사용하며 canonical bytes로 bool/int/float 및 승격/편집 차이를 구분합니다. 원장 전체 구조·hash/chain·전후 상태·정책·undo·cleanup·독립 관계·현재성/권한과 저장 절차는 유지합니다.
- 새7개 포함 관련49개·전체65모듈653개(96.916초)·독립 storage/MCP 검토·인계 mock17개가 통과했습니다. 최초 관련49개 중1개는 인용 없는 candidate promotion fixture가 기존 근거 검사에서 거절된 경우였고 실제 본문 인용을 추가한 최종 검사에서 통과했습니다. 원래 validator를 완화하지 않았습니다.
- 같은 고정6문서×40entity×39relation×8review·각5회 median은 review9.089→9.029ms, history73.674→72.554ms, impact55.633→50.461ms이며 수정 전 함수와 전체 DTO bytes/원본 동일을 확인했습니다. 실제 direct profile은1604.974→1549.152ms, `_check_saved_value`3441→1109회·누적316.320→111.600ms였지만 확보 문서21→22와 자료 시점이 달라 동일 고정 입력의 가속률로 해석하지 않습니다.

| API | loopback 전→후 중앙값(ms), 각5회 | HTTPS 전→후 중앙값(ms), 각3회 |
| --- | --- | --- |
| 통합 이력 | 888.010 → 828.119 | 1005.764 → 873.325 |
| 변경 영향 | 1528.782 → 1457.730 | 1555.926 → 1491.192 |

- 정상 로그인·현재 read/기본 profile·동일 문서 참조를 확인한 계정의 읽기 요청만 수행했습니다. 인증정보·응답 본문·실제 문서/사용자 ID는 보관하지 않았습니다. 자료와 부하를 동결하지 않았으며 이번 추가 이득은 소폭입니다. 최종22회(선택16+인접 작업 목록/상세·연결3+동시 목록/검토함/이력3)는 모두HTTP200입니다. 인증/발견 호출은 이 수에서 제외합니다. 동시3 묶음2032.326ms의 대기는 남으며 모든 부하에서2초 미만인 SLA는 아닙니다. 기존 한도·누락/부분 결과를 전체 자료 확보와 혼동하지 않습니다.
- 기존 터널62720·URL·auth/data/ruleset 설정과 tracking/metrics를 유지해 guardian43700/server43743으로 반영했습니다. 검증한273개 runtime source와 소유 코드 hash가 기동 전/최종에 같고 server/tunnel alive·이전 guardian 종료·status=updated·오류/잔여 없음도 확인했습니다. 수동 source 복구용 원본과 tracking-only 기동 fallback은 구분합니다. 설치 앱·운영 분석 쓰기는 수행하지 않았습니다.
- 근거: `.local/diagnostics/read-validation-20261106-63qnftw8/verification-summary.json`, 같은 경로의 회귀/초기 fixture 실패·benchmark·전후 summary/semantics·profile·독립 검토·동시/인접 API·rollout verification 및 `.local/deployments/2026-11-06-read-validation-q5gb1cvv/runtime.json`.

## 2026-11-06 — 2초 목표의 영향 조회 조립·메타정보 해석 재사용

- 사용자가 요청한2초 미만을 목표로 `reviews/{state,render,capture}.py`, `documents/metadata.py`, `knowledge/impact.py`를 수정했습니다. 기본 scope·정책 이력 부재에서만 동일한 source/current 그래프 조립을 공유하고 두 effective 검증을 유지합니다. 정책·독립 정책·과거/undo/다른 관점은 기존 source render를 유지합니다. 정책 이벤트가 없으면 이미 검증한 source 결과의 중복 복사를 생략합니다.
- Impact의 같은 root lock 안에서만 exact 원문+parser/loader/validator identity의 성공 메타정보 해석을 재사용합니다. 256개/입출력 인코딩16MiB, mutable metadata 사본, 실패/초과 bypass·owner thread·closed/clear/reset을 적용해 다음 요청/다른 thread/종료된 copied context로 자료가 넘어가지 않게 했습니다. 파일 I/O·권한·현재 source/원장/정책·인용/ID/좌표·CAS/전체 이력을 생략하지 않습니다.
- source-layer 새7개·metadata 새14개와 관련53개, 전체64모듈646개(97.649초)·독립 storage/MCP 검토·인계 mock17개가 통과했습니다. 초기 관련46개의2실패는 제거한 중복 snapshot/normalize 호출수 기대를 갱신했으며 필수 검증/원본/전체 DTO 동일을 재확인했습니다. 첫 진단 명령의 임시 폴더 경로 오타는 네트워크 실행 전에 실패했고 실제 생성 경로로 바로잡았습니다. 운영 자료로 쓰기 시험은 하지 않았습니다.
- 실제 읽기 전용 profile에서 metadata YAML 해석754→100회(전체 호출732회 중순수parse100회), 누적534.587→72.833ms를 관측했습니다. 직접 domain warm2239.456→1698.099ms였으나 자료와 예산 확보 문서 수가 바뀌었으므로 동일 고정 자료의 속도비로 해석하지 않습니다. 고정6문서의 정확한 수정 전 함수/예산에서 각5회 median review9.743→6.626, history75.563→56.672, impact59.723→39.179ms와 canonical DTO/원본 동일을 확인했습니다.

| API | loopback 전→후 중앙값(ms), 각5회 | HTTPS 전→후 중앙값(ms), 각3회 |
| --- | --- | --- |
| 통합 이력 | 1297.604 → 877.530 | 1162.935 → 939.509 |
| 변경 영향 | 2291.733 → 1580.045 | 2273.511 → 1614.657 |

- 반영 후 영향 loopback5회는1726.860/1560.788/1576.527/1580.045/1648.115ms, HTTPS3회는1644.103/1594.610/1614.657ms로8회 모두2초 미만입니다. 정상 로그인·현재 read/기본 profile과 같은 문서 참조를 확인했고 인증정보·응답 본문·실제 문서/사용자 ID는 보관하지 않았습니다. 자료/부하는 동결하지 않았으며 표는 현재 계정의 순차 관측이고 모든 부하에서의 SLA는 아닙니다.
- 최종 읽기22회(선택16+인접 작업 목록/상세·연결3+동시 목록/검토함/이력3)는 모두HTTP200이었습니다. 인증/발견 호출은 이 수에서 제외합니다. 동시3 묶음은2110.375ms, 각451.243/1888.112/2081.526ms로잠금 대기는 여전히2초를 넘길 수 있습니다. 이력의 capture/output limit와2000상한, 영향의 byte/scan 한도·ontology missing/review unavailable 등 부분 결과를 유지했습니다. HTTP200을 전체 이력·의미 영향의 완전성으로 해석하지 않습니다.
- 기존 터널62720·공개 주소·auth/data/ruleset 설정과 tracking/metrics를 유지해 guardian57294/server57347로 반영했습니다. 전체 검사 동안 runtime273파일은 변하지 않았고 기동 전/최종 소유 코드 hash와 현재 server/tunnel identity·이전 guardian 종료·status=updated·오류/잔여 없음도 확인했습니다. 최종 전체 runtime hash도 같았습니다. source 수동 복구본과 tracking-only 기동 fallback을 구분하며 설치 앱·운영 분석 쓰기는 수행하지 않았습니다.
- 근거: `.local/diagnostics/impact-under2-20261106-gt70l6ei/verification-summary.json`, 같은 경로의 회귀/표준 함수 benchmark·전후 summary/semantics·profile parse counters·동시/인접 API·독립 검토/rollout verification, `.local/deployments/2026-11-06-impact-under2-8cmvhtnl/runtime.json`.

## 2026-11-06 — 지도 전용 검색과 이웃 전송

- `POST /ontology/search`, `/ontology/neighbors`에 기존 read 인가·엄격한 JSON 입력/출력 스키마를 적용했습니다. `ontologySearch`/`ontologyNeighbors` operation을 기존 workspace IPC/웹 테스트 bridge와 `WorkspaceApiService` 고정 경로에 연결했습니다. main에서도 경량 응답을 검사해 전체 지식/임의 extra 필드 응답을 거부합니다. 현재 권한·선택/사용자·accessRevision 재확인을 재사용합니다.
- 격리 실제 ASGI 신규3개와 기존 지식 HTTP7개를 통과했습니다. 최종 웹 모드 전송 전체에서 지도 **11묶음**(스키마/입력·scope·접근 변경·늦은 응답·실제 web→main→HTTP cursor)을 포함해 기존 회귀를 확인했습니다. SQLite 불가503/기존 canonical 보존/접근 철회 후 캐시 전403은 지식 도메인의110개 검증에 포함됩니다.
- 재현 UI fixture는 `app/tests/ontology-exploration/run.mjs`/`server.py`입니다. 고유 임시 루트와 임의 loopback 포트의 실제 renderer/main/API로3문서·29직접관계·속성·후보·한정어·문서별 동명을 검증합니다. 최초 준비 자체 검사에서 색인을 만들므로 cold 구축 성능 근거로 사용하지 않습니다. 설치/운영/공개 HTTPS·Windows 검증은 수행하지 않았습니다.

## 2026-11-06 — 검토 응답의 복사 비용 감축

- 사용자 추가 개선 요청에서 검토 응답 복사 비용에 한정해 `core/modules/reviews/values.py`, `render.py`, `cleanup_state.py`를 수정했습니다. JSON 컨테이너만 복사하고 불변 값/키를 즉시 재사용하며 호출별 memo·기존 타입 fallback으로 mutable 분리·공유/cycle을 보존합니다. 기존 업무 함수19개는 복사 이름을 정규화하면 AST가 같으며 전체 원장·정책·근거·현재성·effective 두 번 검증을 유지합니다. 테스트는 새 `test_review_copy.py`와 보존 fixture의 정확한 루트 잠금 파일 구분만 추가했습니다.
- 새6개 포함 핵심23개, 보존/관계/journal 관련83개·독립 검토·인계 helper17개가 통과했습니다. 최초 손상 그래프 시험은 빈 envelope가 문서 ID 보호에서 먼저 거절되는 fixture 오류였고 ID를 보존한 손상 근거로 고쳐 확인했습니다. 초기 전체608개에서는 병행 ontology/review publication intent 변경 때문에 잠금 journal까지 보존 스냅샷에 들어간5개가 실패했습니다. 원래 표준 copier에서도 같은5개를 재현한 뒤 `.storage.lock` 하나만 coordination metadata로 구분했습니다. 실제 wiki·전체 history·graph·review/cleanup/relations 원장은 계속 bytes 비교합니다. 최종 전체62모듈621개(102.081초)는 실패/오류0입니다.
- 전체 검사 중 병행 변경된 `core/api/errors.py`와 `core/modules/knowledge/ontology_exploration.py`는 관련 도메인/HTTP18개를 추가 확인하고 기동 직전 runtime273개 파일 hash를 검증했습니다. 기동 뒤 별도 작업에서 exploration 파일이 다시 바뀐 것은 최종 전역 디스크 검사에서 감지해 `rollout-verification.json`에 별도 기록했습니다. 이번 소유 파일의 hash와 기동 시 검증 기준, 운영 중 응답 확인을 구분하며 다른 작업의 파일을 덮어쓰거나 재배포를 반복하지 않았습니다.
- 첫 비교 측정은 짧은 prototype CPU 실험과 겹쳐 `before-prototype-overlap`로 보존하되 비교에서 제외했습니다. 다음 순차 기준16회와 반영 후16회를 비교했습니다. 정상 로그인·현재 read/기본 profile을 같은 계정으로 확인하고 같은 문서 참조를 사용했으며 토큰·응답 본문·실제 자료/사용자 ID는 저장하지 않았습니다.

| API | loopback 전→후 중앙값(ms), 각5회 | HTTPS 전→후 중앙값(ms), 각3회 |
| --- | --- | --- |
| 통합 이력 | 1491.407 → 1234.042 | 1756.083 → 1316.067 |
| 변경 영향 | 2749.705 → 2665.910 | 2800.202 → 2492.020 |

- 반영 후 선택 조회16회+인접 작업 목록/상세·연결3회+동시 목록/검토함/이력3회, 최종22회가 모두HTTP200이었습니다. 동시 묶음은2887.715ms입니다. 이 수는 인증/발견 호출을 제외합니다. 자료·실행 부하는 동결하지 않았으므로 앞선 라운드 수치나 고정 자료의 순수 가속률/SLA와 동일시하지 않습니다. 특히 영향의 loopback 추가 이득은 작았습니다. 원래 capture/출력·스캔/바이트 한도와 missing/unavailable 등 부분 결과는 유지하며 HTTP200을 전체 자료 확보로 해석하지 않습니다.
- 고정6문서 fixture에서는 각5회 review12.379→9.875ms, history90.727→81.731ms, impact75.606→60.551ms이고 DTO bytes/원본 불변을 확인했습니다. 실제 전체 자료의 검토 조립·미적용 모듈의 깊은 복사·잠금 대기 비용은 남습니다.
- 기존 터널62720·공개 URL·auth/data/ruleset 설정과 tracking/metrics를 유지해 guardian91807/server91851로 반영했습니다. 이전 guardian 종료·status=updated·오류/잔여 프로세스 없음과 현재 server/tunnel identity를 확인했습니다. source 수동 복구본과 tracking-only 기동 fallback은 구분합니다. 운영에서는 원본 쓰기·분석 실행·설치 앱 교체를 수행하지 않았습니다.
- 근거: `.local/diagnostics/review-copy-20261106-r_xls09e/verification-summary.json`, 같은 경로의 최종/초기 회귀·표준 copier 재현·관련18개 검사·전후 summary/semantics·benchmark·독립 검토·rollout verification, `.local/deployments/2026-11-06-review-copy-y58tg0o7/runtime.json`.

## 2026-11-06 — 통합 이력과 변경 영향의 반복 검증 감축

- 사용자가 지정한 통합 이력(앞선 측정2151.850ms)을 남은 변경 영향 조회와 함께 개선했습니다. 정상 로그인 API로 같은 계정의 현재 허용 공간/기본 관점·read 권한을 확인했고 이력/영향의 개선 전16회와 반영 후16회, 인접 API3회·동시3회만 읽기 전용으로 측정했습니다. 인증정보·응답 본문·실제 문서/사용자 식별자는 보관하지 않았습니다.
- 병목은 tenant 이력 발견의 모든 개인 작업 상세 결과 조립과, 영향 조회의 동일 machine graph/전체 ledger 반복 검증이었습니다. 이력은 D-102의 소유 이벤트 전용 경로로 분리하고 문서/대응 전체 capture·기존 예산은 유지했습니다. 영향은 exact root/document/source content+revision/raw graph/raw ledger/history 관측을 immutable bytes로 재사용하며 정책 on/off render·effective 두 번·현재 독립 관계와 다른 문서 대조는 유지했습니다. 기본 목록/상세 API의 검증은 그대로입니다.
- 공통 회귀58모듈587개(91.342초)와 별도 영향12개, 총599개가 실패/오류 없이 통과했습니다. 담당의 이력54개·기존 영향40개는 이 수와 중복되므로 합산하지 않습니다. 격리 정상 DTO/canonical bytes·cursor/소유/손상/한도·현재성·원본 불변과 독립 검토, 인계 helper mock17개도 통과했습니다. 보조 profile 도구는 첫 파일명이 Python 표준 모듈과 충돌해1회 실패했으며 이름 변경 후 정상 측정했습니다. 서비스 API 오류가 아니었습니다.

| API | loopback 전→후 중앙값(ms), 각5회 | HTTPS 전→후 중앙값(ms), 각3회 |
| --- | --- | --- |
| 통합 이력 | 2796.007 → 1119.983 | 2498.523 → 1230.337 |
| 변경 영향 | 3459.009 → 2640.563 | 3430.451 → 2735.538 |

- 같은 계정/주소·동일 선택 문서 참조를 사용했지만 실행 중인 작업과 자료를 동결하지 않았습니다. 이력 total_items는 개선 전781–799, 개선 후2000상한이며 앞선2151.850ms와도 측정 시점이 다릅니다. 따라서 표는 실제 관측값이며 동일 고정 자료의 순수 가속률/SLA로 해석하지 않습니다. 고정 격리 fixture에서는 실제 저장6작업50.847→35.732ms·상세/결과/입력 조립 제거,20문서 영향189.800→146.198ms·machine61→21/ledger40→20회와 DTO 보존을 확인했습니다.
- 최종 timed22회는 모두HTTP200입니다(인증/발견 호출 제외). 작업 목록·상세·문서 연결도 정상이었고 동시 목록/검토함/이력3회 묶음은2519.922ms, 각427.017/1636.077/2490.328ms였습니다. 이력의 capture/output limit, 영향의 byte budget·scan incomplete·ontology missing/review unavailable 상태는 그대로 알립니다. HTTP200을 전체 이력/의미 영향의 완전성으로 해석하지 않습니다. 자료 확대에 따른 검토 조립·깊은 복사와 저장 잠금 대기는 남습니다.
- 기존 터널62720·공개 HTTPS 주소와 auth/data/ruleset 설정을 유지한 채 guardian61406/server61455로 교체했습니다. 최종 status=updated, tracking/metrics=true, 이전 guardian 종료, 오류/잔여 프로세스 없음과 현재 PID identity를 확인했습니다. 수동 source 복구용 원본은 새 RUN/rollback에 보존합니다. 수동 source 복구와 tracking-only 기동 fallback은 구분하며 자동 자료 이관/원본 수정은 없습니다. 새 서버 로그에서 실제 MCP POST의 상태200이97회, 상태202가4회였고 HTTP5xx 없음도 수동 점검 시점에 확인했습니다. readiness의 비인증GET/mcp401은 예상한 검사입니다.
- 근거: `.local/diagnostics/history-impact-20261106-cuzgm50v/verification-summary.json`, 같은 경로의 전후 summary/semantics·동시/인접 조회·회귀 로그·독립 검토·rollout verification 및 `.local/deployments/2026-11-06-history-impact-olhi1y71/runtime.json`. 이번에는 설치 앱을 교체하지 않았습니다.

## 2026-11-06 — 실계정 재측정과 조회 반복 계산 개선

- 사용자가 알려준 이름으로 기존 서버의 정상 로그인 API를 사용하고 현재 허용 tenant/default profile/read 권한을 확인했습니다. 토큰은 프로세스 메모리에서만 사용했으며 응답 본문·실제 문서/사용자 ID는 진단 산출물에 저장하지 않았습니다. 기존 옛 자격 증명의401을 다른 계정으로 우회하지 않았습니다. 문서가 source 항목 뒤에 있어 정상 cursor4페이지로 현재 문서 참조를 찾았습니다.
- 반복 조회에서 목록 metadata보다 상세 투영·검토 계산이 오래 걸렸습니다. 실제 이력의 읽기 전용 profile은 작업 project167회(발견154+사용13), 입력 load862회와 경로 확인11,702회를 관측했습니다. 이를 근거로 기대 진단 schema bytes 생성, render별 entity identity, 한 summary의 immutable input load, 한 tenant history의 성공 job 관측을 재사용했습니다. 정책/원문/hash/receipt/basis/소유 검사는 유지하고 실패/overflow는 기존 경로입니다. 교차 요청의 mutable 자료나 권한 판단은 캐시하지 않았습니다.
- 중간 전체559개에 이어 마지막 입력/이력 보완 후 **57모듈581개 PASS**,88.469초였습니다. builder/입력 cache key·상한·실패·caller 오염,8 DTO/해시·복합 오류 순서,이력 cursor/한도/부분 실패/접근 변경을 검증했습니다. 독립 검토의 병렬 순수 schema32회·claim64개와 입력 closure/tenant 요청 분리도 통과했습니다. Mac 런처 검사1건의 기대 인자를 이미 추가된 추적/계측 옵션에 맞췄습니다. 기존 웹 통합 통과 이후 앱 코드는 변경하지 않았습니다.
- 동일 계정의 순차 반복5회 중앙값(추가 계산 보완 전→최종, loopback)은 작업 목록 **341.387→203.455ms**, 작업 상세 **25.087→17.631ms**, 대조 상세 **571.594→483.156ms**, 검토함 **841.419→777.883ms**, 통합 이력 **2580.952→2151.850ms**입니다. 최종 문서 목록13.244ms·원본 목록7.002ms, 기존 HTTPS 문서/원본 목록은3회 중앙값60.108/60.296ms였습니다. 진행 중 분석과 부하가 달라 고정 snapshot·SLA 비교는 아닙니다.
- 문서 내용/이력/지식/기계층/연결/영향도 확인했습니다. **변경 영향3144.947→3448.538ms, 연결663.280→710.552ms로 이 경로의 시간 개선은 확인하지 못했습니다.** 최종 HTTPS 영향3427.692ms로 큰 범위 그래프/검토 집계는 남은 비용입니다. 현재 저장/관측 계약에 묶인 별도 계산 인덱스는 다음 범위로 남깁니다. pagination/원장 바이트 한도에 따른 complete/truncated/skipped를 유지했고 HTTP200을 전체 자료 포함으로 해석하지 않습니다.
- 최종 순차96건과 동시3건의 **측정99건 모두 HTTP200**입니다. 동시 작업 목록/검토함/통합 이력은393.478/1296.690/4361.799ms, batch4391.526ms로 시간 초과는 없었으나 대기/집계 비용이 커집니다. 사전 보조 문서1건은 측정 도구의 유휴 HTTP/1.1 연결 재사용으로0.088ms RemoteDisconnected였고 서버 응답 오류와 구분했습니다. 같은 문서와6초 유휴 GET을 새 연결로 재확인해200 및1회 재접속을 확인했으며 최종 도구는 읽기 GET에만1회 재접속합니다.
- 검증한 source6파일과 원본 복구 사본을 준비한 뒤17개 mock 검사·실제 identity 재확인으로 서버를 갱신했습니다. 최종 guardian19848/server19891, 기존 tunnel62720·HTTPS URL·인증/자료/규약·추적/계측 설정 유지, 상태updated·잔존/복구 오류 없음입니다. 실제 사용자 원문/이력/판단의 시험 쓰기·자동 이관·AI 시험 호출은 하지 않았습니다.
- 최종 상태/복구 준비는 `.local/deployments/2026-11-06-read-cpu-final-rxl3mykl/`, source 원본·격리 비교는 앞 CPU RUN의 `rollback/`·benchmark JSON, 전체 회귀/실계정 전후 측정/profile은 `.local/diagnostics/api-cpu-20261106-d1b68upp/`에 보존했습니다. 사전 실계정 측정은 이전 SQLite stage2의 `authorized-live-f8yjva2e/`에 남겼습니다. 계정 이름 확인 대기는 해소됐습니다.

## 2026-11-06 — 변경 기록·계측과 현재 서버 반영

- [D-101](../documents/DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06)의 common 변경 원장/관측·저장 훅과 문서/원본/작업/이력 조회를 연결했습니다. HTTP `--tracked-read-index`는 관리 writer 환경의 명시 모드이고 기본은 전체 검사입니다. `--read-metrics`는 route template·상태·시간·고정 단계/건수·복귀 사유만 기록하며 본문/토큰/실제 경로/사용자·tenant ID는 남기지 않습니다. 인증·잠금 대기/보유·탐색·파일 읽기·SQL·투영을 실제 구간에서 측정하며 단계 합계는 중첩될 수 있습니다.
- 전체 core **53모듈541개 PASS**, 약98.5초. 이후 추적 HTTP/MCP 쓰기·warm 반영·권한 회수403 통합1개를 추가하고 문서 추적 파일13개를 재통과했습니다(추가 테스트만 변경, 전체 반복 없음). 전용 계측12개는 동시 요청/스레드 격리·예외/취소/stream 보존·민감정보 없음·계측 실패 무영향을 포함합니다. Python 생산18파일 AST·diff whitespace도 통과했습니다.
- 웹 통합은 처음 PATH의 Node16 때문에 Vite import 전에 중단됐고, 확인된 Node24.22.1의 절대 실행 경로로 동일 검사에 재진입해 웹24·파일 경계14·파일 UI12묶음·취소4·원본 무결성13·상세9·복원21·기본 읽기9묶음이 통과했습니다. 임시 fixture만 사용했습니다.
- 독립 검토에서 최초 빈 원장 기준의 chain loss와 저장/정리 실패 후 임시 파일 잔존 시 탐색 한도 차이를 재현했습니다. bound lock inode/stamp와 변경 문서의 상위 이름 대조, 구형 원본 registry 변경의 전체 검사로 보완하고 독립 재현 두 건·전용 회귀를 통과했습니다. 원문/전체 이력/작성 원장을 보존했으며 실패 intent에 따른 lockfile 변경만 기존 보존 기대에 반영했습니다.
- 같은 응답의 격리 warm5회 중앙값(기본 인덱스→추적): 작업80/페이지20 **33.972→20.777ms**, 원본 metadata100×30판본/페이지20 **25.329→2.946ms**, 문서500/페이지20 **11.241→9.633ms**, 보관 판본59/페이지20 **4.820→4.906ms**. 이력은 시간 이득을 확인하지 못했습니다. 네 경로 모두 warm 전체 탐색 건수0이며 선택 페이지 현재 원문 검사는 유지합니다. 이력 본문은약203KiB로 기존192KiB 표기는 정정합니다. 초기 구축·운영 자료·네트워크/UI의 속도 보장은 아닙니다.
- 운영 교체 helper의 identity/후보/복구/준비 확인15개 mock 검사를 통과한 뒤 실제 PID/시작 시각/명령·현재 정책과 lock2개의 private/regular를 재확인했습니다. 이전 감시자62699·서버62705를 교체하고 터널62720과 HTTPS 주소를 유지했습니다. 새 감시자72123/서버72168, 추적/계측 활성화, 상태`updated`, 복구/잔존 오류 없음입니다. 인증/자료/규약 설정은 유지했고 Mac 런처에도 두 옵션을 연결해 구문/도움말을 확인했습니다. 서버 반영에서 사용자 원문을 이관·정리하거나 AI를 시험 호출하지 않았습니다.
- loopback 및 기존 HTTPS `/mcp`의 정상 인증 보호401을 확인했습니다. 반영 후 실제 클라이언트의 MCP200·작업 heartbeat200도 개인정보 없는 로그에서 관측했습니다. 옛 보관 토큰의401은 우회하지 않았으며 현재 앱 계정 이름을 질문했습니다. **현재 계정의 목록/상세를 직접 반복 측정하는 일은 대기 중**이며, 상세 계산 캐시 등의 다음 범위는 그 결과로 선택합니다.
- 실행 상태/복구 준비물은 `.local/deployments/2026-11-06-read-index-ie8cretj/`, 회귀·웹·격리 측정·readiness·실제 익명 집계는 `.local/diagnostics/sqlite-stage2-20261106-t5t8diam/`에 보존했습니다. 실제 로그는 계속 늘 수 있으며 기록 시점 이후의 클라이언트 호출과 구분합니다.

## 2026-11-06 — SQLite 조회 인덱스 1단계 통합 검증

- [D-100](../documents/DECISIONS.md#d-100--원문을-보존하는-sqlite-조회-인덱스-1단계-2026-11-06)의 공통 `core/common/read_index.py`와 문서/원본/개인 작업/보관 판본·통합 목록을 연결했습니다. Python 표준 sqlite3, workspace별 `_index/read.sqlite3`, WAL/FULL·짧은 busy 한도와 request별 연결을 사용합니다. 원본 자료·권한·CAS·공개 API/cursor는 유지합니다. SQLite/경로/스키마 오류만 기존 조회로 복귀하며 미확인·손상 DB는 보존합니다.
- 공통27개, 문서7개, 원본14개, 작업18개의 전용 검사를 포함해 격리 자료의 cold/warm/변경·부분 실패·scope·busy·DB 손상·symlink·원본 보존을 검증했습니다. 안전한 bulk lookup과 요청 안 원본 관측값 재사용, 변경 없는 sync의 SELECT-only 경로를 추가해 초기 캐시 구현의 반복 SQL/파일 검사 비용을 줄였습니다. 독립 검토에서 발견한 이력 연결 종료의 fallback 누락과 작업 복합 손상의 오류 순서를 보완하고 재현했습니다.
- 전체 core 회귀는 처음 465개가 통과했고, 최종 생산 코드로 48모듈477개를 실행한 결과 476개 통과/실패1/오류0이었습니다. 실패는 SELECT-only warm 조회가 writer 잠금 중에도 성공하는데 기존 busy 테스트가 fallback을 기대한 1건입니다. 테스트만 보완한 뒤 작업18+MCP8+foundation busy/no-op2개, **관련28개가 모두 통과**했습니다. 생산 코드 추가 변경은 없으며 수정 후 전체477개를 다시 실행하지 않았습니다.
- `npm run test:web:verify`의 웹 모드24·파일 경계14·파일 UI12묶음·취소4·원본 HTTP 무결성13·상세9·메모리 복원21·기본 읽기9 검증이 통과했습니다. 변경 Python 구문·diff whitespace 검사도 통과했습니다. 모두 격리 서버/fixture이며 실제 AI 호출은 없었습니다.
- 같은 응답임을 대조한 warm3회 중앙값은 작업80/페이지20 **47.111→29.673ms**, 원본 카탈로그 metadata100×30판본/페이지20 **101.242→24.821ms**, 보관 판본59×192KiB/페이지20 **5.188→4.541ms**입니다. 초기 구축 시간·운영 자료·실제 네트워크/UI 응답 속도 보장은 아닙니다. 파일 metadata 탐색 O(N), 원본 목록 변경 시 기존 전체 hash 계산은 남아 있습니다.
- 근거 로그·측정값은 로컬 `.local/diagnostics/sqlite-stage1-20261106-zf455g1q/`에 보존했습니다. 운영 데이터·실행 서버·Quick Tunnel·설치 앱·연결 설정은 변경하지 않았습니다. 다음은 운영 반영 뒤 실제 목록/상세 응답 재측정입니다. FTS·검토/영향 사전 계산·영구 변경 대기 원장은 후속 범위로 남겼습니다.

## 2026-11-06 — 전체 HTTP API 경계와 조회 성능 점검

- 현재 OpenAPI의 HTTP 112개(GET48/POST62/PUT2)를 기준으로 점검했습니다. 전수 인증 누락·무효 토큰·권한 회수·필수 입력 누락/없는 자원 448건에서 예상 불일치와 예상외5xx가 없었습니다. 공개 로그인/가입의 빈 입력422, 자기 접근정보200과 tenant 권한403은 구분합니다.
- **정상 HTTP 성공112/112**: 기존 격리 회귀48개, 기존 허용 자료의 고유 읽기35개에서 추가18개, 기존 fixture를 재사용한 추가 격리 흐름56개에서 추가46개입니다. 최소 한 정상 요청의 성공 커버리지이며 모든 입력·상태·의미 정확성을 뜻하지 않습니다. 추가 흐름77요청 중76건2xx, 구형 관계 fixture의 엄격한 v3 필드 누락422 한 건은 성공에서 제외하고 유효 입력으로 결과 연결200을 다시 확인했습니다. 이 과정에서 운영 쓰기·실제 AI 호출은 없었습니다.
- 기존 격리 회귀 **408개 통과**. 최초 실행405PASS+계측 loader의 상대 import 오류2개+로컬 포트 차단1개였으며, 세 항목만 canonical module/허용된 실행에서 재통과했습니다. 실제 localhost HTTP/MCP SDK·stdio 연결도 확인했습니다. 전체 suite를 불필요하게 반복하지 않았고 정상 HTTP 추가 흐름을 회귀 test 개수에 더하지 않았습니다.
- 기존 허용 tenant/profile의 읽기45건은 수정 전후 모두200이었습니다. 변경 코드의 ASGI 측정에서 개념 검색7.561→2.746초, 변경 영향7.693→2.403초, 공간 검토함4.329→2.430초, 공간 전체 이력11.410→4.278초, 지식 대조 상세2.775→0.451초를 관측했습니다. 운영 자료는 별도 분석으로 계속 추가되므로 고정 snapshot·SLA·반복 통계로 해석하지 않습니다. `truncated`·`skipped`·`complete`를 유지하며 일부 결과200을 전체 조회 완료로 간주하지 않습니다.
- [검토값 검사](../reviews/HISTORY.md#2026-11-06--검토-조회에서-동일한-기계-주장의-중복-검사-감축)와 [이력 원장 읽기](../documents/HISTORY.md#2026-11-06--이력-목록의-반복-원장-읽기-개선)의 중복을 줄였습니다. 수정 후 지식108+저장/HTTP/MCP60, **관련168개 통과**(기존 suite와 중복, 신규 회귀3개 포함). 독립 검토에서 발견한 복합 손상 시 오류 순서 회귀도 보완하고 재현했습니다. 현재 코드4파일 AST와 diff whitespace 검사도 통과했습니다.
- 원자료: [전체 요약](../../../.local/diagnostics/api-20261106-5a26wjkt/summary.json), [112개 경로별 정상·경계 근거](../../../.local/diagnostics/api-20261106-5a26wjkt/contracts/combined-success-coverage.json), [추가 정상 흐름](../../../.local/diagnostics/api-20261106-5a26wjkt/contracts/additional-success-summary.json). 출력에는 인증 헤더·토큰·요청/응답 본문을 넣지 않았습니다. 원래 임시 실행 경로는 기록의 재현 명령/trace에 남고 산출물은 이 로컬 진단 폴더에 보존합니다.
- 운영 원문·과거 이력·인증/정책·앱/서버·Quick Tunnel을 변경하지 않았습니다. 쓰기·stale·부분 결과는 격리 ASGI/업무 회귀로 검증했으며 공개 HTTPS·실제 TCP 쓰기·Windows·실제 모델·변경 앱 화면은 별도 미검증입니다. 운영 서버/설치 앱 반영 후 실화면 재확인이 남아 있습니다.

## 2026-11-06 — 입력 검증과 요청 조립의 복잡도·보일러플레이트 감축

- `core/mcp/validation.py`는 도구별 반복 if를 필드/필수·optional·nullable/검사 함수/기존 오류문구의 순서표로 통합했습니다. compact→cleanup→concept→correspondence→일반 필드→qualifiers 순서와 원래 JSON 타입·첫 오류·text 응답의 키 순서를 유지합니다. 새 helper를 포함한 모듈 결정점 **145→116**, 최대 함수 점수 **72→44**, 최대 제어 중첩 **4→3**입니다. `validate_raw_arguments` 자체는 **72/깊이4→12/깊이2**이며 분기를 옮긴 양과 전체 감소를 구별합니다.
- `WorkspaceApiService.ts`는 59개 operation의 메서드·고정 경로·경로 식별자·GET query 키·POST 본문 제외 키·권한을 타입이 검사되는 선언표에 모았습니다. 별도 계층·실행 코드 생성 없이 같은 파일에서 조립합니다. 파일 결정점 **142→81**, 최대 함수 **62→44**(route62→7, execute51→44), 제어 중첩 최대8 유지이며 **714→593물리줄**, 23,742→20,944바이트입니다. profile 전달·허용 범위·응답유실·영수증/현재 권한 확인은 그대로입니다.
- 검토 HTTP의 같은 json_operation/인가/업무 호출 조립 **4곳→1곳**을 `core/api/v1/reviews/router.py`에서 재사용합니다. 공개6경로의 signature/decorator와 before_commit 재인가 순서는 동일합니다. Python 생산2파일은21줄, 정상/실패 회귀2파일은179줄 늘었습니다. 이 변경을 총줄수 감소로 세지 않습니다.
- 동일 AST 규칙으로 조건문·반복/예외·조건식·단락 논리연산을 세고, 모듈 합계는 함수 기본값1을 제외합니다. 중첩 함수는 따로 세며 새 helper도 범위에 포함합니다. 언어별 전후 비교용 근사 분기 지표이며 공식 Sonar/Radon 인지 복잡도 점수가 아닙니다.
- 검증: 57개 도구 이름에 대한 **105,385건**의 누락·null·원래 타입·복수 오류를 시작 snapshot과 structured result/text 키 순서/예외까지 대조해 모두 동일했습니다. MCP 전체 **90개**(기존79+신규11), core309파일 AST가 통과했습니다. API 59개 operation의 입력옵션·권한·성공/HTTP 실패·응답 scope 불일치·연결 변경·응답유실과 관계 권한 **1,241건**에서 요청 URL/메서드/headers/body와 공개 결과 차이가 없었습니다. 전체 타입/lint/format, 기존 웹 모드8묶음과 실제 Electron 검토함 HTTP 회귀도 통과했습니다. 일부 fixture의 runtime/update handler 미등록 로그는 PASS/exit0과 구별합니다. 최종 앱 빌드·화면 회귀/전체 계수는 [통합 기록](../workflow/HISTORY.md#2026-11-06--분기-복잡도와-반복-조립-감축)을 따릅니다. 운영/설치 앱·실제 모델·저장 정책·권한 계약은 변경하지 않았습니다.

## 2026-11-06 — 실행 감독·HTTP·프로세스 경계의 구조 정리

- `core/client/supervision.py`에 질문·추출안·lease의 작업/감시 경쟁과 task 회수를 **3곳→1곳**으로 모았습니다. 취소/호출자 실패 신호→감시 실패→모델 결과의 기존 우선순위를 유지하며 저장 응답을 확인해야 하는 heartbeat는 끝까지 기다립니다. `question.py`·`proposal.py`·`ai/lease.py`는 업무별 상태와 오류를 소유합니다. 새 감독 회귀는 동시 완료·관찰자 실패·외부 취소·중첩 lease 회수·마지막 heartbeat CAS 응답을 확인합니다.
- `source_conversion_report.py`는 파서가 맡던 누적·한도·checkpoint를 소유합니다. 기본 보고 구조 **2곳→1곳**, 중단 시 미독 꼬리 조립 **3곳→1곳**으로 통합했고 기존 class/상수/예외 import 경로는 alias로 유지했습니다. core 생산 5개 파일 수정·공통 2개 파일 추가로 **1,934→1,951물리줄(+17)**이며 기존 5개 파일 자체는 100줄 줄었습니다. 신규 회귀 2파일/286줄을 추가했습니다.
- 앱 `readApi.ts`·`personalProcess.ts`와 사용 서비스 11개에서 scoped HTTP **3곳→1곳**, 제한된 UTF-8 JSON 수신 **3곳→1곳**, 예상 범위 비교 **9곳→1곳**, JSONL 파싱 **2곳→1곳**, close→저널/인증 정리→running 해제 **4곳→1곳**, 같은 런타임 경로 해석 **3곳→1곳**으로 모았습니다. GET/POST의 profile 전달 차이, 서비스별 schema/문구, 쓰기 응답 유실의 outcome_unknown과 요청 ID 보존은 유지했습니다. 생산 13파일은 **7,292→7,128줄(-164)**, 250,635→245,387바이트입니다. 경계/비교 테스트는 389줄 늘었습니다.
- 검증: analysis **144개**·knowledge **107개**, 고유 **251개 통과**(새 감독·보고 회귀 17개 포함). 기존 snapshot 구현과 7형식의 결과·전체 checkpoint **49개 경우가 canonical JSON 바이트로 동일**했습니다. core 307파일 AST도 통과했습니다. 앱 session-runtime 기본(native 창 숨김/종료·취소·제공자 연결 포함), 웹 조사, 새 HTTP/프로세스 경계, knowledge-comparisons 전체 회귀와 관련 별도 TypeScript 검사를 통과했습니다. 부모의 전체 앱 검사/빌드와 웹 모드 24개·파일 왕복/경계 14개·파일 UI 12묶음·브라우저 취소 4묶음·원본 HTTP 무결성 13개·원본 상세 9개·메모리 복구 21묶음·기본 조회 9묶음도 통과했습니다.
- 경계 검토에서 동기 cleanup 예외도 원래처럼 정리 경고로 처리하도록 Promise 경계를 보완하고 회귀를 추가했습니다. JSON 크기 초과 후 reader.cancel 실패가 원래 오류를 덮지 않음도 확인했습니다. 기존 비교 fixture의 필수 `next_cursor` 누락/요청 cursor 차이는 시작 전 source에서도 동일 실패가 재현된 뒤 fixture만 현행 계약으로 보완했습니다. 운영 자료·권한·CAS·전체 이력·프롬프트·스키마, 실제 모델/계정과 설치 앱은 변경하지 않았습니다. 최종 UI/채팅 검증과 전체 계수는 [통합 기록](../workflow/HISTORY.md#2026-11-06--반복-구현과-화면실행-책임의-구조-정리)을 따릅니다.

## 2026-11-05 — 전체 프로젝트 core·도구·실행 코드 정리

- core 303개 Python 파일의 참조와 호환 진입점을 확인하고 22개 파일을 정리했습니다. 사용하지 않는 import 17개와 공통 검사 통합 후 불필요해진 import 4개를 제거했습니다. 저장 직전 인가 callback 3곳→1곳, JSON 객체 파싱 2곳→1곳, MCP 모델/UTF-8 바이트 검사 2곳→1곳으로 모았습니다. 변경 파일은 4,215→4,184물리줄입니다. 저장·권한·CAS·전체 이력·정리 실패의 의미와 호환 wrapper/동적 실행 진입점은 유지했습니다.
- `tools/cli_io.py`에서 6개 개인 CLI의 AI 인자·JSONL·signal/stdin 취소 처리를 재사용합니다. 분석·대조의 Task 취소와 질문·추출안의 Event 취소를 구별합니다. `comparison_cli.py`가 다른 CLI의 비공개 함수를 가져오던 의존성을 제거했습니다. 앱의 `personalProcess.ts`는 검색어 제안·웹 조사·첨부 읽기의 제한된 UTF-8 출력, 시간 제한, 중단을 `runPersonalCommand`로 모았습니다. 실제 앱·설치·진단·서버에서 사용하는 도구 진입점 17개는 유지했습니다.
- 사용하지 않는 공유 타입 export 14개와 생성 토큰 export 3개를 제거하고 생성기를 수정했습니다. 토큰 값 194개×2모드는 유지했습니다. 생성 `tokens.ts`를 제외한 도구/main/계약/생성기 생산소스는 19→20파일, 4,754→4,671물리줄입니다. `jotai`는 유일한 사용처인 미사용 Provider 정리 뒤 package/lock/설치 모듈에서 제거했고, lock의 다른 패키지 항목은 동일했습니다.
- core 회귀 **344개**(storage 37·MCP 79·analysis 121·knowledge 107), 새 공통 CLI 검사 **6개**, 개인 CLI 6종 `--help`, session-runtime 기본/웹 조사·실제 Electron 종료 수명·첨부 통합을 통과했습니다. 개인 실행기 소스 허용 목록 284개에 공통 CLI가 포함되고 테스트는 제외됨을 확인했습니다. MCP loopback 1건은 로컬 포트 제한 때문에 승인된 실행에서 다시 통과했고 analysis 상대 import 2건은 dotted module 실행으로 통과했습니다.
- 앱 전체 타입·lint·format·토큰 검사와 main/preload/renderer 제품 빌드가 통과했습니다. 생성 토큰에 formatter가 적용되어 생긴 초기 일치 검사 실패는 원본 생성기로 재생성해 해결했습니다. CSS Modules 공통화의 PostCSS 경고는 UI의 Sass mixin 공유로 해결했습니다. 실제 모델 재호출·운영 서버 재시작·설치 앱 교체·Windows 실기기 검사는 수행하지 않았습니다. 파일 정리의 계수·보존 근거와 최종 통합 결과는 [전체 작업 기록](../workflow/HISTORY.md#2026-11-05--전체-프로젝트-코드와-불필요-파일-정리)을 따릅니다.

## 2026-11-05 — 웹 조사 결과 검사 코드 정리

- `app/src/main/backend/webResearch.ts`에서 CLI 결과 파싱/검색어·중복 URL·본문 지문 검사를 실행/중단/임시 폴더 수명과 분리했습니다. 출력·AI 실행·프로세스 시간 한도를 이름 있는 상수로 모으고 중복 URL/지문을 같은 순회에서 검사합니다. 기존 입력/출력과 실패 상태·보호 경계는 유지합니다.
- 기존 `node tests/session-runtime/run.mjs --web-search` 통과: 실제 하위 프로세스의 Unicode/한도, 지문 변조·다른 검색어·중복·비공개 URL 거부, 중단과 임시 폴더 정리를 재확인했습니다. 앱 전체 빌드/검사도 통과했습니다. 실제 모델·운영 서버·계정 설정·설치 앱은 이번 정리에서 변경하지 않았습니다.

## 2026-11-05 — 개인 웹 조사와 고정 답변 연결 (D-099)

- 변경: `client/ai/codex.py`·`claude.py`에 기본 해제된 별도 웹 검색 실행을 추가하고 `client/web_research.py`·`tools/web_search_cli.py`에서 검색 완료 관측→공개 페이지 직접 읽기→원문 hash/시각을 연결했습니다. 앱은 `webResearch.ts`, 질문 실행 서비스/IPC, 공용 web/question/workspace 계약·bridge·renderer gateway·웹 테스트 전송을 재사용합니다. 기본 브라우저는 검증한 출처 링크의 명시 클릭으로만 엽니다.
- 검증: 웹 조사·이벤트/실행 옵션·기존 어댑터/세션 회귀 40개 통과. 실제 하위 프로세스를 사용하는 `node tests/session-runtime/run.mjs --web-search`에서 Unicode·본문 hash 변조·다른 검색어·중복·비공개 URL 거부·중단·임시 폴더 정리를 확인했습니다. DNS의 혼합/사설 응답, 검증한 IP로 연결/TLS 원래 호스트 검사, 리다이렉트·크기/시간·부분 조회는 격리 fixture로 검증했습니다.
- 실제 Codex 기본 모델: 공개 검색어 `Python asyncio TaskGroup official documentation`으로 네이티브 검색 완료 1건과 공개 페이지 4개를 확인했습니다. 12,000자 보관 한도 초과 자료는 `content_truncated`와 partial로 표시했습니다. 이어 고정 자료만 사용한 별도 실제 답변에서 인용 3개를 검증/저장했습니다. 최초 제한 실행은 앱 서버 초기화의 `Operation not permitted`로 실패했고 동일 임시 검증을 승인된 실행 권한에서 완료했습니다. 이는 웹 검색·저장 연결 확인이며 내용의 독립 의미 검증은 아닙니다.
- 실제 Claude 기본 모델도 같은 공개 검색어로 네이티브 검색 완료 1건과 공개 페이지 4개를 읽었습니다. 잘림은 동일하게 partial로 보존됐습니다. Claude의 웹 조사 단계는 실제 성공했으며 최종 답변/저장까지의 실모델 확인은 위 Codex 실행에서 수행했습니다.
- 공식 실행 근거: [OpenAI web_search 설정](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude tools](https://code.claude.com/docs/en/tools-reference). 현재 설치 CLI 도움말과도 대조했습니다. Windows 실기기, 로그인 필요한 사이트·동적 페이지·PDF 웹 자료는 이번 실제 실행에서 확인하지 않았습니다. 운영 서버/인증 설정과 설치 앱 패키지는 변경하지 않았습니다.

## 2026-11-05 — 채팅에서 실제 기록 재전송과 파일 드롭을 확인 (D-098)

- 질문 실행기가 새 AI 세션에 저장된 이전 대화를 다시 넣을 때만 진행 이벤트를 보낸다. 앱은 단계가 바뀌어도 이번 실행의 재전송 여부를 보존한다. 기존 세션 재개 실패 이벤트와 구분해 새 대화·정상 재개에는 비용 안내를 붙이지 않는다.
- Electron의 실제 드롭에서 받은 파일만 한 번 읽도록 제한하고, 파일 선택과 동일한 변환·한도·임시 파일 정리를 사용한다. 위키 등록이나 서버 업로드는 수행하지 않는다. 격리 Electron에서 경로 위조·재사용·파일 제한, 패키지에서 파일 2개 연속 첨부를 확인했다. 질문 세션·첨부 Python 검사 16개 통과.

## 2026-11-03 — 패키징·문서에서 Pandoc 제거(D-095)

- 변경: `scripts/package-desktop.mjs`의 Pandoc 동봉·검증·`--require-pandoc`/`--check-pandoc`, `scripts/pandoc-bundle.mjs`, `package.json`의 `package:check-pandoc`을 제거했다. `README.md`·`app/README.md`의 Pandoc 설명을 앱 내장 라이브러리 기준으로 바꾸고 `docs`의 현재 상태(PLAN)에 대체 사실을 추가했다.
- 검증: `node --check scripts/package-desktop.mjs` 통과, `runtime_doctor --skip-ai` 출력에 `conversion.packages`·`tesseract`만 있고 Pandoc 항목이 없음을 확인했다. 실제 패키징(electron-builder) 빌드는 실행하지 않았다.
- 남긴 것: 개인 PC의 `.local/pandoc` 실행 파일과 `.local/pandoc-bundle`은 사용자 파일이라 삭제하지 않았다(더는 쓰이지 않음). 과거 결정·기록의 Pandoc 설명은 당시 내용으로 보존한다.

## 2026-11-03 — Claude 어댑터가 추론 토큰 알림을 도구 사용으로 오판하던 문제

- 증상: 설치된 Claude Code 2.1.317이 추론 중 `system` 이벤트의 `subtype: thinking_tokens`(추정 토큰 수만 담음)를 보내면 `core/client/ai/claude.py`가 허용 목록 밖이라 `ai_unexpected_tool_activity`로 실행을 중단했다. 양식(템플릿) 시험의 긴 답변에서 재현했고, 모델이 오래 생각하는 일반 채팅 질문에서도 같은 이유로 실패할 수 있다.
- 수정: 허용 목록에 `thinking_tokens`를 추가했다. 훅 출력(`hook_started` 등)과 알 수 없는 `system` 하위 종류는 계속 거부한다. `core/tests/poc_analysis/test_claude_events.py`(2개)를 추가해 두 동작을 고정했다.
- 검증: 새 테스트 통과, 수정 뒤 실제 Claude로 같은 요청 3건이 완료됐다. 기존 `test_session_continuation`의 Codex 2건은 이 PC에 Codex CLI가 없어(`ai_cli_unavailable`) 실패하며 이번 수정과 무관하다. 다른 Claude CLI 버전의 이벤트 종류는 확인하지 않았다.

## 2026-10-30 — 스킬 검증에서 발견한 MCP 입력 안내 보완

- 독립 관계 도구의 `replacement`에 source/policy별 필수 키·방향·qualifiers/context·원문 인용 포함 범위·provenance 타입·mapping 조건을 공개했다. source 추가의 기존 schema>=3 경계를 명시했으며 schema1/2를 자동 업그레이드하지 않는다. 실제 격리 MCP의 구schema2건은 invalid_argument/원장무변경이었다.
- 새 공개 안내 뒤 관계 통합8개와 실제 tools/list의 replacement 설명·전체55개 노출을 확인했다. 신규 저장 계약/업무 권한/HTTP 동작을 바꾸지 않았다. 질문 근거 준비와 검토 조회를 함께 설명하도록 tenant/reviews의 안내를 갱신했다. 실제 운영 연결 갱신은 미실행이다.
- 발생 배경과 스킬 검증은 [workflow HISTORY](../workflow/HISTORY.md#2026-10-30--순차-개선-6-wiki-스킬-책임-분리와-진단-추가)를 따른다.

## 2026-10-30 — 순차 개선 4: tenant MCP 13개 추가

- 변경: `core/mcp/tools/document_management.py`, `analysis_jobs.py`, `knowledge_queries.py`, `authored_relations.py`와 공통 `tenant.py`/`results.py`. 기존 문서·작업·집계·관계 서비스를 재사용하고 새 저장 형식/HTTP API는 추가하지 않았다.
- 신규 격리 검사 32개(문서10·작업7·질문/집계7·관계8)를 포함한 `core/tests/poc_mcp/test_*.py` 전체 **79개 통과**. 실제 loopback HTTP MCP SDK·stdio, HTTP 동등성, 원본 판본·전체 이력 보존, CAS, 취소/lease 만료, 소유권·cursor 격리, 저장 직전 권한 회수, 엄격 JSON, 응답 유실 재조회·저장 성공 경고를 확인했다. 실제 목록은 tenant55개, legacy8개를 확인했다.
- 독립 검토에서 없는 개체/옛 세대 관계의 HTTP/MCP 오류 코드 차이를 재현해 신규 관계 도구만 `invalid_argument`로 맞추고 동등성 검사를 추가했다. SDK의 nullable 문자열 사전 변환을 막아 literal `null`을 첫 페이지로 처리하지 않는다. 문서/집계 cursor는 생략·빈 문자열, 작업 cursor는 생략·JSON null을 허용한다.
- 초기 통합 실행은 작성 중 테스트의 오래된 fixture/기대값을 읽어 실패했고, 이후 전역 로그 비활성화 실행은 의도된 `assertLogs`를 막아 실패했다. 확정 파일·기본 로깅으로 재실행한 최종79개는 통과했다. unittest 패키지 discover 대신 기존 namespace 모듈 이름으로 로드했다.
- 운영 자료·정책·토큰·설치 앱·서버 프로세스는 변경하지 않았다. 실제 외부 연결 노출과 운영 쓰기/전문가 판단은 검증 범위가 아니다.

## 2026-10-29 — 여러 시트의 Pandoc 호환·정확한 제목 연결

- 실제 Pandoc 3.13의 workbook 관계 namespace 별칭 의존을 임시 사본의 r:id 표기로 보완했다. 원본 ZIP 바이트를 유지하며, 원본 시트 순서와 Pandoc sheet-N 생성 머리글을 대조하고 번호/정확한 인용 원명으로 연결한다. 불일치는 원본 구조와 셀 기록의 부분 상태로 남긴다.
- 8시트·서식/크기/색 참조의 보존과 실제 worker/API/MD 판본 연결을 포함해 담당 **45개 통과**. Python 5개 AST/whitespace와 변경 whitespace 검사도 통과했다. 새 실행 파일/의존성·서버/Office 렌더링은 추가하지 않았다. 세부 표본/판단/미실행은 [sources HISTORY](../sources/HISTORY.md#2026-10-29--여러-시트-대응이름-범위서식-출처-검증)를 따른다.

## 2026-10-29 — XLSX v2 병합 참조·구조 보존과 렌더 검증

- 개인 Pandoc 보기만 v2로 바꿔 생성 열 머리글·원래 좌표·병합 기준셀 참조를 사용하고 원본 구조를 MD에 함께 보존한다. 원본/서버/HTTP/MCP 계약과 기존 worker 시간·취소·격리 임시 폴더 경계를 재사용한다. 병합 참조 확장은 10,000칸 예산 안에서 수행하고 초과 범위를 partial로 보고하며 읽은 구조/셀 기록을 유지한다. 원문 경로/원본 캐시를 재작성하지 않는다.
- 실제 Pandoc 3.13에서 복잡 XLSX → MD → HTML td/th의 원문 대응과 multipart/worker/불변 보고/MD 판본 연결을 검증했다. 담당 **39개 통과**, Python 4개 AST/whitespace·담당 변경 whitespace 검사를 통과했다. 세부 표본/실패/미실행은 [sources HISTORY](../sources/HISTORY.md#2026-10-29--병합-셀복잡-표의-markdown-대응-검증과-수정)를 따른다. 새 의존성/실행 파일을 설치하지 않았으며 Windows/GUI/운영 서버 실행과 시각적 셀 병합 재현은 미검증이다.

## 2026-10-29 — XLSX Pandoc 호환 입력·형식별 진단

- Pandoc 3.13 공식 파서의 절대 package 경로 중복 결합과 inline 문자열/수식 손실을 재현하고 개인 PC의 임시 XLSX 문자열 보기로 보완했다. source ZIP·공통 저장 계약·서버 의존성을 변경하지 않으며 `--from=xlsx` 실행은 기존 개인 worker의 시간/취소/임시 폴더 경계 안에서만 수행한다. 내부 경로만 해석하고 외부 URI/package 밖 이동을 거부하며 표와 셀 기록의 합산 출력 한도를 적용한다.
- 실제 Mac Pandoc 3.13과 변환/등록 **30개 통과**. `tools.runtime_doctor --skip-ai` exit 0, `ready_formats=[docx,xlsx]`, 담당 Python 4개 AST 파싱과 변경 whitespace 검사를 통과했다. 구체적인 원인·셀/캐시 검증·응답 유실/MD 연결과 한계는 [sources HISTORY](../sources/HISTORY.md#2026-10-29--xlsx-경로-오류-수정pandoc-표와-원본-셀-기록-보존)를 따른다. 조사용 공식 소스 사본은 정리했으며 Windows/Pandoc 번들·실제 Excel/GUI/운영 실행은 미검증이다.

## 2026-10-29 — 개인 Pandoc 설치·진단·worker 연결

- [공식 Pandoc 3.13 macOS arm64 zip](https://github.com/jgm/pandoc/releases/tag/3.13)을 받아 GitHub asset digest SHA-256 `f436d18bebbfb3ddd326597686dacab9fac5dc23bd060495020f35a28a43a7c3`를 대조한 뒤 실행 파일만 프로젝트 `.local/pandoc`에 0700으로 새로 배치했다. 기존 파일은 덮어쓰지 않았고 시스템 패키지/로그인/정책을 변경하지 않았다. 제한 환경 DNS 실패 후 허용된 네트워크 실행으로 다운로드했으며 작업용 zip/메타데이터는 정리했다.
- 변환 진단은 PATH 우선/프로젝트 로컬 대체, 실제 버전·입출력 형식·DOCX 준비 상태를 반환한다. `tools.runtime_doctor --skip-ai` exit 0과 `conversion.pandoc`의 3.13/ready·실제 xlsx 포함 형식 목록을 확인했다. 지원 목록과 실제 적용 경로/문서 정확성을 구분한다.
- 개인 worker 안에서 shell 없이 `--sandbox`, 고정 DOCX reader/Markdown writer·track-changes=all·시간/출력 한도를 사용한다. 원본으로부터 도구/필터/외부 경로를 실행하지 않으며 이미지를 임시 파일로 추출하지 않는다. 진단은 원문을 포함할 수 있는 외부 로그 대신 경고 종류를 전달한다. 기존 부모의 전체 프로세스 취소/시간 제한과 scratch 정리를 재사용한다.
- 변환/등록 격리 검증 합계 **22개 통과**. 실제 ASGI API + 실제 Pandoc worker와 취소/응답 유실을 확인했으며 상세는 [sources HISTORY](../sources/HISTORY.md#2026-10-29--d-080-개인-pandoc-docx--보존형-md)를 따른다. 새 서버 의존성/HTTP/MCP 도구는 추가하지 않았다. Windows 실행/설치 파일의 Pandoc 포함·실제 GUI/운영 서버는 미검증이다.
- 담당 Python 3개 AST 파싱, 담당 변경 `git diff --check`, D-080 색인 유일성을 확인했다.

## 2026-10-29 — D-076 MCP 간결 응답·현재 재사용 기준

- `core/mcp/response_views.py`, `results.py`, `validation.py`, `tools/{reviews,analysis_results}.py`에 명시 `response_mode=compact`를 연결했습니다. 기본 full, 저장 요청 hash·멱등·현재 access 정보·전체 진단 findings·오류/미실행·정리 경고를 유지합니다. 검토 쓰기 4종은 저장 직전에 actor/현재 권한도 다시 확인합니다. 의미 판단과 Clean Up에 별도 AI 호출을 추가하지 않았습니다.
- 실제 격리 ASGI HTTP JSON-RPC의 신규 `test_compact_responses` **8개**, 기존 `test_cleanup_transport` **5개** 통과. 기본/간결 응답의 같은 event/claim/판본/조건/이유/범위, 상세 재조회·응답 모드 변경 멱등, 오류 동일, strict 인자, 권한/tenant/owner 분리·저장 직전 철회, 성공 정리 경고의 단일 저장을 확인했습니다. 개인 실행기·입력·재개 통합을 합친 최종 대상 61개 결과는 [analysis HISTORY](../analysis/HISTORY.md)에 기록합니다.
- 같은 snapshot의 canonical JSON UTF-8: 30개 합성 관계/2개 판단에서 검토 full **111,945 B → compact 5,188 B (95.4%)**. 단일 Wiki 결과 영수증은 **6,441 → 6,399 B (0.65%)**로 효과가 작았습니다. 필수 영수증·진단을 지워 크기를 줄이지 않았습니다. text와 structured 응답을 합친 wire 크기나 토큰 수가 아니며 측정 중 실제 모델 호출은 0회입니다.
- 개인 실행기는 프롬프트 문자/바이트·스키마/결과 JSON 바이트·호출 시도와 provider_reported 토큰을 구별합니다. 제공자 usage는 fixture만 검증했으며 실제 모델 사용량·요금·공개 HTTPS·추가 stdio·Windows·Electron·운영 연결을 이번 검증에 포함하지 않았습니다. 기존 credentials 초기화 실패 및 운영 정책/자료 문제는 수정하지 않았습니다.

## 2026-10-28 — core 구조 안내와 Claude 호환 확인

- [core/README.md](../../../core/README.md)에 폴더 역할, 시작점과 실제 처리 코드, HTTP/MCP 실행 흐름, 개인 AI 실행기, 두 tools 및 Python 본체·가상환경의 차이를 설명했습니다. 로컬 문서 링크 43개가 실제 파일/폴더로 연결되는지 확인했습니다. Python 실행 코드와 환경 설정은 변경하지 않았습니다.
- 앱 설정의 Claude 선택과 `core/client/ai/provider.py`의 Claude 어댑터 연결을 확인했습니다. 현재 설치된 Claude Code 2.1.311에 `tools.runtime_doctor`를 실행하여 필요한 옵션 지원을 확인했지만, 로그인 결과는 `not_logged_in`이며 전체 진단은 exit 1입니다. 로그인·실제 모델 호출은 수행하지 않았습니다.
- 프로젝트의 `.agent/*.toml`과 이를 참조하는 `.codex/agents`는 Codex 역할 설정입니다. `.agents/skills`에만 있는 스킬도 Claude 프로젝트 설정으로 자동 연결되어 있지 않습니다. Claude의 공식 프로젝트 경로는 [`.claude/agents`](https://code.claude.com/docs/en/sub-agents)와 [`.claude/skills`](https://code.claude.com/docs/en/skills)입니다. 현재 Claude는 [AGENTS.md fallback](https://code.claude.com/docs/en/memory)을 지원하지만 실제 세션의 지침 로딩은 검증하지 않았습니다. 앱의 Claude 어댑터는 고정 입력·규약을 직접 전달하므로 프로젝트 역할/스킬 자동 로딩에 의존하지 않습니다.
- 실제 로컬 MCP 시작은 `policy_unavailable`로 실패했습니다. 정책/토큰 파일은 존재하지만 현재 정책이 가리키는 `data/personal`이 없고 `data/`가 비어 있습니다. 이 상태에서 Codex·Claude의 해당 로컬 MCP 이용은 모두 막힙니다. 하위 에이전트 시작도 필수 `llm_wiki` MCP 초기화 실패로 실행되지 않았습니다. 자료가 없어진 원인은 확인하지 않았으며, 이번 UI/문서 작업에서 자료·정책·인증정보를 수정하거나 빈 워크스페이스를 생성하지 않았습니다.

## 2026-10-28 — D-071~074 MCP·공통 서버 연결

- 공통 Access DTO/현재성 비교에 `access_revision`을 연결했습니다. 없는 과거 actor 필드는 직렬화에 추가하지 않습니다. API와 MCP의 신원 응답·분석 인가 콜백·검토/대응/개념 actor에 같은 공개 값을 사용합니다.
- `create_application`에서 실제 `initialize_auth`와 공개 가입/로그인 router를 연결했고, HTTP CLI에 키 파일 옵션을 추가했습니다. 신규 경로만 받는 `tools.initialize_server`와 기존 경로 보존 검증을 추가했습니다. 새 초기화는 환경의 다른 키 경로를 사용하지 않습니다. 정상 서버 부팅에 자료/정책 자동 초기화는 없습니다.
- `wiki_read`는 전체 파일과 본문/Front Matter/작성정보를 같은 잠금에서 반환합니다. `wiki_write`는 공통 편집 서비스를 통해 ID/source 보호·CAS·실제 actor와 명시 origin/reason을 전달하며 `audit_status`·`audit_error`를 보존합니다. `AuthorshipCorruptError`는 API/MCP의 `authorship_corrupt`로 구별합니다.
- `analysis_registration_create`는 실제 보존형 등록 모듈을 사용합니다. 기존 실행/입력/결과 도구를 유지하고 본문 좌표와 전체 파일 revision의 구분을 도구 설명에 반영했습니다. cryptography 50.0.2·PyYAML 6.0.2를 고정했으며 후자를 프로젝트 `.venv`에 설치했습니다. 초기 제한 네트워크 설치는 실패했고 승인된 재시도에서 성공했습니다.
- 최종 `.venv/bin/python -B -m unittest discover -s core/tests/poc_mcp -v`: **16개 중 15개 통과, 1개 오류**. 통과 범위는 API/MCP 동일 신원·권한·접근 기준, 가입/동일 토큰 재로그인, 다른 사용자 가입 중 고정 입력 유지, 정확한 공개 경로·Host/Origin/본문 제한, 권한/토큰 회수, 정책 오류 실패 차단, 실제 stdio와 loopback HTTP+MCP SDK, stdout/오류 토큰 비노출, 신규/과거 문서·전체 이력·동시 CAS, 작성 원장 부분 실패/손상, 본문 근거 전체파일 줄 좌표·stale, 원본→MD 하나→그래프 영수증과 그래프 실패 뒤 MD 보존·요청 재전송·개인 소유권입니다. loopback 검증은 최초 포트 제한 이후 권한을 받아 실제 임시 포트로 실행했습니다.
- 남은 오류: `test_legacy_plaintext_credentials_do_not_prevent_authenticated_boot`에서 기존 `credentials/*.token`만 있고 키가 없는 정책이 `initialize_auth`의 모든 credentials 파일 존재 검사 때문에 `PolicyError`로 부팅 실패합니다. 소유권상 인증 담당 파일은 수정하지 않고 PLAN에 정확한 재현을 인계했습니다. 초기 문서 3검사 실패의 nullable actor 원인은 저장 담당 수정 뒤 재검증에서 해소됐습니다.
- 공통 변경의 업무 회귀를 위해 기존 담당 검증도 실행했습니다: `poc_access` **27**, `poc_storage` **35**, `poc_analysis` **12**, `poc_knowledge` **25** 모두 통과(총 99). `pip check`, 관련 Python 33파일 문법 검사, 과거 Access 직렬화 유지, Linux 서비스의 정책 폴더 쓰기 설정 검사와 담당 범위 `git diff --check`도 통과했습니다.
- 실제 사용자 `data/`, `.local/tenancy/`, CLI 설정·토큰·운영 서버는 변경하지 않았습니다. 분석 결과는 합성 입력의 계약 검증이며 실제 모델 의미 정확도·Electron 화면·OS 보호 저장/로그아웃·Windows/WSL/원격 HTTPS 운영 완료로 확대하지 않습니다.


## 2026-10-29 — Clean Up 공통 HTTP/MCP 계약 검증

- `core/api/v1/reviews/cleanup_router.py`와 `core/mcp/tools/cleanup.py`를 같은 CleanupStore에 연결했다. GET preview/events/request, POST apply/undo 및 tenant MCP 5개 도구에 read/ontology_review 경계·서버 actor·엄격 JSON·상태/cursor 충돌을 적용했다. 일반 document knowledge 응답 모델에 current_claims/current_pending_history/cleanup을 추가했다.
- 신규 전송5개 통과: HTTP/MCP 미리보기·저장 영수증·이력·원시/현재 조회 동등성, HTTP 적용→MCP 재요청/되돌림, 다른 tenant/허용되지 않은 profile 거부, 다른 사용자 영수증 미노출, 권한 회수 뒤 본인 영수증 read, 저장 직전 권한 회수, 요청 취소 뒤 작업 소유/저장 영수증, SDK 전처리 이전 JSON 타입 거부를 확인했다. 저장 직전 AccessDenied가 MCP SDK 일반 오류로 감싸지던 실패를 재현해 cleanup 어댑터에서 명시 access_denied로 매핑했다.
- `.venv/bin/python -B -m unittest discover -s core/tests/poc_mcp -v`: **21개 중 19개 통과, 2개 오류**. `legacy_plaintext_credentials_do_not_prevent_authenticated_boot`는 기존 PLAN에 기록된 `initialize_auth -> PolicyError`가 재현됐다. 이 인증 소유 범위는 수정하지 않았다. `live_http_sdk_and_api_use_one_address`는 제한 실행 환경의 loopback bind 거부였다. 해당 검사만 권한 있는 실행 환경에서 재실행하여 **1개 통과**했다. 결과적으로 이 회귀 범위의 고유 검사20개 통과·기존 인증 실패1개다.
- 신규 서비스15+전송5의 통합 실행20개는 모두 통과했고 최종 DTO 제약을 적용한 전송5개도 재검증했다. 기존 지식 저장26개와 합치면 이번에 확인한 고유 검사는 **61개 통과·기존 실패1개**다. 변경 파일 whitespace 검사는 통과했다.
- 모든 테스트 자료/정책/서버는 TemporaryDirectory 안에 생성했다. 운영 cleanup·운영 정책·UI 파일·배포는 수행하지 않았다. 앱은 ontology PLAN의 고정 공개 계약으로 연결해야 하며 실제 UI 사용 동선은 해당 세션에서 확인할 항목이다.

## 2026-10-29 — Mac 서버·Quick Tunnel 동시 실행

- `tools/start-mac.command`를 추가하고 README에 더블클릭/한 줄 실행, cloudflared 준비, 주소 변경과 종료 방법을 기록했습니다. 기존 `core.runtime.http_cli`·개인 정책·loopback Host 보호를 재사용하고, 임시 Cloudflare 설정과 `TUNNEL_NAME` 해제로 명시 Quick Tunnel을 선택합니다. 기존 서버/자료/인증정보를 자동 초기화하거나 종료하지 않습니다.
- `bash -n`, 도움말, 잘못된 포트/추가 인자 거부, cloudflared 누락 안내와 변경 범위 whitespace 검사를 통과했습니다. 임시 새 정책·키·자료의 **실제 HTTP 서버 + 모의 cloudflared**에서 공백 경로/다른 작업 폴더 실행, 앱/MCP 주소 표시, SIGINT·SIGHUP 종료, 터널 실패→서버 종료, 서버 실패→터널 종료, 점유 포트 보존, 잘못된 키의 시작 실패를 **6개 수명주기 검사**로 확인했습니다. 각 종료 후 소유 프로세스·임시 로그 정리를 확인했습니다. 초기 loopback 권한 제한은 허용된 실행으로 재검사했고, 모의 실행기의 공백 포함 shebang 오류는 시험 코드에서 고친 뒤 최종 6개를 통과했습니다.
- 현재 `.local/cloudflared`·Homebrew 경로·PATH에서 실행 파일을 찾지 못했고 `data/`의 workspace 폴더는 0개이며 기존 정책의 읽기 전용 검사는 실패했습니다. 운영 자료·정책·키를 변경하지 않았습니다. 실제 Cloudflare 공개 HTTPS, 인증된 원격 MCP 초기화, Finder 직접 클릭·다른 PC 접속은 미실행입니다. 실제 사용에는 cloudflared 준비와 원래 자료 위치 확인/복구가 남습니다.

## 2026-10-29 — 프로젝트 내부 cloudflared 설치

- 사용자 요청에 따라 [공식 2026.10.5 배포](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.5)의 `cloudflared-darwin-arm64.tgz`를 받아 GitHub 배포 메타데이터의 파일 크기와 SHA-256 `184c7d4f5f977348243a6d7ca8f6cf6073b9b2746cfe8c1fe15aa59e9a522bf0`를 대조한 뒤 `.local/cloudflared`에 0700 권한으로 배치했습니다. 기존 파일 덮어쓰기 없이 실행 파일만 추출했으며 임시 다운로드는 정리했습니다. 최초 제한 환경의 DNS 실패 후 허용된 네트워크 실행에서 다운로드를 완료했습니다.
- 런처의 Homebrew/PATH/환경변수 경로 선택을 제거해 프로젝트 `.local/cloudflared`만 사용하도록 수정하고 도움말·README를 맞췄습니다. 시스템 설치·자동 갱신·계정 로그인은 수행하지 않았습니다.
- 실제 실행 파일의 `--version`(2026.10.5), Mach-O arm64, 사용 옵션의 `--help` 파싱, 셸 문법/도움말, Git 제외와 변경 범위 whitespace 검사를 통과했습니다. 이전 경로 환경변수가 있어도 로컬 파일을 선택한 뒤 기존 정책·자료 읽기 오류로 안전하게 중단함을 확인했습니다. 이전 6개 수명주기 검사를 이번에 재실행하지 않았습니다. 기존 자료·인증 설정은 변경하지 않았으며 실제 서버·공개 터널·원격 인증 연결은 미기동 상태입니다.


## 2026-10-29 — personal 자료 준비와 실제 Mac 런처 확인

- 사용자 요청으로 누락된 `data/personal`을 만들었고 기존 정책·자료 검사 실패가 해소됐습니다. 이어진 기존 평문 토큰 시작 오류는 access 담당 코드에서 수정했으며 정상/실패 보존 경계와 검사 29개 통과는 access HISTORY를 따릅니다. 빈 정책 교체·기존 토큰 삭제·자동 이관은 하지 않았습니다.
- 실제 `tools/start-mac.command`에서 HTTP 서버와 cloudflared의 Quick Tunnel 연결 등록·앱/MCP 주소 표시를 두 번 확인했습니다. loopback 무인증 요청 401, 기존 개인 토큰의 access-context 200, MCP initialize 성공을 확인했습니다. 정책·토큰 바이트와 두 번째 실행의 키를 보존했고 SIGINT 후 서버 포트가 닫혔습니다. 확인 후 프로세스를 종료하고 임시 로그를 정리했습니다.
- 공개 터널로 기존 개인 토큰을 전송하려던 검증은 자동 승인 검토가 목적지에 대한 민감정보 외부 전송 승인이 없다는 이유로 실행 전에 거부했습니다. 이후 승인된 대안에서 토큰은 redirect/proxy 없는 고정 loopback에만 전달했습니다. 공개 주소에는 인증정보·쿠키·본문 없는 요청만 보냈으나 DNS 조회가 실패했고 2초 간격 15회 준비 재확인도 실패했습니다. 따라서 공개 HTTPS 응답·원격 개인 인증·다른 PC 연결·Finder 클릭·실제 문서 저장은 완료로 표시하지 않습니다.

## 2026-10-29 — 저장 없는 ontology_validate_draft 공개

- legacy/tenant MCP에 `ontology_validate_draft(document,expected_revision,submission,max_errors=20)`를 추가했습니다. 원시 JSON·read-only annotation, tenant 기존 read/profile 선택, 그래프 무필터, 오류/의존/한도/미검사·save_authorized=false 계약입니다. 새 HTTP 경로와 권한 이름은 없습니다.
- 순수 검사·storage·MCP 전송/기존 통합64개를 통과했습니다. 무쓰기/무잠금·읽기 권한/철회·profile/tenant 거부·성공 후 쓰기 권한 부여 없음·별도 source/review CAS를 확인했습니다. 샌드박스 포트 제한으로 막힌 HTTP1개는 허용된 로컬 포트 환경에서 재실행해 통과했습니다.
- 기존 직접 `ontology_generate`가 analysis-result 경로의 before_commit 권한 콜백을 사용하지 않는 점은 이번 변경에서 해결하지 않았습니다. 초안 통과가 최종 권한 검사를 대체하지 않습니다. 운영 서버 재시작/배포는 수행하지 않았습니다. [D-081](../ontology/DECISIONS.md#d-081--저장-없는-초안-검사와-제한된-끝점-역할-규칙-2026-10-29), [검증 근거](../../../evals/2026-10-29-adopt-imp01-02/implementation-verification.json).


## 2026-10-30 — Mac 운영 규약·서버·설치 앱 반영

- 사용자 승인 범위에서 공통 MUST·미독 경계의 기존 담당 채팅 완료/대기를 확인하고 평가를 중복하지 않았습니다. `.local/extraction-rules`에 `common/2026-10-30.1`을 불변 발행했습니다. revision은 `e4e65eabb1c520e48215b4cad4014423d31340fbaf616fc813d7c825989e3fa2`입니다. 관리 도구의 plan/apply와 CAS를 통해 `sdv-platform`, `personal`의 첫 기본 규약으로 연결했고 두 감사 이력·정책 전후 원본을 보존했습니다. 인증 정책과 자격 증명은 변경하지 않았습니다.
- `core/runtime/rulesets.py`, `http_cli.py`, `tools/start-mac.command`, README에 명시 `--ruleset-config` 연결을 추가했습니다. 두 절대 경로만 허용하고 설정/개별 인자 혼용·알 수 없는 필드·누락/링크를 거부합니다. 설정이 없는 기존 실행은 유지합니다. 격리 설정/실제 모의 런처 검사 **5개**, 셸 문법·도움말·변경 파일 검사를 통과했습니다. 운영 설정은 `.local/server-rulesets.json`입니다.
- 운영 자료를 사용하는 새 서버 8767에서 신규 QA 한 건만 등록해 실제 Codex 추출 저장→같은 대화 검색/대조 3호출을 완료했습니다. 그래프 개체2/관계1, 대조 complete/current, 조회2/5회입니다. [실행 보고](../../../evals/2026-10-30-operational-smoke/REPORT.md)를 따릅니다. QA의 로컬 세션은 실제 8767 주소에 묶여 있으며 다른 주소나 앱 저장소로 재바인딩하지 않았습니다. 이 QA의 설치 앱 수동 재대조는 검증하지 않았습니다.
- 기존 런처가 자식 종료 시 터널도 정리하므로 이번 전용 handover에서 기존 감시자를 잠시 멈추고 서버를 정상 종료한 뒤 최신 8766 서버로 교체했습니다. 기존 감시자만 종료하고 새 감시자가 기존 cloudflared를 인계했습니다. 신호 전 PID/시작시각/실행 경로 확인, 시작 실패의 1회 복구, 상태 기록 실패, PID 재사용, 종료 시간 초과 등의 모의 오류 주입 **9개**를 통과한 뒤 실행했습니다. 실제 결과는 `updated`, 오류/잔존 프로세스 없음입니다.
- 현재 감시자 PID1230, 서버 PID1276, 기존 터널 PID83274이며 공개 주소 `https://raise-stem-array-events.trycloudflare.com`을 유지했습니다. 정확한 프로세스 신원·명령·시작 시각은 `.local/deployments/2026-10-30/runtime.json`에 있습니다. 종료할 때는 현재 신원을 재확인한 감시자에 TERM을 보내고 `stopped`/잔존 상태를 확인합니다. 다음 일반 실행은 README의 Mac 런처가 명시 규약 설정을 읽습니다. 이번 인계는 재부팅 자동 시작을 추가하지 않습니다.
- 교체 후 loopback API/MCP 동일 사용자·기본 규약·신규 대조 목록200·QA 원본/문서 전체 hash·그래프 판본·대조 원장 보존 **7개**를 통과했습니다. [최종 검사](../../../evals/2026-10-30-operational-smoke/ROLLOUT.json). 공개 주소의 무인증 MCP401·redirect 없음과 설치 앱의 기존 인증을 통한 QA 완료/대조 조회도 확인했습니다. QA 임시 서버8767은 종료했습니다.
- 최신 arm64 앱을 빌드해 로컬 ad-hoc 서명·서명 무결성·ASAR8파일 일치를 확인하고 `/Applications/LLM Wiki.app`에 설치했습니다. 설치 ASAR SHA256은 `19f91c8e161b685f77d85c9dc073f2eb6503568a29963cb997c6d37daa39b32f`입니다. 최종 개인 실행기 ZIP274파일 일치/CRC를 확인했고 SHA256은 `2c3add878a25834de4ffaf769da27d165956373dc2e225804165ca0f349f5ed8`입니다. [패키지 검증](../../../app/release/v0.1.0-operational-20261030/VERIFICATION.json). 공인 서명/공증·Windows 설치 검증으로 확대하지 않습니다.
- 이전 앱과 전체 사용자 설정519파일을 `.local/deployments/2026-10-30/`에 백업했습니다. 기존 운영32파일은 모두 동일하고 신규 QA60파일만 추가됐으며 access 정책 hash도 같습니다. 보호 연결·실행 설정·복구7파일이 모두 남았고 앱 실행 후 복구 암호문1파일의 바이트만 달라졌습니다. 원본 암호문 백업을 유지했으며 그 파일의 의미적 동일성은 별도로 확인하지 않았습니다. 근거는 같은 폴더의 `before.json`, `app-install.json`, `preservation-after.json`입니다.
- Claude Code2.1.312의 실제 첫 요청은 `ai_rate_limited`였습니다. 성공한 답변·재개·전체 추출/대조·수동 재대조는 미검증이며 추가 호출이나 계정/결제/로그인 변경은 하지 않았습니다. [실패 근거와 남은 범위](../../../evals/2026-10-30-claude-live/REPORT.md). 다양한 실문서 의미 정확도·다른 PC/Windows·재부팅 자동 시작은 이번 완료 범위에 포함하지 않습니다.

## 2026-11-03 — 로컬 실행기 터널 주소 저장

- `tools/start-mac.command`가 Quick Tunnel 주소를 `.local/last-server-url.txt`에 기록하고 종료 시 지운다. 주소는 재실행마다 바뀌고 인증 정보는 담지 않는다.

## 2026-11-03 — 터미널 창에서 서버 (재)시작 스킬

- `tools/open-server-terminal-mac.sh [포트]`: 이 프로젝트의 `start-mac.command` 런처(작업 폴더로 식별)를 TERM으로 내리고 포트가 비면 macOS 터미널 창에서 다시 실행한 뒤 `.local/last-server-url.txt`의 터널 주소를 출력한다. 다른 프로세스가 포트를 쓰면 시작하지 않는다. 사용 지침은 `.claude/skills/wiki-server/SKILL.md`. 실제로 실행해 새 터미널 창(ttys000)에서 서버가 떠 로컬 `/mcp`가 401로 응답함을 확인했다(주소는 재시작마다 바뀜).

## 2026-11-06 — 사용자 요청으로 SDV 데이터 비우기

- `data/sdv-platform`의 위키·원본·히스토리·분석 자료·개인 기록 96파일(373,920바이트)을 삭제했다. 최상위 7개 폴더와 `.registration.lock`·`.storage.lock`, 기존 워크스페이스 ID는 유지했다.
- 검증: 원본/개인 기록 잠금과 위키 잠금을 순서대로 확보한 상태에서 삭제하고, 7개 폴더가 비었으며 폴더·잠금 파일의 inode/권한이 유지됨을 확인했다. `.local/tenancy` 파일 전체의 전후 SHA-256과 `data` 최상위 항목도 일치했다. 제품 코드 변경·제품 시험·앱 화면 확인은 수행하지 않았다.


## 2026-11-06 — 해사 40문항의 저장·개인 AI 실패 원인 조사

- 제품 변경 없이 고정 실행 기록과 코드 경로를 대조했습니다. 저장20건은 전체 basis 반복 삽입과 공통 JSON1MiB 한도의 충돌입니다. 사용자 질문14건·실행 생성3건·완성 답변3건 모두 기록 크기 하한이 상한보다 큽니다. QA-014는 위키 content5,237바이트→전체 근거525,394바이트→두 턴 기록 최소1,060,024바이트였습니다.
- 기존 승인 범위의 QA-013 프롬프트·원 출력 계약으로 별도2회 호출해 동일 오류 지문의 `Incomplete response returned, reason: max_output_tokens`를 확인했습니다. 첫 관측 필터가 원문을 가려 규칙을 교정 후1회 추가했고 거기서 종료했습니다. 전달용 schema는 required63개 목록의 순서만 달라 의미 동등 확인·지문 차이를 공개했습니다. 기존40문항·점수·23회 집계는 그대로 두고 추가2회를 분리했습니다.
- CLI의 모든 비정상 종료를 `ai_login_or_execution_failed`로 묶는 제품 오류 처리와, 확정 personal_limit 뒤 영수증404를 mutation_unconfirmed로 바꾸는 평가 보조 도구의 구분 문제를 확인했습니다. 실제 모델·출력 상한·실패 usage 미기록 때문에 설정 생성 상한과 전체 문맥 잔여 공간 중 결정적 원인 및 다른10건의 정확한 과거 오류는 미확정입니다. Python·의존성·CLI·인증정보 존재의 읽기 전용 진단은 통과했고 새 API/MCP 확인·서버 쓰기·설정 수정·설치·배포는 미실행입니다.
- [진단 보고서](../../../evals/2026-11-06-maritime-corpus/execution/chat-rerun-cause-diagnosis/REPORT.md)와 [검증](../../../evals/2026-11-06-maritime-corpus/execution/chat-rerun-cause-diagnosis/FINAL-VERIFICATION.json)을 보존했습니다. 저장 분리·생성 예산 관측·오류 분류의 제품 수정은 이번 조사 범위에서 적용하지 않았습니다.
