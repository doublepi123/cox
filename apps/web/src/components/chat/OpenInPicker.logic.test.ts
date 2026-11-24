import { describe, expect, it } from "vite-plus/test";

import { fileManagerActionForPath } from "./OpenInPicker.logic";

describe("fileManagerActionForPath", () => {
  it("opens only folders and shows a file once its read settled on a server that can", () => {
    for (const [isFolder, isSettled, canReveal, action] of [
      [true, false, false, "open"],
      [false, false, true, "unavailable"],
      [false, true, false, "unavailable"],
      [false, true, true, "reveal"],
    ] as const) {
      expect(fileManagerActionForPath({ isFolder, isSettled, canReveal })).toBe(action);
    }
  });
});
