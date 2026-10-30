import { z } from "zod";
import { boundedText } from "./search-state.schema.js";

/** Keep provider search inputs aligned with the user-visible character limit. */
export const jobSearchSchema = z.object({
  query: boundedText(200, 1600).transform(value => value.trim()),
  historyQuery: boundedText(200, 1600).transform(value => value.trim()).optional(),
  sourceSite: z.enum(["jobsdb", "linkedin"]).default("jobsdb"),
  persistResults: z.boolean().default(true),
  isRemote: z.boolean().default(false),
  countryCodes: z.array(z.string().length(2)).max(20).default([]),
  city: z.string().trim().max(100).nullable().optional(),
  hasSalary: z.boolean().default(false),
  page: z.number().int().min(0).default(0),
  daysSincePosted: z.number().int().min(1).max(180).default(7),
  limit: z.number().int().min(1).max(100).default(25),
});

export type JobSearchInput = z.infer<typeof jobSearchSchema>;
