"""오류 보고의 단일 텍스트 입력과 저장 확인 응답이다."""

from pydantic import Field, field_validator

from core.api.schemas import Model


class ReportRequest(Model):
    content: str = Field(min_length=1)

    @field_validator("content")
    @classmethod
    def nonempty_content(cls, value: str) -> str:
        """공백만 있는 보고를 거부하고 실제 입력 내용은 그대로 보존한다."""
        if not value.strip():
            raise ValueError("A report requires text.")
        return value


class ReportReceipt(Model):
    report_id: str
    created_at: str
