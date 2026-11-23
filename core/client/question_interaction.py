"""새 질문 계약의 확인 질문과 사용자 응답 문맥만 다룬다."""

from copy import deepcopy
import re

CONTRACT = "user-input-v1"
MAX_EXCHANGES = 5
OPTIONS_SCHEMA = {"type": "array", "maxItems": 3,
                  "items": {"type": "string", "minLength": 1, "maxLength": 200}}
OPTION_DETAILS_SCHEMA = {"type": "array", "maxItems": 3, "items": {
    "type": "object", "additionalProperties": False,
    "properties": {"option": {"type": "string", "minLength": 1, "maxLength": 200},
                   "description": {"type": "string", "minLength": 1, "maxLength": 400},
                   "recommended": {"type": "boolean"}},
    "required": ["option", "description", "recommended"]}}
CLARIFICATION_SCHEMA = {"type": "object", "additionalProperties": False,
                        "properties": {"options": OPTIONS_SCHEMA, "option_details": OPTION_DETAILS_SCHEMA},
                        "required": ["options"]}


def enabled(handoff):
    return handoff.get("interaction_contract") == CONTRACT


def validate_input(handoff):
    if not any(key in handoff for key in ("interaction_contract", "continuation")):
        return
    if not enabled(handoff) or handoff.get("contract_version") not in {"personal-question-v5", "personal-question-v6"}:
        raise ValueError("Unsupported question interaction")
    if "continuation" not in handoff:
        return
    value = handoff["continuation"]
    if not isinstance(value, dict) or set(value) != {"root_question_turn_id", "clarification_turn_id", "exchanges"}:
        raise ValueError("Invalid question continuation")
    if any(not isinstance(value[key], str) or not re.fullmatch(r"[0-9a-f]{32}", value[key])
           for key in ("root_question_turn_id", "clarification_turn_id")):
        raise ValueError("Invalid continuation identity")
    exchanges = value["exchanges"]
    if not isinstance(exchanges, list) or not 1 <= len(exchanges) <= MAX_EXCHANGES:
        raise ValueError("Invalid continuation exchanges")
    for exchange in exchanges:
        if (not isinstance(exchange, dict) or not {"question", "answer"} <= set(exchange)
                or set(exchange) - {"question", "answer", "clarification"}):
            raise ValueError("Invalid continuation exchange")
        for key, limit in (("question", 4000), ("answer", 16000)):
            if not isinstance(exchange[key], str) or not exchange[key].strip() or len(exchange[key]) > limit:
                raise ValueError("Invalid continuation text")
        if "clarification" in exchange:
            detail = exchange["clarification"]
            if (not isinstance(detail, dict) or "options" not in detail
                    or set(detail) - {"options", "option_details"}):
                raise ValueError("Invalid continuation clarification")
            clarification(exchange["question"], detail["options"], detail.get("option_details"))


def can_clarify(handoff):
    return enabled(handoff) and len(handoff.get("continuation", {}).get("exchanges", [])) < MAX_EXCHANGES


