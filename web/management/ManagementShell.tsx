import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import type { ManagementContext, ResolvedManagementItem } from "../../src/modules/panel-contract";
import type { PortedTargetState } from "./host-contract";
import { href, linkProps, navigate, parseRoute, useRoute } from "../lib/routes";
import { Button, Empty, Spinner } from "../ui";
import { managementEntryState, managementLanding, normalizedManagementHref } from "./registry";
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
  // Até 8 itens por coluna, no máximo 3 colunas; o painel rola se passar disso.
  const panelGrid = (count: number): React.CSSProperties => {
    const columns = Math.min(3, Math.ceil(count / 8));
    return { gridTemplateColumns: `repeat(${columns}, minmax(190px, max-content))`, gridTemplateRows: `repeat(${Math.ceil(count / columns)}, auto)` };
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
    {!mobile && <nav ref={topnav} className="management-topnav" aria-label="Menu do ERP">
      <a {...link("/app/erp")} className="management-topnav-link" aria-current={entry ? "page" : undefined}>Início</a>
      {[...groups].map(([group, entries]) => {
        const title = groupTitle(entries[0]), selected = entries.some(selectedItem);
        if (entries.length === 1) return <a key={group} {...link(entries[0].href)} className="management-topnav-link"
          aria-current={selected ? "page" : undefined}>{entries[0].resolvedLabel}</a>;
        const expanded = menuGroup === group;
        return <div key={group} className="management-topnav-group">
          <button type="button" className={"management-topnav-link" + (selected ? " management-topnav-selected" : "")}
            aria-haspopup="true" aria-expanded={expanded}
            onClick={(event) => showGroup(group, event.currentTarget, true)}
            onMouseEnter={(event) => { if (menuGroup !== null && menuGroup !== group) showGroup(group, event.currentTarget, false); }}>
            {title}<ChevronDown size={14} aria-hidden="true" />
          </button>
          {expanded && <div className={"management-topnav-panel" + (menuRight ? " management-topnav-panel-right" : "")}>
            <strong>{title}</strong>
            <div className="management-topnav-items" style={panelGrid(entries.length)}>
              {entries.map((item) => <a key={item.id} {...link(item.href)} aria-current={
                selectedItem(item) ? "page" : undefined
              }>{item.resolvedLabel}</a>)}
            </div>
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
        {[...groups].map(([group, entries]) => <section key={group}>
          {!(entries[0].module === "os" && entries.some(item => item.resolvedLabel === groupTitle(entries[0]))) &&
            <h2>{groupTitle(entries[0])}</h2>}
          {entries.map((item) => <a key={item.id} {...link(item.href)} aria-current={
            selectedItem(item) ? "page" : undefined
          }>{item.resolvedLabel}</a>)}
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
