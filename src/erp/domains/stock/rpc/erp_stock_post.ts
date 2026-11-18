// public.erp_stock_post → erp_stock.post → erp_stock.post_physical_025.
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
// O público recusa 'reversal' (erp_stock_use_reversal_command); o estorno
// (p_reverses_id) vem do estorno de documento (rpc/document-stock.ts).
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { replay } from "../../../engine/receipt.ts";
import { todaySaoPaulo, validDate } from "../../../engine/time.ts";
import * as sync from "../../sync/public.ts";
import {
  QTY,
  QTY_MAX,
  balanceKept,
  compositionOwnStock,
  derivedCommand,
  reservationWriteAccess,
  ensureBalance,
  insertEntry,
  movementDto,
  negativeAllowed,
  requireAccess,
  sha256,
  updateBalance,
} from "../internal.ts";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
const KINDS = ["receipt", "issue", "adjustment", "transfer", "reversal"];
const LINE_KEYS = new Set(["product_id", "warehouse_id", "quantity", "expected_version"]);
const btrim = (s: string) => s.replace(/^ +| +$/g, "");
const lower = (u: string) => u.toLowerCase();

export function erpStockPost(ctx: RpcContext, a: RpcArgs) {
  // Tipos e DEFAULTs dos argumentos já vêm do callRpc (engine/args.ts).
  const user = a.p_user_id as string;
  const command = (a.p_command_id as string | null) ?? null;
  const kind = (a.p_kind as string | null) ?? null;
  if (kind === "reversal") raise("22023", "erp_stock_use_reversal_command");
  return post(ctx, {
    user,
    command,
    kind,
    occurredOn: (a.p_occurred_on as string | null) ?? null,
    reason: (a.p_reason as string | null) ?? null,
    reference: (a.p_reference as string | null) ?? null,
    items: typeof a.p_items === "string" ? JSON.parse(a.p_items) : a.p_items,
  });
}

export interface PostInput {
  user: string;
  command: string | null;
  kind: string | null;
  occurredOn: string | null;
  reason: string | null;
  reference: string | null;
  items: unknown;
  /** p_reverses_id: o movimento estornado (só com kind 'reversal'). */
  reversesId?: string | null;
}

const COMPENSATION_REASON = "Estorno anterior ao balanço: saldo atual mantido";
export { postPhysical as postPhysical025 };
const COMPENSATION_SETTING = "erp_stock.reversal_compensation";
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && jsonbText(a) === jsonbText(b);
/** (texto)::uuid */
function uuidCast(v: unknown): string {
  const s = v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
  if (s === null) return "";
  if (!UUID.test(s)) raise("22P02", `invalid input syntax for type uuid: "${s}"`);
  return s.toLowerCase();
}

/**
 * erp_stock.post: o lançamento físico. No estorno de um lançamento de
 * documento, recebimento ou nota (224), as posições que mantêm o saldo
 * (balance_kept) ganham um ajuste de compensação antes (saída) ou depois
 * (entrada) do estorno.
 */
