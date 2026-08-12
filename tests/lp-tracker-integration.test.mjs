import assert from "node:assert/strict";
import test from "node:test";

import { runTemporalLpTracker } from "../lib/lp-tracker.ts";
import { RIOT_PLAYERS } from "../lib/riot-client.ts";
import { TRACKER_REQUEST_BUDGET } from "../lib/riot-request.ts";
import { resetChampionCatalog } from "../lib/champion-catalog.ts";

/** Enough of Data Dragon's champion list to resolve the keys these tests use. */
const CHAMPION_CATALOG = {
  data: {
    Mordekaiser: { key: "82", id: "Mordekaiser", name: "Mordekaiser" },
    Jhin: { key: "202", id: "Jhin", name: "Jhin" },
    Leona: { key: "89", id: "Leona", name: "Leona" },
    Darius: { key: "122", id: "Darius", name: "Darius" },
    Nami: { key: "267", id: "Nami", name: "Nami" },
  },
};

function fakeStore(players, observations, sessions) {
  const writes = { observations: [], sessions: [], candidates: [], evidence: [], cursors: [], enrolled: [], pruned: [] };
  return {
    writes,
    async acquireLease() { return true; },
    async releaseLease() {},
    async blockLaneUntil() {},
    async loadTrackerState() { return { players, observations, sessions, candidates: [], snapshot: null }; },
    async bootstrapPlayerSyncState(snapshot) { writes.enrolled.push(...snapshot.players); },
    async insertRankObservations(value) { writes.observations.push(...value); },
    async upsertGameSessions(value) { writes.sessions.push(...value); },
    async upsertCandidates(value) { writes.candidates.push(...value); },
    async writeTerminalEvidence(value) { writes.evidence.push(...value); },
    async hydrateLatestMatchEvidence(value) { return value; },
    async updateRecentCursors(value) { writes.cursors.push(...value); },
    async pruneRankObservations(before) { writes.pruned.push(before); },
    async writeLeaderboardProjection() {},
  };
}

function riotResponse(url, detailCounter) {
  if (url.includes("/league/v4/")) return new Response(JSON.stringify([{
    queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "IV", leaguePoints: 12, wins: 11, losses: 10,
  }]), { status: 200 });
  if (url.includes("/spectator/v5/")) return new Response(null, { status: 404 });
  if (url.includes("/ids?")) return new Response(JSON.stringify(["LA2_77"]), { status: 200 });
  // Account lookups are their own endpoint, not a Match-V5 detail. Without this
  // branch the catch-all below bills the tracker's roster catch-up to
  // `detailCounter` and hands it a match payload as if it were an account.
  if (url.includes("/riot/account/v1/")) {
    const [gameName, tagLine] = url.split("/by-riot-id/")[1].split("/");
    return new Response(JSON.stringify({
      puuid: `puuid-${decodeURIComponent(gameName)}`,
      gameName: decodeURIComponent(gameName),
      tagLine: decodeURIComponent(tagLine),
    }), { status: 200 });
  }
  detailCounter.count += 1;
  return new Response(JSON.stringify({
    metadata: { matchId: "LA2_77" },
    info: {
      queueId: 420,
      gameStartTimestamp: 1_500,
      gameEndTimestamp: 4_000,
      participants: [
        { puuid: "puuid-1", win: true },
        { puuid: "puuid-2", win: true },
      ],
    },
  }), { status: 200 });
}

