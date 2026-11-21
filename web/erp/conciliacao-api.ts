// Porta das telas Financeiro › Conciliação bancária e Conciliação de cartões:
// /api/v1/profiles/<área>/erp-conciliacao. O servidor confere e grava; o
// navegador só lê o arquivo escolhido e manda as escolhas da pessoa.
// Instalada pelo hospedeiro (host-runtime.tsx) em erpPorts().conciliacao.

export interface ConciliacaoAccess {
  ready: boolean;
  role: string | null;
  demo: boolean;
  /** Partes ligadas: Financeiro (dono das telas), PDV e Vendas (só mudam a origem mostrada da venda). */
  parts: { finance: boolean; pos: boolean; sales: boolean };
}

export class ConciliacaoError extends Error {
  readonly status: number;
  readonly code: string;
  /** A resposta não chegou: o pedido pode ter sido gravado; atualize antes de repetir. */
  readonly uncertain: boolean;
  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "conciliacao_error";
    this.uncertain = options.uncertain ?? false;
  }
}

export interface Account { id: string; name: string; kind: string; account_type: string; pending: number; reconciled: number; ignored: number; last_line_on: string | null }
export interface Category { id: string; name: string; kind: "receivable" | "payable" }
export interface Layout { id: string; kind: "bank" | "card"; name: string; acquirer: string | null; acquirer_name: string | null; account_id: string | null; mapping: { columns: Record<string, string> }; version: number }
export interface Rule { id: string; name: string; pattern: string; direction: "in" | "out" | "any"; account_id: string | null; category_id: string; category_name: string | null; contact_name: string | null; active: boolean; version: number }
export interface Rate { id: string; acquirer: string; acquirer_name: string; brand: string; brand_label: string; product: "debit" | "credit"; installments_from: number; installments_to: number; rate_bp: number; fixed_cents: string; settle_days: number; active: boolean; version: number }
export interface Overview {
  role: string; can_write: boolean; accounts: Account[]; categories: Category[]; layouts: Layout[]; rules: Rule[]; rates: Rate[];
  acquirers: { id: string; name: string }[]; brands: { id: string; label: string }[]; parts: { pos: boolean; sales: boolean };
}
export interface Link { link_id: string; kind: string; id: string; line_kind: string; posted_on: string; amount_cents: string; note: string | null; contact_name: string | null; category_name: string | null }
export interface Suggestion {
  type: "movement" | "title" | "card" | "rule"; confidence: number; level: string; label: string; detail: string | null;
  links?: { kind: "entry" | "movement"; id: string }[]; titles?: { id: string; version: number; balance_cents: string }[]; rule_id?: string; category_id?: string;
}
export interface BankLine {
  id: string; posted_on: string; amount_cents: string; memo: string | null; state: "pending" | "reconciled" | "ignored"; version: number; source: string;
  ignored_reason: string | null; links: Link[]; suggestions: Suggestion[];
}
export interface DayBalance { day: string; system_cents: string; bank_cents: string | null; difference_cents: string | null }
export interface BankPage {
  role: string; can_write: boolean; account: { id: string; name: string }; state: string; counts: { pending: number; reconciled: number; ignored: number };
  lines: BankLine[]; truncated: boolean; balances: DayBalance[]; period: { from: string; to: string };
  statements: { id: string; file_name: string; period_from: string; period_to: string; new_lines: number }[];
}
export interface Candidates {
  movements: { kind: "entry" | "movement"; id: string; line_kind: string; posted_on: string; amount_cents: string; note: string | null; contact_name: string | null }[];
  titles: { id: string; kind: string; version: number; contact_name: string; description: string; due_on: string; balance_cents: string; installment: number; installments: number }[];
}
export interface Preview {
  target: "bank" | "card"; total: number; header: string[] | null; mapped: Record<string, number> | null; period_from?: string; period_to?: string;
  credits_cents?: string; debits_cents?: string; gross_cents?: string; skipped?: number; balances?: number; lines: Record<string, unknown>[];
}
export interface TitleRef { id: string; version: number; description: string | null; contact_name: string | null; issued_on: string; due_on: string; amount_cents: string; balance_cents: string; installment: number; installments: number; origin: string | null }
export interface GroupRef { id: string; contact_name: string | null; description: string | null; issued_on: string; installments: number; amount_cents: string }
export interface CardLine {
  id: string; kind: "sale" | "receivable"; acquirer: string; acquirer_name: string; sold_on: string | null; expected_on: string | null; brand: string; brand_label: string;
  product: "debit" | "credit"; installment: number; installments: number; gross_cents: string; fee_cents: string; net_cents: string; nsu: string | null; authorization: string | null;
  state: "pending" | "matched" | "received" | "ignored"; version: number; confidence: number | null; level: string | null; title: TitleRef | null; group: GroupRef | null;
  fee: { charged_rate_bp: number; contracted_rate_bp: number | null; expected_cents: string | null; difference_cents: string | null; above_contract: boolean; contracted_day: string | null; late: boolean };
  received: { settlement_id: string; account_id: string; received_on: string } | null; ignored_reason: string | null;
}
export interface CardPage {
  role: string; can_write: boolean; lines: CardLine[]; truncated: boolean;
  summary: { gross_cents: string; fee_cents: string; expected_fee_cents: string; above_contract: number; coming: { day: string; count: number; gross_cents: string; net_cents: string }[];
    late: { count: number; net_cents: string }; open_titles: { day: string; count: number; balance_cents: string }[] };
  imports: { id: string; acquirer_name: string; kind: string; file_name: string; lines: number; new_lines: number }[]; rates: Rate[]; accounts: { id: string; name: string }[];
}

