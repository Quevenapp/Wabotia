// Financeiro: borderôs de baixa (erp_finance.bordero): o histórico da baixa
// (settlement_text), o DTO (bordero_dto) e se ainda tem baixa ativa.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { bool, cmpText, ts, txt, writeRow } from "./internal.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { left, utf16Length } from "./titles.ts";

/** erp_finance.settlement_text: histórico até 2000 (UTF-16); a nota guarda os primeiros 500. */
export function settlementText(data: unknown): { note: string | null; history: string | null } {
  const v = txt(data, "note", 2000);
  if (v !== null && utf16Length(v) > 2000) raise("22023", "erp_finance_invalid_text");
  if (v === null || utf16Length(v) <= 500) return { note: v, history: null };
  let n = 500;
  let note = left(v, n).replace(/ +$/, "");
  while (utf16Length(note) > 500) {
    n--;
    note = left(v, n).replace(/ +$/, "");
  }
  return { note, history: v };
}

/** erp_finance.bordero_active */
export const borderoActive = (db: SqlDriver, id: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_finance__bordero_item" i WHERE i.bordero_id=? AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=i.settlement_id) LIMIT 1`,
    id,
  );

/** erp_finance.bordero_dto(id, linhas) */
export function borderoDto(db: SqlDriver, id: string, withLines: boolean) {
  const b = one(
    db,
    `SELECT b.*, a.name account_name, c.name category_name FROM "erp_finance__bordero" b JOIN "erp_finance__account" a ON a.id=b.account_id
       LEFT JOIN "erp_finance__category" c ON c.id=b.category_id WHERE b.id=?`,
    id,
  );
  if (!b) return null;
  const lines = db.exec(
    `SELECT s.id settlement_id, s.title_id, t.contact_id, r.name contact_name, coalesce(t.source_reference, CAST(d.number AS TEXT)) document_number, t.description,
            s.principal_cents, s.interest_cents, s.penalty_cents, s.discount_cents, s.fee_cents, s.net_cash_cents,
            s.principal_cents+s.interest_cents+s.penalty_cents-s.discount_cents paid_cents,
            EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id) reversed, i.category_id, g.name category_name
       FROM "erp_finance__bordero_item" i JOIN "erp_finance__settlement" s ON s.id=i.settlement_id JOIN "erp_finance__title" t ON t.id=s.title_id
       JOIN "erp_catalog__record" r ON r.id=t.contact_id
       LEFT JOIN "erp_finance__category" g ON g.id=i.category_id
       LEFT JOIN "erp_finance__document_title" l ON l.title_id=t.id LEFT JOIN "erp_finance__document_posting" dp ON dp.id=l.posting_id
       LEFT JOIN "erp_documents__document" d ON d.id=dp.document_id
      WHERE i.bordero_id=?`,
    id,
  ).rows;
  const active = lines.filter((l) => !l.reversed);
  const contacts = new Set(lines.map((l) => String(l.contact_id)));
  const sum = (k: string) => String(active.reduce((s, l) => s + Number(l[k]), 0));
  const dtoBase: Record<string, unknown> = {
    id: b.id,
    kind: b.kind,
    posted_on: b.posted_on,
    account_id: b.account_id,
    account_name: b.account_name,
    category_id: b.category_id,
    category_name: b.category_name ?? null,
    note: b.note,
    grouped: bool(b.grouped),
    version: b.version,
    created_at: ts(b.created_at),
    deleted_at: ts(b.deleted_at),
    active: active.length > 0,
    contact_name: contacts.size === 1 ? lines.map((l) => String(l.contact_name)).sort(cmpText)[0] : null,
    contacts: contacts.size,
    items: lines.length,
    totals: {
      paid_cents: sum("paid_cents"),
      interest_cents: sum("interest_cents"),
      penalty_cents: sum("penalty_cents"),
      discount_cents: sum("discount_cents"),
      fee_cents: sum("fee_cents"),
      net_cash_cents: sum("net_cash_cents"),
    },
  };
  if (!withLines) return dtoBase;
  const sorted = [...lines].sort(
    (x, y) => cmpText(String(x.contact_name), String(y.contact_name)) || cmpText(String(x.settlement_id), String(y.settlement_id)),
  );
  return {
    ...dtoBase,
    lines: sorted.map((l) => ({
      settlement_id: l.settlement_id,
      title_id: l.title_id,
      contact_name: l.contact_name,
      document_number: l.document_number ?? null,
      description: l.description,
      principal_cents: String(l.principal_cents),
      interest_cents: String(l.interest_cents),
      penalty_cents: String(l.penalty_cents),
      discount_cents: String(l.discount_cents),
      fee_cents: String(l.fee_cents),
      paid_cents: String(l.paid_cents),
      net_cash_cents: String(l.net_cash_cents),
      reversed: !!l.reversed,
      category_id: l.category_id ?? null,
      category_name: l.category_name ?? null,
    })),
  };
}

/** UPDATE de bordero fora da reclassificação: bordero_immutable só deixa a exclusão lógica. */
export function deleteBordero(ctx: RpcContext, id: string, user: string, note: string | null) {
  const old = one(ctx.db, 'SELECT version, deleted_at FROM "erp_finance__bordero" WHERE id=?', id)!;
  if (old.deleted_at !== null) raise("55000", "erp_finance_bordero_immutable");
  writeRow(ctx, "erp_finance__bordero", "id", id, {
    deleted_at: ctx.clock.next().toString(),
    deleted_by: user,
    deleted_note: note,
    version: Number(old.version) + 1,
  });
}
