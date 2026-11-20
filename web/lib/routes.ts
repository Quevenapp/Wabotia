// Endereços do painel (web/DESIGN.md §2): cada conversa, protocolo e página
// tem um caminho próprio, abre em nova aba e volta com o navegador.
import { useSyncExternalStore } from "react";
import {
  areaOfPage,
  sections,
  type AreaId,
  type PageId,
} from "../workspace-navigation";

import {
  canonicalManagementUrl,
  isNativeManagementPage,
  nativePageSlugs,
} from "../management/routes";
import type { ManagementRouterBridge } from "../../src/modules/panel-contract";
import type { BindManagementRouter } from "../management/host-contract";

export type Area = AreaId | "more";
export type Route = {
  area: Area;
  /** Conversa, protocolo ou conversa interna aberta. */
  id?: string;
  /** Subdivisão da área (segmento de Equipe). */
  sub?: string;
  /** Página administrativa ou nativa da casa ERP. */
  page?: PageId;
  typeId?: string;
  tab?: string;
  filters?: Record<string, string>;
  erpPath?: string;
  search?: string;
  hash?: string;
  nativePath?: string;
};

const areaSlugs: Record<Area, string> = {
  conversations: "conversas",
  tickets: "protocolos",
  team: "equipe",
  calls: "ligacoes",
  queue: "fila",
  contacts: "contatos",
  // A casa distingue entrada, páginas nativas e caminhos portados.
  erp: "erp",
  admin: "gestao",
  more: "mais",
};
const pageSlugs: Partial<Record<PageId, string>> = {
  juridico: "prazos-juridicos",
  condominio: "condominio",
  saude: "prontuarios",
  ensino: "ensino",
  work: "trabalhos",
  "my-deadlines": "meus-prazos",
  "work-types": "tipos-de-trabalho",
  "area-templates": "modelos-de-area",
  overview: "inicio",
  setup: "configuracao",
  groups: "grupos",
  users: "pessoas",
  bots: "bots",
  menus: "menus",
  templates: "modelos",
  knowledge: "conhecimento",
  settings: "regras",
  "queue-settings": "filas",
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
  modules: "modulos",
  forms: "formularios",
  agenda: "agenda",
  "agenda-settings": "servicos-e-horarios",
  "service-orders": "ordens-de-servico",
  "service-orders-settings": "ordem-de-servico",
  payments: "cobranca",
  mensalidades: "mensalidades",
  "mensalidade-settings": "mensalidade",
  suporte: "suporte-pago",
  "suporte-settings": "regras-do-suporte",
  establishment: "estabelecimento",
  reserva: "reservas",
  "reserva-settings": "unidades-e-regras",
  pedidos: "pedidos",
  "pedidos-cardapio": "cardapio-e-loja",
  mesas: "mesas",
};
/** Segmentos de Equipe aceitos no endereço. */
export const teamSegments = [
  "conversas",
  "pessoas",
  "bots",
  "setores",
] as const;

const base = "/app";
const decode = (value?: string) => {
  try {
    return value ? decodeURIComponent(value) : undefined;
  } catch {
    return value;
  }
};

const filterKeys = [
  "q",
  "stage",
  "status",
  "assignee",
  "tab",
  "editor",
  "open",
  "type_id",
  "period",
  "state",
  "due_from",
  "due_to",
];
const isWorkPage = (page?: PageId) =>
  page === "work" || page === "work-types" || page === "my-deadlines" || page === "service-orders-settings";
const localUrl = (url: URL) => url.pathname + url.search + url.hash;

/** Objetos antigos continuam válidos, inclusive os produzidos pelas páginas de trabalhos. */
function normalizeRoute(route: Route): Route {
  if (
    (route.area === "admin" || route.area === "erp") &&
    route.page &&
    isNativeManagementPage(route.page)
  )
    return {
      ...route,
      area: "erp",
      page: route.page === "service-orders" ? "work" : route.page,
    };
  return route;
}

