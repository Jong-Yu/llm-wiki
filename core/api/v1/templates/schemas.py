"""템플릿의 메타 입력과 명시 판본 조회 조건을 제한한다."""

from typing import Annotated
from pydantic import Field
from core.api.schemas import Model

Identifier = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
Revision = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class TemplateProfile(Model):
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class TemplateCreate(TemplateProfile):
    request_id: Identifier
    name: str = Field(min_length=1, max_length=200)
    instructions: str = Field(max_length=12000)


class TemplateUpdate(TemplateCreate):
    expected_revision: Revision


class TemplateArchive(TemplateProfile):
    request_id: Identifier
    expected_revision: Revision


class TemplateRender(TemplateProfile):
    content: str = Field(min_length=1, max_length=65536)
