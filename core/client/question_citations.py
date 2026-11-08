"""실제로 제공한 근거 표식에서 본문 번호와 인용표를 함께 만든다.

번호의 구조적 연결을 고정할 뿐, 선택한 구절이 주장 의미를 지지하는지는
판정하지 않는다. 숫자 배열 등 코드 표현은 Markdown 코드 구간에서 보존한다.
"""

from copy import deepcopy
import re

from core.client.ai.contracts import AIAdapterError


MAX_CITATIONS = 64
MAX_CONTENT_CHARACTERS = 65536
MAX_IDENTIFIER_CHARACTERS = 80
_MARKER = re.compile(r"\[\[([^\[\]\r\n]+)\]\]")
_NUMERIC_MARKER = re.compile(r"\[\s*\d+\s*(?:(?:[,;]|[-–—])\s*\d+\s*)*\]")
_FENCE = re.compile(r" {0,3}(?P<fence>`{3,}|~{3,})(?P<tail>[^\r\n]*)\Z")
_LINE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n|$)")
_BACKTICKS = re.compile(r"`+")


def _invalid():
    raise AIAdapterError("ai_invalid_result")


def _identifier(value):
    return (isinstance(value, str) and 1 <= len(value) <= MAX_IDENTIFIER_CHARACTERS
            and not any(character.isspace() or character in "[]`" for character in value))


def _inline_code_ranges(content, start, end):
    """길이가 같은 backtick run을 짝지으며 미완성 표식은 코드로 숨기지 않는다."""
    runs = list(_BACKTICKS.finditer(content, start, end))
    next_same, nearest = {}, {}
    for index in range(len(runs) - 1, -1, -1):
        width = runs[index].end() - runs[index].start()
        if width in nearest:
            next_same[index] = nearest[width]
        nearest[width] = index
    index = 0
    while index < len(runs):
        before = runs[index].start()
        backslashes = 0
        while before > start and content[before - 1] == "\\":
            backslashes += 1
            before -= 1
        if backslashes % 2:
            index += 1
            continue
        closing = next_same.get(index)
        if closing is None:
            index += 1
            continue
        yield runs[index].start(), runs[closing].end()
        index = closing + 1


def _code_ranges(content):
    """fenced code와 inline backtick 코드만 숫자 표식 검사에서 제외한다."""
    fenced, opening = [], None
    for match in _LINE.finditer(content):
        if match.start() == match.end():
            continue
        line = match.group().rstrip("\r\n")
        fence = _FENCE.fullmatch(line)
        if fence is None:
            continue
        run, tail = fence.group("fence", "tail")
        if opening is not None:
            start, character, width = opening
            if run[0] == character and len(run) >= width and not tail.strip():
                fenced.append((start, match.end()))
                opening = None
        elif run[0] != "`" or "`" not in tail:
            opening = (match.start(), run[0], len(run))
    if opening is not None:
        fenced.append((opening[0], len(content)))
    start = 0
    for first, last in fenced:
        yield from _inline_code_ranges(content, start, first)
        yield first, last
        start = last
    yield from _inline_code_ranges(content, start, len(content))


def _masked(content, ranges):
    """검사용 사본에서만 구간을 가리며 반환 본문의 공백·개행은 바꾸지 않는다."""
    characters = list(content)
    for start, end in ranges:
        characters[start:end] = " " * (end - start)
    return "".join(characters)


def render_evidence_citations(content, declared_ids, registry):
    """[[근거ID]]의 첫 등장 순서로 content/citations/evidence_ids를 함께 만든다.

    코드 안의 숫자 배열·첨자는 그대로 두지만 근거 ID 표식은 코드에서도 같은
    계약으로 처리한다. 들여쓰기 코드·HTML은 숫자 검사 예외로 추정하지 않는다.
    """
    if (not isinstance(content, str) or not 1 <= len(content) <= MAX_CONTENT_CHARACTERS
            or not isinstance(declared_ids, list) or len(declared_ids) > MAX_CITATIONS
            or not isinstance(registry, dict) or any(not _identifier(value) for value in declared_ids)):
        _invalid()
    declared = set(declared_ids)
    if (len(declared) != len(declared_ids)
            or any(value not in registry or not isinstance(registry[value], dict) for value in declared)):
        _invalid()
    matches = list(_MARKER.finditer(content))
    identifiers = []
    numbers = {}
    for match in matches:
        identifier = match.group(1)
        if (not _identifier(identifier) or identifier not in declared
                or (match.start() and content[match.start() - 1] == "[")
                or (match.end() < len(content) and content[match.end()] == "]")):
            _invalid()
        if identifier not in numbers:
            identifiers.append(identifier)
            numbers[identifier] = len(identifiers)
    residue = _masked(content, [(match.start(), match.end()) for match in matches])
    if "[[" in residue or "]]" in residue or set(identifiers) != declared:
        _invalid()
    prose = _masked(residue, _code_ranges(content))
    if _NUMERIC_MARKER.search(prose):
        _invalid()
    rendered = _MARKER.sub(lambda match: f"[{numbers[match.group(1)]}]", content)
    return {"content": rendered, "citations": [deepcopy(registry[value]) for value in identifiers],
            "evidence_ids": identifiers}
