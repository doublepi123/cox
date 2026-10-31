import type { EnvironmentId, PreviewRuntime } from "@t3tools/contracts";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  return readEnvironmentSupportsServerBrowser(environmentId) ? "server" : undefined;
}
export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return readEnvironmentSupportsServerBrowser(environmentId);
}
export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentSupportsServerBrowser(environmentId);
}
