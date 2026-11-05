import type { ModelServiceRecovery } from "@t3tools/contracts";
import { useTranslation } from "../../i18n";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

export function ModelServiceRecoverySettings({
  value,
  disabled,
  onChange,
}: {
  readonly value: ModelServiceRecovery;
  readonly disabled: boolean;
  readonly onChange: (value: ModelServiceRecovery) => void;
}) {
  const { t } = useTranslation();
  const toggles = [
    ["retryEnabled", "Automatically retry temporary failures"],
    ["retryOn429", "Retry all 429 responses, including quota limits"],
    ["retryToolRequests", "Retry failed requests with upstream tools"],
    ["hedgeEnabled", "Start backup requests when responses are slow"],
    ["respectRetryAfter", "Respect 429 cooldown"],
  ] as const;
  const fields = [
    ["hedgeDelayMs", "Backup delay (seconds)", 1000, 0.1, 600],
    ["reasoningHedgeDelayMs", "Reasoning backup delay (seconds)", 1000, 0.1, 600],
    ["maxAttempts", "Maximum attempts (including backups)", 1, 1, 100],
    ["budgetMs", "Recovery budget (seconds)", 1000, 0.1, 1800],
    ["responseHeadersTimeoutMs", "Response headers timeout (seconds)", 1000, 0.1, 1800],
    ["maxConcurrent", "Maximum concurrent requests", 1, 1, 4],
  ] as const;
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-border/60 p-3">
      <legend className="px-1 text-sm font-medium">{t("Request recovery")}</legend>
      {toggles.map(([key, label]) => (
        <label key={key} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
          <Checkbox
            checked={value[key]}
            onCheckedChange={(checked) => onChange({ ...value, [key]: checked === true })}
          />
          {t(label)}
        </label>
      ))}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "Retries and backups share one budget. Backup requests may incur additional usage even when cancelled.",
        )}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "The response headers timeout applies to each attempt within the remaining recovery budget. Normal streaming output is not limited by these timers.",
        )}
      </p>
      {value.retryOn429 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "429 retries share the recovery budget. The cooldown setting still controls how long to wait.",
          )}
        </p>
      ) : null}
      {value.retryToolRequests ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "Failed requests with tools such as web search retry sequentially before output starts. Upstream tools may run again.",
          )}
        </p>
      ) : null}
      {!value.respectRetryAfter ? (
        <p className="text-xs text-muted-foreground">
          {t("429 responses use the local retry interval instead of the service cooldown.")}
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t("Recovery limits and timing")}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          {fields.map(([key, label, scale, min, max]) => (
            <label key={key} className="grid min-w-0 gap-1.5 text-sm">
              {t(label)}
              <Input
                type="number"
                required
                min={min}
                max={max}
                step={scale === 1 ? 1 : 0.1}
                value={value[key] / scale}
                onChange={(event) =>
                  onChange({ ...value, [key]: Math.round(Number(event.target.value) * scale) })
                }
              />
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