export function parseRoute(pathname: string, search = "", hash = ""): Route {
  const canonical = canonicalManagementUrl(
    new URL(pathname + search + hash, "https://panel.invalid"),
  );
  if (canonical) pathname = canonical.pathname;
  const parts = pathname
    .replace(/^\/app\/?/, "")
    .split("/")
    .filter(Boolean);
  const [first, second, third] = parts;
  const area = (Object.keys(areaSlugs) as Area[]).find(
    (key) => areaSlugs[key] === first,
  );
  const extras = { ...(search ? { search } : {}), ...(hash ? { hash } : {}) };
  if (!area) {
    if (new URLSearchParams(search).has("pair"))
      return { area: "admin", page: "applications", ...extras };
    return { area: "conversations", ...extras };
  }
  if (area === "erp") {
    if (!second) return { area, ...extras };
    if (second !== "modulos")
      return { area, erpPath: pathname.slice("/app/erp".length), ...extras };
    const page = (
      Object.keys(nativePageSlugs) as (keyof typeof nativePageSlugs)[]
    ).find((key) => nativePageSlugs[key] === third);
    const maxParts = page === "work" ? 5 : isWorkPage(page) ? 4 : 3;
    if (!page || parts.length > maxParts)
      return { area, nativePath: pathname.slice("/app/erp".length), ...extras };
    if (isWorkPage(page)) {
      const query = new URLSearchParams(search);
      const filters: Record<string, string> = {};
      for (const key of filterKeys)
        if (query.has(key)) filters[key] = query.get(key)!;
      return {
        area,
        page,
        typeId: decode(parts[3]),
        id: page === "work" ? decode(parts[4]) : undefined,
        tab: query.get("aba") || undefined,
        filters,
        ...extras,
      };
    }
    return { area, page, ...extras };
  }
  if (area === "admin") {
    const page = (Object.keys(pageSlugs) as PageId[]).find(
      (key) => pageSlugs[key] === second,
    );
    return { area, page: page || "overview", ...extras };
  }
  if (area === "team") {
    const sub = (teamSegments as readonly string[]).includes(second || "")
      ? second
      : undefined;
    return { area, sub, id: decode(sub ? third : second), ...extras };
  }
  if (area === "conversations" || area === "tickets")
    return { area, id: decode(second), ...extras };
  return { area, ...extras };
}

/** Altera apenas parâmetros efetivamente modificados, mantendo repetições e escapes dos demais. */
function routeSearch(route: Route, session = false) {
  const raw = (route.search || "").replace(/^\?/, "");
  let fields = raw ? raw.split("&") : [];
  const update = (key: string, value: string | undefined) => {
    const query = new URLSearchParams(fields.join("&"));
    if ((query.get(key) || undefined) === value) return;
    const at = fields.findIndex((part) => new URLSearchParams(part).has(key));
    fields = fields.filter((part) => !new URLSearchParams(part).has(key));
    if (value !== undefined)
      fields.splice(
        at < 0 ? fields.length : at,
        0,
        new URLSearchParams({ [key]: value }).toString(),
      );
  };
  if (session && typeof location !== "undefined") {
    const current = new URLSearchParams(location.search);
    for (const key of ["demo", "pair"])
      if (current.has(key) && !new URLSearchParams(fields.join("&")).has(key))
        update(key, current.get(key) || "1");
  }
  if (Object.hasOwn(route, "tab")) update("aba", route.tab || undefined);
  if (route.filters) {
    for (const key of new Set([...filterKeys, ...Object.keys(route.filters)]))
      update(key, route.filters[key] || undefined);
  }
  return fields.length ? "?" + fields.join("&") : "";
}

/** Caminho canônico; somente demo/pair são herdados da sessão, nunca os filtros atuais. */
export function href(input: Route) {
  const route = normalizeRoute(input);
  let path = base + "/" + areaSlugs[route.area];
  if (route.area === "erp") {
    if (route.nativePath) path += route.nativePath;
    else if (route.page && isNativeManagementPage(route.page))
      path +=
        "/modulos/" +
        nativePageSlugs[route.page as keyof typeof nativePageSlugs];
    else if (route.erpPath && route.erpPath !== "/") path += route.erpPath;
  } else if (route.area === "admin")
    path += "/" + (pageSlugs[route.page || "overview"] || "inicio");
  else {
    if (route.sub) path += "/" + route.sub;
    if (route.id) path += "/" + encodeURIComponent(route.id);
  }
  if (route.area === "erp" && isWorkPage(route.page) && route.typeId) {
    path += "/" + encodeURIComponent(route.typeId);
    if (route.page === "work" && route.id)
      path += "/" + encodeURIComponent(route.id);
  }
  return path + routeSearch(route, true) + (route.hash || "");
}

export function pageRoute(page: string): Route {
  const known = sections.some(([id]) => id === page) ? (page as PageId) : null;
  if (!known) return { area: "conversations" };
  const area = areaOfPage(known);
  return normalizeRoute(
    area === "admin" || area === "erp" ? { area, page: known } : { area },
  );
}

