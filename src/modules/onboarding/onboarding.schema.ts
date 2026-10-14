import { z } from "zod";

const text = z.string().max(4000);

// Each lane is an alternative combination: its requirements travel together.
export const laneSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200),
  roles: text,
  location: text,
  workStyle: z.enum(["any", "remote", "hybrid", "onsite"]),
  pay: text,
  seniority: text,
  avoid: text,
  openToAdjacent: z.boolean(),
});

// Bound saved input and reject unknown versions rather than silently losing fields.
export const draftSchema = z
  .object({
    schemaVersion: z.literal(1),
    step: z.number().int().min(0).max(2),
    background: z.string().max(30000),
    lanes: z.array(laneSchema).max(12),
    brief: z.string().max(12000),
    interviewAnswers: z.record(z.string().max(500), z.string().max(12000)),
    confirmedAt: z.iso.datetime({ offset: true }).nullable(),
    sourceDocumentIds: z.array(z.uuid()).max(30),
    advice: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((draft, context) => {
    if (
      new Set(draft.lanes.map((lane) => lane.id)).size !== draft.lanes.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Each work lane needs a unique ID.",
        path: ["lanes"],
      });
    }
    if (
      draft.confirmedAt &&
      (!draft.background.trim() ||
        !draft.brief.trim() ||
        !draft.lanes.length ||
        draft.lanes.some((lane) => !lane.roles.trim()))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Add your background, a role in each lane, and a brief before confirming.",
        path: ["confirmedAt"],
      });
    }
  });

export const saveSchema = z
  .object({
    draft: draftSchema,
    expectedRevision: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const assistSchema = z
  .object({
    draft: draftSchema,
    mode: z.enum(["background", "lanes", "interview", "review"]),
  })
  .strict();

export const assessJobsSchema = z.object({
  jobIds: z.array(z.uuid()).min(1).max(12),
  expectedRevision: z.number().int().positive(),
}).strict().superRefine((input, context) => {
  if (new Set(input.jobIds).size !== input.jobIds.length) {
    context.addIssue({ code: "custom", message: "Job IDs must be unique.", path: ["jobIds"] });
  }
});

export const jobLaneAssessmentsSchema = z.object({
  results: z.array(z.object({
    job_id: z.uuid(),
    lane_assessments: z.array(z.object({
      lane_id: z.string().min(1).max(100),
      fit: z.enum(["fit", "uncertain", "not_fit"]),
      reason: z.string().min(1).max(400),
      unknowns: z.array(z.string().max(120)).max(8),
    }).strict()).max(12),
  }).strict()).max(12),
}).strict();

// Provider output is untrusted; only these displayable suggestions can reach the UI.
export const adviceSchema = z.object({
  summary: z.string().max(12000),
  questions: z.array(text).max(8),
  suggestedLanes: z
    .array(
      z.object({
        name: z.string().max(200),
        roles: text,
        reason: text,
      }),
    )
    .max(6),
  tailoring: z
    .array(
      z.object({
        laneId: z.string().max(100),
        advice: text,
        evidence: text,
      }),
    )
    .max(12),
  interviewFollowUps: z.array(text).max(8),
  brief: z.string().max(12000),
});

// Give the provider the same contract the API enforces, including nested field types.
export const adviceResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "jobrank_onboarding_advice",
    strict: true,
    schema: z.toJSONSchema(adviceSchema, { target: "draft-7" }),
  },
};

export type OnboardingDraft = z.infer<typeof draftSchema>;
export type OnboardingAdvice = z.infer<typeof adviceSchema>;
export type AssistInput = z.infer<typeof assistSchema>;
export type AssessJobsInput = z.infer<typeof assessJobsSchema>;
