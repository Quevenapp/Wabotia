// Tema Sistema / Claro / Escuro (web/DESIGN.md §1). A primeira pintura é
// resolvida por um script em index.html; aqui ficam a troca e a escuta.
import { useEffect, useState } from "react";
import { readText, writeText } from "./storage";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "wabotia:theme";
const listeners = new Set<() => void>();
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function themeMode(): ThemeMode {
  const saved = readText(KEY, "system");
  return saved === "light" || saved === "dark" ? saved : "system";
}
export const resolvedTheme = (mode = themeMode()) =>
  mode === "system" ? (media().matches ? "dark" : "light") : mode;

export function applyTheme(mode = themeMode()) {
  const theme = resolvedTheme(mode);
  document.documentElement.dataset.theme = theme;
  // A cor da barra do navegador acompanha o token de fundo do tema ativo.
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue("--panel")
    .trim();
  if (color)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
}
export function setThemeMode(mode: ThemeMode) {
  writeText(KEY, mode);
  applyTheme(mode);
  listeners.forEach((listener) => listener());
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  media().addEventListener("change", () => {
    if (themeMode() === "system") {
      applyTheme("system");
      listeners.forEach((listener) => listener());
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) {
      applyTheme();
      listeners.forEach((listener) => listener());
    }
  });
}

export function useTheme() {
  const [, bump] = useState(0);
  useEffect(() => {
    wire();
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    mode: themeMode(),
    theme: resolvedTheme() as "light" | "dark",
    setMode: setThemeMode,
  };
}
