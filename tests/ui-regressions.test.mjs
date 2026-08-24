import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
/** These assertions read source text, and several of them span line breaks. A
    CRLF checkout — the default on Windows — would fail those and only those,
    for a reason that has nothing to do with the code under test. */
const readSource = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
const readPage = () => readSource("app/page.tsx");
const readCss = () => readSource("app/globals.css");
const readLeaderboard = () => readSource("lib/leaderboard.ts");

/**
 * These tests pin the decisions made when the leaderboard was rebuilt on frame
 * 1b of the design audit. They compare the *source text* of page.tsx and
 * globals.css with regular expressions, so an innocuous reformat can break one:
 * read the test name before editing it.
 */

/* ─── Header ─── */

test("states region, queue and season under the brand instead of as loose pills", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /<small>LAS · Solo\/Duo · S2026<\/small>/);
  assert.match(css, /\.brand small \{[^}]*font-family: var\(--mono\)/);
  assert.doesNotMatch(page, /context-pills/);
  assert.doesNotMatch(css, /\.context-pills/);
});

test("reports roster size, live games and update time as one segmented readout", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /className="header-stats"/);
  assert.match(page, /jugadores</);
  assert.match(page, /IN-GAME/);
  assert.match(css, /\.header-stats > span:first-child \{[^}]*border-radius: var\(--r-sm\) 0 0 var\(--r-sm\)/);
  assert.match(css, /\.header-stats > span:last-child \{[^}]*border-radius: 0 var\(--r-sm\) var\(--r-sm\) 0/);
});

test("ranks everyone, so a place and the arrow beside it count the same list", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // The board used to hold its target out of the standings, which left the
  // place column and the movement arrow measuring two different orderings.
  assert.match(page, /const visiblePlayers = sortLeaderboard\(players\);/);
  assert.doesNotMatch(page, /goalVisible|challengeGoalPlayer|contenders/);
  assert.doesNotMatch(page, /className="goal-card"/);
  assert.doesNotMatch(css, /\.goal-card|--goal-color/);
  assert.match(page, /className=\{`row-delta\$\{delta > 0 \? " is-up" : delta < 0 \? " is-down" : ""\}`\}/);
  assert.match(css, /\.row-delta\.is-up \{ color: var\(--green\); \}/);
});

test("moves the cards when the standings move, which is what the arrows say", async () => {
  const page = await readPage();

  // The FLIP capture belonged to the reveal toggle and had no other caller.
  // A refresh that reorders the board is exactly the event it was written for.
  assert.match(page, /const nextOrder = sortLeaderboard\(nextPayload\.data\.players\)/);
  assert.match(page, /renderedOrder\.current !== nextOrder\) captureRankingPositions\(\)/);
  assert.match(page, /\}, \[hasLiveData, payload\.data\.fetchedAt, syncRankingNodes\]\)/);
});

test("puts Los Juegos de Gaspi behind the header badge", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /className="gaspi-card" onClick=\{openGaspi\}/);
  assert.match(page, /<strong>Los Juegos de Gaspi<\/strong>/);
  assert.match(page, /role="dialog" aria-modal="true"/);
  // Escape closes it, and the scroll lock is undone with it.
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /document\.body\.style\.overflow = "hidden"/);
  assert.match(css, /\.gaspi-card \{[\s\S]*?inset 0 0 0 2px rgb\(227 188 110 \/ 42%\)/);
  assert.match(css, /\.gaspi-title \{[^}]*font-family: "Cinzel"/);
});

