/// <reference types="vite-plus/client" />

import type { ThreadId } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_RELEASE_CHANNEL: string;
  readonly T3CODE_FEATURE_SECRETS: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    /** Dev builds only, from DevReplayHost. Agents call these from the browser console. */
    t3dev?: {
      readonly replayScenarios: () => ReadonlyArray<string>;
      readonly replay: (scenario?: string) => Promise<ThreadId>;
    };
  }
}
