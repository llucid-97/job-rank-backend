import type { Sandbox } from "@vercel/sandbox";
import { env } from "../../config/env.js";
import { PdfResourceLimitError } from "./pdf-resource-limit.js";
import { PdfExtractionError } from "./pdf-extraction-error.js";

const sandboxTimeoutMs = 45_000;
const maxInputBytes = 15 * 1024 * 1024;
const maxOutputBytes = 4 * 1024 * 1024;
const inputPath = "/vercel/sandbox/input.pdf";
const outputPath = "/vercel/sandbox/output.txt";
const extractorPath = "/vercel/sandbox/pdf-worker/extract.mjs";

type SandboxHandle = Pick<Sandbox, "writeFiles" | "runCommand" | "readFile" | "delete">;
type SandboxCreateOptions = Parameters<typeof Sandbox.create>[0];
type SandboxFactory = (options: SandboxCreateOptions) => Promise<SandboxHandle>;

export class PdfSandboxConfigurationError extends Error {
  constructor(message = "PDF sandbox extraction is not configured.") {
    super(message);
    this.name = "PdfSandboxConfigurationError";
  }
}

/** Parse a PDF in an isolated, short-lived Vercel microVM. */
export async function extractPdfTextInSandbox(
  buffer: Buffer,
  options: { snapshotId?: string; createSandbox?: SandboxFactory } = {},
): Promise<string> {
  const snapshotId = options.snapshotId ?? env.PDF_SANDBOX_SNAPSHOT_ID;
  if (!snapshotId) throw new PdfSandboxConfigurationError();
  if (buffer.length === 0 || buffer.length > maxInputBytes) {
    throw new PdfResourceLimitError("The PDF exceeds supported extraction limits.");
  }

  const createSandbox = options.createSandbox ?? (async createOptions => {
    const { Sandbox: VercelSandbox } = await import("@vercel/sandbox");
    return VercelSandbox.create(createOptions);
  });

  let sandbox: SandboxHandle | undefined;
  try {
    sandbox = await createSandbox({
      source: { type: "snapshot", snapshotId },
      resources: { vcpus: 1 },
      timeout: sandboxTimeoutMs,
      networkPolicy: "deny-all",
      persistent: false,
    });
    await sandbox.writeFiles([{ path: inputPath, content: buffer }]);

    let command: Awaited<ReturnType<SandboxHandle["runCommand"]>>;
    try {
      command = await sandbox.runCommand({ cmd: "node", args: [extractorPath] });
    } catch (error) {
      if (isSandboxResourceTermination(error)) {
        throw new PdfResourceLimitError("PDF extraction exceeded the sandbox time or memory limit.");
      }
      throw error;
    }
    if (command.exitCode === 3 || isResourceExitCode(command.exitCode)) {
      throw new PdfResourceLimitError("The PDF could not be safely extracted within the sandbox limits.");
    }
    if (command.exitCode === 2) {
      throw new PdfExtractionError("The uploaded file is not a valid, supported PDF.");
    }
    if (command.exitCode !== 0) throw new PdfExtractionError("The PDF could not be parsed.");

    const output = await sandbox.readFile({ path: outputPath });
    if (!output) throw new Error("PDF sandbox returned no extracted text.");

    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of output) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
      byteLength += bytes.length;
      if (byteLength > maxOutputBytes) {
        throw new PdfResourceLimitError("The extracted document is too large to save.");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, byteLength).toString("utf8").trim();
  } finally {
    if (sandbox) await sandbox.delete();
  }
}

function isResourceExitCode(exitCode: number | null): boolean {
  return exitCode === 124 || exitCode === 137 || exitCode === 143;
}

function isSandboxResourceTermination(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timed?\s*out|timeout|deadline|out of memory|oom|memory limit|resource limit)/i.test(message);
}
