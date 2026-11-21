// Porta da tela Notas recebidas (Compras): /api/v1/profiles/<área>/erp-recebidas.
// O servidor lê o XML, confere e lança; o navegador só manda as escolhas da
// pessoa. Instalada pelo hospedeiro (host-runtime.tsx) em erpPorts().recebidas.

export interface RecebidasAccess {
  ready: boolean;
  role: string | null;
  admin: boolean;
  demo: boolean;
  /** products: Produtos (cadastrar produto pela nota); ausente conta como ligado e o servidor confere. */
  parts: { purchases: boolean; stock: boolean; finance: boolean; fiscal: boolean; products?: boolean };
}

export class RecebidasError extends Error {
  readonly status: number;
  readonly code: string;
  /** A resposta não chegou ou o cofre não deu resposta conclusiva: consulte antes de repetir. */
  readonly uncertain: boolean;
  readonly retryAt: string | null;
  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean; retryAt?: string | null } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "recebidas_error";
    this.uncertain = options.uncertain ?? false;
    this.retryAt = options.retryAt ?? null;
  }
}

export type Environment = "homologacao" | "producao";
export interface ItemChoice { position: number; product_id?: string | null; factor?: string | null; lot?: { code: string; manufactured_on?: string | null; expires_on?: string | null } | null }
export interface Choices {
  warehouse_id?: string | null; order_id?: string | null; stock?: boolean; finance?: boolean; icms_in_cost?: boolean;
  category_id?: string | null; payment_method_id?: string | null; items?: ItemChoice[];
}

/** Uma nota do índice, como o servidor devolve (src/erp/domains/inbound/rpc.ts, noteDto). */
export interface ReceivedNote {
  id: string; source: "cofre" | "manual"; environment: Environment; access_key: string; role: string;
  emitter: { document: string | null; name: string | null }; supplier: { id: string; name: string; code: string | null } | null;
  series: number | null; number: number | null; issued_on: string | null; total_cents: number | null; situation: string;
  nature: string | null; purpose: string; purpose_label: string;
  xml: { key: string; sha256: string; size: number } | null;
  vault: null | {
    id: string; xml_available: boolean;
    manifestation: { type: string; label: string; at: string | null; origin: string | null } | null;
    pending: { type: string; state: string; justification: string | null; at: string | null } | null;
  };
  entry: Entry | null; last_entry: Entry | null;
}
export interface Entry {
  id: string; state: "active" | "reversed"; stock_status: string; finance_status: string; movement_ids: string[]; title_ids: string[];
  order_id: string | null; created_at: string | null; reversed_at: string | null; reversal_reason: string | null; result: any;
}
export interface NotesPage {
  items: ReceivedNote[]; total: number; page: number; per_page: number;
  settings: { version: number; manifest_enabled: boolean };
  fetches: { environment: Environment; read_at: string | null; next_at: string | null; error: { code: string; message: string } | null }[];
  company_document: string | null;
}
export interface Review { note: ReceivedNote; review: any | null; missing_xml: boolean }

/** Produto proposto a partir do item da nota (src/erp/domains/inbound/rpc.ts, productProposal). */
export interface ProductProposal {
  position: number; supplier_code: string; description: string; note_unit: string; quantity: string;
  proposal: { name: string; code: string | null; unit: string; ncm: string | null; cest: string | null; gtin: string | null; purchase_price: string; cost_price: string };
  existing: { id: string; name: string; code: string | null } | null;
  problems: string[]; notices: string[];
}
export interface ProductPreview { supplier: { id: string; name: string } | null; can_create: boolean; blockers: string[]; items: ProductProposal[] }
export interface ProductInput { position: number; name?: string; code?: string | null; unit?: string; ncm?: string | null; cest?: string | null; gtin?: string | null }

