import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route as PullRequestsRoute } from "../../routes/_chat.pull-requests";

function matchedSearch(url: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const pullRequests = createRoute({
    getParentRoute: () => chat,
    path: "pull-requests",
    validateSearch: PullRequestsRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([pullRequests])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  // useSearch reads matched-route search, which can differ from URL search.
  return router.matchRoutes(router.latestLocation).at(-1)?.search as
    | Record<string, unknown>
    | undefined;
}

describe("pull requests route search", () => {
  it("drops a q the URL parser turned into a number", () => {
    expect(matchedSearch("/pull-requests?q=4089")?.q).toBeUndefined();
    expect(matchedSearch("/pull-requests?q=true")?.q).toBeUndefined();
  });

  it.each(["author", "labels"])("drops a numeric %s from the matched route", (key) => {
    expect(matchedSearch(`/pull-requests?${key}=4089`)?.[key]).toBeUndefined();
  });

  it("keeps a q that is text, including quoted digits", () => {
    expect(matchedSearch("/pull-requests?q=fix")?.q).toBe("fix");
    expect(matchedSearch("/pull-requests?q=%224089%22")?.q).toBe("4089");
  });

  it("cuts a long search before an emoji the limit would split", () => {
    const kept = "a".repeat(199);
    const query = new URLSearchParams({ q: `${kept}😀 rest` });
    expect(matchedSearch(`/pull-requests?${query}`)?.q).toBe(kept);
  });
});
