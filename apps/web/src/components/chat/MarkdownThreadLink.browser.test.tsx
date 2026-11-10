import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";
import { makeThreadFixture } from "../../test-fixtures";
import "../../index.css";

const state = vi.hoisted(() => ({
  supported: true,
  shellId: null as string | null,
  pending: false,
  error: null as string | null,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([[EnvironmentId.make("local"), { threadLinkMetadata: state.supported }]])) as never,
  useThreadRefs: () =>
    state.error
      ? [{ environmentId: EnvironmentId.make("other"), threadId: ThreadId.make("same-id") }]
      : [],
  useThreadShell: (ref) =>
    ref && ref.threadId === state.shellId && (!state.error || ref.environmentId === "other")
      ? makeThreadFixture({
          id: ref.threadId,
          environmentId: ref.environmentId,
          title: "Decoded thread",
        })
      : null,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: {},
    dataUpdatedAt: 0,
    error: state.error,
    failure: state.error,
    isPending: state.pending,
    isSuccess: state.error === null,
    refresh: () => {},
  })) as never,
}));

const environmentId = EnvironmentId.make("local");
function resetState() {
  state.supported = true;
  state.shellId = null;
  state.pending = false;
  state.error = null;
}

describe("MarkdownThreadLink metadata", () => {
  it("keeps a known-missing thread unresolved during refresh", async () => {
    resetState();
    state.pending = true;
    await using screen = await render(
      <MarkdownThreadLink
        environmentId={environmentId}
        link={{ environmentId: null, threadId: ThreadId.make("missing") }}
        label="Missing"
      />,
    );
    await expect.element(screen.getByText("Missing")).toBeVisible();
    expect(screen.container.querySelector("a")).toBeNull();
  });

  it("does not guess another environment after a metadata failure", async () => {
    resetState();
    state.error = "Disconnected";
    state.shellId = "same-id";
    await using screen = await render(
      <MarkdownThreadLink
        environmentId={environmentId}
        link={{ environmentId: null, threadId: ThreadId.make("same-id") }}
        label="Source thread"
      />,
    );
    expect(screen.container.querySelector("a")?.getAttribute("href")).not.toContain("/other/");
  });
  it.each(["constructor", "toString", "__proto__"])(
    "does not read inherited metadata for %s",
    async (id) => {
      resetState();
      await using screen = await render(
        <MarkdownThreadLink
          environmentId={environmentId}
          link={{ environmentId: null, threadId: ThreadId.make(id) }}
          label="Unknown thread"
        />,
      );
      await expect.element(screen.getByText("Unknown thread")).toBeVisible();
    },
  );

  it("resolves a decoded shell without metadata capability", async () => {
    resetState();
    state.supported = false;
    state.shellId = "thread:decoded";
    await using screen = await render(
      <MarkdownThreadLink
        environmentId={environmentId}
        link={{ environmentId: null, threadId: ThreadId.make("thread%3Adecoded") }}
        label={null}
      />,
    );
    await expect.element(screen.getByText("Decoded thread")).toBeVisible();
  });
});
