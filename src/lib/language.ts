// The browser's language: chosen in Settings and kept in this browser, or the
// closest one to the browser's own languages. A language's translations are
// downloaded only when it is used.
import { type Catalog, type Language, addCatalog, direction, isLanguage, matchLanguage, setLanguage } from "./i18n";

const KEY = "lsc-language";
const LOADERS: Record<Exclude<Language, "en">, () => Promise<{ default: Catalog }>> = {
  ro: () => import("./locales/ro.json"),
  zh: () => import("./locales/zh.json"),
  hi: () => import("./locales/hi.json"),
  es: () => import("./locales/es.json"),
  ar: () => import("./locales/ar.json"),
  fr: () => import("./locales/fr.json"),
  bn: () => import("./locales/bn.json"),
  pt: () => import("./locales/pt.json"),
  ru: () => import("./locales/ru.json"),
  ur: () => import("./locales/ur.json"),
};
export const LANGUAGE_CHANGED = "lsc-language-changed";

export function savedLanguage(): Language {
  try {
    const value = localStorage.getItem(KEY);
    if (isLanguage(value)) return value;
  } catch {}
  return matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}
// Loads and applies a language; remember keeps it as this browser's choice.
export async function applyLanguage(language: Language, remember = false) {
  if (language !== "en") addCatalog(language, (await LOADERS[language]()).default);
  setLanguage(language);
  document.documentElement.lang = language;
  document.documentElement.dir = direction(language);
  if (remember) {
    try { localStorage.setItem(KEY, language); } catch {}
  }
  window.dispatchEvent(new Event(LANGUAGE_CHANGED));
}
