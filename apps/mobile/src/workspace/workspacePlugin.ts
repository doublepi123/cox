import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { WorkspaceProfile } from "./iosWorkspacePolicy";
import { workspaceProfile } from "./iosWorkspacePolicy";

export interface ProfileUrlRequest {
  readonly profileId: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
  readonly url: string;
}

export interface ProfileUrlResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface GatewaySignInRequest {
  readonly profileId: string;
  readonly origin: string;
}

export class GatewaySignInError extends Error {
  readonly code: "gateway_cancelled" | "gateway_unavailable";

  constructor(code: GatewaySignInError["code"], message?: string, options?: ErrorOptions) {
    super(
      message ??
        (code === "gateway_cancelled"
          ? "Cloudflare Access sign-in was cancelled."
          : "Cloudflare Access sign-in could not be completed."),
      options,
    );
    this.code = code;
  }
}

interface WorkspacePlugin {
  syncLauncherTheme?(options: { readonly color: string | null }): Promise<void>;
  requestProfileUrl?(request: ProfileUrlRequest): Promise<ProfileUrlResponse>;
  signInToGateway?(request: GatewaySignInRequest): Promise<void>;
  openWorkspace(profile: WorkspaceProfile): Promise<void>;
  closeWorkspace(): Promise<void>;
  forgetProfile(profile: { readonly profileId: string; readonly origin: string }): Promise<void>;
  addListener(
    event: "openServerSwitcher" | "openConnectionManager",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "workspaceLocation",
    listener: (location: { readonly profileId: string; readonly path: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const CoxWorkspaceWebView = registerPlugin<WorkspacePlugin>("CoxWorkspaceWebView");

export const hasNativeWorkspace = () => Capacitor.isNativePlatform();

function pluginErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function createProfileFetcher(target: {
  readonly profileId: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
}): typeof fetch {
  return async (input, init) => {
    if (!hasNativeWorkspace() || typeof CoxWorkspaceWebView.requestProfileUrl !== "function") {
      return await fetch(input, init);
    }
    if (init?.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    try {
      const response = await CoxWorkspaceWebView.requestProfileUrl({
        profileId: target.profileId,
        origin: target.origin,
        allowInsecureHttp: target.allowInsecureHttp,
        url,
      });
      const body = response.status >= 300 && response.status < 400 ? null : response.body;
      return new Response(body, {
        status: response.status,
        headers: new Headers(response.headers),
      });
    } catch (error) {
      const code = pluginErrorCode(error);
      if (code === "network_error" || error instanceof Error) {
        throw new TypeError(error instanceof Error ? error.message : "Network request failed.", {
          cause: error,
        });
      }
      throw error;
    }
  };
}

export function canSignInToWorkspaceGateway(): boolean {
  return hasNativeWorkspace() && typeof CoxWorkspaceWebView.signInToGateway === "function";
}

export async function signInToWorkspaceGateway(request: GatewaySignInRequest): Promise<void> {
  if (!canSignInToWorkspaceGateway() || typeof CoxWorkspaceWebView.signInToGateway !== "function") {
    throw new GatewaySignInError("gateway_unavailable");
  }
  try {
    await CoxWorkspaceWebView.signInToGateway(request);
  } catch (error) {
    if (error instanceof GatewaySignInError) throw error;
    const code = pluginErrorCode(error);
    if (code === "gateway_cancelled") {
      throw new GatewaySignInError("gateway_cancelled", undefined, { cause: error });
    }
    if (error instanceof Error) {
      throw new GatewaySignInError("gateway_unavailable", error.message, { cause: error });
    }
    throw error;
  }
}

export async function syncNativeLauncherTheme(color: string | null): Promise<void> {
  if (hasNativeWorkspace() && typeof CoxWorkspaceWebView.syncLauncherTheme === "function") {
    try {
      await CoxWorkspaceWebView.syncLauncherTheme({ color });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
}

export async function openWorkspace(profile: WorkspaceProfile): Promise<void> {
  if (hasNativeWorkspace()) await CoxWorkspaceWebView.openWorkspace(workspaceProfile(profile));
}

export async function forgetWorkspaceProfile(profile: {
  readonly id: string;
  readonly origin: string;
}): Promise<void> {
  if (hasNativeWorkspace())
    await CoxWorkspaceWebView.forgetProfile({ profileId: profile.id, origin: profile.origin });
}

export async function subscribeWorkspaceLocation(
  listener: (location: { readonly profileId: string; readonly path: string }) => void,
): Promise<() => void> {
  if (!hasNativeWorkspace() || typeof CoxWorkspaceWebView.addListener !== "function") {
    return () => {};
  }
  try {
    const handle = await CoxWorkspaceWebView.addListener("workspaceLocation", listener);
    return () => {
      void handle.remove();
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return () => {};
  }
}
