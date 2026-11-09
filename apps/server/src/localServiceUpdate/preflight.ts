import { pathToFileURL } from "node:url";
import { runLocalServiceCommand } from "./process.ts";

export async function inspectCandidateMigration(modulePath: string, node: string): Promise<number> {
  const result = await runLocalServiceCommand(node, [
    "--input-type=module",
    "--eval",
    `const { BUILD_MIGRATION_HEAD } = await import(${JSON.stringify(pathToFileURL(modulePath).href)}); console.log(BUILD_MIGRATION_HEAD);`,
  ]);
  const head = Number(result.trim());
  if (!Number.isSafeInteger(head) || head < 1)
    throw new Error("The staged Cox update has no valid migration manifest.");
  return head;
}
