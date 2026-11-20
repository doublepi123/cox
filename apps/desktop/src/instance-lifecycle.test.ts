import { describe, expect, it, vi } from "vite-plus/test";
import {
  InstanceOwnership,
  LOCAL_BACKEND_PROCESS_ID,
  LOCAL_CONNECTION_KEY,
  LOCAL_INSTANCE_ID,
  remoteClientProcessId,
  remoteConnectionKey,
  snapshotHasInterruptibleWork,
} from "./instance-lifecycle.ts";
import { killOwnedProcessTree, processTreeKillPlan, stopOwnedProcess } from "./process-tree.ts";

function instance(id: string, kind: "local" | "remote" = "remote") {
  return {
    id,
    kind,
    connectionKey: kind === "local" ? LOCAL_CONNECTION_KEY : remoteConnectionKey(id),
  } as const;
}

describe("desktop instance ownership", () => {
  it("releases an exclusive process with its instance and keeps a shared process", () => {
    const ownership = new InstanceOwnership();
    ownership.open(instance(LOCAL_INSTANCE_ID, "local"));
    ownership.open(instance("remote-b"));
    ownership.lease(LOCAL_INSTANCE_ID, LOCAL_BACKEND_PROCESS_ID, true);
    ownership.lease(LOCAL_INSTANCE_ID, "shared-helper", false);
    ownership.lease("remote-b", "shared-helper", false);
    ownership.lease("remote-b", remoteClientProcessId("remote-b"), true);

    const closed = ownership.close(LOCAL_INSTANCE_ID);
    expect(closed?.released.map((item) => item.id)).toEqual([LOCAL_BACKEND_PROCESS_ID]);
    expect(closed?.retained).toEqual(["shared-helper"]);
    expect(ownership.retainCount("shared-helper")).toBe(1);
    expect(ownership.retainCount(LOCAL_BACKEND_PROCESS_ID)).toBe(0);
    expect(ownership.isOpen("remote-b")).toBe(true);
    expect(ownership.wasClosed(LOCAL_CONNECTION_KEY)).toBe(true);
    expect(ownership.wasClosed(remoteConnectionKey("remote-b"))).toBe(false);

    const remaining = ownership.close("remote-b");
    expect(remaining?.released.map((item) => item.id)).toEqual([
      "shared-helper",
      remoteClientProcessId("remote-b"),
    ]);
    expect(ownership.retainCount("shared-helper")).toBe(0);
    expect(ownership.isOpen("remote-b")).toBe(false);
  });

  it("does not restore a closed connection until it is opened again", () => {
    const ownership = new InstanceOwnership();
    ownership.open(instance("remote-a"));
    ownership.close("remote-a");
    expect(ownership.wasClosed(remoteConnectionKey("remote-a"))).toBe(true);
    expect(ownership.close("remote-a")).toBeUndefined();
    ownership.open(instance("remote-a"));
    expect(ownership.wasClosed(remoteConnectionKey("remote-a"))).toBe(false);
    expect(ownership.isOpen("remote-a")).toBe(true);
  });

  it("cancels reconnect timers for the closed instance only", () => {
    const ownership = new InstanceOwnership();
    ownership.open(instance("remote-a"));
    ownership.open(instance("remote-b"));
    const cancelA = vi.fn();
    const runA = vi.fn();
    const cancelB = vi.fn();
    ownership.scheduleReconnect("remote-a", {
      cancel: () => {
        cancelA();
        runA.mockImplementation(() => {});
      },
    });
    ownership.scheduleReconnect("remote-b", { cancel: cancelB });
    ownership.scheduleReconnect("missing", { cancel: cancelA });
    expect(cancelA).toHaveBeenCalledOnce();

    ownership.close("remote-a");
    expect(cancelA).toHaveBeenCalledTimes(2);
    expect(runA).not.toHaveBeenCalled();
    expect(cancelB).not.toHaveBeenCalled();
    expect(ownership.isOpen("remote-b")).toBe(true);
  });

  it("refuses to share an exclusive process or change its lease kind", () => {
    const ownership = new InstanceOwnership();
    ownership.open(instance(LOCAL_INSTANCE_ID, "local"));
    ownership.open(instance("remote-b"));
    ownership.lease(LOCAL_INSTANCE_ID, LOCAL_BACKEND_PROCESS_ID, true);
    expect(() => ownership.lease("remote-b", LOCAL_BACKEND_PROCESS_ID, true)).toThrow(
      "cannot be shared",
    );
    expect(() => ownership.lease("remote-b", LOCAL_BACKEND_PROCESS_ID, false)).toThrow(
      "cannot change",
    );
    expect(ownership.retainCount(LOCAL_BACKEND_PROCESS_ID)).toBe(1);
  });

  it("detects interruptible shell work and ignores idle snapshots", () => {
    expect(snapshotHasInterruptibleWork({ threads: [{ status: "idle" }] })).toBe(false);
    expect(snapshotHasInterruptibleWork({ threads: [{ status: "running" }] })).toBe(true);
    expect(
      snapshotHasInterruptibleWork({
        threads: [{ status: "idle", activityRunStatus: "waiting" }],
      }),
    ).toBe(true);
    expect(
      snapshotHasInterruptibleWork({
        threads: [{ status: "idle", pendingBackgroundTasks: [{ id: "terminal-1" }] }],
      }),
    ).toBe(true);
    expect(snapshotHasInterruptibleWork(null)).toBe(false);
    expect(snapshotHasInterruptibleWork({ threads: "nope" })).toBe(false);
  });
});

