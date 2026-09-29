/**
 * The public API's request handling, apart from the Bun server that binds it
 * (`api-server.ts`), so it can be exercised under Node without a port or a
 * database. Reads only: the tracker runner is what writes the snapshot.
 */
import { CACHE_TTL_MS, type DuoRecord, type PlayerSnapshot } from "../lib/leaderboard.ts";
import { getLeaderboardForRequest } from "../lib/leaderboard-route.ts";
import type { CacheRecord } from "../lib/leaderboard-service.ts";

export const PRODUCTION_WEB_ORIGIN = "https://20q-challenge.pages.dev";

/** Cloudflare Pages serves each preview deployment and branch alias on its own
    subdomain of the project's host. */
const PAGES_PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.20q-challenge\.pages\.dev$/;

const LEADERBOARD_CACHE_CONTROL =
  `public, max-age=${CACHE_TTL_MS / 1_000}, s-maxage=30, stale-while-revalidate=60`;

export type ApiDependencies = {
  /** `PUBLIC_WEB_ORIGIN`, which defaults to `PRODUCTION_WEB_ORIGIN`. */
  publicWebOrigin: string;
  readCache: () => Promise<CacheRecord | null>;
  enrich: (
    players: readonly PlayerSnapshot[],
    now: number,
  ) => Promise<{ players: PlayerSnapshot[]; duos: DuoRecord[] }>;
  now?: () => number;
};

export function isAllowedOrigin(origin: string, publicWebOrigin: string) {
  return origin === publicWebOrigin || PAGES_PREVIEW_ORIGIN.test(origin);
}

function responseHeaders(origin: string | null, cacheControl: string): Record<string, string> {
  return {
    // Echoes the caller's own origin, which is what lets one API serve the
    // production site and every preview; `Vary` keeps shared caches from
    // handing one origin's answer to another.
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Cache-Control",
    "Access-Control-Max-Age": "600",
    "Cache-Control": cacheControl,
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function handleApiRequest(request: Request, deps: ApiDependencies): Promise<Response> {
  // Requests without an Origin (curl, health checks, server-side callers) are
  // not cross-origin and are served as before, just without CORS grants.
  const origin = request.headers.get("origin") || null;
  if (origin && !isAllowedOrigin(origin, deps.publicWebOrigin)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(origin, LEADERBOARD_CACHE_CONTROL) });
  }

  const now = (deps.now ?? Date.now)();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    // Always 200: deploy smokes only ask whether the process answers. How old
    // the snapshot is rides in the body, for whoever wants to alert on it.
    let cached: CacheRecord | null = null;
    try {
      cached = await deps.readCache();
    } catch {
      cached = null;
    }
    const fetchedAt = cached && Number.isFinite(cached.fetchedAt) ? cached.fetchedAt : null;
    return Response.json({
      ok: true,
      fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
      ageSeconds: fetchedAt === null ? null : Math.max(0, Math.floor((now - fetchedAt) / 1_000)),
    }, { status: 200, headers: responseHeaders(origin, "no-store") });
  }
  if (request.method !== "GET" || url.pathname !== "/api/leaderboard") {
    return new Response("Not found", { status: 404, headers: responseHeaders(origin, LEADERBOARD_CACHE_CONTROL) });
  }

  const payload = await getLeaderboardForRequest({ now, apiKey: "", readCache: deps.readCache });
  if (payload.meta.source === "demo") {
    // The shared route falls back to demo players, which is right for local
    // development and wrong here: fake players must never pass for the real
    // board. Uncached, so it clears as soon as the tracker writes one.
    return Response.json({ error: "no_snapshot" }, { status: 503, headers: responseHeaders(origin, "no-store") });
  }
  const enriched = await deps.enrich(payload.data.players, now);
  return Response.json(
    { ...payload, data: { ...payload.data, players: enriched.players, duos: enriched.duos } },
    { status: 200, headers: responseHeaders(origin, LEADERBOARD_CACHE_CONTROL) },
  );
}
