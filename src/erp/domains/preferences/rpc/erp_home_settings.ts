// Início (erp_home): gráficos e atalhos por usuário, produtos a vencer e a
// central de notificações. public.erp_home_charts_get, _charts_save,
// _shortcuts_get, _shortcuts_save, _expiring, _notifications e
// _notifications_read. O gatilho guard_notification é cumprido aqui: a
// notificação só muda ao ser lida.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { PG_CNTRL, pgBtrim, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../../engine/time.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { memberRole, resourcesForRole } from "../../access/public.ts";
import { allowed as catalogAllowed, requireAccess as catalogRequireAccess } from "../../catalog/public.ts";
import { allowed as documentsAllowed } from "../../documents/public.ts";
import { int, json, text, uuid } from "../args.ts";
import { frameworkHash } from "../framework.ts";
import { NOTIFICATION_TYPES, addDays, expiringProducts, expiryDays, notificationDigest, notificationRecipient, notificationRoles } from "../home-notifications.ts";
import { compareText } from "../order.ts";
import { saoPauloMidnight } from "../time.ts";

/** erp_home.require_member */
function requireMember(db: SqlDriver, user: string | null): string {
  const r = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r) raise("42501", "erp_home_access_denied");
  return String(r.role);
}

const CHART_KEYS = ["resumo", "ticket_medio", "valor_faturado", "quantidade_pedidos", "top_skus"];
const topProductsAllowed = (role: string) => documentsAllowed(role, "sales_orders", false) && catalogAllowed(role, "products", false);
const availableCharts = (role: string) => CHART_KEYS.filter((k) => k !== "top_skus" || topProductsAllowed(role));

/** erp_home.charts_view */
function chartsView(db: SqlDriver, user: string, role: string) {
  const c = one(db, 'SELECT charts, version FROM "erp_home__chart_preference" WHERE user_id=?', user);
  const list = c ? (JSON.parse(String(c.charts)) as string[]) : CHART_KEYS;
  const available = availableCharts(role);
  return {
    scope: "home_charts",
    data_mode: "erp_native",
    role,
    version: c ? Number(c.version) : 0,
    customized: !!c,
    charts: list.filter((k) => available.includes(k)),
    available,
  };
}

export function erpHomeChartsGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  return chartsView(ctx.db, user!, requireMember(ctx.db, user));
}

export function erpHomeChartsSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const expected = int(a, "p_expected_version");
  const charts = json(a, "p_charts") as unknown[] | null;
  const db = ctx.db;
  const role = requireMember(db, user);
  const invalid = (): never => raise("22023", "erp_home_charts_invalid");
  if (
    command === null ||
    expected === null ||
    expected < 0 ||
    expected >= 2147483647 ||
    charts === null ||
    jsonType(charts) !== "array" ||
    charts.length > 5 ||
    charts.some((e) => jsonType(e) !== "string" || !CHART_KEYS.includes(e as string))
  )
    invalid();
  const list = charts as string[];
  if (new Set(list).size !== list.length) invalid();
  if (list.some((e) => !availableCharts(role).includes(e))) raise("42501", "erp_home_chart_forbidden");
  const hash = frameworkHash({ op: "charts", actor: user, version: expected, charts });
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_home__shortcut_command" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_home_command_conflict");
    return { ...chartsView(db, user!, role), receipt: JSON.parse(String(stored.result)), replayed: true };
  }
  const row = one(db, 'SELECT charts, version FROM "erp_home__chart_preference" WHERE user_id=?', user);
  if ((row ? Number(row.version) : 0) !== expected) raise("40001", "erp_home_charts_version_conflict");
  const version = expected! + 1;
  const at = ctx.clock.next().toString();
  if (!row)
    db.exec('INSERT INTO "erp_home__chart_preference"(user_id, charts, version, created_at, updated_at) VALUES (?,?,?,?,?)', user, JSON.stringify(list), version, at, at);
  else db.exec('UPDATE "erp_home__chart_preference" SET charts=?, version=?, updated_at=? WHERE user_id=?', JSON.stringify(list), version, at, user);
  const result = { command_id: command, version, charts: list, changed_at: jsonTimestamp(ctx.clock.next().toString()) };
  db.exec('INSERT INTO "erp_home__shortcut_command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)', command, user, hash, jsonbText(result), at);
  db.exec(
    'INSERT INTO "erp_home__shortcut_audit"(actor, command_id, before_data, after_data, created_at) VALUES (?,?,?,?,?)',
    user,
    command,
    row ? jsonbText({ version: Number(row.version), charts: JSON.parse(String(row.charts)) }) : null,
    jsonbText({ version, charts: list }),
    at,
  );
  return { ...chartsView(db, user!, role), receipt: result, replayed: false };
}

