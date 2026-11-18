// Espelho local: current_position, product_summary e projetor do staging.
// Não chama Origin: lê e projeta os registros já presentes no SQLite.
import {
  compareDec,
  decText,
  formatScaled,
  toScaled,
} from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { fromSqlite, raise } from "../../../engine/errors.ts";
import { arrow } from "../../../engine/json.ts";
import { registerRpc, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import {
  PG_CNTRL,
  pgBtrim,
  pgCompareText,
  pgHasCntrl,
  pgLeft,
  pgLength,
} from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { fold as catalogFold } from "../../catalog/public.ts";
import { requireAccess } from "../internal.ts";
const fold = (s: string) => catalogFold(s)!;
const parse = (v: unknown): any =>
  v === null || v === undefined ? null : JSON.parse(String(v));
const text = (v: string | null, n: number) =>
  v === null
    ? null
    : pgLeft(pgBtrim(v.replace(new RegExp(PG_CNTRL, "g"), " ")), n) || null;
const trim = (v: string) =>
  v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
const finiteStamp = (v: unknown) =>
  v !== null &&
  v !== undefined &&
  !["9223372036854775807", "-9223372036854775808"].includes(String(v));
// numeric subtraction retains the greatest operand scale.
const difference = (x: unknown, y: unknown) => {
  if (x === null || y === null) return null;
  const scale = Math.max(
    (String(x).split(".")[1] ?? "").length,
    (String(y).split(".")[1] ?? "").length,
  );
  return formatScaled(
    toScaled(String(x), scale) - toScaled(String(y), scale),
    scale,
  );
};

function positions(db: SqlDriver) {
  return db
    .exec(
      `SELECT p.id,p.product_source_id,o.warehouse_source_id,co.record_id product_id,wb.warehouse_id,cr.name product_name,cr.code product_code,cr.active,cp.unit,cp.kind,cp.format,wr.name warehouse_name,pr.payload product_payload,sr.payload stock_payload,sr.version raw_version,sr.version_hash raw_hash,CAST(sr.last_seen_at AS TEXT) last_seen_at,ws.payload warehouse_payload,o.physical,o.virtual,o.physical_state,o.virtual_state,o.source_version,o.source_hash,o.observed_at,o.source_deleted,o.issues FROM erp_stock_mirror__position p JOIN erp_stock_mirror__observation o ON o.id=p.observation_id LEFT JOIN erp_catalog__origin co ON co.entity='products' AND co.source_id=p.product_source_id LEFT JOIN erp_catalog__record cr ON cr.id=co.record_id LEFT JOIN erp_catalog__product cp ON cp.record_id=co.record_id LEFT JOIN erp_warehouse_import__binding wb ON wb.source_id=o.warehouse_source_id LEFT JOIN erp_catalog__record wr ON wr.id=wb.warehouse_id LEFT JOIN origin_sync__raw_record pr ON pr.entity='products' AND pr.source_id=p.product_source_id LEFT JOIN origin_sync__raw_record sr ON sr.entity='stock_balances' AND sr.source_id=p.product_source_id LEFT JOIN origin_sync__raw_record ws ON ws.entity='warehouses' AND ws.source_id=o.warehouse_source_id`,
    )
    .rows.map((r) => {
      const pr = parse(r.product_payload),
        sr = parse(r.stock_payload),
        ws = parse(r.warehouse_payload),
        issues = [...parse(r.issues)];
      if (r.product_id === null) issues.push("PRODUCT_UNLINKED");
      if (r.warehouse_id === null) issues.push("WAREHOUSE_UNLINKED");
      if (r.active === 0) issues.push("PRODUCT_INACTIVE");
      if (r.kind !== null && r.kind !== "P") issues.push("PRODUCT_SERVICE");
      if (["E", "V"].includes(String(r.format)))
        issues.push("PRODUCT_STRUCTURE_REVIEW");
      if (r.unit === null && arrow(pr, "unidade") === null)
        issues.push("UNIT_UNCONFIRMED");
      return {
        id: r.id as number,
        product_source_id: String(r.product_source_id),
        product_id: r.product_id,
        product_name:
          r.product_name ??
          text(arrow(pr, "nome"), 200) ??
          "Produto Origin " + r.product_source_id,
        product_code:
          r.product_code ??
          text(arrow(pr, "codigo"), 100) ??
          text(arrow(sr?.produto, "codigo"), 100),
        unit: r.unit ?? text(arrow(pr, "unidade"), 16),
        warehouse_source_id: String(r.warehouse_source_id),
        warehouse_id: r.warehouse_id,
        warehouse_name:
          r.warehouse_name ??
          text(arrow(ws, "descricao"), 200) ??
          text(arrow(ws, "nome"), 200) ??
          (r.warehouse_source_id === ""
            ? "Depósito não identificado"
            : "Depósito Origin " + r.warehouse_source_id),
        physical: r.physical as string | null,
        virtual: r.virtual as string | null,
        reserved: difference(r.physical, r.virtual),
        physical_state: r.physical_state,
        virtual_state: r.virtual_state,
        source_version: r.source_version,
        source_hash: r.source_hash,
        observed_at: jsonTimestamp(
          (r.raw_version === r.source_version &&
          r.raw_hash === r.source_hash &&
          finiteStamp(r.last_seen_at)
            ? r.last_seen_at
            : r.observed_at) as number | string,
        ),
        source_deleted: !!r.source_deleted,
        issues,
      };
    });
}
// A busca deste espelho usa LIKE no Fagoo (inclui % e _), sem aplicar LIKE/NOCASE no SQLite.
function matchesQuery(value: string, query: string): boolean {
  const pattern = [...("%" + fold(pgBtrim(query)) + "%")];
  let re = "^";
  const literal = (c: string) => "\\u{" + c.codePointAt(0)!.toString(16) + "}";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c.codePointAt(0) === 92) re += literal(pattern[++i]);
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += literal(c);
  }
  return new RegExp(re + "$", "su").test(fold(value));
}
const count = (db: SqlDriver, table: string) =>
  one(db, `SELECT count(*) n FROM "${table}"`)!.n;
