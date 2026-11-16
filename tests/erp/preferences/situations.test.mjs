// Situações e transições (migração 148): workers/erp-api/test/system-frameworks-sql.test.mjs do Fagoo na fixture dupla.
// Adaptações: o oráculo tem todas as migrações (a 148 testada num estado posterior), então as listas de situações
// e as contagens de transições são as do estado final; a adoção entra por SQL direto e passa pela cópia.
// Fora, declarados: as leituras de erp_preferences.transition_rule e situation_of (funções internas do motor de
// documentos, sem RPC) e "148 situações RPCs: only service_role executes them; the history is immutable" (GRANT e o
// gatilho de trilha imutável, acionado só por SQL direto; no motor a trilha só recebe INSERT).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import {
  parseSituationsPage,
  captureSituationsQuery,
  captureSituationSave,
  captureTransitionSave,
  captureTransitionsDelete,
  parseSituationsResult,
} from "../../../src/erp/fagoo/packages/erp-domain/src/system-frameworks.mjs";

const fails = (assert, fn, code) => assert.rejects(fn, (e) => e.code === code);
const page = async (f, kind, user = f.users.admin) =>
  parseSituationsPage(await f.rpc("erp_preferences_situations", { p_user_id: user, p_kind: kind }), captureSituationsQuery({ tipo: kind }));
const saveSituation = async (f, body, user = f.users.admin) => {
  const s = captureSituationSave(body);
  return parseSituationsResult(
    await f.rpc("erp_preferences_situation_save", {
      p_user_id: user,
      p_command_id: s.command_id,
      p_kind: s.kind,
      p_situation: s.id,
      p_expected_version: s.expected_version,
      p_data: s.data,
    }),
    s,
    "situation",
  );
};
const saveTransition = async (f, body, user = f.users.admin) => {
  const s = captureTransitionSave(body);
  return parseSituationsResult(
    await f.rpc("erp_preferences_transition_save", {
      p_user_id: user,
      p_command_id: s.command_id,
      p_kind: s.kind,
      p_from: s.from,
      p_to: s.to,
      p_expected_version: s.expected_version,
      p_data: s.data,
    }),
    s,
    "transition",
  );
};
const removeTransitions = async (f, body) => {
  const s = captureTransitionsDelete(body);
  return parseSituationsResult(
    await f.rpc("erp_preferences_transitions_delete", { p_user_id: f.users.admin, p_command_id: s.command_id, p_kind: s.kind, p_items: s.items }),
    s,
    "delete",
  );
};
const situation = (kind, patch = {}) => ({
  command_id: randomUUID(),
  kind,
  id: null,
  expected_version: 0,
  data: { base_status: "open", name: "Aguardando pagamento", color: "#ff8800", active: true, ...patch },
});

