// Relatórios customizados (migrações 149, 230, 264 e 284): public.erp_preferences_reports,
// _report_save e _report_run (as linhas vêm de report-source.ts).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLength, pgLower } from "../../../engine/text.ts";
import { compareDec, formatScaled, toScaled } from "../../../engine/dec.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { accessRequireAdmin, permitted, requirePermission } from "../../access/public.ts";
import { allowed as catalogAllowed } from "../../catalog/public.ts";
import { allowed as documentsAllowed, reportCoverage } from "../../documents/public.ts";
import { int, json, text, uuid } from "../args.ts";
import { directory, readerRole } from "../center.ts";
import { frameworkHash, frameworkKeys, frameworkReplay, frameworkText, frameworkVersion } from "../framework.ts";
import { compareText } from "../order.ts";
import { REPORT_CATALOG } from "../report-catalog.ts";
import { reportSource } from "../report-source.ts";
import { reportDto } from "./erp_preferences_framework_delete.ts";

const FIN = ["admin", "financeiro", "consulta"];
const NOTES = ["admin", "consulta", "fiscal"];

/** erp_preferences.report_allowed(role, base) */
export function reportAllowed(role: string, base: string): boolean {
  switch (base) {
    case "produtos":
      return catalogAllowed(role, "products", false);
    case "contatos":
    case "pessoas_contato":
      return catalogAllowed(role, "contacts", false);
    case "contas_receber":
    case "contas_pagar":
    case "recebimentos":
    case "pagamentos":
    case "comissoes":
    case "caixa":
    case "ficha_receber":
    case "ficha_pagar":
      return FIN.includes(role);
    case "vendas":
    case "venda_parcela":
    case "curva_abc":
    case "ocorrencias_vendas":
    case "transporte_venda":
      return documentsAllowed(role, "sales_orders", false);
    case "propostas":
    case "ocorrencias_propostas":
      return documentsAllowed(role, "sales_proposals", false);
    case "pedidos_compra":
      return documentsAllowed(role, "purchase_orders", false);
    case "ordens_servico":
    case "ocorrencias_os":
      return documentsAllowed(role, "service_orders", false);
    case "notas_saida":
    case "notas_entrada":
    case "nfce":
    case "transporte_nota":
      return NOTES.includes(role);
    default:
      return false;
  }
}

/** erp_preferences.report_permission(base) */
const REPORT_PERMISSION: Record<string, string> = {
  produtos: "cadastros.produtos",
  contatos: "cadastros.clientes_fornecedores",
  contas_receber: "financas.contas_receber",
  contas_pagar: "financas.contas_pagar",
  vendas: "vendas.pedidos_venda",
  propostas: "vendas.propostas",
  pedidos_compra: "suprimentos.pedidos_compra",
  ordens_servico: "servicos.ordem_servico",
  notas_saida: "vendas.notas_fiscais",
  notas_entrada: "suprimentos.notas_entrada",
  nfce: "vendas.nfce",
  recebimentos: "financas.contas_receber",
  pagamentos: "financas.contas_pagar",
  venda_parcela: "vendas.pedidos_venda",
  comissoes: "vendas.comissoes",
  caixa: "financas.caixas_bancos",
  curva_abc: "vendas.pedidos_venda",
  pessoas_contato: "cadastros.clientes_fornecedores",
  ficha_receber: "financas.ficha",
  ficha_pagar: "financas.ficha",
  ocorrencias_propostas: "vendas.propostas",
  ocorrencias_os: "servicos.ordem_servico",
  ocorrencias_vendas: "vendas.pedidos_venda",
  transporte_venda: "vendas.pedidos_venda",
  transporte_nota: "vendas.notas_fiscais",
};

/** erp_preferences.report_visible(user, role, base) */
export function reportVisible(db: SqlDriver, user: string, role: string, base: string) {
  const key = REPORT_PERMISSION[base];
  return reportAllowed(role, base) && permitted(db, user, "outros.relatorios_customizados") && key !== undefined && permitted(db, user, key);
}

export function erpPreferencesReports(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const db = ctx.db;
  const role = readerRole(db, user);
  requirePermission(db, user!, "outros.relatorios_customizados");
  const reports = db
    .exec('SELECT * FROM "erp_preferences__report"')
    .rows.filter((r) => reportVisible(db, user!, role, String(r.base)) && (role === "admin" || (JSON.parse(String(r.users)) as string[]).includes(user!)))
    .sort((x, y) => compareText(pgLower(String(x.title)), pgLower(String(y.title))) || compareText(String(x.id), String(y.id)))
    .map(reportDto);
  return {
    scope: "reports",
    data_mode: "erp_native",
    can_manage: role === "admin",
    bases: REPORT_CATALOG.filter((b) => reportVisible(db, user!, role, b.base)),
    reports,
    directory: role === "admin" ? directory(ctx) : null,
  };
}

const definitionInvalid = (): never => raise("22023", "erp_preferences_report_definition_invalid");

