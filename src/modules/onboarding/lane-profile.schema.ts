import { z } from "zod";

const id = z.string().min(1).max(100);
export const laneMatchingProfileSchema = z.object({
  skills: z.array(z.object({
    id,
    label: z.string().min(1).max(100),
    evidence: z.string().min(1).max(1000),
  }).strict()).max(16),
  interests: z.array(z.object({
    id,
    label: z.string().min(1).max(100),
    criterion: z.string().min(1).max(1500),
  }).strict()).max(12),
}).strict().superRefine((profile, context) => {
  for (const group of [profile.skills, profile.interests]) {
    if (new Set(group.map((item) => item.id)).size !== group.length) {
      context.addIssue({ code: "custom", message: "Criterion IDs must be unique." });
    }
  }
});

export const prepareLaneProfilesSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const matchLaneJobsSchema = z.object({
  jobIds: z.array(z.uuid()).min(1).max(12),
  expectedRevision: z.number().int().nonnegative(),
  matchingSourceKey: z.string().length(64).regex(/^[0-9a-f]+$/),
}).strict().superRefine((input, context) => {
  if (new Set(input.jobIds).size !== input.jobIds.length) {
    context.addIssue({ code: "custom", message: "Job IDs must be unique.", path: ["jobIds"] });
  }
});
