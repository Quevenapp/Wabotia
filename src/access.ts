// Acesso por pessoa (docs/API.md, "Acesso por pessoa"; docs/MODULOS.md,
// "Acessos e papéis"). O administrador marca, para cada atendente, o que ele
// usa: áreas do núcleo, módulos e papéis dos módulos (entregador, garçom,
// técnico, caixa). Fica em users.access, uma lista JSON:
//   ["*"]                    atendente completo (o mesmo que null)
//   ["caixa:cashier"]        só caixa (o papel já dá o módulo)
//   ["*", "os:technician"]   tudo, e também técnico
// O servidor confere em cada rota (primeiro segmento depois da área) e em
// cada comando, com 403 access_denied, e esconde das leituras (eventos,
// push, contadores) o que a pessoa não acessa. O administrador acessa tudo;
// aplicações e aparelhos pareados seguem pelos escopos.
import { ApiError, type Actor } from "./types";
import { ERP_MODULE_IDS } from "./erp/parts";
import {
  moduleForOperation,
  moduleForRoute,
  modules,
  type ModuleStates,
} from "./modules/registry";

/** Tudo o que não é papel de módulo. */
export const ALL = "*";

/** Áreas do núcleo que o atendente pode ter ou não. */
export const coreAccess = [
  {
    id: "conversations",
    label: "Conversas e atendimento",
    description:
      "Caixa de entrada, responder, assumir e transferir conversas, grupos e respostas de formulário.",
  },
  {
    id: "tickets",
    label: "Protocolos",
    description: "Lista e detalhe dos protocolos, prazos e mudanças de estado.",
  },
  {
    id: "contacts",
    label: "Contatos",
    description: "Agenda de contatos, importação e vínculo com conversas.",
  },
  {
    id: "calls",
    label: "Ligações",
    description: "Chamadas de voz do WhatsApp e histórico de ligações.",
  },
  {
    id: "team",
    label: "Equipe",
    description: "Conversa interna com a equipe e os bots.",
  },
  {
    id: "reports",
    label: "Relatórios e avaliações",
    description: "Relatórios do atendimento e notas das avaliações.",
  },
] as const;

export type AccessItem = {
  id: string;
  group: "core" | "module";
  module_id: string | null;
  /** Papel de módulo (entregador, garçom…): não entra no "*". */
  role: boolean;
  label: string;
  description: string;
};

/** Catálogo completo; com `states`, só os módulos ligados. */
export function accessCatalog(states?: ModuleStates): AccessItem[] {
  const items: AccessItem[] = coreAccess.map((c) => ({
    ...c,
    group: "core",
    module_id: null,
    role: false,
  }));
  for (const m of modules) {
    if (states && !states[m.id]) continue;
    items.push({
      id: m.id,
      group: "module",
      module_id: m.id,
      role: false,
      label: m.name,
      description: m.description,
    });
    for (const g of m.grants || [])
      items.push({
        id: `${m.id}:${g.id}`,
        group: "module",
        module_id: m.id,
        role: true,
        label: g.label,
        description: g.description,
      });
  }
  return items;
}

/**
 * Atalhos do painel: só preenchem as caixas. Os que citam módulo ausente
 * nesta versão não aparecem (veja `presetsFor`).
 */
export const accessPresets = [
  { id: "full", label: "Atendente completo", access: [ALL] },
  { id: "cashier", label: "Só caixa", access: ["caixa:cashier"] },
  { id: "waiter", label: "Só garçom", access: ["mesas:waiter"] },
  {
    id: "courier",
    label: "Só entregador da loja",
    access: ["entrega:courier"],
  },
  { id: "technician", label: "Técnico", access: ["os:technician"] },
  // ERP: só o papel (que já dá o módulo); some com o ERP desligado.
  { id: "erp-admin", label: "ERP · Administração", access: ["erp:admin"] },
  { id: "erp-consulta", label: "ERP · Consulta", access: ["erp:consulta"] },
  { id: "erp-vendas", label: "ERP · Vendas", access: ["erp:vendas"] },
  {
    id: "erp-financeiro",
    label: "ERP · Financeiro",
    access: ["erp:financeiro"],
  },
  { id: "erp-estoque", label: "ERP · Estoque", access: ["erp:estoque"] },
  { id: "erp-fiscal", label: "ERP · Fiscal", access: ["erp:fiscal"] },
] as const;

