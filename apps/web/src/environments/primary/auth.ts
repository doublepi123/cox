import type { AuthBrowserSessionResult, AuthSessionState } from "@t3tools/contracts";
import { EnvironmentAuthRateLimitedError, EnvironmentHttpCommonError } from "@t3tools/contracts";
import type { EnvironmentHttpCommonError as EnvironmentHttpCommonErrorType } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";
import { stripSensitiveUrlToken } from "@t3tools/shared/remote";

import { PrimaryEnvironmentHttpClient } from "./httpClient";
import { runPrimaryHttp } from "../../lib/runtime";

const PrimaryEnvironmentRequestOperation = Schema.Literals([
  "fetch-session-state",
  "create-browser-session",
]);
type PrimaryEnvironmentRequestOperation = typeof PrimaryEnvironmentRequestOperation.Type;

export class PrimaryEnvironmentRequestError extends Schema.TaggedError<PrimaryEnvironmentRequestError>()(
  "PrimaryEnvironmentRequestError",
  {
    operation: PrimaryEnvironmentRequestOperation,
    status: Schema.Number,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(input: {
    readonly operation: PrimaryEnvironmentRequestOperation;
    readonly cause: unknown;
    readonly sessionId?: string;
  }): PrimaryEnvironmentRequestError {
    const status = readHttpApiStatus(input.cause) ?? 500;
    return new PrimaryEnvironmentRequestError({
      operation: input.operation,
      status,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      cause: input.cause,
    });
  }

  override get message(): string {
    return `Primary environment request failed during ${this.operation} (HTTP ${this.status}).`;
  }
}

const isPrimaryEnvironmentRequestError = Schema.is(PrimaryEnvironmentRequestError);

export class PrimaryEnvironmentCredentialRejectedError extends Schema.TaggedError<PrimaryEnvironmentCredentialRejectedError>()(
  "PrimaryEnvironmentCredentialRejectedError",
  {
    providedLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid password. Check the password and try again.";
  }
}

export class PrimaryEnvironmentAuthRateLimitedError extends Schema.TaggedError<PrimaryEnvironmentAuthRateLimitedError>()(
  "PrimaryEnvironmentAuthRateLimitedError",
  {
    retryAfterSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Too many failed attempts. Try again in {minutes} min.";
  }
}

export class PrimaryEnvironmentAuthSessionTimeoutError extends Schema.TaggedError<PrimaryEnvironmentAuthSessionTimeoutError>()(
  "PrimaryEnvironmentAuthSessionTimeoutError",
  {
    timeoutMs: Schema.Number,
    elapsedMs: Schema.Number,
  },
) {
  override get message(): string {
    return "Timed out waiting for authenticated session after bootstrap.";
  }
}

export class PrimaryEnvironmentCredentialRequiredError extends Schema.TaggedError<PrimaryEnvironmentCredentialRequiredError>()(
  "PrimaryEnvironmentCredentialRequiredError",
  {
    providedLength: Schema.Number,
  },
) {
  override get message(): string {
    return "Enter your password to continue.";
  }
}

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentAuthRateLimitedError = Schema.is(EnvironmentAuthRateLimitedError);

type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;
const BOOTSTRAP_REQUEST_TIMEOUT_MS = 5_000;

export async function fetchSessionState(): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    try {
      return await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.auth.session({ headers: {} })),
          Effect.timeout(BOOTSTRAP_REQUEST_TIMEOUT_MS),
        ),
      );
    } catch (error) {
      throw PrimaryEnvironmentRequestError.fromCause({
        operation: "fetch-session-state",
        cause: error,
      });
    }
  });
}

function readHttpApiStatus(error: unknown): number | null {
  if (isEnvironmentHttpCommonError(error)) {
    return readEnvironmentHttpErrorStatus(error);
  }
  return HttpClientError.isHttpClientError(error) && error.response !== undefined
    ? error.response.status
    : null;
}

function readEnvironmentHttpErrorStatus(error: EnvironmentHttpCommonErrorType): number {
  switch (error._tag) {
    case "EnvironmentRequestInvalidError":
      return 400;
    case "EnvironmentAuthInvalidError":
      return 401;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return 403;
    case "EnvironmentResourceNotFoundError":
      return 404;
    case "EnvironmentInternalError":
      return 500;
  }
}

async function createBrowserSession(credential?: string): Promise<AuthBrowserSessionResult> {
  return retryTransientBootstrap(async () => {
    try {
      return await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.auth.browserSession({ payload: credential === undefined ? {} : { credential } }),
          ),
          Effect.timeout(BOOTSTRAP_REQUEST_TIMEOUT_MS),
        ),
      );
    } catch (error) {
      if (isEnvironmentAuthRateLimitedError(error)) {
        throw new PrimaryEnvironmentAuthRateLimitedError({
          retryAfterSeconds: error.retryAfterSeconds,
          cause: error,
        });
      }
      if (
        credential !== undefined &&
        isEnvironmentHttpCommonError(error) &&
        error._tag === "EnvironmentAuthInvalidError" &&
        error.reason === "invalid_credential"
      ) {
        throw new PrimaryEnvironmentCredentialRejectedError({
          providedLength: credential.length,
          cause: error,
        });
      }
      throw PrimaryEnvironmentRequestError.fromCause({
        operation: "create-browser-session",
        cause: error,
      });
    }
  });
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();

  while (true) {
    const session = await fetchSessionState();
    if (session.authenticated) {
      return session;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      throw new PrimaryEnvironmentAuthSessionTimeoutError({
        timeoutMs: AUTH_SESSION_ESTABLISH_TIMEOUT_MS,
        elapsedMs,
      });
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientBootstrapError(error: unknown): boolean {
  if (isPrimaryEnvironmentRequestError(error)) {
    return (
      TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status) || isTransientBootstrapError(error.cause)
    );
  }

  if (Cause.isTimeoutError(error)) {
    return true;
  }

  if (HttpClientError.isHttpClientError(error)) {
    return error.response === undefined;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const session = await fetchSessionState();
  if (session.authenticated) {
    return { status: "authenticated" };
  }
  if (session.auth.loginMode === "password") {
    return { status: "requires-auth", auth: session.auth };
  }
  await createBrowserSession();
  await waitForAuthenticatedSessionAfterBootstrap();
  return { status: "authenticated" };
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new PrimaryEnvironmentCredentialRequiredError({
      providedLength: credential.length,
    });
  }

  resolvedAuthenticatedGateState = null;
  await createBrowserSession(trimmedCredential);
  await waitForAuthenticatedSessionAfterBootstrap();
  resolvedAuthenticatedGateState = { status: "authenticated" };
  bootstrapPromise = null;
}

export function invalidateServerAuthGate(): void {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    const sanitized = stripSensitiveUrlToken(url);
    if (sanitized.href !== url.href) {
      window.history.replaceState(window.history.state, document.title, sanitized.href);
    }
  }
  if (bootstrapPromise) {
    return bootstrapPromise;
  }
  if (resolvedAuthenticatedGateState?.status === "authenticated") {
    return resolvedAuthenticatedGateState;
  }
  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = nextPromise;
  return nextPromise
    .then((result) => {
      if (bootstrapPromise === nextPromise && result.status === "authenticated") {
        resolvedAuthenticatedGateState = result;
      }
      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}
