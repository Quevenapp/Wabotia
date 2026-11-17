// Conferência de estoque por leitura (Estoque › Conferência, 106): public.
// erp_stock_count_get, _read, _delete, _warehouse, _restart e _balance, com
// count_dto, count_open, count_physical, count_replay e count_hash.
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
import { createHash } from "node:crypto";
import { formatScaled, fromColumn, toParam, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp, saoPauloStamp, todaySaoPaulo } from "../../../engine/time.ts";
import { fold } from "../../catalog/public.ts";
import { ignoredWarehouse } from "../home.ts";
import {
  QTY, QTY_MAX, commandTaken, compositionOwnStock, insertBalanceCount, requireAccess, reservationWriteAccess, reservedQuantity, sha256,
} from "../internal.ts";
import { post } from "./erp_stock_post.ts";

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const t6 = (v: bigint) => formatScaled(v, QTY);
const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(v as number));
const MAX_VERSION = 2147483647;
type Session = Record<string, unknown>;

/** erp_stock.count_hash(p_profile, p_actor, p_data) */
const countHash = (profile: string, actor: string, data: unknown) => sha256(jsonbText({ profile, actor, data }));

/** erp_stock.count_physical(p_product, p_warehouse): saldo no depósito, ou nos não ignorados. */
function countPhysical(db: SqlDriver, product: string, warehouse: string | null): bigint {
  let total = 0n;
  for (const b of db.exec('SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', product).rows)
    if (b.warehouse_id === warehouse || (warehouse === null && !ignoredWarehouse(db, String(b.warehouse_id)))) total += fromColumn(b.q);
  return total;
}

