import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestActorAvatar } from "./pullRequestPresentation";

describe("PullRequestActorAvatar", () => {
  it("renders an astral initial as one character", () => {
    expect(
      renderToStaticMarkup(<PullRequestActorAvatar actor={{ login: "😀octokit" }} />),
    ).toContain(">😀</span>");
  });
});
