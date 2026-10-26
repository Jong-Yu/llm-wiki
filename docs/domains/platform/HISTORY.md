# API·MCP·실행 환경 작업 기록

## 2026-10-26 — 초보자용 외부 접속 서버 가이드 보강

- 사용자 요청은 기존 화면/PDF 안내를 하나씩 따라할 수 있는 수준으로 보강하고 집 밖에서도 접속하도록 설명하는 범위다. `WSL2_SERVER_GUIDE.md`와 이미지 포함 HTML·단일 PDF, 문서 전용 생성기·화면 자료를 준비하고 README/현재 PLAN의 진입을 연결했다. 본문은00~35의36단계이며 최종 PDF47페이지·공식 참고9장과 설명용 예시7장을 포함한다.
- 현재 통합 `core.runtime.http_cli`·Python3.12+·lock 설치·실제 API/MCP 진단에 맞췄다. 어느 PC/창, 클릭·입력·완료 기준·오류의 복귀 단계를 명시하고, 새 빈 서버의 최소 read 인증 생성과 기존 자료 전체 보존 이전을 분리했다. Cloudflare 고정 Tunnel 주 경로와 Caddy/systemd 대안의 중복 적용을 피하고 Windows 작업 스케줄러의 전경 실행·시간 제한·계정·수동/재부팅/외부 핫스폿 검사를 설명한다.
- 코드/연결 검토와 공식 자료/초보 동선 검토를 별도로 수행했다. 기존 DNSSEC/DS 확인·토큰 직접 보호 입력·Edge 인증서 메뉴·실패 재시도 예시·경고 수준 서버 로그의 조용한 정상 상태·단계 참조를 보완했다. 기존 영문 구버전 화면과 설명용 화면을 Windows 실기기 촬영/성공 기록으로 표시하지 않는다.
- 격리 검증:11단계 heredoc 원문을 새 임시 CWD에서 실행해 read 정책·토큰0600·정책 검증을 확인했다. 두 번째 실행은 비0 거부이며 직전/직후 전체 파일 hash 동일, 토큰 원문 출력0이다. 네트워크 없는 실제 ASGI의 개인 인증/빈 문서 목록200, 서버 CLI의 앱/인수 조립을 확인했고 실제 포트는 열지 않았다.23/24 스크립트 구문·수동/자동 실행 인수·스케줄러 인수도 대조했다. 임시 저장소 조회가 만든 잠금 파일은 원래 정책/토큰 변경과 구분했다.
- 문서 검증: 상대 참조23곳·Bash 구문29블록·내부 Python 구문1블록·PNG hash16개 오류0. PDF 본문/명령559블록·제목48개 누락0, 내부 목차39개·외부 링크23개·페이지 밖 문자0을 검사하고47페이지 렌더링과 주요 명령/화면을 육안 확인했다. 임시 Chrome의1440/390폭에서 이미지16개·목차/확대·복사 핸들러·가로 넘침 없음·JS 오류0을 확인했다. 복사는 페이지의 임시 대체 함수로 검사하여 개인 클립보드를 읽거나 덮지 않았다.
- 범위 보존: 확인한 실행/설치/인증 코드·의존성·앱 안내8파일은 hash 동일이다. 운영 자료·실제 정책/토큰·서버/터널·MCP 등록·DNS/도메인 결제/방화벽·권한은 변경하지 않았다. Windows/WSL2 설치·개인 ACL 실기기·Cloudflare 운영 연결·재부팅/로그인 전/다른 PC와 실제 자료 이전은 이 문서 작업에서 미실행이다. 문서 작성 완료를 그 현장 조건의 통과로 바꾸지 않는다.

## 2026-10-25 — 시안 기준 부족한 API 구현

