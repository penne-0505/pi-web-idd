export type Locale = "en" | "zh-CN";

export type TranslationParams = Record<string, string | number>;

export interface LocalePlugin {
  id: string;
  label: string;
  messages: Record<string, string>;
}
