// Núcleo do Fiscal (erp_fiscal_invoices, versões finais no oráculo): papel e
// permissão, a validação dos valores de entrada (check_value e os *_input), o
// recibo de comando com a auditoria e a leitura das preferências.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { formatScaled, toScaled } from "../../engine/dec.ts";
import { pgHasCntrl, pgLength } from "../../engine/text.ts";
import { validDate } from "../../engine/time.ts";
import { activeRole, permitted } from "../access/public.ts";
import { contactScope, contactVisibleTo } from "../catalog/public.ts";
import { get as preferenceGet } from "../preferences/public.ts";

export type Json = Record<string, unknown>;
const invalid = (): never => raise("22023", "erp_fiscal_value_invalid");

/** erp_fiscal_invoices.role_of: papel do membro ativo (42501 sem membro). */
export function roleOf(db: SqlDriver, user: string | null): string {
  const r = user === null ? null : activeRole(db, user);
  if (r === null) raise("42501", "erp_fiscal_invoice_forbidden");
  return r!;
}

/** erp_fiscal_invoices.require_write */
export function requireWrite(db: SqlDriver, user: string | null): string {
  const r = roleOf(db, user);
  if (!["admin", "fiscal"].includes(r)) raise("42501", "erp_fiscal_invoice_forbidden");
  if (!(permitted(db, user!, "vendas.notas_fiscais.ie") || permitted(db, user!, "suprimentos.notas_entrada.ie"))) raise("42501", "erp_fiscal_invoice_forbidden");
  return r;
}

/** erp_fiscal_invoices.require_read (Notas Fiscais de saída ou Notas de Entrada). */
export function requireRead(db: SqlDriver, user: string | null): string {
  const r = roleOf(db, user);
  if (!["admin", "consulta", "fiscal"].includes(r)) raise("42501", "erp_fiscal_invoice_forbidden");
  if (!(permitted(db, user!, "vendas.notas_fiscais") || permitted(db, user!, "suprimentos.notas_entrada"))) raise("42501", "erp_fiscal_invoice_forbidden");
  return r;
}

const DATE = /^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** btrim(v, E' \t\n\r') */
const trimSpaces = (v: string) => v.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");

/**
 * erp_fiscal_invoices.check_value(valor, descritor): b (booleano), t:n e m:n
 * (texto de uma linha ou várias, até n), e:a|b (lista), x:regex, u (uuid),
 * a (data) e d:escala:inteiros (decimal em texto, completado até a escala).
 */
export function checkValue(value: unknown, desc: string): unknown {
  const k = desc.split(":")[0];
  const a = desc.slice(k.length + 1);
  if (value === null || value === undefined) return null;
  if (k === "b") {
    if (typeof value !== "boolean") invalid();
    return value;
  }
  if (typeof value !== "string") invalid();
  const v = value as string;
  if (k === "t" || k === "m") {
    const s = trimSpaces(v);
    if (s === "") return null;
    if (pgLength(s) > Number(a) || pgHasCntrl.test(k === "m" ? s.replace(/[\n\r\t]/g, "") : s)) invalid();
    return s;
  }
  if (k === "e") {
    if (!a.split("|").includes(v)) invalid();
    return v;
  }
  if (k === "x") {
    if (!new RegExp(a).test(v)) invalid();
    return v;
  }
  if (k === "u") {
    if (!UUID.test(v)) invalid();
    return v.toLowerCase();
  }
  if (k === "a") {
    if (!DATE.test(v) || !validDate(v)) invalid();
    return v;
  }
  if (k === "d") {
    const [s, i] = a.split(":").map(Number);
    if (!new RegExp(`^(0|[1-9][0-9]{0,${i - 1}})(\\.[0-9]{1,${s}})?$`).test(v)) invalid();
    const [whole, frac = ""] = v.split(".");
    return `${whole}.${frac.padEnd(s, "0")}`;
  }
  return raise("22023", "erp_fiscal_spec_invalid");
}

/** erp_fiscal_invoices.spec_object(valor, spec): só as chaves da spec, cada uma conferida. */
export function specObject(value: unknown, spec: Record<string, string>): Json {
  if (value === null || value === undefined) return {};
  if (jsonType(value) !== "object") invalid();
  const result: Json = {};
  for (const key of jsonbKeys(value as object)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) raise("22023", "erp_fiscal_unknown_field");
    const n = checkValue((value as Json)[key], spec[key]);
    if (n !== null) result[key] = n;
  }
  return result;
}

/** erp_fiscal_invoices.text_input(valor, máximo, obrigatório, várias linhas) */
export function textInput(value: unknown, max: number, required = false, multiline = false): string | null {
  const v = checkValue(value, `${multiline ? "m" : "t"}:${max}`) as string | null;
  if (required && v === null) raise("22023", "erp_fiscal_value_required");
  return v;
}

/** erp_fiscal_invoices.bool_input(valor, padrão) */
export function boolInput(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "boolean") invalid();
  return value as boolean;
}

/** erp_fiscal_invoices.uuid_input(valor, obrigatório) */
export function uuidInput(value: unknown, required = true): string | null {
  const v = checkValue(value, "u") as string | null;
  if (v === null && required) raise("22023", "erp_fiscal_value_required");
  return v;
}

/** erp_fiscal_invoices.version_input: número inteiro de 1 a 2147483647. */
export function versionInput(value: unknown): number {
  if (jsonType(value) !== "number" || !/^[1-9][0-9]{0,9}$/.test(jsonbText(value)) || Number(value) > 2147483647) raise("22023", "erp_fiscal_version_invalid");
  return Number(value);
}

