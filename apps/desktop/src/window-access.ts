import { isBackendNavigation } from "./config.ts";

export interface WindowAccess {
  readonly origin: string;
  readonly kind: "local" | "remote";
}

export function trustedWindowAccess(
  access: WindowAccess | undefined,
  mainFrame: unknown,
  senderFrame: unknown,
  url: string,
): WindowAccess | undefined {
  return access && mainFrame === senderFrame && isBackendNavigation(url, access.origin)
    ? access
    : undefined;
}
