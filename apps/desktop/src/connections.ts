import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  newRemoteProfileId,
  normalizeRemoteOrigin,
  remoteProfileId,
  type RemoteServerInspection,
} from "./remote.ts";

export interface RemoteConnectionProfile extends RemoteServerInspection {
  readonly id: string;
  readonly name: string;
}

export type DesktopConnectionTarget =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly profileId: string }
  | null;

export interface DesktopConnectionSnapshot {
  readonly active: DesktopConnectionTarget;
  readonly profiles: ReadonlyArray<RemoteConnectionProfile>;
}

interface StoredConnections {
  readonly version: 1;
  readonly active: DesktopConnectionTarget;
  readonly profiles: ReadonlyArray<RemoteConnectionProfile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid connection settings.");
  return value.trim();
}

function decodeProfile(value: unknown): RemoteConnectionProfile {
  if (!isRecord(value)) throw new Error("Invalid connection settings.");
  return {
    id: remoteProfileId(string(value.id)),
    name: string(value.name),
    origin: normalizeRemoteOrigin(string(value.origin)),
    environmentId: string(value.environmentId),
    label: string(value.label),
    serverVersion: string(value.serverVersion),
  };
}

function decodeTarget(value: unknown, profiles: ReadonlyArray<RemoteConnectionProfile>) {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("Invalid connection settings.");
  if (value.kind === "local") return { kind: "local" } as const;
  if (value.kind !== "remote") throw new Error("Invalid connection settings.");
  const profileId = remoteProfileId(string(value.profileId));
  if (!profiles.some((profile) => profile.id === profileId))
    throw new Error("Invalid active connection settings.");
  return { kind: "remote", profileId } as const;
}

export class DesktopConnectionStore {
  private readonly file: string;
  private state: StoredConnections;

  constructor(home: string, initialActive: DesktopConnectionTarget = { kind: "local" }) {
    this.file = join(home, "connections.json");
    if (!existsSync(this.file)) {
      this.state = { version: 1, active: initialActive, profiles: [] };
      return;
    }
    const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles))
      throw new Error("Invalid connection settings.");
    const profiles = value.profiles.map(decodeProfile);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
      throw new Error("Invalid duplicate connection settings.");
    this.state = { version: 1, active: decodeTarget(value.active, profiles), profiles };
  }

  snapshot(): DesktopConnectionSnapshot {
    return structuredClone({ active: this.state.active, profiles: this.state.profiles });
  }

  profile(id: string): RemoteConnectionProfile | undefined {
    const normalized = remoteProfileId(id);
    return this.state.profiles.find((profile) => profile.id === normalized);
  }

  saveRemote(
    inspection: RemoteServerInspection,
    input: { readonly id?: string; readonly name?: string },
  ): RemoteConnectionProfile {
    const existing = input.id
      ? this.profile(input.id)
      : this.state.profiles.find((profile) => profile.origin === inspection.origin);
    if (existing && existing.environmentId !== inspection.environmentId)
      throw new Error(
        "The server identity changed. Forget this server and add it again only if this was expected.",
      );
    const profile: RemoteConnectionProfile = {
      id: existing?.id ?? newRemoteProfileId(),
      name: input.name?.trim() || existing?.name || inspection.label,
      ...inspection,
    };
    this.state = {
      ...this.state,
      profiles: existing
        ? this.state.profiles.map((candidate) =>
            candidate.id === existing.id ? profile : candidate,
          )
        : [...this.state.profiles, profile],
    };
    this.persist();
    return profile;
  }

  setActive(active: DesktopConnectionTarget): void {
    if (active?.kind === "remote" && !this.profile(active.profileId))
      throw new Error("Unknown remote server.");
    this.state = { ...this.state, active };
    this.persist();
  }

  remove(id: string): void {
    const profileId = remoteProfileId(id);
    this.state = {
      ...this.state,
      active:
        this.state.active?.kind === "remote" && this.state.active.profileId === profileId
          ? null
          : this.state.active,
      profiles: this.state.profiles.filter((profile) => profile.id !== profileId),
    };
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
