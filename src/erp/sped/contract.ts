// Obrigações fiscais em arquivo (parte Fiscal): SPED Fiscal (EFD ICMS/IPI),
// EFD-Contribuições (PIS/COFINS) e SINTEGRA (Convênio 57/95), em
// /api/v1/profiles/:profile/erp-sped.
//
// Operações com nome estável, as mesmas para a tela, para a API e para o
// inventário de concessões dos bots (src/modules/erp/bot-access.ts, assunto
// "nfe"). Conferir, gerar e consultar são operações comuns; enviar ao
// contador é sensível (o bot propõe e a pessoa confirma). Nada aqui transmite
// ao governo: o arquivo é para o contador ou para o validador oficial (PVA).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

/** Segmento das rotas no Worker (módulo erp-fiscal: desligado, 409 module_disabled). */
export const ERP_SPED_ROUTE = "erp-sped";
/** Prefixo das rotas internas no objeto da área (src/erp/hub.ts). */
export const ERP_SPED_DO_PREFIX = "/erp-sped/";
/** Tela do painel. */
export const SPED_SCREEN = "/sped-fiscal";

/** Parte Fiscal desligada: qual módulo ligar. */
export const SPED_OFF_MESSAGE = "Para gerar SPED e SINTEGRA, ligue o módulo Fiscal em Gestão → Módulos.";

export const SPED_READ_ROLES: readonly string[] = Object.freeze(["admin", "fiscal", "consulta"]);
export const SPED_WRITE_ROLES: readonly string[] = Object.freeze(["admin", "fiscal"]);

export type SpedKind = "efd_icms_ipi" | "efd_contribuicoes" | "sintegra";
export const SPED_KINDS: readonly SpedKind[] = Object.freeze(["efd_icms_ipi", "efd_contribuicoes", "sintegra"]);
export const SPED_KIND_LABELS: Readonly<Record<SpedKind, string>> = Object.freeze({
  efd_icms_ipi: "SPED Fiscal (EFD ICMS/IPI)",
  efd_contribuicoes: "EFD-Contribuições (PIS/COFINS)",
  sintegra: "SINTEGRA",
});
export type SpedEnvironment = "producao" | "homologacao";
export type SpedChannel = "whatsapp" | "email";

