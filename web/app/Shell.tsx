// Casca do painel: trilho à esquerda, barra de abas no celular, faixas de
// estado e atalhos globais (web/DESIGN.md §2 e §10).
import React, { useEffect, useState } from "react";
import {
  BookOpen,
  Building2,
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
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Ticket,
  Users,
  WifiOff,
} from "lucide-react";
import { Avatar, BrandMark, MenuButton } from "../ui";
import {
  linkProps,
  navigate,
  useRoute,
  type Area,
  type Route,
} from "../lib/routes";
import { useTheme } from "../lib/theme";
import {
  accessAllows,
  canOpenPage,
  moduleAllows,
  railPages,
  type PageId,
} from "../workspace-navigation";
import { useApp } from "./AppContext";
import { AccountDialog } from "./Account";
import { erpModuleOn } from "../erp/modules";
import { PreferencesDialog, PresenceDialog, ShortcutsDialog } from "./chrome";

type Item = {
  area: Area;
  /** Página de Gestão aberta por um item de módulo (railPages). */
  page?: PageId;
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
    { area: "queue", label: "Fila", icon: Ticket },
    // Módulos com lugar no trilho (web/workspace-navigation.ts, railPages).
    ...railPages
      .filter(
        (item) =>
          moduleAllows(item.page, app.modules) &&
          canOpenPage(item.page, app.me.role, app.modules, app.me.access),
      )
      .map((item) => ({
        area: "admin" as Area,
        page: item.page,
        label: item.label,
        icon: item.icon,
      })),
    { area: "contacts", label: "Contatos", icon: Contact },
    { area: "erp", label: "ERP", icon: Building2 },
    { area: "admin", label: "Gestão", icon: Settings },
  ].filter(
    (item) =>
      // ERP: desligado de fábrica, até o servidor declarar o módulo (web/erp/modules.ts).
      (item.area === "erp"
        ? erpModuleOn(app.modules, "erp")
        : moduleAllows(item.area, app.modules)) &&
      // Acesso por pessoa: some o que ela não acessa (Gestão fica, com o
      // Início e as páginas de módulo que ela tem).
      (item.area === "admin" ||
        accessAllows(item.area, app.me.role, app.me.access)),
  ) as Item[];
}

const itemRoute = (item: Item): Route =>
  item.area === "admin"
    ? { area: "admin", page: item.page || "overview" }
    : { area: item.area };

/** Item de módulo ativo na sua página; Gestão, nas demais páginas de Gestão. */
const itemActive = (item: Item, route: Route) =>
  item.page
    ? route.area === "admin" && route.page === item.page
    : item.area === "admin"
      ? route.area === "admin" &&
        !railPages.some((rail) => rail.page === route.page)
      : route.area === item.area;

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
  const route = itemRoute(item);
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
  const [dialog, setDialog] = useState<
    "" | "prefs" | "keys" | "presence" | "account"
  >("");
  // Abaixo de 760 px a conversa, o protocolo ou a página aberta ocupa a tela
  // toda, sem a barra de abas (como no aplicativo).
  const detail =
    !!route.id ||
    (route.area === "admin" && !!route.page && route.page !== "overview");

  // Acesso por pessoa: área que ela não acessa (a de entrada é Conversas)
  // leva ao primeiro item que ela tem.
  const blocked =
    route.area !== "admin" &&
    !accessAllows(route.area, app.me.role, app.me.access);
  useEffect(() => {
    if (blocked && items[0]) navigate(itemRoute(items[0]), { replace: true });
  }, [blocked, items[0]?.area, items[0]?.page]);

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
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        /^[1-7]$/.test(event.key)
      ) {
        const item = items[Number(event.key) - 1];
        if (item) {
          event.preventDefault();
          navigate(itemRoute(item));
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
              key={item.page || item.area}
              item={item}
              active={itemActive(item, route)}
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
                label: app.online
                  ? "Online · alterar presença"
                  : "Offline · alterar presença",
                icon: (
                  <span
                    className={
                      "presence-dot " + (app.online ? "online" : "offline")
                    }
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
                label: "Minha conta",
                icon: <ShieldCheck size={17} />,
                onSelect: () => setDialog("account"),
              },
              {
                label: "Sair",
                icon: <LogOut size={17} />,
                danger: true,
                onSelect: () => void app.logout(),
              },
            ]}
          >
            <Avatar
              name={app.me.name}
              seed={app.me.id}
              size={36}
              online={app.online}
            />
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
        <div className="app-area">{blocked ? null : children}</div>
      </div>
      <nav className="tabbar" aria-label="Áreas do painel">
        {items.slice(0, 4).map((item) => (
          <NavLink
            key={item.page || item.area}
            item={item}
            active={itemActive(item, route)}
            className="tab-item"
          />
        ))}
        <NavLink
          item={{ area: "more", label: "Mais", icon: Ellipsis }}
          active={["more", "queue", "contacts", "erp", "admin"].includes(
            route.area,
          )}
          className="tab-item"
        />
      </nav>
      {dialog === "prefs" && (
        <PreferencesDialog onClose={() => setDialog("")} />
      )}
      {dialog === "keys" && <ShortcutsDialog onClose={() => setDialog("")} />}
      {dialog === "account" && <AccountDialog onClose={() => setDialog("")} />}
      {dialog === "presence" && (
        <PresenceDialog onClose={() => setDialog("")} />
      )}
    </div>
  );
}
