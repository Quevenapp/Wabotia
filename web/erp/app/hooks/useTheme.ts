// Wabotia: o tema do ERP segue a preferência do painel (web/lib/theme.ts,
// Sistema / Claro / Escuro, em <html data-theme>). O botão de tema do ERP troca
// a do painel; a preferência "Habilita tema escuro" salva no ERP não sobrescreve
// a escolha feita no Wabotia (PLANO-FAGOO-PAINEL.md, B). Original do Fagoo em
// ORIGEM.json (hooks/useTheme.ts).
import { resolvedTheme, setThemeMode, useTheme as usePanelTheme } from '../../../lib/theme';

export type Theme = 'light' | 'dark';

export function readTheme(): Theme {
  try { return resolvedTheme() === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

/** No Fagoo aplicava o tema salvo nas Preferências; no Wabotia quem manda é a casca. */
export function applyStoredTheme(_theme: Theme) { /* tema do painel: web/lib/theme.ts */ }

export function useTheme() {
  const { theme } = usePanelTheme();
  return { theme: theme as Theme, toggle: () => setThemeMode(theme === 'dark' ? 'light' : 'dark') };
}
