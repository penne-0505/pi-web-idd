/**
 * The one place a time is turned into a place on the chart. The minimap, the full band and the detail's strip all
 * share it, so a span that looks longer than another does so in each of them (the plan's 時刻 → 位置の変換は
 * 純粋な関数 1 つにまとめ, DEC-103-3 keeps the stage spans themselves in one place).
 */

export interface TimeWindow {
  from: number;
  to: number;
}

const HOUR = 3600 * 1000;

/** the shown window: a few hours back from now and a little ahead, widened to hold every given start */
export function timeWindow(starts: string[], now: number, backHours = 8): TimeWindow {
  const times = starts.map((s) => Date.parse(s)).filter((t) => !Number.isNaN(t));
  const back = now - backHours * HOUR;
  const from = times.length ? Math.min(back, ...times) : back;
  return { from, to: now + HOUR / 2 };
}

/** where a time sits in the window, 0 at its left edge and 1 at its right; clamped to the window */
export function timePosition(t: number, w: TimeWindow): number {
  if (!(w.to > w.from)) return 0;
  return Math.min(1, Math.max(0, (t - w.from) / (w.to - w.from)));
}

/** a span as the chart draws it: its two edges in the window, `to` equal to `from` for an open span */
export function spanPosition(span: { start: string; end?: string }, w: TimeWindow): { from: number; to: number } {
  const a = timePosition(Date.parse(span.start), w);
  const b = span.end ? timePosition(Date.parse(span.end), w) : 1;
  return { from: a, to: Math.max(a, b) };
}

const JST = 9 * HOUR;

/** a clock label in JST, the day the engine writes its records in */
export function clockLabel(t: number): string {
  return new Date(t + JST).toISOString().slice(11, 16);
}

/** the ticks of the band's axis, evenly spaced across the window */
export function axisTicks(w: TimeWindow, count = 5): { pos: number; label: string }[] {
  const n = Math.max(2, count);
  return Array.from({ length: n }, (_, i) => {
    const pos = i / (n - 1);
    return { pos, label: clockLabel(w.from + (w.to - w.from) * pos) };
  });
}
