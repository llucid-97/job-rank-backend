import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePatchedParser,
  validatePatchedWorker,
} from "./validate-pdfjs-resource-patch.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function readPackageVersion(relativePath) {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "node_modules", relativePath), "utf8"),
  );
  return packageJson.version;
}

function replaceExactly(source, before, after, label, expected = 1) {
  const count = source.split(before).length - 1;
  if (count !== expected) {
    throw new Error(`Expected ${expected} ${label} anchors, found ${count}.`);
  }
  return source.replaceAll(before, after);
}

const pdfjsVersion = await readPackageVersion("pdfjs-dist/package.json");
const pdfParseVersion = await readPackageVersion("pdf-parse/package.json");
if (pdfjsVersion !== "5.4.296" || pdfParseVersion !== "2.4.5") {
  throw new Error(
    `PDF resource patch expects pdfjs-dist 5.4.296 and pdf-parse 2.4.5; found ${pdfjsVersion} and ${pdfParseVersion}.`,
  );
}

const workerPath = path.join(
  repoRoot,
  "node_modules",
  "pdfjs-dist",
  "legacy",
  "build",
  "pdf.worker.mjs",
);
let worker = await readFile(workerPath, "utf8");
if (worker.includes("JOBRANK_PDF_RESOURCE_LIMIT")) {
  validatePatchedWorker(worker);
} else {
  worker = replaceExactly(
    worker,
    "/******/ var __webpack_modules__ = ({",
    'import { inflateSync as jobRankInflateSync } from "node:zlib";\n/******/ var __webpack_modules__ = ({',
    "PDF.js module entry",
  );

  const resourceHelpers = `const JOBRANK_PDF_RESOURCE_LIMIT = "JOBRANK_PDF_RESOURCE_LIMIT";
const JOBRANK_PDF_MAX_DECODED_BYTES = (() => {
  const hardLimit = 32 * 1024 * 1024;
  const requested = Number(process.env.JOBRANK_PDF_MAX_DECODED_BYTES);
  return Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, hardLimit)
    : hardLimit;
})();
const JOBRANK_PDF_MAX_STREAM_BYTES = 8 * 1024 * 1024;
const JOBRANK_PDF_MAX_TEXT_ITEMS = (() => {
  const hardLimit = 100_000;
  const requested = Number(process.env.JOBRANK_PDF_MAX_TEXT_ITEMS);
  return Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, hardLimit)
    : hardLimit;
})();
let jobRankPdfDecodedBytes = 0;
let jobRankPdfTextItemCount = 0;
function jobRankConsumePdfDecodedBytes(amount) {
  if (amount <= 0) return;
  if (amount > JOBRANK_PDF_MAX_DECODED_BYTES - jobRankPdfDecodedBytes) {
    throw new Error(JOBRANK_PDF_RESOURCE_LIMIT + ":decoded_bytes");
  }
  jobRankPdfDecodedBytes += amount;
}
function jobRankAppendPdfTextItem(items, item) {
  if (jobRankPdfTextItemCount >= JOBRANK_PDF_MAX_TEXT_ITEMS) {
    throw new Error(JOBRANK_PDF_RESOURCE_LIMIT + ":text_items");
  }
  jobRankPdfTextItemCount++;
  items.push(item);
}

class DecodeStream extends BaseStream {`;
  worker = replaceExactly(
    worker,
    "class DecodeStream extends BaseStream {",
    resourceHelpers,
    "DecodeStream class",
  );

  const constructorAnchor = `      while (this.minBufferLength < maybeMinBufferLength) {
        this.minBufferLength *= 2;
      }
    }
  }
  get isEmpty() {`;
  const constructorPatched = `      while (this.minBufferLength < maybeMinBufferLength) {
        this.minBufferLength *= 2;
      }
    }
    const originalReadBlock = this.readBlock;
    if (typeof originalReadBlock === "function") {
      const stream = this;
      this.readBlock = function (...args) {
        const before = stream.bufferLength;
        try {
          return originalReadBlock.apply(stream, args);
        } finally {
          jobRankConsumePdfDecodedBytes(stream.bufferLength - before);
        }
      };
    }
  }
  get isEmpty() {`;
  worker = replaceExactly(
    worker,
    constructorAnchor,
    constructorPatched,
    "DecodeStream readBlock accounting",
  );

  const ensureAnchor = `  ensureBuffer(requested) {
    const buffer = this.buffer;
    if (requested <= buffer.byteLength) {`;
  const ensurePatched = `  ensureBuffer(requested) {
    if (
      requested > JOBRANK_PDF_MAX_STREAM_BYTES ||
      Math.max(0, requested - this.bufferLength) >
        JOBRANK_PDF_MAX_DECODED_BYTES - jobRankPdfDecodedBytes
    ) {
      throw new Error(JOBRANK_PDF_RESOURCE_LIMIT + ":stream_buffer");
    }
    const buffer = this.buffer;
    if (requested <= buffer.byteLength) {`;
  worker = replaceExactly(worker, ensureAnchor, ensurePatched, "DecodeStream buffer guard");

  const flateAnchor = `  async asyncGetBytes() {
    this.str.reset();
    const bytes = this.str.getBytes();
    try {
      const {
        readable,
        writable
      } = new DecompressionStream("deflate");
      const writer = writable.getWriter();
      await writer.ready;
      writer.write(bytes).then(async () => {
        await writer.ready;
        await writer.close();
      }).catch(() => {});
      const chunks = [];
      let totalLength = 0;
      for await (const chunk of readable) {
        chunks.push(chunk);
        totalLength += chunk.byteLength;
      }
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return data;
    } catch {
      this.str = new Stream(bytes, 2, bytes.length, this.str.dict);
      this.reset();
      return null;
    }
  }`;
  const flatePatched = `  async asyncGetBytes() {
    this.str.reset();
    const bytes = this.str.getBytes();
    const remaining = JOBRANK_PDF_MAX_DECODED_BYTES - jobRankPdfDecodedBytes;
    if (remaining <= 0) {
      throw new Error(JOBRANK_PDF_RESOURCE_LIMIT + ":decoded_bytes");
    }
    try {
      const data = jobRankInflateSync(bytes, { maxOutputLength: remaining });
      jobRankConsumePdfDecodedBytes(data.byteLength);
      return data;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(JOBRANK_PDF_RESOURCE_LIMIT + ":decoded_bytes");
      }
      this.str = new Stream(bytes, 2, bytes.length, this.str.dict);
      this.reset();
      return null;
    }
  }`;
  worker = replaceExactly(worker, flateAnchor, flatePatched, "Flate decoder guard");
  worker = replaceExactly(
    worker,
    "textContent.items.push(",
    "jobRankAppendPdfTextItem(textContent.items, ",
    "text item guard",
    6,
  );
}
await writeFile(workerPath, worker);

