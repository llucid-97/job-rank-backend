import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/middleware/error-handling.js";
import { createCandidateDocumentDirectUploadHandler } from "../src/modules/candidate/candidate-document-direct-upload.js";

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  } as any;
}

function request() {
  return { auth: { userId: "00000000-0000-0000-0000-000000000001" } } as any;
}

test("denied upload admission returns Retry-After before parsing or extraction", async () => {
  const events: string[] = [];
  let extractionCalls = 0;
  const handler = createCandidateDocumentDirectUploadHandler({
    acquire: async () => { events.push("acquire"); return 17; },
    release: async () => { events.push("release"); return true; },
    parseMultipart: async () => { events.push("parse"); },
    upload: async () => { extractionCalls++; },
  });
  const res = response();
  const errors: unknown[] = [];

  await handler(request(), res, error => errors.push(error));

  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "17");
  assert.equal(res.body.error.code, "UPLOAD_RATE_LIMITED");
  assert.deepEqual(events, ["acquire"]);
  assert.equal(extractionCalls, 0);
  assert.deepEqual(errors, []);
});

test("admitted PDF body reaches the existing upload handler and releases after success", async () => {
  const events: string[] = [];
  let requestId = "";
  const handler = createCandidateDocumentDirectUploadHandler({
    acquire: async (_userId, id) => { requestId = id; events.push("acquire"); return 0; },
    release: async (_userId, id) => { events.push(`release:${id}`); return true; },
    parseMultipart: async req => {
      events.push("parse");
      req.file = { mimetype: "application/pdf", buffer: Buffer.from("%PDF-synthetic") } as any;
    },
    upload: async req => {
      events.push("upload");
      assert.equal(req.file.mimetype, "application/pdf");
    },
  });
  const errors: unknown[] = [];

  await handler(request(), response(), error => errors.push(error));

  assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(events, ["acquire", "parse", "upload", `release:${requestId}`]);
  assert.deepEqual(errors, []);
});

test("parser error, including an aborted multipart request, releases before error handling", async () => {
  const events: string[] = [];
  const abortError = new Error("Synthetic request aborted");
  const handler = createCandidateDocumentDirectUploadHandler({
    acquire: async () => { events.push("acquire"); return 0; },
    release: async () => { events.push("release"); return true; },
    parseMultipart: async () => { events.push("parse"); throw abortError; },
    upload: async () => { events.push("upload"); },
  });
  const errors: unknown[] = [];

  await handler(request(), response(), error => { events.push("next"); errors.push(error); });

  assert.deepEqual(events, ["acquire", "parse", "release", "next"]);
  assert.deepEqual(errors, [abortError]);
});

test("upload/extraction/storage failures release the lease before passing errors onward", async () => {
  const events: string[] = [];
  const uploadError = new Error("Synthetic upload failure");
  const handler = createCandidateDocumentDirectUploadHandler({
    acquire: async () => { events.push("acquire"); return 0; },
    release: async () => { events.push("release"); return true; },
    parseMultipart: async () => { events.push("parse"); },
    upload: async () => { events.push("upload"); throw uploadError; },
  });
  const errors: unknown[] = [];

  await handler(request(), response(), error => { events.push("next"); errors.push(error); });

  assert.deepEqual(events, ["acquire", "parse", "upload", "release", "next"]);
  assert.deepEqual(errors, [uploadError]);
});

test("admission RPC failure fails closed without parsing or releasing", async () => {
  const events: string[] = [];
  const handler = createCandidateDocumentDirectUploadHandler({
    acquire: async () => { events.push("acquire"); throw new AppError(503, "UPLOAD_ADMISSION_UNAVAILABLE", "Unable to check upload capacity."); },
    release: async () => { events.push("release"); return true; },
    parseMultipart: async () => { events.push("parse"); },
    upload: async () => { events.push("upload"); },
  });
  const errors: unknown[] = [];

  await handler(request(), response(), error => { events.push("next"); errors.push(error); });

  assert.deepEqual(events, ["acquire", "next"]);
  assert.ok(errors[0] instanceof AppError);
  assert.equal((errors[0] as AppError).statusCode, 503);
});