test("invades the ranking's palette rather than painting over it", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Every surface the invasion recolours is a token, and the tokens are
  // registered as colours so the swap interpolates instead of jumping.
  assert.match(css, /@property --bg \{ syntax: "<color>"/);
  assert.match(css, /html\.is-invaded \{[\s\S]*?--glow-a: rgb\(227 188 110 \/ 14%\)/);
  assert.doesNotMatch(css, /background: #12151d|background: #0a0b10|background: #0c0e14|background: #0a0c11/);
  assert.match(page, /classList\.add\("is-invaded"\),\s*\n?\s*GASPI_INVASION_DELAY_MS/);

  // The invasion outlives the card that started it: coming back from Los Juegos
  // the ranking stays gold. Only unmount undoes it, so the class must not be
  // removed by the effect that owns the overlay's scroll lock.
  const scrollLock = page.slice(page.indexOf("if (!gaspiOpen) return;"));
  const lockBody = scrollLock.slice(0, scrollLock.indexOf("}, [gaspiOpen]);"));
  assert.doesNotMatch(lockBody, /classList\.remove\("is-invaded"\)/);
  assert.match(page, /useEffect\(\(\) => \(\) => \{[\s\S]*?classList\.remove\("is-invaded"\)[\s\S]*?\}, \[\]\)/);
});

test("keeps the sticky header pinned to the box that actually scrolls", async () => {
  const css = await readCss();

  // `overflow-x: hidden` on the body made it a scroll container, and a scroll
  // container is what `position: sticky` resolves against. The body never
  // scrolls — the document does — so the header pinned itself to a box that
  // stood still and rode up out of view. `clip` contains overflow without
  // becoming a scroll container, which is the whole fix.
  assert.match(css, /body \{[^}]*overflow-x: clip/);
  assert.doesNotMatch(css, /body \{[^}]*overflow-x: hidden/);
  assert.match(css, /\.site-header \{[^}]*position: sticky/);
});

test("keeps the header taking its background whoever is doing the scrolling", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // A sentinel does not care which box scrolls; a listener does not care
  // whether observations are being delivered. Both run, because either one
  // alone is a header that silently stops taking its wash.
  assert.match(page, /window\.addEventListener\("scroll", handleScroll/);
  assert.match(page, /new IntersectionObserver\(\s*\n?\s*\(\[entry\]\) => setIsHeaderScrolled/);
  assert.match(page, /document\.scrollingElement\?\.scrollTop/);
  // And the width the scrollbar occupied is given back as padding while the
  // overlay holds scrolling, so losing it cannot jolt the layout sideways.
  assert.match(page, /const gutter = window\.innerWidth - root\.clientWidth/);
  assert.match(page, /if \(gutter > 0\) root\.style\.paddingRight = `\$\{gutter\}px`/);
  assert.doesNotMatch(css, /scrollbar-gutter/);
});

test("ranks the pairs that win together, on the champions' own criterion", async () => {
  const [page, css, leaderboard] = await Promise.all([readPage(), readCss(), readLeaderboard()]);

  // One Wilson bound serves both rankings, so a duo is judged on exactly the
  // terms a champion disc is.
  assert.match(leaderboard, /export function wilsonLowerBound/);
  assert.match(leaderboard, /function championConfidenceScore\(champion: ChampionAggregate\) \{\s*return wilsonLowerBound\(champion\.wins, champion\.games\);/);
  assert.match(page, /`duo-panel\$\{duosRevealed \? " is-in" : ""\}`/);
  assert.match(page, /Mínimo \{DUO_LEADERBOARD_MIN_GAMES\} partidas juntos/);
  assert.match(css, /\.duo-row\.is-top \{[^}]*border-color: rgb\(246 214 138 \/ 30%\)/);
});

test("counts a duo's record only where the two actually shared a side", async () => {
  const duos = await readSource("lib/habitual-duos.ts");

  // Two members drawn onto opposite teams share a game and never share its
  // outcome, so the record query filters on the team read off the roster.
  assert.match(duos, /export const DUO_RECORD_QUERY/);
  assert.match(duos, /peer_team = own_team/);
  assert.match(duos, /SUM\(won\) AS wins/);
  assert.match(duos, /export function foldDuoRecords/);
});

/* ─── What the payload always carried ─── */

test("states the league-point distance that explains each placement", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Finding 02: rows were sorted by rankScore() but the distance was never painted.
  assert.match(page, /leaguePointsGap\(visiblePlayers, index\)/);
  assert.match(page, /leaderAdvantage\(visiblePlayers\)/);
  assert.match(page, /if \(isLeader\) return ""/);
  assert.match(page, /PL para/);
  // The chip is podium furniture now, in a slot that reserves its height so the
  // leader's card \u2014 which trails nobody, and so has no chip \u2014 stays aligned.
  assert.match(css, /\.podium-rank \.gap-slot \{[^}]*min-height: 22px/);
  assert.doesNotMatch(css, /\.gap-pill\.is-leader|\.gap-text\.is-leader/);
});

test("keeps the role distribution derivable even though frame 1b does not draw it", async () => {
  const leaderboard = await readLeaderboard();

  // Finding 03 named roleCounts as wasted data, but frame 1b renders only the
  // main role and its share. The helper stays so the row can show the spread
  // once it has the width for it.
  assert.match(leaderboard, /export function roleDistribution/);
  assert.match(leaderboard, /intensity: peak === 0 \? 0 : entry\.games \/ peak/);
});

test("shows champion winrate as text so touch users can read it", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Finding 05: the winrate lived only in a :hover tooltip, unreachable on touch.
  assert.match(page, /className="champion-wr"/);
  assert.match(page, /championWinRatePercent\(champion\)/);
  assert.match(page, /championWinRateTone\(shownPercent\)/);
  assert.doesNotMatch(page, /champion-tooltip/);
  assert.doesNotMatch(css, /\.champion-tooltip/);
  assert.doesNotMatch(page, /tabIndex=\{0\}/);
});

test("colours champion winrate from the rounded percent that is displayed", async () => {
  const leaderboard = await readLeaderboard();

  // 54.9% and 55.0% both render "55%", so they must not differ in colour.
  assert.match(leaderboard, /export function championWinRateTone\(shownPercent: number\)/);
  assert.match(leaderboard, /if \(shownPercent >= 55\) return "strong"/);
  assert.match(leaderboard, /return shownPercent >= 48 \? "even" : "weak"/);
});

test("aggregates the habitual challenge duo instead of only naming one peer", async () => {
  const [page, enrichment, duoLogic] = await Promise.all([
    readPage(),
    readSource("db/player-enrichment.ts"),
    readSource("lib/habitual-duos.ts"),
  ]);

  // Finding 09: challengePlayerId only ever produced a "Con X" label.
  assert.match(page, /function DuoText/);
  assert.match(page, /if \(!duo\) return null;/);
  assert.doesNotMatch(page, /sin dúo del grupo/);
  assert.match(enrichment, /readHabitualDuos/);
  assert.match(duoLogic, /challengePlayerId/);
  assert.match(duoLogic, /tracked_game_sessions/);
  assert.match(duoLogic, /COALESCE\(t\.match_id, t\.platform_game_id\)/);
  assert.match(duoLogic, /pickHabitualDuos/);
});

test("gives a live game the last-match slot in a different state", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Finding 08: spectator sessions were detected but never surfaced.
  assert.match(page, /function LiveSummary/);
  assert.match(page, /IN-GAME<\/strong>/);
  assert.match(page, /className="live-clock"/);
  assert.doesNotMatch(page, /className="live-champ"/);
  assert.match(page, /function PodiumCard\(\{[^}]*clockNow/);
  assert.match(page, /<div className="podium-strip is-live">/);
  assert.match(page, /<LiveSummary player=\{player\} version=\{version\} clockNow=\{clockNow\} \/>/);
  assert.match(css, /\.row-live \{/);
  assert.match(css, /\.podium-strip\.is-live \{/);
  assert.match(css, /animation: live-sweep/);
  assert.match(css, /animation: live-pulse/);
});

test("tracks recent form as five slots that stay visible when empty", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /function Streak/);
  // The card names the run; the row drops the label and puts the season record
  // where it was, so both lines still say what the dots are.
  assert.match(page, /label="Últimas 5"/);
  assert.match(page, /\{label \? <small className="streak-label">\{label\}<\/small> : null\}/);
  assert.match(page, /<small className="record">/);
  assert.match(css, /\.streak-dots > i\.is-empty/);
  assert.match(css, /\.row-performance \.record \{[^}]*margin-left: auto/);
});

test("shows place movement against the previous ranking", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /player\.placeDelta \?\? 0/);
  assert.match(page, /▲/);
  assert.match(page, /▼/);
  assert.match(css, /\.row-delta\.is-up \{ color: var\(--green\)/);
  assert.match(css, /\.row-delta\.is-down \{ color: var\(--red\)/);
});

/* ─── Hierarchy and legibility ─── */

test("keeps the tier out of the row frame, where the crest already says it", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // The audit reversed frame 1b here. A tinted edge on every row re-ranked the
  // list a second time in a weaker alphabet, and it fought the podium's metals.
  // Only the goal card is still keyed to a tier.
  assert.doesNotMatch(css, /--tier-color|--tier-wash|--tier-edge/);
  assert.doesNotMatch(page, /tierAccentStyle/);
  assert.match(css, /\.leaderboard-row \{[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?background: var\(--panel\)/);
  assert.doesNotMatch(css, /\.leaderboard-row:nth-child\(even\)/);
  // The zebra it replaced must not come back either.
  assert.match(css, /\.leaderboard-row:not\(\.is-pending\):is\(:hover, :focus-within\) \{[^}]*border-color: var\(--line-bright\)/);
});

test("keeps the winrate bar and performance layout while removing only the match KDA label", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /className="wr-bar"/);
  assert.match(css, /\.wr-bar \{[^}]*height: 6px/);
  assert.match(css, /\.podium-performance \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.stat-pair\.is-end \{[^}]*justify-self: end/);
  assert.match(css, /\.row-performance \.perf-head \{[^}]*justify-content: space-between/);
  assert.match(css, /\.row-performance \.perf-head \{[^}]*gap: 10px/);
  assert.match(page, /<small className="kda-label">KDA<\/small>/);
  assert.match(page, /<small className="match-kda">\{matchKda\}<\/small>/);
});

test("weights an old match differently and names unavailable LP evidence", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Finding 07: a 38-day-old match rendered identically to a two-hour-old one,
  // and unavailable evidence surfaced as a cryptic "N/D".
  assert.match(page, /isStaleMatch\(match\.gameStartTimestamp\)/);
  assert.match(page, /return null/);
  assert.doesNotMatch(page, /return "N\/D"/);
  assert.match(css, /\.match-when\.is-stale/);
});

