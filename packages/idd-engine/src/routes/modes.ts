import { json } from "../http.ts";
import { readModes } from "@idd/lane";

export async function GET() {
  try {
    return json({ modes: Object.values(readModes()) });
  } catch (err) {
    return json({ modes: [], error: String(err) }, { status: 500 });
  }
}
