import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { App } from "../App";
import { CONNECTION_STORAGE_KEY, ConnectionStore } from "../connections/store";
import { translator } from "../i18n";

const t = translator("en");

const SERVER_A_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_B_ID = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT_A = "11111111-aaaa-4111-8111-111111111111";
const ENVIRONMENT_B = "22222222-bbbb-4222-8222-222222222222";

import { native } from "./nativeWorkspace.fixture";

vi.mock("@capacitor/core", async () => {
  const { native } = await import("./nativeWorkspace.fixture");
  return {
    Capacitor: { isNativePlatform: () => true },
    registerPlugin: (name: string) => {
      if (name === "CoxVault") return native.vault;
      if (name === "CoxWorkspaceWebView") return native.workspace;
      throw new Error(`Unexpected native plugin: ${name}`);
    },
  };
});

const environments = new Map<string, string>([
  ["https://workstation.example.com", ENVIRONMENT_A],
  ["http://192.0.2.20:3773", ENVIRONMENT_B],
]);

function admissionFetcher(): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const origin = new URL(url).origin;
    if (url.endsWith("/.well-known/t3/environment")) {
      const environmentId = environments.get(origin);
      if (environmentId === undefined) throw new TypeError("Unknown mobile smoke origin.");
      return Response.json({
        environmentId,
        label: "Test Cox",
        serverVersion: "9.9.9",
      });
    }
    if (url.endsWith("/api/auth/session")) {
      return Response.json({ auth: { loginMode: "password" } });
    }
    return new Response("Not found", { status: 404 });
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderApp(store: ConnectionStore) {
  container = document.createElement("div");
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  flushSync(() => mountedRoot.render(<App store={store} />));
}

function createStore(): ConnectionStore {
  const ids = [SERVER_A_ID, SERVER_B_ID];
  return new ConnectionStore({
    storage: localStorage,
    fetcher: admissionFetcher(),
    now: () => "2026-11-15T12:00:00.000Z",
    newId: () => ids.shift() ?? SERVER_B_ID,
  });
}

async function addServerThroughEditor(input: {
  readonly label: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
  readonly password: string;
}) {
  await page.getByRole("button", { name: t("addServer") }).click();
  await page.getByLabelText(t("nameLabel")).fill(input.label);
  await page.getByLabelText(t("originLabel")).fill(input.origin);
  if (input.allowInsecureHttp) {
    await page.getByRole("checkbox", { name: t("allowHttp") }).click();
  }
  await page.getByRole("checkbox", { name: t("savePasswordInVault") }).click();
  await page.getByLabelText(t("vaultPassword")).fill(input.password);
  await page.getByRole("button", { name: t("saveServer") }).click();
}

async function addBothServersThroughEditor() {
  await addServerThroughEditor({
    label: "Workstation",
    origin: "https://workstation.example.com",
    allowInsecureHttp: false,
    password: "secret-vault-a",
  });
  await addServerThroughEditor({
    label: "LAN Box",
    origin: "http://192.0.2.20:3773",
    allowInsecureHttp: true,
    password: "secret-vault-b",
  });
  await expect
    .element(
      page.getByRole("listitem").filter({ hasText: "LAN Box" }).getByText("http://192.0.2.20:3773"),
    )
    .toBeInTheDocument();
}

function serverRow(label: string) {
  return page.getByRole("listitem").filter({ hasText: label });
}