/** erp_fiscal_invoices.ufs() */
export const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
export const ufs = () => [...UFS];

/** erp_fiscal_invoices.ipi_situation_allowed(direção, situação) */
export const ipiSituationAllowed = (direction: string, situation: string | null) =>
  situation === null || (direction === "0" ? ["00", "01", "02", "03", "04", "05", "49"] : ["50", "51", "52", "53", "54", "55", "99"]).includes(situation);

/** erp_fiscal_invoices.digits */
export const digits = (value: string | null) => (value ?? "").replace(/[^0-9]/g, "");

/** erp_fiscal_invoices.money_text: to_char(round(coalesce(v,0),2),'FM9999999999999990.00') */
export const moneyText = (value: string | number | null) => formatScaled(toScaled(value === null ? "0" : String(value), 2), 2);

/** erp_fiscal_invoices.command_hash(ator, escopo, ação, dados) */
export const commandHash = (actor: string | null, scope: string, action: string, data: unknown) =>
  createHash("sha256").update(jsonbText({ actor, scope, action, data }), "utf8").digest("hex");

/** erp_fiscal_invoices.command_replay: o recibo do mesmo pedido volta com replayed; outro pedido, 40001. */
export function commandReplay(db: SqlDriver, commandId: string, actor: string, scope: string, hash: string): Json | null {
  const c = one(db, 'SELECT actor, scope, request_hash, result FROM "erp_fiscal_invoices__command" WHERE command_id=?', commandId);
  if (!c) return null;
  if (c.actor !== actor || c.scope !== scope || c.request_hash !== hash) raise("40001", "erp_fiscal_command_conflict");
  return { ...(JSON.parse(String(c.result)) as Json), replayed: true };
}

/** O recibo (erp_fiscal_invoices.command) e a linha da auditoria. */
export function finishCommand(
  ctx: RpcContext,
  p: { commandId: string; actor: string; scope: string; hash: string; result: Json; entity: string | null; version: number | null; action: string; reason?: string | null },
) {
  ctx.db.exec(
    'INSERT INTO "erp_fiscal_invoices__command"(command_id, actor, scope, request_hash, result, created_at) VALUES(?,?,?,?,?,?)',
    p.commandId, p.actor, p.scope, p.hash, JSON.stringify(p.result), ctx.clock.next().toString(),
  );
  ctx.db.exec(
    'INSERT INTO "erp_fiscal_invoices__audit"(actor, command_id, scope, entity_id, version, action, reason, created_at) VALUES(?,?,?,?,?,?,?,?)',
    p.actor, p.commandId, p.scope, p.entity, p.version, p.action, p.reason ?? null, ctx.clock.next().toString(),
  );
  return p.result;
}

/** erp_fiscal_invoices.preference(chave, tipo jsonb, padrão): o valor de erp_preferences.get do tipo pedido. */
export function preference(db: SqlDriver, key: string, type: string, fallback: unknown): unknown {
  const v = preferenceGet(db, key, null);
  if (v === null || v === undefined || jsonType(v) !== type) return fallback;
  return v;
}

/** erp_fiscal_mirror.native_visible(usuário, nota): o destinatário da nota nativa está na carteira de quem lê. */
export const nativeVisible = (db: SqlDriver, user: string | null, id: string | null) =>
  contactVisibleTo(
    db,
    contactScope(db, user),
    (one(db, `SELECT json_extract(recipient,'$.contact_id') c FROM "erp_fiscal_invoices__invoice" WHERE id=?`, id)?.c as string | null | undefined) ?? null,
  );

/**
 * erp_fiscal_mirror.visible(usuário, entidade, origem): sem carteira, tudo; com
 * carteira, o contato da nota espelhada (erp_fiscal_mirror.current antes de
 * origin_sync.raw_record) precisa ser de um cliente do vendedor. Leitura do
 * espelho portada como leitura (ERP-PORTE.md, "Origin fora"): sem dado, nada é
 * visível com carteira, como no oráculo; com dado, compara.
 */
export function visible(db: SqlDriver, user: string | null, entity: string | null, source: string | null): boolean {
  const scope = contactScope(db, user);
  if (scope === null) return true;
  const c = one(
    db,
    `SELECT c FROM (SELECT json_extract(payload,'$.contato.id') c, 0 priority FROM "erp_fiscal_mirror__current" WHERE entity=? AND source_id=?
       UNION ALL SELECT json_extract(payload,'$.contato.id') c, 1 priority FROM "origin_sync__raw_record" WHERE entity=? AND source_id=?) ORDER BY priority LIMIT 1`,
    entity, source, entity, source,
  );
  const contact = c?.c === null || c?.c === undefined ? null : String(c.c);
  return (
    contact !== null &&
    !!one(
      db,
      `SELECT 1 x FROM "erp_catalog__origin" o JOIN "erp_catalog__contact_profile" cp ON cp.record_id=o.record_id WHERE o.entity='contacts' AND cp.seller_id=? AND o.source_id=?`,
      scope, contact,
    )
  );
}

/** erp_fiscal_invoices.scalar(valor, máximo): texto ou número de 1 a n caracteres, sem controle. */
export function scalar(value: unknown, max: number): string | null {
  const t = jsonType(value);
  if (t !== "string" && t !== "number") return null;
  const s = typeof value === "string" ? value : jsonbText(value);
  const n = pgLength(s);
  return n >= 1 && n <= max && !pgHasCntrl.test(s) ? s : null;
}
