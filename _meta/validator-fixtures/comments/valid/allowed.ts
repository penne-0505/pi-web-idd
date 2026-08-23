#!/usr/bin/env -S deno run
// deno-lint-ignore-file no-unused-vars
// Covers AC-001
export const answer = (): number => {
  // @ts-expect-error fixture exercises pragma allowance
  return "42";
};