const parsePath = path.join(
  repoRoot,
  "node_modules",
  "pdf-parse",
  "dist",
  "pdf-parse",
  "esm",
  "PDFParse.js",
);
let parser = await readFile(parsePath, "utf8");
if (parser.includes("jobRankLoadingTask")) {
  validatePatchedParser(parser);
} else {
  const destroyBefore = `    async destroy() {
        if (this.doc) {
            await this.doc.destroy();
            this.doc = undefined;
        }
    }`;
  const destroyAfter = `    async destroy() {
        if (this.doc) {
            const doc = this.doc;
            this.doc = undefined;
            this.jobRankLoadingTask = undefined;
            await doc.destroy();
        }
        else if (this.jobRankLoadingTask) {
            const loadingTask = this.jobRankLoadingTask;
            this.jobRankLoadingTask = undefined;
            await loadingTask.destroy();
        }
    }`;
  parser = replaceExactly(parser, destroyBefore, destroyAfter, "PDFParse destroy hook");

  const loadBefore = `                const loadingTask = pdfjs.getDocument(this.options);
                loadingTask.onProgress = (progress) => {
                    this.progress = progress;
                };
                this.doc = await loadingTask.promise;`;
  const loadAfter = `                const loadingTask = pdfjs.getDocument(this.options);
                this.jobRankLoadingTask = loadingTask;
                loadingTask.onProgress = (progress) => {
                    this.progress = progress;
                };
                try {
                    this.doc = await loadingTask.promise;
                }
                finally {
                    if (this.jobRankLoadingTask === loadingTask) {
                        this.jobRankLoadingTask = undefined;
                    }
                }`;
  parser = replaceExactly(parser, loadBefore, loadAfter, "PDFParse loading-task hook");
}
await writeFile(parsePath, parser);

process.stdout.write("Applied bounded PDF worker patch for pdf-parse 2.4.5 / pdfjs-dist 5.4.296.\n");
