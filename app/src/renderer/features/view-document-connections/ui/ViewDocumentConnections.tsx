import type { JSX } from 'react';
import { isDocumentPath } from '@contracts/documents.contract';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useDocumentConnections } from '../model/useDocumentConnections';
import type {
  ConnectionEdge,
  DocumentConnectionsModel,
} from '../model/useDocumentConnections';
import type {
  ConnectionsInput,
  ConnectionEntity,
  DocumentImpact,
  DocumentConnections,
  ExplicitDocumentLink,
  SharedConceptCandidate,
} from '../api/documentConnections.api';
import styles from './ViewDocumentConnections.module.scss';

export type ViewDocumentConnectionsProps = ConnectionsInput & {
  onOpenDocument: (document: string) => void;
  onScopeInvalidated: () => void;
};
type EntityEvidenceProps = { entity: ConnectionEntity; title: string };
type SelectedEvidenceProps = {
  model: DocumentConnectionsModel;
  onOpenDocument: (document: string) => void;
};
type ImpactDetailsProps = {
  data: DocumentImpact;
  onOpenDocument: (document: string) => void;
};

/** 서버의 JSON 객체만 좁히고 인용/출처 값을 조합해 새 사실을 만들지 않습니다. */
function object(value: KnowledgeJson | undefined): KnowledgeValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** 표준 문자열 필드만 간단히 표시하고 그 밖의 값은 원형 상세로 보존합니다. */
function stringField(value: KnowledgeValue, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null;
}

/** 현재/과거 근거 상태를 서버 원문 값에 따라 구분합니다. */
function referenceLabel(value: KnowledgeJson | undefined): string {
  if (value === 'current_snapshot') return '현재 판본의 근거';
  if (value === 'historical_action') return '과거 검토·업무 판단의 근거';
  if (value === 'historical_source') return '과거 원문 판본의 근거';
  return typeof value === 'string' ? value : '현재 연결 조회의 개체 근거';
}

/** 개체의 실제 인용·ID·원문 판본·출처를 양쪽 문서별로 유지합니다. */
function EntityEvidence({ entity, title }: EntityEvidenceProps): JSX.Element {
  const evidence = object(entity.evidence);
  const quote =
    typeof entity.evidence === 'string'
      ? entity.evidence
      : evidence && typeof evidence.quote === 'string'
        ? evidence.quote
        : null;
  return (
    <section className={styles.entityEvidence}>
      <h4>{title}</h4>
      <strong>
        {entity.label} · {entity.type}
      </strong>
      <p>{referenceLabel(entity.reference_status)}</p>
      {quote && <blockquote>{quote}</blockquote>}
      <dl>
        <dt>문서</dt>
        <dd>{entity.document}</dd>
        <dt>개체 ID</dt>
        <dd>{entity.id}</dd>
        <dt>원문 판본</dt>
        <dd>{entity.source_revision}</dd>
        {typeof entity.graph_revision === 'string' && (
          <>
            <dt>그래프 판본</dt>
            <dd>{entity.graph_revision}</dd>
          </>
        )}
        {typeof entity.origin === 'string' && (
          <>
            <dt>근거 출처</dt>
            <dd>{entity.origin}</dd>
          </>
        )}
        {typeof entity.event_id === 'string' && (
          <>
            <dt>이벤트</dt>
            <dd>{entity.event_id}</dd>
          </>
        )}
      </dl>
      <details>
        <summary>개체의 전체 근거·한정 정보</summary>
        <pre>{JSON.stringify(entity, null, 2)}</pre>
      </details>
    </section>
  );
}

/** 명시 링크는 원문에서 검증한 줄과 링크 주소를 표시하고 외부 탐색으로 실행하지 않습니다. */
function LinkDetails({ link }: { link: ExplicitDocumentLink }): JSX.Element {
  return (
    <>
      <p>
        {link.direction === 'outgoing'
          ? '이 문서에서 다른 문서를 참조'
          : '다른 문서가 이 문서를 참조'}
      </p>
      {link.change === 'removed' && (
        <StatusNotice tone="warning" title="이전 원문에 있던 연결">
          현재 연결에서 제거된 과거 근거입니다.
        </StatusNotice>
      )}
      <dl>
        <dt>참조 문서</dt>
        <dd>{link.source_document}</dd>
        <dt>참조 원문 판본</dt>
        <dd>{link.source_revision}</dd>
        <dt>대상 문서</dt>
        <dd>{link.target_document}</dd>
        <dt>대상 원문 판본</dt>
        <dd>{link.target_revision || '확인되지 않음'}</dd>
        <dt>대상 상태</dt>
        <dd>{link.target_status}</dd>
        <dt>원문 위치</dt>
        <dd>
          {link.evidence.start_line}–{link.evidence.end_line}줄 ·{' '}
          {link.evidence.scope}
        </dd>
        <dt>원문 링크</dt>
        <dd>{link.href}</dd>
        {link.fragment && (
          <>
            <dt>참조 절</dt>
            <dd>{link.fragment}</dd>
          </>
        )}
        {link.origin && (
          <>
            <dt>근거 시점</dt>
            <dd>{link.origin}</dd>
          </>
        )}
      </dl>
    </>
  );
}