export interface SpedOperation {
  name: string;
  method: "GET" | "POST" | "PUT";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  group: "nfe";
  access: "read" | "write";
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_SPED_ROUTE;
export const ERP_SPED_OPERATIONS: readonly SpedOperation[] = Object.freeze([
  {
    name: "nfe.sped.conferir", method: "GET", path: `${R}/conferencia`, sensitive: false, group: "nfe", access: "read",
    summary: "Conferir o que falta para o SPED ou o SINTEGRA",
    description: "Antes de gerar o SPED Fiscal, a EFD-Contribuições ou o SINTEGRA de um mês (tipo efd_icms_ipi, efd_contribuicoes ou sintegra; de e ate em AAAA-MM-DD), lista em palavras o que falta nos cadastros: inscrição estadual e endereço da empresa, NCM ou unidade de produto, participante sem CPF ou CNPJ, dados do contador. Diz também se o regime da empresa normalmente entrega o arquivo (o Simples Nacional não entrega SPED). Só consulta.",
    query: ["tipo", "de", "ate", "inventario"], body: [], required: ["tipo", "de", "ate"],
  },
  {
    name: "nfe.sped.gerar", method: "POST", path: `${R}/arquivos`, sensitive: false, group: "nfe", access: "write",
    summary: "Gerar o SPED Fiscal, a EFD-Contribuições ou o SINTEGRA",
    description: "Gera o arquivo do mês (tipo efd_icms_ipi, efd_contribuicoes ou sintegra; de e ate em AAAA-MM-DD, um mês): lê as notas emitidas pelo emissor e as recebidas com entrada, os cadastros e, se pedido (inventario: o dia do inventário, AAAA-MM-DD), o estoque. A geração continua sozinha; consulte os arquivos para ver quando ficou pronto. Se faltar dado obrigatório, o arquivo não sai e a lista diz o que corrigir. O mesmo período pedido de novo devolve o mesmo arquivo; refazer: true gera outro. Nada é transmitido ao governo.",
    query: [], body: ["tipo", "de", "ate", "ambiente", "inventario", "saldo_credor_anterior", "refazer"], required: ["tipo", "de", "ate"],
  },
  {
    name: "nfe.sped.arquivos", method: "GET", path: `${R}/arquivos`, sensitive: false, group: "nfe", access: "read",
    summary: "Ver os arquivos de SPED e SINTEGRA gerados",
    description: "Lista os arquivos de SPED Fiscal, EFD-Contribuições e SINTEGRA já pedidos: tipo, período, situação (gerando, pronto, com pendências ou falhou), quantas notas e linhas e o que falta corrigir. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "nfe.sped.enviar", method: "POST", path: `${R}/envios`, sensitive: true, group: "nfe", access: "write",
    summary: "Enviar o arquivo de SPED ou SINTEGRA ao contador",
    description: "Põe o arquivo pronto no pacote do contador do mesmo período e manda ao contador cadastrado o link seguro de 7 dias, pelo mesmo envio do pacote (WhatsApp da área ou e-mail). Se o pacote ainda precisa ser montado com o arquivo, o envio sai sozinho quando ele ficar pronto. Sensível: o bot propõe e a pessoa confirma.",
    query: [], body: ["arquivo", "canal"], required: ["arquivo"],
  },
  // Só pela tela.
  {
    name: "nfe.sped.arquivo.ver", method: "GET", path: `${R}/arquivos/:id`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Ver um arquivo de SPED ou SINTEGRA", description: "Situação, contagens, totais e pendências de um arquivo.", query: [], body: [], required: ["id"],
  },
  {
    name: "nfe.sped.arquivo.baixar", method: "GET", path: `${R}/arquivos/:id/conteudo`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Baixar o arquivo de SPED ou SINTEGRA", description: "O arquivo texto pronto, para o contador ou para o validador oficial (PVA).", query: [], body: [], required: ["id"],
  },
  {
    name: "nfe.sped.configuracao", method: "GET", path: `${R}/configuracao`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Ver a configuração do SPED", description: "Perfil, atividade, contador do registro 0100, regime do PIS/COFINS e códigos do SINTEGRA.", query: [], body: [], required: [],
  },
  {
    name: "nfe.sped.configuracao.salvar", method: "PUT", path: `${R}/configuracao`, sensitive: false, group: "nfe", access: "write", bot: false,
    summary: "Salvar a configuração do SPED", description: "Grava a configuração dos arquivos.",
    query: [], body: ["perfil", "atividade", "contador", "pis_cofins", "codigo_receita_icms", "dia_vencimento_icms", "sintegra", "no_pacote"], required: [],
  },
  {
    name: "nfe.sped.envios.ver", method: "GET", path: `${R}/envios`, sensitive: false, group: "nfe", access: "read", bot: false,
    summary: "Ver os envios de arquivos ao contador", description: "Os pedidos de envio de arquivos ao contador e a situação de cada um.", query: [], body: [], required: [],
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function spedOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_SPED_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const date = { type: "string", format: "date" };
export const ERP_SPED_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  tipo: { type: "string", enum: [...SPED_KINDS], description: "efd_icms_ipi (SPED Fiscal), efd_contribuicoes (PIS/COFINS) ou sintegra." },
  de: { ...date, description: "Primeiro dia do período (AAAA-MM-DD)." },
  ate: { ...date, description: "Último dia do período (AAAA-MM-DD), no mesmo mês." },
  ambiente: { type: "string", enum: ["producao", "homologacao"], description: "Padrão: producao." },
  inventario: { ...date, description: "Dia do inventário a incluir (bloco H do SPED, registro 74 do SINTEGRA), por exemplo o último dia do ano anterior. Sem ele, o arquivo sai sem inventário." },
  saldo_credor_anterior: { type: "number", minimum: 0, description: "Saldo credor de ICMS do mês anterior, em reais (SPED Fiscal). Padrão: 0." },
  refazer: { type: "boolean", description: "true: gera de novo mesmo que o período já tenha arquivo." },
  arquivo: { type: "string", pattern: "^[0-9a-f]{16}$", description: "Id do arquivo (da lista de arquivos)." },
  canal: { type: "string", enum: ["whatsapp", "email"], description: "Padrão: o canal do cadastro do contador." },
});

export function erpSpedParams(operation: SpedOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_SPED_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...operation.required],
  };
}

export const ERP_SPED_MODULE_CONTRACT = {
  routes: [ERP_SPED_ROUTE],
  definition: { bot: { sensitive: ERP_SPED_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_SPED_OPERATIONS.filter((op) => op.bot !== false).map((op) => [op.name, op.summary])) } },
};

// ---------------------------------------------------------------------------
// Período

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = (value: unknown): value is string =>
  typeof value === "string" && DAY.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const isKind = (value: unknown): value is SpedKind => typeof value === "string" && (SPED_KINDS as readonly string[]).includes(value);

/**
 * Período conferido ou a mensagem do que corrigir. SPED Fiscal e
 * EFD-Contribuições: o mês inteiro (a escrituração é mensal). SINTEGRA: dentro
 * de um mês (normalmente o mês inteiro).
 */
