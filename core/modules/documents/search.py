"""본문 문자열 검색과 제한된 탐색을 담당하는 공통 업무 서비스.

MCP/HTTP의 요청·응답 타입은 사용하지 않는다. 호출자가 먼저 허용 tenant의
저장소를 선택하고 읽기 오류를 공개 코드로 바꾸는 함수를 명시적으로 전달한다.
이 모듈은 원문을 저장하거나 잠금을 추가하지 않는다.
"""

# 검색은 search_documents, 검색 결과 주변의 짧은 원문 표시는 make_snippet이 맡는다.
# 검색은 파일명/본문의 문자열을 찾는 기능이다. 같은 개체라는 의미 판정이나 문서 저장은 하지 않는다.

import os
import unicodedata
from pathlib import Path
from typing import Callable

from core.modules.documents.store import WikiStore

MAX_SEARCH_RESULTS = 50
MAX_QUERY_CHARACTERS = 200
MAX_SEARCH_FILES = 1000
MAX_SEARCH_BYTES = 16 * 1024 * 1024
MAX_SKIPPED_FILES = 50
SNIPPET_CHARACTERS = 200

def fold(text: str) -> str:
    # 한글을 NFC로 맞춘 뒤 casefold한다. macOS 파일명(NFD)과 입력(NFC)의 조합 차이로 검색이 비는 것을 막는다.
    return unicodedata.normalize("NFC", text).casefold()


def make_snippet(content: str, needle: str) -> str:
    # Keep original text, including characters whose casefold expands (e.g. ß).
    # needle이 나타난 원문 주변 문자열을 반환한다. 대소문자 비교를 바꾸더라도 반환 본문은 원래 글자를 유지한다.
    for line in content.splitlines():
        line = unicodedata.normalize("NFC", line)
        folded_index = line.casefold().find(needle)
        if folded_index >= 0:
            offset = 0
            for index, character in enumerate(line):
                offset += len(character.casefold())
                if offset > folded_index:
                    start = max(0, index - 40)
                    return line[start:start + SNIPPET_CHARACTERS]
    return content[:SNIPPET_CHARACTERS]


def search_documents(
    store: WikiStore, query: str, limit: int, *,
    read_error_code: Callable[[Exception], str],
) -> dict:
    # query 문자열을 포함한 경로/본문을 한도 안에서 찾는다. read_error_code는 읽기 예외를 공개 코드로 바꾸는 함수다.
    query = query.strip()
    if not query:
        raise ValueError("query must not be blank")
    if store.wiki_dir.is_symlink():
        raise ValueError("wiki root must not be a symlink")
    needle = fold(query)
    matches = []
    skipped = []
    scanned = 0
    scanned_bytes = 0
    truncated = False

    def walk_error(error):
        # An unreadable directory must not silently look like an empty search.
        raise error

    for directory, directories, filenames in os.walk(
        store.wiki_dir, followlinks=False, onerror=walk_error
    ):
        directories[:] = sorted(
            name for name in directories if not (Path(directory) / name).is_symlink()
        )
        for name in sorted(filenames):
            if not name.endswith(".md"):
                continue
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue
            if scanned >= MAX_SEARCH_FILES or scanned_bytes >= MAX_SEARCH_BYTES:
                truncated = True
                break
            document = path.relative_to(store.wiki_dir).as_posix()
            scanned += 1
            try:
                snapshot = store.read(document)
            except (OSError, ValueError) as error:
                skipped.append({"document": document, "code": read_error_code(error)})
                if len(skipped) >= MAX_SKIPPED_FILES:
                    truncated = True
                    break
                continue
            scanned_bytes += len(snapshot.content.encode("utf-8"))
            if needle not in fold(document) and needle not in fold(snapshot.content):
                continue
            if len(matches) == limit:
                truncated = True
                break
            matches.append({
                "document": document,
                "revision": snapshot.revision,
                "snippet": make_snippet(snapshot.content, needle),
            })
        if truncated:
            break
    return {"matches": matches, "truncated": truncated, "skipped": skipped, "scanned": scanned}
