export interface DesktopWindowState {
  readonly fullscreen: boolean;
  readonly zoomFactor: number;
}

export interface DesktopUpdateProgress {
  readonly phase: "downloading" | "verifying" | "installing" | "validating" | "starting";
  readonly transferredBytes: number;
  readonly totalBytes: number | null;
  readonly bytesPerSecond: number | null;
  readonly remainingSeconds: number | null;
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

export interface DesktopShellBridge {
  readonly platform: string;
  readonly windowKind?: "main" | "settings";
  openSettings?(path: string): Promise<void>;
  openMain?(path: string): Promise<void>;
  onNavigate?(listener: (path: string) => void): () => void;
  closeSettings?(): void;
  onSettingsCloseRequested?(listener: () => void): () => void;
  ready(capabilities?: { readonly settingsWindow?: boolean }): void;
  onQuitRequested(listener: (reason?: "quit" | "update") => void): () => void;
  answerQuit(confirmed: boolean): void;
  setWindowColors(background: string, foreground: string): void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  syncWindowControls(): void;
  getBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  checkBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  installBackendUpdate?(): Promise<DesktopBackendUpdateState>;
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
