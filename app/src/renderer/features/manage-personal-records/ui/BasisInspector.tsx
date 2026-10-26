import { useState } from 'react';
import type { JSX } from 'react';
import type { KnowledgeClaim } from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { claimLabel, jsonText, textValue } from '../model/personalRecords';
import type { BasisDocument, PersonalBasis } from '../model/personalRecords';
import { PersonalContent } from './PersonalContent';
import styles from './ManagePersonalRecords.module.scss';

type BasisInspectorProps = { basis: PersonalBasis | null; label: string };
/** 저장 당시 원문·추출·검토·관점을 현재값과 섞지 않고 보여 줍니다. */
export function BasisInspector({
  basis,
  label,
}: BasisInspectorProps): JSX.Element {
  const [chosen, setChosen] = useState('');
  const document =
    basis?.documents.find(
      (item: BasisDocument): boolean => item.document === chosen,
    ) || basis?.documents[0];
  return (
    <aside className={styles.inspector} aria-label="개인 기록의 근거">
      <header className={styles.panelHeader}>
        <h2>근거·작성 기준</h2>
        <span>{label}</span>
      </header>
      <div className={styles.inspectorBody}>
        {!basis ? (
          <div className={styles.empty}>
            질문·결과 또는 비교 기준을 선택하면 실제 저장된 근거가 표시됩니다.
          </div>
        ) : (
          <>
            <p className={styles.notice}>
              이 기준은 읽은 시점의 전체 스냅샷입니다. 현재 문서·정책과 같은지는
              확인하지 않았습니다.
            </p>
            <div className={styles.pills}>
              {basis.documents.map((item: BasisDocument): JSX.Element => (
                <Button
                  key={item.document}
                  variant="secondary"
                  aria-pressed={document?.document === item.document}
                  onClick={(): void => setChosen(item.document)}
                >
                  {item.document}
                </Button>
              ))}
            </div>
            {document && (
              <>
                <h3>{document.document}</h3>
                <details>
                  <summary>기준 판본과 관점</summary>
                  <dl>
                    <dt>원문 판본</dt>
                    <dd>{document.source_revision}</dd>
                    <dt>추출 판본</dt>
                    <dd>{document.knowledge.graph_revision || '추출 없음'}</dd>
                    <dt>검토 상태 판본</dt>
                    <dd>{document.knowledge.state_revision}</dd>
                  </dl>
                  <pre>{jsonText(basis.scope)}</pre>
                </details>
                <details open>
                  <summary>저장 당시 원문</summary>
                  <PersonalContent content={document.content} />
                </details>
                <details>
                  <summary>
                    당시 주장 {document.knowledge.claims.length}개
                  </summary>
                  {document.knowledge.claims.map(
                    (claim: KnowledgeClaim): JSX.Element => (
                      <article className={styles.claim} key={claim.claim_id}>
                        <strong>{claimLabel(claim.reviewed_value)}</strong>
                        <small>
                          {claim.collection} · 검토: {claim.decision}
                          {claim.needs_review ? ' · 검토 필요' : ''}
                        </small>
                        <details>
                          <summary>인용·조건·전체 주장</summary>
                          <pre>{jsonText(claim)}</pre>
                        </details>
                      </article>
                    ),
                  )}
                </details>
              </>
            )}
            {basis.originals?.map(
              (
                original: NonNullable<PersonalBasis['originals']>[number],
              ): JSX.Element => (
                <section
                  key={`${original.source_ref.source_id}:${original.source_ref.source_version}`}
                >
                  <h3>
                    고정 원본 ·{' '}
                    {textValue(original.manifest, 'title') ||
                      original.source_ref.source_id}
                  </h3>
                  <dl>
                    <dt>원본 판본</dt>
                    <dd>{original.source_ref.source_version}</dd>
                    <dt>바이트 해시</dt>
                    <dd>{original.source_ref.source_sha256}</dd>
                  </dl>
                  <details>
                    <summary>질문 당시 원본 문자·보고 위치</summary>
                    <PersonalContent content={original.content} />
                    <pre>{jsonText(original)}</pre>
                  </details>
                </section>
              ),
            )}
            <details>
              <summary>원본 자료·정책·선택을 포함한 전체 기준</summary>
              <pre>{jsonText(basis)}</pre>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
