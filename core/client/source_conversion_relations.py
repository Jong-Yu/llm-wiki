"""도식의 상자·연결을 사람이 읽는 관계 문장으로 정리한다(D-160).

원본 문자·좌표는 바꾸지 않는다. 파일에 기록된 연결(PPTX stCxn/endCxn)과 위치로 추정한 연결을 구분하고,
끝을 찾지 못한 연결은 "확인 필요"로 남긴다. 선의 색·모양은 속성으로만 적고 업무 의미를 붙이지 않는다.
"""

import math

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
LINE_SHAPES = {"line", "straightConnector1", "bentConnector2", "bentConnector3", "bentConnector4",
               "bentConnector5", "curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5"}
# 선 끝이 상자 테두리에서 이만큼(슬라이드 짧은 변 대비) 떨어져 있어도 그 상자에 닿은 것으로 본다.
TOLERANCE = .03
MAX_LABEL = 60


def _number(node, key, default=0):
    try:
        return int(node.get(key, default))
    except (TypeError, ValueError):
        return default


class Transform:
    """그룹 안 좌표를 슬라이드 좌표로 옮긴다. 그룹 회전은 반영하지 않는다(근사)."""

    def __init__(self, scale_x=1.0, scale_y=1.0, shift_x=0.0, shift_y=0.0):
        self.scale_x, self.scale_y, self.shift_x, self.shift_y = scale_x, scale_y, shift_x, shift_y

    def point(self, x, y):
        return self.shift_x + x * self.scale_x, self.shift_y + y * self.scale_y

    def child(self, xfrm):
        off, ext = xfrm.find(A + "off"), xfrm.find(A + "ext")
        child_off, child_ext = xfrm.find(A + "chOff"), xfrm.find(A + "chExt")
        if off is None or ext is None or child_off is None or child_ext is None:
            return self
        sx = _number(ext, "cx") / _number(child_ext, "cx") if _number(child_ext, "cx") else 1.0
        sy = _number(ext, "cy") / _number(child_ext, "cy") if _number(child_ext, "cy") else 1.0
        # 그룹 안 x → off.x + (x - chOff.x) * sx 를 현재 변환에 합성한다.
        ox, oy = self.point(_number(off, "x") - _number(child_off, "x") * sx, _number(off, "y") - _number(child_off, "y") * sy)
        return Transform(self.scale_x * sx, self.scale_y * sy, ox, oy)


def _box(xfrm, transform):
    off, ext = xfrm.find(A + "off"), xfrm.find(A + "ext")
    if off is None or ext is None:
        return None
    x0, y0 = transform.point(_number(off, "x"), _number(off, "y"))
    x1, y1 = transform.point(_number(off, "x") + _number(ext, "cx"), _number(off, "y") + _number(ext, "cy"))
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def _line_ends(xfrm, transform):
    """선의 시작(head)·끝(tail) 점. flip과 회전을 반영한다."""
    box = _box(xfrm, transform)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    start, end = [x0, y0], [x1, y1]
    if xfrm.get("flipH") == "1":
        start[0], end[0] = end[0], start[0]
    if xfrm.get("flipV") == "1":
        start[1], end[1] = end[1], start[1]
    angle = math.radians(_number(xfrm, "rot") / 60000)
    if angle:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

        def turn(point):
            dx, dy = point[0] - cx, point[1] - cy
            return [cx + dx * math.cos(angle) - dy * math.sin(angle), cy + dx * math.sin(angle) + dy * math.cos(angle)]
        start, end = turn(start), turn(end)
    return tuple(start), tuple(end)


def _short(text):
    line = " ".join(text.split())
    return line if len(line) <= MAX_LABEL else line[:MAX_LABEL - 1] + "…"


def _invisible(node):
    """테두리가 없고 채우기가 없거나 흰색·배경색인 도형. 흰 바탕 슬라이드에서 보이지 않는다."""
    properties = node.find(P + "spPr")
    if properties is None:
        return False
    line = properties.find(A + "ln")
    if line is None or line.find(A + "noFill") is None:
        return False
    if properties.find(A + "noFill") is not None:
        return True
    fill = properties.find(A + "solidFill")
    if fill is None:
        return False
    scheme, rgb = fill.find(A + "schemeClr"), fill.find(A + "srgbClr")
    # 밝기 조정(lumMod 등)이 붙은 색은 회색일 수 있어 보이는 도형으로 본다.
    return (scheme is not None and scheme.get("val") in {"bg1", "lt1"} and not list(scheme)) or (
        rgb is not None and (rgb.get("val") or "").upper() == "FFFFFF" and not list(rgb))


def _is_label_box(node):
    """채우기·테두리 없는 글상자는 연결의 라벨 후보다."""
    properties = node.find(P + "spPr")
    textbox = node.find(P + "nvSpPr/" + P + "cNvSpPr")
    if textbox is not None and textbox.get("txBox") == "1":
        return True
    if properties is None:
        return False
    no_fill = properties.find(A + "noFill") is not None
    line = properties.find(A + "ln")
    no_line = line is not None and line.find(A + "noFill") is not None
    return no_fill and no_line