export function post(ctx: RpcContext, p: PostInput) {
  const db = ctx.db;
  const reverses = p.reversesId ?? null;
  requireAccess(db, p.user, true);
  requireAccess(db, p.user, true);
  if (
    p.command &&
    !one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', p.command) &&
    one(db, 'SELECT 1 x FROM "erp_stock__reservation_command" WHERE id=?', p.command)
  )
    raise("40001", "erp_stock_command_conflict");
  if (
    p.kind === "reversal" &&
    reverses !== null &&
    p.command !== null &&
    jsonType(p.items) === "array" &&
    !one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', p.command) &&
    (one(db, 'SELECT 1 x FROM "erp_stock__document_posting" WHERE movement_id=?', reverses) ||
      one(db, 'SELECT 1 x FROM "erp_purchase_receipts__receipt" WHERE movement_id=?', reverses) ||
      one(db, 'SELECT 1 x FROM "erp_stock__invoice_posting" WHERE movement_id=?', reverses))
  ) {
    const items = p.items as unknown[];
    const objects = items.filter((i) => jsonType(i) === "object") as Record<string, unknown>[];
    const kept = (i: Record<string, unknown>) => balanceKept(db, reverses, uuidCast(i.product_id), uuidCast(i.warehouse_id));
    const quantity = (i: Record<string, unknown>) => arrow(i, "quantity");
    const before = objects
      .filter((i) => quantity(i) !== null && quantity(i)!.startsWith("-") && kept(i))
      .map((i) => ({ product_id: i.product_id, warehouse_id: i.warehouse_id, quantity: quantity(i)!.replace(/^-+/, ""), expected_version: i.expected_version }));
    const after = objects
      .filter((i) => quantity(i) !== null && !quantity(i)!.startsWith("-") && kept(i))
      .map((i) => ({
        product_id: i.product_id,
        warehouse_id: i.warehouse_id,
        quantity: "-" + quantity(i),
        expected_version: Number(BigInt(arrow(i, "expected_version") ?? "") + 1n),
      }));
    if (before.length || after.length) {
      const pre = derivedCommand(p.command, "before"),
        postId = derivedCommand(p.command, "after");
      let items2: unknown = p.items;
      if (before.length) {
        items2 = items.map((i) => {
          const o = i as Record<string, unknown>;
          return jsonType(i) === "object" && before.some((b) => same(b.product_id, o.product_id) && same(b.warehouse_id, o.warehouse_id))
            ? { ...o, expected_version: Number(BigInt(arrow(o, "expected_version") ?? "") + 1n) }
            : i;
        });
        ctx.settings.set(COMPENSATION_SETTING, pre);
        postPhysical(ctx, { ...p, command: pre, kind: "adjustment", reason: COMPENSATION_REASON, reference: null, items: before, reversesId: null });
        ctx.settings.set(COMPENSATION_SETTING, "");
      }
      const result = postPhysical(ctx, { ...p, items: items2 });
      if (after.length) {
        ctx.settings.set(COMPENSATION_SETTING, postId);
        postPhysical(ctx, { ...p, command: postId, kind: "adjustment", reason: COMPENSATION_REASON, reference: null, items: after, reversesId: null });
        ctx.settings.set(COMPENSATION_SETTING, "");
      }
      reservationWriteAccess(db, p.user);
      const adjustments = db
        .exec('SELECT result FROM "erp_stock__command" WHERE id IN (?,?) ORDER BY created_at, id', pre, postId)
        .rows.map((r) => JSON.parse(String(r.result)).movement);
      return { ...result, balance_adjustments: adjustments };
    }
  }
  const result = postPhysical(ctx, p);
  reservationWriteAccess(db, p.user);
  return result;
}

