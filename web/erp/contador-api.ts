// Para o contador: chamadas do painel a /api/v1/profiles/<área>/erp-contador
// (src/erp/contador/routes.ts). O servidor confere tudo de novo (papel no ERP,
// parte Fiscal, horário de acesso e segundo fator); aqui só se monta o pedido.
// Fora do painel da área (demonstração) não há esta rota.
import { erpPorts } from "./ports";

export type Environment = "producao" | "homologacao";
export type Channel = "whatsapp" | "email";

export interface Counts { issued: number; received: number; bling: number; void_ranges: number; events: number; xml: number; pdf: number; without_xml: number }
export interface PackageView {
  id: string; environment: Environment; from: string; to: string; label: string; state: "running" | "done" | "failed"; phase: string;
  counts: Counts; bytes: number; filename: string | null; error: string | null; requested_by: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
}
export interface SendView {
  id: string; pacote: string; periodo: string; de: string; ate: string; canal: Channel; destino: string; contador: string | null;
  situacao: "preparado" | "enviado" | "falhou"; erro: string | null; automatico: boolean; por: string; pelo_bot: boolean;
  enviado_em: number; vale_ate: number; vencido: boolean; downloads: number; ultimo_download: number | null;
}
export interface Line { key: string; label: string; count: number; amount: number }
export interface Taxes { icms: number; icms_st: number; ipi: number; pis: number; cofins: number; iss: number }
export interface Report {
  environment: Environment; period: { from: string; to: string; label: string }; complete: boolean; pending_reads: number; retry_after_ms: number | null;
  vault: boolean; notices: string[]; regime: { crt: string | null; label: string };
  issued: { authorized: { count: number; amount: number }; taxes: Taxes; by_cfop: Line[]; by_nature: Line[]; by_status: Line[] };
  received: { authorized: { count: number; amount: number; with_xml: number }; taxes: Taxes; as_third_party: number; by_cfop: Line[]; by_status: Line[];
    by_nature: Line[]; with_entry: { count: number; amount: number } };
  simples: null | { by_annex: (Line & { natures: string[] })[]; unassigned: { amount: number; count: number; natures: string[] }; total: number };
}
export interface Settings {
  nome: string | null; email: string | null; whatsapp: string | null; canal: Channel; linha: string | null; automatico: boolean; dia: number;
  ultimo_mes_automatico: string | null; anexos: Record<string, string>; atualizado_em: number | null;
}
export interface SettingsPage {
  contador: Settings; naturezas: string[]; crt: string | null; anexos_validos: { id: string; nome: string }[];
  linhas: { id: string; nome: string; numero: string | null; tipo: "qr" | "oficial" }[]; email_disponivel: boolean; pode_editar: boolean;
}

export class ContadorError extends Error {
  readonly code: string; readonly status: number;
  constructor(message: string, code = "erp_contador_failed", status = 0) { super(message); this.name = "ContadorError"; this.code = code; this.status = status; }
}

/** /api/v1/profiles/<área>/erp-contador, ou null na demonstração e fora do painel da área. */
export function contadorBase(): string | null {
  const ports = erpPorts();
  if (!ports || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, "/erp-contador");
}
export const CONTADOR_UNAVAILABLE = "O que é do contador abre no painel da área (não na demonstração).";

export async function contadorCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = contadorBase();
  if (!base) throw new ContadorError(CONTADOR_UNAVAILABLE, "erp_contador_unavailable");
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: "same-origin", cache: "no-store", ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ContadorError(init.method && init.method !== "GET" ? "A resposta não chegou. Atualize a lista antes de tentar de novo." : "Sem resposta do servidor. Confira a conexão e tente de novo.", "erp_contador_network");
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new ContadorError(typeof error.message === "string" ? error.message : `O servidor recusou o pedido (${response.status}). Tente de novo.`,
      typeof error.code === "string" ? error.code : "erp_contador_failed", response.status);
  }
  return body as T;
}
const send = <T,>(method: string, path: string, body: unknown) => contadorCall<T>(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

export const listPackages = (signal?: AbortSignal) => contadorCall<{ pacotes: PackageView[]; envios: SendView[] }>("/pacotes", { signal });
export const askPackage = (input: { de: string; ate: string; ambiente: Environment; refazer?: boolean }) =>
  send<{ pacote: PackageView; reaproveitado: boolean }>("POST", "/pacotes", input);
export const downloadUrl = (id: string) => `${contadorBase()}/pacotes/${id}/arquivo`;
export const loadReport = (query: { de: string; ate: string; ambiente: Environment }, signal?: AbortSignal) =>
  contadorCall<Report>(`/relatorio?${new URLSearchParams(query)}`, { signal });
export const reportCsvUrl = (query: { de: string; ate: string; ambiente: Environment }) => `${contadorBase()}/relatorio?${new URLSearchParams({ ...query, formato: "csv" })}`;
export const loadSettings = (signal?: AbortSignal) => contadorCall<SettingsPage>("/contador", { signal });
export const saveSettings = (input: Partial<{ nome: string; email: string; whatsapp: string; canal: Channel; linha: string | null; automatico: boolean; dia: number; anexos: Record<string, string> }>) =>
  send<{ contador: Settings }>("PUT", "/contador", input);
export const sendPackage = (input: { pacote: string; canal?: Channel }) => send<{ envio: SendView }>("POST", "/envios", input);
export const listSends = (signal?: AbortSignal) => contadorCall<{ envios: SendView[] }>("/envios", { signal });

// ---------- formatos ----------
export const money = (value: number) => (Number(value) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const brDay = (day: string) => day.split("-").reverse().join("/");
export const when = (ms: number | string | null) => ms === null ? "—" : new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
export const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
export const PHASES: Record<string, string> = {
  emitidas: "lendo as notas emitidas", inutilizacoes: "lendo as inutilizações", recebidas: "juntando as notas recebidas", bling: "juntando o acervo do Bling", fechamento: "fechando o arquivo",
};
/** Mês (AAAA-MM) como período. */
export function monthPeriod(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
/** Mês anterior ao de hoje (São Paulo), AAAA-MM. */
export function previousMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value), m = Number(parts.find((p) => p.type === "month")!.value);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
