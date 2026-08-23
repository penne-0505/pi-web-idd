// intent: DEC-175 — provider 一覧は auth 宣言から派生させ、id 直書きの hardcode で漏れを起こさない

export type ProviderCredentialType = "api_key" | "oauth";

const CUSTOM_PROVIDER_SOURCES = new Set(["models_json_key", "models_json_command"]);

const OAUTH_DISPLAY_NAMES: Record<string, string> = {
  "openai-codex": "ChatGPT Plus/Pro",
  "github-copilot": "GitHub Copilot",
};

export interface ProviderListingInput {
  id: string;
  name: string;
  hasApiKeyLogin: boolean;
  hasOAuth: boolean;
  oauthName?: string;
  status: { configured: boolean; source?: string };
  credentialType?: ProviderCredentialType;
  modelCount: number;
}

export interface ApiKeyProviderListing {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
  supportsOAuth: boolean;
}

export interface OAuthProviderListing {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  supportsApiKey: boolean;
}

function dedupeById(providers: readonly ProviderListingInput[]): ProviderListingInput[] {
  const seen = new Set<string>();
  const result: ProviderListingInput[] = [];
  for (const provider of providers) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    result.push(provider);
  }
  return result;
}

// intent: DEC-176 — API-key list は models.json 由来と OAuth 認証中を外し、二重表示と cross-list 重複を避ける
export function buildApiKeyProviderList(
  providers: readonly ProviderListingInput[],
): ApiKeyProviderListing[] {
  const result: ApiKeyProviderListing[] = [];
  for (const provider of dedupeById(providers)) {
    if (!provider.hasApiKeyLogin) continue;
    if (provider.status.source && CUSTOM_PROVIDER_SOURCES.has(provider.status.source)) continue;

    const configured = provider.status.configured && provider.credentialType !== "oauth";
    result.push({
      id: provider.id,
      displayName: provider.name,
      configured,
      ...(configured && provider.status.source ? { source: provider.status.source } : {}),
      modelCount: provider.modelCount,
      supportsOAuth: provider.hasOAuth,
    });
  }
  return result;
}

export function buildOAuthProviderList(
  providers: readonly ProviderListingInput[],
): OAuthProviderListing[] {
  const result: OAuthProviderListing[] = [];
  for (const provider of dedupeById(providers)) {
    if (!provider.hasOAuth) continue;
    result.push({
      id: provider.id,
      name: OAUTH_DISPLAY_NAMES[provider.id] ?? provider.oauthName ?? provider.name,
      usesCallbackServer: false,
      loggedIn: provider.credentialType === "oauth",
      supportsApiKey: provider.hasApiKeyLogin,
    });
  }
  return result;
}