export function sameRoute(left: Route, right: Route) {
  const a = normalizeRoute(left),
    b = normalizeRoute(right);
  return (
    a.area === b.area &&
    ["id", "sub", "typeId", "erpPath", "nativePath", "hash"].every(
      (key) => (a[key as keyof Route] || "") === (b[key as keyof Route] || ""),
    ) &&
    (a.page || (a.area === "admin" ? "overview" : "")) ===
      (b.page || (b.area === "admin" ? "overview" : "")) &&
    routeSearch(a) === routeSearch(b)
  );
}

// --- navegação: somente este módulo escreve no histórico público ------------
type Guard = () => boolean;
const listeners = new Set<() => void>();
const blockedListeners = new Set<(target: Route) => void>();
let guard: Guard | null = null;
const indexKey = "wabotiaRouteIndex";
type Entry = { url: string; index: number; route: Route };
let committed: Entry | null = null;
let wired = false;
const emit = () => listeners.forEach((listener) => listener());
const browserUrl = () => location.pathname + location.search + location.hash;
const entryIndex = () =>
  typeof history.state?.[indexKey] === "number"
    ? (history.state[indexKey] as number)
    : null;
const indexedState = (index: number) => ({
  ...history.state,
  [indexKey]: index,
});
const routeAt = (url: string) => {
  const parsed = new URL(url, location.href);
  return parseRoute(parsed.pathname, parsed.search, parsed.hash);
};
function canonicalBrowserUrl() {
  const canonical = canonicalManagementUrl(new URL(location.href));
  return canonical ? localUrl(canonical) : browserUrl();
}
function read() {
  if (!wired) {
    wired = true;
    window.addEventListener("popstate", pop);
  }
  if (!committed) {
    const url = canonicalBrowserUrl(),
      index = entryIndex() ?? 0;
    // Antes da primeira renderização: um favorito antigo não acrescenta etapa em Voltar.
    history.replaceState(indexedState(index), "", url);
    committed = { url, index, route: routeAt(url) };
  }
  return committed.route;
}
function commit(url: string, index: number) {
  committed = { url, index, route: routeAt(url) };
  emit();
}
function write(url: string, replace: boolean) {
  const index = committed!.index + (replace ? 0 : 1);
  if (replace) history.replaceState(indexedState(index), "", url);
  else history.pushState({ [indexKey]: index }, "", url);
  commit(url, index);
}

type Connection = { bridge: ManagementRouterBridge; last: string };
let connection: Connection | null = null;
let delegation: { owner: Connection } | null = null;
type Travel = {
  entry: Entry;
  phase: "restoring" | "asking" | "replaying";
  owner?: Connection;
};
let travel: Travel | null = null;
let blocked: {
  target: Route;
  url: string;
  replace: boolean;
  travel: Travel | null;
} | null = null;
const isPorted = (route: Route) =>
  route.area === "erp" &&
  !!route.erpPath &&
  route.erpPath.startsWith("/") &&
  route.erpPath !== "/" &&
  !/^\/modulos(?:\/|$)/.test(route.erpPath) &&
  !route.page &&
  !route.nativePath;
const canDelegate = (target: Route) =>
  connection && isPorted(committed!.route) && isPorted(target);
const leaving = (current: Route, target: Route) =>
  current.area !== target.area ||
  ((current.area === "admin" || current.area === "erp") &&
    !sameRoute(current, target));
