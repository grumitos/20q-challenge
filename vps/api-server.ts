import { readLeaderboardCache } from "../db/leaderboard-cache.ts";
import { enrichPlayers } from "../db/player-enrichment.ts";
import { rankScore } from "../lib/leaderboard.ts";
import { handleApiRequest, PRODUCTION_WEB_ORIGIN } from "./api-handler.ts";
import { openBunTrackerDatabase } from "./bun-sqlite.ts";

const publicWebOrigin = (process.env.PUBLIC_WEB_ORIGIN ?? PRODUCTION_WEB_ORIGIN).trim();
const port = Number(process.env.PORT ?? 8200);

const { database, d1 } = await openBunTrackerDatabase();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    return handleApiRequest(request, {
      publicWebOrigin,
      readCache: () => readLeaderboardCache(d1),
      enrich: (players, now) => enrichPlayers(players, rankScore, now, d1),
    });
  },
});

function close() {
  void server.stop().finally(() => database.close());
}

process.once("SIGTERM", close);
process.once("SIGINT", close);
console.log(JSON.stringify({ event: "20q_api", status: "ready", port }));
