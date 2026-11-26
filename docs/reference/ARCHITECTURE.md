# LLM Wiki 시스템과 데이터 구조

설명 기준: 2026-10-30. [문서 적용 기준](README.md#문서-적용-기준)에 따라 현행 계약·검증 상태는 담당 도메인에서 확인한다.

LLM Wiki는 문서와 지식을 보관하는 중앙 서버, 사용자가 작업하는 데스크톱 앱, 개인 PC에서 AI와 파일 변환을 실행하는 실행기로 구성한다. 중앙 서버는 원문·판본·권한·검토·저장 결과를 관리하고, 개인 실행기는 서버가 고정한 입력으로 AI 작업을 수행한다.

## 1. 시스템 구성

![앱과 개인 실행기가 API 또는 MCP를 통해 중앙 서버의 권한 확인·업무 처리와 문서·지식·전체 이력에 접근하는 구성](assets/system-architecture.png)

앱은 조회·편집을 요청하고 개인 실행기는 AI CLI와 변환기를 실행한다. 두 경로 모두 서버의 권한·업무 검사를 거쳐 저장 영역에 접근한다. ‘개인 PC에서 실행’은 CLI와 변환기의 실행 위치이며 AI 모델 자체의 오프라인 구동을 뜻하지 않는다. 아래 도식은 같은 구조를 구성 요소별로 펼친 것이다.

```mermaid
flowchart LR
    subgraph PC[개인 PC]
        UI[Electron 화면]
        MAIN[앱 실행 서비스]
        RUN[개인 Python 실행기]
        AI[Codex 또는 Claude Code CLI]
        CONVERT[문서 변환과 OCR]
        UI --> MAIN
        MAIN --> RUN
        RUN --> AI
        RUN --> CONVERT
    end
    subgraph SERVER[중앙 Python 서버]
        HTTP[HTTP API]
        MCP[MCP 도구]
        ACCESS[인증과 행동 권한 검사]
        DOMAIN[업무 모듈]
        HTTP --> ACCESS
        MCP --> ACCESS
        ACCESS --> DOMAIN
    end
    subgraph STORAGE[서버 저장 영역]
        DATA[워크스페이스별 자료와 이력]
        POLICY[접근 정책과 보호된 인증정보]
    end
    MAIN --> HTTP
    RUN --> MCP
    RUN --> HTTP
    DOMAIN --> DATA
    ACCESS --> POLICY
```

서버는 업무별 모듈을 하나의 배포 단위로 묶은 구조다. HTTP API와 MCP는 같은 접근 정책과 업무 모듈을 호출한다. API는 `/api/v1`, 원격 MCP는 `/mcp`로 제공한다. MCP는 로컬 stdio 연결도 지원한다.

앱의 일반 조회·편집은 HTTP API를 사용한다. 개인 실행기는 작업 종류에 맞는 API 또는 MCP를 통해 입력을 받고 결과를 제출한다. 분석 실행기는 MCP의 규약·고정 입력·저장 계약을 사용하며, AI CLI의 출력은 검증을 거쳐 서버에 전달한다. 서버 프로세스가 AI CLI나 파일 변환기를 직접 실행하지 않는다.

### 코드의 책임

| 위치 | 책임 |
| --- | --- |
| `app/src/renderer/` | 화면, 입력, 탐색, 결과와 상태 표시 |
| `app/src/main/` | 서버 연결, OS 보호 저장, 개인 실행 관리, 창과 실행 수명 |
| `core/runtime/` | 서버 조립, 실행 설정, 데스크톱 브리지, 프로세스 관리 |
| `core/api/` | HTTP 요청·응답과 업무 라우팅 |
| `core/mcp/` | MCP 도구·입력 검증·응답과 업무 라우팅 |
| `core/modules/` | 도메인별 업무 규칙, 저장, 검증, 조회 |
| `core/client/` | 개인 PC의 서버 통신, AI 실행, 입력 조립, 파일 변환 |
| `core/common/` | 정규 JSON, 해시, 공통 경로 등 기술 도구 |
| `tools/` | 서버 준비·진단·분석·질문·변환·규약 발행의 실행 명령 |

진입점과 실행 방법은 [Python 코드 길잡이](../../core/README.md), [프로젝트 실행 안내](../../README.md), [앱 실행 안내](../../app/README.md)를 따른다.

## 2. 업무 도메인

| 도메인 | 소유 데이터와 역할 |
| --- | --- |
| access | 사용자, 워크스페이스 소속, 행동 권한, 인증, 접근 기준 |
| sources | 등록 원본, 원본 판본, 파일 특성, Wiki 문서 연결 |
| documents | 편집 가능한 Markdown, 문서 메타데이터, 전체 파일 이력, 작성 원장 |
| ontology | 문서 판본에 근거한 개체·관계·속성·후보와 추출 그래프 |
| reviews | 전문가 검토, 정정, 업무 정책, 관계 추가, 정리 표시, 되돌림 기록 |
| correspondences | 문서 사이의 명시적 대응과 그 근거·판단 |
| knowledge | 개념·맥락·문서 연결·변경 영향을 함께 조회하는 통합 계층 |
| extraction_rules | 발행한 추출 규약·스키마·의미 지침과 허용 정책 |
| analysis_jobs | 분석 접수, 진행 상태, 작업 소유권과 실행 사용권, 취소 |
| analysis_inputs | 원문·규약·맥락·검토 상태를 특정 판본으로 고정한 입력 |
| analysis_results | 제출 검증, 문서·그래프 저장, 저장 영수증과 진단 |
| analysis_plans·analysis_proposals | 명시적 고급 분석 계획, 저장 전 추출안의 검토·적용 |
| personal | 개인 대화·질문 실행·저장 결과·초안·비교와 지식 대조 기록 |

업무 모듈은 원본, 추출, 사람의 판단을 각각 관리한다. 예를 들어 전문가 정책은 원문 수정으로 취급하지 않으며, AI의 문서 간 유사성 후보는 확정된 대응 관계와 구분한다.

## 3. 데이터 계보와 식별자

```mermaid
flowchart TD
    SOURCE[원본 source_id와 source_version]
    CONVERSION[변환 보고와 원본 위치]
    DOC[Wiki document_id와 전체 revision]
    BODY[본문 body_revision과 줄 좌표]
    INPUT[고정 분석 입력과 발행 규약]
    GRAPH[추출 그래프와 generation_id]
    REVIEW[주장별 전문가 판단]
    QUERY[근거 기반 탐색과 질문]
    RESULT[개인 답변과 결과 초안]
    SOURCE --> CONVERSION --> DOC --> BODY
    SOURCE --> INPUT
    BODY --> INPUT --> GRAPH
    GRAPH --> REVIEW
    DOC --> QUERY
    GRAPH --> QUERY
    REVIEW --> QUERY
    QUERY --> RESULT
    RESULT -->|사용자의 명시 반영| DOC
```

| 값 | 의미와 사용처 |
| --- | --- |
| `tenant`·`workspaceId` | 자료가 속한 작업 공간의 안정 식별자. 표시 이름과 구분한다. |
| `user_id` | 서버가 검증한 사용자 식별자. 개인 기록 소유권의 기준이다. |
| `source_id`·`source_version` | 등록 원본과 특정 불변 판본. 같은 파일명도 별도 원본일 수 있다. |
| `document` | `주제/문서.md` 형태의 Wiki 상대 경로. 문서 조회·저장에 사용한다. |
| `document_id` | 서버가 관리하는 문서 ID. 그래프·검토 원장과 문서를 연결한다. |
| `revision` | Front Matter를 포함한 전체 파일 바이트의 SHA-256. 읽은 내용과 함께 받고 저장 충돌 검사에 사용한다. |
| `body_revision` | Front Matter를 제외한 본문 지문. 전체 파일의 저장 기준을 대신하지 않는다. |
| `source_revision` | 해당 그래프가 근거로 삼은 Wiki 전체 파일의 revision. 원본 파일의 version ID와 다르다. |
| `generation_id` | 그래프 추출 세대를 식별한다. 사람의 판단을 적용할 주장·세대와 현재성을 대조한다. |
| `job_id`·`request_id` | 분석 작업과 개별 접수·저장 요청을 구분한다. 동일 요청의 결과 확인과 중복 방지에 사용한다. |
| `bundle_revision`·규약 참조 | 분석 입력과 발행 규약의 정확한 판본을 식별한다. |
| `access_revision` | 본인의 소속·유효 권한·허용 조회 정의·인증 세대에 따른 접근 기준. 전체 정책 감사용 `policy_revision`과 구분한다. |

### Markdown의 내용과 메타데이터

관리 문서는 Front Matter와 본문을 한 파일에 보관한다. 메타데이터는 `schema_version`, `document_id`, `title`, `tags`와 선택적인 `source`, `description`으로 구성한다. 원본에서 만든 문서의 `source`에는 변환에 사용한 원본의 ID와 판본을 기록한다.

`title`, `tags`, `description`은 편집할 수 있다. 문서 ID와 원본 연결은 서버가 생성·검증한다. 작성자·권한·검토 상태·작업 진행 상태는 서버 기록으로 관리한다. 사용자가 편집할 수 있는 문서 메타데이터만으로 작성 신원을 판정하지 않는다.

분석 근거는 본문에서 찾는다. 근거 줄 번호와 앵커는 전체 파일의 1부터 시작하는 좌표를 사용하며, `body_start_line`으로 본문 시작 위치를 알 수 있다. 메타데이터가 없는 문서도 원문 그대로 읽을 수 있다.

현재 그래프는 근거 `source_revision`과 현재 문서 revision이 일치해야 한다. 서로 다르면 `stale`과 재추출 필요 상태를 반환한다. 문서가 바뀌었다는 이유로 옛 그래프나 전문가 판단을 새 본문에 자동 적용하지 않는다.

## 4. 파일 저장 구조

```text
data/<workspaceId>/
  wiki/<문서상대경로>
  _history/<문서상대경로>/
    <시각>-<고유값>.md
    changes.json
  _sources/<sourceId>/
    catalog.json
    versions/<versionId>/
      original
      manifest.json
  _knowledge/
    graphs/<documentId>.json
    reviews/<documentId>.json
    correspondences/<id>.json
  _personal/<userId>/
    analysis/<jobId>/
    conversations/
    question-runs/
    saved-results/
    result-drafts/
    comparisons/
    knowledge-comparisons/
    _requests/
```

위 구조는 자료별 대표 위치다. 문서 상대 경로는 `.md` 확장자를 포함한다. 잠금·입력·저장 확인에 필요한 내부 파일도 저장 상태의 일부다. 원본 판본은 불변으로 보관하며, `wiki/`에는 현재 편집 문서를, `_history/`에는 수정 전 전체 파일을 보관한다. `_knowledge/`는 문서에서 파생된 지식과 사람의 판단, `_personal/`은 사용자별 작업과 결과를 맡는다.

접근 정책과 보호된 인증정보는 자료 루트 밖 `.local/tenancy/`에 둔다. 규약 저장소와 허용 정책도 별도 설정으로 지정한다. 개인 PC에는 연결 설정, AI 실행 환경, 보호된 작업 파일과 세션 참조가 있으며 중앙 문서 저장소와 책임을 구분한다.

저장 경로는 검증된 식별자와 상대 문서 경로로 만든다. 자료 루트 밖 경로, 경로 순회, 심볼릭 링크를 통한 접근을 거부한다. 동일 자료가 둘 이상의 저장 위치에 발견되면 임의 합치기나 덮어쓰기를 수행하지 않고 충돌을 드러낸다.

## 5. 저장과 동시성 계약

문서 변경은 `WikiStore.read()`로 받은 본문과 revision을 기준으로 `WikiStore.save(expected_revision=...)`에 제출한다. 수정 전 전체 파일 보존과 기준 판본 검사를 통과해야 현재 파일을 교체한다. 신규 문서에만 `expected_revision=None`을 사용한다.

파일 단위 원자 공개와 업무별 영수증을 사용하므로 본문 저장·그래프 저장·지식 대조는 부분 성공할 수 있다. 각 단계의 결과를 확인하며 후속 실패 때문에 성공한 쓰기를 반복하지 않는다.

- 저장 결과·충돌·잠금·정리 경고·작성 원장 계약: [문서 공개 구현 계약](../domains/documents/PLAN.md#공개-구현-계약).
- 문서당 크기 한도는 없으며 전송·응답·AI 입력 한도는 별개이다: [D-141](../domains/documents/DECISIONS.md#d-141--문서당-크기-한도-없애기-2026-11-20).
- 사용자에게 표시할 실패·미확인·부분 완료와 다음 행동: [공통 처리 흐름](FLOWS.md#11-실패와-부분-완료의-공통-처리).

## 6. 사용자와 권한

서버가 인증 사용자·작업 공간·행동 권한·개인 자료 소유권을 검사한다. AI 출력이나 위키 내용은 권한 부여 지시가 아니다. 이름 가입·로그인과 공간 배정은 별개이며 신규 사용자는 배정 전 업무 자료에 접근할 수 없다.

앱은 연결 인증정보를 OS 보호 저장으로 보관하고 재시작 시 접근 기준을 확인한다. 로그아웃은 현재 PC의 활성 연결과 자동 복원을 해제한다. API/MCP의 `profile`은 조회 방식이며 접근 권한을 대신하지 않는다.

인증 예외 경로·토큰·가입 한도·복구는 [인증 공개 계약](../domains/access/PLAN.md#공개-구현-계약), tenant/profile·권한 경계는 [접근 규칙](../domains/access/RULES.md)을 따른다. 행동별 권한 정의는 [D-026](../domains/access/DECISIONS.md#d-026--사용자-권한과-관점-프로필을-분리한-tenant-모드-2026-10-22-4-a)에서 관리한다.

## 7. 실행과 검증 범위

앱·서버·개인 CLI의 구현, 배포, 실제 모델·기기 검증을 구분한다. 실행 명령은 [README](../../README.md), 지원 환경·배포·남은 기기 검증은 [플랫폼 계획](../domains/platform/PLAN.md), 제공자별 분석 검증은 [분석 계획](../domains/analysis/PLAN.md)에서 확인한다.

## 8. 상세 계약과 구현 위치

- [서버 조립](../../core/runtime/application.py) · [HTTP 라우터](../../core/api/router.py) · [MCP tenant 서버](../../core/mcp/tenant.py)
- [공통 저장 경로](../../core/common/storage_layout.py) · [문서 저장](../../core/modules/documents/store.py) · [문서 메타데이터](../../core/modules/documents/metadata.py)
- [원본 저장](../../core/modules/sources/store.py) · [그래프 저장 위치](../../core/modules/ontology/storage.py) · [그래프 현재성](../../core/modules/ontology/snapshots.py)
- [개인 기록 저장](../../core/modules/personal/store.py) · [고정 분석 기준](../../core/modules/analysis_inputs/basis.py)
- [인증 정책](../../core/modules/access/policy.py) · [인증 서비스](../../core/modules/access/auth.py) · [접근 규칙](../domains/access/RULES.md)
- [문서 계약](../domains/documents/DECISIONS.md) · [원본 계약](../domains/sources/DECISIONS.md) · [분석 계약](../domains/analysis/DECISIONS.md)