def pptx_shapes(tree, paragraphs):
    """슬라이드의 상자·그림·연결선을 슬라이드 좌표로 모은다. AlternateContent는 Fallback만 읽는다."""
    nodes, lines = [], []

    def walk(parent, transform, depth=0):
        if depth > 64:
            return
        for child in parent:
            if child.tag == MC + "AlternateContent":
                fallback = child.find(MC + "Fallback")
                if fallback is not None:
                    walk(fallback, transform, depth + 1)
                continue
            identity = next((value for tag in ("nvSpPr", "nvCxnSpPr", "nvGrpSpPr", "nvGraphicFramePr", "nvPicPr")
                             if (value := child.find(P + tag + "/" + P + "cNvPr")) is not None), None)
            ident = identity.get("id") if identity is not None else None
            name = identity.get("name", "") if identity is not None else ""
            if child.tag == P + "grpSp":
                xfrm = child.find(P + "grpSpPr/" + A + "xfrm")
                walk(child, transform.child(xfrm) if xfrm is not None else transform, depth + 1)
                continue
            xfrm = child.find(P + "spPr/" + A + "xfrm") if child.tag != P + "graphicFrame" else child.find(P + "xfrm")
            geometry = child.find(P + "spPr/" + A + "prstGeom")
            body = child.find(P + "txBody")
            text = paragraphs(body) if body is not None else ""
            if child.tag == P + "cxnSp" or (child.tag == P + "sp" and geometry is not None
                                             and geometry.get("prst") in LINE_SHAPES):
                ends = _line_ends(xfrm, transform) if xfrm is not None else None
                outline = child.find(P + "spPr/" + A + "ln")
                connection = child.find(P + "nvCxnSpPr/" + P + "cNvCxnSpPr")
                decorations = {tag: (outline.find(A + tag).get("type") if outline is not None
                                     and outline.find(A + tag) is not None else None) for tag in ("headEnd", "tailEnd")}
                dash = outline.find(A + "prstDash") if outline is not None else None
                lines.append({"id": ident, "text": text.strip(), "ends": ends, "head": decorations["headEnd"],
                              "tail": decorations["tailEnd"],
                              "start_ref": (connection.find(A + "stCxn").get("id") if connection is not None
                                            and connection.find(A + "stCxn") is not None else None),
                              "end_ref": (connection.find(A + "endCxn").get("id") if connection is not None
                                          and connection.find(A + "endCxn") is not None else None),
                              "dash": dash.get("val") if dash is not None and dash.get("val") != "solid" else None})
            elif child.tag in {P + "sp", P + "pic", P + "graphicFrame"}:
                box = _box(xfrm, transform) if xfrm is not None else None
                if box is not None:
                    nodes.append({"id": ident, "name": name, "text": text.strip(), "box": box,
                                  "label_box": child.tag == P + "sp" and bool(text.strip()) and _is_label_box(child),
                                  "invisible": child.tag == P + "sp" and not text.strip() and _invisible(child)})
    walk(tree, Transform())
    return nodes, lines


def _distance_to_box(point, box):
    x, y = point
    dx = max(box[0] - x, 0, x - box[2])
    dy = max(box[1] - y, 0, y - box[3])
    return math.hypot(dx, dy)


def _edge_distance(point, box):
    """점과 상자 테두리 사이 거리(안쪽이면 가장 가까운 변까지)."""
    x, y = point
    if box[0] <= x <= box[2] and box[1] <= y <= box[3]:
        return min(x - box[0], box[2] - x, y - box[1], box[3] - y)
    return _distance_to_box(point, box)


def _area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _touching(point, nodes, tolerance, page_area):
    """선 끝이 닿은 상자. 테두리 근처이거나 작은 상자 안이면 후보이고, 가장 작은 상자를 고른다."""
    candidates = [node for node in nodes if _distance_to_box(point, node["box"]) <= tolerance
                  and (_edge_distance(point, node["box"]) <= tolerance or _area(node["box"]) < page_area * .1)]
    if not candidates:
        return None
    # 테두리가 가장 가까운 상자를 고른다(3pt 단위). 같은 테두리를 공유하면(화면 모형의 안쪽 칸 등)
    # 이름 있는 상자, 그다음 작은 상자를 고른다.
    return min(candidates, key=lambda node: (round(_edge_distance(point, node["box"]) / 3),
                                             not (node["text"] or node["name"]), _area(node["box"])))


