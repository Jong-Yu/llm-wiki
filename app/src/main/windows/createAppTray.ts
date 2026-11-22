import { Menu, Tray } from 'electron';
import type { App } from 'electron';

type AppTrayOptions = {
  iconPath: string;
  showWindow: () => void;
};

/** 숨긴 앱을 다시 열고 기존 작업 정리 절차로 종료하는 트레이를 만듭니다. */
export function createAppTray(
  application: Pick<App, 'once' | 'quit'>,
  options: AppTrayOptions,
): Tray {
  const tray = new Tray(options.iconPath);
  tray.setToolTip('LLM Wiki');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '앱 열기', click: options.showWindow },
      { type: 'separator' },
      { label: '종료', click: (): void => application.quit() },
    ]),
  );
  tray.on('click', options.showWindow);
  tray.on('double-click', options.showWindow);
  // 종료 취소·정리 실패 때는 유지하며, 이 참조로 실행 중 GC도 막습니다.
  application.once('will-quit', (): void => tray.destroy());
  return tray;
}
