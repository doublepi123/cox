import * as Schema from "effect/Schema";

export interface DesktopWindowState {
  readonly fullscreen: boolean;
  readonly zoomFactor: number;
}

export interface DesktopClientUpdateState {
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  readonly progress: DesktopUpdateProgress | null;
  readonly message: string | null;
  readonly installMode: "automatic" | "manual";
  readonly automaticChecks: boolean;
  readonly ignoredVersion: string | null;
}

export interface DesktopBackendUpdateState {
  readonly desktopVersion: string;
  readonly bundledVersion: string | null;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly status:
    | "idle"
    | "checking"
    | "available"
    | "incompatible"
    | "installing"
    | "ready"
    | "error";
  readonly message: string | null;
  readonly automaticChecks?: boolean;
  readonly ignoredVersion?: string | null;
  readonly progress?: DesktopUpdateProgress | null;
}

export interface DesktopSoftwareUpdateState {
  readonly backend: DesktopBackendUpdateState;
  readonly client: DesktopClientUpdateState;
}

export const DesktopUpdateProgress = Schema.Struct({
  phase: Schema.Literals(["downloading", "verifying", "installing", "validating", "starting"]),
  transferredBytes: Schema.Number,
  totalBytes: Schema.NullOr(Schema.Number),
  bytesPerSecond: Schema.NullOr(Schema.Number),
  remainingSeconds: Schema.NullOr(Schema.Number),
});
export type DesktopUpdateProgress = typeof DesktopUpdateProgress.Type;

export interface DesktopShellBridge {
  readonly platform: string;
  readonly windowKind?: "main" | "settings" | "usage";
  openSettings?(path: string): Promise<void>;
  openUsage?(path: string): Promise<void>;
  openMain?(path: string): Promise<void>;
  onNavigate?(listener: (path: string) => void): () => void;
  closeSettings?(): void;
  closeUsage?(): void;
  onSettingsCloseRequested?(listener: () => void): () => void;
  ready(capabilities?: { readonly settingsWindow?: boolean; readonly usageWindow?: boolean }): void;
  onQuitRequested(listener: (reason?: "quit" | "update") => void): () => void;
  answerQuit(confirmed: boolean): void;
  setWindowColors(background: string, foreground: string): void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  syncWindowControls(): void;
  openConnections?(): Promise<void>;
  checkUpdates?(): Promise<DesktopSoftwareUpdateState>;
  downloadUpdates?(): Promise<DesktopSoftwareUpdateState>;
  applyUpdates?(): Promise<void>;
  setUpdatePolicy?(policy: "automatic" | "never"): Promise<DesktopSoftwareUpdateState>;
  getBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  checkBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  installBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  applyBackendUpdate?(): Promise<void>;
  setBackendUpdatePolicy?(
    policy: "automatic" | "ignore-version" | "never",
    version?: string,
  ): Promise<DesktopBackendUpdateState>;
  onBackendUpdate?(listener: (state: DesktopBackendUpdateState) => void): () => void;
  getClientUpdate?(): Promise<DesktopClientUpdateState>;
  checkClientUpdate?(): Promise<DesktopClientUpdateState>;
  downloadClientUpdate?(): Promise<DesktopClientUpdateState>;
  applyClientUpdate?(): Promise<void>;
  setClientUpdatePolicy?(
    policy: "automatic" | "ignore-version" | "never",
    version?: string,
  ): Promise<DesktopClientUpdateState>;
  onClientUpdate?(listener: (state: DesktopClientUpdateState) => void): () => void;
}
