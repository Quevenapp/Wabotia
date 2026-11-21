import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import type { ManagementContext, ResolvedManagementItem } from "../../src/modules/panel-contract";
import type { PortedTargetState } from "./host-contract";
import { href, linkProps, navigate, parseRoute, useRoute } from "../lib/routes";
import { Button, Empty, Spinner } from "../ui";
import { managementEntryState, managementLanding, normalizedManagementHref } from "./registry";
import { managementMenu, type MenuColumn } from "./menu-groups";
import "./management.css";

export function managementRoute(to: string) {
  const url = new URL(to, location.origin);
  return parseRoute(url.pathname, url.search, url.hash);
}

export function ManagementState({ state, admin, retained = false, detail }: {
  state: PortedTargetState | "empty" | "redirecting";
  admin: boolean;
  retained?: boolean;
  /** Tela do ERP com parte desligada: qual módulo falta e de quem depende. */
  detail?: string | null;
}) {
  if (state === "loading" || state === "redirecting")
    return <div className="loading"><Spinner label="Abrindo a gestão…" /></div>;
  const messages = {
    empty: ["Nenhum módulo de gestão ligado", admin
      ? "Ligue os módulos que deseja usar em Gestão → Módulos."
      : "Peça ao administrador em Gestão → Módulos"],
    disabled: ["Módulo desligado", retained
      ? "A tela está indisponível. Seu rascunho foi preservado nesta aba; novas consultas e ações estão bloqueadas até o módulo ser ligado novamente."
      : detail ? detail + (admin ? "" : " Peça ao administrador.") : "Este módulo está desligado nesta área de atendimento."],
    denied: ["Você não tem acesso aos módulos de gestão desta área", "Peça ao administrador para revisar suas permissões."],
    unavailable: ["Recurso indisponível", "Este destino ainda não está disponível nesta instalação."],
    "not-found": ["Página não encontrada", "Escolha um destino no menu de gestão."],
    allowed: ["", ""],
  };
  const [title, description] = messages[state];
  return <div className="management-state" role="status">
    <Empty title={title} description={description} action={
      admin && (state === "empty" || state === "disabled")
        ? <Button onClick={() => navigate({ area: "admin", page: "modules" })}>Abrir Módulos</Button>
        : undefined
    } />
  </div>;
}

