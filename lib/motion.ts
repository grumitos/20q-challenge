/**
 * The motion values motion/react components use, in seconds. The shared ones
 * mirror the stylesheet's tokens in app/globals.css (`:root`), where the
 * system is described; tests/ui-regressions.test.mjs keeps the two in step.
 */

/** `--ease`: a quick start that lands softly, with no overshoot. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export const DURATION = {
  /** `--switch`: a swap in place, like a switch's thumb sliding to the chosen option. */
  switch: 0.22,
  /** `--fill`: something reaching its size, like a row's detail opening. */
  fill: 0.3,
} as const;

/** Cards and rows arriving with the data: a short rise, one after another. */
export const ENTRANCE = {
  card: { duration: 0.45, step: 0.06 },
  row: { duration: 0.4, step: 0.035, maxDelay: 0.3 },
} as const;
