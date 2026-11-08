# 구현·검증 기록

## 2026-10-28 — D-072/073/074 지식 저장 계약

새/옛 대응 경로 조회·발견·추가 이벤트, 중복 경로 충돌 보존, source/access 변경 CAS, 공개 실패 보존 및 저장 성공의 cleanup warning 분리를 확인했습니다.

- 실행: `.venv/bin/python -m unittest discover -s core/tests/poc_knowledge -q` — **26개 통과**(네 도메인을 함께 검증하는 공통 검사 수).
- 테스트는 TemporaryDirectory의 격리 자료만 사용했습니다. 실제 모델 의미 평가·실제 사람 판단·운영 서버·data/.local 쓰기는 하지 않았습니다. 전체 UI/MCP/분석 통합은 완료 범위에 포함하지 않습니다.