test("148 situações: the defaults come from the document rule; a custom situação is based on one, unique by name, CAS and idempotent", async () => {
  const f = await dualFixture();
  try {
    const sales = await page(f, "sales_orders");
    assert.deepEqual(sales.situations.slice(0, 3).map((s) => s.name), ["Em digitação", "Em aberto", "Verificado"]);
    // O oráculo tem a adoção dos documentos (163); a 148 sozinha mostrava false.
    assert.equal(sales.adopted, (await f.db.query("select 1 from erp_preferences.situation_adoption where kind='sales_orders'")).rows.length > 0);
    assert.ok(sales.transitions.every((t) => t.default && t.active && t.version === 0 && !t.actions.length));
    assert.deepEqual(sales.rules.partially_fulfilled, ["in_progress", "partially_invoiced", "fulfilled", "cancelled"]);
    assert.deepEqual((await page(f, "service_orders")).situations.map((s) => s.name).slice(0, 3), ["Em aberto", "Orçada", "Aprovada"]);
    assert.equal((await page(f, "purchase_orders")).transitions.length, 16);
    for (const user of [f.users.vendas, f.users.consulta, f.users.inactive, randomUUID()]) await fails(assert, () => page(f, "sales_orders", user), "42501");
    await fails(assert, () => f.rpc("erp_preferences_situations", { p_user_id: f.users.admin, p_kind: "sales_proposals" }), "22023");
    const body = situation("sales_orders"),
      created = await saveSituation(f, body);
    assert.equal(created.replayed, false);
    const replay = await saveSituation(f, body);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.target, created.receipt.target);
    await fails(
      assert,
      () =>
        f.rpc("erp_preferences_situation_save", {
          p_user_id: f.users.admin,
          p_command_id: body.command_id,
          p_kind: "sales_orders",
          p_situation: null,
          p_expected_version: 0,
          p_data: { ...body.data, name: "Outro nome" },
        }),
      "40001",
    );
    await fails(assert, () => saveSituation(f, situation("sales_orders")), "23505");
    await fails(assert, () => saveSituation(f, situation("sales_orders", { name: "em aberto" })), "23505");
    assert.equal((await saveSituation(f, situation("purchase_orders"))).receipt.kind, "purchase_orders", "the same name in another tab");
    await fails(assert, () => saveSituation(f, situation("sales_orders", { name: "Sem base", base_status: "quoted" })), "22023");
    await fails(assert, () => saveSituation(f, situation("sales_orders", { name: "Pelo vendedor" }), f.users.vendas), "42501");
    const key = created.receipt.target;
    let view = await page(f, "sales_orders");
    const custom = view.situations.find((s) => s.key === key);
    assert.deepEqual([custom.base_status, custom.name, custom.default, custom.active, custom.version], ["open", "Aguardando pagamento", false, true, 1]);
    assert.equal(view.situations.findIndex((s) => s.key === key), 2, "listed right after its base");
    // Editing: Nome, Cor and ativa; "Baseada em" is fixed; a stale version conflicts; the same values are refused.
    await saveSituation(f, { command_id: randomUUID(), kind: "sales_orders", id: key, expected_version: 1, data: { base_status: "open", name: "Aguardando PIX", color: "#00aa00", active: false } });
    await fails(
      assert,
      () => saveSituation(f, { command_id: randomUUID(), kind: "sales_orders", id: key, expected_version: 1, data: { base_status: "open", name: "De novo", color: "#00aa00", active: true } }),
      "40001",
    );
    await fails(
      assert,
      () =>
        saveSituation(f, { command_id: randomUUID(), kind: "sales_orders", id: key, expected_version: 2, data: { base_status: "verified", name: "Aguardando PIX", color: "#00aa00", active: false } }),
      "22023",
    );
    await fails(
      assert,
      () => saveSituation(f, { command_id: randomUUID(), kind: "sales_orders", id: key, expected_version: 2, data: { base_status: "open", name: "Aguardando PIX", color: "#00aa00", active: false } }),
      "22023",
    );
    await fails(
      assert,
      () => saveSituation(f, { command_id: randomUUID(), kind: "purchase_orders", id: key, expected_version: 2, data: { base_status: "open", name: "Outra aba", color: "#00aa00", active: true } }),
      "P0002",
    );
    view = await page(f, "sales_orders");
    assert.deepEqual(view.situations.filter((s) => !s.default).map((s) => [s.name, s.active, s.version]), [["Aguardando PIX", false, 2]]);
    // Limit of 30 custom situações per tab.
    const bases = view.situations.length - 1;
    for (let i = 0; i < 29; i++) await saveSituation(f, situation("sales_orders", { name: `Situação ${i}` }));
    await fails(assert, () => saveSituation(f, situation("sales_orders", { name: "Trigésima primeira" })), "22023");
    assert.equal((await page(f, "sales_orders")).situations.length, bases + 30);
    const audit = await f.db.query("select action,target,before_data,after_data from erp_preferences.framework_audit where area='situations' order by id limit 2");
    assert.deepEqual(audit.rows.map((r) => r.action), ["situation_create", "situation_create"]);
    assert.equal(audit.rows[0].before_data, null);
    assert.equal(audit.rows[0].after_data.name, "Aguardando pagamento");
  } finally {
    await f.close();
  }
});