/** Reposição pelo mínimo e máximo (src/erp/domains/inbound/replenishment.ts). */
export interface ReplenishmentItem {
  product_id: string; code: string | null; name: string; unit: string | null; stock_min: string | null; stock_max: string | null;
  balance: string; ordered: string; orders: { id: string; number: string | null; quantity: string }[]; below_min: boolean; suggestion: string;
  covered_by_orders: boolean; supplier_id: string | null; supplier_name: string | null; suppliers: { id: string; name: string }[];
  unit_price: string | null; price_source: string | null; value: string | null;
}
export interface Replenishment {
  filters: { warehouse_id: string | null; supplier_id: string | null; only_below: boolean }; can_order: boolean;
  warehouses: { id: string; name: string }[]; total: number; items: ReplenishmentItem[];
  totals: { below_min: number; to_buy: number; without_supplier: number; value: string };
}
export interface GeneratedOrders { orders: { document_id: string; number: string | number | null; supplier_id: string; supplier_name: string | null; items: number; replayed: boolean }[]; replayed: boolean }
export interface Inventory {
  filters: { date: string; warehouse_id: string | null; include_zero: boolean }; cost_visible: boolean; cost_basis: string;
  warehouses_available: { id: string; name: string }[]; total: number;
  items: { product_id: string; code: string | null; name: string; unit: string | null; warehouse_id: string; warehouse_name: string; ignored: boolean; quantity: string; average_cost: string | null; value: string | null }[];
  warehouses: { warehouse_id: string; name: string; products: number; value: string | null }[];
  totals: { value: string | null; uncosted: number | null };
}
export interface InventoryQuery { data: string; deposito?: string | null; zerados?: boolean }

const uuid = () => crypto.randomUUID();
const inventoryQuery = (query: InventoryQuery) => {
  const q = new URLSearchParams({ data: query.data });
  if (query.deposito) q.set("deposito", query.deposito);
  if (query.zerados) q.set("zerados", "1");
  return q.toString();
};

export interface RecebidasPort {
  access(): RecebidasAccess;
  list(query: { ambiente?: Environment | ""; situacao?: string; pagina?: number }, signal?: AbortSignal): Promise<NotesPage>;
  review(id: string, signal?: AbortSignal): Promise<Review>;
  preview(id: string, choices: Choices, signal?: AbortSignal): Promise<Review>;
  fetchVault(input: { ambiente: Environment; autorizacao_producao?: boolean }): Promise<any>;
  importXml(xml: string): Promise<ReceivedNote>;
  createSupplier(id: string, command: string): Promise<{ supplier: { id: string; name: string }; created: boolean }>;
  enter(id: string, command: string, choices: Choices): Promise<{ entry: Entry; note: ReceivedNote; replayed: boolean; already_entered?: boolean }>;
  reverse(id: string, command: string, reason: string): Promise<{ entry: Entry; note: ReceivedNote }>;
  manifest(id: string, input: { command_id: string; tipo: string; justificativa?: string; autorizacao_producao?: boolean; reenviar?: boolean }): Promise<any>;
  settings(signal?: AbortSignal): Promise<{ version: number; manifest_enabled: boolean }>;
  saveSettings(input: { expected_version: number; manifestar: boolean; ciente_ato_fiscal: boolean }): Promise<{ version: number; manifest_enabled: boolean }>;
  xmlUrl(id: string): string;
  /** Um identificador novo por intenção (repetir o mesmo pedido não duplica nada no servidor). */
  command(): string;
  /** Produto pelo XML: prévia dos itens sem produto (ou dos escolhidos) e o cadastro. */
  productPreview?(id: string, positions?: number[], signal?: AbortSignal): Promise<ProductPreview>;
  createProducts?(id: string, command: string, items: ProductInput[]): Promise<{ created: { position: number; product: { id: string; name: string; code: string | null } }[]; replayed: boolean }>;
  /** Reposição pelo estoque mínimo e máximo e os pedidos de compra gerados. */
  replenishment?(query: { deposito?: string | null; fornecedor?: string | null; todos?: boolean }, signal?: AbortSignal): Promise<Replenishment>;
  generateOrders?(command: string, input: { deposito?: string | null; itens: { product_id: string; quantity: string; supplier_id?: string | null }[] }): Promise<GeneratedOrders>;
  /** Inventário valorizado numa data (tela e planilha). */
  inventory?(query: InventoryQuery, signal?: AbortSignal): Promise<Inventory>;
  inventoryCsvUrl?(query: InventoryQuery): string;
}

