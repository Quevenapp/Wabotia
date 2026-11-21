// Régua de cobrança e contas recorrentes automáticas, em
// /api/v1/profiles/:profile/erp-regua (parte Financeiro).
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// (Financeiro › Régua de cobrança e Contas recorrentes), para a API e para o
// inventário de concessões dos bots (src/modules/erp/bot-access.ts, assunto
// Financeiro). Consultar a régua e as recorrências automáticas é leitura
// comum; ligar, desligar e mudar a régua é só do administrador, pela tela
// (fora do inventário dos bots); marcar a recorrência como automática também
// fica só na tela. As rotas do Worker ficam em ./routes.ts; o envio, no
// alarme da área (./sender.ts). Só sintaxe TypeScript apagável.
import type { ErpModuleId } from "../parts.ts";

export const ERP_REGUA_ROUTE = "erp-regua";
/** A parte dona (Financeiro, que depende de Cadastros). */
export const ERP_REGUA_PART: ErpModuleId = "erp-financeiro";

export interface ErpReguaOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** Só o administrador da área (pessoa, não bot). */
  admin?: boolean;
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_REGUA_ROUTE;
export const ERP_REGUA_OPERATIONS: readonly ErpReguaOperation[] = Object.freeze([
  {
    name: "erp.regua.ver", method: "GET", path: R, sensitive: false,
    summary: "Consultar a régua de cobrança",
    description: "Mostra se a régua de cobrança está ligada, os dias dos avisos (antes do vencimento, no dia e depois), o horário comercial e os canais; o que vai sair hoje, o que já saiu e o que não saiu (com o motivo), dos últimos 30 dias. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.regua.configurar", method: "POST", path: `${R}/configuracao`, sensitive: true, admin: true, bot: false,
    summary: "Ligar, desligar ou ajustar a régua de cobrança",
    description: "Liga ou desliga a régua (ligar pede a confirmação do aviso) e muda os dias dos avisos, os canais, a forma de pagamento da mensagem e o horário comercial. Só o administrador, pela tela.",
    query: [], body: ["ligada", "dias_antes", "no_vencimento", "dias_depois", "whatsapp", "email", "pagamento", "hora_inicio", "hora_fim", "so_dias_uteis", "confirmo"], required: [],
  },
  {
    name: "erp.regua.recorrentes", method: "GET", path: `${R}/recorrentes`, sensitive: false,
    summary: "Consultar as contas recorrentes automáticas",
    description: "Lista as recorrências que o sistema gera sozinho (e as que já enviam a cobrança ao gerar), com o que o alarme fez em cada período: conta gerada ou o motivo de não ter gerado. Só consulta.",
    query: ["ids"], body: [], required: [],
  },
  {
    name: "erp.regua.recorrente_automatica", method: "POST", path: `${R}/recorrentes/:id`, sensitive: true, bot: false,
    summary: "Marcar uma conta recorrente como automática",
    description: "Liga ou desliga a geração sozinha da conta recorrente no dia de emissão de cada período e, nas contas a receber, o envio da cobrança pela régua ao gerar. Só pela tela.",
    query: [], body: ["automatica", "enviar_cobranca"], required: ["id", "automatica"],
  },
]);

export function erpReguaOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_REGUA_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

/** Esquema de cada parâmetro, para o inventário dos bots. */
export const ERP_REGUA_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  ids: { type: "string", description: "Identificadores das recorrências, separados por vírgula (até 100)." },
});
export function erpReguaParams(operation: ErpReguaOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_REGUA_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...operation.required],
  };
}

export const ERP_REGUA_MODULE_CONTRACT = {
  routes: [ERP_REGUA_ROUTE], operations: ["erp.regua."],
  definition: { bot: { sensitive: ERP_REGUA_OPERATIONS.filter((op) => op.sensitive && op.bot !== false).map((op) => op.name),
    hints: Object.fromEntries(ERP_REGUA_OPERATIONS.map((op) => [op.name, op.summary])) } },
};

// ---------------------------------------------------------------------------
// Configuração (D1, migrations/0290_erp_regua_cobranca.sql)