def relation_lines(nodes, lines, size, *, position_of=None):
    """관계 문장과 (위치 추정 수, 확인 필요 수)를 돌려준다. nodes/lines의 형식은 pptx_shapes와 같다."""
    width, height = size
    tolerance = min(width, height) * TOLERANCE
    page_area = width * height
    shapes = [node for node in nodes if not node["label_box"]]
    labels = [node for node in nodes if node["label_box"]]
    by_id = {}
    for node in shapes:
        by_id.setdefault(node["id"], []).append(node)
    edges, estimated, unresolved = [], 0, 0
    for line in lines:
        ends, how = [], []
        if "nodes" in line:
            # PDF 트리 선·PPTX 이어 붙인 선처럼 미리 끝을 정한 연결. 끝을 정한 방법을 함께 받을 수 있다.
            ends, how = list(line["nodes"]), list(line.get("how", ("position", "position")))
        for reference, point in (() if "nodes" in line else (
                (line["start_ref"], line["ends"][0] if line["ends"] else None),
                (line["end_ref"], line["ends"][1] if line["ends"] else None))):
            if reference is not None:
                matches = by_id.get(reference, [])
                ends.append(matches[0] if len(matches) == 1 else None)
                how.append("file")
            elif point is not None:
                ends.append(_touching(point, shapes, tolerance, page_area))
                how.append("position")
            else:
                ends.append(None)
                how.append("none")
        if "file" not in how and line["ends"]:
            (x0, y0), (x1, y1) = line["ends"]
            inside = [node for node in shapes if node["box"][0] - 1 <= min(x0, x1) and max(x0, x1) <= node["box"][2] + 1
                      and node["box"][1] - 1 <= min(y0, y1) and max(y0, y1) <= node["box"][3] + 1]
            # 한 상자 안에서 시작하고 끝나는 선, 서로 겹친 상자 사이의 선은 상자 안 장식(화면 모형의 줄 등)으로
            # 보고 관계에서 뺀다.
            overlapping = all(ends) and _area((max(ends[0]["box"][0], ends[1]["box"][0]),
                max(ends[0]["box"][1], ends[1]["box"][1]), min(ends[0]["box"][2], ends[1]["box"][2]),
                min(ends[0]["box"][3], ends[1]["box"][3]))) > 0 and min(ends[0]["box"][2], ends[1]["box"][2]) > max(
                ends[0]["box"][0], ends[1]["box"][0]) and min(ends[0]["box"][3], ends[1]["box"][3]) > max(
                ends[0]["box"][1], ends[1]["box"][1])
            if (ends[0] is not None and ends[0] is ends[1]) or (not any(ends) and inside) or overlapping:
                continue
        label, label_estimated = line["text"], False
        if not label and line["ends"]:
            (x0, y0), (x1, y1) = line["ends"]
            # 이어 붙인 선은 조각마다의 가운데에서 라벨을 찾는다.
            spots = line.get("label_points") or [(((x0 + x1) / 2, (y0 + y1) / 2), math.hypot(x1 - x0, y1 - y0))]
            near = [(math.dist(middle, ((node["box"][0] + node["box"][2]) / 2, (node["box"][1] + node["box"][3]) / 2)),
                     node, max(length * .6, tolerance * 3)) for middle, length in spots for node in labels]
            near = [item[:2] for item in near if item[0] <= item[2]]
            if near:
                label, label_estimated = min(near, key=lambda item: item[0])[1]["text"], True
        directed = line["head"] not in (None, "none") or line["tail"] not in (None, "none")
        if not directed and "file" not in how and any(node is not None and not (node["text"] or node["name"])
                                                      for node in ends):
            continue   # 이름 없는 상자에 닿은 방향 없는 선은 표·모형의 칸 구분선일 가능성이 커 뺀다.
        pair = {id(node) for node in ends if node is not None}
        if all(ends) and not directed and any(set(id(node) for node in other["ends"]) == pair for other in edges):
            continue   # 같은 두 상자 사이의 겹친 선(화살표와 함께 그려진 선 등)은 한 번만 적는다.
        if all(ends) and directed:
            edges = [other for other in edges if not (all(other["ends"]) and {id(node) for node in other["ends"]} == pair
                     and other["line"]["head"] in (None, "none") and other["line"]["tail"] in (None, "none"))]
        edges.append({"ends": ends, "how": how, "line": line, "label": label, "label_estimated": label_estimated})
    estimated = sum("position" in edge["how"] and all(edge["ends"]) for edge in edges)
    unresolved = sum(not all(edge["ends"]) for edge in edges)
    if not edges:
        return [], 0, 0
    used = [node for edge in edges for node in edge["ends"] if node is not None]
    names = {}
    for node in shapes:
        names.setdefault(_short(node["text"] or node["name"] or "이름 없는 도형"), []).append(node)

    def display(node):
        if node is None:
            return "?"
        name = _short(node["text"] or node["name"] or "이름 없는 도형")
        if len(names[name]) > 1:
            name += f" [{position_of(node) if position_of else 'id=' + str(node['id'])}]"
        return name
    output = [f"### 도식 관계 (연결 {len(edges)}개: 파일의 연결 정보 {len(edges) - estimated - unresolved}개, "
              f"위치로 추정 {estimated}개, 확인 필요 {unresolved}개)"]
    for edge in edges:
        start, end = edge["ends"]
        line = edge["line"]
        forward = line["tail"] not in (None, "none")
        backward = line["head"] not in (None, "none")
        if backward and not forward:
            start, end = end, start
        arrow = "↔" if forward and backward else "→" if forward or backward else "—"
        details = []
        if edge["label"]:
            details.append(f"라벨 \"{_short(edge['label'])}\"" + (" (위치로 추정)" if edge["label_estimated"] else ""))
        if line["dash"]:
            details.append(f"선 모양 {line['dash']}")
        if not all(edge["ends"]):
            details.append("끝 확인 필요")
        elif "position" in edge["how"]:
            details.append("끝은 위치로 추정")
        if line["id"]:
            details.append(f"연결선 id={line['id']}")
        output.append(f"- {display(start)} {arrow} {display(end)}" + ("".join(" · " + value for value in details)))
    containers = []
    # 글자가 있는 상자만 경계로 본다. 슬라이드 대부분을 덮는 배경 도형은 경계가 아니다.
    # 설명 글로 이름을 붙인 아이콘(PPTX)은 경계가 아니다.
    bounds = [node for node in shapes if node["text"] and not node.get("captioned") and _area(node["box"]) < page_area * .8]
    for node in shapes:
        parents = [other for other in bounds if other is not node and _area(other["box"]) >= _area(node["box"]) * 2
                   and other["box"][0] - tolerance <= node["box"][0] and other["box"][1] - tolerance <= node["box"][1]
                   and node["box"][2] <= other["box"][2] + tolerance and node["box"][3] <= other["box"][3] + tolerance]
        if parents:
            containers.append((min(parents, key=lambda other: _area(other["box"])), node))
    grouped = {}
    for parent, child in containers:
        grouped.setdefault(id(parent), (parent, []))[1].append(child)
    if grouped and used:
        output.append("### 포함 관계 (위치로 추정)")
        for parent, children in grouped.values():
            output.append(f"- {display(parent)}: " + ", ".join(display(child) for child in children))
    return output, estimated, unresolved


def review_status(block, unresolved, max_review_ratio=.3):
    """관계 묶음을 본문에 붙일지("added") AI 해석 후보로 남길지("review") 정한다. PDF·PPTX 공통 기준이다.

    끝을 못 찾은 연결과 이름 없는 상자가 각각 연결의 30% 이하일 때만 붙인다.
    """
    if not block:
        return None
    section = block[1:block.index("### 포함 관계 (위치로 추정)")] if "### 포함 관계 (위치로 추정)" in block else block[1:]
    edges = [line for line in section if line.startswith("- ")]
    if not edges:
        return None
    unnamed = sum(line.count("이름 없는 도형") for line in edges)
    if unresolved > len(edges) * max_review_ratio or unnamed > len(edges) * max_review_ratio:
        return "review"
    return "added"


# --- PPTX: 파일의 연결 참조를 우선하고, 꺾임용 투명 상자·나무 모양 갈래·떨어진 설명 글을 정리한다(D-167). ---
PPTX_POINT = 12700          # EMU per pt
WAYPOINT_MAX = .1           # 슬라이드 짧은 변 대비. 이보다 작은 보이지 않는 도형은 꺾인 선을 잇는 점이다.
CAPTION_GAP = .05           # 슬라이드 짧은 변 대비. 글자 없는 도형과 설명 글 사이 최대 간격.


def _within(inner, outer, slack):
    return (outer[0] - slack <= inner[0] and outer[1] - slack <= inner[1]
            and inner[2] <= outer[2] + slack and inner[3] <= outer[3] + slack)


def _segment_distance(point, ends):
    (x0, y0), (x1, y1) = ends
    dx, dy = x1 - x0, y1 - y0
    if dx == dy == 0:
        return math.dist(point, (x0, y0))
    t = max(0.0, min(1.0, ((point[0] - x0) * dx + (point[1] - y0) * dy) / (dx * dx + dy * dy)))
    return math.dist(point, (x0 + t * dx, y0 + t * dy))


