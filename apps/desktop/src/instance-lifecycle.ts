export const LOCAL_INSTANCE_ID = "local";
export const LOCAL_CONNECTION_KEY = "local";
export const LOCAL_BACKEND_PROCESS_ID = "local-backend";

export function remoteConnectionKey(profileId: string) {
  return "remote:" + profileId;
}

export function remoteClientProcessId(profileId: string) {
  return "remote-client:" + profileId;
}

export interface OwnedInstance {
  readonly id: string;
  readonly kind: "local" | "remote";
  readonly connectionKey: string;
}

export interface ProcessLease {
  readonly id: string;
  readonly exclusive: boolean;
}

export interface ClosedInstance {
  readonly instance: OwnedInstance;
  readonly released: readonly ProcessLease[];
  readonly retained: readonly string[];
}

interface ProcessRecord {
  exclusive: boolean;
  readonly owners: Set<string>;
}

const LIVE_WORK = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export function snapshotHasInterruptibleWork(snapshot: unknown): boolean {
  if (typeof snapshot !== "object" || snapshot === null || !("threads" in snapshot)) return false;
  const threads = snapshot.threads;
  if (!Array.isArray(threads)) return false;
  return threads.some((thread) => {
    if (typeof thread !== "object" || thread === null) return false;
    const status = "status" in thread ? thread.status : undefined;
    const activity = "activityRunStatus" in thread ? thread.activityRunStatus : undefined;
    const background =
      "pendingBackgroundTasks" in thread ? thread.pendingBackgroundTasks : undefined;
    return (
      (typeof status === "string" && LIVE_WORK.has(status)) ||
      (typeof activity === "string" && LIVE_WORK.has(activity)) ||
      (Array.isArray(background) && background.length > 0)
    );
  });
}

export class InstanceOwnership {
  private readonly instances = new Map<string, OwnedInstance>();
  private readonly processes = new Map<string, ProcessRecord>();
  private readonly processesByInstance = new Map<string, Set<string>>();
  private readonly closedConnections = new Set<string>();
  private readonly reconnects = new Map<string, Set<{ cancel(): void }>>();

  open(instance: OwnedInstance): void {
    if (this.instances.has(instance.id)) throw new Error("Instance is already open.");
    this.instances.set(instance.id, instance);
    this.processesByInstance.set(instance.id, new Set());
    this.closedConnections.delete(instance.connectionKey);
  }

  lease(instanceId: string, processId: string, exclusive: boolean): void {
    if (!this.instances.has(instanceId)) throw new Error("Unknown instance.");
    const existing = this.processes.get(processId);
    if (!existing) {
      this.processes.set(processId, { exclusive, owners: new Set([instanceId]) });
    } else if (existing.exclusive !== exclusive) {
      throw new Error("Process lease kind cannot change.");
    } else if (exclusive && !existing.owners.has(instanceId)) {
      throw new Error("An exclusive process cannot be shared.");
    } else {
      existing.owners.add(instanceId);
    }
    this.processesByInstance.get(instanceId)?.add(processId);
  }

  isOpen(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  wasClosed(connectionKey: string): boolean {
    return this.closedConnections.has(connectionKey);
  }

  retainCount(processId: string): number {
    return this.processes.get(processId)?.owners.size ?? 0;
  }

  scheduleReconnect(instanceId: string, timer: { cancel(): void }): void {
    if (!this.instances.has(instanceId)) {
      timer.cancel();
      return;
    }
    const timers = this.reconnects.get(instanceId) ?? new Set();
    timers.add(timer);
    this.reconnects.set(instanceId, timers);
  }

  close(instanceId: string): ClosedInstance | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    this.instances.delete(instanceId);
    this.closedConnections.add(instance.connectionKey);
    for (const timer of this.reconnects.get(instanceId) ?? []) timer.cancel();
    this.reconnects.delete(instanceId);
    const released: ProcessLease[] = [];
    const retained: string[] = [];
    for (const processId of this.processesByInstance.get(instanceId) ?? []) {
      const record = this.processes.get(processId);
      if (!record) continue;
      record.owners.delete(instanceId);
      if (record.owners.size === 0) {
        this.processes.delete(processId);
        released.push({ id: processId, exclusive: record.exclusive });
      } else {
        retained.push(processId);
      }
    }
    this.processesByInstance.delete(instanceId);
    return { instance, released, retained };
  }
}
