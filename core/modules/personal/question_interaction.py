"""저장된 추가 질문과 사용자 답을 검증해 원래 작업의 문맥을 이어 준다."""

from copy import deepcopy
from .store import PersonalConflictError

INTERACTION_CONTRACT = "user-input-v1"
MAX_EXCHANGES = 5


def validate_clarification(content, clarification):
    """표시용 문장과 선택지만 받으며 도구 실행이나 사람 승인을 뜻하지 않는다."""
    if (not isinstance(content, str) or not content.strip() or len(content) > 4000
            or not isinstance(clarification, dict) or "options" not in clarification
            or not set(clarification) <= {"options", "option_details"}):
        raise ValueError("A clarification needs a question and options")
    options = clarification["options"]
    if (not isinstance(options, list) or len(options) > 3
            or any(not isinstance(item, str) or not item.strip() or len(item) > 200 for item in options)):
        raise ValueError("A clarification accepts at most three short options")
    details = clarification.get("option_details")
    if details is None:
        return
    if len(set(options)) != len(options) or any("[[" in option or "wiki-template-result" in option for option in options):
        raise ValueError("Described clarification options must be distinct plain text labels")
    if not isinstance(details, list) or len(details) > 3:
        raise ValueError("Clarification details describe at most three existing options")
    seen, recommended = set(), 0
    for detail in details:
        if not isinstance(detail, dict) or set(detail) != {"option", "description", "recommended"}:
            raise ValueError("A clarification detail needs an option, description and recommendation flag")
        option, description = detail["option"], detail["description"]
        if (not isinstance(option, str) or option not in options or option in seen
                or not isinstance(description, str) or not description.strip() or len(description) > 400
                or "[[" in description or "wiki-template-result" in description
                or type(detail["recommended"]) is not bool):
            raise ValueError("Clarification details must describe distinct existing options in plain text")
        seen.add(option)
        recommended += detail["recommended"]
    if recommended > 1:
        raise ValueError("A clarification can recommend at most one option")


def continuation_for(conversation, question):
    """원장의 불변 turn만 따라가며 임의 root·basis·요약으로 문맥을 대체하지 않는다."""
    events = conversation["events"]
    positions = {turn["id"]: index for index, turn in enumerate(events)}
    current, exchanges = question, []
    reference = question.get("clarification_turn_id")
    while current.get("clarification_turn_id") is not None:
        if len(exchanges) >= MAX_EXCHANGES:
            raise ValueError("A question can request user input at most five times")
        index = positions.get(current["id"], -1)
        if (index < 1 or current.get("role") != "user" or current.get("status") != "complete"
                or not isinstance(current.get("content"), str) or not current["content"].strip()
                or len(current["content"]) > 16000):
            raise ValueError("The stored clarification response is invalid")
        clarification = events[index - 1]
        if (clarification["id"] != current["clarification_turn_id"]
                or clarification.get("role") != "assistant" or clarification.get("status") != "complete"):
            raise PersonalConflictError()
        validate_clarification(clarification.get("content"), clarification.get("clarification"))
        parent_index = positions.get(clarification.get("reply_to"), -1)
        if parent_index < 0 or parent_index >= index - 1:
            raise ValueError("The clarification needs its original user question")
        parent = events[parent_index]
        if (parent.get("role") != "user" or current.get("basis") != parent.get("basis")
                or clarification.get("basis") != parent.get("basis")
                or current.get("template_ref") != parent.get("template_ref")):
            raise PersonalConflictError()
        exchange = {"question": clarification["content"], "answer": current["content"]}
        if clarification["clarification"].get("option_details") is not None:
            exchange["clarification"] = deepcopy(clarification["clarification"])
        exchanges.append(exchange)
        current = parent
    if not exchanges:
        return current, None
    return current, {"root_question_turn_id": current["id"], "clarification_turn_id": reference,
                     "exchanges": list(reversed(exchanges))}


def pending_clarification(conversation, turn_id):
    """현재 대화의 마지막 미응답 추가 질문에만 답할 수 있다."""
    events = conversation["events"]
    if not events or events[-1]["id"] != turn_id:
        raise PersonalConflictError()
    clarification = events[-1]
    if clarification.get("role") != "assistant" or clarification.get("status") != "complete":
        raise ValueError("Select a stored assistant clarification")
    validate_clarification(clarification.get("content"), clarification.get("clarification"))
    question = next((turn for turn in events[:-1] if turn["id"] == clarification.get("reply_to")
                     and turn.get("role") == "user"), None)
    if question is None or clarification.get("basis") != question.get("basis"):
        raise PersonalConflictError()
    root, continuation = continuation_for(conversation, question)
    if continuation and len(continuation["exchanges"]) >= MAX_EXCHANGES:
        raise ValueError("A question can request user input at most five times")
    return deepcopy(root)
