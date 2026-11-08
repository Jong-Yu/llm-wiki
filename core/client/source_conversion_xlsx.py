"""원본 ZIP을 바꾸지 않는 XLSX 구조·수식·서식 관측.

읽은 셀 기록의 좌표와 원본 수식·캐시를 보존하며 재계산하거나 원본을 저장하지 않는다.
"""

import json
import posixpath
import re
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"


def part_path(target, base="xl"):
    """OPC 내부 경로만 해석한다. 외부 URI나 package 밖 이동은 허용하지 않는다."""
    url = urlsplit(target)
    if url.scheme or url.netloc or url.query or url.fragment or "\\" in target:
        raise ValueError("unsupported_xlsx_part_target")
    path = unquote(url.path)
    path = posixpath.normpath(path.lstrip("/") if path.startswith("/") else posixpath.join(base, path))
    if path in {"", ".", ".."} or path.startswith("../"):
        raise ValueError("invalid_xlsx_part_target")
    return path


def workbook_parts(archive):
    root = ET.fromstring(archive.read("_rels/.rels"))
    office = next(item for item in root if item.get("Type", "").endswith("/officeDocument"))
    if office.get("TargetMode") == "External" or part_path(office.get("Target", ""), "") != "xl/workbook.xml":
        raise ValueError("unsupported_xlsx_workbook_part")
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    by_id = {item.get("Id"): item for item in relations}
    sheets = []
    for sheet in workbook.findall(f"{{{NS}}}sheets/{{{NS}}}sheet"):
        relationship = by_id[sheet.attrib[f"{{{OFFICE_REL[:-1]}}}id"]]
        if relationship.get("TargetMode") == "External" or not relationship.get("Type", "").endswith("/worksheet"):
            raise ValueError("unsupported_xlsx_sheet_relationship")
        sheets.append((sheet.attrib["name"], part_path(relationship.attrib["Target"])))
    return root, relations, sheets


def raw_formula_cells(path):
    """숫자/날짜 해석 전 f/v와 속성을 남기고 빈 캐시와 미저장을 구분한다."""
    result = {}
    with ZipFile(path) as archive:
        _, _, sheets = workbook_parts(archive)
        for sheet, part in sheets:
            root = ET.fromstring(archive.read(part))
            for cell in root.iter(f"{{{NS}}}c"):
                formula = cell.find(f"{{{NS}}}f")
                if formula is not None:
                    cached = cell.find(f"{{{NS}}}v")
                    result[(sheet, cell.attrib["r"])] = {"formula": formula.text or "", "attributes": dict(formula.attrib),
                        "cached_raw": None if cached is None else cached.text or "", "cached_type": cell.get("t", "n")}
    return result


def bounds(reference):
    from openpyxl.utils.cell import range_boundaries
    if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?", reference):
        raise ValueError("invalid_xlsx_range")
    left, top, right, bottom = range_boundaries(reference)
    if not 1 <= left <= right <= 16384 or not 1 <= top <= bottom <= 1048576:
        raise ValueError("invalid_xlsx_range")
    return left, top, right, bottom


def xml_record(element):
    value = {"tag": element.tag.removeprefix("{" + NS + "}"), "attributes": dict(element.attrib)}
    if element.text and element.text.strip():
        value["text"] = element.text
    if len(element):
        value["children"] = [xml_record(child) for child in element]
    return value


