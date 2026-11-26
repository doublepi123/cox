import {
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
  type TaskFolderError,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { outputRequestProblem } from "../../../orchestration-v2/runOutput.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import { mutateProjectWithClone } from "../../../project/ProjectMutation.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as DateTime from "effect/DateTime";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  providerOptionDescriptors,
  refuseAgentModePick,
  resolveRuntimeMode,
} from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestrationMcp from "../../OrchestratorMcpService.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectInvalidError"
      ? error.detail
      : error._tag === "ProjectNotFoundError"
        ? "The project was not found."
        : error._tag === "ProjectConflictError"
          ? "The workspace is already registered to a project."
          : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}
/** Require a registered project worktree and retain Git's spelling of its path. */
const projectWorktreePath = Effect.fn("mcp.projectWorktreePath")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const registered = yield* git
    .listWorktreePaths(workspaceRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const requested = yield* real(worktreePath);
  for (const candidate of registered) if ((yield* real(candidate)) === requested) return candidate;
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "worktreePath must be one of the project's git worktrees. cox_worktree_list shows them.",
  });
});

/** A fixed-length id, so a long key fits in the scratch folder name derived from it. */
const launchCommandId = Effect.fn("mcp.launchCommandId")(function* (
  namespace: string,
  key: string,
) {
  const crypto = yield* Digest.Digest;
  // @effect-diagnostics-next-line preferSchemaOverJson:off - a JSON pair keeps the caller apart from the key.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, key]));
  const digest = yield* crypto.digest(Digest.sha256, bytes).pipe(Effect.mapError(unavailable));
  return CommandId.make(`mcp:launch:${Hex.encode(digest)}`);
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});

/** Settings, not the project record, hold the default model and actions that new threads use. */
const withSavedProjectSettings = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.mapError(unavailable),
  );
  return (project: ProjectRecord) => {
    const resolved = resolveProjectSettings(settings, project.id, project);
    return {
      ...project,
      defaultModelSelection:
        resolved.sources.defaultModelSelection === "project"
          ? resolved.settings.defaultModelSelection
          : null,
      scripts: resolveProjectScripts(settings, project),
    };
  };
});

// The project is already committed, so a failed Settings read must not report the create as failed.
const withSavedProjectSettingsAfterCreate = withSavedProjectSettings.pipe(
  Effect.orElseSucceed(() => (project: ProjectRecord) => project),
);

