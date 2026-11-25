import type { AnalysisDetail, AnalysisJob } from '@contracts/analysis.contract';
import type { DocumentConversionAttempt } from '@contracts/documentTasks.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import type {
  DocumentTaskMeasurement,
  DocumentTaskStage,
  DocumentTaskState,
  DocumentTaskStep,
  DocumentTaskStepState,
  DocumentTaskView,
} from './documentTask.types';

type Conversion = SourceConversionRun | DocumentConversionAttempt;
type ProgressInput = {
  state: DocumentTaskState;
  detail: AnalysisDetail | null;
  job: AnalysisJob | null;
  targets: readonly string[];
  inputReady: boolean;
  conversionKnown: boolean;
  conversion: Conversion | null;
  format: string;
};
type ProgressView = Pick<
  DocumentTaskView,
  | 'steps'
  | 'activeStep'
  | 'completedStepCount'
  | 'completionLabel'
  | 'measurement'
  | 'operation'
> & { state: DocumentTaskState; status: string };

/** 대상의 현재 저장 영수증만 완료 근거로 사용하며 이전 본문 링크와 구별합니다. */
function stageSaved(
  detail: AnalysisDetail | null,
  targets: readonly string[],
  stage: 'prepare_wiki' | 'extract_ontology',
): boolean {
  return (
    targets.length > 0 &&
    targets.every((document: string): boolean =>
      (detail?.receipts ?? []).some(
        (item: AnalysisDetail['receipts'][number]): boolean =>
          item.state === 'complete' &&
          item.saved === true &&
          item.receipt?.document === document &&
          item.receipt.stage === stage &&
          item.current_output?.status === 'current',
      ),
    )
  );
}

/** 바이트 다운로드·제출 횟수는 변환 수량으로 표시하지 않습니다. */
function measurement(
  conversion: Conversion | null,
  format: string,
): DocumentTaskMeasurement | null {
  const progress = conversion?.progress;
  if (!progress || progress.stage !== 'convert') return null;
  const total =
    progress.total != null &&
    progress.total > 0 &&
    progress.total >= progress.completed
      ? progress.total
      : null;
  return {
    completed: progress.completed,
    total,
    percent:
      total === null ? null : Math.floor((progress.completed / total) * 100),
    remaining: total === null ? null : total - progress.completed,
    unit:
      format === 'pdf'
        ? '페이지'
        : format === 'ppt' || format === 'pptx'
          ? '슬라이드'
          : '단위',
  };
}

/** 전체 상태는 현재 미완료 단계에만 적용하고 나머지 단계는 대기로 남깁니다. */
function activeState(state: DocumentTaskState): DocumentTaskStepState {
  if (state === 'running') return 'current';
  if (state === 'partial') return 'failed';
  if (state === 'complete') return 'unconfirmed';
  return state;
}

