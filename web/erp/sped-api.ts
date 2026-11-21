// SPED e SINTEGRA: chamadas do painel a /api/v1/profiles/<área>/erp-sped
// (src/erp/sped/routes.ts). O servidor confere tudo de novo (papel no ERP,
// parte Fiscal, horário de acesso e segundo fator); aqui só se monta o pedido.
// Fora do painel da área (demonstração) não há esta rota.
import { erpPorts } from "./ports";

export type Kind = "efd_icms_ipi" | "efd_contribuicoes" | "sintegra";
export type Environment = "producao" | "homologacao";
export type Channel = "whatsapp" | "email";
export const KINDS: { id: Kind; label: string; help: string }[] = [
  { id: "efd_icms_ipi", label: "SPED Fiscal (EFD ICMS/IPI)", help: "Notas de mercadoria, apuração do ICMS e do IPI e, se você escolher, o inventário. Mensal." },
  { id: "efd_contribuicoes", label: "EFD-Contribuições (PIS/COFINS)", help: "Notas de mercadoria e de serviço e a apuração do PIS e da COFINS. Mensal, para quem não é do Simples." },
  { id: "sintegra", label: "SINTEGRA", help: "Notas por CFOP e alíquota, itens, cupons (NFC-e), produtos e, se você escolher, o inventário. Pedido por alguns estados." },
];

export interface Problem { kind: string; message: string; link: string | null; blocking: boolean }
export interface Counts { issued: number; received: number; nfce: number; nfse: number; cancelled: number; voided: number; without_xml: number; inventory_items: number }
export interface FileView {
  id: string; kind: Kind; kind_label: string; environment: Environment; from: string; to: string; label: string; inventory_on: string | null;
  state: "running" | "done" | "blocked" | "failed"; phase: string; counts: Counts; problems: Problem[]; warnings: string[]; lines: number; bytes: number;
  sha256: string | null; filename: string | null; summary: Record<string, number | string> | null; error: string | null; requested_by: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
}
export interface PendingView { id: string; arquivo: string; pacote: string; periodo: string; canal: Channel | null; situacao: string; erro: string | null; por: string; pedido_em: number }
export interface Check { pendencias: Problem[]; aviso_regime: string | null; crt: string | null; pode_gerar: boolean }
export interface Settings {
  perfil: "A" | "B" | "C"; atividade: "0" | "1";
  contador: { nome: string | null; cpf: string | null; crc: string | null; cnpj: string | null; cep: string | null; endereco: string | null; numero: string | null;
    complemento: string | null; bairro: string | null; telefone: string | null; email: string | null; municipio: string | null };
  pis_cofins: { incidencia: "1" | "2" | "3"; apropriacao: "1" | "2"; tipo_contribuicao: "1" | "2"; regime_cumulativo: "1" | "2" | "9"; natureza: string; atividade: string };
  codigo_receita_icms: string | null; dia_vencimento_icms: number;
  sintegra: { natureza: "1" | "2" | "3"; finalidade: "1" | "2" | "3" | "5"; contato: string | null };
  no_pacote: boolean;
}
export interface SettingsPage { configuracao: Settings; contador_cadastro: { nome: string | null; email: string | null; telefone: string | null } | null; pode_editar: boolean }

export class SpedError extends Error {
  readonly code: string; readonly status: number;
  constructor(message: string, code = "erp_sped_failed", status = 0) { super(message); this.name = "SpedError"; this.code = code; this.status = status; }
}
export function spedBase(): string | null {
  const ports = erpPorts();
  if (!ports || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, "/erp-sped");
}
export const SPED_UNAVAILABLE = "SPED e SINTEGRA abrem no painel da área (não na demonstração).";

export async function spedCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = spedBase();
  if (!base) throw new SpedError(SPED_UNAVAILABLE, "erp_sped_unavailable");
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: "same-origin", cache: "no-store", ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new SpedError(init.method && init.method !== "GET" ? "A resposta não chegou. Atualize a lista antes de tentar de novo." : "Sem resposta do servidor. Confira a conexão e tente de novo.", "erp_sped_network");
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new SpedError(typeof error.message === "string" ? error.message : `O servidor recusou o pedido (${response.status}). Tente de novo.`,
      typeof error.code === "string" ? error.code : "erp_sped_failed", response.status);
  }
  return body as T;
}
const send = <T,>(method: string, path: string, body: unknown) => spedCall<T>(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

export const checkFile = (query: { tipo: Kind; de: string; ate: string; ambiente: Environment; inventario?: string }, signal?: AbortSignal) =>
  spedCall<Check>(`/conferencia?${new URLSearchParams(Object.entries(query).filter(([, v]) => !!v) as [string, string][])}`, { signal });
export const listFiles = (signal?: AbortSignal) => spedCall<{ arquivos: FileView[]; envios: PendingView[] }>("/arquivos", { signal });
export const generateFile = (input: { tipo: Kind; de: string; ate: string; ambiente: Environment; inventario?: string; saldo_credor_anterior?: number; refazer?: boolean }) =>
  send<{ arquivo: FileView; reaproveitado: boolean }>("POST", "/arquivos", input);
export const downloadUrl = (id: string) => `${spedBase()}/arquivos/${id}/conteudo`;
export const loadSettings = (signal?: AbortSignal) => spedCall<SettingsPage>("/configuracao", { signal });
export const saveSettings = (input: Partial<Omit<Settings, "contador">> & { contador?: Partial<Settings["contador"]> }) => send<{ configuracao: Settings }>("PUT", "/configuracao", input);
export const sendFile = (input: { arquivo: string; canal?: Channel }) =>
  send<{ envio: { periodo: string; destino: string } | null; aguardando: boolean; mensagem?: string }>("POST", "/envios", input);

export const money = (cents: number) => ((Number(cents) || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const when = (value: string | number | null) => value === null ? "—" : new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
export const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
export const PHASES: Record<string, string> = { emitidas: "lendo as notas emitidas", inutilizacoes: "lendo as inutilizações", recebidas: "lendo as notas recebidas", fechamento: "montando e conferindo o arquivo" };
/** Mês (AAAA-MM) como período. */
export function monthPeriod(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  return { from: `${month}-01`, to: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
}
/** Mês anterior ao de hoje (São Paulo), AAAA-MM. */
export function previousMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value), m = Number(parts.find((p) => p.type === "month")!.value);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
/** Totais do arquivo em palavras. */
export const SUMMARY_LABELS: Record<string, string> = {
  debitos: "ICMS das saídas (débitos)", creditos: "ICMS das entradas (créditos)", saldo_credor_anterior: "Saldo credor do mês anterior", icms_a_recolher: "ICMS a recolher",
  saldo_credor_transportar: "Saldo credor para o mês seguinte", st_retido: "ICMS-ST retido", ipi_debitos: "IPI das saídas", ipi_creditos: "IPI das entradas", inventario: "Valor do inventário",
  receita_tributada: "Receita tributada", pis_apurado: "PIS apurado", cofins_apurado: "COFINS apurada", credito_pis: "Crédito de PIS", credito_cofins: "Crédito de COFINS",
  pis_a_recolher: "PIS a recolher", cofins_a_recolher: "COFINS a recolher", receita_nao_tributada: "Receita sem PIS/COFINS",
  valor_saidas: "Valor das saídas", valor_entradas: "Valor das entradas", icms_saidas: "ICMS das saídas", icms_entradas: "ICMS das entradas",
};
export const COUNT_LABELS: Record<string, string> = { documentos: "Documentos", registros: "Registros", notas: "NF-e", nfce: "NFC-e" };
