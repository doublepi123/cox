import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { acquireDevRunnerLock } from "./dev-runner-lock.ts";

describe("dev runner lock", () => {
  it("refuses a second runner until the owner releases the state directory", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cox-dev-runner-lock-"));
    try {
      const first = acquireDevRunnerLock(root, "pid 1, dev");
      expect(() => acquireDevRunnerLock(root, "pid 2, dev")).toThrow("pid 1, dev");
      first();
      const second = acquireDevRunnerLock(root, "pid 2, dev");
      second();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });
});