registerRpc("erp_stock_mirror_list", (ctx, a) => {
  const db = ctx.db,
    limit = a.p_limit as number,
    after = a.p_after as number | bigint | null,
    query = a.p_query as string | null,
    warehouse = a.p_warehouse_source_id as string | null,
    state = a.p_state as string | null;
  requireAccess(db, a.p_user_id as string, false);
  if (
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    (after !== null && (after < 0 || after > 9007199254740991)) ||
    (query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query))) ||
    (state !== null && !["negative", "pending", "deleted"].includes(state)) ||
    (warehouse !== null &&
      (!/^[0-9]{1,40}$/.test(warehouse) || /^0+$/.test(warehouse)))
  )
    raise("22023", "stock_mirror_invalid_query");
  const all = positions(db),
    rows = all
      .filter(
        (p) =>
          (a.p_product_id === null || p.product_id === a.p_product_id) &&
          (state === "deleted" || !p.source_deleted) &&
          (warehouse === null || p.warehouse_source_id === warehouse) &&
          (query === null ||
            matchesQuery(
              p.product_name +
                " " +
                (p.product_code ?? "") +
                " " +
                p.product_source_id,
              query,
            )) &&
          (state === null ||
            (state === "negative" &&
              ((p.physical !== null && compareDec(p.physical, "0") < 0) ||
                (p.virtual !== null && compareDec(p.virtual, "0") < 0))) ||
            (state === "pending" && p.issues.length > 0) ||
            (state === "deleted" && p.source_deleted)) &&
          (after === null || BigInt(p.id) > BigInt(after)),
      )
      .sort((x, y) => x.id - y.id);
  const wh = [
    ...new Map(
      all
        .filter((p) => p.warehouse_source_id !== "")
        .map((p) => [
          p.warehouse_source_id,
          {
            source_id: p.warehouse_source_id,
            id: p.warehouse_id,
            name: p.warehouse_name,
          },
        ]),
    ).values(),
  ].sort(
    (x, y) =>
      pgCompareText(String(x.name), String(y.name)) ||
      pgCompareText(x.source_id, y.source_id),
  );
  return {
    scope: "stock_mirror",
    data_mode: "origin_mirror",
    limit,
    has_more: rows.length > limit,
    next_after: rows.length > limit ? rows[limit - 1].id : null,
    items: rows
      .slice(0, limit)
      .map((p) => ({
        ...p,
        warehouse_source_id: p.warehouse_source_id || null,
        origin: "origin",
        read_only: true,
      })),
    coverage: {
      positions: count(db, "erp_stock_mirror__position"),
      products: count(db, "erp_stock_mirror__applied"),
      raw_products: one(
        db,
        "SELECT count(*) n FROM origin_sync__raw_record WHERE entity='stock_balances'",
      )!.n,
      pending_products: one(
        db,
        "SELECT count(DISTINCT product_source_id) n FROM erp_stock_mirror__pending",
      )!.n,
      partial:
        !!one(db, "SELECT 1 FROM erp_stock_mirror__pending LIMIT 1") ||
        !!one(
          db,
          "SELECT 1 FROM erp_stock_mirror__issue WHERE resolved_at IS NULL LIMIT 1",
        ) ||
        all.some((p) => p.issues.length > 0) ||
        !!one(
          db,
          "SELECT 1 FROM origin_sync__raw_record r WHERE r.entity='products' AND NOT EXISTS(SELECT 1 FROM erp_stock_mirror__applied a WHERE a.product_source_id=r.source_id) LIMIT 1",
        ),
    },
    warehouses: wh,
    native: {
      positions: count(db, "erp_stock__balance"),
      movements: count(db, "erp_stock__movement"),
    },
  };
});
registerRpc("erp_stock_mirror_product_summary", (ctx, a) => {
  const db = ctx.db,
    ids = a.p_product_ids as string[] | null,
    w = a.p_warehouse_id as string | null;
  requireAccess(db, a.p_user_id as string, false);
  if (
    ids === null ||
    ids.length > 250 ||
    ids.includes(null as unknown as string) ||
    new Set(ids).size !== ids.length
  )
    raise("22023", "stock_mirror_invalid_query");
  if (
    w !== null &&
    !one(db, "SELECT 1 FROM erp_catalog__warehouse WHERE record_id=?", w)
  )
    raise("P0002", "stock_mirror_warehouse_not_found");
  const source =
      one(
        db,
        "SELECT source_id FROM erp_warehouse_import__binding WHERE warehouse_id=?",
        w,
      )?.source_id ?? null,
    all = positions(db);
  const items = ids.flatMap((id) => {
    const p = one(
      db,
      "SELECT o.source_id FROM erp_catalog__product p LEFT JOIN erp_catalog__origin o ON o.entity='products' AND o.record_id=p.record_id WHERE p.record_id=?",
      id,
    );
    if (!p) return [];
    const rows = all.filter(
        (r) =>
          r.product_source_id === p.source_id &&
          (w === null || r.warehouse_source_id === source),
      ),
      live = rows.filter((r) => !r.source_deleted),
      s = live.length === 1 && (w === null || source !== null) ? live[0] : null;
    return [
      {
        product_id: id,
        product_source_id: p.source_id,
        state:
          p.source_id === null
            ? "unlinked"
            : w !== null && source === null
              ? "warehouse_unlinked"
              : live.length === 1
                ? "observed"
                : live.length > 1
                  ? "multiple_warehouses"
                  : rows.some((r) => r.source_deleted)
                    ? "source_deleted"
                    : "not_observed",
        warehouse_source_id: s?.warehouse_source_id || null,
        warehouse_name: s?.warehouse_name ?? null,
        physical: s?.physical ?? null,
        virtual: s?.virtual ?? null,
        physical_state: s?.physical_state ?? null,
        virtual_state: s?.virtual_state ?? null,
        observed_at: s?.observed_at ?? null,
        source_version: s?.source_version ?? null,
        positions: live.length,
        issues: s?.issues ?? [],
      },
    ];
  });
  return {
    scope: "product_stock_mirror",
    data_mode: "origin_mirror",
    origin: "origin",
    read_only: true,
    warehouse:
      w === null ? null : { id: w, source_id: source, linked: source !== null },
    items,
  };
});

