"""기존 원문 앵커 import의 호환 진입점; 구현은 ontology가 소유한다."""

from core.modules.ontology.anchors import endpoint_key, is_source_anchor, normalize_anchor

# 예전 import 경로를 쓰는 호출자에게 같은 함수를 다시 노출한다. 실제 구현을 복사한 파일은 아니다.
# __all__은 이 호환 모듈에서 공개할 이름의 목록이다.
__all__ = ["endpoint_key", "is_source_anchor", "normalize_anchor"]