/** erp_preferences.report_check(base, columns, filters) */
function reportCheck(baseId: string, columns: unknown, filters: unknown) {
  const b = REPORT_CATALOG.find((x) => x.base === baseId);
  if (
    !b ||
    jsonType(columns) !== "array" ||
    (columns as unknown[]).length < 1 ||
    (columns as unknown[]).length > 30 ||
    jsonType(filters) !== "array" ||
    (filters as unknown[]).length > 10 ||
    (columns as unknown[]).some((c) => jsonType(c) !== "string" || !b.columns.some((k) => k.id === c)) ||
    new Set(columns as string[]).size !== (columns as unknown[]).length
  )
    definitionInvalid();
  for (const f of filters as Record<string, unknown>[]) {
    if (!frameworkKeys(f, ["column", "value"]) || jsonType(f.column) !== "string" || jsonType(f.value) !== "string") definitionInvalid();
    const type = b!.columns.find((k) => k.id === f.column)?.type ?? null;
    frameworkText(f.value, 100);
    if (type === null || (["money", "decimal", "int"].includes(type) && !/^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$/.test(f.value as string))) definitionInvalid();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function erpPreferencesReportSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const report = uuid(a, "p_report");
  const expected = int(a, "p_expected_version");
  const data = json(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  const limit = data === null ? null : frameworkVersion(data.view_limit);
  if (
    command === null ||
    expected === null ||
    expected < 0 ||
    expected > 2147483646 ||
    (report === null) !== (expected === 0) ||
    !frameworkKeys(data, ["base", "columns", "filters", "title", "users", "view_limit", "with_totals"]) ||
    jsonType(data!.base) !== "string" ||
    jsonType(data!.with_totals) !== "boolean" ||
    limit === null ||
    limit > 2000 ||
    jsonType(data!.users) !== "array" ||
    (data!.users as unknown[]).length > 100 ||
    (data!.users as unknown[]).some((u) => jsonType(u) !== "string" || !UUID.test(u as string))
  )
    raise("22023", "erp_preferences_report_input_invalid");
  const base = data!.base as string;
  reportCheck(base, data!.columns, data!.filters);
  const title = frameworkText(data!.title, 80);
  const given = data!.users as string[];
  const users = [...new Set(given)].sort(compareText);
  if (users.length !== given.length) raise("22023", "erp_preferences_report_users_invalid");
  const hash = frameworkHash({ op: "report_save", actor: user, id: report, version: expected, data });
  const replay = frameworkReplay(db, command!, user!, "reports", hash);
  if (replay) return replay;
  if (db.exec('SELECT id, title FROM "erp_preferences__report"').rows.some((r) => pgLower(String(r.title)) === pgLower(title) && r.id !== report))
    raise("23505", "erp_preferences_report_title_taken");
  let id: string;
  let row: Record<string, unknown> | undefined;
  if (report === null) {
    if (Number(one(db, 'SELECT count(*) n FROM "erp_preferences__report"')!.n) >= 200) raise("22023", "erp_preferences_report_limit");
    id = crypto.randomUUID();
  } else {
    row = one(db, 'SELECT * FROM "erp_preferences__report" WHERE id=?', report);
    if (!row) raise("P0002", "erp_preferences_report_not_found");
    if (Number(row.version) !== expected) raise("40001", "erp_preferences_report_version_conflict");
    if (row.base !== base) raise("22023", "erp_preferences_report_base_fixed");
    id = report;
  }
  // Usuários: quem entra agora precisa ser membro ativo; quem já estava e perdeu o acesso pode ficar (ou sair).
  const before = row ? (JSON.parse(String(row.users)) as string[]) : [];
  if (users.some((u) => !before.includes(u) && !one(db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1', u)))
    raise("22023", "erp_preferences_report_users_invalid");
  const beforeDto = row ? reportDto(row) : null;
  const same = (x: ReturnType<typeof reportDto>) => jsonbText({ ...x, version: null, updated_at: null });
  const next = {
    title,
    columns: jsonbText(data!.columns),
    filters: jsonbText(data!.filters),
    view_limit: limit,
    with_totals: data!.with_totals ? 1 : 0,
    users: JSON.stringify(users),
  };
  if (beforeDto && same(beforeDto) === same(reportDto({ ...row!, ...next }))) raise("22023", "erp_preferences_report_unchanged");
  const at = ctx.clock.next().toString();
  const result = {
    scope: "reports_command",
    data_mode: "erp_native",
    receipt: { command_id: command, action: report === null ? "report_create" : "report_update", target: id, count: 1, changed_at: jsonTimestamp(at) },
  };
  db.exec(
    'INSERT INTO "erp_preferences__framework_command"(id, actor, area, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    "reports",
    hash,
    jsonbText(result),
    at,
  );
  if (report === null)
    db.exec(
      `INSERT INTO "erp_preferences__report"(id, base, title, columns, filters, view_limit, with_totals, users, version, created_at, created_by, updated_at, updated_by, command_id, title__fold)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
      id,
      base,
      title,
      next.columns,
      next.filters,
      limit,
      next.with_totals,
      next.users,
      at,
      user,
      at,
      user,
      command,
      pgLower(title),
    );
  else
    db.exec(
      `UPDATE "erp_preferences__report" SET title=?, columns=?, filters=?, view_limit=?, with_totals=?, users=?, version=version+1, updated_at=?, updated_by=?,
       command_id=?, title__fold=? WHERE id=?`,
      title,
      next.columns,
      next.filters,
      limit,
      next.with_totals,
      next.users,
      at,
      user,
      command,
      pgLower(title),
      id,
    );
  const after = one(db, 'SELECT * FROM "erp_preferences__report" WHERE id=?', id)!;
  db.exec(
    `INSERT INTO "erp_preferences__framework_audit"(created_at, actor, command_id, area, action, target, before_data, after_data) VALUES (?,?,?,?,?,?,?,?)`,
    at,
    user,
    command,
    "reports",
    result.receipt.action,
    id,
    beforeDto === null ? null : jsonbText(beforeDto),
    jsonbText(reportDto(after)),
  );
  return { ...result, replayed: false };
}

/** Soma de decimais em texto como o sum(numeric) do Postgres: escala = a maior das parcelas. */
function decSum(values: string[]): string {
  if (values.length === 0) return "0";
  const scale = Math.max(...values.map((v) => (v.includes(".") ? v.split(".")[1].length : 0)));
  return formatScaled(
    values.reduce((s, v) => s + toScaled(v, scale), 0n),
    scale,
  );
}

const REPORT_KIND: Record<string, string> = {
  vendas: "sales_orders", venda_parcela: "sales_orders", curva_abc: "sales_orders", ocorrencias_vendas: "sales_orders", transporte_venda: "sales_orders",
  propostas: "sales_proposals", ocorrencias_propostas: "sales_proposals", pedidos_compra: "purchase_orders", ordens_servico: "service_orders", ocorrencias_os: "service_orders",
};

export function erpPreferencesReportRun(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const role = readerRole(db, user);
  const base = text(a, "p_base");
  if (base === null || !reportVisible(db, user!, role, base)) raise("42501", "erp_preferences_report_access_denied");
  const columns = json(a, "p_columns") as string[];
  const filters = json(a, "p_filters") as { column: string; value: string }[];
  reportCheck(base!, columns, filters);
  const limit = int(a, "p_view_limit");
  const page = int(a, "p_page");
  const offset = int(a, "p_offset");
  if (limit === null || limit < 1 || limit > 2000 || page === null || page < 1 || page > 200 || offset === null || offset < 0 || offset >= Math.max(limit, 1))
    raise("22023", "erp_preferences_report_page_invalid");
  const b = REPORT_CATALOG.find((x) => x.base === base)!;
  const type = (col: string) => b.columns.find((k) => k.id === col)?.type ?? null;
  const numeric = (t: string | null) => t !== null && ["money", "decimal", "int"].includes(t);
  const src = reportSource(db, base!)
    .filter((s) =>
      filters.every((f) => {
        const v = s.data[f.column] ?? null;
        if (numeric(type(f.column))) return v !== null && compareDec(v, f.value) === 0;
        return pgLower(v ?? "").includes(pgLower(f.value));
      }),
    )
    // row_number() over(order by sort_key): nulos por último.
    .sort((x, y) => (x.sort === null ? (y.sort === null ? 0 : 1) : y.sort === null ? -1 : compareText(x.sort, y.sort)));
  const rows: unknown[][] = [];
  let acc = 0;
  for (let n = offset! + 1; n <= Math.min(offset! + page!, limit!) && n <= src.length; n++) {
    const line = columns.map((c) => src[n - 1].data[c] ?? null);
    acc += pgLength(jsonbText(line));
    // A página para antes de 180 kB de linhas (a tela pede a próxima a partir de offset + linhas).
    if (acc > 180000) break;
    rows.push(line);
  }
  const totals: Record<string, string> = {};
  for (const c of columns)
    if (["money", "decimal"].includes(type(c) ?? ""))
      totals[c] = decSum(
        src
          .slice(0, limit!)
          .map((s) => s.data[c] ?? null)
          .filter((v): v is string => v !== null),
      );
  const kind = REPORT_KIND[base!];
  return {
    scope: "report_rows",
    data_mode: "erp_native",
    base,
    columns,
    rows,
    offset,
    total_rows: Math.min(src.length, limit!),
    truncated: src.length > limit!,
    totals,
    ...(kind ? reportCoverage() : {}),
  };
}

registerRpc("erp_preferences_report_run", erpPreferencesReportRun);
registerRpc("erp_preferences_reports", erpPreferencesReports);
registerRpc("erp_preferences_report_save", erpPreferencesReportSave);
