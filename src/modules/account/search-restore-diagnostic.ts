import type { Request, Response } from "express";
import { z } from "zod";

const diagnosticSchema = z.strictObject({
  stage: z.enum(["preferences", "sources", "profile", "jobs", "migration", "unknown"]),
  failureKind: z.enum(["auth", "timeout", "network", "format", "storage", "unknown"]),
});

const recentReports = new Map<string, { since: number; count: number }>();
const windowMs = 60_000;
const maxUsers = 1_000;
const maxReports = 3;

// shortcut: per-instance suppression resets on serverless cold starts; use shared limits if traffic grows.
function admitReport(userId: string, now: number): boolean {
  const previous = recentReports.get(userId);
  if (previous && now - previous.since < windowMs) {
    if (previous.count >= maxReports) return false;
    previous.count += 1;
    return true;
  }
  if (!previous && recentReports.size >= maxUsers) {
    const oldest = recentReports.keys().next().value;
    if (oldest !== undefined) recentReports.delete(oldest);
  }
  // Refresh insertion order so the bounded map evicts the least recent window.
  recentReports.delete(userId);
  recentReports.set(userId, { since: now, count: 1 });
  return true;
}

// Log an allow-listed classification without passing the request, exception or user data to a logger.
export function reportSearchRestoreFailure(request: Request, response: Response) {
  const userId = request.auth?.userId;
  if (!userId) return response.status(401).end();
  const parsed = diagnosticSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).end();
  if (admitReport(userId, Date.now())) {
    console.error(JSON.stringify({
      event: "search.restore.failed",
      userId,
      stage: parsed.data.stage,
      failureKind: parsed.data.failureKind,
    }));
  }
  // Workspace clients decode every successful response as a JSON envelope.
  return response.status(200).json({ data: null });
}
