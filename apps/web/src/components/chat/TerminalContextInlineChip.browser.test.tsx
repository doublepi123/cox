import { expect, it, onTestFinished } from "vite-plus/test";

import { setLanguagePreference } from "~/i18n";
import { render } from "../../../test/render";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

it.each([
  { lineEnd: 7, label: "终端 2 第 7 行" },
  { lineEnd: 9, label: "终端 2 第 7–9 行" },
])("shows the exact Chinese line label $label", async ({ lineEnd, label }) => {
  setLanguagePreference("zh");
  onTestFinished(() => setLanguagePreference("system"));
  await using screen = await render(
    <TerminalContextInlineChip
      terminalLabel="终端 2"
      lineStart={7}
      lineEnd={lineEnd}
      text="terminal output"
      detailsMode="popover"
    />,
  );
  await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
});
