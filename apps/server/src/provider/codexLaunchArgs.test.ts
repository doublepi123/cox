import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexAppServerArgs, codexExecLaunchArgs } from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`, "0.167.0"),
      [
        "app-server",
        "-c",
        "thread_unload_delay_secs=0",
        "--config",
        'model="gpt-6.1-sol"',
        "--strict-config",
      ],
    );
  });
});

it.each(["0.153.0", null])(
  "keeps strict config on Codex %s without adding an unknown key",
  (version) => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config", version), [
      "app-server",
      "--strict-config",
    ]);
  },
);

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
