/**
 * Defaults of the review loop that its readers must reach without the config file's Node imports.
 *
 * `pipeline.ts` parses `roles.yaml` (fs, yaml), but the loop's ledger reads these values too, and the ledger runs
 * in the screen's bundle (the submit card reads the loop's ledger).
 * A value kept here can be taken by both sides without dragging the server's code into the browser build.
 */

/** the shoulds one `triage`-value judgement may recommend fixing before penne is asked, when roles.yaml names none */
export const DEFAULT_MAX_SHOULD_FIX = 2;
