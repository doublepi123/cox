import { EMPTY_COMMAND_OUTPUT } from "@t3tools/client-runtime/state/command-output";
import { EnvironmentId, RuntimeRequestId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { CustomSnoozeDialogHost, requestCustomSnooze } from "../CustomSnoozeDialog";
import { CommandOutputPanel } from "./CommandOutputPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");

it("keeps a provider question's authored line breaks", async () => {
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: RuntimeRequestId.make("line-breaks"),
          createdAt: "2026-10-09T00:00:00.000Z",
          dismissible: false,
          responseCapability: "live",
          questions: [
            {
              id: "question",
              header: "Choose options",
              question: "First question line\nSecond question line",
              options: [{ label: "Proceed", description: "Use both lines" }],
              multiSelect: false,
            },
          ],
        },
      ]}
      cwd={undefined}
      threadRef={{ environmentId, threadId }}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
  const paragraph = [...screen.container.querySelectorAll("p")].find((p) =>
    p.textContent?.includes("First question line"),
  );
  expect(paragraph?.querySelector("br")).toBeInstanceOf(HTMLBRElement);
});

it("scrolls the truncation notice with the command output", async () => {
  const text = Array.from({ length: 100 }, (_, index) => String(index)).join("\n");
  const output = Atom.make(
    AsyncResult.success({
      ...EMPTY_COMMAND_OUTPUT,
      output: { ...EMPTY_COMMAND_OUTPUT.output, text, truncated: true },
    }),
  );
  await using screen = await render(
    <div className="whitespace-pre-wrap">
      <CommandOutputPanel
        environmentId={environmentId}
        threadId={threadId}
        itemId={TurnItemId.make("output")}
        source={() => output}
      />
    </div>,
  );
  const notice = screen.getByText("Earlier output not shown").element();
  const scroller = notice.parentElement!;
  expect(getComputedStyle(scroller).overflowY).toBe("auto");
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  expect(scroller.scrollTop).toBeGreaterThan(0);
  expect(notice.getBoundingClientRect().bottom).toBeLessThan(scroller.getBoundingClientRect().top);
});

it.each([390, 1024])("uses equal date and time label spacing at %s px", async (width) => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  try {
    await page.viewport(width, 800);
    await using screen = await render(<CustomSnoozeDialogHost />);
    await act(() => {
      void requestCustomSnooze();
    });
    const dialog = page.getByRole("dialog", { name: "Custom snooze" });
    await expect.element(dialog).toBeVisible();
    const labels = [...dialog.element().querySelectorAll<HTMLLabelElement>("label")];
    const date = labels.find((label) => label.textContent === "Date")!;
    const time = labels.find((label) => label.textContent === "Time")!;
    expect(date.control).toBeInstanceOf(HTMLButtonElement);
    expect(time.control).toBeInstanceOf(HTMLInputElement);
    expect(getComputedStyle(date.parentElement!).rowGap).toBe(getComputedStyle(time).rowGap);
    expect(screen.container.isConnected).toBe(true);
  } finally {
    await page.viewport(previous.width, previous.height);
  }
});