def _pptx_caption(node, labels, used, gap):
    """글자 없는 도형(아이콘·그림·빈 상자)의 바로 아래(없으면 위)에서 가운데가 맞는 글상자.

    아이콘 그림은 투명한 여백이 있어 설명 글과 겹치기도 한다. 글상자의 가운데가 도형 아래쪽(위쪽) 1/4 밖에 있으면
    겹쳐도 설명 글로 본다.
    """
    x0, y0, x1, y1 = node["box"]
    middle, quarter = (y0 + y1) / 2, (y1 - y0) / 4
    best = None
    for label in labels:
        if id(label) in used:
            continue
        lx0, ly0, lx1, ly1 = label["box"]
        if abs((lx0 + lx1) / 2 - (x0 + x1) / 2) > max(6 * PPTX_POINT, .25 * max(x1 - x0, lx1 - lx0)):
            continue
        if (ly0 + ly1) / 2 >= middle + quarter and ly0 <= y1 + gap:
            rank = (0, max(0, ly0 - y1))
        elif (ly0 + ly1) / 2 <= middle - quarter and ly1 >= y0 - gap:
            rank = (1, max(0, y0 - ly1))
        else:
            continue
        if best is None or rank < best[0]:
            best = (rank, label)
    return best[1] if best else None


def pptx_relation_lines(nodes, lines, size):
    """PPTX 슬라이드의 관계 문장과 (위치 추정 수, 확인 필요 수). nodes/lines는 pptx_shapes 결과다.

    - 글자 없는 도형은 파일 속 도형 이름("직사각형 16" 같은 자동 이름) 대신 아래·위 설명 글을 이름으로 쓴다.
    - 글자 없는 도형 안의 글자 없는 도형(아이콘을 이루는 조각)은 바깥 도형으로 본다.
    - 위아래로 맞붙은 같은 너비의 칸(클래스 제목·속성 칸)은 맨 위 칸 이름의 한 상자로 본다.
    - 보이지 않는 작은 도형에서 끊긴 선, 다른 선 위에서 끝나는 선은 이어 붙여 양 끝 상자를 찾는다.
      갈래가 여럿이면 화살촉 없는 쪽 하나를 출발점으로, 모두 화살촉이 없으면 줄기 방향이 하나뿐인 쪽을 뿌리로 본다.
    """
    width, height = size
    short = min(width, height)
    tolerance, page_area = short * TOLERANCE, width * height
    labels = [node for node in nodes if node["label_box"]]
    shapes = [node for node in nodes if not node["label_box"]]
    for node in shapes:
        box = node["box"]
        node["waypoint"] = bool(node.get("invisible")) and max(box[2] - box[0], box[3] - box[1]) <= short * WAYPOINT_MAX
        if not node["text"]:
            node["name"] = ""   # 글자 없는 도형의 파일 속 이름은 자동 이름·생성 코드라 표시 이름으로 쓰지 않는다.
    blank = [node for node in shapes if not node["text"] and not node["waypoint"]]
    parent = {}
    for node in blank:
        outer = [other for other in blank if other is not node and _area(other["box"]) < page_area * .1
                 and _area(other["box"]) >= _area(node["box"]) and _within(node["box"], other["box"], PPTX_POINT)]
        if outer:
            parent[id(node)] = max(outer, key=lambda other: (_area(other["box"]), -shapes.index(other)))

    def root(node):
        for _ in range(8):
            if node is None or id(node) not in parent:
                return node
            node = parent[id(node)]
        return node
    kept = [node for node in shapes if not node["waypoint"] and id(node) not in parent]
    # 위아래로 맞붙고 좌우 끝이 같은 칸(클래스 도식의 제목·속성 칸)은 맨 위 칸의 상자다(PDF의 칸 합치기와 같다).
    for node in sorted(kept, key=lambda node: node["box"][1]):
        above = next((other for other in kept if other is not node and id(other) not in parent
                      and abs(other["box"][0] - node["box"][0]) <= PPTX_POINT
                      and abs(other["box"][2] - node["box"][2]) <= PPTX_POINT
                      and abs(other["box"][3] - node["box"][1]) <= PPTX_POINT), None)
        if above is not None:
            top = root(above)
            parent[id(node)] = top
            top["box"] = (min(top["box"][0], node["box"][0]), min(top["box"][1], node["box"][1]),
                          max(top["box"][2], node["box"][2]), max(top["box"][3], node["box"][3]))
    kept = [node for node in kept if id(node) not in parent]
    used, owner = set(), {}
    for node in sorted((node for node in kept if not node["text"]), key=lambda node: -_area(node["box"])):
        caption = _pptx_caption(node, labels, used, short * CAPTION_GAP)
        if caption is not None:
            used.add(id(caption))
            owner[id(caption)] = node
            node["text"], node["captioned"] = " ".join(caption["text"].split()), True
            # 선이 설명 글 쪽에서 시작해도 그 도형에 닿은 것으로 본다.
            node["box"] = tuple(min(a, b) if index < 2 else max(a, b)
                                for index, (a, b) in enumerate(zip(node["box"], caption["box"])))
    by_id = {}
    for node in shapes + labels:
        by_id.setdefault(node["id"], []).append(node)
    # 연결선이 글상자에 붙어 있으면: 설명 글이면 그 아이콘에, 아니면 그 글상자 자체를 상자로 본다.
    promoted = []
    for reference in {value for line in lines for value in (line["start_ref"], line["end_ref"]) if value is not None}:
        matches = by_id.get(reference, [])
        if len(matches) == 1 and matches[0]["label_box"] and id(matches[0]) not in owner:
            matches[0]["label_box"] = False
            promoted.append(matches[0])

    def end_of(reference, point, decoration):
        if reference is not None:
            matches = by_id.get(reference, [])
            node, how = (root(owner.get(id(matches[0]), matches[0])) if len(matches) == 1 else None), "file"
        elif point is not None:
            node, how = root(_touching(point, shapes, tolerance, page_area)), "position"
        else:
            node, how = None, "none"
        waypoint = node if node is not None and node.get("waypoint") else None
        return {"node": None if waypoint else node, "how": how, "waypoint": waypoint, "point": point,
                "decoration": decoration if decoration not in (None, "none") else None}
    items = []
    for line in lines:
        points = line["ends"] or (None, None)
        items.append((line, (end_of(line["start_ref"], points[0], line["head"]),
                             end_of(line["end_ref"], points[1], line["tail"]))))
    group = list(range(len(items)))

    def find(index):
        while group[index] != index:
            group[index] = group[group[index]]
            index = group[index]
        return index
    for index, (line, ends) in enumerate(items):
        for end in ends:
            if end["node"] is not None:
                continue
            for other, (other_line, other_ends) in enumerate(items):
                if other == index:
                    continue
                joined = (end["waypoint"] is not None and any(item["waypoint"] is end["waypoint"] for item in other_ends)) or (
                    end["point"] is not None and other_line["ends"] is not None and (
                        any(item["node"] is None and item["point"] is not None
                            and math.dist(end["point"], item["point"]) <= 3 * PPTX_POINT for item in other_ends)
                        or _segment_distance(end["point"], other_line["ends"]) <= 2 * PPTX_POINT))
                if joined:
                    group[find(index)] = find(other)
    members = {}
    for index in range(len(items)):
        members.setdefault(find(index), []).append(index)
    merged = []
    for indexes in sorted(members.values()):
        if len(indexes) == 1:
            line, ends = items[indexes[0]]
            merged.append({**line, "nodes": tuple(end["node"] for end in ends), "how": [end["how"] for end in ends]})
            continue
        pieces = [items[index][0] for index in indexes]
        terminals = []
        for index in indexes:
            line, ends = items[index]
            upright = line["ends"] is not None and abs(line["ends"][1][0] - line["ends"][0][0]) < abs(
                line["ends"][1][1] - line["ends"][0][1])
            for end in ends:
                if end["node"] is None:
                    continue
                same = next((item for item in terminals if item["node"] is end["node"]), None)
                if same is not None:
                    same["decoration"] = same["decoration"] or end["decoration"]
                    continue
                terminals.append({**end, "upright": upright})
        base = {"id": pieces[0]["id"], "text": " ".join(piece["text"] for piece in pieces if piece["text"]),
                "start_ref": None, "end_ref": None, "dash": next((piece["dash"] for piece in pieces if piece["dash"]), None),
                "label_points": [(((piece["ends"][0][0] + piece["ends"][1][0]) / 2, (piece["ends"][0][1] + piece["ends"][1][1]) / 2),
                                  math.dist(*piece["ends"])) for piece in pieces if piece["ends"] is not None]}

        def edge(start, end):
            return {**base, "ends": (start["point"], end["point"]) if start and end and start["point"] and end["point"] else None,
                    "head": start["decoration"] if start else None, "tail": end["decoration"] if end else None,
                    "nodes": (start["node"] if start else None, end["node"] if end else None),
                    "how": [start["how"] if start else "none", end["how"] if end else "none"]}
        sources = [item for item in terminals if item["decoration"] is None]
        if len(terminals) == 2:
            merged.append(edge(*terminals))
        elif len(terminals) > 2 and len(sources) == 1:
            merged.extend(edge(sources[0], item) for item in terminals if item is not sources[0])
        elif len(terminals) > 2 and len(sources) == len(terminals):
            upright = [item for item in terminals if item["upright"]]
            flat = [item for item in terminals if not item["upright"]]
            trunk = upright[0] if len(upright) == 1 else flat[0] if len(flat) == 1 else None
            if trunk is not None:
                merged.extend(edge(trunk, item) for item in terminals if item is not trunk)
            else:
                merged.extend(edge(item, None) for item in terminals)
        elif terminals:
            merged.extend(edge(item, None) for item in terminals)
        else:
            merged.append({**edge(None, None), "ends": pieces[0]["ends"]})
    return relation_lines(kept + promoted + [label for label in labels if id(label) not in used and label["label_box"]],
                          merged, size)


