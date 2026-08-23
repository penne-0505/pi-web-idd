import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildApiKeyProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

// intent: DEC-534 — capability-based で API key を受け付ける provider を列挙（dual-auth も含む）
export async function GET() {
  const modelRuntime = await ModelRuntime.create();
  const providers = buildApiKeyProviderList(await collectProviderListingInputs(modelRuntime));
  return Response.json({ providers });
}