def styles_metadata(archive, relations, sheets):
    """실제 사용한 서식과 원본 색상 참조를 보존한다. 표시 색/조건부 서식은 계산하지 않는다."""
    relation = next((item for item in relations if item.get("Type", "").endswith("/styles")), None)
    if relation is None:
        return {}
    if relation.get("TargetMode") == "External":
        raise ValueError("external_xlsx_styles")
    root = ET.fromstring(archive.read(part_path(relation.attrib["Target"])))
    xfs = root.find(f"{{{NS}}}cellXfs")
    used = {0}
    for sheet in sheets:
        used.update(int(value) for value in sheet["cell_styles"].values())
        used.update(int(value["s"]) for value in sheet["row_formatting"].values() if "s" in value)
        used.update(int(value["style"]) for value in sheet["column_formatting"] if "style" in value)
    values = {"cell_xfs": {}, "fonts": {}, "fills": {}, "borders": {}, "number_formats": {},
              "differential_styles": [], "indexed_colors": [], "theme_colors": []}
    for index in sorted(used):
        if xfs is None or not 0 <= index < len(xfs):
            raise ValueError("invalid_xlsx_style_reference")
        xf = xfs[index]; values["cell_xfs"][str(index)] = xml_record(xf)
        for attribute, key in (("fontId", "fonts"), ("fillId", "fills"), ("borderId", "borders")):
            identifier = xf.get(attribute, "0"); entries = root.find(f"{{{NS}}}{key}")
            if entries is not None and 0 <= int(identifier) < len(entries):
                values[key][identifier] = xml_record(entries[int(identifier)])
    for item in root.findall(f"{{{NS}}}numFmts/{{{NS}}}numFmt"):
        values["number_formats"][item.attrib["numFmtId"]] = dict(item.attrib)
    values["differential_styles"] = [xml_record(item) for item in root.findall(f"{{{NS}}}dxfs/{{{NS}}}dxf")]
    values["indexed_colors"] = [dict(item.attrib) for item in root.findall(f"{{{NS}}}colors/{{{NS}}}indexedColors/{{{NS}}}rgbColor")]
    for relation in relations:
        if relation.get("Type", "").endswith("/theme"):
            if relation.get("TargetMode") == "External":
                raise ValueError("external_xlsx_theme")
            theme = ET.fromstring(archive.read(part_path(relation.attrib["Target"])))
            palette = theme.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}clrScheme")
            if palette is not None:
                values["theme_colors"].append(xml_record(palette))
    return values


