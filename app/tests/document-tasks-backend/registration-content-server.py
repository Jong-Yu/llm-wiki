"""문서 입력 main/API 통합 검증. 새 임시 서버와 합성 원본만 사용한다."""
from io import BytesIO
import json
from pathlib import Path
import socket
import sys
from uuid import uuid4

import uvicorn
from pypdf import PdfWriter
from core.api.dependencies import access_value
from core.api.v1.analysis_plans.schemas import CreateConversion, CreateConversionPart, CompleteConversionParts
from core.api.v1.notifications.schemas import CreateWorkflow
from core.modules.access.auth import AuthService
from core.modules.access.policy import AccessPolicy
from core.modules.analysis_plans.store import PlanStore
from core.modules.analysis_plans.conversion_parts import complete as complete_parts
from core.modules.notifications.store import LOW, NotificationStore
from core.modules.sources.store import SourceStore
from core.runtime.application import create_application
from core.tests.poc_access.fixtures import grant_test_membership_for_user
from core.tests.poc_analysis.test_presentation_conversion import package as presentation_package
from tools.initialize_server import initialize_new_server

root = Path(sys.argv[1])
if root.parent.parent != Path('/private/tmp') or not root.parent.name.startswith('wiki-document-tasks-'):
    raise RuntimeError('Only a new isolated document task test directory is allowed.')
config = initialize_new_server(root)
policy = AccessPolicy(config['access_config'], config['tenant_root'])
user = AuthService(policy).signup('격리 내용 입력 검증')
grant_test_membership_for_user(policy, user['user_id'])
scope = policy.authorize(user['token'], 'sdv-platform', 'source_write')
actor = access_value(scope)
sources = SourceStore(scope.store)
plans = PlanStore(scope.store, actor)
notifications = NotificationStore(scope.store, actor)


def fixture(name, *, units, unread, complete=False, format='pdf', multipart=False):
    stream = BytesIO()
    if format == 'pdf':
        writer = PdfWriter()
        for _ in range(3):
            writer.add_blank_page(width=300, height=300)
        writer.write(stream)
    elif format == 'pptx':
        stream.write(presentation_package(image=True))
    else:
        stream.write(b'Original synthetic text.\nSecond line.\n')
    stream.seek(0)
    staged = sources.stage(stream, kind='file', title=name, format=format, filename=name + '.' + format)
    registered = sources.commit(staged, tenant=actor['tenant'], user_id=actor['user_id'],
        request_id=uuid4().hex, authorize=lambda: actor)
    catalog = sources.get_source(registered['receipt']['source_id'])
    reference = {key: catalog['versions'][-1][key] for key in ('source_id', 'source_version', 'source_sha256')}
    reference['registration_revision'] = catalog['registration_revision']
    method = {'pdf': 'ocr', 'pptx': 'pptx_text'}.get(format, 'verbatim')
    common = dict(source_ref=reference, method=method, complete=complete,
        unread_ranges=unread, warnings=['Synthetic retained conversion warning.'])
    if multipart:
        conversion_request = uuid4().hex
        references = []
        for index, unit in enumerate(units):
            part = plans.conversion(CreateConversionPart(request_id=uuid4().hex, conversion_request_id=conversion_request,
                part_index=index, units=[unit], **common).model_dump(exclude={'profile'}), lambda: actor, part=True)
            references.append(dict(part_id=part['manifest']['id'], part_revision=part['revision']))
        report = complete_parts(plans, CompleteConversionParts(request_id=conversion_request, parts=references, **common)
                                .model_dump(exclude={'profile'}), lambda: actor)
    else:
        report = plans.conversion(CreateConversion(request_id=uuid4().hex, units=units, **common)
                                  .model_dump(exclude={'profile'}), lambda: actor)
    conversion_ref = dict(conversion_id=report['manifest']['id'], conversion_revision=report['revision'])
    if complete:
        notifications.create(CreateWorkflow(request_id=uuid4().hex, source_ref=reference,
            conversion_ref=conversion_ref, title=name, target_document=name + '.md'), lambda: actor)
    return dict(workflow_id=report['manifest']['id'], source_ref=reference, conversion_ref=conversion_ref,
                source_size_bytes=catalog['versions'][-1]['size_bytes'])


def page(number, content):
    return dict(unit_id='p' + str(number), location=dict(kind='pages', start=number, end=number), content=content)


fixtures = dict(
    partial=fixture('partial', units=[page(1, 'Existing low confidence text.'), page(3, 'Normal third page.')],
        unread=[f'page 1: {LOW}', 'page 2: no_text_detected_manual_review_required']),
    whole=fixture('whole', units=[page(1, 'Original document fragment.')], unread=['PDF: unsupported embedded content']),
    large=fixture('large', units=[page(1, '"' * (2 * 1024 * 1024))], unread=[f'page 1: {LOW}']),
    multipart=fixture('multipart', multipart=True, units=[page(1, '"' * (2 * 1024 * 1024)),
        page(2, '"' * (2 * 1024 * 1024))], unread=[f'page 1: {LOW}']),
    text=fixture('text', format='txt', complete=True, unread=[], units=[
        dict(unit_id='lines', location=dict(kind='lines', start=1, end=2), content='Original synthetic text.\nSecond line.\n')]),
    presentation=fixture('presentation', format='pptx', units=[
        dict(unit_id='slide_1', location=dict(kind='slides', start=1, end=1), content='첫 슬라이드의 보존된 본문.'),
        dict(unit_id='slide_2', location=dict(kind='slides', start=2, end=2), content='둘째 슬라이드의 보존된 본문.')],
        unread=['slide 1: picture_content_not_read']),
)
with (root / 'fixture.json').open('x', encoding='utf-8') as stream:
    json.dump(dict(token=user['token'], access=actor, fixtures=fixtures), stream)
(root / 'fixture.json').chmod(0o600)
app = create_application(policy)
sock = socket.socket()
sock.bind(('127.0.0.1', 0)); sock.listen(128)
print('READY http://127.0.0.1:' + str(sock.getsockname()[1]) + '/api/v1/', flush=True)
uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False)).run(sockets=[sock])
