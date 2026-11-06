export async function closeDesktopSettings() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const { flushClientSettingsPersistence } = await import("../hooks/useSettings");
  await flushClientSettingsPersistence();
  window.coxDesktop?.closeSettings?.();
}