# --- PDF: 저장된 그리기 명령(사각형·선·화살촉)만으로 관계를 추정한다. 모두 "위치로 추정"이다. ---
PDF_MIN_BOX = 12.0      # pt. 이보다 작은 사각형은 상자로 보지 않는다(체크박스·아이콘 조각).
PDF_HEAD_SPREAD = 2.0   # 화살촉 쪽 끝의 폭이 반대쪽보다 이 배수 이상 넓어야 방향으로 본다.


def _pdf_points(item, pdfium_c, ctypes):
    """경로의 모든 점(쪽 좌표)과 하위 경로 시작 위치."""
    matrix = item.get_matrix()
    points, starts = [], []
    for index in range(pdfium_c.FPDFPath_CountSegments(item)):
        segment = pdfium_c.FPDFPath_GetPathSegment(item, index)
        x, y = ctypes.c_float(), ctypes.c_float()
        if not pdfium_c.FPDFPathSegment_GetPoint(segment, ctypes.byref(x), ctypes.byref(y)):
            continue
        if pdfium_c.FPDFPathSegment_GetType(segment) == pdfium_c.FPDF_SEGMENT_MOVETO:
            starts.append(len(points))
        points.append((matrix.a * x.value + matrix.c * y.value + matrix.e,
                       matrix.b * x.value + matrix.d * y.value + matrix.f))
    return points, starts


def _stroked(item, pdfium_c, ctypes):
    fill, stroke = ctypes.c_int(), ctypes.c_int()
    return bool(pdfium_c.FPDFPath_GetDrawMode(item, ctypes.byref(fill), ctypes.byref(stroke))) and bool(stroke.value)


def _closed(item, pdfium_c, points, starts):
    """모든 하위 경로가 닫혀 있으면 True다. 닫기 표시가 있거나 끝점이 시작점과 1pt 안이면 닫힌 것으로 본다."""
    flags = []
    for index in range(pdfium_c.FPDFPath_CountSegments(item)):
        segment = pdfium_c.FPDFPath_GetPathSegment(item, index)
        if pdfium_c.FPDFPathSegment_GetType(segment) == pdfium_c.FPDF_SEGMENT_MOVETO:
            flags.append(False)
        elif flags and pdfium_c.FPDFPathSegment_GetClose(segment):
            flags[-1] = True
    if not starts or len(flags) != len(starts):
        return False
    bounds = starts + [len(points)]
    for index, start in enumerate(starts):
        part = points[start:bounds[index + 1]]
        if not flags[index] and (len(part) < 3 or math.dist(part[0], part[-1]) > 1.0):
            return False
    return True


def _rectangle(points, starts):
    """하나의 닫힌 축 정렬 사각형(점 4~5개)이면 경계를 돌려준다."""
    if len(starts) != 1 or not 4 <= len(points) <= 5:
        return None
    xs = sorted({round(x, 1) for x, _ in points})
    ys = sorted({round(y, 1) for _, y in points})
    if len(xs) != 2 or len(ys) != 2:
        return None
    return xs[0], ys[0], xs[1], ys[1]


