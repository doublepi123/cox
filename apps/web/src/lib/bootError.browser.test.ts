import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { showBootError } from "./bootError";

it("reports Cox boot failures to Cox rather than upstream without leaking the report", async () => {
  using errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const shell = document.createElement("div");
  shell.id = "boot-shell";
  document.body.append(shell);
  try {
    showBootError(new Error("http://127.0.0.1:4773/failure?token=PRIVATE"));
    await expect.element(page.getByRole("heading", { name: "Cox failed to start" })).toBeVisible();
    const link = page.getByRole("link", { name: "Report an issue" }).element() as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/doublepi123/cox/issues/new");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.target).toBe("_blank");
    expect(shell.textContent).not.toContain("PRIVATE");
    expect(errorLog).toHaveBeenCalledOnce();
  } finally {
    shell.remove();
  }
});
