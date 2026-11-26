// Pull requests for workflows use the project credentials and the same hosts as the app.
import {
  type PullRequestAction,
  type PullRequestDetail,
  PullRequestListEntry,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestRef,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkflowReferenceKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";
import { noteReference, pullRequestReference } from "./runReferences.ts";
import { isProjectPath } from "./WorkflowAgents.ts";
import type { ReferenceInput } from "./WorkflowStore.ts";

export class WorkflowForgeError extends Schema.TaggedError<WorkflowForgeError>()(
  "WorkflowForgeError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** What a pull request trigger gives its run, and what `pullRequests.list` returns rows of. */
export const PullRequest = PullRequestListEntry;
export type PullRequest = typeof PullRequest.Type;

/** A pull request by its web address, or as a trigger or a listing gave it. */
export type PullRequestAddress =
  | { readonly project: string; readonly url: string }
  | Pick<PullRequest, "projectId" | "host" | "repository" | "number">;

/** Where a pull request stands, as a wait on it gives it. */
export const PullRequestStanding = Schema.Struct({
  state: Schema.Literals(["open", "closed", "merged"]),
  /** `none` when the host lists no checks for it. */
  checks: Schema.Literals(["passing", "failing", "pending", "none"]),
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  url: Schema.String,
});
export type PullRequestStanding = typeof PullRequestStanding.Type;
export type PullRequestUntil = "checks" | "merged" | "closed";
/** What a wait on a pull request keeps for the engine to look at. */
export interface PullRequestWatch {
  readonly kind: "pullRequest";
  readonly until: PullRequestUntil;
  readonly pullRequest:
    | { readonly project: string; readonly url: string }
    | {
        readonly projectId: string;
        readonly host: string;
        readonly repository: string;
        readonly number: number;
      };
}

// Checks take a moment to be listed after a push, so "none" only counts once it has stayed none.
const NO_CHECKS_AFTER_MS = 2 * 60_000;

/** Required checks decide when the host marks any as required; otherwise all of them do. */
export const standingOf = (
  detail: Pick<PullRequestDetail, "state" | "checks" | "mergeability" | "url">,
): PullRequestStanding => {
  const listed = detail.checks.filter((check) => check.placeholder !== true);
  const counted = listed.some((check) => check.required === true)
    ? listed.filter((check) => check.required === true)
    : listed;
  const failing = counted.some(
    (check) =>
      check.status === "failure" ||
      check.status === "cancelled" ||
      // Nothing moves it but a person, so a run waiting for it would wait for good.
      check.status === "action-required",
  );
  const pending = counted.some((check) => check.status === "pending");
  return {
    state: detail.state,
    // Pending first: the wait is for none of them still running, even once one has failed.
    checks: counted.length === 0 ? "none" : pending ? "pending" : failing ? "failing" : "passing",
    mergeability: detail.mergeability,
    url: detail.url,
  };
};

/** Whether a wait `until` this is over, the host having listed no checks for `withoutChecksMs`. */
export const isSettled = (
  until: PullRequestUntil,
  standing: PullRequestStanding,
  withoutChecksMs: number,
): boolean => {
  if (standing.state !== "open") return true;
  if (until !== "checks") return false;
  if (standing.checks === "none") return withoutChecksMs >= NO_CHECKS_AFTER_MS;
  return standing.checks !== "pending";
};

export interface PullRequestQuery {
  readonly project: string;
  /** Defaults to open. */
  readonly state?: PullRequestListState | undefined;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}

type PullRequestSeen = Parameters<typeof pullRequestReference>[1];
/** A pull request as a run's reference, under the key every way of naming it shares. */
export const pullRequestReferenceOf = (
  ref: Pick<PullRequestRef, "projectId" | "host" | "repository" | "number">,
  seen?: PullRequestSeen,
) =>
  pullRequestReference(
    {
      projectId: ref.projectId,
      ...normalizeThreadPullRequestKey({
        host: ref.host ?? "",
        repository: ref.repository,
        number: ref.number,
        ...(seen?.url === undefined ? {} : { url: seen.url }),
      }),
    },
    seen,
  );

/** The pull requests linked to a thread from `sinceMillis` on, as references of its step. */
export const linkedPullRequestReferences = (
  thread: Parameters<typeof threadPullRequestsOf>[0] & { readonly projectId: ProjectId },
  sinceMillis: number | undefined,
) =>
  threadPullRequestsOf(thread)
    .filter(
      (link) =>
        link.source !== "stack-dismissed" &&
        (sinceMillis === undefined || Date.parse(link.linkedAt) >= sinceMillis),
    )
    .map((link) =>
      pullRequestReferenceOf(
        {
          projectId: thread.projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        },
        link.snapshot === null
          ? { url: link.url }
          : { url: link.url, title: link.snapshot.title, state: link.snapshot.state },
      ),
    );

/**
 * What `subject` and `runs({ subject })` take: a pull request as a trigger or a
 * listing gave it, `{ threadId }`, or a web address.
 */
export type SubjectInput =
  | string
  | (Pick<PullRequest, "projectId" | "host" | "repository" | "number"> & {
      readonly title?: string;
      readonly url?: string;
    })
  | { readonly threadId: string };

const SUBJECT_EXAMPLE = "a pull request a trigger or listing gave, { threadId }, or a web address";

const decodeSubjectPullRequest = Schema.decodeUnknownOption(
  Schema.Struct({
    projectId: ProjectId,
    host: TrimmedNonEmptyString,
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * A subject as the reference it is kept and found by. Throws for anything else: a workflow file
 * is not type-checked, and a subject that names nothing would be a run no one can find.
 */
export const subjectReference = (what: string, subject: SubjectInput) => {
  if (typeof subject === "string") {
    if (!URL.canParse(subject) || !/^https?:$/.test(new URL(subject).protocol)) {
      throw new Error(`${what} takes ${SUBJECT_EXAMPLE}; "${subject}" is not a web address.`);
    }
    return {
      kind: WorkflowReferenceKind.url,
      key: subject,
      address: { url: subject },
      title: "",
      url: subject,
    } satisfies ReferenceInput;
  }
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    throw new Error(`${what} takes ${SUBJECT_EXAMPLE}.`);
  }
  const seen = {
    ...("title" in subject && nonEmpty(subject.title) ? { title: subject.title } : {}),
    ...("url" in subject && nonEmpty(subject.url) ? { url: subject.url } : {}),
  };
  // Decoded, not trusted: an item's own view finds its runs by project and host, so a subject
  // kept without either would be a run that view never lists.
  if ("repository" in subject && "number" in subject) {
    const pullRequest = Option.getOrUndefined(decodeSubjectPullRequest(subject));
    if (pullRequest === undefined) {
      throw new Error(
        `${what} takes ${SUBJECT_EXAMPLE}; a pull request needs its projectId, host, repository and number.`,
      );
    }
    return pullRequestReferenceOf(pullRequest, seen);
  }
  if ("threadId" in subject && nonEmpty(subject.threadId)) {
    return {
      kind: WorkflowReferenceKind.thread,
      key: subject.threadId,
      address: { threadId: subject.threadId },
      title: "",
    } satisfies ReferenceInput;
  }
  throw new Error(`${what} takes ${SUBJECT_EXAMPLE}.`);
};

export class WorkflowForge extends Context.Service<
  WorkflowForge,
  {
    readonly pullRequests: {
      readonly list: (
        query: PullRequestQuery,
      ) => Effect.Effect<ReadonlyArray<PullRequest>, WorkflowForgeError>;
      readonly read: (
        pullRequest: PullRequestAddress,
      ) => Effect.Effect<PullRequestDetail, WorkflowForgeError>;
      readonly comment: (
        pullRequest: PullRequestAddress,
        body: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly act: (
        pullRequest: PullRequestAddress,
        action: PullRequestAction,
        options?: { readonly mergeMethod?: PullRequestMergeMethod | undefined },
      ) => Effect.Effect<void, WorkflowForgeError>;
    };
  }
>()("cox/workflows/WorkflowForge") {}

const failed =
  (what: string) =>
  (cause: unknown): WorkflowForgeError =>
    new WorkflowForgeError({
      reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

const missing = (what: string) => () =>
  Effect.fail(
    new WorkflowForgeError({
      reason: `${what} are not available to workflows on this server.`,
    }),
  );
/** For an engine with no trackers behind it: every call says so. */
export const unavailable = WorkflowForge.of({
  pullRequests: {
    list: missing("Pull requests"),
    read: missing("Pull requests"),
    comment: missing("Pull requests"),
    act: missing("Pull requests"),
  },
});

export const layer = Layer.effect(
  WorkflowForge,
  Effect.gen(function* () {
    const pullRequests = yield* PullRequestService.PullRequestService;
    const projects = yield* ProjectService.ProjectService;

    const projectIdOf = Effect.fn("WorkflowForge.projectIdOf")(function* (project: string) {
      if (!isProjectPath(project)) return ProjectId.make(project);
      const found = yield* projects
        .getByWorkspaceRoot(project)
        .pipe(Effect.mapError(failed("Could not read the project")));
      if (Option.isNone(found)) {
        return yield* new WorkflowForgeError({ reason: `No project is registered at ${project}.` });
      }
      return found.value.id;
    });

    const pullRequestRef = Effect.fn("WorkflowForge.pullRequestRef")(function* (
      pullRequest: PullRequestAddress,
    ) {
      if (!("project" in pullRequest)) {
        return {
          projectId: pullRequest.projectId,
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
        } satisfies PullRequestRef;
      }
      const parsed = sourceControlDefinitions.parseChangeRequestUrl(pullRequest.url)?.link;
      if (parsed === undefined) {
        return yield* new WorkflowForgeError({
          reason: `${pullRequest.url} is not a pull request address.`,
        });
      }
      const key = normalizeThreadPullRequestKey(parsed);
      return {
        projectId: yield* projectIdOf(pullRequest.project),
        host: key.host,
        repository: key.repository,
        number: key.number,
      } satisfies PullRequestRef;
    });

    // An address that is a whole listing row already says what the item is called.
    const seenOf = (address: object) => ({
      ...("title" in address && typeof address.title === "string" ? { title: address.title } : {}),
      ...("url" in address && typeof address.url === "string" ? { url: address.url } : {}),
    });
    const pullRequestTouched = (ref: PullRequestRef, seen: PullRequestSeen) =>
      noteReference(pullRequestReferenceOf(ref, seen));

    return WorkflowForge.of({
      pullRequests: {
        list: Effect.fn("WorkflowForge.pullRequests.list")(function* (query) {
          const result = yield* pullRequests
            .list({
              projectId: yield* projectIdOf(query.project),
              state: query.state ?? "open",
              ...(query.query === undefined ? {} : { query: query.query }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            })
            .pipe(Effect.mapError(failed("Could not list pull requests")));
          const problem = result.errors[0];
          if (result.entries.length === 0 && problem !== undefined) {
            return yield* new WorkflowForgeError({
              reason: `Could not list pull requests: ${problem.message}`,
            });
          }
          return result.entries;
        }),
        read: Effect.fn("WorkflowForge.pullRequests.read")(function* (pullRequest) {
          const ref = yield* pullRequestRef(pullRequest);
          // Fresh, not a held copy: checks that passed before a push must not end a wait after it.
          const detail = yield* pullRequests
            .detail({ ...ref, allowStale: false })
            .pipe(Effect.mapError(failed("Could not read the pull request")));
          yield* pullRequestTouched(ref, detail);
          return detail;
        }),
        comment: Effect.fn("WorkflowForge.pullRequests.comment")(function* (pullRequest, body) {
          const ref = yield* pullRequestRef(pullRequest);
          yield* pullRequests
            .comment({ ...ref, body })
            .pipe(Effect.mapError(failed("Could not comment on the pull request")));
          yield* pullRequestTouched(ref, seenOf(pullRequest));
        }),
        act: Effect.fn("WorkflowForge.pullRequests.act")(function* (pullRequest, action, options) {
          const ref = yield* pullRequestRef(pullRequest);
          yield* pullRequests
            .runAction({
              ...ref,
              action,
              ...(options?.mergeMethod === undefined ? {} : { mergeMethod: options.mergeMethod }),
            })
            .pipe(Effect.mapError(failed(`Could not ${action} the pull request`)));
          yield* pullRequestTouched(ref, seenOf(pullRequest));
        }),
      },
    });
  }),
);
