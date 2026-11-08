"""Bounded, pure structural/source validation of an unpublished extraction.

The authoritative submission schema and whole graph must both pass. Item
diagnostics explain failures; they cannot authorize saving or establish meaning.
Budgets bound work in-process on every platform, not elapsed wall-clock time.
"""

from hashlib import sha256
import math

from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import SchemaError
from referencing.exceptions import Unresolvable

from core.common.json_codec import canonical_json_bytes
from core.modules.documents.metadata import parse_document
from core.modules.documents.store import MAX_DOCUMENT_BYTES
from . import constants
from .errors import OntologyValidationError
from .validation import _graph, _items
from .values import _revision


DRAFT_VALIDATION_VERSION = 1
MAX_SUBMISSION_BYTES = 1024 * 1024
MAX_INPUT_NODES = 20000
MAX_INPUT_DEPTH = 32
MAX_ERRORS = 100
MAX_SCHEMA_STEPS = 200000
MAX_CORE_ITEM_VISITS = 200000
MAX_SOURCE_SCAN_WORK = 512 * 1024 * 1024
COLLECTIONS = ("entities", "relations", "relation_candidates", "attributes")
_LIMITS = (constants.MAX_ENTITIES, constants.MAX_RELATIONS,
           constants.MAX_RELATION_CANDIDATES, constants.MAX_ATTRIBUTES)


class _BudgetExceeded(ValueError):
    pass


def _pointer(parts):
    return "" if not parts else "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _error(path, code, message, *, kind="first_failure", **extra):
    return {"path": path, "code": code, "message": str(message)[:500], "kind": kind, **extra}


def _admit_json(value):
    """Admit a JSON tree before encoding or schema traversal, without copying it."""
    pending, seen, nodes, text_bytes = [(value, 0)], set(), 0, 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        if nodes > MAX_INPUT_NODES or depth > MAX_INPUT_DEPTH:
            raise _BudgetExceeded("JSON node/depth budget exceeded")
        kind = type(item)
        if kind in (dict, list):
            if id(item) in seen:
                raise _BudgetExceeded("Input must be an unaliased JSON tree without cycles")
            seen.add(id(item))
            if len(item) > MAX_INPUT_NODES or len(pending) + len(item) * 2 > MAX_INPUT_NODES * 2:
                raise _BudgetExceeded("JSON container budget exceeded")
            if kind is dict:
                for key, child in item.items():
                    if type(key) is not str:
                        raise ValueError("JSON object keys must be strings")
                    pending.append((key, depth + 1))
                    pending.append((child, depth + 1))
            else:
                pending.extend((child, depth + 1) for child in item)
        elif kind is str:
            if len(item) > MAX_SUBMISSION_BYTES:
                raise _BudgetExceeded("UTF-8 byte budget exceeded")
            text_bytes += len(item.encode("utf-8"))
            if text_bytes > MAX_SUBMISSION_BYTES:
                raise _BudgetExceeded("UTF-8 byte budget exceeded")
        elif kind is int:
            if item.bit_length() > 1024:
                raise _BudgetExceeded("Integer bit budget exceeded")
        elif kind is float:
            if not math.isfinite(item):
                raise ValueError("JSON numbers must be finite")
        elif kind not in (bool, type(None)):
            raise ValueError("Input must contain only JSON values")
    if len(canonical_json_bytes(value)) > MAX_SUBMISSION_BYTES:
        raise _BudgetExceeded("UTF-8 byte budget exceeded")


