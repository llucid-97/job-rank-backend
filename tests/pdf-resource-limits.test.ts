import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { extractPdfText } from "../src/modules/candidate/document_text.service.js";

function makePdf(contentStreams: Buffer[], filter = "/FlateDecode"): Buffer {
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Resources << /Font << /F1 ${contentStreams.length + 4} 0 R >> >> /Contents [${contentStreams.map((_, i) => `${i + 4} 0 R`).join(" ")}] >>`,
    ),
    ...contentStreams.map((stream) =>
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} /Filter ${filter} >>\nstream\n`),
        stream,
        Buffer.from("\nendstream"),
      ]),
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let position = chunks[0]!.length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(position);
    const object = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      objects[i]!,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(object);
    position += object.length;
  }
  const xrefStart = position;
  const xref = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const offset of offsets.slice(1)) {
    xref.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  xref.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  chunks.push(Buffer.from(xref.join("")));
  return Buffer.concat(chunks);
}

function textStream(charCount: number): Buffer {
  return deflateSync(
    Buffer.from(`BT /F1 12 Tf (${"A".repeat(charCount)}) Tj ET\n`, "ascii"),
  );
}

function runLengthEncode(bytes: Buffer): Buffer {
  const encoded: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 128) {
    const chunk = bytes.subarray(offset, offset + 128);
    encoded.push(chunk.length - 1, ...chunk);
  }
  encoded.push(128);
  return Buffer.from(encoded);
}

function runLengthTextStream(charCount: number): Buffer {
  return runLengthEncode(
    Buffer.from(`BT /F1 12 Tf (${"A".repeat(charCount)}) Tj ET\n`, "ascii"),
  );
}

function manyItemStream(itemCount: number): Buffer {
  const operators = Array.from(
    { length: itemCount },
    (_, index) => `BT /F1 12 Tf 1 0 0 1 ${index % 1000} ${Math.floor(index / 1000)} Tm (A) Tj ET\n`,
  ).join("");
  return deflateSync(Buffer.from(operators, "ascii"));
}

test("PDF extraction accepts bounded documents and resets budget per document", async () => {
  process.env.JOBRANK_PDF_MAX_DECODED_BYTES = String(2 * 1024 * 1024);
  process.env.JOBRANK_PDF_MAX_TEXT_ITEMS = "100000";
  const first = makePdf([textStream(500_000)]);
  const second = makePdf([textStream(500_000)]);

  assert.ok((await extractPdfText(first, 10_000)).length > 0);
  assert.ok((await extractPdfText(second, 10_000)).length > 0);
});

test("PDF extraction rejects cumulative Flate output before crossing the document budget", async () => {
  process.env.JOBRANK_PDF_MAX_DECODED_BYTES = String(2 * 1024 * 1024);
  process.env.JOBRANK_PDF_MAX_TEXT_ITEMS = "100000";
  const pdf = makePdf([textStream(1_200_000), textStream(1_200_000)]);

  await assert.rejects(extractPdfText(pdf, 10_000), /PDF exceeds supported extraction limits/);
});

test("PDF extraction applies cumulative decoded-byte accounting to non-Flate streams", async () => {
  process.env.JOBRANK_PDF_MAX_DECODED_BYTES = String(2 * 1024 * 1024);
  process.env.JOBRANK_PDF_MAX_TEXT_ITEMS = "100000";
  const pdf = makePdf(
    [runLengthTextStream(1_200_000), runLengthTextStream(1_200_000)],
    "/RunLengthDecode",
  );

  await assert.rejects(extractPdfText(pdf, 10_000), /PDF exceeds supported extraction limits/);
});

test("PDF extraction caps TextContent item amplification", async () => {
  process.env.JOBRANK_PDF_MAX_DECODED_BYTES = String(2 * 1024 * 1024);
  process.env.JOBRANK_PDF_MAX_TEXT_ITEMS = "2000";
  const pdf = makePdf([manyItemStream(2500)]);

  await assert.rejects(extractPdfText(pdf, 10_000), /PDF exceeds supported extraction limits/);
});

