import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MobileShellPlatform = Schema.Literals(["ios", "android"]);
export type MobileShellPlatform = typeof MobileShellPlatform.Type;

export const MobileShellInfo = Schema.Struct({
  platform: MobileShellPlatform,
  activeServerLabel: Schema.String,
  serverCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MobileShellInfo = typeof MobileShellInfo.Type;

export const COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

const cssColor = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (
        value.length === 0 ||
        value.length > 64 ||
        value.trim() !== value ||
        /[^\x20-\x7e]/.test(value)
      ) {
        return false;
      }
      if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
        return true;
      }

      const number = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
      const percentage = String.raw`(${number})%`;
      const inRange = (token: string, bounds: readonly [number, number], percent = false) => {
        const match = new RegExp(`^${percent ? percentage : `(${number})`}$`).exec(token);
        if (!match) return false;
        const numericValue = Number(match[1]);
        return (
          Number.isFinite(numericValue) && numericValue >= bounds[0] && numericValue <= bounds[1]
        );
      };
      const alpha = (token: string) => inRange(token, [0, 1]) || inRange(token, [0, 100], true);
      const hue = (token: string) => new RegExp(`^${number}(?:deg|rad|grad|turn)?$`).test(token);
      const component = (token: string) => new RegExp(`^${number}$`).test(token);
      const rgbChannelSet = (channels: readonly string[]) =>
        channels.length === 3 &&
        (channels.every((channel) => inRange(channel, [0, 255])) ||
          channels.every((channel) => inRange(channel, [0, 100], true)));
      const hslChannels = (channels: readonly string[]) =>
        channels.length === 3 &&
        hue(channels[0] ?? "") &&
        inRange(channels[1] ?? "", [0, 100], true) &&
        inRange(channels[2] ?? "", [0, 100], true);
      const parseFunction = /^(rgb|rgba|hsl|hsla|oklch)\(([^()]*)\)$/.exec(value);
      if (!parseFunction) return false;

      const name = parseFunction[1];
      const body = (parseFunction[2] ?? "").trim();
      if (body.length === 0) return false;
      const commaSyntax = body.includes(",");
      let channels: readonly string[];
      if (commaSyntax) {
        if (name === "oklch" || body.includes("/")) return false;
        const parts = body.split(",").map((part) => part.trim());
        if (
          (parts.length !== 3 && parts.length !== 4) ||
          parts.some((part) => part.length === 0 || /\s/.test(part)) ||
          (parts.length === 4 && !alpha(parts[3] ?? ""))
        ) {
          return false;
        }
        channels = parts.slice(0, 3);
      } else {
        const segments = body.split("/");
        if (segments.length !== 1 && segments.length !== 2) return false;
        channels = (segments[0] ?? "").trim().split(/\s+/);
        if (channels.length !== 3) return false;
        if (segments.length === 2) {
          const alphaSegment = (segments[1] ?? "").trim();
          if (/\s/.test(alphaSegment) || !alpha(alphaSegment)) return false;
        }
      }

      switch (name) {
        case "rgb":
        case "rgba":
          return rgbChannelSet(channels);
        case "hsl":
        case "hsla":
          return hslChannels(channels);
        case "oklch": {
          const lightness = channels[0] ?? "";
          const chroma = channels[1] ?? "";
          const lightnessValid = inRange(lightness, [0, 1]) || inRange(lightness, [0, 100], true);
          const chromaValid =
            (component(chroma) && Number(chroma) >= 0) ||
            (new RegExp(`^${number}%$`).test(chroma) && Number.parseFloat(chroma) >= 0);
          return lightnessValid && chromaValid && hue(channels[2] ?? "");
        }
        default:
          return false;
      }
    },
    { expected: "a safe CSS color string of at most 64 characters" },
  ),
);

const dataUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const comma = value.indexOf(",");
      if (
        !value.startsWith("data:") ||
        comma < 0 ||
        value.length > Math.ceil((COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES * 4) / 3) + 4096
      ) {
        return false;
      }
      const payload = value.slice(comma + 1);
      if (value.slice(0, comma).endsWith(";base64")) {
        const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
        return (
          payload.length % 4 === 0 &&
          !/[^A-Za-z0-9+/]/.test(payload.slice(0, payload.length - padding)) &&
          (payload.length / 4) * 3 - padding <= COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES
        );
      }
      try {
        return (
          new TextEncoder().encode(decodeURIComponent(payload)).byteLength <=
          COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES
        );
      } catch (error) {
        if (error instanceof URIError) return false;
        throw error;
      }
    },
    { expected: "a bounded data URL" },
  ),
);

const safeFilename = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      value.length <= 255 &&
      !/[\\/]/.test(value) &&
      !value.includes("..") &&
      !/[\u0000-\u001f\u007f]/.test(value),
    { expected: "a safe filename without path components" },
  ),
);

const saveBlobDownload = Schema.Struct({
  type: Schema.Literal("saveBlobDownload"),
  bridgeToken: TrimmedNonEmptyString,
  dataUrl,
  filename: safeFilename,
  mimeType: Schema.String.check(Schema.isMaxLength(128)),
});

export const MobileShellBridgeMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("openServerSwitcher"), bridgeToken: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("openConnectionManager"),
    bridgeToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("syncThemeColor"),
    bridgeToken: TrimmedNonEmptyString,
    color: cssColor,
  }),
  Schema.Struct({ type: Schema.Literal("hapticSelection"), bridgeToken: TrimmedNonEmptyString }),
  saveBlobDownload,
]);
export type MobileShellBridgeMessage = typeof MobileShellBridgeMessage.Type;
