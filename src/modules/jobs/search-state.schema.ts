import { z } from "zod";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Keep user-visible character limits and a separate byte cap on untrusted inputs. */
export function boundedText(maxCharacters: number, maxBytes: number) {
  return z.string().refine(value =>
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes &&
    [...segmenter.segment(value)].length <= maxCharacters,
  `Must contain at most ${maxCharacters} characters and ${maxBytes} UTF-8 bytes.`);
}

const optionalCity = boundedText(100, 400).nullable().optional();
const countries = z.record(
  boundedText(100, 400),
  z.enum(["authorized", "needs_sponsorship", "unknown"]),
).refine(value => Object.keys(value).length <= 250, "Too many work countries.");

/** Preserve every saved search control while bounding what an account can store. */
const searchSnapshotSchema = z.object({
  query: boundedText(200, 1600),
  location: z.enum(["remote", "on-site", "all"]),
  countryScope: boundedText(100, 400),
  hasSalary: z.boolean(),
  city: optionalCity,
  hiringCountries: countries,
  preferences: boundedText(2000, 16384),
  mustHaves: boundedText(2000, 16384),
  minimumSalary: z.number().finite().positive().nullable().optional(),
  salaryCurrency: z.string().regex(/^[A-Z]{3}$/),
  salaryPeriod: z.enum(["year", "month", "hour"]),
}).passthrough();

export const savedSearchSchema = searchSnapshotSchema.refine(
  value => value.query.trim().length > 0, "Search query is required.",
);

/** Existing source settings have nested public board lists; cap their serialized size. */
const sourceSettings = z.record(z.string(), z.unknown()).refine(value => {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 65536; }
  catch { return false; }
}, "Source settings are too large.");

/** Location may contribute a country choice, but precise coordinates are never saved. */
function containsCoordinateFields(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (["lat", "lon", "lng", "latitude", "longitude", "coordinates", "coords", "geolocation"].includes(key.toLowerCase())) return true;
      pending.push(child);
    }
  }
  return false;
}

export const searchStateSchema = z.object({
  version: z.literal(1),
  currentSearch: searchSnapshotSchema.nullable().optional(),
  locationDefaultAttempted: z.boolean().optional(),
  history: z.array(savedSearchSchema).max(40),
  lastBatch: z.object({
    searches: z.array(savedSearchSchema).min(1).max(40),
    sourceSite: boundedText(100, 200).refine(value => value.trim().length > 0),
    jobsFetchLimit: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]),
    sourceSettings: sourceSettings.nullable(),
  }).passthrough().nullable(),
  jobsMaxPostedAgeDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]).nullable(),
}).passthrough().refine(value => !containsCoordinateFields(value), "Precise location cannot be saved.").refine(value => {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 786432; }
  catch { return false; }
}, "Search state is too large.");
