import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { useSoftwareKeyboardOpen } from "~/hooks/useSoftwareKeyboardOpen";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { Select, SelectTrigger } from "../ui/select";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

const mobilePrompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-mobile"),
  createdAt: "2026-11-15T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [0, 1, 2, 3].map((index) => ({
    id: `mobile-question-${index}`,
    header: `Mobile question ${index + 1}`,
    question: `Choose for mobile question ${index + 1}`,
    options:
      index === 0
        ? Array.from({ length: 8 }, (_, optionIndex) => ({
            label: `Mobile option ${optionIndex + 1}`,
            description: `Touch target ${optionIndex + 1}`,
          }))
        : [{ label: "Continue", description: "Continue to the next question" }],
    multiSelect: index === 0,
  })),
};

const shortcutPrompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-shortcuts"),
  createdAt: "2026-10-31T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "question",
      header: "Rollout",
      question: "How should this ship?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: true,
    },
  ],
};

async function mobileSoftwareKeyboardScope() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 844);
  expect(Object.getOwnPropertyDescriptor(window, "visualViewport")?.value).toBeUndefined();
  expect(window.visualViewport).not.toBeNull();
  expect(window.visualViewport?.constructor.name).toBe("VisualViewport");
  expect(window.visualViewport?.height).toBe(844);
  return {
    async [Symbol.asyncDispose]() {
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

const mobileProgress = derivePendingUserInputProgress(mobilePrompt.questions, {}, 0);

function SoftwareKeyboardHost({ children }: { readonly children: ReactNode }) {
  useSoftwareKeyboardOpen();
  return children;
}

function MobileChatComposerFixture() {
  useSoftwareKeyboardOpen();
  const promptRef = useRef("");
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const composerImagesRef = useRef<
    ComponentProps<typeof ChatComposer>["composerImagesRef"]["current"]
  >([]);
  const composerFilesRef = useRef<
    ComponentProps<typeof ChatComposer>["composerFilesRef"]["current"]
  >([]);
  const composerTerminalContextsRef = useRef<
    ComponentProps<typeof ChatComposer>["composerTerminalContextsRef"]["current"]
  >([]);
  return (
    <div
      data-testid="mobile-visual-viewport"
      className="fixed inset-x-0 top-0 flex flex-col justify-end overflow-hidden"
      style={{ height: "var(--visual-viewport-height, 100dvh)" }}
    >
      <div className="relative mt-auto">
        <ChatComposer
          composerDraftTarget={threadRef}
          environmentId={threadRef.environmentId}
          canOperateThread
          attachmentUploadsCapabilityKnown={false}
          supportsAttachmentUploads={false}
          supportsQuestionAttachments={false}
          maxFileAttachmentBytes={null}
          routeKind="server"
          routeThreadRef={threadRef}
          draftId={null}
          multipleModelSelections={null}
          supportsMultipleModels={false}
          onMultipleModelSelectionsChange={() => {}}
          activeThreadId={threadRef.threadId}
          activeThread={undefined}
          activeThreadShell={null}
          promptHistoryMessages={[]}
          forceExpandedOnMobile
          projectSelectionRequired={false}
          phase="ready"
          canInterrupt={false}
          isSendBusy={false}
          canResume={false}
          sendDisabledReason={null}
          isPreparingWorktree={false}
          isCompacting={false}
          canSteer={false}
          bannerItems={[]}
          resumeCompactionTokens={null}
          keepFullHistory={false}
          onToggleKeepFullHistory={() => {}}
          environmentUnavailable={null}
          activePendingApproval={null}
          pendingApprovals={[]}
          onHeldRequestIdsChange={() => {}}
          pendingUserInputs={[mobilePrompt]}
          activePendingProgress={mobileProgress}
          activePendingResolvedAnswers={null}
          activePendingIsResponding={false}
          activePendingDraftAnswers={{}}
          activePendingQuestionIndex={0}
          respondingRequestIds={[]}
          showPlanFollowUpPrompt={false}
          activeProposedPlan={null}
          threadSyncPhase={null}
          runtimeMode="full-access"
          interactionMode="default"
          lockedProvider={null}
          providerStatuses={[]}
          providerCatalogKnown={false}
          activeProjectDefaultModelSelection={null}
          activeThreadModelSelection={null}
          activeProjectId={null}
          activeContextWindow={null}
          compactThreadUnavailable={false}
          compactDisabled={false}
          compactDisabledReason={null}
          resolvedTheme="dark"
          settings={DEFAULT_UNIFIED_SETTINGS}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          terminalOpen={false}
          gitCwd={null}
          pullRequestProjectId={null}
          pullRequestRepository={null}
          threadPullRequests={undefined}
          onComposerOverlayHeightChange={() => {}}
          permissionsShownInStrip={false}
          promptRef={promptRef}
          composerImagesRef={composerImagesRef}
          composerFilesRef={composerFilesRef}
          composerTerminalContextsRef={composerTerminalContextsRef}
          composerRef={composerRef}
          onPageScrollKeyDown={() => {}}
          onPageScrollKeyUp={() => {}}
          onPageScrollRelease={() => {}}
          editingQueuedAttachments={null}
          onRemoveEditingQueuedAttachment={() => {}}
          onCompactContext={() => {}}
          onSend={() => {}}
          onResume={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={() => {}}
          onSelectActivePendingUserInputOption={() => {}}
          onAdvanceActivePendingUserInput={() => {}}
          onDismissActivePendingUserInput={() => {}}
          onPreviousActivePendingUserInputQuestion={() => {}}
          onChangeActivePendingUserInputCustomAnswer={() => {}}
          onProviderModelSelect={() => {}}
          onOpenProviderSetup={() => {}}
          getModelDisabledReason={() => null}
          toggleInteractionMode={() => {}}
          handleRuntimeModeChange={() => {}}
          handleInteractionModeChange={() => {}}
          focusComposer={() => {}}
          scheduleComposerFocus={() => {}}
          setThreadError={() => {}}
          onExpandImage={() => {}}
          onFileOpen={() => {}}
        />
      </div>
    </div>
  );
}

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

interface ProbeProps {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
}

function useProbeRequests({ environmentId, projection, loading = false }: ProbeProps) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  return usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
    promptRef,
    composerRef,
    setThreadError: () => {},
  });
}

