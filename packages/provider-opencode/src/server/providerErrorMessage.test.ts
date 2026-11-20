import { assert, it } from "@effect/vitest";

import { parseClaudeUsageLimit } from "./providerErrorMessage.ts";

it("keeps the timestamp attached to a Claude usage limit", () => {
  assert.deepEqual(
    parseClaudeUsageLimit(
      "You've hit your weekly limit · resets 9pm (Europe/Paris) Resets at 2026-11-02T20:00:00.000Z.",
    ),
    { resetAt: "2026-11-02T20:00:00.000Z" },
  );
  assert.deepEqual(parseClaudeUsageLimit("You've hit your session limit · resets 5:20pm"), {
    resetAt: null,
  });
  assert.isUndefined(parseClaudeUsageLimit("Request failed. Resets at 2026-11-02T20:00:00Z."));
});
