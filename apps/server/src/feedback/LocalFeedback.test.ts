import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as LocalFeedback from "./LocalFeedback.ts";

it.effect("stores a scrubbed report in the local database", () =>
  Effect.gen(function* () {
    const { id } = yield* LocalFeedback.save(
      {
        kind: "bug",
        subject: "cox tool",
        expected: "a response",
        actual: "error for alice@example.com",
        workaround: "used /home/alice/test",
      },
      "thread-1",
      ["alice"],
    );
    expect(yield* LocalFeedback.list).toEqual([
      {
        id,
        createdAt: expect.any(String),
        threadId: "thread-1",
        kind: "bug",
        subject: "cox tool",
        expected: "a response",
        actual: "error for [redacted]",
        workaround: "used [redacted]",
      },
    ]);
  }).pipe(Effect.provide(Layer.merge(Sqlite.layerMemory, NodeCrypto.layer))),
);
