// Porta da tela Ordens de produção (Estoque › Ordens de produção):
// /api/v1/profiles/<área>/erp-producao (src/erp/production). O servidor
// confere, calcula e lança; o navegador só manda as escolhas da pessoa.
// Instalada pelo hospedeiro (host-runtime.tsx) em erpPorts().producao.

export interface ProducaoAccess {
  ready: boolean;
  role: string | null;
  admin: boolean;
  demo: boolean;
  parts: { production: boolean; sales: boolean; purchases: boolean };
}

export class ProducaoError extends Error {
  readonly status: number;
  readonly code: string;
  /** A resposta não chegou: o pedido pode ter sido registrado; atualize antes de repetir. */
  readonly uncertain: boolean;
  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "producao_error";
    this.uncertain = options.uncertain ?? false;
  }
}

export type Status = "draft" | "released" | "in_progress" | "done" | "cancelled";
export interface Ref { id: string; name: string | null; code?: string | null; unit?: string | null }
export interface OrderInput {
  position: number; product_id: string; name: string | null; code: string | null; unit: string | null; per_unit: string; loss_percent: string;
  from_composition: boolean; planned: string; pending?: string; available: string; missing: string; problem: string | null;
}
export interface Completion {
  id: string; position: number; quantity: string; occurred_on: string; note: string | null;
  lot: { id: string; code: string; manufactured_on: string | null; expires_on: string | null } | null;
  inputs_cost: string | null; extra_cost: string | null; unit_cost: string | null; state: "active" | "reversed";
  reversed_at: string | null; reverse_reason: string | null; created_at: string;
  inputs: { position: number; product_id: string; name: string; code: string | null; unit: string | null; quantity: string; unit_cost: string | null; total_cost: string | null }[];
}
export interface Order {
  id: string; number: number; label: string; status: Status; status_label: string;
  product: (Ref & { format: string; lot_control: boolean; problem: string | null }) | null;
  quantity: string; produced: string; remaining: string; unit: string | null;
  source_warehouse: { id: string; name: string | null; active: boolean }; target_warehouse: { id: string; name: string | null; active: boolean };
  planned_on: string | null; responsible: string | null; notes: string | null; origin: "manual" | "plan";
  sales_orders: { id: string; number: number | null; status: string | null }[]; cancel_reason: string | null; version: number;
  created_at: string; updated_at: string; inputs: OrderInput[]; completions: Completion[];
  costs_visible: boolean; can_write: boolean; negative_allowed: boolean; lot_rules: { require_expiry: boolean; require_manufacture: boolean };
}
export interface OrderRow {
  id: string; number: number; label: string; status: Status; status_label: string; product: Ref; quantity: string; produced: string; unit: string | null;
  planned_on: string | null; responsible: string | null; origin: string; source_warehouse: Ref; target_warehouse: Ref; version: number;
}
export interface OrdersPage { items: OrderRow[]; total: number; page: number; per_page: number; counts: Record<Status, number> }
export interface Options {
  warehouses: { id: string; name: string; active: boolean }[]; default_warehouse_id: string | null; negative_allowed: boolean; entry_decimals: number;
  can_write: boolean; costs_visible: boolean; can_purchase: boolean; parts: { sales: boolean; purchases: boolean };
  lot_rules: { require_expiry: boolean; require_manufacture: boolean };
}
export interface ProductHit extends Ref { format: string; lot_control: boolean; has_composition: boolean; problem: string | null; stock: string }
export interface CompositionView {
  product: Ref & { format: string; lot_control: boolean }; problem: string | null; quantity: string; inputs: OrderInput[];
}
export interface Preview {
  quantity: string; negative_allowed: boolean; can_complete: boolean; costs_visible: boolean; cost_known: boolean;
  finished: Ref & { lot_control: boolean }; lot_rules: { require_expiry: boolean; require_manufacture: boolean };
  inputs: { product_id: string; name: string | null; code: string | null; unit: string | null; quantity: string; balance: string; available: string; missing: string; no_cost: boolean; unit_cost: string | null; total_cost: string | null }[];
  inputs_cost: string | null; extra_cost: string | null; unit_cost: string | null;
}
export interface Suggestion {
  product: Ref & { format: string }; demand: string; stock: string; planned: string; quantity: string; sales_orders: { id: string; number: number | null }[];
  inputs: { product_id: string; name: string | null; code: string | null; unit: string | null; per_unit: string; needed: string; available: string; missing: string }[];
}
export interface ShoppingItem { product_id: string; name: string | null; code: string | null; unit: string | null; needed: string; missing: string; supplier: { id: string; name: string } | null; cost_price: string | null }
export interface Plan { sales_on: boolean; purchases_on: boolean; can_purchase: boolean; can_write: boolean; suggestions: Suggestion[]; shopping: ShoppingItem[] }

