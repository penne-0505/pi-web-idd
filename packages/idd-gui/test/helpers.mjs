import { createJiti } from "jiti";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { fakeFetch, snapshot } from "./fake.mjs";
import { decorate } from "./fixtures/items.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
export const h = React.createElement;
export const render = (element) => renderToStaticMarkup(element);
/** a card as the engine sends it: with its own answer on it (`decision`), made by the engine's function */
export const answered = decorate;
/** load a source file by its path under the package root, e.g. load("src/shell/AppShell.tsx") */
export const load = (path) => jiti.import(resolve(HERE, "..", path));

const { emptyDrafts } = await load("./src/inbox/drafts.ts");
const { requestFor } = await load("./src/inbox/requests.ts");

/** how the engine's answer on the card says this intent is signed: "none", "passkey" or "passkey_or_pin" */
export const signatureOf = (intent, item) => requestFor(intent, item)?.signature ?? "none";
const { InboxStore } = await load("./src/inbox/useDecide.ts");

/** run the inbox store against one state answer (at `now`) and hand back the store's own state */
export async function readInbox(items, extra, now) {
  const engine = fakeFetch();
  const store = new InboxStore(engine.fetchFn, () => now);
  const read = store.read();
  engine.calls[0].respond(200, snapshot(items, extra));
  await read;
  return store.state;
}

const noop = () => {};
/** the inbox view model's handlers, each doing nothing */
export const NOOP = { focus: noop, note: noop, openNote: noop, closeNote: noop, select: noop, setTab: noop, setQuestion: noop, shipField: noop, outboundField: noop, outboundReply: noop, goName: noop, purposeRestate: noop, purposeWithdraw: noop, wake: noop, unignore: noop, retry: noop, clearReceipt: noop, dispatch: noop };
/** the inbox screen's own state with nothing open, `over` laid on top */
export const ui = (over = {}) => ({ noteOpen: false, askOpen: false, note: "", selection: null, question: 0, confirm: null, drafts: emptyDrafts(), tab: null, ...over });
