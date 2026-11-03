import { useId, useState } from "react";
import { PencilLineIcon } from "lucide-react";
import { isValidGitBranchName, sanitizeNewRefName } from "@t3tools/shared/git";
import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { useTranslation } from "../i18n";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

export function WorktreeNameControl({
  target,
  multiple = false,
}: {
  readonly target: ComposerThreadTarget;
  readonly multiple?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const draft = useComposerDraftStore((store) => store.getDraftThread(target));
  const setContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  if (!draft) return null;
  const name = draft.worktreeName ?? "";
  const invalid = Boolean(name.trim()) && !isValidGitBranchName(sanitizeNewRefName(name));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<ComposerControl size="xs" className="min-w-0 max-w-40 shrink" />}
        aria-label={t("Worktree name")}
        data-composer-context-control
      >
        <PencilLineIcon className="size-3 shrink-0" />
        <ComposerContextLabel>{name.trim() || t("Automatic name")}</ComposerContextLabel>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="none" width="md">
        <div className="space-y-2 p-3">
          <label htmlFor={id} className="text-sm font-medium">
            {t("Worktree name (optional)")}
          </label>
          <Input
            id={id}
            value={name}
            aria-invalid={invalid}
            placeholder={t("Leave blank for an LLM recommendation")}
            onChange={(event) => setContext(target, { worktreeName: event.target.value })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                setOpen(false);
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            {name.trim()
              ? t("Branch name: {name}", { name: sanitizeNewRefName(name) })
              : t(
                  "Cox recommends a name from your first message before creating the worktree. If generation fails, it uses a random name.",
                )}
          </p>
          {invalid ? (
            <p role="alert" className="text-xs text-destructive">
              {t("Use a valid Git branch name.")}
            </p>
          ) : null}
          {multiple ? (
            <p className="text-xs text-muted-foreground">
              {t("Each model gets a unique suffix when a name is specified.")}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