export interface ConciliacaoPort {
  access(): ConciliacaoAccess;
  overview(signal?: AbortSignal): Promise<Overview>;
  bankLines(account: string, query: Record<string, string | undefined>, signal?: AbortSignal): Promise<BankPage>;
  bankCandidates(line: string, search: string | undefined, signal?: AbortSignal): Promise<Candidates>;
  preview(input: Record<string, unknown>): Promise<Preview>;
  bankImport(account: string, input: Record<string, unknown>, command: string): Promise<{ new_lines: number; skipped: number; duplicate_file: boolean; balances: number; period_from: string; period_to: string }>;
  bankAction(line: string, input: Record<string, unknown>, command: string): Promise<{ line: BankLine }>;
  saveRule(input: Record<string, unknown>, command: string): Promise<{ rule: Rule }>;
  saveLayout(input: Record<string, unknown>, command: string): Promise<{ layout: Layout }>;
  cardLines(query: Record<string, string | undefined>, signal?: AbortSignal): Promise<CardPage>;
  cardCandidates(line: string, signal?: AbortSignal): Promise<{ candidates: { confidence: number; level: string; title: TitleRef | null; group: GroupRef | null }[] }>;
  cardImport(input: Record<string, unknown>, command: string): Promise<{ new_lines: number; skipped: number; duplicate_file: boolean; suggested: number; ignored_rows: number }>;
  cardAction(line: string, input: Record<string, unknown>, command: string): Promise<{ line: CardLine }>;
  cardBatch(input: Record<string, unknown>, command: string): Promise<{ confirmed?: number; suggested?: number; checked?: number }>;
  cardReceive(input: Record<string, unknown>, command: string): Promise<{ received: number; net_cents: string }>;
  saveRate(input: Record<string, unknown>, command: string): Promise<{ rate: Rate }>;
  command(): string;
}

const UUID = /^[0-9a-f-]{36}$/;
export function createConciliacaoPort(profile: string, options: { access: () => ConciliacaoAccess; fetch?: typeof fetch }): ConciliacaoPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-conciliacao`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const id = (value: string) => {
    if (!UUID.test(value)) throw new ConciliacaoError("Identificador inválido. Atualize a tela.", { status: 400, code: "invalid_request" });
    return encodeURIComponent(value);
  };
  const qs = (query: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    return q.size ? `?${q}` : "";
  };
  async function request(method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal, read = method === "GET"): Promise<any> {
    if (options.access().demo && !read) throw new ConciliacaoError("A demonstração não grava na conciliação.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ConciliacaoError(read ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. O pedido pode ter sido gravado: atualize a tela antes de repetir.",
        { code: "response_lost", uncertain: !read });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new ConciliacaoError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "conciliacao_error", uncertain: response.status === 502 || response.status === 504,
      });
    }
    return value;
  }
  return {
    access: options.access,
    overview: (signal) => request("GET", "resumo", undefined, signal),
    bankLines: (account, query, signal) => request("GET", `banco/${id(account)}${qs(query)}`, undefined, signal),
    bankCandidates: (line, search, signal) => request("GET", `banco/linhas/${id(line)}/candidatos${qs({ busca: search })}`, undefined, signal),
    preview: (input) => request("POST", "previa", input, undefined, true),
    bankImport: (account, input, command) => request("POST", `banco/${id(account)}/importar`, { ...input, comando: command }),
    bankAction: (line, input, command) => request("POST", `banco/linhas/${id(line)}`, { ...input, comando: command }),
    saveRule: (input, command) => request("POST", "regras", { ...input, comando: command }),
    saveLayout: (input, command) => request("POST", "modelos", { ...input, comando: command }),
    cardLines: (query, signal) => request("GET", `cartao${qs(query)}`, undefined, signal),
    cardCandidates: (line, signal) => request("GET", `cartao/linhas/${id(line)}/candidatos`, undefined, signal),
    cardImport: (input, command) => request("POST", "cartao/importar", { ...input, comando: command }),
    cardAction: (line, input, command) => request("POST", `cartao/linhas/${id(line)}`, { ...input, comando: command }),
    cardBatch: (input, command) => request("POST", "cartao/lote", { ...input, comando: command }),
    cardReceive: (input, command) => request("POST", "cartao/receber", { ...input, comando: command }),
    saveRate: (input, command) => request("POST", "cartao/taxas", { ...input, comando: command }),
    command: () => crypto.randomUUID(),
  };
}

/** Texto do arquivo escolhido: UTF-8; se não for, Windows-1252 (o das planilhas dos bancos). */
export async function readFileText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}
