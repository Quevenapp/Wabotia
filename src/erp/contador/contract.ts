// Para o contador (parte Fiscal): pacote do período com os XML e PDFs das
// notas, relatórios fiscais de conferência e envio ao contador, em
// /api/v1/profiles/:profile/erp-contador.
//
// Operações com nome estável, as mesmas para a tela, para a API e para o
// inventário de concessões dos bots (src/modules/erp/bot-access.ts, assunto
// "nfe"). Montar o pacote e consultar são operações comuns; enviar ao
// contador é sensível (o bot propõe e a pessoa confirma). As telas usam
// também as rotas só da tela (bot: false).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

/** Segmento das rotas no Worker (módulo erp-fiscal: desligado, 409 module_disabled). */
export const ERP_CONTADOR_ROUTE = "erp-contador";
/** Prefixo das rotas internas no objeto da área (src/erp/hub.ts). */
export const ERP_CONTADOR_DO_PREFIX = "/erp-contador/";

/** Quem vê (relatórios, pacotes, envios) e quem monta, cadastra e envia. */
export const CONTADOR_READ_ROLES: readonly string[] = Object.freeze(["admin", "fiscal", "consulta"]);
export const CONTADOR_WRITE_ROLES: readonly string[] = Object.freeze(["admin", "fiscal"]);

/** Validade do link enviado ao contador: 7 dias. */
export const CONTADOR_LINK_DAYS = 7;
export const CONTADOR_LINK_MS = CONTADOR_LINK_DAYS * 24 * 60 * 60 * 1000;
/** Período máximo de um pacote ou relatório (o cofre lê até 366 dias). */
export const CONTADOR_MAX_DAYS = 366;

export type ContadorEnvironment = "producao" | "homologacao";
export type ContadorChannel = "whatsapp" | "email";

export interface ContadorOperation {
  name: string;
  method: "GET" | "POST" | "PUT";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  group: "nfe";
  /** Papel do ERP que pode: leitura (admin, fiscal, consulta) ou escrita (admin, fiscal). */
  access: "read" | "write";
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_CONTADOR_ROUTE;
export const ERP_CONTADOR_OPERATIONS: readonly ContadorOperation[] = Object.freeze([
  {
    name: "nfe.contador.pacotes", method: "GET", path: `${R}/pacotes`, sensitive: false, group: "nfe", access: "read",
    summary: "Ver os pacotes do contador",
    description: "Lista os pacotes de arquivos fiscais para o contador já pedidos (período, situação, quantas notas e arquivos entraram e se já foi enviado). Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "nfe.contador.pacote", method: "POST", path: `${R}/pacotes`, sensitive: false, group: "nfe", access: "write",
    summary: "Montar o pacote do contador de um período",
    description: "Monta o pacote do contador de um mês ou intervalo (de e ate em AAAA-MM-DD, até 366 dias): um ZIP com os XML das notas emitidas (NF-e, NFC-e e NFS-e, com cancelamentos, cartas de correção e inutilizações), das notas recebidas com entrada, os PDFs que o emissor oferece e uma planilha de índice. O mesmo período pedido de novo devolve o mesmo pacote; refazer: true monta outro (por exemplo, porque saiu nota nova). A montagem continua sozinha; consulte os pacotes para ver quando ficou pronto.",
    query: [], body: ["de", "ate", "ambiente", "refazer"], required: ["de", "ate"],
  },
  {
    name: "nfe.contador.relatorio", method: "GET", path: `${R}/relatorio`, sensitive: false, group: "nfe", access: "read",
    summary: "Ver os relatórios fiscais do período",
    description: "Notas emitidas e recebidas do período por CFOP, por natureza da operação e por situação, os impostos destacados (ICMS, ICMS-ST, IPI, PIS, COFINS e ISS) e, no Simples Nacional, a receita separada por anexo conforme a natureza. É conferência para o contador: não calcula guia. Os números vêm do emissor (o que foi autorizado). Só consulta.",
    query: ["de", "ate", "ambiente"], body: [], required: ["de", "ate"],
  },
  {
    name: "nfe.contador.enviar", method: "POST", path: `${R}/envios`, sensitive: true, group: "nfe", access: "write",
    summary: "Enviar o pacote ao contador",
    description: "Manda ao contador cadastrado em Preferências do Fiscal um link seguro, válido por 7 dias, para baixar um pacote pronto: pelo WhatsApp da área ou por e-mail, quando a instalação envia e-mail. Cada envio fica registrado. Sensível: o bot propõe e a pessoa confirma.",
    query: [], body: ["pacote", "canal"], required: ["pacote"],
  },
  // Só pela tela.
  {
    name: "nfe.contador.pacote.ver", method: "GET", path: `${R}/pacotes/:id`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Ver um pacote do contador", description: "Situação e contagens de um pacote do contador.", query: [], body: [], required: ["id"],
  },
  {
    name: "nfe.contador.pacote.baixar", method: "GET", path: `${R}/pacotes/:id/arquivo`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Baixar o pacote do contador", description: "O arquivo ZIP de um pacote pronto.", query: [], body: [], required: ["id"],
  },
  {
    name: "nfe.contador.cadastro", method: "GET", path: `${R}/contador`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Ver o cadastro do contador", description: "Nome, e-mail, WhatsApp do contador, o envio automático e os anexos do Simples por natureza.", query: [], body: [], required: [],
  },
  {
    name: "nfe.contador.cadastro.salvar", method: "PUT", path: `${R}/contador`, sensitive: false, group: "nfe", access: "write", bot: false,
    summary: "Salvar o cadastro do contador", description: "Grava o contador, o envio automático e os anexos do Simples por natureza.",
    query: [], body: ["nome", "email", "whatsapp", "canal", "linha", "automatico", "dia", "simples", "anexos"], required: [],
  },
  {
    name: "nfe.contador.envios.ver", method: "GET", path: `${R}/envios`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Ver os envios ao contador", description: "O registro de cada envio ao contador.", query: [], body: [], required: [],
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function contadorOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_CONTADOR_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const date = { type: "string", format: "date" };
export const ERP_CONTADOR_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  de: { ...date, description: "Primeiro dia do período (AAAA-MM-DD)." },
  ate: { ...date, description: "Último dia do período (AAAA-MM-DD)." },
  ambiente: { type: "string", enum: ["producao", "homologacao"], description: "Padrão: producao." },
  refazer: { type: "boolean", description: "true: monta um pacote novo mesmo que o período já tenha um." },
  pacote: { type: "string", pattern: "^[0-9a-f]{16}$", description: "Id do pacote (da lista de pacotes)." },
  canal: { type: "string", enum: ["whatsapp", "email"], description: "Padrão: o canal do cadastro do contador." },
});

/** Parâmetros (consulta e corpo) num objeto, para o inventário dos bots. */
export function erpContadorParams(operation: ContadorOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_CONTADOR_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...operation.required],
  };
}

