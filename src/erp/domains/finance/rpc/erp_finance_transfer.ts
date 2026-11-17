// Transferência interna por comando (migração 053; fora do mapa de fechos,
// docs/ERP-FASE0.md: RPC montado por concatenação): public.erp_finance_transfer_post,
// _command, _get e _list, com erp_finance.transfer_flags e transfer_view.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgHasSpace } from "../../../engine/text.ts";
import {
  bool,
  charLength,
  cents,
  CNTRL,
  day,
  expected,
  field,
  hasKey,
  insertAudit,
  insertMovement,
  jsonArg,
  keys,
  requestHash,
  requireAccess,
  reserveCommand,
  insertCommand,
  ts,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
} from "../internal.ts";
import { insertTransfer, transferAccount } from "../cash.ts";

/** erp_finance.transfer_flags */
const flags = () => ({
  scope: "finance_internal_transfer",
  data_mode: "erp_native",
  bank_operation_performed: false,
  title_mutation_performed: false,
  opening_mutation_performed: false,
});

/** erp_finance.transfer_view (null se não existe) */
function transferView(db: SqlDriver, id: string) {
  const t = one(db, 'SELECT * FROM "erp_finance__transfer" WHERE id=?', id);
  if (!t) return null;
  const moves = db
    .exec('SELECT id, account_id, kind, delta_cents FROM "erp_finance__movement" WHERE transfer_id=?', id)
    .rows.sort((x, y) => (x.kind === "transfer_out" ? 0 : 1) - (y.kind === "transfer_out" ? 0 : 1))
    .map((m) => ({ id: m.id, account_id: m.account_id, kind: m.kind, delta_cents: String(m.delta_cents) }));
  return {
    receipt: {
      id: t.id,
      command_id: t.command_id,
      from_account: JSON.parse(String(t.from_snapshot)),
      to_account: JSON.parse(String(t.to_snapshot)),
      amount_cents: String(t.amount_cents),
      posted_on: t.posted_on,
      note: t.note,
      created_at: ts(t.created_at),
      movements: moves.length ? moves : null,
    },
    current: { from_account: transferAccount(db, String(t.from_account_id)), to_account: transferAccount(db, String(t.to_account_id)) },
  };
}

