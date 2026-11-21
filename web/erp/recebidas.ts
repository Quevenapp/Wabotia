// Porta da tela Notas recebidas (Compras): /api/v1/profiles/<área>/erp-recebidas.
// O servidor lê o XML, confere e lança; o navegador só manda as escolhas da
// pessoa. Instalada pelo hospedeiro (host-runtime.tsx) em erpPorts().recebidas.

export interface RecebidasAccess {
  ready: boolean;
  role: string | null;
  admin: boolean;
  demo: boolean;
  parts: { purchases: boolean; stock: boolean; finance: boolean; fiscal: boolean };
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

const uuid = () => crypto.randomUUID();

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
  };
}
