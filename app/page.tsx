"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  papipuRespawnSeconds,
  parseLeaderboardPayload,
  sortLeaderboard,
  type LeaderboardPayload,
  type PlayerSnapshot,
} from "../lib/leaderboard";
import { nextPeruHourUtc } from "../lib/peru-time";
import { Duos } from "../components/leaderboard/duos";
import { GASPI_TITLE, GaspiDialog, playHelicopter } from "../components/leaderboard/gaspi";
import { Podium } from "../components/leaderboard/podium";
import { Standings } from "../components/leaderboard/standings";
import { TopBar } from "../components/leaderboard/top-bar";

const LEADERBOARD_STORAGE_KEY = "20q-leaderboard-payload-v1";
const LEADERBOARD_REFRESH_MS = 60_000;
const PRODUCTION_API_ORIGIN = "https://20q-api.yasmiau.com";
const configuredLeaderboardApiOrigin = process.env.NEXT_PUBLIC_LEADERBOARD_API_ORIGIN?.trim().replace(/\/+$/, "");

/**
 * The production page and its Pages previews read the VPS API; anything else —
 * local development above all — keeps using its own `/api/leaderboard` route.
 */
function leaderboardApiUrl() {
  if (configuredLeaderboardApiOrigin) return `${configuredLeaderboardApiOrigin}/api/leaderboard`;
  if (/(^|\.)20q-challenge\.pages\.dev$/.test(window.location.hostname)) {
    return `${PRODUCTION_API_ORIGIN}/api/leaderboard`;
  }
  return "/api/leaderboard";
}

/** Long enough for the card's own fade to cover the ranking, so the palette swap underneath is never seen happening. */
const GASPI_INVASION_DELAY_MS = 560;
/** 23:00 in Lima: when Papipu's respawn countdown starts. */
const PAPIPU_CURFEW_HOUR = 23;

const awayTabTitles = [
  "Bienvenidos a los juegos de Gaspi",
  "Papipu, Mamimu e Hijuepu",
  "Haz lo tuyo Giancarlo",
  "BOMBA",
  "Quiero queque",
  "Haz caso bro",
  "Comenzó la racha",
  "NO HAY NINGÚN MAÑANA",
  "Gente murió Oliver Tree",
  "SERRANOOOO",
  "Yo estaría tilteado",
  "El que muere es cabro",
  "Le pegó al nexo",
  "elweso",
  "equisdeee",
  "Papipu ya son las 11",
  "API API...",
] as const;

/**
 * A title that sets up the next one: when the key is drawn, its value comes up
 * on the following tab-away, so the pair reads as one line delivered across two
 * glances. Follow-ups are not in the bag; they only ever arrive behind their setup.
 */
const awayTabFollowUps: Record<string, string> = {
  "Bienvenidos a los juegos de Gaspi": "de Gaspi",
};

