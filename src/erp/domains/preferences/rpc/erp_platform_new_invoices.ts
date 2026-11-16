// Cartão "Novas NF-es" da home (migração 334): public.erp_platform_new_invoices
// e _new_invoices_seen; internas invoice_reader, new_invoices_view,
// new_invoices e erp_fiscal_invoices.origin_status/scalar.
// Origin desligado: origin_sync.raw_record fica vazio na instalação nova,
// mas a regra continua aqui (a tabela existe e o diferencial a exercita).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { memberRole } from "../../access/public.ts";
import { uuid } from "../args.ts";
import { nowMicros } from "../platform.ts";

const DAY = 86_400_000_000n;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** erp_fiscal_invoices.scalar(p_value, p_max): texto de string ou número curto, sem controle. */
function scalar(value: unknown, max: number): string | null {
  const t = jsonType(value);
  if (t !== "string" && t !== "number") return null;
  const v = t === "string" ? (value as string) : jsonbText(value);
  return pgLength(v) >= 1 && pgLength(v) <= max && !CONTROL.test(v) ? v : null;
}

const ORIGIN_STATUS: Record<string, number> = { "1": 1, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "10": 11, "11": 12 };
/** erp_fiscal_invoices.origin_status(p_value jsonb) */
function originStatus(value: unknown): number | null {
  const inner = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined;
  const key = scalar(inner, 4) ?? scalar(value, 4);
  return key === null ? null : (ORIGIN_STATUS[key] ?? null);
}

/** erp_platform.invoice_reader: administrador, consulta ou fiscal. */
function invoiceReader(db: SqlDriver, user: string | null) {
  const role = memberRole(db, user);
  if (!["admin", "consulta", "fiscal"].includes(role)) raise("42501", "erp_platform_invoices_forbidden");
  return role;
}

/** erp_platform.new_invoices(p_since): uma linha por nota (pela chave de acesso), Origin antes da SEFAZ. */
function newInvoices(db: SqlDriver, since: bigint) {
  const found = new Map<string, { source: string; o: number }>();
  const add = (key: string, source: string, o: number) => {
    const prev = found.get(key);
    if (!prev || o < prev.o) found.set(key, { source, o });
  };
  for (const r of db.exec(
    `SELECT source_id, payload FROM "origin_sync__raw_record" WHERE entity='nfe' AND first_seen_at>?`,
    since.toString(),
  ).rows) {
    const payload = JSON.parse(String(r.payload)) as Record<string, unknown>;
    const status = originStatus(payload.situacao);
    if (status !== 6 && status !== 7) continue;
    const chave = typeof payload.chaveAcesso === "string" ? payload.chaveAcesso : payload.chaveAcesso === undefined || payload.chaveAcesso === null ? null : jsonbText(payload.chaveAcesso);
    // XMLs de homologação do arquivo do Origin ficam de fora (113).
    if (
      chave !== null &&
      one(
        db,
        `SELECT 1 x FROM "origin_fiscal__source" s JOIN "origin_fiscal__item" i ON i.revision=s.current_revision
         JOIN "origin_fiscal__object" ob ON ob.hash=i.object_hash
         WHERE s.entity='nfe' AND s.source_id=? AND s.access_key=? AND ob.metadata->>'$.kind'='invoice' AND ob.metadata->>'$.environment'='2'`,
        String(r.source_id),
        chave,
      )
    )
      continue;
    const access = chave !== null && /^[0-9]{44}$/.test(chave) ? chave : null;
    add(access ?? `origin:${r.source_id}`, "origin", 1);
  }
  for (const d of db.exec(
    `SELECT d.id, d.access_key FROM "erp_dfe__document" d JOIN "erp_dfe__channel" ch ON ch.id=d.channel_id
     WHERE ch.environment='1' AND d.kind IN ('invoice_summary','invoice') AND d.quarantined=0 AND d.created_at>?`,
    since.toString(),
  ).rows)
    add((d.access_key as string | null) ?? `sefaz:${d.id}`, "sefaz", 2);
  return [...found.values()];
}

/** erp_platform.new_invoices_view(p_user) */
function view(db: SqlDriver, user: string) {
  const seen = one(db, `SELECT CAST(seen_at AS TEXT) seen_at FROM "erp_platform__card_view" WHERE user_id=? AND card='novas_nfes'`, user);
  const since = seen ? BigInt(String(seen.seen_at)) : nowMicros() - 7n * DAY;
  const n = newInvoices(db, since);
  return {
    scope: "home_new_invoices",
    data_mode: "erp_native",
    since: jsonTimestamp(since.toString()),
    seen_before: seen !== null,
    total: n.length,
    synced: n.filter((x) => x.source === "origin").length,
    received: n.filter((x) => x.source === "sefaz").length,
    as_of: jsonTimestamp(nowMicros().toString()),
  };
}

export function erpPlatformNewInvoices(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  invoiceReader(ctx.db, user);
  return view(ctx.db, user!);
}

export function erpPlatformNewInvoicesSeen(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const db = ctx.db;
  invoiceReader(db, user);
  if (command === null) raise("22023", "erp_platform_input_invalid");
  const c = one(db, 'SELECT actor, result FROM "erp_platform__card_view_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user) raise("40001", "erp_platform_command_conflict");
    return { ...(JSON.parse(String(c.result)) as Record<string, unknown>), view: view(db, user!), replayed: true };
  }
  const at = ctx.clock.next();
  const result = { scope: "home_new_invoices_seen", data_mode: "erp_native", seen_at: jsonTimestamp(at.toString()) };
  db.exec(
    'INSERT INTO "erp_platform__card_view_command"(id, actor, result, created_at) VALUES (?,?,?,?)',
    command,
    user,
    jsonbText(result),
    at.toString(),
  );
  db.exec(
    `INSERT INTO "erp_platform__card_view"(user_id, card, seen_at, command_id, updated_at) VALUES (?, 'novas_nfes', ?, ?, ?)
     ON CONFLICT(user_id, card) DO UPDATE SET seen_at=excluded.seen_at, command_id=excluded.command_id, updated_at=excluded.updated_at`,
    user,
    at.toString(),
    command,
    at.toString(),
  );
  return { ...result, view: view(db, user!), replayed: false };
}

registerRpc("erp_platform_new_invoices", erpPlatformNewInvoices);
registerRpc("erp_platform_new_invoices_seen", erpPlatformNewInvoicesSeen);
