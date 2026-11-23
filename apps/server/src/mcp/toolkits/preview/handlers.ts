import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationActInputs,
  PreviewAutomationRepeatedFailureError,
  OrchestratorMcpFailure,
  type ToolActivityIcon,
  type ThreadId,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";

import {
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/** Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
function normalizePreviewOpenInput(input: PreviewAutomationOpenInput): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

export const PREVIEW_FAILURE_LIMIT = 2;
export const PREVIEW_FAILURE_COOLDOWN_MS = 5 * 60_000;
const PREVIEW_FAILURE_GUIDANCE =
  "Preview calls failed twice in a row on this tab, so Cox refuses further preview calls here for now. Stop using preview_* for this step: quote the error, then use the user's own browser through computer-use tools (Cox computer_* or your own) or another browser tool you have.";

interface PreviewFailureRecord {
  readonly count: number;
  readonly lastAt: number;
  readonly lastErrorTag: string;
  readonly lastErrorMessage: string;
}

const previewFailureLedgers = new WeakMap<object, Map<string, PreviewFailureRecord>>();

const previewFailuresFor = (broker: object) => {
  const existing = previewFailureLedgers.get(broker);
  if (existing !== undefined) return existing;
  const created = new Map<string, PreviewFailureRecord>();
  previewFailureLedgers.set(broker, created);
  return created;
};

const PREVIEW_CLEANUP_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "dialog",
  "close",
  "recordingStop",
]);

const countsAsPreviewFailure = (error: { readonly _tag: string }) =>
  error._tag !== "PreviewAutomationInvalidSelectorError" &&
  error._tag !== "PreviewAutomationUnavailableError" &&
  error._tag !== "PreviewAutomationControlInterruptedError" &&
  error._tag !== "PreviewAutomationTabNotFoundError" &&
  error._tag !== "PreviewAutomationRepeatedFailureError";

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  { result: A; toolIcon?: ToolActivityIcon },
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const previewFailures = previewFailuresFor(broker);
  const failureKey = `${scope.thread.threadId}\u0000${tabId ?? ""}`;
  const guarded = !PREVIEW_CLEANUP_OPERATIONS.has(operation);
  const blocked = guarded ? previewFailures.get(failureKey) : undefined;
  if (blocked !== undefined && blocked.count >= PREVIEW_FAILURE_LIMIT) {
    const now = yield* Clock.currentTimeMillis;
    const remaining = blocked.lastAt + PREVIEW_FAILURE_COOLDOWN_MS - now;
    if (remaining > 0)
      return yield* new PreviewAutomationRepeatedFailureError({
        operation,
        ...(tabId === undefined ? {} : { tabId }),
        failures: blocked.count,
        lastErrorTag: blocked.lastErrorTag,
        lastErrorMessage: blocked.lastErrorMessage,
        retryAfterMs: remaining,
        guidance: PREVIEW_FAILURE_GUIDANCE,
      });
    previewFailures.delete(failureKey);
  }
  let targetTabId = tabId;
  const result = yield* broker
    .invoke<A>({
      onTargetTab: (resolvedTabId) => {
        targetTabId = resolvedTabId;
      },
      scope,
      operation,
      input,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(tabId === undefined ? {} : { tabId }),
    })
    .pipe(
      Effect.tap(() => Effect.sync(() => previewFailures.delete(failureKey))),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!guarded || !countsAsPreviewFailure(error)) return yield* error;
          const now = yield* Clock.currentTimeMillis;
          const count = (previewFailures.get(failureKey)?.count ?? 0) + 1;
          previewFailures.set(failureKey, {
            count,
            lastAt: now,
            lastErrorTag: error._tag,
            lastErrorMessage: error.message,
          });
          if (count < PREVIEW_FAILURE_LIMIT) return yield* error;
          return yield* new PreviewAutomationRepeatedFailureError({
            operation,
            ...(tabId === undefined ? {} : { tabId }),
            failures: count,
            lastErrorTag: error._tag,
            lastErrorMessage: error.message,
            retryAfterMs: PREVIEW_FAILURE_COOLDOWN_MS,
            guidance: PREVIEW_FAILURE_GUIDANCE,
          });
        }),
      ),
    );
  if (["status", "open", "navigate", "snapshot"].includes(operation)) return { result };
  const statusTabId =
    (operation !== "evaluate" && typeof result === "object" && result !== null
      ? (result as { tabId?: PreviewTabId }).tabId
      : undefined) ?? targetTabId;
  const page = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      timeoutMs: 500,
      updateCurrentTab: false,
      ...(statusTabId === undefined ? {} : { tabId: statusTabId }),
    })
    .pipe(Effect.orElseSucceed(() => null));
  return {
    result,
    ...(page?.url && /^https?:\/\//i.test(page.url) && page.url.length <= 4096
      ? { toolIcon: { _tag: "website" as const, pageUrl: page.url } }
      : {}),
  };
});

const invokeTargeted = <A extends object>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId).pipe(
    Effect.map(({ result, toolIcon }) => ({
      ...result,
      ...(toolIcon ? { toolIcon } : {}),
    })),
  );
};

const decodeActInput = Record.map(PreviewAutomationActInputs, (schema) =>
  Schema.decodeUnknownEffect(schema),
);

const UploadedRecordingArtifact = Schema.Struct({
  ...PreviewAutomationRecordingArtifact.fields,
  uploadedAttachmentId: Schema.optional(Schema.String),
});
const decodeUploadedRecordingArtifact = Schema.decodeUnknownEffect(UploadedRecordingArtifact);

export const claimPreviewRecording = Effect.fn("PreviewToolkit.claimRecording")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const artifact = yield* decodeUploadedRecordingArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  );
  if (!artifact.uploadedAttachmentId) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const config = yield* ServerConfig.ServerConfig;
  const uuid = parseAttachmentUuid(artifact.uploadedAttachmentId);
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
  if (!uuid || !extension || !threadSegment || artifact.uploadedAttachmentId !== pendingId) {
    return yield* new PreviewAutomationRecordingTransferError({
      threadId,
    });
  }
  const finalId = `${threadSegment}-${uuid}-${extension}`;
  const currentPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${pendingId}.${extension}`,
  });
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${finalId}.${extension}`,
  });
  if (!currentPath || !finalPath) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const validateFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.filterOrFail(
        (stat) =>
          stat.type === "File" &&
          Number(stat.size) === artifact.sizeBytes &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        () => new PreviewAutomationRecordingTransferError({ threadId }),
      ),
    );
  yield* Effect.gen(function* () {
    yield* validateFile(currentPath);
    yield* fileSystem.rename(currentPath, finalPath);
  }).pipe(
    Effect.catchIf(
      (cause) =>
        cause._tag !== "PreviewAutomationRecordingTransferError" &&
        cause.reason._tag === "NotFound",
      () => validateFile(finalPath),
    ),
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  );
  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact;
  return { ...recording, id: finalId, path: finalPath };
});

const handlers = {
  preview_dialog: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("dialog", input),
  ),
  preview_status: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  ),
  // Models often pass a dev server as both `url` and `target`; the target knows the environment.
  preview_open: McpToolAccess.actsAsCaller(({ target, url, ...input }) =>
    Effect.gen(function* () {
      const opened = yield* invokeTargeted<PreviewAutomationStatus>(
        "open",
        normalizePreviewOpenInput(
          target === undefined && url !== undefined ? { ...input, url } : input,
        ),
      );
      if (target === undefined || opened.tabId === null) return opened;
      return yield* invokeTargeted<PreviewAutomationStatus>("navigate", {
        target,
        tabId: opened.tabId,
      });
    }),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  ),
  preview_resize: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  ),
  preview_set_appearance: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  ),
  preview_snapshot: McpToolAccess.readsAsCaller((input) => {
    const { includeImage: _includeImage, save, ...operationInput } = input ?? {};
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", {
      ...operationInput,
      ...(save === true ? { fullScreenshot: true } : {}),
    });
  }),
  preview_act: McpToolAccess.actsAsCaller(({ action, ...input }) =>
    decodeActInput[action](input).pipe(
      Effect.mapError(
        (cause) => new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
      ),
      Effect.flatMap((decoded) =>
        invokeTargeted<object>(
          action,
          decoded,
          "timeoutMs" in decoded ? decoded.timeoutMs : undefined,
        ),
      ),
    ),
  ),
  preview_evaluate: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    invoke<unknown>("evaluate", input, undefined, tabId).pipe(
      Effect.map(({ result, toolIcon }) => ({
        value: result ?? null,
        ...(toolIcon ? { toolIcon } : {}),
      })),
    ),
  ),
  preview_wait_for: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<object>("waitFor", input, input.timeoutMs),
  ),
  preview_recording_start: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  ),
  preview_recording_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...operationInput, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewRecording(scope.thread.threadId, response.result);
      return { ...artifact, ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PreviewToolkit.tools>;

const { preview_snapshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(PreviewStandardToolkit, standardHandlers);

export const layerSnapshot = McpToolAccess.toLayer(PreviewSnapshotToolkit, {
  preview_snapshot,
});
