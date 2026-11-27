import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function acquireDevRunnerLock(stateDir: string, owner: string): () => void {
  mkdirSync(stateDir, { recursive: true });
  const database = new DatabaseSync(join(stateDir, "dev-runner.sqlite"));
  try {
    database.exec("BEGIN EXCLUSIVE;");
  } catch (cause) {
    database.close();
    const busy =
      cause instanceof Error &&
      (("errcode" in cause && cause.errcode === 5) ||
        ("code" in cause && cause.code === "SQLITE_BUSY"));
    if (!busy) throw cause;
    let currentOwner = "owner unknown";
    try {
      currentOwner = readFileSync(join(stateDir, "dev-runner-owner.txt"), "utf8").trim() || currentOwner;
    } catch {}
    throw new Error(`Another Cox dev runner already uses ${stateDir} (${currentOwner}). Stop it, or use a separate checkout.`);
  }
  try {
    writeFileSync(join(stateDir, "dev-runner-owner.txt"), owner);
  } catch (cause) {
    database.close();
    throw cause;
  }
  return () => database.close();
}
