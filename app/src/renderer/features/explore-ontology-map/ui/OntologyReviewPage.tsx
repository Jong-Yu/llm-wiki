import { useState } from 'react';
import type { JSX } from 'react';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { Tabs } from '@renderer/shared/ui/Tabs';
import type {
  CorrectionBasis,
  CorrectionReceipt,
} from '../model/ontologyMap.types';
import { useOntologyDecision } from '../model/useOntologyDecision';
import { OntologyAssertionDetails } from './OntologyAssertionDetails';
import { OntologyReferencePane } from './OntologyReferencePane';
import {
  OntologySourceReviewForm,
  OntologyExpertPolicyForm,
} from './OntologyReviewForms';
import { OntologyReviewHistory } from './OntologyReviewHistory';
import styles from './OntologyMapWorkspace.module.scss';
import { useOntologyTaskFocus } from '../model/useOntologyTaskFocus';

type OntologyReviewPageProps = {
  basis: CorrectionBasis;
  open: boolean;
  onClose: () => void;
  onSaved: (receipt: CorrectionReceipt) => void;
  onInvalidate: () => void;
  onDiscard: () => void;
};

/** 읽은 근거·초안은 닫기와 탭 전환에도 유지하고 저장 후 새 검토는 다시 읽게 합니다. */
export function OntologyReviewPage({
  basis,
  open,
  onClose,
  onSaved,
  onInvalidate,
  onDiscard,
}: OntologyReviewPageProps): JSX.Element {
  const focusAnchor = useOntologyTaskFocus(open);
  const [tab, setTab] = useState(
    basis.assertion.claim?.authored_event_id ? 'history' : 'review',
  );
  const model = useOntologyDecision(basis, onSaved, onInvalidate);
  const knowledge = basis.assertion.knowledge;
  const claim = basis.assertion.claim;
  const authored = !!claim?.authored_event_id;
  const canWrite =
    knowledge.status === 'ready' &&
    knowledge.machineGraph.needs_reextraction !== true &&
    !claim?.ambiguous &&
    !!knowledge.claims.find(
      (item: (typeof knowledge.claims)[number]): boolean =>
        item.claim_id === claim?.claim_id,
    );
  const props = {
    basis,
    blocked: model.blocked || !canWrite,
    onSubmit: model.submit,
  };
  return (
    <WorkspacePage
      hidden={!open}
      onBack={onClose}
      title="관계 검토"
      backLabel="초안 보관하고 돌아가기"
      className={styles.taskPage}
    >
      <div ref={focusAnchor}>
        <OntologyAssertionDetails
          assertion={basis.assertion}
          section="summary"
        />
      </div>
      {!canWrite && !authored && (
        <p className={styles.notice}>
          현재 원문·추출 기준에서 저장할 수 없습니다. 과거 기록을 조회하고 최신
          추출을 확인해 주세요.
        </p>
      )}
      {model.state.phase === 'error' && (
        <div role="alert" className={styles.error}>
          <strong>
            {model.state.error.code === 'outcome_unknown'
              ? '저장 여부를 확인하지 못했습니다.'
              : '판단을 기록하지 못했습니다.'}
          </strong>
          <p>{model.state.error.message}</p>
          {model.requestId && model.state.error.code === 'outcome_unknown' && (
            <button
              type="button"
              onClick={(): void => {
                if (model.requestId) void model.reconcile(model.requestId);
              }}
            >
              추가 요청 저장 여부 확인
            </button>
          )}
          <p>
            작성한 초안과 기준 버전을 보존했습니다. 충돌·응답 유실 뒤에는 새로
            조회한 기록과 대조해 주세요.
          </p>
        </div>
      )}
      {model.state.phase === 'saved' && (
        <div role="status" className={styles.notice}>
          <strong>판단이 저장되었습니다.</strong>
          {model.state.receipt.cleanupWarningCount > 0 && (
            <p>
              저장은 완료됐지만 임시 파일 정리 경고{' '}
              {model.state.receipt.cleanupWarningCount}건이 있습니다. 다시
              저장하지 마세요.
            </p>
          )}
        </div>
      )}
      <Tabs
        label="관계 검토 내용"
        value={tab}
        onValueChange={setTab}
        items={[
          ...(authored
            ? [
                {
                  id: 'information',
                  label: '관계 정보',
                  content: (
                    <OntologyAssertionDetails
                      assertion={basis.assertion}
                      section="information"
                    />
                  ),
                },
              ]
            : [
                {
                  id: 'review',
                  label: '원문 근거 검토',
                  content: (
                    <div
                      className={styles.taskComparison}
                      data-ontology-comparison
                    >
                      <OntologyReferencePane basis={basis} />
                      <section
                        className={styles.editorPane}
                        aria-label="원문 근거 검토"
                        data-ontology-editor
                      >
                        <h2>검토 결정</h2>
                        <OntologySourceReviewForm {...props} />
                      </section>
                    </div>
                  ),
                },
                ...(claim?.collection !== 'relation_candidates'
                  ? [
                      {
                        id: 'policy',
                        label: '전문가 업무 판단',
                        content: (
                          <div
                            className={styles.taskComparison}
                            data-ontology-comparison
                          >
                            <OntologyReferencePane basis={basis} />
                            <section
                              className={styles.editorPane}
                              aria-label="전문가 업무 판단"
                              data-ontology-editor
                            >
                              <h2>업무 판단</h2>
                              <OntologyExpertPolicyForm {...props} />
                            </section>
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]),
          {
            id: 'history',
            label: '검토 기록',
            content: (
              <OntologyReviewHistory
                assertion={basis.assertion}
                {...props}
                blocked={model.blocked}
              />
            ),
          },
        ]}
      />
      <div className={styles.actions}>
        <button
          type="button"
          disabled={model.state.phase === 'saving'}
          onClick={onDiscard}
        >
          {model.state.phase === 'saved' ? '검토 완료' : '검토 초안 버리기'}
        </button>
      </div>
    </WorkspacePage>
  );
}
