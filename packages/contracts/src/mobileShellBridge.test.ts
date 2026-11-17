import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES,
  MobileShellBridgeMessage,
  MobileShellInfo,
} from "./mobileShellBridge.ts";

const decodeMessage = Schema.decodeUnknownOption(MobileShellBridgeMessage);
const decodeInfo = Schema.decodeUnknownOption(MobileShellInfo);

it("requires a non-empty token on every bridge message", () => {
  const valid = decodeMessage({ type: "hapticSelection", bridgeToken: "token" });
  const missing = decodeMessage({ type: "hapticSelection" });
  const blank = decodeMessage({ type: "hapticSelection", bridgeToken: "   " });
  assert.equal(valid._tag, "Some");
  assert.equal(missing._tag, "None");
  assert.equal(blank._tag, "None");
});

it("accepts bounded safe CSS colors and rejects injection", () => {
  assert.equal(
    decodeMessage({ type: "syncThemeColor", bridgeToken: "token", color: "oklch(60% 0.2 30)" })
      ._tag,
    "Some",
  );
  assert.equal(
    decodeMessage({
      type: "syncThemeColor",
      bridgeToken: "token",
      color: "red);url(javascript:alert(1))",
    })._tag,
    "None",
  );
  for (const color of [
    "rgb(1)",
    "hsl(%)",
    "oklch(+)",
    "rgb(1 2 3 4 5)",
    "rgb(1, 2)",
    "#12345",
    "expression(alert(1))",
    "rgb(1/2 3 .5)",
    "hsl(220/40% 12% .5)",
    "oklch(0.21, 0.03, 264.6)",
    "oklch(0.21/0.03 264.6 .5)",
    "rgb(1/2/3/.5)",
    "rgb(1., 2, 3)",
  ]) {
    assert.equal(
      decodeMessage({ type: "syncThemeColor", bridgeToken: "token", color })._tag,
      "None",
    );
  }
});

it("rejects traversal filenames and data payloads above the byte budget", () => {
  const prefix = "data:application/octet-stream;base64,";
  assert.equal(
    decodeMessage({
      type: "saveBlobDownload",
      bridgeToken: "token",
      dataUrl: prefix + "YQ==",
      filename: "../../etc/passwd",
      mimeType: "application/octet-stream",
    })._tag,
    "None",
  );
  for (const filename of ["..\\secret.txt", "folder\\file.txt", "bad\u0000.txt"]) {
    assert.equal(
      decodeMessage({
        type: "saveBlobDownload",
        bridgeToken: "token",
        dataUrl: prefix + "YQ==",
        filename,
        mimeType: "application/octet-stream",
      })._tag,
      "None",
    );
  }
  const oversizedBytes = COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES + 1;
  const oversized =
    "AAAA".repeat(Math.floor(oversizedBytes / 3)) +
    (oversizedBytes % 3 === 1 ? "AA==" : oversizedBytes % 3 === 2 ? "AAA=" : "");
  assert.equal(
    decodeMessage({
      type: "saveBlobDownload",
      bridgeToken: "token",
      dataUrl: prefix + oversized,
      filename: "file.bin",
      mimeType: "application/octet-stream",
    })._tag,
    "None",
  );
});

it("parses the restricted mobile shell information shape", () => {
  assert.equal(
    decodeInfo({ platform: "ios", activeServerLabel: "Local", serverCount: 1 })._tag,
    "Some",
  );
  assert.equal(
    decodeInfo({ platform: "desktop", activeServerLabel: "Local", serverCount: 1 })._tag,
    "None",
  );
});

it("rejects malformed data URLs while accepting valid encoded downloads", () => {
  for (const dataUrl of [
    "data:text/plain",
    "data:text/plain;base64,***=",
    "data:text/plain;base64,YQ=",
    "data:text/plain,%ZZ",
  ]) {
    assert.equal(
      decodeMessage({
        type: "saveBlobDownload",
        bridgeToken: "token",
        dataUrl,
        filename: "notes.txt",
        mimeType: "text/plain",
      })._tag,
      "None",
    );
  }
  for (const dataUrl of ["data:text/plain;base64,SGVsbG8=", "data:text/plain,Hello%20world"]) {
    assert.equal(
      decodeMessage({
        type: "saveBlobDownload",
        bridgeToken: "token",
        dataUrl,
        filename: "notes.txt",
        mimeType: "text/plain",
      })._tag,
      "Some",
    );
  }
});