test("runs the cron path without HTTP visits and persists terminal evidence", async () => {
  const players = [{ playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null }];
  const observations = [{ id: "p1:1000", playerId: "p1", observedAt: 1_000, tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10 }];
  const sessions = [{ playerId: "p1", platformGameId: "77", queueId: 420, baselineObservationId: "p1:1000", gameStartedAt: 1_500, firstSeenAt: 2_000, lastSeenAt: 3_000, endedDetectedAt: 4_000, matchId: null, status: "ended_waiting_match", updatedAt: 4_000 }];
  const store = fakeStore(players, observations, sessions);
  const detailCounter = { count: 0 };

  const result = await runTemporalLpTracker({
    store,
    apiKey: "secret",
    now: 5_000,
    owner: "run-1",
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), detailCounter)),
  });

  assert.equal(result.status, "completed");
  assert.equal(store.writes.evidence[0].lpDelta, 22);
  assert.equal(store.writes.sessions[0].status, "linked");
  assert.equal(store.writes.cursors[0].matchId, "LA2_77");
});

test("names a failed run in its log instead of letting it read as a Riot outage", async () => {
  // The leaderboard route catches whatever this throws and tells the reader
  // "Riot no respondió", so a D1 error — an unapplied migration, most likely —
  // is invisible unless the run says so itself.
  const players = [{ playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null }];
  const observations = [{ id: "p1:1000", playerId: "p1", observedAt: 1_000, tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10 }];
  const sessions = [{ playerId: "p1", platformGameId: "77", queueId: 420, baselineObservationId: "p1:1000", gameStartedAt: 1_500, firstSeenAt: 2_000, lastSeenAt: 3_000, endedDetectedAt: 4_000, matchId: null, status: "ended_waiting_match", updatedAt: 4_000 }];
  const store = fakeStore(players, observations, sessions);
  let released = false;
  store.upsertGameSessions = async () => {
    throw new Error("D1_ERROR: table tracked_game_sessions has no column named champion_id");
  };
  store.releaseLease = async () => { released = true; };

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    await assert.rejects(
      runTemporalLpTracker({
        store,
        apiKey: "secret",
        now: 5_000,
        owner: "run-failed",
        fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
      }),
      /no column named champion_id/,
    );
  } finally {
    console.log = realLog;
  }

  const run = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "lp_tracker_run");
  assert.ok(run, "the run must log even when it throws");
  assert.equal(run.status, "failed");
  assert.match(run.error, /no column named champion_id/);
  assert.equal(released, true, "a failed run must still release its lease");
});

test("logs a run that never starts, so a stuck lease is not silence", async () => {
  const store = fakeStore([], [], []);
  store.acquireLease = async () => false;

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  let result;
  try {
    result = await runTemporalLpTracker({ store, apiKey: "secret", now: 5_000, owner: "run-blocked" });
  } finally {
    console.log = realLog;
  }

  assert.equal(result.status, "skipped");
  const run = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "lp_tracker_run");
  assert.equal(run.status, "skipped:lease_unavailable");
});

/**
 * The whole write path for a live game whose tracked player hides their
 * identity. Riot blanks the puuid *and* the Riot ID of whoever turns streamer
 * mode on, and the champion is what the card exists to show.
 */
