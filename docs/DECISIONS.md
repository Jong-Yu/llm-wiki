# 결정 색인

결정 본문은 도메인별 DECISIONS에서 관리합니다. 도메인이 정해졌으면 해당 파일의 필요한 절만 읽습니다. D 번호는 전역에서 유일하게 유지하며 새 중요한 결정을 만들 때만 이 색인에서 다음 번호를 확인합니다. 사소한 수정마다 새 결정을 만들지 않습니다. 현재 구현 상태는 도메인 PLAN, 실행 방법은 README를 따릅니다.

## 현재 기준 찾기

[도메인별 시작점](PLAN.md#도메인별-시작점)을 사용합니다. 기존 결정 전체 원문·미결정 표는 이관 전 기록 (정리로 삭제된 참고 자료)에 보존합니다. 상세 계약은 각 도메인 본문에서 유지하며 과거의 시험/운영 정정 기록을 새 결과로 승격하지 않습니다.

| 결정 | 소유 도메인 | 본문 |
| --- | --- | --- |
| D-001 | `workflow` | [작업 위치와 파일 역할](domains/workflow/DECISIONS.md#d-001--작업-위치와-파일-역할) |
| D-002 | `documents` | [전체 파일 버저닝](domains/documents/DECISIONS.md#d-002--전체-파일-버저닝) |
| D-003 | `workflow` | [단계별 확장](domains/workflow/DECISIONS.md#d-003--단계별-확장) |
| D-004 | `workflow` | [문서 책임 분리와 최소 구성](domains/workflow/DECISIONS.md#d-004--문서-책임-분리와-최소-구성) |
| D-005 | `documents` | [Python 표준 라이브러리와 Markdown 경로 (2026-10-21, 1단계)](domains/documents/DECISIONS.md#d-005--python-표준-라이브러리와-markdown-경로-2026-10-21-1단계) |
| D-006 | `documents` | [완성된 히스토리를 먼저 저장 (2026-10-21, 1단계)](domains/documents/DECISIONS.md#d-006--완성된-히스토리를-먼저-저장-2026-10-21-1단계) |
| D-007 | `documents` | [버전 이름과 동일 내용 처리 (2026-10-21, 1단계)](domains/documents/DECISIONS.md#d-007--버전-이름과-동일-내용-처리-2026-10-21-1단계) |
| D-008 | `documents` | [데이터 루트 단위 쓰기 잠금 (2026-10-21, 1단계)](domains/documents/DECISIONS.md#d-008--데이터-루트-단위-쓰기-잠금-2026-10-21-1단계) |
| D-009 | `documents` | [필수 기준 버전 검사로 오래된 내용 덮어쓰기 방지 (2026-10-21, 1단계 보완)](domains/documents/DECISIONS.md#d-009--필수-기준-버전-검사로-오래된-내용-덮어쓰기-방지-2026-10-21-1단계-보완) |
| D-010 | `documents` | [저장 결과와 임시 파일 정리 실패 분리 (2026-10-21, R-001 보완)](domains/documents/DECISIONS.md#d-010--저장-결과와-임시-파일-정리-실패-분리-2026-10-21-r-001-보완) |
| D-011 | `documents` | [문서당 UTF-8 1 MiB 상한 (2026-10-21, R-002 보완)](domains/documents/DECISIONS.md#d-011--문서당-utf-8-1-mib-상한-2026-10-21-r-002-보완) |
| D-012 | `platform` | [공식 Python MCP SDK와 로컬 stdio (2026-10-21, 2단계)](domains/platform/DECISIONS.md#d-012--공식-python-mcp-sdk와-로컬-stdio-2026-10-21-2단계) |
| D-013 | `documents` | [최신 파일의 제한된 문자열 검색 (2026-10-21, 2단계)](domains/documents/DECISIONS.md#d-013--최신-파일의-제한된-문자열-검색-2026-10-21-2단계) |
| D-014 | `documents` | [잠금 획득 대기 제한 (2026-10-21, R-003 보완)](domains/documents/DECISIONS.md#d-014--잠금-획득-대기-제한-2026-10-21-r-003-보완) |
| D-015 | `platform` | [MCP 쓰기 계약과 오류 전달 (2026-10-21, 2단계)](domains/platform/DECISIONS.md#d-015--mcp-쓰기-계약과-오류-전달-2026-10-21-2단계) |
| D-016 | `platform` | [맥북의 로컬 stdio 서버와 프로젝트 Codex CLI 연결 (2026-10-21, 3단계)](domains/platform/DECISIONS.md#d-016--맥북의-로컬-stdio-서버와-프로젝트-codex-cli-연결-2026-10-21-3단계) |
| D-017 | `platform` | [Windows 원격 PoC와 임시 HTTPS 터널 (2026-10-21, 3단계 보완)](domains/platform/DECISIONS.md#d-017--windows-원격-poc와-임시-https-터널-2026-10-21-3단계-보완) |
| D-018 | `ontology` | [Codex 추출과 문서별 온톨로지 (2026-10-22, 4단계)](domains/ontology/DECISIONS.md#d-018--codex-추출과-문서별-온톨로지-2026-10-22-4단계) |
| D-019 | `knowledge` | [문서 간 명시 링크와 공통 개념 후보 (2026-10-22, 4단계 보완)](domains/knowledge/DECISIONS.md#d-019--문서-간-명시-링크와-공통-개념-후보-2026-10-22-4단계-보완) |
| D-020 | `ontology` | [역할별 협업과 근거·의미를 구분한 추출 평가 (2026-10-22, 4단계 보완)](domains/ontology/DECISIONS.md#d-020--역할별-협업과-근거의미를-구분한-추출-평가-2026-10-22-4단계-보완) |
| D-021 | `ontology` | [원본 보유 세션과 관계 생성 세션의 분리 검증 (2026-10-22, 4단계 보완)](domains/ontology/DECISIONS.md#d-021--원본-보유-세션과-관계-생성-세션의-분리-검증-2026-10-22-4단계-보완) |
| D-022 | `ontology` | [조건을 보존하는 온톨로지 v2와 사용자 검토 후보 (2026-10-22, 4단계 보완)](domains/ontology/DECISIONS.md#d-022--조건을-보존하는-온톨로지-v2와-사용자-검토-후보-2026-10-22-4단계-보완) |
| D-023 | `ontology` | [업무 관점과 수식된 개념의 검증 범위 (2026-10-22, 4단계 보완)](domains/ontology/DECISIONS.md#d-023--업무-관점과-수식된-개념의-검증-범위-2026-10-22-4단계-보완) |
| D-024 | `ontology` | [관점·식별 범위·속성 주장·출처를 보존하는 v3 (2026-10-22, 4단계 보완)](domains/ontology/DECISIONS.md#d-024--관점식별-범위속성-주장출처를-보존하는-v3-2026-10-22-4단계-보완) |
| D-025 | `ontology` | [자연어 의미 설명·사용자별 관점·사람의 수정 이력 (2026-10-22, 4단계 후속 설계)](domains/ontology/DECISIONS.md#d-025--자연어-의미-설명사용자별-관점사람의-수정-이력-2026-10-22-4단계-후속-설계) |
| D-026 | `access` | [사용자 권한과 관점 프로필을 분리한 tenant 모드 (2026-10-22, 4-A)](domains/access/DECISIONS.md#d-026--사용자-권한과-관점-프로필을-분리한-tenant-모드-2026-10-22-4-a) |
| D-027 | `knowledge` | [선택 문서의 자연어·전체 그래프를 보존하는 조회 맥락 (2026-10-22, 4-B)](domains/knowledge/DECISIONS.md#d-027--선택-문서의-자연어전체-그래프를-보존하는-조회-맥락-2026-10-22-4-b) |
| D-028 | `reviews` | [원문·추출과 분리한 검토 원장과 상태 충돌 검사 (2026-10-22, 4-C)](domains/reviews/DECISIONS.md#d-028--원문추출과-분리한-검토-원장과-상태-충돌-검사-2026-10-22-4-c) |
| D-029 | `ontology` | [질문을 고정한 자연어·그래프·결합 비교 (2026-10-22, 4-D)](domains/ontology/DECISIONS.md#d-029--질문을-고정한-자연어그래프결합-비교-2026-10-22-4-d) |
| D-030 | `reviews` | [전문가의 업무 판단과 Action log·계정/연결 방향 (2026-10-22)](domains/reviews/DECISIONS.md#d-030--전문가의-업무-판단과-action-log계정연결-방향-2026-10-22) |
| D-031 | `reviews` | [전문가 정책을 기존 검토 원장에 보존하고 최신 판단으로 조회 (2026-10-22, 선행 1)](domains/reviews/DECISIONS.md#d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1) |
| D-032 | `knowledge` | [변경 문서의 직접 연결과 재검토 후보 안내 (2026-10-23, 선행 2)](domains/knowledge/DECISIONS.md#d-032--변경-문서의-직접-연결과-재검토-후보-안내-2026-10-23-선행-2) |
| D-033 | `ui` | [정책을 추적한 UI 시안과 구현 경계 (2026-10-23)](domains/ui/DECISIONS.md#d-033--정책을-추적한-ui-시안과-구현-경계-2026-10-23) |
| D-034 | `workflow` | [지식을 축적·활용·갱신하는 제품 목적 (2026-10-23)](domains/workflow/DECISIONS.md#d-034--지식을-축적활용갱신하는-제품-목적-2026-10-23) |
| D-035 | `analysis` | [문서 등록의 맥락 힌트와 Bounded Context 간 대응 검토 (2026-10-23)](domains/analysis/DECISIONS.md#d-035--문서-등록의-맥락-힌트와-bounded-context-간-대응-검토-2026-10-23) |
| D-036 | `ontology` | [추출 신뢰성·반복 일관성과 전문가 조정의 판정 기준 (2026-10-23)](domains/ontology/DECISIONS.md#d-036--추출-신뢰성반복-일관성과-전문가-조정의-판정-기준-2026-10-23) |
| D-037 | `knowledge` | [문서에서 발견한 개념·상태 조건의 연결과 통합 조회 방향 (2026-10-23)](domains/knowledge/DECISIONS.md#d-037--문서에서-발견한-개념상태-조건의-연결과-통합-조회-방향-2026-10-23) |
| D-038 | `correspondences` | [문서 간 조건·개념 대응 판단의 최소 계약 (2026-10-23)](domains/correspondences/DECISIONS.md#d-038--문서-간-조건개념-대응-판단의-최소-계약-2026-10-23) |
| D-039 | `ui` | [유스케이스에 따른 AI 온톨로지 중심 화면 구성 (2026-10-23)](domains/ui/DECISIONS.md#d-039--유스케이스에-따른-ai-온톨로지-중심-화면-구성-2026-10-23) |
| D-040 | `knowledge` | [개념 중심 최신 지식 통합 조회 (2026-10-23)](domains/knowledge/DECISIONS.md#d-040--개념-중심-최신-지식-통합-조회-2026-10-23) |
| D-041 | `access` | [개인 인증 tenant 연결 전환과 보존·복구 절차 (2026-10-23)](domains/access/DECISIONS.md#d-041--개인-인증-tenant-연결-전환과-보존복구-절차-2026-10-23) |
| D-042 | `sources` | [첫 업무 자료의 선정·등록 범위와 최소 쓰기 권한 (2026-10-24)](domains/sources/DECISIONS.md#d-042--첫-업무-자료의-선정등록-범위와-최소-쓰기-권한-2026-10-24) |
| D-043 | `sources` | [원격 문서 등록과 개인 CLI 분석·MCP 저장·UI 결과 연결 (2026-10-24)](domains/sources/DECISIONS.md#d-043--원격-문서-등록과-개인-cli-분석mcp-저장ui-결과-연결-2026-10-24) |
| D-044 | `analysis` | [MCP 공통 추출 규약·맥락과 분석 입력 버전 관리 (2026-10-24)](domains/analysis/DECISIONS.md#d-044--mcp-공통-추출-규약맥락과-분석-입력-버전-관리-2026-10-24) |
| D-045 | `ui` | [Electron 앱의 디자인 토큰과 React 컴포넌트 경계 (2026-10-24)](domains/ui/DECISIONS.md#d-045--electron-앱의-디자인-토큰과-react-컴포넌트-경계-2026-10-24) |
| D-046 | `platform` | [업무별 백엔드 모듈과 FastAPI·MCP 분리 및 스펙 주도 개발 (2026-10-25)](domains/platform/DECISIONS.md#d-046--업무별-백엔드-모듈과-fastapimcp-분리-및-스펙-주도-개발-2026-10-25) |
| D-047 | `platform` | [원격 PC의 최초 연결과 설정 수명주기 (2026-10-25)](domains/platform/DECISIONS.md#d-047--원격-pc의-최초-연결과-설정-수명주기-2026-10-25) |
| D-048 | `platform` | [서버 노트북의 WSL2와 Electron 중앙 저장 (2026-10-25)](domains/platform/DECISIONS.md#d-048--서버-노트북의-wsl2와-electron-중앙-저장-2026-10-25) |
| D-049 | `workflow` | [도메인별 문서와 작업 규모별 절차](domains/workflow/DECISIONS.md#d-049--도메인별-문서와-작업-규모별-절차-2026-10-25) |
| D-050 | `platform` | [잔여 HTTP API와 개인 기록의 최소 계약](domains/platform/DECISIONS.md#d-050--잔여-http-api와-개인-기록의-최소-계약-2026-10-25) |
| D-051 | `platform` | [시안의 분석·비교·결과·질문·집계를 지원하는 API](domains/platform/DECISIONS.md#d-051--시안의-분석비교결과질문집계를-지원하는-api-2026-10-25) |
| D-052 | `analysis` | [MCP 진단 보존·버전별 제출·작업 공통 기준](domains/analysis/DECISIONS.md#d-052--mcp-진단-보존버전별-제출작업-공통-기준-2026-10-25) |
| D-053 | `ui` | [1280×720 공통 레이아웃과 시안 접근 경로 보존](domains/ui/DECISIONS.md#d-053--1280720-공통-레이아웃과-시안-접근-경로-보존-2026-10-25) |
| D-054 | `sources` | [DOCX·이미지의 불변 원본 보관과 개인 변환 보고](domains/sources/DECISIONS.md#d-054--docx이미지의-불변-원본-보관과-개인-변환-보고-2026-10-25) |
| D-055 | `platform` | [개인 실행 환경과 읽기 전용 진단·안전한 재개](domains/platform/DECISIONS.md#d-055--개인-실행-환경과-읽기-전용-진단안전한-재개-2026-10-25) |
| D-056 | `analysis` | [규칙별 검사 보고·개인 별도 의미 검사와 기존 규약 호환](domains/analysis/DECISIONS.md#d-056--규칙별-검사-보고개인-별도-의미-검사와-기존-규약-호환-2026-10-25) |
| D-057 | `platform` | [PC 연결 보호 저장과 재시작 재확인](domains/platform/DECISIONS.md#d-057--pc-연결-보호-저장과-재시작-재확인-2026-10-25) |
| D-058 | `analysis` | [규약 허용 정책의 명시 전환·전체 보존·되돌림](domains/analysis/DECISIONS.md#d-058--규약-허용-정책의-명시-전환전체-보존되돌림-2026-10-25) |
| D-059 | `platform` | [데스크톱 실행 브리지와 명시 서버 배포 준비](domains/platform/DECISIONS.md#d-059--데스크톱-실행-브리지와-명시-서버-배포-준비-2026-10-25) |
| D-060 | `platform` | [고정 근거에서 선택하는 질문 인용 계약](domains/platform/DECISIONS.md#d-060--고정-근거에서-선택하는-질문-인용-계약-2026-10-26) |
| D-061 | `analysis` | [별도 의미 검사 상태 계약과 부분 보고 보존](domains/analysis/DECISIONS.md#d-061--별도-의미-검사-상태-계약과-부분-보고-보존-2026-10-26) |
| D-062 | `ontology` | [규범 문장의 텍스트 보존과 사실 관계 구분](domains/ontology/DECISIONS.md#d-062--규범-문장의-텍스트-보존과-사실-관계-구분-2026-10-26) |
| D-063 | `workflow` | [반복 사용하는 v0.1.0 내부 배포판의 지원 범위](domains/workflow/DECISIONS.md#d-063--반복-사용하는-v010-내부-배포판의-지원-범위-2026-10-26) |
| D-064 | `platform` | [Windows 실행 전 실제 보호 기능 진단](domains/platform/DECISIONS.md#d-064--windows-실행-전-실제-보호-기능-진단-2026-10-26) |
| D-065 | `analysis` | [Codex·Claude 실행 기록과 고정 규약 호환](domains/analysis/DECISIONS.md#d-065--codexclaude-실행-기록과-고정-규약-호환-2026-10-26) |
| D-066 | `workflow` | [다섯 기능 중심의 PoC와 원본 보관·Markdown 편집](domains/workflow/DECISIONS.md#d-066--다섯-기능-중심의-poc와-원본-보관markdown-편집-2026-10-26) |
| D-067 | `ui` | [기존 API/MCP를 전제로 한 화면별 Electron 시안](domains/ui/DECISIONS.md#d-067--기존-apimcp를-전제로-한-화면별-electron-시안-2026-10-26) |
| D-068 | `ui` | [화면별 새 세션에서 신규 UI 개발](domains/ui/DECISIONS.md#d-068--화면별-새-세션에서-신규-ui-개발-2026-10-27) |
| D-069 | `platform` | [Windows 설치 파일에 개인 실행기와 OCR 포함](domains/platform/DECISIONS.md#d-069--windows-설치-파일에-개인-실행기와-ocr-포함-2026-10-27) |
| D-070 | `ui` | [현재 화면을 기본 UI로 통합](domains/ui/DECISIONS.md#d-070--현재-화면을-기본-ui로-통합-2026-10-28) |
| D-071 | `access` | [소규모 PoC 가입·로그인과 사용자별 영구 토큰](domains/access/DECISIONS.md#d-071--소규모-poc-가입로그인과-사용자별-영구-토큰-2026-10-28) |
| D-072 | `documents` | [편집 Markdown의 Front Matter와 작성 이력](domains/documents/DECISIONS.md#d-072--편집-markdown의-front-matter와-작성-이력-2026-10-28) |
| D-073 | `sources` | [원본 판본 보관과 관련 저장 폴더 통합](domains/sources/DECISIONS.md#d-073--원본-판본-보관과-관련-저장-폴더-통합-2026-10-28) |
| D-074 | `analysis` | [기본 등록의 단일 Markdown과 최소 분석 기록](domains/analysis/DECISIONS.md#d-074--기본-등록의-단일-markdown과-최소-분석-기록-2026-10-28) |
| D-075 | `ontology` | [판단 원장을 보존하는 문서별 Clean Up](domains/ontology/DECISIONS.md#d-075--판단-원장을-보존하는-문서별-clean-up-2026-10-29) |
| D-076 | `analysis` | [명시 입력 보기와 검증된 재개로 분석 전송량 제한](domains/analysis/DECISIONS.md#d-076--명시-입력-보기와-검증된-재개로-분석-전송량-제한-2026-10-29) |
| D-077 | `ontology` | [명시 내용 보존과 추정 검토의 추출 정책 초안](domains/ontology/DECISIONS.md#d-077--명시-내용-보존과-추정-검토의-추출-정책-초안-2026-10-29) |
| D-078 | `reviews` | [사람이 추가하는 독립 관계와 현재 UI의 검토 복원](domains/reviews/DECISIONS.md#d-078--사람이-추가하는-독립-관계와-현재-ui의-검토-복원-2026-10-29) |
| D-079 | `ui` | [같은 화면과 업무 서비스를 사용하는 로컬 웹 테스트 모드](domains/ui/DECISIONS.md#d-079--같은-화면과-업무-서비스를-사용하는-로컬-웹-테스트-모드-2026-10-29) |
| D-080 | `sources` | [개인 PC의 Pandoc 기본 DOCX 변환과 기존 보고 호환](domains/sources/DECISIONS.md#d-080--개인-pc의-pandoc-기본-docx-변환과-기존-보고-호환-2026-10-29) |
| D-081 | `ontology` | [저장 없는 초안 검사와 제한된 끝점 역할 규칙](domains/ontology/DECISIONS.md#d-081--저장-없는-초안-검사와-제한된-끝점-역할-규칙-2026-10-29) |
| D-082 | `ui` | [대상 주소와 초안을 유지하는 화면 이동 및 업무 모달 제거](domains/ui/DECISIONS.md#d-082--대상-주소와-초안을-유지하는-화면-이동-및-업무-모달-제거-2026-10-29) |
| D-083 | `access` | [PoC에서 역할별 조회 관점 제외](domains/access/DECISIONS.md#d-083--poc에서-역할별-조회-관점-제외-2026-10-29) |
| D-084 | `ontology` | [IMP05 별도 시간 장부와 조회 엔진의 도입 제외](domains/ontology/DECISIONS.md#d-084--imp05-별도-시간-장부와-조회-엔진의-도입-제외-2026-10-30) |
| D-085 | `ui` | [VS Code 기반 공통 작업 화면](domains/ui/DECISIONS.md#d-085--vs-code-기반-공통-작업-화면-2026-10-31) |
| D-086 | `ui` | [연속된 작업 면을 기준으로 색상 구성 선택](domains/ui/DECISIONS.md#d-086--연속된-작업-면을-기준으로-색상-구성-선택-2026-10-31) |
| D-087 | `ui` | [전체 UI의 설계 규칙과 완료 기준 확정](domains/ui/DECISIONS.md#d-087--전체-ui의-설계-규칙과-완료-기준-확정-2026-10-31) |
| D-088 | `ui` | [공통 틀의 바깥 패널 분리와 사이드바 호버 펼침](domains/ui/DECISIONS.md#d-088--공통-틀의-바깥-패널-분리와-사이드바-호버-펼침-2026-11-01) |
| D-089 | `ui` | [화면 사용성 시안의 구현 선택](domains/ui/DECISIONS.md#d-089--화면-사용성-시안의-구현-선택-2026-11-01) |
| D-090 | `ui` | [보류 기능의 구현 선택](domains/ui/DECISIONS.md#d-090--보류-기능의-구현-선택-2026-11-02) |
| D-091 | `ui` | [Header의 제목·주 버튼 규칙과 점검 의견의 구현 선택](domains/ui/DECISIONS.md#d-091--header의-제목주-버튼-규칙과-점검-의견의-구현-선택-2026-11-02) |
| D-092 | `ui` | [채팅 질문의 AI 세션 이어 가기(resume)와 폴백](domains/ui/DECISIONS.md#d-092--채팅-질문의-ai-세션-이어-가기resume와-폴백-2026-11-03) |
| D-093 | `ui` | [AI 제공자별 모델 선택](domains/ui/DECISIONS.md#d-093--ai-제공자별-모델-선택-2026-11-03) |
| D-094 | `ui` | [채팅 답변의 결과물 복사본은 내려받을 때만 만든다](domains/ui/DECISIONS.md#d-094--채팅-답변의-결과물-복사본은-내려받을-때만-만든다-2026-11-03) |
| D-095 | `platform` | [Pandoc 사용 중단과 문서 변환의 대체](domains/platform/DECISIONS.md#d-095--pandoc-사용-중단과-문서-변환의-대체-2026-11-03) |
| D-096 | `ui` | [관련 위키 문서가 없어도 질문을 AI에 보내 "위키에 없음"을 답한다](domains/ui/DECISIONS.md#d-096--관련-위키-문서가-없어도-질문을-ai에-보내-위키에-없음을-답한다-2026-11-04) |
| D-097 | `ui` | [설정 화면의 "연결됨"은 로그인 확인이며, 실제 호출은 별도 시험으로 확인한다](domains/ui/DECISIONS.md#d-097--설정-화면의-연결됨은-로그인-확인이며-실제-호출은-별도-시험으로-확인한다-2026-11-04) |
| D-098 | `ui` | [AI 화면 재디자인의 범위와 연결 상태 4단계](domains/ui/DECISIONS.md#d-098--ai-화면-재디자인의-범위와-연결-상태-4단계-2026-11-04) |
| D-099 | `knowledge` | [질문별 외부 웹 근거 선택과 출처 보존](domains/knowledge/DECISIONS.md#d-099--질문별-외부-웹-근거-선택과-출처-보존-2026-11-05) |
| D-100 | `documents` | [원문을 보존하는 SQLite 조회 인덱스 1단계](domains/documents/DECISIONS.md#d-100--원문을-보존하는-sqlite-조회-인덱스-1단계-2026-11-06) |
| D-101 | `documents` | [변경 원장과 요청 계측으로 조회 인덱스 증분 갱신](domains/documents/DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06) |
| D-102 | `analysis` | [통합 이력의 작업 이벤트 조회와 상세 결과 검증 분리](domains/analysis/DECISIONS.md#d-102--통합-이력의-작업-이벤트-조회와-상세-결과-검증-분리-2026-11-06) |
| D-103 | `knowledge` | [전체 문서 검색과 판본 고정 관계 페이지로 시작하는 지도](domains/knowledge/DECISIONS.md#d-103--전체-문서-검색과-판본-고정-관계-페이지로-시작하는-지도-2026-11-06) |
| D-104 | `ui` | [온톨로지 검색의 화면 한정 조회 캐시 시범 적용](domains/ui/DECISIONS.md#d-104--온톨로지-검색의-화면-한정-조회-캐시-시범-적용-2026-11-06) |
| D-105 | `ui` | [인증 화면 트리에 속한 조회 캐시와 편집 기준 분리](domains/ui/DECISIONS.md#d-105--인증-화면-트리에-속한-조회-캐시와-편집-기준-분리-2026-11-06) |
| D-106 | `knowledge` | [Python 서버의 기동 전·변경 후 온톨로지 색인 준비](domains/knowledge/DECISIONS.md#d-106--python-서버의-기동-전변경-후-온톨로지-색인-준비-2026-11-06) |
| D-107 | `knowledge` | [기존 근거에서 읽는 선택 용어 카드와 기본 채팅 분리](domains/knowledge/DECISIONS.md#d-107--기존-근거에서-읽는-선택-용어-카드와-기본-채팅-분리-2026-11-06) |
| D-108 | `knowledge` | [전체 근거를 보존하고 필요한 부분을 읽는 질문 실행](domains/knowledge/DECISIONS.md#d-108--전체-근거를-보존하고-필요한-부분을-읽는-질문-실행-2026-11-06) |
| D-109 | `knowledge` | [인용 ID 렌더링과 읽기 범위 명시](domains/knowledge/DECISIONS.md#d-109--인용-id-렌더링과-읽기-범위-명시-2026-11-06) |
| D-110 | `knowledge` | [질문 항목과 원문 맥락 보존의 개발 검증](domains/knowledge/DECISIONS.md#d-110--질문-항목과-원문-맥락-보존의-개발-검증-2026-11-07) |
| D-111 | `knowledge` | [동일 근거의 무손실 입력 참조](domains/knowledge/DECISIONS.md#d-111--동일-근거의-무손실-입력-참조-2026-11-07) |
| D-112 | `knowledge` | [짧은 문서 전문 읽기의 단일 자동 이어읽기](domains/knowledge/DECISIONS.md#d-112--짧은-문서-전문-읽기의-단일-자동-이어읽기-2026-11-07) |
| D-113 | `knowledge` | [선택적 묶음 조회와 사후 계획 재생의 구분](domains/knowledge/DECISIONS.md#d-113--선택적-묶음-조회와-사후-계획-재생의-구분-2026-11-07) |
| D-114 | `ui` | [지도 주제 추가와 관계 중심 이동의 분리](domains/ui/DECISIONS.md#d-114--지도-주제-추가와-관계-중심-이동의-분리-2026-11-07) |
| D-115 | `ui` | [사용자 과업에 따른 내부 참조와 원시 응답 표시 제거](domains/ui/DECISIONS.md#d-115--사용자-과업에-따른-내부-참조와-원시-응답-표시-제거-2026-11-07) |
| D-116 | `knowledge` | [질문 전용 CLI 입력 축소의 실제 비교와 품질 채택 기준](domains/knowledge/DECISIONS.md#d-116--질문-전용-cli-입력-축소의-실제-비교와-품질-채택-기준-2026-11-07) |
| D-117 | `ui` | [지도 범위와 판본에 연결된 근거 탐색](domains/ui/DECISIONS.md#d-117--지도-범위와-판본에-연결된-근거-탐색-2026-11-07) |
| D-118 | `knowledge` | [같은 호출의 완결성 안내와 질문 전용 기본 연결](domains/knowledge/DECISIONS.md#d-118--같은-호출의-완결성-안내와-질문-전용-기본-연결-2026-11-07) |
| D-119 | `knowledge` | [전체 지도에서 이어 읽는 원문 앵커 관계](domains/knowledge/DECISIONS.md#d-119--전체-지도에서-이어-읽는-원문-앵커-관계-2026-11-07) |
| D-120 | `knowledge` | [사용자 원문을 우선하는 질문 문맥과 조건 변경 유지](domains/knowledge/DECISIONS.md#d-120--사용자-원문을-우선하는-질문-문맥과-조건-변경-유지-2026-11-08) |
| D-121 | `knowledge` | [첫 호출의 도구 선택과 상세 안내의 지연 제공](domains/knowledge/DECISIONS.md#d-121--첫-호출의-도구-선택과-상세-안내의-지연-제공-2026-11-08) |
| D-122 | `knowledge` | [첫 검색어 정밀 안내의 소규모 비교와 기본 도입 보류](domains/knowledge/DECISIONS.md#d-122--첫-검색어-정밀-안내의-소규모-비교와-기본-도입-보류-2026-11-08) |
| D-123 | `knowledge` | [검색 후보를 보존하는 일치 구절 우선 페이지와 도입 보류](domains/knowledge/DECISIONS.md#d-123--검색-후보를-보존하는-일치-구절-우선-페이지와-도입-보류-2026-11-08) |
| D-124 | `knowledge` | [기존 관계·판단 색인과 첫 답변 전 고정 근거 제공](domains/knowledge/DECISIONS.md#d-124--기존-관계판단-색인과-첫-답변-전-고정-근거-제공-2026-11-08) |
