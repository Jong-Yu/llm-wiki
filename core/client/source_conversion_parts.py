"""큰 변환 보고를 기존 단위 경계로 전송하고 확정된 전체 manifest만 완료로 인정한다."""
from hashlib import sha256
import json
import re

import httpx2

from core.client.transport import AnalysisClientError

PART_TEXT_BYTES = 4 * 1024 * 1024
PART_TRANSPORT_BYTES = 6 * 1024 * 1024
PART_MAX_UNITS = 1000


class ReportRejected(AnalysisClientError):
    """서버가 쓰기를 거부한 경우와 실제 저장 결과를 모르는 경우를 구분한다."""


def _wire_bytes(value):
    return len(json.dumps(value, ensure_ascii=False).encode('utf-8'))


def _over_budget(count, text_bytes, transport_bytes):
    return (count > PART_MAX_UNITS or text_bytes > PART_TEXT_BYTES
            or transport_bytes > PART_TRANSPORT_BYTES)


def needs_parts(body):
    """최초 제출과 저장 재개가 같은 보고의 UTF-8·JSON 전송 예산을 사용한다."""
    return _over_budget(len(body['units']),
        sum(len(unit['content'].encode('utf-8')) for unit in body['units']), _wire_bytes(body))


def parts(body):
    """원본 단위의 문자·위치·순서를 바꾸지 않고 전송 묶음만 나눈다."""
    result, current, total, transport = [], [], 0, 0
    for unit in body['units']:
        size = len(unit['content'].encode('utf-8'))
        wire = _wire_bytes(unit)
        if _over_budget(1, size, wire):
            raise ReportRejected('conversion_unit_transport_limit')
        if current and _over_budget(len(current) + 1, total + size, transport + wire):
            result.append(current)
            current, total, transport = [], 0, 0
        current.append(unit)
        total += size
        transport += wire
    if current:
        result.append(current)
    if not 1 <= len(result) <= 64:
        raise ReportRejected('conversion_part_limit')
    return result


def _id(kind, tenant, user, request):
    return sha256(f'{kind}:{tenant}:{user}:{request}'.encode()).hexdigest()[:32]


def _part_receipt(value, body, part_id):
    """저장된 본문·출처·순서까지 대조해 다른 응답을 현재 부분 영수증으로 쓰지 않는다."""
    manifest = value.get('manifest', {})
    if (manifest.get('id') != part_id or manifest.get('kind') != 'conversion_parts'
            or any(manifest.get(key) != body[key] for key in
                   ('request_id', 'conversion_request_id', 'part_index', 'source_ref', 'method', 'complete', 'warnings', 'unread_ranges'))
            or manifest.get('units') != [{key: val for key, val in unit.items() if key != 'content'} for unit in body['units']]
            or value.get('components') != {unit['unit_id']: unit['content'] for unit in body['units']}
            or re.fullmatch(r'[a-f0-9]{64}', value.get('revision', '')) is None):
        raise AnalysisClientError('conversion_part_receipt_mismatch')
    return {'part_id': part_id, 'part_revision': value['revision']}


async def _write_then_read(http, post, get, body, check):
    """기존 영수증을 먼저 읽고 없을 때 한 번 보내며 응답 유실 뒤에는 조회만 한다."""
    existing = await http.get(get)
    if existing.status_code == 200:
        return check(existing.json()['data'])
    if existing.status_code != 404:
        raise AnalysisClientError('report_save_unconfirmed')
    try:
        response = await http.post(post, json=body)
        if response.status_code in {200, 201}:
            return check(response.json()['data'])
        if response.status_code < 500:
            code = response.json().get('error', {}).get('code', 'report_rejected')
            raise ReportRejected(code if isinstance(code, str) and re.fullmatch(r'[a-z0-9_]{1,80}', code) else 'report_rejected')
    except httpx2.HTTPError:
        pass
    response = await http.get(get)
    if response.status_code == 200:
        return check(response.json()['data'])
    raise AnalysisClientError('report_save_unconfirmed')


async def submit(http, base, query, body, user, emit):
    """부분 저장은 남기되 모든 참조를 확정하기 전에는 전체 변환 저장으로 표시하지 않는다."""
    tenant = base.rsplit('/', 1)[-1]
    conversion_id = _id('conversions', tenant, user, body['request_id'])
    try:
        selected = parts(body)
        # 첫 부분의 응답이 오기 전에 종료되어도 main이 저장 시도를 같은 요청으로 복구한다.
        emit('submit', completed=0, total=len(selected) + 1)
        references = []
        for index, units in enumerate(selected):
            request_id = sha256(f"conversion-part:{body['request_id']}:{index}".encode()).hexdigest()[:32]
            value = {**body, 'request_id': request_id, 'conversion_request_id': body['request_id'],
                     'part_index': index, 'units': units}
            part_id = _id('conversion_parts', tenant, user, request_id)
            reference = await _write_then_read(http, base + '/analysis-conversion-parts',
                base + '/analysis-conversion-parts/' + part_id + query, value,
                lambda result: _part_receipt(result, value, part_id))
            references.append(reference)
            emit('submit', completed=index + 1, total=len(selected) + 1)
        final = {key: value for key, value in body.items() if key != 'units'} | {'parts': references}

        def checked(result):
            manifest = result.get('manifest', {})
            if (manifest.get('id') != conversion_id or any(manifest.get(key) != final[key] for key in
                    ('request_id', 'source_ref', 'method', 'complete', 'warnings', 'unread_ranges', 'parts'))
                    or manifest.get('unit_count') != len(body['units'])
                    or manifest.get('text_bytes') != sum(len(unit['content'].encode()) for unit in body['units'])
                    or re.fullmatch(r'[a-f0-9]{64}', result.get('revision', '')) is None):
                raise AnalysisClientError('conversion_receipt_mismatch')
            return {'state': 'saved', 'conversion_ref': {'conversion_id': conversion_id,
                    'conversion_revision': result['revision']}, 'revision': result['revision'],
                    'manifest': manifest, 'replayed': result.get('replayed', False)}

        receipt = await _write_then_read(http, base + '/analysis-conversions/complete-parts',
            base + '/analysis-conversions/' + conversion_id + query, final, checked)
        emit('submit', completed=len(selected) + 1, total=len(selected) + 1)
        return receipt
    except ReportRejected as error:
        return {'state': 'rejected', 'conversion_id': conversion_id, 'error': {'code': error.code}}
    except (httpx2.HTTPError, KeyError, ValueError, AnalysisClientError):
        return {'state': 'unconfirmed', 'conversion_id': conversion_id,
                'error': {'code': 'report_save_unconfirmed'}}
