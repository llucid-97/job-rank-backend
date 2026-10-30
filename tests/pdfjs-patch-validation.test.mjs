import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  validatePatchedParser,
  validatePatchedWorker,
} from "../scripts/validate-pdfjs-resource-patch.mjs";

const workerPath = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
);
const parserPath = new URL(
  "../node_modules/pdf-parse/dist/pdf-parse/esm/PDFParse.js",
  import.meta.url,
);

test("postinstall accepts complete patched PDF.js and pdf-parse bundles", async () => {
  const [worker, parser] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(parserPath, "utf8"),
  ]);

  assert.doesNotThrow(() => validatePatchedWorker(worker));
  assert.doesNotThrow(() => validatePatchedParser(parser));
});

test("postinstall rejects partial resource and lifecycle patches", async () => {
  const [worker, parser] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(parserPath, "utf8"),
  ]);

  assert.throws(
    () => validatePatchedWorker(worker.replace("requested > JOBRANK_PDF_MAX_STREAM_BYTES", "requested > 0")),
    /stream-size guard/,
  );
  assert.throws(
    () => validatePatchedWorker(worker.replace("jobRankAppendPdfTextItem(textContent.items, ", "textContent.items.push(")),
    /text-item hook/,
  );
  assert.throws(
    () => validatePatchedParser(parser.replace("await loadingTask.destroy();", "await Promise.resolve();")),
    /PDFParse destroy hook/,
  );
});
