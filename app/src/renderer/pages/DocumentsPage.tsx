import { PageNavigation } from '@renderer/shared/ui/PageNavigation';
import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import type { JSX } from 'react';
import type { DocumentContent } from '@contracts/documents.contract';
import { ListDocuments } from '@renderer/features/list-documents';
import type {
  DocumentAnalysisSelection,
  DocumentRegistrationContext,
  DocumentPanelContext,
} from '@renderer/features/list-documents';
import { ConvertSource } from '@renderer/features/convert-source';
import { RegisterSource } from '@renderer/features/register-source';
import { RunSourceAnalysis } from '@renderer/features/run-source-analysis';
import { ViewDocumentKnowledge } from '@renderer/features/view-document-knowledge';
import { ManageSourceVersions } from '@renderer/features/manage-source-versions';
import type { NewSourceVersion } from '@renderer/features/manage-source-versions';
import { ViewDocumentHistory } from '@renderer/features/view-document-history';
import type { DocumentRestoreOutcome } from '@renderer/features/view-document-history';
import { EditWikiDocument } from '@renderer/features/edit-wiki-document';
import type { DocumentSaveOutcome } from '@renderer/features/edit-wiki-document';
import { Dialog } from '@renderer/shared/ui/Dialog';
import type {
  SourceConversionReference,
  ConversionSource,
} from '@contracts/sourceConversion.contract';
import { SaveCleanupNotice } from '@renderer/shared/ui/SaveCleanupNotice';
import { ReviewDialog } from '@renderer/features/review-document-knowledge';
import type {
  ReviewSelection,
  ReviewScope,
} from '@renderer/features/review-document-knowledge';
import { ViewDocumentConnections } from '@renderer/features/view-document-connections';

/** 기능 간 직접 참조를 만들지 않고 페이지에서 등록 동선과 목록 갱신을 연결합니다. */
function registration(context: DocumentRegistrationContext): JSX.Element {
  return (
    <RegisterSource
      key={JSON.stringify([context.connectionId, context.tenant])}
      {...context}
    />
  );
}

