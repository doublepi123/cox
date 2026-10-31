import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("retains local singleton identity and does not advertise removed capabilities", () => {
    const parsed = decodeDescriptor(descriptor);
    expect(parsed.environmentId).toBe("environment-1");
    expect(parsed.capabilities).not.toHaveProperty("cloud");
    expect(parsed.capabilities).not.toHaveProperty("device");
    expect(parsed.capabilities).not.toHaveProperty("serverUpdate");
  });
});