def _axis(points):
    """가장 먼 두 점을 선의 양 끝으로 본다."""
    best, ends = -1.0, None
    for i, first in enumerate(points):
        for second in points[i + 1:]:
            length = math.dist(first, second)
            if length > best:
                best, ends = length, (first, second)
    return ends, best


def _end_spread(points, ends, length):
    """각 끝 구간(길이의 20%, 최소 9pt, 최대 45%)에서 선 축과 수직 방향으로 퍼진 폭."""
    (x0, y0), (x1, y1) = ends
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    window = min(max(length * .2, 9.0), length * .45)
    spreads = []
    for near_start in (True, False):
        values = []
        for x, y in points:
            along = (x - x0) * ux + (y - y0) * uy
            if (along <= window) if near_start else (along >= length - window):
                values.append(-(x - x0) * uy + (y - y0) * ux)
        spreads.append(max(values) - min(values) if values else 0.0)
    return spreads


def _merge_compartments(boxes):
    """위아래로 맞붙고 좌우 끝이 같은 칸들(클래스 도식의 제목·속성 칸 등)을 한 상자로 합친다.

    합친 상자를 더하고 칸은 지운다. 이름은 이후 맨 위 칸 자리의 글자에서 정해진다.
    """
    boxes = sorted(set(boxes), key=lambda box: -box[3])
    merged, used = [], set()
    for index, box in enumerate(boxes):
        if index in used:
            continue
        group = [box]
        for other_index, other in enumerate(boxes):
            last = group[-1]
            if other_index in used or other_index == index or other in group:
                continue
            if abs(other[0] - last[0]) <= 2 and abs(other[2] - last[2]) <= 2 and abs(other[3] - last[1]) <= 2:
                group.append(other)
                used.add(other_index)
        merged.append((min(b[0] for b in group), min(b[1] for b in group), max(b[2] for b in group), max(b[3] for b in group)))
    return list(dict.fromkeys(merged))


def _head_side(points, starts, ends, length):
    """화살촉이 있는 끝("start"/"end") 또는 None.

    점선 화살표처럼 조각이 여럿이면 가장 넓게 퍼진 조각을 화살촉으로 보고, 그 조각이 치우친 끝을 고른다.
    조각이 하나뿐이면 양 끝 구간의 폭을 비교한다.
    """
    (x0, y0), (x1, y1) = ends
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    bounds = list(starts) + [len(points)]
    best = None
    if len(starts) > 1:
        for first, last in zip(bounds, bounds[1:]):
            part = points[first:last]
            if not part:
                continue
            across = [-(x - x0) * uy + (y - y0) * ux for x, y in part]
            along = [(x - x0) * ux + (y - y0) * uy for x, y in part]
            spread = max(across) - min(across)
            if spread >= 3.0 and (best is None or spread > best[0]):
                best = (spread, min(along), max(along))
    if best is not None and best[2] - best[1] < length * .9:
        return "end" if length - best[2] < best[1] else "start"
    start_spread, end_spread = _end_spread(points, ends, length)
    if start_spread >= max(end_spread * PDF_HEAD_SPREAD, 2.0):
        return "start"
    if end_spread >= max(start_spread * PDF_HEAD_SPREAD, 2.0):
        return "end"
    return None


def pdf_shapes(page, textpage, pdfium_c, ctypes):
    """쪽의 상자(사각형+안쪽 글자)와 선(양 끝·화살촉)을 모은다. 좌표는 PDF 좌표(아래가 0)다."""
    boxes, lines, heads = {}, [], []
    for item in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_PATH,)):
        points, starts = _pdf_points(item, pdfium_c, ctypes)
        if len(points) < 2:
            continue
        box = _rectangle(points, starts)
        if box is not None:
            # 얇은 사각형(테두리·구분선 조각)은 연결선으로 보지 않는다. 표·카드 테두리가 연결로 잡히는 것을 막는다.
            if box[2] - box[0] >= PDF_MIN_BOX and box[3] - box[1] >= PDF_MIN_BOX:
                boxes[tuple(round(value) for value in box)] = box
            continue
        ends, length = _axis(points)
        left, bottom, right, top = item.get_bounds()
        if (min(right - left, top - bottom) >= PDF_MIN_BOX and len(points) > 4 and _stroked(item, pdfium_c, ctypes)
                and _closed(item, pdfium_c, points, starts)):
            # 테두리가 있는 둥근 모서리 상자·원·원통은 크기가 작아도 상자다(선으로 잘못 보면 모서리가 연결 끝이 된다).
            # 테두리 없이 칠만 한 도형(알약 모양 이름표·아이콘)은 상자로 보지 않는다.
            boxes.setdefault((round(left), round(bottom), round(right), round(top)), (left, bottom, right, top))
            continue
        if length < PDF_MIN_BOX:
            heads.append(points)                   # 따로 저장된 작은 화살촉 후보
            continue
        if min(right - left, top - bottom) > length * .5 and len(starts) <= 1:
            continue                               # 선이 아닌 큰 도형(둥근 경계 등)은 아래에서 상자로 본다
        lines.append({"points": points, "starts": starts, "ends": ends, "length": length})
    # 둥근 모서리 경계처럼 점이 많은 닫힌 도형도 경계 상자로 쓴다.
    for item in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_PATH,)):
        points, starts = _pdf_points(item, pdfium_c, ctypes)
        left, bottom, right, top = item.get_bounds()
        if len(starts) == 1 and len(points) > 5 and min(right - left, top - bottom) > 40:
            boxes.setdefault((round(left), round(bottom), round(right), round(top)), (left, bottom, right, top))
    # 아이콘·화면 캡처 같은 그림도 화살표가 닿는 상자로 본다. 쪽 절반 이상을 덮는 배경 그림은 뺀다.
    width, height = page.get_size()
    for item in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,)):
        left, bottom, right, top = item.get_bounds()
        if min(right - left, top - bottom) >= PDF_MIN_BOX and (right - left) * (top - bottom) < width * height * .5:
            boxes.setdefault((round(left), round(bottom), round(right), round(top)), (left, bottom, right, top))
    nodes = [{"id": None, "name": "", "text": "", "box": box, "label_box": False} for box in _merge_compartments(boxes.values())]
    nodes += _pdf_names(nodes, textpage)
    result = []
    for line in lines:
        side = _head_side(line["points"], line["starts"], line["ends"], line["length"])
        head, tail = side == "start", side == "end"
        for points in heads:
            # 따로 저장된 화살촉이 선 끝에 붙어 있으면 그 끝을 화살표로 본다.
            center = (sum(x for x, _ in points) / len(points), sum(y for _, y in points) / len(points))
            if math.dist(center, line["ends"][0]) <= 6:
                head = True
            elif math.dist(center, line["ends"][1]) <= 6:
                tail = True
        result.append({"id": None, "text": "", "ends": line["ends"], "head": "arrow" if head else None,
                       "tail": "arrow" if tail else None, "start_ref": None, "end_ref": None, "dash": None})
    return nodes, result