/** Os espaços que o Fagoo não aceita como nota: [[:space:]] e os brancos Unicode da lista do 053. */
const EXTRA_BLANKS = new Set([0xa0, 0x1680, ...Array.from({ length: 12 }, (_, k) => 0x2000 + k), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const blank = (s: string) => [...s].every((c) => pgHasSpace.test(c) || EXTRA_BLANKS.has(c.codePointAt(0)!));

function post(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireAccess(db, user, true);
  keys(data, ["from_account_id", "to_account_id", "expected_from_version", "expected_to_version", "amount_cents", "posted_on", "note", "confirmed"]);
  if (command === null || Object.keys(data as object).length !== 8 || field(data, "confirmed") !== true) raise("22023", "erp_finance_transfer_invalid");
  const src = uuidValue(field(data, "from_account_id"))!;
  const dst = uuidValue(field(data, "to_account_id"))!;
  const srcVersion = expected(field(data, "expected_from_version"));
  const dstVersion = expected(field(data, "expected_to_version"));
  const amountText = field(data, "amount_cents");
  if (src === dst || jsonType(amountText) !== "string" || !/^[1-9][0-9]{0,14}$/.test(amountText as string)) raise("22023", "erp_finance_transfer_invalid");
  const amount = cents(amountText, false);
  day(field(data, "posted_on"), true);
  const note = txt(data, "note", 500, true)!;
  const raw = hasKey(data, "note") ? field(data, "note") : null;
  const rawText = raw === null || raw === undefined ? null : typeof raw === "string" ? raw : jsonbText(raw);
  if (note !== rawText || charLength(note) < 3 || CNTRL.test(note) || blank(note)) raise("22023", "erp_finance_transfer_note_invalid");
  const hash = requestHash(user, "internal_transfer", data);
  requireAccess(db, user, true);
  const cmd = one(db, 'SELECT actor, request_hash, result FROM "erp_finance__command" WHERE id=?', command);
  if (cmd) {
    const result = JSON.parse(String(cmd.result));
    if (cmd.actor !== user || cmd.request_hash !== hash || result?.action !== "internal_transfer") raise("40001", "erp_finance_command_conflict");
    const tid = one(db, 'SELECT id FROM "erp_finance__transfer" WHERE command_id=?', command)?.id;
    if (tid === undefined) raise("55000", "erp_finance_transfer_missing");
    return { ...flags(), ...transferView(db, String(tid)), replayed: true };
  }
  requireAccess(db, user, true);
  const ra = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', src);
  const rb = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', dst);
  if (!ra || !rb) raise("P0002", "erp_finance_not_found");
  if (!bool(ra.active) || !bool(rb.active) || ra.version !== srcVersion || rb.version !== dstVersion || ra.version === 2147483647 || rb.version === 2147483647)
    raise("40001", "erp_finance_transfer_account_conflict");
  const posted = day(field(data, "posted_on"), true);
  if (one(db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id IN (?, ?) AND kind='opening' AND posted_on>? LIMIT 1`, src, dst, posted))
    raise("22023", "erp_finance_transfer_before_opening");
  const ca = transferAccount(db, src)!;
  const cb = transferAccount(db, dst)!;
  const snapshot = (acc: Record<string, unknown>, snap: Record<string, unknown>, delta: number) => ({
    id: acc.id, name: acc.name, kind: acc.kind, version_before: acc.version, version_after: Number(acc.version) + 1,
    balance_before_cents: snap.balance_cents, balance_after_cents: String(Number(snap.balance_cents) + delta), opening_on: snap.opening_on,
  });
  // transfer.command_id → command é FK adiada no Postgres: o recibo é reservado antes.
  reserveCommand(ctx, command, user, hash);
  const tid = insertTransfer(ctx, {
    command_id: command, actor: user, from_account_id: src, to_account_id: dst, amount_cents: amount, posted_on: posted, note,
    from_snapshot: snapshot(ra, ca, -amount), to_snapshot: snapshot(rb, cb, amount),
  });
  insertMovement(ctx, { account_id: src, kind: "transfer_out", delta_cents: -amount, posted_on: posted, note, actor: user, command_id: command, transfer_id: tid });
  insertMovement(ctx, { account_id: dst, kind: "transfer_in", delta_cents: amount, posted_on: posted, note, actor: user, command_id: command, transfer_id: tid });
  for (const acc of [src, dst]) updateAccount(ctx, acc, {});
  const result = { ...flags(), ...transferView(db, tid), replayed: false };
  insertCommand(ctx, command, user, hash, { ...result, action: "internal_transfer" });
  insertAudit(ctx, user, command, "internal_transfer", { from_account: ca, to_account: cb }, result);
  return result;
}

function byCommand(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const tid = one(ctx.db, 'SELECT id FROM "erp_finance__transfer" WHERE command_id=? AND actor=?', uuidArg(a.p_command_id), user)?.id;
  if (tid === undefined) raise("P0002", "erp_finance_not_found");
  return { ...flags(), ...transferView(ctx.db, String(tid)), read_only: true };
}

function get(ctx: RpcContext, a: RpcArgs) {
  requireAccess(ctx.db, uuidArg(a.p_user_id)!, false);
  const id = uuidArg(a.p_id);
  const v = id === null ? null : transferView(ctx.db, id);
  if (v === null) raise("P0002", "erp_finance_not_found");
  return { ...flags(), ...v, read_only: true };
}

function list(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireAccess(db, uuidArg(a.p_user_id)!, false);
  const limit = (a.p_limit as number | null) ?? null;
  const account = uuidArg(a.p_account_id);
  const after = uuidArg(a.p_after);
  if (limit === null || limit < 1 || limit > 25) raise("22023", "erp_finance_invalid_query");
  if (account !== null && !one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=?', account)) raise("P0002", "erp_finance_not_found");
  const page = db
    .exec('SELECT id FROM "erp_finance__transfer" WHERE (? IS NULL OR from_account_id=? OR to_account_id=?) AND (? IS NULL OR id>?) ORDER BY id LIMIT ?', account, account, account, after, after, limit + 1)
    .rows.map((r) => transferView(db, String(r.id))!);
  const more = page.length > limit;
  const items = more ? page.slice(0, limit) : page;
  return {
    ...flags(), read_only: true, items, limit, has_more: more,
    next_cursor: more ? (items[limit - 1].receipt.id as string) : null,
  };
}

registerRpc("erp_finance_transfer_post", post);
registerRpc("erp_finance_transfer_command", byCommand);
registerRpc("erp_finance_transfer_get", get);
registerRpc("erp_finance_transfer_list", list);
