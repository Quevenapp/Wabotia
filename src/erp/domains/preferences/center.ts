// Centro de preferências (migração 115 e evoluções): papéis de leitura e
// escrita, a página (valores da empresa ou do usuário), o diretório de
// usuários, as situações personalizadas da página e a validação de cada tipo
// de campo. Portado de erp_preferences.reader_role, write_access, page_dto,
// page_permission, directory, page_situations, situation_bases,
// situation_base_label, situation_base_color e value_valid.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { pgLeft, pgLength, pgLower } from "../../engine/text.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { permitted } from "../access/public.ts";
import { validCnpj, validCpf } from "../catalog/public.ts";
import { transitions } from "../documents/public.ts";
import { compareText } from "./order.ts";
import { situationBaseColor, situationBaseLabel } from "./situation-labels.ts";

export { situationBaseColor, situationBaseLabel };

export interface Page {
  id: string;
  scope: string;
  read_roles: string[];
}
export interface Definition {
  key: string;
  page_id: string;
  ordinal: number;
  kind: string;
  options: unknown;
  default_value: unknown;
  min_value: number | null;
  max_value: number | null;
  scale: number | null;
  max_length: number | null;
  max_items: number | null;
  format: string | null;
  min_length: number | null;
  situation_kind: string | null;
}

const parse = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function pageRow(db: SqlDriver, id: string | null): Page | null {
  const r = id === null ? null : one(db, 'SELECT id, scope, read_roles FROM "erp_preferences__page" WHERE id=?', id);
  return r ? { id: String(r.id), scope: String(r.scope), read_roles: parse(r.read_roles) ?? [] } : null;
}

const toDefinition = (r: Record<string, unknown>): Definition => ({
  key: String(r.key),
  page_id: String(r.page_id),
  ordinal: Number(r.ordinal),
  kind: String(r.kind),
  options: parse(r.options),
  default_value: parse(r.default_value),
  min_value: num(r.min_value),
  max_value: num(r.max_value),
  scale: num(r.scale),
  max_length: num(r.max_length),
  max_items: num(r.max_items),
  format: (r.format as string | null) ?? null,
  min_length: num(r.min_length),
  situation_kind: (r.situation_kind as string | null) ?? null,
});
export const definition = (db: SqlDriver, key: string) => {
  const r = one(db, 'SELECT * FROM "erp_preferences__definition" WHERE key=?', key);
  return r ? toDefinition(r) : null;
};
export const pageDefinitions = (db: SqlDriver, page: string) =>
  db.exec('SELECT * FROM "erp_preferences__definition" WHERE page_id=? ORDER BY ordinal', page).rows.map(toDefinition);

/** erp_preferences.reader_role(p_actor): o papel do membro ativo. */
export function readerRole(db: SqlDriver, actor: string | null): string {
  const r = actor === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', actor);
  if (!r) raise("42501", "erp_preferences_access_denied");
  return String(r.role);
}

/** erp_preferences.write_access(p_actor, p_page) */
export function writeAccess(db: SqlDriver, actor: string | null, page: Page): string {
  const r = actor === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', actor);
  const role = r ? String(r.role) : null;
  if (role === null || !page.read_roles.includes(role) || (page.scope === "company" && role !== "admin"))
    raise("42501", "erp_preferences_access_denied");
  return role;
}

/** erp_preferences.page_permission(p_page) */
const pagePermission = (page: string) =>
  page === "contabilidade-contador" ? "contabilidade.meu_contador" : page === "central-notificacoes" ? "preferencias.central_notificacoes" : null;

/** erp_preferences.directory(): até 500 membros ativos, com o nome do perfil ou o e-mail. */
export function directory(ctx: RpcContext) {
  const people = ctx.identity.people ?? [];
  return ctx.db
    .exec('SELECT m.user_id, m.role, p.name FROM "erp_access__membership" m LEFT JOIN "erp_access__profile" p ON p.user_id=m.user_id WHERE m.active=1 ORDER BY m.created_at, m.user_id LIMIT 500')
    .rows.map((m) => {
      const email = people.find((x) => x.user_id === m.user_id)?.email ?? (ctx.identity.actor?.user_id === m.user_id ? ctx.identity.actor?.email : null) ?? null;
      const label = (m.name as string | null) ?? (email === null ? null : pgLower(email));
      return { user_id: m.user_id, role: m.role, label: label === null ? null : pgLeft(label, 200) };
    });
}

const ORDER = [
  "draft", "open", "quoted", "approved", "rejected", "verified", "in_progress", "agency_sale", "waiting_parts", "partially_fulfilled",
  "partially_invoiced", "service_done", "fulfilled", "finalized", "no_repair", "cancelled",
];