function ask(
  target: Route,
  url: string,
  replace: boolean,
  displacement: Travel | null,
) {
  blocked = { target, url, replace, travel: displacement };
  blockedListeners.forEach((listener) => listener(target));
}
function replay(displacement: Travel) {
  if (travel !== displacement) return;
  displacement.phase = "replaying";
  history.go(displacement.entry.index - committed!.index);
}
function delegate(url: string, replace: boolean, displacement: Travel | null) {
  const owner = connection!;
  const request = { owner };
  delegation = request;
  if (displacement) displacement.owner = owner;
  // Uma promessa resolvida sem publish é cancelamento. Falhas também conservam a tela.
  void Promise.resolve()
    .then(() => {
      if (connection !== owner) return;
      return owner.bridge.navigate(url, { replace });
    })
    .catch((error: unknown) => {
      console.error("Não foi possível concluir a navegação do ERP.", error);
    })
    .finally(() => {
      if (delegation === request) delegation = null;
      if (
        connection === owner &&
        displacement &&
        travel === displacement &&
        displacement.phase === "asking"
      )
        travel = null;
    });
}
function decideTravel(displacement: Travel) {
  displacement.phase = "asking";
  // Uma confirmação portada já aberta conserva a intenção e a posição atuais.
  if (delegation) { travel = null; return; }
  const { route, url } = displacement.entry;
  if (canDelegate(route)) delegate(url, true, displacement);
  else if (leaving(committed!.route, route) && guard?.())
    ask(route, url, false, displacement);
  else replay(displacement);
}
function pop() {
  if (!committed) {
    read();
    return;
  }
  const index = entryIndex();
  if (index === null) {
    // Entradas anteriores à instalação do roteador pertencem ao navegador.
    // Entradas GET criadas por este roteador sempre possuem índice.
    return;
  }
  if (travel?.phase === "restoring") {
    if (index === committed.index) decideTravel(travel);
    else history.go(committed.index - index);
    return;
  }
  if (travel?.phase === "replaying" && index === travel.entry.index) {
    const accepted = travel.entry;
    travel = null;
    blocked = null;
    history.replaceState(indexedState(index), "", accepted.url);
    commit(accepted.url, index);
    return;
  }
  if (index === committed.index) return;
  const url = canonicalBrowserUrl();
  blocked = null;
  travel = { entry: { index, url, route: routeAt(url) }, phase: "restoring" };
  // Não publicar o primeiro popstate: conserva a árvore atual durante a confirmação.
  history.go(committed.index - index);
}

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

export function cancelBlockedNavigation() {
  if (blocked?.travel === travel && travel?.phase === "asking") travel = null;
  blocked = null;
}

export const bindManagementRouter: BindManagementRouter = (bridge) => {
  read();
  const owner: Connection = { bridge, last: committed!.url };
  if (travel?.phase === "asking" && travel.owner === connection) travel = null;
  connection = owner;
  delegation = null;
  return {
    publish(to: string, action: "push" | "replace") {
      if (connection !== owner || !isPorted(committed!.route)) return;
      const parsed = new URL(to, location.href);
      if (!to.startsWith("/app/erp/") || parsed.origin !== location.origin)
        return;
      const route = routeAt(localUrl(parsed));
      if (!isPorted(route)) return;
      const url = href(route);
      if (url === committed!.url) {
        owner.last = url;
        return;
      }
      // Após fechar uma confirmação global, uma navegação interna nova também
      // encerra o deslocamento cancelado (a assinatura onBlocked não tem onCancel).
      if (
        travel?.phase === "asking" &&
        blocked?.travel === travel &&
        travel.entry.url !== url
      ) {
        travel = null;
        blocked = null;
      }
      if (travel) {
        if (travel.phase === "asking" && travel.entry.url === url) {
          owner.last = url;
          replay(travel);
        }
        return;
      }
      if (url === owner.last) return;
      owner.last = url;
      blocked = null;
      write(url, action === "replace");
    },
    dispose() {
      if (connection === owner) connection = null;
      if (delegation?.owner === owner) delegation = null;
      if (travel?.phase === "asking" && travel.owner === owner) travel = null;
    },
  };
};

/** true também significa pedido encaminhado à ponte; a confirmação pode ser assíncrona. */
export function navigate(
  input: Route,
  options: { replace?: boolean; force?: boolean } = {},
) {
  const current = read(),
    target = normalizeRoute(input),
    url = href(target);
  if (sameRoute(current, target) || url === committed!.url) return true;
  if (delegation) return false;
  if (travel && travel.phase !== "asking") return false;
  if (options.force && blocked && blocked.url === url) {
    const accepted = blocked;
    blocked = null;
    if (accepted.travel && accepted.travel === travel) replay(accepted.travel);
    else {
      travel = null;
      write(url, options.replace ?? accepted.replace);
    }
    return true;
  }
  if (!options.force && blocked?.url === url) return false;
  // Uma nova intenção encerra qualquer confirmação cancelada (onClose não precisa navegar).
  travel = null;
  blocked = null;
  if (canDelegate(target)) {
    delegate(url, !!options.replace, null);
    return true;
  }
  if (!options.force && leaving(current, target) && guard?.()) {
    ask(target, url, !!options.replace, null);
    return false;
  }
  write(url, !!options.replace);
  return true;
}
function subscribe(listener: () => void) {
  read();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const currentRoute = read;
export function useRoute() {
  return useSyncExternalStore(subscribe, read, read);
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
