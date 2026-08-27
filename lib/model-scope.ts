import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  resolveModelScopeWithDiagnostics,
  type ModelRuntime,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const THINKING_LEVEL_SUFFIXES = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// intent: DEC-179 — enabledModels の解決は pi 側 resolver に委譲し、glob/fuzzy/:level を独自実装しない (#307 の再発防止)

export interface ModelScopeResult {
  visible: readonly Model<Api>[];
  scopedModels: readonly ScopedModel[];
  thinkingLevelPins: Record<string, string>;
  warnings: string[];
}

export interface InitialModelScopeOptions {
  requestedModel?: { provider: string; modelId: string };
  defaultModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface InitialModelScopeResult {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  scopedModels: ScopedModel[];
}

function matchesModel(
  model: { provider: string; id: string },
  ref: { provider: string; modelId: string },
): boolean {
  return model.provider === ref.provider && model.id === ref.modelId;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function exactReferenceMatches(pattern: string, models: readonly Model<Api>[]): Model<Api>[] {
  const normalized = pattern.toLowerCase();
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonical.length > 0) return canonical;
  return models.filter((model) => model.id.toLowerCase() === normalized);
}

function assertNoAmbiguousExactPatterns(
  patterns: readonly string[],
  models: readonly Model<Api>[],
): void {
  for (const pattern of patterns) {
    if (hasGlob(pattern)) continue;

    let matches = exactReferenceMatches(pattern, models);
    if (matches.length === 0) {
      const colonIndex = pattern.lastIndexOf(":");
      const suffix = colonIndex >= 0 ? pattern.slice(colonIndex + 1) : "";
      if (THINKING_LEVEL_SUFFIXES.has(suffix as ThinkingLevel)) {
        matches = exactReferenceMatches(pattern.slice(0, colonIndex), models);
      }
    }

    if (matches.length > 1) {
      const references = matches
        .map((model) => `${model.provider}/${model.id}`)
        .sort()
        .join(", ");
      throw new Error(
        `Ambiguous enabledModels entry "${pattern}" matches multiple models: ${references}. Use provider/modelId.`,
      );
    }
  }
}

// intent: DEC-180 — 空 / 解決失敗時は available 全体にフォールバックし、typo や stale 設定で UI から選択肢を消さない

export async function resolveVisibleModels(
  modelRuntime: ModelRuntime,
  patterns: string[] | undefined,
): Promise<ModelScopeResult> {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return {
      visible: await modelRuntime.getAvailable(),
      scopedModels: [],
      thinkingLevelPins: {},
      warnings: [],
    };
  }

  const available = await modelRuntime.getAvailable();
  assertNoAmbiguousExactPatterns(cleaned, available);
  const snapshotRuntime = {
    getAvailable: async () => available,
  } as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(cleaned, snapshotRuntime);
  const warnings = diagnostics.map((diagnostic) => diagnostic.message);
  if (scopedModels.length === 0) {
    return {
      visible: available,
      scopedModels: [],
      thinkingLevelPins: {},
      warnings,
    };
  }

  // intent: DEC-181 — `:level` サフィックスの thinking pin は matched 全 model について報告し、client の pre-select 側から引ける状態にする
  const thinkingLevelPins: Record<string, string> = {};
  for (const scoped of scopedModels) {
    if (scoped.thinkingLevel) {
      thinkingLevelPins[`${scoped.model.provider}/${scoped.model.id}`] = scoped.thinkingLevel;
    }
  }
  return {
    visible: scopedModels.map((scoped) => scoped.model),
    scopedModels,
    thinkingLevelPins,
    warnings,
  };
}

// intent: DEC-182 — 初期 model 選択は requested → scope 内 default → resolver 先頭の順で確定させ、pi の起動則と一致させる

export function selectInitialModelScope(
  scope: ModelScopeResult,
  options: InitialModelScopeOptions = {},
): InitialModelScopeResult {
  const requestedRef = options.requestedModel;
  const defaultRef = options.defaultModel;
  const requested = requestedRef
    ? scope.visible.find((model) => matchesModel(model, requestedRef))
    : undefined;
  if (requestedRef && !requested) {
    throw new Error(
      `Model is not available in the enabled scope: ${requestedRef.provider}/${requestedRef.modelId}`,
    );
  }

  const requestedScoped = requested
    ? scope.scopedModels.find((scoped) => scoped.model === requested
      || matchesModel(scoped.model, { provider: requested.provider, modelId: requested.id }))
    : undefined;
  const defaultScoped = !requested && defaultRef
    ? scope.scopedModels.find((scoped) => matchesModel(scoped.model, defaultRef))
    : undefined;
  const fallbackScoped = !requested ? (defaultScoped ?? scope.scopedModels[0]) : undefined;
  const defaultVisible = !requested && !fallbackScoped && defaultRef
    ? scope.visible.find((model) => matchesModel(model, defaultRef))
    : undefined;
  const selectedModel = requested ?? fallbackScoped?.model ?? defaultVisible;
  const scopedSelection = requestedScoped ?? fallbackScoped;
  const thinkingLevel = options.thinkingLevel ?? scopedSelection?.thinkingLevel;

  return {
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    scopedModels: [...scope.scopedModels],
  };
}
