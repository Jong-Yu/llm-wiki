"""사용자가 고른 이전 대조를 같은 AI 대화·최신 지식으로 새로 실행한다."""
import re
from urllib.parse import urlencode
from uuid import uuid4
import httpx2

from core.client.analysis import _identifier, _private_directory, server_url
from core.client.question import _call, _profile
from core.client.comparison import run_comparison
from core.client.transport import AnalysisClientError
from core.client.ai.observations import ObservedAdapter
from core.client.session_refs import SessionRefs, binding, registry_path


async def restart_comparison(*, base_url, tenant, token, comparison_id, request_id,
                             work_dir, adapter, provider, profile=None, http=None, session_registry=None):
    """이전 실행을 덮어쓰지 않으며 모델 제공자나 대화 ID를 임의로 교체하지 않는다."""
    base = server_url(base_url)
    _identifier(comparison_id); _identifier(request_id); _profile(profile)
    if not isinstance(tenant, str) or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) is None:
        raise AnalysisClientError("invalid_tenant")
    root = _private_directory(work_dir)

    async def execute(connection):
        prefix = base + f"/api/v1/tenants/{tenant}"
        query = "?" + urlencode({"profile": profile}) if profile else ""
        previous = await _call(connection, "GET", prefix + "/knowledge-comparisons/" + comparison_id + query)
        data = previous["record"]["data"]
        if data.get("provider") != provider:
            raise AnalysisClientError("comparison_provider_mismatch")
        session_id = data["session_id"]
        record = previous["record"]
        selected_profile = record["actor"]["profile_id"]
        if record["tenant"] != tenant or profile is not None and profile != selected_profile:
            raise AnalysisClientError("comparison_session_binding_mismatch")
        SessionRefs(registry_path(root, session_registry)).restore(adapter,
            scope=binding(server=base, tenant=tenant, user_id=record["user_id"], profile=selected_profile,
                document=data["document"], job_id=data.get("job_id")), provider=provider, session_id=session_id)
        # 서버에서 현재 권한·판본을 읽는다. 옛 결과의 버전값만 바꿔 제출하지 않는다.
        params = {"document": data["document"], "profile": selected_profile}
        current = await _call(connection, "GET", prefix + "/documents/knowledge?" + urlencode(params))
        info = await adapter.preflight()
        if info.get("provider") != provider:
            raise AnalysisClientError("comparison_provider_mismatch")
        adapter.persist_session = True
        observed = ObservedAdapter(adapter)

        async def continue_session(*, prompt, output_schema, directory):
            return await observed.run(prompt=prompt, schema=output_schema, directory=directory, session_id=session_id)

        result = await run_comparison(connection, continue_session, base_url=base, tenant=tenant, profile=selected_profile,
            document=data["document"], source_revision=current["source_revision"], graph_revision=current["graph_revision"],
            session_id=session_id, provider=provider, job_id=data.get("job_id"), request_id=request_id,
            directory=root / ("comparison-" + uuid4().hex), refresh_target=True)
        return {"event": "comparison_complete", "comparison_id": result["record"]["id"],
                "request_id": request_id, "status": result["status"], "lookup_count": result["lookup_count"],
                "usage_observations": observed.summary()}

    if http is not None:
        return await execute(http)
    async with httpx2.AsyncClient(base_url=base + "/", headers={"Authorization": "Bearer " + token},
                                 timeout=15, trust_env=False, follow_redirects=False) as connection:
        return await execute(connection)