describe("owned process trees", () => {
  it("kills a Windows process tree by pid and refuses a process-name kill", async () => {
    const execFile = vi.fn(async () => {});
    const killGroup = vi.fn();
    await killOwnedProcessTree({
      pid: 4242,
      platform: "win32",
      systemRoot: "D:\\Windows",
      execFile,
      killGroup,
    });
    expect(execFile).toHaveBeenCalledExactlyOnceWith("D:\\Windows\\System32\\taskkill.exe", [
      "/PID",
      "4242",
      "/T",
      "/F",
    ]);
    expect(JSON.stringify(execFile.mock.calls)).not.toContain("/IM");
    expect(killGroup).not.toHaveBeenCalled();
    expect(processTreeKillPlan({ pid: 7, platform: "darwin" })).toEqual({
      kind: "group",
      signal: "SIGKILL",
    });
    expect(processTreeKillPlan({ pid: 7, platform: "linux" })).toEqual({
      kind: "group",
      signal: "SIGKILL",
    });
    expect(() => processTreeKillPlan({ pid: 0, platform: "win32" })).toThrow("process id");
  });

  it("signals the owned process group on macOS", async () => {
    const execFile = vi.fn(async () => {});
    const killGroup = vi.fn();
    await killOwnedProcessTree({
      pid: 88,
      platform: "darwin",
      execFile,
      killGroup,
    });
    expect(killGroup).toHaveBeenCalledExactlyOnceWith(88, "SIGKILL");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("asks the owned process to exit before forcing its tree", async () => {
    const notify = vi.fn();
    const force = vi.fn(async () => {});
    let exited = false;
    await expect(
      stopOwnedProcess({
        pid: 5,
        exited: () => exited,
        notify,
        waitForExit: async () => {
          exited = true;
          return true;
        },
        timeoutMs: 25,
        force,
      }),
    ).resolves.toBe("graceful");
    expect(notify).toHaveBeenCalledOnce();
    expect(force).not.toHaveBeenCalled();

    const forced = vi.fn(async () => {});
    await expect(
      stopOwnedProcess({
        pid: 5,
        exited: () => false,
        notify: vi.fn(),
        waitForExit: async () => false,
        timeoutMs: 25,
        force: forced,
      }),
    ).resolves.toBe("forced");
    expect(forced).toHaveBeenCalledOnce();
    await expect(
      stopOwnedProcess({
        pid: undefined,
        exited: () => false,
        notify: vi.fn(),
        waitForExit: async () => false,
        timeoutMs: 25,
        force: vi.fn(async () => {}),
      }),
    ).resolves.toBe("idle");
  });
});
