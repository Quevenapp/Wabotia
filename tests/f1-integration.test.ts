import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { uid, type Env } from "../src/types";
import { conversation, inbound, perform } from "../src/service";
import { resolveCustomer, historyPort } from "../src/customer/ports";
import { enrichLocal, processJob } from "../src/customer/jobs";
import { routineCustomer, selfCustomerStatements } from "../src/modules/agenda/customer-provider";
import { modulesApi } from "../src/modules/api";
import { erpStub } from "../src/erp/hub";
import { fixture, receive } from "./service-center-fixture";
import { measure } from "./d1-counter";
import { contactCommand } from "../src/contacts";
import { activeTicketForConversation, conversationTicket, issueTicket } from "../src/queue";
import { createOrder, notify } from "../src/modules/os/store";
import { workCustomerAllows } from "../src/modules/os/public";

// Composição real: nenhuma porta de identidade, escrita ou ERP é simulada.
describe("fase 1 integrada", () => {
  it("entrada legada sem conexão permite associação humana, sem conceder prova telefônica", async () => {
    const f = await fixture();
    const contact = await contactCommand(env, f.member, f.profile, "contact.create", { name: "Ana", phone: "5511999990000" });
    const result = await inbound(env, f.profile, { external_id: "5511999990000", message_id: uid(), text: "oi" }, "meta:test", null);
    const c = await conversation(env, result.conversation_id, f.profile);
    expect(await resolveCustomer(env, c)).toMatchObject({ contactId: null, verifiedPhone: null });
    expect(await one(env, "SELECT contact_id FROM conversation_contacts WHERE conversation_id=?", c.id)).toBeNull();
    await contactCommand(env, f.member, f.profile, "contact.from-conversation", { id: c.id, contact_id: contact.id });
    const linked = await conversation(env, c.id, f.profile);
    expect(await resolveCustomer(env, linked)).toMatchObject({ state: "ready", contactId: contact.id, verifiedPhone: null });
    expect(await modulesApi(env, f.profile, "os").contact(linked)).toMatchObject({ id: contact.id });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("aviso da OS usa o contato vinculado; documento ainda exige o telefone e troca de contato revoga o aviso", async () => {
    const f = await fixture();
    await perform(env, f.admin, f.profile, "module.set", { id: "os", enabled: true }, uid());
    const c = await receive(f, f.line, "oi", "5511999998888"), ctx = modulesApi(env, f.profile, "os");
    const input = { conversation: c, phone: "5511960010203", item: "Objeto", problem: "Escopo", source: "panel" as const, actor: f.member.id, notify: false, sourceKey: uid() };
    await expect(createOrder(ctx, { ...input, phone: "123" })).rejects.toMatchObject({ status: 400 });
    expect(await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile)).toHaveLength(0);
    const { order } = await createOrder(ctx, input);
    expect(order.contact_id).toBe((await resolveCustomer(env, c)).contactId);
    expect(order.phone).not.toBe(c.phone);
    await notify(ctx, order, "ready", "ready");
    await notify(ctx, order, "ready", "ready");
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=? AND kind!='team'", c.id)).toHaveLength(1);
    expect(await workCustomerAllows(ctx, c, order, true)).toBe(false);
    const other = await receive(f, f.second, "oi", "5511999990002"), ref = await resolveCustomer(env, other);
    await contactCommand(env, f.member, f.profile, "contact.from-conversation", { id: c.id, contact_id: ref.contactId });
    await expect(notify(ctx, order, "pickup_reminder", "pickup")).rejects.toMatchObject({ code: "contact_conflict" });
    expect(await workCustomerAllows(ctx, await conversation(env, c.id, f.profile), order, true)).toBe(false);
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=? AND kind!='team'", c.id)).toHaveLength(1);
  });

  it("senha do balcão aceita o telefone autenticado e suas variantes, sem autorizar aplicação nem transferir vínculo", async () => {
    const f = await fixture(), queue = uid(), phone = "5511960000004";
    await exec(env, "INSERT INTO queues(id,profile_id,name,created,updated) VALUES(?,?,'Fila',1,1)", queue, f.profile);
    const { ticket } = await issueTicket(env, f.profile, { queueId: queue, source: "staff", actorId: f.admin.id, phone, preferential: false });
    const c = await receive(f, f.line, "SENHA", phone), second = await receive(f, f.second, "SENHA", "551160000004");
    for (const linked of [c, second])
      expect(await conversationTicket(env, f.profile, linked.id)).toMatchObject({ senha: { codigo: ticket.code } });
    const measured = await measure(env, e => activeTicketForConversation(e, f.profile, c.id));
    expect(measured.count).toMatchObject({ statements: 1, calls: 1 });
    const external = await inbound(env, f.profile, { external_id: phone, phone, text: "SENHA", message_id: uid() }, "app:fake", null);
    expect(await conversationTicket(env, f.profile, external.conversation_id, phone)).toEqual({ senha: null });
    expect(await conversationTicket(env, f.profile, uid(), phone)).toEqual({ senha: null });
    // O telefone não transfere uma senha que já tem conversa própria.
    await exec(env, "UPDATE queue_tickets SET conversation_id=? WHERE id=?", second.id, ticket.id);
    expect(await conversationTicket(env, f.profile, c.id)).toEqual({ senha: null });
    await exec(env, "UPDATE queue_tickets SET conversation_id=NULL,source='kiosk' WHERE id=?", ticket.id);
    expect(await conversationTicket(env, f.profile, c.id)).toEqual({ senha: null });
    await exec(env, "UPDATE queue_tickets SET source='staff' WHERE id=?", ticket.id);
    await exec(env, "UPDATE conversations SET customer_link_state='blocked' WHERE id=?", c.id);
    expect(await conversationTicket(env, f.profile, c.id)).toEqual({ senha: null });
  });

  it("contato automático atravessa linhas, nono dígito, sessões e enriquecimento sem ERP", async () => {
    const f = await fixture();
    const isolated = { ...env, COORDINATOR: new Proxy({}, { get() { throw new Error("ERP não solicitado"); } }) } as Env;
    const data = { external_id: "5511987654321", phone: "5511987654321", text: "oi", message_id: uid() };
    const first = await inbound(isolated, f.profile, data, `channel:${f.line}`, f.line);
    const c = await conversation(env, first.conversation_id, f.profile), ref = await resolveCustomer(env, c);
    expect(ref).toMatchObject({ state: "ready", erp: null });
    expect(await one(env, "SELECT name,source FROM contacts WHERE id=?", ref.contactId)).toEqual({ name: "", source: "automatic" });
    const repeated = await measure(isolated, e => inbound(e, f.profile, data, `channel:${f.line}`, f.line));
    expect(repeated.count).toMatchObject({ statements: 1, calls: 1 });
    const other = await receive(f, f.second, "voltei", "551187654321");
    expect((await resolveCustomer(env, other)).contactId).toBe(ref.contactId);
    await exec(env, "UPDATE conversations SET state='closed' WHERE id=?", c.id);
    const next = await receive(f, f.line, "nova conversa", data.phone);
    expect(next.session).not.toBe(c.session);
    const history = await historyPort.read(env, f.admin, f.profile, { contactId: ref.contactId! }, {});
    expect(history.items.filter(item => item.kind === "conversation")).toHaveLength(3);
    const saved = await enrichLocal(isolated, f.admin, f.profile, ref.contactId!, {
      commandId: uid(), expectedVersion: ref.version!, expectedErpVersion: null,
      mode: "fill_empty", patch: { name: "Ana", document: "52998224725" },
    });
    expect(saved).toMatchObject({ state: "done", contactId: ref.contactId });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("confirmação de autoatendimento completa somente o contato da sessão", async () => {
    const f = await fixture(), c = await receive(f, f.line, "oi", "5511977700001");
    const ctx = modulesApi(env, f.profile, "pedido"), customer = (await routineCustomer(ctx, c))!;
    await batch(env, await selfCustomerStatements(ctx, c, customer, "pedido:confirmado", "Ana"));
    const job = await one(env, "SELECT id FROM customer_jobs WHERE profile_id=?", f.profile);
    await processJob(env, f.profile, job.id);
    expect(await one(env, "SELECT state,error_code FROM customer_jobs WHERE id=?", job.id)).toEqual({ state: "done", error_code: null });
    expect(await one(env, "SELECT name FROM contacts WHERE id=?", customer.ref.contactId)).toEqual({ name: "Ana" });
  });

  it("desvinculação automática confere o contato esperado e mantém bloqueio na próxima mensagem", async () => {
    const f = await fixture(), c = await receive(f, f.line, "oi", "5511977700004");
    const ref = await resolveCustomer(env, c);
    await expect(perform(env, f.admin, f.profile, "contact.unlink", { id: c.id, expected_contact_id: uid() }, uid()))
      .rejects.toMatchObject({ code: "contact_conflict" });
    await perform(env, f.admin, f.profile, "contact.unlink", { id: c.id, expected_contact_id: ref.contactId }, uid());
    const again = await receive(f, f.line, "voltei", c.phone!);
    expect(await resolveCustomer(env, again)).toMatchObject({ state: "blocked", contactId: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT contact_id FROM customer_records WHERE conversation_id=?", c.id)).toEqual([{ contact_id: ref.contactId }]);
  });

  it.each([false, true])("fila e ponte promovem com comando do Coordinator, perda de resposta=%s", async lost => {
    const f = await fixture(), c = await receive(f, f.line, "oi", "5511977700002");
    const ref = await resolveCustomer(env, c);
    await perform(env, f.admin, f.profile, "module.set", { id: "erp", enabled: true }, uid());
    const commandId = uid().replaceAll("-", "");
    const input = { commandId, expectedVersion: ref.version!, expectedErpVersion: null, mode: "fill_empty" as const, patch: { name: "Ana" } };
    let fail = lost;
    const fault = { ...env, COORDINATOR: new Proxy(env.COORDINATOR, { get(target, key) {
      if (key === "get") return (...args: Parameters<typeof target.get>) => {
        const stub = target.get(...args);
        return new Proxy(stub, { get(s, prop) {
          if (prop === "fetch") return async (...request: Parameters<typeof s.fetch>) => {
            const response = await s.fetch(...request);
            if (fail && String(request[0]).includes("erp_catalog_contact_save") && response.ok) {
              fail = false; await response.text(); throw new Error("Resposta perdida depois do save");
            }
            return response;
          };
          const value = Reflect.get(s, prop); return typeof value === "function" ? value.bind(s) : value;
        } });
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) } as Env;
    let result = await enrichLocal(fault, f.admin, f.profile, ref.contactId!, input, "promote");
    if (lost) {
      expect(fail).toBe(false);
      expect(result.pending).toBe(true);
      await exec(env, "UPDATE customer_jobs SET retry_at=0,lease_until=0 WHERE id=?", result.jobId);
      await processJob(env, f.profile, result.jobId!);
      result = await enrichLocal(env, f.admin, f.profile, ref.contactId!, input, "promote");
    }
    expect(result).toMatchObject({ contactId: ref.contactId, state: "done", pending: false, version: ref.version! + 1 });
    expect(await enrichLocal(env, f.admin, f.profile, ref.contactId!, input, "promote")).toEqual(result);
    const job = await one(env, "SELECT state,cursor_json,payload_cipher FROM customer_jobs WHERE id=?", result.jobId);
    expect(job.state).toBe("done");
    expect(job.payload_cipher).toBeNull();
    expect(JSON.parse(job.cursor_json).customerErp.done).toBe(true);
    const counts = await runInDurableObject(erpStub(env, f.profile), (_instance, state) => ({
      contacts: state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__record WHERE entity='contacts'").toArray()[0].n,
      creates: state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__audit WHERE entity='contacts' AND action='create'").toArray()[0].n,
    }));
    expect(counts).toEqual({ contacts: 1, creates: 1 });
  });
});
