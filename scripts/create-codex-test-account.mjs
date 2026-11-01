#!/usr/bin/env node
import "dotenv/config";
import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const label = process.argv[2] ?? "";
const command = process.argv[2] ?? "";
const existingUserId = process.argv[3] ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) {
  if (command !== "adopt" || !/^[0-9a-f-]{36}$/i.test(existingUserId)) {
    console.error("Usage: node scripts/create-codex-test-account.mjs <agent-label> | adopt <test-user-uuid>");
    process.exit(2);
  }
}
if (command === "adopt" && !/^[0-9a-f-]{36}$/i.test(existingUserId)) {
  console.error("Usage: node scripts/create-codex-test-account.mjs adopt <test-user-uuid>");
  process.exit(2);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY in the trusted backend environment.");
}

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

if (command === "adopt") {
  const { data, error } = await admin.auth.admin.getUserById(existingUserId);
  if (error || !data.user) throw new Error("The specified account could not be verified.");
  const metadata = data.user.app_metadata;
  const expiresAt = String(metadata?.codex_test_expires_at ?? "");
  if (
    metadata?.codex_test_account !== true ||
    !/^[0-9a-f-]{36}$/i.test(String(metadata?.codex_test_account_id ?? "")) ||
    !/^codex-test-agent-[0-9a-f]{32}@example\.invalid$/.test(data.user.email ?? "") ||
    !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now() + 7 * 24 * 60 * 60 * 1000
  ) throw new Error("The account is outside the Codex test-account namespace or expiry window.");
  const { data: current, error: readError } = await admin.from("codex_test_accounts")
    .select("account_id,email,expires_at").eq("user_id", existingUserId).maybeSingle();
  if (readError) throw readError;
  if (current) {
    if (current.account_id !== metadata.codex_test_account_id || current.email !== data.user.email || Date.parse(current.expires_at) !== Date.parse(expiresAt)) {
      throw new Error("The existing expiry record does not match trusted Auth metadata.");
    }
  } else {
    const { error: insertError } = await admin.from("codex_test_accounts").insert({
      user_id: existingUserId,
      account_id: metadata.codex_test_account_id,
      label: "adopted-agent-account",
      email: data.user.email,
      expires_at: expiresAt,
    });
    if (insertError) throw insertError;
  }
  console.log(JSON.stringify({ adopted: true, user_id: existingUserId, expires_at: expiresAt }));
  process.exit(0);
}

const accountId = randomUUID();
const email = `codex-test-agent-${randomBytes(16).toString("hex")}@example.invalid`;
const password = randomBytes(36).toString("base64url");
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
let createdUserId;
let credentialPath;

try {
  // Keep a new Auth identity out of circulation until its expiry marker and private queue row agree.
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Codex Test Agent" },
    app_metadata: {
      codex_test_account: true,
      codex_test_account_id: accountId,
      codex_test_label: label,
      codex_test_expires_at: expiresAt,
    },
  });
  if (error || !data.user) throw error ?? new Error("Auth did not return a user.");
  createdUserId = data.user.id;

  // The auth.users trigger inserts the cleanup record in this same transaction.
  const { data: queued, error: queueError } = await admin.from("codex_test_accounts")
    .select("account_id,email,expires_at").eq("user_id", createdUserId).maybeSingle();
  if (queueError || !queued || queued.account_id !== accountId || queued.email !== email || Date.parse(queued.expires_at) !== Date.parse(expiresAt)) {
    throw queueError ?? new Error("Auth account did not receive its matching expiry record.");
  }

  const directory = join(homedir(), ".codex", "jobrank-test-accounts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  credentialPath = join(directory, `${accountId}.json`);
  if (existsSync(credentialPath)) throw new Error("Credential file already exists.");
  writeFileSync(credentialPath, `${JSON.stringify({
    account_id: accountId,
    user_id: createdUserId,
    label,
    email,
    password,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(credentialPath, 0o600);
  console.log(JSON.stringify({ created: true, user_id: createdUserId, expires_at: expiresAt, credentials_path: credentialPath }));
} catch (error) {
  if (credentialPath && existsSync(credentialPath)) await import("node:fs/promises").then(({ unlink }) => unlink(credentialPath)).catch(() => undefined);
  if (createdUserId) {
    try {
      const { error: deleteError } = await admin.auth.admin.deleteUser(createdUserId);
      if (deleteError) throw deleteError;
    } catch (rollbackError) {
      console.error(JSON.stringify({ rollback_pending: true, user_id: createdUserId, error: rollbackError?.code ?? rollbackError?.name ?? "unknown" }));
    }
  }
  console.error(`Test-account creation failed: ${error?.code ?? error?.name ?? "unknown error"}`);
  process.exitCode = 1;
}
