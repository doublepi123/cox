import type { DesktopConnectionSnapshot } from "./connections.ts";
import { escapeHtml } from "./startup-page.ts";

export function createConnectionPage(
  locale: string,
  snapshot: DesktopConnectionSnapshot,
  icon?: string,
  error?: string,
) {
  const zh = /^zh(?:-|_|$)/i.test(locale);
  const labels = zh
    ? {
        title: "连接",
        subtitle: "在这台电脑上运行 Cox，或连接你自己部署的远程服务端。",
        local: "此电脑",
        localDetail: "使用本地 Cox 后端。连接远程服务器不会停止本地任务。",
        useLocal: "使用本地模式",
        remote: "远程服务器",
        add: "添加并连接",
        name: "名称（可选）",
        origin: "HTTP(S) 服务器地址",
        connect: "连接",
        forget: "忘记",
        current: "当前",
        security:
          "远程服务端必须启用 COX_AUTH_PASSWORD。HTTP 仅在可信网络中使用；密码、会话和内容不会被加密。密码不会保存在连接配置中。",
      }
    : {
        title: "Connections",
        subtitle: "Run Cox on this computer, or connect to a remote server that you operate.",
        local: "This computer",
        localDetail: "Use the local Cox backend. Connecting remotely keeps local tasks running.",
        useLocal: "Use local mode",
        remote: "Remote servers",
        add: "Add and connect",
        name: "Name (optional)",
        origin: "HTTP(S) server origin",
        connect: "Connect",
        forget: "Forget",
        current: "Current",
        security:
          "Remote servers must enable COX_AUTH_PASSWORD. Use HTTP only on trusted networks: credentials, sessions and content are not encrypted. Passwords are never saved in connection settings.",
      };
  const active = snapshot.active;
  const profiles = snapshot.profiles
    .map(
      (profile) =>
        `<article class="server"><div class="server-copy"><strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(profile.origin)}</span><small>Cox ${escapeHtml(profile.serverVersion)}${active?.kind === "remote" && active.profileId === profile.id ? ` · ${labels.current}` : ""}</small></div><div class="actions"><button type="button" data-action="connect" data-id="${profile.id}">${labels.connect}</button><button type="button" class="secondary" data-action="forget" data-id="${profile.id}">${labels.forget}</button></div></article>`,
    )
    .join("");
  return [
    '<!doctype html><meta charset="utf-8">',
    `<html lang="${zh ? "zh" : "en"}">`,
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">",
    `<title>Cox · ${labels.title}</title><style>`,
    ":root{color-scheme:light dark;--bg:light-dark(#f7f7f8,#151518);--fg:light-dark(#262626,#f5f5f5);--muted:light-dark(#6b6b70,#a0a0a8);--line:light-dark(#dedee2,#303036);--card:light-dark(#fff,#1c1c20)}",
    "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui}main{width:min(720px,calc(100vw - 40px));margin:0 auto;padding:52px 0}header{display:flex;align-items:center;gap:12px;margin-bottom:10px}header img{width:36px;height:36px}h1{font-size:24px;margin:0}p{color:var(--muted);margin:0 0 28px}h2{font-size:13px;margin:26px 0 10px}.local,.server{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:16px}.local{display:flex;align-items:center;justify-content:space-between;gap:16px}.local strong,.server strong{display:block;font-size:14px}.local span,.server span,.server small{display:block;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.server{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:8px}.server-copy{min-width:0}.actions{display:flex;gap:8px;flex-shrink:0}button,input{font:inherit}button{border:1px solid var(--fg);border-radius:8px;background:var(--fg);color:var(--bg);padding:7px 12px;cursor:pointer}button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}button:disabled{opacity:.5;cursor:wait}form{display:grid;grid-template-columns:1fr 1.5fr auto;gap:8px;margin-top:12px}input{min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);padding:8px 10px}input:focus{outline:2px solid color-mix(in srgb,var(--fg) 30%,transparent);outline-offset:1px}.security{font-size:12px;margin:18px 0 0}.error{color:light-dark(#b42318,#ffb4ab);background:light-dark(#fff0ee,#3a1d1d);padding:10px 12px;border-radius:8px;margin-bottom:16px;overflow-wrap:anywhere}@media(max-width:620px){form{grid-template-columns:1fr}.local,.server{align-items:flex-start;flex-direction:column}.actions{width:100%}main{padding-top:32px}}",
    `</style><body><main id="cox-connections"><header>${icon ? `<img alt="" src="${escapeHtml(icon)}">` : ""}<h1>${labels.title}</h1></header><p>${labels.subtitle}</p>`,
    `<div id="cox-connection-error" class="error" role="alert" ${error ? "" : "hidden"}>${escapeHtml(error ?? "")}</div>`,
    `<section><h2>${labels.local}</h2><div class="local"><div><strong>${labels.local}</strong><span>${labels.localDetail}</span></div><button type="button" data-action="local">${labels.useLocal}</button></div></section>`,
    `<section><h2>${labels.remote}</h2>${profiles}`,
    `<form id="cox-connection-form"><input id="cox-connection-name" aria-label="${labels.name}" placeholder="${labels.name}" autocomplete="off"><input id="cox-connection-origin" aria-label="${labels.origin}" placeholder="https://cox.example.com" type="url" required autocomplete="url"><button type="submit">${labels.add}</button></form>`,
    `<p class="security">${labels.security}</p></section></main></body></html>`,
  ].join("");
}