test("persists the live champion of a player whose identity is hidden", async () => {
  resetChampionCatalog();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /ddragon\.leagueoflegends\.com/);
    return new Response(JSON.stringify(CHAMPION_CATALOG), { status: 200 });
  };

  const players = [
    { playerId: "papipu", puuid: "puuid-papipu", gameName: "Papipu", tagLine: "HOLA", recentMatchId: null },
    { playerId: "miqi", puuid: "puuid-miqi", gameName: "miqi", tagLine: "8745", recentMatchId: null },
  ];
  const observations = players.map((player) => ({
    id: `${player.playerId}:1000`, playerId: player.playerId, observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }));
  const store = fakeStore(players, observations, []);

  const spectator = {
    gameId: 4242,
    gameQueueConfigId: 420,
    gameStartTime: 3_000,
    participants: [
      // Papipu, in streamer mode: both identifiers withheld by Riot.
      { puuid: "", riotId: "", championId: 82, teamId: 100 },
      // miqi is also in the game, and also hiding their puuid — but Riot still
      // reports the Riot ID, so the duo must not read as a stranger.
      { puuid: "", riotId: "miqi#8745", championId: 202, teamId: 100 },
      { puuid: "someone", riotId: "Nadie#LAS", championId: 89, teamId: 100 },
      { puuid: "rival", riotId: "Rival#LAS", championId: 122, teamId: 200 },
      { puuid: "otro", riotId: "Otro#LAS", championId: 267, teamId: 200 },
    ],
  };

  try {
    await runTemporalLpTracker({
      store, apiKey: "secret", now: 5_000, owner: "run-streamer",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/league/v4/")) return new Response(JSON.stringify([{
          queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "IV", leaguePoints: 12, wins: 11, losses: 10,
        }]), { status: 200 });
        // Only Papipu is in a game; miqi's own spectator lookup returns nothing,
        // which is what happens when the roster is polled one player at a time.
        if (url.includes("/spectator/v5/")) {
          return url.includes("puuid-papipu")
            ? new Response(JSON.stringify(spectator), { status: 200 })
            : new Response(null, { status: 404 });
        }
        if (url.includes("/ids?")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(null, { status: 404 });
      },
    });
  } finally {
    globalThis.fetch = realFetch;
    resetChampionCatalog();
  }

  const session = store.writes.sessions.find((entry) => entry.playerId === "papipu");
  assert.ok(session, "the active session must be written");
  assert.equal(session.status, "active");
  assert.equal(session.championId, "Mordekaiser", "streamer mode hides the name, never the champion");
  assert.equal(session.championName, "Mordekaiser");

  const roster = JSON.parse(session.participants);
  assert.equal(roster.length, 5);
  // The hidden player is claimed by the run that found them, so the card can
  // mark their disc and read their champion off it.
  assert.equal(roster[0].challengePlayerId, "papipu");
  assert.equal(roster[0].championId, "Mordekaiser");
  assert.deepEqual(roster.map((entry) => entry.rosterIndex), [0, 1, 2, 3, 4]);
  // A challenge peer hiding only their puuid is still matched, by Riot ID.
  assert.equal(roster[1].challengePlayerId, "miqi");
  // Nobody else is mistaken for a member just for being anonymous.
  assert.deepEqual(roster.slice(2).map((entry) => entry.challengePlayerId), [null, null, null]);
  // Spectator reports no position, so none may be invented.
  assert.deepEqual(roster.map((entry) => entry.role ?? null), [null, null, null, null, null]);
});

test("refuses to guess the live champion when two players are anonymous", async () => {
  resetChampionCatalog();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(CHAMPION_CATALOG), { status: 200 });

  const players = [{ playerId: "papipu", puuid: "puuid-papipu", gameName: "Papipu", tagLine: "HOLA", recentMatchId: null }];
  const observations = [{ id: "papipu:1000", playerId: "papipu", observedAt: 1_000, tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10 }];
  const store = fakeStore(players, observations, []);

  try {
    await runTemporalLpTracker({
      store, apiKey: "secret", now: 5_000, owner: "run-ambiguous",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/league/v4/")) return new Response(JSON.stringify([{
          queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "IV", leaguePoints: 12, wins: 11, losses: 10,
        }]), { status: 200 });
        if (url.includes("/spectator/v5/")) return new Response(JSON.stringify({
          gameId: 4243, gameQueueConfigId: 420, gameStartTime: 3_000,
          participants: [
            { puuid: "", riotId: "", championId: 82, teamId: 100 },
            { puuid: "", riotId: "", championId: 202, teamId: 100 },
          ],
        }), { status: 200 });
        if (url.includes("/ids?")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(null, { status: 404 });
      },
    });
  } finally {
    globalThis.fetch = realFetch;
    resetChampionCatalog();
  }

  const session = store.writes.sessions.find((entry) => entry.playerId === "papipu");
  // Putting the wrong champion on the card is worse than putting none: the game
  // is still tracked, the art slot simply stays empty.
  assert.equal(session.status, "active");
  assert.equal(session.championId, "");
  // And a blank identifier must not match anybody: two anonymous strangers are
  // strangers, not whichever member happens to be keyed under the empty string.
  assert.deepEqual(JSON.parse(session.participants).map((entry) => entry.challengePlayerId), [null, null]);
  assert.deepEqual(JSON.parse(session.participants).map((entry) => entry.gameName), ["", ""]);
});

