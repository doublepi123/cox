import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it.each([
  ["git@github.com:/example/cox.git", "example/cox"],
  ["github.com:/example/cox.git", "example/cox"],
  ["hg::user@host:Owner/Repo.git", null],
  ["file:///workspace/example/cox.git", null],
  ["https://github.com/T3Tools/t3code.git?view=compact", "T3Tools/t3code"],
  ["https://github.com/T3Tools/t3code.git#section", "T3Tools/t3code"],
  ["ssh://git@code.example.test/T3Tools/t3code.git?transport=ssh", "T3Tools/t3code"],
  ["git://code.example.test/T3Tools/t3code.git#browse", "T3Tools/t3code"],
  ["./repositories/t3code", null],
  ["git@code.example.test:T3Tools/t3code.git?literal=scp", "T3Tools/t3code.git?literal=scp"],
])("reads repository path from %s", (remote, expected) => {
  assert.strictEqual(repositoryPathFromRemoteUrl(remote), expected);
});

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});