test("148 transições: custom pairs follow the base rule, default ones are only deactivated, actions wait for adoption and deletions are by version", async () => {
  const f = await dualFixture();
  try {
    const a = (await saveSituation(f, situation("purchase_orders", { name: "Aguardando NF" }))).receipt.target;
    const b = (await saveSituation(f, situation("purchase_orders", { name: "Recebido conferido", base_status: "fulfilled" }))).receipt.target;
    const base = (await page(f, "purchase_orders")).transitions.length;
    // open → partially_fulfilled is not allowed by the purchase rule; open → Aguardando NF (same base) and Aguardando NF → in_progress are.
    const c = (await saveSituation(f, situation("purchase_orders", { name: "Parcial conferido", base_status: "partially_fulfilled" }))).receipt.target;
    await fails(assert, () => saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: a, to: c, expected_version: 0, data: { active: true, actions: [] } }), "22023");
    await fails(
      assert,
      () => saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "open", to: "partially_fulfilled", expected_version: 0, data: { active: true, actions: [] } }),
      "22023",
    );
    const body = { command_id: randomUUID(), kind: "purchase_orders", from: "open", to: a, expected_version: 0, data: { active: true, actions: [] } };
    await saveTransition(f, body);
    assert.equal((await saveTransition(f, body)).replayed, true);
    await saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: a, to: "in_progress", expected_version: 0, data: { active: true, actions: [] } });
    await fails(
      assert,
      () => saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "open", to: a, expected_version: 0, data: { active: false, actions: [] } }),
      "40001",
    );
    await fails(
      assert,
      () => saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "open", to: randomUUID(), expected_version: 0, data: { active: true, actions: [] } }),
      "P0002",
    );
    let view = await page(f, "purchase_orders");
    const custom = view.transitions.find((t) => t.from === "open" && t.to === a);
    assert.deepEqual([custom.default, custom.active, custom.actions], [false, true, []]);
    assert.equal(view.transitions.length, base + 2);
    assert.ok(b);
    // Actions are refused until the documents lane adopts the kind.
    const adopted = (await f.db.query("select count(*)::int n from erp_preferences.situation_adoption where kind='purchase_orders'")).rows[0].n > 0;
    if (!adopted)
      await fails(
        assert,
        () => saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "in_progress", to: "fulfilled", expected_version: 0, data: { active: true, actions: ["post_stock"] } }),
        "22023",
      );
    // A default transition is deactivated by overriding it; it cannot be deleted.
    await saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "fulfilled", to: "open", expected_version: 0, data: { active: false, actions: [] } });
    await fails(
      assert,
      () => saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "cancelled", to: "open", expected_version: 0, data: { active: true, actions: [] } }),
      "22023",
    );
    view = await page(f, "purchase_orders");
    const off = view.transitions.find((t) => t.from === "fulfilled" && t.to === "open");
    assert.deepEqual([off.default, off.active], [true, false]);
    assert.ok(off.version > 0);
    await fails(assert, () => removeTransitions(f, { command_id: randomUUID(), kind: "purchase_orders", items: [{ from: "fulfilled", to: "open", expected_version: off.version }] }), "22023");
    if (!adopted) {
      await f.db.query("insert into erp_preferences.situation_adoption(kind,migration)values('purchase_orders','202610200160')");
      await f.sync();
    }
    await saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "in_progress", to: "fulfilled", expected_version: 0, data: { active: true, actions: ["post_finance", "post_stock"] } });
    // The contract refuses opposite actions; the SQL refuses them too.
    assert.throws(
      () =>
        captureTransitionSave({ command_id: randomUUID(), kind: "purchase_orders", from: "fulfilled", to: "open", expected_version: off.version, data: { active: true, actions: ["post_stock", "reverse_stock"] } }),
      /ERP_INVALID_INPUT/,
    );
    await fails(
      assert,
      () =>
        f.rpc("erp_preferences_transition_save", {
          p_user_id: f.users.admin,
          p_command_id: randomUUID(),
          p_kind: "purchase_orders",
          p_from: "fulfilled",
          p_to: "open",
          p_expected_version: off.version,
          p_data: { active: true, actions: ["post_stock", "reverse_stock"] },
        }),
      "22023",
    );
    view = await page(f, "purchase_orders");
    assert.equal(view.adopted, true);
    assert.deepEqual(view.transitions.find((t) => t.from === "in_progress" && t.to === "fulfilled").actions, ["post_finance", "post_stock"]);
    // A deactivated situação keeps its transitions listed.
    await saveSituation(f, { command_id: randomUUID(), kind: "purchase_orders", id: a, expected_version: 1, data: { base_status: "open", name: "Aguardando NF", color: "#ff8800", active: false } });
    // Excluir selecionados: all or nothing, each by version; a pair created again gets a version never used before.
    view = await page(f, "purchase_orders");
    const items = view.transitions.filter((t) => !t.default).map((t) => ({ from: t.from, to: t.to, expected_version: t.version }));
    assert.equal(items.length, 2);
    await fails(
      assert,
      () => removeTransitions(f, { command_id: randomUUID(), kind: "purchase_orders", items: [items[0], { ...items[1], expected_version: items[1].expected_version + 100 }] }),
      "40001",
    );
    assert.equal((await page(f, "purchase_orders")).transitions.filter((t) => !t.default).length, 2);
    const removed = await removeTransitions(f, { command_id: randomUUID(), kind: "purchase_orders", items });
    assert.equal(removed.receipt.count, 2);
    assert.equal((await page(f, "purchase_orders")).transitions.filter((t) => !t.default).length, 0);
    await saveTransition(f, { command_id: randomUUID(), kind: "purchase_orders", from: "open", to: a, expected_version: 0, data: { active: true, actions: [] } });
    const again = (await page(f, "purchase_orders")).transitions.find((t) => t.from === "open" && t.to === a);
    assert.ok(again.version > Math.max(...items.map((i) => i.expected_version)));
    await fails(assert, () => removeTransitions(f, { command_id: randomUUID(), kind: "purchase_orders", items: [items.find((i) => i.from === "open")] }), "40001");
    // Fronteiras do porte: p_items nulo passa com count nulo (como no Postgres); objeto, vazio e repetidos são recusados.
    const nul = await f.rpc("erp_preferences_transitions_delete", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: "purchase_orders", p_items: null });
    assert.equal(nul.receipt.count, null);
    for (const items of [{}, [], [{ from: "open", to: a, expected_version: 1 }, { from: "open", to: a, expected_version: 2 }], [{ from: "open", to: a, expected_version: 0 }], [{ from: "open", to: a, expected_version: 1.5 }]])
      await fails(assert, () => f.rpc("erp_preferences_transitions_delete", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: "purchase_orders", p_items: items }), "22023");
    const audit = (await f.db.query("select action from erp_preferences.framework_audit where area='situations' and action like 'transition%' order by id")).rows.map((r) => r.action);
    assert.deepEqual(audit, ["transition_save", "transition_save", "transition_save", "transition_save", "transition_delete", "transition_delete", "transition_save"]);
  } finally {
    await f.close();
  }
});

