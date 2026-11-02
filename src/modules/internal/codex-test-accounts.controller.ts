import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";

const accountBatchSize = 25;
const storageBatchSize = 100;
const storageBuckets = ["candidate-documents", "candidate-document-staging"];

async function listOwnedObjects(bucket: string, userId: string, folder = userId): Promise<string[]> {
  // Only collect descendants of the UUID-owned folder so cleanup cannot cross accounts.
  if (folder !== userId && !folder.startsWith(`${userId}/`)) throw new Error("Storage prefix escaped account scope.");
  const paths: string[] = [];
  for (let offset = 0; ; offset += storageBatchSize) {
    const { data, error } = await supabaseAdmin.storage.from(bucket).list(folder, {
      limit: storageBatchSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    for (const item of data ?? []) {
      if (!item.name || item.name === "." || item.name === ".." || item.name.includes("/")) {
        throw new Error("Storage returned an invalid path component.");
      }
      const path = `${folder}/${item.name}`;
      if (item.id) paths.push(path);
      else paths.push(...await listOwnedObjects(bucket, userId, path));
    }
    if (!data || data.length < storageBatchSize) break;
  }
  return paths;
}

async function removeAccountObjects(bucket: string, userId: string): Promise<void> {
  // Listing completes before removal so pagination remains stable during each pass.
  const paths = await listOwnedObjects(bucket, userId);
  for (let offset = 0; offset < paths.length; offset += storageBatchSize) {
    const batch = paths.slice(offset, offset + storageBatchSize);
    if (batch.some(path => !path.startsWith(`${userId}/`))) throw new Error("Storage cleanup escaped account scope.");
    const { error } = await supabaseAdmin.storage.from(bucket).remove(batch);
    if (error) throw error;
  }
}

/** Enforce the exact expiry in API auth and clean only accounts explicitly marked by the service role. */
export async function cleanupExpiredCodexTestAccounts(request: Request, response: Response) {
  const secret = env.CRON_SECRET;
  if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
    return response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } });
  }

  const { data: accounts, error } = await supabaseAdmin
    .from("codex_test_accounts")
    .select("user_id,account_id,email,expires_at")
    .lte("expires_at", new Date().toISOString())
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .order("expires_at", { ascending: true })
    .limit(accountBatchSize);
  if (error) throw error;

  // Record the batch before external deletes so failed accounts rotate behind untouched rows.
  const accountIds = (accounts ?? []).map(account => account.user_id);
  if (accountIds.length > 0) {
    const { error: attemptError } = await supabaseAdmin
      .from("codex_test_accounts")
      .update({ last_attempt_at: new Date().toISOString() })
      .in("user_id", accountIds);
    if (attemptError) throw attemptError;
  }

  let removed = 0;
  let failed = 0;
  // Keep per-account failures isolated so one damaged storage prefix cannot block other expiry cleanup.
  for (const account of accounts ?? []) {
    try {
      const { data, error: userError } = await supabaseAdmin.auth.admin.getUserById(account.user_id);
      if (userError) throw userError;
      if (!data.user) {
        const { error: orphanError } = await supabaseAdmin.from("codex_test_accounts").delete().eq("user_id", account.user_id);
        if (orphanError) throw orphanError;
        removed += 1;
        continue;
      }
      const metadata = data.user.app_metadata;
      if (
        metadata?.codex_test_account !== true ||
        metadata?.codex_test_account_id !== account.account_id ||
        Date.parse(String(metadata?.codex_test_expires_at ?? "")) !== Date.parse(account.expires_at) ||
        data.user.email !== account.email ||
        !/^codex-test-agent-[0-9a-f]{32}@example\.invalid$/.test(account.email)
      ) {
        throw new Error("Account ownership marker did not match.");
      }
      for (const bucket of storageBuckets) await removeAccountObjects(bucket, account.user_id);
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(account.user_id);
      if (deleteError) throw deleteError;
      removed += 1;
    } catch {
      // Keep failed accounts queued; the next daily run retries without exposing identity data.
      failed += 1;
    }
  }

  const result = { examined: accounts?.length ?? 0, removed, failed };
  return response.status(failed ? 500 : 200).json(result);
}
