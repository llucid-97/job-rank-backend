import mammoth from "mammoth";
import { checkDocxSize } from "./docx-limits.js";

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  if (mimeType === "text/plain") {
    return buffer.toString("utf8").trim();
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    checkDocxSize(buffer);
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  if (mimeType === "application/pdf") {
    try {
      // Keep the native dependency visible to serverless file tracing.
      await import("@napi-rs/canvas");
      const { PDFParse } = await import("pdf-parse");
      PDFParse.setWorker(import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"));
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text.trim();
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = /DOMMatrix|ImageData|Path2D/i.test(message) ? "canvas_globals"
        : /canvas|native binding/i.test(message) ? "canvas_binding"
        : /worker/i.test(message) ? "pdf_worker"
        : /module|package/i.test(message) ? "module_loading"
        : "other";
      console.error("PDF extraction failed", { reason, name: error instanceof Error ? error.name : "unknown" });
      throw error;
    }
  }

  throw new Error("Unsupported document type.");
}
