import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { consumeQuota } from "../provider-proxy/provider-quota.js";
import { acquireJobsDbSearchLease, releaseJobsDbSearchLease } from "./search-admission.js";
import { jobSearchSchema } from "./job-search.schema.js";
import { searchJobsDb } from "./jobsdb.service.js";
import { saveSearchResults } from "./job.repository.js";
import z from "zod";
import { saveSearch } from "./search.repository.js";

export async function searchJobs(request: Request, response: Response) {
  const parsed = jobSearchSchema.safeParse(request.body);

  if (!parsed.success) {
    return response.status(400).json({
      error: {
        code: "INVALID_SEARCH",
        message: "The search details are invalid.",
        details: z.flattenError(parsed.error).fieldErrors,
      },
    });
  }

  const userId = request.auth!.userId;
  const requestId = randomUUID();
  const admitted = await acquireJobsDbSearchLease(userId, requestId);
  if (!admitted) {
    response.set("Retry-After", "5");
    return response.status(429).json({
      error: {
        code: "JOB_SEARCH_BUSY",
        message: "Job search capacity is busy. Retry shortly.",
      },
    });
  }

  try {
    await consumeQuota(userId, "jobsdb", 1);
    const providerJobs = await searchJobsDb(parsed.data);
    console.log("JobsDB provider results:", {
      count: providerJobs.length,
    });
    const jobs = await saveSearchResults(
      userId,
      providerJobs,
      parsed.data.sourceSite,
      parsed.data.persistResults,
    );
    await saveSearch(userId, parsed.data);

    console.log("Saved normalized jobs:", {
      count: jobs.length,
    });

    return response.status(200).json({
      data: jobs,
      meta: {
        count: jobs.length,
        page: parsed.data.page,
      },
    });
  } finally {
    try {
      const released = await releaseJobsDbSearchLease(userId, requestId);
      if (!released) console.error("JobsDB search admission lease was not released.");
    } catch {
      // A failed release is recoverable through the database lease expiry.
      console.error("JobsDB search admission lease release failed.");
    }
  }
}
