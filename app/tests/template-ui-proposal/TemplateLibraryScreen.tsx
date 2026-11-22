import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, SubmitEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../src/renderer/shared/ui/Button';
import { Icon } from '../../src/renderer/shared/ui/Icon';
import { WorkspaceSection } from '../../src/renderer/shared/ui/WorkspaceSection';
import { DocumentChipPopover } from '../../src/renderer/features/manage-document-content/ui/DocumentChipPopover';
import { HeaderActions } from '../../src/renderer/shared/lib/headerActions';
import { useWorkspaceActivity } from '../../src/renderer/shared/lib/workspaceActivity';
import library from '../../src/renderer/features/browse-document-library/ui/DocumentLibrary.module.scss';
import registration from '../../src/renderer/features/import-document-content/ui/ImportDocumentContent.module.scss';
import registerPage from '../../src/renderer/pages/register/RegisterDocumentPage.module.scss';
import document from '../../src/renderer/features/manage-document-content/ui/ManageDocumentContent.module.scss';
import chips from '../../src/renderer/features/manage-document-content/ui/DocumentChips.module.scss';
import { templateFileType } from './ReusableTemplateModel';
import type { SavedTemplate, TemplateDraft } from './ReusableTemplateModel';
import { TemplateList } from './TemplateList';

type LibraryView = 'list' | 'detail' | 'edit' | 'new';
export type TemplateLibraryScreenProps = {
  templates: SavedTemplate[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSave: (id: string | null, draft: TemplateDraft) => void;
  onUse: (id: string) => void;
  onViewChange?: (view: LibraryView, title: string) => void;
  listRequest?: string;
  initialEdit?: boolean;
};
const draftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '템플릿 이름을 입력해 주세요.')
    .max(60, '60자 이내로 입력해 주세요.'),
  fileName: z.string().min(1, '양식 파일을 선택해 주세요.'),
  rules: z.string(),
  example: z.boolean(),
});
type DraftValues = z.infer<typeof draftSchema>;
const pageSize = 20;

/** 신규 양식은 파일과 룰을 채우기 전의 빈 입력으로 시작합니다. */
function blankDraft(): DraftValues {
  return { name: '', fileName: '', rules: '', example: false };
}

