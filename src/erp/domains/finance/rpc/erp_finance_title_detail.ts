// public.erp_finance_title_detail (a gaveta da conta) e public.erp_finance_get
// (leitura de um registro pelo DTO do 010).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { actorLabel } from "../../access/public.ts";
import { BANK_WRITEOFF_ACTION, bool, requireAccess, ts, uuidArg } from "../internal.ts";
import { dto, titleBilling, titleOrigin } from "../titles.ts";

export function erpFinanceTitleDetail(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const id = uuidArg(a.p_id);
  requireAccess(db, user, false);
  if (id === null) raise("22023", "erp_finance_invalid_query");
  const v = dto(db, "titles", id);
  if (v === null) raise("P0002", "erp_finance_not_found");
  const acc = one(
    db,
    'SELECT a.id, a.name, a.active FROM "erp_finance__account" a JOIN "erp_finance__title" t ON t.account_id=a.id WHERE t.id=?',
    id,
  );
  // A versão original: o item do title_create (ou title_create_group) na auditoria.
  let original: Record<string, unknown> | null = null;
  const audits = db.exec(
    `SELECT id, after_data, created_at FROM "erp_finance__audit" WHERE action IN ('title_create_group','title_create') ORDER BY id`,
  ).rows;
  for (const audit of audits) {
    const after = JSON.parse(String(audit.after_data));
    const items = Array.isArray(after?.items) ? after.items : [];
    const item = items.find((x: Record<string, unknown>) => x?.id === id);
    if (item) {
      const text = (k: string) => (item[k] === undefined || item[k] === null ? null : typeof item[k] === "string" ? item[k] : JSON.stringify(item[k]));
      original = {
        contact_name: text("contact_name"),
        due_on: text("due_on"),
        amount_cents: text("amount_cents"),
        description: text("description"),
        created_at: ts(audit.created_at),
      };
      break;
    }
  }
  // Local (desvio "titulo-cobranca-bancaria"): a declaração de boleto baixado no banco que cancelou a
  // conta, lida da auditoria já gravada por erp_finance_execute. Aditivo: a chave só vem quando existe.
  const writeoff = bool(v.cancelled) ? bankWriteoff(db, id) : null;
  return {
    entity: "titles",
    record: v,
    ...(writeoff ? { bank_writeoff: writeoff } : {}),
    origin: titleOrigin(db, id),
    account: acc ? { id: acc.id, name: acc.name, active: bool(acc.active) } : null,
    ...(ctx.parts.billing ? { billing: titleBilling(db, id) } : { unavailable_parts: ["billing"] }),
    imported: !!one(db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" WHERE title_id=? LIMIT 1', id),
    settled_before: !!one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE title_id=? LIMIT 1', id),
    original,
    history: one(db, 'SELECT history FROM "erp_finance__title" WHERE id=?', id)?.history ?? null,
    data_mode: "erp_native",
  };
}

function bankWriteoff(db: SqlDriver, id: string) {
  const row = one(db, `SELECT after_data FROM "erp_finance__audit" WHERE action=? AND json_extract(after_data,'$.record.id')=? ORDER BY id DESC LIMIT 1`, BANK_WRITEOFF_ACTION, id);
  const w = row ? JSON.parse(String(row.after_data))?.bank_writeoff : null;
  if (!w || typeof w !== "object") return null;
  const by = String(w.declared_by);
  return { billing_title_id: w.billing_title_id, remittance_id: w.remittance_id, reason: w.reason, declared_by: by, declared_by_name: actorLabel(db, by), declared_at: w.declared_at };
}

export function erpFinanceGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const entity = (a.p_entity as string | null) ?? null;
  const id = uuidArg(a.p_id);
  requireAccess(db, user, false);
  // dto(p_entity, NULL): a entidade inválida falha antes do id ausente.
  const v = id === null ? (dtoEntityCheck(entity), null) : dto(db, String(entity), id);
  if (v === null) raise("P0002", "erp_finance_not_found");
  return { entity, record: v, data_mode: "erp_native", ...(entity === "titles" ? { origin: titleOrigin(db, id!) } : {}) };
}

function dtoEntityCheck(entity: string | null) {
  if (!["accounts", "categories", "titles", "settlements", "movements"].includes(String(entity)))
    raise("22023", "erp_finance_invalid_entity");
}

registerRpc("erp_finance_title_detail", erpFinanceTitleDetail);
registerRpc("erp_finance_get", erpFinanceGet);
