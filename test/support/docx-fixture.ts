// A minimal .docx, built with jszip for the DOCX extraction tests: the three parts a WordprocessingML
// package needs to be read, the content types, the package relationship to the main document, and
// that document with one paragraph per string. The zip starts with a local file header (PK\3\4), the
// magic bytes the upload plan sniffs.

import JSZip from "jszip";

/** Every part gets this date, so the same paragraphs always give the same bytes. */
const FIXED_DATE = new Date("2026-10-19T12:00:00Z");

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** A .docx whose body is one paragraph (`<w:p>`) per string, in order. */
export async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join("\n");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
</w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES, { date: FIXED_DATE });
  zip.file("_rels/.rels", PACKAGE_RELS, { date: FIXED_DATE });
  zip.file("word/document.xml", document, { date: FIXED_DATE });
  return zip.generateAsync({ type: "uint8array" });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
