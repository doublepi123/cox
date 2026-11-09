import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { SoftwareUpdates } from "./software-updates.ts";

function setup(
  backendChange: Partial<DesktopBackendUpdateState> = {},
  clientChange: Partial<DesktopClientUpdateState> = {},
) {
  let backendState: DesktopBackendUpdateState = {
    desktopVersion: "0.2.16",
    bundledVersion: "0.1.54",
    currentVersion: "0.1.54",
    latestVersion: "0.1.54",
    status: "idle",
    message: null,
    automaticChecks: true,
    ...backendChange,
  };
  let clientState: DesktopClientUpdateState = {
    currentVersion: "0.2.16",
    latestVersion: "0.2.16",
    status: "idle",
    progress: null,
    message: null,
    installMode: "automatic",
    automaticChecks: true,
    ignoredVersion: null,
    ...clientChange,
  };
  const backend = {
    getState: () => ({ ...backendState }),
    check: vi.fn(async (_manual?: boolean) => backend.getState()),
    stage: vi.fn(async () => {
      backendState = { ...backendState, status: "ready" };
      return backend.getState();
    }),
    setPolicy: vi.fn(async (policy: "automatic" | "never" | "ignore-version") => {
      backendState = { ...backendState, automaticChecks: policy !== "never" };
      return backend.getState();
    }),
  };
  const client = {
    getState: () => ({ ...clientState }),
    check: vi.fn(async (_manual?: boolean) => client.getState()),
    download: vi.fn(async () => {
      clientState = { ...clientState, status: "ready" };
      return client.getState();
    }),
    setPolicy: vi.fn(async (policy: "automatic" | "never" | "ignore-version") => {
      clientState = { ...clientState, automaticChecks: policy !== "never" };
      return client.getState();
    }),
  };
  return {
    updates: new SoftwareUpdates(backend, client),
    backend,
    client,
    changeBackend: (change: Partial<DesktopBackendUpdateState>) => {
      backendState = { ...backendState, ...change };
    },
    changeClient: (change: Partial<DesktopClientUpdateState>) => {
      clientState = { ...clientState, ...change };
    },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("unified desktop updates", () => {
  it("checks both products manually with one deduplicated operation", async () => {
    const { updates, backend, client } = setup();
    const first = updates.check(true);
    expect(updates.check(true)).toBe(first);
    await first;
    expect(backend.check).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.check).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["backend", "client"] as const)(
    "disables all automatic checks when the %s policy is disabled",
    async (disabled) => {
      const { updates, backend, client } = setup(
        disabled === "backend" ? { automaticChecks: false } : {},
        disabled === "client" ? { automaticChecks: false } : {},
      );
      await updates.check();
      expect(backend.check).not.toHaveBeenCalled();
      expect(client.check).not.toHaveBeenCalled();
      await updates.check(true);
      expect(backend.check).toHaveBeenCalledWith(true);
      expect(client.check).toHaveBeenCalledWith(true);
    },
  );

  it("downloads both products together and ignores duplicate download clicks", async () => {
    const { updates, backend, client } = setup(
      { status: "available", latestVersion: "0.1.55" },
      { status: "available", latestVersion: "0.2.17" },
    );
    const downloading = updates.download();
    expect(updates.download()).toBe(downloading);
    expect(updates.check(true)).toBe(downloading);
    expect(await downloading).toMatchObject({
      backend: { status: "ready" },
      client: { status: "ready" },
    });
    expect(backend.stage).toHaveBeenCalledOnce();
    expect(client.download).toHaveBeenCalledOnce();
  });

  it("preserves a ready client and prepares the missing backend", async () => {
    const { updates, backend, client } = setup(
      { status: "available", latestVersion: "0.1.55" },
      { status: "ready", latestVersion: "0.2.17" },
    );
    await updates.download();
    expect(backend.stage).toHaveBeenCalledOnce();
    expect(client.download).not.toHaveBeenCalled();
  });

  it("rechecks failed backend downloads before retrying staging", async () => {
    const { updates, backend, changeBackend } = setup({ status: "error", latestVersion: "0.1.55" });
    backend.check.mockImplementation(async () => {
      changeBackend({ status: "available" });
      return backend.getState();
    });
    await updates.download();
    expect(backend.check).toHaveBeenCalledWith(true);
    expect(backend.stage).toHaveBeenCalledOnce();
  });

  it("never stages a stale version after a failed check", async () => {
    const { updates, backend } = setup({ status: "error", latestVersion: "0.1.54" });
    await updates.download();
    expect(backend.stage).not.toHaveBeenCalled();
    await expect(updates.apply(vi.fn(), vi.fn())).rejects.toThrow("not ready");
  });

  it("does not apply partially failed downloads or checks", async () => {
    const { updates, backend, changeBackend } = setup(
      { status: "available", latestVersion: "0.1.55" },
      { status: "available", latestVersion: "0.2.17" },
    );
    backend.stage.mockImplementation(async () => {
      changeBackend({ status: "error", message: "Download failed" });
      return backend.getState();
    });
    const state = await updates.download();
    expect(state.backend.status).toBe("error");
    expect(state.client.status).toBe("ready");
    const confirm = vi.fn();
    const install = vi.fn();
    await expect(updates.apply(confirm, install)).rejects.toThrow("not ready");
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("preserves manual checks requested during automatic checks, including downloads", async () => {
    const { updates, backend } = setup({ status: "available", latestVersion: "0.1.55" });
    const automatic = deferred<DesktopBackendUpdateState>();
    backend.check.mockImplementationOnce(() => automatic.promise);
    const checking = updates.check();
    const manual = updates.check(true);
    const downloading = updates.download();
    automatic.resolve(backend.getState());
    await Promise.all([checking, manual, downloading]);
    expect(backend.check.mock.calls).toEqual([[false], [true]]);
    expect(backend.stage).toHaveBeenCalledOnce();
  });

  it("does not download or confirm while a check failed without a target version", async () => {
    const { updates, backend, client } = setup(
      { status: "error", latestVersion: null },
      { status: "ready", latestVersion: "0.2.17" },
    );
    await updates.download();
    expect(backend.stage).not.toHaveBeenCalled();
    expect(client.download).not.toHaveBeenCalled();
    await expect(updates.apply(vi.fn(), vi.fn())).rejects.toThrow("not ready");
  });

  it.each(["checking", "available", "installing", "error"] as const)(
    "blocks applying a ready client while the backend is %s",
    async (status) => {
      const { updates } = setup(
        { status, latestVersion: "0.1.55" },
        { status: "ready", latestVersion: "0.2.17" },
      );
      await expect(updates.apply(vi.fn(), vi.fn())).rejects.toThrow("not ready");
    },
  );

  it.each(["backend", "client", "both"] as const)(
    "confirms and installs ready %s updates once",
    async (target) => {
      const { updates } = setup(
        target !== "client" ? { status: "ready", latestVersion: "0.1.55" } : {},
        target !== "backend" ? { status: "ready", latestVersion: "0.2.17" } : {},
      );
      const decision = deferred<boolean>();
      const confirm = vi.fn(() => decision.promise);
      const install = vi.fn(async () => {});
      const applying = updates.apply(confirm, install);
      await updates.apply(confirm, install);
      decision.resolve(true);
      await applying;
      expect(confirm).toHaveBeenCalledOnce();
      expect(install).toHaveBeenCalledExactlyOnceWith(updates.getState());
    },
  );

  it("allows a ready client to supply a required newer runtime", async () => {
    const { updates } = setup(
      { status: "incompatible", latestVersion: "0.1.55" },
      { status: "ready", latestVersion: "0.2.17" },
    );
    const install = vi.fn(async () => {});
    await updates.apply(async () => true, install);
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not quit or install when confirmation is cancelled", async () => {
    const { updates } = setup({ status: "ready", latestVersion: "0.1.55" });
    const install = vi.fn(async () => {});
    await updates.apply(async () => false, install);
    expect(install).not.toHaveBeenCalled();
    await updates.apply(async () => true, install);
    expect(install).toHaveBeenCalledOnce();
  });

  it("revalidates both versions after confirmation", async () => {
    const { updates, changeBackend } = setup({ status: "ready", latestVersion: "0.1.55" });
    const install = vi.fn(async () => {});
    await expect(
      updates.apply(async () => {
        changeBackend({ latestVersion: "0.1.56" });
        return true;
      }, install),
    ).rejects.toThrow("changed");
    expect(install).not.toHaveBeenCalled();
  });

  it("reports a partial policy failure and still updates the other product", async () => {
    const { updates, backend, client } = setup();
    backend.setPolicy.mockRejectedValue(new Error("Cannot save Cox policy"));
    await expect(updates.setPolicy("never")).rejects.toThrow("Cannot save Cox policy");
    expect(client.setPolicy).toHaveBeenCalledExactlyOnceWith("never");
    await updates.check();
    expect(backend.check).not.toHaveBeenCalled();
    expect(client.check).not.toHaveBeenCalled();
  });
});
