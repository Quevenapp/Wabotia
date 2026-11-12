// Casca do painel: trilho à esquerda, barra de abas no celular, faixas de
// estado e atalhos globais (web/DESIGN.md §2 e §10).
import React, { useEffect, useState } from "react";
import {
  BookOpen,
  CircleHelp,
  Code2,
  Contact,
  Ellipsis,
  FileText,
  Keyboard,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  Phone,
  Settings,
  SlidersHorizontal,
  Sun,
  Users,
  WifiOff,
} from "lucide-react";
import { Avatar, BrandMark, MenuButton } from "../ui";
import { linkProps, navigate, useRoute, type Area, type Route } from "../lib/routes";
import { useTheme } from "../lib/theme";
import { useApp } from "./AppContext";
import { PreferencesDialog, PresenceDialog, ShortcutsDialog } from "./chrome";

type Item = {
  area: Area;
  label: string;
  icon: typeof MessageCircle;
  count?: number;
  tone?: "accent" | "danger";
  countLabel?: string;
};

function useItems(): Item[] {
  const app = useApp();
  return [
    {
      area: "conversations",
      label: "Conversas",
      icon: MessageCircle,
      count: app.unreadTotal,
      countLabel: "não lidas",
    },
    {
      area: "tickets",
      label: "Protocolos",
      icon: FileText,
      count: app.ticketCounts.overdue || 0,
      tone: "danger",
      countLabel: "atrasados",
    },
    {
      area: "team",
      label: "Equipe",
      icon: Users,
      count: app.internalUnreadTotal,
      countLabel: "conversas internas não lidas",
    },
    {
      area: "calls",
      label: "Ligações",
      icon: Phone,
      count: app.ringingCalls.length,
      countLabel: "ligações tocando",
    },
    { area: "contacts", label: "Contatos", icon: Contact },
    { area: "admin", label: "Gestão", icon: Settings },
  ];
}