export type ReguaPayment = "auto" | "pix" | "link" | "boleto" | "sem";
export const REGUA_PAYMENTS: readonly ReguaPayment[] = ["auto", "pix", "link", "boleto", "sem"];
export interface ReguaSettings {
  enabled: boolean; whatsapp: boolean; email: boolean; payment: ReguaPayment;
  /** Em branco (null): o da preferência de Contas a receber. */
  before: number | null; on_due: boolean | null; after: number | null;
  hour_from: number; hour_to: number; business_days: boolean;
  enabled_by: string | null; enabled_at: number | null; updated_by: string | null; updated: number | null;
}
export const REGUA_DEFAULTS: ReguaSettings = Object.freeze({
  enabled: false, whatsapp: true, email: false, payment: "auto", before: null, on_due: null, after: null, hour_from: 8, hour_to: 18, business_days: true,
  enabled_by: null, enabled_at: null, updated_by: null, updated: null,
}) as ReguaSettings;

/** O aviso que o administrador confirma ao ligar. */
export const REGUA_WARNING = "Com a régua ligada, o sistema manda mensagens de cobrança aos seus clientes sozinho, em seu nome, nos dias marcados, sem uma pessoa conferir cada envio. Só saem mensagens no horário comercial, a quem pode receber pelo WhatsApp (conversa aberta nas últimas 24 horas ou modelo aprovado com a autorização do cliente) e nunca de conta já paga ou cancelada.";

/** A configuração que vai ao motor em cada chamada (p_args.config). */
export const engineConfig = (s: ReguaSettings) => ({
  enabled: s.enabled, whatsapp: s.whatsapp, email: s.email, hour_from: s.hour_from, hour_to: s.hour_to, business_days: s.business_days,
  before: s.before, on_due: s.on_due, after: s.after,
});

export class ReguaArgsError extends Error {}
const bad = (message: string): never => { throw new ReguaArgsError(message); };
const hour = (value: unknown, name: string, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : bad(`${name}: informe a hora cheia, de ${min} a ${max}.`);
const flag = (value: unknown, name: string) => typeof value === "boolean" ? value : bad(`${name}: use verdadeiro ou falso.`);

/** A configuração nova a partir do pedido (só os campos enviados mudam). */
export function nextSettings(current: ReguaSettings, body: Record<string, unknown>): ReguaSettings {
  const next = { ...current };
  if (body.ligada !== undefined) next.enabled = flag(body.ligada, "ligada");
  if (body.whatsapp !== undefined) next.whatsapp = flag(body.whatsapp, "whatsapp");
  if (body.email !== undefined) next.email = flag(body.email, "email");
  if (body.so_dias_uteis !== undefined) next.business_days = flag(body.so_dias_uteis, "so_dias_uteis");
  if (body.pagamento !== undefined)
    next.payment = REGUA_PAYMENTS.includes(body.pagamento as ReguaPayment) ? body.pagamento as ReguaPayment : bad("pagamento: use auto, pix, link, boleto ou sem.");
  const days = (value: unknown, name: string) => value === null || value === "" ? null
    : typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 365 ? value : bad(`${name}: informe de 0 a 365 dias (ou deixe em branco para usar a preferência).`);
  if (body.dias_antes !== undefined) next.before = days(body.dias_antes, "dias_antes");
  if (body.dias_depois !== undefined) next.after = days(body.dias_depois, "dias_depois");
  if (body.no_vencimento !== undefined) next.on_due = body.no_vencimento === null ? null : flag(body.no_vencimento, "no_vencimento");
  if (body.hora_inicio !== undefined) next.hour_from = hour(body.hora_inicio, "hora_inicio", 0, 23);
  if (body.hora_fim !== undefined) next.hour_to = hour(body.hora_fim, "hora_fim", 1, 24);
  if (next.hour_to <= next.hour_from) bad("O horário comercial termina depois de começar (por exemplo, das 8 às 18).");
  if (next.enabled && !next.whatsapp && !next.email) bad("Escolha pelo menos um canal (WhatsApp ou e-mail) para ligar a régua.");
  return next;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function reguaUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) bad(`${name}: identificador inválido.`);
  return (value as string).toLowerCase();
}
export function reguaIds(value: string | null): string[] | undefined {
  if (value === null || value === "") return undefined;
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length > 100) bad("ids: até 100 recorrências por consulta.");
  return ids.map((id) => reguaUuid(id, "ids"));
}
