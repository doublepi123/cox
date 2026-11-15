import { MobileShellBridgeMessage } from "@t3tools/contracts";
import { normalizeRemoteOrigin } from "@t3tools/shared/remoteServerAdmission";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface WorkspaceProfile {
  readonly profileId: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
  readonly lastThreadPath: string | null;
  readonly label: string;
  readonly serverCount: number;
  readonly gatewayLogin?: boolean;
}

export class WorkspacePolicyError extends Error {
  readonly code: "profile_id" | "origin";

  constructor(code: WorkspacePolicyError["code"]) {
    super(`Invalid workspace ${code}.`);
    this.code = code;
  }
}

export function profileDataStoreId(profileId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId))
    throw new WorkspacePolicyError("profile_id");
  return profileId.toLowerCase();
}

export function workspaceProfile(input: WorkspaceProfile): WorkspaceProfile {
  const origin = normalizeRemoteOrigin(input.origin, input);
  if (origin !== input.origin) throw new WorkspacePolicyError("origin");
  return { ...input, profileId: profileDataStoreId(input.profileId) };
}

export interface WorkspaceState {
  readonly phase: "loading" | "ready" | "gateway_handoff";
  readonly generation: number;
  readonly bridgeToken: string | null;
}

export const initialWorkspaceState: WorkspaceState = {
  phase: "loading",
  generation: 0,
  bridgeToken: null,
};

export interface NavigationRequest {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly newWindow: boolean;
}

function accessChallenge(url: URL, profile: WorkspaceProfile): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname.endsWith(".cloudflareaccess.com") ||
      (url.origin === profile.origin && url.pathname.startsWith("/cdn-cgi/access/")))
  );
}

export function navigateWorkspace(
  profile: WorkspaceProfile,
  state: WorkspaceState,
  request: NavigationRequest,
): { readonly action: "allow" | "external" | "refuse"; readonly state: WorkspaceState } {
  const url = URL.parse(request.url);
  if (
    !url ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && profile.allowInsecureHttp))
  )
    return { action: "refuse", state };
  if (!request.isMainFrame && !request.newWindow) return { action: "allow", state };
  const gateway = accessChallenge(url, profile) || state.phase === "gateway_handoff";
  if ((request.newWindow || url.origin !== profile.origin) && !gateway)
    return { action: "external", state };
  return {
    action: "allow",
    state: {
      phase: gateway ? "gateway_handoff" : "loading",
      generation: state.generation + 1,
      bridgeToken: null,
    },
  };
}

export function commitWorkspace(
  profile: WorkspaceProfile,
  state: WorkspaceState,
  commit: { readonly url: string; readonly generation: number; readonly freshToken: string },
): WorkspaceState {
  const url = URL.parse(commit.url);
  if (
    commit.generation !== state.generation ||
    !url ||
    url.origin !== profile.origin ||
    accessChallenge(url, profile) ||
    !/^[0-9a-f]{64}$/.test(commit.freshToken)
  )
    return state;
  return { ...state, phase: "ready", bridgeToken: commit.freshToken };
}

export interface WorkspacePool {
  readonly active: string | null;
  readonly recent: readonly string[];
}

export function activateWorkspace(pool: WorkspacePool, profileId: string) {
  const id = profileDataStoreId(profileId);
  const recent = [...pool.recent.filter((entry) => entry !== id), id];
  return {
    pool: { active: id, recent: recent.slice(-2) },
    dispose: recent.slice(0, -2),
  };
}

export function trimWorkspaceMemory(pool: WorkspacePool) {
  return {
    pool: { active: pool.active, recent: pool.recent.filter((id) => id === pool.active) },
    dispose: pool.recent.filter((id) => id !== pool.active),
  };
}

export function forgetWorkspace(pool: WorkspacePool, profileId: string) {
  const id = profileDataStoreId(profileId);
  return {
    pool: {
      active: pool.active === id ? null : pool.active,
      recent: pool.recent.filter((entry) => entry !== id),
    },
    effects: [
      { type: "dispose", profileId: id },
      { type: "removeDataStore", profileId: id },
    ] as const,
  };
}

const decodeMessage = Schema.decodeUnknownOption(MobileShellBridgeMessage);

export function authorizeWorkspaceMessage(
  profile: WorkspaceProfile,
  state: WorkspaceState,
  message: {
    readonly isMainFrame: boolean;
    readonly securityOrigin: string;
    readonly payload: unknown;
  },
) {
  if (!message.isMainFrame) return { refusal: "frame" } as const;
  if (message.securityOrigin !== profile.origin) return { refusal: "origin" } as const;
  if (state.phase !== "ready" || state.bridgeToken === null)
    return { refusal: "detached" } as const;
  const decoded = decodeMessage(message.payload);
  if (Option.isNone(decoded)) return { refusal: "payload" } as const;
  const supplied = decoded.value.bridgeToken;
  let mismatch = supplied.length ^ state.bridgeToken.length;
  for (let index = 0; index < state.bridgeToken.length; index++)
    mismatch |= (supplied.charCodeAt(index) || 0) ^ state.bridgeToken.charCodeAt(index);
  if (mismatch !== 0) return { refusal: "token" } as const;
  return { message: decoded.value } as const;
}
