/** Ponte da ordem de serviço com as notas fiscais (OS, parte 5). A nota é do
 * ERP (src/erp/domains/fiscal/comnfe/os-notes.ts, pelo cofre da NFapi); aqui
 * só se lê, no D1 da área, o que a ordem permite: a nota de serviço e a de
 * peças saem com o orçamento aprovado (ou o preço fixo autorizado) e a ordem
 * em execução, pronta ou entregue. A ordem nunca espera a nota para mudar de
 * etapa; o modelo pode marcar "exigir nota para entregar" (requireInvoice).
 */
import { exec, one } from "../../../db";
import { ApiError, json, now, type Env } from "../../../types";
import { moduleEnabled } from "../../registry";

/** Situação de cada nota da ordem, como o serviço da nota a leu agora. */
export interface OsNoteSnapshot { kind: "nfse" | "nfe"; emission: { id: string; status: string; number: number | null; protocol: string | null; environment: string } | null }
/** Anota no D1 a situação das notas (migração 0156). Só leitura do ERP; falhar aqui não muda a nota. */
export async function rememberOsNotes(env: Env, profile: string, orderId: string, notes: readonly OsNoteSnapshot[]): Promise<void> {
  for (const note of notes) {
    if (!note.emission) { await exec(env, "DELETE FROM os_fiscal_notes WHERE profile_id=? AND order_id=? AND kind=?", profile, orderId, note.kind); continue; }
    const number = note.kind === "nfse" ? note.emission.protocol : note.emission.number == null ? null : String(note.emission.number);
    await exec(env, `INSERT INTO os_fiscal_notes(profile_id,order_id,kind,emission_id,status,number,environment,updated) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id,order_id,kind) DO UPDATE SET emission_id=excluded.emission_id,status=excluded.status,number=excluded.number,
      environment=excluded.environment,updated=excluded.updated`, profile, orderId, note.kind, note.emission.id, note.emission.status, number, note.emission.environment, now());
  }
}
/** Modelo com "exigir nota para entregar": a entrega pede nota autorizada (de serviço ou de peças). */
export async function requireInvoiceToDeliver(env: Env, profile: string, orderId: string): Promise<void> {
  // Com a parte Fiscal desligada a ordem funciona como antes: a marca não vale.
  if (!(await moduleEnabled(env, profile, "erp-fiscal"))) return;
  const authorized = await one(env, "SELECT 1 FROM os_fiscal_notes WHERE profile_id=? AND order_id=? AND status='autorizada' LIMIT 1", profile, orderId);
  if (!authorized) throw new ApiError(409, "invoice_required",
    "Este modelo exige nota fiscal autorizada para entregar. Emita a nota no bloco Notas fiscais da ordem (ou abra o bloco para atualizar a situação) e tente de novo.");
}

export interface OsOrderFiscalState {
  found: boolean;
  /** Estado de base da ordem (received, approved, in_progress, ready, delivered...). */
  status: string | null;
  /** Título no vocabulário do modelo, por exemplo "Ordem de serviço 12". */
  title: string | null;
  authorized: boolean;
  /** Pode emitir agora; senão, `reason` diz por que não, em palavras. */
  eligible: boolean;
  reason: string | null;
  /** O modelo exige nota autorizada para entregar. */
  require_invoice_to_deliver: boolean;
}

/** Estados em que a ordem já tem orçamento aprovado ou serviço concluído. */
export const OS_INVOICE_STATUSES = ["approved", "in_progress", "ready", "delivered"] as const;

export async function osOrderFiscalState(env: Env, profile: string, orderId: string): Promise<OsOrderFiscalState> {
  const none: OsOrderFiscalState = { found: false, status: null, title: null, authorized: false, eligible: false,
    reason: "Ordem de serviço não encontrada nesta área.", require_invoice_to_deliver: false };
  if (!(await moduleEnabled(env, profile, "os"))) return { ...none, reason: "O módulo Ordem de Serviço está desligado nesta área. Um administrador pode ligá-lo em Gestão → Módulos." };
  const row = await one<Record<string, unknown>>(env,
    "SELECT id,status,number,type_number,commercial_json,type_snapshot_json FROM os_orders WHERE profile_id=? AND id=?", profile, orderId);
  if (!row) return none;
  const status = String(row.status);
  const commercial = json(row.commercial_json as string | null, {}) as { authorization?: { kind?: string } | null };
  const snapshot = json(row.type_snapshot_json as string | null, null) as { labels?: { singular?: string }; number_prefix?: string;
    features?: { require_invoice_to_deliver?: boolean } } | null;
  const authorized = commercial.authorization?.kind === "approved_quote" || commercial.authorization?.kind === "fixed_price";
  const label = snapshot?.labels?.singular?.trim() || "Ordem de serviço";
  const number = `${snapshot?.number_prefix ?? ""}${row.type_number ?? row.number}`;
  let reason: string | null = null;
  if (status === "cancelled") reason = "A ordem foi cancelada: não há nota a emitir.";
  else if (status === "declined") reason = "O cliente recusou o orçamento: não há nota a emitir.";
  else if (!authorized || !(OS_INVOICE_STATUSES as readonly string[]).includes(status))
    reason = "Falta aprovar o orçamento (ou autorizar o preço fixo) antes de emitir a nota.";
  return { found: true, status, title: `${label} ${number}`, authorized, eligible: reason === null, reason,
    require_invoice_to_deliver: snapshot?.features?.require_invoice_to_deliver === true };
}
