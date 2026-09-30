import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-level contracts for behaviour that has no DOM harness here. They name
// what must stay true, not how a line is spelled; a CRLF checkout (the Windows
// default) is normalised first so the patterns never depend on line endings.
const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const sources = async () => {
  const [page, podium, standings, duos, gaspi, topBar, primitives, css] = await Promise.all([
    read("app/page.tsx"),
    read("components/leaderboard/podium.tsx"),
    read("components/leaderboard/standings.tsx"),
    read("components/leaderboard/duos.tsx"),
    read("components/leaderboard/gaspi.tsx"),
    read("components/leaderboard/top-bar.tsx"),
    read("components/leaderboard/primitives.tsx"),
    read("app/globals.css"),
  ]);
  return { page, podium, standings, duos, gaspi, topBar, primitives, css };
};

test("ranks everyone on one sorted list, podium first, so places and arrows count the same players", async () => {
  const { page, podium, standings } = await sources();
  assert.match(page, /const standings = payload \? sortLeaderboard\(payload\.data\.players\) : \[\]/);
  assert.match(podium, /standings\.slice\(0, 3\)\.map\(\(player, index\) =>/);
  assert.match(standings, /const rows = standings\.slice\(3\)/);
  assert.match(standings, /place=\{index \+ 4\}/);
  assert.match(standings, /function PlaceDelta/);
});

test("keeps the top three in numeric document order so focus follows reading order", async () => {
  const { css } = await sources();
  assert.doesNotMatch(css, /\.pcard[^{]*\{[^}]*\border\s*:/);
  assert.match(css, /\.pcard\.place-1\s*\{\s*grid-column:\s*1 \/ -1;/);
});

test("moves cards and rows when the standings move", async () => {
  const { podium, standings, page } = await sources();
  assert.match(podium, /<m\.article\s+layout/);
  assert.match(standings, /<m\.li\s+layout="position"/);
  assert.match(page, /<LazyMotion features=\{domMax\} strict>/);
  assert.match(page, /<MotionConfig reducedMotion="user">/);
});

test("puts Los Juegos de Gaspi behind the top-bar badge, reveals it once and invades the palette", async () => {
  const { page, gaspi, topBar, css } = await sources();
  assert.match(topBar, /aria-label=\{`Abrir \$\{GASPI_TITLE\}`\}/);
  assert.match(gaspi, /export const GASPI_TITLE = "LOS JUEGOS DE GASPI"/);
  assert.match(gaspi, /<Dialog\.Root open=\{open\} onOpenChange=\{onOpenChange\}>/);
  assert.match(gaspi, /seen \? undefined : \{ animationDelay:/);
  assert.match(page, /setGaspiSeen\(gaspiRevealSpent\.current\);\s*gaspiRevealSpent\.current = true;/);
  assert.match(page, /playHelicopter\(\);/);
  assert.match(gaspi, /if \(helicopterPlayed\) return;/);
  assert.match(page, /document\.documentElement\.classList\.add\("is-invaded"\)/);
  assert.match(css, /html\.is-invaded\s*\{[^}]*--bg:/);
  assert.match(css, /@property --bg \{ syntax: "<color>"/);
  assert.match(css, /\.gaspi\.is-seen \.gaspi__letter \{ animation: none; \}/);
});

test("sends Papipu to respawn after the curfew and ticks while anyone is counting", async () => {
  const { page, primitives, standings, podium } = await sources();
  assert.match(page, /papipuRespawnSeconds\(clockNow\)/);
  assert.match(page, /player\.gameName\.toLocaleLowerCase\("es-PE"\) === "papipu"/);
  assert.match(page, /const needsSecondTicks = papipuSeconds !== null \|\| liveCount > 0;/);
  assert.match(page, /nextPeruHourUtc\(clockNow, PAPIPU_CURFEW_HOUR\)/);
  assert.match(page, /const PAPIPU_CURFEW_HOUR = 23;/);
  assert.match(primitives, /Reaparece en/);
  assert.match(primitives, /Papipu, ya son las 11/);
  assert.match(primitives, /role="timer"/);
  assert.match(standings, /<RespawnPill seconds=\{respawnSeconds\}/);
  assert.match(podium, /<RespawnPill seconds=\{respawnSeconds\}/);
});

test("rotates a playful tab title while the page is away, one line at a time", async () => {
  const { page } = await sources();
  assert.match(page, /"Papipu ya son las 11"/);
  assert.match(page, /"Bienvenidos a los juegos de Gaspi": "de Gaspi"/);
  assert.match(page, /if \(bag\.length === 0\) bag = \[\.\.\.awayTabTitles\];/);
  assert.match(page, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
});

test("polls every minute, pauses while hidden and catches up on return", async () => {
  const { page } = await sources();
  assert.match(page, /const LEADERBOARD_REFRESH_MS = 60_000;/);
  assert.match(page, /window\.setInterval\(\(\) => \{\s*void loadLeaderboard\(\);\s*\}, LEADERBOARD_REFRESH_MS\)/);
  assert.match(page, /if \(document\.visibilityState === "hidden"\) \{\s*window\.clearInterval\(pollTimer\);/);
  assert.match(page, /cache: "no-store"/);
  assert.match(page, /const LEADERBOARD_STORAGE_KEY = "20q-leaderboard-payload-v1";/);
});

test("reads the VPS API from production and its previews, and its own route anywhere else", async () => {
  const { page } = await sources();
  assert.match(page, /NEXT_PUBLIC_LEADERBOARD_API_ORIGIN/);
  assert.match(page, /\/\(\^\|\\\.\)20q-challenge\\\.pages\\\.dev\$\//);
  assert.match(page, /return "\/api\/leaderboard";/);
});

test("distinguishes loading from a first-load network error, and keeps the top bar free of manual refresh", async () => {
  const { page, topBar, css } = await sources();
  assert.match(page, /aria-busy=\{pending && !unreachable\}/);
  assert.match(page, /role="alert"/);
  // The board refreshes itself; the top bar only says something while a game is live.
  assert.doesNotMatch(topBar, /Actualizar|Actualizado|RefreshIcon|onRefresh/);
  assert.doesNotMatch(css, /\.topbar__status|\.status-dot|\.icon-button/);
  assert.match(topBar, /liveCount > 0 \?/);
});

test("keeps the section links as plain scroll shortcuts that do not follow or force the scroll", async () => {
  const { page, topBar } = await sources();
  // They move the scroll and nothing else: no hash in the URL, no "current" state, no scroll listeners.
  assert.match(topBar, /event\.preventDefault\(\);\s*target\.scrollIntoView\(\{ block: "start" \}\);/);
  assert.doesNotMatch(topBar, /addEventListener|is-current|aria-current|useState|useEffect/);
  // A hash left by an older visit is dropped once, when the page loads.
  assert.match(page, /window\.history\.replaceState\(null, "", `\$\{pathname\}\$\{search\}`\)/);
});

test("draws champions as rows whose solid bar is the adjusted winrate and whose tail is the observed one", async () => {
  const { primitives, css } = await sources();
  assert.match(primitives, /className="wr-track__observed" style=\{\{ width: `\$\{champion\.winRate\}%` \}\}/);
  assert.match(primitives, /className="wr-track__adjusted" style=\{\{ width: `\$\{champion\.adjusted\}%` \}\}/);
  assert.match(primitives, /aria-label=\{`\$\{champion\.name\}: \$\{champion\.games\} partidas, \$\{champion\.winRate\}% de winrate`\}/);
  assert.match(css, /\.wr-track__observed \{ background: var\(--win-soft\); \}/);
  assert.match(css, /\.wr-track__adjusted \{ background: var\(--win\); \}/);
});

test("keeps the five form slots visible even with no games", async () => {
  const { primitives, css } = await sources();
  assert.match(primitives, /form\.slots\.map\(\(slot, index\) => <i key=\{index\} className=\{`pill is-\$\{slot\}`\} \/>\)/);
  assert.match(css, /\.pill \{[^}]*box-shadow: inset 0 0 0 1px var\(--line-strong\)/);
});

test("names the live game, remakes and missing PL evidence honestly", async () => {
  const { primitives } = await sources();
  assert.match(primitives, /const live = player\.liveGame;/);
  assert.match(primitives, /En partida/);
  assert.match(primitives, /if \(isRemakeMatch\(match\)\) return "remake";/);
  assert.match(primitives, /title=\{lpEvidenceTitle\(match\.lpChangeEvidence, remake\)\}/);
  assert.match(primitives, /matchDetailsUrl\(match\.matchId\) \?\? profileUrl\(player\)/);
});

test("opens a row's detail from its button, with the row itself as a pointer shortcut", async () => {
  const { standings } = await sources();
  assert.match(standings, /aria-expanded=\{open\}/);
  assert.match(standings, /aria-controls=\{detailId\}/);
  assert.match(standings, /if \(\(event\.target as HTMLElement\)\.closest\("a, button"\)\) return;/);
  assert.match(standings, /aria-pressed=\{order === "best"\}/);
  assert.match(standings, /<AnimatePresence initial=\{false\}>/);
  assert.match(standings, /is-self/);
  assert.match(standings, /is-peer/);
});

test("lets a podium card show a row detail's roles and summary in place, at one height", async () => {
  const { podium, standings, css } = await sources();
  assert.match(podium, /\["best", "Mejores"\],\s*\["most", "Más jugados"\],\s*\["roles", "Roles"\],\s*\["summary", "Resumen"\],/);
  for (const source of [podium, standings]) {
    assert.match(source, /<RoleList player=\{player\} \/>/);
    assert.match(source, /<PlayerSummary player=\{player\} roster=\{roster\} version=\{version\} \/>/);
  }
  assert.match(css, /\.pcard__panel \{ margin-top: 12px; min-height: 164px; \}/);
});

test("gives the podium and the table their own headings and keeps the duos title visible", async () => {
  const { page, podium, standings, duos } = await sources();
  assert.match(page, /<h1 className="sr-only">20Q Challenge · Clasificación<\/h1>/);
  assert.match(podium, /<h2 id="podio-title" className="sr-only">Top 3 del ranking<\/h2>/);
  assert.match(standings, /<h2 id="resto-title" className="sr-only">Resto de la clasificación<\/h2>/);
  assert.match(duos, /<h2 id="duos-title">Mejores dúos<\/h2>/);
  assert.match(duos, /Mínimo \{DUO_LEADERBOARD_MIN_GAMES\} partidas juntos/);
});

test("keeps the skip link, the legal links and the Riot disclaimer in English", async () => {
  const { page, css } = await sources();
  assert.match(page, /<a className="skip-link" href="#clasificacion">Ir al ranking<\/a>/);
  assert.match(page, /href="\/privacy"/);
  assert.match(page, /href="\/terms"/);
  assert.match(page, /<p lang="en">20Q Challenge is not endorsed by Riot Games/);
  assert.match(css, /scroll-padding-top: calc\(var\(--topbar-h\) \+ 16px\)/);
});

test("lays the board out for wide desktops, half screens and phones", async () => {
  const { css } = await sources();
  for (const breakpoint of [1359, 1199, 959, 719]) {
    assert.match(css, new RegExp(`@media \\(max-width: ${breakpoint}px\\)`));
  }
  assert.match(css, /@container pcard \(min-width: 820px\)/);
  // The plate is two equal halves, the rank and the 2×2 figures, with a stitch between them and no box
  // around either; only a plate too narrow for both side by side stacks them.
  assert.match(css, /\.plate__grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.plate__stats::before \{/);
  assert.doesNotMatch(css, /\.plate(__stats)? \{[^}]*\bborder\b/);
  assert.match(css, /@container plate \(max-width: 269px\) \{\s*\.plate__grid \{ grid-template-columns: 1fr;/);
  assert.match(css, /\.srow__stats \{ display: contents; \}/);
});

test("respects reduced motion and keeps focus visible", async () => {
  const { css } = await sources();
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /a:focus-visible, button:focus-visible/);
});

test("drains the borrowed Iron crest for unranked players", async () => {
  const { primitives, css } = await sources();
  assert.match(primitives, /tier === "UNRANKED" \? " is-unranked" : ""/);
  assert.match(css, /\.emblem\.is-unranked \{ filter: grayscale\(1\)/);
});
