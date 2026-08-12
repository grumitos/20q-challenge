/**
 * Spectator-v5 identifies champions by numeric key while the rest of the app
 * (and every Data Dragon asset URL) uses the textual id. This resolves one to
 * the other from Data Dragon's champion list, which needs no Riot API key and
 * is cached for the lifetime of the worker isolate.
 */

export type ChampionIdentity = { id: string; name: string };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let cached: { version: string; byKey: Map<string, ChampionIdentity> } | null = null;
let inFlight: Promise<Map<string, ChampionIdentity>> | null = null;

async function loadCatalog(version: string, fetchImpl: FetchLike): Promise<Map<string, ChampionIdentity>> {
  const response = await fetchImpl(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`,
  );
  if (!response.ok) throw new Error(`Data Dragon champion list failed: ${response.status}`);
  const payload: unknown = await response.json();
  const data = typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>).data
    : null;
  if (typeof data !== "object" || data === null) throw new Error("Data Dragon champion list was malformed.");

  const byKey = new Map<string, ChampionIdentity>();
  for (const entry of Object.values(data as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const champion = entry as Record<string, unknown>;
    if (typeof champion.key !== "string" || typeof champion.id !== "string") continue;
    byKey.set(champion.key, {
      id: champion.id,
      name: typeof champion.name === "string" ? champion.name : champion.id,
    });
  }
  return byKey;
}

export async function championsByNumericKey(
  version: string,
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, ChampionIdentity>> {
  if (cached?.version === version) return cached.byKey;
  if (!inFlight) {
    inFlight = loadCatalog(version, fetchImpl)
      .then((byKey) => {
        cached = { version, byKey };
        return byKey;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Resets the memoised catalog. Test-only. */
export function resetChampionCatalog() {
  cached = null;
  inFlight = null;
}
