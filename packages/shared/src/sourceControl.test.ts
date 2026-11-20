import { describe, expect, it } from "vite-plus/test";

import { isSshRemoteUrl } from "./sourceControl.ts";

describe("isSshRemoteUrl", () => {
  it.each([
    ["gitserver:repo.git", true],
    ["gitserver:team/repo.git", true],
    ["gitserver:/srv/git/repo.git", true],
    ["git@gitserver:repo.git", true],
    ["ssh://gitserver/srv/git/repo.git", true],
    ["C:repo.git", false],
    ["C:\\repos\\repo.git", false],
    ["hg::owner/repo", false],
    ["https://github.com/owner/repo.git", false],
    ["./team:group/repo", false],
  ] as const)("classifies %s as SSH: %s", (remote, expected) => {
    expect(isSshRemoteUrl(remote)).toBe(expected);
  });
});
