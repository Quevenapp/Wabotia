import { catalogParts } from "./part-context.ts";
import { projectCatalogRecord } from "./part-projection.ts";
// Vendedores (erp_catalog.seller): regras que outros domínios chamam.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { actorLabel, gateRequired, windowOpen } from "../access/public.ts";
import { compareText, contactText, percentValid } from "./fields.ts";
import { fromColumn, formatScaled, toParam, toScaled } from "../../engine/dec.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { isTechnicalUser } from "../access/identity.ts";

/**
 * erp_catalog.seller_access_allowed(p_user_id, p_at): o usuário vinculado a
 * um vendedor com horário de acesso só entra dentro de uma janela (hora e
 * dia de São Paulo, pela windowOpen do Acesso). Sem vendedor, sem horário
 * ligado ou sem janelas: liberado.
 */
export function sellerAccessAllowed(db: SqlDriver, user: string | null, at: bigint): boolean {
  if (user === null || isTechnicalUser(db, user)) return true;
  const s = one(db, 'SELECT access_hours_enabled, access_windows FROM "erp_catalog__seller" WHERE user_id=?', user);
  if (!s) return true;
  const windows = JSON.parse(String(s.access_windows));
  return !Number(s.access_hours_enabled) || windows.length === 0 || windowOpen(windows, at);
}

/**
 * erp_catalog.seller_users(): as pessoas ativas do ERP (até 500, por data de
 * entrada e id), para vincular um vendedor a um usuário.
 * Porte da sessão B (auxiliares do Catálogo).
 */
export function sellerUsers(db: SqlDriver): Record<string, unknown>[] {
  return db
    .exec('SELECT user_id, role, CAST(created_at AS TEXT) created_at FROM "erp_access__membership" WHERE active=1')
    .rows.filter((m) => !isTechnicalUser(db, String(m.user_id))).sort((a, b) => {
      const x = BigInt(String(a.created_at)),
        y = BigInt(String(b.created_at));
      return x < y ? -1 : x > y ? 1 : compareText(String(a.user_id), String(b.user_id));
    })
    .slice(0, 500)
    .map((m) => ({ user_id: m.user_id, name: actorLabel(db, String(m.user_id)), role: m.role }));
}

/**
 * erp_catalog.seller_access(p_user_id, p_write): ler vendedores é de admin,
 * consulta, vendas e financeiro; escrever, só do administrador. Devolve o papel.
 * Porte da sessão B (auxiliares do Catálogo).
 */
export function sellerAccess(db: SqlDriver, user: string | null, write: boolean): string {
  const m = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  const role = (m?.role as string | undefined) ?? null;
  if (role === null || !(write ? role === "admin" : ["admin", "consulta", "vendas", "financeiro"].includes(role)))
    raise("42501", "erp_catalog_access_denied");
  return role!;
}

/** erp_catalog.seller_dto(p_id): as configurações do vendedor (decimais em texto com 4 casas). */
export function sellerDto(db: SqlDriver, id: string, internal = false): Record<string, unknown> | null {
  const s = one(
    db,
    `SELECT id, contact_id, CAST(version AS TEXT) version, user_id, allow_unregistered_products, view_stock, access_hours_enabled,
     access_windows, modules, commission_rule, commission_mode, CAST(commission_rate AS TEXT) commission_rate, commission_bands,
     CAST(discount_limit AS TEXT) discount_limit, notes, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at
     FROM "erp_catalog__seller" WHERE id=?`,
    id,
  );
  if (!s) return null;
  const dec = (v: unknown) => (v === null ? null : formatScaled(fromColumn(v), 4));
  const linked = s.user_id === null || isTechnicalUser(db, String(s.user_id)) ? null : s.user_id;
  const result = {
    id: s.id,
    contact_id: s.contact_id,
    version: Number(s.version),
    user_id: linked,
    user_name: linked === null ? null : actorLabel(db, String(linked)),
    allow_unregistered_products: !!Number(s.allow_unregistered_products),
    view_stock: !!Number(s.view_stock),
    access_hours_enabled: !!Number(s.access_hours_enabled),
    access_windows: JSON.parse(String(s.access_windows)),
    modules: JSON.parse(String(s.modules)),
    commission_rule: s.commission_rule,
    commission_mode: s.commission_mode,
    commission_rate: dec(s.commission_rate),
    commission_bands: JSON.parse(String(s.commission_bands)),
    discount_limit: dec(s.discount_limit),
    notes: s.notes,
    created_at: jsonTimestamp(String(s.created_at)),
    updated_at: jsonTimestamp(String(s.updated_at)),
  };
  return internal ? result : projectCatalogRecord(catalogParts(db), "sellers", result);
}

// ---------------------------------------------------------------------------
// Gravação do vendedor (bloco D dos auxiliares, sessão B).

