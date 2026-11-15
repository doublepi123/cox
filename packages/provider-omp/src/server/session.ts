import { PiRpcError, type PiRpcRecord } from "@t3tools/provider-pi/server";
import * as Effect from "effect/Effect";
import { ompRecord } from "./framing.ts";

export const ompForkBeforeEntry = Effect.fn("ompForkBeforeEntry")(function* (
  command: PiRpcRecord,
  listing: unknown,
) {
  const entries = ompRecord(listing).entries;
  if (!Array.isArray(entries))
    return yield* new PiRpcError({
      operation: "fork",
      detail: "Oh My Pi session entries are missing.",
    });
  const byId = new Map<string, PiRpcRecord>();
  for (const value of entries) {
    const entry = ompRecord(value);
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const boundary = typeof command.entryId === "string" ? byId.get(command.entryId) : undefined;
  if (boundary?.type !== "message" || ompRecord(boundary.message).role !== "user")
    return yield* new PiRpcError({
      operation: "fork",
      detail: "Oh My Pi fork boundary is not a user entry.",
    });
  const visited = new Set<string>();
  let parentId = boundary.parentId;
  while (typeof parentId === "string") {
    const parent = byId.get(parentId);
    if (parent === undefined || visited.has(parentId))
      return yield* new PiRpcError({
        operation: "fork",
        detail: "Oh My Pi session ancestry is invalid.",
      });
    if (parent.type === "message") return { ...command, entryId: parentId };
    visited.add(parentId);
    parentId = parent.parentId;
  }
  return { ...command, type: "branch" };
});