def _schema_validator(schema):
    """Use the real validator with bounded keyword work and no external refs."""
    _admit_json(schema)
    if (type(schema) is not dict or schema.get("type") != "object"
            or type(schema.get("properties")) is not dict
            or not {"schema_version", *COLLECTIONS} <= set(schema["properties"])):
        raise ValueError("A published submission object schema is required")
    pending = [schema]
    while pending:
        node = pending.pop()
        if type(node) is dict:
            for key in ("$ref", "$dynamicRef"):
                reference = node.get(key)
                if reference is not None and (type(reference) is not str or not reference.startswith("#/$defs/")):
                    raise ValueError("Only local published $defs references are supported")
            if any(key in node for key in ("$schema", "$id", "$anchor", "$dynamicAnchor")):
                raise ValueError("Use the published submission schema without dialect or resolution overrides")
            pending.extend(node.values())
        elif type(node) is list:
            pending.extend(node)
    steps = [0]

    def bounded(check):
        def run(validator, value, instance, current_schema):
            steps[0] += 1
            if steps[0] > MAX_SCHEMA_STEPS:
                raise _BudgetExceeded("Schema keyword work budget exceeded")
            yield from check(validator, value, instance, current_schema)
        return run

    bounded_class = validators.extend(Draft202012Validator, {
        name: bounded(check) for name, check in Draft202012Validator.VALIDATORS.items()
    })
    return bounded_class(schema)


def _schema_errors(error):
    """Localize published version/predicate branches, without replacing validation."""
    branch = None
    value = error.instance
    if error.validator == "anyOf" and type(value) is dict:
        if type(value.get("schema_version")) is int and value["schema_version"] in (3, 4, 5, 6):
            branch = value["schema_version"] - 3
        elif type(value.get("predicate")) is str:
            branch = 1 if value["predicate"] == "maps_to" else 2 if value["predicate"] in constants.V6_SOURCE_RECORD_PREDICATES else 0
    prefix = tuple(error.absolute_schema_path)
    children = [] if branch is None else [child for child in error.context
        if tuple(child.absolute_schema_path)[:len(prefix)] == prefix
        and tuple(child.absolute_schema_path)[len(prefix):len(prefix) + 1] == (branch,)]
    if not children:
        yield error
    else:
        for child in children:
            yield from _schema_errors(child)


class _CoreBudget:
    def __init__(self):
        self.items = self.source_work = 0

    def charge(self, source, collections):
        count = sum(len(values) for values in collections.values())
        self.items += count
        # Each admitted item has bounded identifiers, anchors, qualifiers and
        # provenance. This conservative scan allowance also covers line indexing.
        if source is not None:
            self.source_work += len(source) * (1 + count * 16)
        if self.items > MAX_CORE_ITEM_VISITS or self.source_work > MAX_SOURCE_SCAN_WORK:
            raise _BudgetExceeded("Core item/source-scan work budget exceeded")


def _core_items(submission, source, document, revision, budget, **collections):
    budget.charge(source, collections)
    return _items(collections.get("entities", []), collections.get("relations", []), source,
                  collections.get("relation_candidates", []), attributes=collections.get("attributes", []),
                  schema_version=submission["schema_version"], document=document,
                  source_revision=revision, body_only=True)


def _dependencies(item, rejected):
    if type(item) is not dict:
        return []
    references = [item.get("subject"), item.get("object")]
    if type(item.get("mapping")) is dict:
        references.append(item["mapping"].get("within"))
    if type(item.get("provenance")) is dict:
        references.extend(item["provenance"].get(key) for key in ("source_entity", "attributed_to"))
    return sorted({rejected[ref] for ref in references if type(ref) is str and ref in rejected})


