// Porta da tela Lojas e filiais: /api/v1/profiles/<área>/erp-lojas. O servidor
// confere e grava (src/erp/lojas/); o navegador só manda as escolhas da
// pessoa. Instalada pelo hospedeiro (host-runtime.tsx) em erpPorts().lojas.

export interface LojasAccess {
  ready: boolean;
  role: string | null;
  demo: boolean;
  /** Partes ligadas (cada seção do relatório e cada lista dependem da sua). */
  parts: { sales: boolean; purchases: boolean; stock: boolean; finance: boolean; pos: boolean };
}

export class LojasError extends Error {
  readonly status: number;
  readonly code: string;
  readonly uncertain: boolean;
  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "lojas_error";
    this.uncertain = options.uncertain ?? false;
  }
}

export interface Address { postal_code?: string; street?: string; number?: string; complement?: string; district?: string; city?: string; state?: string }
export interface Named { id: string; name: string; active?: boolean; kind?: string }
export interface Store {
  id: string; name: string; is_main: boolean; active: boolean; version: number;
  address?: Address; phone?: string | null; cnpj?: string | null; fiscal_series?: number | null;
  default_warehouse_id?: string | null; default_warehouse_name?: string | null;
  warehouses?: Named[]; accounts?: Named[]; people?: number;
}
export interface Overview {
  role: string; admin: boolean; multi: boolean;
  me: { user_id: string; limited: boolean; allowed: string[] | null; selected_store_id: string | null; default_store_id: string | null };
  stores: Store[];
  warehouses?: (Named & { store_id: string | null })[];
  accounts?: (Named & { store_id: string | null })[];
  people?: { user_id: string; name: string | null; role: string; store_ids: string[] }[];
}
export interface Compared { by_store: Record<string, string>; total: string }
export interface Report {
  from: string; to: string; basis: "cash" | "competence";
  stores: { id: string; name: string; is_main: boolean }[];
  unavailable: string[];
  sales?: { orders: Compared; total: Compared; average_ticket: Compared; pos_orders: Compared; pos_total: Compared };
  cash?: { inflow: Compared; outflow: Compared; net: Compared; balance: Compared; sessions: Compared; open_sessions: Compared };
  stock?: { quantity: Compared; cost_value?: Compared; sale_value?: Compared; cost_hidden?: boolean };
  dre?: { groups: ({ key: string } & Compared)[]; lines: ({ key: string } & Compared)[]; unclassified: Compared };
}
export type OperationKind = "pedidos" | "propostas" | "compras" | "contas" | "estoque" | "caixa";
export interface OperationItem {
  id: string; label: string; number?: string | null; description?: string | null; contact_name?: string | null; date: string | null;
  status?: string; total?: string | null; settled?: string; quantity?: string; reason?: string | null; store_id: string; store_name: string | null;
}
export interface Operations { kind: string; page: number; limit: number; total: number; stores: Named[]; items: OperationItem[] }
export interface StoreInput {
  id?: string; versao?: number; nome?: string; endereco?: Address; telefone?: string; cnpj?: string; serie?: number | null; ativa?: boolean;
  depositos?: string[]; contas?: string[]; deposito_padrao?: string | null;
}

export interface LojasPort {
  access(): LojasAccess;
  overview(signal?: AbortSignal): Promise<Overview>;
  report(query: { de: string; ate: string; lojas?: string[]; regime?: "caixa" | "competencia" }, signal?: AbortSignal): Promise<Report>;
  operations(query: { tipo: OperationKind; loja?: string; de?: string; ate?: string; pagina?: number }, signal?: AbortSignal): Promise<Operations>;
  save(input: StoreInput, command: string): Promise<{ store: Store }>;
  setPerson(user: string, stores: string[], command: string): Promise<unknown>;
  select(store: string | null): Promise<{ selected_store_id: string | null }>;
  assign(input: { registro: "documento" | "conta"; id: string; loja: string }, command: string): Promise<unknown>;
  command(): string;
}

export function createLojasPort(profile: string, options: { access: () => LojasAccess; fetch?: typeof fetch }): LojasPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-lojas`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const qs = (query: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, String(v));
    return q.size ? `?${q}` : "";
  };
  async function request(method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal): Promise<any> {
    if (options.access().demo && method !== "GET") throw new LojasError("A demonstração não grava nas lojas.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new LojasError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. A loja pode ter sido gravada: atualize a tela antes de repetir.",
        { code: "response_lost", uncertain: method !== "GET" });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new LojasError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "lojas_error", uncertain: response.status === 502 || response.status === 504,
      });
    }
    return value;
  }
  return {
    access: options.access,
    overview: (signal) => request("GET", "", undefined, signal),
    report: (query, signal) => request("GET", `/relatorio${qs({ de: query.de, ate: query.ate, lojas: query.lojas?.join(","), regime: query.regime })}`, undefined, signal),
    operations: (query, signal) => request("GET", `/operacoes${qs(query)}`, undefined, signal),
    save: (input, command) => request("POST", "", { ...input, comando: command }),
    setPerson: (user, stores, command) => request("POST", "/pessoas", { pessoa: user, lojas: stores, comando: command }),
    select: (store) => request("POST", "/em-uso", { loja: store }),
    assign: (input, command) => request("POST", "/vincular", { ...input, comando: command }),
    command: () => crypto.randomUUID(),
  };
}