/** 실측 변환과 단계별 저장 확인을 같은 순서로 투영하며 가짜 전체 비율을 만들지 않습니다. */
export function buildDocumentProgress(input: ProgressInput): ProgressView {
  const { detail, job, targets, inputReady, conversionKnown, conversion } =
    input;
  const wikiSaved = stageSaved(detail, targets, 'prepare_wiki');
  const ontologySaved = stageSaved(detail, targets, 'extract_ontology');
  const wikiRequested = job?.outputs.includes('wiki') ?? true;
  const ontologyRequested = job?.outputs.includes('ontology') ?? true;
  const requestedSaved =
    (!wikiRequested || wikiSaved) && (!ontologyRequested || ontologySaved);
  // 요약만 성공해도 대상 영수증을 읽기 전에는 저장 완료를 만들지 않습니다.
  const state =
    input.state === 'complete' && !requestedSaved ? 'unconfirmed' : input.state;
  const activeInput = job?.active_input_ref?.stage;
  const activeStep: DocumentTaskStage = !inputReady
    ? 'convert'
    : activeInput === 'extract_ontology' && !ontologySaved
      ? 'ontology'
      : wikiRequested && !wikiSaved
        ? 'wiki'
        : 'ontology';
  const current = activeState(state);
  const steps: DocumentTaskStep[] = [
    {
      id: 'convert',
      title: '문자 변환',
      state: !conversionKnown
        ? 'unavailable'
        : inputReady
          ? 'complete'
          : current,
      note: !conversionKnown
        ? '저장된 입력 사용 · 변환 기록 없음'
        : inputReady
          ? '등록할 내용 준비됨'
          : '원본에서 문자 읽기',
    },
    {
      id: 'wiki',
      title: 'Wiki 생성',
      state: wikiSaved
        ? 'complete'
        : !wikiRequested
          ? 'unavailable'
          : !inputReady
            ? 'waiting'
            : activeStep === 'wiki'
              ? current
              : 'unconfirmed',
      note: wikiSaved
        ? '현재 문서 저장 확인'
        : !wikiRequested
          ? '기존 문서 사용'
          : 'Wiki 저장 확인 전',
    },
    {
      id: 'ontology',
      title: '온톨로지 구성',
      state: ontologySaved
        ? 'complete'
        : !ontologyRequested
          ? 'unavailable'
          : inputReady && activeStep === 'ontology'
            ? current
            : 'waiting',
      note: ontologySaved
        ? '관계 저장 확인'
        : !ontologyRequested
          ? '이번 작업에 포함되지 않음'
          : '관계 저장 확인 전',
    },
  ];
  const completedStepCount = steps.filter(
    (step: DocumentTaskStep): boolean => step.state === 'complete',
  ).length;
  const phase =
    activeStep === 'convert'
      ? '문자 변환'
      : activeStep === 'wiki'
        ? 'Wiki 생성'
        : '온톨로지 구성';
  const statuses: Record<DocumentTaskState, string> = {
    ready: `${phase} 대기`,
    running: `${phase} 중`,
    failed: `${activeStep === 'ontology' ? '온톨로지' : phase} 중단`,
    partial: `${activeStep === 'ontology' ? '온톨로지' : phase} 중단`,
    review: '문자 확인 필요',
    unconfirmed: '저장 결과 확인 필요',
    complete: wikiRequested && ontologyRequested ? '등록 완료' : '저장 완료',
    stopped: `${activeStep === 'ontology' ? '온톨로지' : phase} 중단`,
  };
  const operation =
    state === 'complete'
      ? { title: '저장 확인 완료', note: '저장된 문서를 열어 볼 수 있습니다.' }
      : state === 'unconfirmed'
        ? {
            title: '저장 결과 확인 필요',
            note: '결과를 조회하며 같은 내용을 다시 저장하지 않습니다.',
          }
        : activeStep === 'convert'
          ? {
              title:
                state === 'review'
                  ? '변환 내용 보관됨'
                  : state !== 'running'
                    ? '등록할 내용 준비'
                    : conversion?.progress?.stage === 'submit'
                      ? '변환 내용 보관 중'
                      : conversion?.progress?.stage === 'download'
                        ? '원본 읽는 중'
                        : '등록할 내용 준비',
              note: '문자 변환이 끝나면 Wiki 생성을 진행합니다.',
            }
          : {
              title:
                activeStep === 'wiki'
                  ? 'Wiki 저장 확인 전'
                  : '관계 저장 확인 전',
              note:
                activeStep === 'wiki'
                  ? '등록할 내용으로 Wiki 문서를 만듭니다.'
                  : '문서의 개념과 관계를 구성합니다.',
            };
  return {
    state,
    status:
      requestedSaved && state === 'running'
        ? '저장 완료 · 실행 마무리 중'
        : statuses[state],
    steps,
    activeStep,
    completedStepCount,
    completionLabel: steps.some(
      (step: DocumentTaskStep): boolean => step.state === 'unavailable',
    )
      ? `확인된 ${completedStepCount}단계 완료`
      : `${completedStepCount} / 3단계 완료`,
    measurement: inputReady ? null : measurement(conversion, input.format),
    operation,
  };
}