test("downloads one Match-V5 detail when two challenge players share a match", async () => {
  const players = [
    { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null },
    { playerId: "p2", puuid: "puuid-2", gameName: "P2", tagLine: "LAS", recentMatchId: null },
  ];
  const observations = players.map((player) => ({ id: `${player.playerId}:1000`, playerId: player.playerId, observedAt: 1_000, tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10 }));
  const sessions = players.map((player) => ({ playerId: player.playerId, platformGameId: "77", queueId: 420, baselineObservationId: `${player.playerId}:1000`, gameStartedAt: 1_500, firstSeenAt: 2_000, lastSeenAt: 3_000, endedDetectedAt: 4_000, matchId: null, status: "ended_waiting_match", updatedAt: 4_000 }));
  const store = fakeStore(players, observations, sessions);
  const detailCounter = { count: 0 };

  await runTemporalLpTracker({ store, apiKey: "secret", now: 5_000, owner: "run-2", fetchImpl: (input) => Promise.resolve(riotResponse(String(input), detailCounter)) });

  assert.equal(detailCounter.count, 1);
  assert.equal(store.writes.evidence.length, 2);
});

test("gives every player their newest match before anyone gets a second", async () => {
  const players = Array.from({ length: 9 }, (_, index) => ({
    playerId: `p${index + 1}`,
    puuid: `puuid-${index + 1}`,
    gameName: `P${index + 1}`,
    tagLine: "LAS",
    recentMatchId: null,
  }));
  const observations = players.map((player) => ({
    id: `${player.playerId}:1000`,
    playerId: player.playerId,
    observedAt: 1_000,
    tier: "SILVER",
    division: "I",
    leaguePoints: 90,
    wins: 10,
    losses: 10,
  }));
  const store = fakeStore(players, observations, []);
  const downloadedMatchIds = [];

  const result = await runTemporalLpTracker({
    store,
    apiKey: "secret",
    now: 5_000,
    owner: "run-fair-latest",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/league/v4/")) return new Response(JSON.stringify([{
        queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "IV", leaguePoints: 12, wins: 11, losses: 10,
      }]), { status: 200 });
      if (url.pathname.includes("/spectator/v5/")) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("/ids")) {
        const puuid = decodeURIComponent(url.pathname.split("/").at(-2));
        const playerNumber = puuid.split("-").at(-1);
        return new Response(JSON.stringify([
          `LA2_${playerNumber}_latest`,
          `LA2_${playerNumber}_older_1`,
          `LA2_${playerNumber}_older_2`,
        ]), { status: 200 });
      }

      // Account lookups are not match details; without this branch the roster
      // catch-up's requests land in `downloadedMatchIds` and read as downloads.
      if (url.pathname.includes("/riot/account/v1/")) {
        return new Response(JSON.stringify({ puuid: "x", gameName: "x", tagLine: "x" }), { status: 200 });
      }
      const matchId = decodeURIComponent(url.pathname.split("/").at(-1));
      downloadedMatchIds.push(matchId);
      const playerNumber = matchId.split("_")[1];
      return new Response(JSON.stringify({
        metadata: { matchId },
        info: {
          queueId: 420,
          gameStartTimestamp: 1_500,
          gameEndTimestamp: 4_000,
          participants: [{ puuid: `puuid-${playerNumber}`, win: true }],
        },
      }), { status: 200 });
    },
  });

  assert.deepEqual(
    store.writes.cursors.map(({ playerId, matchId }) => [playerId, matchId]),
    players.map((player, index) => [player.playerId, `LA2_${index + 1}_latest`]),
  );
  // One detail per player per tick. `matchIdsByRecency` puts everyone's latest
  // first, so the cap lands exactly on "everybody's newest, nobody's second" —
  // and a backlog drains a tick at a time rather than in one CPU spike.
  assert.deepEqual(downloadedMatchIds, players.map((_, index) => `LA2_${index + 1}_latest`));
  assert.equal(downloadedMatchIds.some((matchId) => matchId.endsWith("older_")), false);
  assert.ok(result.requestsUsed <= TRACKER_REQUEST_BUDGET);
});