let requests: ReturnType<typeof usePendingThreadRequests>;

function PendingRequestsProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  useLayoutEffect(() => {
    requests = state;
  });
  return null;
}

it("retains answers, selections and question position after leaving chat, including while the projection reloads", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("remount-environment");
  const projection = questionProjection(threadRef.threadId);
  const probe = (loading = false) => (
    <PendingRequestsProbe environmentId={environmentId} projection={projection} loading={loading} />
  );
  await using screen = await render(probe());
  await act(() =>
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Keep my text"),
  );
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onSelectActivePendingUserInputOption("question-1", "Incremental"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  const expected = {
    activePendingQuestionIndex: 2,
    activePendingDraftAnswers: {
      "question-0": { customAnswer: "Keep my text" },
      "question-1": { selectedOptionValues: ["Incremental"] },
    },
  };
  expect(requests).toMatchObject(expected);

  // New thread and Settings both unmount the chat that owns this hook.
  await screen.rerender(null);
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);

  await screen.rerender(null);
  await screen.rerender(probe(true));
  expect(requests.activePendingUserInput).toBeNull();
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);
});

function QuestionPositionProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  return (
    <>
      <output>Question {state.activePendingQuestionIndex + 1}</output>
      <button
        type="button"
        onClick={() => state.onSelectActivePendingUserInputOption("question-0", "Incremental")}
      >
        Choose Incremental
      </button>
      <button type="button" onClick={() => state.onAdvanceActivePendingUserInput()}>
        Submit
      </button>
    </>
  );
}

it("stays on an unanswered question when the composer submits", async () => {
  await using screen = await render(
    <QuestionPositionProbe
      environmentId={EnvironmentId.make("unanswered-environment")}
      projection={questionProjection(threadRef.threadId)}
    />,
  );
  const submit = screen.getByRole("button", { name: "Submit" });
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 1");

  await userEvent.click(screen.getByRole("button", { name: "Choose Incremental" }));
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 2");
});

it("isolates drafts by environment, thread and request and discards only resolved requests", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("scope-environment");
  const projection = questionProjection(threadRef.threadId);
  const scopes = [
    { environmentId, projection },
    { environmentId: EnvironmentId.make("other-environment"), projection },
    { environmentId, projection: questionProjection(ThreadId.make("other-thread")) },
    { environmentId, projection: questionProjection(threadRef.threadId, ["second", "first"]) },
  ];
  await using screen = await render(null);
  const show = (scope: ComponentProps<typeof PendingRequestsProbe>) =>
    screen.rerender(<PendingRequestsProbe {...scope} />);
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(0);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBeUndefined();
    await act(() =>
      requests.onChangeActivePendingUserInputCustomAnswer("question-0", `Answer ${index}`),
    );
    await act(() => requests.onAdvanceActivePendingUserInput());
  }

  // "first" was answered on another device.
  await show({
    environmentId,
    projection: {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) =>
        request.id === "first"
          ? { ...request, status: "resolved", resolvedAt: projection.updatedAt }
          : request,
      ),
    },
  });
  expect(requests.activePendingUserInput?.requestId).toBe("second");
  await act(() =>
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadRef.threadId,
    )([RuntimeRequestId.make("second")]),
  );
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});

