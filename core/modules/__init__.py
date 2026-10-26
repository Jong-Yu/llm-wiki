"""외부 전송과 구분한 공통 업무 모듈."""
# HTTP/MCP 입구가 공통으로 사용하는 업무 처리 묶음이다. 요청/응답 형식은 api/와 mcp/가 맡는다.
# 문서 저장은 documents, 원본 보관은 sources, 분석 흐름은 analysis_*에서 시작한다.
# 그래프는 ontology, 검토/정책은 reviews, 문서 간 대응은 correspondences, 읽기 조합은 knowledge에 있다.