function NavLink({
  item,
  active,
  className,
}: {
  item: Item;
  active: boolean;
  className: string;
}) {
  const Icon = item.icon;
  const route: Route =
    item.area === "admin" ? { area: "admin", page: "overview" } : { area: item.area };
  return (
    <a
      {...linkProps(route)}
      className={className + (active ? " active" : "")}
      aria-current={active ? "page" : undefined}
      title={item.label}
    >
      <span className="nav-icon">
        <Icon size={22} strokeWidth={active ? 2.3 : 1.9} />
        {!!item.count && (
          <b
            className={"count-badge " + (item.tone || "accent")}
            aria-label={`${item.count} ${item.countLabel}`}
          >
            {item.count > 99 ? "99+" : item.count}
          </b>
        )}
      </span>
      <span className="nav-label">{item.label}</span>
    </a>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const route = useRoute();
  const items = useItems();
  const { mode, theme, setMode } = useTheme();
  const [dialog, setDialog] = useState<"" | "prefs" | "keys" | "presence">("");
  // Abaixo de 760 px a conversa, o protocolo ou a página aberta ocupa a tela
  // toda, sem a barra de abas (como no aplicativo).
  const detail =
    !!route.id || (route.area === "admin" && !!route.page && route.page !== "overview");

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.isContentEditable);
      if (
        (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) ||
        (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey)
      ) {
        const search = document.querySelector<HTMLInputElement>(
          "[data-global-search]",
        );
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }
      if (event.key === "?" && !typing && !document.querySelector(".modal")) {
        event.preventDefault();
        setDialog("keys");
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-6]$/.test(event.key)) {
        const item = items[Number(event.key) - 1];
        if (item) {
          event.preventDefault();
          navigate(
            item.area === "admin"
              ? { area: "admin", page: "overview" }
              : { area: item.area },
          );
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [items.length]);

  const ringing = app.ringingCalls[0];
  const ThemeIcon = mode === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <div className={"app" + (detail ? " in-detail" : "")}>
      <nav className="rail" aria-label="Áreas do painel">
        <a
          {...linkProps({ area: "conversations" })}
          className="rail-brand"
          aria-label="Wabotia"
        >
          <BrandMark size={38} />
        </a>
        <div className="rail-items">
          {items.map((item) => (
            <NavLink
              key={item.area}
              item={item}
              active={route.area === item.area}
              className="rail-item"
            />
          ))}
        </div>
        <div className="rail-bottom">
          <MenuButton
            label="Aparência"
            align="start"
            items={[
              {
                label: "Sistema" + (mode === "system" ? " ✓" : ""),
                icon: <Monitor size={17} />,
                onSelect: () => setMode("system"),
              },
              {
                label: "Claro" + (mode === "light" ? " ✓" : ""),
                icon: <Sun size={17} />,
                onSelect: () => setMode("light"),
              },
              {
                label: "Escuro" + (mode === "dark" ? " ✓" : ""),
                icon: <Moon size={17} />,
                onSelect: () => setMode("dark"),
              },
            ]}
          >
            <ThemeIcon size={20} />
          </MenuButton>
          <MenuButton
            label="Ajuda"
            align="start"
            items={[
              {
                label: "Atalhos de teclado",
                icon: <Keyboard size={17} />,
                onSelect: () => setDialog("keys"),
              },
              {
                label: "Guia de instalação",
                icon: <BookOpen size={17} />,
                onSelect: () => window.open("/install", "_blank", "noopener"),
              },
              {
                label: "Documentação da API",
                icon: <Code2 size={17} />,
                onSelect: () => window.open("/api-docs", "_blank", "noopener"),
              },
            ]}
          >
            <CircleHelp size={20} />
          </MenuButton>
          <MenuButton
            label={`Conta de ${app.me.name}`}
            className="rail-user"
            align="start"
            items={[
              {
                label: app.online ? "Online · alterar presença" : "Offline · alterar presença",
                icon: (
                  <span
                    className={"presence-dot " + (app.online ? "online" : "offline")}
                    style={{ width: 10, height: 10, margin: "0 3px" }}
                  />
                ),
                onSelect: () => setDialog("presence"),
              },
              ...(app.profiles.length > 1
                ? app.profiles.map((item, index) => ({
                    label: item.name + (item.id === app.profile ? " ✓" : ""),
                    icon: <Users size={17} />,
                    separator: index === 0,
                    onSelect: () => app.chooseProfile(item.id),
                  }))
                : []),
              {
                label: "Ajustes",
                icon: <SlidersHorizontal size={17} />,
                separator: true,
                onSelect: () => setDialog("prefs"),
              },
              {
                label: "Sair",
                icon: <LogOut size={17} />,
                danger: true,
                onSelect: () => void app.logout(),
              },
            ]}
          >
            <Avatar name={app.me.name} seed={app.me.id} size={36} online={app.online} />
          </MenuButton>
        </div>
      </nav>
      <div className="app-main">
        {app.offline && (
          <div className="strip offline" role="status">
            <WifiOff size={14} /> Sem conexão · tentando reconectar
          </div>
        )}
        {app.demo && (
          <div className="strip demo" role="note">
            Telas de referência · dados fictícios. Nenhuma mensagem real é
            enviada.
          </div>
        )}
        {ringing && route.area !== "conversations" && (
          <div className="strip call" role="status">
            <Phone size={14} /> Você está recebendo uma ligação pelo WhatsApp.
            <button
              type="button"
              onClick={() =>
                navigate({ area: "conversations", id: ringing.conversation_id })
              }
            >
              Abrir ligação
            </button>
          </div>
        )}
        <div className="app-area">{children}</div>
      </div>
      <nav className="tabbar" aria-label="Áreas do painel">
        {items.slice(0, 4).map((item) => (
          <NavLink
            key={item.area}
            item={item}
            active={route.area === item.area}
            className="tab-item"
          />
        ))}
        <NavLink
          item={{ area: "more", label: "Mais", icon: Ellipsis }}
          active={["more", "contacts", "admin"].includes(route.area)}
          className="tab-item"
        />
      </nav>
      {dialog === "prefs" && <PreferencesDialog onClose={() => setDialog("")} />}
      {dialog === "keys" && <ShortcutsDialog onClose={() => setDialog("")} />}
      {dialog === "presence" && <PresenceDialog onClose={() => setDialog("")} />}
    </div>
  );
}
