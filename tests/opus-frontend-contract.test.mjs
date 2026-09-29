import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");

test("builds the loading view from the real card and row frames, out of the accessibility tree", async () => {
  const [podium, standings, css] = await Promise.all([
    read("components/leaderboard/podium.tsx"),
    read("components/leaderboard/standings.tsx"),
    read("app/globals.css"),
  ]);

  // The skeleton reuses the card's own classes, so it cannot drift from what it imitates.
  assert.match(podium, /<article className=\{`pcard place-\$\{place\} is-pending`\} aria-hidden="true">/);
  assert.match(standings, /<li className="srow is-pending" aria-hidden="true">/);
  assert.match(podium, /\[1, 2, 3\]\.map\(\(place\) => <PodiumSkeleton key=\{place\} place=\{place\} \/>\)/);
  assert.match(css, /@keyframes sk-sweep/);
  assert.doesNotMatch(podium + standings, /PatternGrid|pattern-grid/);
});

test("preserves Riot review links and the photographic favicon", async () => {
  const [page, layout, css, favicon] = await Promise.all([
    read("app/page.tsx"),
    read("app/layout.tsx"),
    read("app/globals.css"),
    readFile(new URL("public/favicon.png", root)),
  ]);

  assert.match(page, /href="\/privacy"/);
  assert.match(page, /href="\/terms"/);
  assert.match(css, /\.legal-shell/);
  assert.match(layout, /icon:\s*"\/favicon\.png"/);
  assert.ok(favicon.length > 0);
});
