/** Prefer this owner's saved provider fields; legacy server-sourced jobs have no snapshot. */
export function ownerJob<T extends Record<string, any>>(job: T, snapshot: unknown): T {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return job;
  const fields = snapshot as Record<string, unknown>;
  const owned: Record<string, unknown> = { ...job };
  for (const [source, target] of [
    ["title", "title"], ["companyName", "company_name"], ["location", "location"],
    ["description", "description"], ["url", "application_url"],
    ["apiDatePosted", "provider_date_posted"], ["apiJobData", "provider_payload"],
  ] as const) {
    owned[target] = fields[source] ?? (source === "apiDatePosted" ? null : source === "apiJobData" ? {} : "");
  }
  return owned as T;
}
