"""원보고와 구분해 보정 문자를 보존하고 승인 당시 참조만 입력에 적용한다."""
from hashlib import sha256
import re

from core.common.json_codec import canonical_json_hash

from core.modules.analysis_jobs.contracts import JobValidationError, identifier, revision
from core.modules.analysis_inputs.contracts import InputCorruptError, InputLimitError

MAX_TEXT_BYTES = 4 * 1024 * 1024
MAX_EFFECTIVE_TEXT_BYTES = 20 * 1024 * 1024
SOURCE_KEYS = ('source_id', 'source_version', 'source_sha256', 'registration_revision')
TARGET_FIELDS = ('page', 'unit_id', 'whole_document')
PAGE_RANGE = re.compile(r'^page ([1-9][0-9]*): (.+)$')
LOW = 'ocr_low_or_missing_confidence_text_retained_manual_review_required'
BLOCKED = re.compile(r'checkpoint|encrypted|password|corrupt|dependency_missing|language_load|'
                     r'engine_failed|conversion_cancelled|conversion_.*failed|worker|memory|resources|'
                     r'timeout|(?:^|_)limit(?:_|$)|not_selected_for_page_ocr')


def target(value):
    """기존 page 계약과 일반 위치 계약을 같은 불변 대상으로 정규화한다."""
    if hasattr(value, 'model_dump'):
        value = value.model_dump()
    selected = {key: value[key] for key in TARGET_FIELDS if value.get(key) is not None}
    if len(selected) != 1:
        raise JobValidationError('Exactly one content target is required.')
    if 'page' in selected and (type(selected['page']) is not int or not 1 <= selected['page'] <= 1000000):
        raise JobValidationError('A bounded page number is required.')
    if 'unit_id' in selected and (not isinstance(selected['unit_id'], str)
            or re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', selected['unit_id']) is None):
        raise JobValidationError('A preserved conversion unit is required.')
    if 'whole_document' in selected and selected['whole_document'] is not True:
        raise JobValidationError('Whole-document input must be explicit.')
    return selected


def target_key(value):
    value = target(value)
    return ('page:' + str(value['page']) if 'page' in value else
            'unit:' + value['unit_id'] if 'unit_id' in value else 'whole_document')


def review_targets(manifest, components):
    """보관된 보고의 입력 부족을 연결하며 실행/파일 오류는 명시 전체 대체만 허용한다."""
    if manifest.get('complete'):
        return []
    unread = manifest.get('unread_ranges', [])
    if any(BLOCKED.search(item.split(': ', 1)[-1]) for item in unread):
        # 실패로 사라진 범위를 페이지 경고나 남은 단위 수로 추정하지 않는다.
        # 사용자가 전체 본문을 직접 제공하기 전에는 usable 표시로 진행할 수 없다.
        return [dict(whole_document=True)]
    result = {}
    for item in unread:
        match = PAGE_RANGE.fullmatch(item)
        selected = dict(page=int(match[1])) if match and int(match[1]) <= 1000000 else dict(whole_document=True)
        result[target_key(selected)] = selected
    return list(result.values()) or [dict(whole_document=True)]


def unit_target(unit):
    location = unit['location']
    if location.get('kind') == 'pages' and location.get('start') == location.get('end'):
        return dict(page=location['start'])
    return dict(unit_id=unit['unit_id'])


def binding(report, selected, *, allow_page_unit=False):
    """새 위치를 추정하지 않고 실제 단위 또는 원보고의 명시 누락 위치에만 연결한다."""
    selected = target(selected)
    manifest, parts = report['manifest'], report['components']
    if 'whole_document' in selected:
        return dict(unit_id=None, original_unit_sha256=canonical_json_hash(parts), location=dict(kind='whole'))
    if 'unit_id' in selected:
        matches = [unit for unit in manifest['units'] if unit['unit_id'] == selected['unit_id']]
        # 단일 페이지 단위는 page 계약 하나로만 식별해 중복 수정 선택을 막는다.
        if matches and 'page' in unit_target(matches[0]) and not allow_page_unit:
            raise JobValidationError('A single PDF page must use its page target.')
    else:
        page = selected['page']
        matches = [unit for unit in manifest['units'] if unit['location'].get('kind') == 'pages'
                   and unit['location'].get('start') == page and unit['location'].get('end') == page]
    if len(matches) == 1 and matches[0]['unit_id'] in parts:
        unit = matches[0]
        return dict(unit_id=unit['unit_id'], original_unit_sha256=sha256(parts[unit['unit_id']].encode()).hexdigest(),
                    location=unit['location'])
    declared = {target_key(item) for item in review_targets(manifest, parts)}
    if not matches and 'page' in selected and target_key(selected) in declared:
        page = selected['page']
        if any(unit['location'].get('kind') == 'pages' and unit['location']['start'] <= page <= unit['location']['end']
               for unit in manifest['units']):
            raise JobValidationError('The page overlaps an existing multi-page conversion unit.')
        return dict(unit_id=None, original_unit_sha256=None, location=dict(kind='pages', start=page, end=page))
    raise JobValidationError('The target is absent from the preserved conversion and its explicit missing locations.')


def selection_revision(items):
    return canonical_json_hash(sorted([dict(**target(item), correction_ref=item['correction_ref'])
        for item in items if item.get('correction_ref')], key=target_key))


def needs_input(report, selected):
    """문자가 없거나 실제 누락인 위치는 usable 표시만으로 해결되지 않는다."""
    selected = target(selected)
    if selected.get('whole_document'):
        return not report['manifest']['complete']
    try:
        bound = binding(report, selected)
    except JobValidationError:
        return True
    if bound['unit_id'] is None or not report['components'][bound['unit_id']].strip():
        return True
    if 'page' in selected:
        prefix = 'page ' + str(selected['page']) + ': '
        return any(item.startswith(prefix) and item != prefix + LOW for item in report['manifest']['unread_ranges'])
    return False


def validate_reference(value):
    """입력 출처로 사용할 완전한 불변 참조만 받는다."""
    if type(value) is not dict or set(value) != {'correction_id', 'correction_revision'}:
        raise JobValidationError('A complete page correction reference is required.')
    identifier(value['correction_id']); revision(value['correction_revision'])


def unit_at(manifest, components, page):
    """한 쪽에 정확히 하나로 연결된 원래 변환 단위만 보정한다."""
    matches = [unit for unit in manifest['units'] if unit['location'].get('kind') == 'pages'
               and unit['location'].get('start') == page and unit['location'].get('end') == page]
    if len(matches) != 1 or matches[0]['unit_id'] not in components:
        raise JobValidationError('The page must identify exactly one preserved conversion unit.')
    return matches[0]


def validate_content(content, method, selected, bound):
    if (not isinstance(content, str) or '\0' in content or len(content.encode()) > MAX_TEXT_BYTES
            or method not in ('manual', 'ocr', 'blank')):
        raise JobValidationError('A bounded user content selection is required.')
    if method == 'blank':
        if content != '' or 'whole_document' in selected or bound['location']['kind'] not in ('pages', 'slides'):
            raise JobValidationError('Only an explicitly confirmed physical page or slide may be blank.')
    elif not content.strip():
        raise JobValidationError('Empty text requires an explicit blank-page confirmation.')


def publish(plans, workflow, report, body, authorize, now):
    """동일 요청의 공개된 묶음은 재사용하며 기존 변환 보고의 최신 포인터는 바꾸지 않는다."""
    selected = target(body)
    bound = binding(report, selected)
    validate_content(body.content, body.method, selected, bound)
    payload = dict(workflow_id=workflow['workflow_id'], profile_id=plans.actor['profile_id'],
                   **{key: value for key, value in body.model_dump(exclude={'profile'}).items()
                      if key not in TARGET_FIELDS or value is not None})
    manifest = dict(workflow_id=workflow['workflow_id'], source_ref=workflow['source_ref'],
        conversion_ref=workflow['conversion_ref'], target=selected, **bound,
        method=body.method, warnings=list(body.warnings), content_sha256=sha256(body.content.encode()).hexdigest(),
        created_at=now, origin='client_reported' if body.method == 'ocr' else 'user_entered')
    return plans._publish_locked('corrections', body.request_id, payload, manifest, {'text': body.content}, authorize)


def load(plans, reference, *, workflow_id, source_ref, conversion_ref, report, page=None, selected_target=None):
    """보정 본문·소유 관점·원보고 위치/hash를 함께 확인한다. 구 page 보정도 그대로 읽는다."""
    validate_reference(reference)
    selected = target(selected_target if selected_target is not None else dict(page=page))
    manifest, actual, components = plans._load_locked('corrections',
        reference['correction_id'], reference['correction_revision'])
    bound = binding(report, selected)
    content = components.get('text')
    actor = manifest.get('actor') or {}
    stored_target = manifest.get('target', dict(page=manifest.get('page')))
    try:
        validate_content(content, manifest.get('method'), selected, bound)
    except JobValidationError as error:
        raise InputCorruptError('The stored correction content is invalid.') from error
    if (set(components) != {'text'} or manifest.get('workflow_id') != workflow_id
            or manifest.get('source_ref') != source_ref or manifest.get('conversion_ref') != conversion_ref
            or stored_target != selected or manifest.get('unit_id') != bound['unit_id']
            or manifest.get('original_unit_sha256') != bound['original_unit_sha256']
            or ('location' in manifest and manifest['location'] != bound['location'])
            or manifest.get('content_sha256') != sha256(content.encode()).hexdigest()
            or any(actor.get(key) != plans.actor[key] for key in ('tenant', 'user_id', 'profile_id'))):
        raise InputCorruptError('The correction differs from its fixed source or scope.')
    warnings = manifest.get('warnings')
    if (not isinstance(warnings, list) or len(warnings) > 100
            or any(not isinstance(item, str) or len(item) > 1024 for item in warnings)):
        raise InputCorruptError('The correction diagnostics are invalid.')
    from core.modules.analysis_jobs.contracts import instant
    instant(manifest.get('created_at'))
    identifier(manifest.get('request_id'))
    return dict(correction_ref=dict(reference), **selected, content=content, request_id=manifest['request_id'],
                method=manifest['method'], warnings=warnings, created_at=manifest['created_at'])


def selected(plans, workflow, report):
    """현재 선택된 참조만 읽으며 이전 보정 묶음은 그대로 보존한다."""
    return [load(plans, item['correction_ref'], workflow_id=workflow['workflow_id'],
        source_ref=workflow['source_ref'], conversion_ref=workflow['conversion_ref'],
        selected_target=target(item), report=report) for item in workflow['pages'] if item.get('correction_ref')]


def effective_units(report, corrections):
    """원보고와 별도인 유효 입력을 만든다. 누락 위치만 추가하고 전체 대체 선택은 우선한다."""
    parts = dict(report['components'])
    units = [dict(unit) for unit in report['manifest']['units']]
    seen = set()
    whole = None
    for correction in corrections:
        selected = target(correction)
        key = target_key(selected)
        if key in seen:
            raise JobValidationError('A corrected target must not be repeated.')
        seen.add(key)
        bound = binding(report, selected)
        validate_content(correction['content'], correction['method'], selected, bound)
        if 'whole_document' in selected:
            whole = correction
            continue
        unit_id = bound['unit_id']
        if unit_id is None:
            # 이 ID는 서버가 확인한 누락 페이지의 사용자 입력에만 붙이며 원보고에는 추가하지 않는다.
            unit_id = 'user_page_' + str(selected['page'])
            if unit_id in parts:
                raise JobValidationError('The user-entered page identifier overlaps a preserved unit.')
            units.append(dict(unit_id=unit_id, location=bound['location']))
        parts[unit_id] = correction['content']
    if whole is not None:
        units = [dict(unit_id='user_whole_document', location=dict(kind='whole'))]
        parts = dict(user_whole_document=whole['content'])
    elif units and all(unit['location']['kind'] == 'pages' for unit in units):
        units.sort(key=lambda unit: (unit['location']['start'], unit['location']['end']))
    if sum(len(text.encode()) for text in parts.values()) > MAX_EFFECTIVE_TEXT_BYTES:
        raise InputLimitError('The corrected conversion text exceeds its complete byte limit.')
    return units, parts


def effective_parts(report, corrections):
    return effective_units(report, corrections)[1]


def resolution(report, corrections):
    """원래 경고를 지우지 않고 사용자가 실제로 보완한 범위만 별도 근거로 기록한다."""
    targets = {target_key(item) for item in corrections}
    resolved, remaining = [], []
    for value in report['manifest']['unread_ranges']:
        match = PAGE_RANGE.fullmatch(value)
        key = 'page:' + match[1] if match else None
        destination = resolved if 'whole_document' in targets or key in targets else remaining
        destination.append(value)
    complete = bool(report['manifest']['complete'] or ('whole_document' in targets) or
                    (report['manifest']['unread_ranges'] and not remaining))
    return dict(complete=complete, resolved_ranges=resolved, remaining_ranges=remaining)
