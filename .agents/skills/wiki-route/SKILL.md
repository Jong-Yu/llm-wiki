---
name: wiki-route
description: LLM Wiki 요청을 조회·작성·추출·검토·진단 조각으로 나누고 조각마다 MCP 도구 묶음(toolset)과 스킬을 고른다. 여러 업무가 섞인 요청, 긴 작업, 토큰을 아껴야 하는 작업에 먼저 사용한다.
---

# Wiki 업무 조각 나누기

요청 전체를 한 연결에서 처리하지 않는다. 조각마다 필요한 도구만 실은 연결과 해당 스킬 하나만 사용한다.

## 조각과 연결

| 조각 | toolset | 스킬 | 범위 |
| --- | --- | --- | --- |
| 질문 답변·값 조회·탐색 | `ask` | [wiki-query](../wiki-query/SKILL.md) | 읽기 전용. `wiki_read`는 본문 보기(`view=body`)가 기본이다. |
| 본문 작성·산출물 저장·판본 비교/복원 | `write` | [wiki-edit](../wiki-edit/SKILL.md) | 위키 본문과 이력 |
| 원본 등록·분석 작업·온톨로지 추출 | `extract` | [wiki-analyze](../wiki-analyze/SKILL.md) | 작업·입력·결과 |
| 검토·전문가 정책·관계·문서 대응·Clean Up | `review` | [wiki-review](../wiki-review/SKILL.md) | 판단 기록과 되돌림 |
| 연결·권한·실행 준비 진단 | 어느 묶음이든 | [wiki-diagnose](../wiki-diagnose/SKILL.md) | `access_context`와 로컬 진단 |

- 연결 방법: stdio는 `--toolset <이름>`(개인 launcher 포함), HTTP는 `/mcp?toolset=<이름>`. 기본 `all`은 전체 도구다.
- 묶음은 노출 범위일 뿐 권한이 아니다. 묶음 밖 도구가 필요하면 그 조각의 연결이나 하위 에이전트로 넘기고, 권한 거부를 다른 설정으로 우회하지 않는다.

## 복합 요청

- 조각 단위 단계로 나누어 실제 의존 순서대로 실행한다. 예: 조회(`ask`) → 본문 작성(`write`) → 영향 확인(`ask`).
- 조각 사이에는 결과 전문 대신 식별자와 짧은 결론만 넘긴다: 문서 경로·`revision`·`history_id`·`claim_id`·`state_revision`·`job_id`·`event_id`. 다음 조각은 필요한 것만 직접 다시 읽는다.
- 하위 에이전트를 쓸 수 있으면 조각마다 해당 toolset 연결과 그 스킬만 준다. 조각 하나로 끝나는 작은 요청은 나누지 않는다.
- 각 조각의 저장·경고·미실행은 따로 보고하며 뒤 조각의 실패로 앞 조각의 저장을 다시 시도하지 않는다.

## 적은 토큰으로 충분한 도구

- 좁은 조회부터: `wiki_search` 스니펫으로 대상 선택 → 필요한 문서만 읽기 → 인용할 문서만 검토 맥락(`knowledge_context_prepare`/`ontology_review_query`) 준비.
- 용어 하나는 그래프 전체 대신 `ontology_concept_find`·`ontology_glossary_query`를 쓴다.
- 같은 세션에서 revision이 같은 결과는 다시 읽지 않는다. 목록은 `next_cursor`로 필요한 페이지까지만 읽고 `truncated`/`skipped`를 밝힌다.
- 저장·검토 응답은 compact다. 전체 스냅샷은 `detail_query`가 필요할 때만 따른다.
- 판단이 필요 없는 반복(페이지 넘김, 정해진 목록 수집)은 처음 정한 범위로 이어서 처리하고 단계마다 계획을 다시 세우지 않는다.
