import { useState } from "react";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";

export function OmoOfficialRecommendations({
  dirty,
  disabled,
  onApply,
}: {
  readonly dirty: boolean;
  readonly disabled: boolean;
  readonly onApply: () => readonly string[];
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [unmatched, setUnmatched] = useState<readonly string[] | undefined>(undefined);
  const apply = () => {
    setConfirming(false);
    setUnmatched(onApply());
  };
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            if (dirty) setConfirming(true);
            else apply();
          }}
        >
          {t("Apply official recommendations")}
        </Button>
        <p className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">
          {t(
            "Fills each role with OMO's official model for this service. Free and offline; nothing is saved until you apply OMO models.",
          )}
        </p>
      </div>
      {confirming && !disabled ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs">
            {t(
              "Official recommendations will replace the model and thinking strength of every role that has a match. Saved settings stay unchanged until you apply.",
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={apply}>
              {t("Replace with official recommendations")}
            </Button>
            <Button size="sm" variant="ghost-muted" onClick={() => setConfirming(false)}>
              {t("Keep current draft")}
            </Button>
          </div>
        </div>
      ) : null}
      {unmatched ? (
        <p aria-live="polite" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {unmatched.length > 0
            ? t(
                "Official recommendations added to the draft. Left unchanged, no official match in this service: {roles}",
                {
                  roles: unmatched.join(", "),
                },
              )
            : t("Official recommendations added to the draft.")}
        </p>
      ) : null}
    </div>
  );
}
