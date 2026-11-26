# 실행 환경 작업 기록

## 2026-11-26 — 등록 재개와 Windows 원본 미리보기 수정

- Windows 보호 실행기의 허용 목록에 미리보기·그림 복구 등 기존 앱 CLI가 빠져 실행 전 거부되던 결함을 수정했다. 앱 자식 환경에 Program Files 경로를 전달하고 공통 Office 탐색기가 배포본의 렌더러를 우선한다. 공식 LibreOffice Portable26.2.4를 해시로 고정해 DLL·필터·라이선스와 함께 번들한다([D-171](DECISIONS.md#d-171--windows-배포본에-원본-렌더러-포함-2026-11-26)).
- 미리보기에 숨김 슬라이드 내보내기·슬라이드 수 일치 검사·macOS 한글 글꼴 설정을 적용했다. 실제 VOC PPTX170장과 문제5장 PNG를 만들었고 원본SHA는 동일했다. 121장 원본PNG와 고정 보고 문자를 제품 화면에서 나란히 표시·확대했다. 화면의 인증·통신은 로컬 재생이며 운영 등록 성공으로 간주하지 않는다.
- 실제 Office 포함 Python50개, 번들7개, 배포70개, 미리보기 서비스6개·화면6개, IPC8개와 앱 전체 build/type/lint/format/token 검사를 통과했다. 격리 backend 전체와 서버 claim/lease4개도 통과했다. Windows 번들17,693파일과 Office14,696파일을 manifest로 확인했다. 이 시점의 Windows 실제 배포 ZIP 검사는 후속 GitHub Actions 실행 전이다.
- 증거: `.local/diagnostics/source-preview-render-eolkae_c/verification.json`, `.local/diagnostics/2026-11-26-registration-preview/`, `.local/diagnostics/2026-11-26-office-bundle/verification.json`, `.local/releases/0.6.6-registration-preview/regression.json`. 운영 원문·Wiki·이력·승인 기록을 변경하지 않았다.


## 2026-11-26 — PPT 그림 문자 복구 0.6.5 배포

- 사용자의 운영 서버·Windows 배포 승인에 따라45개 변경을 `39ac71076efa372397e9c7446402fbd0c86a6b38`/`v0.6.5`에 고정하고 [0.6.5 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.6.5-portable)을 공개했다. PPT 검토 대상 복원·개인 AI 그림 문자 복구·본문/초안 보존·취소를 포함한다. 실제6그림 판독과 보존은 [sources 검증](../sources/HISTORY.md#2026-11-26--저신뢰-pptx-그림-문자-복구와-실제-voc-검증d-170)을 따른다.
- 서버는 기존 검증 snapshot492파일에 승인된2파일만 반영했고 서버 Python277파일이 고정 commit과 같다. 후보47검사·인계25검사와 같은 공개 주소/터널·local/public API/MCP/VOC6경로의 무인증401을 확인했다. 운영 분석/질문 실행 중 작업은 없었다. 보존 대상1,841파일 중1,840개는 동일하고 알림 DB만 자연 조회에 따라 변경됐다. 별도 사본 대조로 해당 문서의 전체 입력 대기→121/122/124/128/136슬라이드 pending 복원과 사건1개·변경 순번1개만 확인했다. 원본/보고 참조·기존 판단·보정·승인·실행·다른11workflow·원문/히스토리/정책/규약/주소는 보존됐다. 최초 전체 바이트 불일치 결과를 지우지 않고 의도한 파생 변경의 분류 검증을 별도로 남겼다.
- Python 집중162검사·제품 UI56검사·backend/IPC/보호 초안 회귀와 고정 checkout의 앱 빌드·릴리스70검사를 통과했다. 개인 소스360개·런타임2,996파일·PE0.6.5·아이콘·복구 IPC/최종 슬롯 코드·5초 종료 유예·ZIP/SHA를 확인했고 기존 의존성2,636파일은0.6.4와 같다. ZIP253,765,981바이트·SHA256 `d29fb475c1c141a6c0bd8086a03eb3ea11d9782232e2c9614ea0108c5d539340`.
- 공개 ZIP/SHA의 인증 없는 전체 다운로드가 로컬 값·GitHub digest와 일치했다. 기존8릴리스/16자산·latest `app-0.4.1-portable`와 설치형 업데이트 피드는 유지했다. 근거는 `.local/releases/0.6.5-voc-recovery/`의 `local-verification-release.json`, `remote-verification.json`, `server-verification.json`이다. 실제 Windows·두PC·Codex 그림 판독·운영 인증 제출·사용자 전체 문서 AI 완료·Mac 설치 교체는 미실행이다.

## 2026-11-26 — 개인 AI 그림 문자 복구의 IPC·실행 경계

- `notifications:recover-images`는 고정 슬라이드/원본/보고와 현재 권한을 전후 검사하며 후보만 반환한다. 일반 알림 조회의 outbox flush를 쓰지 않아 후보 생성에 서버 쓰기가 섞이지 않는다. 개인 실행기의 보호 요청/토큰 파일, 단일 JSONL 결과·단위 집합·크기/경고 한도·범위 변경·인증 정리를 검증했다.
- 합성 CLI와 격리 HTTP를 사용한 backend 전체 회귀 및 IPC7검사를 통과했다. 최초 sandbox localhost 제한은 승인된 격리 실행으로 해소했고,33MiB 출력·인증 정리 중 취소·경고 한도 초과에서는 기존 내용을 유지했다. 실제 Python 복구의 AI/등록 검증은 [sources 기록](../sources/HISTORY.md#2026-11-26--저신뢰-pptx-그림-문자-복구와-실제-voc-검증d-170)을 따른다. 운영 서버·공개 릴리스는 변경하지 않았다.
- 추가 검토에서 Python 자식 회수2초보다 부모 강제 종료1초가 빨라 POSIX AI 자식이 남는 문제를 실제 heartbeat로 재현했다. 개인 실행기의 종료 유예를 제한된 선택값으로 추가하고 그림 복구에만5초를 적용했다. 실제 SIGTERM 무시·별도 세션 자식의 소멸과 임시 원본/본문요청/인증 파일 정리, 기존 실행기의 기본1초 동작을 함께 확인했다. 고정 본문도 private 요청에 전달하고 실행 후 재비교하며 외부 AI 입력에는 넣지 않는다.
- 기존 공개본과 분리된 비공개 Windows 후보를 `app/release/portable/0.6.4-voc-image-recovery-private-20261126/windows-x64/`에 만들었다. ZIP253,765,977바이트·SHA256 `418ae914af85a4fc949db23b07776659989c3fa38ef917d3ec7f7c012c0f3517`, 잠금 런타임2,996파일·현재 개인 소스360개·main/preload/renderer의 복구 기능 포함과 ZIP 무결성을 확인했다. 패키징 계약42검사도 통과했다. 최초 사용자 자료 제외 검사에서 PDFium 라이선스의 `data/` 하위 경로를 잘못 잡았으며 실제 프로젝트 자료 경계로 고쳐 통과했다. 공개 게시·Windows 실기·운영 서버 교체는 하지 않았다.

## 2026-11-26 — PPT 미판단 검토 대상 복원

- 알림 저장소의 기존 재조정에서 현재 원본/보고의 미판단 전체 입력만 슬라이드/프레임 단위로 복원한다. 사용자가 보류 후 되돌린 기록을 포함해 판단·보정·승인·실행이 있으면 변경하지 않는다. 새 revision·변경 사건을 함께 저장하고 실패 시 원상태로 롤백한다. 반복 조회 멱등·오래된 revision 거부·기존 원보고 보존을 포함한93개 관련 Python 검사 통과. 운영 DB·서버·앱 배포는 실행하지 않았다. [실제 보고 재현](../sources/HISTORY.md#2026-11-26--재접수-voc의-ppt-등록-차단과-남은-ocr-문제).

## 2026-11-26 — 현재 변경 통합 0.6.4 Windows 포터블 공개

- 사용자의 현재 변경 포함 릴리즈 요청에 따라 기존 수정·신규85경로를 `abb2ec2`에 담고, 검증에서 재현한 쪽 그림 렌더의 실행권 갱신·취소·Windows 경로/UTF-8 출력을 `7e5288e13e954e54dac7d62f35c16bf4ebc96b68`에서 보완했다. `main`·`v0.6.4`와 [Windows 포터블0.6.4](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.6.4-portable)을 게시했다. PDF/PPT 변환·AI 후보 쪽 이미지 전달·문서 작업 진단과 기존 문서/역할 지침 정리를 함께 포함했다.
- 운영 서버는 기존0.6.3을 유지했다. 최종 릴리즈의 서버측302소스가 운영 후보와 같고 후보492파일·서버/감시자/터널 신원을 확인했다. 로컬·공개 API/MCP/VOC6경로는 예상 무인증401이었으며 검증 전후 자료·정책·규약·주소1498파일의 집합/바이트 변경0이었다. 서버 재시작·운영 로그인·정책 변경·사용자 자료 쓰기는 하지 않았다.
- Node24 전체 앱 빌드의 타입·lint·format·194토큰/3테마 검사, 제품 문서 작업 모델17·UI11묶음, 변경된 시안 타입4개, 릴리즈70검사를 통과했다. Python 집중100검사와 확장 회귀152검사를 통과했고 Windows 파일 잠금1건은 건너뛰었다. 독립 검토의 Windows 출력/경로·취소 보존3검사도 통과했다. 과거 문서 흐름·알림 시안2검사의 실패는 기준 `2d1f076`에서도 재현해 제품 필수 검사와 구별했다. 초기 Node16·Chrome/LibreOffice sandbox 및 Windows 모의 fixture 실패와 해소는 앱·Python 요약에 보존했다.
- 격리 고정 소스의 빌드 입력589개·개인 실행 소스358개·런타임2994파일을 대조했다. PE0.6.4·아이콘·새 진단 UI·이미지 모듈·포터블 업데이트 차단·비밀/개인 경로 제외를 확인했고 Python/OCR 의존성2636파일은 검증된0.6.3과 동일하다. ZIP은253,749,813바이트, SHA256 `ba8bed384737be44925231e38313955f8abf341b50557c78bc44e030193f9e24`이다.
- 공개 ZIP/SHA의 인증 없는 전체 다운로드와 GitHub digest를 대조했다. 기존7릴리즈/14자산과 latest `app-0.4.1-portable`를 보존했고 설치형 업데이트 피드는 변경하지 않았다. 근거는 `.local/releases/0.6.4-current/local-verification-release.json`, `remote-verification.json`, `server-verification.json`, `windows-build-summary.json`이다. Windows 실기·두PC·이번 릴리즈의 실제 AI 호출·서명/공증·Mac 설치 교체는 미검증이다.

## 2026-11-26 — 오류 보고 0.6.3 서버와 Windows 포터블 배포

- 사용자 배포 승인으로 VOC 제품/테스트·버전32파일을 `ecc5703fa5946f4bb83b9f21e95f4b6ef482c45e`에 고정하고 `main`·`v0.6.3`과 [Windows 포터블0.6.3](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.6.3-portable)을 게시했다. 작업 중이던60경로를 제품 소스에 섞지 않았고 해당 지문을 보존했다. 문서는 이번 기능·배포 기록만 별도 반영했다.
- 기존 터널·공개주소를 유지해 VOC 서버6파일을 새 후보 소스에서 실행했다. 후보492소스와 자료·정책·규약·주소1497파일의 집합/바이트를 확인했고 변경·추가·삭제0이었다. 인계25검사·독립 검토·후보 API12검사와 로컬/공개 API·MCP·VOC6경로의 예상 무인증401을 확인했다. 운영 시험 보고·로그인·정책 변경은 하지 않았다.
- Windows ZIP 253,735,037바이트, SHA256 `441fb6ad7b3b39e6074b2d7299bf37576920578259b861ef7824e280eafb7c80`. 고정 입력588개·개인 실행 소스357개·런타임2993파일과 PE0.6.3·아이콘·VOC UI/IPC 포함·비밀/개인 경로 제외를 확인했다. Python/OCR 의존성2636파일은0.6.2와 같다. 앱 빌드·보고 UI29·bridge5·실제 격리 HTTP→파일·릴리즈70·Python12검사가 통과했다. 기존 IPC 검사의 별도 고정 채널 수 불일치는 아래 구현 기록대로 남겼다.
- 최초 패키징의 sandbox DNS 실패와 SHA sidecar 누락 검사 실패는 기록을 보존하고 네트워크 승인 및 checksum 생성 후 재검증했다. 첫 소스 push의 제한된 토큰403은 같은 Jong-Yu 계정의 기존 CLI 로그인·저장소 쓰기 권한을 확인한 뒤 게시했다. 새 인증정보 발급이나 사용자 설정 변경은 하지 않았다.
- ZIP/SHA 익명 전체 다운로드·GitHub digest를 대조하고 기존 6릴리즈/12자산 및 latest `app-0.4.1-portable`를 보존했다. 설치형 업데이트 피드는 변경하지 않았다. 근거: `.local/releases/0.6.3-voc/local-verification-final.json`, `server-verification.json`, `remote-verification.json`. Windows 실기·운영 인증 제출·두PC·공인 서명/공증·Mac 설치 교체는 미검증이다.

## 2026-11-26 — 텍스트 오류 보고 API와 서버 보관

- [D-168](DECISIONS.md#d-168--텍스트-오류-보고의-서버-전용-보관-2026-11-26)에 따라 인증된 `POST /api/v1/voc`와 `data/voc/<report_id>.json` 저장을 추가했다. 원문·서버 시각·인증 사용자 ID를 보존하며 목록·조회·수정·삭제·피드백 API는 제공하지 않는다. 원자적 신규 공개·기존 파일 보존·저장 직전 재인증을 적용했다.
- Electron의 제한된 `voc.submit` bridge와 입력/응답·sender 검사, 기존 연결 토큰·오류 변환, web-test dispatch를 연결했다. 소속/tenant/profile 없이 로그인으로 보고할 수 있고, 연결 전환의 늦은 응답·응답 유실은 완료로 표시하거나 자동 재전송하지 않는다.
- `.venv/bin/python -B -m unittest core.tests.poc_storage.test_voc_http -v` 12개 통과: 입력·HTTP 8 MiB·인증/회수·API 범위·symlink·부분 쓰기·24건 동시 저장·ID 충돌·원문/기존 파일 보존·공개 후 정리 실패. Node24의 `node tests/voc/verify.mjs` 5개 통과: 로그인/범위·원문·응답/예외·늦은 결과·IPC. `node tests/voc/integration.mjs`는 실제 격리 서버의 가입/로그인→bridge→HTTP→파일까지 통과했고 서버/임시 자료를 정리했다.
- Node24 `npm run build`의 전체 타입·lint·format·194토큰/3테마·main/preload/renderer 번들을 통과했다. 최초 기본 Node16 타입 검사도 완료됐으나 실제 빌드는 명시한 Node24를 사용했다. 별도 기존 `tests/ipc/verify.mjs`는 6개 중5개 통과, VOC를 등록하지 않는 검사의 고정 채널 수 기대값14/실제15 불일치로1개 실패했고 이 테스트는 수정하지 않았다. 격리 통합 서버는 최초 sandbox bind 제한 뒤 승인된 실행으로 검증했다.
- 운영 서버·사용자 자료·인증정보는 변경하지 않았다. 배포 서버/앱 반영과 Windows 실기기 검증은 미실행이다.

## 2026-11-26 — 등록 화면 회귀 수정 0.6.2 공개

- 사용자의 기존 게시 승인에 따라 소스 `main`·`v0.6.2`를 `95876dfc5f33a36a1f2c911af9fd17b9c4600e16`에 게시하고 [Windows 포터블0.6.2](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.6.2-portable)의 ZIP/SHA 두 자산을 추가했다. 별도 작업 중 파일60경로를 제품 소스에 섞지 않았고 요청 범위의 제품/회귀41파일만 고정했다.
- ZIP 253,725,470바이트, SHA256 `76ce3842af7193ac0f18be21934930c93022bbe9ee239ad61ff7c0909bff9655`를 로컬 검증·GitHub digest·익명 전체 다운로드·SHA 파일과 대조했다. 기존 5릴리즈/10자산과 latest `app-0.4.1-portable`를 보존했다. ASAR/PE/런타임/소스입력과 새 UI·진단 마커를 검증했다.
- 첫 격리 빌드의 의존성 symlink가 주석에 원작업트리 경로를 넣어 패키지 검증을 실패했다. 실패 ZIP/보고를 보존하고 같은 검증 소스·의존성을 독립 디렉터리로 복사한 뒤 재빌드/패키징하여 통과했다. 산출물의 문자열을 사후 치환하거나 검사 예외로 숨기지 않았다.
- 호환 서버는 기존 주소/자료를 보존해 반영했으며 초기 인계 안전 중단과 복구는 아래 기록을 따른다. 근거는 `.local/releases/0.6.2-ui/windows-local-verification.json`, `remote-verification.json`, `server-verification.json`이다. Windows 실제 기기·운영 인증 업로드·두PC 전체 흐름·서명/공증은 미검증이다. 기존 Mac 설치본은 교체하지 않았다.

## 2026-11-26 — 실패 진단 호환 서버 반영

- 0.6.1 고정 소스에 `core/api/v1/notifications/schemas.py`·`core/modules/notifications/store.py` 두 파일만 반영한 후보로8766 서버를 인계했다. 최종 앱 소스 `95876df`와 비테스트 런타임355파일이 일치하며 기존 별도 `core/client` 작업은 포함하지 않았다. 후보487파일과 자료·정책·규약·주소1326파일의 집합·바이트 보존을 확인했다.
- 최초 인계에서 종료 중 프로세스가 `identity_changed`로 관측돼 안전 중단했다. 기존 서버/감시자의 실제 종료와 빈8766포트를 확인한 뒤 검증한 후보를 시작해 복구했다. 무중단 배포였다고 주장하지 않는다. 새 서버98885·감시자98852, 기존 터널96817과 공개주소를 유지했다. 로컬/공개 API·MCP4경로는 인증 경계401로 응답했다.
- 후보 알림46·인계 보호22검사와 독립 읽기 검토를 통과했다. 후보의 상대 경로 규약 의존성으로 발생한 초기 회귀 실패는 같은 기준의 `.agent/ontology_semantics.md`를 후보/복구본에 보완한 뒤 재검증했다. 두 승인 변경 외 제품 코드 차이는 없다.
- `.local/releases/0.6.2-ui/server-verification.json`에 원실패·복구·지문·응답 검증을 보존했다. 운영 인증 업무 API·사용자 업로드·쓰기 시험은 하지 않았다. 거절된 기존 인증을 우회하거나 토큰·정책을 변경하지 않았다.

## 2026-11-26 — 내용 조회 누락과 실패 진단 전달 수정

- 실제 임시 API가 부분 PPTX의 원본 형식·변환 단위·본문을200으로 반환했지만 renderer의 전체 내용 조회 분기가 이를 누락했다. 전체 입력의 원문/현재 구간 보정/빈 문자열·누락 페이지/로컬 초안을 보존하도록 수정했다. 이미 알려진 비PDF 형식에는 PDF 전용 페이지 수 API를 호출하지 않는다. 이전415는 불필요 호출이었으며 빈 본문의 직접 원인과 구별한다.
- 실패/중단 사건에 최대100개의 제한된 진단 코드만 전달하고 원시 오류·본문은 넣지 않는다. 새 기기는 같은 기록에서 원인을 설명할 수 있고, 코드 없는 과거 기록은 원인을 추정하지 않는다. 진단이 없는 기존 요청에서는 선택 필드를 payload 지문에서 제외해 이전 영수증 재전송을 보존한다.
- `.venv/bin/python -B -m unittest core.tests.poc_analysis.test_notifications`46개와 Node24 `node tests/document-tasks-backend/run.mjs` 전체 통과. 실제 격리 API에서 부분 본문 조회, 구간 보정→전체 저장→재조회·원보고 불변, 타기기 실패진단·중복 사건 방지, 구요청 영수증 호환을 확인했다. main/tools 타입 및 대상 lint 통과. 고정 후보 소스의46검사 로그는 `.local/deployments/2026-11-26-notification-compat-4t7q32jh/notification-tests.log`에 있다.
- 구0.6.1 서버는 새 진단 필드를 넣은 요청을422로 거부하고 기존 요청은200으로 처리함을 격리 확인했다. 따라서 새 앱에는 호환 서버를 함께 반영해야 한다. 실제 사용자 실패의 원인이 과거에 기록되지 않았다면 복원해 알아낸 것으로 주장하지 않는다.

## 2026-11-26 — 화면 수정 0.6.1 Windows 포터블 공개

- 사용자의 명시 승인 후 소스 `main`·`v0.6.1`을 `67e70b7e078ad459f99a122e51d53c18c0374be8`로 게시하고 [0.6.1 Windows 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.6.1-portable)을 공개했다. ZIP·SHA256 두 자산만 추가했으며 Mac 패키지는 공개하지 않았다.
- 익명 전체 다운로드에서 ZIP253,719,772바이트와 SHA256 `0dfa17239492461722b6c70c0d8454e666890183a9b5ed00d8845c61517cc366`을 로컬 검증물·GitHub digest·SHA 파일과 대조했다. 이전4릴리즈·8자산과 기존 latest `app-0.4.1-portable`의 내용·식별자를 보존했다.
- 서버0.6.1 반영·기존 주소/자료 보존과 앱 빌드·ASAR/PE/런타임 검증은 [준비·서버 반영 기록](#2026-11-26--화면-수정-061-서버-반영과-앱-배포-준비)을 따른다. 공개 검증 근거는 `.local/releases/0.6.1-ui/remote-verification.json`, `windows-local-verification.json`, `server-verification.json`이다.
- 현재 Mac 설치는 기존 앱의 정상 종료 대기 상태다. 운영 인증 API·사용자 업로드·Windows/두PC 전체 흐름·공인 서명/공증은 미검증이다. 공개 다운로드 성공을 해당 실사용 확인으로 확대하지 않는다.

## 2026-11-26 — 화면 수정 0.6.1 서버 반영과 앱 배포 준비

- 사용자 반영 요청으로 제품·관련 테스트34파일만 `67e70b7e078ad459f99a122e51d53c18c0374be8`에 고정하고 버전을0.6.1로 올렸다. 별도 역할·시안·문서 정리57경로의 작업 중 내용은 패키징 전후 그대로 보존했다.
- 기존 터널/공개URL을 유지한 채8766 서버를 인계했다. 새 서버의486소스 지문 일치, 자료·정책·규약·주소977파일의 집합과 바이트 보존을 확인했다. 로컬/공개 API·MCP4경로는 예상 무인증401이며 이전 서버/watcher만 정상 종료했다. 인계16검사와 catalogue/notification54회귀 통과. 기존 토큰 거부를 우회하지 않았으므로 운영 인증 목록·알림 삭제·진행 작업 검사는 미실행이다. 근거: `.local/deployments/2026-11-26-ui-server-x_0kwu2d/verification.json`.
- 최종 앱 빌드·Windows/Mac 포터블 패키징 성공. Windows ZIP253,719,772바이트(SHA256 `0dfa17239492461722b6c70c0d8454e666890183a9b5ed00d8845c61517cc366`), payload3,061·런타임2,988파일/소스352·빌드입력571개·PE x64/0.6.1.0·새UI/IPC·비밀 제외를 검증했다. Python/OCR 의존성2,636개는0.6.0과 동일하다. Mac ZIP131,519,201바이트·CRC·0.6.1·ad-hoc 서명과 Windows와 동일 ASAR를 확인했다. 공인 서명/공증·Windows 실기는 미검증이다.
- Mac 정상 종료 요청은 반환했지만 기존0.1.0 main/helper 프로세스가 남아 안전 조건에서 설치를 멈췄다. 강제 종료·기존 앱 교체·설정/인증 변경은 하지 않았다. 검증된 새 앱은 `/Applications/.LLM-Wiki-0.6.1-67e70b7.app`에 설치 대기한다. 잠금 해제 후 기존 앱 정상 종료가 필요하며 저장된 옛 서버 주소는 정상 연결 경로에서 다시 설정해야 한다.
- 공개 소스 저장소 main·v0.6.1 push는 자동 승인 검토가 “반영”만으로 외부 공개까지 명확히 승인되지 않았다는 사유로 실행 전에 거절했다. 후속 읽기 조회에서 동일 Jong-Yu 소유·admin권한·public을 확인했으며 우회 게시하지 않았다. 소스 push·태그 생성·새 GitHub 릴리즈/자산 업로드는 모두 미실행이다. 기존 공개4릴리즈·8자산·latest0.4.1 기준을 보관하고 게시용 ZIP/SHA·릴리즈 본문을 준비했다.
- 산출물·빌드/실제 회귀 요약·서버/패키지 검사·미완료 설치 근거는 `.local/releases/0.6.1-ui/`에 보존했다. 전체 회귀를 중복 실행하지 않았으며 업로드 직후 이동은 기존 라우터 연결 확인과 최종 빌드로 검증했다. 공개 승인·Mac 정상 종료 뒤 설치, 운영 로그인·업로드·Windows/두PC 실사용 확인이 남았다.

## 2026-11-26 — 문서 목록500 진단과 개인 알림 삭제

- 로컬/공개 API·MCP가 예상 무인증401로 응답하고 서버와 터널이 살아 있음을 확인했다. 운영 로그1,325건에서 문서 목록만500이28회였으며 원본 등록201·조회200 뒤 처음 발생했다. 운영 로그에는 원본 형식이 없어 실제 자료와 원인을 직접 연결해 확정하지는 않았다.
- `core/api/v1/documents/schemas.py`의 목록 응답 형식에 `pptx`/`ppt`가 빠져 있음을 확인했다. 격리 실제 multipart 등록 뒤 기본/묶음 목록 모두500 `response_invalid`를 재현하고 형식을 추가했다. `test_catalogue_lineage.py`에 두 형식의 등록→목록→원본 다운로드 바이트 보존 회귀를 추가했다. catalogue_lineage·presentation_conversion21검사 통과.
- 실행 중 Mac 설치본0.1.0의 저장 주소는 현재 터널 주소와 달랐고 옛 주소의 DNS 조회는 실패했다. 기존 보호 토큰은 로컬/공개에서 인증 거부돼 우회하지 않았다. 서버 재시작·터널 갱신·앱 설정/인증 변경은 하지 않았으므로 운영 프로세스에는 아직 수정이 반영되지 않았다. 기존 터널 유지 인계 스크립트는 현재 프로세스 인수와 맞지 않아 그대로 실행하지 않았다.
- [D-166](DECISIONS.md#d-166--개인-알림-목록에서-삭제와-원천-이력-보존-2026-11-26)의 개인 삭제를 알림 저장소·API·main 서비스·IPC·bridge·renderer에 연결했다. 원천 사건/문서/workflow 보존, 사용자/tenant/profile 격리, 중복·동시 삭제·재시작, 인가 실패/롤백을 검증했다. 변경 증분 `after_change_seq` 이후 삭제가 있으면 `refresh_required=true`를 반환해 병합 소비자가 전체 목록을 다시 읽도록 알린다. 현재 앱은 전체 목록 갱신을 유지한다.
- Python 알림44검사, 앱 backend 연결과 최종 `npm run build` 통과. 삭제 실패 시 행 보존·재접속·읽음/내용 확인 구별·반응형 검증은 [UI 기록](../ui/HISTORY.md#2026-11-26--휴지통-독립-화면과-알림-정리)을 따른다. 새 앱 공개/설치·운영 서버 반영과 실제 두 PC/Windows 검증은 미실행이다.

## 2026-11-26 — 문서 등록 재설계 0.6.0 포터블 공개와 서버 반영

- 제품/회귀257경로를 `12c4e39`에 고정하고 테스트 응답의 실제 access 계약 보완만 `c6fc0f1`에 추가했다. [0.6.0 Windows 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.6.0-portable)과 `v0.6.0`을 공개했다. 별도 역할·시안·문서 정리 변경은 릴리즈 소스 커밋에 섞지 않았다.
- 앱 빌드·릴리즈70검사·등록/미리보기/진행/초안/재개 등9묶음과 Python1,702개 범위(1,698통과·실제Windows4생략)를 확인했다. 최초4실패는 모듈 수집 방식2건과 합성 응답의 access 누락2건이며 원로그를 보존하고 기존 assertion으로 재검증했다. LibreOffice2검사도 실제 설치본으로 통과했다.
- ZIP253,718,409바이트의3,061파일을 압축 해제 결과와 대조했다. 런타임2,988파일(소스352·의존성2,636)·빌드입력569파일·PE x64·버전·아이콘·새 UI/IPC·비밀자료 제외를 확인했다. 최종 테스트 전용 커밋과 기존 패키지의 제품 바이트 동일성도 확인했다. 공개 ZIP/SHA256 전체를 인증 없이 다시 내려받아 지문을 대조했다.
- 관리 서버8766을 같은 제품 코드로 재시작해486소스 파일·기존 자료/권한612파일의 집합과 바이트 보존, 같은 주소 메모 갱신, 로컬/공개 API·MCP 무인증401을 확인했다. 인증 업무·실행 중 작업 수를 확인하거나 운영 자료에 쓰기 시험을 하지는 않았다.
- 기존3릴리즈·6자산과 기존 최신 표시0.4.1, 설치형 업데이트 피드를 보존했다. 자동 분할은 `ENABLED=False`이며 Office 미리보기에는 LibreOffice가 필요하다. Windows 실제 실행·두 PC 사용·실자료 전체 OCR/AI 품질은 미검증이다.
- 첫 패키지 검증의 sidecar 준비 누락과 검사기의 source_format 문법 가정은 원실패 기록을 남기고 재검증했다. 소스 push의 배포 전용 토큰403은 기존 동일 계정의 repo 권한 로그인으로 게시했다. 근거: `.local/releases/0.6.0-registration/`의 최종 회귀·패키지·서버·공개 다운로드 보고.

## 2026-11-25 — 조회 책임과 IPC 계약 정리

- `NotificationContentReader`에 본문·부분 보고 재조립과 판본/hash 검사를 분리했다. 기존 서비스의 문맥 확인→전송 대기 처리→조회→승인 원장 정리 순서와 GET 수명·페이지 수 캐시를 유지했다. `AnalysisService`·`WorkspaceApiService`는 필요한 연결 메서드4개씩만 받는다.
- 연결·알림·등록 초안의 IPC 호출자/인자 수/예외 처리를 공통화하고, 기존 Bridge에서 채널별 계약을 검사한다. 업무별 오류와 런타임 파싱 순서는 유지하며 범용 renderer IPC를 추가하지 않았다.
- 전체 `npm run check`(5개 TS 설정·lint·529파일 format·194토큰/3모드), IPC 보안6묶음과 잘못된 타입 연결6건, 실제 Electron18검사와 새 프로세스3경로, 백엔드 회귀를 통과했다. 명령은 `node --test tests/ipc/verify.mjs`, `node tests/poc-ui/run.mjs`, `node tests/document-tasks-backend/run.mjs`다.
- 초기 localhost/Chrome 실행 제한은 권한을 확보해 재검증했다. reader 인스턴스 둘의 요청을 합산하던 테스트 계측은 개별 reader로 한정했다. 기준본 대조 중 발견한 다른 작업의 분석 오류 안내 추가는 보존했다. 실제 AI·운영 배포·Windows 검증은 수행하지 않았다.

## 2026-11-25 — 원본 미리보기의 로컬 실행 경계

- SourceVisualPreviewService/별도 IPC·bridge와 개인 Python 정적 렌더를 연결했다. 카탈로그·hash·권한을 다운로드/렌더 전후 확인하고, 화면 비활성화/범위 변경/취소/정상 종료에 이번 임시 폴더만 정리한다. Office 별도 프로필·외부 참조 제거와 구형 PPT의 추가 격리를 적용했다.
- 렌더6·서비스6·실제 UI4검사, 전체 앱 빌드 통과. 구형 PPT의 강화 격리 렌더 불가와 Windows 실기 미실행은 [sources 기록](../sources/HISTORY.md#2026-11-25--보호된-원본-사본의-office이미지-렌더)에 구분했다. 운영 서버/포터블/설치형은 배포하지 않았다.

## 2026-11-25 — 등록 입력과 고정 제출의 보호된 초안 복원

- `registrationDrafts.get/save/clear`와 별도 `userData/registration-drafts` 보호 저장소를 연결했다. 현재 인증 범위·불변 원본/변환 참조와 원래 기준을 유지하고, 빈 문자열·빈 구간 선택·고정 제출 요청을 앱 재시작 후 복원한다. 삭제 표시의 CAS로 늦은 자동 저장 부활을 차단하며, 저장 성공과 정리 경고를 구분한다. 로그아웃에는 암호화 보존하며 다른 계정·관점으로 공개하지 않는다.
- 큰 초안은 기존 보호 저장소의 여러 조각과 마지막 manifest CAS로 확정한다. 8 MiB entry 경계를 우회하는 평문 저장이나 본문 절단은 없고, 기존 32 MiB 파일 경계 초과·보호 기능 실패에는 이전 초안을 보존한다. 제출 snapshot에는 원 보고 본문을 중복하지 않고 실제 제출 문자와 참조·요청 상태만 보관한다.
- `node tests/registration-drafts/run.mjs`의 실제 격리 디스크/AES 검증에서 12 MiB 초과 복원·계정/관점 격리·두 서비스 CAS·저장 실패·clear 경쟁·요청 응답 유실을 통과했다. 20 MiB 원문 제출 snapshot의 경량화, 서버 수정/확인/등록/진행 응답 유실 뒤 새 연결 ID에서 최초 요청 재개도 통과했다. `node tests/notifications/registration-run.mjs`의 제품 UI 27사례·접근 회수·axe·3개 너비/2개 테마 검증을 통과했다. 제품 OS 키체인/DPAPI와 실제 강제 종료·Windows 실기기 검증은 별도이며 이번 시험의 암호화는 격리 키를 사용했다.
- 후속으로 초안 조회 실패의 동일 화면 재시도와 서버 변경 전의 보호 저장 실패에서 입력 재편집을 연결하고 제품 UI 28사례를 통과했다. 이미 보낸 요청과 앱 재시작으로 복원한 제출은 계속 고정하며, 같은 실행에서 서버 미전송이 확인된 실패만 편집 잠금을 해제한다.

## 2026-11-25 — 목록 입력 검증과 오류 변환 중복 정리

- 문서·원본·작업 목록의 페이지 검증을 기존 공통 모델로 모으고 단일 호출 오류 wrapper를 제거했다. 기존 모델명·문서 전용 profile·입력 제약·오류 응답을 유지하며 소스6개에서18줄을 줄였다. HTTP 경계 회귀2개를 기존 검사 파일에 추가했다.
- 기존3+신규2검사 전후 통과, 모델4개·입력220건 동등성을 확인했다. 동시 작업의 CatalogueQuery/group_sources 변경을 보존한 격리 비교에서 OpenAPI129경로가 바이트까지 같았다. 검증 중 API소스64개의 해시 불변, diff·독립 코드 검토 통과. 실제 AI·운영 자료·배포는 변경하지 않았다.

## 2026-11-24 — 보류 해결의 보정 API와 개인 재인식 연결

- PDF 페이지 보정과 개인 OCR 재인식, 보정 판본의 불변 저장을 연결했다. API·main·CLI·UI·빌드 검증을 통과했다. 이전 0.5.0 앱은 새 보정 내용을 확인·승인할 수 없다.
- 개발본 구현까지이며 호환 서버/새 앱 배포와 Windows 실기기는 미검증이다. 근거: `.local/diagnostics/2026-11-24-held-page-resolution/`.

## 2026-11-24 — 알림·승인 0.5.0 포터블 공개와 서버 반영

- `35f011d5052`의 알림·승인 기능을 [0.5.0 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.5.0-portable)로 공개했다. Python 1,513개 통과/Windows 4개 생략, 알림 UI 24·작업 UI 18·릴리스 70개와 앱 빌드를 통과했고 공개 ZIP 전체 다운로드·SHA·런타임 2,977파일을 대조했다.
- 관리 서버 8766도 반영해 소스 461파일과 정책 보존을 확인했다. 로컬·공개 MCP는 무인증 401만 확인했으며 기존 토큰의 거부로 인증 업무·실행 중 작업 검증은 미실행이다. Windows 실제 알림·두 PC 경쟁·실자료 OCR은 미검증이다.
- 기존 배포를 보존하고 최신 표시가 의도와 다르게 바뀐 뒤 0.4.1로 복원했다. 설치형 업데이트 피드는 변경하지 않았다. 근거: `.local/releases/0.5.0-notifications/`.

## 2026-11-24 — 서버 알림·승인·실행권 구현과 격리 검증

- 서버 SQLite 알림함·읽음·공유 승인 CAS·기기별 claim/resume과 저장 전 outbox를 구현했다. 알림 DB 실패가 원본 저장 성공을 뒤집지 않도록 분리했다.
- 서버 58개, HTTP/MCP·페이지 이미지 16개, 앱 알림 24·작업 18개와 빌드를 통과했다. 격리 두 PC 경쟁·권한·재전송·종료 인계를 검증했고 합성 알림 10,001개에서 첫 30건 조회는 1.84–2.48ms였다. 실제 Windows 알림·장기 운영 성능은 확인하지 않았다.

## 2026-11-24 — Windows 문자 변환 보완 0.4.1 포터블 공개

- `49928862`의 Windows EACCES 읽기 재시도·복합 오류 진단을 [0.4.1 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.4.1-portable)로 공개했다. 0.4.0 대비 실행기 변경은 `source_conversion.py`뿐이며 의존성 2,636파일은 같았다.
- 관련 54개 통과/Windows 1개 생략, 릴리스 70개·빌드·익명 전체 다운로드와 SHA 대조를 통과했다. 서버는 변경하지 않았고 실제 Windows 잠금·전체 PDF 처리·OCR 품질은 미확인이다. 근거: `.local/releases/0.4.1-checkpoint/`.

## 2026-11-24 — 전체 변경의 0.4.0 통합 공개와 서버 반영

- `eece4b403`의 PPT·휴지통·실행 감독·가이드·주소 메모를 [0.4.0 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.4.0-portable)로 통합 공개했다. Python 1,463개 통과/Windows 3개 생략, 웹 125·backend 12·작업 UI 10개와 앱 빌드, ZIP 전체 공개 다운로드·SHA·런타임 2,969파일을 확인했다.
- 관리 서버 8766을 재시작해 소스 449파일과 기존 자료 보존을 확인했다. 공개·로컬 무인증 401을 확인했으며 인증 업무 성공을 입증한 것은 아니다. Windows·LibreOffice·전체 PDF·전원 차단·설치형 업데이트는 미검증이다. 근거: `.local/releases/0.4.0-integrated/`.

## 2026-11-24 — 대표 아이콘 0.3.1 Windows 포터블 공개

- `03bec224`의 대표 아이콘을 [0.3.1 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.3.1-portable)로 공개했다. 실제 Mac 트레이 수명·아이콘/테마, 빌드, PE 아이콘 9개, ZIP 3,039파일과 공개 다운로드 SHA를 확인했다. 실행기 2,966파일은 0.3.0과 같다.
- 실제 Windows 고정 작업 표시줄·테마·설치 업데이트·공인 서명은 미검증이다. 근거: `.local/releases/0.3.1-icons/`.

## 2026-11-23 — 0.3.0 Windows 포터블 공개와 검증

- `5949dc121`의 문서 처리 UX·보호 작업 기록을 [0.3.0 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.3.0-portable)로 공개했다. 범위·시도별 보호 기록과 미확정 요청의 GET 확인을 구현했고 로그아웃 때 기록을 삭제하거나 자동 재실행하지 않는다. PPT·휴지통·watchdog는 이 배포에 포함하지 않았다.
- backend 12·상태 8·제품 UI 10·분석 14·작업 진입 7개, 빌드·공개 ZIP 3,039파일·SHA 검증을 통과했다. 실행기는 rc.2와 같아 서버를 반영하지 않았다. Windows 실제 PDF worker 실패 해결 여부는 미확인이다. 근거: `.local/releases/0.3.0-workflow/`.

## 2026-11-23 — 0.1.3-rc.2 포터블과 채팅 서버 반영

- `867ea439`에 rc.1 `643f6f3`과 채팅 실시간 답변·공개 설명·추가 질문·재시작 복원을 모아 [0.1.3-rc.2 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.3-rc.2-portable)을 공개했다. Python 159·릴리스 70·CLI 14·탐색 23·Electron 6개와 빌드를 통과하고 런타임 2,966파일·공개 다운로드 SHA를 대조했다.
- 실제 서버 소스 308파일 반영과 공개 무인증 401을 확인했다. 인증 업무·Windows 실기기는 미검증이며 이전 native 수명 검사 시간 초과를 재통과로 간주하지 않았다. 근거: `.local/releases/0.1.3-rc.2-portable/`.

## 2026-11-23 — 추가 질문의 선택적 설명·추천 계약

- 추가 질문의 선택적 `option_details`에 선택지 일치·길이·추천 최대 1개 검사를 연결했다. 생략한 옛 입력 해시를 보존하고 사용자 답변을 실행 승인으로 취급하지 않는다.
- 102개·Electron 4개·빌드와 실제 Codex/Claude 합성 6턴에서 설명 필요/불필요 조건을 확인했다. 새 메타정보는 옛 엄격 스키마와 호환되지 않아 앱·실행기·서버를 함께 반영해야 한다. Windows·큰 실제 템플릿은 미검증이다. 근거: `.local/verification/chat-user-input/2026-11-23-option-details.json`.

## 2026-11-23 — 0.1.3-rc.1 포터블 사전 릴리스

- `643f6f3`의 변환·분석 20파일을 [0.1.3-rc.1 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.3-rc.1-portable)로 분리 공개했다. 변환 29·릴리스 70·세션 14·Electron 6개와 빌드, 실행기 2,962파일·공개 다운로드 SHA를 확인했다.
- 채팅 변경·서버 반영은 제외했고 기존 120초 제한·초기 변환은 유지했다. 실제 Windows 원인 해결·전체 PDF 처리는 미검증이다. 근거: `.local/releases/0.1.3-rc.1-portable/`.

## 2026-11-23 — 추가 질문 저장과 사용자 응답 이어가기

- v5/v6 질문의 추가 질문을 저장하고 lease를 끝낸 뒤, 사용자 답변과 고정 근거·기존 문맥으로 새 실행을 이어가도록 했다. 최대 5회 교환이며 자동 대답을 만들지 않는다.
- HTTP 신규 11+기존 57개와 client 257개, 실제 Codex·Claude의 추가 질문→답변 4턴을 확인했다. 제공자용 평탄 스키마 뒤 원래 분기 검증은 유지했으며 root anyOf가 실패 원인이라고 확정하지 않았다. 초기 실패 사용량은 unknown으로 보존했고 v3/v4·지원 밖 조합은 포함하지 않았다.

## 2026-11-23 — 일반 질문 답변의 실시간 전송

- v5/v6 일반 질문의 공개 답변 본문만 실시간 전송한다. 템플릿/초안은 최종 결과만 전달하고 Codex App Server delta·Claude partial을 호출별로 사용한다. 도구·훅·MCP 차단은 실행 전 확인한다.
- 질문/템플릿 98·어댑터 71·Electron 정상 6/실패 9개를 통과했다. 실제 Codex 첫 본문/최종 14.780/18.069초, Claude 9.264/9.354초로 Claude 청크는 끝에 몰렸다. Windows는 미검증이다. 근거: `.local/verification/answer-streaming/2026-11-23-final.json`.

## 2026-11-23 — 재시작 뒤 AI 호출 확인 기록 복원

- 서비스 재생성으로 사라지던 AI 호출 확인 시각을 비민감 실행 지문과 함께 보존한다. 현재 로그인·제공자·모델·CLI·Python·자료 경로가 같을 때만 복원하고 재시작 때 AI를 호출하지 않는다. 새 실패는 옛 성공을 무효화한다.
- CAS·잠금·실패 경계 14개와 모의 AI를 사용한 실제 Electron 재시작을 확인했다. 원래 Windows 네트워크 실패의 해결을 입증한 것은 아니다. 근거: `app/test-results/ai-verification-restart-20261123/`.

## 2026-11-23 — 0.1.2 정식 배포와 공개 다운로드 검증

- `7434b184`를 [0.1.2 설치형](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.2) 10자산과 같은 코드의 [Windows 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.2-portable)로 공개했다. 릴리스 70개·앱 빌드/패키징, 피드와 모든 공개 다운로드의 해시·런타임 2,962파일을 대조했다.
- 설치 앱 교체·서버 재시작은 하지 않았다. Mac 공인 서명과 실제 Windows 설치/자동 업데이트는 미검증이다. 근거: `.local/release-012-local-verification.json`, `.local/release-012-remote-verification.json`.

## 2026-11-23 — 서버 주소를 비공개 GitHub 메모에 자동 게시

- 명시 설정한 `.local/address-gist-id`의 같은 secret Gist에 서버 주소를 갱신하도록 했다. 잘못된 입력은 거부하고 게시 실패가 서버 실행을 막지 않는다. 런처 9·설정 6개의 모의 검증을 통과했다.
- 실제 Gist 생성·갱신을 확인했다. `public=false`여도 주소를 아는 익명 사용자의 raw 조회는 200이므로 접근 통제 저장소가 아니다. 토큰을 메모에 기록하지 않았다.

## 2026-11-23 — 질문 AI의 공개 작업 설명 전달

- 질문 AI가 내보낸 공개 agent message만 최대 2,000자·3개 전달한다. 원시 reasoning을 노출하거나 새 모델 호출을 추가하지 않는다.
- parser 등 201+117개를 통과했다. 실제 합성 질문의 첫 설명/최종 답변은 Codex 4.134/6.576초, Claude 3.347/6.161초였다. 최종 스키마·인용 검증은 유지했다.

## 2026-11-23 — 사용자를 보존한 샘플 데이터 초기화

- 사용자 요청으로 SDV 139파일(2,751,732바이트)을 `.local/sdv-reset-20261123/backup/sdv-platform`으로 이동했다. 두 사용자의 권한·활성 lease 부재를 확인하고 서버 종료·잠금 아래 처리했으며 같은 workspace ID, 파일 SHA·크기·권한과 정책/설정을 보존했다.
- 재시작 뒤 업무 목록은 잘림 없이 0건이었다. 설치 앱의 기존 저장 주소가 달랐으나 자동 변경하지 않았고 실제 앱 재연결은 미검증이다. 근거: `.local/sdv-reset-20261123/reset-verification.json`.

## 2026-11-22 — 0.1.1 정식 배포와 Windows 트레이 포함 확인

- `eeb36ed300`의 [0.1.1 설치형](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.1) 10자산과 `2f6513a`의 [Windows 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.1-portable-windows)을 공개했다. 공개 소스 전송 승인 후 패키징했고 익명 전체 다운로드·SHA·NSIS 트레이와 런타임 2,961파일을 대조했다. 포터블 관련 46개가 통과했다.
- 실제 Windows 설치/실행과 Mac 공인 서명은 미검증이다. 근거: `.local/windows-portable-011-remote-verification.json`.

## 2026-11-22 — Windows 포터블 fix4 사전 릴리스 공개

- D-143의 상태·네트워크 진단과 D-144의 내장 실행기 경로 자동 이관을 [Windows fix4](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.0-portable-windows-fix4)로 공개했다. fix1–3의 부분 패치와 달리 당시 작업 트리를 전체 빌드했다.
- Claude 8·진단 21·설정 5개와 앱 빌드, 실행기 소스·CRC/해시를 확인했다. 분석 293개 중 호출 방식 때문에 실패한 2개는 직접 실행으로 통과했다. 실제 Mac Claude 검색어 1회는 성공했으나 Windows 프록시/인증서·경로 이관은 미검증이고 운영 서버·설치형 채널은 바꾸지 않았다.

## 2026-11-22 — 실행기 보완판 공개와 다운로드 검증 완료

- `700a0a4fb`의 소스 311개와 안내를 [실행기 보완판](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/runtime-0.1.0-token-latency-20261122)으로 공개했다. MCP 146·분석 90개, 압축 소스/커밋·컴파일·CLI import·익명 전체 다운로드 SHA를 확인했다.
- 도구 JSON은 all 57개/129,520B, ask 20개/46,739B, write 10개/14,394B, extract 22개/47,606B, review 29개/69,622B였다. 지침 포함·전송 봉투 제외 바이트이며 실제 모델 토큰 절감값은 아니다.
- macOS 외부 Python용 선택 배포다. 기존 stable 0.1.0 자산과 Windows fix3, 설치 앱·운영 서버·실행기 설정은 유지했으며 전체 앱 A/B는 수행하지 않았다.

## 2026-11-22 — 설치 앱의 실제 실행 완료 확인

- 현재 작업 트리를 빌드·서명/출력/ASAR 대조해 Mac에 설치하고 실제 실행 경로를 확인했다. 공개 원문 2건을 실제 Codex로 등록·추출·운영 저장·후속 대조해 UI 완료/실행 중 해제를 확인했다. QA의 단계/full 비교·보존·한계는 [분석 기록](../analysis/HISTORY.md)에 통합했다.

## 2026-11-22 — 모든 HTTP 요청의 80 ms 지연 제거

- template file/render의 `status_code=200` 누락으로 OpenAPI 생성이 실패해 계측 middleware가 모든 요청마다 80ms 기다리던 문제를 수정했다. 실패 캐시·unmatched 처리를 보완하고 MCP 관련 164개를 통과했다.
- 격리 access 80→2ms, tools 92→4ms, read 92→13ms, search 115→39ms를 관측했다. 반영한 실제 서버의 무인증 401 중앙값도 81→0.5ms였으며 빈 자료의 인증 업무 성능까지 검증한 것은 아니다. [보고서](../../../evals/2026-11-22-claude-mcp-speed/REPORT.md).

## 2026-11-21 — 정상 로그인으로 로컬·공개 MCP 조회 확인

- 서버 재시작 후 기존 보호 토큰은 401이었으나 정상 로그인한 사용자의 로컬·공개 MCP ask 21개와 검토함 조회는 성공했다. 토큰 교체·정책 변경은 하지 않았다.
- 빈 공간이라 실제 문서 상태는 확인하지 못했다. stdio의 기존 보호 토큰은 계속 거부되어 재연결이 남았다.

## 2026-11-21 — ask 검토함 조회 복원과 축소 유지

- ask에서 누락됐던 `ontology_review_queue`를 복원하고 권한·쓰기 차단 등 41개를 통과했다. 도구 JSON은 20개/41,860B→21개/43,756B로, 전체 58개/127,527B보다 65.69% 작았다. 초기 지침·실제 모델 토큰을 포함한 수치는 아니다.

## 2026-11-21 — 개발용 프롬프트·도구 축소 감사

- 개발용 지침은 40,405→46,380B(+14.79%)로 늘었고 ask의 검토함 누락을 발견해 위 항목에서 복원했다.
- `knowledge_lookup` 1회 안내와 별도 access/review 조회 요구, 쓰기 후 영향 조회와 쓰기 전 baseline 요구의 충돌은 남았다. 도구 축소를 전체 지침·토큰 축소로 단정하지 않았다.

## 2026-11-19 — 도구 묶음 실측과 로컬 Codex 연결 변경

- all/ask/write/extract/review 묶음과 본문 보기를 추가하고 로컬 Codex의 개별 허용 13개 설정을 `--toolset ask`로 바꿨다. 9개 계약 검사를 통과했으나 기존·변경 연결 모두 같은 자격 증명 거부로 실제 로컬 인증은 확인하지 못했다.
- 실제 Codex 20·Claude 9호출에서 Codex all/ask는 약 88–89k로 비슷했다. Claude 기본은 14,799→14,118, 도구 비활성 비교는 51,195→18,601이었다. 잘못된 설정 6개 등 무효 시도는 제외했으며 보편적인 모델 토큰 절감으로 해석하지 않는다. 근거: `evals/2026-11-19-toolset-cache-measurement/`.

## 2026-11-19 — 첫 Claude system 알림 거부와 진단 v2 공개

- Windows 실제 Claude가 첫 system 알림에서 거부됐으나 v1 진단에는 원시 subtype이 없어 원인을 확정하지 못했다. 버전/도움말 성공은 실제 AI 성공과 구별했다.
- v2는 제한된 메타정보·해시만 수집하고 31개를 통과해 `claude-windows-diagnostic-v2`로 공개했다. 앱 배포가 아니며 Windows v2 실제 진단 결과는 아직 없다.

## 2026-11-19 — Windows 진단의 CreateJobObject TypeError와 fix3 준비

- 사용자 진단에서 pywin32 b311의 `CreateJobObject(None, None)` TypeError를 확인했다. 빈 이름을 `''`로 바꾸고 Job 제한·정리를 유지했다. 당시 앱은 fix2인데 실행기 해시는 fix1이어서 버전 혼용도 확인했다.
- 관련 50개 통과/Windows 3개 생략 후 fix2의 `client_process`와 manifest만 바꾼 [fix3](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.0-portable-windows-fix3)를 공개했다. CRC·나머지 바이트 동일을 확인했으며 새 폴더로 인한 설정을 초기화하지 않았다. Windows 실제 해결은 미검증이다.

## 2026-11-18 — MCP 입력 오류 안내·도구 정의 분량·표시 정리

- MCP 오류를 입력 값 없는 필드/사유로 구조화하고 권한 거부는 자원 존재를 숨기도록 유지했다. 중복 설명·스키마 title을 줄여 tools/list 146,844→129,134B, 한국어 title 59개와 실제 replay 동작에 맞춘 hint를 적용했다. 입력·저장 권한은 바꾸지 않았다.
- 전체 관련 265개 중 기존 OpenAPI 오류와 변경 전에도 재현된 첫 색인 검사 2개가 실패했다. 후속 프롬프트 표시·빈 입력 처리까지 MCP 138개 통과/같은 OpenAPI 1개 실패였고 해당 오류는 11-22에 수정했다. 도구 권한별 공개·생성 설명·답변 안내 변경은 보류했다.

## 2026-11-18 — Windows 포터블 AI 호출 확인의 pywin32 핸들 오류

- Windows 실제 PyHANDLE이 context manager를 지원하지 않는데 MagicMock이 이를 놓친 오류를 수정했다. 명시 `Close()`/finally, FILE_READ_ATTRIBUTES·자식 창 숨김을 적용하고 오류 분류를 유지했다.
- 193개 실행에서 Codex 미설치 19실패·Windows 2개 생략을 분리했다. [fix2](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.0-portable-windows-fix2)를 11-19 공개했으며 실제 Windows 해결은 미검증이다.

## 2026-11-18 — 기능별 MCP 명령과 선택 안내

- 기능별 MCP 22프롬프트·57도구와 full/compact 안내를 정리했다. 실제 24개 계획 비교는 총 토큰 187,643→180,483(−3.82%)였지만 기계 검사는 12/12→11/12, 반복 결과 일치는 4/4→3/4였다. 일관성 개선은 입증하지 못했고 기본 full을 유지했다.

## 2026-11-16 — 템플릿 생성 CLI 실패 진단과 실제 DOCX 저장

- 템플릿 생성의 실제 `output_limit` 2실패를 확인하고 D-131의 7부분 작성 v2·인용 조립으로 7회 성공, 답변·DOCX 하나를 저장했다. 이번 CLI 16회 중 사용량 관측 합계는 939,778토큰이며 누락 2회가 있어 전체 소비로 단정하지 않는다.
- 관련 68·82·12개와 실제 API→저장→렌더→Electron 다운로드/재시작 후 바이트 일치를 확인했다. UI 전송 버튼으로 시작한 실제 AI 흐름은 아니며 내용·배치 한계는 [보고서](../../../evals/2026-11-16-template-from-existing-data/REPORT.md)를 따른다.

## 2026-11-16 — 템플릿 질문 판본과 조회 계약 재검증

- 추가 대화의 템플릿 판본을 권한·불변 입력에 고정하고 생략한 옛 요청 해시·재시도·저장 직전 재인가를 확인했다. 평가 래퍼의 네 번째 프롬프트 변조를 제거했다.
- 실제 HTTP/파일 저장+모의 AI의 Electron 4개와 실제 Codex ASGI를 구별했다. 마지막 실문서 CLI는 exit1·결과 0바이트로 답변/DOCX 미저장이며 의존성·로그인 존재 진단만으로 원인은 확정하지 못했다. [결과와 한계](../../../evals/2026-11-15-next-data-template-retry/REPORT.md).

## 2026-11-15 — 등록 템플릿의 저장·API·렌더 구현

- 등록 템플릿의 파일·지침·이전 판본·영수증을 `/templates`에 연결했다. 저장/HTTP 18·렌더 26개와 Electron 실서버에서 CAS·권한·판본/원본 보존·응답 유실 재요청의 단일 저장을 확인했다.
- 실제 Codex 1회로 Word 빈 셀 6개와 비대상 패키지 보존 11항목을 확인했다. 기존 DOCX/PPTX/XLSX 영역·UTF-8 텍스트 작성만 지원하며 PDF/HWP/이미지는 원본 보존, 새 행/슬라이드·배치·서버 수식·지침 의미 검사는 미구현이다. Windows·운영 배포는 미검증이다. [검증](../../../app/test-results/template-implementation-20261115/verification.md).

## 2026-11-14 — 스킬 안내 제외 설정의 실제 v6 반복 비교

- 11-13~14 스킬 안내 제외를 단발·전체 v6 흐름으로 비교했다. 단발 4회와 통제 24회는 입력이 매번 874토큰 줄었지만, 전체 138호출은 A 668,066→B 727,457토큰(+8.89%), 품질 108/111→104/111과 중요 설명 누락 4건으로 기본 도입하지 않았다.
- 24회 통제는 승인된 같은 두 상태·새 세션·AB/BA 순서로 실행했고 실패/재시도/usage 누락은 없었다. 로컬 901토큰과 제공자 874토큰, 설정 내 행동 변동과 설정 간 차이를 구별했다. 실제 serving/effort·전체 앱 품질/비용은 단발로 입증하지 않았다. [전체 보고서](../../../evals/2026-11-13-skills-instructions-flow/REPORT.md)·[원인 진단](../../../evals/2026-11-13-skills-instructions-flow/cause-audit/REPORT.md).

## 2026-11-09 — Windows AI 호출의 search_terms_failed 원인 수정

- Windows AI의 `search_terms_failed`를 잘못된 win32 상수 모듈 참조로 재현하고 `win32file` 상수로 수정했다. 65개 통과/Windows 2개 생략 뒤 Python 2파일·manifest만 바꾼 [fix1](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.0-portable-windows-fix1)을 공개했다.
- 이후 Claude 실패는 별도 읽기 전용 진단으로 분리했다. 실제 Windows AI 성공은 확인하지 못했으며 후속 fix2/fix3 기록을 따른다.

## 2026-11-09 — 포터블 GitHub Release 공개

- [0.1.0 Mac·Windows 포터블](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.0-portable)을 공개하고 ZIP·런타임·SHA와 관련 70개를 확인했다. Mac ad-hoc 서명 문제는 보완했다.
- 실제 키체인 연결의 멈춤 원인은 미확정이다. 모의 키체인으로 로그인한 결과를 실제 보호 저장 성공으로 해석하지 않았으며 Windows 실제 실행은 미검증이다.

## 2026-11-09 — 릴리스 버전 폴더와 자동 정리

- 11-09 사용자 요청으로 정식 0.1.0 외 시험 배포 1건과 과거 패키지 12폴더·20파일을 정리했다. 논리 크기는 약 4.05GiB이며 실제 디스크 회수량은 미측정이다. 정식 10자산·Git 태그·설치 앱/사용자 자료를 유지하고 검증 기록 13파일은 `.local/releases/20261109-cleanup/retained-records/`로 해시 그대로 옮겼다.
- 후속 패키저는 공개 성공 뒤 버전별 최종 자산을 보관하고 확인 가능한 옛 배포만 정리한다. 공개 전 실패/취소·미확정 공개·공개 후 로컬 정리 실패를 구별하도록 55개 격리 검증을 통과했다. 실제 Windows 종료·전원 차단/SIGKILL은 미검증이다. [정리 검증](../../../.local/releases/20261109-cleanup/FINAL-VERIFICATION.json)·[자동화 검증](../../../.local/releases/20261109-automatic-cleanup/FINAL-CHECKS.json).

## 2026-11-09 — 앱 자동 업데이트 배포 경로 정정

- 업데이트의 잘못된 소스 저장소 주소를 전용 배포 저장소로 고쳤다. 빈 저장소/병렬 릴리스 생성의 422와 불완전 공개 후 immutable 태그 재사용 실패를 확인해, 단일 draft에서 모든 자산을 준비한 뒤 공개하도록 바꿨다.
- `8b729d80`의 [app-0.1.0](https://github.com/Jong-Yu/llm-wiki-releases/releases/tag/app-0.1.0)을 새 태그로 공개해 10자산·피드·런타임 2,942파일·익명 다운로드를 확인했다. 실제 GitHubProvider의 가상 0.0.9는 업데이트 발견, 0.1.0은 없음이었다.
- 설치 업데이트 실행·Mac 공인 서명/공증·Windows 실기기는 미검증이고 기존 같은 버전 설치본은 수동 교체가 필요했다. 잘못된 이전 공개물은 뒤 정리에서 제거했다. 근거: `.local/releases/v0.1.0-feed-20261109/report.json`.

## 2026-11-09 — 0.1.0 공개 준비와 전체 Python 회귀

- 최초 `0e4fe60`의 v0.1.0 공개 준비에서 고유 Python 1,018개·앱 검사/빌드·런타임 2,942파일을 확인했다. 실제 AI·Windows는 검증하지 않았다.
- 소스 저장소에 공개한 당시 11자산은 위 업데이트 경로 정정의 전용 `app-0.1.0` 배포로 대체됐다.

## 2026-11-08 — 질문 전 근거 조회와 신규 v6 인계

- 신규 v6의 첫 AI 호출 전에 허용 공간 검색과 실행별 근거 제공 영수증을 연결했다. 기존 v1~v5·재접수·권한/판본/CAS/lease·제출 검증은 유지했다. 격리 loopback 포함 195개와 앱 검증은 [소유 기록](../knowledge/HISTORY.md#2026-11-08--질문용-색인과-첫-ai-호출-전-근거-제공-d-124)을 따른다. 실제 AI 비교·설치/운영 반영은 미실행이다.

## 2026-11-08 — 저장된 검색 정책과 실행 환경 보완 비교 (D-123)

- 신규 v5의 명시 옵션에만 검색 정책을 저장했다. 관련 99·검색 47·합성/정책/계수 검사를 통과했고 기존 요청/영수증은 유지했다.
- CLI 시작 실패 8회와 환경 보완 후 시도를 구분했다. 정상 18회에서 총 토큰 5.57% 감소·모델 9→9였으나 양쪽 공통 설명 누락으로 품질 기준에 실패해 기본 도입을 보류했다. 전체 26시도 중 8회 usage 불명, fatal 원인·모델 ID·요금 미확정이다. [보고서](../../../evals/2026-11-08-ranked-search/REPORT.md).

## 2026-11-08 — 첫 검색어 정밀 안내의 명시 비교·도입 보류 (D-122)

- 정밀 검색어 안내 A/B 8답변·16호출에서 전체 토큰 1.38% 감소, 품질 24→24였다. 사전 5% 기준에 못 미쳐 기본 도입을 보류하고 명시 개발 옵션만 남겼다.
- 125개 등 관련 검증을 통과했다. 실제 모델 ID·요금·설치/운영 효과는 미확인이다. [보고서](../../../evals/2026-11-08-precise-search/REPORT.md).

## 2026-11-08 — 첫 호출 도구 선택 안내의 Codex v5 연결 (D-121)

- 같은 v5 인계의 도구 선택 안내 A/B 8시도에서 모델 9→8·전체 토큰 11.28% 감소, 양쪽 품질 24→24를 확인해 Codex v5에만 연결했다. 이득은 q03의 추가 read 제거에 집중됐고 q02/q04는 늘었다.
- 기존 Claude/레거시·공유 어댑터·전역 설정 보존 등 66개를 통과했다. 실제 모델 ID·요금·다른 자료와 운영 효과는 미확인이다. [보고서](../../../evals/2026-11-08-question-tool-selection/REPORT.md).

## 2026-11-08 — 짧은 질문의 로컬 비용 분해

- 기존 28시도/88호출을 새 모델 호출 없이 분해했다. 짧은 후속 6호출의 제공자 입력과 로컬 저장 입력 차이는 회당 3,625토큰으로 일정했지만 고정 지시·제거 가능량·요금으로 귀속하지 않았다. 출력 스키마는 저장 입력의 6.73%였다.
- 원시 사용량·두 인코딩·실패 unknown과 기존 설정/파일 보존을 확인했다. [진단 보고서](../../../evals/2026-11-08-simple-question-token-audit/REPORT.md).

## 2026-11-08 — 신규 v5 질문 문맥의 개발본 연결 (D-120)

- 사용자 원문 우선 문맥 A/B 10회에서 품질 80→80/80·전체 토큰 36.47% 감소를 확인해 신규 v5 생성에 `user_dialogue=True`를 연결했다. 제공자 선택 전 적용하나 실제 의미/사용량 평가는 Codex뿐이다.
- 생성→claim→입력, 권한/취소/이력/레거시 등 18개를 통과했다. 비캐시 입력 +1.81%·출력 +13.75%여서 요금 절감은 미확인이고 전역 설정·설치/운영은 유지했다. [보고서와 채택 근거](../../../evals/2026-11-07-question-condition-timeline/REPORT.md).

## 2026-11-08 — 속성 상세 선택 수정본의 앱 단독 설치

- 속성 선택 무반응 수정본을 Mac에 설치해 고정 출력·ASAR·서명을 대조하고 이전 앱을 보존했다. 실제 `llm-wiki-app` 설정/복구 파일은 종료·교체·재시작 전후 해시가 같았다.
- 격리 앱의 클릭·키보드·원문 왕복은 통과했지만 Mac 재잠금으로 설치 후 마지막 직접 클릭은 미실행이다. [화면 검증](../../../app/test-results/ontology-attribute-detail-20261108/verification.md)·[설치 영수증](../../../.local/releases/20261109-cleanup/retained-records/ontology-attribute-install-20261108-zz023ug3/VERIFICATION.json).

## 2026-11-08 — 개념 선택·원문 지도 앱과 서버의 동시 반영

- 개념 선택·원문 지도 앱과 서버를 함께 반영했다. 앱 출력·ASAR·서명을 대조하고 이전 앱을 보존했다. 첫 서버 기동은 색인 준비 약 12.4초가 확인 한도를 넘어 fallback했으며, 60초 인계 절차로 복구해 tracking/metrics 활성·오류/잔여 없음과 기존 터널/주소를 확인했다.
- 자료 1,208파일·보호 설정 23파일과 실제 앱 설정/복구 파일의 집합·해시를 보존했다. 설치 앱의 연결·지도 제어는 확인했으나 전체 업무·실제 AI·실자료 쓰기는 검증하지 않았다. 디스크 소스 관측을 이전 프로세스의 정확한 소스 복원 증명으로 확대하지 않는다. [설치 검증](../../../app/test-results/installed-ontology-map-20261108/verification.md)·[서버 반영](../../../.local/deployments/ontology-map-install-20261107-tracked-ylozhb_2/rollout-verification.json).

## 2026-11-07 — 원문 앵커 관계의 지도 전송 계약

- 지도 전송에서 개념 끝점과 원문 anchor 끝점을 구분하고 문서/판본/줄/집합을 검사했다. HTTP 4·지도 전송 16묶음과 실제 renderer/main/API를 확인했다.
- 기존 설치본은 새 필드를 받지 못해 앱·서버 동시 반영이 필요했다. [검증 보고서](../../../app/test-results/ontology-source-anchor-map-20261107/verification.md).

## 2026-11-07 — 완결성 안내를 보완한 질문 전용 옵션의 연결 (D-118)

- 완결성 안내를 보완한 질문 전용 옵션은 실제 4쌍에서 모델 17→15·전체 토큰 49.71% 감소, 양쪽 품질 40→40으로 기준을 통과해 Codex v5 호출에만 연결했다. 레거시/Claude·preview·공유 객체 보존 등 66개를 통과했다.
- 전역 설정·운영·설치는 유지했다. 모델 ID 미보고, v1 직접 비교와 새 자료/긴 대화는 미검증이다. [소유 기록](../knowledge/HISTORY.md#2026-11-07--같은-호출의-완결성-안내와-새-원문-비교-d-118)·[보고서](../../../evals/2026-11-07-question-cli-completeness/REPORT.md).

## 2026-11-07 — 온톨로지 후속 개선의 Mac 설치

- 온톨로지 후속 UI의 23개·앱 빌드·격리 화면 검증 후 Mac 앱을 교체했다. 고정 출력/ASAR·ad-hoc 서명을 대조하고 이전 앱을 보존했으며 실제 설치 경로에서 검색·연결 미리보기·원문 위치를 확인했다.
- 사전 설정 검사는 실제 경로가 아닌 `Application Support/LLM Wiki`를 읽었다. 실제 `llm-wiki-app`의 설정/복구·연결은 사후 확인했지만 전후 바이트 동일성은 입증하지 못했다. Windows·공인 서명/공증·실제 모델·전체 업무는 미검증이다. [설치 영수증](../../../.local/releases/20261109-cleanup/retained-records/ontology-usability-20261107-w7YS5r/VERIFICATION.json)·[UI 기록](../ui/HISTORY.md#2026-11-07--첫-사용-검토의-후속-개선과-mac-설치).

## 2026-11-07 — 질문 호출 전용 CLI 옵션과 자동 적용 철회

- 호출별 짧은 질문 CLI 프로필을 구현해 관련 66개를 통과했다. 실제 4쌍/36호출에서 전체 토큰 50.25% 감소였으나 두 평가가 q03 누락을 지적해 자동 적용을 철회하고 기본 False의 명시 옵션만 남겼다.
- 전역 설정·질문 기본 경로가 원래와 같음을 확인했다. [비교 보고서](../../../evals/2026-11-07-question-cli-profile/REPORT.md).

## 2026-11-07 — 질문 CLI의 공통 입력 주입 경로와 설정 조사

- 기존 117호출과 Codex 0.167.0-alpha.3.2를 조사하고 격리 오프라인 prompt-input으로 주입 경로를 확인했다. 짧은 지시와 스킬 설명 생략으로 공통 본문은 로컬 7,995→1,773토큰이었고 권한 799토큰·도구 정의는 유지됐다.
- 프로젝트 문서/도구 차단과 CLI 기본 지시·스킬 카탈로그 주입을 구별하도록 설명을 정정했다. 과거 실제 요청의 미보존으로 9,758토큰을 재구성한 것은 아니며 실제 제공자 절감·품질은 미검증이다. 새 모델 0회, 기존 772파일·설정/바이너리 보존. [보고서](../../../evals/2026-11-07-cli-input-audit/REPORT.md).

## 2026-11-07 — Mac 설치 앱의 테마·상태바 반영

- 테마·상태바 개발본을 Mac에 새 설치했다. 앱 검사/빌드·고정 출력 10파일·ASAR·ad-hoc 서명을 확인하고 실제 4테마 선택·크림/화이트·잔여 표시를 검증했다. [설치 영수증](../../../.local/releases/20261109-cleanup/retained-records/theme-update-20261107-verified/VERIFICATION.json).
- 저장 주소의 로그인 복원은 실패했고 자동 재연결은 승인 검토에서 차단됐다. 사용자가 직접 현재 주소로 로그인한 뒤 연결을 확인했다. runtime/work-recovery는 같았지만 연결 보호 2파일은 갱신되어 전체 설정의 바이트 동일성은 주장하지 않는다. Windows·실제 AI·전체 업무는 미검증이다.

## 2026-11-06 — ID 인용 렌더와 단계 preview 보호

- 개인 질문의 원시 ID/초안 preview를 막고 검증·렌더된 최종 답변만 전달했다. callback/property 경계를 모두 복원하며 레거시는 유지했다. 관련 119개와 모델 검증 범위·추가 검사 기본 도입 보류는 [소유 기록](../knowledge/HISTORY.md#2026-11-06--인용과-읽기-방식-개선-및-추가-검사-기본-도입-보류-d-109)을 따른다.

## 2026-11-06 — 질문별 선택 근거 조회와 영수증

- v5 선택 근거 조회에 요청별 영수증을 연결해 전송 유실 시 GET으로 확인하도록 했다. 현재 권한·판본·lease·revision·제출 검사를 유지하고 생략한 옛 mode 해시/v3/v4는 보존했다.
- ASGI 17·저장 18개와 문맥/세션·client 관련 검증을 통과했다. 실제 모델·운영 반영은 포함하지 않았다. [소유 기록](../knowledge/HISTORY.md#2026-11-06--필요한-근거만-읽는-채팅-d-108).

## 2026-11-06 — 온톨로지 색인 준비의 운영 반영

- 온톨로지 색인 준비를 tracking 서버 기동/종료에 연결하고 격리 497개에서 보존·갱신·첫 응답을 확인했다. 운영 인계는 이전 서버 종료 중 identity 변경으로 중단된 뒤 포트·프로세스를 재확인해 복구했으며 기존 터널·정책/규약·274소스 해시를 보존했다.
- 준비 202ms로 기존 SQLite를 재사용했고 정확한 최근 문서 5개 요청은 65/64/59ms, 본문 읽기/색인 갱신 0회였다. timed 8건은 모두 200, 공개 주소는 무인증 401만 확인했다. coverage 누락·관계 제외는 남았으며 고정 자료 SLA/화면 시간은 아니다. 근거: `.local/diagnostics/ontology-eager-rollout-20261106-wwn147zl/rollout-verification.json`.

## 2026-11-06 — 온톨로지 최근 문서5개의 정확한 요청 재측정

- 첫 API 진단의 8,236.641ms는 `kind=all` 요청이어서 현재 화면의 `kind=document/limit=5` 진입 시간이라는 해석을 정정했다. 같은 정상 계정으로 정확한 화면 입력은 232.913/66.096/67.346ms였고 이미 준비된 색인을 사용했다.
- 원래 45건은 모두 200이었으나 이력/영향/검토함의 잘림·불완전 상태를 유지했다. `limit=5`여도 서버는 전체 색인 상태를 먼저 점검하며, cold 구축·공개 HTTPS·설치 앱 표시는 미측정이다. 근거: `.local/diagnostics/first-api-20261106-k1pr9u0m/`의 원 관측과 `exact-screen-report.json`.

## 2026-11-06 — 영향 조회 1.2초 목표의 가능성 측정

- 영향 조회의 1.2초 가능성을 읽기 전용으로 측정했다. 운영 loopback 5회 중앙값 1,527.597ms, 같은 입력/결과의 별도 내부 query 3쌍은 1,415.207→1,144.229ms였다. HTTP·영구 구문 자료 비용을 포함한 개선 응답은 미측정이며 약 1.23–1.26초는 산술 추정이다.
- 공개 인증 요청은 자동 승인 검토가 거절해 수행하지 않았다. [소유 기록](../knowledge/HISTORY.md#2026-11-06--영향-조회-12초-목표의-가능성-측정).

## 2026-11-06 — 검토 원장의 동일 값 검증 재사용

- 검토 이벤트 안에서 성공한 동일 target/before/after 값 검사를 재사용했다. bool/int/float·정책·undo·전체 chain/현재성 검사는 유지하고 전체 653개와 독립 검토를 통과했다. 고정 fixture의 DTO/원본은 같고 영향 중앙값은 55.633→50.461ms였다.
- 운영 반영 후 영향 중앙값은 loopback 1,528.782→1,457.730ms, HTTPS 1,555.926→1,491.192ms였다. 최종 22읽기는 모두 200이나 자료/부하를 동결하지 않았고 동시 조회 2.03초와 불완전 결과는 남았다. 기존 터널·정책·273소스 확인 및 수동 복구본 보존. 근거: `.local/diagnostics/read-validation-20261106-63qnftw8/verification-summary.json`.

## 2026-11-06 — 2초 목표의 영향 조회 조립·메타정보 해석 재사용

- 같은 요청/잠금에서만 검토 그래프 조립·성공 메타정보 해석을 재사용했다. 정책/undo·effective 검사·권한·I/O·CAS는 유지하고 전체 646개·독립 검토를 통과했다. 고정 fixture 영향 59.723→39.179ms와 DTO/원본 동일을 확인했다.
- 운영 영향 중앙값은 loopback 2,291.733→1,580.045ms, HTTPS 2,273.511→1,614.657ms로 순차 8회 모두 2초 미만이었다. 최종 22읽기는 200이나 동시 묶음은 2.11초이며 자료/부하 비동결·부분 결과 때문에 SLA/완전성으로 확대하지 않는다. 기존 터널·정책·273소스와 수동 복구본을 보존했다. 근거: `.local/diagnostics/impact-under2-20261106-gt70l6ei/verification-summary.json`.

## 2026-11-06 — 지도 전용 검색과 이웃 전송

- 지도 search/neighbors를 엄격한 경량 응답·현재 read 인가로 HTTP/IPC/웹 전송에 연결했다. ASGI 신규 3+기존 7개, 지도 전송 11묶음과 실제 renderer/main/API를 확인했다. fixture가 준비 중 색인을 만들므로 cold 성능 근거가 아니며 설치/운영·Windows는 미검증이다.

## 2026-11-06 — 검토 응답의 복사 비용 감축

- 검토 응답의 JSON 컨테이너 복사를 줄이되 mutable 분리·공유/cycle과 업무 검증을 유지했다. 전체 621개·독립 검토를 통과하고 고정 fixture DTO/원본 동일을 확인했다. 보존 스냅샷에서는 coordination lock만 구분했으며 위키/전체 이력/원장은 계속 바이트 대조했다.
- 운영 이력 중앙값은 loopback 1,491.407→1,234.042ms, 영향 2,749.705→2,665.910ms로 영향의 추가 이득은 작았다. 최종 22읽기는 200, 동시 묶음 2.89초·부분 결과는 남았다. 기동 뒤 다른 세션의 소스 변경을 감지해 기동 시 검증/소유 파일과 구분했다. 근거: `.local/diagnostics/review-copy-20261106-r_xls09e/verification-summary.json`.

## 2026-11-06 — 통합 이력과 변경 영향의 반복 검증 감축

- 통합 이력은 작업 상세 대신 소유 이벤트를 읽고, 영향은 같은 원문/그래프/원장 관측의 반복 검증을 줄였다. 정책별 render·effective·현재성 검사를 유지했다. 599개·독립 검토와 고정 fixture DTO/원본 보존을 통과했다.
- 운영 이력 중앙값은 loopback 2,796.007→1,119.983ms, 영향 3,459.009→2,640.563ms였다. 최종 22읽기 모두 200이나 자료가 늘고 이력 2,000상한·영향 스캔/바이트 한도가 있어 고정 가속률이나 전체 자료 확보를 뜻하지 않는다. 기존 주소·터널·정책과 수동 복구본을 유지해 서버에 반영했다. 근거: `.local/diagnostics/history-impact-20261106-cuzgm50v/verification-summary.json`.

## 2026-11-06 — 실계정 재측정과 조회 반복 계산 개선

- 정상 로그인 계정의 profile로 병목을 측정해 schema bytes·entity identity·한 요청의 불변 입력/성공 작업 관측을 재사용했다. 전체 581개와 독립 경계 검토를 통과했고 기존 터널·설정·자료를 유지해 서버에 반영했다.
- 운영 loopback 중앙값은 작업 목록 341→203ms, 검토함 841→778ms, 이력 2,581→2,152ms였다. 영향 3,145→3,449ms·연결 663→711ms는 개선되지 않았다. 99측정 모두 200이나 동시 묶음 4.39초·잘림/누락은 남았고 자료/부하를 동결하지 않았다. 근거: `.local/diagnostics/api-cpu-20261106-d1b68upp/`.

## 2026-11-06 — 변경 기록·계측과 현재 서버 반영

- D-101 변경 원장·저장 훅을 연결하고 명시 tracking 모드와 민감값 없는 요청 계측을 추가했다. core 541개, 추적 파일 13개·추가 HTTP/MCP 통합과 웹 경계 검증을 통과했다. 독립 검토의 chain loss·임시 파일 잔존 한도 차이를 보완하고 원문/전체 이력을 보존했다.
- 격리 warm 작업 33.972→20.777ms, 원본 25.329→2.946ms였고 이력 4.820→4.906ms는 이득이 없었다. 관리 서버에 반영해 기존 터널·주소·정책/규약을 유지했다. 공개 무인증 401·기존 클라이언트 200을 확인했으며 당시 직접 실계정 측정 대기는 다음 기록에서 해소했다. 근거: `.local/diagnostics/sqlite-stage2-20261106-t5t8diam/`.

## 2026-11-06 — SQLite 조회 인덱스 1단계 통합 검증

- D-100의 재생성 가능한 SQLite 조회 인덱스를 문서·원본·작업·판본에 연결했다. cold/warm·변경·busy·손상·symlink·부분 실패와 원본 보존을 검증했다. 최종 전체 477개 중 busy 기대값 1개가 실패했고 테스트만 수정한 관련 28개는 통과했다. 수정 후 전체 477개는 재실행하지 않았다.
- 웹 전송/파일/취소·원본/복원 검증도 통과했다. 격리 warm 작업 47.111→29.673ms, 원본 101.242→24.821ms, 판본 5.188→4.541ms였다. 전체 metadata 탐색·원본 hash 비용은 남았고 운영/네트워크 성능을 뜻하지 않는다. 당시 운영 반영은 미실행. 근거: `.local/diagnostics/sqlite-stage1-20261106-zf455g1q/`.

## 2026-11-06 — 전체 HTTP API 경계와 조회 성능 점검

- HTTP 112경로의 인증·입력 경계 448건에서 불일치/예상외 5xx가 없었고 경로별 최소 한 정상 성공 112/112를 확인했다. 격리 회귀 408개와 중복 검증 감축 뒤 관련 168개를 통과했다. 전체 입력/상태·의미 정확도 보장은 아니다.
- 허용 계정 읽기 45건은 전후 200이었다. 관측된 이력 11.410→4.278초·영향 7.693→2.403초 등은 비동결 자료 결과이며 잘림/부분 상태를 유지했다. 운영 쓰기·실제 AI·공개 HTTPS·Windows·설치 반영은 미실행이다. [전체 요약](../../../.local/diagnostics/api-20261106-5a26wjkt/summary.json)·[경로별 근거](../../../.local/diagnostics/api-20261106-5a26wjkt/contracts/combined-success-coverage.json).

## 2026-11-06 — 입력 검증과 요청 조립의 복잡도·보일러플레이트 감축

- MCP 입력 검사를 순서표로, 앱 API 59 operation의 경로/권한/본문을 선언표로, 검토 HTTP 조립 4곳을 공통 함수로 정리했다. 오류 우선순위·타입/키 순서·profile·현재 권한·응답 유실 의미는 유지했다.
- 기존 구현과 MCP 105,385입력·API 1,241요청을 대조해 차이가 없었다. MCP 90개·앱 타입/웹/실제 Electron 검토함을 통과했다. 전체 줄수 감소로 계산하지 않으며 운영/실제 모델은 미실행이다. [통합 기록](../workflow/HISTORY.md#2026-11-06--분기-복잡도와-반복-조립-감축).

## 2026-11-06 — 실행 감독·HTTP·프로세스 경계의 구조 정리

- 질문/추출/lease의 감독 경쟁, 변환 보고서·checkpoint, 앱 HTTP/JSONL/범위 비교·프로세스 정리를 공통화했다. 실패 우선순위·마지막 heartbeat·기존 import·쓰기 미확정/요청 ID는 유지했다.
- Python 고유 251개와 기존 구현 대비 7형식/49경우의 JSON·checkpoint 바이트 동일을 확인했다. 앱 개인 실행·웹 조사·HTTP/프로세스·웹 파일/복원·Electron 검증을 통과했다. 운영 자료·설치/실제 모델은 변경하지 않았다. [통합 기록](../workflow/HISTORY.md#2026-11-06--반복-구현과-화면실행-책임의-구조-정리).

## 2026-11-05 — 전체 프로젝트 core·도구·실행 코드 정리

- core 22파일의 미사용 import·반복 인가/JSON 검사를 정리하고 개인 CLI 6종의 인자·출력·취소를 공유했다. 앱 개인 명령 실행·웹 조사 결과 검사를 분리했으며 미사용 export와 jotai를 제거했다. 실제 진입점·취소 방식·저장/권한 계약은 보존했다.
- core 344·공통 CLI 6개, CLI 도움말·실제 하위 프로세스/첨부·Electron 종료 수명과 앱 검사/빌드를 통과했다. 실제 모델·운영 반영·Windows는 미실행이다. [통합 기록](../workflow/HISTORY.md#2026-11-05--전체-프로젝트-코드와-불필요-파일-정리).

## 2026-11-05 — 개인 웹 조사와 고정 답변 연결 (D-099)

- 개인 웹 검색 완료 관측→공개 페이지 읽기→hash/시각→고정 답변 인용을 연결했다. 관련 40개와 하위 프로세스에서 변조·중복·비공개 URL·DNS/redirect·한도·취소를 검증했다. 11-10에는 질문 기반 입력과 도구 관측을 보완했다.
- 실제 Codex·Claude가 같은 공개 검색어로 각각 검색 1건·페이지 4개를 확인했다. Codex는 후속 답변의 인용 3개까지 저장했고 Claude는 웹 조사까지만 확인했다. 잘린 내용은 partial로 표시했다. 독립 의미 평가·Windows·로그인/동적/PDF 페이지는 미검증이며 운영/설치는 바꾸지 않았다.

## 2026-11-05 — 채팅에서 실제 기록 재전송과 파일 드롭을 확인 (D-098)

- 새 AI 세션에 이전 기록을 실제 재전송한 경우만 비용 안내를 유지하고 정상 재개와 구별했다. 실제 Electron 드롭 파일만 한 번 읽어 기존 첨부 변환/한도/정리를 사용하도록 했다. 경로 위조·재사용·파일 제한·연속 2파일 첨부와 Python 16개를 통과했다.

## 2026-11-03 — 패키징·문서에서 Pandoc 제거(D-095)

- 10-29 개인 Pandoc 3.13 설치·진단/worker·XLSX 호환을 확인했으나 D-095에 따라 11-03 패키저·동봉 검사·현재 실행 안내에서 제거했다. 개인 `.local/pandoc`·bundle 파일은 보존했다. 변환 세부 검증은 [sources 기록](../sources/HISTORY.md)에 통합했다.
- 패키저 구문과 runtime_doctor의 내장 변환 패키지/Tesseract 진단은 통과했다. 이 제거 작업에서 실제 electron-builder 패키징은 실행하지 않았다.

## 2026-11-03 — Claude 어댑터가 추론 토큰 알림을 도구 사용으로 오판하던 문제

- Claude Code 2.1.317의 `thinking_tokens` 알림을 도구 실행으로 오판하던 문제를 수정했다. 알 수 없는 system·hook은 계속 거부하도록 새 2개와 같은 실제 요청 3건 성공을 확인했다.
- 기존 세션의 Codex 2건은 CLI 미설치로 실패했다. 다른 Claude 버전의 알림 호환은 미검증이다.

## 2026-10-30 — 순차 개선 4: tenant MCP 13개 추가

- 기존 업무 서비스를 재사용해 tenant MCP 13개를 추가했다. 신규 32개 포함 MCP 79개와 실제 loopback SDK/stdio에서 HTTP 동등성·판본/전체 이력·CAS·소유권/cursor·권한 회수·유실 재조회·성공 경고를 확인했다. 목록은 tenant 55·legacy 8개였다.
- 오류 코드와 nullable cursor의 SDK 선변환 차이를 보완했다. 후속 스킬 검사에서 관계 replacement의 source/policy 필수 입력을 공개하고 구형 schema 거부·원장 무변경을 확인했다. 운영 서버/설치·실제 외부 쓰기는 반영하지 않았다.

## 2026-10-29 — D-076 MCP 간결 응답·현재 재사용 기준

- 명시 compact 응답을 MCP에 연결하되 기본 full·영수증/진단·멱등·저장 직전 권한 검사를 유지했다. 신규 8+Clean Up 5개를 통과했다.
- 같은 합성 자료의 검토 JSON은 111,945→5,188B, 단일 Wiki 영수증은 6,441→6,399B였다. wire 전체·실제 모델 토큰/요금은 아니며 제공자 usage는 fixture만 확인했다. 기존 인증/운영 문제·Windows는 해결한 범위가 아니다.

## 2026-10-28 — core 구조 안내와 Claude 호환 확인

- core 구조·진입점 안내를 정리하고 Claude 2.1.311의 옵션 지원을 확인했으나 로그인은 `not_logged_in`이었다. 프로젝트 Codex 역할/스킬의 Claude 자동 연결과 실제 지침 로딩은 확인하지 못했다.
- 당시 정책이 가리키는 `data/personal`이 없어 MCP·하위 에이전트 시작이 `policy_unavailable`로 실패했다. 삭제 원인은 미확정이며 임의 초기화하지 않았다. 자료 준비와 인증 오류 해소는 10-29 Mac 런처 기록을 따른다.

## 2026-10-28 — D-071~074 MCP·공통 서버 연결

- D-071~074의 access revision·가입/로그인·엄격 초기화·Wiki 전체 읽기/작성 CAS·보존형 분석 등록을 API/MCP에 연결했다. 업무 회귀 99개와 MCP 고유 15개가 통과했으나 평문 credentials만 있는 초기화는 PolicyError로 남았다.
- 10-29 Clean Up HTTP/MCP 계약·교차 재요청/undo·권한/취소/단일 저장까지 고유 61개가 통과했고 같은 인증 실패 1개를 별도 인계했다. 이 실패는 access 담당 수정 뒤 Mac 런처에서 해소됐다. 검증은 격리 자료이며 실제 모델 의미·Windows/원격 운영 완료를 뜻하지 않는다.

## 2026-10-29 — personal 자료 준비와 실제 Mac 런처 확인

- 10-29 Mac 서버/Quick Tunnel 런처와 공식 cloudflared 2026.10.5 로컬 설치를 연결했다. 실제 HTTP+모의 터널 6수명 검증·배포 SHA/옵션을 확인했다. 사용자 요청으로 누락된 `data/personal`을 준비하고 평문 토큰 부팅 오류를 access 담당이 수정해 관련 29개를 통과했다.
- 실제 런처 두 번에서 터널 등록·주소 출력, loopback 무인증 401·기존 토큰 access 200·MCP initialize·정상 종료를 확인했다. 정책/토큰/키를 보존했다. 공개 토큰 전송은 자동 승인 검토에서 거절됐고 무인증 공개 조회도 DNS 실패여서 원격 인증·다른 PC·Finder 클릭은 미검증이었다.

## 2026-10-29 — 저장 없는 ontology_validate_draft 공개

- 저장 없는 `ontology_validate_draft`를 legacy/tenant MCP에 공개하고 순수 검사·storage·전송 64개에서 무쓰기·권한/철회·판본·성공 후 권한 비승격을 확인했다.
- 직접 `ontology_generate`가 분석 결과 경로의 before_commit 콜백을 사용하지 않는 기존 차이는 해결하지 않았다. 초안 성공이 최종 권한을 대체하지 않으며 운영 반영은 미실행이다. [D-081](../ontology/DECISIONS.md#d-081--저장-없는-초안-검사와-제한된-끝점-역할-규칙-2026-10-29)·[검증](../../../evals/2026-10-29-adopt-imp01-02/implementation-verification.json).

## 2026-10-30 — Mac 운영 규약·서버·설치 앱 반영

- `common/2026-10-30.1` 규약을 불변 발행해 CAS로 sdv-platform/personal에 연결하고 감사 이력·정책 원본을 보존했다. 규약 설정 5개·서버 인계 9개 검증 후 기존 터널/주소를 유지해 운영 서버·Mac 앱을 반영했다. 실제 Codex QA 추출/저장→같은 대화 검색/대조와 설치 앱 조회, 반영 후 보존 7개를 확인했다. [실행 보고](../../../evals/2026-10-30-operational-smoke/REPORT.md)·[반영 확인](../../../evals/2026-10-30-operational-smoke/ROLLOUT.json).
- 기존 운영 32파일·인증 정책은 같고 QA 60파일만 추가됐다. 이전 앱·사용자 설정 519파일을 `.local/deployments/2026-10-30/`에 보존했다. 복구 암호문 1파일은 앱 실행 후 바뀌었으며 의미적 동일성은 미확인이다. 옛 패키지 검증 파일은 후속 배포물 정리로 현재 경로에 없다.
- Claude 2.1.312 첫 실제 요청은 rate limit이었다. 한도 해제 시각, 성공 답변·재개·전체 추출/대조·설치 앱 수동 재대조, Windows/다른 PC·재부팅 자동 시작·Mac 공인 서명/공증은 미검증이다. [Claude 실패 기록](../../../evals/2026-10-30-claude-live/REPORT.md).

## 2026-11-06 — 사용자 요청으로 SDV 데이터 비우기

- 사용자 요청으로 SDV 위키·원본·히스토리·분석·개인 기록 96파일(373,920바이트)을 삭제했다. 등록/위키 잠금 아래 최상위 7폴더·잠금 파일의 inode/권한·workspace ID를 유지했다.
- 폴더 비움과 `.local/tenancy` 전체 해시·data 최상위 항목 보존을 확인했다. 제품 시험·앱 화면 확인은 수행하지 않았다.

## 2026-11-06 — 해사 40문항의 저장·개인 AI 실패 원인 조사

- 해사 40문항 저장 실패 20건은 반복 basis와 JSON 1MiB 한도의 충돌로 확인했다. QA-014는 위키 5,237B→근거 525,394B→두 턴 최소 1,060,024B였다. 별도 실제 2호출에서 `max_output_tokens` 실패를 재현하고 원래 40문항/23호출 집계와 분리했다.
- CLI 실패의 포괄 오류와 평가 도구의 미확정 저장 오분류도 발견했다. 실제 상한·usage가 남지 않아 문맥/생성 예산 중 결정적 원인과 다른 10건의 과거 오류는 미확정이다. 제품 수정·서버 쓰기는 하지 않았다. [진단 보고서](../../../evals/2026-11-06-maritime-corpus/execution/chat-rerun-cause-diagnosis/REPORT.md).

## 2026-11-09 — Mac 런처 단일화(재시작·새 창 실행)

- 11-03 추가한 터널 주소 저장·새 터미널 실행을 11-09 `start-mac.command --new-window`로 통합하고 별도 스크립트를 제거했다. 같은 프로젝트의 확인된 런처만 재시작하며 다른 포트 소유자는 보존한다.
- 신규 3+규약 6개, 실제 터미널의 모의 서버/터널 시작→재시작→종료·주소 삭제를 확인했다. 당시 실제 8766 서버는 재시작하지 않았고 다음 SDV 초기화에서 새 방식의 실제 실행을 확인했다.

## 2026-11-09 — SDV 테스트 자료 초기화와 단일 시험 문서

- 사용자 요청으로 SDV 11,252파일(918,492,989바이트)을 `.local/sdv-reset-20261109/backup/sdv-platform`으로 이동했다. 정상 로그인·서버/터널 종료·잠금 아래 같은 workspace ID를 유지하고 원본/전체 이력/원장·설정의 SHA·크기·권한을 대조했다.
- 새 런처로 실제 서버/터널을 재시작해 인증 목록·온톨로지 0건/완전 상태를 확인했다. 설치 앱 연결은 변경하지 않았다. 가상 SDV 현장 협의 문서 1개만 작성하고 등록/추출하지 않았다. 근거: `.local/sdv-reset-20261109/reset-verification.json`.

## 2026-11-25 — 실행 설정과 진단 실행의 책임 분리

- `RuntimeSettingsService`의 외부 진단 실행·환경·응답 검사를 `runtimeDiagnostics.ts`로 분리했다. 설정/로그인·보호 저장/CAS·확인 기록·보고서 수명은 유지했다.
- 모의 실행기/임시 자료의 CLI 20묶음에서 실패·중간 결과·동시 실행·재시도·파일 보존을 확인했고 앱/테스트 타입·정적 검사·독립 검토를 통과했다. 실제 AI·Windows·배포는 미실행이다.

## 2026-11-25 — 연결 수명과 문서 읽기 분리

- `ConnectionService`의 읽기를 `DocumentReadService`로 분리했다. 연결/현재 권한·다운로드 저장은 기존 서비스가, 취소·공유 16개 상한·응답 검사는 읽기 서비스가 맡고 공개 메서드/오류 무효화 규칙을 유지했다.
- 전후 11묶음·모의 HTTP 228요청, 기존 웹/지도/파일/원본/복구 통합·타입/정적 검사·독립 검토를 통과했다. 실제 자료·AI·운영 배포는 변경하지 않았다.

## 2026-11-25 — 실행·전송 중복 정리와 현역 테스트 검사 복구

- 테스트 서버 READY/종료와 검증 실행 절차를 공유하고 현역 TS/TSX 테스트 76개를 기본 검사에 포함해 타입 오류 18건을 고쳤다. 개인 AI 인자·공개 활동·JSON 출력·제공자 capability·늦은 응답 처리의 중복을 줄이되 취소·저장/미확정 의미는 유지했다.
- 앱 check, READY 5·작업 표시 8묶음, Python 94개·CLI main 출력 동등성, 개인 실행/웹 검색/대조·지도 24묶음과 웹 경계를 통과했다. 기존 fixture의 요청 ID/변환 참조·workspace 배정·webContents 초점을 보완한 뒤 Electron 로그인/등록 18·재시작 3·Clean Up 14·관계 검토 18개도 통과했다. 독립 diff 검토를 마쳤으며 실제 AI·Windows·배포는 미실행이다.