def _line_items(chars):
    """(x0, y0, x1, y1, 문자) 목록을 위에서 아래 줄로 묶어 (문자열, 경계)로 돌려준다. 글자 사이가 벌어지면 띄운다."""
    rows = []
    for char in sorted(chars, key=lambda item: (-(item[1] + item[3]) / 2, item[0])):
        middle, height = (char[1] + char[3]) / 2, char[3] - char[1]
        for row in rows:
            # 마침표처럼 작은 글자도 같은 줄에 들도록 줄 높이 기준으로 비교한다.
            if abs(row[0] - middle) <= max(2.0, max(height, row[2]) * .5):
                row[1].append(char)
                row[2] = max(row[2], height)
                break
        else:
            rows.append([middle, [char], height])
    items = []
    for _, row, _ in rows:
        row.sort(key=lambda item: item[0])
        # 같은 높이라도 글자 높이의 두 배 넘게 떨어진 글은 따로 놓인 글로 나눈다.
        runs = [[row[0]]]
        row_height = max(char[3] - char[1] for char in row)
        for char in row[1:]:
            if char[0] - runs[-1][-1][2] > row_height * 2:
                runs.append([])
            runs[-1].append(char)
        for run in runs:
            text = ""
            for index, char in enumerate(run):
                # 띄어쓰기는 PDF 글자 흐름의 공백(문자 앞 공백 표시)을 따른다.
                if index and len(char) > 5 and char[5]:
                    text += " "
                text += char[4]
            items.append((text.strip(), (min(c[0] for c in run), min(c[1] for c in run),
                                         max(c[2] for c in run), max(c[3] for c in run)), run))
    return items


def _pdf_names(nodes, textpage, max_label=30):
    """글자를 상자에 배정해 상자 이름을 정하고, 남은 글자 줄을 라벨 후보로 돌려준다.

    순서: 경계(안에 상자가 있는 상자)의 위쪽 25% 첫 줄 → 안에 상자가 없는 상자의 자기 글자 첫 줄 →
    아직 이름 없는 상자(화면 모형·아이콘)는 큰 것부터 바로 아래 설명 글 줄 전체. 경계 안에 떠 있는 글자와 상자
    밖 글자가 설명 글·라벨 후보다. 너무 긴 줄(본문 문장 등)은 경계 이름으로 쓰지 않는다.
    """
    if textpage is None:
        return []
    chars, spaced = [], False
    for index in range(textpage.count_chars()):
        text = textpage.get_text_range(index, 1)
        if not text.strip():
            spaced = True
            continue
        left, bottom, right, top = textpage.get_charbox(index)
        chars.append((left, bottom, right, top, text, spaced))
        spaced = False
    children = {id(node): [other for other in nodes if other is not node and node["box"][0] <= other["box"][0]
                           and node["box"][1] <= other["box"][1] and other["box"][2] <= node["box"][2]
                           and other["box"][3] <= node["box"][3]] for node in nodes}
    owner = {}
    for char in chars:
        cx, cy = (char[0] + char[2]) / 2, (char[1] + char[3]) / 2
        owners = [node for node in nodes if node["box"][0] <= cx <= node["box"][2] and node["box"][1] <= cy <= node["box"][3]]
        owner[id(char)] = min(owners, key=lambda node: _area(node["box"])) if owners else None
    free = [char for char in chars if owner[id(char)] is None or children[id(owner[id(char)])]]
    used = set()

    def ancestors_or_loose(node):
        # 설명 글 후보: 상자 밖 글자이거나, 이 상자를 감싸는 경계 안에 떠 있는 글자.
        return [char for char in free if owner[id(char)] is None or node in children[id(owner[id(char)])]]
    for node in sorted(nodes, key=lambda node: -_area(node["box"])):
        if children[id(node)]:
            node["text"] = _caption(node["box"], ancestors_or_loose(node), used)[:max_label * 2]
    for node in nodes:
        if node["text"]:
            continue
        top, bottom = node["box"][3], node["box"][1]
        own = [char for char in chars if owner[id(char)] is node]
        if children[id(node)]:
            items = [item for item in _line_items(own) if item[1][3] >= top - (top - bottom) * .25]
            if items and len(items[0][0]) <= max_label:
                node["text"] = items[0][0]
                used.update(id(char) for char in items[0][2])
        elif own:
            items = _line_items(own)
            # 첫 줄이 «entity» 같은 분류 표시면 다음 줄(이름)까지 쓴다.
            first = items[0][0] + (" " + items[1][0] if items[0][0].startswith("«") and len(items) > 1 else "")
            node["text"] = first[:max_label * 2]
            used.update(id(char) for char in own)
    for node in sorted(nodes, key=lambda node: -_area(node["box"])):
        if not node["text"]:
            node["text"] = _caption(node["box"], ancestors_or_loose(node), used)[:max_label * 2]
    labels = []
    for text, box, row in _line_items([char for char in free if id(char) not in used]):
        # 숫자·기호만 있는 글(쪽 번호 등)은 라벨로 쓰지 않는다.
        if text and len(text) <= max_label and any(char.isalpha() for char in text):
            labels.append({"id": None, "name": "", "text": text, "box": box, "label_box": True})
    return labels


