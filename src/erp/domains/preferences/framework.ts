// Molduras do sistema (migração 148, system_frameworks): comando idempotente
// por área, validações de chaves/texto/versão, situações personalizadas e
// transições. Portado de erp_preferences.framework_keys, framework_text,
// framework_version, framework_hash, framework_replay, situation_list,
// situation_of, transition_list e transition_allowed.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../engine/text.ts";
import { transitions } from "../documents/public.ts";
import { situationBases } from "./center.ts";
import { compareText } from "./order.ts";

/** framework_keys(p, keys): objeto com exatamente essas chaves. */
export function frameworkKeys(p: unknown, keys: string[]): boolean {
  if (p === null || jsonType(p) !== "object") return false;
  const have = Object.keys(p as object).sort(compareText);
  const want = [...keys].sort(compareText);
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

/** framework_text(p, max): texto aparado, de 1 a max caracteres, sem controle. */
export function frameworkText(p: unknown, max: number): string {
  if (jsonType(p) !== "string") raise("22023", "erp_preferences_framework_text_invalid");
  const s = p as string;
  if (s !== pgBtrim(s) || pgLength(s) < 1 || pgLength(s) > max || pgHasCntrl.test(s)) raise("22023", "erp_preferences_framework_text_invalid");
  return s;
}

/** framework_version(p): inteiro positivo do jsonb, ou null. */
export function frameworkVersion(p: unknown): number | null {
  if (p === null || p === undefined || jsonType(p) !== "number") return null;
  const t = jsonbText(p);
  if (!/^[1-9][0-9]{0,9}$/.test(t) || BigInt(t) > 2147483647n) return null;
  return Number(t);
}

/** framework_hash(p): sha256 do jsonb::text. */
export const frameworkHash = (p: unknown) => createHash("sha256").update(jsonbText(p), "utf8").digest("hex");

/** framework_replay: o recibo do mesmo comando, ou null; outro corpo, autor ou área conflita. */
export function frameworkReplay(db: SqlDriver, command: string, actor: string, area: string, hash: string) {
  const c = one(db, 'SELECT actor, area, request_hash, result FROM "erp_preferences__framework_command" WHERE id=?', command);
  if (!c) return null;
  if (c.actor !== actor || c.area !== area || c.request_hash !== hash) raise("40001", "erp_preferences_framework_command_conflict");
  return { ...(JSON.parse(String(c.result)) as Record<string, unknown>), replayed: true };
}

export const SITUATION_KINDS = ["sales_orders", "purchase_orders", "service_orders"];

export interface SituationItem {
  key: string;
  base_status: string;
  name: string;
  color: string;
  is_default: boolean;
  active: boolean;
  version: number;
  ordinal: number;
  created_at: bigint | null;
}

/** situation_list(kind): as situações-base e as personalizadas (cujo status-base existe). */
export function situationList(db: SqlDriver, kind: string): SituationItem[] {
  const bases = situationBases(kind);
  const out: SituationItem[] = bases.map((b) => ({
    key: b.status,
    base_status: b.status,
    name: b.label,
    color: b.color,
    is_default: true,
    active: true,
    version: 0,
    ordinal: b.ordinal,
    created_at: null,
  }));
  for (const s of db.exec('SELECT id, base_status, name, color, active, version, created_at FROM "erp_preferences__situation" WHERE kind=?', kind).rows) {
    const b = bases.find((x) => x.status === s.base_status);
    if (!b) continue;
    out.push({
      key: String(s.id),
      base_status: String(s.base_status),
      name: String(s.name),
      color: String(s.color),
      is_default: false,
      active: Number(s.active) === 1,
      version: Number(s.version),
      ordinal: b.ordinal,
      created_at: BigInt(s.created_at as string | number),
    });
  }
  return out;
}

/** situation_of(kind, key) */
export function situationOf(db: SqlDriver, kind: string, key: string | null) {
  const s = key === null ? undefined : situationList(db, kind).find((x) => x.key === key);
  return s ? { key: s.key, base_status: s.base_status, name: s.name, color: s.color, default: s.is_default, active: s.active } : null;
}

/** transition_allowed(kind, from, to): o mesmo status-base ou a transição do documento. */
export function transitionAllowed(kind: string, from: string, to: string) {
  return from === to || (transitions()[kind]?.[from] ?? []).includes(to);
}

const pad = (n: number | bigint, w: number) => String(n).padStart(w, "0");
/** to_char(t at time zone 'UTC', 'YYYYMMDDHH24MISSUS') */
function utcStamp(micros: bigint) {
  const us = ((micros % 1000000n) + 1000000n) % 1000000n;
  const d = new Date(Number((micros - us) / 1000n));
  return (
    pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2) + pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2) + pad(us, 6)
  );
}

/** transition_list(kind): as transições padrão (entre situações-base) e as gravadas, na ordem das situações. */
export function transitionList(db: SqlDriver, kind: string) {
  const list = situationList(db, kind).map((l) => ({
    ...l,
    ord: pad(l.ordinal, 4) + (l.is_default ? "0" : "1" + utcStamp(l.created_at!) + l.key),
  }));
  const stored = new Map(
    db
      .exec('SELECT from_key, to_key, active, actions, version FROM "erp_preferences__transition" WHERE kind=?', kind)
      .rows.map((t) => [`${t.from_key}\u0000${t.to_key}`, t]),
  );
  const out = [];
  for (const a of list)
    for (const b of list) {
      if (a.key === b.key || !transitionAllowed(kind, a.base_status, b.base_status)) continue;
      const t = stored.get(`${a.key}\u0000${b.key}`);
      if (!(a.is_default && b.is_default) && !t) continue;
      out.push({
        from_key: a.key,
        to_key: b.key,
        is_default: a.is_default && b.is_default,
        active: t ? Number(t.active) === 1 : true,
        actions: t ? (JSON.parse(String(t.actions)) as string[]) : [],
        version: t ? Number(t.version) : 0,
        from_ord: a.ord,
        to_ord: b.ord,
      });
    }
  return out.sort((x, y) => compareText(x.from_ord, y.from_ord) || compareText(x.to_ord, y.to_ord));
}

/** situations_page(kind) */
export function situationsPage(db: SqlDriver, kind: string) {
  const bases = situationBases(kind);
  const list = situationList(db, kind).sort(
    (a, b) =>
      a.ordinal - b.ordinal ||
      Number(b.is_default) - Number(a.is_default) ||
      (a.created_at === null ? (b.created_at === null ? 0 : 1) : b.created_at === null ? -1 : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
      compareText(a.key, b.key),
  );
  const rules: Record<string, string[]> = {};
  for (const b of bases)
    rules[b.status] = bases
      .filter((o) => o.status !== b.status && (transitions()[kind]?.[b.status] ?? []).includes(o.status))
      .sort((x, y) => x.ordinal - y.ordinal || compareText(x.status, y.status))
      .map((o) => o.status);
  return {
    scope: "situations_page",
    data_mode: "erp_native",
    kind,
    adopted: !!one(db, 'SELECT 1 x FROM "erp_preferences__situation_adoption" WHERE kind=?', kind),
    situations: list.map((s) => ({ key: s.key, base_status: s.base_status, name: s.name, color: s.color, default: s.is_default, active: s.active, version: s.version })),
    rules: Object.fromEntries(jsonbKeys(rules).map((k) => [k, rules[k]])),
    transitions: transitionList(db, kind).map((t) => ({
      from: t.from_key,
      to: t.to_key,
      default: t.is_default,
      active: t.active,
      actions: t.actions,
      version: t.version,
    })),
  };
}
