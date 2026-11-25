"""기존 크기 경계의 불변 부분 보고를 검증해 하나의 원본 변환으로 읽는다."""
from copy import deepcopy

from core.common.json_codec import canonical_json_hash
from core.modules.analysis_inputs.contracts import InputCorruptError, InputLimitError
from .contracts import CompletePartsCommand

MAX_CONVERSION_TEXT_BYTES = 20 * 1024 * 1024
MAX_CONVERSION_UNITS = 10000


def resolve(plans, manifest):
    """순서·소유·원본·요청·부분 hash를 모두 대조하며 누락된 조각은 성공으로 합치지 않는다."""
    references = manifest.get('parts')
    if (type(references) is not list or not 1 <= len(references) <= 64
            or any(type(item) is not dict for item in references)
            or len({item.get('part_id') for item in references}) != len(references)):
        raise InputCorruptError('The conversion part manifest is invalid.')
    units, components, locations, total = [], {}, set(), 0
    for index, reference in enumerate(references):
        if type(reference) is not dict or set(reference) != {'part_id', 'part_revision'}:
            raise InputCorruptError('The conversion part reference is invalid.')
        part, _, values = plans._load_locked('conversion_parts', reference['part_id'], reference['part_revision'])
        if (part.get('conversion_request_id') != manifest['request_id'] or part.get('part_index') != index
                or any(part.get(key) != manifest[key] for key in
                       ('source_ref', 'method', 'complete', 'unread_ranges', 'warnings'))):
            raise InputCorruptError('A conversion part belongs to a different report or order.')
        for unit in part['units']:
            key = unit['unit_id']
            location = canonical_json_hash(unit['location'])
            if key in components or location in locations or key not in values:
                raise InputCorruptError('Conversion parts repeat or omit original units.')
            total += len(values[key].encode('utf-8'))
            if total > MAX_CONVERSION_TEXT_BYTES or len(units) >= MAX_CONVERSION_UNITS:
                raise InputLimitError('The complete conversion exceeds its processing budget.')
            units.append(unit)
            components[key] = values[key]
            locations.add(location)
        if set(values) != {unit['unit_id'] for unit in part['units']}:
            raise InputCorruptError('A conversion part contains unbound text.')
    if manifest.get('unit_count', len(units)) != len(units) or manifest.get('text_bytes', total) != total:
        raise InputCorruptError('The conversion totals differ from its parts.')
    # revision은 저장한 부분 참조 manifest의 hash다. 아래 units는 검증한 조회용 합성 값이다.
    return {**manifest, 'units': units, 'unit_count': len(units), 'text_bytes': total}, components


def complete(plans, body: CompletePartsCommand, authorize):
    """전체 부분이 확인돼야 최초 보고 head와 알림을 게시하며 기존 부분은 그대로 보존한다."""
    value = deepcopy(body)
    if value['complete'] and value['unread_ranges']:
        raise ValueError('Unread ranges must not be marked complete')
    if any(len(text) > 1000 for text in [*value['unread_ranges'], *value['warnings']]):
        raise ValueError('Bounded warnings and unread ranges are required')
    with plans.sources._coordination_lock(create=True):
        _, _, stream = plans._original_locked(value['source_ref'])
        stream.close()
        manifest = {**value, 'origin': 'client_reported', 'coverage': 'reported_units_only',
                    'original_coverage': 'not_verified', 'semantic_validation': 'not_run'}
        resolved, _ = resolve(plans, manifest)
        manifest.update(unit_count=resolved['unit_count'], text_bytes=resolved['text_bytes'])
        result = plans._publish_locked('conversions', value['request_id'], value, manifest, {}, authorize)
        # 응답은 부분 참조만 보낸다. 전체 문자 조회가 HTTP 응답 한도를 우회하지 않는다.
        stored, revision, components = plans._load_locked('conversions', result['manifest']['id'], resolve_parts=False)
        return dict(manifest=stored, revision=revision, components=components, replayed=result['replayed'])
