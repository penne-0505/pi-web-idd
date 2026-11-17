import { json } from "../http.ts";
import { planModeStart } from "@idd/lane";

/**
 * The mode's plan: cwd, tools, model, thinking and the role's agent dir, which is prepared here.
 * Starting pi is the GUI's (its own process owns the session the screen streams from).
 */
export async function POST(_req: Request, params: Record<string, string>) {
  try {
    const plan = planModeStart(params.name);
    return json({ ok: true, plan });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 400 });
  }
}