/** erp_preferences.situation_bases(p_kind): as situações-base do tipo (status, rótulo, cor, ordem). */
export function situationBases(kind: string) {
  const map = ["sales_orders", "purchase_orders", "service_orders"].includes(kind) ? (transitions()[kind] ?? {}) : {};
  return jsonbKeys(map)
    .filter((s) => /^[a-z_]{2,40}$/.test(s))
    .map((status) => ({
      status,
      label: situationBaseLabel(kind, status),
      color: situationBaseColor(status),
      ordinal: ORDER.indexOf(status) >= 0 ? ORDER.indexOf(status) + 1 : 1000,
    }));
}

/** erp_preferences.page_situations(p_page) */
export function pageSituations(db: SqlDriver, page: string) {
  const kinds = new Set(
    db.exec('SELECT situation_kind FROM "erp_preferences__definition" WHERE page_id=? AND situation_kind IS NOT NULL', page).rows.map((r) => String(r.situation_kind)),
  );
  const kindOrder = (k: string) => {
    const i = ["sales_orders", "purchase_orders", "service_orders"].indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return db
    .exec('SELECT id, kind, name, base_status, color, active FROM "erp_preferences__situation"')
    .rows.filter((s) => kinds.has(String(s.kind)))
    .map((s) => {
      const base = situationBases(String(s.kind)).find((b) => b.status === s.base_status);
      return {
        row: s,
        ordinal: base?.ordinal ?? 1000,
        dto: {
          id: s.id,
          kind: s.kind,
          name: s.name,
          base_status: s.base_status,
          base_label: base?.label ?? s.base_status,
          color: s.color,
          active: Number(s.active) === 1,
        },
      };
    })
    .sort(
      (a, b) =>
        kindOrder(String(a.row.kind)) - kindOrder(String(b.row.kind)) ||
        a.ordinal - b.ordinal ||
        compareText(pgLower(String(a.row.name)), pgLower(String(b.row.name))) ||
        compareText(String(a.row.id), String(b.row.id)),
    )
    .map((x) => x.dto);
}

/** O valor salvo (empresa ou usuário), ou null. */
export function storedValue(db: SqlDriver, page: Page, key: string, user: string) {
  const r =
    page.scope === "company"
      ? one(db, 'SELECT value, CAST(version AS TEXT) version, CAST(updated_at AS TEXT) updated_at FROM "erp_preferences__company_value" WHERE key=?', key)
      : one(
          db,
          'SELECT value, CAST(version AS TEXT) version, CAST(updated_at AS TEXT) updated_at FROM "erp_preferences__user_value" WHERE key=? AND user_id=?',
          key,
          user,
        );
  return r ? { value: parse(r.value), version: Number(r.version), updated_at: String(r.updated_at) } : null;
}

/** erp_preferences.page_dto(p_page, p_role, p_user) */
export function pageDto(ctx: RpcContext, page: Page, role: string, user: string) {
  const db = ctx.db;
  const key = pagePermission(page.id);
  if (key !== null && !permitted(db, user, key)) raise("42501", "erp_preferences_permission_denied");
  const defs = pageDefinitions(db, page.id);
  const manage = page.scope === "user" || role === "admin";
  return {
    scope: "preferences_page",
    data_mode: "erp_native",
    page: page.id,
    owner: page.scope,
    role,
    can_manage: manage,
    items: defs.map((d) => {
      const v = storedValue(db, page, d.key, user);
      return { key: d.key, value: v ? v.value : d.default_value, version: v?.version ?? 0, updated_at: v ? jsonTimestamp(v.updated_at) : null };
    }),
    directory: manage && defs.some((d) => d.kind === "users") ? directory(ctx) : null,
    ...(defs.some((d) => d.situation_kind !== null) ? { situations: pageSituations(db, page.id) } : {}),
  };
}

// ---------------------------------------------------------------------------
// value_valid

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^@ ]+@[^@ ]+\.[^@ ]+$/;
const has = (options: unknown, value: string) =>
  Array.isArray(options) ? options.some((o) => o === value) : options !== null && typeof options === "object" && value in (options as object);