/** erp_stock.post_physical_025 */
function postPhysical(ctx: RpcContext, p: PostInput) {
  const db = ctx.db;
  const reverses = p.reversesId ?? null;
  requireAccess(db, p.user, true);
  // 182: o estorno, e o ajuste de compensação marcado para este comando, não
  // recusam produto ou depósito inativo nem produto que virou composição.
  const free =
    p.kind === "reversal" ||
    (p.kind === "adjustment" &&
      btrim(p.reason ?? "") === COMPENSATION_REASON &&
      p.command !== null &&
      (ctx.settings.get(COMPENSATION_SETTING) ?? "") === p.command);
  const items = p.items;
  const today = todaySaoPaulo();
  if (
    p.command === null ||
    p.kind === null ||
    !KINDS.includes(p.kind) ||
    p.occurredOn === null ||
    !validDate(p.occurredOn) ||
    p.occurredOn < "1900-01-01" ||
    p.occurredOn > today ||
    p.reason === null ||
    [...btrim(p.reason)].length < 3 ||
    [...btrim(p.reason)].length > 500 ||
    CNTRL.test(p.reason) ||
    (p.reference !== null && ([...p.reference].length > 100 || CNTRL.test(p.reference))) ||
    items === null ||
    items === undefined ||
    jsonType(items) !== "array" ||
    (items as unknown[]).length < 1 ||
    (items as unknown[]).length > 100 ||
    new TextEncoder().encode(jsonbText(items)).length > 65536 ||
    (p.kind === "reversal") !== (reverses !== null)
  )
    raise("22023", "erp_stock_invalid_command");
  const lines = items as Record<string, unknown>[];
  for (const line of lines) {
    if (
      jsonType(line) !== "object" ||
      jsonType(line.product_id) !== "string" ||
      jsonType(line.warehouse_id) !== "string" ||
      !UUID.test(String(line.product_id ?? "")) ||
      !UUID.test(String(line.warehouse_id ?? "")) ||
      jsonType(line.quantity) !== "string" ||
      !/^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(String(line.quantity ?? "")) ||
      jsonType(line.expected_version) !== "number" ||
      !/^[0-9]{1,10}$/.test(jsonbText(line.expected_version)) ||
      Object.keys(line).some((k) => !LINE_KEYS.has(k))
    )
      raise("22023", "erp_stock_invalid_line");
    const q = toScaled(String(line.quantity), QTY);
    if (
      q === 0n ||
      (line.expected_version as number) > 2147483647 ||
      (p.kind === "receipt" && q < 0n) ||
      (p.kind === "issue" && q > 0n)
    )
      raise("22023", "erp_stock_invalid_quantity");
  }
  const positions = new Set(lines.map((l) => `${lower(String(l.product_id))}|${lower(String(l.warehouse_id))}`));
  if (positions.size !== lines.length) raise("22023", "erp_stock_duplicate_position");
  if (
    p.kind === "transfer" &&
    (lines.length !== 2 ||
      new Set(lines.map((l) => lower(String(l.product_id)))).size !== 1 ||
      lines.reduce((s, l) => s + toScaled(String(l.quantity), QTY), 0n) !== 0n)
  )
    raise("22023", "erp_stock_invalid_transfer");
  const hash = sha256(
    jsonbText({
      actor: p.user,
      kind: p.kind,
      occurred_on: p.occurredOn,
      reason: p.reason,
      reference: p.reference,
      items,
      reverses_id: reverses,
    }),
  );
  const replayed = replay(db, "erp_stock__command", p.command, p.user, hash, "erp_stock_command_conflict");
  if (replayed) return { ...replayed, replayed: true };
  if (p.kind === "reversal") {
    const origin = one(db, `SELECT occurred_on FROM "erp_stock__movement" WHERE id=? AND kind<>'reversal'`, reverses);
    if (!origin) raise("P0002", "erp_stock_movement_not_found");
    if (one(db, 'SELECT 1 x FROM "erp_stock__movement" WHERE reverses_id=?', reverses)) raise("40001", "erp_stock_already_reversed");
    if (p.occurredOn! < String(origin.occurred_on)) raise("22023", "erp_stock_reversal_date_invalid");
  }

  const movement = crypto.randomUUID();
  db.exec(
    'INSERT INTO "erp_stock__movement"(id, kind, occurred_on, reason, reference, actor, command_id, reverses_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    movement,
    p.kind,
    p.occurredOn,
    btrim(p.reason),
    p.reference === null || btrim(p.reference) === "" ? null : btrim(p.reference),
    p.user,
    p.command,
    reverses,
    ctx.clock.next().toString(),
  );
  const ordered = [...lines].sort((x, y) => {
    const a = lower(String(x.product_id)),
      b = lower(String(y.product_id));
    if (a !== b) return a < b ? -1 : 1;
    const c = lower(String(x.warehouse_id)),
      d = lower(String(y.warehouse_id));
    return c < d ? -1 : c > d ? 1 : 0;
  });
  // v_import: ajuste do ator do espelho com importação autorizada
  // (erp_sync.stock_import_allowed: falso fora da aplicação do espelho; na
  // aplicação, 0A000 até o espelho ser portado).
  const isImport = p.kind === "adjustment" && p.user === sync.actor(ctx) && sync.stockImportAllowed(ctx);
  let ordinal = 0;
  for (const line of ordered) {
    const product = lower(String(line.product_id));
    const warehouse = lower(String(line.warehouse_id));
    const quantity = toScaled(String(line.quantity), QTY);
    const version = line.expected_version as number;
    const prod = one(
      db,
      'SELECT p.unit, p.kind, p.format, r.active FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE p.record_id=?',
      product,
    );
    if (!prod || prod.unit === null || prod.kind !== "P" || (!prod.active && !free && !isImport))
      raise("22023", "erp_stock_product_unavailable");
    if (!free && !isImport && (prod.format === "V" || (prod.format === "E" && !compositionOwnStock(db, product))))
      raise("22023", "erp_stock_composition_unsupported");
    const wh = one(
      db,
      'SELECT r.active FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id WHERE w.record_id=?',
      warehouse,
    );
    if (!wh || (!wh.active && !free && !isImport)) raise("22023", "erp_stock_warehouse_unavailable");
    ensureBalance(ctx, product, warehouse, String(prod.unit));
    const balance = one(
      db,
      'SELECT CAST(quantity AS TEXT) quantity, unit, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?',
      product,
      warehouse,
    )!;
    const current = fromColumn(balance.quantity);
    const currentVersion = balance.version as number;
    if (currentVersion !== version || currentVersion === 2147483647)
      raise("40001", "erp_stock_version_conflict");
    if (balance.unit !== prod.unit) raise("40001", "erp_stock_unit_conflict");
    const after = current + quantity;
    if (after > QTY_MAX || after < -QTY_MAX || (quantity < 0n && after < 0n && !negativeAllowed(db) && !isImport))
      raise("22023", "erp_stock_insufficient_or_excess_quantity");
    updateBalance(ctx, product, warehouse, current, quantity);
    ordinal++;
    insertEntry(ctx, {
      movement,
      ordinal,
      product,
      warehouse,
      quantity,
      unit: String(prod.unit),
      balanceAfter: after,
      balanceVersion: currentVersion + 1,
    });
  }
  const result = { movement: movementDto(db, movement), replayed: false, data_mode: "erp_native" };
  db.exec(
    'INSERT INTO "erp_stock__command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    p.command,
    p.user,
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  return result;
}

registerRpc("erp_stock_post", erpStockPost);
export { formatScaled };
