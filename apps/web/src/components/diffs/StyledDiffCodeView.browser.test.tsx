import { expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { buildFileDiffEntries, getRenderablePatch } from "../../lib/diffRendering";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

/** The text Chromium's accessibility tree gives a screen reader, in reading order. */
async function screenReaderText() {
  const session = cdp();
  const { frameTree } = await session.send("Page.getFrameTree");
  const frame = [frameTree, ...(frameTree.childFrames ?? [])].find(
    (tree) => tree.frame.url === location.href,
  );
  const { nodes } = await session.send("Accessibility.getFullAXTree", {
    frameId: frame!.frame.id,
  });
  return nodes
    .filter((node) => !node.ignored && node.role?.value === "StaticText")
    .map((node) => String(node.name?.value ?? ""))
    .join("");
}

it("tells a screen reader which lines were removed and which were added", async () => {
  const parsed = getRenderablePatch(
    [
      "diff --git a/limits.ts b/limits.ts",
      "--- a/limits.ts",
      "+++ b/limits.ts",
      "@@ -1,2 +1,2 @@",
      " export const name = 1;",
      "-const limit = 10;",
      "+const limit = 20;",
      "",
    ].join("\n"),
  );
  if (parsed?.kind !== "files") throw new Error("Expected file diffs");
  await using screen = await render(
    <StyledDiffCodeView
      className="h-[600px] w-[800px]"
      items={buildFileDiffEntries(parsed.files).map(({ fileDiff, fileKey, fileVersion }) => ({
        type: "diff",
        id: fileKey,
        fileDiff,
        version: fileVersion,
      }))}
      options={{ theme: "pierre-dark", diffStyle: "unified" }}
    />,
    // This viewer fixture does not navigate or read router state.
    { router: false },
  );
  await expect.element(screen.getByText("export const name = 1;", { exact: true })).toBeVisible();
  await vi.waitFor(async () => {
    const text = await screenReaderText();
    expect(text).toContain("export const name = 1;Removedconst limit = 10;Addedconst limit = 20;");
  });
});
