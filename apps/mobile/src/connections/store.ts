import {
  inspectRemoteServer,
  normalizeRemoteOrigin,
  RemoteEnvironmentMismatchError,
  RemoteGatewayRequiredError,
  type RemoteServerInspection,
} from "@t3tools/shared/remoteServerAdmission";
import { biometricVault, VaultError, type BiometricVault } from "../vault/biometricVault";
import {
  canSignInToWorkspaceGateway,
  createProfileFetcher,
  forgetWorkspaceProfile,
  GatewaySignInError,
  signInToWorkspaceGateway,
  type GatewaySignInRequest,
} from "../workspace/workspacePlugin";

export const CONNECTION_STORAGE_KEY = "cox.mobile.connections.v1";

export interface SavedServerProfile {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
  readonly pinnedEnvironmentId: string;
  readonly lastServerVersion: string;
  readonly hasSavedPassword: boolean;
  readonly lastThreadPath: string | null;
  readonly lastConnectedAt: string | null;
  readonly healthStatus:
    | "unverified"
    | "verified"
    | "identity_mismatch"
    | "gateway_required"
    | "unreachable";
}

export interface ConnectionSnapshot {
  readonly profiles: readonly SavedServerProfile[];
}

export interface ServerDraft {
  readonly id?: string;
  readonly label: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
  readonly savePasswordInVault: boolean;
  readonly password?: string;
  readonly requireBiometric?: boolean;
}

export interface ConnectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ProfileFetcherTarget {
  readonly profileId: string;
  readonly origin: string;
  readonly allowInsecureHttp: boolean;
}

export interface ConnectionStoreOptions {
  readonly storage: ConnectionStorage;
  readonly fetcher?: typeof fetch;
  readonly profileFetcher?: (target: ProfileFetcherTarget) => typeof fetch;
  readonly canSignInToGateway?: () => boolean;
  readonly signInToGateway?: (request: GatewaySignInRequest) => Promise<void>;
  readonly cleanupUnsavedProfile?: (profile: {
    readonly id: string;
    readonly origin: string;
  }) => Promise<void>;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly vault?: BiometricVault;
}

interface StoredConnections extends ConnectionSnapshot {
  readonly version: 1;
}

export class ConnectionStoreError extends Error {
  readonly code: "invalid_storage" | "unknown_server";

