// Cliente das notas da ordem (OS, parte 5): nota de serviço (NFS-e) e nota de
// peças (NF-e) pela rota erp-comercial-nfe do ERP. A tela só pede; o servidor
// prepara, confere cadastro, cofre, papel e partes, e decide.

export type OsNoteKind = "nfse" | "nfe";
export type OsNoteAction = "emitir" | "emitir_de_novo" | "consultar" | "cancelar" | "xml" | "pdf" | "xml_cancelamento";
export interface OsNoteEmission {
  id: string; model: OsNoteKind; status: string; environment: string; fiscal_version: number;
  series: number | null; number: number | null; access_key: string | null; protocol: string | null; authorized_at: string | null;
  messages: { code: string; description: string }[];
  cancellation: null | { state: string; justification: string; xml_status: string };
}
export interface OsNoteSection {
  kind: OsNoteKind; label: string; situation: string; reason: string | null; actions: OsNoteAction[]; effects_note: string | null;
  lines: { id: string; description: string; quantity: string; total_cents: string }[]; total_cents: string;
  emission: OsNoteEmission | null; blockers: { code: string; message: string }[];
}
export interface OsNotesOverview {
  order: { id: string; title: string | null; status: string | null; eligible: boolean; reason: string | null; require_invoice_to_deliver: boolean };
  vault: { configured: boolean; nfse: boolean | null };
  environment: string;
  notes: OsNoteSection[];
  authorized: boolean;
}
export type NfseCancelReason = "erro_emissao" | "servico_nao_prestado" | "outros";
export class OsNotesError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly overview: OsNotesOverview | null = null) { super(message); }
}

const isOverview = (value: unknown): value is OsNotesOverview =>
  !!value && typeof value === "object" && Array.isArray((value as OsNotesOverview).notes) && !!(value as OsNotesOverview).order;

export function createOsNotesApi(profile: string, transport: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-comercial-nfe`;
  const order = (id: string) => `${base}/os/${encodeURIComponent(id)}/notas`;
  async function request(url: string, method: "GET" | "POST" = "GET", body?: object, signal?: AbortSignal): Promise<OsNotesOverview> {
    let response: Response;
    try {
      response = await transport(url, { method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json", "Idempotency-Key": String((body as { command_id?: string }).command_id ?? crypto.randomUUID()) } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new OsNotesError(method === "GET" ? "Sem conexão com o servidor. Confira sua rede e tente de novo."
        : "A resposta não chegou. A nota pode ter sido pedida: use Consultar antes de tentar de novo.", 0, "network");
    }
    let value: unknown = null;
    try { value = await response.json(); } catch { /* resposta sem JSON vira erro legível abaixo */ }
    // Emissão bloqueada (422) devolve a visão com o motivo.
    if (response.status === 422 && isOverview(value)) return value;
    if (!response.ok || !isOverview(value)) {
      const detail = (value && typeof value === "object" ? value : {}) as { code?: string; message?: string; error?: { code?: string; message?: string } };
      throw new OsNotesError(detail.message ?? detail.error?.message ?? (response.status >= 500 ? "O servidor não respondeu. Tente de novo em instantes." : "A nota não pôde ser consultada agora."),
        response.status, detail.code ?? detail.error?.code ?? "fiscal_request_failed");
    }
    return value;
  }
  async function download(id: string, kind: OsNoteKind, file: "xml" | "pdf" | "cancelamento-xml"): Promise<void> {
    const response = await transport(`${order(id)}/${file}?kind=${kind}`, { credentials: "same-origin", cache: "no-store",
      headers: { Accept: file === "pdf" ? "application/pdf" : "application/xml" } });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { code?: string; message?: string };
      throw new OsNotesError(detail.message ?? "O arquivo não pôde ser baixado agora.", response.status, detail.code ?? "fiscal_file_failed");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${kind === "nfse" ? "nota-de-servico" : "nota-de-pecas"}${file === "cancelamento-xml" ? "-cancelamento" : ""}.${file === "pdf" ? "pdf" : "xml"}`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }
  return {
    overview: (id: string, signal?: AbortSignal) => request(order(id), "GET", undefined, signal),
    emit: (id: string, kind: OsNoteKind) => request(`${order(id)}/emitir`, "POST", { command_id: crypto.randomUUID(), kind }),
    consult: (id: string, kind: OsNoteKind) => request(`${order(id)}/consultar`, "POST", { command_id: crypto.randomUUID(), kind }),
    cancel: (id: string, kind: OsNoteKind, justification: string, reason?: NfseCancelReason) =>
      request(`${order(id)}/cancelar`, "POST", { command_id: crypto.randomUUID(), kind, justification, ...(kind === "nfse" && reason ? { reason } : {}) }),
    download,
  };
}
