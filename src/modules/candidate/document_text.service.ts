import mammoth from "mammoth";
import { checkDocxSize, UnsafeDocumentError } from "./docx-limits.js";
import { PdfResourceLimitError } from "./pdf-resource-limit.js";
import { extractPdfTextInSandbox } from "./pdf-sandbox-extraction.service.js";

const pdfExtractionTimeoutMs = 15_000;

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  options: { extractPdf?: typeof extractPdfTextInSandbox } = {},
): Promise<string> {
  if (mimeType === "text/plain") {
    return buffer.toString("utf8").trim();
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    checkDocxSize(buffer);
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    } catch {
      throw new UnsafeDocumentError();
    }
  }

  if (mimeType === "application/pdf") {
    return (options.extractPdf ?? extractPdfTextInSandbox)(buffer);
  }

  throw new Error("Unsupported document type.");
}

/** Extract PDF text with bounded worker decode work and an invocation deadline. */
export async function extractPdfText(
  buffer: Buffer,
  timeoutMs = pdfExtractionTimeoutMs,
): Promise<string> {
  try {
    // Keep the native dependency visible to serverless file tracing.
    await import("@napi-rs/canvas");
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"));
    const parser = new PDFParse({ data: buffer, stopAtErrors: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        parser.getText(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new PdfResourceLimitError("PDF extraction timed out.")),
            timeoutMs,
          );
        }),
      ]);
      return result.text.trim();
    } finally {
      if (timeout) clearTimeout(timeout);
      // PDFParse.destroy terminates its worker, including a load still in flight.
      await parser.destroy();
    }
  } catch (error) {
    if (error instanceof PdfResourceLimitError) throw error;
    if (error instanceof Error && error.message.includes("JOBRANK_PDF_RESOURCE_LIMIT")) {
      throw new PdfResourceLimitError();
    }
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
