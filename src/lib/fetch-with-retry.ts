import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";

export const retryLog = pino({ name: "service-retry" });
// Tests replace timing only; production always uses the real clock and abortable sleep.
export const retryRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
};
export type RetryBoundary = "onboarding_ai" | "candidate_ai" | "ranking_ai" | "jobsdb";
export interface RetryOptions {
  boundary: RetryBoundary;
  safeToReplay?: boolean;
  retries?: number;
  totalTimeoutMs?: number;
  attemptTimeoutMs?: number;
  requestId?: number;
}
const retryStatuses = new Set([408, 429, 500, 502, 503, 504]);

// Provider-supplied delays cannot hold a user action open without a bounded deadline.
export function retryDelay(header: string | null, attempt: number): number {
  const seconds = header === null ? NaN : Number(header);
  const parsed = header === null
    ? NaN
    : Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - retryRuntime.now();
  const backoff = Math.min(4000, 250 * 2 ** (attempt - 1)) *
    (0.5 + retryRuntime.random() * 0.5);
  return Math.min(
    5000,
    Math.max(backoff, Number.isFinite(parsed) ? Math.max(0, parsed) : 0),
  );
}

// Only replayable transport requests retry; parsing and all later database writes run once.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<Response> {
  const safe = options.safeToReplay === true ||
    ["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
  const maxAttempts = safe
    ? 1 + Math.max(0, Math.min(10, Math.floor(options.retries ?? 3)))
    : 1;
  const totalMs = options.totalTimeoutMs ?? 60000;
  const deadline = retryRuntime.now() + totalMs;
  const totalSignal = AbortSignal.timeout(totalMs);
  const signal = init.signal ? AbortSignal.any([init.signal, totalSignal]) : totalSignal;
  // Caller cancellation stays silent; a spent operation budget emits only safe metadata.
  const throwIfStopped = (attempt: number, status?: number): void => {
    init.signal?.throwIfAborted();
    if (!totalSignal.aborted && retryRuntime.now() < deadline) return;
    retryLog.warn({
      event: "service.retry.deadline",
      boundary: options.boundary,
      request_id: options.requestId,
      attempt,
      max_attempts: maxAttempts,
      category: "timeout",
      status,
    }, "Service retry deadline reached");
    throw totalSignal.reason ??
      new DOMException("Service deadline reached", "TimeoutError");
  };
  // A single deadline covers attempts, response bodies, and every backoff wait.
  for (let attempt = 1; ; attempt++) {
    throwIfStopped(attempt);
    const remaining = deadline - retryRuntime.now();
    const attemptSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(
        Math.max(1, Math.min(options.attemptTimeoutMs ?? 20000, remaining)),
      ),
    ]);
    let response: Response | undefined;
    let failure: unknown;
    let category = "http";
    // Keep response reads inside the attempt budget, including transports that finish late.
    try {
      response = await fetch(url, { ...init, signal: attemptSignal });
      // Buffer within the deadline so interrupted bodies also belong to this attempt.
      const body = await response.arrayBuffer();
      response = new Response(body.byteLength ? body : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      init.signal?.throwIfAborted();
      attemptSignal.throwIfAborted();
      if (retryRuntime.now() >= deadline) {
        throw new DOMException("Service deadline reached", "TimeoutError");
      }
      if (!retryStatuses.has(response.status)) return response;
    } catch (error) {
      // Distinguish retryable attempt timeouts from caller cancellation and total expiry.
      throwIfStopped(attempt, response?.status);
      // Fetch body streams may report AbortError for an attempt timeout; preserve its cause.
      const timedOut = attemptSignal.aborted &&
        attemptSignal.reason instanceof Error &&
        attemptSignal.reason.name === "TimeoutError";
      failure = timedOut ? attemptSignal.reason : error;
      category = failure instanceof Error && failure.name === "TimeoutError"
        ? "timeout"
        : "network";
      if (
        !(failure instanceof TypeError) &&
        !(failure instanceof Error && failure.name === "TimeoutError")
      ) throw failure;
    }
    const metadata = {
      boundary: options.boundary,
      request_id: options.requestId,
      attempt,
      max_attempts: maxAttempts,
      category,
      status: response?.status,
    };
    if (attempt >= maxAttempts) {
      retryLog.warn(
        { event: "service.retry.exhausted", ...metadata },
        "Service attempts exhausted",
      );
      if (failure !== undefined) throw failure;
      return response!;
    }
    const delay = retryDelay(response?.headers.get("retry-after") ?? null, attempt);
    if (retryRuntime.now() + delay >= deadline) {
      retryLog.warn(
        { event: "service.retry.deadline", ...metadata },
        "Service retry deadline reached",
      );
      throw new DOMException("Service deadline reached", "TimeoutError");
    }
    retryLog.info(
      { event: "service.retry.scheduled", ...metadata, delay_ms: Math.round(delay) },
      "Retrying service request",
    );
    try {
      await retryRuntime.sleep(delay, signal);
    } catch (error) {
      throwIfStopped(attempt, response?.status);
      throw error;
    }
  }
}
