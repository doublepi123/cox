import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { useTranslation } from "../../i18n";

import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger, MenuItem, MenuGroup, MenuSeparator } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import type { ChangeRequestTerminology } from "~/sourceControlPresentation";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import { PullRequestGlyph } from "./pullRequestIcons";
import { mergeHeadPin, readableFailure } from "./pullRequestDetail.logic";

export function PullRequestStackMenu({
  hostLabel,
  terminology,
  stack,
  reference,
  environmentId,
  shownHeadSha,
  stale,
  canMerge,
  canRebase,
  canAutoMerge,
  preferAutoMerge,
  autoMergeArmed,
  canCancelAutoMerge,
  mergeMethod,
  onSelect,
  onActed,
  notice,
  onRetry,
}: {
  hostLabel: string;
  terminology: ChangeRequestTerminology;
  notice?: string | null;
  onRetry?: (() => void) | undefined;
  stack: PullRequestStack;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  /** The head of `reference` the reader was shown; the stack read can run ahead of it. */
  shownHeadSha: string | undefined;
  stale: boolean;
  canMerge: boolean;
  canRebase: boolean;
  canAutoMerge: boolean;
  preferAutoMerge: boolean;
  autoMergeArmed: boolean;
  canCancelAutoMerge: boolean;
  mergeMethod: PullRequestMergeMethod;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  onActed: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "merge" | "enable-auto-merge" | "update-branch" | null
  >(null);
  const [pending, setPending] = useState(false);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const top = stack.layers.at(-1);
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const hasClosed = unmerged.some((layer) => layer.state !== "open");
  const position = stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  const mergeLayers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const selectedLayer = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  const expectedStackHeads = unmerged.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const hasUnknownHead = expectedStackHeads.length !== unmerged.length;
  const mergeDisabled =
    pending ||
    stale ||
    selectedLayer?.state !== "open" ||
    mergeLayers.some((layer) => !layer.headSha) ||
    mergeHasClosed ||
    mergeLayers.length === 0 ||
    mergeLayers.some((layer) => layer.isDraft);
  const rebaseDisabled = pending || stale || hasUnknownHead || hasClosed || unmerged.length === 0;
  const run = async () => {
    if (
      pending ||
      !confirmation ||
      (confirmation === "update-branch"
        ? !canRebase || rebaseDisabled
        : mergeDisabled || (confirmation === "merge" ? !canMerge : !canAutoMerge || autoMergeArmed))
    )
      return;
    const action = confirmation;
    const merging = action !== "update-branch";
    const target = merging ? selectedLayer : top;
    if (!target?.headSha) return;
    const actionHeads = (merging ? mergeLayers : unmerged).flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    );
    setPending(true);
    setConfirmation(null);
    const toastId = toastManager.add({
      type: "loading",
      title:
        action === "enable-auto-merge"
          ? "Enabling stack auto-merge..."
          : merging
            ? "Merging stack..."
            : "Rebasing stack...",
    });
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        number: target.number,
        stackNumber: stack.number,
        expectedStackHeads: actionHeads,
        ...mergeHeadPin(action, shownHeadSha),
        action,
        ...(merging ? { mergeMethod } : { updateMethod: "rebase" }),
      },
    });
    setPending(false);
    onActed();
    if (result._tag === "Failure") {
      toastManager.update(toastId, {
        type: "error",
        title:
          action === "enable-auto-merge"
            ? "Could not enable stack auto-merge"
            : merging
              ? "Could not merge the stack"
              : "Could not rebase the stack",
        description: readableFailure(
          squashAtomCommandFailure(result),
          merging
            ? "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting."
            : "The host refused the rebase. A rebase stops at the first commit that does not apply cleanly.",
        ),
      });
    } else {
      toastManager.update(toastId, {
        type: "success",
        title:
          action === "enable-auto-merge"
            ? "Stack auto-merge enabled"
            : merging
              ? "Stack merge request completed"
              : "Stack rebased",
        description:
          action === "merge"
            ? `${hostLabel} merged the stack or added it to its merge queue.`
            : undefined,
      });
    }
  };
  const cancelAutoMerge = async () => {
    if (pending || !canCancelAutoMerge) return;
    setPending(true);
    const result = await runAction({
      environmentId,
      input: { ...reference, stackNumber: stack.number, action: "disable-auto-merge" },
    });
    setPending(false);
    onActed();
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Could not cancel stack auto-merge" });
  };
  const leadsWithAutoMerge = canAutoMerge && (preferAutoMerge || !canMerge);
  const confirmationLayers = confirmation === "update-branch" ? unmerged : mergeLayers;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <SharedTooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Stack ${stack.number}, layer ${position} of ${stack.layers.length}`}
                />
              }
            >
              <PullRequestGlyph.stack aria-hidden className="size-3.5" /> {position}/
              {stack.layers.length}
              {onRetry ? <TriangleAlertIcon aria-hidden className="size-3 text-warning" /> : null}
            </MenuTrigger>
          }
          label={
            <>
              View stack #{stack.number}, layer {position} of {stack.layers.length}
              {notice ? ` · ${notice}` : null}
            </>
          }
        />
        <MenuPopup align="start">
          <MenuGroup>
            <PullRequestStackHeader number={stack.number} notice={notice} stale={!!onRetry} />
            {onRetry ? <MenuItem onClick={onRetry}>Retry stack refresh</MenuItem> : null}
            <PullRequestStackLayers
              stack={stack}
              reference={reference}
              pending={pending}
              onSelect={
                onSelect
                  ? (target) => {
                      setOpen(false);
                      onSelect(target);
                    }
                  : undefined
              }
            />
          </MenuGroup>
          {canMerge || canRebase || canAutoMerge || canCancelAutoMerge ? (
            <>
              <MenuSeparator />
              {canMerge && !autoMergeArmed ? (
                <MenuItem disabled={mergeDisabled} onClick={() => setConfirmation("merge")}>
                  <PullRequestGlyph.merged aria-hidden />
                  Merge stack ({mergeLayers.length})
                </MenuItem>
              ) : null}
              {canAutoMerge && !autoMergeArmed ? (
                <MenuItem
                  disabled={mergeDisabled}
                  onClick={() => setConfirmation("enable-auto-merge")}
                >
                  Auto-merge stack ({mergeLayers.length})
                </MenuItem>
              ) : null}
              {autoMergeArmed && canCancelAutoMerge ? (
                <MenuItem disabled={pending} onClick={() => void cancelAutoMerge()}>
                  Cancel stack auto-merge
                </MenuItem>
              ) : null}
              {canRebase ? (
                <MenuItem
                  disabled={rebaseDisabled}
                  onClick={() => setConfirmation("update-branch")}
                >
                  <RefreshCwIcon aria-hidden />
                  Rebase stack
                </MenuItem>
              ) : null}
              {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  Every layer being merged must be open and ready for review.
                </p>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {(leadsWithAutoMerge || canMerge) && !autoMergeArmed && selectedLayer?.state === "open" ? (
        <SharedTooltipTrigger
          render={
            <span className="inline-flex">
              <Button
                variant="default"
                size="xs"
                disabled={mergeDisabled && !stale}
                aria-disabled={mergeDisabled || undefined}
                aria-description={stale ? (notice ?? undefined) : undefined}
                onClick={
                  mergeDisabled
                    ? undefined
                    : () => setConfirmation(leadsWithAutoMerge ? "enable-auto-merge" : "merge")
                }
              >
                <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                {leadsWithAutoMerge ? "Auto-merge stack" : "Merge stack"}
              </Button>
            </span>
          }
          label={
            <>
              {stale
                ? notice
                : `Merge stack through #${reference.number} into ${stack.base} (${mergeLayers.length} ${mergeLayers.length === 1 ? terminology.singular : terminology.plural})`}
            </>
          }
        />
      ) : null}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(value) => {
          if (!value) setConfirmation(null);
        }}
      >
        <DialogPopup width="md">
          <DialogHeader>
            <DialogTitle>
              {confirmation === "merge"
                ? `Merge ${mergeLayers.length} ${mergeLayers.length === 1 ? terminology.singular : terminology.plural}?`
                : confirmation === "enable-auto-merge"
                  ? `Auto-merge ${mergeLayers.length} ${mergeLayers.length === 1 ? terminology.singular : terminology.plural}?`
                  : `Rebase ${unmerged.length} ${unmerged.length === 1 ? terminology.singular : terminology.plural}?`}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "merge"
                ? `Merge #${reference.number} and its unmerged layers below into ${stack.base} using ${mergeMethod}. ${hostLabel} checks their rules before merging or queueing them and rebases the remaining stack after merging.`
                : confirmation === "enable-auto-merge"
                  ? `Merge through #${reference.number} once the requirements on ${hostLabel} are met.`
                  : `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {confirmationLayers.map((layer) => (
                <li
                  key={layer.number}
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
                >
                  <PullRequestStackLayerContent layer={layer} compact />
                </li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              {t("Cancel")}
            </Button>
            <Button onClick={() => void run()}>
              {confirmation === "merge"
                ? "Merge stack"
                : confirmation === "enable-auto-merge"
                  ? "Enable auto-merge"
                  : "Rebase stack"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
