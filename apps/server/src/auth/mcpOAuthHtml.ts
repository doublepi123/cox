const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
  main { width: min(100%, 440px); }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 12px; line-height: 1.5; color: #4b5060; }
  label { display: block; margin: 12px 0; }
  input, select, button { font: inherit; padding: 8px; }
  button { margin: 12px 8px 0 0; cursor: pointer; }
  [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8ee; }
    p { color: #a0a6b4; }
  }
`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;

export function renderErrorPage(description: string): string {
  return shell(
    "Sign-in failed",
    `<h1>This sign-in cannot continue</h1>
    <p>${escapeHtml(description)}</p>
    <p>Close this page and start the sign-in again from your agent.</p>`,
  );
}

export const consentScript = `
const page = document.getElementById("consent");
const authorization = Object.fromEntries(new URLSearchParams(page.dataset.authorization));
const signIn = document.getElementById("sign-in");
const password = document.getElementById("password");
const consent = document.getElementById("approve");
const access = document.getElementById("access");
const status = document.getElementById("status");
let csrfToken;
let submitting = false;
const post = async (path, payload) => {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", redirect: "error",
    headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error("The request failed. Check your sign-in and try again.");
  return body;
};
const details = async () => {
  const result = await post("/oauth/mcp/approval", authorization);
  if (result.redirectTo) { window.location.assign(result.redirectTo); return false; }
  csrfToken = result.csrfToken;
  consent.hidden = !csrfToken;
  signIn.hidden = !!csrfToken || page.dataset.loginMode === "local";
  access.replaceChildren();
  for (const level of result.oneClickAccess || []) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    access.append(option);
  }
  document.getElementById("allow").disabled = !csrfToken || !access.options.length;
  return !!csrfToken;
};
const login = async () => {
  await post("/api/auth/browser-session", page.dataset.loginMode === "password" ? { credential: password.value } : {});
  password.value = "";
  if (!(await details())) throw new Error("Your browser session cannot approve this request.");
  status.textContent = "Review the requested access, then choose Allow or Deny.";
};
signIn.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  try { await login(); } catch (error) { status.textContent = error.message; }
  finally { submitting = false; }
});
consent.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting || !csrfToken) return;
  submitting = true;
  try {
    const result = await post("/oauth/mcp/decision", {
      authorization, decision: { _tag: "browser-session", access: access.value, csrfToken }
    });
    window.location.assign(result.redirectTo);
  } catch (error) { status.textContent = error.message; submitting = false; }
});
document.getElementById("deny").addEventListener("click", async () => {
  if (submitting) return;
  submitting = true;
  try {
    const result = await post("/oauth/mcp/decision", { authorization, decision: { _tag: "deny" } });
    window.location.assign(result.redirectTo);
  } catch (error) { status.textContent = error.message; submitting = false; }
});
(async () => {
  try {
    if (await details()) {
      status.textContent = "Review the requested access, then choose Allow or Deny.";
    } else if (page.dataset.loginMode === "local") {
      await login();
    } else {
      status.textContent = "Sign in to review access. Signing in does not approve the agent.";
    }
  } catch (error) { status.textContent = error.message; }
})();
`;

export function renderConsentPage(input: {
  readonly authorizationQuery: string;
  readonly clientName: string;
  readonly redirectHost: string;
  readonly loginMode: "local" | "password";
}): string {
  return shell(
    "Approve agent access",
    `<section id="consent" data-authorization="${escapeHtml(input.authorizationQuery)}" data-login-mode="${input.loginMode}">
    <h1>Approve agent access</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> is requesting access to this Cox environment.</p>
    <p>The result will be sent to <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
    <p>Read-only access can read project and thread information. Other access levels can operate coding agents with the selected approval policy. Full access grants unrestricted agent execution.</p>
    <p id="status" role="status">Checking your browser session…</p>
    <form id="sign-in" hidden>
      <label>Cox password <input id="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit">Sign in</button>
    </form>
    <form id="approve" hidden>
      <label>Access level <select id="access" required></select></label>
      <button id="allow" type="submit" disabled>Allow access</button>
    </form>
    <button id="deny" type="button">Deny</button>
    <noscript>JavaScript is required to sign in and explicitly approve this request.</noscript>
    </section><script>${consentScript}</script>`,
  );
}
