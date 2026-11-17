import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PropterApp, type PropterAppProps } from "./PropterApp";
import { cardFromQuery, initialScreen } from "./screenHash";
import "./styles/global.css";

/**
 * The screen's door. The screen comes from the URL: `?view=chat` / `?view=lanes` / `?view=inbox&card=IDD-246` pick it (a `card` is a lane's or a draft's id),
 * and `#work/<lane>` / `#work/all` add the Work selection, so a reload opens the same place. The query and the
 * hash are validated here; an unknown value is left out rather than cast, and the screen falls back to the Inbox.
 * The values the Work screen draws come from the engine's doors (see `src/work/viewmodel.ts`).
 */
const search = location.search;
const initial = initialScreen(search, location.hash);
const props: PropterAppProps = {
  startView: initial.view,
  startLane: initial.lane,
  startAll: initial.all,
  inboxCard: cardFromQuery(search) ?? undefined,
  keepAsk: new URLSearchParams(search).get("ask") === "branch" ? "branch" : "stream",
};

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <PropterApp {...props} />
    </StrictMode>,
  );
}
