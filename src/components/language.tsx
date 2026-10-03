"use client";
import { LANGUAGES, type Language, language, t } from "@/lib/i18n";
import { applyLanguage } from "@/lib/language";
import { Languages } from "lucide-react";
// The language of this browser, chosen anywhere: sign-in, setup, Settings.
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const select = (
    <select
      aria-label={t("Language")}
      value={language()}
      onChange={(event) => void applyLanguage(event.target.value as Language, true)}
    >
      {LANGUAGES.map((item) => <option key={item.id} value={item.id} lang={item.id}>{item.name}</option>)}
    </select>
  );
  if (compact) return <div className="language-select"><Languages size={16} aria-hidden />{select}</div>;
  return <label>{t("Language")}{select}<small>{t("Saved in this browser. The dashboard and its messages use it; notifications have their own language under Notifications.")}</small></label>;
}
