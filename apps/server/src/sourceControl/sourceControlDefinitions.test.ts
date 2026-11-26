import { expect, it } from "@effect/vitest";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  changeRequestsClosedBy,
  sourceControlDefinitions,
} from "./sourceControlDefinitions.ts";

it("runs a driver for every host the server and clients read, in their order", () => {
  expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.definition)).toEqual(
    sourceControlDefinitions.definitions,
  );
});

it.each([
  ['/bin/zsh -lc "gh pr merge 19" > "merge.log"', [19]],
  [`/bin/zsh -lc 'gh pr merge 19' > 'merge.log'`, [19]],
  ["gh pr merge --squash --subject=2026 42", [42]],
  ['gh pr merge --squash --subject="2026" 42', [42]],
  ["gh pr merge --body=https://github.com/o/r/pull/20 19", [19]],
  ['az repos pr update --id="19" --title "20" --status completed', [19]],
])("matches the change request named by %s", (command, numbers) => {
  const selected = changeRequestsClosedBy(command);
  expect(selected === "any" ? selected : [...selected]).toEqual(numbers);
});
