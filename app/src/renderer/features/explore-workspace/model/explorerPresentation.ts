import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type { WorkspaceResponse } from '@contracts/workspace.contract';

export type ExplorerRow = {
  key: string;
  title: string;
  summary: string;
  status: string;
  kind: string;
  document: string | null;
  target: KnowledgeValue | null;
  value: KnowledgeValue;
};
export type GraphNode = {
  key: string;
  id: string;
  label: string;
  document: string;
  row: ExplorerRow;
};
export type GraphEdge = {
  key: string;
  subject: string;
  object: string;
  label: string;
  candidate: boolean;
  row: ExplorerRow;
};

/** 외부 JSON의 객체/배열을 좁히며 원형 값은 변경하지 않습니다. */
export function object(
  value: KnowledgeJson | undefined,
): KnowledgeValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}
/** 구조화 필드는 표시할 때만 문자열을 선택합니다. */
export function stringField(value: KnowledgeValue, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null;
}
/** 배열에서 실제 객체 항목만 선택해 UI가 원문 값을 추측하지 않게 합니다. */
export function objectList(value: KnowledgeJson | undefined): KnowledgeValue[] {
  return Array.isArray(value)
    ? value.flatMap((item: KnowledgeJson): KnowledgeValue[] => {
        const found = object(item);
        return found ? [found] : [];
      })
    : [];
}
/** 일부 정해진 공개 상태를 읽기 쉬운 문구로 표시합니다. */
export function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    unreviewed: '미검토',
    defer: '보류',
    pending: '이전 기준·확인 대기',
    ready: '현재 원문 기준',
    stale: '원문 변경됨',
    missing: '추출 결과 없음',
    current: '현재 기준',
    unavailable: '확인 불가',
    changed_or_unavailable: '선택 기준 변경/확인 불가',
    accepted: '수용',
    rejected: '거절',
    active: '적용 중',
    other_scope: '다른 관점',
    inactive: '비활성',
    source: '원문',
    machine: '기계 추출',
    reviewed: '검토 반영',
    document_policy: '전문가 판단',
    version_changed: '선택 이후 판본 변경',
    ambiguous: '대상을 하나로 확인할 수 없음',
    accept: '수용',
    reject: '거절',
    review: '원문 근거 검토',
    policy: '전문가 판단',
    undo: '되돌림',
    historical: '과거 기록',
  };
  return labels[value] || value;
}

/** 서버의 항목 종류를 목록과 상세의 일관된 이름으로 표시합니다. */
export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    entities: '개념',
    relations: '관계',
    attributes: '속성',
    relation_candidates: '연결 후보',
    document_claim: '문서 주장',
    document_review: '원문 근거 검토',
    document_policy: '전문가 판단',
    document_event: '문서 변경 기록',
    review_event: '검토 기록',
    documents: '위키 문서',
    originals: '고정 원본',
    selected_claims: '선택 주장',
    matches: '발견한 근거',
  };
  return labels[kind] || '저장된 항목';
}

