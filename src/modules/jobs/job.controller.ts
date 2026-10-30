import type { Request, Response } from "express";
import { consumeQuota } from "../provider-proxy/provider-quota.js";
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

  await consumeQuota(request.auth!.userId, "jobsdb", 1);
  const providerJobs = await searchJobsDb(parsed.data);
  console.log("JobsDB provider results:", {
    count: providerJobs.length,
  });
  const jobs = await saveSearchResults(
    request.auth!.userId,
    providerJobs,
    parsed.data.sourceSite,
    parsed.data.persistResults,
  );
  await saveSearch(request.auth!.userId, parsed.data);

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
}