/** Módulos com papel exclusivo: no máximo um papel dele por pessoa. */
const ONE_ROLE = ["erp"];

export function presetsFor(catalog: AccessItem[]) {
  const ids = new Set(catalog.map((i) => i.id));
  return accessPresets.filter((p) =>
    p.access.every((id) => id === ALL || ids.has(id)),
  );
}

/** Lista guardada da pessoa; null (sem lista) vale como ["*"]. */
const listOf = (actor: Pick<Actor, "access">) => actor.access ?? [ALL];

/** Pessoa com lista restrita (atendente); admin e aplicações não. */
export const restricted = (actor: Actor) =>
  actor.kind === "user" && actor.role !== "admin";

/**
 * O que a pessoa acessa, por id do catálogo, já expandido: "*" vira todos os
 * itens que não são papel; papel dá também o módulo dele.
 */
export function effectiveAccess(actor: Actor, catalog: AccessItem[]) {
  if (!restricted(actor))
    return catalog.filter((i) => !i.role).map((i) => i.id);
  const list = listOf(actor);
  const out = new Set<string>();
  for (const item of catalog) {
    if (
      item.role
        ? list.includes(item.id)
        : list.includes(ALL) || list.includes(item.id)
    )
      out.add(item.id);
    if (item.role && list.includes(item.id) && item.module_id)
      out.add(item.module_id);
  }
  return catalog.map((i) => i.id).filter((id) => out.has(id));
}

/** Papéis de módulo concedidos (só os da lista, nunca pelo "*"). */
export const rolesOf = (actor: Actor) =>
  actor.kind === "user" ? listOf(actor).filter((id) => id.includes(":")) : [];

/** A pessoa acessa o item (núcleo ou módulo)? Papel dá o módulo. */
export function allows(actor: Actor, item: string) {
  if (!restricted(actor)) return true;
  const list = listOf(actor);
  // "*" como item: o que só o atendente completo alcança.
  if (item === ALL) return list.includes(ALL);
  if (list.includes(item)) return true;
  // Área do núcleo ou módulo pelo "*"; módulo também por um papel dele.
  if (!item.includes(":") && list.includes(ALL)) return true;
  return list.some((id) => id.startsWith(item + ":"));
}

export function requireAccess(actor: Actor, item: string) {
  if (!allows(actor, item))
    throw new ApiError(
      403,
      "access_denied",
      "Seu acesso não inclui esta parte do sistema. Peça ao administrador.",
    );
}

/**
 * Primeiro segmento da rota em /api/v1/profiles/:profile/<segmento> → item.
 * `null`: livre para qualquer pessoa da área (dados de apoio sem cliente,
 * como estabelecimento, pessoas e capacidades). Segmento fora desta lista e
 * de módulo: negado para quem tem lista restrita.
 */
const SEGMENTS: Record<string, string | null> = {
  conversations: "conversations",
  groups: "conversations",
  "group-operations": "conversations",
  consents: "conversations",
  deliveries: "conversations",
  "bot-runs": "conversations",
  "web-steps": "conversations",
  inbound: "conversations",
  tickets: "tickets",
  contacts: "contacts",
  calls: "calls",
  team: "team",
  "internal-chats": "team",
  // Pedidos de aprovação: quem vê e decide é a audiência de cada pedido,
  // declarada pelo módulo (src/approvals.ts).
  approvals: null,
  reports: "reports",
  surveys: "reports",
  // Apoio, sem dado de cliente.
  status: null,
  capabilities: null,
  establishment: null,
  people: null,
  grants: null,
  access: null,
  presence: null,
  events: null,
  modules: null,
  media: null,
  menus: null,
  lines: null,
  router: null,
  bots: null,
  knowledge: null,
};