export const ERP_CONTADOR_MODULE_CONTRACT = {
  routes: [ERP_CONTADOR_ROUTE],
  definition: { bot: { sensitive: ERP_CONTADOR_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_CONTADOR_OPERATIONS.filter((op) => op.bot !== false).map((op) => [op.name, op.summary])) } },
};

// ---------------------------------------------------------------------------
// Período

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) => DAY.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

/** Período conferido (de ≤ ate, até 366 dias) ou a mensagem do que corrigir. */
export function contadorPeriod(from: unknown, to: unknown): { from: string; to: string } | string {
  if (typeof from !== "string" || !validDay(from)) return "Informe o primeiro dia do período (de, AAAA-MM-DD).";
  if (typeof to !== "string" || !validDay(to)) return "Informe o último dia do período (ate, AAAA-MM-DD).";
  if (from > to) return "O primeiro dia do período vem depois do último. Confira as datas.";
  const days = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000 + 1;
  if (days > CONTADOR_MAX_DAYS) return `O período vai até ${CONTADOR_MAX_DAYS} dias. Escolha um período menor.`;
  return { from, to };
}

/** O mês anterior ao dia (AAAA-MM-DD) como período. */
export function previousMonth(day: string): { from: string; to: string } {
  const [y, m] = day.split("-").map(Number);
  const year = m === 1 ? y - 1 : y, month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}` };
}

/** Rótulo do período: "11/2026" para um mês inteiro, senão "01/11/2026 a 15/11/2026". */
export function periodLabel(from: string, to: string): string {
  const br = (d: string) => d.split("-").reverse().join("/");
  const [y, m] = from.split("-");
  const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  if (from.endsWith("-01") && to === `${y}-${m}-${String(last).padStart(2, "0")}`) return `${m}/${y}`;
  return `${br(from)} a ${br(to)}`;
}

/** Id estável do pacote: o mesmo ambiente e período dão o mesmo id. */
export async function contadorPackageId(environment: string, from: string, to: string): Promise<string> {
  const bytes = new TextEncoder().encode(`wabotia-contador-v1|${environment}|${from}|${to}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Visões públicas

export type ContadorPackageState = "running" | "done" | "failed";
export interface ContadorPackageView {
  id: string;
  environment: ContadorEnvironment;
  from: string;
  to: string;
  label: string;
  state: ContadorPackageState;
  /** Etapa em montagem: emitidas, inutilizacoes, recebidas, bling, fechamento. */
  phase: string;
  counts: ContadorCounts;
  bytes: number;
  filename: string | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
export interface ContadorCounts {
  issued: number;
  received: number;
  bling: number;
  void_ranges: number;
  events: number;
  xml: number;
  pdf: number;
  /** Notas que entraram só na planilha (sem XML no emissor, ou o arquivo não confere). */
  without_xml: number;
}
export const emptyCounts = (): ContadorCounts => ({ issued: 0, received: 0, bling: 0, void_ranges: 0, events: 0, xml: 0, pdf: 0, without_xml: 0 });
