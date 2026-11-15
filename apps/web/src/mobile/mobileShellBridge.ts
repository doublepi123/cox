import {
  MobileShellBridgeMessage,
  MobileShellInfo,
  type MobileShellBridgeMessage as MobileShellBridgeMessageType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

export { COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES } from "@t3tools/contracts";

type MobileShellInfoType = MobileShellInfo;

interface MobileShellWindow {
  readonly info: MobileShellInfoType;
  readonly bridgeToken: string;
  readonly postMessage: (payload: string | MobileShellBridgeMessageType) => void;
}

type MobileShellBridgeRequest = {
  [Message in MobileShellBridgeMessageType as Message["type"]]: Omit<Message, "bridgeToken">;
}[MobileShellBridgeMessageType["type"]];

const compactQuery = "(max-width: 640px)";
const decodeInfo = Schema.decodeUnknownOption(MobileShellInfo);
const decodeMessage = Schema.decodeUnknownOption(MobileShellBridgeMessage);
let infoSnapshot: MobileShellInfoType | null = null;

function subscribeInfo(listener: () => void): () => void {
  window.addEventListener("cox:mobile-shell-change", listener);
  return () => {
    window.removeEventListener("cox:mobile-shell-change", listener);
  };
}

function readBridge(): MobileShellWindow | null {
  if (typeof window === "undefined" || window.self !== window.top) return null;
  const bridge: unknown = Reflect.get(window, "__coxMobileShell__");
  if (typeof bridge !== "object" || bridge === null) return null;
  const info = Option.getOrNull(decodeInfo(Reflect.get(bridge, "info")));
  const bridgeToken = Reflect.get(bridge, "bridgeToken");
  const postMessage = Reflect.get(bridge, "postMessage");
  if (
    info === null ||
    typeof bridgeToken !== "string" ||
    bridgeToken.trim().length === 0 ||
    typeof postMessage !== "function"
  ) {
    return null;
  }
  return { info, bridgeToken, postMessage };
}

function readInfo(): MobileShellInfoType | null {
  const info = readBridge()?.info ?? null;
  if (
    infoSnapshot?.platform === info?.platform &&
    infoSnapshot?.activeServerLabel === info?.activeServerLabel &&
    infoSnapshot?.serverCount === info?.serverCount
  ) {
    return infoSnapshot;
  }
  infoSnapshot = info;
  return infoSnapshot;
}

function send(message: MobileShellBridgeRequest): boolean {
  const bridge = readBridge();
  if (!bridge) return false;
  const payload = { ...message, bridgeToken: bridge.bridgeToken };
  if (Option.isNone(decodeMessage(payload))) return false;
  const { postMessage } = bridge;
  postMessage(payload);
  return true;
}

function subscribeViewport(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function readCompactViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(compactQuery).matches;
}

export function getMobileShellInfo(): MobileShellInfoType | null {
  return readInfo();
}

export function openMobileServerSwitcher(): boolean {
  return send({ type: "openServerSwitcher" });
}

export function openMobileConnectionManager(): boolean {
  return send({ type: "openConnectionManager" });
}

export function syncMobileThemeColor(color: string): boolean {
  if (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    !CSS.supports("color", color)
  ) {
    return false;
  }
  return send({ type: "syncThemeColor", color });
}

export function triggerMobileHapticSelection(): boolean {
  return send({ type: "hapticSelection" });
}

export function saveMobileBlobDownload(
  dataUrl: string,
  filename: string,
  mimeType: string,
): boolean {
  return send({ type: "saveBlobDownload", dataUrl, filename, mimeType });
}

export function useMobileShellInfo(): MobileShellInfoType | null {
  return useSyncExternalStore(subscribeInfo, readInfo, () => null);
}

export function useIsCompactPhoneViewport(): boolean {
  return useSyncExternalStore(subscribeViewport, readCompactViewport, () => false);
}
