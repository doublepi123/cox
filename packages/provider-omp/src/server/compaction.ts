import type { PiRpcRecord } from "@t3tools/provider-pi/server";

const COMPACTION_NO_OP_SUMMARY = "Nothing to compact";

export function ompCompactionEvent(record: PiRpcRecord): PiRpcRecord {
  switch (record.type) {
    case "manual_compaction_start":
    case "auto_compaction_start":
      return { ...record, type: "compaction_start" };
    case "manual_compaction_end":
    case "auto_compaction_end": {
      const skipped =
        record.skipped === true && (record.result === null || record.result === undefined);
      if (!skipped) return { ...record, type: "compaction_end" };
      const summary =
        typeof record.errorMessage === "string" ? record.errorMessage : COMPACTION_NO_OP_SUMMARY;
      return { ...record, type: "compaction_end", result: { summary } };
    }
    default:
      return record;
  }
}
