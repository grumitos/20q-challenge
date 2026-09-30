import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-level contracts for behaviour that has no DOM harness here. They name
// what must stay true, not how a line is spelled; a CRLF checkout (the Windows
// default) is normalised first so the patterns never depend on line endings.
const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const sources = async () => {
  const [page, podium, standings, duos, gaspi, gaspiDoor, topBar, primitives, panel, css] = await Promise.all([
    read("app/page.tsx"),
    read("components/leaderboard/podium.tsx"),
    read("components/leaderboard/standings.tsx"),
    read("components/leaderboard/duos.tsx"),
    read("components/leaderboard/gaspi.tsx"),
    read("components/leaderboard/gaspi-door.tsx"),
    read("components/leaderboard/top-bar.tsx"),
    read("components/leaderboard/primitives.tsx"),
    read("components/leaderboard/player-panel.tsx"),
    read("app/globals.css"),
  ]);
  return { page, podium, standings, duos, gaspi, gaspiDoor, topBar, primitives, panel, css };
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
  const { page, gaspi, gaspiDoor, topBar, css } = await sources();
  assert.match(topBar, /<GaspiDoor onOpen=\{onOpenGaspi\} \/>/);
  assert.match(gaspiDoor, /aria-label=\{`Abrir \$\{GASPI_TITLE\}`\}/);
  // The door wears the tournament's own mark, the title's gilded Cinzel, the same on every screen.
  assert.match(gaspiDoor, /<span className="gaspi-mark" aria-hidden="true">G<\/span>/);
  assert.match(css, /\.gaspi-mark \{\s*font-family: var\(--font-display\);/);
  // Its rim is metal-fx's liquid gold, loaded on the client in its own chunk, pinned to the dark tuning; without
  // WebGL, or should the metal fail, the still gilded rim stays. The wrapper never hides the door.
  assert.match(gaspiDoor, /import\("metal-fx"\)/);
  assert.match(gaspiDoor, /if \(!canRunMetal\(\)\) return;/);
  assert.match(gaspiDoor, /<MetalFallback fallback=\{door\}>/);
  assert.match(gaspiDoor, /preset="gold" theme="dark"/);
  assert.match(gaspiDoor, /paused=\{reduceMotion\} normalizeHostStyles=\{false\}/);
  assert.match(css, /\.gaspi-metal\.metal-fx-root \{[^}]*opacity: 1 !important;\s*visibility: visible !important;/);
  assert.match(css, /\.gaspi-metal \.gaspi-button \{ margin-left: 0; border-color: transparent; background: transparent; \}/);
  assert.match(gaspi, /export const GASPI_TITLE = "LOS JUEGOS DE GASPI"/);
  // The way back is a notice (Esc, or a tap on touch screens) and a click anywhere; no visible back pill.
  assert.doesNotMatch(gaspi + css, /gaspi__back/);
  assert.match(gaspi, /onClick=\{\(\) => onOpenChange\(false\)\}/);
  assert.match(gaspi, /<Dialog\.Close className="sr-only">Volver al ranking<\/Dialog\.Close>/);
  assert.match(gaspi, /Toca para volver/);
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
  assert.match(standings, /<RespawnClock seconds=\{respawnSeconds\}/);
  assert.match(podium, /<RespawnClock seconds=\{respawnSeconds\}/);
});

