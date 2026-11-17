import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const TOKENS = join(SRC, "styles", "tokens.css");

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("the ported tokens file is the only value place, and the old one is gone", () => {
  assert.equal(existsSync(join(SRC, "tokens.css")), false, "the old src/tokens.css must be gone");
  assert.equal(existsSync(join(SRC, "app.css")), false, "the old src/app.css must be gone");
  assert.equal(existsSync(TOKENS), true, "src/styles/tokens.css holds the values");
});

test("every token a part or the view model references is declared in the tokens file", () => {
  const css = readFileSync(TOKENS, "utf8");
  const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set();
  for (const file of files(SRC)) {
    if (file === TOKENS) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(match[1]);
  }
  const missing = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], "a var() reference with no declaration");
});

test("the role names the ported parts use are declared", () => {
  const css = readFileSync(TOKENS, "utf8");
  const required = [
    // ink, ground, lines
    "--ink", "--ink-2", "--ink-3", "--line", "--line-soft", "--surface", "--surface-sunk",
    "--bg-page", "--bg-inbox", "--bg-sidebar", "--bg-panel", "--bg-panel-alt", "--bg-hover", "--bg-canvas",
    // role colours
    "--attention", "--attention-bg", "--sign", "--sign-bg", "--sign-text", "--external", "--ok", "--inbound",
    // type
    "--font-sans", "--font-mono",
    // frames and shadows
    "--shadow-pop", "--shadow-sheet", "--shadow-panel", "--shadow-window", "--scrim", "--window-line",
    // motion
    "--ease-out", "--ease-in", "--ease-pop",
  ];
  for (const name of required) assert.match(css, new RegExp(`${name}\\s*:`), name);
});

test("no part but the tokens file names a colour, a font or a motion curve", () => {
  const offenders = [];
  for (const file of files(SRC)) {
    if (file === TOKENS) continue;
    const text = readFileSync(file, "utf8");
    const patterns = [/#[0-9a-fA-F]{6}\b/, /\boklch\(/, /\brgba?\(/, /\bhsla?\(/, /IBM Plex/, /cubic-bezier\(/];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) offenders.push(`${relative(SRC, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the font is loaded from the tokens file, not from the entry html", () => {
  const css = readFileSync(TOKENS, "utf8");
  assert.match(css, /@import\s+url\(['"]https:\/\/fonts\.googleapis\.com\/css2\?family=IBM\+Plex/);
  const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
  assert.equal(html.includes("IBM+Plex"), false, "the entry html carries no font name");
  assert.equal(html.includes("IBM Plex"), false);
});