/** 문서 목록 feature의 공개 진입점만 화면에 조립합니다. */
export function DocumentsPage(): JSX.Element {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  /** 저장 영수증으로 확인한 변환 판본만 다음 질문의 명시 근거로 넘깁니다. */
  function questionFromConversion(reference: SourceConversionReference): void {
    const query = new URLSearchParams({
      sourceId: reference.sourceId,
      sourceVersion: reference.sourceVersion,
      sourceSha256: reference.sourceSha256,
      conversionId: reference.conversionId,
      conversionRevision: reference.conversionRevision,
    });
    void navigate(`/conversations?${query.toString()}`);
  }
  const initialDocument = search.get('document') || undefined;
  const [analysisSource, setAnalysisSource] =
    useState<DocumentAnalysisSelection | null>(null);
  const [editing, setEditing] = useState<{
    current: DocumentContent;
    onSaved: () => void;
  } | null>(null);
  const [reviewing, setReviewing] = useState<{
    selection: ReviewSelection;
    connectionId: string;
    scope: ReviewScope;
    onScopeInvalidated: () => void;
  } | null>(null);
  const [knowledgeRefresh, setKnowledgeRefresh] = useState(0);
  const [versioning, setVersioning] = useState<{
    target: NewSourceVersion;
    context: DocumentPanelContext;
  } | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const [conversion, setConversion] = useState<{
    source: ConversionSource;
    context: DocumentPanelContext;
  } | null>(null);
  const [cleanupWarningCount, setCleanupWarningCount] = useState(0);

  /** 문서 패널은 각 기능의 공개 입력/결과만 페이지에서 연결합니다. */
  function panel(context: DocumentPanelContext): JSX.Element | null {
    const { item, scope, onScopeInvalidated } = context;
    if (context.tab === 'conversion' && item.kind === 'source') {
      return (
        <ConvertSource
          key={`${scope.connectionId}:${item.sourceId}:${item.sourceVersion}`}
          source={{
            sourceId: item.sourceId,
            sourceVersion: item.sourceVersion,
            sourceSha256: item.sourceSha256,
            registrationRevision: item.registrationRevision,
          }}
          scope={scope}
          onQuestion={questionFromConversion}
          allowed={scope.canRegisterSource}
          onScopeInvalidated={onScopeInvalidated}
        />
      );
    }
    if (context.tab === 'versions') {
      if (item.kind === 'source')
        return (
          <ManageSourceVersions
            sourceId={item.sourceId}
            selectedVersion={item.sourceVersion}
            scope={scope}
            onScopeInvalidated={onScopeInvalidated}
            onConvert={(source: ConversionSource): void =>
              setConversion({ source, context })
            }
            onPreview={context.onPreview}
            onOpenDocument={context.onOpenDocument}
            onNewVersion={(target: NewSourceVersion): void => {
              setVersioning({ target, context });
              setVersionOpen(true);
            }}
          />
        );
      return (
        <ViewDocumentHistory
          document={item.document}
          connectionId={scope.connectionId}
          scope={scope}
          allowed={scope.canEditWiki}
          onRestored={(outcome: DocumentRestoreOutcome): void => {
            setCleanupWarningCount(outcome.cleanupWarningCount);
            context.onOpenDocument(item.document);
          }}
          onScopeInvalidated={onScopeInvalidated}
        />
      );
    }
    if (item.kind !== 'wiki') return null;
    if (context.tab === 'knowledge')
      return (
        <ViewDocumentKnowledge
          key={`${item.document}:${knowledgeRefresh}`}
          document={item.document}
          connectionId={scope.connectionId}
          scope={scope}
          onScopeInvalidated={onScopeInvalidated}
          onReview={(selection: ReviewSelection): void =>
            setReviewing({
              selection,
              connectionId: scope.connectionId,
              scope,
              onScopeInvalidated,
            })
          }
        />
      );
    if (context.tab === 'connections')
      return (
        <ViewDocumentConnections
          document={item.document}
          connectionId={scope.connectionId}
          scope={scope}
          onOpenDocument={context.onOpenDocument}
          onScopeInvalidated={onScopeInvalidated}
        />
      );
    return null;
  }
  return (
    <>
      <ListDocuments
        navigation={
          <PageNavigation
            links={[
              { to: '/correspondences', label: '조건·개념 대응' },
              { to: '/comparisons', label: '변경 비교' },
            ]}
          />
        }
        key={initialDocument || 'catalogue'}
        initialDocument={initialDocument}
        renderRegistration={registration}
        onAnalyzeSource={setAnalysisSource}
        renderPanel={panel}
        onEditDocument={(current: DocumentContent, onSaved: () => void): void =>
          setEditing({ current, onSaved })
        }
      />
      {conversion && (
        <Dialog
          open
          title="고정 원본의 문자 변환"
          onOpenChange={(open: boolean): void => {
            if (!open) setConversion(null);
          }}
        >
          <ConvertSource
            source={conversion.source}
            onQuestion={questionFromConversion}
            scope={conversion.context.scope}
            allowed={conversion.context.scope.canRegisterSource}
            onScopeInvalidated={(): void => {
              conversion.context.onScopeInvalidated();
              setConversion(null);
            }}
          />
        </Dialog>
      )}
      {analysisSource ? (
        <RunSourceAnalysis
          key={JSON.stringify(analysisSource)}
          source={analysisSource}
          onClose={(): void => setAnalysisSource(null)}
        />
      ) : null}
      {editing && (
        <EditWikiDocument
          current={editing.current}
          allowed
          onClose={(): void => setEditing(null)}
          onSaved={(outcome: DocumentSaveOutcome): void => {
            setCleanupWarningCount(outcome.cleanupWarningCount);
            editing.onSaved();
            setEditing(null);
          }}
          onScopeInvalidated={(): void => {
            editing.onSaved();
            setEditing(null);
          }}
        />
      )}
      {reviewing && (
        <ReviewDialog
          selection={reviewing.selection}
          connectionId={reviewing.connectionId}
          scope={reviewing.scope}
          onChanged={(count: number): void => {
            setCleanupWarningCount(count);
            setKnowledgeRefresh((value: number): number => value + 1);
            setReviewing(null);
          }}
          onClose={(): void => setReviewing(null)}
          onScopeInvalidated={(): void => {
            reviewing.onScopeInvalidated();
            setReviewing(null);
          }}
        />
      )}
      {versioning && (
        <RegisterSource
          key={`${versioning.target.sourceId}:${versioning.target.expectedRegistrationRevision}`}
          connectionId={versioning.context.scope.connectionId}
          tenant={versioning.context.scope.tenant}
          allowed={versioning.context.scope.canRegisterSource}
          expectedScope={{
            userId: versioning.context.scope.userId,
            tenant: versioning.context.scope.tenant,
            profileId: versioning.context.scope.profileId,
            policyRevision: versioning.context.scope.policyRevision,
          }}
          versionTarget={{
            sourceId: versioning.target.sourceId,
            expectedRegistrationRevision:
              versioning.target.expectedRegistrationRevision,
          }}
          initialTitle={versioning.target.title}
          openOnMount
          controlledOpen={versionOpen}
          onRegistered={versioning.context.onUpdated}
          onScopeInvalidated={versioning.context.onScopeInvalidated}
          onClose={(): void => setVersionOpen(false)}
        />
      )}
      {cleanupWarningCount > 0 && (
        <SaveCleanupNotice
          count={cleanupWarningCount}
          onClose={(): void => setCleanupWarningCount(0)}
        />
      )}
    </>
  );
}