/** 선택한 링크/후보를 원문 근거와 분리된 상세로 표시합니다. */
function SelectedEvidence({
  model,
  onOpenDocument,
}: SelectedEvidenceProps): JSX.Element {
  const edge = model.selected;
  if (!edge)
    return (
      <aside className={styles.evidence} aria-label="선택 연결의 근거">
        <h3>연결 근거</h3>
        <p>
          지도나 목록에서 연결을 선택하면 양쪽 문서와 근거 판본을 확인할 수
          있습니다.
        </p>
      </aside>
    );
  const canOpen =
    isDocumentPath(edge.peerDocument) &&
    (edge.kind === 'candidate' ||
      edge.link.direction === 'incoming' ||
      edge.link.target_status === 'resolved');
  return (
    <aside className={styles.evidence} aria-label="선택 연결의 근거">
      <header>
        <h3>
          {edge.kind === 'explicit' ? '명시 링크 근거' : '공통 개념 후보 근거'}
        </h3>
        <Button
          variant="secondary"
          onClick={(): void => onOpenDocument(edge.peerDocument)}
          disabled={!canOpen}
        >
          현재 문서 열기
        </Button>
      </header>
      {edge.kind === 'explicit' ? (
        <>
          <LinkDetails link={edge.link} />
          {model.excerpt.status === 'loading' && (
            <p>같은 판본의 원문 인용을 확인하고 있습니다.</p>
          )}
          {model.excerpt.status === 'ready' &&
            (model.excerpt.data.status === 'matched' ? (
              <blockquote>{model.excerpt.data.quote}</blockquote>
            ) : (
              <StatusNotice tone="warning" title="당시 인용 확인 안내">
                {model.excerpt.data.message}
              </StatusNotice>
            ))}
          {model.excerpt.status === 'error' && (
            <StatusNotice tone="warning" title="원문 인용 조회 안내">
              {model.excerpt.error.message}
            </StatusNotice>
          )}
          <details>
            <summary>링크 전체 정보</summary>
            <pre>{JSON.stringify(edge.link, null, 2)}</pre>
          </details>
        </>
      ) : (
        <>
          <StatusNotice title="이름·유형이 같은 후보">
            같은 개체나 의미 의존으로 확정하지 않았습니다. 양쪽 개체와 근거를
            따로 확인해 주세요.
          </StatusNotice>
          <EntityEvidence
            title="기준 문서의 개체"
            entity={edge.candidate.source_entity}
          />
          <EntityEvidence
            title="연결 후보 문서의 개체"
            entity={edge.candidate.target_entity}
          />
        </>
      )}
    </aside>
  );
}

/** 후보 한 건을 동일성/의존성 사실로 승격하지 않고 실제 두 출처를 보존합니다. */
function ImpactCandidate({
  candidate,
}: {
  candidate: SharedConceptCandidate;
}): JSX.Element {
  return (
    <details className={styles.impactReference}>
      <summary>
        {candidate.target_entity.document} · {candidate.source_entity.label} /{' '}
        {candidate.target_entity.label} · 미확정 후보
      </summary>
      <EntityEvidence
        title="기준 개체의 근거"
        entity={candidate.source_entity}
      />
      <EntityEvidence
        title="다른 문서 개체의 근거"
        entity={candidate.target_entity}
      />
      <p>동일 개체·의미 의존·현재 사실로 확정하지 않았습니다.</p>
    </details>
  );
}

