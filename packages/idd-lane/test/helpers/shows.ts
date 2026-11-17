import { expect } from "bun:test";

/** `text` has every sentence of `yes` and none of `no` */
export function shows(text: string, yes: string[], no: string[] = []): void {
  for (const sentence of yes) expect(text).toContain(sentence);
  for (const sentence of no) expect(text).not.toContain(sentence);
}