/** 실제 목록·등록·본문 편집의 구조를 재사용하고 템플릿의 파일과 룰만 바꿔 표시합니다. */
export function TemplateLibraryScreen({
  templates,
  selectedId,
  onSelect,
  onSave,
  onUse,
  onViewChange,
  listRequest = '',
  initialEdit = false,
}: TemplateLibraryScreenProps): JSX.Element {
  const initialTemplate = initialEdit
    ? (templates.find(
        (item: SavedTemplate): boolean => item.id === selectedId,
      ) ?? templates[0])
    : undefined;
  const [view, setView] = useState<LibraryView>(
    initialTemplate ? 'edit' : 'list',
  );
  const [editingId, setEditingId] = useState<string | null>(
    initialTemplate?.id ?? null,
  );
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [lastOpenedId, setLastOpenedId] = useState('');
  const [preservedDraftIds, setPreservedDraftIds] = useState<string[]>([]);
  const drafts = useRef(new Map<string, DraftValues>());
  const fileInput = useRef<HTMLInputElement>(null);
  const fileButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const lastOpened = useRef<HTMLLIElement>(null);
  const restorePosition = useRef(false);
  const active = useWorkspaceActivity();
  const selected =
    templates.find((item: SavedTemplate): boolean => item.id === selectedId) ??
    templates[0];
  const form = useForm<DraftValues>({
    resolver: zodResolver(draftSchema),
    defaultValues: initialTemplate
      ? {
          name: initialTemplate.name,
          fileName: initialTemplate.fileName,
          rules: initialTemplate.rules,
          example: initialTemplate.example,
        }
      : blankDraft(),
  });
  const fileName = useWatch({ control: form.control, name: 'fileName' });
  const templateName = useWatch({ control: form.control, name: 'name' });
  const example = useWatch({ control: form.control, name: 'example' });
  const editing = view === 'edit' || view === 'new';
  const unsaved =
    (editing && form.formState.isDirty) ||
    !!(selected && preservedDraftIds.includes(selected.id));
  /** 저장본과 다른 입력만 초안으로 보관해 읽기 화면에 미저장 상태를 남깁니다. */
  function preserveDraft(): boolean {
    const values = form.getValues();
    const saved =
      templates.find(
        (template: SavedTemplate): boolean => template.id === editingId,
      ) ?? blankDraft();
    const changed =
      values.name !== saved.name ||
      values.fileName !== saved.fileName ||
      values.rules !== saved.rules ||
      values.example !== saved.example;
    if (changed) drafts.current.set(editingId ?? 'new', values);
    else drafts.current.delete(editingId ?? 'new');
    setPreservedDraftIds([...drafts.current.keys()]);
    return changed;
  }
  const previousListRequest = useRef(listRequest);
  const returnToList = useEffectEvent((): void => {
    const preserved = editing && preserveDraft();
    setView('list');
    setNotice(preserved ? '작성 중인 내용은 유지됩니다.' : '');
    onViewChange?.('list', '템플릿');
  });
  useEffect((): void => {
    if (listRequest && listRequest !== previousListRequest.current)
      returnToList();
    previousListRequest.current = listRequest;
  }, [listRequest]);
  useEffect((): void => {
    if (
      view === 'list' &&
      active &&
      restorePosition.current &&
      lastOpened.current
    ) {
      restorePosition.current = false;
      lastOpened.current.focus({ preventScroll: true });
      lastOpened.current.scrollIntoView({ block: 'center' });
    }
  }, [view, active]);
  const formats = [
    ...new Set(
      templates.map((template: SavedTemplate): string =>
        templateFileType(template.fileName),
      ),
    ),
  ].sort();
  const keyword = searchedQuery.trim().toLocaleLowerCase();
  const matches = templates.filter(
    (template: SavedTemplate): boolean =>
      (filter === 'all' || templateFileType(template.fileName) === filter) &&
      (!keyword ||
        `${template.name}\n${template.fileName}\n${template.rules}`
          .toLocaleLowerCase()
          .includes(keyword)),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(matches.length / pageSize) - 1),
  );
  const visible = searchedQuery
    ? matches
    : matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  /** 화면 제목은 앱의 경로 제목에 전달하고 본문에는 반복하지 않습니다. */
  function changeView(next: LibraryView, nextTitle: string): void {
    setView(next);
    onViewChange?.(next, nextTitle);
  }
  /** 목록의 선택 위치를 보존하고 명시한 대상의 상세를 표시합니다. */
  function openDetail(template: SavedTemplate): void {
    onSelect(template.id);
    setLastOpenedId(template.id);
    restorePosition.current = true;
    changeView('detail', template.name);
    setNotice('');
  }
  /** 편집 대상별 초안이 있으면 저장본보다 먼저 복원합니다. */
  function openEditor(template: SavedTemplate | null): void {
    const key = template?.id ?? 'new';
    const saved = template
      ? {
          name: template.name,
          fileName: template.fileName,
          rules: template.rules,
          example: template.example,
        }
      : blankDraft();
    form.reset(drafts.current.get(key) ?? saved);
    setEditingId(template?.id ?? null);
    changeView(
      template ? 'edit' : 'new',
      template ? template.name : '템플릿 등록',
    );
    setNotice('');
  }
  /** 복귀해도 파일명과 룰 초안은 현재 시안에서 유지합니다. */
  function leaveEditor(): void {
    const preserved = preserveDraft();
    changeView(
      editingId ? 'detail' : 'list',
      editingId ? (selected?.name ?? '템플릿') : '템플릿',
    );
    setNotice(preserved ? '작성 중인 내용은 유지됩니다.' : '');
  }
  /** 저장된 묶음을 공유 목록에 반영한 뒤 상세로 돌아갑니다. */
  function save(values: DraftValues): void {
    onSave(editingId, values);
    drafts.current.delete(editingId ?? 'new');
    setPreservedDraftIds([...drafts.current.keys()]);
    changeView('detail', values.name);
    setNotice('시안에서 저장했습니다. AI 채팅에서 선택할 수 있습니다.');
  }
  /** 파일 본문을 읽거나 전송하지 않고 선택한 이름만 반영합니다. */
  function chooseFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) {
      form.setValue('fileName', file.name, {
        shouldDirty: true,
        shouldValidate: true,
      });
      form.setValue('example', false, { shouldDirty: true });
    }
    event.target.value = '';
  }
  /** Enter를 누를 때만 이름·파일명·룰 전체에서 검색합니다. */
  function applySearch(): void {
    setSearchedQuery(query.trim());
    setPage(0);
  }
  /** 실제 목록의 초기화 동작처럼 검색과 필터를 함께 되돌립니다. */
  function resetSearch(): void {
    setQuery('');
    setSearchedQuery('');
    setFilter('all');
    setPage(0);
    searchInput.current?.focus();
  }
  /** 이름 입력과 오류 표시는 등록·편집에서 같은 필드를 사용합니다. */
  function nameField(): JSX.Element {
    return (
      <div className={registration.field}>
        <label htmlFor="template-name">템플릿 이름</label>
        <input
          id="template-name"
          placeholder="템플릿을 알아보기 쉬운 이름"
          required
          {...form.register('name')}
          aria-invalid={!!form.formState.errors.name}
          aria-describedby={
            form.formState.errors.name ? 'template-name-error' : undefined
          }
        />
        {form.formState.errors.name && (
          <small id="template-name-error" className={registration.error}>
            {form.formState.errors.name.message}
          </small>
        )}
      </div>
    );
  }
  /** 편집에서는 이름을 먼저 보여 주고 등록에서는 기존 파일 선택 순서를 유지합니다. */
  function metadataFields(nameFirst: boolean = false): JSX.Element {
    return (
      <>
        {nameFirst && nameField()}
        <div className={registration.dropZone}>
          <Icon
            name="file-text"
            size={20}
            className={registration.uploadIcon}
          />
          <div className={registration.fileContent}>
            <h3>{fileName || '가져올 양식 파일'}</h3>
            <small>
              {fileName
                ? example
                  ? '예시 양식'
                  : '파일명만 반영 · 내용 확인 미연결'
                : '문서, 슬라이드, 시트, PDF, 이미지 등'}
            </small>
          </div>
          <Button
            type="button"
            variant="surface"
            ref={fileButton}
            className={registration.button}
            aria-describedby={
              form.formState.errors.fileName ? 'template-file-error' : undefined
            }
            onClick={(): void => fileInput.current?.click()}
          >
            {fileName ? '파일 다시 선택' : '파일 선택'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            aria-label="양식 파일 선택"
            hidden
            onChange={chooseFile}
          />
          {form.formState.errors.fileName && (
            <p
              id="template-file-error"
              className={registration.error}
              role="alert"
            >
              {form.formState.errors.fileName.message}
            </p>
          )}
        </div>
        {!nameFirst && nameField()}
      </>
    );
  }
  /** 자연어 지침은 입력값을 그대로 보존합니다. */
  function ruleField(): JSX.Element {
    return (
      <div className={registration.field}>
        <label htmlFor="template-rules">지침</label>
        <textarea
          id="template-rules"
          {...form.register('rules')}
          aria-describedby="template-rules-hint"
          placeholder={
            '각 화면에 목적과 예외 상태를 포함하세요.\n근거가 없는 내용은 임의로 확정하지 말고 질문하세요.'
          }
        />
        <small id="template-rules-hint">
          AI 채팅에서 이 템플릿을 선택하면 함께 적용됩니다.
        </small>
      </div>
    );
  }
  /** 신규 등록은 실제 원본 등록의 입력·완료 행동 구조를 유지합니다. */
  function fields(): JSX.Element {
    return (
      <fieldset className={registration.fields}>
        <legend className={registration.srOnly}>템플릿 등록 입력</legend>
        <WorkspaceSection title="템플릿 입력">
          {metadataFields()}
          {ruleField()}
        </WorkspaceSection>
      </fieldset>
    );
  }
  if (view === 'list')
    return (
      <section className={library.library} aria-label="템플릿 등록 및 관리">
        {notice && <p role="status">{notice}</p>}
        <HeaderActions>
          <Button
            type="button"
            className={library.primary}
            onClick={(): void => openEditor(null)}
          >
            <Icon name="plus" />
            템플릿 등록
          </Button>
        </HeaderActions>
        {templates.length > 0 && (
          <section className={library.finder} aria-label="템플릿 찾기">
            <div className={library.toolbar}>
              <form
                className={library.search}
                onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
                  event.preventDefault();
                  applySearch();
                }}
                role="search"
              >
                <label className={library.searchInput}>
                  <Icon name="search" />
                  <input
                    ref={searchInput}
                    aria-label="템플릿 검색"
                    placeholder="템플릿 이름이나 내용으로 검색 (Enter)"
                    value={query}
                    maxLength={200}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setQuery(event.target.value)
                    }
                    onKeyDown={(
                      event: KeyboardEvent<HTMLInputElement>,
                    ): void => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applySearch();
                      }
                    }}
                  />
                </label>
              </form>
              <div className={library.tools}>
                <label>
                  <span className={library.srOnly}>템플릿 형식 필터</span>
                  <select
                    aria-label="템플릿 형식 필터"
                    value={filter}
                    onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                      setFilter(event.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="all">전체 템플릿</option>
                    {formats.map((format: string): JSX.Element => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </section>
        )}
        {templates.length === 0 ? (
          <div className={library.state}>
            <span className={library.symbol} aria-hidden="true">
              <Icon name="file-text" size={24} />
            </span>
            <h2>첫 템플릿을 등록해 보세요</h2>
            <p>양식 파일과 지침을 함께 저장하세요.</p>
            <Button
              type="button"
              className={library.primary}
              onClick={(): void => openEditor(null)}
            >
              템플릿 등록
            </Button>
          </div>
        ) : (
          <>
            {searchedQuery && (
              <div className={library.resultLine} aria-live="polite">
                <span>“{searchedQuery}” 검색 결과</span>
                <span>템플릿 {matches.length}개</span>
              </div>
            )}
            {visible.length > 0 ? (
              <TemplateList
                templates={visible}
                lastOpenedId={lastOpenedId}
                onOpen={openDetail}
                lastOpenedRef={lastOpened}
              />
            ) : (
              <div className={library.state}>
                <span className={library.symbol} aria-hidden="true">
                  <Icon name="search" size={24} />
                </span>
                <h2>검색 결과가 없습니다</h2>
                <p>
                  {searchedQuery
                    ? `“${searchedQuery}”와 현재 필터에 일치하는 템플릿을 찾지 못했습니다.`
                    : '현재 페이지에서 선택한 조건에 맞는 템플릿이 없습니다.'}
                </p>
                <p>검색어를 바꾸거나 필터를 초기화해 주세요.</p>
                <Button
                  variant="surface"
                  type="button"
                  className={library.button}
                  onClick={resetSearch}
                >
                  검색 조건 초기화
                </Button>
              </div>
            )}
            {!searchedQuery && (
              <nav className={library.pagination} aria-label="템플릿 페이지">
                <Button
                  type="button"
                  variant="surface"
                  className={`${library.button} ${library.pageButton}`}
                  aria-label="이전 페이지"
                  disabled={currentPage === 0}
                  onClick={(): void => setPage(currentPage - 1)}
                >
                  <Icon name="chevron-right" className={library.flipIcon} />
                </Button>
                <b aria-current="page">{currentPage + 1}</b>
                <Button
                  type="button"
                  variant="surface"
                  className={`${library.button} ${library.pageButton}`}
                  aria-label="다음 페이지"
                  disabled={(currentPage + 1) * pageSize >= matches.length}
                  onClick={(): void => setPage(currentPage + 1)}
                >
                  <Icon name="chevron-right" />
                </Button>
              </nav>
            )}
          </>
        )}
      </section>
    );
  if (view === 'new')
    return (
      <main className={registerPage.page}>
        <div className={registerPage.grid}>
          <section aria-label="템플릿 등록 및 관리">
            <form
              className={registration.form}
              noValidate
              onSubmit={(event: SubmitEvent<HTMLFormElement>): void =>
                event.preventDefault()
              }
            >
              {fields()}
              <div className={registration.actions}>
                <span className={registration.caption}>
                  양식 파일과 지침을 함께 저장합니다.
                </span>
                <Button
                  type="button"
                  className={`${registration.button} ${registration.primary}`}
                  disabled={!fileName || !templateName.trim()}
                  onClick={(): void => {
                    void form.handleSubmit(save)();
                  }}
                >
                  템플릿 등록
                </Button>
              </div>
            </form>
          </section>
        </div>
      </main>
    );
  if (!selected)
    return (
      <section className={document.state} aria-label="템플릿 선택 필요">
        <span className={document.documentSymbol}>
          <Icon name="file-text" size={24} />
        </span>
        <h1>읽을 템플릿을 선택해 주세요</h1>
        <Button
          variant="surface"
          type="button"
          className={document.button}
          onClick={(): void => changeView('list', '템플릿')}
        >
          템플릿 목록으로
        </Button>
      </section>
    );
  return (
    <section
      className={document.root}
      data-layout={view === 'edit' ? 'work' : 'reading'}
      aria-label="템플릿 등록 및 관리"
    >
      <HeaderActions>
        {view === 'edit' ? (
          <div className={document.actions}>
            <Button
              type="button"
              variant="surface"
              className={document.button}
              onClick={leaveEditor}
            >
              취소
            </Button>
            <Button
              type="button"
              className={document.primaryButton}
              onClick={(): void => {
                void form.handleSubmit(save)();
              }}
            >
              저장
            </Button>
          </div>
        ) : (
          <>
            <Button
              type="button"
              variant="surface"
              className={document.button}
              onClick={(): void => openEditor(selected ?? null)}
            >
              편집
            </Button>
            <Button
              type="button"
              className={document.primaryButton}
              disabled={!selected}
              onClick={(): void => {
                if (selected) onUse(selected.id);
              }}
            >
              AI 채팅에서 사용
            </Button>
          </>
        )}
      </HeaderActions>
      {unsaved && (
        <div className={document.eyebrow}>
          <span className={document.badge}>미저장 초안 있음</span>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {view === 'edit' ? (
        <section className={document.editor} aria-label="템플릿 편집">
          <div className={document.editToolbar}>
            <div className={chips.editHeader}>
              <strong>수정 중</strong>
            </div>
          </div>
          <form
            className={document.editor}
            noValidate
            onSubmit={(event: SubmitEvent<HTMLFormElement>): void =>
              event.preventDefault()
            }
          >
            {metadataFields(true)}
            {ruleField()}
            <div className={document.footer}>
              <span className={document.hint}>
                저장하지 않은 초안은 시안을 닫으면 사라집니다.
              </span>
            </div>
          </form>
        </section>
      ) : (
        <>
          <div className={chips.chipRow}>
            <DocumentChipPopover
              icon="info"
              label="템플릿 정보"
              popoverLabel="템플릿 정보"
            >
              {(): JSX.Element => (
                <dl>
                  <dt>파일명</dt>
                  <dd>{selected.fileName}</dd>
                  <dt>형식</dt>
                  <dd>{templateFileType(selected.fileName)}</dd>
                  {!selected.example && (
                    <>
                      <dt>확인 상태</dt>
                      <dd>내용 확인 필요</dd>
                    </>
                  )}
                </dl>
              )}
            </DocumentChipPopover>
          </div>
          <section className={document.documentBody} aria-label="템플릿 본문">
            <article className={document.markdown} aria-label="지침">
              {selected.rules.trim() ? (
                <>
                  <h2>지침</h2>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{selected.rules}</p>
                </>
              ) : (
                <div className={document.empty}>
                  <h2>지침이 없습니다</h2>
                  <p>
                    편집에서 이 양식에 함께 적용할 지침을 작성할 수 있습니다.
                  </p>
                </div>
              )}
            </article>
          </section>
        </>
      )}
    </section>
  );
}
