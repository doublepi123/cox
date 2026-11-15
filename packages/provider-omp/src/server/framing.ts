import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { PiRpcError, type PiRpcRecord } from "@t3tools/provider-pi/server";

const Frame = Schema.Record(Schema.String, Schema.Unknown);
const isRecord = Schema.is(Frame);
export function ompRecord(value: unknown): PiRpcRecord {
  return isRecord(value) ? value : {};
}
const decodeFrame = Schema.decodeUnknownSync(Frame);
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Frame));
const Chunk = Schema.Struct({
  chunkId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 256 })),
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1024 * 1024, maximum: 64 * 1024 * 1024 }),
  ),
  data: Schema.String,
});
const decodeChunk = Schema.decodeUnknownSync(Chunk);

export class OmpFrameDecoder {
  private protocolV2 = false;
  private pending:
    | {
        readonly chunkId: string;
        readonly count: number;
        readonly byteLength: number;
        readonly chunks: Buffer[];
        nextIndex: number;
        receivedBytes: number;
      }
    | undefined;

  get negotiated(): boolean {
    return this.protocolV2;
  }

  incoming(record: PiRpcRecord, downstream?: (record: PiRpcRecord) => PiRpcRecord | undefined) {
    if (
      record.type === "ready" &&
      (!Array.isArray(record.supportedProtocolVersions) ||
        !record.supportedProtocolVersions.includes(2))
    )
      throw new PiRpcError({ operation: "startup", detail: "OMP protocol v2 is required" });
    if (record.type === "rpc_chunk" && !this.protocolV2)
      throw new PiRpcError({ operation: "frame", detail: "Chunk received before v2 negotiation" });
    const decoded = this.push(record);
    if (
      decoded?.type === "response" &&
      decoded.command === "negotiate_protocol" &&
      decoded.success === true &&
      ompRecord(decoded.data).protocolVersion === 2
    )
      this.protocolV2 = true;
    return decoded === undefined || downstream === undefined ? decoded : downstream(decoded);
  }

  push(record: PiRpcRecord): PiRpcRecord | undefined {
    if (Buffer.byteLength(JSON.stringify(record)) + 1 > 1024 * 1024)
      throw new PiRpcError({ operation: "frame", detail: "Physical frame exceeds 1 MiB" });
    if (record.type !== "rpc_chunk") {
      if (this.pending !== undefined)
        throw new PiRpcError({ operation: "frame", detail: "Chunk sequence interrupted" });
      return decodeFrame(record);
    }
    const chunk = decodeChunk(record);
    if (
      chunk.index >= chunk.count ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
    )
      throw new PiRpcError({ operation: "frame", detail: "Invalid chunk metadata or base64" });
    const bytes = Buffer.from(chunk.data, "base64");
    if (bytes.length === 0 || bytes.length > 256 * 1024 || bytes.toString("base64") !== chunk.data)
      throw new PiRpcError({ operation: "frame", detail: "Invalid chunk payload" });
    if (this.pending === undefined) {
      if (chunk.index !== 0)
        throw new PiRpcError({ operation: "frame", detail: "Chunk sequence must start at zero" });
      this.pending = { ...chunk, chunks: [], nextIndex: 0, receivedBytes: 0 };
    }
    const pending = this.pending;
    if (
      pending.chunkId !== chunk.chunkId ||
      pending.count !== chunk.count ||
      pending.byteLength !== chunk.byteLength ||
      pending.nextIndex !== chunk.index
    )
      throw new PiRpcError({ operation: "frame", detail: "Chunk sequence mismatch" });
    pending.chunks.push(bytes);
    pending.nextIndex++;
    pending.receivedBytes += bytes.length;
    if (pending.receivedBytes > pending.byteLength)
      throw new PiRpcError({ operation: "frame", detail: "Chunk length exceeded" });
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength)
      throw new PiRpcError({ operation: "frame", detail: "Chunk length mismatch" });
    this.pending = undefined;
    const result = decodeJson(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks)),
    );
    if (result.type === "rpc_chunk")
      throw new PiRpcError({ operation: "frame", detail: "Nested chunk frame" });
    return result;
  }
}

export class OmpPromptFrames {
  private serial = 0;
  private aborted = false;
  private error: string | undefined;
  private readonly approvals = new Map<
    string,
    { readonly accept: string; readonly deny: string }
  >();
  private readonly pending = new Map<
    string,
    {
      readonly originalId: unknown;
      readonly deferred: Deferred.Deferred<unknown, PiRpcError> | undefined;
      readonly queue: "steering" | "followUp" | undefined;
      readonly message: string | undefined;
      queued: boolean;
      acknowledged: boolean;
      result: boolean;
    }
  >();