def _caption(box, chars, used):
    """상자 바로 아래(20pt 이내)에서 상자 가로 범위에 걸치는 첫 글자 줄 전체."""
    left, bottom, right, top = box
    below = [char for char in chars if id(char) not in used and bottom - 20 <= char[3] <= bottom + 1
             and char[0] <= right and char[2] >= left]
    if not below:
        return ""
    baseline = max(char[1] for char in below)
    row = sorted((char for char in chars if id(char) not in used and abs(char[1] - baseline) <= 3),
                 key=lambda char: char[0])
    picked = [char for char in below if abs(char[1] - baseline) <= 3]
    lo, hi = min(char[0] for char in picked), max(char[2] for char in picked)
    changed = True
    while changed:
        changed = False
        for char in row:
            gap = (char[3] - char[1]) * 1.5
            if char not in picked and (lo - gap <= char[2] <= lo or hi <= char[0] <= hi + gap):
                picked.append(char)
                lo, hi = min(lo, char[0]), max(hi, char[2])
                changed = True
    middle, width = (left + right) / 2, right - left
    if not left + width * .25 <= (lo + hi) / 2 <= right - width * .25 and abs((lo + hi) / 2 - middle) > 6:
        return ""   # 상자 가운데 아래에 있지 않은 글(쪽 번호 등)은 설명 글로 보지 않는다.
    for char in picked:
        used.add(id(char))
    return _line_items(picked)[0][0]


def pdf_relation_lines(nodes, lines, size, *, position_of=None):
    """PDF 선 조각을 이어 붙인 뒤 관계 문장을 만든다. 화살표 없는 선들이 서로 닿아 있으면 한 묶음으로 본다."""
    width, height = size
    tolerance = min(width, height) * TOLERANCE
    page_area = width * height
    shapes = [node for node in nodes if not node["label_box"]]

    def segment_distance(point, line):
        (x0, y0), (x1, y1) = line["ends"]
        dx, dy = x1 - x0, y1 - y0
        if dx == dy == 0:
            return math.dist(point, (x0, y0))
        t = max(0.0, min(1.0, ((point[0] - x0) * dx + (point[1] - y0) * dy) / (dx * dx + dy * dy)))
        return math.dist(point, (x0 + t * dx, y0 + t * dy))
    plain = [line for line in lines if line["head"] is None and line["tail"] is None]
    touches = {id(line): [_touching(point, shapes, tolerance, page_area) for point in line["ends"]] for line in plain}
    seen = set()
    chained = []
    for line in lines:
        if line in plain:
            continue
        found = [_touching(point, shapes, tolerance, page_area) for point in line["ends"]]
        for index, point in enumerate(line["ends"]):
            # 꺾인 화살표: 화살촉 없는 조각을 따라가 반대쪽 상자를 찾는다(최대 5조각).
            hops = 0
            while found[index] is None and hops < 5:
                hops += 1
                step = next((other for other in plain if id(other) not in seen and min(
                    math.dist(point, other["ends"][0]), math.dist(point, other["ends"][1])) <= 3.0), None)
                if step is None:
                    break
                seen.add(id(step))
                near = 0 if math.dist(point, step["ends"][0]) <= math.dist(point, step["ends"][1]) else 1
                point = step["ends"][1 - near]
                found[index] = touches[id(step)][1 - near]
        chained.append({**line, "nodes": tuple(found)} if any(found) else line)
    groups = []
    for line in plain:
        if id(line) in seen:
            continue
        group, queue = [], [line]
        seen.add(id(line))
        while queue:
            current = queue.pop()
            group.append(current)
            for index, point in enumerate(current["ends"]):
                if touches[id(current)][index] is not None:
                    continue
                for other in plain:
                    if id(other) not in seen and segment_distance(point, other) <= 2.0:
                        seen.add(id(other))
                        queue.append(other)
            for other in plain:
                # 다른 선의 끝이 이 선에 닿은 경우(가지가 줄기에 붙은 경우)도 묶는다.
                if id(other) not in seen and any(touches[id(other)][i] is None and segment_distance(point, current) <= 2.0
                                                 for i, point in enumerate(other["ends"])):
                    seen.add(id(other))
                    queue.append(other)
        groups.append(group)
    merged = chained
    for group in groups:
        if len(group) == 1:
            merged.append(group[0])
            continue
        touched = []
        for line in group:
            for index, node in enumerate(touches[id(line)]):
                if node is not None and all(node is not other for other, _ in touched):
                    (x0, y0), (x1, y1) = line["ends"]
                    touched.append((node, abs(x1 - x0) < abs(y1 - y0)))
        if len(touched) == 2:
            merged.append({**group[0], "nodes": (touched[0][0], touched[1][0])})
        elif len(touched) > 2:
            # 줄기(세로)와 가지(가로)처럼 방향이 하나만 다른 상자를 뿌리로 본다. 못 정하면 확인 필요로 남긴다.
            vertical = [node for node, upright in touched if upright]
            horizontal = [node for node, upright in touched if not upright]
            root = vertical[0] if len(vertical) == 1 else horizontal[0] if len(horizontal) == 1 else None
            for node, _ in touched:
                if root is None:
                    merged.append({**group[0], "nodes": (node, None)})
                elif node is not root:
                    merged.append({**group[0], "nodes": (root, node)})
        else:
            merged.extend(group)
    return relation_lines(nodes, merged, size, position_of=position_of)


def pdf_page_relations(document, index, *, max_review_ratio=.3):
    """PDF 한 쪽의 관계 정리 묶음(문자열)과 상태("added"/"review"/None)를 돌려준다.

    연결이 하나 이상이고 끝을 못 찾은 연결·이름 없는 상자가 각각 연결의 30% 이하일 때만 본문에 붙일 묶음을 준다.
    기준을 넘으면 "review"(AI 해석 후보)로만 알린다.
    """
    import ctypes
    import pypdfium2.raw as pdfium_c
    page = document[index]
    try:
        textpage = page.get_textpage()
        try:
            width, height = page.get_size()
            nodes, lines = pdf_shapes(page, textpage, pdfium_c, ctypes)
            position = lambda node: (f"왼쪽 {round((node['box'][0]) / width * 100)}% "
                                     f"위 {round((height - node['box'][3]) / height * 100)}%")
            block, _, unresolved = pdf_relation_lines(nodes, lines, (width, height), position_of=position)
        finally:
            textpage.close()
    finally:
        page.close()
    status = review_status(block, unresolved, max_review_ratio)
    if status != "added":
        return None, status
    return "[도식 관계 · PDF에는 연결 정보가 없어 선과 상자의 위치로 추정함]\n" + "\n".join(block), "added"