test("enrolls a roster member added after the initial bootstrap", async () => {
  // `bootstrapPlayerSyncState` only fires on a cold start, so before this the
  // last roster entry — yvncv#0521, added once the others were already synced —
  // never reached `player_sync_state` and every run polled around them.
  const [straggler, ...synced] = [...RIOT_PLAYERS].reverse();
  const players = synced.map((identity, index) => ({
    playerId: identity.id,
    puuid: `puuid-${index + 1}`,
    gameName: identity.gameName,
    tagLine: identity.tagLine,
    recentMatchId: null,
  }));
  const observations = players.map((player) => ({
    id: `${player.playerId}:1000`, playerId: player.playerId, observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }));
  const store = fakeStore(players, observations, []);

  await runTemporalLpTracker({
    store, apiKey: "secret", now: 5_000, owner: "run-enrol",
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
  });

  assert.deepEqual(
    store.writes.enrolled.map(({ id, gameName, tagLine }) => [id, gameName, tagLine]),
    [[straggler.id, straggler.gameName, straggler.tagLine]],
    "the missing roster member is resolved and written to player_sync_state",
  );
  assert.equal(store.writes.enrolled[0].puuid, `puuid-${straggler.gameName}`);
});

test("a failing account lookup cannot fail a run that already did its work", async () => {
  // The catch-up runs last, after observations, sessions, evidence and the
  // projection are all persisted. Letting a 429 there escape marked a wholly
  // successful run as `failed` and told readers "Riot no respondió".
  const [straggler, ...synced] = [...RIOT_PLAYERS].reverse();
  const players = synced.map((identity, index) => ({
    playerId: identity.id,
    puuid: `puuid-${index + 1}`,
    gameName: identity.gameName,
    tagLine: identity.tagLine,
    recentMatchId: null,
  }));
  const observations = players.map((player) => ({
    id: `${player.playerId}:1000`, playerId: player.playerId, observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }));
  const store = fakeStore(players, observations, []);

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  let result;
  try {
    result = await runTemporalLpTracker({
      store, apiKey: "secret", now: 5_000, owner: "run-enrol-fails",
      fetchImpl: (input) => {
        const url = String(input);
        if (url.includes("/riot/account/v1/")) return Promise.resolve(new Response("nope", { status: 500 }));
        return Promise.resolve(riotResponse(url, { count: 0 }));
      },
    });
  } finally {
    console.log = realLog;
  }

  assert.equal(result.status, "completed");
  assert.equal(store.writes.enrolled.length, 0);
  const entries = lines.map((line) => JSON.parse(line));
  assert.equal(entries.find((entry) => entry.event === "lp_tracker_run").status, "completed");
  const failure = entries.find((entry) => entry.event === "lp_tracker_enrol_failed");
  assert.ok(failure, "the skipped enrolment must still be visible in the log");
  assert.deepEqual(failure.playerIds, [straggler.id]);
});

