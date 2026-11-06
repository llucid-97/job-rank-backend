// Audience: maintainers. Exercise the real authenticated workspace HTTP parser and save boundary.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { supabaseAdmin, supabaseAuth } from "../src/config/supabase.js";
import { app } from "../src/app.js";

test("workspace gzip transport reaches one authenticated atomic save and preserves legacy JSON", async () => {
  const originalFrom = supabaseAdmin.from;
  const originalRpc = supabaseAdmin.rpc;
  const originalGetUser = supabaseAuth.auth.getUser;
  const rpcCalls: Array<{ name: string; args: any }> = [];
  let server: ReturnType<typeof app.listen> | undefined;

  try {
    supabaseAuth.auth.getUser = (async (token: string) => ({
      data: { user: token === "synthetic-token" ? { id: "synthetic-owner", app_metadata: {} } : null },
      error: null,
    })) as any;
    supabaseAdmin.from = ((table: string) => {
      assert.equal(table, "user_entitlements");
      const query: any = {
        select: () => query,
        eq: (_column: string, userId: string) => { assert.equal(userId, "synthetic-owner"); return query; },
        maybeSingle: async () => ({ data: { account_status: "active" }, error: null }),
      };
      return query;
    }) as any;
    supabaseAdmin.rpc = (async (name: string, args: any) => {
      rpcCalls.push({ name, args: structuredClone(args) });
      return { data: { saved: true, count: args.p_jobs.length }, error: null };
    }) as any;

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const send = (body: Buffer, encoding: "gzip" | undefined, type = "application/json") => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const headers: Record<string, string> = {
        authorization: "Bearer synthetic-token",
        "content-type": type,
        "content-length": String(body.byteLength),
      };
      if (encoding) headers["content-encoding"] = encoding;
      const request = http.request({ hostname: "127.0.0.1", port, path: "/v1/jobs/workspace", method: "PUT", headers }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          status: response.statusCode!,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }));
      });
      request.on("error", reject);
      request.end(body);
    });

    // Repetitive Unicode text keeps the fixture deterministic while exceeding Vercel's raw JSON boundary.
    const raw = JSON.stringify({
      sourceSite: "configured",
      replace: false,
      refreshProviderContent: true,
      jobs: Array.from({ length: 30 }, (_, index) => ({
        id: `synthetic-job-${index}`,
        source: "jobicy",
        title: "Développeuse Δ",
        companyName: "Société Synthetic",
        location: "København",
        description: "界".repeat(60_000),
        url: `https://example.invalid/jobs/${index}`,
        applicationStatus: "Applied",
        isHidden: true,
        applicationNotes: "Chcę zachować notatkę — résumé 漢字",
        interviewsNeeded: "Two",
        otherData: { sourceNote: "naïve résumé 漢字" },
      })),
    });
    const rawBytes = Buffer.from(raw);
    const compressed = gzipSync(rawBytes);
    assert.ok(rawBytes.byteLength > 4.5 * 1024 * 1024);
    assert.ok(compressed.byteLength < 4 * 1024 * 1024);

    const compressedResponse = await send(compressed, "gzip");
    assert.equal(compressedResponse.status, 200);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].name, "save_job_workspace");
    assert.equal(rpcCalls[0].args.p_user_id, "synthetic-owner");
    assert.equal(rpcCalls[0].args.p_source, "configured");
    assert.equal(rpcCalls[0].args.p_replace, false);
    assert.equal(rpcCalls[0].args.p_refresh_provider_content, true);
    assert.equal(rpcCalls[0].args.p_jobs.length, 30);
    assert.equal(rpcCalls[0].args.p_jobs[0].description, "界".repeat(60_000));
    assert.equal(rpcCalls[0].args.p_jobs[0].applicationNotes, "Chcę zachować notatkę — résumé 漢字");
    assert.equal(rpcCalls[0].args.p_jobs[0].applicationStatus, "Applied");
    assert.equal(rpcCalls[0].args.p_jobs[0].databaseStatus, "applied");
    assert.equal(rpcCalls[0].args.p_jobs[0].isHidden, true);
    assert.deepEqual(rpcCalls[0].args.p_jobs[0].otherData, { sourceNote: "naïve résumé 漢字" });

    const legacy = Buffer.from(JSON.stringify({
      sourceSite: "configured",
      jobs: [{ id: "legacy-job", source: "jobicy", title: "Legacy", companyName: "Synthetic", location: "", description: "", url: "", applicationStatus: "Not Applied" }],
    }));
    assert.equal((await send(legacy, undefined)).status, 200);
    assert.equal(rpcCalls.length, 2);
    assert.equal(rpcCalls[1].args.p_replace, true);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAuth.auth.getUser = originalGetUser;
  }
});

test("workspace rejects encoded and inflated payloads and preflights gzip headers", async () => {
  const originalGetUser = supabaseAuth.auth.getUser;
  supabaseAuth.auth.getUser = (async () => ({ data: { user: null }, error: null })) as any;
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/v1/jobs/workspace`;
    const overEncoded = await fetch(base, {
      method: "PUT",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Buffer.alloc(4 * 1024 * 1024 + 1),
    });
    assert.equal(overEncoded.status, 413);

    const overInflated = await fetch(base, {
      method: "PUT",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(JSON.stringify({ description: "x".repeat(33 * 1024 * 1024) })),
    });
    assert.equal(overInflated.status, 413);

    const malformed = await fetch(base, {
      method: "PUT",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Buffer.from("not a gzip stream"),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_REQUEST_ENCODING");

    const preflight = await fetch(base, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:3001",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type,content-encoding,authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Content-Encoding/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    supabaseAuth.auth.getUser = originalGetUser;
  }
});
