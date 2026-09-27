// Themes are chosen per browser and stored locally, so a phone and a desktop
// can use different ones. "system" follows the device's light or dark setting.
export const THEMES = [
  { id: "dark", name: "Dark", colors: ["#10151c", "#7dd3a7", "#f1f5f9"] },
  { id: "light", name: "Light", colors: ["#ffffff", "#157a4f", "#111827"] },
  { id: "nord", name: "Nord", colors: ["#2e3440", "#88c0d0", "#eceff4"] },
  { id: "dracula", name: "Dracula", colors: ["#282a36", "#bd93f9", "#f8f8f2"] },
  { id: "solarized", name: "Solarized", colors: ["#002b36", "#2aa198", "#fdf6e3"] },
  { id: "system", name: "System", colors: ["#10151c", "#ffffff", "#7dd3a7"] },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
const KEY = "lsc-theme";

export function savedTheme(): ThemeId {
  try {
    const value = localStorage.getItem(KEY);
    return THEMES.some((theme) => theme.id === value) ? (value as ThemeId) : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(id: ThemeId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
  const root = document.documentElement;
  if (id === "system") delete root.dataset.theme;
  else root.dataset.theme = id;
  // Match the mobile browser bar to the theme's page background.
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
}