test("bounds match details per tick so a backlog cannot spike one run", async () => {
  // This used to assert that a budget drained by match details starved the
  // roster catch-up. Details are capped at one per player now — a fifteen-minute
  // game makes more than that impossible between ticks — so the budget is no
  // longer what limits them, and draining it that way is unreachable. What is
  // worth holding is the cap itself: it is what stopped a backlog being
  // downloaded in a single invocation and spiking the CPU into a 1102.
  const [, ...synced] = [...RIOT_PLAYERS].reverse();
  const players = synced.map((identity, index) => ({
    playerId: identity.id,
    puuid: `puuid-${index + 1}`,
    gameName: identity.gameName,
    tagLine: identity.tagLine,
    recentMatchId: null,
  }));
  const observations = players.map((player) => ({
    id: `${player.playerId}:1000`, playerId: player.playerId, observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }));
  const store = fakeStore(players, observations, []);
  let accountLookups = 0;
  let detailsFetched = 0;

  await runTemporalLpTracker({
    store, apiKey: "secret", now: 5_000, owner: "run-no-budget",
    // Three distinct fresh matches per player, so match details drain the
    // window before the catch-up is reached.
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/riot/account/v1/")) {
        accountLookups += 1;
        return new Response(JSON.stringify({ puuid: "x", gameName: "x", tagLine: "x" }), { status: 200 });
      }
      if (url.pathname.includes("/league/v4/")) return new Response(JSON.stringify([{
        queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "IV", leaguePoints: 12, wins: 11, losses: 10,
      }]), { status: 200 });
      if (url.pathname.includes("/spectator/v5/")) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("/ids")) {
        const puuid = decodeURIComponent(url.pathname.split("/").at(-2));
        const n = puuid.split("-").at(-1);
        return new Response(JSON.stringify([`LA2_${n}_a`, `LA2_${n}_b`, `LA2_${n}_c`]), { status: 200 });
      }
      const matchId = decodeURIComponent(url.pathname.split("/").at(-1));
      detailsFetched += 1;
      return new Response(JSON.stringify({
        metadata: { matchId },
        info: {
          queueId: 420, gameStartTimestamp: 1_500, gameEndTimestamp: 4_000,
          participants: [{ puuid: `puuid-${matchId.split("_")[1]}`, win: true }],
        },
      }), { status: 200 });
    },
  });

  assert.ok(
    detailsFetched <= RIOT_PLAYERS.length,
    `one tick downloaded ${detailsFetched} match details, over the ${RIOT_PLAYERS.length} cap`,
  );
  // The catch-up may now run, since details no longer drain the budget; what
  // matters is that it stays within its own allowance.
  assert.ok(accountLookups <= 3);
});

test("a newly enrolled player is not stamped with LP nobody could have observed", async () => {
  // Their first poll has no earlier rank observation, so every recent match
  // would resolve as unavailable on the same tick and stay that way.
  const players = [{
    playerId: "yvncv", puuid: "puuid-yvncv", gameName: "yvncv", tagLine: "0521", recentMatchId: null,
  }];
  const store = fakeStore(players, [], []);

  await runTemporalLpTracker({
    store, apiKey: "secret", now: 5_000, owner: "run-first-poll",
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
  });

  assert.deepEqual(store.writes.candidates, []);
  assert.deepEqual(store.writes.evidence, []);
  // The observation and the cursor are still recorded, so the next run has the
  // baseline it needs.
  assert.equal(store.writes.observations.length, 1);
});

test("a run that writes no cache holds the lane so requests cannot re-drive it", async () => {
  // `/api/leaderboard` treats an empty cache as always stale, and it is public.
  // Without this the first request started a run that wrote no cache, so the
  // next request started another, at ~45 Riot calls each, with no exit.
  const players = [{
    playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null,
  }];
  const observations = [{
    id: "p1:1000", playerId: "p1", observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }];
  const store = fakeStore(players, observations, []);
  // `loadTrackerState` already returns `snapshot: null` here, which is the case
  // that produced the loop: sync state populated, leaderboard cache empty.
  const blocked = [];
  store.blockLaneUntil = async (lane, until) => blocked.push({ lane, until });

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    await runTemporalLpTracker({
      store, apiKey: "secret", now: 5_000, owner: "run-no-projection",
      fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
    });
  } finally {
    console.log = realLog;
  }

  assert.deepEqual(blocked, [{ lane: "lp-tracker", until: 65_000 }]);
  const gap = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "lp_tracker_no_projection");
  assert.ok(gap, "the skipped projection must be visible in the log");
});

