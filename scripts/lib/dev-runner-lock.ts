import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const ownerPath = join(stateDir, "dev-runner-owner.txt");
    const currentOwner = existsSync(ownerPath)
      ? readFileSync(ownerPath, "utf8").trim() || "owner unknown"
      : "owner unknown";
    throw new Error(
      `Another Cox dev runner already uses ${stateDir} (${currentOwner}). Stop it, or use a separate checkout.`,
      { cause },
    );
  }
  try {
    writeFileSync(join(stateDir, "dev-runner-owner.txt"), owner);
  } catch (cause) {
    database.close();
    throw cause;
  }
  return () => database.close();
}
