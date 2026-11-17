// Contas devolvidas (devolução do PDV, de nota e de documento):
// erp_finance.titles_mark_returned e o gatilho commission_return_capture (AFTER INSERT em
// title_return), que lança o ajuste de devolução na operação de comissão do documento.
// Usado pela devolução do PDV (sessão L).
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { pgHasCntrl, pgLength } from "../../engine/text.ts";
import { saoPauloParts } from "../../engine/time.ts";
import { operationTitles } from "./commissions.ts";
import { insertAudit } from "./internal.ts";
import { dto, updateTitle } from "./titles.ts";

type Data = Record<string, unknown>;

/** round(n/d) do numeric (meio para longe do zero) */
const roundDiv = (n: bigint, d: bigint) => {
  if (d < 0n) (n = -n), (d = -d);
  return n >= 0n ? (2n * n + d) / (2n * d) : -((2n * -n + d) / (2n * d));
};

/** erp_finance.commission_return_capture (AFTER INSERT em title_return) */
function commissionReturnCapture(ctx: RpcContext, r: { title_id: string; source: Data; created_at: string }) {
  const db = ctx.db;
  const t = one(db, 'SELECT amount_cents FROM "erp_finance__title" WHERE id=?', r.title_id);
  const ops = db
    .exec(`SELECT * FROM "erp_finance__commission_operation" WHERE state IN ('active','cancelled') AND total_cents>0 ORDER BY created_at DESC`)
    .rows.filter((c) => operationTitles(db, String(c.document_id)).some((x) => x.title_id === r.title_id));
  const o = ops[0];
  if (!o) return;
  let net = BigInt(String(o.estimated_cents));
  for (const a of db.exec('SELECT amount_cents FROM "erp_finance__commission_adjustment" WHERE operation_id=?', o.id).rows) net += BigInt(String(a.amount_cents));
  const share = t === undefined || t.amount_cents === null ? null : roundDiv(BigInt(String(o.estimated_cents)) * BigInt(String(t.amount_cents)), BigInt(String(o.total_cents)));
  const cap = net > 0n ? net : 0n;
  const amount = share === null ? cap : share < cap ? share : cap; // least() ignora o nulo
  if (amount <= 0n) return;
  if (one(db, 'SELECT 1 x FROM "erp_finance__commission_adjustment" WHERE source_key=?', `return:${r.title_id}`)) return;
  const label = typeof r.source.label === "string" ? r.source.label : "Conta devolvida";
  db.exec(
    `INSERT INTO "erp_finance__commission_adjustment"(id, operation_id, kind, source_key, amount_cents, occurred_on, note, created_at) VALUES(?,?,'return',?,?,?,?,?)`,
    crypto.randomUUID(), o.id, `return:${r.title_id}`, Number(-amount), saoPauloParts(BigInt(r.created_at)).date, [...label].slice(0, 240).join(""), ctx.clock.next().toString(),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** erp_finance.titles_mark_returned(ator, comando, contas, origem): marca as contas devolvidas e cancela as abertas. */
export function titlesMarkReturned(ctx: RpcContext, actor: string | null, command: string | null, titles: (string | null)[] | null, source: unknown) {
  const db = ctx.db;
  const s = source as Data;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const kind = jsonType(source) === "object" ? text(s.kind) : null;
  const id = jsonType(source) === "object" ? s.id : undefined;
  const label = jsonType(source) === "object" ? s.label : undefined;
  if (
    actor === null || command === null || titles === null || !Array.isArray(titles) || titles.some((x) => Array.isArray(x)) || titles.length < 1 || titles.length > 120 ||
    titles.includes(null) || new Set(titles).size !== titles.length || source === null || source === undefined || jsonType(source) !== "object" ||
    Object.keys(s).some((k) => !["kind", "id", "label"].includes(k)) || kind === null || !["pos_return", "invoice_return", "document_return"].includes(kind) ||
    jsonType(id) !== "string" || pgLength(id as string) < 1 || pgLength(id as string) > 60 || pgHasCntrl.test(id as string) ||
    ("label" in s && (jsonType(label) !== "string" || pgLength(label as string) < 1 || pgLength(label as string) > 120 || pgHasCntrl.test(label as string)))
  )
    raise("22023", "erp_finance_title_return_invalid");
  if (!one(db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', actor)) raise("42501", "erp_finance_access_denied");
  const wanted = new Set((titles as string[]).map((x) => x.toLowerCase()));
  const marked: string[] = [],
    cancelled: string[] = [],
    replayed: string[] = [],
    before: Data[] = [];
  const rows = db
    .exec('SELECT * FROM "erp_finance__title"')
    .rows.filter((t) => wanted.has(String(t.id)))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  for (const t of rows) {
    const tid = String(t.id);
    const ret = one(db, 'SELECT command_id FROM "erp_finance__title_return" WHERE title_id=?', tid);
    if (ret) {
      if (ret.command_id !== command) raise("40001", "erp_finance_title_already_returned");
      replayed.push(tid);
      continue;
    }
    if (t.deleted_at !== null) raise("40001", "erp_finance_title_return_unavailable");
    if (Number(t.settled_cents) !== 0) raise("40001", "erp_finance_active_payments");
    if (one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_title" WHERE title_id=? LIMIT 1', tid)) raise("40001", "erp_finance_source_locked");
    const isCancelled = Number(t.cancelled) === 1;
    if (!isCancelled) {
      if (one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE title_id=? LIMIT 1', tid)) raise("40001", "erp_finance_billed_locked");
      // A conta de nota fiscal só é cancelada pelo Estornar contas da nota (247).
      if (one(db, 'SELECT 1 x FROM "erp_finance__invoice_title" WHERE title_id=? LIMIT 1', tid)) raise("40001", "erp_finance_source_locked");
    }
    before.push({ id: tid, version: Number(t.version), cancelled: isCancelled });
    if (!isCancelled) {
      updateTitle(ctx, tid, { cancelled: true, version: Number(t.version) + 1, updated_at: ctx.clock.next().toString() });
      cancelled.push(tid);
    }
    const created = ctx.clock.next().toString();
    db.exec('INSERT INTO "erp_finance__title_return"(title_id, source, actor, command_id, created_at) VALUES(?,?,?,?,?)', tid, JSON.stringify(source), actor, command, created);
    commissionReturnCapture(ctx, { title_id: tid, source: s, created_at: created });
    marked.push(tid);
  }
  if (marked.length + replayed.length !== titles.length) raise("P0002", "erp_finance_not_found");
  const result = {
    entity: "title_returns", source, returned: marked, cancelled, replayed,
    items: [...marked].sort().map((t) => dto(db, "titles", t)),
  };
  if (marked.length > 0) insertAudit(ctx, actor!, command!, "title_returned", { titles: before }, result);
  return result;
}
