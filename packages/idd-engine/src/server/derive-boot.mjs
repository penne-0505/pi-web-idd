import { register } from "node:module";

// node cannot read the tsconfig path aliases that Next and bun use for the workspace packages, so the child is
// started through this file when the engine itself is not bun: the same loader the engine's node tests register,
// then the child. bun resolves the aliases on its own and starts `derive-child.ts` directly.
register("./idd-core-alias.loader.mjs", import.meta.url);
await import("./derive-child.ts");
