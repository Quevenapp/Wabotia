// Porta da tela Contratos (Financeiro › Contratos):
// /api/v1/profiles/<área>/erp-contratos (src/erp/contratos). O servidor
// confere, calcula e gera as contas; o navegador só manda as escolhas da
// pessoa. Instalada pelo hospedeiro (host-runtime.tsx) em erpPorts().contratos.

export interface ContratosAccess {
  ready: boolean;
  role: string | null;
  admin: boolean;
  demo: boolean;
  parts: { contracts: boolean; finance: boolean; fiscal: boolean };
}

export class ContratosError extends Error {
  readonly status: number;
  readonly code: string;
  /** A resposta não chegou: o pedido pode ter sido registrado; atualize antes de repetir. */
  readonly uncertain: boolean;
  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "contratos_error";
    this.uncertain = options.uncertain ?? false;
  }
}

export type Status = "draft" | "active" | "suspended" | "ended";
export type Periodicity = "monthly" | "bimonthly" | "quarterly" | "semiannual" | "annual";
export interface Ref { id: string; name: string; active?: boolean }
export interface Line {
  id: string; position: number; product_id: string | null; description: string; quantity: string; unit_cents: number; unit_price: string;
  total_cents: number; total: string; valid_from: string; valid_until: string | null;
}
export interface Invoice {
  id: string; contract_id: string; contract_label: string | null; contact: (Ref & { document: string | null; phone: string | null }) | null;
  period_start: string; period_end: string; period_label: string; due_on: string; amount_cents: number; amount: string; settled_cents: number;
  title_id: string; status: "open" | "overdue" | "paid" | "cancelled" | "missing"; status_label: string; origin: "alarm" | "manual";
  charge_status: "none" | "pending" | "sent"; charge_label: string; charge_sent_at: string | null;
  nfse_status: "none" | "pending" | "not_configured" | "issued"; nfse_label: string; created_at: string;
}
export interface Notice { id: string; kind: "renewal" | "adjustment_due" | "customer_adjustment"; kind_label: string; reference: string; message: string; created_at: string; contract_id?: string; contract_label?: string; status?: string }
export interface HistoryEvent { id: string; kind: string; summary: string; effective_on: string | null; by_alarm: boolean; created_at: string }
export interface Contract {
  id: string; number: number; label: string; contact: (Ref & { document: string | null; phone: string | null; email: string | null }) | null; object: string;
  starts_on: string; ends_on: string | null; indefinite: boolean; term_months: number | null; periodicity: Periodicity; periodicity_label: string; due_day: number;
  payment_method: Ref | null; category: Ref | null; seller: Ref | null; status: Status; status_label: string;
  billing: { enabled: boolean; send_whatsapp: boolean; emit_nfse: boolean; nfse_configured: boolean; next_period_on: string | null; next_due_on: string | null; next_amount_cents: number | null; after_end: boolean };
  adjustment: { index: "ipca" | "igpm" | "inpc" | "fixed"; index_label: string; percent: string | null; month: number; notify: boolean; last_month: string | null; next_month: string } | null;
  renewal_notice_days: number; ended_on: string | null; end_reason: string | null; notes: string | null; origin: "manual" | "bling";
  items: Line[]; amount_cents: number; amount: string; scheduled_items: Line[]; history_items: Line[];
  invoices: Invoice[]; events: HistoryEvent[]; attachments: { id: string; filename: string; size_bytes: number; created_at: string }[]; notices: Notice[];
  bling_source_id: string | null; can_write: boolean; version: number; created_at: string; updated_at: string;
}
export interface ContractRow {
  id: string; number: number; label: string; contact: { id: string; name: string }; object: string; starts_on: string; ends_on: string | null;
  periodicity: Periodicity; periodicity_label: string; due_day: number; amount_cents: number; status: Status; status_label: string;
  billing_enabled: boolean; next_period_on: string | null; version: number;
}
export interface ContractsPage { items: ContractRow[]; total: number; page: number; per_page: number; counts: Record<Status, number>; notices: number; pending_charges: number; can_write: boolean }
export interface Options {
  categories: { id: string; name: string }[]; payment_methods: { id: string; name: string }[]; sellers: { id: string; name: string }[];
  periodicities: { id: Periodicity; label: string }[]; indices: { id: string; label: string }[]; nfse_configured: boolean; fiscal_on: boolean;
  can_write: boolean; can_bill: boolean; today: string;
}
export interface Hit { id: string; name: string; document?: string | null; code?: string | null; price?: string | null; service?: boolean }
export interface AdjustmentPreview {
  contract_id: string; label: string; index: string; index_label: string; month: string; month_label: string; effective_on: string; percent: string | null; missing_rate: boolean;
  before: Line[]; after: Line[]; before_cents: number; after_cents: number | null; invoices_after: number; future_change: boolean; notify: boolean; too_early: boolean;
}
export interface Rate { index: string; index_label: string; month: string; percent: string; updated_at: string }
export interface BlingPreview {
  source_id: string; version: string; number: string | null; description: string | null; customer: { name: string | null; document: string | null }; contact_id: string | null;
  starts_on: string | null; ends_on: string | null; periodicity: Periodicity | null; periodicity_text: string | null; due_day: number | null;
  items: { description: string; quantity: string; unit_cents: number; unit_price: string }[]; amount_cents: number; situation: string | null;
  problems: string[]; linked: { contract_id: string; label: string } | null; maintenance: boolean; ready: boolean;
}

