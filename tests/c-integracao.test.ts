import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { defaults, uid } from "../src/types";
import { unseal } from "../src/security";
import { modulesApi } from "../src/modules/api";
import { routineCustomer, selfCustomerStatements } from "../src/modules/agenda/customer-provider";
import { createOrder, openOrdersFor, type NewOrder } from "../src/modules/pedido/orders";
import { CUSTOMER_QUEUE_LIMIT } from "../src/customer/jobs";
import { fixture, receive } from "./service-center-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { countingEnv } from "./d1-counter";
import { createOrder as createWork, conversationOf, loadOrder } from "../src/modules/os/store";
import { requestStageApproval, sendStageApproval } from "../src/modules/os/stages";
import { workCustomerAllows } from "../src/modules/os/public";
import { createTask } from "../src/modules/os/tasks/store";
import { runTaskDue } from "../src/modules/os/tasks/reminders";

it.each([false, true])("carrinho grava pedido e intenção de nome atomicamente, mesmo com fila cheia=%s", async full => {
  const f = await fixture();
  await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'pedido',1,1)", f.profile);
  const c = await receive(f, f.line, "oi", "5511970000005"), ctx = modulesApi(env, f.profile, "pedido");
  const customer = await routineCustomer(ctx, c);
  expect(customer?.ref).toMatchObject({ state: "ready", verifiedPhone: "5511970000005" });
  if (!customer) throw new Error("A entrada real deve produzir o contato comprovado.");
  if (full) for (let n = 0; n < CUSTOMER_QUEUE_LIMIT; n++)
    await batch(env, await selfCustomerStatements(ctx, c, customer, `previous:${n}`, "Ana"));
  const input: NewOrder = {
    conversation: c, customer_name: "Ana", source: "cart", sourceKey: uid(), actor: "customer",
    lines: [], item_count: 1, subtotal_cents: 1000, delivery_fee_cents: 0, total_cents: 1000,
    fulfillment: "pickup", address: null, note: "",
  };
  const first = await createOrder(ctx, input);
  expect(first.created).toBe(true);
  expect(first.order).toMatchObject({ contact_id: customer.ref.contactId, customer_name: "Ana", total_cents: 1000 });
  expect((await createOrder(ctx, input)).created).toBe(false);
  // Também reexecuta o INSERT ... SELECT com ON CONFLICT que acompanha o lote.
  await batch(env, await selfCustomerStatements(ctx, c, customer, input.sourceKey, "Ana"));
  const jobs = await all(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", f.profile, `self:${input.sourceKey}`);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ contact_id: customer.ref.contactId, kind: "enrich", state: full ? "retained" : "pending",
    error_code: full ? "customer_queue_full" : null });
  if (full) expect(jobs[0].payload_cipher).toBeNull();
  else expect(await unseal(env, jobs[0].payload_cipher)).toMatchObject({ input: { mode: "fill_empty", patch: { name: "Ana" } } });
  expect(await all(env, "SELECT id FROM pedido_orders WHERE profile_id=?", f.profile)).toHaveLength(1);
  expect(await all(env, "SELECT id FROM pedido_history WHERE profile_id=?", f.profile)).toHaveLength(1);
  expect((await openOrdersFor(ctx, c)).map(row => row.id)).toEqual([first.order.id]);
  expect((await one(env, "SELECT name FROM contacts WHERE id=?", customer.ref.contactId)).name).toBe("");
});

async function workFixture() {
  const f = await fixture(), type = motorWorkType();
  type.transitions[0] = { ...type.transitions[0], kind: "customer_approval", valid_hours: 1, request_text: "Autoriza iniciar?" };
  await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'os',1,1)", f.profile);
  await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify({ ...defaults, os_work_types: [type] }), f.profile);
  return { ...f, ctx: modulesApi(env, f.profile, "os"), input: {
    type_id: type.id, phone: "5511960010203", item: "Objeto", problem: "Escopo",
    source: "panel" as const, actor: f.member.id, sourceKey: uid(), notify: false,
  } };
}

