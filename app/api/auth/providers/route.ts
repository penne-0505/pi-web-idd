import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

// intent: DEC-534 — capability-based で OAuth login を持つ provider を列挙（dual-auth も含む）
export async function GET() {
  const modelRuntime = await ModelRuntime.create();
  const providers = buildOAuthProviderList(await collectProviderListingInputs(modelRuntime));
  return Response.json({ providers });
}
