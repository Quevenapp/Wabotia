// Moldura das páginas públicas (web/DESIGN.md §9): barra do topo com a marca
// do app, alternância de tema e rodapé, no mesmo estilo do painel.
import React, { useEffect } from "react";
import { ArrowUpRight, Monitor, Moon, Sun } from "lucide-react";
import { Logo } from "../ui";
import { applyTheme, useTheme, type ThemeMode } from "../lib/theme";
import "../styles/site.css";

const order: ThemeMode[] = ["system", "light", "dark"];
const names: Record<ThemeMode, string> = {
  system: "Sistema",
  light: "Claro",
  dark: "Escuro",
};

/** Botão que alterna Sistema → Claro → Escuro. */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun;
  const next = order[(order.indexOf(mode) + 1) % order.length];
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Aparência: ${names[mode]}. Mudar para ${names[next]}`}
      title={`Aparência: ${names[mode]}`}
      onClick={() => setMode(next)}
    >
      <Icon size={19} />
    </button>
  );
}

export function SitePage({
  className = "",
  nav,
  children,
  footer = true,
}: {
  className?: string;
  /** Links e ações à direita da marca. */
  nav?: React.ReactNode;
  children: React.ReactNode;
  footer?: boolean;
}) {
  useEffect(() => {
    applyTheme();
  }, []);
  return (
    <div className={"site " + className}>
      <header className="site-nav">
        <div className="site-nav-inner">
          <Logo />
          <nav className="site-nav-links" aria-label="Páginas">
            {nav}
          </nav>
          <ThemeToggle />
        </div>
      </header>
      {children}
      {footer && (
        <footer className="site-footer">
          <div className="site-footer-inner">
            <Logo size={26} />
            <span>MIT · Quevenapp</span>
            <a href="/privacidade">Privacidade</a>
            <a href="https://github.com/Quevenapp/Wabotia">
              Código no GitHub <ArrowUpRight size={14} />
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}