export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  cox_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const context = yield* readCaller();
        const { caller } = context;
        // A retry with the same key replays the first launch: the ids derive
        // from the caller and the key, and the launch service replays a
        // command it already accepted.
        const commandId =
          input.clientRequestId === undefined
            ? yield* newCommandId()
            : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
        const threadId = ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
        const attachments = input.attachments ?? [];
        if (input.generateTitle === true && !input.message?.trim() && attachments.length === 0)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Title generation requires a message or attachments. No thread was created.",
          });
        const schemaProblem =
          input.outputSchema === undefined
            ? null
            : outputRequestProblem(input.outputSchema, {
                text: input.message ?? "",
                attachments: input.attachments,
              });
        if (schemaProblem !== null || (input.outputSchema !== undefined && !input.message))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: schemaProblem ?? "outputSchema needs a message that asks for the result.",
          });
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          });
        const projectId =
          input.scratch === true
            ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                Effect.flatMap((folders) => folders.ensureScratchProject),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              )).projectId
            : yield* resolveProjectId(context, input.projectId);
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        // A retry of an accepted launch replays it: it keeps the model it started
        // with and skips the checks only a new launch needs, which the project
        // may no longer pass, such as a base branch deleted since.
        const launched =
          input.clientRequestId === undefined
            ? null
            : yield* context.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        const launchedModel =
          launched === null || launched.deletedAt !== null ? undefined : launched.modelSelection;
        const replaying = launchedModel !== undefined;
        let strategy = input.workspaceStrategy;
        if (!replaying && input.workspaceStrategy?.type === "existing_worktree") {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          strategy = {
            ...input.workspaceStrategy,
            worktreePath: yield* projectWorktreePath(
              project.workspaceRoot,
              input.workspaceStrategy.worktreePath,
            ),
          };
        }
        // Reject unresolved base refs before accepting a launch; worktree provisioning happens later.

        if (!replaying && strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    error._tag === "ThreadLaunchBranchConflictError"
                      ? `${error.message} No thread was created. Choose a branch name that neither contains nor is nested under an existing branch.`
                      : `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                          strategy.startFromOrigin === true
                            ? "; the project has no usable remote to fetch it from."
                            : ", or set startFromOrigin:true if it exists only on a remote."
                        }`,
                }),
            ),
          );
        // A caller outside a thread has nothing to inherit, so it starts with the
        // project's effective defaults, as the composer does. Its mode stays
        // within the ceiling it was approved with.
        const projectDefaults =
          caller === undefined && !replaying
            ? yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.flatMap((settings) =>
                  Effect.map(
                    readProject,
                    (project) => resolveProjectSettings(settings, projectId, project).settings,
                  ),
                ),
              )
            : undefined;
        let modelSelection =
          input.modelSelection ??
          launchedModel ??
          caller?.modelSelection ??
          (projectDefaults
            ? resolveNewThreadModelSelection({
                defaultSelection: projectDefaults.defaultModelSelection,
                fallbackSelection: projectDefaults.fallbackModelSelection,
                providers: yield* ProviderRegistry.ProviderRegistry.pipe(
                  Effect.flatMap((registry) => registry.getProviders),
                ),
                settings: projectDefaults,
                projectId,
                now: DateTime.toEpochMillis(yield* DateTime.now),
              }).selection
            : null) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        let startedRuntimeMode =
          projectDefaults !== undefined && input.runtimeMode === undefined
            ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                Effect.orElseSucceed(() => runtimeMode),
              )
            : runtimeMode;
        if (!replaying) {
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          const { instanceId } = modelSelection;
          const provider = providers.find((candidate) => candidate.instanceId === instanceId);
          yield* refuseAgentModePick({
            callerRuntimeMode: context.limits.runtimeMode,
            picked: input.modelSelection?.options,
            descriptors: providerOptionDescriptors(provider),
            held:
              caller?.modelSelection.instanceId === instanceId
                ? caller.modelSelection.options
                : undefined,
          });
          if (provider !== undefined && input.modelSelection !== undefined) {
            const options = yield* OrchestrationMcp.validateModelOptions(
              provider,
              modelSelection.model,
              modelSelection.options,
            );
            if (options !== undefined && options !== modelSelection.options) {
              modelSelection = { ...modelSelection, options };
            }
          }
          startedRuntimeMode = yield* resolveRuntimeMode(startedRuntimeMode, input.runtimeMode, {
            modelSelection,
            supportedRuntimeModes: provider?.supportedRuntimeModes,
          });
        }
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          ...(input.generateTitle === undefined ? {} : { generateTitle: input.generateTitle }),
          ...(input.generateTitle === true ? {} : { titleRenamed: true }),
          modelSelection,
          runtimeMode: startedRuntimeMode,
          interactionMode,
          workspaceStrategy: strategy ?? { type: "root" },
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                  ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          link: McpInvocationContext.threadLinkFor(scope, thread.id, thread.title),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
  ),
  cox_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      // Identities are resolved: linked environments find this side's project by repository.
      const page = yield* projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(unavailable));
      return { ...page, projects: page.projects.map(yield* withSavedProjectSettings) };
    }),
  ),
  cox_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return (yield* withSavedProjectSettings)(result.value);
    }),
  ),
  cox_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      if (workspaceRoot === undefined) {
        // Only updates record model defaults; reject defaults that creation would silently drop.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined ||
          input.trackedFolders !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts, trackedFolders, or defaultModelSelection afterwards with cox_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders.createNamedProject({ name: input.title }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              }),
          ),
        );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...(yield* withSavedProjectSettingsAfterCreate)(project),
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      const created = yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
      return (yield* withSavedProjectSettingsAfterCreate)(created);
    }),
  ),
  cox_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      const updated = yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
      return (yield* withSavedProjectSettings)(updated);
    }),
  ),
  cox_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      if (yield* folders.isScratchProject(input.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            '"No project" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.',
        });
      const projects = yield* Project.ProjectService;
      const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
      return yield* mutateProjectWithClone(projects, clones, {
        ...input,
        type: "project.delete",
        commandId: yield* newCommandId(),
      }).pipe(Effect.mapError(projectFailure));
    }),
  ),
  cox_project_clone: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input, { timeoutMs: null }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
  ),
});
