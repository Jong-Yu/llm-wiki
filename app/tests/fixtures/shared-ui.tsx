import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@renderer/shared/ui/Button';
import { IconButton } from '@renderer/shared/ui/IconButton';
import { TextField } from '@renderer/shared/ui/TextField';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import {
  Panel,
  PanelHeader,
  PanelBody,
  PanelActions,
} from '@renderer/shared/ui/Panel';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { Dialog } from '@renderer/shared/ui/Dialog';
import '@renderer/shared/theme/tokens.css';

/** 제품 경로에 포함하지 않는 공통 UI 행동 검사용 입력입니다. */
function SharedUiFixture() {
  const [value, setValue] = useState('');
  const [tab, setTab] = useState('first');
  const [open, setOpen] = useState(false);
  const [submissions, setSubmissions] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="wiki-theme" data-wiki-theme={theme}>
      <Panel aria-label="공통 요소">
        <PanelHeader>
          <h1>공통 UI</h1>
          <IconButton
            aria-label="테마 전환"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            ☀
          </IconButton>
        </PanelHeader>
        <PanelBody>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmissions((count) => count + 1);
            }}
          >
            <p id="external-help">외부 도움말</p>
            <TextField
              ref={input}
              label="이름"
              description="이름 도움말"
              aria-describedby="external-help"
              error={value ? undefined : '이름을 입력하세요'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
            />
            <TextareaField label="설명" description="여러 줄 입력" />
            <SelectField label="분류">
              <option value="a">첫 항목</option>
              <option value="b">둘째 항목</option>
            </SelectField>
            <Button onClick={() => setOpen(true)}>대화상자 열기</Button>
            <Button variant="secondary" onClick={() => input.current?.focus()}>
              입력으로 이동
            </Button>
            <Button disabled onClick={() => setSubmissions(99)}>
              사용 불가
            </Button>
            <Button type="submit">확인</Button>
            <output aria-label="제출 횟수">{submissions}</output>
          </form>
          <Tabs
            label="공통 탭"
            value={tab}
            onValueChange={setTab}
            items={[
              {
                id: 'first',
                label: '첫 탭',
                content: <TextField label="보존할 입력" />,
              },
              {
                id: 'disabled',
                label: '비활성 탭',
                disabled: true,
                content: '열리지 않음',
              },
              {
                id: 'last',
                label: '끝 탭',
                content: (
                  <StatusNotice title="준비됨">두 번째 패널</StatusNotice>
                ),
              },
            ]}
          />
        </PanelBody>
        <PanelActions>
          <Button variant="secondary">보조 동작</Button>
        </PanelActions>
      </Panel>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="동작 확인"
        description="입력은 닫아도 유지됩니다"
        actions={<Button onClick={() => setOpen(false)}>완료</Button>}
      >
        <TextField label="대화상자 입력" />
      </Dialog>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('검사 영역이 없습니다.');
createRoot(root).render(
  <StrictMode>
    <SharedUiFixture />
  </StrictMode>,
);
