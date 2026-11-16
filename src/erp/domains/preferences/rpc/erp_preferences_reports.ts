// Relatórios customizados (migrações 149, 230, 264 e 284): public.erp_preferences_reports
// e _report_save. (_report_run lê as bases pelo report_source, que depende de
// funções ainda em stub no Financeiro e no Catálogo.)
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLower } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { accessRequireAdmin, permitted, requirePermission } from "../../access/public.ts";
import { allowed as catalogAllowed } from "../../catalog/public.ts";
import { allowed as documentsAllowed } from "../../documents/public.ts";
import { int, json, uuid } from "../args.ts";
import { directory, readerRole } from "../center.ts";
import { frameworkHash, frameworkKeys, frameworkReplay, frameworkText, frameworkVersion } from "../framework.ts";
import { compareText } from "../order.ts";
import { REPORT_CATALOG } from "../report-catalog.ts";
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

registerRpc("erp_preferences_reports", erpPreferencesReports);
registerRpc("erp_preferences_report_save", erpPreferencesReportSave);
