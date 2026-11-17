/**
 * Which changed paths a long-lived process would read again.
 *
 * The judgment is deliberately lopsided: only paths known not to be read again are called ineffective, and
 * everything else counts as effective. Missing an effective change leaves stale code running; counting an
 * ineffective one costs one quiet restart. The engine and the screen each ask about their own side.
 */

const RECORDS = [/^_docs\//, /^_meta\//, /^TODO\.md$/];
/** settings the engine (and the agents it starts) read on every use, so a change lands without a restart */
const CONFIG = [/^config\//];
const TESTS = [/(^|\/)test\//, /(^|\/)__tests__\//, /\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/];
/** places only the screen's bundle reads (the engine serves `dist/` from disk on every request, so a change needs a rebuild and no restart) */
const GUI_ONLY = [/^packages\/idd-gui\//];
/** places only the engine's entry reads */
const ENGINE_ONLY = [/^bin\//];

const matches = (patterns: readonly RegExp[], path: string): boolean => patterns.some((p) => p.test(path));

/** whether a changed path is read again by the engine, by the screen, or by neither */
export function pathEffect(path: string): { engine: boolean; gui: boolean } {
  if (matches(RECORDS, path) || matches(CONFIG, path) || matches(TESTS, path)) return { engine: false, gui: false };
  if (matches(ENGINE_ONLY, path)) return { engine: true, gui: false };
  if (matches(GUI_ONLY, path)) return { engine: false, gui: true };
  // unknown places fall here on purpose: a new directory is counted as effective for both, never silently missed
  return { engine: true, gui: true };
}

/** the union of the paths' effects: any effective path marks that side */
export function effectsOf(paths: readonly string[]): { engine: boolean; gui: boolean } {
  let engine = false;
  let gui = false;
  for (const path of paths) {
    const e = pathEffect(path);
    engine = engine || e.engine;
    gui = gui || e.gui;
  }
  return { engine, gui };
}
