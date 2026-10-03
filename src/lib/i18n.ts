// Translations, shared by the browser and the server. The English text is the
// key: t("Add script") returns it in the current language, or in English when
// a translation is missing. {name} in a text is replaced by vars.name. A text
// that depends on a number is written "{count} script|{count} scripts" (one and
// other in English) and translated per plural category of the language.
//
// The browser's language is chosen in Settings and kept per browser; requests
// send it, so the server answers in it too. Notifications use the language
// chosen for them in Settings → Notifications.
export const LANGUAGES = [
  { id: "en", name: "English", dir: "ltr" },
  { id: "ro", name: "Română", dir: "ltr" },
  { id: "zh", name: "中文", dir: "ltr" },
  { id: "hi", name: "हिन्दी", dir: "ltr" },
  { id: "es", name: "Español", dir: "ltr" },
  { id: "ar", name: "العربية", dir: "rtl" },
  { id: "fr", name: "Français", dir: "ltr" },
  { id: "bn", name: "বাংলা", dir: "ltr" },
  { id: "pt", name: "Português", dir: "ltr" },
  { id: "ru", name: "Русский", dir: "ltr" },
  { id: "ur", name: "اردو", dir: "rtl" },
] as const;
export type Language = (typeof LANGUAGES)[number]["id"];
export type PluralEntry = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalog = Record<string, string | PluralEntry>;
export type Vars = Record<string, string | number>;

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.id === value);
}
export function direction(language: Language) {
  return LANGUAGES.find((item) => item.id === language)?.dir ?? "ltr";
}
// The supported language closest to a list of preferred ones ("pt-BR" → pt).
export function matchLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

const catalogs: Partial<Record<Language, Catalog>> = {};
export function addCatalog(language: Language, catalog: Catalog) {
  catalogs[language] = catalog;
}
// The language of the text being produced: the browser's, or on the server the
// one of the request being handled (see setLanguageSource).
let current: Language = "en";
let source: () => Language = () => current;
export function setLanguage(language: Language) {
  current = language;
}
export function setLanguageSource(get: () => Language) {
  source = get;
}
export function language() {
  return source();
}

function fill(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
export function t(text: string, vars?: Vars) {
  const entry = catalogs[source()]?.[text];
  return fill(typeof entry === "string" && entry ? entry : text, vars);
}
// A text that depends on count: key "{count} script|{count} scripts".
export function tn(key: string, count: number, vars: Vars = {}) {
  const lang = source();
  const entry = catalogs[lang]?.[key];
  const values = { ...vars, count: count.toLocaleString(locale()) };
  if (entry && typeof entry === "object") {
    const category = new Intl.PluralRules(lang).select(count);
    const text = entry[category] ?? entry.other;
    if (text) return fill(text, values);
  }
  const [one, other = one] = key.split("|");
  return fill(count === 1 ? one : other, values);
}
// For number and date formatting in the chosen language.
export function locale() {
  const lang = source();
  return lang === "zh" ? "zh-CN" : lang === "pt" ? "pt-BR" : lang;
}
// Marks a text for translation where it is defined (a list of labels, say) and
// translated later, with t(), where it is shown.
export function msg(text: string) {
  return text;
}
