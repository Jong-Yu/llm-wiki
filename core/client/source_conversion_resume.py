"""고정한 비공개 보고만 재전송하며 이미 변환한 원본을 다시 내려받거나 OCR하지 않는다."""
from hashlib import sha256
import json
from pathlib import Path
import re
from urllib.parse import urlencode

import httpx2

from core.client.analysis import _private_directory, server_url
from core.client.transport import AnalysisClientError, api_call
from core.runtime.client_platform import read_private
from core.client.source_conversion_worker import atomic_json
from core.client.source_conversion_report import MAX_TEXT, MAX_UNITS


async def resume_report(*, base_url, tenant, token, source_ref, work_dir, request_id, profile=None,
                        report_sha256=None, on_event=None, http=None, cancel_file=None, **unused):
    """보호된 요청 범위·보고 hash·서버 현재 원본을 대조한 뒤 남은 부분만 게시한다."""
    from .source_conversion import check_ref, report_body, submit_report
    from .source_conversion_parts import needs_parts, submit as submit_parts
    check_ref(source_ref)
    if (re.fullmatch(r'[a-f0-9]{32}', request_id or '') is None
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', tenant or '') is None
            or profile is not None and re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', profile) is None):
        raise AnalysisClientError('invalid_report_resume')
    root=_private_directory(work_dir)
    candidates=[path for path in root.iterdir() if path.name.startswith('conversion-'+request_id+'-')]
    if len(candidates)!=1:
        raise AnalysisClientError('conversion_report_unavailable')
    directory=_private_directory(candidates[0])
    raw=read_private(directory/'report.json',128*1024*1024)
    body=json.loads(raw)
    owner=json.loads(read_private(directory/'report-owner.json',16384))
    conversion_path = 'attempt-conversion.json' if not body.get('units') else 'conversion.json'
    conversion=json.loads(read_private(directory/conversion_path,128*1024*1024))
    actual_hash=sha256(raw).hexdigest()
    if (owner.get('request_id')!=request_id or owner.get('source_ref')!=source_ref
            or owner.get('tenant')!=tenant or owner.get('profile_id')!=profile
            or owner.get('report_sha256')!=actual_hash or report_sha256 is not None and report_sha256!=actual_hash
            or body!=report_body(conversion,source_ref,request_id,profile)):
        raise AnalysisClientError('conversion_report_basis_changed')
    empty_attempt = (not body['units'] and not body['complete'] and body['unread_ranges']
                     and any('conversion_attempt_no_text' in value for value in body['warnings'])
                     and conversion.get('state') == 'failed')
    if (len(body['units'])>MAX_UNITS or sum(len(unit['content'].encode()) for unit in body['units'])>MAX_TEXT
            or not empty_attempt and (not body['units'] or conversion.get('state') not in {'complete','partial'})):
        raise AnalysisClientError('conversion_report_unavailable')
    base=server_url(base_url)+f'/api/v1/tenants/{tenant}'
    query='?'+urlencode({'profile':profile}) if profile else ''
    owned=http is None
    if owned:
        http=httpx2.AsyncClient(headers={'Authorization':'Bearer '+token},timeout=15,trust_env=False,follow_redirects=False)
    def emit(stage,**values):
        if cancel_file is not None and Path(cancel_file).exists():
            raise AnalysisClientError('conversion_cancelled')
        if on_event:on_event(dict(schema_version=1,type='progress',request_id=request_id,stage=stage,**values))
    try:
        emit('submit',completed=0)
        catalog=await api_call(http,'GET',base+'/sources/'+source_ref['source_id']+query)
        current=next((version for version in catalog['versions'] if version['source_version']==source_ref['source_version']),None)
        if (catalog.get('current_version')!=source_ref['source_version'] or catalog.get('registration_revision')!=source_ref['registration_revision']
                or not current or current['source_sha256']!=source_ref['source_sha256']
                or catalog['access']['user_id']!=owner['user_id']):
            raise AnalysisClientError('source_basis_changed')
        if needs_parts(body):
            receipt=await submit_parts(http,base,query,body,owner['user_id'],emit)
        else:
            # 단일 보고도 기존 요청을 먼저 확인한다. 없을 때만 같은 원문으로 한 번 전송한다.
            conversion_id=sha256(f"conversions:{tenant}:{owner['user_id']}:{request_id}".encode()).hexdigest()[:32]
            existing=await http.get(base+'/analysis-conversions/'+conversion_id+query)
            if existing.status_code==200:
                from .source_conversion import checked_receipt
                receipt=checked_receipt(existing.json()['data'],body,conversion_id)
            elif existing.status_code==404:
                receipt=await submit_report(http,base,query,body,owner['user_id'],emit)
            else:
                receipt=dict(state='unconfirmed',error=dict(code='report_save_unconfirmed'))
        result=dict(schema_version=1,request_id=request_id,source_ref=source_ref,format=current['format'],
            conversion=conversion,receipt=receipt,report_sha256=actual_hash,
            state='report_unconfirmed' if receipt['state']=='unconfirmed' else conversion['state'],
            ok=receipt['state']=='saved' and conversion['state'] in {'complete','partial'})
        atomic_json(directory/'resume-result.json',result)
        return result
    finally:
        if owned:await http.aclose()
