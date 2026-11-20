import type { PageId } from "../workspace-navigation";

/** Lista fechada de endereços nativos; não carrega componentes nem o motor ERP. */
export const nativePageSlugs = {
  agenda: "agenda",
  "agenda-settings": "servicos-e-horarios",
  mensalidades: "mensalidades",
  "mensalidade-settings": "mensalidade",
  pedidos: "pedidos",
  "pedidos-cardapio": "cardapio-e-loja",
  mesas: "mesas",
  reserva: "reservas",
  "reserva-settings": "unidades-e-regras",
  suporte: "suporte-pago",
  "suporte-settings": "regras-do-suporte",
  condominio: "condominio",
  juridico: "prazos-juridicos",
  saude: "prontuarios",
  ensino: "ensino",
  work: "trabalhos",
  "service-objects": "objetos-de-servico",
  "service-orders": "trabalhos",
  "my-deadlines": "meus-prazos",
  "work-types": "tipos-de-trabalho",
  "service-orders-settings": "ordem-de-servico",
  forms: "formularios",
  payments: "cobranca",
} as const satisfies Partial<Record<PageId, string>>;

export function isNativeManagementPage(page: string): page is PageId {
  return Object.hasOwn(nativePageSlugs, page);
}

const aliases = new Map<string, string>(
  Object.values(nativePageSlugs).map((slug) => [slug, slug]),
);
aliases.set("ordens-de-servico", "trabalhos");

/** Troca somente o caminho: a consulta bruta e o fragmento nunca são reconstruídos. */
export function canonicalManagementUrl(url: URL): URL | null {
  const result = new URL(url.href);
  const legacy = /^\/app\/gestao\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (legacy) {
    const slug = aliases.get(legacy[1]);
    if (!slug) return null;
    result.pathname = "/app/erp/modulos/" + slug + (legacy[2] || "");
    return result;
  }
  if (!/^\/app\/erp(?:\/|$)/.test(url.pathname)) return null;
  if (url.pathname === "/app/erp/") result.pathname = "/app/erp";
  else
    result.pathname = result.pathname.replace(
      /^\/app\/erp\/modulos\/ordens-de-servico(?=\/|$)/,
      "/app/erp/modulos/trabalhos",
    );
  return result;
}
