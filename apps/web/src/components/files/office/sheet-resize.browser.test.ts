import JSZip from "jszip";
import { expect, it } from "vite-plus/test";
import type { SheetMethods } from "./sheet-protocol";
import { createWorkerClient } from "./worker-rpc";

it.each([false, true])(
  "draws text from cells scrolled out before the frame, frozen: %s",
  async (frozen) => {
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sample" sheetId="1" r:id="sheet"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    archive.file(
      "xl/styles.xml",
      '<styleSheet><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf/><xf applyAlignment="1"><alignment vertical="center"/></xf></cellXfs></styleSheet>',
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet>${frozen ? '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" state="frozen" topLeftCell="B2"/></sheetView></sheetViews>' : ""}<sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>${"M".repeat(60)}</t></is></c></row><row r="4"><c r="C4" t="inlineStr" s="1"><is><t>MMMM</t></is></c></row></sheetData><mergeCells><mergeCell ref="C4:C40"/></mergeCells></worksheet>`,
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const client = createWorkerClient<SheetMethods>(
      new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" }),
    );
    const inked = async (
      at: { x: number; y: number },
      area: { x: number; y: number; width: number; height: number },
    ) => {
      const frame = await client.call("frame", {
        sheet: 0,
        ...at,
        width: 400,
        height: 300,
        ratio: 1,
        offset: { x: 0, y: 0 },
        wider: undefined,
      });
      const canvas = new OffscreenCanvas(frame!.bitmap.width, frame!.bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(frame!.bitmap, 0, 0);
      frame!.bitmap.close();
      const pixels = context.getImageData(area.x, area.y, area.width, area.height).data;
      return pixels.some(
        (value, index) => index % 4 === 0 && value < 128 && pixels[index + 3]! > 0,
      );
    };
    try {
      await client.call("open", {
        bytes,
      });
      // B2's text overflows to the right well past B, and the merge centres C4's text far below row 4.
      const panes = frozen ? { x: 64, y: 20 } : { x: 0, y: 0 };
      expect(
        await inked({ x: 160, y: 0 }, { x: panes.x + 40, y: 20, width: 200, height: 20 }),
      ).toBe(true);
      expect(await inked({ x: 0, y: 200 }, { x: 128, y: 200, width: 64, height: 80 })).toBe(true);
    } finally {
      client.close();
    }
  },
);
