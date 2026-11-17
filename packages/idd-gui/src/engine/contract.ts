/**
 * The screen's only outside door: everything the screen needs from the engine is re-exported from the engine's
 * `gui-contract`. Nothing here may reach into `lib/`, the engine's state reading, or `@idd/*`; keeping this the
 * single outside import is what keeps the server's code out of the screen's bundle.
 */
export * from "../../../idd-engine/src/gui-contract.ts";
