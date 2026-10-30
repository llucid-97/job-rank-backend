import { AppError } from "../../middleware/error-handling.js";
import { TokenParser, Tokenizer, TokenType } from "@streamparser/json";
import type { JobSearchInput } from "./job-search.schema.js";

const maxProviderResponseBytes = 4 * 1024 * 1024;
const maxProviderJsonDepth = 128;

function resolveTimeFrame(days: number) {
  if (days <= 1) return "24h";
  if (days <= 7) return "7d";
  return "6m";
}
const countryNames: Record<string, string> = {
  GB: "United Kingdom",
  US: "United States",
  NG: "Nigeria",
  CA: "Canada",
  AU: "Australia",
};

function formatLocations(countryCodes: string[]) {
  return countryCodes
    .map((code) => countryNames[code] ?? code)
    .map((country) => (country.includes(" ") ? `"${country}"` : country))
    .join(" OR ");
}

const providerJobArrayKeys = ["data", "jobs", "results", "items"] as const;
type ProviderJobArrayKey = typeof providerJobArrayKeys[number];
type ProviderJobTarget = ProviderJobArrayKey | "root";

interface ProviderJobCandidate {
  isArray: boolean;
  jobs: Record<string, unknown>[];
}

interface JsonFrame {
  kind: "object" | "array";
  state: "key" | "colon" | "value" | "item" | "comma";
  key?: string;
  rootObject?: boolean;
  target?: ProviderJobTarget;
}

/** Stream-validate the response while retaining only the requested object records. */
export function extractProviderJobs(responseBody: Buffer, limit: number): Record<string, unknown>[] {
  if (responseBody.length >= 3 && responseBody[0] === 0xef && responseBody[1] === 0xbb && responseBody[2] === 0xbf) {
    throw new Error("JobsDB returned an invalid JSON response.");
  }
  const documentParser = new TokenParser({ paths: [], keepStack: false, separator: "" });
  documentParser.onValue = () => {};

  const tokenizer = new Tokenizer();
  const frames: JsonFrame[] = [];
  const candidates = new Map<ProviderJobArrayKey, ProviderJobCandidate>();
  let rootSeen = false;
  let rootIsArray = false;
  let rootJobs: Record<string, unknown>[] = [];
  let activeRecord: { parser: TokenParser; depth: number; target: ProviderJobTarget; value?: unknown } | undefined;

  const startRecord = (target: ProviderJobTarget, token: TokenType, value: unknown) => {
    if (target === "root" ? rootJobs.length >= limit : (candidates.get(target)?.jobs.length ?? 0) >= limit) return;
    const parser = new TokenParser({ paths: ["$"] });
    const record: { parser: TokenParser; depth: number; target: ProviderJobTarget; value?: unknown } = {
      parser,
      depth: 1,
      target,
    };
    parser.onValue = ({ value: parsed }) => { record.value = parsed; };
    parser.write({ token, value: value as string });
    activeRecord = record;
  };

  tokenizer.onToken = ({ token, value }) => {
    const opensContainer = token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET;
    if (opensContainer && frames.length >= maxProviderJsonDepth) {
      throw new Error("JobsDB response exceeded the maximum JSON nesting depth.");
    }
    documentParser.write({ token, value });

    if (activeRecord) {
      activeRecord.parser.write({ token, value });
      if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) activeRecord.depth += 1;
      if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
        activeRecord.depth -= 1;
        if (activeRecord.depth === 0) {
          const { target, value: job } = activeRecord;
          if (typeof job === "object" && job !== null && !Array.isArray(job)) {
            if (target === "root") rootJobs.push(job as Record<string, unknown>);
            else candidates.get(target)?.jobs.push(job as Record<string, unknown>);
          }
          activeRecord = undefined;
        }
      }
    }

    const frame = frames.at(-1);
    if (token === TokenType.STRING && frame?.kind === "object" && frame.state === "key") {
      frame.key = String(value);
      frame.state = "colon";
      return;
    }
    if (token === TokenType.COLON && frame?.kind === "object" && frame.state === "colon") {
      frame.state = "value";
      return;
    }
    if (token === TokenType.COMMA && frame) {
      frame.state = frame.kind === "object" ? "key" : "item";
      frame.key = undefined;
      return;
    }
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      frames.pop();
      return;
    }

    const parent = frames.at(-1);
    const isRootValue = !parent;
    let targetArray: ProviderJobTarget | undefined;
    if (isRootValue) {
      rootSeen = true;
      if (token === TokenType.LEFT_BRACKET) {
        rootIsArray = true;
        rootJobs = [];
        targetArray = "root";
      }
    } else if (parent.kind === "object" && parent.state === "value") {
      if (parent.rootObject && providerJobArrayKeys.includes(parent.key as ProviderJobArrayKey)) {
        const key = parent.key as ProviderJobArrayKey;
        const isArray = token === TokenType.LEFT_BRACKET;
        candidates.set(key, { isArray, jobs: [] });
        if (isArray) targetArray = key;
      }
      parent.state = "comma";
      parent.key = undefined;
    } else if (parent.kind === "array" && parent.state === "item") {
      if (parent.target && token === TokenType.LEFT_BRACE) startRecord(parent.target, token, value);
      parent.state = "comma";
    }

    if (token === TokenType.LEFT_BRACE) {
      frames.push({ kind: "object", state: "key", rootObject: isRootValue });
    } else if (token === TokenType.LEFT_BRACKET) {
      frames.push({ kind: "array", state: "item", target: targetArray });
    }
  };

  tokenizer.write(responseBody);
  tokenizer.end();
  documentParser.end();
  if (!rootSeen) throw new Error("JobsDB returned an invalid JSON response.");

  if (rootIsArray) return rootJobs;
  for (const key of providerJobArrayKeys) {
    const candidate = candidates.get(key);
    if (candidate?.isArray) return candidate.jobs;
  }
  throw new Error("JobsDB returned an unexpected response structure.");
}

