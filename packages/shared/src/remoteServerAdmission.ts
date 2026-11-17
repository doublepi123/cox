export interface RemoteServerInspection {
  readonly origin: string;
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
}

export interface RemoteOriginOptions {
  readonly allowInsecureHttp?: boolean;
}

export interface RemoteInspectionOptions extends RemoteOriginOptions {
  readonly pinnedEnvironmentId?: string;
  readonly requirePasswordAuth?: boolean;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}

export class RemoteAdmissionError extends Error {
  readonly code:
    | "malformed_input"
    | "redirect"
    | "http_error"
    | "invalid_response"
    | "password_required";

  constructor(code: RemoteAdmissionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export class RemoteGatewayRequiredError extends Error {
  readonly origin: string;

  constructor(origin: string) {
    super("Sign in to Cloudflare Access to connect to this server.");
    this.origin = origin;
  }
}

export class RemoteEnvironmentMismatchError extends Error {
  readonly code = "environment_id_mismatch";
  readonly expectedEnvironmentId: string;
  readonly actualEnvironmentId: string;

  constructor(expectedEnvironmentId: string, actualEnvironmentId: string) {
    super(
      "The server identity changed. Forget this server and add it again only if this was expected.",
    );
    this.expectedEnvironmentId = expectedEnvironmentId;
    this.actualEnvironmentId = actualEnvironmentId;
  }
}

export function normalizeRemoteOrigin(input: string, options: RemoteOriginOptions = {}): string {
  const trimmed = input.trim();
  if (trimmed.includes("?") || trimmed.includes("#"))
    throw new RemoteAdmissionError(
      "malformed_input",
      `Enter an ${options.allowInsecureHttp === true ? "HTTP or HTTPS" : "HTTPS"} server origin without credentials, a path, query, or fragment.`,
    );
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new RemoteAdmissionError("malformed_input", "Enter a valid HTTPS server origin.");
  }
  if (
    (url.protocol !== "https:" &&
      !(options.allowInsecureHttp === true && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new RemoteAdmissionError(
      "malformed_input",
      `Enter an ${options.allowInsecureHttp === true ? "HTTP or HTTPS" : "HTTPS"} server origin without credentials, a path, query, or fragment.`,
    );
  return url.origin;
}

export function isCloudflareAccessUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname.endsWith(".cloudflareaccess.com")
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}

export function isCloudflareAccessGate(origin: string, status: number, headers: Headers): boolean {
  if (status >= 300 && status < 400) {
    const location = headers.get("location");
    if (!location) return false;
    try {
      const target = new URL(location, origin);
      return (
        isCloudflareAccessUrl(target.href) ||
        (target.protocol === "https:" &&
          target.origin === origin &&
          !target.username &&
          !target.password &&
          target.pathname.startsWith("/cdn-cgi/access/"))
      );
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return false;
    }
  }
  return (
    (status === 401 || status === 403) &&
    ([...headers.keys()].some((name) => name.startsWith("cf-access-")) ||
      /Cloudflare-Access/i.test(headers.get("www-authenticate") ?? ""))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function inspectRemoteServer(
  originInput: string,
  options: RemoteInspectionOptions = {},
): Promise<RemoteServerInspection> {
  const origin = normalizeRemoteOrigin(originInput, options);
  const fetcher = options.fetcher ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(15_000);
  const readJson = async (path: string): Promise<unknown> => {
    const response = await fetcher(`${origin}${path}`, {
      cache: "no-store",
      credentials: "include",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal,
    });
    if (isCloudflareAccessGate(origin, response.status, response.headers))
      throw new RemoteGatewayRequiredError(origin);
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
      throw new RemoteAdmissionError(
        "redirect",
        "Remote server redirected the request. Enter the server's final origin.",
      );
    if (!response.ok)
      throw new RemoteAdmissionError(
        "http_error",
        `Remote server returned HTTP ${response.status}.`,
      );
    const text = await response.text();
    if (text.length > 1_000_000)
      throw new RemoteAdmissionError("invalid_response", "Remote server response is too large.");
    try {
      return JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new RemoteAdmissionError("invalid_response", "Remote server returned invalid JSON.");
    }
  };
  const descriptor = await readJson("/.well-known/t3/environment");
  if (
    !isRecord(descriptor) ||
    !nonEmptyString(descriptor.environmentId) ||
    !nonEmptyString(descriptor.label) ||
    !nonEmptyString(descriptor.serverVersion)
  )
    throw new RemoteAdmissionError(
      "invalid_response",
      "The server did not return a valid Cox environment descriptor.",
    );
  if (
    options.pinnedEnvironmentId !== undefined &&
    descriptor.environmentId !== options.pinnedEnvironmentId
  )
    throw new RemoteEnvironmentMismatchError(options.pinnedEnvironmentId, descriptor.environmentId);
  const session = await readJson("/api/auth/session");
  const auth = isRecord(session) && isRecord(session.auth) ? session.auth : undefined;
  const hostname = new URL(origin).hostname;
  const loopback =
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (((options.requirePasswordAuth ?? true) || !loopback) && auth?.loginMode !== "password")
    throw new RemoteAdmissionError(
      "password_required",
      "Remote Cox servers must enable COX_AUTH_PASSWORD.",
    );
  if (auth?.loginMode !== "password" && auth?.loginMode !== "local")
    throw new RemoteAdmissionError(
      "invalid_response",
      "Remote server returned invalid session metadata.",
    );
  return {
    origin,
    environmentId: descriptor.environmentId,
    label: descriptor.label.trim(),
    serverVersion: descriptor.serverVersion.trim(),
  };
}
