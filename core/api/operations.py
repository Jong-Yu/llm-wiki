"""새 업무 API가 함께 쓰는 엄격한 본문·현재 권한·작업 수명·응답 처리다.

라우터는 URL과 요청 모델만 연결하고 operation(scope, value)에 실제 업무를
전달한다. scope는 서버가 확인한 사용자/자료 범위이며 클라이언트가 만들지 않는다.
"""

from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse
from core.api.concurrency import run_owned_thread
from core.api.dependencies import access_value, envelope
from core.api.errors import error_response
from core.api.ingress import RequestInputError, read_json_model
from core.modules.access.policy import AccessDenied

BODY_MODELS = {}


def body_schema(model):
    """수동 스트림 검사에도 OpenAPI에 실제 입력 모델을 공개한다."""
    # 다른 업무에 같은 이름의 모델이 있어도 요청 계약이 서로 덮이지 않게 한다.
    prefix = model.__module__.replace(".", "_") + "__"
    schema = model.model_json_schema(ref_template="#/components/schemas/" + prefix + "{model}")
    BODY_MODELS.update({prefix + name: value for name, value in schema.pop("$defs", {}).items()})
    BODY_MODELS[prefix + model.__name__] = schema
    return {"requestBody": {"required": True, "content": {"application/json": {
        "schema": {"$ref": f"#/components/schemas/{prefix}{model.__name__}"}}}}}


def reauthorize(request, tenant, token, permission, profile, expected=None):
    """저장 직전에도 현재 권한을 확인하며 처음 읽은 주체/관점과 섞지 않는다."""
    scope = request.app.state.policy.authorize(token, tenant, permission, profile)
    if expected is not None and access_value(scope) != access_value(expected):
        raise AccessDenied()
    return scope


async def json_operation(request, tenant, token, model, permission, operation, *, created=False):
    """인가→제한된 본문 읽기→최신 관점 인가→업무 처리 순서로 한 번 실행한다.

응답이 유실되어도 쓰기를 자동 반복하지 않는다. operation에서 저장하는 경우에는
기존 Store의 CAS와 before_commit 권한 확인을 함께 사용해야 한다.
"""
    request.app.state.policy.authorize(token, tenant, permission)
    try:
        if request.query_params:
            raise RequestInputError(422, "invalid_argument", "Put the selected profile and fields in the JSON body.")
        value = await read_json_model(request, model)
        def execute():
            scope = reauthorize(request, tenant, token, permission, getattr(value, "profile", None))
            result = operation(scope, value)
            return envelope({**result, "access": access_value(scope)})
        result = await run_owned_thread(execute)
        if created:
            status = 200 if result["data"].get("replayed") else 201
            return JSONResponse(result, status_code=status, headers={"Cache-Control": "no-store"})
        return result
    except RequestInputError as error:
        return error_response(error.status, error.code, error.message)
    except ClientDisconnect:
        return error_response(400, "request_disconnected", "The request was interrupted; inspect current state before retrying.", retry="reconcile")


def install_body_schemas(app):
    """라우터의 본문 모델을 OpenAPI components에 연결해 참조를 완성한다."""
    original = app.openapi
    def openapi():
        value = original()
        value.setdefault("components", {}).setdefault("schemas", {}).update(BODY_MODELS)
        return value
    app.openapi = openapi
