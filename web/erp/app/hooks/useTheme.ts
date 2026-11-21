// Vinki: o tema do ERP segue a preferência do painel (web/lib/theme.ts,
// Sistema / Claro / Escuro, em <html data-theme>). O botão de tema do ERP troca
// a do painel; a preferência "Habilita tema escuro" salva no ERP não sobrescreve
// a escolha feita no Vinki (PLANO-FAGOO-PAINEL.md, B). Original do Fagoo em
// web/erp/ORIGEM.json (hooks/useTheme.ts).
import { useEffect, useState } from 'react';
import { setThemeMode } from '../../../lib/theme';

export type Theme = 'light' | 'dark';

/** O tema em vigor é o que o painel pôs no <html>. */
export function readTheme(): Theme {
  try { return globalThis.document?.documentElement?.dataset.theme === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

/** No Fagoo aplicava o tema salvo nas Preferências; no Vinki quem manda é a casca. */
export function applyStoredTheme(_theme: Theme) { /* tema do painel: web/lib/theme.ts */ }

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || !globalThis.document?.documentElement) return;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return { theme, toggle: () => setThemeMode(readTheme() === 'dark' ? 'light' : 'dark') };
}