export interface OrderInputChoice { produto: string; por_unidade: string; perda?: string }
export interface OrderFields {
  produto?: string; quantidade?: string; deposito_insumos?: string; deposito_acabado?: string; data_prevista?: string | null;
  responsavel?: string | null; observacoes?: string | null; insumos?: OrderInputChoice[];
}
export interface CompleteInput {
  versao: number; quantidade: string; custo_adicional?: string; consumo?: { produto: string; quantidade: string }[];
  lote?: { codigo: string; fabricacao?: string; validade?: string }; observacao?: string; encerrar?: boolean; comando: string;
}

export interface ProducaoPort {
  access(): ProducaoAccess;
  options(signal?: AbortSignal): Promise<Options>;
  list(query: { situacao?: string; busca?: string; de?: string; ate?: string; pagina?: number }, signal?: AbortSignal): Promise<OrdersPage>;
  get(id: string, signal?: AbortSignal): Promise<{ order: Order }>;
  products(busca: string, finalidade: "acabado" | "insumo", signal?: AbortSignal): Promise<{ items: ProductHit[]; total: number }>;
  composition(produto: string, quantidade: string, deposito: string | null, signal?: AbortSignal): Promise<CompositionView>;
  create(fields: OrderFields & { situacao?: "rascunho" | "liberada"; comando: string }): Promise<{ order: Order }>;
  update(id: string, fields: OrderFields & { versao: number; comando: string }): Promise<{ order: Order }>;
  status(id: string, input: { versao: number; acao: string; motivo?: string; comando: string }): Promise<{ order: Order }>;
  preview(id: string, query: { quantidade: string; custo_adicional?: string; consumo?: { produto: string; quantidade: string }[] }, signal?: AbortSignal): Promise<Preview>;
  complete(id: string, input: CompleteInput): Promise<{ order: Order }>;
  reverse(completion: string, input: { versao: number; motivo: string; comando: string }): Promise<{ order: Order }>;
  plan(signal?: AbortSignal): Promise<Plan>;
  generate(input: { itens: { produto: string; quantidade: string; pedidos?: string[] }[]; comando: string }): Promise<{ orders: { id: string; label: string }[] }>;
  purchase(input: { itens: { produto: string; quantidade: string; fornecedor?: string }[]; comando: string }): Promise<{ documents: { id: string; number: number | null; supplier_id: string; items: number }[] }>;
  /** Um identificador novo por intenção (repetir o mesmo pedido não duplica nada no servidor). */
  command(): string;
}