it("OS com titular confirmado envia aprovação à conversa persistida, mesmo com outro telefone no snapshot", async () => {
  const f = await workFixture(), c = await receive(f, f.line, "oi");
  const { order } = await createWork(f.ctx, { ...f.input, conversation: c });
  expect(order.phone).not.toBe(c.phone);
  expect(order.contact_id).toBe((await f.ctx.customer(c)).contactId);
  expect((await conversationOf(f.ctx, order))?.id).toBe(c.id);
  const pending = await requestStageApproval(f.ctx, order, { transition_id: "iniciar", version: order.row_version }, f.member.id);
  expect(JSON.parse(pending.stage_approval_json).state).toBe("pending");
  const sent = () => all(env, "SELECT id FROM outbox WHERE profile_id=? AND dedupe LIKE '%stage-approval:%'", f.profile);
  expect(await sent()).toHaveLength(1);
  for (const state of ["blocked", "excluded", "ambiguous"] as const) {
    await exec(env, "UPDATE conversations SET customer_link_state=? WHERE id=?", state, c.id);
    expect(await conversationOf(f.ctx, pending)).toBeNull();
    await sendStageApproval(f.ctx, pending);
  }
  await exec(env, "UPDATE conversations SET customer_link_state='ready' WHERE id=?", c.id);
  const other = await receive(f, f.second, "oi", "5511970000008");
  // Mesmo uma linha antiga em memória não contorna a mudança persistida.
  await exec(env, "UPDATE os_orders SET contact_id=? WHERE id=?", (await f.ctx.customer(other)).contactId, order.id);
  expect(await workCustomerAllows(f.ctx, c, pending, true)).toBe(false);
  await sendStageApproval(f.ctx, pending);
  expect(await sent()).toHaveLength(1);
  expect((await loadOrder(f.ctx, order.id)).phone).toBe(f.input.phone);
});

async function counterWork() {
  const f = await workFixture(), { order } = await createWork(f.ctx, f.input);
  const c = await receive(f, f.line, "oi", f.input.phone);
  // Instantes explícitos evitam depender da resolução do relógio no Worker.
  await exec(env, "UPDATE os_orders SET conversation_id=?,created=? WHERE id=?", c.id, c.created - 1000, order.id);
  return { ...f, c, order: await loadOrder(f.ctx, order.id) };
}

it("OS anterior à primeira conversa envia dez lembretes no orçamento e não os repete", async () => {
  const f = await counterWork();
  expect(f.order.contact_id).toBeNull();
  expect((await conversationOf(f.ctx, f.order))?.id).toBe(f.c.id);
  for (let i = 0; i < 10; i++) await createTask(f.ctx, f.member, {
    id: f.order.id, title: "Conferir entrega", audience: "customer", client_visible: true,
    sensitive: false, due_at: 20, remind_at: 10,
  }, uid());
  const run = async () => {
    const measured = countingEnv(env);
    const budget = { remaining: 200, consume(n: number) { this.remaining -= n; } };
    const result = await runTaskDue(modulesApi(measured.env, f.profile, "os"), { now: 10, budget, limit: 10 });
    expect(200 - budget.remaining).toBe(measured.count.statements);
    expect(measured.count.statements).toBeLessThanOrEqual(200);
    return result;
  };
  expect((await run()).processed).toBe(10);
  expect((await run()).processed).toBe(0);
  expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND dedupe LIKE '%task-due:%'", f.profile)).toHaveLength(10);
  expect(await all(env, "SELECT id FROM os_tasks WHERE order_id=? AND notified_at=10", f.order.id)).toHaveLength(10);
  expect((await loadOrder(f.ctx, f.order.id)).contact_id).toBeNull();
});

it.each(["sessão posterior", "outro titular", "índice revisado", "candidato cadastral", "telefone editado"])(
  "OS de balcão não recupera destinatário com %s", async reason => {
    const f = await counterWork();
    expect((await conversationOf(f.ctx, f.order))?.id).toBe(f.c.id);
    if (reason === "sessão posterior")
      await exec(env, "UPDATE conversations SET created=? WHERE id=?", f.order.created - 1000, f.c.id);
    if (reason === "outro titular") {
      const other = await receive(f, f.second, "oi", "5511970000008");
      await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'conversations','session',?,?,?,'test',1)",
        f.profile, `${f.c.id}:old`, (await f.ctx.customer(other)).contactId, f.c.id);
    }
    if (reason === "índice revisado")
      await exec(env, "UPDATE customer_phones SET version=version+1 WHERE profile_id=?", f.profile);
    if (reason === "candidato cadastral")
      await exec(env, "UPDATE customer_phone_candidates SET origin='local' WHERE profile_id=?", f.profile);
    if (reason === "telefone editado")
      await exec(env, "INSERT INTO os_history(id,profile_id,order_id,kind,actor,created,changed_fields_json) VALUES(?,?,?,'os.updated',?,1,'[\"phone\"]')", uid(), f.profile, f.order.id, f.member.id);
    expect(await conversationOf(f.ctx, f.order)).toBeNull();
  },
);