/** erp_home.shortcut_catalog(): ordinal, caminho, papéis (null: todos) e recurso exigido. */
const SHORTCUTS: [number, string, string[] | null, string | null][] = (() => {
  const all = ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"];
  const noVendas = ["admin", "consulta", "financeiro", "estoque", "fiscal"];
  const fin = ["admin", "consulta", "financeiro"];
  const sales = ["admin", "consulta", "vendas", "financeiro"];
  const fiscal = ["admin", "consulta", "fiscal"];
  const rows: [string, string[] | null, string | null][] = [
    ["/meu-negocio?painel=mensal", all, null],
    ["/meu-negocio?painel=margem-pedido", noVendas, null],
    ["/painel-produtos-empresa", ["admin", "consulta", "vendas", "estoque", "fiscal"], null],
    ["/meu-negocio?painel=novos-recorrentes", all, null],
    ["/meu-negocio?painel=curva-abc", all, null],
    ["/meu-negocio?painel=metas", all, null],
    ["/cadastros-reais?cadastro=products", null, "products"],
    ["/cadastros-reais?cadastro=contacts", null, "contacts"],
    ["/vendedores-empresa", sales, null],
    ["/funcionarios-empresa", ["admin"], null],
    ["/financeiro-empresa?area=contas-financeiras", fin, null],
    ["/financeiro-empresa?area=categories", fin, null],
    ["/formas-pagamento-empresa", sales, null],
    ["/categorias-produtos", null, "products"],
    ["/listas-precos", null, "products"],
    ["/documentos-empresa?tipo=sales_orders", all, null],
    ["/historico-fiscal?modelo=55", fiscal, null],
    ["/historico-fiscal?modelo=65", fiscal, null],
    ["/frente-caixa-empresa", sales, null],
    ["/documentos-empresa?tipo=sales_proposals", sales, null],
    ["/documentos-empresa?tipo=service_orders", sales, null],
    ["/documentos-empresa?tipo=service_orders&acao=relatorios", sales, null],
    ["/documentos-empresa?tipo=sales_orders&acao=checkout", ["admin", "vendas"], null],
    ["/documentos-empresa?tipo=sales_orders&acao=relatorios", all, null],
    ["/documentos-empresa?tipo=purchase_orders", noVendas, null],
    ["/notas-entrada", fiscal, null],
    ["/cadastros-reais?cadastro=contacts&contato=fornecedor", null, "contacts"],
    ["/painel-produtos-empresa?painel=sugestao", ["admin", "consulta", "estoque", "fiscal"], null],
    ["/checkin-recebimentos", ["admin", "estoque", "fiscal"], null],
    ["/estoque-empresa", ["admin", "consulta", "vendas", "estoque", "fiscal"], null],
    ["/conferencia-estoque-empresa", ["admin", "estoque"], null],
    ["/cadastros-reais?cadastro=warehouses", ["admin", "consulta", "estoque"], null],
    ["/relatorios-estoque", ["admin", "consulta", "vendas", "estoque", "fiscal"], null],
    ["/financeiro-empresa?area=accounts", fin, null],
    ["/financeiro-empresa?area=payable", fin, null],
    ["/financeiro-empresa?area=receivable", fin, null],
    ["/financeiro-empresa?area=remessas", fin, null],
    ["/financeiro-empresa?area=ficha", fin, null],
    ["/financeiro-empresa?area=comissoes", fin, null],
    ["/financeiro-empresa?area=controle-caixa", fin, null],
    ["/financeiro-empresa?area=faturamento-agrupado", fin, null],
    ["/financeiro-empresa?area=relatorios", fin, null],
  ];
  return rows.map(([path, roles, resource], i) => [i + 1, path, roles, resource]);
})();

