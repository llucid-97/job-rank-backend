import pino from "pino";
import { ZodError } from "zod";

export const assistDiagnosticLog = pino({ name: "onboarding-assist" });
export type AssistStage =
  | "provider_request"
  | "provider_status"
  | "provider_envelope"
  | "provider_content"
  | "advice_validation"
  | "evidence_recheck";
const errorNames = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "TimeoutError", "AbortError", "ZodError"]);
const fields = new Set(["summary", "questions", "suggestedLanes", "name", "roles", "reason", "tailoring", "laneId", "advice", "evidence", "interviewFollowUps", "brief"]);
const codes = new Set(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"]);

// Diagnostics contain only bounded classifications, never exception messages or input values.
export function safeAssistFailure(error: unknown, stage: AssistStage) {
  const name = error instanceof Error ? error.name : "nonErrorObject";
  let category: string = {
    provider_request: "unknown",
    provider_status: "provider_http_error",
    provider_envelope: "invalid_provider_envelope",
    provider_content: "invalid_provider_content",
    advice_validation: "schema_validation",
    evidence_recheck: "evidence_read_failed",
  }[stage];
  if (stage === "provider_request") {
    category = name === "TimeoutError"
      ? "provider_timeout"
      : name === "AbortError"
        ? "provider_aborted"
        : error instanceof TypeError ? "provider_network" : "unknown";
  }
  return {
    error_category: category,
    error_name: errorNames.has(name) ? name : error instanceof Error ? "UnknownError" : "nonErrorObject",
    ...(error instanceof ZodError ? {
      schema_issues: error.issues.slice(0, 8).map(issue => ({
        code: codes.has(issue.code) ? issue.code : "custom",
        path: issue.path.slice(0, 6)
          .map(part => typeof part === "number" ? "[]"
            : fields.has(String(part)) ? String(part) : "[field]")
          .join(".").replaceAll(".[]", "[]"),
      })),
    } : {}),
  };
}
