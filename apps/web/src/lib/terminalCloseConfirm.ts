import { translateCurrent } from "~/i18n";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            translateCurrent('Close terminal "{label}"?', { label: labels[0] }),
            translateCurrent("This stops the running process and clears its history."),
          ].join("\n")
        : [
            translateCurrent("Close {count} terminals?", { count: labels.length }),
            translateCurrent(
              "This stops their running processes and clears their histories: {labels}.",
              { labels: labels.map((label) => `"${label}"`).join(", ") },
            ),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
