import type { DesktopUpdateProgress as Progress } from "@t3tools/contracts";
import { useTranslation } from "../i18n";

const PHASE_LABELS = {
  downloading: "Downloading…",
  verifying: "Verifying download…",
  installing: "Installing dependencies…",
  validating: "Verifying installation…",
  starting: "Starting Cox…",
} as const;

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export function DesktopUpdateProgress({
  progress,
}: {
  readonly progress: Progress | null | undefined;
}) {
  const { t } = useTranslation();
  if (!progress) return null;
  const downloading = progress.phase === "downloading";
  const percent =
    downloading && progress.totalBytes !== null && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, Math.floor((progress.transferredBytes / progress.totalBytes) * 100)),
        )
      : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground" role="status">
      <div className="flex items-center justify-between gap-3">
        <span>{t(PHASE_LABELS[progress.phase])}</span>
        {percent !== undefined && <span className="tabular-nums">{percent}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={t(PHASE_LABELS[progress.phase])}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full bg-primary transition-[width] duration-150 motion-reduce:transition-none ${percent === undefined ? "w-1/3 animate-pulse motion-reduce:animate-none" : ""}`}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      {downloading && (
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 tabular-nums">
          <span>
            {formatBytes(progress.transferredBytes)}
            {progress.totalBytes !== null && ` / ${formatBytes(progress.totalBytes)}`}
          </span>
          <span>
            {progress.bytesPerSecond !== null && `${formatBytes(progress.bytesPerSecond)}/s`}
            {progress.remainingSeconds !== null &&
              ` · ${t("About {seconds}s remaining", { seconds: progress.remainingSeconds })}`}
          </span>
        </div>
      )}
    </div>
  );
}
