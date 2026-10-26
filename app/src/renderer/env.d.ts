import type { WikiBridge } from '@contracts/app.contract';

declare global {
  interface Window {
    readonly wiki?: WikiBridge;
  }
}
