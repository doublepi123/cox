import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = NodePath.resolve(import.meta.dirname, "../.."),
}: {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const readEnv = (name: string) => {
    const path = NodePath.join(repoRoot, name);
    return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
  };
  return { ...readEnv(".env"), ...readEnv(".env.local"), ...baseEnv };
}
