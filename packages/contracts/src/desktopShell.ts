export interface DesktopWindowState {
  readonly fullscreen: boolean;
  readonly zoomFactor: number;
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
}

export interface DesktopShellBridge {
  readonly platform: string;
  ready(): void;
  onQuitRequested(listener: () => void): () => void;
  answerQuit(confirmed: boolean): void;
  setWindowColors(background: string, foreground: string): void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  syncWindowControls(): void;
  getBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  checkBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  installBackendUpdate?(): Promise<DesktopBackendUpdateState>;
  onBackendUpdate?(listener: (state: DesktopBackendUpdateState) => void): () => void;
}
