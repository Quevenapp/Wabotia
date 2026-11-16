// Relatórios customizados (migrações 149, 230, 264 e 284) na fixture dupla. Adaptados de reports-labels-sql.test.mjs do Fagoo:
// "149 relatórios…" (catálogo, bases por papel e diretório; erp_preferences_report_run ainda roda só no oráculo, então as
// linhas, totais e recusas do run ficam com o oráculo), "149 relatórios customizados…" e "149 review…".
// Adaptações: o catálogo é o final (25 bases, REPORT_CATALOG do motor contra erp_preferences.report_catalog()); o diretório
// conta os membros ativos da fixture; updates diretos de membership passam pela cópia.
// Fora, declarados: GRANT/has_function_privilege.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { sameJson, parseReports, captureReportSave, captureFrameworkDelete, parseFrameworkResult } from "../../../src/erp/fagoo/packages/erp-domain/src/reports-labels.mjs";
import { REPORT_CATALOG } from "../../../src/erp/domains/preferences/report-catalog.ts";

const fails = (assert, fn, code) => assert.rejects(fn, (e) => e.code === code);
const reports = async (f, user = f.users.admin) => parseReports(await f.rpc("erp_preferences_reports", { p_user_id: user }));
const save = async (f, body, user = f.users.admin) => {
  const s = captureReportSave(body);
  return parseFrameworkResult(
    await f.rpc("erp_preferences_report_save", { p_user_id: user, p_command_id: s.command_id, p_report: s.id, p_expected_version: s.expected_version, p_data: s.data }),
    s,
    "report-save",
  );
};
const remove = async (f, body) => {
  const s = captureFrameworkDelete(body);
  return parseFrameworkResult(
    await f.rpc("erp_preferences_framework_delete", { p_user_id: f.users.admin, p_command_id: s.command_id, p_target: "reports", p_items: s.items }),
    s,
    "reports-delete",
  );
};
const reportBody = (patch = {}) => ({
  command_id: randomUUID(),
  id: null,
  expected_version: 0,
  data: { base: "vendas", title: "Vendas por cliente", columns: ["numero", "contato", "total"], filters: [], view_limit: 2000, with_totals: true, users: [], ...patch },
});

test("149 relatórios: the SQL catalog is the engine catalog and the bases follow the module rules", async () => {
  const f = await dualFixture();
  try {
    const sql = await f.scalar("select erp_preferences.report_catalog() v");
    assert.ok(sameJson(sql, JSON.parse(JSON.stringify(REPORT_CATALOG))));
    const admin = await reports(f);
    assert.deepEqual(admin.bases.map((b) => b.base), REPORT_CATALOG.map((b) => b.base));
    assert.equal(admin.can_manage, true);
    const active = (await f.db.query("select count(*)::int n from erp_access.membership where active")).rows[0].n;
    assert.equal(admin.directory.length, active);
    const vendas = await reports(f, f.users.vendas);
    assert.ok(!vendas.bases.some((b) => ["contas_receber", "contas_pagar", "pedidos_compra"].includes(b.base)));
    assert.equal(vendas.directory, null);
    assert.ok(!(await reports(f, f.users.estoque)).bases.some((b) => b.base.startsWith("contas_")));
    for (const role of ["consulta", "financeiro", "fiscal", "vendedor"]) await reports(f, f.users[role]);
    await fails(assert, () => reports(f, f.users.inactive), "42501");
    await fails(assert, () => reports(f, randomUUID()), "42501");
  } finally {
    await f.close();
  }
});

