import { useId, useState } from 'react';
import type { ChangeEvent, JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { WorkspaceResponse } from '@contracts/workspace.contract';
import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { TextField } from '@renderer/shared/ui/TextField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useWorkspaceExplorer } from '../model/useWorkspaceExplorer';
import type { OnExplorerReview } from '../model/useWorkspaceExplorer';
import type {
  ExplorerMode,
  ExplorerValues,
} from '../model/explorerForm.schema';
import {
  responseRows,
  responseGraph,
  responseWarnings,
  statusLabel,
  object,
  stringField,
  kindLabel,
  eventDescription,
} from '../model/explorerPresentation';
import type { ExplorerRow, GraphNode } from '../model/explorerPresentation';
import { ExplorerGraph } from './ExplorerGraph';
import { ExplorerInspector } from './ExplorerInspector';
import { ExplorerScopeForm } from './ExplorerScopeForm';
import styles from './WorkspaceExplorer.module.scss';

export type WorkspaceExplorerProps = {
  navigation?: ReactNode;
  mode: ExplorerMode;
  onReview?: OnExplorerReview;
  initialDocument?: string;
};

/** 실제 조회 기능에 맞는 화면 이름을 표시합니다. */
export function explorerTitle(mode: ExplorerMode): string {
  return {
    knowledge: '지식 탐색',
    review: '검토함',
    history: '변경 이력',
    questions: '질문 근거 준비',
  }[mode];
}

/** 선택 범위는 별도 창에서 유지하고 목록·지도·상세는 각각 독립적으로 읽습니다. */
export function WorkspaceExplorer({
  navigation,
  mode,
  onReview,
  initialDocument,
}: WorkspaceExplorerProps): JSX.Element {
  const model = useWorkspaceExplorer(mode);
  const formId = useId();
  const [selected, setSelected] = useState<{
    row: ExplorerRow;
    response: WorkspaceResponse;
  } | null>(null);
  const [focus, setFocus] = useState<{
    key: string;
    response: WorkspaceResponse;
  } | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeEdited, setScopeEdited] = useState(false);
  const [filter, setFilter] = useState('');
  const catalog =
    model.catalog.status === 'ready' ? model.catalog.catalog : null;
  const response =
    model.result.status === 'ready' ? model.result.response : null;
  const rows = response ? responseRows(response) : [];
  const graph =
    response && mode === 'knowledge'
      ? responseGraph(response.data, Infinity)
      : null;
  const indexRows = graph?.nodes.length
    ? graph.nodes.map((node: GraphNode): ExplorerRow => node.row)
    : rows;
  const visibleRows = indexRows.filter((row: ExplorerRow): boolean =>
    `${row.title} ${row.summary} ${row.document || ''}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase()),
  );
  const active =
    selected && selected.response === response
      ? selected.row
      : indexRows[0] || null;
  const focusKey =
    focus?.response === response ? focus.key : graph?.nodes[0]?.key;
  const warnings = response ? responseWarnings(response.data) : [];
  const locked = model.busy || model.result.status === 'loading';
  const reviewable =
    !!active &&
    active.kind === 'document_claim' &&
    !scopeEdited &&
    !!object(active.value.claim) &&
    !!onReview;
  const nextCursor = response
    ? stringField(response.data, 'next_cursor')
    : null;
  const indexTitle = {
    knowledge: graph?.nodes.length ? '개념 탐색' : '발견한 개념·근거',
    review: '검토할 주장',
    history: '검토·변경 기록',
    questions: '선택한 질문 근거',
  }[mode];
  const description = {
    knowledge: '개념을 선택하고 연결과 원문 근거를 확인합니다.',
    review: '저장된 주장을 원문과 대조하고 판단을 남깁니다.',
    history: '선택한 자료에 기록된 변경과 당시의 판단을 확인합니다.',
    questions: '문서·원본·주장을 선택해 질문에 사용할 근거를 준비합니다.',
  }[mode];

  /** 새 범위 조회는 이전 목록 선택을 해제하지만 입력 초안은 보존합니다. */
  function query(values: ExplorerValues): void {
    setSelected(null);
    setFocus(null);
    setFilter('');
    setScopeEdited(false);
    setScopeOpen(false);
    model.query(values);
  }
  /** 발견 결과의 판본 참조를 그대로 조회하며 지도 개체 선택은 표시만 바꿉니다. */
  function selectRow(row: ExplorerRow): void {
    if (!response) return;
    setSelected({ row, response });
    if (row.kind === 'entities') {
      const node = graph?.nodes.find(
        (item: GraphNode): boolean => item.row.key === row.key,
      );
      if (node) setFocus({ key: node.key, response });
    } else if (mode === 'knowledge' && row.target && !scopeEdited && !locked) {
      setFilter('');
      model.queryTarget(row.target);
    }
  }
  const notices = (
    <>
      {model.catalog.status === 'loading' && (
        <StatusNotice title="자료 목록을 읽고 있습니다">
          현재 허용된 문서와 원본을 확인합니다.
        </StatusNotice>
      )}
      {model.catalog.status === 'error' && (
        <StatusNotice tone="error" title="조회 범위를 확인해 주세요">
          <p>{model.catalog.error.message}</p>
          <Link to="/setup/connection">서버 연결·작업 공간 선택</Link>
        </StatusNotice>
      )}
      {model.result.status === 'loading' && (
        <StatusNotice title="선택 범위를 조회하고 있습니다">
          선택한 자료의 저장 결과를 불러옵니다.
        </StatusNotice>
      )}
      {model.result.status === 'error' && model.catalog.status !== 'error' && (
        <StatusNotice tone="error" title="조회 결과를 확인하지 못했습니다">
          <p>{model.result.error.message}</p>
          {model.result.error.traceId && (
            <p>문의 코드: {model.result.error.traceId}</p>
          )}
        </StatusNotice>
      )}
      {scopeEdited && response && (
        <StatusNotice tone="warning" title="조회 범위가 변경되었습니다">
          현재 보이는 내용은 이전 범위의 결과입니다. 자료 범위에서 다시 조회해
          주세요.
        </StatusNotice>
      )}
      {warnings.length > 0 && (
        <StatusNotice tone="warning" title="조회 범위·준비 상태 안내">
          <ul>
            {warnings.map((message: string): JSX.Element => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </StatusNotice>
      )}
      {model.claimError && (
        <StatusNotice tone="error" title="선택 기준 확인">
          {model.claimError}
        </StatusNotice>
      )}
    </>
  );
  /** 지도 목록은 문서별로 묶고 연결을 선택해도 중심 개념 표시를 유지합니다. */
  function renderRow(row: ExplorerRow): JSX.Element {
    const entity = row.kind === 'entities';
    const node = entity
      ? graph?.nodes.find(
          (entry: GraphNode): boolean => entry.row.key === row.key,
        )
      : null;
    return (
      <li key={row.key}>
        <button
          type="button"
          aria-pressed={node ? node.key === focusKey : active?.key === row.key}
          onClick={(): void => selectRow(row)}
        >
          <span className={styles.rowTop}>
            <strong>{row.title}</strong>
            {entity ? (
              <small>{stringField(row.value, 'id')}</small>
            ) : (
              row.status && (
                <span className={styles.badge}>{statusLabel(row.status)}</span>
              )
            )}
          </span>
          {row.summary && <span className={styles.summary}>{row.summary}</span>}
          {!entity && <small>{row.document || kindLabel(row.kind)}</small>}
          {mode === 'history' && <small>{eventDescription(row)}</small>}
        </button>
      </li>
    );
  }
  const groups = new Map<string, ExplorerRow[]>();
  if (graph?.nodes.length)
    for (const row of visibleRows) {
      const document = row.document || '현재 문서';
      const group = groups.get(document) || [];
      group.push(row);
      groups.set(document, group);
    }
  const index = (
    <aside className={styles.index} aria-label="조회 항목 탐색">
      <header>
        <div className={styles.rowTop}>
          <h2>{indexTitle}</h2>
          <span className={styles.caption}>{indexRows.length}개</span>
        </div>
        <TextField
          label="목록에서 찾기"
          placeholder={
            mode === 'knowledge' ? '개념 이름 찾기' : '제목·문서·이유 찾기'
          }
          value={filter}
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            setFilter(event.target.value)
          }
        />
      </header>
      <div className={styles.indexScroll}>
        {response ? (
          <ul
            className={styles.rows}
            data-concepts={!!graph?.nodes.length}
            aria-label="조회 항목 목록"
          >
            {graph?.nodes.length
              ? [...groups].map(
                  ([document, items]: [string, ExplorerRow[]]): JSX.Element => (
                    <li key={document} className={styles.conceptGroup}>
                      <details open>
                        <summary>
                          {document}
                          <span>{items.length}</span>
                        </summary>
                        <ul className={styles.rows}>{items.map(renderRow)}</ul>
                      </details>
                    </li>
                  ),
                )
              : visibleRows.map(renderRow)}
          </ul>
        ) : (
          <p className={styles.caption}>
            자료 범위를 선택하면 {indexTitle}을 표시합니다.
          </p>
        )}
        {response && visibleRows.length === 0 && (
          <p className={styles.caption}>
            {filter
              ? '입력한 단어와 일치하는 항목이 없습니다.'
              : '현재 조회 범위에 표시할 항목이 없습니다.'}
          </p>
        )}
      </div>
      <footer>
        {response && (nextCursor || model.canPrevious) ? (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              onClick={model.previous}
              disabled={!model.canPrevious || locked || scopeEdited}
            >
              이전 페이지
            </Button>
            <span>{model.pageNumber}</span>
            <Button
              variant="secondary"
              onClick={model.next}
              disabled={
                !nextCursor ||
                response.data.requires_refresh === true ||
                scopeEdited ||
                locked
              }
            >
              다음 페이지
            </Button>
          </div>
        ) : (
          <span>
            {response ? '현재 조회 범위의 항목' : '선택한 자료만 조회합니다'}
          </span>
        )}
      </footer>
    </aside>
  );
  const inspector = (
    <ExplorerInspector
      row={active}
      busy={locked || scopeEdited}
      presentation={mode === 'knowledge' ? 'inspector' : 'detail'}
      onQueryTarget={(target: KnowledgeValue): void => {
        setSelected(null);
        model.queryTarget(target);
      }}
      onReview={
        reviewable && active && onReview
          ? (): void => {
              void model.review(active, onReview);
            }
          : undefined
      }
    />
  );
  const metadata = response && (
    <details className={styles.scopeDetails}>
      <summary>조회 범위·판본·누락 상세</summary>
      <p>조회 관점 · {response.access.profileId}</p>
      <pre>
        {JSON.stringify(
          {
            scope: response.data.scope || response.data.selection,
            snapshot:
              response.data.snapshot_revision || response.data.view_revision,
            skipped: response.data.skipped,
            completeness: response.data.completeness,
            resource_manifest: response.data.resource_manifest,
            evaluation: response.data.evaluation,
            condition_evaluation: response.data.condition_evaluation,
            consistency: response.data.consistency,
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
  const empty = (
    <div className={styles.empty}>
      <h2>
        {mode === 'questions'
          ? '질문에 사용할 근거를 골라 주세요'
          : '자료를 선택해 탐색을 시작하세요'}
      </h2>
      <p>{description}</p>
      <Button onClick={(): void => setScopeOpen(true)} disabled={!catalog}>
        자료 범위 선택
      </Button>
    </div>
  );
  const content = (
    <section className={styles.results} aria-label="조회 결과">
      <header>
        <div>
          <h2>
            {mode === 'knowledge'
              ? graph?.nodes.find(
                  (node: GraphNode): boolean => node.key === focusKey,
                )?.label || '개념과 연결'
              : explorerTitle(mode)}
          </h2>
          <p className={styles.caption}>{description}</p>
        </div>
      </header>
      <div className={styles.resultScroll}>
        {notices}
        {model.result.status === 'idle' && empty}
        {response &&
          mode === 'knowledge' &&
          (graph?.nodes.length ? (
            <ExplorerGraph
              data={response.data}
              focusKey={focusKey}
              selectedKey={active?.key}
              onSelect={selectRow}
            />
          ) : (
            <div className={styles.empty}>
              <h2>
                {rows.length
                  ? '찾은 개념에서 연결을 살펴보세요'
                  : '일치하는 항목을 찾지 못했습니다'}
              </h2>
              <p>
                {rows.length
                  ? '왼쪽 항목을 선택하면 해당 판본을 기준으로 연결과 근거를 조회합니다.'
                  : '조회 범위와 검색어를 바꿔 다시 찾아보세요.'}
              </p>
              <Button
                variant="secondary"
                onClick={(): void => setScopeOpen(true)}
              >
                자료 범위 변경
              </Button>
            </div>
          ))}
        {response && mode === 'questions' && (
          <StatusNotice
            tone={response.data.can_prepare === true ? 'success' : 'warning'}
            title={
              response.data.can_prepare === true
                ? '질문 근거 준비 완료'
                : '질문 근거에 확인할 항목이 있습니다'
            }
          >
            원문·필수 문서·선택 주장의 판본을 확인했습니다. 현재 단계는 근거
            준비이며 AI 실행·대화 저장은 포함하지 않습니다.
          </StatusNotice>
        )}
        {response && mode !== 'knowledge' && inspector}
        {metadata}
      </div>
    </section>
  );
  return (
    <section
      className={styles.workspace}
      data-mode={mode}
      aria-label={explorerTitle(mode)}
    >
      <WorkspaceToolbar className={styles.toolbar}>
        <h1>{mode === 'knowledge' ? '개념과 연결' : explorerTitle(mode)}</h1>
        {catalog && <span>조회 관점 · {catalog.scope.profileId}</span>}
        <div className={styles.toolbarActions}>
          {navigation}
          <Button
            variant="secondary"
            disabled={!catalog || locked}
            onClick={(): void => setScopeOpen(true)}
          >
            {response ? '자료 범위 변경' : '자료 범위 선택'}
          </Button>
          <Button
            variant="secondary"
            disabled={locked}
            onClick={(): void => {
              setSelected(null);
              setFocus(null);
              setScopeEdited(false);
              setFilter('');
              model.reload();
            }}
          >
            자료 새로고침
          </Button>
        </div>
      </WorkspaceToolbar>
      {mode === 'knowledge' ? (
        <WorkspaceLayout
          className={styles.layout}
          labels={{ index: '개념', content: '연결 지도', inspector: '근거' }}
        >
          <WorkspacePane name="index">{index}</WorkspacePane>
          <WorkspacePane name="content">{content}</WorkspacePane>
          <WorkspacePane name="inspector">{inspector}</WorkspacePane>
        </WorkspaceLayout>
      ) : (
        <WorkspaceLayout
          className={styles.masterDetail}
          panes={['index', 'content']}
        >
          <WorkspacePane name="index">{index}</WorkspacePane>
          <WorkspacePane name="content">{content}</WorkspacePane>
        </WorkspaceLayout>
      )}
      {catalog && (
        <Dialog
          open={scopeOpen}
          onOpenChange={setScopeOpen}
          title="조회할 자료 선택"
          description="현재 관점에서 읽을 문서·원본을 선택합니다. 입력한 초안은 창을 닫아도 유지됩니다."
          className={styles.scopeDialog}
          actions={
            <Button type="submit" form={formId} disabled={locked}>
              {
                {
                  knowledge: '조회',
                  review: '검토 대상 조회',
                  history: '변경 이력 조회',
                  questions: '질문 근거 준비',
                }[mode]
              }
            </Button>
          }
        >
          <ExplorerScopeForm
            key={JSON.stringify(catalog.scope)}
            formId={formId}
            mode={mode}
            catalog={catalog}
            model={model}
            onSubmit={query}
            onScopeChange={(): void => setScopeEdited(true)}
            locked={locked}
            initialDocument={initialDocument}
          />
          {model.claimError && (
            <StatusNotice tone="error" title="선택 기준 확인">
              {model.claimError}
            </StatusNotice>
          )}
          {catalog.nextCursor && (
            <Button
              variant="secondary"
              disabled={locked}
              onClick={model.nextCatalog}
            >
              자료 목록 더 읽기
            </Button>
          )}
          {(catalog.truncated || catalog.skippedCount > 0) && (
            <StatusNotice tone="warning" title="자료 선택 목록 안내">
              탐색 한도 또는 읽기 실패가 있습니다. 현재 읽은 자료만 선택할 수
              있습니다.
            </StatusNotice>
          )}
        </Dialog>
      )}
    </section>
  );
}