test("brings a renamed player's stored identity back in line", async () => {
  // A puuid survives a rename but the Riot ID does not, and nothing else ever
  // rewrites these columns. Before this the tracker kept recording the player's
  // LP while the board showed them UNRANKED for good, because `refreshLeaderboard`
  // looks the account up by the hardcoded Riot ID and got a 404.
  const players = [{
    playerId: "yvncv", puuid: "puuid-yvncv", gameName: "yvncv", tagLine: "0521", recentMatchId: null,
  }];
  const observations = [{
    id: "yvncv:1000", playerId: "yvncv", observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }];
  const store = fakeStore(players, observations, []);

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    await runTemporalLpTracker({
      store, apiKey: "secret", now: 5_000, owner: "run-rename",
      fetchImpl: (input) => {
        const url = String(input);
        if (url.includes("/accounts/by-puuid/")) {
          return Promise.resolve(new Response(JSON.stringify({
            puuid: "puuid-yvncv", gameName: "yvncvNEW", tagLine: "LAS",
          }), { status: 200 }));
        }
        return Promise.resolve(riotResponse(url, { count: 0 }));
      },
    });
  } finally {
    console.log = realLog;
  }

  // The other eight are the roster catch-up doing its own job; this test is
  // only about the one whose identity moved.
  assert.deepEqual(
    store.writes.enrolled
      .filter(({ id }) => id === "yvncv")
      .map(({ gameName, tagLine }) => [gameName, tagLine]),
    [["yvncvNEW", "LAS"]],
  );
  const changed = lines.map((line) => JSON.parse(line))
    .find((entry) => entry.event === "lp_tracker_identity_changed");
  assert.equal(changed.from, "yvncv#0521");
  assert.equal(changed.to, "yvncvNEW#LAS");
});

test("leaves an unchanged identity alone instead of rewriting it every minute", async () => {
  const players = [{
    playerId: "yvncv", puuid: "puuid-yvncv", gameName: "yvncv", tagLine: "0521", recentMatchId: null,
  }];
  const observations = [{
    id: "yvncv:1000", playerId: "yvncv", observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }];
  const store = fakeStore(players, observations, []);

  await runTemporalLpTracker({
    store, apiKey: "secret", now: 5_000, owner: "run-same-name",
    fetchImpl: (input) => {
      const url = String(input);
      if (url.includes("/accounts/by-puuid/")) {
        return Promise.resolve(new Response(JSON.stringify({
          puuid: "puuid-yvncv", gameName: "yvncv", tagLine: "0521",
        }), { status: 200 }));
      }
      return Promise.resolve(riotResponse(url, { count: 0 }));
    },
  });

  assert.deepEqual(store.writes.enrolled.filter(({ id }) => id === "yvncv"), []);
});

test("sweeps stale observations hourly, not on every tick", async () => {
  // `rank_observations` grows by nine rows a minute and `loadTrackerState`
  // ranks all of them on every run, so without a sweep the read cost climbs
  // linearly forever. Running it every minute would be pointless churn.
  const players = [{
    playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null,
  }];
  const observations = [{
    id: "p1:1000", playerId: "p1", observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }];

  const onTheHour = 3_600_000 * 5;
  const sweeping = fakeStore(players, observations, []);
  await runTemporalLpTracker({
    store: sweeping, apiKey: "secret", now: onTheHour, owner: "run-sweep",
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
  });
  assert.deepEqual(sweeping.writes.pruned, [onTheHour - 7 * 24 * 60 * 60_000]);

  const quiet = fakeStore(players, observations, []);
  await runTemporalLpTracker({
    store: quiet, apiKey: "secret", now: onTheHour + 60_000, owner: "run-quiet",
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
  });
  assert.deepEqual(quiet.writes.pruned, []);
});
