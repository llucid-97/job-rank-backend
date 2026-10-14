import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),

  FRONTEND_URL: z.string().url(),

  SUPABASE_URL: z.string().url(),

  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),

  SUPABASE_SECRET_KEY: z.string().min(1),

  OPENROUTER_API_KEY: z.string().min(1),

  JOBSDB_API_KEY: z.string().min(1),

  TYPESAFE_API_KEY: z.string().min(1),

  SKILLS_JSON_GENERATION_MODEL: z.string().min(1),

  COVER_LETTER_CODEX_MODEL: z.string().min(1),

  QUESTION_ANSWERING_CODEX_MODEL: z
    .string()
    .min(1)
    .default("openai/gpt-5.6-luna"),
});

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  console.error(
    "Invalid environment variables:",
    z.flattenError(result.error).fieldErrors,
  );

  process.exit(1);
}

export const env = result.data;