/** Campos do contrato como a rota recebe (nomes em português). */
export interface ContractFields {
  cliente?: string; objeto?: string; inicio?: string; fim?: string | null; prazo_meses?: number | null; periodicidade?: string; dia_vencimento?: number;
  forma_pagamento?: string | null; categoria?: string | null; vendedor?: string | null; itens?: { servico?: string; descricao?: string; quantidade?: string; valor: string }[];
  reajuste?: { indice: string; percentual?: string; mes: number; avisar_cliente?: boolean } | null; aviso_renovacao_dias?: number; observacoes?: string | null;
}

export interface ContratosPort {
  access(): ContratosAccess;
  options(signal?: AbortSignal): Promise<Options>;
  search(tipo: "clientes" | "servicos", busca: string, signal?: AbortSignal): Promise<{ items: Hit[] }>;
  list(query: { situacao?: string; busca?: string; pagina?: number; vencendo_em?: number }, signal?: AbortSignal): Promise<ContractsPage>;
  get(id: string, signal?: AbortSignal): Promise<{ contract: Contract }>;
  create(fields: ContractFields & { comando: string }): Promise<{ contract: Contract }>;
  update(id: string, fields: ContractFields & { versao: number; comando: string }): Promise<{ contract: Contract }>;
  status(id: string, acao: "ativar" | "suspender" | "reativar" | "encerrar", input: { versao: number; motivo?: string; data?: string; comando: string }): Promise<{ contract: Contract }>;
  billing(id: string, input: { versao: number; ligada: boolean; enviar_whatsapp?: boolean; emitir_nfse?: boolean; a_partir_de?: string; comando: string }): Promise<{ contract: Contract; created: unknown[] }>;
  billNow(id: string, input: { versao: number; periodo: string; comando: string }): Promise<{ contract: Contract }>;
  invoices(query: { contrato?: string; situacao?: string; de?: string; ate?: string; pagina?: number }, signal?: AbortSignal): Promise<{ items: Invoice[]; total: number; page: number; per_page: number }>;
  markInvoice(id: string, acao: "cobranca_enviada" | "cobranca_a_enviar" | "dispensar_cobranca" | "nfse_emitida", comando: string): Promise<{ invoice: Invoice }>;
  notices(todos: boolean, signal?: AbortSignal): Promise<{ items: Notice[] }>;
  closeNotice(id: string, acao: "feito" | "dispensar", comando: string): Promise<unknown>;
  rates(signal?: AbortSignal): Promise<{ items: Rate[]; indices: { id: string; label: string }[]; can_write: boolean }>;
  saveRate(input: { indice: string; mes: string; percentual: string | null; comando: string }): Promise<unknown>;
  adjustmentPreview(id: string, aPartirDe?: string, signal?: AbortSignal): Promise<AdjustmentPreview>;
  adjust(id: string, input: { versao: number; mes: string; percentual: string; a_partir_de?: string; comando: string }): Promise<{ contract: Contract }>;
  amend(id: string, input: { versao: number; a_partir_de: string; itens?: ContractFields["itens"]; fim?: string | null; motivo: string; comando: string }): Promise<{ contract: Contract }>;
  renew(id: string, input: { versao: number; fim?: string; comando: string }): Promise<{ contract: Contract }>;
  upload(id: string, file: File): Promise<unknown>;
  attachmentUrl(id: string): string;
  removeAttachment(id: string, comando: string): Promise<unknown>;
  bling(cursor?: string, signal?: AbortSignal): Promise<{ available: boolean; items: BlingPreview[]; next_cursor: string | null }>;
  adoptBling(source: string, input: { versao_bling: string; periodicidade?: string; dia_vencimento?: number; categoria?: string; forma_pagamento?: string; comando: string }): Promise<{ contract: Contract }>;
  /** Um identificador novo por intenção (repetir o mesmo pedido não duplica nada no servidor). */
  command(): string;
}