/** 이력 목록에는 해시 대신 실제 기록 주체·관점·시각을 우선 표시합니다. */
export function eventDescription(row: ExplorerRow): string {
  const event = object(row.value.event) || row.value;
  const actor = object(event.actor);
  const created =
    stringField(event, 'timestamp') || stringField(event, 'created_at');
  const date = created ? new Date(created) : null;
  return [
    actor ? stringField(actor, 'user_id') : null,
    actor ? stringField(actor, 'profile_id') : null,
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString('ko-KR', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : created,
  ]
    .filter(Boolean)
    .join(' · ');
}
/** 관계 요약은 주장의 실제 끝점·관계·값을 유지합니다. */
export function assertionTitle(value: KnowledgeValue): string {
  const endpoint = (raw: KnowledgeJson | undefined): string => {
    if (
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      typeof raw === 'boolean'
    )
      return String(raw);
    const ref = object(raw);
    return ref
      ? stringField(ref, 'quote') || stringField(ref, 'id') || '원문 참조'
      : '';
  };
  const subject = endpoint(value.subject);
  const predicate =
    stringField(value, 'predicate') ||
    stringField(value, 'property') ||
    stringField(value, 'attribute');
  const target = endpoint(value.object) || endpoint(value.value);
  if (subject || predicate)
    return [subject, predicate, target].filter(Boolean).join(' → ');
  return (
    stringField(value, 'label') ||
    stringField(value, 'title') ||
    stringField(value, 'quote') ||
    stringField(value, 'statement') ||
    '저장된 항목'
  );
}

/** 모든 문서 참조는 실제 응답의 필드에서만 찾고 링크 내용은 실행하지 않습니다. */
export function rowDocument(value: KnowledgeValue): string | null {
  const direct = stringField(value, 'document');
  if (direct) return direct;
  const selection = object(value.selection);
  const selectedDocument = selection
    ? stringField(selection, 'document')
    : null;
  if (selectedDocument) return selectedDocument;
  const ref = object(value.ref);
  if (ref && ref.kind === 'document') return stringField(ref, 'reference');
  const target = object(value.target_ref);
  if (target) {
    const doc = stringField(target, 'document');
    if (doc) return doc;
    const anchor = object(target.anchor);
    if (anchor) return stringField(anchor, 'document');
  }
  const origin = object(value.provenance);
  return origin ? stringField(origin, 'document') : null;
}

/** API별 실제 결과 배열을 목록으로 옮기며 주장·이벤트·원본의 종류를 보존합니다. */
export function responseRows(response: WorkspaceResponse): ExplorerRow[] {
  const data = response.data;
  const groups: { name: string; items: KnowledgeValue[] }[] = [];
  for (const key of [
    'matches',
    'items',
    'entities',
    'relations',
    'attributes',
    'relation_candidates',
    'documents',
    'originals',
    'selected_claims',
    'explicit_links',
    'common_concept_candidates',
    'affected_documents',
    'recommendations',
  ]) {
    const items = objectList(data[key]);
    if (items.length) groups.push({ name: key, items });
  }
  if (response.operation === 'conceptQuery')
    for (const entry of objectList(data.documents)) {
      const document = stringField(entry, 'document');
      if (!document) continue;
      const claims = objectList(entry.claims).map(
        (claim: KnowledgeValue): KnowledgeValue => ({
          kind: 'document_claim',
          document,
          ref: {
            kind: 'document',
            reference: document,
            source_revision: entry.source_revision || null,
            graph_revision: entry.graph_revision || null,
            state_revision: entry.state_revision || null,
            history_revision: entry.history_revision || null,
          },
          claim,
        }),
      );
      if (claims.length)
        groups.push({ name: `claims:${document}`, items: claims });
    }
  if (groups.length === 0) {
    for (const [key, value] of Object.entries(data)) {
      if (
        [
          'access',
          'scope',
          'selection',
          'skipped',
          'resource_manifest',
          'completeness',
          'evaluation',
          'machine_graph',
          'effective_graph',
        ].includes(key)
      )
        continue;
      const items = objectList(value);
      if (items.length) groups.push({ name: key, items });
    }
  }
  return groups.flatMap(
    (group: { name: string; items: KnowledgeValue[] }): ExplorerRow[] =>
      group.items.map((value: KnowledgeValue, index: number): ExplorerRow => {
        const claim = object(value.claim);
        const event = object(value.event);
        const assertion = claim
          ? object(claim.reviewed_value) || object(claim.value)
          : null;
        const eventAfter = event ? object(event.after) : null;
        const eventValue = eventAfter ? object(eventAfter.value) : null;
        const manifest = object(value.manifest);
        const originalTitle = manifest
          ? stringField(manifest, 'title') || stringField(manifest, 'filename')
          : null;
        const target = object(value.target_ref);
        const document = rowDocument(value);
        const kind = stringField(value, 'kind') || group.name;
        const title = assertion
          ? assertionTitle(assertion)
          : group.name === 'matches'
            ? (target?.kind === 'entity' && object(target.snapshot)
                ? stringField(object(target.snapshot) || {}, 'label')
                : null) ||
              stringField(value, 'original_text') ||
              stringField(value, 'value') ||
              document ||
              assertionTitle(value)
            : eventValue
              ? assertionTitle(eventValue)
              : originalTitle || document || assertionTitle(value);
        const summary =
          stringField(value, 'snippet') ||
          stringField(value, 'message') ||
          (event ? stringField(event, 'reason') : null) ||
          stringField(value, 'reason') ||
          stringField(value, 'field') ||
          '';
        const status =
          stringField(value, 'status') ||
          stringField(value, 'decision') ||
          (claim ? stringField(claim, 'decision') : null) ||
          (event ? stringField(event, 'action') : null) ||
          stringField(value, 'currentness') ||
          stringField(value, 'layer') ||
          '';
        return {
          key: `${group.name}:${stringField(value, 'key') || stringField(value, 'id') || index}`,
          title,
          summary,
          status,
          kind,
          document,
          target,
          value,
        };
      }),
  );
}

/** 준비/조회 완전성은 개별 자원과 페이지의 한계를 함께 표시합니다. */
export function responseWarnings(data: KnowledgeValue): string[] {
  const warnings: string[] = [];
  const status = stringField(data, 'status');
  if (status && status !== 'ready')
    warnings.push(
      `자료 상태: ${statusLabel(status)}. 현재 원문과 지식의 상태를 확인해 주세요.`,
    );
  if (data.needs_review === true)
    warnings.push(
      '검토가 필요한 지식입니다. 추출 결과가 전문가의 확인을 뜻하지 않습니다.',
    );
  const target = object(data.target);
  const targetStatus = target ? stringField(target, 'status') : null;
  if (targetStatus && targetStatus !== 'current')
    warnings.push(
      `선택 대상: ${statusLabel(targetStatus)}. 현재 대상으로 자동 교체하지 않았습니다. 개념 찾기에서 다시 선택해 주세요.`,
    );
  if (target?.selectable_as_current === false)
    warnings.push(
      '선택 대상은 현재 적용할 지식으로 확인되지 않았습니다. 과거 값·다른 관점·대기 상태와 현재 주장을 구분해 주세요.',
    );
  if (data.complete === false)
    warnings.push(
      '현재 결과가 전체 선택 범위/페이지에 대해 완전하지 않습니다.',
    );
  if (data.scope_complete === false)
    warnings.push('선택한 일부 자료를 읽지 못했습니다.');
  if (data.truncated === true)
    warnings.push('조회 한도에 도달한 부분 결과입니다.');
  const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
  if (skipped > 0)
    warnings.push(`누락·읽기 실패 ${skipped}개를 상세에서 확인해 주세요.`);
  if (data.requires_refresh === true)
    warnings.push('목록 기준이 변경되었습니다. 처음부터 다시 조회해 주세요.');
  return warnings;
}

/** 실제 인용/이유만 요약하며 많은 항목은 원형 상세에서 계속 확인할 수 있습니다. */
export function evidenceTexts(value: KnowledgeValue): string[] {
  const output: string[] = [];
  let inspected = 0;
  const walk = (entry: KnowledgeJson, depth: number): void => {
    if (depth > 6 || inspected++ > 200 || output.length >= 16) return;
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item, depth + 1);
      return;
    }
    const record = object(entry);
    if (!record) return;
    for (const [key, item] of Object.entries(record)) {
      if (
        [
          'quote',
          'reason',
          'evidence',
          'statement',
          'message',
          'snippet',
        ].includes(key) &&
        typeof item === 'string' &&
        item.length > 0 &&
        !output.includes(item)
      )
        output.push(item);
      else if (item !== null && typeof item === 'object') walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return output;
}

/** 같은 이름의 개체는 ID를 함께 표시하며 실제 그래프의 이름만 사용합니다. */
function entityDisplayName(graph: KnowledgeValue, id: string): string {
  const entities = objectList(graph.entities);
  const entity = entities.find(
    (value: KnowledgeValue): boolean => value.id === id,
  );
  const label = entity ? stringField(entity, 'label') : null;
  if (!label) return id;
  return entities.filter(
    (value: KnowledgeValue): boolean => value.label === label,
  ).length > 1
    ? `${label} (${id})`
    : label;
}

/** 지도는 같은 문서 안의 실제 개체 ID만 연결하고 동명 개체를 병합하지 않습니다. */
export function responseGraph(
  data: KnowledgeValue,
  limit: number = 20,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const graphs: { document: string; graph: KnowledgeValue }[] = [];
  if (Array.isArray(data.entities))
    graphs.push({ document: stringField(data, 'document') || '', graph: data });
  for (const document of objectList(data.documents)) {
    const graph = object(document.effective_graph) || object(document.graph);
    if (graph)
      graphs.push({
        document: stringField(document, 'document') || '',
        graph: {
          ...graph,
          source_revision: document.source_revision ?? null,
          graph_revision: document.graph_revision ?? null,
          state_revision: document.state_revision ?? null,
        },
      });
  }
  const mapContext = object(data.map_context);
  if (graphs.length === 0 && mapContext)
    for (const entry of objectList(mapContext.nodes))
      graphs.push({
        document: stringField(entry, 'document') || '',
        graph: entry,
      });
  for (const entry of graphs) {
    const reference: KnowledgeValue = {
      kind: 'document',
      reference: entry.document,
      source_revision: entry.graph.source_revision ?? null,
      graph_revision: entry.graph.graph_revision ?? null,
      state_revision: entry.graph.state_revision ?? null,
    };
    const layer =
      stringField(entry.graph, 'layer') ||
      stringField(data, 'layer') ||
      'reviewed';
    for (const entity of objectList(entry.graph.entities)) {
      const id = stringField(entity, 'id');
      const label = stringField(entity, 'label');
      if (!id || !label) continue;
      const key = JSON.stringify([entry.document, id]);
      if (!nodes.some((node: GraphNode): boolean => node.key === key))
        nodes.push({
          key,
          id,
          label,
          document: entry.document,
          row: {
            key: `entity:${key}`,
            title: label,
            kind: 'entities',
            summary: '',
            status: layer,
            document: entry.document,
            target: null,
            value: { ...entity, ref: reference },
          },
        });
    }
    for (const collection of ['relations', 'relation_candidates'])
      for (const relation of objectList(entry.graph[collection])) {
        const subject =
          typeof relation.subject === 'string' ? relation.subject : null;
        const target =
          typeof relation.object === 'string' ? relation.object : null;
        if (subject && target) {
          const key = JSON.stringify([
            entry.document,
            collection,
            edges.length,
          ]);
          edges.push({
            key,
            subject: JSON.stringify([entry.document, subject]),
            object: JSON.stringify([entry.document, target]),
            label: stringField(relation, 'predicate') || '관계',
            candidate: collection === 'relation_candidates',
            row: {
              key: `relation:${key}`,
              title: assertionTitle({
                ...relation,
                subject: entityDisplayName(entry.graph, subject),
                object: entityDisplayName(entry.graph, target),
              }),
              kind: collection,
              summary: '',
              status:
                collection === 'relation_candidates' ? '미확정 후보' : layer,
              document: entry.document,
              target: null,
              value: { ...relation, ref: reference },
            },
          });
        }
      }
  }
  const visible = nodes.slice(0, limit);
  return {
    nodes: visible,
    edges: edges.filter(
      (edge: GraphEdge): boolean =>
        visible.some((node: GraphNode): boolean => node.key === edge.subject) &&
        visible.some((node: GraphNode): boolean => node.key === edge.object),
    ),
    totalNodes: nodes.length,
  };
}
