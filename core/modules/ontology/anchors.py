"""원문 인용의 정확한 위치를 가리키는 버전 있는 앵커를 검증한다.

앵커는 개체나 사람의 승인이 아니다. 같은 문구가 반복돼도 문서·원문 판본·
줄 범위·occurrence로 선택한 위치를 구분하며 근거를 발명하지 않는다.
"""
from bisect import bisect_right
from hashlib import sha256
from pathlib import PurePosixPath
import re

FIELDS = frozenset({'kind','document','source_revision','quote','start_line','end_line','occurrence'})
MAX_QUOTE = 1000
MAX_POSITION = 1024 * 1024


def is_source_anchor(value):
    return isinstance(value, dict) and value.get('kind') == 'source_anchor'


def normalize_anchor(value, *, document=None, source_revision=None, source=None, evidence=None):
    """Validate shape/binding first; actual source validation requires source.

    Historical snapshots may be structurally read without their old source. That
    read never establishes current applicability or actual quote existence.
    """
    if not isinstance(value, dict) or set(value) != FIELDS or value.get('kind') != 'source_anchor':
        raise ValueError('source anchor must contain exactly its documented fields')
    doc = value['document']
    if (not isinstance(doc, str) or not doc or len(doc) > 4096 or not doc.endswith('.md')
            or '\\' in doc or any(ord(c) < 32 for c in doc) or doc.startswith('/')
            or any(p in {'', '.', '..'} for p in doc.split('/')) or str(PurePosixPath(doc)) != doc):
        raise ValueError('source anchor document must be a normalized relative .md path')
    revision = value['source_revision']
    if not isinstance(revision, str) or re.fullmatch(r'[0-9a-f]{64}', revision) is None:
        raise ValueError('source anchor revision must be a SHA-256')
    quote = value['quote']
    if not isinstance(quote, str) or not quote.strip() or len(quote) > MAX_QUOTE:
        raise ValueError('source anchor quote must be nonblank bounded text')
    quote.encode('utf-8')
    start, end, occurrence = (value[k] for k in ('start_line','end_line','occurrence'))
    if (type(start) is not int or type(end) is not int or not 1 <= start <= end <= MAX_POSITION
            or type(occurrence) is not int or not 0 <= occurrence <= MAX_POSITION):
        raise ValueError('source anchor line bounds/occurrence are invalid')
    if document is not None and doc != document:
        raise ValueError('source anchor must reference this graph document')
    if source_revision is not None and revision != source_revision:
        raise ValueError('source anchor revision must match its graph source')
    if evidence is not None and (not isinstance(evidence, str) or quote not in evidence):
        raise ValueError('source anchor quote must occur inside its relation evidence')
    normalized = {k: value[k] for k in ('kind','document','source_revision','quote','start_line','end_line','occurrence')}
    if source is None:
        return normalized
    if sha256(source.encode('utf-8')).hexdigest() != revision:
        raise ValueError('source anchor is not bound to the actual source bytes')
    if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > MAX_QUOTE:
        raise ValueError('source anchor relation requires bounded continuous evidence')
    evidence_offset = source.find(evidence)
    if evidence_offset < 0 or source.find(evidence, evidence_offset + 1) >= 0:
        raise ValueError('source anchor relation evidence must have one unique source occurrence')
    line_starts = [0] + [m.end() for m in re.finditer(r'\r\n|\r|\n', source)]
    positions = []
    offset = source.find(quote)
    while offset >= 0:
        quote_end = offset + len(quote)
        if (bisect_right(line_starts, offset) == start
                and bisect_right(line_starts, quote_end - 1) == end):
            positions.append((offset, quote_end))
        offset = source.find(quote, offset + 1)
    if occurrence >= len(positions):
        raise ValueError('source anchor occurrence does not exist on its declared lines')
    selected_start, selected_end = positions[occurrence]
    if not evidence_offset <= selected_start < selected_end <= evidence_offset + len(evidence):
        raise ValueError('source anchor occurrence is outside its relation evidence')
    return normalized


def endpoint_key(value):
    """Keep legacy string keys unchanged; distinguish exact source occurrences."""
    if isinstance(value, str):
        return value
    value = normalize_anchor(value)
    return tuple(value[k] for k in ('kind','document','source_revision','quote','start_line','end_line','occurrence'))
