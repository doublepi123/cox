import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openDiffFilePrimaryAction, resolveDiffPathForWorkspace } from "./diffFileActions";
import { resolveFileContextMenuAbsolutePath } from "./fileContextMenu";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  });

  it("opens repository-relative diff files from a nested project", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:Dockerfile",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("opens and reveals a POSIX diff file with a literal backslash", () => {
    const filePath = "frontend/back\\slash.txt";
    const workspaceRoot = "/repo/frontend";
    const repositoryRoot = "/repo";
    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath,
      activeCwd: workspaceRoot,
      repositoryRoot,
      openInEditor: vi.fn(),
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ activeSurfaceId: "file:back\\slash.txt" });
    expect(
      resolveFileContextMenuAbsolutePath({
        environmentId: THREAD_REF.environmentId,
        filePath,
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("/repo/frontend/back\\slash.txt");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
      }),
    ).toBe("src/index.ts");
  });

  // regression: #6174 opening diff files broke for repositories at a filesystem root
  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("index.ts");
  });

  it.each([
    "backend/server.ts",
    "frontend2/app.ts",
    "frontend/../secret.ts",
    "frontend/..\\secret.ts",
    "C:secret.ts",
  ])("does not open an out-of-project diff path: %s", (filePath) => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath,
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ isOpen: false });
    expect(openInEditor).not.toHaveBeenCalled();
  });
});

describe("absolute tool diff paths", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  });

  describe.each([
    {
      style: "POSIX",
      workspaceRoot: "/repo/frontend",
      filePath: "/repo/frontend/src/Index.ts",
      editorPath: "/repo/frontend/src/Index.ts",
    },
    {
      style: "Windows drive",
      workspaceRoot: "C:\\Repo\\Frontend",
      filePath: "c:/repo/frontend/src\\Index.ts",
      editorPath: "C:\\Repo\\Frontend\\src\\Index.ts",
    },
    {
      style: "Windows UNC",
      workspaceRoot: "\\\\Server\\Share\\Repo",
      filePath: "\\\\server\\share\\repo\\src\\Index.ts",
      editorPath: "\\\\Server\\Share\\Repo\\src\\Index.ts",
    },
  ])("$style paths inside the workspace", ({ workspaceRoot, filePath, editorPath }) => {
    it("opens the workspace-relative file on the thread route", () => {
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: workspaceRoot,
        openInEditor,
      });

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: true, activeSurfaceId: "file:src/Index.ts" });
      expect(openInEditor).not.toHaveBeenCalled();
    });

    it("resolves the context menu target under the workspace root", () => {
      expect(
        resolveFileContextMenuAbsolutePath({
          environmentId: THREAD_REF.environmentId,
          filePath,
          workspaceRoot,
        }),
      ).toBe(editorPath);
    });
  });

  describe.each([
    { filePath: "/repo/backend/server.ts", workspaceRoot: "/repo/frontend" },
    { filePath: "/repo/frontend2/app.ts", workspaceRoot: "/repo/frontend" },
    { filePath: "/repo/Frontend/app.ts", workspaceRoot: "/repo/frontend" },
    { filePath: "/repo/frontend/../backend/server.ts", workspaceRoot: "/repo/frontend" },
    { filePath: "/repo/frontend/src/../app.ts", workspaceRoot: "/repo/frontend" },
    { filePath: "/repo/frontend", workspaceRoot: "/repo/frontend" },
    { filePath: "/repo/frontend/src/Index.ts", workspaceRoot: undefined },
    { filePath: "/home/fixture/repo/~/app.ts", workspaceRoot: "/home/fixture/repo" },
    { filePath: "C:\\repo\\frontend2\\app.ts", workspaceRoot: "C:\\repo\\frontend" },
    { filePath: "C:\\repo\\frontend\\src/../app.ts", workspaceRoot: "C:\\repo\\frontend" },
  ])("path $filePath with workspace $workspaceRoot", ({ filePath, workspaceRoot }) => {
    it("leaves the thread file panel closed", () => {
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: workspaceRoot,
        repositoryRoot: workspaceRoot ?? "/repo",
        openInEditor,
      });

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ isOpen: false });
      expect(openInEditor).not.toHaveBeenCalled();
    });

    it("provides no context menu target", () => {
      expect(
        resolveFileContextMenuAbsolutePath({
          environmentId: THREAD_REF.environmentId,
          filePath,
          workspaceRoot,
          repositoryRoot: workspaceRoot ?? "/repo",
        }),
      ).toBeNull();
    });
  });
});
