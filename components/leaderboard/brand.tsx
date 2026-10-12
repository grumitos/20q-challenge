import { useEffect, useState } from "react";
import { GLYPH_20 } from "./glyph-20";

/**
 * The title reads "20 Deadlocks" for a few seconds. The first swap comes early, to catch
 * the eye; after it the swap settles into a slow rhythm.
 */
const FIRST_SWAP_MS = 4000;
const SWAP_HOLD_MS = 6000;
const SWAP_EVERY_MS = 30000;
/** Quick, like a shooter's HUD: the whole swap takes about half a second. */
const TYPE_MS = 22;
const ERASE_MS = 14;
const MORPH_STEP = 0.12;
const MORPH_TICK_MS = 16;

/** What follows "20": the usual name, or the game's. */
const NAME = "Q Challenge";
const SWAPPED = " Deadlocks";
const DEADLOCKS_URL = "https://los20deadlocks.pages.dev/";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Brand() {
  // The timer and the pointer each ask for the swap: hovering forces it and
  // holds it until the pointer leaves, unless the timer has already put it back.
  // Only a mouse hovers: a tap would leave the swap stuck until the next tap
  // elsewhere, so touch screens get the timer alone. Once the title is clicked
  // (it opens Deadlocks' page in a new tab) it goes back to normal and the timer
  // stops for good; a mouse can still bring the swap back by leaving and coming in again.
  const [timed, setTimed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [clicked, setClicked] = useState(false);
  // The text after "20" right now, always a prefix of NAME or of SWAPPED.
  const [tail, setTail] = useState(NAME);
  // How far the "20" has morphed from the title's face (0) into Deadlock's (1).
  const [shape, setShape] = useState(0);
  const swapped = hovered || (!clicked && timed);
  const want = swapped ? SWAPPED : NAME;

  useEffect(() => {
    if (clicked) return;
    let id: number;
    const step = (on: boolean) => {
      setTimed(on);
      id = window.setTimeout(() => step(!on), on ? SWAP_HOLD_MS : SWAP_EVERY_MS);
    };
    id = window.setTimeout(() => step(true), FIRST_SWAP_MS);
    return () => window.clearTimeout(id);
  }, [clicked]);

  // One character a step: type while the tail leads to the wanted text, erase otherwise.
  useEffect(() => {
    if (tail === want) return;
    const typing = want.startsWith(tail);
    const still = reducedMotion();
    const next = still ? want : typing ? want.slice(0, tail.length + 1) : tail.slice(0, -1);
    const id = window.setTimeout(() => setTail(next), still ? 0 : typing ? TYPE_MS : ERASE_MS);
    return () => window.clearTimeout(id);
  }, [tail, want]);

  // The "20" moves toward its goal in small steps, so it can turn around mid-way.
  useEffect(() => {
    const goal = swapped ? 1 : 0;
    if (shape === goal) return;
    const next = reducedMotion() ? goal : Math.min(1, Math.max(0, shape + (goal > shape ? MORPH_STEP : -MORPH_STEP)));
    const id = window.setTimeout(() => setShape(next), MORPH_TICK_MS);
    return () => window.clearTimeout(id);
  }, [shape, swapped]);

  // Each contour's points sit between its two faces' partners, eased.
  const eased = shape * shape * (3 - 2 * shape);
  const outline = GLYPH_20.from
    .map((contour, i) => `M${contour.map((v, j) => (v + (GLYPH_20.to[i][j] - v) * eased).toFixed(1)).join(" ")}Z`)
    .join("");

  return (
    <a
      className={`brand${swapped ? " is-swapped" : ""}`}
      href={DEADLOCKS_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => {
        // The pointer is still over the title: let go of the hover so it goes back at once.
        setClicked(true);
        setHovered(false);
      }}
      onPointerEnter={(event) => setHovered(event.pointerType === "mouse")}
      onPointerLeave={() => setHovered(false)}
    >
      {/* The logo fades into Deadlock's wheel while the text swaps. */}
      <span className="brand__mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand__logo" src="/brand-logo.webp" alt="" width={28} height={28} />
        <span className="brand__icon" />
      </span>
      <span className="brand__name">
        <span className="sr-only">20Q Challenge (abre Los 20 Deadlocks en una pestaña nueva)</span>
        <svg
          className="brand__num"
          viewBox={`0 -${GLYPH_20.height} ${GLYPH_20.width} ${GLYPH_20.height}`}
          style={{ width: `${GLYPH_20.width / 1000}em`, height: `${GLYPH_20.height / 1000}em` }}
          aria-hidden="true"
        >
          <path d={outline} />
        </svg>
        <span className="brand__tail" aria-hidden="true">
          {/* Both tails sit hidden in one cell, so the bar keeps the wider one's width
              while the text types and the font loads before it is first needed. */}
          <span>{NAME}</span>
          <span className="brand__occult">{SWAPPED}</span>
          <span className={tail && SWAPPED.startsWith(tail) ? "brand__occult" : undefined}>{tail}</span>
        </span>
      </span>
    </a>
  );
}