export function spedPeriod(kind: SpedKind, from: unknown, to: unknown): { from: string; to: string } | string {
  if (!validDay(from)) return "Informe o primeiro dia do período (de, AAAA-MM-DD).";
  if (!validDay(to)) return "Informe o último dia do período (ate, AAAA-MM-DD).";
  if (from > to) return "O primeiro dia do período vem depois do último. Confira as datas.";
  if (from.slice(0, 7) !== to.slice(0, 7)) return "O arquivo é de um mês só: escolha o primeiro e o último dia do mesmo mês.";
  const [y, m] = from.split("-").map(Number);
  const whole = from.endsWith("-01") && Number(to.slice(8)) === lastDay(y, m);
  if (kind !== "sintegra" && !whole) return `O ${SPED_KIND_LABELS[kind]} é do mês inteiro: de ${from.slice(0, 8)}01 até ${from.slice(0, 8)}${lastDay(y, m)}.`;
  return { from, to };
}

/** Dia do inventário conferido (até o fim do período), null sem inventário, ou a mensagem. */
export function inventoryDay(value: unknown, to: string): string | null | { error: string } {
  if (value === undefined || value === null || value === "") return null;
  if (!validDay(value)) return { error: "Dia do inventário inválido: use AAAA-MM-DD (por exemplo, o último dia do ano anterior)." };
  if (value > to) return { error: "O inventário é de um dia até o fim do período do arquivo." };
  return value;
}

/** Rótulo do período: "11/2026" para um mês inteiro, senão "01/11/2026 a 15/11/2026". */
export function spedPeriodLabel(from: string, to: string): string {
  const br = (d: string) => d.split("-").reverse().join("/");
  const [y, m] = from.split("-");
  if (from.endsWith("-01") && Number(to.slice(8)) === lastDay(Number(y), Number(m)) && to.slice(0, 7) === from.slice(0, 7)) return `${m}/${y}`;
  return `${br(from)} a ${br(to)}`;
}

/** Id estável do arquivo: o mesmo tipo, ambiente e período dão o mesmo id. */
export async function spedFileId(kind: SpedKind, environment: string, from: string, to: string): Promise<string> {
  const bytes = new TextEncoder().encode(`wabotia-sped-v1|${kind}|${environment}|${from}|${to}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Regime

/**
 * Quem normalmente entrega cada arquivo, pelo regime (CRT): 1 Simples, 2
 * Simples com excesso de sublimite, 3 regime normal, 4 MEI. A tela avisa,
 * sem impedir de gerar.
 */
export function regimeNotice(kind: SpedKind, crt: string | null): string | null {
  const simples = crt === "1" || crt === "4";
  if (kind === "efd_icms_ipi") {
    if (simples) return "Empresas do Simples Nacional normalmente não entregam o SPED Fiscal. Confirme com o contador antes de usar o arquivo; você pode gerar mesmo assim.";
    if (crt === "2") return "No Simples com excesso de sublimite, o SPED Fiscal costuma ser obrigatório. Confirme com o contador.";
  }
  if (kind === "efd_contribuicoes" && (simples || crt === "2"))
    return "Empresas do Simples Nacional não entregam a EFD-Contribuições (o PIS e a COFINS vão no DAS). Você pode gerar mesmo assim, só para conferência.";
  if (kind === "sintegra")
    return "O SINTEGRA só é pedido por alguns estados ou em fiscalização; quem entrega o SPED Fiscal normalmente está dispensado. Confirme com o contador.";
  if (crt === null) return "O regime da empresa (CRT) não está informado: confira em Empresa › Dados fiscais.";
  return null;
}

// ---------------------------------------------------------------------------
// Visões públicas

export type SpedFileState = "running" | "done" | "blocked" | "failed";
export interface SpedProblem {
  /** empresa, contador, produto, participante, nota, configuracao */
  kind: string;
  /** Em palavras: o que falta e onde. */
  message: string;
  /** Atalho na tela para corrigir (rota do painel), quando há. */
  link: string | null;
  /** true: impede o arquivo; false: só atenção. */
  blocking: boolean;
}
export interface SpedCounts {
  issued: number;
  received: number;
  nfce: number;
  nfse: number;
  cancelled: number;
  voided: number;
  /** Notas sem XML no emissor (ficam de fora, com aviso). */
  without_xml: number;
  inventory_items: number;
}
export const emptySpedCounts = (): SpedCounts => ({ issued: 0, received: 0, nfce: 0, nfse: 0, cancelled: 0, voided: 0, without_xml: 0, inventory_items: 0 });

export interface SpedFileView {
  id: string;
  kind: SpedKind;
  kind_label: string;
  environment: SpedEnvironment;
  from: string;
  to: string;
  label: string;
  inventory_on: string | null;
  state: SpedFileState;
  phase: string;
  counts: SpedCounts;
  problems: SpedProblem[];
  warnings: string[];
  lines: number;
  bytes: number;
  sha256: string | null;
  filename: string | null;
  /** Totais conferidos do arquivo (E110 do SPED, M200/M600 da EFD-Contribuições, totais do 50 no SINTEGRA). */
  summary: Record<string, number | string> | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
