import { readFile, writeFile } from "node:fs/promises";

const inputPath = "/vercel/sandbox/input.pdf";
const outputPath = "/vercel/sandbox/output.txt";
const maxInputBytes = 15 * 1024 * 1024;
const maxOutputBytes = 4 * 1024 * 1024;

let parser;
try {
  const data = await readFile(inputPath);
  if (data.length === 0 || data.length > maxInputBytes || data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    process.stderr.write("PDF_INPUT_INVALID\n");
    process.exitCode = 2;
  } else {
    // Load the native canvas package before pdf-parse so PDF.js has its expected globals.
    await import("@napi-rs/canvas");
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"));
    parser = new PDFParse({ data, stopAtErrors: true });
    const result = await parser.getText();
    const text = result.text.trim();
    if (Buffer.byteLength(text, "utf8") > maxOutputBytes) {
      process.stderr.write("PDF_OUTPUT_LIMIT\n");
      process.exitCode = 3;
    } else {
      await writeFile(outputPath, text, "utf8");
    }
  }
} catch {
  // Never return parser diagnostics or document content through command logs.
  process.stderr.write("PDF_EXTRACTION_FAILED\n");
  process.exitCode = 1;
} finally {
  if (parser) await parser.destroy().catch(() => undefined);
}