it.each<{ focus: string; control: ReactNode; toggles: boolean }>([
  { focus: "a page button", control: <button type="button" aria-label="Focused" />, toggles: true },
  {
    focus: "a dialog",
    control: (
      <div role="dialog">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a popup",
    control: (
      <div data-slot="menu-popup">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a menu",
    control: (
      <div role="menu">
        <button type="button" role="menuitem" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a select",
    control: (
      <select aria-label="Focused">
        <option>One</option>
      </select>
    ),
    toggles: false,
  },
  {
    focus: "a closed select menu",
    control: (
      <Select>
        <SelectTrigger aria-label="Focused" />
      </Select>
    ),
    toggles: false,
  },
  {
    focus: "a combobox",
    control: <button type="button" role="combobox" aria-label="Focused" aria-expanded="false" />,
    toggles: false,
  },
])(
  "digit shortcut with focus in $focus toggles an option: $toggles",
  async ({ control, toggles }) => {
    const onToggleOption = vi.fn();
    await using screen = await render(
      <>
        {control}
        <ComposerPendingUserInputPanel
          pendingUserInputs={[shortcutPrompt]}
          cwd={undefined}
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={vi.fn()}
          onDismiss={vi.fn()}
        />
      </>,
    );
    await expect.element(screen.getByText("Incremental")).toBeVisible();
    screen.getByLabelText("Focused").element().focus();

    await userEvent.keyboard("1");

    expect(onToggleOption.mock.calls).toEqual(toggles ? [["question", "Incremental"]] : []);
  },
);

it("keeps a four-question prompt scrollable with 44px options when the visual viewport shrinks", async () => {
  await using _viewport = await mobileSoftwareKeyboardScope();
  await using screen = await render(
    <SoftwareKeyboardHost>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[mobilePrompt]}
        cwd={undefined}
        threadRef={threadRef}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={vi.fn()}
        onAdvance={vi.fn()}
        onDismiss={vi.fn()}
      />
    </SoftwareKeyboardHost>,
  );
  await expect.element(screen.getByText("1/4")).toBeVisible();
  const rows = Array.from(screen.container.querySelectorAll<HTMLElement>("button[aria-pressed]"));
  expect(rows).toHaveLength(8);
  for (const row of rows) {
    expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  const scroller = screen.container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
  if (!scroller) throw new Error("Missing pending-question scroll viewport");
  await page.viewport(390, 480);
  await expect.poll(() => getComputedStyle(scroller).maxHeight).toBe("264px");
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  await act(() => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  expect(scroller.scrollTop).toBeGreaterThan(0);
  const lastRow = rows.at(-1);
  if (!lastRow) throw new Error("Missing final pending-question option");
  expect(lastRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    scroller.getBoundingClientRect().bottom + 1,
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it("keeps the integrated composer answer and submit controls above a 480px software keyboard", async () => {
  await using _viewport = await mobileSoftwareKeyboardScope();
  await using screen = await render(<MobileChatComposerFixture />);
  expect(
    getComputedStyle(document.documentElement).getPropertyValue("--visual-viewport-height").trim(),
  ).toBe("844px");
  await expect.element(screen.getByText("1/4")).toBeVisible();

  await page.viewport(390, 480);

  expect(window.visualViewport?.height).toBe(480);
  await expect
    .poll(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--visual-viewport-height")
        .trim(),
    )
    .toBe("480px");
  const scroller = screen.container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
  if (!scroller) throw new Error("Missing integrated pending-question scroll viewport");
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  await act(() => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  expect(scroller.scrollTop).toBeGreaterThan(0);
  const editor = screen.getByTestId("composer-editor").element();
  const submit = screen.getByRole("button", { name: "Next", exact: true }).element();
  for (const control of [editor, submit]) {
    const bounds = control.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(480);
    expect(bounds.height).toBeGreaterThan(0);
  }
});
