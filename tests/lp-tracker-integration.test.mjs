import assert from "node:assert/strict";
import test from "node:test";

import { MATCH_DETAILS_PER_RUN, runTemporalLpTracker } from "../lib/lp-tracker.ts";
import { RIOT_PLAYERS } from "../lib/riot-client.ts";
import { RiotRequestBudgetExceeded, TRACKER_REQUEST_BUDGET } from "../lib/riot-request.ts";
import { resetChampionCatalog } from "../lib/champion-catalog.ts";
import { createDemoSnapshot } from "../lib/leaderboard.ts";

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
  const writes = { observations: [], sessions: [], candidates: [], evidence: [], cursors: [], enrolled: [], pruned: [], renewals: [] };
  return {
    writes,
    async acquireLease() { return true; },
    async renewLease(name, owner, expiresAt) { writes.renewals.push({ name, owner, expiresAt }); },
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
    const puuid = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    const identity = RIOT_PLAYERS.find((player) => player.puuid === puuid);
    return new Response(JSON.stringify({
      puuid,
      gameName: identity?.gameName ?? "Player",
      tagLine: identity?.tagLine ?? "LAS",
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
  // Sessions are persisted twice now — once before the match details are
  // fetched, so a run killed in between cannot strand a live card, and again
  // once linking has happened. The last write is the one that has to be right.
  assert.equal(store.writes.sessions.filter(({ platformGameId }) => platformGameId === "77").at(-1).status, "linked");
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

test("closes a finished game even when the run dies before its expensive half", async () => {
  // The fault behind Papipu's stuck card. A Worker terminated for exceeding its
  // 10 ms CPU budget stops mid-run, and every write used to happen at the end,
  // behind the Match-V5 downloads: rank observations were already persisted, the
  // session close was not. The row kept `status = 'active'` with a frozen
  // `last_seen_at`, so the board advertised a game that had finished — for
  // sixty-seven minutes, because each following run died in the same place.
  //
  // A kill is modelled here as the match-detail fetch never returning, which is
  // where the CPU actually went.
  const players = [{ playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null }];
  const observations = [{ id: "p1:1000", playerId: "p1", observedAt: 1_000, tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10 }];
  // Live as far as the store knows: the spectator 404 below is the game ending.
  const sessions = [{ playerId: "p1", platformGameId: "77", queueId: 420, baselineObservationId: "p1:1000", gameStartedAt: 1_500, firstSeenAt: 2_000, lastSeenAt: 3_000, endedDetectedAt: null, matchId: null, status: "active", updatedAt: 3_000 }];
  const store = fakeStore(players, observations, sessions);

  await assert.rejects(runTemporalLpTracker({
    store,
    apiKey: "secret",
    now: 5_000,
    owner: "run-killed",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/lol/match/v5/matches/LA2_")) throw new Error("Worker exceeded resource limits");
      return riotResponse(url, { count: 0 });
    },
  }));

  const closed = store.writes.sessions.find((session) => session.platformGameId === "77");
  assert.ok(closed, "the session must be persisted before the run risks itself");
  assert.equal(closed.status, "ended_waiting_match");
  assert.equal(closed.endedDetectedAt, 5_000);
});

test("renews the lane while it works, so a killed run does not hold it for its full TTL", async () => {
  // A killed run never reaches its `finally`, so nothing releases the lane and
  // the next four ticks were refused. Measured in production as rank
  // observations 297-301s apart for an hour: the cadence collapsed from one run
  // a minute to one every five. Renewal is what lets the TTL be short enough
  // that a dead run costs about a tick, without capping how long a live run may
  // legitimately take.
  const players = [{ playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null }];
  const observations = [{ id: "p1:1000", playerId: "p1", observedAt: 1_000, tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10 }];
  const store = fakeStore(players, observations, []);

  await runTemporalLpTracker({
    store, apiKey: "secret", now: 5_000, owner: "run-renew",
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
  });

  assert.ok(store.writes.renewals.length >= 2, "a run must renew as it crosses phases");
  for (const renewal of store.writes.renewals) {
    assert.equal(renewal.name, "lp-tracker");
    assert.equal(renewal.owner, "run-renew", "a run may only ever extend its own claim");
    assert.ok(
      renewal.expiresAt - Date.now() <= 90_000,
      "a renewal must not push the lane past the TTL a dead run would be held for",
    );
  }
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
  const recentMatchPolls = [];

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
        recentMatchPolls.push(playerNumber);
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

  // Idle history rotates by player, so this tick pays one recent-match request
  // and one newest detail. A later tick covers player 2, then player 3, while
  // active or post-game players remain priority every minute.
  assert.equal(downloadedMatchIds.length, 1);
  assert.deepEqual(recentMatchPolls, ["1"]);
  assert.deepEqual(
    downloadedMatchIds,
    ["LA2_1_latest"],
  );
  assert.equal(downloadedMatchIds.some((matchId) => matchId.includes("_older_")), false);
  // Only the players whose detail was actually downloaded get their cursor
  // moved; the rest keep theirs and are picked up on a following tick.
  assert.deepEqual(
    store.writes.cursors.filter(({ matchId }) => matchId !== null).map(({ playerId, matchId }) => [playerId, matchId]),
    [["p1", "LA2_1_latest"]],
  );
  assert.ok(result.requestsUsed <= TRACKER_REQUEST_BUDGET);
});

test("enrolls a roster member added after the initial bootstrap", async () => {
  // `bootstrapPlayerSyncState` only fires on a cold start, so before this the
  // last roster entry — yvncv#0521, added once the others were already synced —
  // never reached `player_sync_state` and every run polled around them.
  const [straggler, ...synced] = [...RIOT_PLAYERS].reverse();
  const players = synced.map((identity) => ({
    playerId: identity.id,
    puuid: identity.puuid,
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
  assert.equal(store.writes.enrolled[0].puuid, straggler.puuid);
});

test("a failing account lookup cannot fail a run that already did its work", async () => {
  // The catch-up runs last, after observations, sessions, evidence and the
  // projection are all persisted. Letting a 429 there escape marked a wholly
  // successful run as `failed` and told readers "Riot no respondió".
  const [straggler, ...synced] = [...RIOT_PLAYERS].reverse();
  const players = synced.map((identity) => ({
    playerId: identity.id,
    puuid: identity.puuid,
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
  const players = synced.map((identity) => ({
    playerId: identity.id,
    puuid: identity.puuid,
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
    detailsFetched <= MATCH_DETAILS_PER_RUN,
    `one tick downloaded ${detailsFetched} match details, over the ${MATCH_DETAILS_PER_RUN} cap`,
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

test("sweeps stale observations hourly by elapsed time, whatever minute the ticks land on", async () => {
  // `rank_observations` grows by nine rows a minute and `loadTrackerState`
  // ranks all of them on every run, so without a sweep the read cost climbs
  // linearly forever. Running it every minute would be pointless churn.
  //
  // It used to run on `minute % 60 === 0`. The timer's ticks drift 60–70 s
  // apart, so an hour whose ticks skipped that one minute was never swept.
  const players = [{
    playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null,
  }];
  const observations = [{
    id: "p1:1000", playerId: "p1", observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }];
  const store = fakeStore(players, observations, []);
  // The sweep lane behaves like the real lease: claimable once expired.
  const expiries = new Map();
  store.acquireLease = async (name, _owner, now, ttlMs) => {
    if (name === "lp-tracker") return true;
    if ((expiries.get(name) ?? 0) > now) return false;
    expiries.set(name, now + ttlMs);
    return true;
  };

  const hour = 60 * 60_000;
  const ticks = [
    5 * hour + 30_000, // sweeps: nothing has swept yet
    5 * hour + 95_000, // too soon
    5 * hour + 59 * 60_000 + 50_000, // still inside the hour
    6 * hour + 60_000, // 70 s later: the 6:00 minute had no tick at all
    6 * hour + 125_000,
  ];
  for (const [index, now] of ticks.entries()) {
    await runTemporalLpTracker({
      store, apiKey: "secret", now, owner: `run-sweep-${index}`,
      fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
    });
  }

  const retention = 7 * 24 * hour;
  assert.deepEqual(store.writes.pruned, [ticks[0] - retention, ticks[3] - retention]);
});

/** Runs the tracker with its structured log captured, whether it resolves or throws. */
async function runLogged(options) {
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  let result;
  let error;
  try {
    result = await runTemporalLpTracker(options);
  } catch (caught) {
    error = caught;
  } finally {
    console.log = realLog;
  }
  const entries = lines.map((line) => JSON.parse(line));
  return { result, error, run: entries.find((entry) => entry.event === "lp_tracker_run") };
}

function twoPlayerTick(extraSessions = []) {
  const players = ["p1", "p2"].map((playerId, index) => ({
    playerId, puuid: `puuid-${index + 1}`, gameName: playerId.toUpperCase(), tagLine: "LAS", recentMatchId: null,
  }));
  const observations = players.map((player) => ({
    id: `${player.playerId}:1000`, playerId: player.playerId, observedAt: 1_000,
    tier: "SILVER", division: "I", leaguePoints: 90, wins: 10, losses: 10,
  }));
  return fakeStore(players, observations, extraSessions);
}

/** `riotResponse`, except the rank lookup of the given puuids answers `status`. */
function failingRank(statusByPuuid, headers = {}) {
  return (input) => {
    const url = String(input);
    const failing = Object.entries(statusByPuuid)
      .find(([puuid]) => url.includes("/league/v4/") && url.endsWith(`/${puuid}`));
    return Promise.resolve(failing
      ? new Response("{}", { status: failing[1], headers })
      : riotResponse(url, { count: 0 }));
  };
}

test("one player's Riot 5xx skips that player and keeps everyone else's tick", async () => {
  // Seven ticks in a week died on a single "Riot is temporarily unavailable."
  // with nothing inserted for anyone. Only the player whose request failed
  // should lose the tick — and their live session must be left alone: a poll
  // that never completed is not evidence that the game ended.
  const liveSession = {
    playerId: "p2", platformGameId: "88", queueId: 420, baselineObservationId: "p2:1000",
    gameStartedAt: 3_000, firstSeenAt: 3_000, lastSeenAt: 4_000, endedDetectedAt: null,
    matchId: null, status: "active", updatedAt: 4_000,
  };
  const store = twoPlayerTick([liveSession]);

  const { result, error, run } = await runLogged({
    store, apiKey: "secret", now: 5_000, owner: "run-one-5xx",
    fetchImpl: failingRank({ "puuid-2": 503 }),
  });

  assert.equal(error, undefined);
  assert.equal(result.status, "completed");
  assert.equal(result.playerErrors, 1);
  assert.deepEqual(store.writes.observations.map(({ playerId }) => playerId), ["p1"]);
  assert.deepEqual(store.writes.sessions.filter(({ playerId }) => playerId === "p2"), [], "the live session must not be touched");
  assert.deepEqual([...new Set(store.writes.cursors.map(({ playerId }) => playerId))], ["p1"]);
  assert.equal(run.status, "completed");
  assert.equal(run.observationsInserted, 1);
  assert.equal(run.playerErrors, 1);
  assert.deepEqual(run.playerErrorDetails, [{ playerId: "p2", error: "Riot is temporarily unavailable." }]);
});

test("a tick in which every player fails is still a failed run", async () => {
  const store = twoPlayerTick();

  const { error, run } = await runLogged({
    store, apiKey: "secret", now: 5_000, owner: "run-all-5xx",
    fetchImpl: failingRank({ "puuid-1": 500, "puuid-2": 502 }),
  });

  assert.match(error?.message ?? "", /temporarily unavailable/);
  assert.equal(run.status, "failed");
  assert.equal(run.playerErrors, 2);
  assert.equal(run.observationsInserted, 0);
  assert.deepEqual(store.writes.observations, []);
});

test("a rejected key still aborts the whole tick", async () => {
  // A 401 is about the key, so every other player would fail the same way.
  const store = twoPlayerTick();

  const { error, run } = await runLogged({
    store, apiKey: "secret", now: 5_000, owner: "run-401",
    fetchImpl: failingRank({ "puuid-1": 401 }),
  });

  assert.match(error?.message ?? "", /authentication failed/);
  assert.equal(run.status, "failed");
  assert.deepEqual(store.writes.observations, [], "nothing is persisted from an aborted tick");
});

test("an exhausted request budget still aborts the whole tick", async () => {
  const store = twoPlayerTick();

  const { error, run } = await runLogged({
    store, apiKey: "secret", now: 5_000, owner: "run-no-budget-left", maxRequests: 1,
    fetchImpl: (input) => Promise.resolve(riotResponse(String(input), { count: 0 })),
  });

  assert.ok(error instanceof RiotRequestBudgetExceeded);
  assert.equal(run.status, "failed");
  assert.deepEqual(store.writes.observations, []);
});

test("a throttled key ends the tick as rate_limited and blocks the lane for Riot's window", async () => {
  const store = twoPlayerTick();
  const blocked = [];
  store.blockLaneUntil = async (lane, until) => blocked.push({ lane, until });
  const before = Date.now();

  const { error, run } = await runLogged({
    store, apiKey: "secret", now: 5_000, owner: "run-429",
    fetchImpl: failingRank({ "puuid-1": 429 }, { "Retry-After": "30" }),
  });

  assert.match(error?.message ?? "", /rate limit/);
  assert.equal(run.status, "rate_limited");
  assert.ok(run.blockedUntil >= before + 30_000);
  assert.deepEqual(blocked.map(({ lane }) => lane), ["lp-tracker"]);
  assert.ok(blocked[0].until >= before + 30_000, "the lane stays shut for the whole Retry-After");
  assert.ok(Date.now() - before < 10_000, "and nobody slept through it");
});

test("the cold-start bootstrap keeps the players it could poll", async () => {
  const store = fakeStore([], [], []);
  const snapshot = createDemoSnapshot(new Date(0));
  for (const player of snapshot.players) {
    player.puuid = RIOT_PLAYERS.find(({ id }) => id === player.id)?.puuid ?? null;
  }
  store.loadTrackerState = async () => ({ players: [], observations: [], sessions: [], candidates: [], snapshot });
  const [unlucky] = RIOT_PLAYERS;

  const { result, error, run } = await runLogged({
    store, apiKey: "secret", now: 5_000, owner: "run-bootstrap-5xx",
    fetchImpl: failingRank({ [unlucky.puuid]: 500 }),
  });

  assert.equal(error, undefined);
  assert.equal(result.status, "bootstrapped");
  assert.equal(result.playerErrors, 1);
  assert.equal(store.writes.observations.length, RIOT_PLAYERS.length - 1);
  assert.equal(store.writes.observations.some(({ playerId }) => playerId === unlucky.id), false);
  assert.equal(store.writes.cursors.some(({ playerId }) => playerId === unlucky.id), false);
  assert.deepEqual(run.playerErrorDetails, [{ playerId: unlucky.id, error: "Riot is temporarily unavailable." }]);
});
