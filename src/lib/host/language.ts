// The server's side of the translations: every catalog is loaded, and the text
// a request produces is in the language its browser sent. Background work (the
// monitor, notifications) uses the language chosen for notifications.
import { AsyncLocalStorage } from "node:async_hooks";
import { type Catalog, type Language, addCatalog, isLanguage, setLanguageSource } from "../i18n";
import ar from "../locales/ar.json";
import bn from "../locales/bn.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import hi from "../locales/hi.json";
import pt from "../locales/pt.json";
import ro from "../locales/ro.json";
import ru from "../locales/ru.json";
import ur from "../locales/ur.json";
import zh from "../locales/zh.json";

for (const [language, catalog] of Object.entries({ ar, bn, es, fr, hi, pt, ro, ru, ur, zh })) addCatalog(language as Language, catalog as Catalog);
// Kept on globalThis, like the actor, so every module copy shares it.
const requestLanguage = ((globalThis as { lscLanguage?: AsyncLocalStorage<Language> }).lscLanguage ??= new AsyncLocalStorage<Language>());
let backgroundLanguage: () => Language = () => "en";
setLanguageSource(() => requestLanguage.getStore() ?? backgroundLanguage());
export function setBackgroundLanguage(get: () => Language) {
  backgroundLanguage = get;
}
export function inLanguage<T>(language: unknown, work: () => T) {
  return requestLanguage.run(isLanguage(language) ? language : "en", work);
}