def prompt_context(handoff, value, *, template=False):
    """기존 입력은 바꾸지 않고 새 계약에만 안내·원문 응답을 더한다."""
    validate_input(handoff)
    if not enabled(handoff):
        return ""
    value["interaction_contract"] = CONTRACT
    if "continuation" in handoff:
        value["continuation"] = deepcopy(handoff["continuation"])
    guide = (
        "The original question remains the task. continuation.exchanges contains the user's actual replies to earlier "
        "clarification questions; apply those choices when continuing this task. Replies are user preferences/context, "
        "not factual source evidence, expert approval, permission to execute tools, or proof of successful work. "
        "Never invent a reply or assume consent. Do not re-ask a decision already resolved by these replies. "
        "An exchange's optional clarification preserves the choices and descriptions the user actually saw; "
        "use them to interpret the reply, not as source evidence or as agreement with an unselected recommendation. "
    )
    if not can_clarify(handoff):
        return guide + (
            "The five-question clarification limit has been reached. Do not ask another question. "
            "Complete only what is supported and explicitly explain any remaining limitation; do not guess a missing decision.\n")
    field = "clarification" if template else "content"
    return guide + (
        "When an essential user decision or ambiguity prevents a correct result, use action=clarify and ask one short, "
        f"specific question in {field}, at most 4000 characters. First use available evidence to resolve factual questions; "
        "do not pass ordinary retrieval work or every evidence gap to the user. A clarification ends this invocation "
        "and waits for the user's reply: do not complete the task using an invented answer. "
        + ("Return no replacements. " if template else
           "Set all query fields to null; evidence_ids may contain only actually served IDs cited inline in the question. ")
        + "clarification_options is null or up to three short, distinct answer choices (1–200 characters each). "
        "clarification_option_details is optional: use null when plain choices are enough. "
        "Only when context, tradeoffs, or an unfamiliar choice would help the user decide, include details for those "
        "choices as {option: an exact choice label, description: a brief plain-text explanation (1–400 characters), "
        "recommended: a boolean}. Each choice can have at most one detail. Recommend at most one choice, and only "
        "when the user's stated goals/context provide a defensible reason; explain that reason in its description. "
        "Descriptions without any recommendation are valid. Do not add generic descriptions or recommendations "
        "to every clarification, and never manufacture a preference. Put useful overall context or your qualified "
        "opinion in the question text only when needed. Source-dependent claims and evidence markers belong in the "
        "question text with validated citations, not in option descriptions. Do not put raw evidence markers or "
        "internal plans in option details. Both clarification_options and clarification_option_details must be null "
        "for every other action. A recommendation never selects or submits the user's answer. "
        + "Never include an internal document replacement plan in the question. "
        "This clarify action remains available when evidence queries are exhausted; the evidence-query limit is not a user decision.\n"
    )


def step_schema(schema, handoff):
    if not enabled(handoff):
        return schema
    schema = deepcopy(schema)
    schema["properties"]["clarification_options"] = {**deepcopy(OPTIONS_SCHEMA), "type": ["array", "null"]}
    schema["properties"]["clarification_option_details"] = {
        **deepcopy(OPTION_DETAILS_SCHEMA), "type": ["array", "null"]}
    schema["required"].append("clarification_options")
    if can_clarify(handoff):
        ordinary = deepcopy(schema)
        ordinary["properties"]["clarification_options"] = {"type": "null"}
        ordinary["properties"]["clarification_option_details"] = {"type": "null"}
        question = deepcopy(schema)
        question["properties"]["action"]["enum"] = ["clarify"]
        question["properties"]["content"] = {"type": "string", "minLength": 1, "maxLength": 4000}
        for key in ("query", "material_id", "start_line", "line_count", "offset", "limit",
                    "start_character", "character_count"):
            question["properties"][key] = {"type": "null"}
        schema["properties"]["action"]["enum"].append("clarify")
        schema["anyOf"] = [ordinary, question]
    else:
        schema["properties"]["clarification_options"] = {"type": "null"}
        schema["properties"]["clarification_option_details"] = {"type": "null"}
    return schema


def clarification(content, options, option_details=None):
    """확인 질문의 본문·선택지를 표시/저장 전 같은 경계로 검사한다."""
    if (not isinstance(content, str) or not content.strip() or len(content) > 4000
            or "wiki-template-result" in content):
        raise ValueError("Invalid clarification content")
    options = [] if options is None else options
    if (not isinstance(options, list) or len(options) > 3
            or any(not isinstance(option, str) or not option.strip() or len(option) > 200
                   or "[[" in option or "wiki-template-result" in option for option in options)
            or len(set(options)) != len(options)):
        raise ValueError("Invalid clarification options")
    result = {"options": list(options)}
    if option_details is None:
        return result
    if not isinstance(option_details, list) or len(option_details) > 3:
        raise ValueError("Invalid clarification option details")
    seen, recommendations = set(), 0
    for item in option_details:
        if (not isinstance(item, dict) or set(item) != {"option", "description", "recommended"}
                or not isinstance(item["option"], str) or item["option"] not in options or item["option"] in seen
                or not isinstance(item["description"], str) or not item["description"].strip()
                or len(item["description"]) > 400 or "[[" in item["description"]
                or "wiki-template-result" in item["description"] or type(item["recommended"]) is not bool):
            raise ValueError("Invalid clarification option detail")
        seen.add(item["option"])
        recommendations += item["recommended"]
    if recommendations > 1:
        raise ValueError("A clarification may recommend at most one choice")
    result["option_details"] = deepcopy(option_details)
    return result
