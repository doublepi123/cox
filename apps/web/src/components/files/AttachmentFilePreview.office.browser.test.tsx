import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";

it.each([
  [
    new URL("../../../test/fixtures/file-passwords/locked.docx", import.meta.url),
    "docx",
    "Unlocked Word",
  ],
  [
    new URL("../../../test/fixtures/file-passwords/standard.docx", import.meta.url),
    "docx",
    "Unlocked Word",
  ],
  [
    new URL("../../../test/fixtures/file-passwords/locked.odt", import.meta.url),
    "odt",
    "Unlocked Writer",
  ],
  [
    new URL("../../../test/fixtures/file-passwords/locked.epub", import.meta.url),
    "epub",
    "Unlocked EPUB",
  ],
] as const)("opens the password-protected document at %s", async (src, kind, content) => {
  const blob = await fetch(src).then((response) => response.blob());
  const file = new File([blob], `locked.${kind}`, { type: "application/octet-stream" });
  await using screen = await render(
    <AttachmentFilePreview
      name={file.name}
      mimeType={file.type}
      file={file}
      sizeBytes={file.size}
    />,
  );
  const password = screen.getByLabelText("File password");
  await password.fill("wrong");
  await screen.getByRole("button", { name: "Unlock" }).click();
  await expect.element(screen.getByText("Incorrect password. Try again.")).toBeVisible();
  await password.fill("open me");
  await screen.getByRole("button", { name: "Unlock" }).click();
  if (kind === "docx") await expect.element(screen.getByText(content)).toBeVisible();
  else {
    await vi.waitFor(() => {
      const frame = screen.container.querySelector("iframe");
      expect(frame?.getAttribute("srcdoc")).toContain(content);
    });
  }
});
