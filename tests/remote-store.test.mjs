import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteLpTrackerStore } from "../lib/remote-lp-tracker-store.ts";

const SECRET = "s".repeat(64);

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return handler(JSON.parse(String(init.body)));
  };
  return { calls, fetchImpl };
}

test("sends each store call as an allowlisted method with its arguments", async () => {
  const { calls, fetchImpl } = recordingFetch(() => Response.json({ result: true }));
  const store = createRemoteLpTrackerStore({ origin: "https://example.test/", secret: SECRET, fetchImpl });

  const acquired = await store.acquireLease("lp-tracker", "owner-1", 1_000, 90_000);

  assert.equal(acquired, true);
  assert.equal(calls.length, 1);
  // The trailing slash on the origin must not produce a double slash: the
  // endpoint would 404 and read as a rejected secret.
  assert.equal(calls[0].url, "https://example.test/api/cron/store");
  assert.equal(calls[0].init.headers["x-cron-secret"], SECRET);
  assert.deepEqual(calls[0].body, { method: "acquireLease", args: ["lp-tracker", "owner-1", 1_000, 90_000] });
});

test("carries the loaded tracker state back unchanged", async () => {
  const state = {
    players: [{ playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null }],
    observations: [], sessions: [], candidates: [], snapshot: null,
  };
  const { fetchImpl } = recordingFetch((body) =>
    body.method === "loadTrackerState" ? Response.json({ result: state }) : Response.json({ result: null }));
  const store = createRemoteLpTrackerStore({ origin: "https://example.test", secret: SECRET, fetchImpl });

  assert.deepEqual(await store.loadTrackerState(["p1"]), state);
});

test("names a refused secret as a refused secret, not a missing route", async () => {
  // The store endpoint answers 404 to a wrong or unset secret so it cannot be
  // probed. Reported as a plain 404 it sends you looking for a broken deploy.
  const { fetchImpl } = recordingFetch(() => new Response("Not found", { status: 404 }));
  const store = createRemoteLpTrackerStore({ origin: "https://example.test", secret: SECRET, fetchImpl });

  await assert.rejects(store.insertRankObservations([]), /rejected the cron secret/);
});

test("surfaces a failing store call instead of resolving with nothing", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("Store call failed", { status: 500 }));
  const store = createRemoteLpTrackerStore({ origin: "https://example.test", secret: SECRET, fetchImpl });

  await assert.rejects(store.upsertGameSessions([]), /failed \(500\)/);
});

test("refuses to be built without a secret", () => {
  assert.throws(
    () => createRemoteLpTrackerStore({ origin: "https://example.test", secret: "   " }),
    /cron secret is required/,
  );
});

test("implements every method the tracker calls on its store", async () => {
  // The runner drives the real `runTemporalLpTracker`, so a method missing here
  // is not a type error at the call site — it is a crash one tick later, in
  // production, on whichever branch happens to reach it first.
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../db/lp-tracker-store.ts", import.meta.url), "utf8"));
  const declared = [...source.matchAll(/^\s{4}(?:async )?(\w+)\(/gm)].map((match) => match[1]);

  const { fetchImpl } = recordingFetch(() => Response.json({ result: null }));
  const store = createRemoteLpTrackerStore({ origin: "https://example.test", secret: SECRET, fetchImpl });

  for (const method of declared) {
    assert.equal(typeof store[method], "function", `the remote store is missing ${method}`);
  }
  assert.ok(declared.length >= 12, `expected the store to declare its methods, found ${declared.length}`);
});