/** erp_stock.count_dto(p_session) */
function countDto(db: SqlDriver, id: string) {
  const s = one(db, 'SELECT * FROM "erp_stock__count_session" WHERE id=?', id);
  if (!s) return null;
  const live = db.exec('SELECT product_id, CAST(quantity AS TEXT) q, created_at FROM "erp_stock__count_reading" WHERE session_id=? AND deleted_at IS NULL', id).rows;
  const items = new Map<string, { counted: bigint; last: number }>();
  let total = 0n;
  for (const r of live) {
    const q = fromColumn(r.q);
    total += q;
    const it = items.get(String(r.product_id)) ?? { counted: 0n, last: -Infinity };
    it.counted += q;
    it.last = Math.max(it.last, Number(r.created_at));
    items.set(String(r.product_id), it);
  }
  const shown = [...items.entries()]
    .sort((x, y) => y[1].last - x[1].last || pgCompareText(x[0], y[0]))
    .slice(0, 1500)
    .map(([product, it]) => {
      const r = one(
        db,
        'SELECT r.code, r.name, p.location, p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?',
        product,
      );
      if (!r) return null;
      const physical = countPhysical(db, product, (s.warehouse_id as string | null) ?? null);
      return {
        product_id: product,
        code: r.code ?? null,
        name: r.name,
        location: r.location ?? null,
        unit: r.unit ?? null,
        counted: t6(it.counted),
        physical: t6(physical),
        difference: t6(it.counted - physical),
        image_url: one(db, 'SELECT url FROM "erp_catalog__product_image" WHERE record_id=? ORDER BY position LIMIT 1', product)?.url ?? null,
      };
    })
    .filter((x) => x !== null);
  const log = db
    .exec(
      `SELECT x.id, x.code, CAST(x.quantity AS TEXT) q, x.product_id, r.name, x.created_at, x.deleted_at
         FROM (SELECT * FROM "erp_stock__count_reading" WHERE session_id=?) x JOIN "erp_catalog__record" r ON r.id=x.product_id`,
      id,
    )
    .rows.sort((a, b) => Number(b.created_at) - Number(a.created_at) || pgCompareText(String(a.id), String(b.id)))
    .slice(0, 200)
    .map((x) => ({
      id: x.id,
      code: x.code,
      quantity: t6(fromColumn(x.q)),
      product_id: x.product_id,
      product_name: x.name,
      recorded_at_local: saoPauloStamp(x.created_at as number),
      deleted: x.deleted_at !== null && x.deleted_at !== undefined,
    }));
  return {
    session: {
      id: s.id,
      state: s.state,
      version: s.version,
      warehouse_id: s.warehouse_id ?? null,
      warehouse_name: s.warehouse_id ? (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', s.warehouse_id)?.name ?? null) : null,
      created_at: ts(s.created_at),
      balance_scope: s.balance_scope ?? null,
      closed_at: ts(s.closed_at),
    },
    total_read: t6(total),
    readings: live.length,
    items_total: items.size,
    items: shown,
    log,
  };
}

/** erp_stock.count_replay: o resultado gravado do comando, ou null. */
function countReplay(db: SqlDriver, actor: string, command: string, action: string, hash: string) {
  requireAccess(db, actor, true);
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_stock__count_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== actor || c.action !== action || c.request_hash !== hash) raise("40001", "erp_stock_count_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command) || one(db, 'SELECT 1 x FROM "erp_stock__count_reading" WHERE command_id=? OR delete_command_id=?', command, command))
    raise("40001", "erp_stock_count_conflict");
  return null;
}

/** INSERT de uma conferência nova (id, created_at e updated_at do DEFAULT). */
function newSession(ctx: RpcContext, actor: string, warehouse: string | null): Session {
  const id = crypto.randomUUID();
  const at = ctx.clock.next().toString();
  ctx.db.exec('INSERT INTO "erp_stock__count_session"(id, actor, warehouse_id, created_at, updated_at) VALUES(?,?,?,?,?)', id, actor, warehouse, at, at);
  return one(ctx.db, 'SELECT * FROM "erp_stock__count_session" WHERE id=?', id)!;
}

/** erp_stock.count_open(p_actor, p_session, p_create, p_warehouse): a conferência aberta da pessoa. */
function countOpen(ctx: RpcContext, actor: string, session: string | null, create: boolean, warehouse: string | null = null): Session {
  const db = ctx.db;
  const s = one(db, `SELECT * FROM "erp_stock__count_session" WHERE actor=? AND state='open'`, actor);
  if (s) {
    if (s.state !== "open" || (session !== null && s.id !== session)) raise("40001", "erp_stock_count_session_changed");
    return s;
  }
  if (session !== null) raise("40001", "erp_stock_count_session_changed");
  if (!create) raise("P0002", "erp_stock_count_not_found");
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.id=? AND r.active=1', warehouse))
    raise("22023", "erp_stock_warehouse_unavailable");
  return newSession(ctx, actor, warehouse);
}

/** md5(texto)::uuid */
function md5Uuid(text: string): string {
  const h = createHash("md5").update(text, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const base = (outcome: string) => ({ scope: "stock_count", data_mode: "erp_native", outcome });

registerRpc("erp_stock_count_get", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  requireAccess(db, user, true);
  const s = one(db, `SELECT id FROM "erp_stock__count_session" WHERE actor=? AND state='open'`, user);
  return { scope: "stock_count", data_mode: "erp_native", count: s ? countDto(db, String(s.id)) : null };
});

registerRpc("erp_stock_count_read", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    session = str(a.p_session_id),
    code = str(a.p_code),
    quantity = str(a.p_quantity),
    warehouse = str(a.p_warehouse_id);
  requireAccess(db, user, true);
  if (command === null || code === null || pgLength(pgBtrim(code)) < 1 || pgLength(pgBtrim(code)) > 100 || pgHasCntrl.test(code) || quantity === null || pgLength(quantity) > 40)
    raise("22023", "erp_stock_count_invalid");
  const hash = countHash("stock-count-read-106", user, { session_id: session, code, quantity, warehouse_id: warehouse });
  const replayed = countReplay(db, user, command, "read", hash);
  if (replayed) return replayed;
  const trimmed = pgBtrim(code);
  let rejected: string | null = null;
  let product: Session | undefined;
  let qty = 0n;
  if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(quantity) || toScaled(quantity, QTY) === 0n) rejected = "invalid_quantity";
  else {
    qty = toScaled(quantity, QTY);
    // gtin, gtin tributável ou lower(código): o __fold do código filtra; a igualdade do lower confere em TS.
    const matches = db
      .exec(
        'SELECT p.record_id, p.kind, p.format, r.active, r.name, r.code, p.gtin, p.gtin_tax FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE p.gtin=? OR p.gtin_tax=? OR r.code__fold=?',
        trimmed,
        trimmed,
        fold(trimmed),
      )
      .rows.filter((r) => r.gtin === trimmed || r.gtin_tax === trimmed || (r.code !== null && pgLower(String(r.code)) === pgLower(trimmed)));
    if (matches.length === 0) rejected = "not_found";
    else if (matches.length > 1) rejected = "ambiguous";
    else {
      product = matches[0];
      rejected =
        product.kind !== "P" ? "invalid_kind"
        : product.format !== "S" && !(product.format === "E" && compositionOwnStock(db, String(product.record_id))) ? "invalid_format"
        : !product.active ? "inactive"
        : null;
    }
  }
  if (rejected !== null) {
    const open = one(db, `SELECT id FROM "erp_stock__count_session" WHERE actor=? AND state='open'`, user);
    return { ...base("rejected"), reason: rejected, code: trimmed, replayed: false, count: open ? countDto(db, String(open.id)) : null };
  }
  const s = countOpen(ctx, user, session, true, warehouse);
  const n = Number(one(db, 'SELECT count(*) n FROM "erp_stock__count_reading" WHERE session_id=? AND deleted_at IS NULL', s.id)!.n);
  const sum = fromColumn(
    one(db, 'SELECT CAST(coalesce(sum(quantity),0) AS TEXT) q FROM "erp_stock__count_reading" WHERE session_id=? AND product_id=? AND deleted_at IS NULL', s.id, product!.record_id)!.q,
  );
  if (n >= 20000 || sum + qty > QTY_MAX) raise("22023", "erp_stock_count_limit");
  db.exec(
    'INSERT INTO "erp_stock__count_reading"(id, session_id, product_id, quantity, code, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?)',
    crypto.randomUUID(), s.id, product!.record_id, toParam(qty), trimmed, user, command, ctx.clock.next().toString(),
  );
  const result = {
    ...base("read"),
    reason: null,
    code: trimmed,
    reading: { product_id: product!.record_id, product_name: product!.name, quantity: t6(qty) },
    session_id: s.id,
  };
  db.exec(
    'INSERT INTO "erp_stock__count_command"(id, actor, action, session_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "read", s.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  reservationWriteAccess(db, user);
  return { ...result, count: countDto(db, String(s.id)), replayed: false };
});

registerRpc("erp_stock_count_delete", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    session = str(a.p_session_id),
    product = str(a.p_product_id);
  requireAccess(db, user, true);
  if (command === null || session === null || product === null) raise("22023", "erp_stock_count_invalid");
  const hash = countHash("stock-count-delete-106", user, { session_id: session, product_id: product });
  const replayed = countReplay(db, user, command, "delete", hash);
  if (replayed) return replayed;
  const s = countOpen(ctx, user, session, false);
  const n = Number(
    one(db, 'SELECT count(*) n FROM "erp_stock__count_reading" WHERE session_id=? AND product_id=? AND deleted_at IS NULL', s.id, product.toLowerCase())!.n,
  );
  db.exec(
    'UPDATE "erp_stock__count_reading" SET deleted_at=?, deleted_by=?, delete_command_id=? WHERE session_id=? AND product_id=? AND deleted_at IS NULL',
    ctx.clock.next().toString(), user, command, s.id, product.toLowerCase(),
  );
  if (n === 0) raise("P0002", "erp_stock_count_reading_not_found");
  const result = { ...base("deleted"), product_id: product, deleted_readings: n, session_id: s.id };
  db.exec(
    'INSERT INTO "erp_stock__count_command"(id, actor, action, session_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "delete", s.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  reservationWriteAccess(db, user);
  return { ...result, count: countDto(db, String(s.id)), replayed: false };
});

registerRpc("erp_stock_count_restart", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    session = str(a.p_session_id),
    version = int(a.p_expected_version);
  requireAccess(db, user, true);
  if (command === null || session === null || version === null) raise("22023", "erp_stock_count_invalid");
  const hash = countHash("stock-count-restart-106", user, { session_id: session, expected_version: version });
  const replayed = countReplay(db, user, command, "restart", hash);
  if (replayed) return replayed;
  const s = countOpen(ctx, user, session, false);
  if (s.version !== version || s.version === MAX_VERSION) raise("40001", "erp_stock_count_version_conflict");
  const at = ctx.clock.next().toString();
  // O comando existe antes de a conferência apontar para ele como o de fechamento.
  const result = {
    ...base("restarted"),
    session_id: s.id,
    discarded_readings: Number(one(db, 'SELECT count(*) n FROM "erp_stock__count_reading" WHERE session_id=? AND deleted_at IS NULL', s.id)!.n),
  };
  db.exec(
    'INSERT INTO "erp_stock__count_command"(id, actor, action, session_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "restart", s.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  db.exec(`UPDATE "erp_stock__count_session" SET state='restarted', version=version+1, updated_at=?, closed_at=?, close_command_id=? WHERE id=?`, at, at, command, s.id);
  const keep = s.warehouse_id && one(db, 'SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND active=1', s.warehouse_id) ? String(s.warehouse_id) : null;
  const fresh = newSession(ctx, user, keep);
  reservationWriteAccess(db, user);
  return { ...result, count: countDto(db, String(fresh.id)), replayed: false };
});

registerRpc("erp_stock_count_warehouse", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    session = str(a.p_session_id),
    version = int(a.p_expected_version),
    warehouse = str(a.p_warehouse_id);
  requireAccess(db, user, true);
  if (command === null || session === null || version === null) raise("22023", "erp_stock_count_invalid");
  const hash = countHash("stock-count-warehouse-106", user, { session_id: session, expected_version: version, warehouse_id: warehouse });
  const replayed = countReplay(db, user, command, "warehouse", hash);
  if (replayed) return replayed;
  const s = countOpen(ctx, user, session, false);
  if (s.version !== version || s.version === MAX_VERSION) raise("40001", "erp_stock_count_version_conflict");
  const target = warehouse?.toLowerCase() ?? null;
  if ((s.warehouse_id ?? null) === target) raise("22023", "erp_stock_count_unchanged");
  if (target !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.id=? AND r.active=1', target))
    raise("22023", "erp_stock_warehouse_unavailable");
  db.exec('UPDATE "erp_stock__count_session" SET warehouse_id=?, version=version+1, updated_at=? WHERE id=?', target, ctx.clock.next().toString(), s.id);
  const result = {
    ...base("warehouse"),
    session_id: s.id,
    from: { warehouse_id: s.warehouse_id ?? null, version: s.version },
    to: { warehouse_id: warehouse, version: Number(s.version) + 1 },
  };
  db.exec(
    'INSERT INTO "erp_stock__count_command"(id, actor, action, session_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "warehouse", s.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  reservationWriteAccess(db, user);
  return { ...result, count: countDto(db, String(s.id)), replayed: false };
});

registerRpc("erp_stock_count_balance", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    session = str(a.p_session_id),
    version = int(a.p_expected_version),
    scope = str(a.p_scope),
    confirmed = a.p_confirmed === undefined ? null : (a.p_confirmed as boolean | null);
  requireAccess(db, user, true);
  if (command === null || session === null || version === null || scope === null || !["counted", "all_active"].includes(scope) || (scope === "all_active" && confirmed !== true))
    raise("22023", "erp_stock_count_invalid");
  const hash = countHash("stock-count-balance-106", user, { session_id: session, expected_version: version, scope, confirmed });
  const replayed = countReplay(db, user, command, "balance", hash);
  if (replayed) return replayed;
  const s = countOpen(ctx, user, session, false);
  if (s.version !== version || s.version === MAX_VERSION) raise("40001", "erp_stock_count_version_conflict");
  if (!s.warehouse_id) raise("22023", "erp_stock_count_single_warehouse");
  const warehouse = String(s.warehouse_id);
  if (!one(db, 'SELECT 1 x FROM "erp_stock__count_reading" WHERE session_id=? AND deleted_at IS NULL', s.id)) raise("22023", "erp_stock_count_no_reading");
  requireAccess(db, user, true);
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND active=1', warehouse)) raise("22023", "erp_stock_warehouse_unavailable");
  const day = todaySaoPaulo();
  const counted = new Map<string, bigint>();
  for (const r of db.exec('SELECT product_id, CAST(quantity AS TEXT) q FROM "erp_stock__count_reading" WHERE session_id=? AND deleted_at IS NULL', s.id).rows)
    counted.set(String(r.product_id), (counted.get(String(r.product_id)) ?? 0n) + fromColumn(r.q));
  if (scope === "all_active")
    for (const p of db.exec(`SELECT p.record_id FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE r.active=1 AND p.kind='P'`).rows)
      if (!counted.has(String(p.record_id))) counted.set(String(p.record_id), 0n);
  const changed: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  let unchanged = 0;
  for (const product of [...counted.keys()].sort(pgCompareText)) {
    const row = one(db, 'SELECT r.name, r.active, p.kind, p.format, p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?', product);
    if (!row) continue;
    const qty = counted.get(product)!;
    const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse);
    const current = b ? fromColumn(b.q) : 0n;
    const currentVersion = b ? Number(b.version) : 0;
    if (qty === current) {
      unchanged++;
      continue;
    }
    // 226: composição Físico com estrutura tem estoque próprio e é balanceada; Virtual, sem estrutura e variações ficam de fora.
    if (!row.active || row.kind !== "P" || row.unit === null || row.format === "V" || (row.format === "E" && !compositionOwnStock(db, product))) {
      skipped.push({ product_id: product, name: row.name, reason: row.format === "E" || row.format === "V" ? "composition" : "unavailable" });
      continue;
    }
    const diff = qty - current;
    if ((diff < 0n ? -diff : diff) > QTY_MAX) {
      skipped.push({ product_id: product, name: row.name, reason: "limit" });
      continue;
    }
    if (reservedQuantity(db, product, warehouse) > qty) {
      skipped.push({ product_id: product, name: row.name, reason: "reserved" });
      continue;
    }
    const derived = md5Uuid(`${command}:count:${product}:${warehouse}`);
    if (commandTaken(db, derived)) raise("40001", "erp_stock_count_conflict");
    const posted = post(ctx, {
      user, command: derived, kind: "adjustment", occurredOn: day, reason: "Balanço (conferência de estoque)", reference: null,
      items: [{ product_id: product, warehouse_id: warehouse, quantity: t6(diff), expected_version: currentVersion }],
    }) as { movement: { id: string } };
    insertBalanceCount(ctx, posted.movement.id, product, warehouse, qty, current, "count");
    changed.push({ product_id: product, name: row.name, movement_id: posted.movement.id, counted: t6(qty), previous: t6(current) });
  }
  const at = ctx.clock.next().toString();
  const result = { ...base("balanced"), session_id: s.id, warehouse_id: warehouse, balance_scope: scope, occurred_on: day, changed, unchanged, skipped };
  db.exec(
    'INSERT INTO "erp_stock__count_command"(id, actor, action, session_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "balance", s.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  db.exec(`UPDATE "erp_stock__count_session" SET state='closed', version=version+1, updated_at=?, closed_at=?, close_command_id=?, balance_scope=? WHERE id=?`, at, at, command, scope, s.id);
  reservationWriteAccess(db, user);
  return { ...result, replayed: false };
});