- 범위: 화면 연결 작업을 중단하라는 요청에 따라 서버만 확장했습니다. 변환 보고/분석 계획7개, 전체 추출안/미발견8개, 결과 초안/반영6개, 질문 실행10개를 추가해 HTTP 동작93개/경로84개입니다. 기존 검토함/이력에는 `coverage=tenant`를 추가했습니다. API 사용 순서는 README, 보존/실행 경계는 [D-051](DECISIONS.md#d-051--시안의-분석비교결과질문집계를-지원하는-api-2026-10-25)이 관리합니다. 이 작업에서 `app/`·UI 문서는 편집하지 않았으며 다른 채팅의 화면 변경은 보존합니다.
- 재사용/설명: 기존 공통 JSON/현재 인가·안전한 파일·불변 입력 공개·개인 기록·전체 이력·CAS와 WikiStore/ReviewStore/OntologyStore/JobStore를 재사용했습니다. 새 업무 모듈은 계획·추출안·개인 실행/초안으로 나누고, 역할/입력/판본/잠금/실패 보존 이유를 Python 초보자용 한국어 주석으로 설명했습니다. MCP 공개 인자/docstring과 그래프 의미·배포 지문4파일은 변경하지 않았습니다. 기존 생성기의 기본 no-op는 유지하고 계획 재분석/추출안 적용에만 새 세대를 요구합니다.
- 분석/원본 검증: 새 계획 API의 핵심4개가0.922초에 통과했습니다. 원본/변환 위치·다중 출력·필수 맥락·입력 판본 충돌·부분 실패 보존을 확인했습니다. 바이너리 직접 단일 job 거부 보완 후 영향받은1개와 기존 md/txt multipart/판본 호환1개만0.550초에 확인했습니다. 같은 Wiki 일부 줄로 전체 그래프 교체를 거부하고, 전체 재분석→고정 입력→저장→동일 내용도 새 세대/옛 승인 보류까지 연결한 신규 통합1개가0.866초에 통과했습니다. 기존 결과 저장의 잘못된 인용 거부/위키·원장 보존/정상 완료 호환1개도0.134초에 통과했습니다.
- 추출안 검증: 신규 고유6개가 최종1.865초에 통과했습니다. 저장 전 canonical 불변, 원문/관점/소유권/CAS, 실제 과거 본문과 stale 그래프 보존, 미발견 제외/근거 있는 복구, 새 인용→새 claim ID 명시 대응→실제 검토 후 완료, 저장 뒤 연결 실패/쓰기 회수 뒤 영수증, 미연결 후보의 개수·바이트 한도/같은 요청 재연결을 확인했습니다. 기존 동일 그래프 no-op 호환1개도 통과했습니다. 독립 읽기 검토에서 발견한 미연결 후보 용량 누락과 claim ID 변경 누락을 보완했습니다. 이미 통과한 전체 제품 회귀는 실행하지 않았습니다.
- 결과/질문 검증: 신규 고유6개(초안3/질문3)가1.788초, 기존 개인 대화 append 호환1개가0.372초에 통과했습니다. 초안 편집/CAS·전체 근거·Wiki 전체 이력/같은 요청 영수증, 근거 변경의 최신 관측 동의·권한 회수·성공/미확인 실패 보존, 실행 claim/입력/lease/progress/취소/소유권/만료 재접수·원문 변경 거부·실제 인용·최종 저장 시점의 lease 만료·응답 유실 영수증을 확인했습니다. 정책/claim 인용·답변 계보/전체 부록·생성 당시 입력 계약 고정·목록을 보완한 뒤 관련 정상2개만0.733초에 재확인했습니다. 배포 상수 변경을 주입해 기존 질문의 입력 지문이 바뀌지 않는 것도 확인했습니다.
- 공간 전체 집계 검증: 신규3개가0.503초에 통과했습니다. 명시8개를 넘는 문서 발견/페이지·관점/자료 추가 시 cursor 충돌, 권한 거부가 탐색보다 앞서는지, 종류/캡처 한도에서 빈 결과도 불완전 표시되는지, 같은 tenant 다른 사용자의 개인 작업을 읽지 않고 본인 job만 이력에 포함하는지 확인했습니다.
- 통합 점검/수정: 인증된 앱의 OpenAPI 생성과 모든 로컬 모델 참조를 실제 확인했고 신규31개를 포함한93개 동작/84개 경로가 생성됐습니다. 최초 계획 통합 fixture의 응답 ID 위치·그래프 단계에 불필요한 extraction_id·구형 fixture 스키마를 실제 계약에 맞춰 수정한 뒤 해당1개만 통과시켰습니다. 질문 인용 fixture가 evidence 객체를 quote 문자열에 넣은 오류는 실제 evidence.quote 대조로 수정했습니다. 실패를 통과로 기록하지 않았고 운영 자료/정책/토큰·실제 모델은 시험하지 않았습니다.
- 마지막 통합 보완: PDF/XLSX 변환 보고를 `source_refs[].conversion_ref`로 질문 준비/저장 근거에 연결했습니다. 원본/소유자/변환 판본·구성 hash 대조, 문자·위치·방법/보고 범위 보존, 누락/다른 원본/미독/판본 불일치의 준비 실패, 기존 txt 요청 구조/hash 보존을 신규1개로0.549초에 확인했습니다. 변환 문자 인용도 원시 파일의 직접 판독과 구별하도록 `reported_conversion` 및 변환 판본/방법/보고 범위를 답변에 보존했고, 해당1개를 실제 질문 실행→답변 저장까지 확장해0.610초에 통과시켰습니다. 신규 고유 검사는 총21개(계획/변환/질문 근거5, 추출안6, 초안/질문6, 공간 집계3, 계획 실행 통합1)이며 기존 호환 검사는 관련4개만 수행했습니다. 최종 추가된 변환 참조 모델까지 OpenAPI의1,378개 로컬 참조가 모두 해석됐습니다. 변경 문서10개의 코드 블록 구조와 새 계약 링크13개도 확인했고 이후 기능 회귀를 반복하지 않았습니다.
- 완료의 경계: 서버는 PDF/XLSX 원본과 개인 PC의 문자 변환 보고를 보관하지만 OCR/Office 변환을 실행하거나 원본 전체 포함/의미 정확성을 인증하지 않습니다. 계획 인계는 문서별 기존 job을 만들며 개인 AI를 자동 실행하지 않습니다. 질문 API는 개인 실행기와의 계약이며 실제 질문 CLI/화면 연결은 별도입니다. 공간 전체 집계도 유한한 관측 범위이고 개인 기록 공유/삭제/자동 만료는 없습니다. 실제 Electron 전체 흐름·운영 배포·두 PC·실문서 의미 평가는 미실행입니다.

## 2026-10-25 — 잔여 HTTP API 전체 연결

- 범위: 기존16개에46개를 추가해 HTTP 동작62개/경로56개를 제공합니다. B검색/지식7, C본문/판본/검토/정책/이벤트10, D대응9, S추출/파일/요청확인5, E명시범위집계2, F질문준비1·개인대화4·저장결과3·비교4·개인요청확인1입니다. 후보였던 E/F는 [D-050](DECISIONS.md#d-050--잔여-http-api와-개인-기록의-최소-계약-2026-10-25)에서 현재 최소 범위를 확정했습니다. Electron 화면이나 운영 권한/서버 배포는 변경하지 않았습니다.
- 공통화/보존: 기존 WikiStore/ReviewStore/CorrespondenceStore·지식/검색·전체 원장·잠금·정규 JSON·안전한 파일·불변 bundle 공개·스트림/취소 대기를 재사용했습니다. 공통 JSON operation은 인가·실제8MiB/strict/중복키 검사·최신 관점·owned thread·응답을 담당합니다. 본문/검토/대응/개인 기록은 최종 교체 직전 권한을 재확인합니다. 요청과 응답의 OpenAPI 모델 참조를 모듈별로 구분하고 전체 참조의 존재를 검증했습니다. 새/변경 함수에는 초보자용 한국어 역할·입출력·보존 이유 주석을 달았습니다. 기존 MCP 인자/docstring과 ontology의 배포 지문4파일은 변경하지 않았습니다.
- 실제 핵심 검증: 신규 고유19개(B/E/F1의5개, C4개, D/S5개, 개인기록/통합5개)가 통과했습니다. 일반 API의 기존 인증/Host/Origin/OpenAPI1개와 기존 검토 edit→undo 호환1개도 통과했습니다. 각 담당은 자신의 핵심만 실행했고 최종 전체 회귀는 추가 실행하지 않았습니다. 새 파일 바이트 한도·손상 시 보존1개는0.276초, 새/옛 개인 근거·소유권/CAS·비교 실제 검토·OpenAPI/회수4개는 마지막0.823초, 마지막 공통guard/기존 인증2개는0.488초에 통과했습니다. 새원본만 질문준비는 해당1개만0.219초에 재확인했습니다.
- 확인 내용: 검색/전체 기계 그래프/유효 정책/직접 영향·관점/다른tenant/unknown거부, 집계scope/cursor변경409, 본문 전체 이력/복원·history경로/링크·검토/정책 권한/undo/이벤트 페이지, 대응9경로 prepare/CAS/원장 보존, 추출 문자페이지/원본manifest 불변/파일 hash/취소후읽기, 개인 소유권·별도권한·요청지문/응답유실조회·append CAS·질문 당시 전체근거·client_reported/미승인·실제 새claim 검토 뒤 비교완료를 확인했습니다. 개인 기록1MiB 초과 시 기존 전체 질문/요청 바이트 보존과 손상 시500/초기화 없음도 확인했습니다. 운영 data/정책/토큰은 시험하지 않았습니다.
- 발견/수정: 초기 두 담당의 fixture 클래스 직접 import로 기존 검사가 중복 수집되어 각32개가 실행되었습니다. module alias로 고쳐 이후 신규 클래스만 실행했습니다. 기존 OpenAPI의 content GET-only 기대값은 PUT 추가에 맞춰 수정했습니다. 통합에서 custom 파일응답의 기본 HTTP상태 누락으로 OpenAPI 생성이 실패해200을 명시했고, 개인 검사1개의 외부/내부 profile 불일치는 명시 관점 입력으로 수정했습니다. 독립 읽기전용 검토3건은 artifact 응답 유실 후 취소/회수 상태의 영수증 경로, pending/미연결 blob 용량 누락, 개인 생성 최종guard 누락이었습니다. 영수증 GET과 모든 예약/보관의 quota를 보완하고, publish 후 job연결 실패202→용량413/파일보존→취소+쓰기회수 뒤 정확한 요청hash/read 확인을 신규1개(0.340초)로 검증했습니다. 개인 최종guard는 실제 교체 직전 권한 회수로 검증했습니다. 이미 통과한 묶음은 관련 변경/실패가 있을 때만 재실행했습니다.
- 제약: E01/E02는 명시 자료 범위이며 tenant 전체 집계가 아닙니다. F02/F03/F04는 개인 보관으로 시작하고 새3권한은 자동 부여하지 않습니다. 대화/답변·비교는 클라이언트 보고이고 자동 의미 판정/사람 승인/다른 범위 완료로 승격하지 않습니다. C/D 일반 쓰기는 CAS와 조회 대조를 사용하며 별도 일반 멱등 영수증은 없습니다. 산출물 업로드는 공개 추출물 ID/revision을 요구하고 취소/만료 뒤 재조회가 가능합니다. 실제 AI 의미 평가·제품 UI 전체 연결·실제 원격 두 PC·운영 이관은 미실행입니다. API 실행법과 전체 경로는 README에 둡니다.

## 2026-10-25 — 백엔드·CLI 전체의 입문자용 주석 보강

- `core/`와 `tools/`의 생산용 Python 173개 전체를 점검하고 설명이 부족했던 163개 파일에 한국어 `#` 주석을 추가했습니다. API/runtime/client/tools, 원본·분석·규약·결과 저장, 문서·권한·그래프·검토·대응·지식 조회, MCP·호환 진입점까지 포함합니다. 앞서 충분히 설명한 6개 공통/결과 파일은 유지했습니다. 테스트·외부 의존성·운영 자료는 편집하지 않았습니다.
- 짧은 파일 소개에 그치지 않고 파일별 역할/읽는 순서, 주요 함수의 입력·결과·부작용, 모델 필드, 저장·권한·버전·예외·재전송의 이유를 설명했습니다. Python의 self·상속·타입 표기·데코레이터·비동기 호출·딕셔너리/집합·콜백 등은 실제 사용하는 위치에서 풀어 썼습니다.
- `ontology/constants.py`, `values.py`, `validation.py`, `anchors.py` 4개는 원시 바이트가 배포된 규약의 검증 지문에 포함되므로 보존했습니다. 이 파일들의 역할·읽는 순서는 기존 `core/modules/ontology/__init__.py`에 안내했습니다. 운영 규약 재발행이나 호환 우회는 하지 않았습니다.
- 전체 173개 파일의 변경 전후 AST가 기존 docstring·문자열까지 포함해 동일함을 확인했습니다. Python 구문도 정상이며 위 4개 파일은 원시 SHA-256도 동일합니다. 설명만 보강했으므로 기능 검사·모델 호출·제품 모듈 import는 실행하지 않았습니다. 기능 상태와 다음 구현 범위는 기존 도메인 계획을 유지합니다.

## 2026-10-25 — 기존 API·분석 입력 코드의 주석과 공통 로직 정리

- `core/api/ingress.py`에 단일 Content-Type 확인·실제 수신량 제한을 공유하고, 원본/작업별 한도·JSON 파싱·오류 응답은 기존 어댑터에 유지했습니다. 취소 시 작업 완료/정리를 기다리는 기존 구현은 원본 전용 경로에서 `core/api/concurrency.py`로 옮겨 등록·다운로드·분석 작업이 사용합니다.
- `core/client/transport.py`에 CLI 오류·API/MCP 응답 처리를 분리해 작업 연결과 입력 수신의 순환 참조를 제거했습니다. 긴 입력 수신은 manifest 검증·문자 페이지 수신·규약 수신으로 나누고 원래 바이트/hash·JSON 처리와 오류 코드를 유지했습니다.
- 원본·작업·고정 입력의 진입점과 규약 공개에 한국어 주석을 추가했습니다. 조정 잠금 순서, 현재 권한 재확인, 작업/lease 버전 분리, 공개 후 연결 실패의 보존, 문자 offset과 UTF-8 hash 구분을 설명했습니다. 새 기능·MCP 계약·원문·이력·원장·운영 설정은 변경하지 않았습니다.
- 핵심 **고유 7개 검사 통과**: multipart 판본/원본 보존, 원본 JSON/수신 한도, 직접 취소 전후의 정리/저장 보존 2개, 작업 JSON 경계/기존 도구 계약, 실제 규약·고정 입력 CLI 연결, manifest/문자 내용/페이지 offset 변조 거부. 첫 실행은 로컬 포트 개방 제한으로 CLI 1개가 실행되지 않았고 나머지 6개는 통과했습니다. 해당 CLI만 로컬 서버 실행이 허용된 환경에서 통과했고, 마지막 manifest 처리 정리 후 영향받은 변조 거부·CLI 2개만 재확인했습니다. 전체 회귀·AI 호출은 실행하지 않았습니다.
- 분석 결과의 실제 위키/그래프 저장 연결은 [analysis PLAN](../analysis/PLAN.md)의 후속 범위로 남습니다.

## 2026-10-25 — 개인 PC 실행 환경과 Python 병렬 통합

- fastapi_4 소유 범위에서 설치/보호 토큰/진단 CLI, Windows ACL 파일·Job Object/대기 bootstrap, 공개 답변 이벤트, 실제 작업 CAS·영수증 기반 부분 재개, 명시 별도 의미 검사 연결을 구현했다. 원본 확장 담당의 공통 문서 format Literal·바이너리 직접 분석 차단 요청을 반영했고 mcp_1의 동일 기준 결과 집계·앞선 위키 영수증 승계를 소비했다. 원문·위키·전체 이력·운영 정책·토큰·발행 규약은 수정하지 않았다.
- pypdf 6.21.2, pypdfium2 5.14.0, openpyxl 3.1.5, python-docx 1.2.0, Pillow 12.3.0 및 lxml/et-xmlfile을 프로젝트 `.venv`에 설치하고 고정했다. Windows 전용 pywin32 311 marker를 추가했다. `pip check` 통과. 최초 제한 환경의 네트워크 설치는 실패했고 허용된 프로젝트 설치로 완료했다. 전역 Python/패키지를 변경하지 않았다.
- 실제 macOS Codex 0.164.0-alpha.11.1의 version/help/login-status 진단 통과. 로그인 정보 존재만 관측하며 새 모델 호출/실제 사용권 인증/운영 MCP 호출은 하지 않았다. 실제 임시 HTTP/MCP 서버에서 별도 연결 진단·부분 저장 재개·오래된 job CAS 거부·이미 저장한 위키/이력 1회 보존을 확인했다. 별도 의미 검사에 합성 오류를 발생시켜 오류 보고 초안과 정상 그래프 저장 영수증이 다른 request로 남는 것도 통과했다.
- 전체 `.venv/bin/python -B -m unittest discover -s core/tests -t . -q`를 한 번 실행: **913개, 157.454초, 처음 909개 통과·4개 실패**. 원인은 바이너리 artifact 다운로드의 `bin` MIME 매핑 회귀 1개와 이전 24도구를 기대한 오래된 MCP/stdio 검사 3개였다. 도구 목록 기대값과 기존 read13/쓰기 거부의 분리를 수정한 뒤 실제 HTTP 1개·stdio 4개가 통과했다. artifact 회귀는 fastapi_1 소유 파일이므로 `fastapi_4-artifact-download.patch`를 인계했으며 반영 대기다. 전체 제품 회귀를 반복하지 않고 실패/변경 범위만 재검사한다.
- 신규 공통 실행기 경계 10개 통과: 공개 답변의 실행 중 전달·추론 미전달, 취소 회수, 기존 파일/잠금 보존, 공개 ACL 거부 모의, npm 경로 해석, bootstrap gate, 현재 출력/영수증 검사, 설치 실패·토큰 덮어쓰기 거부. Windows ACL/Job은 모의·정적 검사이며 실제 Windows/WSL2 통과로 세지 않는다. 최초 loopback 검사는 sandbox bind 거부로 미실행됐고 허용된 격리 실행에서 확인했다.
- 다른 담당의 모듈 검증은 별도 근거다: fastapi_1 원본 65개, fastapi_2 질문 15개, fastapi_3 변환 17개, mcp_1 규칙/의미 검사 33개를 보고했다. 이 통합에서는 해당 모듈을 포함한 전체 회귀를 실행했다. ui_6의 보호 연결 14개(실제 macOS OS 저장 1개 포함)는 해당 담당 근거이며 Electron 최종 빌드/E2E는 ui_7 소유다.
- 실제 Windows 네이티브·WSL2·두 PC·OCR 인식(Tesseract 없음)·실사용자 문서 의미 정확도·원격 배포는 미실행. D-054/055/056/057 등록과 README 실행법을 갱신했다. 임시 실행 자료는 fixture가 자신이 만든 경로만 정리하며 인계/검증 로그는 이번 병렬 조정 디렉터리에 보존한다.

- 최종 보완: 사용자가 fastapi_1 소유 파일의 최소 수정 예외를 승인하여 `core/api/v1/sources/download.py`의 MIME 조회에 `application/octet-stream` 기본값을 복원했다. 원본 형식 등록 검증과 열린 descriptor의 수명주기는 유지했다. 추출물 API 3개·기존 원본 MIME/잘못된 입력 2개·설치/토큰 보존 2개가 **7개, 2.590초에 통과**했다. 앞선 전체 913개 검사에서 발견한 실패 4건은 모두 수정 후 해당 범위 재검사를 통과했다. 전체 913개를 다시 실행한 결과로 표현하지 않는다. 마지막 설치기의 기존 환경 경로/버전 확인을 포함한 변경 Python 문법과 D-054~057 색인 중복 없음도 확인했다.

## 2026-10-25 — Windows·서버 운영 준비와 후속 Python 통합

- 실행 호스트는 Darwin arm64이며 Windows/WSL2/systemd/Caddy 실행 호스트는 제공되지 않았다. 사용자도 실제 서버 주소·배포판·계정·관리 권한·HTTPS 자격을 현재 알 수 없다고 답했다. 기존 개인 stdio 설정·운영 자료·정책은 변경하지 않았다.
- `desktop_bridge`의 제한된 stdin 토큰→새 개인 폴더/보호 파일, 허용 CLI→부모/EOF/신호 취소→자기 트리 회수를 구현했다. Windows bootstrap의 buffered read가 EOF 전 취소를 지연하고 daemon 종료를 abort시키는 결함을 실제 파이프로 재현·수정했다. 공통 `start_owned_process`는 생성 중 취소/연속 취소에도 핸들을 회수한 후 자식을 종료한다. Windows DACL/Job 분기는 실제 OS 인증과 구분하며 `windows_app_verified=false`를 유지한다.
- `server_deployment prepare/inspect`는 새 hash manifest 묶음·명시 TLS reverse proxy·단일 loopback backend·systemd·WSL 시작 스크립트·전체 보존/되돌림 절차와 읽기 전용 mount/사용자/정책/Python/systemd 점검을 제공한다. setup의 Linux 서버 코드 경로 역시 실제 mount로 검사한다. 기존 bundle/자료/정책을 덮어쓰지 않으며 자동 서비스/방화벽/인증서 발급은 없다. Caddy/systemd 실제 구문 실행·운영 배포는 대상 부재로 미실행이다.
- 초기 runtime/배포 집중22개 통과, 생성 중 취소 수정 후 runner/private 경계21개 통과, 최종 공통 helper를 쓴 bridge/배포13개 통과. 실제 격리 loopback bridge→질문 CLI→API 저장/취소 영수증 및 doctor→API/MCP 주체/정책 대조·파일 hash 무변경2개 통과. 첫 loopback 시험은 sandbox bind 거부였으며 scoped escalation 후 통과했다. 모델 출력은 합성이며 Windows 실기기 결과가 아니다.
- `.venv`의 잠금 의존성 전부 일치, `pip check` 통과. 실제 Codex CLI 0.164.0-alpha.11.1 preflight와 login status에 credentials_present 확인; 모델 사용권·실제 모델 품질을 이 진단으로 인증하지 않았다. 의존성 추가/재설치는 필요 없었다.
- fastapi_7 인계: 승인된 Homebrew Tesseract 5.5.3(의존 icu4c@78 78.3 포함) 설치, 기존 버전 cleanup 없음. 공식 tessdata_fast commit `87416418657359cb625c412a48b6e1d6d41c29bd`의 새 `kor.traineddata` SHA256 `6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2`, eng/osd 보존. `/opt/homebrew/bin` PATH와 선택 `TESSDATA_PREFIX=/opt/homebrew/share/tessdata`; 실제 doctor kor+eng ready 확인. 변환기의 언어 누락/손상 fallback·투명 검은 글자·EXIF 유실을 수정하고 실제 한국어/영어 OCR·부분 완료/취소·원본 hash 보존·격리 API 보고 재조회가 검증됐다. 결과 위치는 페이지/프레임과 변환 문자열 offset이며 글자 박스가 아니다. 회전 PDF 오인식·공개 원문 읽기 순서/한국어 오류가 남고 원문 전체 포함/의미 정확도를 보증하지 않는다. 상세 근거는 fastapi_7 handoff와 `validation_dir`에 보존한다.
- 전역 결정 D-058(규약 CAS/전체 보존/되돌림)·D-059(실행 브리지/배포 준비)를 등록하고 README의 운영 명령·진단·OCR 준비를 통합했다. 규약 정책 운영 적용은 관리 대상/권한 부재로 미실행이며 [규약 운영 전환 절차](../analysis/RULESET_ROLLOUT.md)를 연결했다.

- 실제 원문 평가(mcp_3)에서 Codex CLI가 `diagnostics.type=object + anyOf`의 properties 부재로 HTTP400을 반환한 사례를 인계받았다. 공통 `_strict_schema`의 CLI 사본에서 모든 분기가 object인 경우에만 중복 type을 제거하고, 발행 스키마/원문/프롬프트/원래 결과 검증은 유지했다. 스키마·입력·실행기7개 통과. [공식 구조화 출력 규격](https://developers.openai.com/api/docs/guides/structured-outputs)의 anyOf 구조를 확인했다. 평가 담당의 고정 결과를 재추출·튜닝하지 않았으며 실제 모델 재검증/평가는 ontology 기록이 소유한다.
- mcp_3는 실제 질문 모델이 document-only 근거에서 source citation 식별자를 만들어 서버가 invalid_argument로 거부하고 초안을 보존한 사례도 보고했다. 질문 정확도/저장 성공으로 처리하지 않았고, 이번 공통 ai/** 밖의 question_ai.py/question.py 수정 소유권을 UI 통합 후속 요청에 명시했다.

- 최종 공통 Python 회귀 `.venv/bin/python -B -m unittest discover -s core/tests -t . -v`: **970개, 281.149초, 모두 통과**. 격리 자료·실제 loopback HTTP/MCP·합성 모델 프로세스를 사용하며 scoped escalation으로 실행했다. fastapi_5/6/7·mcp_2 신규 검사와 공통 브리지·스키마 투영을 포함한다. 전체 재실행은 이 한 번이며 앞선 개별 검사는 해당 변경/실패 영향 검증이다. 로그는 `/private/var/folders/jv/7byd7qdd7lnc0trccnv0_2v00000gn/T/llm-wiki-fastapi8-integration-ict1fa_j/python-regression.log`에 보존한다. Python 통합은 완료했으며 Windows/WSL2 실기기·Caddy/systemd 실행·운영 HTTPS/재부팅/두 PC 검증은 미실행이다.

## 2026-10-26 — 고정 근거의 질문 인용 계약 개선

- 공개 개발 자료 `evals/rfc9111_stale_20261026`의 원시 답변은 인용문이 정확해도 `originals=[]`에서 가짜 source ID/판본/hash 3개를 만들어 서버가 거부했다. 원시 평가 파일은 수정하지 않고 기존 범용 스키마 통과·서버 거부를 재현했다.
- 새 `personal-question-v2`는 생성 때 `output.citation_references`에 실제 문서·원본·기계 주장·활성 정책의 전체 참조 조합을 고정하고 클라이언트 동적 스키마가 목록 밖의 ID·종류·판본 조합을 거부한다. 서버 검증을 완화하지 않았다. 기존 v1 계약·기존 실행/저장 영수증·권한/사용권·CAS·변환 계보를 보존하며 잘못된 출력도 로컬 원시 결과로 남긴다. 결정은 D-060.
- 질문 계약/클라이언트/실제 CLI/API 및 기존 변환 질문 인계의 집중 검증 **25개, 11.858초 통과**. 문서-only, 원본-only, 변환 참조, 혼합 claim/policy, 미존재 ID·틀린 종류·다른 판본, 정책 이벤트, 권한 회수, 현재 근거/대화 CAS, 취소, 응답 유실, 부분 저장/미확인 영수증을 포함한다. 최초 18개 실행은 16개 통과·CLI 2개 sandbox bind 거부였고, scoped escalation으로 실제 loopback을 허용한 뒤 새 시험을 포함해 통과했다. 합성 모델과 공개 고정 실패 자료를 사용했으며 실제 모델 호출은 수행하지 않았다.
- 다른 담당 구현을 묶은 Python 전체 회귀는 준비 후 한 번 실행한다. 실제 모델 재평가는 mcp_6이 담당하며 현재 외부 전송 승인 제한으로 대기 중이다. 이 코드 검증을 의미 정확도·실제 모델 성공·Windows/WSL2/운영 HTTPS 검증으로 확대하지 않는다.

- 통합 준비 중 mcp_6의 집중 검사에서 질문 heartbeat 시험 실패가 보고됐다. 고정 순서의 합성 지연으로 모델 완료 직전 서버가 heartbeat를 저장한 뒤 응답 수신 전에 감시 작업이 취소되면 로컬 lease 판본이 남아 다음 요청이 conflict인 문제를 재현했다. 감시 종료는 이미 보낸 heartbeat의 확인/기존 영수증 복구를 마치고 상태를 보존하도록 수정했으며 새 요청으로 재시도하거나 CAS 기준만 교체하지 않는다. 정상 시험의 120ms 대기 가정도 실제 heartbeat 이벤트 대기로 바꿨다. 수정 후 질문 클라이언트15개(5.492초), 실제 격리 질문/후보 CLI5개(30.714초)가 통과했다.
- mcp_4 인계에 따라 후보 CLI의 합성 checker 출력 fixture만 새 private assessment 계약에 맞췄다. 공개 진단 스키마/제품 checker/기존 판정은 변경하지 않았다. 전역 결정 D-061(의미 검사 상태·부분 보고)·D-062(규범 텍스트 보존)를 각 도메인의 확정 항목에 연결했다.

- 최종 공통 Python 회귀 `.venv/bin/python -B -m unittest discover -s core/tests -t . -v`: **999개, 286.306초, 모두 통과**. 전체 실행은 한 번이며 fastapi_10 OCR·mcp_4 의미 검사·mcp_5 추출 지침 및 이번 질문/heartbeat/후보 fixture 변경을 포함한다. 격리 자료·합성 모델 실행파일·실제 loopback HTTP/MCP/CLI로 검사했고 외부 실제 모델 호출은 0회다. 실행 전후 담당 변경 소스/시험 지문도 동일했다. 로그·결과·범위가 명시된 파일 지문은 `/private/tmp/llm-wiki-quality-fixes-20261026-xnucf4gg/fastapi9-integration-8viprnaa/`에 보존했다.
- UI 최종 build/E2E/패키징은 기존 ui_11 소유이며 변경된 답변 API/CLI 출력 형식은 없다. mcp_6은 로컬 준비만 완료했고 제품 지침·스키마·파생 자료의 외부 모델 전송은 기존 자동 승인 제한으로 미실행이다. 실제 의미 개선·모델 생성/저장 성공을 이번 통과로 주장하지 않는다. Windows/WSL2 실기기·운영 HTTPS/재부팅·두 PC·서명 검증도 미실행 상태를 유지한다.

## 2026-10-26 — Windows 실행 전 실제 보호 기능 진단

- 사용자가 Windows/WSL2 설치 동안 나머지 v0.1.0 문제 해결을 요청했습니다. `desktop_bridge`가 항상 `not_certified`를 반환하는데 앱은 `certified`를 요구해 준비된 Windows에서도 실행할 수 없던 경계를 D-064에 따라 수정했습니다. 새 `probe`는 실제 Windows 보호 파일·기존 파일 보존·hardlink 거부·Job의 자식/손자 종료를 검사하고, 앱은 그 성공과 실행마다의 기존 prepare 검사를 모두 요구합니다. 실패·시간 초과·정리 실패 시 실행을 허용하지 않습니다.
- Python의 desktop bridge/protocol 관련25검사 중24통과·실제 Windows 검사1건 건너뜀, 앱 personal-process Node7검사·main TypeScript·변경 범위 Oxc/format 통과. 최초 loopback 바인딩 제한2건은 허용된 격리 실행으로 재검증했고 시스템 Node 버전 오류는 번들 Node에서 해결했습니다. 실제 Windows 배포 검증 필드는 `not_certified`/`false`를 유지했습니다.
- 루트 README에 Windows `desktop_bridge probe` 실행법과 성공 필드·별도 실기기 검증 상태를 반영했습니다. 운영 자료·권한은 변경하지 않았고 기존 서버 보존 도구는 삭제하지 않았습니다. 사용자 요청으로 백업·복원 시험은 이번 출시 범위에서 제외했으며 Windows/WSL2 실기기 확인은 설치 완료 후 남아 있습니다.

## 2026-10-26 — 실제 질문 v2 저장과 후속 제품 동선

- 명시 승인한 공개 RFC9110의 실제 CLI 질문 출력 content와 인용5개를 수정 없이 기존 question run에 제출해 saved/complete 영수증을 확인했습니다. 만료 사용권은 정상 reclaim하고 원래 입력 hash·문서 revision·대화 기준 일치를 확인했습니다. 출력 ID 교정·서버 검증 완화·AI 재시도는 없었습니다.
- 실제 API 저장 뒤 Electron 결과 보관·초안 편집·명시 Wiki 반영·전체 이전 본문 이력과 종료/재시작 조회를 통과했습니다. 후속 통합의 추가 모델 호출은0회입니다. [고정 API 근거](../../../app/release/quality-fixes-20261026/verification/question-flow-v010-20261026/api-summary.json)와 [UI 근거](../../../app/release/quality-fixes-20261026/verification/question-flow-v010-20261026/ui-summary.json)를 따릅니다. 실제 질문 답변의 의미 정확도나 새 Windows/WSL2 운영 검증으로 확대하지 않습니다.


## 2026-10-26 — 개인 AI CLI의 Codex·Claude 선택

- 기존 비대화형 실행 구조에 ClaudeAdapter와 공통 provider 선택을 추가했습니다. 분석·질문·추출안·doctor는 `--ai-provider codex|claude`와 `--ai-cli`를 받고 기본 Codex를 유지합니다. 별도 의미 검사도 같은 제공자를 사용합니다. 프로세스 보호·취소·사용권·서버 저장/영수증 복구를 재사용하며 서버 토큰/API 키를 AI 환경에 전달하지 않습니다.
- Claude는 개인 로그인을 유지하는 safe-mode와 명시한 빈 사용자 설정/도구/MCP 구성을 사용합니다. 조직 관리 정책은 계속 적용됩니다. JSON Schema 결과의 StructuredOutput 운반 항목만 허용하고 임의 도구 활동·오류/누락 결과·입력/출력 크기 초과를 거부합니다. stdin 10,000,000바이트와 OS argv 한도 초과는 자르지 않고 ai_input_limit으로 반환합니다.
- 어댑터·플랫폼·스키마·의미 검사 단위 **33개 통과(11.529초)**. Claude 구조화 결과/공개 이벤트/프로세스 취소/입력 제한/doctor와 Codex 기존 호환을 포함합니다. Windows native/npm shim과 argv 한도는 모의 검사입니다.
- 실제 loopback CLI 통합 **18개 통과(114.055초, Codex 9+Claude 9)**. 분석 위키/그래프 저장·부분 실패, 질문 저장/생성 미리보기·stdin/SIGTERM 취소, 후보·별도 보고·읽기 재개·권한 회수 뒤 영수증, 별도 의미 보고/부분 오류 보존을 격리 서버와 합성 모델 실행 파일로 확인했습니다. 최초 sandbox 포트 바인딩 거부 뒤 해당 격리 실행만 승인 범위로 재검증했습니다.
- 설치된 Claude Code 2.1.302의 실제 사전 점검과 인증 상태 조회를 수행했습니다. 확인 당시 미로그인이며 모델 호출은 0회입니다. 사용자의 로그인 완료 후 실제 생성 검증, Windows 실기기 검증은 남습니다. 운영 자료·인증·MCP 설정·규약 정책 변경은 없습니다. 서버 provider/구 규약 호환은 analysis HISTORY, 앱 연결과 설정 복원은 ui HISTORY를 따릅니다.

재현 명령(프로젝트 루트, CLI 통합은 loopback 허용 환경):

```sh
.venv/bin/python -m unittest core.tests.runtime.test_claude_ai_runner core.tests.runtime.test_personal_ai_runner core.tests.runtime.test_client_runtime core.tests.runtime.test_cli_schema_projection core.tests.runtime.test_semantic_check -q
.venv/bin/python -m unittest core.tests.runtime.test_claude_cli core.tests.runtime.test_personal_ai_workflow core.tests.runtime.test_question_cli core.tests.runtime.test_proposal_cli core.tests.runtime.test_semantic_check_cli -q
```