const DEFAULT_SHORTCUTS = [
  "/documentos-empresa?tipo=sales_orders",
  "/historico-fiscal?modelo=55",
  "/cadastros-reais?cadastro=products",
  "/cadastros-reais?cadastro=contacts",
  "/financeiro-empresa?area=receivable",
  "/financeiro-empresa?area=payable",
];

/** erp_home.shortcut_allowed(role, path) */
function shortcutAllowed(role: string, path: string | null) {
  const c = path === null ? undefined : SHORTCUTS.find((s) => s[1] === path);
  return !!c && (c[2] === null || c[2].includes(role)) && (c[3] === null || resourcesForRole(role).includes(c[3]));
}

const BY_LENGTH = [...SHORTCUTS].sort((x, y) => y[1].length - x[1].length);
const keysOf = (query: string) => query.split("&").map((p) => p.split("=")[0]);

/** erp_home.shortcut_base(link): o caminho do catálogo de que o link deriva (filtros extras aceitos), ou null. */
function shortcutBase(link: string | null): string | null {
  if (link === null || pgLength(link) > 200) return null;
  for (const [, path] of BY_LENGTH) {
    if (link === path) return path;
    if (link.startsWith(path + (path.includes("?") ? "&" : "?"))) {
      const extra = link.slice(path.length + 1);
      if (!/^[a-z_]{1,30}=[A-Za-z0-9_.:,-]{1,60}(&[a-z_]{1,30}=[A-Za-z0-9_.:,-]{1,60}){0,7}$/.test(extra)) continue;
      const keys = keysOf(extra);
      const baseKeys = path.includes("?") ? keysOf(path.split("?")[1]) : [];
      if (new Set(keys).size === keys.length && !keys.some((k) => baseKeys.includes(k))) return path;
    }
  }
  return null;
}

const availableShortcuts = (role: string) => SHORTCUTS.filter((c) => shortcutAllowed(role, c[1])).map((c) => c[1]);
const visibleShortcuts = (role: string, list: string[]) => list.filter((s) => shortcutAllowed(role, shortcutBase(s)));
function visibleLabels(role: string, list: string[], labels: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const s of list) if (s in labels && shortcutAllowed(role, shortcutBase(s))) out[s] = labels[s];
  return out;
}

export function erpHomeShortcutsGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const role = requireMember(ctx.db, user);
  const row = one(ctx.db, 'SELECT shortcuts, labels, version FROM "erp_home__shortcut_preference" WHERE user_id=?', user);
  const list = row ? (JSON.parse(String(row.shortcuts)) as string[]) : DEFAULT_SHORTCUTS;
  const labels = row ? (JSON.parse(String(row.labels)) as Record<string, unknown>) : {};
  return {
    scope: "home_shortcuts",
    data_mode: "erp_native",
    role,
    version: row ? Number(row.version) : 0,
    customized: !!row,
    shortcuts: visibleShortcuts(role, list),
    labels: visibleLabels(role, list, labels),
    available: availableShortcuts(role),
  };
}