async function readProviderResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxProviderResponseBytes) {
        throw new AppError(502, "JOB_PROVIDER_RESPONSE_TOO_LARGE", "The job provider returned too much data.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export async function searchJobsDb(input: JobSearchInput) {
  const host = input.sourceSite === "linkedin" ? process.env.JOBSDB_API_HOST_LINKEDIN : process.env.JOBSDB_API_HOST_ATS || process.env.JOBSDB_API_HOST;
  const endpoint = input.sourceSite === "linkedin" ? process.env.LINKEDIN_API_ENDPOINT : process.env.JOBSDB_API_ENDPOINT || "/active-ats";
  const apiKey = process.env.JOBSDB_API_KEY;

  if (!host || !endpoint || !apiKey) {
    throw new Error("JobsDB configuration is missing.");
  }

  const parameters = new URLSearchParams({
    description: input.query,
    time_frame: resolveTimeFrame(input.daysSincePosted),
    offset: (input.page * input.limit).toString(),
    limit: input.limit.toString(),
    description_format: "text",
  });

  if (input.city) {
    parameters.set("location", input.city);
  } else if (input.countryCodes.length > 0) {
    parameters.set("location", formatLocations(input.countryCodes));
  }

  if (input.isRemote) {
    parameters.set("ai_work_arrangement", "Remote OK,Remote Solely");
  }

  if (input.hasSalary) {
    parameters.set("has_salary", "true");
  }

  const response = await fetch(`https://${host}${endpoint}?${parameters}`, {
    signal: AbortSignal.timeout(30000),
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": host,
    },
  });
  const responseBody = await readProviderResponse(response);
  console.log("JobsDB response:", {
    status: response.status,
    contentType: response.headers.get("content-type"),
    responseLength: responseBody.length,
  });
  if (!response.ok) {
    throw new AppError(502,"JOB_PROVIDER_UNAVAILABLE", response.status === 403
      ? "The backend JobsDB key is not subscribed to this provider. Use an enabled public source or update the backend key."
      : "The job provider is unavailable. Please try again.");
  }

  let providerJobs: Record<string, unknown>[];
  try {
    providerJobs = extractProviderJobs(responseBody, input.limit);
  } catch (error) {
    if (error instanceof Error && error.message === "JobsDB returned an unexpected response structure.") throw error;
    throw new Error("JobsDB returned an invalid JSON response.");
  }

  return providerJobs;

  // if (Array.isArray(body)) return body;
  // if (Array.isArray(body.jobs)) return body.jobs;
  // if (Array.isArray(body.data)) return body.data;

  // throw new Error("JobsDB returned an unexpected response.");
}
