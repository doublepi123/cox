export interface DesktopShellBridge {
  readonly platform: string;
  ready(): void;
  onQuitRequested(listener: () => void): () => void;
  answerQuit(confirmed: boolean): void;
  setWindowColors(background: string, foreground: string): void;
}
