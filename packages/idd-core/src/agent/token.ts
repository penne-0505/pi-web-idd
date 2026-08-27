// intent: DEC-660 — agent が叩く書き込み口は token で閉じる (dev server を LAN に出しているため)

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { stateDir } from "../paths.ts";

export function agentToken(): string {
  const fromEnv = process.env.IDD_AGENT_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent-token");
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored) return stored;
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

// intent: DEC-661 — 書き戻し先は envelope に載る。port が既定と違う環境では env で上書きする
export function agentBaseUrl(): string {
  const explicit = process.env.IDD_AGENT_BASE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.PORT?.trim() || "30141";
  return `http://127.0.0.1:${port}`;
}

export function checkAgentToken(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = agentToken();
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}
