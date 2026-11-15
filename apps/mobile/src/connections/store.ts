import {
  inspectRemoteServer,
  normalizeRemoteOrigin,
  RemoteEnvironmentMismatchError,
  RemoteGatewayRequiredError,
  type RemoteServerInspection,
} from "@t3tools/shared/remoteServerAdmission";
import { biometricVault, VaultError, type BiometricVault } from "../vault/biometricVault";

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

export interface ConnectionStoreOptions {
  readonly storage: ConnectionStorage;
  readonly fetcher?: typeof fetch;
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
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly vault: BiometricVault;
  private readonly listeners = new Set<() => void>();
  private snapshot: ConnectionSnapshot;

  constructor(options: ConnectionStoreOptions) {
    this.storage = options.storage;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.vault = options.vault ?? biometricVault;
    this.snapshot = decodeSnapshot(this.storage.getItem(CONNECTION_STORAGE_KEY));
  }

  async saveServer(draft: ServerDraft): Promise<SavedServerProfile> {
    const existing = draft.id === undefined ? undefined : this.requireProfile(draft.id);
    const allowInsecureHttp = /^http:\/\//i.test(draft.origin.trim()) && draft.allowInsecureHttp;
    const origin = normalizeRemoteOrigin(draft.origin, { allowInsecureHttp });
    const inspection = await inspectRemoteServer(origin, {
      allowInsecureHttp,
      ...(existing ? { pinnedEnvironmentId: existing.pinnedEnvironmentId } : {}),
      fetcher: this.fetcher,
    });
    const profile = this.profileFromInspection(draft, inspection, existing);
    if (draft.savePasswordInVault) {
      if (draft.password) {
        await this.vault.savePassword({
          profileId: profile.id,
          canonicalOrigin: profile.origin,
          password: draft.password,
          requireBiometric: draft.requireBiometric ?? true,
        });
      } else if (!existing?.hasSavedPassword || existing.origin !== profile.origin) {
        throw new VaultError("invalid_input");
      }
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
      inspection = await inspectRemoteServer(existing.origin, {
        allowInsecureHttp: existing.allowInsecureHttp,
        pinnedEnvironmentId: existing.pinnedEnvironmentId,
        fetcher: this.fetcher,
      });
    } catch (error) {
      const healthStatus =
        error instanceof RemoteEnvironmentMismatchError
          ? "identity_mismatch"
          : error instanceof RemoteGatewayRequiredError
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
  ): SavedServerProfile {
    return {
      id: existing?.id ?? this.newId(),
      label: draft.label.trim() || inspection.label,
      origin: inspection.origin,
      allowInsecureHttp: inspection.origin.startsWith("http://") && draft.allowInsecureHttp,
      pinnedEnvironmentId: inspection.environmentId,
      lastServerVersion: inspection.serverVersion,
      hasSavedPassword: draft.savePasswordInVault,
      lastThreadPath: existing?.lastThreadPath ?? null,
      lastConnectedAt: existing?.lastConnectedAt ?? null,
      healthStatus: existing?.healthStatus ?? "unverified",
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