/** erp_preferences.value_valid(d, v) */
export function valueValid(d: Definition | null, v: unknown): boolean {
  if (d === null || v === undefined) return false;
  switch (d.kind) {
    case "toggle":
      return jsonType(v) === "boolean";
    case "choice":
      return jsonType(v) === "string" && has(d.options, v as string);
    case "multi": {
      if (jsonType(v) !== "array") return false;
      let list = v as unknown[];
      // 299: depois das opções padrão, os ids das situações personalizadas do tipo (uuid minúsculo, crescente, distinto, até 30).
      if (d.situation_kind !== null) {
        if (list.some((x) => jsonType(x) !== "string")) return false;
        const custom = (list as string[]).filter((x) => !has(d.options, x));
        if (custom.length > 30) return false;
        let prev: string | null = null;
        for (const e of custom) {
          if (!UUID_LOWER.test(e) || (prev !== null && compareText(e, prev) <= 0)) return false;
          prev = e;
        }
        const defaults = (list as string[]).filter((x) => has(d.options, x));
        if (jsonbText([...defaults, ...custom]) !== jsonbText(list)) return false;
        list = defaults;
      }
      if (d.max_items !== null && list.length > d.max_items) return false;
      if (list.some((x) => jsonType(x) !== "string" || !has(d.options, x as string))) return false;
      // Distintos e na ordem das opções: uma escolha tem uma representação só.
      const options = Array.isArray(d.options) ? (d.options as unknown[]) : [];
      let before = -1;
      for (const x of list as string[]) {
        const i = options.indexOf(x) + 1;
        if (before !== -1 && i <= before) return false;
        before = i;
      }
      return true;
    }
    case "integer": {
      if (jsonType(v) !== "number" || !/^-?(0|[1-9][0-9]{0,8})$/.test(jsonbText(v))) return false;
      const n = Number(v);
      return d.min_value !== null && d.max_value !== null && n >= d.min_value && n <= d.max_value;
    }
    case "decimal": {
      if (jsonType(v) !== "string") return false;
      const s = v as string;
      if (!new RegExp(`^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,${d.scale}})?$`).test(s)) return false;
      const n = Number(s);
      return d.min_value !== null && d.max_value !== null && n >= d.min_value && n <= d.max_value;
    }
    case "text": {
      if (jsonType(v) !== "string") return false;
      const s = v as string;
      if ((d.max_length !== null && pgLength(s) > d.max_length) || /[\x01-\x1f\x7f]/.test(s) || /^ | $/.test(s)) return false;
      if (s === "" || d.format === "plain") return true;
      if (d.format === "email") return EMAIL.test(s);
      if (d.format === "digits") return /^[0-9]+$/.test(s) && pgLength(s) >= (d.min_length ?? 1) && pgLength(s) <= (d.max_length ?? 0);
      const parts = s.split(",");
      return parts.length <= (d.max_items ?? 0) && parts.every((p) => EMAIL.test(p.replace(/^ +| +$/g, "")));
    }
    case "textarea": {
      if (jsonType(v) !== "string") return false;
      const s = v as string;
      return (d.max_length === null || pgLength(s) <= d.max_length) && !/[\x01-\x09\x0b-\x1f\x7f]/.test(s) && !/^[ \n]|[ \n]$/.test(s);
    }
    case "users": {
      if (jsonType(v) !== "array" || (d.max_items !== null && (v as unknown[]).length > d.max_items)) return false;
      let prev: string | null = null;
      for (const e of v as unknown[]) {
        if (jsonType(e) !== "string" || !UUID_LOWER.test(e as string) || (prev !== null && compareText(e as string, prev) <= 0)) return false;
        prev = e as string;
      }
      return true;
    }
    case "keymap": {
      const options = (d.options ?? {}) as { actions?: string[]; keys?: unknown };
      const actions = options.actions ?? [];
      if (jsonType(v) !== "object" || Object.keys(v as object).length !== actions.length) return false;
      const map = v as Record<string, unknown>;
      if (actions.some((a) => !(a in map) || jsonType(map[a]) !== "string" || !has(options.keys, map[a] as string))) return false;
      return new Set(actions.map((a) => map[a])).size === actions.length;
    }
    case "documents": {
      if (jsonType(v) !== "array" || (d.max_items !== null && (v as unknown[]).length > d.max_items)) return false;
      const seen = new Set<string>();
      for (const e of v as Record<string, unknown>[]) {
        if (
          jsonType(e) !== "object" ||
          Object.keys(e).length !== 2 ||
          !("document" in e && "name" in e) ||
          jsonType(e.document) !== "string" ||
          jsonType(e.name) !== "string"
        )
          return false;
        const s = e.document as string,
          t = e.name as string;
        if (!(validCpf(s) || validCnpj(s)) || seen.has(s)) return false;
        if (pgLength(t) > 80 || /[\x01-\x1f\x7f]/.test(t) || /^ | $/.test(t)) return false;
        seen.add(s);
      }
      return true;
    }
    default:
      return false;
  }
}
