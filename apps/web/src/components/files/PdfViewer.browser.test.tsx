import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "~/index.css";

// Vite serves the worker module through its transform with an inline source map (6.8 MB for
// a 1.3 MB file), which dominated this test under CPU contention. A blob of the raw file is the
// same code without the dev-server cost.
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

import PdfViewer from "./PdfViewer";

// Page 1 is a short banner whose title is drawn in two runs with a font change, so pdf.js
// splits it into two text spans. Page 2 is a letter page rotated a quarter turn.
function testPdf(
  pages: { box: string; rotate: number; text: string; annots?: string }[] = [
    {
      box: "0 0 612 140",
      rotate: 0,
      text: "BT /F1 24 Tf 30 70 Td (Quarter) Tj /F2 24 Tf (ly outlook) Tj ET",
    },
    { box: "0 0 612 792", rotate: 90, text: "BT /F1 24 Tf 30 700 Td (Budget and risks) Tj ET" },
  ],
) {
  const fonts = 3 + pages.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`,
    ...pages.flatMap(({ box, rotate, text, annots = "" }, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Rotate ${rotate}${annots && ` /Annots [${annots}]`} /Resources << /Font << /F1 ${fonts} 0 R /F2 ${fonts + 1} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: "application/pdf" });
}

it("fits the width, then finds split and rotated text and jumps to its page", async () => {
  const url = URL.createObjectURL(testPdf());
  try {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:500px;height:600px";
    await using screen = await render(<PdfViewer src={url} title="Planning PDF" />, {
      container,
    });
    // The milestone is pdf.js booting its worker and parsing the document, not a frame count.
    await expect.element(screen.getByText("1 / 2 pages"), { timeout: 10_000 }).toBeVisible();
    const region = screen.container.querySelector<HTMLElement>('[role="region"]')!;
    // Fit width follows the measured viewport, which settles once the scrollbar appears.
    await vi.waitFor(() => {
      const canvas = region.querySelector('canvas[aria-label="Page 1"]')!;
      expect(canvas.getBoundingClientRect().width).toBe(region.clientWidth - 32);
      expect(region.scrollWidth).toBe(region.clientWidth);
    });

    const find = screen.getByRole("searchbox", { name: "Find in PDF" });
    await find.fill("quarterly outlook");
    await expect.element(screen.getByRole("status")).toHaveTextContent("1/1");
    await vi.waitFor(() =>
      expect(
        Array.from(region.querySelectorAll(".pdf-find-match"), (span) => span.textContent),
      ).toEqual(["Quarter", "ly outlook"]),
    );

    await find.fill("budget");
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveTextContent("1/1");
    const rotated = await vi.waitFor(() => {
      const span = Array.from(region.querySelectorAll("[data-pdf-text-layer] span")).find(
        (node) => node.textContent === "Budget and risks",
      );
      expect(span).toBeDefined();
      return span!;
    });
    // The rotated page's text runs top to bottom inside the page, so a selection lands on it.
    const textBounds = rotated.getBoundingClientRect();
    const pageBounds = rotated.closest("[data-pdf-text-layer]")!.getBoundingClientRect();
    expect(textBounds.height).toBeGreaterThan(textBounds.width);
    expect(textBounds.width).toBeGreaterThan(0);
    expect(textBounds.left).toBeGreaterThanOrEqual(pageBounds.left - 1);
    expect(textBounds.top).toBeGreaterThanOrEqual(pageBounds.top - 1);
    expect(textBounds.right).toBeLessThanOrEqual(pageBounds.right + 1);
    expect(textBounds.bottom).toBeLessThanOrEqual(pageBounds.bottom + 1);
    expect(getComputedStyle(rotated).userSelect).toBe("text");
    const range = document.createRange();
    range.selectNodeContents(rotated);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("Budget and risks");
    selection.removeAllRanges();

    await find.fill(" ");
    await expect.element(screen.getByRole("status")).toHaveTextContent("0/0");
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("follows a link to another page and exposes a web link", async () => {
  const url = URL.createObjectURL(
    testPdf([
      {
        box: "0 0 612 792",
        rotate: 0,
        text: "BT /F1 24 Tf 30 700 Td (See p. 2) Tj 0 -60 Td (Website) Tj ET",
        annots: [
          "<< /Type /Annot /Subtype /Link /Rect [30 690 200 730] /Border [0 0 0] /Dest [5 0 R /XYZ 0 792 0] >>",
          "<< /Type /Annot /Subtype /Link /Rect [30 630 200 670] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>",
        ].join(" "),
      },
      { box: "0 0 612 792", rotate: 0, text: "BT /F1 24 Tf 30 700 Td (Target) Tj ET" },
    ]),
  );
  try {
    await using screen = await render(
      <div className="flex h-[300px] w-[320px]">
        <PdfViewer src={url} title="Linked PDF" />
      </div>,
    );
    await expect.element(screen.getByText("1 / 2 pages")).toBeVisible();
    const region = screen.getByRole("region", { name: "Linked PDF" }).element();
    const web = await vi.waitFor(() => {
      const link = region.querySelector<HTMLAnchorElement>('a[href="https://example.com/"]');
      expect(link).not.toBeNull();
      return link!;
    });
    expect(getComputedStyle(web).cursor).toBe("pointer");
    const internal = await vi.waitFor(() => {
      const link = Array.from(region.querySelectorAll<HTMLAnchorElement>("a")).find(
        (anchor) => anchor !== web,
      );
      expect(link).toBeDefined();
      return link!;
    });
    internal.click();
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
  } finally {
    URL.revokeObjectURL(url);
  }
});
