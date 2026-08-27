import { enLocale } from "./messages/en";
import { zhCNLocale } from "./messages/zh-CN";
import type { Locale, LocalePlugin } from "./types";

const localePlugins = new Map<string, LocalePlugin>();

// intent: DEC-235 — 重複登録は throw して翻訳の静黙上書きを防ぐ

export function registerLocale(plugin: LocalePlugin): void {
  if (!plugin.id.trim()) throw new Error("Locale id must not be empty");
  if (localePlugins.has(plugin.id)) throw new Error(`Locale already registered: ${plugin.id}`);
  localePlugins.set(plugin.id, plugin);
}

export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.get(id);
}

export function getSupportedLocales(): string[] {
  return [...localePlugins.keys()];
}

// intent: DEC-235 — 未対応言語は英語に fallback して常に UI が読める状態を保つ

export function resolveBrowserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  }
  return "en";
}

registerLocale(enLocale);
registerLocale(zhCNLocale);