test("renders remakes neutrally and keeps the PL value on one line", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /isRemakeMatch\(match\)/);
  assert.match(page, /remake \? "Remake"/);
  assert.match(page, /remake \? "0 PL"/);
  assert.match(css, /\.match-lp \{[^}]*white-space: nowrap/);
  assert.match(css, /\.match-result\.is-remake/);
});

test("renders the respawn countdown as a clock, not raw seconds", async () => {
  const [page, css, leaderboard] = await Promise.all([readPage(), readCss(), readLeaderboard()]);

  // Finding 10: "Reaparece en: 19113".
  assert.match(leaderboard, /export function formatRespawnClock/);
  assert.match(page, /formatRespawnClock\(respawnSeconds\)/);
  assert.match(page, /role="timer"/);
  assert.doesNotMatch(page, /Reaparece en: \{respawnSeconds\}/);
  // Two elements, nothing else: the overlay is the label and the clock.
  assert.doesNotMatch(page, /ventana 23:00|showWindow/);
  assert.match(css, /\.respawn strong \{[\s\S]*?color: var\(--red-bright\)/);
  // The countdown must survive in both layouts.
  assert.match(css, /\.leaderboard-row \.respawn strong/);
});

test("labels every stacked figure once the column heading disappears", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Finding 11: data-label existed but was never used in CSS, so mobile showed
  // numbers with no visible name.
  assert.match(css, /\.row-grid \[data-label\]::before, \.duo-grid \[data-label\]::before \{\s*content: attr\(data-label\)/);
  assert.match(page, /data-label="Rendimiento"/);
  assert.match(page, /data-label="Rango"/);
  assert.match(page, /data-label="Rol"/);
  assert.match(css, /@media \(max-width: 960px\)/);
});

test("lifts informative text off the 10px floor", async () => {
  const css = await readCss();

  // Finding 12: most labels, notes and the legal footer sat at 10px on --muted.
  assert.match(css, /footer \{[^}]*font-size: 10\.5px/);
  assert.match(css, /--muted: #9aa0b4/);
});

/* ─── Behaviour preserved through the rebuild ─── */

test("keeps the top three in numeric order so focus follows reading order", async () => {
  const page = await readPage();

  assert.match(page, /topThree\.map\(\(player, index\) => \(/);
  assert.match(page, /place=\{index \+ 1\}/);
});

test("keeps the leaderboard synchronized with the one-minute cloud cadence", async () => {
  const page = await readPage();

  assert.match(page, /const LEADERBOARD_REFRESH_MS = 60_000;/);
  assert.match(page, /window\.setInterval/);
  assert.match(page, /window\.clearInterval\(pollTimer\)/);
});

test("distinguishes loading, stale data and a first-load network error", async () => {
  const page = await readPage();

  assert.match(page, /role="alert">No se pudo contactar con Riot/);
  assert.match(page, /payload\.meta\.notice \? <p className="status-notice" role="status"/);
  assert.match(page, /"cargando"/);
});

test("rotates a playful tab title while the page is away from focus", async () => {
  const page = await readPage();

  assert.match(page, /const awayTabTitles = \[/);
  assert.match(page, /document\.addEventListener\("visibilitychange"/);
  // Coming back lands on the view that is actually on top, not always the board.
  assert.match(page, /gaspiOpen \? GASPI_TITLE : "20Q Challenge"/);
  assert.match(page, /document\.title = homeTitle\(\);/);
});

test("keeps the match block linked to its League of Graphs detail", async () => {
  const page = await readPage();

  assert.match(page, /matchDetailsUrl\(player\.lastSoloQueueMatch\.matchId\) \?\? profileUrl\(player\)/);
  assert.match(page, /Abrir detalles de la última SoloQ de/);
});

test("names winrate and KDA groups for assistive technology", async () => {
  const page = await readPage();

  assert.match(page, /aria-label=\{pending \? undefined : `Winrate: /);
  assert.match(page, /aria-label=\{pending \? undefined : `KDA: /);
  assert.match(page, /partidas analizadas/);
  assert.match(page, /role=\{pending \? undefined : "group"\}/);
});

test("gives the podium and the table their own headings", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /<h2 className="sr-only" id="podio-title">Top 3 del ranking<\/h2>/);
  assert.match(page, /<h2 className="sr-only" id="resto-title">Resto de la clasificación<\/h2>/);
  assert.match(page, /aria-labelledby="resto-title"/);
  assert.match(css, /\.table-heading > span \{[^}]*text-align: center/);
  assert.match(css, /\.table-heading \.indent \{[^}]*padding-left: 0[^}]*text-align: center/);
});

test("clears the sticky header before the skip-link target", async () => {
  const css = await readCss();

  assert.match(css, /#clasificacion \{ scroll-margin-top: 88px; \}/);
});

test("gives footer links a 24px touch target and marks the Riot disclaimer as English", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(css, /footer a \{[^}]*display: inline-block[^}]*padding-block: 7px/);
  assert.match(page, /<span lang="en">20Q Challenge is not endorsed by Riot Games/);
});

test("drains the borrowed Iron crest for unranked players", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.match(page, /rank-emblem tier-iron is-unranked/);
  assert.match(css, /\.rank-emblem\.is-unranked \{ filter: grayscale\(1\)/);
  assert.match(page, /sin partidas clasificadas/);
});

test("backs the podium with vertical loading art, never the landscape splash", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // The "centered" splash is 16:9: cropping it to a portrait-ish card cut the
  // champion in half. Loading art is the only vertically composed source Riot
  // ships, so the card crops its width instead.
  assert.match(page, /function championLoadingAsset/);
  assert.match(page, /cdn\/img\/champion\/loading/);
  assert.doesNotMatch(page, /championCenteredAsset|img\/champion\/centered/);
  // 308x560 art against a card nearer 410x455: sizing it off either single axis
  // leaves the other short. By height it came out 269px wide in a 409px frame
  // and bared 70px of card down each side, which is the whole reason this is
  // pinned. `cover` is the only fit that holds at every breakpoint.
  assert.match(css, /\.podium-splash \{[\s\S]*?inset: 0;[\s\S]*?object-fit: cover/);
  assert.match(css, /\.podium-splash \{[\s\S]*?width: 100%;\s*height: 100%/);
  assert.doesNotMatch(css, /\.podium-splash \{[\s\S]*?height: 108%/);
  // The champion splash starts at the top edge; any necessary crop is taken
  // from the bottom, where the mask already fades.
  assert.match(css, /\.podium-splash \{[\s\S]*?object-position: 50% 0%/);
  // The fade belongs to the frame, so it tracks the card height and not whatever
  // height the portrait happens to scale to.
  assert.match(css, /\.podium-splash-frame \{[\s\S]*?mask-image: linear-gradient\(180deg[^;]*transparent 86%\)/);
  assert.doesNotMatch(page, /splashPositionFromLoading|compareChampionCrop/);
});

test("makes the champion discs the grid columns with no wrapper between them", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // The role="list" wrapper used to be the single grid item, so the discs sized
  // themselves against a collapsed box and rendered at 16.5px instead of 48px.
  // The band is now the list itself, so there is no box left to collapse.
  assert.match(page, /function ChampionBand/);
  assert.match(page, /className="podium-champions champions"/);
  assert.match(page, /className="row-champions champions"/);
  assert.doesNotMatch(css, /display: contents/);
  assert.match(css, /\.podium-champions \.champion-portrait \{ width: 48px; height: 48px; \}/);
  // Row discs need an intrinsic size too, or the middle column collapses to 0.
  assert.match(css, /\.row-champions \.champion-portrait \{ width: 34px; height: 34px; \}/);
});

test("centres a champion set shorter than its slots", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Three discs in a five-column track used to hug the left edge and leave two
  // columns visibly empty.
  assert.match(page, /const shown = pending \? slots : champions\.length/);
  assert.match(page, /shown < slots \? " is-partial" : ""/);
  assert.match(page, /"--shown": shown/);
  assert.match(css, /\.champions \{[^}]*justify-content: center/);
  assert.match(css, /\.podium-champions\.is-partial \{[^}]*grid-template-columns: repeat\(var\(--shown\), auto\)[^}]*justify-content: center/);
});

test("drops the decorative hatch grid from the profile cards entirely", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  assert.doesNotMatch(page, /className="hatch"/);
  assert.doesNotMatch(css, /\.hatch/);
  assert.doesNotMatch(css, /repeating-linear-gradient/);
});

test("builds the loading view from the real cards, shimmering only the values", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Separate skeleton components drifted from the cards they imitated: the row
  // skeleton was still on the pre-redesign class names while the live row had
  // moved on, so the loading state rendered unstyled.
  assert.doesNotMatch(page, /function Skeleton|is-skeleton/);
  assert.match(page, /const PENDING_PLAYER: PlayerSnapshot = \{/);
  assert.match(page, /<PodiumCard key=\{`pending-\$\{place\}`\} player=\{PENDING_PLAYER\}/);
  assert.match(page, /<LeaderboardRow key=\{`pending-\$\{place\}`\} player=\{PENDING_PLAYER\}/);
  assert.match(page, /pending \? " is-pending" : ""/);
  // Frames the design already draws shimmer in place; they are not replaced.
  assert.match(page, /className="champion-portrait sk-slot"/);
  assert.match(page, /className="match-art sk-slot"/);
  assert.match(page, /className="rank-slot sk-slot"/);
  assert.match(css, /\.sk-bone, \.sk-slot \{[^}]*background: var\(--sk-bg\)/);
  // Static labels and the five streak slots are live markup, so they must not be
  // bones: nothing may change size when the payload lands.
  assert.match(page, /<small className="kda-label">KDA<\/small>/);
  assert.match(page, /className="streak-label"/);
});

test("keeps a pending card out of the tab order and the accessibility tree", async () => {
  const page = await readPage();

  assert.match(page, /function Linkable/);
  assert.match(page, /if \(pending \|\| !href\) return <span className=\{className\} data-label=\{dataLabel\}>/);
  assert.match(page, /aria-hidden=\{pending \? true : undefined\}/);
});

test("replaces the animation layer and never pins a finished keyframe", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // A forwards fill outranks author declarations for as long as the element
  // lives, so `both` on an entrance silently killed the hover lift and the
  // dimmed respawn state.
  assert.match(css, /animation: podium-enter 560ms var\(--ease-rank\) backwards/);
  assert.match(css, /animation: row-enter 440ms var\(--ease-rank\) backwards/);
  assert.match(css, /animation: value-settle 460ms var\(--ease-rank\) backwards/);
  assert.doesNotMatch(css, /animation:[^;]*\bboth\b/);
  assert.doesNotMatch(css, /@keyframes (?:card-in|row-in|data-refresh|shimmer|livePulse|liveSweep)\b/);
  assert.match(css, /@keyframes sk-sweep/);
  assert.match(css, /@keyframes goal-sheen/);
  // Hover has to reach the art and the crest, not just lift a grey card.
  assert.match(css, /\.podium-card:not\(\.is-pending\):is\(:hover, :focus-within\) \.podium-splash \{[^}]*opacity: \.38/);
  assert.match(css, /\.podium-card:not\(\.is-pending\):is\(:hover, :focus-within\) \.podium-crest \{[^}]*filter: brightness/);
  assert.match(css, /--ease-rank: cubic-bezier\(\.22, 1, \.28, 1\)/);
  // The ranking's own animations carry the same hazard: a forwards fill would
  // hold `transform: none` on every card it ever moved.
  assert.match(page, /element\.animate\(keyframes, \{ duration, easing: "cubic-bezier\(\.22, 1, \.28, 1\)", fill: "backwards" \}\)/);
  assert.doesNotMatch(page, /fill: "both"/);
});

test("slides a player between the podium and the list without deforming it", async () => {
  const page = await readPage();

  // Revealing the target pushes third place out of the podium and into the list,
  // so that player's element changes shape between frames. Scaling the new
  // element from the old one's dimensions squashed its contents the whole way
  // across; it travels centre to centre at its own size instead.
  assert.match(page, /const changedForm = Math\.abs\(previous\.height - next\.height\) > 24/);
  assert.match(page, /const centreX = \(previous\.left \+ previous\.width \/ 2\) - \(next\.left \+ next\.width \/ 2\)/);
  assert.match(page, /const centreY = \(previous\.top \+ previous\.height \/ 2\) - \(next\.top \+ next\.height \/ 2\)/);
  assert.match(page, /rankingPositions = useRef\(new Map<string, DOMRectReadOnly>\(\)\)/);
  // No ranking animation may scale: every one of them is a slide.
  assert.doesNotMatch(page, /scale\(/);
  assert.doesNotMatch(page, /transformOrigin/);
});

test("defocuses the card behind the respawn clock instead of only dimming it", async () => {
  const css = await readCss();

  // A 46px countdown over champion art needs the art out of focus, or the two
  // compete for the same reading.
  assert.match(css, /\.podium-card\.is-dead :is\(\.podium-body, \.podium-strip\) \{[^}]*blur\(1\.6px\)/);
  assert.match(css, /\.leaderboard-row\.is-dead \.row-grid > \* \{[^}]*blur\(1\.6px\)/);
  assert.match(css, /\.podium-card\.is-dead \.podium-splash \{[^}]*opacity: \.1/);
  assert.match(css, /\.podium-card\.is-dead:is\(:hover, :focus-within\) \.podium-splash \{[^}]*opacity: \.1/);
  assert.match(css, /\.podium-card\.is-dead \.podium-strip a\.match-row:is\(:hover, :focus-visible\) \{[^}]*background: transparent/);
  assert.match(css, /\.leaderboard-row\.is-dead:is\(:hover, :focus-within\) \.row-grid > \* \{[^}]*filter: grayscale\(1\) blur\(1\.6px\)/);
  assert.match(css, /\.podium-card\.is-dead \.champion:hover \.champion-portrait,[\s\S]*\.leaderboard-row\.is-dead \.champion:hover \.champion-portrait/);
  // Respawn must not cancel the card's own hover movement or replace its rank
  // edge with a neutral grey border. The contents stay diffused, while the
  // card remains discoverable and keeps the bronze/silver/gold treatment.
  assert.doesNotMatch(css, /\.podium-card\.is-dead:is\(:hover, :focus-within\) \{[^}]*transform: none/);
  assert.doesNotMatch(css, /\.leaderboard-row\.is-dead:is\(:hover, :focus-within\) \{[^}]*border-color: var\(--line\)/);
  assert.match(css, /\.podium-card:not\(\.is-pending\):is\(:hover, :focus-within\) \{[^}]*transform: translateY\(-3px\)/);
  assert.match(css, /\.leaderboard-row:not\(\.is-pending\):is\(:hover, :focus-within\) \{[^}]*border-color: var\(--line-bright\)/);
  assert.match(css, /\.podium-card\.is-dead\.place-3:is\(:hover, :focus-within\) \{[^}]*border-color: rgb\(214 154 106 \/ 26%\)/);
  assert.match(css, /\.respawn strong \{[\s\S]*?font-size: 46px/);
  assert.match(css, /\.respawn small \{[^}]*font-size: 11px/);
  // The overlay covers the whole card rather than floating as a pill over it.
  assert.match(css, /\.respawn \{[\s\S]*?inset: 0;[\s\S]*?background: rgb\(6 7 11 \/ 34%\)/);
});

/* ─── Audit: the match module ─── */

test("writes a match as two 20px lines instead of one long one", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // The result and the LP go above, the KDA and the company below. `compact`
  // changes type sizes, not which line a field lives on, so the strip is the
  // same shape in a card, in a row and while it loads.
  assert.match(css, /\.match-body \{[^}]*grid-template-rows: var\(--match-line, 20px\) var\(--match-line, 20px\)/);
  assert.match(page, /<span className="match-line">/);
  assert.match(page, /className="match-outcome"/);
  assert.match(page, /<small className=\{`match-when\$\{stale \? " is-stale" : ""\}`\}>hace \{formattedMatchAge\(match\.gameStartTimestamp\)\}<\/small>/);
  assert.doesNotMatch(page, /formattedMatchDuration\(match\.durationSeconds\).*formattedMatchAge/);
  // The age reads "hace 20m" / "hace 3h" / "hace 1d": one letter, joined to its
  // number. The space used to let a long age wrap away from the value.
  const age = page.slice(page.indexOf("function formattedMatchAge"));
  assert.match(age, /\$\{elapsedMinutes\}m`/);
  assert.match(age, /\$\{elapsedHours\}h`/);
  assert.match(age, /\/ 24\)\}d`/);
  assert.doesNotMatch(age.slice(0, age.indexOf("}")), / (min|h|d)`/);
  assert.doesNotMatch(page, /match-headline|match-stats/);
  assert.doesNotMatch(css, /\.match-headline|\.match-stats/);
  // The KDA rides inside the score, so line 2 is one flex pair and not three.
  assert.match(page, /<small className="match-kda">\{matchKda\}<\/small>\s*<\/strong>/);
});

test("lays the ten participants out as two teams, one role per column", async () => {
  const [page, css, leaderboard] = await Promise.all([readPage(), readCss(), readLeaderboard()]);

  // Riot returns participants in payload order, which is how a support ended up
  // under the top column.
  assert.match(leaderboard, /export function orderMatchRoster/);
  assert.match(leaderboard, /export function orderLiveMatchRoster/);
  assert.match(leaderboard, /export const ROSTER_ROLE_ORDER: PlayerRole\[\] = \["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"\]/);
  assert.match(page, /const \{ allies, enemies \} = \(live\n\s*\? orderLiveMatchRoster\(participants, playerId\)\n\s*: orderMatchRoster\(participants, playerId\)\)/);
  assert.match(css, /\.roster \{[\s\S]*?grid-template-columns: repeat\(5, var\(--roster-cell, 20px\)\)/);
  assert.match(css, /\.roster \{[\s\S]*?grid-auto-rows: var\(--roster-cell, 20px\)/);
  // The two rows read apart before any single champion does.
  assert.match(css, /\.roster > span\.is-ally \{[^}]*border-color: #2c3648/);
  assert.match(css, /\.roster > span\.is-foe \{[^}]*border-color: #3d2a30/);
  assert.match(css, /\.roster > span\.is-self/);
  assert.match(css, /\.roster > span\.is-peer/);
});

test("keeps the roster gutter equal to the gap between the two text lines", async () => {
  const css = await readCss();

  // Row 1 has to land on the result line and row 2 on the KDA line: one variable
  // drives both, so a mobile override cannot desynchronise them.
  assert.match(css, /\.roster \{[\s\S]*?gap: var\(--roster-row-gap, 3px\) 2px/);
  assert.match(css, /\.match-body \{[^}]*gap: var\(--roster-row-gap, 3px\)/);
  assert.match(css, /--match-art: 40px; --match-line: 18px; --roster-cell: 18px; --roster-row-gap: 2px/);
});

test("drops the Solo/Duo label and gives the live strip the same density", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Every match the page shows is Solo/Duo, so naming the queue said nothing.
  assert.doesNotMatch(page, /Solo\/Duo<\/small>|live-queue/);
  assert.doesNotMatch(css, /\.live-queue/);
  // Clock, start time, champion and company, on the same two lines as a
  // finished match. No lane: spectator-v5 reports no position, and its
  // participant order is not the draft order either, so a lane would be
  // invented. The teams still separate, because teamId is real.
  assert.match(page, /const startText = `inicio /);
  assert.doesNotMatch(page, /ownLane|live-lane/);
  assert.match(css, /\.live-clock > b \{[^}]*font-variant-numeric: tabular-nums/);
  // A top-three player in a live game gets the live strip too, not a stale match.
  assert.match(page, /<div className="podium-strip is-live">/);
});

test("calls a remake a remake instead of a loss", async () => {
  const [page, css, leaderboard] = await Promise.all([readPage(), readCss(), readLeaderboard()]);

  // `win: false` on an aborted game is not a defeat, and Riot flags it itself.
  assert.match(leaderboard, /remake\?: boolean/);
  assert.match(page, /outcomeText = remake \? "Remake"/);
  assert.match(css, /\.match-result\.is-remake \{ color: var\(--remake-ink\); \}/);
  assert.match(css, /\.match-art\.is-remake/);
});

test("stops the player column absorbing the row's spare width", async () => {
  const [page, css] = await Promise.all([readPage(), readCss()]);

  // Every column already held its content; the leftover all went to the player
  // column, which had nothing to do with it. Keep the match panel compact and
  // give the recovered half-disc of width to the rank column.
  assert.match(css, /grid-template-columns: 30px minmax\(150px, 1fr\) 203px minmax\(180px, 1fr\) 44px 150px 413px/);
  assert.match(css, /grid-template-columns: 28px minmax\(140px, 1fr\) 168px minmax\(158px, 1fr\) 40px 130px 358px/);
  // The title separator touches the first row; no second vertical rhythm is
  // introduced by a list margin.
  assert.match(css, /\.leaderboard-list \{[^}]*margin: 0;/);
  assert.match(css, /\.podium-champions\s*\{[^}]*padding:\s*11px 0 12px/);
  assert.doesNotMatch(css, /\.podium-card::before\s*\{/);
  assert.match(css, /\.podium-card\.place-3\s*\{[^}]*border-color:\s*rgb\(214 154 106 \/ 26%\)/);
  assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?\.podium-champions \{ gap: 4px; padding: 10px 0 11px; \}/);
  assert.match(page, /<strong>\{player\.gameName\}<span className="podium-tag">#\{player\.tagLine\}<\/span><\/strong>/);
  assert.match(page, /<small><span className="games">\{player\.analytics\.games\} partidas<\/span><\/small>/);
  // The handle has to ellipsize now that the column no longer grows for it.
  assert.match(css, /\.row-player \.handle \{[^}]*text-overflow: ellipsis/);
  assert.match(page, /if \(!duo\) return null;/);
  assert.doesNotMatch(page, /sin dúo del grupo/);
});

test("keeps the clock ticking while anyone is in a game", async () => {
  // The live card's elapsed timer is drawn from `clockNow`. Gating the
  // per-second beat on the respawn countdown alone meant that outside that
  // window the clock was rescheduled for 4am the next day, so anyone actually
  // in a game watched a frozen timer for hours.
  const page = await readPage();
  assert.match(page, /const needsSecondTicks = papipuSeconds !== null \|\| liveCount > 0/);
  assert.match(page, /if \(!needsSecondTicks\) \{/);
  // The dependency has to be the combined condition, or the effect keeps
  // resolving the stale one.
  assert.match(page, /\}, \[clockNow, needsSecondTicks\]\);/);
  assert.doesNotMatch(page, /\}, \[clockNow, papipuSeconds\]\);/);
});