/** Item exigido por uma rota (`undefined`: negado a quem é restrito). */
export function routeAccess(segment: string): string | null | undefined {
  const owner = moduleForRoute(segment);
  if (owner) return ERP_MODULE_IDS.some(id => id === owner.id) ? "erp" : owner.id;
  return segment in SEGMENTS ? SEGMENTS[segment] : undefined;
}

export function requireRouteAccess(actor: Actor, segment: string) {
  if (!restricted(actor)) return;
  const item = routeAccess(segment);
  if (item === null) return;
  // Fora do catálogo: só quem tem tudo ("*").
  requireAccess(actor, item ?? ALL);
}

/** Só estes endpoints delegam a autorização à ficha/ERP/job do recurso. */
export function customerResourceRoute(method: string, path: string): boolean {
  return (method === "GET" && /^(contacts\/[^/]+\/profile|contact-jobs\/[^/]+)$/.test(path)) ||
    (method === "POST" && /^(contacts\/[^/]+\/promote|contacts\/from-erp|contact-jobs\/[^/]+\/(resolve|cancel))$/.test(path));
}

/** Comandos do núcleo por prefixo → item. */
const OPERATIONS: [RegExp, string | null][] = [
  [/^(conversation|message|consent|web_step)\.|^inbound$/, "conversations"],
  [/^group\./, "conversations"],
  [/^run\.(create|cancel)$/, "conversations"],
  [/^ticket\./, "tickets"],
  [/^contact\.(promote|from-erp|resolve-job|job-cancel|section)$/, null],
  [/^contact\./, "contacts"],
  [/^call\./, "calls"],
  [/^internal\./, "team"],
  [/^(presence|upload\.|media\.)/, null],
];

/** Confere o comando antes de rodar (perform). */
export function requireOperationAccess(actor: Actor, op: string) {
  if (!restricted(actor)) return;
  const owner = moduleForOperation(op);
  if (owner) return requireAccess(actor, op.startsWith("com1.") ? "erp" : owner.id);
  const match = OPERATIONS.find(([pattern]) => pattern.test(op));
  if (match && match[1] === null) return;
  // Comando fora da lista: só quem tem tudo ("*").
  requireAccess(actor, match ? match[1]! : ALL);
}

/** Tipo de evento (events, webhooks, tempo real) → item, para filtrar. */
export function eventAccess(kind: string): string | null {
  const prefix = kind.split(".")[0];
  const owner = modules.find((m) => m.events.includes(kind));
  if (owner) return owner.id;
  return (
    (
      {
        conversation: "conversations",
        message: "conversations",
        web_step: "conversations",
        form: "conversations",
        consent: "conversations",
        group: "conversations",
        ticket: "tickets",
        contact: "contacts",
        call: "calls",
        internal: "team",
        survey: "reports",
      } as Record<string, string>
    )[prefix] ?? null
  );
}

/** A pessoa vê este evento? Eventos sem dono (module.changed…) ficam. */
export function seesEvent(actor: Actor, kind: string) {
  const item = eventAccess(kind);
  return !item || allows(actor, item);
}

/** Validação de users.access em user.create/user.update. */
export function validateAccess(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 200)
    throw new ApiError(
      400,
      "invalid_request",
      "Acesso: envie uma lista de itens.",
    );
  const known = new Set([ALL, ...accessCatalog().map((i) => i.id)]);
  const out = [...new Set(value)];
  for (const item of out)
    if (typeof item !== "string" || !known.has(item))
      throw new ApiError(
        400,
        "invalid_request",
        `Acesso desconhecido: ${String(item)}.`,
      );
  for (const module of ONE_ROLE)
    if (out.filter((item) => item.startsWith(module + ":")).length > 1)
      throw new ApiError(
        400,
        "invalid_request",
        "Escolha um só papel do ERP para a pessoa.",
      );
  return out as string[];
}
