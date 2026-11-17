/**
 * The JST calendar day an instant belongs to, as `YYYY-MM-DD`. The screens' clocks are Japan time and penne's day
 * is too, so "today" is cut at 0:00 JST wherever a day is summed: today's spend, and the cards answered today.
 */
const JST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

/** the JST day of an instant (an ISO string, epoch ms, or Date); an unreadable instant has no day */
export function jstDay(at: string | number | Date): string {
  const t = typeof at === "string" ? Date.parse(at) : at instanceof Date ? at.getTime() : at;
  return Number.isFinite(t) ? JST_DAY.format(t) : "";
}