export function createRecebidasPort(profile: string, options: { access: () => RecebidasAccess; fetch?: typeof fetch }): RecebidasPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-recebidas`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const id = (value: string) => {
    if (!/^[0-9a-f-]{36}$/.test(value)) throw new RecebidasError("Identificador da nota inválido.", { status: 400, code: "invalid_request" });
    return encodeURIComponent(value);
  };
  async function request(method: "GET" | "POST" | "PUT", path: string, body?: object, signal?: AbortSignal): Promise<any> {
    const access = options.access();
    if (access.demo && method !== "GET") throw new RecebidasError("A demonstração não busca nem lança notas.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new RecebidasError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. O pedido pode ter sido registrado: atualize a lista antes de repetir.",
        { code: "response_lost", uncertain: method !== "GET" });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new RecebidasError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "recebidas_error",
        uncertain: detail.code === "recebidas_manifest_uncertain" || response.status === 502 || response.status === 504,
        retryAt: typeof value?.retry_at === "string" ? value.retry_at : null,
      });
    }
    return value;
  }
  return {
    access: options.access,
    list: (query, signal) => {
      const q = new URLSearchParams();
      if (query.ambiente) q.set("ambiente", query.ambiente);
      if (query.situacao) q.set("situacao", query.situacao);
      if (query.pagina && query.pagina > 1) q.set("pagina", String(query.pagina));
      return request("GET", `notas${q.size ? `?${q}` : ""}`, undefined, signal);
    },
    review: (note, signal) => request("GET", `notas/${id(note)}`, undefined, signal),
    preview: (note, choices, signal) => request("POST", `notas/${id(note)}/previa`, { escolhas: choices }, signal),
    fetchVault: (input) => request("POST", "buscar", input),
    importXml: (xml) => request("POST", "importar", { xml }),
    createSupplier: (note, command) => request("POST", `notas/${id(note)}/fornecedor`, { command_id: command }),
    enter: (note, command, choices) => request("POST", `notas/${id(note)}/entrada`, { command_id: command, escolhas: choices }),
    reverse: (note, command, reason) => request("POST", `notas/${id(note)}/estorno`, { command_id: command, motivo: reason }),
    manifest: (note, input) => request("POST", `notas/${id(note)}/manifestar`, input),
    settings: (signal) => request("GET", "configuracao", undefined, signal),
    saveSettings: (input) => request("PUT", "configuracao", input),
    xmlUrl: (note) => `${base}/notas/${id(note)}/xml`,
    command: uuid,
    productPreview: (note, positions, signal) => request("GET", `notas/${id(note)}/produto${positions?.length ? `?posicoes=${positions.join(",")}` : ""}`, undefined, signal),
    createProducts: (note, command, items) => request("POST", `notas/${id(note)}/produto`, { command_id: command, itens: items }),
    replenishment: (query, signal) => {
      const q = new URLSearchParams();
      if (query.deposito) q.set("deposito", query.deposito);
      if (query.fornecedor) q.set("fornecedor", query.fornecedor);
      if (query.todos) q.set("todos", "1");
      return request("GET", `reposicao${q.size ? `?${q}` : ""}`, undefined, signal);
    },
    generateOrders: (command, input) => request("POST", "reposicao/pedidos", { command_id: command, deposito: input.deposito ?? null, itens: input.itens }),
    inventory: (query, signal) => request("GET", `inventario?${inventoryQuery(query)}`, undefined, signal),
    inventoryCsvUrl: (query) => `${base}/inventario?${inventoryQuery(query)}&formato=csv`,
  };
}
