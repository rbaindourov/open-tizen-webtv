/**
 * Open WebTV - Strictly Typed Runtime Bootstrapper (`core.ts` -> `/assets/core.js`)
 */

export interface OpenWebTVRuntimeInfo {
  readonly version: string;
  readonly bootedAt: string;
}

export var RUNTIME_INFO: OpenWebTVRuntimeInfo = {
  version: '1.0.0',
  bootedAt: new Date().toISOString()
};

if (typeof window !== 'undefined') {
  (window as unknown as { __OPEN_WEBTV_RUNTIME__?: OpenWebTVRuntimeInfo }).__OPEN_WEBTV_RUNTIME__ =
    RUNTIME_INFO;
}
