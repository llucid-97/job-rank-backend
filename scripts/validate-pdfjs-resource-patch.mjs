function count(source, anchor) {
  return source.split(anchor).length - 1;
}

function requireCount(source, anchor, expected, label) {
  const actual = count(source, anchor);
  if (actual !== expected) {
    throw new Error(`Expected ${expected} ${label} anchors, found ${actual}.`);
  }
}

export function validatePatchedWorker(worker) {
  const requiredAnchors = [
    ['import { inflateSync as jobRankInflateSync } from "node:zlib";', 1, "zlib import"],
    ['const JOBRANK_PDF_RESOURCE_LIMIT = "JOBRANK_PDF_RESOURCE_LIMIT";', 1, "resource marker"],
    ["const originalReadBlock = this.readBlock;", 1, "readBlock wrapper"],
    ["jobRankConsumePdfDecodedBytes(stream.bufferLength - before);", 1, "readBlock accounting"],
    ["requested > JOBRANK_PDF_MAX_STREAM_BYTES", 1, "stream-size guard"],
    ["Math.max(0, requested - this.bufferLength)", 1, "cumulative buffer guard"],
    ["jobRankInflateSync(bytes, { maxOutputLength: remaining })", 1, "bounded Flate decoder"],
    ['error.code === "ERR_BUFFER_TOO_LARGE"', 1, "Flate overflow mapping"],
    ["function jobRankAppendPdfTextItem(items, item)", 1, "text-item limiter"],
    ["jobRankAppendPdfTextItem(textContent.items, ", 6, "text-item hook"],
    ["textContent.items.push(", 0, "unbounded text-item push"],
  ];
  for (const [anchor, expected, label] of requiredAnchors) {
    requireCount(worker, anchor, expected, label);
  }
}

export function validatePatchedParser(parser) {
  const destroyHook = `    async destroy() {
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
  const loadingHook = `                const loadingTask = pdfjs.getDocument(this.options);
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
  requireCount(parser, destroyHook, 1, "PDFParse destroy hook");
  requireCount(parser, loadingHook, 1, "PDFParse loading-task hook");
  requireCount(parser, "await loadingTask.destroy();", 1, "in-flight task destroy");
}