test("148 entradas de borda: textos, cores, versões e ações fora do contrato", async () => {
  const f = await dualFixture();
  try {
    const call = (data, extra = {}) =>
      f.rpc("erp_preferences_situation_save", {
        p_user_id: f.users.admin,
        p_command_id: randomUUID(),
        p_kind: "service_orders",
        p_situation: null,
        p_expected_version: 0,
        p_data: data,
        ...extra,
      });
    const ok = { base_status: "quoted", name: "Orçamento enviado", color: "#123abc", active: true };
    for (const bad of [
      { ...ok, name: " Orçamento" },
      { ...ok, name: "" },
      { ...ok, name: "a".repeat(41) },
      { ...ok, name: "linha\u0085" },
      { ...ok, color: "#123ABC" },
      { ...ok, active: false },
      { ...ok, base_status: "inexistente" },
      { ...ok, extra: 1 },
      { ...ok, active: "true" },
    ])
      await fails(assert, () => call(bad), "22023");
    await fails(assert, () => call(ok, { p_situation: randomUUID() }), "22023");
    await fails(assert, () => call(ok, { p_expected_version: 2147483647, p_situation: randomUUID() }), "22023");
    await fails(assert, () => call(ok, { p_kind: "sales_proposals" }), "22023");
    await fails(assert, () => call({ ...ok, name: "ORÇADA" }), "23505");
    const made = await call({ ...ok, name: "a".repeat(40) });
    assert.equal(made.replayed, false);
    const t = (data, from = "open", to = "quoted") =>
      f.rpc("erp_preferences_transition_save", {
        p_user_id: f.users.admin,
        p_command_id: randomUUID(),
        p_kind: "service_orders",
        p_from: from,
        p_to: to,
        p_expected_version: 0,
        p_data: data,
      });
    for (const bad of [
      { active: true, actions: ["post_stock", "post_stock"] },
      { active: true, actions: ["post_finance", "reverse_finance"] },
      { active: true, actions: ["x"] },
      { active: true, actions: [1] },
      { active: true, actions: ["post_stock", "post_finance", "reverse_stock"] },
      { active: true },
    ])
      await fails(assert, () => t(bad), "22023");
    await fails(assert, () => t({ active: true, actions: [] }, "open", "open"), "22023");
    await fails(assert, () => t({ active: true, actions: [] }), "22023"); // a padrão sem mudança
    await t({ active: true, actions: [] }, made.receipt.target, "open");
    await t({ active: false, actions: [] }, "open", made.receipt.target);
  } finally {
    await f.close();
  }
});