export function createContratosPort(profile: string, options: { access: () => ContratosAccess; fetch?: typeof fetch }): ContratosPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-contratos`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const id = (value: string) => {
    if (!/^[0-9a-f-]{36}$/.test(value)) throw new ContratosError("Identificador inválido.", { status: 400, code: "invalid_request" });
    return encodeURIComponent(value);
  };
  async function request(method: "GET" | "POST", path: string, body?: object | Blob, signal?: AbortSignal, contentType = "application/json"): Promise<any> {
    if (options.access().demo && method !== "GET") throw new ContratosError("A demonstração não grava contratos.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": contentType } : {}) },
        body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ContratosError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. O pedido pode ter sido registrado: atualize o contrato antes de repetir.",
        { code: "response_lost", uncertain: method !== "GET" });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new ContratosError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "contratos_error", uncertain: response.status === 502 || response.status === 504,
      });
    }
    return value;
  }
  const qs = (entries: Record<string, string | number | undefined | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(entries)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    return q.size ? `?${q}` : "";
  };
  const STATUS_PATH = { ativar: "ativar", suspender: "suspender", reativar: "reativar", encerrar: "encerrar" } as const;
  return {
    access: options.access,
    options: (signal) => request("GET", "opcoes", undefined, signal),
    search: (tipo, busca, signal) => request("GET", `opcoes${qs({ busca, tipo })}`, undefined, signal),
    list: (query, signal) => request("GET", `contratos${qs({ ...query, pagina: query.pagina && query.pagina > 1 ? query.pagina : undefined })}`, undefined, signal),
    get: (contract, signal) => request("GET", `contratos/${id(contract)}`, undefined, signal),
    create: (fields) => request("POST", "contratos", fields),
    update: (contract, fields) => request("POST", `contratos/${id(contract)}`, fields),
    status: (contract, acao, input) => request("POST", `contratos/${id(contract)}/${STATUS_PATH[acao]}`, input),
    billing: (contract, input) => request("POST", `contratos/${id(contract)}/cobranca`, input),
    billNow: (contract, input) => request("POST", `contratos/${id(contract)}/faturar`, input),
    invoices: (query, signal) => request("GET", `faturas${qs({ ...query, pagina: query.pagina && query.pagina > 1 ? query.pagina : undefined })}`, undefined, signal),
    markInvoice: (invoice, acao, comando) => request("POST", `faturas/${id(invoice)}/marcar`, { acao, comando }),
    notices: (todos, signal) => request("GET", `avisos${todos ? "?situacao=todos" : ""}`, undefined, signal),
    closeNotice: (notice, acao, comando) => request("POST", `avisos/${id(notice)}`, { acao, comando }),
    rates: (signal) => request("GET", "indices", undefined, signal),
    saveRate: (input) => request("POST", "indices", input),
    adjustmentPreview: (contract, aPartirDe, signal) => request("GET", `contratos/${id(contract)}/reajuste${qs({ a_partir_de: aPartirDe })}`, undefined, signal),
    adjust: (contract, input) => request("POST", `contratos/${id(contract)}/reajuste`, input),
    amend: (contract, input) => request("POST", `contratos/${id(contract)}/aditivo`, input),
    renew: (contract, input) => request("POST", `contratos/${id(contract)}/renovar`, input),
    upload: (contract, file) => request("POST", `contratos/${id(contract)}/anexos${qs({ nome: file.name })}`, file, undefined, "application/pdf"),
    attachmentUrl: (attachment) => `${base}/anexos/${id(attachment)}`,
    removeAttachment: (attachment, comando) => request("POST", `anexos/${id(attachment)}/retirar`, { comando }),
    bling: (cursor, signal) => request("GET", `bling${qs({ cursor })}`, undefined, signal),
    adoptBling: (source, input) => {
      if (!/^[1-9][0-9]{0,39}$/.test(source)) throw new ContratosError("Contrato do Bling inválido.", { status: 400, code: "invalid_request" });
      return request("POST", `bling/${source}/adotar`, input);
    },
    command: () => crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Números e datas como a pessoa lê (puro: os testes do Node importam).

/** 31368 → "R$ 313,68". */
export function centsText(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const negative = cents < 0, abs = Math.abs(cents);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${int},${String(abs % 100).padStart(2, "0")}`;
}
/** "2027-03-10" → "10/03/2027". */
export const dayText = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split("-").reverse().join("/") : "—");
/** "4.5600" → "4,56%". */
export const percentText = (value: string | null | undefined) => (value ? `${value.replace(/\.?0+$/, "").replace(".", ",")}%` : "—");
/** "1.234,50" ou "1234.5" → "1234.50"; inválido: null. */
export function moneyInput(value: string): string | null {
  const t = value.trim().replace(/^R\$\s*/, "");
  const normalized = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  return /^\d{1,11}(\.\d{1,2})?$/.test(normalized) ? normalized : null;
}
/** "12,5" → "12.5"; inválido: null. */
export function quantityInput(value: string): string | null {
  const t = value.trim();
  const normalized = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  return /^\d{1,12}(\.\d{1,6})?$/.test(normalized) && Number(normalized) > 0 ? normalized : null;
}
/** "1.000000" → "1"; "2.500000" → "2,5". */
export const quantityText = (value: string) => value.replace(/\.?0+$/, "").replace(".", ",");
export const PERIODICITY_FIELD: Readonly<Record<Periodicity, string>> = { monthly: "mensal", bimonthly: "bimestral", quarterly: "trimestral", semiannual: "semestral", annual: "anual" };
export const INDEX_FIELD: Readonly<Record<string, string>> = { ipca: "ipca", igpm: "igpm", inpc: "inpc", fixed: "fixo" };
export const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** Ações de situação que valem para cada situação do contrato. */
export const STATUS_ACTIONS: Readonly<Record<Status, { acao: "ativar" | "suspender" | "reativar" | "encerrar"; label: string; reason?: "optional" | "required" }[]>> = {
  draft: [{ acao: "ativar", label: "Ativar contrato" }, { acao: "encerrar", label: "Encerrar", reason: "required" }],
  active: [{ acao: "suspender", label: "Suspender", reason: "optional" }, { acao: "encerrar", label: "Encerrar", reason: "required" }],
  suspended: [{ acao: "reativar", label: "Reativar" }, { acao: "encerrar", label: "Encerrar", reason: "required" }],
  ended: [],
};
