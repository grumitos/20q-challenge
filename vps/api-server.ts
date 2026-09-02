import { readLeaderboardCache } from "../db/leaderboard-cache.ts";
import { enrichPlayers } from "../db/player-enrichment.ts";
import { CACHE_TTL_MS } from "../lib/leaderboard.ts";
import { getLeaderboardForRequest } from "../lib/leaderboard-route.ts";
import { rankScore } from "../lib/leaderboard.ts";
import { openBunTrackerDatabase } from "./bun-sqlite.ts";

const publicWebOrigin = (process.env.PUBLIC_WEB_ORIGIN ?? "https://20q-challenge.pages.dev").trim();
const port = Number(process.env.PORT ?? 8200);

function headersFor(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicWebOrigin) return null;
  return {
    "Access-Control-Allow-Origin": origin === publicWebOrigin ? publicWebOrigin : "",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Cache-Control",
    "Access-Control-Max-Age": "600",
    "Cache-Control": `public, max-age=${CACHE_TTL_MS / 1_000}, s-maxage=30, stale-while-revalidate=60`,
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(value: unknown, status: number, headers: Record<string, string>) {
  const filtered = Object.fromEntries(Object.entries(headers).filter(([, entry]) => entry.length > 0));
  return Response.json(value, { status, headers: filtered });
}

const { database, d1 } = await openBunTrackerDatabase();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const headers = headersFor(request);
    if (!headers) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true }, 200, headers);
    }
    if (request.method !== "GET" || url.pathname !== "/api/leaderboard") {
      return new Response("Not found", { status: 404, headers });
    }

    const now = Date.now();
    const payload = await getLeaderboardForRequest({
      now,
      apiKey: "",
      readCache: () => readLeaderboardCache(d1),
    });
    const enriched = await enrichPlayers(payload.data.players, rankScore, now, d1);
    return json({ ...payload, data: { ...payload.data, players: enriched.players, duos: enriched.duos } }, 200, headers);
  },
});

function close() {
  void server.stop().finally(() => database.close());
}

process.once("SIGTERM", close);
process.once("SIGINT", close);
console.log(JSON.stringify({ event: "20q_api", status: "ready", port }));
