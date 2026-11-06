export const STARTUP_PAGE = [
  '<!doctype html><meta charset="utf-8">',
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
  "<title>Cox</title><style>",
  "body{background:#151518;color:#eee;font:18px system-ui;display:grid;place-content:center;height:90vh;text-align:center}",
  ".loading{display:flex;justify-content:center;gap:6px}",
  ".loading span{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.25;animation:cox-pulse 1.2s ease-in-out infinite}",
  ".loading span:nth-child(2){animation-delay:.15s}.loading span:nth-child(3){animation-delay:.3s}",
  "@keyframes cox-pulse{50%{opacity:.8;transform:translateY(-3px)}}",
  "@media(prefers-reduced-motion:reduce){.loading span{animation:none;opacity:.5}}",
  '</style><body><h1>Cox</h1><div class="loading" role="progressbar" aria-label="Cox">',
  "<span></span><span></span><span></span></div>",
].join("");
