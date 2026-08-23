import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// intent: DEC-529 — running session ids を SSE で push、sidebar は idle 時に poll しない
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // intent: DEC-529 — subscribe を snapshot より先にして gap を塞ぐ
      const unsubscribe = subscribeRunningSessions((ids) => {
        try {
          encode({ type: "running", runningSessionIds: ids });
        } catch {
          // intent: DEC-523 — controller 既 close 時の enqueue エラーは握り潰す
        }
      });

      // intent: DEC-529 — initial snapshot で接続直後の UI 空白を防ぐ（duplicate は client 側で同一化）
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds() });

      // intent: DEC-529 — proxy の idle close 対策 heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // intent: DEC-523 — controller 既 close 時の enqueue エラーは握り潰す
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch {}
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