export default function Home() {
  const [payload, setPayload] = useState<LeaderboardPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [gaspiOpen, setGaspiOpen] = useState(false);
  const [gaspiSeen, setGaspiSeen] = useState(false);
  const reloadBoard = useRef<() => void>(() => undefined);
  const gaspiRevealSpent = useRef(false);
  const invasionTimer = useRef(0);

  const standings = payload ? sortLeaderboard(payload.data.players) : [];
  const version = payload?.data.dataDragonVersion ?? "16.19.1";
  const pending = payload === null;
  const liveCount = standings.filter((player) => player.liveGame).length;
  const papipuSeconds = papipuRespawnSeconds(clockNow);
  const respawnFor = useCallback(
    (player: PlayerSnapshot) => (player.gameName.toLocaleLowerCase("es-PE") === "papipu" ? papipuSeconds : null),
    [papipuSeconds],
  );

  // Load, cache and poll. Hidden tabs stop polling and catch up the moment they
  // come back, so a page left open in the background costs the API nothing.
  useEffect(() => {
    let active = true;
    let pollTimer = 0;
    let loadInFlight = false;
    const controller = new AbortController();

    try {
      const stored = parseLeaderboardPayload(JSON.parse(window.localStorage.getItem(LEADERBOARD_STORAGE_KEY) ?? "null"));
      if (stored) window.requestAnimationFrame(() => { if (active) setPayload((current) => current ?? stored); });
    } catch {
      // Unreadable storage only means the first frame waits for the network.
    }

    async function loadLeaderboard() {
      if (loadInFlight) return;
      loadInFlight = true;
      setClockNow(Date.now());
      try {
        const response = await fetch(leaderboardApiUrl(), {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Leaderboard request failed (${response.status}).`);
        const nextPayload = parseLeaderboardPayload(await response.json());
        if (!nextPayload) throw new Error("Leaderboard response was invalid.");
        if (!active) return;
        setPayload(nextPayload);
        setLoadError(false);
        setClockNow(Date.now());
        try {
          window.localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(nextPayload));
        } catch {
          // Live data stays usable when storage is unavailable or full.
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active) setLoadError(true);
      } finally {
        loadInFlight = false;
      }
    }

    const startPolling = () => {
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => {
        void loadLeaderboard();
      }, LEADERBOARD_REFRESH_MS);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearInterval(pollTimer);
        pollTimer = 0;
        return;
      }
      void loadLeaderboard();
      startPolling();
    };

    reloadBoard.current = () => { void loadLeaderboard(); };
    void loadLeaderboard();
    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      active = false;
      reloadBoard.current = () => undefined;
      controller.abort();
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // A live game's clock and Papipu's countdown tick every second. Otherwise the
  // clock only has to wake for the curfew, when the countdown begins.
  const needsSecondTicks = papipuSeconds !== null || liveCount > 0;
  useEffect(() => {
    const delay = needsSecondTicks
      ? 1_000 - (clockNow % 1_000)
      : Math.max(1_000, nextPeruHourUtc(clockNow, PAPIPU_CURFEW_HOUR) - clockNow);
    const timer = window.setTimeout(() => setClockNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [clockNow, needsSecondTicks]);

  // The invasion is not an overlay: it repaints the palette the ranking is drawn
  // from and outlives the card that started it. It waits for the card's fade,
  // and the timer is deliberately not cancelled on close.
  useEffect(() => {
    if (!gaspiOpen) return;
    invasionTimer.current = window.setTimeout(
      () => document.documentElement.classList.add("is-invaded"),
      GASPI_INVASION_DELAY_MS,
    );
  }, [gaspiOpen]);

  useEffect(() => () => {
    window.clearTimeout(invasionTimer.current);
    document.documentElement.classList.remove("is-invaded");
  }, []);

  // Spent once per page load, like the helicopter: a reveal that replays on
  // every opening stops being a reveal and starts being a wait.
  const openGaspi = useCallback(() => {
    playHelicopter();
    setGaspiSeen(gaspiRevealSpent.current);
    gaspiRevealSpent.current = true;
    setGaspiOpen(true);
  }, []);

  const homeTitle = useCallback(() => (gaspiOpen ? GASPI_TITLE : "20Q Challenge"), [gaspiOpen]);

  useEffect(() => {
    document.title = homeTitle();
  }, [homeTitle]);

  // Earlier visits left "#duos" or "#clasificacion" in the address bar. Some
  // mobile browsers re-apply an anchor whenever their toolbar resizes, which
  // pulled the page back while it was being scrolled. The section links no
  // longer set one, and this drops any that a bookmark or old tab still carries.
  useEffect(() => {
    const { hash, pathname, search } = window.location;
    if (hash === "#duos" || hash === "#clasificacion") window.history.replaceState(null, "", `${pathname}${search}`);
  }, []);

  useEffect(() => {
    let isAway = false;
    // Drawn without replacement, so a session's worth of tab-aways works
    // through the whole list before any title repeats.
    let bag: string[] = [];
    let followUp: string | null = null;
    const nextTitle = () => {
      if (followUp !== null) {
        const title = followUp;
        followUp = null;
        return title;
      }
      if (bag.length === 0) bag = [...awayTabTitles];
      const title = bag.splice(Math.floor(Math.random() * bag.length), 1)[0]!;
      followUp = awayTabFollowUps[title] ?? null;
      return title;
    };
    const markAway = () => {
      if (isAway) return;
      isAway = true;
      document.title = nextTitle();
    };
    const restoreTitle = () => {
      if (!isAway) return;
      isAway = false;
      document.title = homeTitle();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") markAway();
      else restoreTitle();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", markAway);
    window.addEventListener("focus", restoreTitle);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", markAway);
      window.removeEventListener("focus", restoreTitle);
    };
  }, [homeTitle]);

  const unreachable = loadError && payload === null;

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
          <a className="skip-link" href="#clasificacion">Ir al ranking</a>
          <TopBar
            liveCount={liveCount}
            onOpenGaspi={openGaspi}
          />
          <main className="page" aria-busy={pending && !unreachable}>
            <h1 className="sr-only">20Q Challenge · Clasificación</h1>
            {payload?.meta.notice ? <p className="notice shell" role="status">{payload.meta.notice}</p> : null}
            {unreachable ? (
              <section className="unreachable shell" role="alert">
                <strong>No se pudo cargar el ranking.</strong>
                <span>El servidor no respondió. Se volverá a intentar en un minuto.</span>
                <button type="button" onClick={() => reloadBoard.current()}>Reintentar ahora</button>
              </section>
            ) : (
              <>
                <Podium standings={standings} version={version} now={clockNow} respawnFor={respawnFor} pending={pending} />
                <Standings standings={standings} version={version} now={clockNow} respawnFor={respawnFor} pending={pending} />
                {payload?.data.duos?.length ? <Duos duos={payload.data.duos} players={standings} version={version} /> : null}
              </>
            )}
          </main>
          {/* One row under the last section, on the page's own rhythm: the
              disclaimer on the left, the legal links on the right. */}
          <footer className="footer shell">
            <p lang="en">20Q Challenge is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.</p>
            <nav className="footer__nav" aria-label="Documentos legales">
              <a href="/privacy">Privacidad</a>
              <a href="/terms">Términos</a>
            </nav>
          </footer>
          <GaspiDialog open={gaspiOpen} seen={gaspiSeen} onOpenChange={setGaspiOpen} />
        </Tooltip.Provider>
      </MotionConfig>
    </LazyMotion>
  );
}
