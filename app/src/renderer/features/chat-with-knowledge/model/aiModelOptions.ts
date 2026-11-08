import { DEFAULT_AI_MODEL } from '@contracts/runtime.contract';
import type { AiProvider } from '@contracts/runtime.contract';

export type AiModelOption = { value: string; label: string };

/**
 * 제공자별 고정 선택지의 유일한 정의입니다.
 * Codex는 모델 이름이 자주 바뀌고 도구에서 조회할 방법이 없어 추측하지 않고 default만 둡니다.
 */
export const aiModelOptions: Record<AiProvider, AiModelOption[]> = {
  codex: [{ value: DEFAULT_AI_MODEL, label: 'default' }],
  claude: [
    { value: DEFAULT_AI_MODEL, label: 'default' },
    { value: 'fable', label: 'fable' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'opus', label: 'opus' },
    { value: 'haiku', label: 'haiku' },
  ],
};
