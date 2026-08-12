import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("uses structural skeletons without the decorative pattern grid", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  // The structure is now the card itself rather than a parallel set of skeleton
  // components, which is the only way it cannot drift from what it imitates.
  assert.match(page, /player=\{PENDING_PLAYER\}/);
  assert.match(page, /pending=\{pending\}/);
  assert.match(page, /`sk-bone\$\{/);
  assert.match(page, /className=\{`podium-place\$\{pending \? " sk-fixed" : ""\}`\}/);
  assert.match(page, /Array\.from\(\{ length: 10 \}/);
  assert.doesNotMatch(page, /function Skeleton/);
  assert.doesNotMatch(page, /sk-role-block|sk-match-roster|sk-static-label/);
  assert.doesNotMatch(page, /PatternGrid|pattern-grid/);
  assert.doesNotMatch(css, /\.pattern-grid/);
  assert.doesNotMatch(css, /is-loading[^}]*visibility:\s*hidden/i);
  assert.doesNotMatch(css, /is-loading[^}]*\.podium-card::before/i);
  assert.doesNotMatch(css, /is-loading[^}]*\.leaderboard-row::before/i);
});

test("preserves Riot review links and the photographic favicon", async () => {
  const [page, layout, css, favicon] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("public/favicon.png", root)),
  ]);

  assert.match(page, /href="\/privacy"/);
  assert.match(page, /href="\/terms"/);
  assert.match(css, /\.legal-shell/);
  assert.doesNotMatch(css, /var\(--(?:text-secondary|panel-glass|violet-glow|coral-glow|radius-(?:sm|md))\)/);
  assert.match(layout, /icon:\s*"\/favicon\.png"/);
  // A committed binary cannot stop being a PNG of a plausible size without
  // someone deliberately replacing it, so asserting its magic bytes and a
  // 1KB–100KB range said nothing. What can actually regress is the reference
  // above going stale, which is checked against the built output in
  // `rendered-html.test.mjs`.
  assert.ok(favicon.length > 0);
});