  begin(record: PiRpcRecord, deferred?: Deferred.Deferred<unknown, PiRpcError>): string {
    const id = `cox-omp-${this.serial++}`;
    this.pending.set(id, {
      originalId: record.id,
      deferred,
      queue:
        record.streamingBehavior === "steer"
          ? "steering"
          : record.streamingBehavior === "followUp"
            ? "followUp"
            : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
      queued: false,
      acknowledged: false,
      result: false,
    });
    return id;
  }

  remove(id: string) {
    this.pending.delete(id);
  }

  reset(error = new PiRpcError({ operation: "prompt", detail: "Session changed" })) {
    for (const ticket of this.pending.values())
      if (ticket.deferred !== undefined) Deferred.doneUnsafe(ticket.deferred, Effect.fail(error));
    this.pending.clear();
    this.approvals.clear();
    this.aborted = false;
    this.error = undefined;
  }

  uiRequest(event: PiRpcRecord): PiRpcRecord {
    const choices = Array.isArray(event.options) ? event.options : [];
    const accept = choices.find(
      (value): value is string => value === "Approve" || value === "Approve Once",
    );
    if (
      event.method !== "select" ||
      typeof event.id !== "string" ||
      accept === undefined ||
      !choices.includes("Deny")
    )
      return event;
    this.approvals.set(event.id, { accept, deny: "Deny" });
    return { ...event, method: "confirm", message: event.title };
  }

  uiResponse(record: PiRpcRecord): PiRpcRecord {
    const labels = typeof record.id === "string" ? this.approvals.get(record.id) : undefined;
    if (labels === undefined) return record;
    this.approvals.delete(String(record.id));
    return { ...record, value: record.confirmed === true ? labels.accept : labels.deny };
  }

  queueUpdate(event: PiRpcRecord) {
    for (const queue of ["steering", "followUp"] as const) {
      const remaining = new Map<string, number>();
      const texts = event[queue];
      if (!Array.isArray(texts)) continue;
      for (const text of texts)
        if (typeof text === "string") remaining.set(text, (remaining.get(text) ?? 0) + 1);
      for (const ticket of this.pending.values()) {
        if (ticket.queue !== queue || ticket.message === undefined) continue;
        const count = remaining.get(ticket.message) ?? 0;
        if (count === 0) continue;
        ticket.queued = true;
        remaining.set(ticket.message, count - 1);
      }
    }
  }

  acknowledge = Effect.fnUntraced(function* (this: OmpPromptFrames, event: PiRpcRecord) {
    const ticket = typeof event.id === "string" ? this.pending.get(event.id) : undefined;
    if (ticket === undefined || event.command !== "prompt") return event;
    ticket.acknowledged = true;
    if (event.success === false || ompRecord(event.data).agentInvoked === false)
      ticket.result = true;
    if (ticket.result) this.pending.delete(String(event.id));
    const acknowledgement =
      event.success === true && ticket.queued
        ? { ...event, data: { ...ompRecord(event.data), disposition: "queued" } }
        : event;
    if (ticket.deferred !== undefined) {
      if (event.success === true) yield* Deferred.succeed(ticket.deferred, acknowledgement.data);
      else
        yield* Deferred.fail(
          ticket.deferred,
          new PiRpcError({ operation: "prompt", detail: String(event.error) }),
        );
      return undefined;
    }
    const { id: _id, ...ack } = acknowledgement;
    return ticket.originalId === undefined ? ack : { ...ack, id: ticket.originalId };
  });

  observe(event: PiRpcRecord) {
    const ticket = typeof event.id === "string" ? this.pending.get(event.id) : undefined;
    if (ticket === undefined || ticket.result) return;
    ticket.result = true;
    if (ticket.acknowledged) this.pending.delete(String(event.id));
    if (event.status === "error") {
      const message = ompRecord(event.error).message;
      this.error = typeof message === "string" ? message : "Oh My Pi prompt failed";
    }
    if (event.status === "aborted") this.aborted = true;
  }

  settle(): ReadonlyArray<PiRpcRecord> {
    const records: PiRpcRecord[] = [];
    if (this.error !== undefined)
      records.push({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: this.error },
      });
    records.push({ type: "agent_settled", aborted: this.aborted });
    this.error = undefined;
    this.aborted = false;
    return records;
  }
}