test("puts Papipu's whole card or row out of reach while the curfew clock runs", async () => {
  const { standings, podium, panel, css } = await sources();
  // The row stays closed, loses its toggle and ignores clicks; its cells, the player's included, are inert under the clock.
  assert.match(standings, /const isOpen = open && !dead;/);
  assert.match(standings, /if \(dead \|\| \(event\.target as HTMLElement\)\.closest\("a, button"\)\) return;/);
  assert.match(standings, /\{dead \? null : \(\s*<button\s+type="button"\s+className="srow__toggle"/);
  assert.match(standings, /<div className="srow__stats" inert=\{dead\}>/);
  assert.match(standings, /<a className="srow__player"[^>]*inert=\{dead\}>/);
  // The podium card goes inert under the clock and its panel loses the switch.
  assert.match(podium, /<div className="pcard__body" inert=\{dead\}>/);
  assert.match(podium, /still=\{dead\}/);
  assert.match(panel, /\{still \? null : \(\s*<div className="section-label panel__head">/);
  // Everything under the clock goes grey and soft, the player too: the form's pills and the winrate colours included.
  assert.match(css, /\.pcard\.is-dead :is\(\.pcard__main, \.pcard__side\) \{ filter: grayscale\(1\) blur\(1\.5px\); opacity: \.3; \}/);
  assert.match(css, /\.srow\.is-dead :is\(\.srow__place, \.srow__player, \.srow__rank, \.srow__wr, \.srow__kda, \.srow__form, \.srow__champs, \.srow__match\) \{ filter: grayscale\(1\) blur\(1\.5px\);/);
  // The clock lies centred over the whole row, not beside the player's cell.
  const rowClock = css.match(/\n\.srow__respawn \{[^}]*\}/)?.[0] ?? "";
  assert.match(rowClock, /position: absolute; inset: 0;/);
  assert.match(rowClock, /align-items: center; justify-content: center;/);
  assert.doesNotMatch(rowClock, /grid-column/);
  assert.match(css, /\.pcard__respawn \{\s*position: absolute; inset: 0;/);
  // On a phone the label and the clock share a line and the note goes under them.
  const phones = css.slice(css.indexOf("@media (max-width: 719px)"));
  assert.match(phones, /\.srow__respawn \.respawn__note \{ flex-basis: 100%; \}/);
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

test("draws a champion's bar as its season in grey under its last month in the result's ink", async () => {
  const { primitives, duos, css } = await sources();
  // The grey layer and the percentage are the season; the ink over it is the last month.
  assert.match(primitives, /className="wr-track__season" style=\{\{ width: `\$\{champion\.winRate\}%` \}\}/);
  assert.match(primitives, /className="wr-track__recent" style=\{\{ width: `\$\{Math\.max\(2, ink\.winRate\)\}%` \}\}/);
  assert.match(css, /\.wr-track__season \{ background: color-mix\(in srgb, var\(--text-3\) 32%, transparent\); \}/);
  assert.match(css, /\.wr-track__recent \{ background: var\(--bar\); \}/);
  // Not played lately: grey only. No recent records in the payload (an older API): the ink shows the season.
  assert.match(primitives, /const ink = champion\.recent === undefined\s*\? \{ winRate: champion\.winRate, tone: champion\.tone \}\s*: champion\.recent;/);
  // The month's record is told, not only drawn: in the row's tooltip and label.
  assert.match(primitives, /aria-label=\{`\$\{champion\.name\}: \$\{champion\.games\} partidas, \$\{champion\.winRate\}% de winrate\$\{recent \? `; \$\{recent\}` : ""\}`\}/);
  assert.match(primitives, /Barra de color: winrate de los últimos 30 días/);
  // The duos keep the adjusted bar: solid adjusted winrate over the observed one as a light tail.
  assert.match(duos, /className="wr-track__observed" style=\{\{ width: `\$\{view\.winRate\}%` \}\}/);
  assert.match(duos, /className="wr-track__adjusted" style=\{\{ width: `\$\{view\.adjusted\}%` \}\}/);
  assert.match(css, /\.wr-track__observed \{ background: color-mix\(in srgb, var\(--bar\) 28%, transparent\); \}/);
  assert.match(css, /\.wr-track__adjusted \{ background: var\(--bar\); \}/);
});

test("picks the best champions by confidence and lists them by winrate, the art keeping the confident pick", async () => {
  const { podium, standings } = await sources();
  // The podium's art follows the Wilson pick; the list reads highest winrate first.
  assert.match(podium, /const splash = picks\[0\];\s*const best = byWinRate\(picks\);/);
  // A row's tiles and its detail's list read the same way.
  assert.match(standings, /byWinRate\(bestChampionViews\(player\.analytics\.championCounts, ROW_CHAMPION_SLOTS, player\.recentChampions\)\)/);
  assert.match(standings, /const best = byWinRate\(bestChampionViews\(counts, DETAIL_CHAMPION_SLOTS, recent\)\);/);
});

test("inks wins green, losses red and even results grey, and keeps the accent for focus and live", async () => {
  const { primitives, standings, duos, css } = await sources();
  assert.match(css, /\.wr-track\.is-even, \.wr-bar\.is-even \{ --bar: var\(--even\); \}/);
  assert.match(css, /\.wr-track\.is-loss, \.wr-bar\.is-loss \{ --bar: var\(--loss\); \}/);
  assert.match(primitives, /className=\{`wr-track\$\{ink \? ` is-\$\{ink\.tone\}` : ""\}`\}/);
  assert.match(duos, /className=\{`wr-track is-\$\{view\.tone\}`\}/);
  assert.match(standings, /className=\{`wr-bar is-\$\{winRateTone\(player\.winRate, games, 1\)\}`\}/);
  for (const source of [primitives, standings]) {
    assert.match(source, /const lpTone = lpChangeTone\(match\.lpChangeEvidence, remake\);/);
  }
  assert.match(css, /\.lp-change\.is-pending, \.lp-change\.is-neutral \{ color: var\(--text-2\); \}/);
  assert.match(css, /\.outcome\.is-remake \{ color: var\(--text-2\); \}/);
  assert.match(css, /outline: 2px solid var\(--accent\);/);
});

test("marks a game in progress with a recording light's red, everywhere a player can be", async () => {
  const { primitives, standings, topBar, css } = await sources();
  // Its own red, apart from the result inks and the accent, and the same under the invasion.
  assert.match(css, /--live: #ff5c68;/);
  assert.doesNotMatch(css.slice(css.indexOf("html.is-invaded {"), css.indexOf("html.is-invaded {") + 600), /--live/);
  // The light comes and goes beside the word, in the top bar's count and in the player's badge.
  assert.match(css, /\.live-badge \{[^}]*color: var\(--live-ink\)/);
  assert.match(css, /\.live-badge i \{[^}]*animation: rec-blink/);
  assert.match(css, /\.live-dot \{[^}]*animation: rec-blink/);
  assert.match(css, /@keyframes rec-blink/);
  assert.match(topBar, /\{liveCount\} In-game/);
  assert.match(primitives, /<span className="live-badge"><i aria-hidden="true" \/>In-game<\/span>/);
  // A live line glows red from its edge; a live row gets a red edge and ring, and names the game
  // under the player wherever the table has no last-match column.
  assert.match(css, /\.mline\.is-live::before \{[^}]*animation: live-glow/);
  assert.match(css, /\.srow\.is-live \.srow__main::before \{[^}]*background: var\(--live\);/);
  assert.match(standings, /\{live \? \(\s*<small className="srow__live">\s*<LiveBadge \/>/);
  const medium = css.slice(css.indexOf("@media (max-width: 1359px)"));
  assert.match(medium, /\.srow\.is-live \.srow__live \{ display: block; \}/);
});

test("gives a phone's top bar to the live count while someone plays", async () => {
  const { topBar, css } = await sources();
  assert.match(topBar, /className=\{`topbar\$\{liveCount > 0 \? " has-live" : ""\}`\}/);
  const phones = css.slice(css.indexOf("@media (max-width: 719px)"));
  assert.match(phones, /\.topbar\.has-live \.topbar__nav \{ display: none; \}/);
  // On wide screens a rule sets the section links apart from the season's line.
  assert.match(topBar, /<span className="topbar__rule topbar__rule--nav" aria-hidden="true" \/>/);
});

test("keeps the five form slots visible even with no games", async () => {
  const { primitives, css } = await sources();
  assert.match(primitives, /form\.slots\.map\(\(slot, index\) => <i key=\{index\} className=\{`pill is-\$\{slot\}`\} \/>\)/);
  assert.match(css, /\.pill \{[^}]*box-shadow: inset 0 0 0 1px var\(--line-strong\)/);
});

test("names the live game, remakes and missing PL evidence honestly", async () => {
  const { primitives } = await sources();
  assert.match(primitives, /const live = player\.liveGame;/);
  assert.match(primitives, /<LiveBadge \/>/);
  assert.match(primitives, /if \(isRemakeMatch\(match\)\) return "remake";/);
  assert.match(primitives, /title=\{lpEvidenceTitle\(match\.lpChangeEvidence, remake\)\}/);
  assert.match(primitives, /matchDetailsUrl\(match\.matchId\) \?\? profileUrl\(player\)/);
});

test("opens a row's detail from its button, with the row itself as a pointer shortcut", async () => {
  const { standings, primitives } = await sources();
  assert.match(standings, /aria-expanded=\{isOpen\}/);
  assert.match(standings, /aria-controls=\{detailId\}/);
  assert.match(standings, /\(event\.target as HTMLElement\)\.closest\("a, button"\)\) return;/);
  // The champion list's switch is a labelled group of pressed-state buttons, best first.
  assert.match(standings, /\["best", "Mejores"\],\s*\["most", "Más jugados"\],/);
  assert.match(standings, /const order = chosen \?\? "best";/);
  assert.match(standings, /<Segmented options=\{DETAIL_ORDERS\} value=\{order\} onChange=\{setChosen\} label="Ordenar campeones" \/>/);
  assert.match(primitives, /<span className="segmented" role="group" aria-label=\{label\}>/);
  assert.match(primitives, /aria-pressed=\{value === key\}/);
  assert.match(standings, /<AnimatePresence initial=\{false\}>/);
  assert.match(standings, /is-self/);
  assert.match(standings, /is-peer/);
});

test("lets a podium card show a row detail's roles and summary in place, at one height", async () => {
  const { podium, standings, panel, css } = await sources();
  assert.match(panel, /\["best", "Mejores"\],\s*\["most", "Más jugados"\],\s*\["roles", "Roles"\],\s*\["summary", "Resumen"\],/);
  for (const source of [panel, standings]) {
    assert.match(source, /<RoleList player=\{player\} \/>/);
    assert.match(source, /<PlayerSummary player=\{player\} roster=\{roster\} version=\{version\} \/>/);
  }
  assert.match(podium, /<PlayerPanel player=\{player\} roster=\{roster\} version=\{version\} best=\{best\} slots=\{PODIUM_CHAMPION_SLOTS\} still=\{dead\} tiles \/>/);
  assert.match(css, /\.panel__view \{ margin-top: 12px; min-height: 164px; \}/);
  // Every view keeps its "i", so the switch never changes width between views.
  assert.match(panel, /<InfoHint label=\{VIEW_HINTS\[view\]\} \/>/);
});

test("folds a row's detail into the podium's panel where the screen is narrow", async () => {
  const { standings, css } = await sources();
  // Under 960px the four blocks become the last match over one switchable panel.
  assert.match(standings, /const NARROW_DETAIL_QUERY = "\(max-width: 959px\)";/);
  assert.match(standings, /if \(narrow\) \{\s*return \(\s*<div className="detail is-narrow">\s*<LastMatchBlock /);
  assert.match(standings, /<PlayerPanel player=\{player\} roster=\{roster\} version=\{version\} best=\{best\} slots=\{DETAIL_CHAMPION_SLOTS\} \/>/);
  // The teams are named "Equipo" and "Enemigo" and their champions sit flush right.
  assert.match(standings, /<RosterRow label="Equipo"/);
  assert.match(standings, /<RosterRow label="Enemigo"/);
  assert.match(css, /\.roster__row \{ display: flex; align-items: center; justify-content: space-between;/);
  // A half screen keeps one line per player, with its own table heading.
  const half = css.slice(css.indexOf("@media (max-width: 959px)"), css.indexOf("@media (max-width: 719px)"));
  assert.match(half, /\.srow-grid \{ grid-template-columns: 26px minmax\(0, 1fr\) 112px/);
  assert.doesNotMatch(half, /\n {2}\.board__head \{ display: none; \}/);
});

test("lines a role's games and share up in two columns and shows the main role's share on rows", async () => {
  const { primitives, standings, css } = await sources();
  assert.match(primitives, /<span className="role-list__games">\{entry\.games\}<\/span>\s*<span className="role-list__share">\{entry\.share\}%<\/span>/);
  assert.match(css, /\.role-list__share \{ width: 4ch; text-align: right;/);
  assert.match(standings, /<span className="mono srow__role-share">\{player\.analytics\.roleShare\}%<\/span>/);
});

test("switches views with one shared pill whose thumb slides, and fades the new view in without moving the card", async () => {
  const { podium, standings, panel, primitives, css } = await sources();
  // One component for both switches, so the podium and the row detail behave alike.
  for (const source of [panel, standings]) {
    assert.match(source, /<Segmented options=\{/);
    assert.doesNotMatch(source, /className="segmented"|aria-pressed=/);
  }
  // A single highlight per switch that motion slides to the chosen option; the
  // pressed button paints no background of its own, and every label sits above the thumb.
  assert.match(primitives, /const thumbId = useId\(\);/);
  assert.match(primitives, /<m\.span\s+layoutId=\{thumbId\}\s+layoutDependency=\{value\}/);
  assert.match(css, /\.segmented \{[^}]*isolation: isolate; \}/);
  assert.match(css, /\.segmented button\[aria-pressed="true"\] \{ color: var\(--text\); \}/);
  assert.match(css, /\.segmented__label \{ position: relative; z-index: 1; \}/);
  // The panel keeps its view to itself: a switch never re-renders the card, whose
  // layout animation would otherwise stretch it on a phone.
  const card = podium.match(/\nfunction PodiumCard\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.match(card, /<PlayerPanel player=\{player\} roster=\{roster\} version=\{version\} best=\{best\} /);
  assert.doesNotMatch(card, /useState/);
  // The shown view is keyed, and it only fades in once the reader has switched,
  // so the first paint keeps the entrances it had.
  assert.match(panel, /<div key=\{view\} className=\{chosen === null \? undefined : "swap-in"\}>/);
  assert.match(standings, /<div key=\{order\} className=\{chosen === null \? undefined : "swap-in"\}>/);
  assert.match(css, /\.swap-in \{ animation: view-in var\(--switch\) var\(--ease\); \}/);
  assert.match(css, /\.swap-in :is\(\.wr-track i, \.role-list__bar i\) \{ transform-origin: left center; animation: bar-fill var\(--fill\) var\(--ease\); \}/);
  assert.match(css, /@keyframes view-in \{ from \{ opacity: 0; transform: translateY\(4px\); \} \}/);
  assert.match(css, /@keyframes bar-fill \{ from \{ transform: scaleX\(0\); \} \}/);
  // Reduced motion cancels each new animation with the very selector that sets it.
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.swap-in, \.swap-in :is\(\.wr-track i, \.role-list__bar i\), \.board--duos\.is-expanded \.drow\.is-extra \{ animation: none; \}/);
});

test("keeps the stylesheet's motion tokens and the ones motion/react uses in step", async () => {
  const { css } = await sources();
  const { DURATION, EASE } = await import("../lib/motion.ts");
  const ease = css.match(/--ease: cubic-bezier\(([^)]*)\);/)?.[1].split(",").map(Number);
  assert.deepEqual(ease, [...EASE]);
  for (const [token, seconds] of Object.entries(DURATION)) {
    const declared = css.match(new RegExp(`--${token}: (\\d+)ms;`))?.[1];
    assert.equal(Number(declared) / 1000, seconds, `--${token} and DURATION.${token}`);
  }
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

test("spaces the page on one beat, from under the top bar to the footer", async () => {
  const { page, css } = await sources();
  // Under the top bar, between the sections and around the footer: one token.
  assert.match(css, /--section-gap: 24px;/);
  assert.match(css, /\.page \{ display: flex; flex-direction: column; gap: var\(--section-gap\); padding-top: var\(--section-gap\); \}/);
  // The footer has no rule of its own: the disclaimer first, the legal links beside it.
  const footer = css.match(/\n\.footer \{[^}]*\}/)?.[0] ?? "";
  assert.match(footer, /margin-top: var\(--section-gap\);/);
  assert.doesNotMatch(footer, /border-top/);
  assert.match(page, /<footer className="footer shell">\s*<p lang="en">[^<]*<\/p>\s*<nav className="footer__nav"/);
});

test("lays the board out for wide desktops, half screens and phones", async () => {
  const { css } = await sources();
  for (const breakpoint of [1359, 1199, 959, 719]) {
    assert.match(css, new RegExp(`@media \\(max-width: ${breakpoint}px\\)`));
  }
  // Spanning the two-column podium, the leader keeps its banner over two body columns of the same width.
  assert.match(css, /@container pcard \(min-width: 640px\) \{\s*\.pcard\.place-1 \.pcard__body \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.pcard\.place-1 \.pcard__art \{ grid-column: 1 \/ -1; \}/);
  // The plate is two equal halves, the rank and the 2×2 figures, with a stitch between them and no box
  // around either; only a plate too narrow for both side by side stacks them.
  assert.match(css, /\.plate__grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.plate__stats::before \{/);
  assert.doesNotMatch(css, /\.plate(__stats)? \{[^}]*\bborder\b/);
  assert.match(css, /@container plate \(max-width: 269px\) \{\s*\.plate__grid \{ grid-template-columns: 1fr;/);
  assert.match(css, /\.srow__stats \{ display: contents; \}/);
});

test("covers the whole podium card with the dot grid and dims it only right behind text", async () => {
  const { podium, css } = await sources();
  // The last match sits between two stitches, under the plate and above the panel.
  assert.match(podium, /<MatchLine player=\{player\} roster=\{roster\} version=\{version\} now=\{now\} \/>\s*<Stitch \/>\s*<\/div>\s*<div className="pcard__side">\s*<div className="pcard__champs">\s*<PlayerPanel /);
  // The stitches are solid hairlines in a channel of the card's surface, so no dot of the grid touches them.
  assert.match(css, /\.stitch \{[^}]*box-shadow: 0 0 0 4px var\(--halo, var\(--surface\)\);/);
  assert.doesNotMatch(css.match(/\n\.stitch \{[^}]*\}/)?.[0] ?? "", /background-size|repeat-x/);
  const block = (selector) => css.match(new RegExp(`\\n${selector} \\{[^}]*\\}`))?.[0] ?? "";
  assert.match(block("\\.pcard"), /background-image: radial-gradient\(circle, var\(--card-dot, [^;]+\) 1px, transparent 1\.4px\);\s*background-size: 9px 9px;/);
  assert.doesNotMatch(block("\\.pcard__side"), /background/);
  assert.doesNotMatch(block("\\.plate"), /background/);
  // A halo of the surface under every glyph dims the dots behind letters and numbers, with no box.
  assert.match(css, /\.pcard, \.detail \{ text-shadow: 0 0 4px var\(--halo\), 0 0 1\.5px var\(--halo\); \}/);
});

test("sets the last match on a two-row grid whose figure columns line up on every card", async () => {
  const { primitives, standings, css } = await sources();
  assert.doesNotMatch(primitives, /\.join\(" · "\)/);
  assert.match(primitives, /\{kdaRatio\(match\.kills, match\.deaths, match\.assists\)\} KDA/);
  // Fixed figure columns on a wide card, every cell on its row's baseline.
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 62px 68px;\s*grid-template-areas: "result kda age" "champ ratio time";\s*align-items: baseline;/);
  // In a game shared with challenge members the company takes the ratio's and the length's columns, in gold.
  assert.match(css, /\.mline\.has-company \.mline__body \{ grid-template-areas: "result kda age" "champ with with"; \}/);
  assert.match(css, /\.mline__with b \{ color: var\(--gold\);/);
  assert.match(primitives, /\{company\.length > 0 \? <MatchCompany names=\{company\} \/> : \(/);
  // The lane is named beside its icon, and the champion by its display name.
  assert.match(primitives, /<span className="mline__lane">\{ROLE_LABELS\[lane\]\}<\/span>/);
  assert.match(primitives, /const champion = championDisplayName\(\{ id: match\.championId, name: match\.championName \}\);/);
  // Icons ride inline in the text: a flex item led by an icon takes the icon's bottom edge as its baseline.
  assert.match(css, /\.mline__body svg \{ display: inline-block; margin-right: 4px; vertical-align: -2px;/);
  assert.doesNotMatch(css, /\.mline__(champ|time|stats) \{[^}]*display: (inline-)?flex/);
  // Narrower cards size the figure columns to their content; the narrowest stack them in two.
  assert.match(css, /@container mline \(max-width: 335px\) \{\s*\.mline__body \{ grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(css, /@container mline \(max-width: 299px\) \{\s*\.mline__body \{ grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "result age" "champ kda"; \}/);
  // One K/D/A everywhere a match shows, and the row detail speaks the same words without dots.
  assert.match(primitives, /export function KdaFigures/);
  assert.match(standings, /<KdaFigures kills=\{match\.kills\} deaths=\{match\.deaths\} assists=\{match\.assists\} \/>/);
  assert.doesNotMatch(standings, /formatDuration\(match\.durationSeconds\)\} · /);
  assert.doesNotMatch(standings, />KDA \{kdaRatio/);
});

test("lights the podium art from one pair of states on every screen, with matching filter lists", async () => {
  const { css } = await sources();
  // Every state spells the same four functions in the same sequence, or the change snaps instead of fading.
  const fourFunctions = String.raw`grayscale\([^)]*\) sepia\([^)]*\) saturate\([^)]*\) brightness\([^)]*\)`;
  assert.match(css, new RegExp(`--splash-rest: ${fourFunctions};`));
  assert.match(css, new RegExp(`--splash-lit: ${fourFunctions};`));
  assert.match(css, new RegExp(`html\\.is-invaded \\.pcard__splash \\{ --splash-rest: ${fourFunctions}; \\}`));
  // Hover on desktop and the featured card on a touch screen share the lit state; nothing restates it.
  assert.match(css, /\.pcard:hover \.pcard__splash \{ transform: scale\(1\.04\); filter: var\(--splash-lit\); \}/);
  assert.match(css, /\.pcard\.is-featured \.pcard__splash \{ transform: scale\(1\.04\); filter: var\(--splash-lit\); \}/);
  assert.doesNotMatch(css, /\.pcard__splash \{[^}]*filter: grayscale/);
});

test("gives the page a sober drafting grid that stays quiet over the middle and fades down the page", async () => {
  const { css } = await sources();
  const backdrop = css.match(/\nbody::before \{[^}]*\}/)?.[0] ?? "";
  // A fine grid: hairlines every 28px, firmer lines every 112px with a point where they cross, one line on the centre.
  assert.match(backdrop, /linear-gradient\(to right, rgb\(255 255 255 \/ 2\.2%\) 1px, transparent 1px\) calc\(50% \+ 14px\) 0 \/ 28px 28px/);
  assert.match(backdrop, /linear-gradient\(to right, rgb\(255 255 255 \/ 4%\) 1px, transparent 1px\) calc\(50% \+ 56px\) 0 \/ 112px 112px/);
  assert.match(backdrop, /radial-gradient\(circle, [^)]+\) 1px, transparent 1\.6px\) calc\(50% \+ \.5px\) calc\(-56px \+ \.5px\) \/ 112px 112px/);
  // Quiet over the middle (the header and the cards), shown in the margins, faded towards the bottom.
  assert.match(backdrop, /mask-image:\s*linear-gradient\(to right, #000, rgb\(0 0 0 \/ 20%\) 32%, rgb\(0 0 0 \/ 20%\) 68%, #000\),/);
  assert.match(backdrop, /mask-composite: intersect;/);
  assert.match(backdrop, /-webkit-mask-composite: source-in;/);
  assert.match(backdrop, /z-index: -1;/);
  assert.match(css, /\nbody \{[^}]*isolation: isolate;/);
  assert.doesNotMatch(css, /feTurbulence/);
});

test("keeps the second and third podium cards compact and one height in every view on phones", async () => {
  const { css } = await sources();
  const phones = css.slice(css.indexOf("@media (max-width: 719px)"));
  assert.match(phones, /\.pcard:is\(\.place-2, \.place-3\) \.panel__view \{ min-height: 78px; \}/);
  assert.match(phones, /\.pcard:is\(\.place-2, \.place-3\) \.role-list \{ flex-direction: row;/);
  assert.match(phones, /\.pcard:is\(\.place-2, \.place-3\) :is\(\.role-list__bar, \.role-list__games\) \{ display: none; \}/);
  assert.match(phones, /\.pcard:is\(\.place-2, \.place-3\) \.summary > div \{ display: flex;/);
});

test("lines the podium's switch up with what sits above and below it", async () => {
  const { css } = await sources();
  // The switch spans the panel like the stitches; on phones the hint (a hover tooltip) gives way to it.
  assert.match(css, /\.panel \.segmented \{ flex: 1; min-width: 0; \}/);
  assert.match(css, /\.panel \.segmented button \{ flex: 1 1 auto; \}/);
  const phones = css.slice(css.indexOf("@media (max-width: 719px)"));
  assert.match(phones, /\.panel \.info-hint \{ display: none; \}/);
  // 52px tiles centre a 36px image, so their rows reach 8px past each edge to put the outer images on it.
  assert.match(phones, /\.panel__tiles \.champ-tiles \{ justify-content: space-between; gap: 0; margin-inline: -8px; \}/);
  assert.match(phones, /\.pcard:is\(\.place-2, \.place-3\) \.role-list \{[^}]*margin-inline: -8px; \}/);
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
