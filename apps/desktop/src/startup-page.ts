function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function createStartupPage(
  locale: string,
  colors?: { background: string; foreground: string },
  icon?: string,
) {
  const zh = /^zh(?:-|_|$)/i.test(locale);
  const labels = zh
    ? {
        preparing: "正在准备 Cox…",
        checking: "正在检查 Cox 版本…",
        downloading: "正在下载 Cox…",
        verifying: "正在校验下载文件…",
        installing: "正在安装依赖…",
        validating: "正在验证安装…",
        starting: "正在启动 Cox…",
        remaining: "预计还需 {seconds} 秒",
        error: "准备未完成，请重试。",
      }
    : {
        preparing: "Preparing Cox…",
        checking: "Checking Cox version…",
        downloading: "Downloading Cox…",
        verifying: "Verifying download…",
        installing: "Installing dependencies…",
        validating: "Verifying installation…",
        starting: "Starting Cox…",
        remaining: "About {seconds}s remaining",
        error: "Setup could not finish. Please retry.",
      };
  const valid =
    colors &&
    /^#[a-f0-9]{6}$/i.test(colors.background) &&
    /^#[a-f0-9]{6}$/i.test(colors.foreground);
  return [
    '<!doctype html><meta charset="utf-8">',
    `<html lang="${zh ? "zh" : "en"}">`,
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">",
    "<title>Cox</title><style>",
    `:root{color-scheme:light dark;--background:${valid ? colors.background : "light-dark(#ffffff,#000000)"};--foreground:${valid ? colors.foreground : "light-dark(#262626,#f5f5f5)"}}`,
    "*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:13px/1.5 system-ui;display:grid;place-content:center;min-height:100vh;text-align:center;-webkit-app-region:drag}",
    "main{width:min(360px,calc(100vw - 64px))}h1{font-size:22px;font-weight:600;margin:12px 0 24px}img{width:48px;height:48px}.status{margin:16px 0 8px;opacity:.7}.progress{height:6px;border-radius:999px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden}.bar{height:100%;width:33%;background:currentColor;opacity:.75;border-radius:inherit;transition:width .15s}.bar.indeterminate{animation:cox-pulse 1.2s ease-in-out infinite}.details{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px;min-height:36px;font-size:11px;font-variant-numeric:tabular-nums;opacity:.6}",
    ".loading{display:flex;justify-content:center;gap:6px}",
    ".loading span{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.25;animation:cox-pulse 1.2s ease-in-out infinite}",
    ".loading span:nth-child(2){animation-delay:.15s}.loading span:nth-child(3){animation-delay:.3s}",
    "@keyframes cox-pulse{50%{opacity:.8;transform:translateY(-3px)}}",
    "@media(prefers-reduced-motion:reduce){.loading span,.bar.indeterminate{animation:none;opacity:.5}.bar{transition:none}}",
    `</style><body><main id="cox-startup" ${Object.entries(labels)
      .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
      .join(" ")}>`,
    icon ? `<img alt="" src="${escapeHtml(icon)}">` : "",
    '<h1>Cox</h1><div class="loading" aria-hidden="true"><span></span><span></span><span></span></div>',
    `<p id="cox-startup-status" class="status" role="status">${labels.preparing}</p>`,
    '<div id="cox-startup-progress" class="progress" role="progressbar" aria-label="Cox" aria-valuemin="0" aria-valuemax="100"><div id="cox-startup-bar" class="bar indeterminate"></div></div>',
    '<div class="details"><span id="cox-startup-size"></span><span id="cox-startup-speed"></span></div></main></body></html>',
  ].join("");
}

export const STARTUP_PAGE = createStartupPage("en");
