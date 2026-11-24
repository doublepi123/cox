import type { EnvironmentId } from "@t3tools/contracts";

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  ) {
    return true;
  }
  return false;
}

export type FileManagerAction = "open" | "reveal" | "unavailable";

/**
 * The file manager opens folders and shows files in their folder. A path whose read has not
 * settled may be either, and a file needs the server's reveal support, so both wait.
 */
export function fileManagerActionForPath(input: {
  readonly isFolder: boolean;
  readonly isSettled: boolean;
  readonly canReveal: boolean;
}): FileManagerAction {
  if (input.isFolder) return "open";
  return input.isSettled && input.canReveal ? "reveal" : "unavailable";
}
