import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useProject, useServerConfigs, useThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";
import { ThreadChipHoverCard } from "./ThreadChipHoverCard";
import { ThreadHoverCardPopup } from "./ThreadHoverCard";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  projectId?: ProjectId | null;
  copyMarkdown?: string;
  unreadable?: boolean;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const supportsMetadata = useServerConfigs().get(environmentId)?.threadLinkMetadata === true;
  const lookup = useEnvironmentQuery(
    shell === null && props.projectId === undefined && supportsMetadata
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId,
          input: { threadIds: [threadId] },
        })
      : null,
  );
  const metadata =
    lookup.data && Object.hasOwn(lookup.data, threadId) ? lookup.data[threadId] : undefined;
  const projectId = shell?.projectId ?? props.projectId ?? metadata?.projectId;
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const title = shell?.title?.trim() || metadata?.title.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId }}
                draggable={false}
                onClick={props.onOpen}
                onAuxClick={props.onOpen}
              />
            }
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <ThreadHoverCardPopup side="top">
        <ThreadChipHoverCard
          title={title}
          project={project}
          shell={shell}
          unreadable={props.unreadable === true}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
