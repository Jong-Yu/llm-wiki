# 문서 간 대응 계획

## 현재 상태

2026-10-28 신규 _knowledge/correspondences 저장과 기존 _reviews/correspondences의 호환 읽기·갱신·발견을 구현했습니다. 의미/업무 판단 스키마는 유지하며 공통 격리 계약 검사 26개가 통과했습니다.

## 공개 구현 계약

- 신규 대응은 `knowledge_root(root, "correspondences")/<id>.json`에 저장합니다. 기존 _reviews/correspondences/<id>.json은 같은 위치에서 갱신하며 새/옛 동시 존재는 KnowledgeStorageConflict로 중단합니다. 공개 CorrespondenceStore 함수와 대응 ID/이벤트/판단/참조를 유지합니다.
- find·개념 탐색·tenant 집계는 양쪽 경로를 발견하고 누락/충돌을 숨기지 않습니다. 원문·그래프·검토·실제 의존 closure의 CAS와 prepare·원자 공개·되돌림 절차를 유지합니다.
- 새 actor의 access_revision을 준비/상태 token의 접근 기준으로 사용하고, 없는 과거 actor는 policy_revision으로 호환합니다. 과거 actor와 hash는 재작성하지 않습니다.
- Front Matter 문서의 인용 근거는 body이며 줄 번호/원문 SHA는 전체파일 기준입니다. 옛 revision의 anchor는 새 문서 revision으로 제출값을 바꾸는 것만으로 유효해지지 않습니다.

## 남은 검증

전체 API/MCP·사용자 화면 통합과 실제 업무 대응 판단은 별도 통합 범위입니다. 운영 자료/원장 이관은 하지 않았습니다.

## 완료 조건과 근거

새/옛 경로 저장·발견·append, 중복 경로 충돌 보존, source/access 변경 CAS, 저장 실패 보존과 성공 후 정리 경고 분리를 격리 자료에서 확인했습니다.

[적용 결정](DECISIONS.md) · [검증 기록](HISTORY.md)
