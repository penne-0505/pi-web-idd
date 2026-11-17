import { json } from "../http.ts";
import { keepSleeping, sleep, snooze, wake } from "../server/snooze";
import { SNOOZE_DEFAULT_MINUTES } from "../../../../lib/idd-ui/snooze.ts";


/**
 * "あとで" and "寝かせる" on an inbox card: { key, minutes? } puts it off, { key, sleep: true } puts it to sleep,
 * { key, keepSleeping: true } answers the ask with "まだ寝かせる", { key, wake: true } brings it back to the front
 */
export async function POST(req: Request) {
  let body: { key?: unknown; minutes?: unknown; wake?: unknown; sleep?: unknown; keepSleeping?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) return json({ ok: false, error: "key が空" }, { status: 400 });
  try {
    if (body.wake === true) {
      await wake(key);
      return json({ ok: true });
    }
    if (body.sleep === true) {
      await sleep(key);
      return json({ ok: true });
    }
    if (body.keepSleeping === true) {
      const kept = await keepSleeping(key);
      return json(kept ? { ok: true } : { ok: false, error: "寝かせているカードではありません（画面を更新してください）" }, { status: kept ? 200 : 400 });
    }
    const minutes = typeof body.minutes === "number" && body.minutes > 0 && body.minutes <= 7 * 24 * 60 ? body.minutes : SNOOZE_DEFAULT_MINUTES;
    const until = await snooze(key, minutes);
    return json({ ok: true, until });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
