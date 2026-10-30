import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { PdfResourceLimitError } from "../src/modules/candidate/pdf-resource-limit.js";
import {
  extractPdfTextInSandbox,
  PdfSandboxConfigurationError,
} from "../src/modules/candidate/pdf-sandbox-extraction.service.js";

const input = Buffer.from("%PDF-1.7 fixture");

function fakeSandbox(output: Buffer, exitCode = 0) {
  const calls: { writes?: unknown; run?: unknown; deleted: boolean } = { deleted: false };
  const sandbox = {
    async writeFiles(files: unknown) { calls.writes = files; },
    async runCommand(params: unknown) {
      calls.run = params;
      return { exitCode };
    },
    async readFile() { return Readable.from([output]); },
    async delete() { calls.deleted = true; },
  };
  return { calls, sandbox };
}

test("PDF sandbox extraction fails closed without a snapshot ID", async () => {
  let created = false;
  await assert.rejects(
    extractPdfTextInSandbox(input, {
      snapshotId: "",
      createSandbox: async () => {
        created = true;
        throw new Error("must not create a sandbox");
      },
    }),
    PdfSandboxConfigurationError,
  );
  assert.equal(created, false);
});

test("PDF extraction creates an isolated throwaway sandbox and returns bounded text", async () => {
  const { calls, sandbox } = fakeSandbox(Buffer.from("Extracted CV text\n"));
  let createOptions: unknown;
  const text = await extractPdfTextInSandbox(input, {
    snapshotId: "snap_parser_only",
    createSandbox: async options => {
      createOptions = options;
      return sandbox as never;
    },
  });

  assert.equal(text, "Extracted CV text");
  assert.deepEqual(createOptions, {
    source: { type: "snapshot", snapshotId: "snap_parser_only" },
    resources: { vcpus: 1 },
    timeout: 45_000,
    networkPolicy: "deny-all",
    persistent: false,
  });
  assert.deepEqual(calls.writes, [{ path: "/vercel/sandbox/input.pdf", content: input }]);
  assert.deepEqual(calls.run, { cmd: "node", args: ["/vercel/sandbox/pdf-worker/extract.mjs"] });
  assert.equal(calls.deleted, true);
});

test("PDF sandbox command failures map to resource rejection and still delete the sandbox", async () => {
  const { calls, sandbox } = fakeSandbox(Buffer.alloc(0), 137);
  await assert.rejects(
    extractPdfTextInSandbox(input, {
      snapshotId: "snap_parser_only",
      createSandbox: async () => sandbox as never,
    }),
    PdfResourceLimitError,
  );
  assert.equal(calls.deleted, true);
});

test("oversized sandbox output is rejected while streamed and still deleted", async () => {
  const { calls, sandbox } = fakeSandbox(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  await assert.rejects(
    extractPdfTextInSandbox(input, {
      snapshotId: "snap_parser_only",
      createSandbox: async () => sandbox as never,
    }),
    PdfResourceLimitError,
  );
  assert.equal(calls.deleted, true);
});
