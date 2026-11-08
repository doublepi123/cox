import type { ProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { AgentElapsed } from "./AgentElapsed";
import { ProviderSubagentBar } from "./ProviderSubagentBar";
import { setLanguagePreference } from "../../i18n";

type TimedStatus = ProviderSubagentStatus & {
  status: "running" | "waiting" | "completed";
};

function Timers({ status }: { status: TimedStatus }) {
  return (
    <>
      <section aria-label="Parent timer">
        <AgentElapsed agent={status} />
      </section>
      <section aria-label="Child timer">
        <ProviderSubagentBar
          provider={null}
          showInstanceBadge={false}
          modelLabel="Test model"
          effortLabel={null}
          status={status}
          onOpenParent={null}
        />
      </section>
    </>
  );
}

it.each([undefined, 1983254])(
  "shows cached duration %s separately from a live timer",
  async (durationMs) => {
    using _timers = fakeTimers();
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    vi.setSystemTime(new Date("2026-11-05T14:00:05.000Z"));
    const content = (
      <>
        <section aria-label="Cached timer">
          <AgentElapsed
            agent={{
              status: "completed",
              startedAt: "2026-11-05T13:59:27.396Z",
              completedAt: "2026-11-05T13:59:27.396Z",
              cached: true,
              durationMs,
            }}
          />
        </section>
        <section aria-label="Live timer">
          <AgentElapsed
            agent={{ status: "running", startedAt: "2026-11-05T14:00:00.000Z", completedAt: null }}
          />
        </section>
      </>
    );
    await using screen = await render(content);
    const cached = screen.getByRole("region", { name: "Cached timer" });
    const live = screen.getByRole("region", { name: "Live timer" });
    const expected =
      durationMs === undefined ? "已复用缓存 · 原耗时未知" : "已复用缓存 · 原耗时 33m 03s";
    expect(cached.element().textContent).toBe(expected);
    expect(live.element().textContent).toBe("5s");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(cached.element().textContent).toBe(expected);
    expect(live.element().textContent).toBe("7s");
    await screen.unmount();
    await using restored = await render(content);
    expect(restored.getByRole("region", { name: "Cached timer" }).element().textContent).toBe(
      expected,
    );
  },
);

it.each(["running", "waiting"] as const)(
  "updates both subagent timers each second while %s and stops after completion",
  async (workStatus) => {
    using _timers = fakeTimers();
    const startedAt = "2026-11-02T12:00:00.000Z";
    vi.setSystemTime(new Date("2026-11-02T12:00:05.000Z"));
    const status: TimedStatus = {
      status: workStatus,
      startedAt,
      completedAt: null,
    };
    await using screen = await render(<Timers status={status} />);
    const parent = screen.getByRole("region", { name: "Parent timer" });
    const child = screen.getByRole("region", { name: "Child timer" });
    expect(parent.element().textContent).toBe("5s");
    expect(child.element().textContent).toContain(
      workStatus === "running" ? "Working 5s" : "Waiting 5s",
    );

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(parent.element().textContent).toBe("7s");
    expect(child.element().textContent).toContain(
      workStatus === "running" ? "Working 7s" : "Waiting 7s",
    );

    await screen.rerender(
      <Timers
        status={{ ...status, status: "completed", completedAt: "2026-11-02T12:00:07.000Z" }}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(parent.element().textContent).toBe("7s");
    expect(child.element().textContent).toContain("Completed in 7s");

    await screen.rerender(<Timers status={status} />);
    expect(parent.element().textContent).toBe("10s");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(parent.element().textContent).toBe("11s");
    expect(child.element().textContent).toContain(
      workStatus === "running" ? "Working 11s" : "Waiting 11s",
    );
  },
);
