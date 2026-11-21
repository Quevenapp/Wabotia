// Porta da Régua de cobrança (Financeiro › Régua de cobrança) e das contas
// recorrentes automáticas (Financeiro › Contas recorrentes):
// /api/v1/profiles/<área>/erp-regua (src/erp/regua). O servidor planeja,
// confere o horário e o consentimento e envia; o navegador só mostra e manda
// as escolhas da pessoa. Instalada pelo hospedeiro (host-runtime.tsx) em
// erpPorts().regua.

export interface ReguaAccess {
  ready: boolean;
  role: string | null;
  admin: boolean;
  demo: boolean;
  parts: { finance: boolean };
}

export class ReguaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "regua_error";
  }
}

export type ReguaPayment = "auto" | "pix" | "link" | "boleto" | "sem";
export type StepStatus = "planned" | "pending" | "sending" | "sent" | "failed" | "skipped" | "cancelled";
export interface ReguaStep {
  id: string | null; title_id: string; stage: "before" | "due" | "after" | "issue"; stage_label: string; channel: "whatsapp" | "email"; channel_label: string;
  origin: "regua" | "recurrence"; planned_on: string; due_on: string; amount_cents: number; status: StepStatus; status_label: string; attempts: number;
  reason: string | null; sent_at: string | null; updated_at: string | null; contact: { id: string; name: string | null } | null; description: string | null;
}
export interface ReguaOverview {
  regua: {
    ligada: boolean; whatsapp: boolean; email: boolean; pagamento: ReguaPayment; hora_inicio: number; hora_fim: number; so_dias_uteis: boolean;
    /** Em branco (null): o da preferência de Contas a receber. */
    dias_antes: number | null; no_vencimento: boolean | null; dias_depois: number | null;
    ligada_em: number | null; ligada_por: string | null; remetente_ativo: boolean | null;
    /** A última rodada do alarme (ms) e, se ela não conseguiu rodar, o motivo. */
    ultima_rodada: number | null; ultimo_erro: string | null;
  };
  email_disponivel: boolean; pode_mudar: boolean; aviso: string;
  today: string; now: string; in_hours: boolean; next_opening: string;
  rules: { before: number; on_due: boolean; after: number; source: "regua" | "preference" | "default"; grace_days: number };
  preference_rules: { before: number; on_due: boolean; after: number; source: "preference" | "default" };
  today_items: ReguaStep[]; sent: ReguaStep[]; not_sent: ReguaStep[];
  counts: { sent: number; failed: number; skipped: number; cancelled: number };
  can_write: boolean;
}
export interface ReguaSettingsInput {
  ligada?: boolean; whatsapp?: boolean; email?: boolean; pagamento?: ReguaPayment; hora_inicio?: number; hora_fim?: number; so_dias_uteis?: boolean; confirmo?: boolean;
  dias_antes?: number | null; no_vencimento?: boolean | null; dias_depois?: number | null;
}
export interface RecurrenceAuto {
  recurrence_id: string; auto_generate: boolean; send_charge: boolean; updated_at: string | null;
  last_run: { recurrence_on: string; outcome: "generated" | "failed"; title_id: string | null; reason: string | null; at: string | null } | null;
}
export interface RecurrenceRun {
  recurrence_id: string; description: string; kind: "receivable" | "payable"; contact_name: string | null; recurrence_on: string;
  outcome: "generated" | "failed"; title_id: string | null; reason: string | null; at: string | null;
}

export interface ReguaPort {
  access(): ReguaAccess;
  overview(signal?: AbortSignal): Promise<ReguaOverview>;
  configure(input: ReguaSettingsInput): Promise<ReguaOverview>;
  recurrences(ids?: readonly string[], signal?: AbortSignal): Promise<{ items: RecurrenceAuto[]; runs: RecurrenceRun[] }>;
  setRecurrence(id: string, input: { automatica: boolean; enviar_cobranca?: boolean }): Promise<{ item: RecurrenceAuto }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createReguaPort(profile: string, options: { access: () => ReguaAccess; fetch?: typeof fetch }): ReguaPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-regua`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function request(method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal): Promise<any> {
    if (options.access().demo && method !== "GET") throw new ReguaError("A demonstração não grava a régua nem as recorrências.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ReguaError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. Atualize a tela para ver se a mudança foi gravada antes de repetir.", { code: "response_lost" });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new ReguaError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`,
        { status: response.status, code: typeof detail.code === "string" ? detail.code : "regua_error" });
    }
    return value;
  }
  return {
    access: options.access,
    overview: (signal) => request("GET", "", undefined, signal),
    configure: (input) => request("POST", "/configuracao", input),
    recurrences: (ids, signal) => {
      const list = (ids ?? []).filter((id) => UUID.test(id)).slice(0, 100);
      return request("GET", `/recorrentes${list.length ? `?ids=${encodeURIComponent(list.join(","))}` : ""}`, undefined, signal);
    },
    setRecurrence: (id, input) => {
      if (!UUID.test(id)) throw new ReguaError("Identificador inválido.", { status: 400, code: "invalid_request" });
      return request("POST", `/recorrentes/${encodeURIComponent(id)}`, input);
    },
  };
}

// ---------------------------------------------------------------------------
// Textos (puro: os testes do Node importam).

/** 31368 → "R$ 313,68". */
export function reguaMoney(cents: number): string {
  const abs = Math.abs(cents), int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cents < 0 ? "-" : ""}R$ ${int},${String(abs % 100).padStart(2, "0")}`;
}
/** "2027-03-10" → "10/03/2027". */
export const reguaDay = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split("-").reverse().join("/") : "—");
/** Instante → "21/11/2026 14:30" em Brasília. */
export const reguaWhen = (value: string | number | null | undefined) => value === null || value === undefined ? "—"
  : new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
export const PAYMENT_LABELS: Readonly<Record<ReguaPayment, string>> = {
  auto: "A da conta (Pix, link ou boleto, conforme a forma de pagamento)", pix: "Pix", link: "Link de pagamento", boleto: "Boleto", sem: "Só a conta, sem cobrança",
};
/** "2 dias antes, no dia e 3 dias depois do vencimento" (ou o que falta configurar). */
export function rulesText(rules: Pick<ReguaOverview["rules"], "before" | "on_due" | "after">): string {
  const parts = [
    ...(rules.before > 0 ? [`${rules.before} ${rules.before === 1 ? "dia" : "dias"} antes`] : []),
    ...(rules.on_due ? ["no dia"] : []),
    ...(rules.after > 0 ? [`${rules.after} ${rules.after === 1 ? "dia" : "dias"} depois`] : []),
  ];
  if (!parts.length) return "Nenhum aviso marcado ainda.";
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}` : parts[0];
  return `${list[0].toUpperCase()}${list.slice(1)} do vencimento.`;
}
