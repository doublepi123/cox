import { describe, expect, it } from "vite-plus/test";

import { clipboardFiles } from "./composerFocusRedirect";

describe("clipboardFiles", () => {
  it("reads a screenshot from clipboard items when the file list is empty", () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    expect(
      clipboardFiles({
        files: [],
        items: [{ kind: "file", getAsFile: () => image }],
      }),
    ).toEqual([image]);
  });

  it("ignores non-file clipboard items", () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    expect(
      clipboardFiles({
        files: [],
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => image },
        ],
      }),
    ).toEqual([image]);
  });

  it("falls back to the file list when items are absent", () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    expect(clipboardFiles({ files: [image] })).toEqual([image]);
  });
});
