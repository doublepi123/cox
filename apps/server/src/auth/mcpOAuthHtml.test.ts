import { runInNewContext } from "node:vm";
import { expect, it } from "@effect/vitest";

import { consentScript, renderConsentPage } from "./mcpOAuthHtml.ts";

class PageElement {
  dataset: Record<string, string> = {};
  hidden = true;
  disabled = true;
  value = "";
  textContent = "";
  options: PageElement[] = [];
  listeners = new Map<string, (event: { preventDefault: () => void }) => Promise<void>>();
  addEventListener(
    name: string,
    listener: (event: { preventDefault: () => void }) => Promise<void>,
  ) {
    this.listeners.set(name, listener);
  }
  append(option: PageElement) {
    this.options.push(option);
    if (this.value === "") this.value = option.value;
  }
  replaceChildren() {
    this.options = [];
    this.value = "";
  }
}

const startPage = async (loginMode: "local" | "password", authenticated = false) => {
  const elements = new Map<string, PageElement>();
  for (const name of [
    "consent",
    "sign-in",
    "password",
    "approve",
    "access",
    "status",
    "allow",
    "deny",
  ]) {
    elements.set(name, new PageElement());
  }
  const element = (name: string) => elements.get(name)!;
  element("consent").dataset = { authorization: "client_id=test&state=original-state", loginMode };
  const requests: { path: string; payload: unknown }[] = [];
  const redirects: string[] = [];
  const html = renderConsentPage({
    authorizationQuery: "client_id=test&state=original-state",
    clientName: "Test agent",
    redirectHost: "localhost:3000",
    loginMode,
  });
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const initialization: unknown = runInNewContext(script, {
    document: { getElementById: element, createElement: () => new PageElement() },
    URLSearchParams,
    window: { location: { assign: (url: string) => redirects.push(url) } },
    fetch: async (path: string, init: RequestInit) => {
      const payload: unknown = JSON.parse(String(init.body));
      requests.push({ path, payload });
      expect(init.credentials).toBe("same-origin");
      expect(init.redirect).toBe("error");
      if (path === "/api/auth/browser-session") {
        authenticated = true;
        return Response.json({ authenticated });
      }
      if (path === "/oauth/mcp/approval") {
        return Response.json(
          authenticated ? { csrfToken: "session-csrf", oneClickAccess: ["read-only", "auto"] } : {},
        );
      }
      return Response.json({ redirectTo: "http://localhost:3000/callback?code=approved" });
    },
  });
  await initialization;
  return { element, requests, redirects };
};

it("establishes only a local session automatically, then waits for explicit approval", async () => {
  const page = await startPage("local");
  expect(page.requests.map((request) => request.path)).toEqual([
    "/oauth/mcp/approval",
    "/api/auth/browser-session",
    "/oauth/mcp/approval",
  ]);
  expect(page.requests[1]!.payload).toEqual({});
  expect(page.redirects).toEqual([]);
  expect(page.element("approve").hidden).toBe(false);
  await page.element("approve").listeners.get("submit")!({ preventDefault() {} });
  expect(page.requests.at(-1)).toEqual({
    path: "/oauth/mcp/decision",
    payload: {
      authorization: { client_id: "test", state: "original-state" },
      decision: { _tag: "browser-session", access: "read-only", csrfToken: "session-csrf" },
    },
  });
  expect(page.redirects).toHaveLength(1);
});

it("requires password sign-in before showing consent and never forwards the password to approval", async () => {
  const page = await startPage("password");
  expect(page.requests).toHaveLength(1);
  expect(page.element("sign-in").hidden).toBe(false);
  expect(page.element("approve").hidden).toBe(true);
  page.element("password").value = "private-password";
  await page.element("sign-in").listeners.get("submit")!({ preventDefault() {} });
  expect(page.requests[1]).toEqual({
    path: "/api/auth/browser-session",
    payload: { credential: "private-password" },
  });
  expect(page.element("password").value).toBe("");
  expect(page.element("approve").hidden).toBe(false);
  expect(page.redirects).toEqual([]);
  expect(page.requests.at(-1)).toEqual({
    path: "/oauth/mcp/approval",
    payload: { client_id: "test", state: "original-state" },
  });
});

it("does not create another session or approve for an already signed-in browser", async () => {
  const page = await startPage("password", true);
  expect(page.requests.map((request) => request.path)).toEqual(["/oauth/mcp/approval"]);
  expect(page.element("sign-in").hidden).toBe(true);
  expect(page.element("approve").hidden).toBe(false);
  expect(page.redirects).toEqual([]);
});

it("escapes client-controlled HTML and preserves the exact static script", () => {
  const html = renderConsentPage({
    authorizationQuery: 'state="><script>evil()</script>',
    clientName: '<img src=x onerror="evil()">',
    redirectHost: "localhost",
    loginMode: "password",
  });
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<script>evil()");
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  expect(script).toBe(consentScript);
});
