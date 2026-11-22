import type { JSX } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  TemplateWorkspace,
  useTemplateAccess,
} from '@renderer/features/manage-templates';
import type { TemplateLocation } from '@renderer/features/manage-templates';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';

/** 주소의 대상과 편집 모드를 명시적으로 연결하며 채팅에는 선택한 템플릿만 전달합니다. */
export function TemplatesPage(): JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { access, error } = useTemplateAccess();
  const templateId = params.get('templateId');
  const requestedMode = params.get('mode');
  const mode =
    requestedMode === 'register'
      ? 'register'
      : templateId
        ? requestedMode === 'edit'
          ? 'edit'
          : 'detail'
        : 'list';
  if (error)
    return (
      <WorkspacePage title="템플릿">
        <StatusNotice
          tone="error"
          action={<Link to="/settings">연결 설정</Link>}
        >
          {error}
        </StatusNotice>
      </WorkspacePage>
    );
  if (!access)
    return (
      <WorkspacePage title="템플릿">
        <p role="status">현재 작업 공간을 확인하고 있습니다.</p>
      </WorkspacePage>
    );
  if (templateId && !/^[a-f0-9]{32}$/.test(templateId))
    return (
      <WorkspacePage title="템플릿">
        <StatusNotice
          tone="error"
          action={<Link to="/templates">템플릿 목록으로</Link>}
        >
          템플릿 주소가 올바르지 않습니다.
        </StatusNotice>
      </WorkspacePage>
    );
  return (
    <TemplateWorkspace
      key={JSON.stringify(access.session)}
      session={access.session}
      canWrite={access.canWrite}
      location={{ templateId, mode }}
      onNavigate={(location: TemplateLocation): void => {
        const query = new URLSearchParams();
        if (location.templateId) query.set('templateId', location.templateId);
        if (location.mode === 'edit' || location.mode === 'register')
          query.set('mode', location.mode);
        setParams(query);
      }}
      onUse={(id: string): void => {
        void navigate(`/chat?templateId=${encodeURIComponent(id)}`);
      }}
    />
  );
}
