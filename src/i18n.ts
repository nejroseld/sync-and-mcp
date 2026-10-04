import { moment } from "obsidian";
import { ru } from "./locales/ru";

export type Language = "en" | "ru";

/** Obsidian sets Moment's locale to the language selected in its interface. */
export const resolveLanguage = (locale?: string): Language =>
  locale?.toLowerCase().split(/[-_]/)[0] === "ru" ? "ru" : "en";

export const currentLanguage = (): Language => {
  const obsidianLocale = moment.locale();
  return resolveLanguage(obsidianLocale || navigator.language);
};

/** English keys are the fallback, so a missing translation remains readable. */
export const t = (english: string, params?: Record<string, string | number>): string => {
  const template = currentLanguage() === "ru" ? ru[english] ?? english : english;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key] ?? `{${key}}`));
};
