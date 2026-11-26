import { describe, expect, it } from "vite-plus/test";
import {
  isWslSharePath,
  workspaceRelativeFilePath,
  newProjectFolderName,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveWorkspaceFilePath,
} from "./path.ts";

describe("path helpers", () => {
  it("recognizes WSL shares and nothing else", () => {
    expect(isWslSharePath("\\\\wsl.localhost\\Ubuntu\\home")).toBe(true);
    expect(isWslSharePath("\\\\wsl$\\Ubuntu")).toBe(true);
    expect(isWslSharePath(" //WSL.LOCALHOST/Ubuntu/home")).toBe(true);
    expect(isWslSharePath("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\repo")).toBe(true);
    expect(isWslSharePath("\\\\.\\UNC\\wsl$\\Ubuntu\\repo")).toBe(true);
    expect(isWslSharePath("\\\\?\\C:\\work\\repo")).toBe(false);
    expect(isWslSharePath("\\\\wslserver\\share")).toBe(false);
    expect(isWslSharePath("\\\\fileserver\\wsl.localhost")).toBe(false);
    expect(isWslSharePath("C:\\work\\repo")).toBe(false);
  });

  // regression: #17923 literal colons in names are kept, not parsed as positions
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["src/file", "C:\\Workspace\\", "C:\\Workspace\\src\\file"],
    ["~/report:123", "/workspace", "~/report:123"],
    ["note.txt", "/tmp/photos\\", "/tmp/photos\\/note.txt"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("normalizes a bare Windows drive root the same as one with a trailing separator", () => {
    expect(normalizeProjectPathForDispatch("C:")).toBe("C:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe("c:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:\\"));
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:/"));
    expect(normalizeProjectPathForDispatch("C:\\repo\\")).toBe("C:\\repo");
  });

  it("names a new project's folder from any typed name", () => {
    expect(newProjectFolderName("Pinball Stats")).toBe("pinball-stats");
    expect(newProjectFolderName("  Café & Crème!  ")).toBe("cafe-creme");
    expect(newProjectFolderName("Łódź sklep")).toBe("lodz-sklep");
    expect(newProjectFolderName("Øl på Þingvellir ı")).toBe("ol-pa-thingvellir-i");
    expect(newProjectFolderName("ŉ woord")).toBe("n-woord");
    expect(newProjectFolderName("../../etc")).toBe("etc");
    expect(newProjectFolderName("🎱🎱")).toBe("project");
    expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(newProjectFolderName("Con")).toBe("con-project");
    expect(newProjectFolderName("LPT1")).toBe("lpt1-project");
    expect(newProjectFolderName("console")).toBe("console");
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #9309 POSIX paths compare case-sensitively, Windows paths do not
  it.each([
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/repo/project-two/a.ts", "/repo/project", null],
    // regression: #16354 a `..` that leaves the root is a host path, not a workspace path
    ["/repo/project/../other/notes.md", "/repo/project", null],
    ["C:\\repo\\project\\src\\..\\..\\notes.md", "C:\\repo\\project", null],
    ["/repo/project/docs/a/../b.md", "/repo/project", "docs/a/../b.md"],
    ["/repo/a\\b.txt", "/repo", "a\\b.txt"],
    ["/repo/a/b.txt", "/repo", "a/b.txt"],
    ["/repo/a\\", "/repo", "a\\"],
    ["/repo/..\\notes.md", "/repo", "..\\notes.md"],
    ["/repo/a\\/../../notes.md", "/repo", null],
    ["/repo\\project/a.txt", "/repo\\project/", "a.txt"],
    ["/repo/project/a.txt", "/repo\\project", null],
    ["/repo\\project/a.txt", "/repo/project", null],
    ["C:\\Repo\\src\\main.ts", "c:/repo/", "src/main.ts"],
    ["/C:/Repo/src/main.ts", "c:\\repo", "src/main.ts"],
    ["C:\\Repo\\src\\main.ts", "/c:/repo", "src/main.ts"],
    ["\\\\SERVER\\Share\\Repo\\src\\main.ts", "\\\\server\\share\\repo", "src/main.ts"],
    ["\\\\SERVER\\Share\\Repo\\src\\main.ts", "//server/share/repo", "src/main.ts"],
    ["//server/share/a\\b.txt", "//server/share", "a\\b.txt"],
    ["\\\\server\\share\\repo\\..\\notes.md", "\\\\server\\share\\repo", null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});