export function ManagementShell({ context, items, entry, chromeRef, children }: {
  context: ManagementContext;
  items: readonly ResolvedManagementItem[];
  entry: boolean;
  chromeRef: (element: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const route = useRoute();
  const current = href(route);
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 759px)").matches);
  const drawer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drawerId = useId();
  const accepted = useRef(current);
  const landing = entry ? managementLanding(items) : null;
  const state = managementEntryState(context, items);
  useEffect(() => {
    if (entry && state === "redirecting" && landing)
      navigate(managementRoute(landing), { replace: true });
  }, [entry, state, landing]);
  // Menu superior (telas largas): um grupo aberto por vez, como um menu de barra.
  const [menuGroup, setMenuGroup] = useState<string | null>(null);
  const [menuRight, setMenuRight] = useState(false);
  const topnav = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  const menuId = useId();
  useEffect(() => {
    // Seta para baixo no grupo: abre o painel e leva o foco à primeira tela dele.
    if (menuGroup === null || !focusFirst.current) return;
    focusFirst.current = false;
    panel.current?.querySelector<HTMLElement>("a[href]")?.focus();
  }, [menuGroup]);
  useEffect(() => {
    // navigate(true) pode ser somente delegação; fechar apenas após publicação.
    if (current !== accepted.current) { accepted.current = current; setOpen(false); setMenuGroup(null); }
  }, [current]);
  useEffect(() => {
    if (menuGroup === null) return;
    const outside = (event: MouseEvent) => { if (!topnav.current?.contains(event.target as Node)) setMenuGroup(null); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const button = topnav.current?.querySelector<HTMLElement>('[aria-expanded="true"]');
      setMenuGroup(null); button?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", keyboard); };
  }, [menuGroup]);
  const showGroup = (group: string, element: HTMLElement, toggle: boolean) => {
    // Grupo na metade direita da tela abre o painel alinhado à direita, para não sair da janela.
    setMenuRight(element.getBoundingClientRect().left > window.innerWidth / 2);
    setMenuGroup(previous => toggle && previous === group ? null : group);
  };
  useEffect(() => {
    const query = window.matchMedia("(max-width: 759px)");
    const change = () => { setMobile(query.matches); if (!query.matches) setOpen(false); };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!open || !mobile || !drawer.current) return;
    const element = drawer.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(element.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), [tabindex="0"]',
    )).filter((node) => node.getClientRects().length > 0);
    const otherDialog = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
      .some((node) => node !== element && node.getClientRects().length > 0);
    focusables()[0]?.focus();
    if (content.current) content.current.inert = true;
    const focus = (event: FocusEvent) => {
      if (!otherDialog() && !element.contains(event.target as Node)) (focusables()[0] || element).focus();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (otherDialog()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if (event.key !== "Tab") return;
      const nodes = focusables(), first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); element.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", keyboard);
      if (content.current) content.current.inert = false;
      if (previous?.isConnected) previous.focus(); else trigger.current?.focus();
    };
  }, [open, mobile]);

  const groups = new Map<string, ResolvedManagementItem[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) || []), item]);
  const groupTitle = (item: ResolvedManagementItem) => item.module === "os"
    ? context.vocabulary?.collection_label || item.groupLabel : item.groupLabel;
  const destinationKey = (to: string) => normalizedManagementHref(href(managementRoute(to)));
  const selectedItem = (item: ResolvedManagementItem) => {
    if (item.module === "os" && item.target.kind === "native") {
      if (item.target.page === "work" && ["work", "service-orders", "my-deadlines"].includes(route.page || "")) return true;
      if (item.target.page === "work-types" && ["work-types", "service-orders-settings"].includes(route.page || "")) return true;
    }
    return normalizedManagementHref(current) === destinationKey(item.href);
  };
  const link = (to: string) => ({
    ...linkProps(managementRoute(to)),
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (normalizedManagementHref(current) === destinationKey(to) &&
        !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0)
        setOpen(false);
      setMenuGroup(null);
      linkProps(managementRoute(to)).onClick(event);
    },
  });
  // Grupos do topo e colunas vêm do mapa único (menu-groups.ts); a página inicial continua pelos grupos dos módulos.
  const menu = managementMenu(items, groupTitle);
  // Título de coluna que repete o nome de um item dela (Agenda › Agenda) some na gaveta, como antes.
  const repeatsItem = (column: MenuColumn<ResolvedManagementItem>) => column.items.some(item => item.resolvedLabel === column.title);
  // Setas esquerda e direita andam entre os grupos do topo; com um painel aberto, abrem o grupo vizinho.
  const topnavKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const roots = Array.from(topnav.current?.querySelectorAll<HTMLElement>("[data-topnav-root]") ?? []);
    const target = event.target as HTMLElement;
    const index = roots.indexOf(target);
    if (index >= 0 && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      const next = roots[(index + (event.key === "ArrowRight" ? 1 : roots.length - 1)) % roots.length];
      next.focus();
      const group = next.dataset.topnavGroup;
      if (menuGroup !== null) { if (group) showGroup(group, next, false); else setMenuGroup(null); }
      return;
    }
    if (index >= 0 && event.key === "ArrowDown" && target.dataset.topnavGroup) {
      event.preventDefault();
      if (menuGroup === target.dataset.topnavGroup) { panel.current?.querySelector<HTMLElement>("a[href]")?.focus(); return; }
      focusFirst.current = true;
      showGroup(target.dataset.topnavGroup, target, false);
      return;
    }
    // Dentro do painel, setas para cima e para baixo andam entre as telas (Tab também percorre).
    const openPanel = target.closest(".management-topnav-panel");
    if (openPanel && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const links = Array.from(openPanel.querySelectorAll<HTMLElement>("a[href]"));
      const at = links.indexOf(target);
      links[(at + (event.key === "ArrowDown" ? 1 : links.length - 1)) % links.length]?.focus();
    }
  };
  return <div className="management-shell">
    <header className="management-header">
      <button ref={trigger} type="button" className="icon-button management-menu-toggle"
        aria-label="Abrir menu de gestão" aria-controls={drawerId} aria-expanded={open}
        onClick={() => setOpen(true)}><Menu size={22} /></button>
      <strong>ERP</strong>
      <div className="management-tools" ref={chromeRef} />
    </header>
    {mobile && open && <div className="management-backdrop" onClick={() => setOpen(false)} />}
    {!mobile && <nav ref={topnav} className="management-topnav" aria-label="Menu do ERP" onKeyDown={topnavKeys}>
      <a {...link("/app/erp")} className="management-topnav-link" data-topnav-root=""
        aria-current={entry ? "page" : undefined}>Início</a>
      {menu.map((group) => {
        const selected = group.items.some(selectedItem);
        if (group.items.length === 1) return <a key={group.key} {...link(group.items[0].href)} className="management-topnav-link"
          data-topnav-root="" aria-current={selected ? "page" : undefined}>{group.items[0].resolvedLabel}</a>;
        const expanded = menuGroup === group.key, panelId = `${menuId}-${group.key}`;
        return <div key={group.key} className="management-topnav-group" onBlur={(event) => {
          // Tab saiu do grupo (botão e painel): o painel fecha sozinho.
          if (expanded && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setMenuGroup(null);
        }}>
          <button type="button" className={"management-topnav-link" + (selected ? " management-topnav-selected" : "")}
            data-topnav-root="" data-topnav-group={group.key}
            aria-haspopup="true" aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}
            onClick={(event) => showGroup(group.key, event.currentTarget, true)}
            onMouseEnter={(event) => { if (menuGroup !== null && menuGroup !== group.key) showGroup(group.key, event.currentTarget, false); }}>
            {group.label}<ChevronDown size={14} aria-hidden="true" />
          </button>
          {expanded && <div id={panelId} ref={panel} className={"management-topnav-panel" + (menuRight ? " management-topnav-panel-right" : "")}>
            {group.columns.map((column) => {
              const titleId = `${panelId}-${column.key}`;
              return <div key={column.key} role="group" aria-labelledby={titleId} className={"management-topnav-column" +
                (column.items.some(selectedItem) ? " management-topnav-column-selected" : "")}>
                <strong id={titleId}>{column.title}</strong>
                {column.items.map((item) => <a key={item.id} {...link(item.href)} aria-current={
                  selectedItem(item) ? "page" : undefined
                }>{item.resolvedLabel}</a>)}
              </div>;
            })}
          </div>}
        </div>;
      })}
    </nav>}
    <aside id={drawerId} ref={drawer} className={"management-menu" + (open ? " management-menu-open" : "")}
      role={mobile && open ? "dialog" : undefined} aria-modal={mobile && open ? true : undefined}
      aria-label="Menu de gestão" tabIndex={-1} inert={mobile && !open}>
      <button type="button" className="icon-button management-menu-close" aria-label="Fechar menu de gestão"
        onClick={() => setOpen(false)}><X size={22} /></button>
      <nav aria-label="Módulos de gestão">
        <a {...linkProps({ area: mobile ? "more" : "conversations" })}>Áreas do painel</a>
        <a {...link("/app/erp")} aria-current={entry ? "page" : undefined}>Início da gestão</a>
        {menu.map((group) => <section key={group.key}>
          <h2>{group.label}</h2>
          {group.columns.map((column) => <React.Fragment key={column.key}>
            {!repeatsItem(column) && group.columns.length > 1 && <h3>{column.title}</h3>}
            {column.items.map((item) => <a key={item.id} {...link(item.href)} aria-current={
              selectedItem(item) ? "page" : undefined
            }>{item.resolvedLabel}</a>)}
          </React.Fragment>)}
        </section>)}
      </nav>
    </aside>
    <div ref={content} className="management-content">
      {entry ? state === "home" ? <div className="management-home">
        <h1>Gestão da área</h1><p>Escolha um módulo para continuar.</p>
        <div className="management-cards">
          {[...groups].map(([group, destinations]) => <section key={group}>
            <h2>{groupTitle(destinations[0])}</h2>
            {destinations.slice(0, 5).map((item) => <a key={item.id} {...link(item.href)}>{item.resolvedLabel}</a>)}
            {destinations.length > 5 && <a {...link(destinations[0].href)}>Ver todos</a>}
          </section>)}
        </div>
      </div> : <ManagementState state={state} admin={context.role === "admin"} /> : children}
    </div>
  </div>;
}
