import { requestApplicationReconnect } from "../../connection/platform";

export function MobileConnectionBanner({
  reconnecting,
  syncing,
}: {
  readonly reconnecting: boolean;
  readonly syncing: boolean;
}) {
  if (!reconnecting && !syncing) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2 sm:hidden">
      <div
        role="status"
        className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-sm"
      >
        <span>{reconnecting ? "Reconnecting" : "Syncing missed events..."}</span>
        <button
          type="button"
          className="shrink-0 rounded-full px-2 py-1 font-medium text-primary hover:bg-accent"
          onClick={requestApplicationReconnect}
        >
          Retry now
        </button>
      </div>
    </div>
  );
}
