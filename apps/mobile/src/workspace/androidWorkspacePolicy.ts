import { normalizeRemoteOrigin } from "@t3tools/shared/remoteServerAdmission";

export interface AndroidWorkspaceIdentity {
  readonly profileId: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
}

export class AndroidWorkspacePolicyError extends Error {}

export async function androidProfileName(identity: AndroidWorkspaceIdentity): Promise<string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      identity.profileId,
    )
  )
    throw new AndroidWorkspacePolicyError("Invalid profile identifier.");
  const origin = normalizeRemoteOrigin(identity.origin, identity);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(origin));
  return `cox_srv_${identity.profileId.replaceAll("-", "").toLowerCase()}_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function androidTransportAllowed(
  identity: AndroidWorkspaceIdentity,
  target: string,
): boolean {
  try {
    const url = new URL(target);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          identity.allowInsecureHttp &&
          identity.origin.startsWith("http:")))
    );
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export interface AndroidDownloadHop {
  readonly url: string;
  readonly cookiesAllowed: boolean;
}

export function androidDownloadHop(
  identity: AndroidWorkspaceIdentity,
  previous: AndroidDownloadHop,
  location: string,
): AndroidDownloadHop | null {
  let target: URL;
  try {
    target = new URL(location, previous.url);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (
    !androidTransportAllowed(identity, target.href) ||
    (previous.url.startsWith("https:") && target.protocol === "http:")
  )
    return null;
  return {
    url: target.href,
    cookiesAllowed: previous.cookiesAllowed && target.origin === identity.origin,
  };
}

export type AndroidOpenDecision =
  | { readonly kind: "isolationPanel" }
  | { readonly kind: "workspace"; readonly evicted: string | null; readonly path: string };

export class AndroidWorkspacePoolPolicy {
  private readonly pool = new Map<string, string>();
  private readonly paths = new Map<string, string>();
  private readonly retired = new Set<string>();

  open(profileName: string, multiProfile: boolean): AndroidOpenDecision {
    if (!multiProfile || this.retired.has(profileName)) return { kind: "isolationPanel" };
    const path = this.paths.get(profileName) ?? "/";
    this.pool.delete(profileName);
    const evicted = this.pool.size === 2 ? (this.pool.keys().next().value ?? null) : null;
    if (evicted !== null) this.pool.delete(evicted);
    this.pool.set(profileName, path);
    return { kind: "workspace", evicted, path };
  }

  remember(profileName: string, path: string): void {
    if (this.pool.has(profileName) && path.startsWith("/") && !path.startsWith("//"))
      this.paths.set(profileName, path);
  }

  forget(profileName: string): readonly ("destroyWebView" | "deleteProfile")[] {
    this.retired.add(profileName);
    const pooled = this.pool.delete(profileName);
    this.paths.delete(profileName);
    return pooled ? ["destroyWebView", "deleteProfile"] : ["deleteProfile"];
  }
}

export class AndroidNavigationPolicy {
  readonly identity: AndroidWorkspaceIdentity;
  private token: string | null = null;
  private expectedUrl: string | null = null;
  private gateway: boolean;
  private gatewayVisited = false;
  private sequence = 0;
  private barrier: {
    readonly ticket: number;
    readonly returnUrl: string;
    started: boolean;
  } | null = null;

  constructor(identity: AndroidWorkspaceIdentity, gatewayLogin = false) {
    this.identity = identity;
    this.gateway = gatewayLogin;
  }

  route(url: string): "load" | "external" | "block" {
    if (!androidTransportAllowed(this.identity, url)) return "block";
    return new URL(url).origin === this.identity.origin ||
      (this.gateway && url.startsWith("https:"))
      ? "load"
      : "external";
  }

  start(url: string): string | null {
    this.token = null;
    if (this.barrier !== null) {
      if (url === `about:blank?cox-gateway=${this.barrier.ticket}`) this.barrier.started = true;
      return null;
    }
    this.expectedUrl = url;
    if (
      this.gateway &&
      (new URL(url).origin !== this.identity.origin ||
        new URL(url).pathname.startsWith("/cdn-cgi/"))
    )
      this.gatewayVisited = true;
    if (
      this.gateway &&
      this.gatewayVisited &&
      new URL(url).origin === this.identity.origin &&
      !new URL(url).pathname.startsWith("/cdn-cgi/")
    ) {
      this.barrier = { ticket: ++this.sequence, returnUrl: url, started: false };
      return `about:blank?cox-gateway=${this.sequence}`;
    }
    return null;
  }

  finishBarrier(url: string): string | null {
    const barrier = this.barrier;
    if (barrier === null || !barrier.started || url !== `about:blank?cox-gateway=${barrier.ticket}`)
      return null;
    this.barrier = null;
    this.gateway = false;
    this.expectedUrl = barrier.returnUrl;
    return barrier.returnUrl;
  }

  commit(url: string, freshToken: string): boolean {
    if (
      this.barrier !== null ||
      url !== this.expectedUrl ||
      new URL(url).origin !== this.identity.origin ||
      (this.gateway && (this.gatewayVisited || new URL(url).pathname.startsWith("/cdn-cgi/"))) ||
      !/^[0-9a-f]{64}$/.test(freshToken)
    )
      return false;
    this.gateway = false;
    this.token = freshToken;
    return true;
  }

  accepts(message: {
    readonly origin: string;
    readonly mainFrame: boolean;
    readonly token: string;
  }): boolean {
    return (
      message.mainFrame &&
      message.origin === this.identity.origin &&
      this.token !== null &&
      message.token === this.token
    );
  }
}
