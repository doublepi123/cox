import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { authCommand } from "./auth.ts";

const run = Command.runWith(authCommand, { version: "0.0.0" });
const services = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

it.effect("exposes only bearer session management in auth help", () =>
  Effect.gen(function* () {
    yield* run(["--help"]);
    const output = JSON.stringify(yield* TestConsole.logLines);
    expect(output).toContain("session");
    expect(output).not.toMatch(/pairing|pair#|base-url/);
  }).pipe(Effect.provide(services)),
);

it.effect("preserves session issue, list and revoke commands", () =>
  Effect.gen(function* () {
    yield* run(["session", "--help"]);
    const output = JSON.stringify(yield* TestConsole.logLines);
    for (const command of ["issue", "list", "revoke"]) expect(output).toContain(command);
  }).pipe(Effect.provide(services)),
);

it.effect("rejects the removed pairing command without initializing auth state", () =>
  Effect.flip(run(["pairing", "list"])).pipe(
    Effect.map((error) => expect(error).toBeDefined()),
    Effect.provide(services),
  ),
);