def read_structure(path):
    """원문에 명시된 병합/표/숨김 정보만 읽는다. 머리글 의미를 추정하지 않는다."""
    structure = {"format": "xlsx_structure_v1", "sheets": [], "defined_names": [], "issues": []}
    with ZipFile(path) as archive:
        _, relations, parts = workbook_parts(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet_elements = workbook.findall(f"{{{NS}}}sheets/{{{NS}}}sheet")
        for index, (sheet_element, (name, part)) in enumerate(zip(sheet_elements, parts), 1):
            root = ET.fromstring(archive.read(part))
            record = {"index": index, "sheet_id": sheet_element.get("sheetId"), "relationship_id": sheet_element.get("{" + OFFICE_REL[:-1] + "}id"),
                      "part": part, "name": name, "state": sheet_element.get("state", "visible"), "merged_ranges": [], "tables": [],
                      "hidden_rows": [int(row.attrib["r"]) for row in root.findall(f"{{{NS}}}sheetData/{{{NS}}}row")
                                      if row.get("hidden") in {"1", "true"}],
                      "hidden_columns": [{"start": int(col.attrib["min"]), "end": int(col.attrib["max"])}
                        for col in root.findall(f"{{{NS}}}cols/{{{NS}}}col") if col.get("hidden") in {"1", "true"}]}
            record["cell_styles"] = {cell.attrib["r"]: cell.attrib["s"] for cell in root.iter(f"{{{NS}}}c") if "s" in cell.attrib}
            record["row_formatting"] = {row.attrib["r"]: dict(row.attrib) for row in root.findall(f"{{{NS}}}sheetData/{{{NS}}}row")
                                        if set(row.attrib) - {"r", "spans"}}
            record["column_formatting"] = [dict(col.attrib) for col in root.findall(f"{{{NS}}}cols/{{{NS}}}col")]
            defaults = root.find(f"{{{NS}}}sheetFormatPr")
            record["sheet_format"] = dict(defaults.attrib) if defaults is not None else {}
            record["conditional_formatting"] = [xml_record(item) for item in root.findall(f"{{{NS}}}conditionalFormatting")]
            populated = {cell.attrib["r"] for cell in root.iter(f"{{{NS}}}c") if cell.find(f"{{{NS}}}f") is not None
                or any(item.text for item in cell if item.tag == f"{{{NS}}}v")
                or any(item.text for item in cell.iter(f"{{{NS}}}t"))}
            rectangles = []
            for merged in root.findall(f"{{{NS}}}mergeCells/{{{NS}}}mergeCell"):
                reference = merged.attrib["ref"]; rectangle = bounds(reference)
                for previous in rectangles:
                    if rectangle[0] <= previous[2] and previous[0] <= rectangle[2] and rectangle[1] <= previous[3] and previous[1] <= rectangle[3]:
                        structure["issues"].append({"code": "overlapping_merged_ranges", "scope": name + "!" + reference})
                        break
                rectangles.append(rectangle)
                record["merged_ranges"].append({"range": reference, "anchor": reference.split(":")[0],
                                                "anchor_has_value": reference.split(":")[0] in populated})
                if len(rectangles) > 10000:
                    raise ValueError("xlsx_structure_limit")
            table_parts = root.findall(f"{{{NS}}}tableParts/{{{NS}}}tablePart")
            if table_parts:
                directory, filename = posixpath.split(part)
                relationships = ET.fromstring(archive.read(directory + "/_rels/" + filename + ".rels"))
                by_id = {item.get("Id"): item for item in relationships}
                for table_part in table_parts:
                    relation = by_id[table_part.attrib[f"{{{OFFICE_REL[:-1]}}}id"]]
                    if relation.get("TargetMode") == "External" or not relation.get("Type", "").endswith("/table"):
                        raise ValueError("unsupported_xlsx_table_relationship")
                    table = ET.fromstring(archive.read(part_path(relation.attrib["Target"], directory)))
                    bounds(table.attrib["ref"])
                    columns = []
                    for col in table.findall(f"{{{NS}}}tableColumns/{{{NS}}}tableColumn"):
                        column = dict(col.attrib)
                        for kind in ("calculatedColumnFormula", "totalsRowFormula"):
                            formula = col.find(f"{{{NS}}}{kind}")
                            if formula is not None:
                                column[kind] = {"text": formula.text or "", "attributes": dict(formula.attrib)}
                        columns.append(column)
                    record["tables"].append({"name": table.get("displayName", table.get("name")), "range": table.attrib["ref"],
                        "attributes": dict(table.attrib), "columns": columns})
            structure["sheets"].append(record)
        for item in workbook.findall(f"{{{NS}}}definedNames/{{{NS}}}definedName"):
            local = item.get("localSheetId")
            scope = None
            if local is not None:
                if not 0 <= int(local) < len(sheet_elements):
                    raise ValueError("invalid_xlsx_defined_name_scope")
                scope = sheet_elements[int(local)].attrib["name"]
            structure["defined_names"].append({"attributes": dict(item.attrib), "text": item.text or "", "scope_sheet": scope})
        structure["styles"] = styles_metadata(archive, relations, structure["sheets"])
    return structure


def structure_markdown(structure):
    return "## XLSX 원본 구조\n\n```json\n" + json.dumps(structure, ensure_ascii=False, indent=2) + "\n```\n\n"


def cell_blocks(units):
    """원문 Markdown 기호가 문법으로 사라지지 않게 실제 셀을 코드 블록에 둔다."""
    contents = []
    for unit in units:
        text = unit["content"]
        fence = "`" * max(3, max((len(value) + 1 for value in re.findall(r"`+", text)), default=3))
        label = json.dumps(unit["location"]["sheet"], ensure_ascii=False) + "!" + unit["location"]["cells"]
        contents.append(fence + "text\n" + label + "\n" + text + "\n" + fence)
    return contents


def non_anchor_issues(structure, units):
    """병합 범위 안의 기준셀이 아닌 칸에 값이 있으면 어느 값이 화면에 보이는지 모호하므로 알린다.

    병합 하나의 면적과 시트의 셀 수 중 작은 쪽만 훑어 큰 병합이 작업량을 키우지 않게 한다.
    """
    from openpyxl.utils.cell import coordinate_to_tuple, get_column_letter
    occupied = {}
    for unit in units:
        location = unit["location"]
        if location["kind"] == "cells":
            occupied.setdefault(location["sheet"], set()).add(location["cells"])
    issues = []
    for sheet in structure["sheets"]:
        cells = occupied.get(sheet["name"])
        if not cells:
            continue
        for merged in sheet["merged_ranges"]:
            left, top, right, bottom = bounds(merged["range"])
            if (right - left + 1) * (bottom - top + 1) <= len(cells):
                addresses = (get_column_letter(column) + str(row)
                             for row in range(top, bottom + 1) for column in range(left, right + 1))
                inside = [address for address in addresses if address in cells]
            else:
                inside = []
                for address in cells:
                    row, column = coordinate_to_tuple(address)
                    if left <= column <= right and top <= row <= bottom:
                        inside.append(address)
            for address in sorted(inside):
                if address != merged["anchor"]:
                    issues.append({"code": "non_anchor_value_inside_merge", "scope": sheet["name"] + "!" + address})
    return issues
