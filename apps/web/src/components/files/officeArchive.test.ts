import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { prepareOffice } from "./officeArchive";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const V = 'xmlns:v="urn:schemas-microsoft-com:vml"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = (type: string, target: string) =>
  `<Relationship Id="${type}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const paragraph = (text: string, properties = "") =>
  `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function wordFile(
  body: string,
  parts: Partial<Record<"styles" | "numbering" | "header" | "footer" | "footnotes", string>> = {},
  section = "",
  extraRels = "",
) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("officeDocument", "word/document.xml")}</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.keys(
      parts,
    )
      .map((part) => relationship(part, `${part}.xml`))
      .join("")}${extraRels}</Relationships>`,
  );
  for (const [part, xml] of Object.entries(parts)) zip.file(`word/${part}.xml`, xml);
  zip.file(
    "word/document.xml",
    `<w:document ${W} ${V} ${R}><w:body>${body}<w:sectPr>${section}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

async function prepared(bytes: ArrayBuffer) {
  const result = await prepareOffice(bytes, "docx");
  const zip = await JSZip.loadAsync(result.bytes);
  return { truncated: result.truncated, part: (path: string) => zip.file(path)?.async("string") };
}

describe("Word preview relationships", () => {
  it("drops a malformed external hyperlink relationship while keeping body text", async () => {
    const result = await prepared(
      await wordFile(
        paragraph("Body text"),
        {},
        "",
        `<Relationship Id="badLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://[placeholder]/" TargetMode="External"/>`,
      ),
    );
    expect(result.truncated).toBe(false);
    expect(await result.part("word/document.xml")).toContain("Body text");
    expect(await result.part("word/_rels/document.xml.rels")).not.toContain("badLink");
  });
});

async function workbookFile(
  target: string,
  sheetPath: string,
  extraRels = "",
  targetMode = "Internal",
  sheetData = `<row r="1"><c r="A1"><v>42</v></c></row>`,
) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("officeDocument", "xl/workbook.xml")}</Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}><sheets><sheet name="Sample" sheetId="1" r:id="sheet"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}" TargetMode="${targetMode}"/>${extraRels}</Relationships>`,
  );
  zip.file(
    sheetPath,
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("Workbook relationship targets", () => {
  it.each(["sheet 1.xml", "sheet%201.xml", "sheet#1.xml"])(
    "prepares a worksheet whose ZIP name matches its target literally (%s)",
    async (name) => {
      const result = await prepareOffice(
        await workbookFile(`worksheets/${name}`, `xl/worksheets/${name}`),
        "xlsx",
      );
      const zip = await JSZip.loadAsync(result.bytes);
      expect(result.truncated).toBe(false);
      expect(await zip.file(`xl/worksheets/${name}`)?.async("string")).toContain("42");
    },
  );

  it("refuses a worksheet whose relationship is external", async () => {
    await expect(
      prepareOffice(
        await workbookFile("worksheets/sheet2.xml", "xl/worksheets/sheet2.xml", "", "External"),
        "xlsx",
      ),
    ).rejects.toThrow("invalid or too many sheets");
  });

  it("handles a malformed external relationship in workbook relationships", async () => {
    const result = await prepareOffice(
      await workbookFile(
        "worksheets/sheet1.xml",
        "xl/worksheets/sheet1.xml",
        `<Relationship Id="ext" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="http://[placeholder]/" TargetMode="External"/>`,
      ),
      "xlsx",
    );
    const zip = await JSZip.loadAsync(result.bytes);
    expect(result.truncated).toBe(false);
    expect(await zip.file("xl/worksheets/sheet1.xml")?.async("string")).toContain("42");
  });
});

describe("Workbook preview limits", () => {
  it("does not split a surrogate pair when truncating cell text", async () => {
    const prefix = "a".repeat(4095);
    const result = await prepareOffice(
      await workbookFile(
        "worksheets/sheet1.xml",
        "xl/worksheets/sheet1.xml",
        "",
        "Internal",
        `<row r="1"><c r="A1" t="inlineStr"><is><t>${prefix}🚀tail</t></is></c></row>`,
      ),
      "xlsx",
    );
    const zip = await JSZip.loadAsync(result.bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    expect(result.truncated).toBe(true);
    expect(sheet).toContain(`<t>${prefix}</t>`);
    expect(sheet).not.toContain("\ufffd");
  });
});
