import type { DesktopSoftwareUpdateState } from "@t3tools/contracts";
import type { BackendUpdates } from "./backend-updates.ts";
import type { ClientUpdates } from "./client-updates.ts";

type Backend = Pick<BackendUpdates, "getState" | "check" | "stage" | "setPolicy">;
type Client = Pick<ClientUpdates, "getState" | "check" | "download" | "setPolicy">;

export function softwareUpdateReady({ backend, client }: DesktopSoftwareUpdateState): boolean {
  if (
    [backend.status, client.status].some((status) =>
      ["checking", "installing", "downloading", "error", "available"].includes(status),
    )
  )
    return false;
  if (backend.status === "incompatible") return client.status === "ready";
  return backend.status === "ready" || client.status === "ready";
}

export class SoftwareUpdates {
  private readonly backend: Backend;
  private readonly client: Client;
  private checking: Promise<DesktopSoftwareUpdateState> | undefined;
  private checkingManual = false;
  private downloading: Promise<DesktopSoftwareUpdateState> | undefined;
  private applying = false;

  constructor(backend: Backend, client: Client) {
    this.backend = backend;
    this.client = client;
  }

  getState(): DesktopSoftwareUpdateState {
    return { backend: this.backend.getState(), client: this.client.getState() };
  }

  check(manual = false): Promise<DesktopSoftwareUpdateState> {
    if (this.downloading) return this.downloading;
    if (this.applying) return Promise.resolve(this.getState());
    return this.checkProducts(manual);
  }

  private checkProducts(manual: boolean): Promise<DesktopSoftwareUpdateState> {
    if (this.checking) {
      if (manual && !this.checkingManual) return this.checking.then(() => this.checkProducts(true));
      return this.checking;
    }
    if (
      !manual &&
      (this.backend.getState().automaticChecks === false || !this.client.getState().automaticChecks)
    )
      return Promise.resolve(this.getState());
    this.checkingManual = manual;
    this.checking = (async () => {
      try {
        await Promise.all([this.backend.check(manual), this.client.check(manual)]);
        return this.getState();
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  download(): Promise<DesktopSoftwareUpdateState> {
    if (this.downloading) return this.downloading;
    if (this.applying) return Promise.resolve(this.getState());
    const checked = this.checkProducts(true);
    this.downloading = (async () => {
      try {
        await checked;
        const { backend, client } = this.getState();
        await Promise.all([
          backend.status === "available" ? this.backend.stage() : undefined,
          client.status === "available" ? this.client.download() : undefined,
        ]);
        return this.getState();
      } finally {
        this.downloading = undefined;
      }
    })();
    return this.downloading;
  }

  async setPolicy(policy: "automatic" | "never"): Promise<DesktopSoftwareUpdateState> {
    const results = await Promise.allSettled([
      this.backend.setPolicy(policy),
      this.client.setPolicy(policy),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return this.getState();
  }

  async apply(
    confirm: (state: DesktopSoftwareUpdateState) => Promise<boolean>,
    install: (state: DesktopSoftwareUpdateState) => Promise<void>,
  ): Promise<void> {
    if (this.applying) return;
    if (this.checking || this.downloading || !softwareUpdateReady(this.getState()))
      throw new Error("Software updates are not ready.");
    this.applying = true;
    try {
      const state = this.getState();
      if (!(await confirm(state))) return;
      const current = this.getState();
      if (
        !softwareUpdateReady(current) ||
        current.backend.latestVersion !== state.backend.latestVersion ||
        current.client.latestVersion !== state.client.latestVersion
      )
        throw new Error("Software updates changed. Check for updates again.");
      await install(current);
    } finally {
      this.applying = false;
    }
  }
}