/** erp_catalog.seller_module_keys(): os módulos que o vendedor pode ver. */
export const SELLER_MODULE_KEYS = [
  "clientes", "clientes_limite_credito", "clientes_ver_clientes", "clientes_ver_fornecedores", "clientes_ver_tecnicos", "clientes_ver_transportadores",
  "clientes_ver_vendedores", "clientes_ver_desenvolvedores", "listas_precos", "comissoes", "controle_caixa", "frente_caixa", "pdv_registro_itens",
  "pdv_registro_pagamento", "pdv_fechamento", "pdv_editar_preco", "pdv_exclusao_itens", "pdv_alterar_forma_pagamento", "pdv_gerenciador_pos",
  "pedidos_venda", "pedidos_exportar", "pedidos_alterar_forma_pagamento", "visualizacao_lote", "propostas", "propostas_outros_vendedores",
  "propostas_alterar_status", "propostas_exportar", "gerenciador_arquivos", "relatorio_controle_caixa", "relatorio_saldos_estoque", "relatorio_vendas",
  "relatorio_visao_financeira_estoque", "ordens_servico", "os_alterar_forma_pagamento", "os_permitir_exclusao",
];

/** erp_catalog.seller_contact_fields(): os campos do contato que o formulário de vendedor mostra (Campos obrigatórios). */
export const SELLER_CONTACT_FIELDS = [
  "name", "code", "trade_name", "person_type", "document", "taxpayer", "ie", "rg", "birth_date", "country", "postal_code", "state", "city",
  "district", "street", "number", "complement", "phone", "mobile", "email",
];

const SETTING_KEYS = [
  "user_id", "allow_unregistered_products", "view_stock", "access_hours_enabled", "access_windows", "modules", "commission_rule",
  "commission_mode", "commission_rate", "commission_bands", "discount_limit", "notes",
];
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
type Json = Record<string, unknown>;
const kind = (v: unknown) =>
  v === undefined ? null : v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;
/** numeric(7,4)::text de um percentual já validado. */
const pct = (v: string) => formatScaled(toScaled(v, 4), 4);

/**
 * erp_catalog.seller_settings(p): confere as configurações do vendedor (as 12
 * chaves, janelas de horário, módulos, comissão e limite de desconto) e devolve
 * a forma gravada: módulos só os ligados, percentuais com 4 casas, faixas em ordem.
 */
export function sellerSettings(p: unknown): Json {
  const bad = (what = "") => raise("22023", `erp_catalog_seller_invalid${what}`);
  if (kind(p) !== "object") bad();
  const s = p as Json;
  const keys = Object.keys(s);
  if (keys.some((k) => !SETTING_KEYS.includes(k)) || keys.length !== SETTING_KEYS.length) bad();
  if (s.user_id !== null && (typeof s.user_id !== "string" || !LOWER_UUID.test(s.user_id))) bad(":user_id");
  if (kind(s.allow_unregistered_products) !== "boolean" || kind(s.view_stock) !== "boolean" || kind(s.access_hours_enabled) !== "boolean")
    bad(":flags");
  if (kind(s.access_windows) !== "array" || (s.access_windows as unknown[]).length > 20) bad(":access_windows");
  for (const w of s.access_windows as unknown[]) {
    const x = w as Json;
    const days = kind(w) === "object" ? (x.days as unknown) : null;
    if (
      kind(w) !== "object" ||
      Object.keys(x).length !== 3 ||
      !("start" in x && "end" in x && "days" in x) ||
      typeof x.start !== "string" ||
      typeof x.end !== "string" ||
      !TIME.test(x.start) ||
      !TIME.test(x.end) ||
      x.start >= x.end ||
      kind(days) !== "array" ||
      (days as unknown[]).length < 1 ||
      (days as unknown[]).length > 7 ||
      (days as unknown[]).some((d) => typeof d !== "number" || !["0", "1", "2", "3", "4", "5", "6"].includes(jsonbText(d))) ||
      new Set((days as unknown[]).map(jsonbText)).size !== (days as unknown[]).length
    )
      bad(":access_windows");
  }
  if (kind(s.modules) !== "object" || Object.entries(s.modules as Json).some(([k, v]) => !SELLER_MODULE_KEYS.includes(k) || typeof v !== "boolean"))
    bad(":modules");
  if (
    typeof s.commission_rule !== "string" ||
    !["parcial", "faturamento", "primeira_parcela", "ultima_parcela"].includes(s.commission_rule) ||
    typeof s.commission_mode !== "string" ||
    !["fixa", "descontos"].includes(s.commission_mode)
  )
    bad(":commission");
  if (!percentValid(s.commission_rate, true) || !percentValid(s.discount_limit, false)) bad(":percent");
  if (kind(s.commission_bands) !== "array" || (s.commission_bands as unknown[]).length > 20) bad(":commission_bands");
  let previous = -1n;
  for (const b of s.commission_bands as unknown[]) {
    const x = b as Json;
    if (
      kind(b) !== "object" ||
      Object.keys(x).length !== 2 ||
      !("discount_up_to" in x && "rate" in x) ||
      !percentValid(x.discount_up_to, false) ||
      !percentValid(x.rate, false) ||
      toScaled(x.discount_up_to as string, 4) <= previous
    )
      bad(":commission_bands");
    previous = toScaled(x.discount_up_to as string, 4);
  }
  const notes = contactText("notes", s.notes, 4000, true);
  const modules: Json = {};
  for (const k of Object.keys(s.modules as Json).sort(compareText)) if ((s.modules as Json)[k] === true) modules[k] = true;
  return {
    user_id: s.user_id,
    allow_unregistered_products: s.allow_unregistered_products,
    view_stock: s.view_stock,
    access_hours_enabled: s.access_hours_enabled,
    access_windows: s.access_windows,
    modules,
    commission_rule: s.commission_rule,
    commission_mode: s.commission_mode,
    commission_rate: s.commission_rate === null ? null : pct(s.commission_rate as string),
    commission_bands: (s.commission_bands as Json[])
      .map((b) => ({ discount_up_to: pct(b.discount_up_to as string), rate: pct(b.rate as string) }))
      .sort((a, b) => (toScaled(a.discount_up_to, 4) < toScaled(b.discount_up_to, 4) ? -1 : 1)),
    discount_limit: pct(s.discount_limit as string),
    notes,
  };
}