export function erpHomeShortcutsSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const expected = int(a, "p_expected_version");
  const shortcuts = json(a, "p_shortcuts") as unknown[] | null;
  const labelsIn = json(a, "p_labels") as Record<string, unknown> | null;
  const db = ctx.db;
  const role = requireMember(db, user);
  const invalid = (): never => raise("22023", "erp_home_shortcuts_invalid");
  if (
    command === null ||
    expected === null ||
    expected < 0 ||
    expected >= 2147483647 ||
    shortcuts === null ||
    jsonType(shortcuts) !== "array" ||
    shortcuts.length > 20 ||
    shortcuts.some((e) => jsonType(e) !== "string") ||
    (labelsIn !== null && (jsonType(labelsIn) !== "object" || Object.keys(labelsIn).length > 20))
  )
    invalid();
  const list = shortcuts as string[];
  if (new Set(list).size !== list.length || list.some((e) => shortcutBase(e) === null)) invalid();
  const labels: Record<string, string> = {};
  const given = labelsIn ?? {};
  for (const k of jsonbKeys(given)) {
    const v = given[k];
    if (!list.includes(k) || jsonType(v) !== "string") invalid();
    const s = v as string;
    if (pgLength(s) < 1 || pgLength(s) > 60 || s !== pgBtrim(s) || pgHasCntrl.test(s)) invalid();
    labels[k] = s;
  }
  if (list.some((e) => !shortcutAllowed(role, shortcutBase(e)))) raise("42501", "erp_home_shortcut_forbidden");
  const hash = frameworkHash({
    op: "shortcuts",
    actor: user,
    version: expected,
    shortcuts,
    ...(Object.keys(labels).length ? { labels } : {}),
  });
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_home__shortcut_command" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_home_command_conflict");
    const result = JSON.parse(String(stored.result)) as Record<string, unknown>;
    return {
      ...result,
      scope: "home_shortcuts",
      data_mode: "erp_native",
      role,
      labels: result.labels ?? {},
      available: availableShortcuts(role),
      replayed: true,
    };
  }
  const row = one(db, 'SELECT shortcuts, labels, version FROM "erp_home__shortcut_preference" WHERE user_id=?', user);
  if ((row ? Number(row.version) : 0) !== expected) raise("40001", "erp_home_shortcuts_version_conflict");
  const version = expected! + 1;
  const at = ctx.clock.next().toString();
  if (!row)
    db.exec(
      'INSERT INTO "erp_home__shortcut_preference"(user_id, shortcuts, labels, version, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      user,
      JSON.stringify(list),
      jsonbText(labels),
      version,
      at,
      at,
    );
  else
    db.exec(
      'UPDATE "erp_home__shortcut_preference" SET shortcuts=?, labels=?, version=?, updated_at=? WHERE user_id=?',
      JSON.stringify(list),
      jsonbText(labels),
      version,
      at,
      user,
    );
  const result = { version, customized: true, shortcuts: list, labels };
  db.exec('INSERT INTO "erp_home__shortcut_command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)', command, user, hash, jsonbText(result), at);
  db.exec(
    'INSERT INTO "erp_home__shortcut_audit"(actor, command_id, before_data, after_data, created_at) VALUES (?,?,?,?,?)',
    user,
    command,
    row ? jsonbText({ version: Number(row.version), shortcuts: JSON.parse(String(row.shortcuts)), labels: JSON.parse(String(row.labels)) }) : null,
    jsonbText({ version, shortcuts: list, labels }),
    at,
  );
  return { ...result, scope: "home_shortcuts", data_mode: "erp_native", role, available: availableShortcuts(role), replayed: false };
}

const CNTRL_ALL = new RegExp(PG_CNTRL, "gu");

export function erpHomeExpiring(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  catalogRequireAccess(db, uuid(a, "p_user_id"), "products", false);
  const today = todaySaoPaulo();
  const days = expiryDays(db);
  const all = expiringProducts(db, null, addDays(today, days));
  const items = all
    .sort((x, y) => compareText(x.expiry_date, y.expiry_date) || compareText(pgLower(x.name), pgLower(y.name)) || compareText(x.id, y.id))
    .slice(0, 20)
    .map((x) => ({
      product_id: x.id,
      code: x.code === null ? null : pgLeft(x.code, 60),
      name: pgLeft(x.name.replace(CNTRL_ALL, " "), 200),
      expiry_date: x.expiry_date,
      expired: x.expiry_date < today,
    }));
  return { scope: "product_expiry", data_mode: "erp_native", business_date: today, days, total: all.length, items };
}

/** erp_home.notification_dto */
const notificationDto = (n: Record<string, unknown>) => ({
  id: String(n.id),
  type: n.type,
  day: n.day,
  quantity: Number(n.quantity),
  amount: n.amount === null ? null : formatScaled(fromColumn(n.amount), 2),
  created_at: jsonTimestamp(String(n.created_at)),
  read: n.read_at !== null,
});

