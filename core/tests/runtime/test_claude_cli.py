"""기존 저장·질문·후보·별도 검사 시나리오를 Claude CLI 선택으로 재검증한다."""

from core.tests.runtime import test_personal_ai_workflow as analysis
from core.tests.runtime import test_question_cli as question
from core.tests.runtime import test_proposal_cli as proposal
from core.tests.runtime import test_semantic_check_cli as semantic


class ClaudeAnalysisCliTests(analysis.PersonalAIWorkflowTests):
    provider = "claude"


class ClaudeQuestionCliTests(question.QuestionCliTests):
    provider = "claude"


class ClaudeProposalCliTests(proposal.ProposalCliTests):
    provider = "claude"


class ClaudeSemanticCheckCliTests(semantic.SemanticCheckCliTests):
    provider = "claude"
