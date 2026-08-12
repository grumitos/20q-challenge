/**
 * Every D1 access in the app goes through here. Note there is no Drizzle client:
 * the stores all use raw `db.prepare(...)`, and `db/schema.ts` exists purely so
 * `drizzle-kit generate` can diff it into a migration.
 */
export async function getD1() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  }
  return env.DB;
}
