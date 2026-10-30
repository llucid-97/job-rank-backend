import { AppError } from "../../middleware/error-handling.js";
import type { JobSearchInput } from "./job-search.schema.js";

const maxProviderResponseBytes = 4 * 1024 * 1024;

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

function extractProviderJobs(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }

  if (typeof body === "object" && body !== null) {
    const object = body as Record<string, unknown>;

    for (const key of ["data", "jobs", "results", "items"]) {
      const value = object[key];

      if (Array.isArray(value)) {
        return value.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        );
      }
    }
  }

  throw new Error("JobsDB returned an unexpected response structure.");
}

async function readProviderResponse(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error("JobsDB returned an empty response.");
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
  const responseText = (await readProviderResponse(response)).toString("utf8");
  console.log("JobsDB response:", {
    status: response.status,
    contentType: response.headers.get("content-type"),
    responseLength: responseText.length,
  });
  if (!response.ok) {
    throw new AppError(502,"JOB_PROVIDER_UNAVAILABLE", response.status === 403
      ? "The backend JobsDB key is not subscribed to this provider. Use an enabled public source or update the backend key."
      : "The job provider is unavailable. Please try again.");
  }

  let body: unknown;

  try {
    body = JSON.parse(responseText);
  } catch {
    throw new Error("JobsDB returned an invalid JSON response.");
  }

  return extractProviderJobs(body).slice(0, input.limit);

  // if (Array.isArray(body)) return body;
  // if (Array.isArray(body.jobs)) return body.jobs;
  // if (Array.isArray(body.data)) return body.data;

  // throw new Error("JobsDB returned an unexpected response.");
}
