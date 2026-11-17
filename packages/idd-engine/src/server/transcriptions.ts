import { readRoles, type SttConfig } from "@idd/lane";

/**
 * Speech to text through the provider the `stt` block names. The caller sends the whole audio in one request
 * and gets the text back; the audio is never written to disk. The key is read from the environment variable
 * the block names and taken out of this process's environment the first time it is used, so an agent this
 * engine starts cannot read it.
 */

/** the keys taken out of the environment, by the variable each came from */
const capturedKeys = new Map<string, string>();

/** how long a provider call may take before it is cut */
const STT_TIMEOUT_MS = 120_000;

/** what a transcription refuses, with the status its door answers */
export class TranscriptionRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TranscriptionRefused";
  }
}

/** the `stt` block, or undefined when roles.yaml cannot be read or carries none */
export function readSttConfig(): SttConfig | undefined {
  try { return readRoles().stt; } catch { return undefined; }
}

/**
 * Take the `stt` key out of `env` into this process's memory, so the engine's own environment (and every
 * child it starts) no longer holds it. Called once at startup; the first transcription also does it, so a
 * test that never runs `main` still leaves the variable gone.
 */
export function captureSttKey(env: NodeJS.ProcessEnv = process.env): void {
  const stt = readSttConfig();
  if (!stt) return;
  const value = env[stt.apiKeyEnv];
  if (typeof value === "string" && value) capturedKeys.set(stt.apiKeyEnv, value);
  delete env[stt.apiKeyEnv];
}

function sttKeyValue(stt: SttConfig): string | undefined {
  const captured = capturedKeys.get(stt.apiKeyEnv);
  if (captured !== undefined) return captured;
  const value = process.env[stt.apiKeyEnv];
  if (typeof value === "string" && value) {
    capturedKeys.set(stt.apiKeyEnv, value);
    delete process.env[stt.apiKeyEnv];
    return value;
  }
  return undefined;
}

/** every occurrence of the key in provider text is hidden before it can reach a response or a log */
function redact(text: string, key: string): string {
  return key ? text.split(key).join("[stt-key]") : text;
}

function collectText(payload: unknown): string {
  const candidates = (payload as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return "";
  let text = "";
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } } | null)?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const t = (part as { text?: unknown } | null)?.text;
      if (typeof t === "string") text += t;
    }
  }
  return text.trim();
}

/**
 * Transcribe one audio in one call. The block and the key are checked before anything leaves this process;
 * a provider failure is reported as 502, a timeout as 504.
 */
export async function transcribe(audio: Uint8Array, mimeType: string): Promise<{ text: string; model: string }> {
  const stt = readSttConfig();
  if (!stt) throw new TranscriptionRefused("文字起こしは設定されていません（roles.yaml の stt）", 503);
  const key = sttKeyValue(stt);
  if (!key) throw new TranscriptionRefused(`文字起こしの鍵（環境変数 ${stt.apiKeyEnv}）がありません`, 503);
  const url = `${stt.baseUrl}/v1beta/models/${encodeURIComponent(stt.model)}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: Buffer.from(audio).toString("base64") } }] }],
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // the key rides in a header, not the URL: a URL turns up in error text and proxies
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new TranscriptionRefused(aborted ? "文字起こしが時間切れになりました" : `文字起こしの呼び出しに失敗しました: ${redact(String(err instanceof Error ? err.message : err), key)}`, aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new TranscriptionRefused(`文字起こしの API が失敗しました (${res.status}): ${redact(text.slice(0, 400), key)}`, 502);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new TranscriptionRefused("文字起こしの応答を読めませんでした", 502); }
  const result = collectText(payload);
  if (!result) throw new TranscriptionRefused("文字起こしの結果が空でした", 502);
  return { text: result, model: stt.model };
}

/** the audio kinds this door accepts, by the Media-Type it is sent with */
export function isAudioType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().split(";")[0].trim().startsWith("audio/");
}
