import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveFileContextMenuAbsolutePath, useFileContextMenu } from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

const menuState = vi.hoisted(() => ({
  allowed: true,
  open: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    availableEditors: ["cursor", "file-manager"],
    shellRevealInFileManager: true,
    shellRevealInFileManagerKind: "xdg-open",
    environment: { platform: { os: "linux" } },
  }),
}));
vi.mock(import("./state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => menuState.allowed,
}));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => menuState.open }));

it.each([true, false])(
  "only offers and runs host editor commands with operate access (%s)",
  async (allowed) => {
    menuState.allowed = allowed;
    menuState.open.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);
    expect(menu.buildItems(BASE_TARGET).map((item) => item.id)).toEqual(
      allowed ? ["open", "reveal-in-folder", "open-with"] : [],
    );
    await menu.activate("open", BASE_TARGET);
    await menu.activate("editor:cursor", BASE_TARGET);
    expect(menuState.open).toHaveBeenCalledTimes(allowed ? 2 : 0);
  },
);

describe("resolveFileContextMenuAbsolutePath", () => {
  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });
});