def _diagnose(result, source, submission, document, revision, max_errors, budget):
    accepted = {name: [] for name in COLLECTIONS}
    rejected = {}
    details = result["item_diagnostics"]
    details.update(status="running", uninspected_items=sum(len(submission[name]) for name in COLLECTIONS))
    for name in COLLECTIONS:
        for index, item in enumerate(submission[name]):
            if len(result["errors"]) >= max_errors:
                result["truncated"] = True
                details["status"] = "error_limit"
                return
            path = _pointer((name, index))
            blocked = [] if name == "entities" else _dependencies(item, rejected)
            valid = False
            if blocked:
                details["dependency_errors"] += 1
                result["errors"].append(_error(path, "dependency_error", "References rejected entity inputs; item was not validated.",
                                               kind="dependent", blocked_by=blocked))
            else:
                local = {"entities": accepted["entities"] if name != "entities" else [item]}
                if name != "entities":
                    local[name] = [item]
                try:
                    _core_items(submission, source, document, revision, budget, **local)
                    prefix = {key: list(values) for key, values in accepted.items()}
                    prefix[name].append(item)
                    _core_items(submission, None, document, revision, budget, **prefix)
                except _BudgetExceeded:
                    raise
                except (OntologyValidationError, ValueError, TypeError, KeyError, UnicodeError) as error:
                    result["errors"].append(_error(path, "item_validation", error))
                else:
                    accepted[name].append(item)
                    valid = True
                    if name == "entities":
                        rejected.pop(item["id"], None)
                details["checked_items"] += 1
            if name == "entities" and not valid and type(item) is dict and type(item.get("id")) is str:
                if not any(existing["id"] == item["id"] for existing in accepted[name]):
                    rejected[item["id"]] = path
            details["uninspected_items"] -= 1
    details["status"] = "completed_limited_scope"