beforeEach(() => {
  localStorage.clear();
  native.reset();
  environments.set("https://workstation.example.com", ENVIRONMENT_A);
  environments.set("http://192.0.2.20:3773", ENVIRONMENT_B);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("launcher to workspace integration", () => {
  it("pins both identities and switches the native workspace and credentials from A to B", async () => {
    const store = createStore();
    renderApp(store);

    await addBothServersThroughEditor();

    await expect
      .element(serverRow("Workstation").getByText("https://workstation.example.com"))
      .toBeInTheDocument();

    await expect.element(serverRow("Workstation").getByTitle(ENVIRONMENT_A)).toBeInTheDocument();
    await expect.element(serverRow("LAN Box").getByTitle(ENVIRONMENT_B)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CONNECTION_STORAGE_KEY) ?? "{}").profiles).toEqual([
      expect.objectContaining({
        id: SERVER_A_ID,
        pinnedEnvironmentId: ENVIRONMENT_A,
        origin: "https://workstation.example.com",
        allowInsecureHttp: false,
        hasSavedPassword: true,
      }),
      expect.objectContaining({
        id: SERVER_B_ID,
        pinnedEnvironmentId: ENVIRONMENT_B,
        origin: "http://192.0.2.20:3773",
        allowInsecureHttp: true,
        hasSavedPassword: true,
      }),
    ]);
    expect(native.calls.savePassword).toEqual([
      {
        profileId: SERVER_A_ID,
        canonicalOrigin: "https://workstation.example.com",
        password: "secret-vault-a",
        requireBiometric: true,
      },
      {
        profileId: SERVER_B_ID,
        canonicalOrigin: "http://192.0.2.20:3773",
        password: "secret-vault-b",
        requireBiometric: true,
      },
    ]);

    await serverRow("Workstation")
      .getByRole("button", { name: t("connect") })
      .click();
    await expect.element(page.getByRole("status")).toHaveTextContent(t("connectionReady"));

    expect(native.calls.unlockAndAutofillPassword).toEqual([
      {
        profileId: SERVER_A_ID,
        canonicalOrigin: "https://workstation.example.com",
        allowInsecureHttp: false,
      },
    ]);
    expect(native.calls.openWorkspace).toEqual([
      {
        profileId: SERVER_A_ID,
        origin: "https://workstation.example.com",
        allowInsecureHttp: false,
        lastThreadPath: null,
        label: "Workstation",
        serverCount: 2,
        gatewayLogin: false,
      },
    ]);
    await expect
      .element(serverRow("Workstation").getByTestId("health-badge"))
      .toHaveTextContent(t("verified"));

    await serverRow("LAN Box")
      .getByRole("button", { name: t("connect") })
      .click();
    await expect.poll(() => native.calls.openWorkspace.length).toBe(2);
    expect(native.calls.openWorkspace[1]).toEqual({
      profileId: SERVER_B_ID,
      origin: "http://192.0.2.20:3773",
      allowInsecureHttp: true,
      lastThreadPath: null,
      label: "LAN Box",
      serverCount: 2,
      gatewayLogin: false,
    });
    expect(native.calls.unlockAndAutofillPassword[1]).toEqual({
      profileId: SERVER_B_ID,
      canonicalOrigin: "http://192.0.2.20:3773",
      allowInsecureHttp: true,
    });
  });

  it("blocks a changed identity without touching credentials and forgetting wipes vault and workspace", async () => {
    const store = createStore();
    renderApp(store);

    await addBothServersThroughEditor();
    await serverRow("Workstation")
      .getByRole("button", { name: t("connect") })
      .click();
    await expect.element(page.getByRole("status")).toHaveTextContent(t("connectionReady"));
    expect(native.calls.openWorkspace).toHaveLength(1);
    const unlocksAfterConnect = native.calls.unlockAndAutofillPassword.length;

    environments.set("http://192.0.2.20:3773", "33333333-cccc-4333-8333-333333333333");
    await serverRow("LAN Box")
      .getByRole("button", { name: t("connect") })
      .click();
    await expect
      .element(page.getByTestId("connection-error"))
      .toHaveTextContent(t("identityMismatch"));
    await expect
      .element(serverRow("LAN Box").getByTestId("health-badge"))
      .toHaveTextContent(t("identity_mismatch"));
    expect(native.calls.unlockAndAutofillPassword).toHaveLength(unlocksAfterConnect);
    expect(native.calls.openWorkspace).toHaveLength(1);

    await serverRow("Workstation")
      .getByRole("button", { name: t("forget") })
      .click();
    await page.getByRole("button", { name: t("forgetServer") }).click();
    await expect.element(serverRow("Workstation")).not.toBeInTheDocument();

    expect(native.calls.deletePassword).toEqual([{ profileId: SERVER_A_ID }]);
    expect(native.calls.forgetProfile).toEqual([
      { profileId: SERVER_A_ID, origin: "https://workstation.example.com" },
    ]);
    await expect.element(serverRow("LAN Box")).toBeInTheDocument();
  });

  it("completes Cloudflare Access sign-in via native profile preflight on Add and connect and remembers thread location", async () => {
    const ids = [SERVER_A_ID, SERVER_B_ID];
    const authedProfiles = new Set<string>();
    let rejectCancelOnce = true;
    native.setHandlers({
      requestProfileUrl: async ({ profileId, origin, url }) => {
        if (!authedProfiles.has(profileId)) {
          return {
            status: 302,
            headers: {
              location: `https://broad-sun-37d6.cloudflareaccess.com/cdn-cgi/access/login/dd.yang.sarl?redirect_url=${encodeURIComponent(new URL(url).pathname)}`,
            },
            body: "",
          };
        }
        if (url === `${origin}/.well-known/t3/environment`) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              environmentId: ENVIRONMENT_A,
              label: "CF Remote",
              serverVersion: "0.1.98",
            }),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth: { loginMode: "password" } }),
        };
      },
      signInToGateway: async ({ profileId }) => {
        if (rejectCancelOnce) {
          rejectCancelOnce = false;
          throw Object.assign(new Error("Cancelled"), { code: "gateway_cancelled" });
        }
        authedProfiles.add(profileId);
      },
    });
    const store = new ConnectionStore({
      storage: localStorage,
      now: () => "2026-11-17T03:35:00.000Z",
      newId: () => ids.shift() ?? SERVER_B_ID,
    });
    renderApp(store);

    await page.getByRole("button", { name: t("addServer") }).click();
    await page.getByLabelText(t("originLabel")).fill("https://dd.yang.sarl");
    await page.getByRole("checkbox", { name: t("savePasswordInVault") }).click();
    await page.getByLabelText(t("vaultPassword")).fill("cf-cox-password");
    await page.getByRole("button", { name: t("saveAndConnect") }).click();

    await expect
      .element(page.getByTestId("server-editor-error"))
      .toHaveTextContent(t("gatewayCancelled"));
    expect(native.calls.forgetProfile).toEqual([
      { profileId: SERVER_A_ID, origin: "https://dd.yang.sarl" },
    ]);
    expect(store.getSnapshot().profiles).toEqual([]);

    await page.getByRole("button", { name: t("saveAndConnect") }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent(t("connectionReady"));

    expect(native.calls.signInToGateway).toHaveLength(2);
    expect(native.calls.unlockAndAutofillPassword).toEqual([
      {
        profileId: SERVER_B_ID,
        canonicalOrigin: "https://dd.yang.sarl",
        allowInsecureHttp: false,
      },
    ]);
    expect(native.calls.openWorkspace).toEqual([
      {
        profileId: SERVER_B_ID,
        origin: "https://dd.yang.sarl",
        allowInsecureHttp: false,
        lastThreadPath: null,
        label: "CF Remote",
        serverCount: 1,
        gatewayLogin: false,
      },
    ]);

    native.emitLocation(SERVER_B_ID, "/env-cf/thread-99");
    await serverRow("CF Remote")
      .getByRole("button", { name: t("connect") })
      .click();
    await expect.poll(() => native.calls.openWorkspace.length).toBe(2);
    expect(native.calls.openWorkspace[1]).toEqual(
      expect.objectContaining({
        profileId: SERVER_B_ID,
        lastThreadPath: "/env-cf/thread-99",
      }),
    );
  });
});
