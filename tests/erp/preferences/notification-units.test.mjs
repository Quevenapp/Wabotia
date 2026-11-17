// notificationDigestFor + notifyMember (preferences/shared.ts), as unidades do agendador do ERP: chamadas usuário a
// usuário, deixam erp_home.notification igual ao erp_platform_notifications_run de uma vez (que o diferencial confere
// contra o oráculo). As unidades rodam só no motor e são desfeitas antes do run, para os dois motores seguirem iguais.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { activeMembers, NOTIFICATION_TYPES, notificationDigestFor, notifyMember } from "../../../src/erp/domains/preferences/shared.ts";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());
const today = () => f.scalar("select to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD') v");
const rows = () =>
  f.driver
    .exec(`SELECT user_id, type, day, quantity, CAST(amount AS TEXT) amount FROM "erp_home__notification" ORDER BY user_id, type`)
    .rows.map((r) => `${r.user_id}|${r.type}|${r.day}|${r.quantity}|${r.amount}`);

test("usuário a usuário, as unidades deixam o banco igual ao erp_platform_notifications_run", async () => {
  const day = await today();
  const contact = (await f.catalog("contacts", { name: "Cliente das unidades" })).id;
  const product = (await f.catalog("products", { name: "Produto das unidades", code: "UNI-1" })).id;
  await f.rpc("erp_document_save", {
    p_user_id: f.users.admin, p_kind: "sales_proposals", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: day, contact_id: contact, next_contact: day, items: [{ product_id: product, description: "Produto", quantity: "1", unit_price: "10.00", unit: "UN" }] },
  });
  await f.db.query(
    "insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents) values($1,1,1,'receivable',$2,'Atrasado',$3::date-30,$3::date-5,15000,2500),($4,1,1,'payable',$2,'Conta',$3::date-30,$3::date-1,1000,0)",
    [randomUUID(), contact, day, randomUUID()],
  );
  await f.sync();
  // Destinatários escolhidos para um tipo: consulta e vendas (vendas não lê finanças).
  const current = (await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: "central-notificacoes" })).items.find(
    (i) => i.key === "notificacoes.contas_receber_atrasadas",
  );
  await f.rpc("erp_preferences_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: "central-notificacoes",
    p_changes: [{ key: "notificacoes.contas_receber_atrasadas", expected_version: current.version, value: [f.users.consulta, f.users.vendas].sort() }],
  });
  // Unidades: o resumo de cada tipo uma vez, depois cada membro (o despachante cederia a vez entre eles).
  const units = inTransaction(f.driver, (ctx) => {
    const digests = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, notificationDigestFor(ctx.db, t, day)]));
    const clock = new Clock();
    let created = 0;
    for (const m of activeMembers(ctx.db)) for (const t of NOTIFICATION_TYPES) if (notifyMember(ctx.db, clock, m.user_id, t, day, digests[t])) created++;
    // Repetir não cria de novo.
    for (const m of activeMembers(ctx.db)) for (const t of NOTIFICATION_TYPES) assert.equal(notifyMember(ctx.db, clock, m.user_id, t, day, digests[t]), false);
    return created;
  });
  const byUnits = rows();
  assert.ok(units >= 3, `criadas: ${units}`);
  assert.ok(byUnits.some((r) => r.startsWith(`${f.users.consulta}|contas_receber_atrasadas`)), "o destinatário escolhido recebe");
  assert.ok(!byUnits.some((r) => r.startsWith(`${f.users.vendas}|contas_receber_atrasadas`)), "vendas não lê finanças");
  // Desfaz no motor e roda a tarefa nos dois motores.
  f.driver.exec('DELETE FROM "erp_home__notification"');
  await f.rpc("erp_platform_schedule", { p_now: new Date().toISOString() });
  const lease = randomUUID();
  const task = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["notifications_generate"] })).task;
  const result = await f.rpc("erp_platform_notifications_run", { p_task: task.id, p_lease: lease });
  await f.rpc("erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: true, p_result: result, p_error: null });
  assert.equal(result.created, units);
  assert.deepEqual(rows(), byUnits, "as mesmas notificações, com as mesmas quantidades e valores");
  // Sem quantidade, nada; usuário inativo ou desconhecido, nada.
  inTransaction(f.driver, (ctx) => {
    const clock = new Clock();
    assert.equal(notifyMember(ctx.db, clock, f.users.admin, "validade", day, { quantity: 0, amount: null }), false);
    assert.equal(notifyMember(ctx.db, clock, f.users.inactive, "proximo_contato", day, { quantity: 1, amount: null }), false);
    assert.equal(notifyMember(ctx.db, clock, randomUUID(), "proximo_contato", day, { quantity: 1, amount: null }), false);
  });
});