// erp_stock_mirror.number: expoente desloca a escala, sem conversão do valor a ponto flutuante.
function mirrorNumber(v: unknown): { state: string; value: string | null } {
  if (v === undefined) return { state: "absent", value: null };
  if (v === null) return { state: "null", value: null };
  const invalid = { state: "invalid", value: null },
    s = String(v);
  if (
    !["string", "number"].includes(typeof v) ||
    s.length > 80 ||
    !/^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.test(s)
  )
    return invalid;
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(s)!;
  const exponent = BigInt(m[4] ?? "0"),
    fraction = m[3] ?? "",
    digits = (m[2] + fraction).replace(/^0+/, "");
  if (!digits) return { state: "value", value: "0" };
  const scale = BigInt(fraction.length) - exponent;
  if (scale > BigInt(digits.length) + 12n || scale < -24n) return invalid;
  let raw: string;
  if (scale <= 0n) raw = digits + "0".repeat(-parseInt(scale.toString(), 10));
  else {
    const n = parseInt(scale.toString(), 10),
      padded = digits.padStart(n + 1, "0");
    raw = padded.slice(0, -n) + "." + padded.slice(-n);
  }
  raw = trim(raw);
  if (
    (raw.split(".")[1] ?? "").length > 12 ||
    compareDec(raw, "1000000000000000000000000") >= 0
  )
    return invalid;
  return { state: "value", value: decText(m[1] + raw, 12, false) };
}
const mirrorId = (v: unknown) => {
  if (typeof v === "string" && /^[1-9][0-9]{0,39}$/.test(v)) return v;
  if (
    typeof v === "number" &&
    /^[1-9][0-9]{0,15}$/.test(String(v)) &&
    BigInt(v) <= 9007199254740991n
  )
    return String(v);
  return null;
};
function projectOne(ctx: RpcContext, s: Record<string, unknown>) {
  const db = ctx.db,
    id = s.product_source_id,
    version = s.source_version;
  const issue = (code: string) =>
    db.exec(
      "INSERT OR IGNORE INTO erp_stock_mirror__issue(product_source_id,source_version,code,created_at) VALUES(?,?,?,?)",
      id,
      version,
      code,
      ctx.clock.next().toString(),
    );
  if (
    !/^[1-9][0-9]{0,39}$/.test(String(id)) ||
    BigInt(String(version)) > 9007199254740991n ||
    !finiteStamp(s.observed_at)
  ) {
    issue("SOURCE_IDENTITY_INVALID");
    return false;
  }
  const applied = one(
    db,
    "SELECT * FROM erp_stock_mirror__applied WHERE product_source_id=?",
    id,
  );
  if (
    applied &&
    BigInt(String(version)) <= BigInt(String(applied.source_version))
  ) {
    if (
      version === applied.source_version &&
      s.source_hash !== applied.source_hash
    )
      issue("VERSION_HASH_CONFLICT");
    return false;
  }
  const payload = parse(s.payload),
    deleted = payload?._brufap_source?.deleted === true,
    common: string[] = [];
  let valid = true,
    list: any[] = [];
  if (mirrorId(payload?.produto?.id) !== id) {
    valid = false;
    common.push("PRODUCT_ID_INVALID");
  }
  if (Array.isArray(payload?.depositos) && payload.depositos.length <= 1000)
    list = payload.depositos;
  else {
    valid = false;
    common.push("WAREHOUSE_LIST_INVALID");
  }
  if (
    list.some((d) => mirrorId(d?.id) === null) ||
    new Set(list.map((d) => mirrorId(d?.id))).size !== list.length
  ) {
    valid = false;
    common.push("WAREHOUSE_LIST_INVALID");
  }
  if (deleted) common.push("SOURCE_DELETED");
  const warehouses = new Set([
    ...list.map((d) => mirrorId(d?.id) ?? ""),
    ...db
      .exec(
        "SELECT warehouse_source_id FROM erp_stock_mirror__position WHERE product_source_id=?",
        id,
      )
      .rows.map((r) => String(r.warehouse_source_id)),
    ...(list.length ? [] : [""]),
  ]);
  for (const w of [...warehouses].sort(pgCompareText)) {
    const d =
        valid && !deleted ? list.find((d) => mirrorId(d?.id) === w) : null,
      ph = valid
        ? mirrorNumber(d?.saldoFisico)
        : { state: "invalid", value: null },
      vi = valid
        ? mirrorNumber(d?.saldoVirtual)
        : { state: "invalid", value: null },
      issues = [...common];
    if (ph.state !== "value" || vi.state !== "value")
      issues.push("BALANCE_INCOMPLETE");
    const prev = one(
      db,
      "SELECT o.physical,o.virtual FROM erp_stock_mirror__position p JOIN erp_stock_mirror__observation o ON o.id=p.observation_id WHERE p.product_source_id=? AND p.warehouse_source_id=?",
      id,
      w,
    );
    const oid = nextIdentity(ctx, "erp_stock_mirror__observation", "id");
    db.exec(
      "INSERT INTO erp_stock_mirror__observation(id,product_source_id,warehouse_source_id,source_version,source_hash,physical,virtual,physical_state,virtual_state,physical_delta,virtual_delta,issues,observed_at,source_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      oid,
      id,
      w,
      version,
      s.source_hash,
      ph.value,
      vi.value,
      ph.state,
      vi.state,
      difference(ph.value, prev?.physical ?? null),
      difference(vi.value, prev?.virtual ?? null),
      JSON.stringify(issues),
      s.observed_at,
      deleted ? 1 : 0,
    );
    const pid = nextIdentity(ctx, "erp_stock_mirror__position", "id");
    if (prev)
      db.exec(
        "UPDATE erp_stock_mirror__position SET observation_id=? WHERE product_source_id=? AND warehouse_source_id=?",
        oid,
        id,
        w,
      );
    else
      db.exec(
        "INSERT INTO erp_stock_mirror__position(id,product_source_id,warehouse_source_id,observation_id) VALUES(?,?,?,?)",
        pid,
        id,
        w,
        oid,
      );
  }
  if (applied)
    db.exec(
      "UPDATE erp_stock_mirror__applied SET source_version=?,source_hash=?,applied_at=? WHERE product_source_id=?",
      version,
      s.source_hash,
      ctx.clock.next().toString(),
      id,
    );
  else
    db.exec(
      "INSERT INTO erp_stock_mirror__applied(product_source_id,source_version,source_hash,applied_at) VALUES(?,?,?,?)",
      id,
      version,
      s.source_hash,
      ctx.clock.next().toString(),
    );
  db.exec(
    "UPDATE erp_stock_mirror__issue SET resolved_at=? WHERE product_source_id=? AND source_version<? AND resolved_at IS NULL",
    ctx.clock.next().toString(),
    id,
    version,
  );
  return true;
}
registerRpc("erp_stock_mirror_project", (ctx, a) => {
  const db = ctx.db,
    limit = a.p_limit as number;
  if (limit === null || limit < 1 || limit > 100)
    raise("22023", "stock_mirror_invalid_limit");
  const pending = db.exec(
    "SELECT product_source_id,source_version FROM erp_stock_mirror__pending WHERE retry_at<=? ORDER BY product_source_id,source_version LIMIT ?",
    ctx.clock.next().toString(),
    limit,
  ).rows;
  let applied = 0,
    failed = 0;
  for (const q of pending) {
    db.exec("SAVEPOINT stock_mirror_project");
    try {
      // O instante i64 deve chegar à validação, inclusive +/-infinity,
      // sem falhar antes na leitura do driver SQLite.
      const s = one(
        db,
        "SELECT product_source_id,source_version,source_hash,payload,CAST(observed_at AS TEXT) observed_at FROM erp_stock_mirror__source_version WHERE product_source_id=? AND source_version=?",
        q.product_source_id,
        q.source_version,
      );
      if (!s) raise("P0002", "query returned no rows");
      if (projectOne(ctx, s)) applied++;
      db.exec(
        "DELETE FROM erp_stock_mirror__pending WHERE product_source_id=? AND source_version=?",
        q.product_source_id,
        q.source_version,
      );
      db.exec("RELEASE stock_mirror_project");
    } catch (e) {
      db.exec("ROLLBACK TO stock_mirror_project");
      db.exec("RELEASE stock_mirror_project");
      failed++;
      db.exec(
        "UPDATE erp_stock_mirror__pending SET attempts=attempts+1,retry_at=?,last_error=? WHERE product_source_id=? AND source_version=?",
        (ctx.clock.next() + 300000000n).toString(),
        fromSqlite(e).code,
        q.product_source_id,
        q.source_version,
      );
      db.exec(
        "INSERT OR IGNORE INTO erp_stock_mirror__issue(product_source_id,source_version,code,created_at) VALUES(?,?,'PROJECTOR_ERROR',?)",
        q.product_source_id,
        q.source_version,
        ctx.clock.next().toString(),
      );
    }
  }
  return {
    processed: pending.length,
    applied,
    failed,
    pending: count(db, "erp_stock_mirror__pending"),
  };
});
