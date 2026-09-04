/** Peru stays on UTC-5 year-round; naming the IANA zone keeps callers from
 * accidentally formatting with the machine's local timezone (the VPS and a
 * visitor's browser do not necessarily agree). */
export const PERU_TIME_ZONE = "America/Lima";
const PERU_UTC_OFFSET_HOURS = 5;

const peruFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PERU_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

export type PeruDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function peruDateParts(value: number | string | Date): PeruDateParts {
  const values = Object.fromEntries(
    peruFormatter.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

/** Returns the next UTC instant at the requested local Lima hour. */
export function nextPeruHourUtc(now: number, hour: number) {
  const current = peruDateParts(now);
  const day = current.hour < hour ? current.day : current.day + 1;
  return Date.UTC(current.year, current.month - 1, day, hour + PERU_UTC_OFFSET_HOURS);
}