export function createProducaoPort(profile: string, options: { access: () => ProducaoAccess; fetch?: typeof fetch }): ProducaoPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-producao`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const id = (value: string) => {
    if (!/^[0-9a-f-]{36}$/.test(value)) throw new ProducaoError("Identificador inválido.", { status: 400, code: "invalid_request" });
    return encodeURIComponent(value);
  };
  async function request(method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal): Promise<any> {
    if (options.access().demo && method !== "GET") throw new ProducaoError("A demonstração não grava ordens de produção.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ProducaoError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. O pedido pode ter sido registrado: atualize a ordem antes de repetir.",
        { code: "response_lost", uncertain: method !== "GET" });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new ProducaoError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "producao_error", uncertain: response.status === 502 || response.status === 504,
      });
    }
    return value;
  }
  const qs = (entries: Record<string, string | number | undefined | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(entries)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    return q.size ? `?${q}` : "";
  };
  return {
    access: options.access,
    options: (signal) => request("GET", "opcoes", undefined, signal),
    list: (query, signal) => request("GET", `ordens${qs({ ...query, pagina: query.pagina && query.pagina > 1 ? query.pagina : undefined })}`, undefined, signal),
    get: (order, signal) => request("GET", `ordens/${id(order)}`, undefined, signal),
    products: (busca, finalidade, signal) => request("GET", `produtos${qs({ busca, finalidade })}`, undefined, signal),
    composition: (produto, quantidade, deposito, signal) => request("GET", `composicao${qs({ produto, quantidade, deposito })}`, undefined, signal),
    create: (fields) => request("POST", "ordens", fields),
    update: (order, fields) => request("POST", `ordens/${id(order)}`, fields),
    status: (order, input) => request("POST", `ordens/${id(order)}/situacao`, input),
    preview: (order, query, signal) => request("GET", `ordens/${id(order)}/previa${qs({ quantidade: query.quantidade, custo_adicional: query.custo_adicional,
      consumo: query.consumo?.length ? JSON.stringify(query.consumo) : undefined })}`, undefined, signal),
    complete: (order, input) => request("POST", `ordens/${id(order)}/concluir`, input),
    reverse: (completion, input) => request("POST", `apontamentos/${id(completion)}/estorno`, input),
    plan: (signal) => request("GET", "planejamento", undefined, signal),
    generate: (input) => request("POST", "planejamento/ordens", input),
    purchase: (input) => request("POST", "planejamento/compras", input),
    command: () => crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Números como a pessoa lê (puro: os testes do Node importam).

/** "12.500000" → "12,5"; "3.000000" → "3". */
export function quantityText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const [int, frac = ""] = value.replace(/^-/, "").split(".");
  const trimmed = frac.replace(/0+$/, "");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (value.startsWith("-") ? "-" : "") + grouped + (trimmed ? `,${trimmed}` : "");
}
/** "5.0000000000" → "R$ 5,00" (até 4 casas quando o custo tem mais). */
export function moneyText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const [int, frac = ""] = value.replace(/^-/, "").split(".");
  const cents = frac.padEnd(2, "0");
  const extra = cents.slice(2, 4).replace(/0+$/, "");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value.startsWith("-") ? "-" : ""}R$ ${grouped},${cents.slice(0, 2)}${extra}`;
}
/** Texto do motivo de não poder fabricar (finishedProblem do motor). */
export const PRODUCT_PROBLEMS: Readonly<Record<string, string>> = {
  deleted: "O produto está na lixeira.",
  not_product: "Serviço não é fabricado.",
  inactive: "O produto está inativo.",
  no_unit: "O produto não tem unidade no cadastro.",
  variations: "Produto com variações: escolha a variação.",
  not_simple: "Este tipo de produto não é fabricado.",
  no_composition: "A composição do produto está vazia: monte a composição em Produtos.",
  virtual: "A composição é Virtual (sem estoque próprio): mude o tipo de estoque para Físico na composição do produto.",
  kit_components: "A composição lança estoque pelos componentes na venda: escolha \"Lançar estoque: Produto\" na composição para fabricar.",
};
export const STATUS_ACTIONS: Readonly<Record<Status, { acao: string; label: string }[]>> = {
  draft: [{ acao: "liberar", label: "Liberar para produção" }, { acao: "iniciar", label: "Começar a produção" }, { acao: "cancelar", label: "Cancelar ordem" }],
  released: [{ acao: "iniciar", label: "Começar a produção" }, { acao: "voltar_rascunho", label: "Voltar para rascunho" }, { acao: "cancelar", label: "Cancelar ordem" }],
  in_progress: [{ acao: "encerrar", label: "Encerrar com o que foi produzido" }, { acao: "cancelar", label: "Cancelar ordem" }],
  done: [],
  cancelled: [],
};
