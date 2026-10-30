import { inflateRawSync } from "node:zlib";

// DOCX is a ZIP file. Limit actual inflated bytes before Mammoth reads its XML.
const maxEntryBytes = 8 * 1024 * 1024;
const maxArchiveBytes = 16 * 1024 * 1024;
const maxEntries = 1024;

export class UnsafeDocumentError extends Error {
  constructor() {
    super("The DOCX file is invalid or expands beyond the supported size.");
  }
}

/** A structurally valid DOCX whose expanded contents exceed parser budgets. */
export class DocxResourceLimitError extends Error {
  constructor() {
    super("The DOCX file expands beyond the supported size.");
    this.name = "DocxResourceLimitError";
  }
}

export function checkDocxSize(buffer: Buffer): void {
  try {
    // Find the ZIP end record, including its optional comment.
    let end = -1;
    for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
      if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
        end = offset;
        break;
      }
    }
    if (end < 0 || buffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), end + 4) !== -1 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new UnsafeDocumentError();
    const entries = buffer.readUInt16LE(end + 10);
    const directorySize = buffer.readUInt32LE(end + 12);
    const directoryOffset = buffer.readUInt32LE(end + 16);
    if (entries !== buffer.readUInt16LE(end + 8) || entries > maxEntries || entries === 0xffff ||
        directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryOffset + directorySize !== end) throw new UnsafeDocumentError();

    let position = directoryOffset;
    let total = 0;
    for (let index = 0; index < entries; index++) {
      if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new UnsafeDocumentError();
      const flags = buffer.readUInt16LE(position + 8);
      const method = buffer.readUInt16LE(position + 10);
      const compressed = buffer.readUInt32LE(position + 20);
      const declaredSize = buffer.readUInt32LE(position + 24);
      const nameSize = buffer.readUInt16LE(position + 28);
      const extraSize = buffer.readUInt16LE(position + 30);
      const commentSize = buffer.readUInt16LE(position + 32);
      const disk = buffer.readUInt16LE(position + 34);
      const local = buffer.readUInt32LE(position + 42);
      const next = position + 46 + nameSize + extraSize + commentSize;
      if (next > end || disk !== 0 || (flags & 1) !== 0 || (method !== 0 && method !== 8) ||
          compressed === 0xffffffff || declaredSize === 0xffffffff || local === 0xffffffff ||
          local + 30 > directoryOffset || buffer.readUInt32LE(local) !== 0x04034b50) throw new UnsafeDocumentError();
      if (declaredSize > maxEntryBytes || total + declaredSize > maxArchiveBytes) throw new DocxResourceLimitError();
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      if (start + compressed > directoryOffset) throw new UnsafeDocumentError();
      const data = buffer.subarray(start, start + compressed);
      // Declared lengths alone are attacker-controlled. Inflate with a hard cap.
      let expanded: Buffer;
      try {
        expanded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.min(maxEntryBytes, maxArchiveBytes - total) });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") throw new DocxResourceLimitError();
        throw new UnsafeDocumentError();
      }
      if (expanded.length > maxEntryBytes || total + expanded.length > maxArchiveBytes) throw new DocxResourceLimitError();
      if (expanded.length !== declaredSize) throw new UnsafeDocumentError();
      total += expanded.length;
      position = next;
    }
    if (position !== end) throw new UnsafeDocumentError();
  } catch (error) {
    if (error instanceof DocxResourceLimitError) throw error;
    throw new UnsafeDocumentError();
  }
}