/**
 * erp_catalog.seller_write(p_user_id, p_seller_id, p_contact_id, p): grava as
 * configurações (já conferidas por sellerSettings). Pessoa vinculada precisa
 * estar ativa e não pode ter outro vendedor. Devolve o id do vendedor.
 */
export function sellerWrite(ctx: RpcContext, user: string, sellerId: string | null, contactId: string, p: Json): string {
  const db = ctx.db;
  const linked = p.user_id as string | null;
  if (linked !== null) {
    if (isTechnicalUser(db, linked)) raise("22023", "erp_catalog_seller_invalid:user_id");
    if (!one(db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', linked)) raise("22023", "erp_catalog_seller_invalid:user_id");
    if (one(db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE user_id=? AND id IS NOT ?', linked, sellerId)) raise("23505", "erp_catalog_seller_user_taken");
  }
  const dec = (v: unknown) => (v === null ? null : toParam(toScaled(v as string, 4)));
  const values = [
    linked, p.allow_unregistered_products ? 1 : 0, p.view_stock ? 1 : 0, p.access_hours_enabled ? 1 : 0, jsonbText(p.access_windows),
    jsonbText(p.modules), p.commission_rule, p.commission_mode, dec(p.commission_rate), jsonbText(p.commission_bands), dec(p.discount_limit),
    p.notes,
  ];
  const now = ctx.clock.next().toString();
  if (sellerId === null) {
    const id = crypto.randomUUID();
    db.exec(
      `INSERT INTO "erp_catalog__seller"(id, contact_id, user_id, allow_unregistered_products, view_stock, access_hours_enabled, access_windows,
       modules, commission_rule, commission_mode, commission_rate, commission_bands, discount_limit, notes, version, created_by, updated_by,
       created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      id, contactId, ...values, user, user, now, now,
    );
    return id;
  }
  db.exec(
    `UPDATE "erp_catalog__seller" SET user_id=?, allow_unregistered_products=?, view_stock=?, access_hours_enabled=?, access_windows=?,
     modules=?, commission_rule=?, commission_mode=?, commission_rate=?, commission_bands=?, discount_limit=?, notes=?, version=version+1,
     updated_by=?, updated_at=? WHERE id=?`,
    ...values, user, now, sellerId,
  );
  return sellerId;
}

/** erp_catalog.seller_values(p_id): o seller_dto sem identidade, versão e carimbos (para comparar com sellerSettings). */
export function sellerValues(db: SqlDriver, id: string): Json | null {
  const dto = sellerDto(db, id, true);
  if (dto === null) return null;
  const { id: _i, contact_id: _c, version: _v, user_name: _n, created_at: _a, updated_at: _u, ...rest } = dto;
  return rest;
}

/** erp_catalog.seller_access_gates(p_users): se cada pessoa passa pelo portão de acesso (horário, segundo fator). */
export function sellerAccessGates(db: SqlDriver, users: unknown): Json[] {
  const list = kind(users) === "array" ? (users as unknown[]) : [];
  return list
    .map((u) => (typeof u === "string" ? u : jsonbText(u)))
    .filter((u) => LOWER_UUID.test(u))
    .sort(compareText)
    .map((u) => ({ user_id: u, gate_required: gateRequired(db, u) }));
}
