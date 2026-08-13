import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("returns a safe demo leaderboard when the Riot secret is not configured", async () => {
  const response = await render("/api/leaderboard");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  // Shared at the edge on purpose: the payload is public and identical for
  // everyone, so several viewers must not each cost an invocation. It was
  // `private, no-store`, and the endpoint fell over once a handful of browsers
  // had the page open at once.
  assert.match(response.headers.get("cache-control") ?? "", /^public,/);
  assert.match(response.headers.get("cache-control") ?? "", /s-maxage=\d+/);

  const payload = await response.json();
  assert.equal(payload.meta.source, "demo");
  assert.equal(payload.meta.cacheTtlSeconds, 60);
  assert.equal(payload.data.region, "LAS");
  assert.equal(payload.data.platform, "LA2");
  assert.equal(payload.data.players.length, 9);
  assert.equal("RIOT_API_KEY" in payload, false);
});

test("server-renders the 20Q Challenge dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="es">/i);
  assert.match(html, /<title>20Q Challenge<\/title>/i);
  assert.doesNotMatch(html, /<title>[^<]*(?:—|SoloQ 2026)[^<]*<\/title>/i);
  assert.match(html, /20Q Challenge/);
  assert.doesNotMatch(html, /20Q \/ LAS|>Clasificación</i);
  assert.match(html, /Meta del challenge:/i);
  assert.match(html, /Top 3 del ranking/);
  assert.match(html, />Rol</);
  assert.doesNotMatch(html, /Rol principal/);
  assert.doesNotMatch(html, /del historial/i);
  assert.match(html, />Rango</);
  assert.match(html, /class="podium-champions champions"/);
  assert.match(html, /Última partida/i);
  assert.doesNotMatch(html, /Campeones más jugados/);
  assert.match(html, /KDA/);
  assert.doesNotMatch(html, /Datos actualizados|sync-state/);
  assert.match(html, /leaderboard-panel is-loading/);
  assert.match(html, /class="sk-bone/);
  assert.match(html, /class="podium-card place-1 is-pending"/);
  assert.match(html, /class="leaderboard-row is-pending"/);
  assert.match(html, /class="champion-portrait sk-slot"/);
  assert.doesNotMatch(html, /is-skeleton/);
  assert.doesNotMatch(html, /pattern-grid/);
  assert.doesNotMatch(html, /class="hatch"/);
  assert.match(html, /src="\/ranks\/iron\.png"/);
  assert.match(html, /class="lp-unit/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
  assert.doesNotMatch(html, /\/_vinext\/image\?url=%2Franks/i);
  assert.match(html, /is not endorsed by Riot Games/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/i);
});

test("leaves dist/client shaped the way Pages expects to deploy it", async () => {
  // `vinext build` empties dist/client, so a plain `npm run build` strips the
  // worker back out of the deploy directory. That made `npm run verify` — the
  // documented pre-flight — the one command guaranteed to leave a directory
  // that serves 404 for every route. `npm test` now runs `build:pages`, and
  // this asserts the result so the packaging step cannot regress silently.
  const client = new URL("../dist/client/", import.meta.url);
  await access(new URL("_worker.js/index.js", client));
  await access(new URL("_worker.js/ssr/index.js", client));
  await access(new URL("ranks/gold.png", client));

  // The Workers deploy descriptor must not ride along inside the bundle: Pages
  // takes its bindings from the project, and shipping a second opinion — one
  // still naming the Sites placeholder database — invites the two to disagree.
  await assert.rejects(access(new URL("_worker.js/wrangler.json", client)));

  // Without this Pages routes every request through the Worker, which answered
  // the build's own hashed assets with a 404: the site shipped as unstyled HTML
  // with no client bundle. Each excluded path is also one fewer billable
  // Function invocation.
  const routes = JSON.parse(await readFile(new URL("_routes.json", client), "utf8"));
  assert.deepEqual(routes.include, ["/*"]);
  for (const path of ["/assets/*", "/ranks/*", "/favicon.png", "/og.jpg", "/brand-logo.webp"]) {
    assert.ok(routes.exclude.includes(path), `${path} must be served by Pages, not the Worker`);
  }

  // The stylesheet the HTML asks for has to be one of the files actually
  // shipped — a hash mismatch here is invisible until the page renders bare.
  const html = await (await render("/")).text();
  const stylesheet = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  assert.ok(stylesheet, "the rendered HTML must reference a built stylesheet");
  await access(new URL(`.${stylesheet}`, client));
});

test("ships the finished product assets without starter dependencies", async () => {
  // Several of these assertions span line breaks, which a CRLF checkout — the
  // default on Windows — would fail for reasons unrelated to the code.
  const readSource = async (path) =>
    (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const [page, layout, css, packageJson] = await Promise.all([
    readSource("../app/page.tsx"),
    readSource("../app/layout.tsx"),
    readSource("../app/globals.css"),
    readSource("../package.json"),
  ]);

  assert.match(page, /useState/);
  assert.doesNotMatch(page, /sync-state|Datos actualizados/);
  assert.match(page, /fetch\("\/api\/leaderboard"/);
  assert.match(page, /const LEADERBOARD_REFRESH_MS = 60_000/);
  assert.match(page, /window\.setInterval\([\s\S]*?void loadLeaderboard\(\)[\s\S]*?LEADERBOARD_REFRESH_MS/);
  assert.match(page, /void loadLeaderboard\(\)/);
  assert.match(page, /El marcador se actualiza automáticamente aproximadamente cada minuto/);
  assert.match(page, /caché de 1 min/);
  assert.match(page, /aria-busy=/);
  assert.match(page, /leagueofgraphs\.com\/summoner\/las/);
  assert.match(page, /const mamimu = players\.find\(\(player\) => player\.id === CHALLENGE_GOAL_PLAYER_ID\)/);
  assert.match(page, /function MatchSummary/);
  assert.match(page, /function LiveSummary/);
  assert.match(page, /is-peer/);
  assert.match(page, /matchDetailsUrl/);
  assert.match(page, /src="\/brand-logo\.webp"/);
  assert.match(layout, /lang="es"/);
  assert.match(layout, /const title = "20Q Challenge"/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /\/og\.jpg/);
  assert.match(layout, /icon: "\/favicon\.png"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /a:focus-visible/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /\.site-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/i);
  assert.match(css, /\.site-header\s*\{[^}]*border-bottom:\s*1px\s+solid\s+var\(--line\)/i);
  assert.doesNotMatch(css, /\.brand\s*\{[^}]*border-right\s*:/i);
  assert.match(css, /\.goal-card\s*\{[^}]*display:\s*grid/i);
  assert.match(css, /\.podium-card\.place-1\s*\{[^}]*linear-gradient/i);
  assert.match(css, /\.podium-card\.place-2\s*\{[^}]*linear-gradient/i);
  assert.match(css, /\.podium-card\.place-3\s*\{[^}]*linear-gradient/i);
  assert.match(page, /className="podium-splash is-aligned"/);
  assert.match(page, /crossOrigin="anonymous"/);
  assert.match(page, /function championLoadingAsset\(champion/);
  assert.match(page, /img\/champion\/loading\//);
  assert.doesNotMatch(page, /function championCenteredAsset|img\/champion\/centered\//);
  assert.match(css, /\.podium-splash\s*\{[\s\S]*?object-fit:\s*cover/i);
  assert.match(css, /\.podium-splash\s*\{[\s\S]*?object-position:\s*50%\s*0%/i);
  assert.match(css, /\.podium-splash\s*\{[\s\S]*?width:\s*100%;\s*height:\s*100%/i);
  assert.doesNotMatch(css, /\.lp-bar\s*>?\s*\{/i);
  assert.doesNotMatch(css, /\.goal-track\s*\{/i);
  assert.match(css, /\.wr-bar\s*\{/i);
  assert.match(css, /\.tier-gold\s*\{/i);
  assert.doesNotMatch(css, /\.row-player::(?:before|after)/i);
  assert.match(css, /\.row-player:is\(:hover,\s*:focus-visible\)\s*>\s*img[^}]*transform:\s*scale\(1\.03\)/i);
  assert.match(css, /\.podium-identity:is\(:hover,\s*:focus-visible\)\s+strong\s*\{\s*color:\s*var\(--gold\)/i);
  assert.doesNotMatch(css, /\.leaderboard-panel\.is-loading\s*>\s*:not\(\.pattern-grid\)\s*\{[^}]*visibility:\s*hidden/i);
  assert.doesNotMatch(css, /\.leaderboard-panel\.is-loading\s+\.podium-card::before/i);
  assert.doesNotMatch(css, /\.leaderboard-panel\.is-loading\s+\.leaderboard-row::before/i);
  assert.match(css, /@keyframes\s+sk-sweep/i);
  assert.match(css, /@keyframes\s+podium-enter/i);
  assert.match(css, /@keyframes\s+row-enter/i);
  assert.doesNotMatch(css, /\.hatch/i);
  // The heading and the rows share one track list, which is what keeps the
  // columns aligned. Asserting it whole, once: the two overlapping fragments
  // this replaced pinned 186px and 430px and had both been wrong since the
  // spacing commit, so the suite was red on main without saying anything useful.
  assert.match(
    css,
    /\.table-heading,\s*\.row-grid\s*\{[\s\S]*?grid-template-columns:\s*30px\s+minmax\(150px,\s*1fr\)\s+203px\s+minmax\(180px,\s*1fr\)\s+44px\s+150px\s+413px/i,
  );
  assert.match(css, /\.site-header::before\s*\{[^}]*width:\s*100vw/i);
  assert.match(css, /\.site-header\.is-scrolled::before\s*\{[^}]*opacity:\s*1/i);
  assert.match(css, /\.app-shell\s*\{[^}]*padding:\s*0\s+0\s+24px/i);
  assert.match(page, /slots=\{PODIUM_CHAMPION_SLOTS\} className="podium-champions champions" showGames/);
  assert.match(page, /slots=\{ROW_CHAMPION_SLOTS\} className="row-champions champions"/);
  assert.match(page, /const PODIUM_CHAMPION_SLOTS = 5/);
  assert.match(page, /const ROW_CHAMPION_SLOTS = 4/);
  assert.match(page, /Array\.from\(\{ length: 10 \}/);
  assert.doesNotMatch(page, /role="progressbar"[^>]*Progreso hacia la próxima división/i);
  assert.match(page, /className="lp-unit"/);
  assert.match(page, /className="wr-bar"/);
  assert.doesNotMatch(page, /sk-role-block|sk-match-roster/);
  assert.match(css, /\.podium-champions\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/i);
  assert.match(css, /\.podium-strip/);
  assert.match(page, /className="match-row"/);
  assert.match(css, /\.roster\s*>\s*span\.is-peer/);
  assert.doesNotMatch(css, /\.leaderboard-panel::after/);
  assert.match(css, /\.rank-emblem\.tier-bronze\s*\{[^}]*--rank-scale:\s*1\.21/i);
  assert.match(css, /\.table-heading\s*\{[^}]*font-size:\s*10px/i);
  assert.match(css, /\.podium-identity\s*>\s*span\s*\{[^}]*text-align:\s*left/i);
  // The emblem track reserves --rank-box (64px), not the 42px the image itself
  // occupies: .rank-emblem scales per tier via `transform`, which never enters
  // layout, so an Iron crest paints 63px wide over a 42px box and used to push
  // the rank label off the column's shared axis.
  assert.match(css, /\.row-rank\s*\{[^}]*grid-template-columns:\s*46px\s+minmax\(0,\s*1fr\)/i);
  assert.match(css, /\.podium-strip\s*\{[^}]*border-top:\s*1px\s+solid/i);
  assert.match(css, /mask-image:\s*linear-gradient\(180deg[^;]*transparent\s+86%\)/i);
  assert.match(page, /className="goal-label">Meta<\/span>/);
  assert.match(page, /className="role-share">\{player\.analytics\.roleShare\}%/);
  assert.match(css, /\.podium-rank\s*\{[^}]*column-gap:\s*8px/i);
  assert.match(css, /\.podium-lp\s*\{[^}]*display:\s*inline-flex[^}]*gap:\s*7px/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await Promise.all(
    [
      "iron",
      "bronze",
      "silver",
      "gold",
      "platinum",
      "emerald",
      "diamond",
      "master",
      "grandmaster",
      "challenger",
    ].map((tier) => access(new URL(`../public/ranks/${tier}.png`, import.meta.url))),
  );
  await access(new URL("../public/favicon.png", import.meta.url));
  await access(new URL("../public/brand-logo.webp", import.meta.url));
  await access(new URL("../public/og.jpg", import.meta.url));

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