def validate_draft(source, submission, *, document, expected_revision, schema, max_errors=20):
    """Check one fixed full-file source and raw submission without filesystem I/O."""
    result = {
        "version": DRAFT_VALIDATION_VERSION, "passed": False, "repairable": False,
        "document": document[:1024] if type(document) is str else None, "source_revision": None,
        "semantic_validation": "not_performed", "save_authorized": False,
        "full_validation": {"status": "not_run", "schema": {"status": "not_run"}, "core_graph": {"status": "not_run"}},
        "errors": [], "truncated": False,
        "item_diagnostics": {"status": "not_run", "checked_items": 0, "dependency_errors": 0,
                             "uninspected_items": None, "exhaustive": False},
        "limits": {"input_bytes": MAX_SUBMISSION_BYTES, "source_bytes": MAX_DOCUMENT_BYTES,
                   "input_nodes": MAX_INPUT_NODES, "input_depth": MAX_INPUT_DEPTH,
                   "schema_steps": MAX_SCHEMA_STEPS, "core_item_visits": MAX_CORE_ITEM_VISITS,
                   "source_scan_work": MAX_SOURCE_SCAN_WORK, "max_errors": max_errors if type(max_errors) is int else None,
                   "time_enforcement": "bounded work; no wall-clock guarantee"},
    }
    try:
        if type(max_errors) is not int or not 1 <= max_errors <= MAX_ERRORS:
            raise ValueError(f"max_errors must be an integer from 1 to {MAX_ERRORS}")
        if type(document) is not str or not document or len(document) > 1024:
            raise ValueError("document must be a nonempty bounded string")
        if type(source) is not str or len(source) > MAX_DOCUMENT_BYTES:
            raise _BudgetExceeded("Source exceeds the UTF-8 byte budget or is not text")
        raw = source.encode("utf-8")
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise _BudgetExceeded("Source exceeds the UTF-8 byte budget")
        result["source_revision"] = sha256(raw).hexdigest()
        _revision(expected_revision)
        if result["source_revision"] != expected_revision:
            result["errors"].append(_error("", "source_revision_mismatch", "Expected revision does not match this exact full-file source."))
            return result
        parsed = parse_document(source)
        validator = _schema_validator(schema)
    except (ValueError, TypeError, UnicodeError, SchemaError, RecursionError) as error:
        result["errors"].append(_error("", "validation_input", error))
        return result
    try:
        _admit_json(submission)
    except (ValueError, TypeError, UnicodeError) as error:
        result["errors"].append(_error("", "input_limit" if isinstance(error, _BudgetExceeded) else "submission_json", error))
        return result

    if type(submission) is dict:
        result["item_diagnostics"]["uninspected_items"] = sum(
            len(submission[name]) for name in COLLECTIONS if type(submission.get(name)) is list)
        for name, limit in zip(COLLECTIONS, _LIMITS):
            if type(submission.get(name)) is list and len(submission[name]) > limit:
                result["errors"].append(_error(_pointer((name,)), "input_limit", f"Collection exceeds the {limit}-item limit"))
                result["item_diagnostics"]["status"] = "input_limit"
                return result

    budget = _CoreBudget()
    try:
        # Validate the injected original schema in full, including top-level
        # constraints. Selecting just an item or version branch is insufficient.
        seen_schema_errors = set()
        for failure in validator.iter_errors(submission):
            for error in _schema_errors(failure):
                key = (_pointer(error.absolute_path), error.message)
                if key in seen_schema_errors:
                    continue
                if len(result["errors"]) >= max_errors:
                    result["truncated"] = True
                    break
                seen_schema_errors.add(key)
                result["errors"].append(_error(key[0], "submission_schema", error.message,
                                               schema_path=_pointer(error.absolute_schema_path)))
            if result["truncated"]:
                break
        result["full_validation"]["schema"] = {"status": "failed" if result["errors"] else "passed"}
        if result["errors"]:
            result["full_validation"]["schema"]["first_error"] = result["errors"][0]
        ready = (type(submission) is dict and type(submission.get("schema_version")) is int
                 and submission["schema_version"] in (3, 4, 5, 6)
                 and all(type(submission.get(name)) is list and len(submission[name]) <= limit
                         for name, limit in zip(COLLECTIONS, _LIMITS)))
        if ready:
            try:
                budget.charge(source, {name: submission[name] for name in COLLECTIONS})
                graph = _graph(document, expected_revision, submission["entities"], submission["relations"], source,
                               submission["relation_candidates"], attributes=submission["attributes"],
                               schema_version=submission["schema_version"], body_only=True)
                graph.update(document_id=parsed.document_id, body_revision=parsed.body_revision,
                             body_start_line=parsed.body_start_line, evidence_coordinates="full_file", generation_id="0" * 32)
                size = len(canonical_json_bytes(graph, allow_nan=True))
                if size > constants.MAX_ONTOLOGY_BYTES:
                    raise OntologyValidationError("Generated ontology exceeds the 1 MiB byte limit")
            except _BudgetExceeded:
                raise
            except (OntologyValidationError, ValueError, TypeError, KeyError, UnicodeError) as error:
                result["full_validation"]["core_graph"] = {"status": "failed", "first_error": _error("", "core_graph", error)}
            else:
                result["full_validation"]["core_graph"] = {
                    "status": "passed", "evidence_scope": "body", "evidence_coordinates": "full_file",
                    "body_revision": parsed.body_revision, "body_start_line": parsed.body_start_line,
                    "graph_bytes_with_generation_id": size,
                }
        result["passed"] = all(result["full_validation"][name]["status"] == "passed" for name in ("schema", "core_graph"))
        result["full_validation"]["status"] = "passed" if result["passed"] else "failed"
        if result["passed"]:
            result["item_diagnostics"].update(status="not_needed", uninspected_items=0)
        elif ready and not result["truncated"]:
            _diagnose(result, source, submission, document, expected_revision, max_errors, budget)
        else:
            result["item_diagnostics"]["status"] = "blocked_by_submission_shape" if not ready else "error_limit"
        if not result["passed"] and not result["errors"]:
            result["errors"].append(result["full_validation"]["core_graph"].get("first_error", _error("", "submission_schema", "Unsupported or incomplete submission")))
        result["repairable"] = not result["passed"] and not result["truncated"]
    except (_BudgetExceeded, RecursionError) as error:
        result["truncated"] = True
        result["repairable"] = result["passed"] = False
        result["full_validation"]["status"] = "incomplete"
        result["item_diagnostics"]["status"] = "work_limit"
        if len(result["errors"]) < max_errors:
            result["errors"].append(_error("", "work_limit", error))
    except (SchemaError, Unresolvable, ValueError, TypeError, KeyError) as error:
        result["repairable"] = False
        result["full_validation"]["status"] = "incomplete"
        if len(result["errors"]) < max_errors:
            result["errors"].append(_error("", "schema_contract", error))
    return result
