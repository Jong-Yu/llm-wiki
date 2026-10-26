# 각 업무 라우터를 /api/v1 아래에 연결한다. tenant를 쓰는 URL에만 공통 tenant 경로를 붙인다.
# 여기서는 저장 업무를 처리하지 않고, 실제 처리는 v1/<업무>/router.py로 넘긴다.

"""구현된 v1 업무별 조회·변경 라우터를 같은 인증 서버에 결합한다."""

from fastapi import APIRouter
from core.api.v1.access.router import router as access
from core.api.v1.documents.router import router as documents
from core.api.v1.knowledge.router import router as knowledge
from core.api.v1.sources.router import router as sources
from core.api.v1.analysis_jobs.router import router as analysis_jobs
from core.api.v1.reviews.router import router as reviews
from core.api.v1.correspondences.router import router as correspondences
from core.api.v1.extractions.router import router as extractions
from core.api.v1.personal.router import router as personal
from core.api.v1.personal.workflows_router import router as personal_workflows
from core.api.v1.analysis_plans.router import router as analysis_plans
from core.api.v1.analysis_proposals.router import router as analysis_proposals
from core.api.schemas import ErrorEnvelope

router = APIRouter(prefix="/api/v1", responses={
    code: {"model": ErrorEnvelope} for code in (400, 401, 403, 404, 405, 409, 413, 415, 421, 422, 500, 503)
})
router.include_router(access)
router.include_router(documents, prefix="/tenants/{tenant}")
router.include_router(knowledge, prefix="/tenants/{tenant}")
router.include_router(sources, prefix="/tenants/{tenant}")
router.include_router(analysis_jobs, prefix="/tenants/{tenant}")
router.include_router(reviews, prefix="/tenants/{tenant}")
router.include_router(correspondences, prefix="/tenants/{tenant}")
router.include_router(extractions, prefix="/tenants/{tenant}")
router.include_router(personal, prefix="/tenants/{tenant}")
router.include_router(personal_workflows, prefix="/tenants/{tenant}")
router.include_router(analysis_plans, prefix="/tenants/{tenant}")
router.include_router(analysis_proposals, prefix="/tenants/{tenant}")
