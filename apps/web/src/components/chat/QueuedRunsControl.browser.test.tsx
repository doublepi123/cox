import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  reorder: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
  useQuietThreadShell: ((target: unknown) =>
    target === null ? null : { title: "Release lead" }) as never,
}));

vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { tasks: [{ id: "task:webhook", title: "PR dispatcher" }] },
  })) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: unknown) =>
    command === threadEnvironment.reorderQueuedRun
      ? state.reorder
      : async () => undefined) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import "~/index.css";
import { render as renderUi } from "../../../test/render";
import { QueuedRunsControl } from "./QueuedRunsControl";
import { threadEnvironment } from "../../state/threads";

function setup() {
  state.projection = null;
  state.workflow = null;
  state.reorder.mockReset().mockResolvedValue(undefined);
}

function setupReorderQueue() {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "active-run" },
    canPromoteToSteer: true,
    queuedRuns: ["first", "second", "third"].map((name) => ({
      run: { id: `run:${name}`, userMessageId: `message:${name}` },
      text: name,
      attachments: [],
    })),
  };
}

it("reorders queued messages using actual delivery targets and disables boundary moves", async () => {
  setupReorderQueue();
  await using screen = await renderQueue();
  const moveUp = screen.getByRole("button", { name: "Move queued message up", exact: true });
  const moveDown = screen.getByRole("button", { name: "Move queued message down", exact: true });
  await expect.element(moveUp.nth(0)).toBeDisabled();
  await expect.element(moveDown.nth(2)).toBeDisabled();
  await moveUp.nth(1).click();
  expect(state.reorder).toHaveBeenLastCalledWith({
    environmentId: baseProps.environmentId,
    input: { threadId: baseProps.threadId, runId: "run:second", beforeRunId: "run:first" },
  });
  await moveDown.nth(0).click();
  expect(state.reorder).toHaveBeenLastCalledWith({
    environmentId: baseProps.environmentId,
    input: { threadId: baseProps.threadId, runId: "run:first", beforeRunId: "run:third" },
  });
  await moveDown.nth(1).click();
  expect(state.reorder).toHaveBeenLastCalledWith({
    environmentId: baseProps.environmentId,
    input: { threadId: baseProps.threadId, runId: "run:second", beforeRunId: null },
  });
});

it("locks queue actions while a reorder is pending and unlocks after failure", async () => {
  setupReorderQueue();
  let resolveReorder: (result: unknown) => void = () => undefined;
  state.reorder.mockReturnValue(
    new Promise((resolve) => {
      resolveReorder = resolve;
    }),
  );
  await using screen = await renderQueue();
  const moveUp = screen.getByRole("button", { name: "Move queued message up", exact: true });
  await moveUp.nth(1).click();
  await expect.element(moveUp.nth(1)).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Remove queued message", exact: true }).nth(0))
    .toBeDisabled();
  resolveReorder({ _tag: "Failure" });
  await expect.element(moveUp.nth(1)).toBeEnabled();
  expect(state.reorder).toHaveBeenCalledOnce();
});

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
  timestampFormat: "locale",
  onOpenThread: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await renderQueue({ onEditQueuedRun });

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Edit queued message", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

it("shows who sent a queued message and folds automation and agent prompts", async () => {
  setup();
  const message = (id: string, fields: Record<string, unknown>) => ({
    id,
    role: "user",
    createdAt: DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"),
    ...fields,
  });
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      [
        "run:automation",
        "GitHub labeled a pull request.\nFollow the runbook.",
        {
          createdBy: "agent",
          scheduledTaskId: "task:webhook",
        },
      ],
      [
        "run:agent",
        "Review finished.",
        {
          createdBy: "agent",
          creationSource: "provider",
          senderThreadId: "thread:lead",
        },
      ],
      [
        "run:server",
        "Continue where you left off.",
        {
          createdBy: "agent",
          creationSource: "server",
        },
      ],
    ].map(([runId, text, fields]) => ({
      run: { id: runId, userMessageId: `${runId}:message` },
      text,
      attachments: [],
      message: message(`${runId}:message`, { text, ...(fields as object) }),
    })),
  };
  const onOpenThread = vi.fn();
  await using _screen = await renderQueue({ onOpenThread });

  const automation = page.getByRole("button", { name: /PR dispatcher/ });
  await expect.element(automation).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText(/Follow the runbook/)).not.toBeInTheDocument();
  await automation.click();
  await expect.element(page.getByText(/Follow the runbook/)).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Open automation" })).toBeInTheDocument();

  await expect.element(page.getByRole("button", { name: /Release lead/ })).toBeVisible();
  await page.getByRole("button", { name: "Open thread" }).click({ force: true });
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("thread:lead");

  await expect.element(page.getByText("Sent by Cox")).toBeVisible();
  await expect.element(page.getByText("Continue where you left off.")).toBeVisible();
});

it("stays inside the timeline scroller instead of growing the chat column", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Later",
        attachments: [],
      },
    ],
  };
  // Mirrors ChatView: a scrollable column, a positioned wrapper, then a non-positioned scroller.
  await using screen = await renderUi(
    <div data-testid="column" style={{ height: 200, overflowY: "auto" }}>
      <div style={{ position: "relative", height: "100%" }}>
        <div style={{ height: "100%", overflowY: "auto" }}>
          <div style={{ height: 1000 }} />
          <QueuedRunsControl {...baseProps} />
        </div>
      </div>
    </div>,
  );
  await expect.element(page.getByText("Later", { exact: true })).toBeInTheDocument();
  const column = screen.getByTestId("column").element();
  expect(column.scrollHeight).toBe(column.clientHeight);
});
