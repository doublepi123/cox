export function hapticTick(): void {
  const plugins = (
    window as Window & {
      Capacitor?: {
        Plugins?: { Haptics?: { impact: (options: { style: string }) => Promise<void> } };
      };
    }
  ).Capacitor?.Plugins?.Haptics;
  if (plugins) {
    void plugins.impact({ style: "MEDIUM" }).catch(() => undefined);
    return;
  }
  navigator.vibrate?.(12);
}