  constructor(code: ConnectionStoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ConnectionStoreError("invalid_storage", "Invalid saved server settings.");
  return value.trim();
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new ConnectionStoreError("invalid_storage", "Invalid saved server settings.");
  return value;
}

function decodeProfile(value: unknown): SavedServerProfile {
  if (!isRecord(value))
    throw new ConnectionStoreError("invalid_storage", "Invalid saved server settings.");
  const id = requiredString(value.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new ConnectionStoreError("invalid_storage", "Invalid saved server identifier.");
  const requestedInsecureHttp = requiredBoolean(value.allowInsecureHttp);
  const storedOrigin = requiredString(value.origin);
  const allowInsecureHttp = requestedInsecureHttp && storedOrigin.startsWith("http://");
  const lastConnectedAt = nullableString(value.lastConnectedAt);
  const healthStatus =
    value.healthStatus === undefined
      ? lastConnectedAt
        ? "verified"
        : "unverified"
      : value.healthStatus;
  if (
    healthStatus !== "unverified" &&
    healthStatus !== "verified" &&
    healthStatus !== "identity_mismatch" &&
    healthStatus !== "gateway_required" &&
    healthStatus !== "unreachable"
  )
    throw new ConnectionStoreError("invalid_storage", "Invalid saved server settings.");
  return {
    id,
    label: requiredString(value.label),
    origin: normalizeRemoteOrigin(storedOrigin, { allowInsecureHttp }),
    allowInsecureHttp,
    pinnedEnvironmentId: requiredString(value.pinnedEnvironmentId),
    lastServerVersion: requiredString(value.lastServerVersion),
    hasSavedPassword: requiredBoolean(value.hasSavedPassword),
    lastThreadPath: nullableString(value.lastThreadPath),
    lastConnectedAt,
    healthStatus,
  };
}

function decodeSnapshot(raw: string | null): ConnectionSnapshot {
  if (raw === null) return { profiles: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ConnectionStoreError(
        "invalid_storage",
        "Saved server settings are not valid JSON.",
      );
    throw error;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles))
    throw new ConnectionStoreError("invalid_storage", "Unsupported saved server settings.");
  const profiles = value.profiles.map(decodeProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new ConnectionStoreError("invalid_storage", "Duplicate saved server identifiers.");
  return { profiles };
}

export class ConnectionStore {
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConnectionSnapshot => this.snapshot;

  private readonly storage: ConnectionStorage;
  private readonly profileFetcher: (target: ProfileFetcherTarget) => typeof fetch;
  private readonly canSignInToGateway: () => boolean;
  private readonly signInToGateway: (request: GatewaySignInRequest) => Promise<void>;
  private readonly cleanupUnsavedProfile: (profile: {
    readonly id: string;
    readonly origin: string;
  }) => Promise<void>;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly vault: BiometricVault;
  private readonly listeners = new Set<() => void>();
  private snapshot: ConnectionSnapshot;

  constructor(options: ConnectionStoreOptions) {
    this.storage = options.storage;
    const explicitFetcher = options.fetcher;
    this.profileFetcher =
      options.profileFetcher ??
      (explicitFetcher ? () => explicitFetcher : (target) => createProfileFetcher(target));
    this.canSignInToGateway =
      options.canSignInToGateway ??
      (options.signInToGateway ? () => true : canSignInToWorkspaceGateway);
    this.signInToGateway = options.signInToGateway ?? signInToWorkspaceGateway;
    this.cleanupUnsavedProfile = options.cleanupUnsavedProfile ?? forgetWorkspaceProfile;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.vault = options.vault ?? biometricVault;
    this.snapshot = decodeSnapshot(this.storage.getItem(CONNECTION_STORAGE_KEY));
  }

  private async safeCleanupProfile(profile: {
    readonly id: string;
    readonly origin: string;
  }): Promise<void> {
    try {
      await this.cleanupUnsavedProfile(profile);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }

  private async inspectWithGateway(
    target: ProfileFetcherTarget,
    pinnedEnvironmentId: string | undefined,
    isUnsaved: boolean,
  ): Promise<{ readonly inspection: RemoteServerInspection; readonly usedGateway: boolean }> {
    const runInspect = () =>
      inspectRemoteServer(target.origin, {
        allowInsecureHttp: target.allowInsecureHttp,
        ...(pinnedEnvironmentId !== undefined ? { pinnedEnvironmentId } : {}),
        fetcher: this.profileFetcher(target),
      });
    try {
      return { inspection: await runInspect(), usedGateway: false };
    } catch (error) {
      if (!(error instanceof RemoteGatewayRequiredError) || !this.canSignInToGateway()) {
        throw error;
      }
      try {
        await this.signInToGateway({ profileId: target.profileId, origin: error.origin });
        return { inspection: await runInspect(), usedGateway: true };
      } catch (signInError) {
        if (isUnsaved) {
          await this.safeCleanupProfile({ id: target.profileId, origin: target.origin });
        }
        throw signInError;
      }
    }
  }

  async saveServer(draft: ServerDraft): Promise<SavedServerProfile> {
    const allowInsecureHttp = /^http:\/\//i.test(draft.origin.trim()) && draft.allowInsecureHttp;
    const origin = normalizeRemoteOrigin(draft.origin, { allowInsecureHttp });
    const existing =
      draft.id !== undefined
        ? this.requireProfile(draft.id)
        : this.snapshot.profiles.find((candidate) => candidate.origin === origin);
    if (
      draft.savePasswordInVault &&
      !draft.password &&
      (!existing?.hasSavedPassword || existing.origin !== origin)
    ) {
      throw new VaultError("invalid_input");
    }
    const profileId = existing?.id ?? this.newId();
    const { inspection } = await this.inspectWithGateway(
      { profileId, origin, allowInsecureHttp },
      existing && existing.origin === origin ? existing.pinnedEnvironmentId : undefined,
      existing === undefined,
    );
    const profile = this.profileFromInspection(draft, inspection, existing, profileId);
    if (draft.savePasswordInVault && draft.password) {
      await this.vault.savePassword({
        profileId: profile.id,
        canonicalOrigin: profile.origin,
        password: draft.password,
        requireBiometric: draft.requireBiometric ?? true,
      });
    }
    if (existing && existing.origin !== profile.origin) {
      await this.safeCleanupProfile({ id: existing.id, origin: existing.origin });
    }
    const profiles = existing
      ? this.snapshot.profiles.map((candidate) =>
          candidate.id === existing.id ? profile : candidate,
        )
      : [...this.snapshot.profiles, profile];
    if (existing?.hasSavedPassword && !draft.savePasswordInVault) {
      await this.commitAfterVaultDeletion(existing.id, profiles);
    } else {
      this.commit(profiles);
    }
    return profile;
  }

  async connect(id: string): Promise<SavedServerProfile> {
    const existing = this.requireProfile(id);
    let inspection: RemoteServerInspection;
    try {
      ({ inspection } = await this.inspectWithGateway(
        {
          profileId: existing.id,
          origin: existing.origin,
          allowInsecureHttp: existing.allowInsecureHttp,
        },
        existing.pinnedEnvironmentId,
        false,
      ));
    } catch (error) {
      const healthStatus =
        error instanceof RemoteEnvironmentMismatchError
          ? "identity_mismatch"
          : error instanceof RemoteGatewayRequiredError || error instanceof GatewaySignInError
            ? "gateway_required"
            : "unreachable";
      this.updateHealth(id, healthStatus);
      throw error;
    }
    const current = this.requireProfile(id);
    if (current.hasSavedPassword) {
      await this.vault.unlockAndAutofillPassword({
        profileId: current.id,
        canonicalOrigin: current.origin,
        allowInsecureHttp: current.allowInsecureHttp,
      });
    }
    const profile: SavedServerProfile = {
      ...current,
      lastServerVersion: inspection.serverVersion,
      lastConnectedAt: this.now(),
      healthStatus: "verified",
    };
    this.commit(
      this.snapshot.profiles.map((candidate) => (candidate.id === id ? profile : candidate)),
    );
    return profile;
  }

  private updateHealth(id: string, healthStatus: SavedServerProfile["healthStatus"]): void {
    this.commit(
      this.snapshot.profiles.map((candidate) =>
        candidate.id === id ? { ...candidate, healthStatus } : candidate,
      ),
    );
  }

  restore(profile: SavedServerProfile, index: number): void {
    if (this.snapshot.profiles.some((candidate) => candidate.id === profile.id)) return;
    const profiles = [...this.snapshot.profiles];
    const destination = Math.max(0, Math.min(Math.trunc(index), profiles.length));
    profiles.splice(destination, 0, profile);
    this.commit(profiles);
  }

  move(id: string, targetIndex: number): void {
    const fromIndex = this.snapshot.profiles.findIndex((profile) => profile.id === id);
    if (fromIndex < 0) throw new ConnectionStoreError("unknown_server", "Unknown remote server.");
    const profiles = [...this.snapshot.profiles];
    const [profile] = profiles.splice(fromIndex, 1);
    if (profile === undefined)
      throw new ConnectionStoreError("unknown_server", "Unknown remote server.");
    const destination = Math.max(0, Math.min(Math.trunc(targetIndex), profiles.length));
    profiles.splice(destination, 0, profile);
    if (destination !== fromIndex) this.commit(profiles);
  }

  rememberThreadPath(id: string, path: string): void {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return;
    const existing = this.snapshot.profiles.find((profile) => profile.id === id);
    if (!existing || existing.lastThreadPath === path) return;
    this.commit(
      this.snapshot.profiles.map((candidate) =>
        candidate.id === id ? { ...candidate, lastThreadPath: path } : candidate,
      ),
    );
  }

  async forget(id: string): Promise<void> {
    const profile = this.snapshot.profiles.find((candidate) => candidate.id === id);
    if (!profile) return;
    const profiles = this.snapshot.profiles.filter((candidate) => candidate.id !== id);
    if (profile.hasSavedPassword) {
      await this.commitAfterVaultDeletion(id, profiles);
    } else {
      this.commit(profiles);
    }
  }

  private async commitAfterVaultDeletion(
    id: string,
    profiles: readonly SavedServerProfile[],
  ): Promise<void> {
    const previousRaw = this.storage.getItem(CONNECTION_STORAGE_KEY);
    const previousSnapshot = this.snapshot;
    const write = this.storage.setItem.bind(this.storage);
    const stored: StoredConnections = { version: 1, profiles };
    write(CONNECTION_STORAGE_KEY, JSON.stringify(stored));
    try {
      await this.vault.deletePassword(id);
    } catch (error) {
      if (previousRaw !== null) write(CONNECTION_STORAGE_KEY, previousRaw);
      this.snapshot = previousSnapshot;
      throw error;
    }
    this.snapshot = { profiles };
    for (const listener of this.listeners) listener();
  }

  private requireProfile(id: string): SavedServerProfile {
    const profile = this.snapshot.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ConnectionStoreError("unknown_server", "Unknown remote server.");
    return profile;
  }

  private profileFromInspection(
    draft: ServerDraft,
    inspection: RemoteServerInspection,
    existing: SavedServerProfile | undefined,
    profileId: string,
  ): SavedServerProfile {
    return {
      id: profileId,
      label: draft.label.trim() || inspection.label,
      origin: inspection.origin,
      allowInsecureHttp: inspection.origin.startsWith("http://") && draft.allowInsecureHttp,
      pinnedEnvironmentId: inspection.environmentId,
      lastServerVersion: inspection.serverVersion,
      hasSavedPassword: draft.savePasswordInVault,
      lastThreadPath:
        existing && existing.origin === inspection.origin ? existing.lastThreadPath : null,
      lastConnectedAt:
        existing && existing.origin === inspection.origin ? existing.lastConnectedAt : null,
      healthStatus:
        existing && existing.origin === inspection.origin ? existing.healthStatus : "unverified",
    };
  }

  private commit(profiles: readonly SavedServerProfile[]): void {
    const previous = this.snapshot;
    this.snapshot = { profiles };
    const stored: StoredConnections = { version: 1, profiles };
    try {
      this.storage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      this.snapshot = previous;
      throw error;
    }
    for (const listener of this.listeners) listener();
  }
}
