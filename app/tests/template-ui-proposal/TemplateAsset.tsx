import { useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { FileInput, Link, PencilLine } from 'lucide-react';
import { Button } from '../../src/renderer/shared/ui/Button';
import { Field } from '../../src/renderer/shared/ui/Field';
import type { FieldControlProps } from '../../src/renderer/shared/ui/Field';
import { TextField } from '../../src/renderer/shared/ui/TextField';
import { SelectField } from '../../src/renderer/shared/ui/SelectField';
import controls from '../../src/renderer/shared/ui/FieldControl.module.scss';
import styles from './TemplateAsset.module.scss';

export type TemplateAsset = {
  kind:
    | 'slides'
    | 'document'
    | 'sheet'
    | 'reference'
    | 'text'
    | 'link'
    | 'unknown';
  name: string;
  output: string;
  mode: 'fill' | 'structure' | 'reference';
  status: 'example' | 'unverified';
};
export type TemplateAssetEditorProps = {
  value: TemplateAsset;
  onChange: (value: TemplateAsset) => void;
  text: string;
  onText: (text: string) => void;
  error?: string;
};
export type TemplateAssetPreviewProps = {
  value: TemplateAsset;
  compact?: boolean;
};
type AssetEntry = 'file' | 'link' | 'text';
type ExampleOption = { label: string; asset: TemplateAsset };
type RegionProps = {
  label: string;
  selected: string[];
  onToggle: (label: string) => void;
};

export const defaultTemplateAsset: TemplateAsset = {
  kind: 'slides',
  name: '화면설계서.pptx',
  output: 'PPTX',
  mode: 'fill',
  status: 'example',
};
const examples: ExampleOption[] = [
  {
    label: 'Word · 한글',
    asset: {
      kind: 'document',
      name: '업무보고서.docx',
      output: 'DOCX',
      mode: 'fill',
      status: 'example',
    },
  },
  { label: 'PowerPoint', asset: defaultTemplateAsset },
  {
    label: 'Excel',
    asset: {
      kind: 'sheet',
      name: '검토목록.xlsx',
      output: 'XLSX',
      mode: 'fill',
      status: 'example',
    },
  },
  {
    label: 'PDF · 이미지',
    asset: {
      kind: 'reference',
      name: '참고양식.pdf',
      output: 'DOCX',
      mode: 'reference',
      status: 'example',
    },
  },
];
const linkSchema = z.object({
  url: z
    .string()
    .trim()
    .refine((value: string): boolean => {
      try {
        return ['https:', 'http:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, 'http:// 또는 https://로 시작하는 올바른 링크를 입력해 주세요.'),
});
type LinkValues = z.infer<typeof linkSchema>;

/** 이름의 확장자만 분류하며 선택한 파일의 내용은 읽지 않습니다. */
function fileAsset(name: string): TemplateAsset {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  let kind: TemplateAsset['kind'] = 'unknown';
  if (['docx', 'dotx', 'hwp', 'hwpx'].includes(extension)) kind = 'document';
  else if (['pptx', 'potx'].includes(extension)) kind = 'slides';
  else if (['xlsx', 'xltx'].includes(extension)) kind = 'sheet';
  else if (['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(extension))
    kind = 'reference';
  else if (['md', 'txt', 'html'].includes(extension)) kind = 'text';
  const output =
    kind === 'slides'
      ? 'PPTX'
      : kind === 'sheet'
        ? 'XLSX'
        : ['hwp', 'hwpx'].includes(extension)
          ? 'HWPX'
          : 'DOCX';
  return {
    kind,
    name,
    output,
    mode:
      kind === 'reference' || kind === 'unknown' ? 'reference' : 'structure',
    status: 'unverified',
  };
}

/** 원본 계열과 같은 산출 형식인지 확인하며 보존 가능성을 보장하지 않습니다. */
function nativeOutput(asset: TemplateAsset): string {
  if (asset.kind === 'slides') return 'PPTX';
  if (asset.kind === 'sheet') return 'XLSX';
  if (asset.kind === 'document')
    return /\.hwpx?$/i.test(asset.name) ? 'HWPX' : 'DOCX';
  if (/\.pdf$/i.test(asset.name)) return 'PDF';
  if (/\.html$/i.test(asset.name)) return 'HTML';
  return '';
}

/** 보관함에서 양식의 입력 형식을 짧게 구별합니다. */
export function templateAssetLabel(asset: TemplateAsset): string {
  if (asset.kind === 'link') return '링크';
  if (asset.kind === 'text')
    return asset.status === 'example'
      ? '직접 정의'
      : asset.name.split('.').at(-1)?.toUpperCase() || '텍스트';
  if (asset.kind === 'reference') return 'PDF · 이미지';
  return nativeOutput(asset) || '형식 확인 필요';
}

/** 파일·링크·직접 정의의 진입과 시안의 입력 metadata만 관리합니다. */
export function TemplateAssetEditor({
  value,
  onChange,
  text,
  onText,
  error,
}: TemplateAssetEditorProps): JSX.Element {
  const [entry, setEntry] = useState<AssetEntry>(
    value.kind === 'text' && value.status === 'example'
      ? 'text'
      : value.kind === 'link'
        ? 'link'
        : 'file',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const linkForm = useForm<LinkValues>({
    resolver: zodResolver(linkSchema),
    defaultValues: { url: value.kind === 'link' ? value.name : '' },
  });
  const differentOutput =
    nativeOutput(value) !== '' && nativeOutput(value) !== value.output;
  const fillUnavailable =
    value.status === 'unverified' ||
    ['reference', 'unknown', 'link', 'text'].includes(value.kind) ||
    differentOutput;
  /** URL을 검사한 뒤 주소만 보관하며 원격 요청은 실행하지 않습니다. */
  function applyLink(values: LinkValues): void {
    onChange({
      kind: 'link',
      name: values.url,
      output: 'DOCX',
      mode: 'reference',
      status: 'unverified',
    });
  }
  /** 파일 선택 취소는 기존 양식을 유지하고 실제 선택은 이름만 반영합니다. */
  function selectFile(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0];
    if (selected) onChange(fileAsset(selected.name));
    event.target.value = '';
  }
  /** 직접 정의는 자연어·Markdown을 모두 허용하는 별도 작성 경로입니다. */
  function selectText(): void {
    setEntry('text');
    onChange({
      kind: 'text',
      name: '직접 정의한 양식',
      output: 'DOCX',
      mode: 'structure',
      status: 'example',
    });
  }
  return (
    <section className={styles.editor} aria-label="원본 양식">
      <div className={styles.entryActions}>
        <Button
          type="button"
          variant={entry === 'file' ? 'primary' : 'secondary'}
          aria-pressed={entry === 'file'}
          onClick={(): void => {
            setEntry('file');
            inputRef.current?.click();
          }}
        >
          <FileInput size={16} />
          파일 가져오기
        </Button>
        <Button
          type="button"
          variant={entry === 'link' ? 'primary' : 'secondary'}
          aria-pressed={entry === 'link'}
          onClick={(): void => setEntry('link')}
        >
          <Link size={16} />
          링크로 가져오기
        </Button>
        <Button
          type="button"
          variant="surface"
          aria-pressed={entry === 'text'}
          onClick={selectText}
        >
          <PencilLine size={16} />
          직접 정의
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        className={styles.fileInput}
        tabIndex={-1}
        aria-label="템플릿 원본 파일"
        onChange={selectFile}
      />
      {entry === 'file' && (
        <p className={styles.hint}>
          문서·슬라이드·시트·PDF·이미지 등 원본 양식을 선택하세요. 시안에서는
          파일명과 형식만 표시합니다.
        </p>
      )}
      {entry === 'link' && (
        <div className={styles.linkEntry}>
          <TextField
            label="템플릿 링크"
            placeholder="https://…"
            {...linkForm.register('url')}
            error={linkForm.formState.errors.url?.message}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>): void => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void linkForm.handleSubmit(applyLink)();
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={(): void => {
              void linkForm.handleSubmit(applyLink)();
            }}
          >
            가져오기
          </Button>
          <p className={styles.hint}>
            주소만 확인합니다. 링크의 내용·접근 권한 확인은 미연결입니다.
          </p>
        </div>
      )}
      {entry === 'text' && (
        <Field
          label="양식 직접 정의"
          description="자연어 또는 Markdown으로 작성할 순서와 항목을 적어 주세요."
          error={error}
        >
          {(field: FieldControlProps): JSX.Element => (
            <textarea
              {...field}
              className={controls.control}
              rows={5}
              value={text}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
                onText(event.target.value)
              }
              placeholder="먼저 화면 이름과 목적을 쓰고, 화면 배치 옆에 동작 설명 표를 넣어 주세요."
            />
          )}
        </Field>
      )}
      <div className={styles.examples} aria-label="예시 양식 선택">
        <span>예시 보기</span>
        {examples.map((example: ExampleOption): JSX.Element => (
          <Button
            key={example.label}
            type="button"
            size="small"
            variant="surface"
            aria-pressed={
              value.status === 'example' && value.kind === example.asset.kind
            }
            onClick={(): void => {
              setEntry('file');
              onChange(example.asset);
            }}
          >
            {example.label}
          </Button>
        ))}
      </div>
      <div className={styles.identity}>
        <strong>{value.name}</strong>
        <span>{value.status === 'example' ? '시안 예시' : '확인 필요'}</span>
      </div>
      {value.status === 'unverified' && (
        <p className={styles.notice} role="status">
          내용·작성 위치 확인 전 ·{' '}
          {value.kind === 'link' ? '링크 가져오기는' : '파일 해석은'} 시안에
          연결하지 않았습니다. 아래는 선택한 원본의 실제 미리보기가 아닙니다.
        </p>
      )}
      <TemplateAssetPreview key={`${value.kind}-${value.name}`} value={value} />
      <div className={styles.configuration}>
        <Field
          label="양식 사용 방식"
          description={
            fillUnavailable
              ? '원본 유지: 편집 가능한 작성 위치·서식 확인 후 선택할 수 있습니다.'
              : '원본 유지: 배치·서식 보존을 요청합니다. 실제 파일에서는 지원 여부 확인이 필요합니다.'
          }
        >
          {(field: FieldControlProps): JSX.Element => (
            <select
              {...field}
              className={controls.control}
              value={value.mode}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                const mode = event.target.value;
                if (
                  mode === 'fill' ||
                  mode === 'structure' ||
                  mode === 'reference'
                )
                  onChange({ ...value, mode });
              }}
            >
              <option value="fill" disabled={fillUnavailable}>
                원본 유지 · 빈칸 채우기{fillUnavailable ? ' (확인 필요)' : ''}
              </option>
              <option value="structure">구조 따라 새로 작성</option>
              <option value="reference">참고해 재구성</option>
            </select>
          )}
        </Field>
        <SelectField
          label="결과 파일 형식"
          description={
            differentOutput
              ? '다른 형식으로 재구성 · 배치는 확인 필요'
              : '입력 양식과 별도로 선택합니다. 생성은 미연결입니다.'
          }
          value={value.output}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const output = event.target.value;
            onChange({
              ...value,
              output,
              mode:
                value.mode === 'fill' && output !== nativeOutput(value)
                  ? 'structure'
                  : value.mode,
            });
          }}
        >
          {['PPTX', 'DOCX', 'XLSX', 'PDF', 'HWPX', 'HTML'].map(
            (format: string): JSX.Element => (
              <option key={format} value={format}>
                {format}
              </option>
            ),
          )}
        </SelectField>
      </div>
    </section>
  );
}

/** 예시의 작성 위치를 버튼으로 선택하며 실제 원본 위치로 저장하지 않습니다. */
function Region({ label, selected, onToggle }: RegionProps): JSX.Element {
  return (
    <button
      type="button"
      className={styles.region}
      aria-pressed={selected.includes(label)}
      onClick={(): void => onToggle(label)}
    >
      {selected.includes(label) ? '✓ ' : '+ '}
      {label}
    </button>
  );
}

/** 형식별 종이·슬라이드·셀을 보여 주는 개념 미리보기이며 외부 파일 렌더러가 아닙니다. */
export function TemplateAssetPreview({
  value,
  compact = false,
}: TemplateAssetPreviewProps): JSX.Element {
  const [selected, setSelected] = useState<string[]>([
    '화면명',
    '동작 설명',
    '내용',
    'B3',
  ]);
  const [protect, setProtect] = useState<boolean>(true);
  const reference = ['reference', 'unknown', 'link'].includes(value.kind);
  /** 선택할 수 있는 예시 영역만 토글하고 보호 설정과 별도로 유지합니다. */
  function toggleRegion(label: string): void {
    setSelected((current: string[]): string[] =>
      current.includes(label)
        ? current.filter((item: string): boolean => item !== label)
        : [...current, label],
    );
  }
  const regionProps = { selected, onToggle: toggleRegion };
  return (
    <div className={[styles.preview, compact ? styles.compact : ''].join(' ')}>
      <div className={styles.previewHeading}>
        <strong>예시 미리보기</strong>
        <span>
          {value.status === 'example' ? '예시에서 표시' : '원본 확인 미연결'}
        </span>
      </div>
      {value.kind === 'slides' ? (
        <div className={styles.slide}>
          <header>
            <span>LOGO</span>
            <Region label="화면명" {...regionProps} />
            <small>01</small>
          </header>
          <div className={styles.slideBody}>
            <div className={styles.wireframe}>
              <div>제목 · 도구 영역</div>
              <div className={styles.wireframeBody}>
                <span>탐색</span>
                <Region label="와이어프레임" {...regionProps} />
              </div>
              <small>화면 배치 자리</small>
            </div>
            <table>
              <caption>동작 설명</caption>
              <thead>
                <tr>
                  <th>영역</th>
                  <th>작성 내용</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>01</td>
                  <td>
                    <Region label="동작 설명" {...regionProps} />
                  </td>
                </tr>
                <tr>
                  <td>02</td>
                  <td>
                    <Region label="예외 상태" {...regionProps} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer>화면설계서 · 슬라이드 배치 예시</footer>
        </div>
      ) : value.kind === 'sheet' ? (
        <div className={styles.sheet}>
          <table>
            <caption>검토목록 · 셀 범위 예시</caption>
            <thead>
              <tr>
                <th />
                <th>A</th>
                <th>B</th>
                <th>C</th>
                <th>D</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>1</th>
                <td>항목</td>
                <td>내용</td>
                <td>상태</td>
                <td>점수</td>
              </tr>
              <tr>
                <th>2</th>
                <td>화면</td>
                <td>문서 상세</td>
                <td>검토</td>
                <td>1</td>
              </tr>
              <tr>
                <th>3</th>
                <td>권한</td>
                <td>
                  <Region label="B3" {...regionProps} />
                </td>
                <td>
                  <Region label="C3" {...regionProps} />
                </td>
                <td>1</td>
              </tr>
              <tr>
                <th>4</th>
                <td>예외</td>
                <td>
                  <Region label="B4" {...regionProps} />
                </td>
                <td>미정</td>
                <td>0</td>
              </tr>
              <tr>
                <th>5</th>
                <td colSpan={2}>합계</td>
                <td colSpan={2} className={styles.formula}>
                  =SUM(D2:D4)<small>수식 보존 대상</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : reference ? (
        <div className={styles.reference}>
          <div className={styles.referencePage}>
            <strong>참고 양식</strong>
            <div className={styles.referenceLine} />
            <div className={styles.referenceLine} />
            <div className={styles.referenceBox}>표 · 이미지 영역</div>
            <div className={styles.referenceLine} />
          </div>
          <div>
            <strong>참고할 범위 지정 필요</strong>
            <p>
              내용을 읽은 뒤 사용할 구역을 고릅니다. 편집 필드 확인 전에는 원본
              빈칸 채우기를 확정할 수 없습니다.
            </p>
            <span>범위 선택 · 미연결</span>
          </div>
        </div>
      ) : (
        <div className={styles.document}>
          <header>
            <span>LOGO · 문서 머리말</span>
            <small>업무 양식</small>
          </header>
          <h4>업무 보고서</h4>
          <Region label="제목" {...regionProps} />
          <p>목적과 배경을 작성하는 문단입니다.</p>
          <table>
            <thead>
              <tr>
                <th>항목</th>
                <th>작성할 영역</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>주요 내용</td>
                <td>
                  <Region label="내용" {...regionProps} />
                </td>
              </tr>
              <tr>
                <td>검토 의견</td>
                <td>
                  <Region label="검토 의견" {...regionProps} />
                </td>
              </tr>
            </tbody>
          </table>
          <footer>문서 꼬리말 · 1</footer>
        </div>
      )}
      {!compact && (
        <div className={styles.previewOptions}>
          {!reference && <p>작성할 영역: 예시의 상자·셀을 눌러 선택하세요.</p>}
          <label>
            <input
              type="checkbox"
              checked={protect}
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                setProtect(event.target.checked)
              }
            />
            고정 요소 보호 요청 ·{' '}
            {value.kind === 'sheet' ? '수식·머리글' : '로고·배치·머리말'}
          </label>
          {!protect && (
            <p>
              보호 요청을 해제했습니다. 재작성 시 변경을 허용하는 선택이며, 원본
              변경은 실행하지 않습니다.
            </p>
          )}
          <p className={styles.hint}>
            선택·보호는 이 시안의 예시 설정입니다. 실제 작성 위치와 원래 서식의
            보존 여부는 확인 필요합니다.
          </p>
        </div>
      )}
    </div>
  );
}
