import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatThreadLink,
  guessThreadLinkRef,
  threadLinkCandidates,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { useServerConfigs, useThreadRefs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const candidates = threadLinkCandidates(props.link, props.environmentId);
  const writtenRef = candidates[0]!;
  const written = useThreadShell(writtenRef);
  const decodedRef = candidates[1] ?? null;
  const decoded = useThreadShell(decodedRef);
  const supportsMetadata =
    useServerConfigs().get(writtenRef.environmentId)?.threadLinkMetadata === true;
  const lookup = useEnvironmentQuery(
    written === null && decoded === null && supportsMetadata
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId: writtenRef.environmentId,
          input: { threadIds: candidates.map((ref) => ref.threadId) },
        })
      : null,
  );
  const settled = !supportsMetadata || (lookup.data !== null && lookup.error === null);
  const target =
    written !== null
      ? { ref: writtenRef, metadata: written }
      : decoded !== null && decodedRef !== null
        ? { ref: decodedRef, metadata: decoded }
        : (candidates.flatMap((ref) => {
            const metadata =
              lookup.data && Object.hasOwn(lookup.data, ref.threadId)
                ? lookup.data[ref.threadId]
                : undefined;
            return metadata ? [{ ref, metadata }] : [];
          })[0] ?? null);
  const missing = target === null && settled;
  const guess = missing && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remoteRef = guess
    ? guessThreadLinkRef(
        props.link,
        refs.filter((ref) => ref.environmentId !== writtenRef.environmentId),
      )
    : null;
  const remote = useThreadShell(remoteRef);
  const resolved = target ?? (remoteRef && remote ? { ref: remoteRef, metadata: remote } : null);
  if (missing && resolved === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = resolved?.ref ?? writtenRef;
  const title = resolved?.metadata.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      projectId={resolved?.metadata.projectId ?? null}
      copyMarkdown={formatThreadLink(ref, title)}
    />
  );
}