/** erp_home.notifications_view */
function notificationsView(db: SqlDriver, user: string, role: string, tab: string) {
  const mine = db
    .exec(
      `SELECT id, type, day, quantity, CAST(amount AS TEXT) amount, CAST(created_at AS TEXT) created_at, read_at FROM "erp_home__notification"
       WHERE user_id=? ORDER BY created_at DESC, id DESC`,
      user,
    )
    .rows.filter((n) => notificationRoles(String(n.type)).includes(role));
  return {
    scope: "notifications",
    data_mode: "erp_native",
    tab,
    role,
    business_date: todaySaoPaulo(),
    unread: mine.filter((n) => n.read_at === null).length,
    items: mine.filter((n) => tab === "todas" || n.read_at === null).slice(0, 100).map(notificationDto),
  };
}

export function erpHomeNotifications(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const tab = text(a, "p_tab");
  const db = ctx.db;
  const role = memberRole(db, user);
  if (tab === null || !["nao_lidas", "todas"].includes(tab)) raise("22023", "erp_home_notifications_input_invalid");
  const today = todaySaoPaulo();
  const a1Limit = saoPauloMidnight(addDays(today, 31));
  for (const t of NOTIFICATION_TYPES) {
    if (!notificationRecipient(db, user!, role, t) || one(db, 'SELECT 1 x FROM "erp_home__notification" WHERE user_id=? AND type=? AND day=?', user, t, today))
      continue;
    const d = notificationDigest(db, t, today, a1Limit);
    if (d.quantity > 0)
      db.exec(
        'INSERT INTO "erp_home__notification"(user_id, type, day, quantity, amount, created_at) VALUES (?,?,?,?,?,?)',
        user,
        t,
        today,
        d.quantity,
        d.amount === null ? null : d.amount.toString(),
        ctx.clock.next().toString(),
      );
  }
  return notificationsView(db, user!, role, tab!);
}

export function erpHomeNotificationsRead(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const ids = json(a, "p_ids") as unknown[] | null;
  const db = ctx.db;
  const role = memberRole(db, user);
  if (
    command === null ||
    (ids !== null &&
      (jsonType(ids) !== "array" ||
        ids.length < 1 ||
        ids.length > 100 ||
        ids.some((x) => jsonType(x) !== "string" || !/^[1-9][0-9]{0,17}$/.test(x as string))))
  )
    raise("22023", "erp_home_notifications_input_invalid");
  const hash = frameworkHash({ profile: "erp-home-notifications-read-v1", actor: user, ids });
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_home__notification_command" WHERE id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_home_notifications_command_conflict");
    return { ...(JSON.parse(String(stored.result)) as object), view: notificationsView(db, user!, role, "nao_lidas"), replayed: true };
  }
  const list = ids === null ? null : (ids as string[]).map((x) => BigInt(x));
  if (list !== null && list.some((i) => !one(db, 'SELECT 1 x FROM "erp_home__notification" WHERE id=? AND user_id=?', i.toString(), user)))
    raise("P0002", "erp_home_notification_not_found");
  const targets = db
    .exec('SELECT id, type FROM "erp_home__notification" WHERE user_id=? AND read_at IS NULL', user)
    .rows.filter((n) => notificationRoles(String(n.type)).includes(role) && (list === null || list.includes(BigInt(n.id as number))));
  const at = ctx.clock.next();
  const result = {
    scope: "notifications_command",
    data_mode: "erp_native",
    receipt: { command_id: command, all: ids === null, marked: targets.length, changed_at: jsonTimestamp(at.toString()) },
  };
  db.exec('INSERT INTO "erp_home__notification_command"(id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)', command, user, hash, jsonbText(result), at.toString());
  for (const n of targets) db.exec('UPDATE "erp_home__notification" SET read_at=?, read_command=? WHERE id=?', at.toString(), command, n.id);
  return { ...result, view: notificationsView(db, user!, role, "nao_lidas"), replayed: false };
}

registerRpc("erp_home_charts_get", erpHomeChartsGet);
registerRpc("erp_home_charts_save", erpHomeChartsSave);
registerRpc("erp_home_shortcuts_get", erpHomeShortcutsGet);
registerRpc("erp_home_shortcuts_save", erpHomeShortcutsSave);
registerRpc("erp_home_expiring", erpHomeExpiring);
registerRpc("erp_home_notifications", erpHomeNotifications);
registerRpc("erp_home_notifications_read", erpHomeNotificationsRead);
