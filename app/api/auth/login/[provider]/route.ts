import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

// intent: DEC-532 — SSE handler と POST handler を跨いだ OAuth flow state を globalThis registry で共有
declare global {
  var __piLoginCallbacks: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  return globalThis.__piLoginCallbacks;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const callbacks = registry.get(token);
  if (!callbacks) {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  // intent: DEC-532 — 別 provider の token を投げ込む攻撃を防ぐため provider prefix を検証
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }

  callbacks.resolve(code);
  registry.delete(token);
  return Response.json({ ok: true, provider });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // intent: DEC-532 — client 切断を ModelRuntime.login まで伝播させて server side promise の hang を回避
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const modelRuntime = await ModelRuntime.create();
      if (!modelRuntime.getProvider(provider)?.auth.oauth) {
        send(controller, { type: "error", message: `Unknown provider: ${provider}` });
        controller.close();
        return;
      }

      const registry = getCallbackRegistry();
      const activeTokens = new Set<string>();
      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;

      const createClientInputRequest = () => {
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);

        const promise = new Promise<string>((resolve, reject) => {
          registry.set(token, {
            resolve: (value) => {
              activeTokens.delete(token);
              registry.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              registry.delete(token);
              reject(error);
            },
          });
        });

        return { token, promise };
      };

      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest();
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      // intent: DEC-532 — cleanup で pending token を全 reject（client 切断・成功終了とも共通）
      const cleanup = () => {
        for (const token of activeTokens) {
          registry.get(token)?.reject(new Error("Login cancelled"));
          registry.delete(token);
        }
        activeTokens.clear();
      };

      abort.signal.addEventListener("abort", cleanup);

      try {
        await modelRuntime.login(provider, "oauth", {
          prompt: async (prompt: AuthPrompt) => {
            const request = prompt.type === "manual_code"
              ? getManualInputRequest()
              : createClientInputRequest();
            if (prompt.type === "select") {
              send(controller, {
                type: "select_request",
                message: prompt.message,
                options: prompt.options,
                token: request.token,
              });
            } else {
              send(controller, {
                type: "prompt_request",
                message: prompt.message,
                placeholder: prompt.placeholder ?? null,
                token: request.token,
              });
            }
            return request.promise;
          },
          notify: (event: AuthEvent) => {
            if (event.type === "auth_url") {
              const request = getManualInputRequest();
              send(controller, {
                type: "auth",
                url: event.url,
                instructions: event.instructions ?? null,
                token: request.token,
              });
            } else if (event.type === "device_code") {
              send(controller, {
                type: "device_code",
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds ?? null,
                expiresInSeconds: event.expiresInSeconds ?? null,
              });
            } else {
              send(controller, { type: "progress", message: event.message });
            }
          },
          signal: abort.signal,
        });

        invalidateModelsCache();
        send(controller, { type: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Login cancelled") {
          send(controller, { type: "error", message: msg });
        } else {
          send(controller, { type: "cancelled" });
        }
      } finally {
        cleanup();
        controller.close();
      }
    },
    cancel() {
      abort.abort();
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
