import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SourceFile } from '@contracts/sources.contract';
import type { ImportScope } from '@renderer/features/import-document-content/api/importRegistration.api';
import { ImportRegistrationSession } from '@renderer/features/import-document-content/model/ImportRegistrationSession';
import type { ImportRegistrationSnapshot } from '@renderer/features/import-document-content/model/ImportRegistrationSession';
import { importDocumentSchema } from '@renderer/features/import-document-content/model/importDocument.schema';
import type { ImportDocumentValues } from '@renderer/features/import-document-content/model/importDocument.schema';
import { ImportDocumentForm } from '@renderer/features/import-document-content/ui/ImportDocumentForm';
import styles from '@renderer/features/browse-ai-sessions/ui/AiSessions.module.scss';

type RegistrationPreviewProps = {
  onRegistered: (title: string, file: SourceFile | null) => void;
};

const scope: ImportScope = {
  connectionId: 'fixture',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: 'e'.repeat(64),
  canRegister: true,
  canPrepare: true,
  canExtract: true,
};

/** 모의 접수는 완료 영수증을 만들지 않고 화면 이동 콜백만 실행합니다. */
function bindRegistration(
  session: ImportRegistrationSession,
  onRegistered: RegistrationPreviewProps['onRegistered'],
): void {
  session.submit = async (values: ImportDocumentValues): Promise<void> => {
    const result = importDocumentSchema.safeParse(values);
    if (!result.success) return;
    session.updateDraft(result.data);
    onRegistered(
      result.data.title,
      result.data.kind === 'file' ? session.getSnapshot().file : null,
    );
  };
}

/** 실제 폼의 입력·검증은 유지하고 등록과 파일 선택만 메모리에서 모의합니다. */
function createPreviewSession(
  onRegistered: RegistrationPreviewProps['onRegistered'],
): ImportRegistrationSession {
  const session = new ImportRegistrationSession(scope);
  session.updateDraft({
    ...session.getSnapshot().draft,
    kind: 'text',
    title: '새 검토 자료',
    content:
      '# 시안용 샘플 문서\n\n이 본문은 등록 이후 작업 상세로 이동하는 흐름을 확인하기 위한 모의 자료입니다.',
  });
  const readOriginal = session.getSnapshot;
  const subscribeOriginal = session.subscribe;
  const listeners = new Set<() => void>();
  let selectedFile: SourceFile | null = null;
  let previousOriginal: ImportRegistrationSnapshot | null = null;
  let snapshot: ImportRegistrationSnapshot = readOriginal();

  // 원본 session의 완료 영수증을 만들지 않아 form의 후속 begin()은 실행되지 않습니다.
  session.getSnapshot = (): ImportRegistrationSnapshot => {
    const original = readOriginal();
    if (original !== previousOriginal || snapshot.file !== selectedFile) {
      previousOriginal = original;
      snapshot = {
        ...original,
        file: selectedFile,
        completed: null,
        notice: selectedFile
          ? '선택한 파일은 시안용 모의 PDF입니다. 실제 파일을 읽거나 서버로 전송하지 않습니다.'
          : '',
      };
    }
    return snapshot;
  };
  session.subscribe = (listener: () => void): (() => void) => {
    const stopOriginal = subscribeOriginal(listener);
    listeners.add(listener);
    return (): void => {
      stopOriginal();
      listeners.delete(listener);
    };
  };
  session.chooseFile = async (): Promise<SourceFile> => {
    selectedFile = {
      fileId: '7'.repeat(32),
      filename: '모의-샘플-문서.pdf',
      format: 'pdf',
      sizeBytes: 204800,
    };
    listeners.forEach((listener: () => void): void => listener());
    return selectedFile;
  };
  bindRegistration(session, onRegistered);
  return session;
}

/** 기존 등록 폼을 그대로 사용하며 접수 결과는 부모의 모의 작업 목록에만 연결합니다. */
export function RegistrationPreview({
  onRegistered,
}: RegistrationPreviewProps): JSX.Element {
  const [session] = useState<ImportRegistrationSession>(
    (): ImportRegistrationSession => createPreviewSession(onRegistered),
  );
  useEffect(
    (): void => bindRegistration(session, onRegistered),
    [session, onRegistered],
  );
  return (
    <div className={styles.root}>
      <ImportDocumentForm session={session} scope={scope} />
    </div>
  );
}
