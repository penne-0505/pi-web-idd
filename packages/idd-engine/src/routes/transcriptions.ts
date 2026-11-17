import { json } from "../http.ts";
import { isAudioType, readSttConfig, transcribe, TranscriptionRefused } from "../server/transcriptions.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/transcriptions — the request body is the audio itself and its `Content-Type` says which kind.
 * The audio is held in memory for the one provider call and never written to disk. A body that is not audio
 * or is empty is 400, one over the block's limit is 413, a missing block or key is 503, and a provider
 * failure is 502.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const contentType = req.headers.get("content-type");
    if (!isAudioType(contentType)) {
      return json({ ok: false, error: "音声の Content-Type（audio/...）で送ってください" }, { status: 400, headers: NO_STORE });
    }
    const audio = new Uint8Array(await req.arrayBuffer());
    if (!audio.length) return json({ ok: false, error: "音声が空です" }, { status: 400, headers: NO_STORE });
    const stt = readSttConfig();
    if (!stt) return json({ ok: false, error: "文字起こしは設定されていません（roles.yaml の stt）" }, { status: 503, headers: NO_STORE });
    if (audio.length > stt.maxBytes) {
      return json({ ok: false, error: `音声が大きすぎます（上限 ${stt.maxBytes} byte）` }, { status: 413, headers: NO_STORE });
    }
    const result = await transcribe(audio, (contentType as string).split(";")[0].trim());
    return json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof TranscriptionRefused) return json({ ok: false, error: err.message }, { status: err.status, headers: NO_STORE });
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 502, headers: NO_STORE });
  }
}
