import { Provider } from 'jotai';
import { HashRouter } from 'react-router';
import type { JSX, ReactNode } from 'react';

type AppProvidersProps = { children: ReactNode };

/** 아직 연결 범위가 없는 골격에서는 테마 UI만 앱 수명으로 소유합니다. */
export function AppProviders({ children }: AppProvidersProps): JSX.Element {
  return (
    <Provider>
      <HashRouter>{children}</HashRouter>
    </Provider>
  );
}
