// Endereços do painel (web/DESIGN.md §2): cada conversa, protocolo e página
// tem um caminho próprio, abre em nova aba e volta com o navegador.
import { useSyncExternalStore } from "react";
import {
  areaOfPage,
  sections,
  type AreaId,
  type PageId,
} from "../workspace-navigation";

export type Area = AreaId | "more";
export type Route = {
  area: Area;
  /** Conversa, protocolo ou conversa interna aberta. */
  id?: string;
  /** Subdivisão da área (segmento de Equipe). */
  sub?: string;
  /** Página de Gestão. */
  page?: PageId;
};

const areaSlugs: Record<Area, string> = {
  conversations: "conversas",
  tickets: "protocolos",
  team: "equipe",
  calls: "ligacoes",
  contacts: "contatos",
  admin: "gestao",
  more: "mais",
};
const pageSlugs: Partial<Record<PageId, string>> = {
  overview: "inicio",
  setup: "configuracao",
  groups: "grupos",
  users: "pessoas",
  bots: "bots",
  menus: "menus",
  templates: "modelos",
  knowledge: "conhecimento",
  settings: "regras",
  router: "zernio",
  lines: "linhas",
  connections: "canais",
  surveys: "avaliacoes",
  reports: "relatorios",
  consents: "consentimentos",
  applications: "sistemas",
  "bot-runs": "execucoes",
  deliveries: "entregas",
  "webhook-deliveries": "eventos",
  system: "sistema",
};
/** Segmentos de Equipe aceitos no endereço. */
export const teamSegments = ["conversas", "pessoas", "bots", "setores"] as const;

const base = "/app";
const decode = (value?: string) => {
  try {
    return value ? decodeURIComponent(value) : undefined;
  } catch {
    return value;
  }
};

export function parseRoute(pathname: string, search = ""): Route {
  const parts = pathname
    .replace(/^\/app\/?/, "")
    .split("/")
    .filter(Boolean);
  const [first, second, third] = parts;
  const area = (Object.keys(areaSlugs) as Area[]).find(
    (key) => areaSlugs[key] === first,
  );
  if (!area) {
    // Convite de pareamento (?pair=) abre Sistemas conectados, como antes.
    if (new URLSearchParams(search).has("pair"))
      return { area: "admin", page: "applications" };
    return { area: "conversations" };
  }
  if (area === "admin") {
    const page = (Object.keys(pageSlugs) as PageId[]).find(
      (key) => pageSlugs[key] === second,
    );
    return { area, page: page || "overview" };
  }
  if (area === "team") {
    const sub = (teamSegments as readonly string[]).includes(second || "")
      ? second
      : undefined;
    return { area, sub, id: decode(sub ? third : second) };
  }
  if (area === "conversations" || area === "tickets")
    return { area, id: decode(second) };
  return { area };
}

/** Caminho de uma rota; preserva ?demo e ?pair, que valem para a sessão toda. */
export function href(route: Route) {
  let path = base + "/" + areaSlugs[route.area];
  if (route.area === "admin")
    path += "/" + (pageSlugs[route.page || "overview"] || "inicio");
  else {
    if (route.sub) path += "/" + route.sub;
    if (route.id) path += "/" + encodeURIComponent(route.id);
  }
  const current = new URLSearchParams(location.search),
    keep = new URLSearchParams();
  for (const key of ["demo", "pair"])
    if (current.has(key)) keep.set(key, current.get(key) || "1");
  const query = keep.toString();
  return path + (query ? "?" + query : "");
}

/** Rota de uma página conhecida pelo identificador antigo (assistente, atalhos). */
export function pageRoute(page: string): Route {
  const known = sections.some(([id]) => id === page) ? (page as PageId) : null;
  if (!known) return { area: "conversations" };
  const area = areaOfPage(known);
  return area === "admin" ? { area, page: known } : { area };
}

export const sameRoute = (a: Route, b: Route) =>
  a.area === b.area &&
  (a.id || "") === (b.id || "") &&
  (a.sub || "") === (b.sub || "") &&
  (a.area !== "admin" || (a.page || "overview") === (b.page || "overview"));

// --- navegação -------------------------------------------------------------
type Guard = () => boolean;
const listeners = new Set<() => void>();
const blockedListeners = new Set<(target: Route) => void>();
let guard: Guard | null = null;
let snapshot = { key: "", route: { area: "conversations" } as Route };
const emit = () => listeners.forEach((listener) => listener());

function read() {
  const key = location.pathname + location.search;
  if (snapshot.key !== key)
    snapshot = { key, route: parseRoute(location.pathname, location.search) };
  return snapshot.route;
}

/**
 * Enquanto houver alterações não salvas, a navegação é segurada e quem escuta
 * onBlocked pergunta se a pessoa quer descartar (navigate com force).
 */
export function setNavigationGuard(next: Guard | null) {
  guard = next;
}
export const navigationGuarded = () => !!guard?.();
export function onBlocked(listener: (target: Route) => void) {
  blockedListeners.add(listener);
  return () => {
    blockedListeners.delete(listener);
  };
}

export function navigate(
  target: Route,
  options: { replace?: boolean; force?: boolean } = {},
) {
  const current = read();
  if (sameRoute(current, target)) return true;
  // Trocar de conversa ou de protocolo dentro da mesma área não perde edições.
  const leaving =
    current.area !== target.area ||
    (current.area === "admin" && current.page !== target.page);
  if (!options.force && leaving && guard?.()) {
    blockedListeners.forEach((listener) => listener(target));
    return false;
  }
  const url = href(target);
  if (options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  emit();
  return true;
}

let wired = false;
function subscribe(listener: () => void) {
  if (!wired) {
    wired = true;
    window.addEventListener("popstate", emit);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const currentRoute = read;
export function useRoute() {
  return useSyncExternalStore(subscribe, read);
}

/** onClick para <a href>: navegação interna sem recarregar; Ctrl/⌘+clique abre nova aba. */
export function linkProps(route: Route) {
  return {
    href: href(route),
    onClick: (event: {
      defaultPrevented: boolean;
      button?: number;
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      preventDefault: () => void;
    }) => {
      if (
        event.defaultPrevented ||
        (event.button ?? 0) !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      navigate(route);
    },
  };
}