/** 제한된 직접 영향과 복원 가능성·현재/과거 근거를 구분해 표시합니다. */
function ImpactDetails({
  data,
  onOpenDocument,
}: ImpactDetailsProps): JSX.Element {
  const changeLabels: Record<string, string> = {
    source: '원문',
    graph: '그래프',
    review: '검토·정책',
    history: '원문 이력',
  };
  return (
    <section className={styles.impact} aria-label="문서 변경 영향">
      <h3>변경 영향 안내</h3>
      <StatusNotice
        tone={
          data.change_status === 'changed' || !data.complete
            ? 'warning'
            : 'info'
        }
        title={
          data.baseline_status === 'not_compared'
            ? '비교 기준 없이 현재 연결만 조회했습니다'
            : data.change_status === 'changed'
              ? '비교 기준 이후 판본 변경이 관측됐습니다'
              : data.change_status === 'unknown'
                ? '일부 판본의 변경 여부를 확인할 수 없습니다'
                : '비교 기준과 관측한 판본이 같습니다'
        }
      >
        직접 연결 한 단계의 제한된 안내입니다. 전체 의미 영향이나 내용 오류를
        확정하지 않으며 재추출·정책 적용을 실행하지 않습니다.
      </StatusNotice>
      <p className={styles.caption}>
        기준 문서: 그래프{' '}
        {stringField(data.root, 'ontology_status') || '확인 불가'} · 검토{' '}
        {stringField(data.root, 'review_status') || '확인 불가'} ·{' '}
        {data.root.needs_review === true
          ? '문서 자체 재검토 필요'
          : '문서 자체 재검토 표시 없음'}{' '}
        ·{' '}
        {data.root.policy_pending === true
          ? '전문가 판단 적용 대기'
          : '전문가 판단 대기 표시 없음'}
      </p>
      <div className={styles.changes}>
        {Object.entries(data.changes).map(
          ([key, changed]: [string, boolean | null]): JSX.Element => (
            <p key={key}>
              <strong>{changeLabels[key] || key}</strong> ·{' '}
              {changed === true
                ? '변경 관측'
                : changed === false
                  ? '판본 일치'
                  : '비교하지 않음/확인 불가'}
            </p>
          ),
        )}
      </div>
      {(!data.complete || data.truncated || data.skipped.length > 0) && (
        <StatusNotice tone="warning" title="불완전한 영향 조회">
          완료 상태: {data.complete ? '한도 내 완료' : '미완료'} · 조회 제한:{' '}
          {data.truncated ? '있음' : '없음'} · 읽지 못한 항목{' '}
          {data.skipped.length}개. 빈 결과를 전체 영향 없음으로 해석하지 마세요.
        </StatusNotice>
      )}
      <section>
        <h4>관련 문서의 재검토 권고</h4>
        {data.documents.length === 0 && (
          <p>이번 제한된 조회에서 반환된 관련 문서가 없습니다.</p>
        )}
        <ul className={styles.related}>
          {data.documents.map(
            (document: DocumentImpact['documents'][number]): JSX.Element => (
              <li key={document.document}>
                <strong>{document.document}</strong>
                <p>
                  원문 {document.source_status} · 그래프{' '}
                  {document.ontology_status} · 검토 {document.review_status}
                </p>
                <p>
                  {document.needs_review
                    ? '재검토 필요 상태'
                    : '문서 자체의 재검토 표시 없음'}{' '}
                  ·{' '}
                  {document.policy_pending
                    ? '전문가 판단 적용 대기'
                    : '전문가 판단 대기 표시 없음'}
                </p>
                <p>
                  현재 상태 조회:{' '}
                  {document.state_available ? '확인됨' : '확인 불가'} · 안내:{' '}
                  {document.recommendation} · 내용 오류{' '}
                  {document.content_error_confirmed
                    ? '확인됨'
                    : '확정하지 않음'}
                </p>
                <p>권고 근거: {document.reasons.join(', ')}</p>
                <Button
                  variant="secondary"
                  onClick={(): void => onOpenDocument(document.document)}
                  disabled={
                    !isDocumentPath(document.document) ||
                    document.source_status !== 'available'
                  }
                >
                  현재 문서 열기
                </Button>
                <details>
                  <summary>관련 문서의 전체 판본·상태</summary>
                  <pre>{JSON.stringify(document, null, 2)}</pre>
                </details>
              </li>
            ),
          )}
        </ul>
      </section>
      <section>
        <h4>명시 링크 · 현재/과거 근거</h4>
        {data.explicit_links.length === 0 && (
          <p>반환된 명시 링크가 없습니다.</p>
        )}
        {data.explicit_links.map(
          (link: ExplicitDocumentLink, index: number): JSX.Element => (
            <details
              key={`${index}:${link.source_document}:${link.target_document}`}
              className={styles.impactReference}
            >
              <summary>
                {link.source_document} → {link.target_document} ·{' '}
                {link.change === 'removed'
                  ? '과거 원문에서 제거된 연결'
                  : '현재 연결'}
              </summary>
              <LinkDetails link={link} />
            </details>
          ),
        )}
      </section>
      <section>
        <h4>공통 개념 후보 · 동일성 미확정</h4>
        {data.candidates.length === 0 && (
          <p>이번 범위에서 반환된 후보가 없습니다.</p>
        )}
        {data.candidates.map(
          (candidate: SharedConceptCandidate, index: number): JSX.Element => (
            <ImpactCandidate
              key={`${index}:${candidate.source_entity.id}:${candidate.target_entity.id}`}
              candidate={candidate}
            />
          ),
        )}
      </section>
      <details>
        <summary>과거 근거 복원 가능성</summary>
        <dl>
          <dt>원문</dt>
          <dd>{data.restoration.source}</dd>
          <dt>기계 그래프</dt>
          <dd>{data.restoration.graph}</dd>
          <dt>검토·정책 이력</dt>
          <dd>{data.restoration.review}</dd>
          <dt>복원 범위 확인</dt>
          <dd>
            {data.restoration.complete
              ? '제공된 범위에서 확인됨'
              : '일부 확인 불가'}
          </dd>
        </dl>
        <p>제한: {data.restoration.limits.join(', ')}</p>
      </details>
      <details>
        <summary>영향 조회의 전체 기준·누락·현재 상태</summary>
        <pre>
          {JSON.stringify(
            {
              baseline: data.baseline,
              current: {
                source_revision: data.source_revision,
                graph_revision: data.graph_revision,
                review_revision: data.review_revision,
                history_revision: data.history_revision,
                state_revision: data.state_revision,
              },
              root: data.root,
              scope: data.scope,
              skipped: data.skipped,
              restoration: data.restoration,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}

/** 실제 연결 지도와 선택 근거·변경 영향만 조립하고 자료를 수정하지 않습니다. */
function DocumentConnectionsSession(
  props: ViewDocumentConnectionsProps,
): JSX.Element {
  const model = useDocumentConnections(props);
  const data =
    model.connections.status === 'ready' ? model.connections.data : null;
  const edges = model.edges;
  return (
    <section className={styles.workspace} aria-label="문서 연결">
      <header className={styles.heading}>
        <div>
          <h2>문서 연결</h2>
          <p>본문에 작성된 명시 링크와 공통 이름·유형 후보를 구분합니다.</p>
        </div>
        <Button
          variant="secondary"
          onClick={model.refresh}
          disabled={model.connections.status === 'loading'}
        >
          연결 새로고침
        </Button>
      </header>
      {model.connections.status === 'loading' && (
        <StatusNotice title="문서 연결을 불러오고 있습니다">
          같은 작업 공간의 실제 연결 근거를 확인합니다.
        </StatusNotice>
      )}
      {model.connections.status === 'error' && (
        <StatusNotice tone="error" title="문서 연결을 확인하지 못했습니다">
          {model.connections.error.message}
        </StatusNotice>
      )}
      {data && (
        <>
          <p className={styles.caption}>
            기계층 연결 · 명시 링크 {data.explicit_links.length}개 · 이름·유형
            후보 {data.candidates.length}개 · 원문 판본 {data.source_revision}
          </p>
          {(data.truncated || data.skipped.length > 0) && (
            <StatusNotice tone="warning" title="일부 연결만 조회했습니다">
              조회 제한: {data.truncated ? '있음' : '없음'} · 읽지 못한 항목{' '}
              {data.skipped.length}개. 현재 결과를 전체 연결로 해석하지 마세요.
            </StatusNotice>
          )}
          <div className={styles.connectionsGrid}>
            <section className={styles.mapSection}>
              {edges.length === 0 ? (
                <StatusNotice title="이번 범위에서 반환된 연결이 없습니다">
                  기계 그래프 미생성·오래된 상태와 조회 제한을 함께 확인해
                  주세요.
                </StatusNotice>
              ) : (
                <>
                  <div
                    className={styles.map}
                    style={{ height: Math.max(210, edges.length * 76 + 24) }}
                    role="group"
                    aria-label="문서 연결 지도"
                  >
                    <svg
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {edges.map(
                        (edge: ConnectionEdge, index: number): JSX.Element => (
                          <path
                            key={edge.key}
                            className={
                              edge.kind === 'candidate'
                                ? styles.candidatePath
                                : undefined
                            }
                            d={`M 41 50 C 51 50,49 ${((index + 0.5) / edges.length) * 100},59 ${((index + 0.5) / edges.length) * 100}`}
                          />
                        ),
                      )}
                    </svg>
                    <div className={styles.current} title={props.document}>
                      {props.document}
                    </div>
                    {edges.map(
                      (edge: ConnectionEdge, index: number): JSX.Element => (
                        <button
                          className={styles.peer}
                          type="button"
                          key={edge.key}
                          aria-pressed={model.selected?.key === edge.key}
                          onClick={(): void => model.select(edge)}
                          style={{
                            top: `${((index + 0.5) / edges.length) * 100}%`,
                          }}
                          title={edge.peerDocument}
                        >
                          <span>{edge.peerDocument}</span>
                          <small>
                            {edge.kind === 'candidate'
                              ? '공통 개념 후보 · 동일성 미확정'
                              : edge.link.direction === 'outgoing'
                                ? '이 문서에서 참조 →'
                                : '← 이 문서를 참조'}
                          </small>
                        </button>
                      ),
                    )}
                  </div>
                  <p className={styles.caption}>
                    실선: 본문 명시 링크 · 점선: 이름·유형 일치 후보. 후보를
                    자동 병합하거나 동일 개체로 확정하지 않습니다.
                  </p>
                </>
              )}
              <ul className={styles.connectionList} aria-label="문서 연결 목록">
                {edges.map((edge: ConnectionEdge): JSX.Element => (
                  <li key={edge.key}>
                    <button
                      type="button"
                      aria-pressed={model.selected?.key === edge.key}
                      onClick={(): void => model.select(edge)}
                    >
                      <strong>{edge.peerDocument}</strong>
                      <span>
                        {edge.kind === 'explicit'
                          ? `명시 링크 · ${edge.link.direction === 'outgoing' ? '나가는 참조' : '들어오는 참조'}`
                          : `후보 · ${edge.candidate.source_entity.label} / ${edge.candidate.target_entity.label}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <SelectedEvidence
              model={model}
              onOpenDocument={props.onOpenDocument}
            />
          </div>
          <details>
            <summary>조회한 문서의 기계 그래프 상태</summary>
            <ul className={styles.states}>
              {data.ontology_states.map(
                (
                  item: DocumentConnections['ontology_states'][number],
                  index: number,
                ): JSX.Element => (
                  <li key={`${item.document}:${index}`}>
                    <strong>{item.document}</strong>
                    <span>
                      {item.status}
                      {item.needs_reextraction === true ? ' · 재추출 필요' : ''}
                    </span>
                    <small>
                      {item.source_revision || '원문 판본 확인 불가'}
                    </small>
                  </li>
                ),
              )}
            </ul>
            {data.skipped.length > 0 && (
              <pre>{JSON.stringify(data.skipped, null, 2)}</pre>
            )}
          </details>
        </>
      )}
      <section className={styles.baseline} aria-label="영향 비교 기준">
        <header>
          <h3>변경 영향</h3>
          <Button
            variant="secondary"
            onClick={model.resetBaseline}
            disabled={model.baselineBusy}
          >
            현재 지식을 비교 기준으로 읽기
          </Button>
          <Button
            onClick={model.queryImpact}
            disabled={model.impact.status === 'loading' || model.baselineBusy}
          >
            변경 영향 확인
          </Button>
        </header>
        <p>
          비교 기준은 저장 권한이나 CAS를 대신하지 않습니다. 이 안내는 자동
          재추출·검토·정책 재적용을 실행하지 않습니다.
        </p>
        {model.baseline ? (
          <details>
            <summary>처음 읽은 지식의 비교 기준 판본</summary>
            <pre>{JSON.stringify(model.baseline, null, 2)}</pre>
          </details>
        ) : (
          <p>
            비교 기준이 없어 변경을 추정하지 않습니다. 영향 조회는 현재 연결만
            안내합니다.
          </p>
        )}
        {model.baselineError && (
          <StatusNotice tone="warning" title="비교 기준 안내">
            {model.baselineError}
          </StatusNotice>
        )}
      </section>
      {model.impact.status === 'loading' && (
        <StatusNotice title="변경 영향을 확인하고 있습니다">
          제한된 직접 연결과 현재/과거 근거를 조회합니다.
        </StatusNotice>
      )}
      {model.impact.status === 'error' && (
        <StatusNotice tone="error" title="변경 영향 조회 안내">
          {model.impact.error.message}
        </StatusNotice>
      )}
      {model.impact.status === 'ready' && (
        <ImpactDetails
          data={model.impact.data}
          onOpenDocument={props.onOpenDocument}
        />
      )}
    </section>
  );
}

/** 연결/관점/문서가 바뀌면 이전 선택과 늦은 응답을 새 범위에서 사용하지 않습니다. */
export function ViewDocumentConnections(
  props: ViewDocumentConnectionsProps,
): JSX.Element {
  return (
    <DocumentConnectionsSession
      key={JSON.stringify([
        props.connectionId,
        props.scope.userId,
        props.scope.tenant,
        props.scope.profileId,
        props.scope.policyRevision,
        props.document,
      ])}
      {...props}
    />
  );
}
