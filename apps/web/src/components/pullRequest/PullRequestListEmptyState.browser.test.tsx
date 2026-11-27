import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { PullRequestListEmptyState } from "./PullRequestListEmptyState";

it.each([false, true])(
  "keeps whole characters in a truncated pull request query (searching: %s)",
  async (searching) => {
    const prefix = "a".repeat(47);
    await using screen = await render(
      <PullRequestListEmptyState
        query={prefix + "🚀tail"}
        filtered={false}
        searching={searching}
        hasProjects
        canLoadMore={false}
        loadingMore={false}
        refreshing={false}
        onClearQuery={() => {}}
        onLoadMore={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(screen.container.textContent).toContain(`“${prefix}…”`);
  },
);

it("shows no space before the ellipsis of a truncated pull request query", async () => {
  const prefix = "a".repeat(46);
  await using screen = await render(
    <PullRequestListEmptyState
      query={prefix + " 🚀and the rest of the search"}
      filtered
      searching={false}
      hasProjects
      canLoadMore={false}
      loadingMore={false}
      refreshing={false}
      onClearQuery={() => {}}
      onLoadMore={() => {}}
      onRefresh={() => {}}
    />,
  );
  expect(screen.container.textContent).toContain(`“${prefix}…”`);
  expect(screen.container.textContent).not.toContain(`“${prefix} …”`);
});