test("149 relatórios customizados: Salvar with title, columns, filters and users by command and version; who sees them; Excluir by version", async () => {
  const f = await dualFixture();
  try {
    const body = reportBody({ users: [f.users.vendas] }),
      created = await save(f, body);
    assert.equal((await save(f, body)).replayed, true);
    await fails(
      assert,
      () =>
        f.rpc("erp_preferences_report_save", { p_user_id: f.users.admin, p_command_id: body.command_id, p_report: null, p_expected_version: 0, p_data: { ...body.data, title: "Outro" } }),
      "40001",
    );
    await fails(assert, () => save(f, reportBody({ title: "vendas POR cliente" })), "23505");
    await fails(assert, () => save(f, reportBody({ title: "Por vendas" }), f.users.vendas), "42501");
    await fails(assert, () => save(f, reportBody({ title: "Inativo", users: [f.users.inactive] })), "22023");
    const id = created.receipt.target;
    let list = await reports(f);
    const saved = list.reports.find((r) => r.id === id);
    assert.deepEqual([saved.title, saved.columns, saved.users, saved.version], ["Vendas por cliente", ["numero", "contato", "total"], [f.users.vendas], 1]);
    assert.deepEqual((await reports(f, f.users.vendas)).reports.map((r) => r.id), [id]);
    assert.deepEqual((await reports(f, f.users.consulta)).reports, []);
    const edit = { command_id: randomUUID(), id, expected_version: 1, data: { ...body.data, title: "Vendas da Ana", filters: [{ column: "contato", value: "Ana" }], users: [] } };
    await save(f, edit);
    await fails(assert, () => save(f, { ...edit, command_id: randomUUID() }), "40001");
    await fails(assert, () => save(f, { command_id: randomUUID(), id, expected_version: 2, data: { ...edit.data, base: "propostas" } }), "22023");
    await fails(assert, () => save(f, { command_id: randomUUID(), id, expected_version: 2, data: edit.data }), "22023");
    assert.deepEqual((await reports(f, f.users.vendas)).reports, []);
    // Fronteiras da definição (direto no RPC, sem o contrato do pacote).
    const raw = (data) =>
      f.rpc("erp_preferences_report_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_report: null, p_expected_version: 0, p_data: { ...reportBody().data, title: "Borda", ...data } });
    for (const data of [
      { columns: [] },
      { columns: ["numero", "numero"] },
      { columns: ["inexistente"] },
      { base: "inexistente" },
      { filters: [{ column: "total", value: "dez" }] },
      { filters: [{ column: "contato", value: " x" }] },
      { filters: [{ column: "inexistente", value: "x" }] },
      { filters: [{ column: "total" }] },
      { view_limit: 2001 },
      { view_limit: 0 },
      { with_totals: "true" },
      { users: ["X"] },
      { users: [f.users.vendas, f.users.vendas] },
      { title: "a".repeat(81) },
    ])
      await fails(assert, () => raw(data), "22023");
    const okTotal = await raw({ title: "Total exato", filters: [{ column: "total", value: "-10.5" }] });
    assert.equal(okTotal.replayed, false);
    list = await reports(f);
    const items = list.reports.map((r) => ({ id: r.id, expected_version: r.version }));
    await fails(assert, () => remove(f, { command_id: randomUUID(), items: [{ id, expected_version: 1 }] }), "40001");
    assert.equal((await remove(f, { command_id: randomUUID(), items: [{ id, expected_version: 2 }] })).receipt.count, 1);
    assert.deepEqual((await reports(f)).reports.map((r) => r.id), items.filter((i) => i.id !== id).map((i) => i.id));
    await fails(assert, () => remove(f, { command_id: randomUUID(), items: [{ id: randomUUID(), expected_version: 1 }] }), "P0002");
    for (const items of [[], [{ id: "X", expected_version: 1 }], [{ id, expected_version: 0 }], [{ id }]])
      await fails(
        assert,
        () => f.rpc("erp_preferences_framework_delete", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_target: "reports", p_items: items }),
        "22023",
      );
    await fails(
      assert,
      () => f.rpc("erp_preferences_framework_delete", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_target: "tags", p_items: [{ id, expected_version: 1 }] }),
      "22023",
    );
    const audit = (await f.db.query("select action,before_data is null b,after_data is null a from erp_preferences.framework_audit where area='reports' order by id")).rows;
    assert.deepEqual(
      audit.map((r) => [r.action, r.b, r.a]),
      [
        ["report_create", true, false],
        ["report_update", false, false],
        ["report_create", true, false],
        ["report_delete", false, true],
      ],
    );
  } finally {
    await f.close();
  }
});

test("149 review: a report user who lost access never locks the report; adding someone without access is still refused", async () => {
  const f = await dualFixture();
  try {
    const save = (id, version, data) =>
      f.rpc("erp_preferences_report_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_report: id, p_expected_version: version, p_data: data });
    const data = { base: "vendas", title: "Relatório sintético", columns: ["numero", "total"], filters: [], view_limit: 10, with_totals: false, users: [f.users.vendas, f.users.financeiro].sort() };
    const id = (await save(null, 0, data)).receipt.target;
    await f.db.query("update erp_access.membership set active=false where user_id=$1", [f.users.vendas]);
    await f.sync();
    assert.equal((await save(id, 1, { ...data, title: "Relatório sintético 2" })).replayed, false, "other fields still change");
    await fails(assert, () => save(id, 2, { ...data, users: [...data.users, f.users.inactive].sort() }), "22023");
    await save(id, 2, { ...data, users: [f.users.financeiro] });
    const list = await f.rpc("erp_preferences_reports", { p_user_id: f.users.admin });
    assert.deepEqual(list.reports.find((r) => r.id === id).users, [f.users.financeiro]);
    // A new report refuses users without access, as before.
    await fails(assert, () => save(null, 0, { ...data, title: "Outro", users: [f.users.vendas] }), "22023");
  } finally {
    await f.close();
  }
});
