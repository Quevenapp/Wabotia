import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { customerHistory } from "../src/customer/history";
import { customerProvider, customerRecordStatements, historyPort } from "../src/customer/ports";
import type { Namespace } from "../src/customer/contracts";
import { conversation } from "../src/service";
import { conversationTicket, issueTicket, linkKioskTicket, serviceDay } from "../src/queue";
import { completeWebStep, openWebStep } from "../src/web-steps";
import { now, uid } from "../src/types";
import { fixture } from "./service-center-fixture";

// A identidade é de outra frente. O teste registra sua porta, sem implementá-la aqui.
vi.mock("../src/customer/ports", async (importOriginal) => {
  const ports = await importOriginal<typeof import("../src/customer/ports")>();
  const { one } = await import("../src/db");
  ports.installIdentityPort({
  async resolve(e, c) {
    const row = await one(e, "SELECT p.id,p.identity_state FROM conversation_contacts l JOIN contacts p ON p.id=l.contact_id AND p.profile_id=l.profile_id WHERE l.profile_id=? AND l.conversation_id=?", c.profile_id, c.id);
    return { profileId: c.profile_id, namespace: (c.external_namespace.startsWith("app:") ? c.external_namespace : "team") as Namespace,
      state: row?.identity_state !== "active" && row ? "excluded" : c.customer_link_state ?? "pending", contactId: row?.id ?? null,
      verifiedPhone: c.verified_phone ?? null, version: 1, erp: null };
  },
  async prepareInbound() { return { statements: [], state: "pending", verifiedPhone: null }; },
  async indexContact() { return []; },
  async maintain() { return { statements: 0, items: 0, pending: false }; },
  });
  // Preserva a simulação quando a implementação paralela for integrada.
  return { ...ports, installIdentityPort: () => {} };
});

async function setup() {
  const f = await fixture(), contact = uid(), cid = uid(), queue = uid(), at = now() - 10000;
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','test','test',?,?)", contact, f.profile, at - 10, at - 10);
  await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,'5511999990001','5511999990001','ready',?,?,?,?)", cid, f.profile, f.qr, `channel:${f.qr}`, cid, uid(), at, at, at);
  await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',?)", cid, f.profile, contact, at - 1);
  await exec(env, "INSERT INTO queues(id,profile_id,name,created,updated) VALUES(?,?,'Fila',?,?)", queue, f.profile, at, at);
  for (const module of ["queue", "forms", "reserva"]) await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=1", f.profile, module, at);
  return { ...f, contact, cid, queue, at, c: await conversation(env, cid, f.profile) };
}
type F = Awaited<ReturnType<typeof setup>>;
async function ticket(f: F, id = uid(), at = f.at, linked = true) {
  await exec(env, "INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,created,updated) VALUES(?,?,?,?,?,'open',?,?)", id, uid(), f.profile, f.cid, "Assunto privado que não deve sair", at, at);
  if (linked) await batch(env, customerRecordStatements({ profileId: f.profile, moduleId: "tickets", kind: "ticket", recordId: id, contactId: f.contact, conversationId: f.cid, linkedBy: "test", occurredAt: at }));
  return id;
}
async function kiosk(f: F, at = f.at - 1000) {
  const id = uid();
  await exec(env, "INSERT INTO queue_tickets(id,profile_id,queue_id,service_day,prefix,seq,code,source,public_token,link_code,created_at,updated) VALUES(?,?,?,?,'N',1,'N001','kiosk',?,'ABCDEF',?,?)", id, f.profile, f.queue, serviceDay(), uid(), at, at);
  return id;
}
const read = (f: F, query = {}) => historyPort.read(env, f.admin, f.profile, { contactId: f.contact }, query);

describe("histórico por vínculo persistido", () => {
  it("fila anterior ao atendimento exige o cupom e grava vínculo junto da associação", async () => {
    const f = await setup(), id = await kiosk(f);
    expect((await read(f)).items).toEqual([]);
    await linkKioskTicket(env, f.c, "N001", "ABCDEF");
    expect((await read(f)).items).toEqual([expect.objectContaining({ kind: "queue", sourceKey: `queue:${id}`, occurredAt: f.at - 1000, status: "waiting" })]);
    await linkKioskTicket(env, f.c, "N001", "ABCDEF");
    expect(await all(env, "SELECT record_id FROM customer_records WHERE profile_id=? AND module_id='queue'", f.profile)).toHaveLength(1);
    // Nem um número igual autoriza outra conversa a ver a senha.
    expect(await conversationTicket(env, f.profile, uid(), f.c.verified_phone!)).toEqual({ senha: null });
    await exec(env, "UPDATE conversations SET verified_phone=NULL,customer_link_state='pending' WHERE id=?", f.cid);
    await expect(linkKioskTicket(env, f.c, "N001", "ABCDEF")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("recusa transferência de senha e rollback deixa o vínculo imutável", async () => {
    const f = await setup(), id = await kiosk(f), second = uid();
    await linkKioskTicket(env, f.c, "N001", "ABCDEF");
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','manual','test','test',1,1)", second, f.profile);
    await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", second, now(), f.cid);
    await expect(linkKioskTicket(env, f.c, "N001", "ABCDEF")).rejects.toMatchObject({ code: "contact_conflict" });
    expect((await one(env, "SELECT contact_id FROM customer_records WHERE profile_id=? AND module_id='queue' AND record_id=?", f.profile, id)).contact_id).toBe(f.contact);
    expect((await historyPort.read(env, f.admin, f.profile, { contactId: second }, {})).items).toEqual([]);
    expect((await historyPort.read(env, f.admin, f.profile, { conversationId: f.cid }, {})).items.some(i => i.kind === "queue")).toBe(false);
  });

  it("emissão pelo WhatsApp grava sua relação no mesmo lote", async () => {
    const f = await setup();
    const { ticket: row } = await issueTicket(env, f.profile, { queueId: f.queue, preferential: false, source: "whatsapp", actorId: "customer", conversationId: f.cid, phone: "número não confiável", sourceKey: uid() });
    expect((await one(env, "SELECT contact_id FROM customer_records WHERE profile_id=? AND module_id='queue' AND record_id=?", f.profile, row.id)).contact_id).toBe(f.contact);
    expect(row.phone).toBe(f.c.verified_phone);
  });

  it("formulário fixa o contato no envio, preserva-o na conclusão e não copia respostas", async () => {
    const f = await setup(), other = uid();
    await exec(env, "INSERT INTO instance_settings(key,value,updated) VALUES('public_origin','https://example.test',1) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    const opened = await openWebStep(env, { conversation: f.c, module: "forms", kind: "form", ref: "administrativo", actor: "test", trigger: "menu", sourceKey: uid(), spec: { title: "Cadastro", fields: [{ id: "f_nome", type: "text", label: "Nome" }], ticket: "none", return_message: "module" } });
    expect(opened.step.contact_id).toBe(f.contact);
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','manual','test','test',1,1)", other, f.profile);
    await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", other, now() + 1, f.cid);
    const completed = await completeWebStep(env, opened.step.id, { f_nome: "RESPOSTA PRIVADA" });
    expect(completed.ok).toBe(true);
    expect((await one(env, "SELECT contact_id FROM web_steps WHERE id=?", opened.step.id)).contact_id).toBe(f.contact);
    const result = await read(f);
    expect(result.items.some(i => i.sourceKey === `form:${opened.step.id}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("RESPOSTA PRIVADA");
    expect(await all(env, "SELECT * FROM customer_records WHERE profile_id=? AND module_id='forms'", f.profile)).toEqual([]);
    const list = await customerProvider("forms")!.list!({ env, profile: f.profile } as any, f.admin, f.contact, "submissions", { limit: 25 });
    expect(list.items[0].cells).toEqual({ id: opened.step.id, status: "completed", occurredAt: expect.any(Number) });
  });

  it("check-in vem do estado da Reserva, sem checkin_answers nem cópia em customer_records", async () => {
    const f = await setup(), id = uid();
    await exec(env, "INSERT INTO reserva_bookings(id,profile_id,number,unit_id,unit_name,mode,starts,ends,arrival_at,departure_at,status,conversation_id,contact_id,source,price_cents,created_by,created,updated,checkin_status,checkin_at,checkin_answers) VALUES(?,?,1,'unit','Unidade','day',1,2,1,2,'confirmed',?,?,'panel',100,'test',?,?,'completed',?,?)", id, f.profile, f.cid, f.contact, f.at, f.at, f.at + 1, '{"privado":"SEGREDO"}');
    const result = await read(f);
    expect(result.items).toEqual([expect.objectContaining({ kind: "checkin", occurredAt: f.at + 1, status: "completed" })]);
    expect(JSON.stringify(result)).not.toContain("SEGREDO");
    await exec(env, "UPDATE reserva_bookings SET checkin_status='sent' WHERE id=?", id);
    expect((await read(f)).items).toEqual([]);
  });

  it("pagina empates sem OFFSET, autentica o cursor e preserva o corte", async () => {
    const f = await setup();
    for (const id of ["a", "b", "c"]) await ticket(f, `${f.profile}-${id}`);
    const first = await read(f, { limit: 2 });
    expect(first.items.map(i => i.sourceKey)).toEqual([`ticket:${f.profile}-c`, `ticket:${f.profile}-b`]);
    await ticket(f, `${f.profile}-novo`, now() + 60000);
    const second = await read(f, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(i => i.sourceKey)).toEqual([`ticket:${f.profile}-a`]);
    expect(second.nextCursor).toBeNull();
    await expect(read(f, { limit: 2, cursor: first.nextCursor!.slice(0, -4) + "AAAA" })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(read(f, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(historyPort.read(env, f.admin, f.profile, { conversationId: f.cid }, { limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it.each([false, true])("pagina as cinco fontes por conversa no D1 (sessão persistida=%s)", async (persisted) => {
    const f = await setup(), protocol = await ticket(f), queue = await kiosk(f, f.at), form = uid(), booking = uid();
    await linkKioskTicket(env, f.c, "N001", "ABCDEF");
    if (persisted) await batch(env, customerRecordStatements({ profileId: f.profile, moduleId: "conversations", kind: "session", recordId: `${f.cid}:${f.c.session}`, contactId: f.contact, conversationId: f.cid, linkedBy: "test", occurredAt: f.at }));
    await exec(env, "INSERT INTO web_steps(id,profile_id,conversation_id,module_id,kind,code_hash,status,title,trigger,actor,expires_at,completed_at,created,updated,contact_id,result) VALUES(?,?,?,'forms','form',?,'completed','Formulário','menu','test',?,?,?,?,?,?)", form, f.profile, f.cid, uid(), f.at + 60000, f.at, f.at, f.at, f.contact, '{"privado":"RESPOSTA PRIVADA"}');
    await exec(env, "INSERT INTO reserva_bookings(id,profile_id,number,unit_id,unit_name,mode,starts,ends,arrival_at,departure_at,status,conversation_id,contact_id,source,price_cents,created_by,created,updated,checkin_status,checkin_at,checkin_answers) VALUES(?,?,1,'unit','Unidade','day',1,2,1,2,'confirmed',?,?,'panel',100,'test',?,?,'completed',?,?)", booking, f.profile, f.cid, f.contact, f.at, f.at, f.at, '{"privado":"CHECK-IN PRIVADO"}');
    const first = await historyPort.read(env, f.admin, f.profile, { conversationId: f.cid }, { limit: 2 });
    expect(first.nextCursor).toBeTruthy();
    await ticket(f, uid(), now() + 60000);
    const second = await historyPort.read(env, f.admin, f.profile, { conversationId: f.cid }, { limit: 2, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeTruthy();
    const third = await historyPort.read(env, f.admin, f.profile, { conversationId: f.cid }, { limit: 2, cursor: second.nextCursor! });
    expect(third.nextCursor).toBeNull();
    const items = [...first.items, ...second.items, ...third.items];
    expect(items.map(item => item.sourceKey)).toEqual([
      `ticket:${protocol}`, `queue:${queue}`, `form:${form}`, `conversation:${f.cid}:${f.c.session}`, `checkin:${booking}`,
    ]);
    expect(items.every(item => item.occurredAt === f.at)).toBe(true);
    expect(items.filter(item => item.kind === "conversation")).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain("PRIVAD");
  });

  it("manutenção retoma por chave, respeita orçamento e é idempotente", async () => {
    const f = await setup();
    for (let n = 0; n < 23; n++) await ticket(f, `${f.profile}-${String(n).padStart(3, "0")}`, f.at + n, false);
    expect((await read(f)).incomplete).toBe(true);
    for (let n = 0; n < 12; n++) {
      const result = await customerHistory.maintain(env, f.profile, { remainingStatements: 9, remainingItems: 4 });
      expect(result.statements).toBeLessThanOrEqual(9);
      expect(result.items).toBeLessThanOrEqual(4);
      if (!result.pending) break;
    }
    expect((await read(f, { limit: 50 })).items).toHaveLength(24);
    expect((await read(f)).incomplete).toBe(false);
    const count = await one(env, "SELECT count(*) n FROM customer_records WHERE profile_id=?", f.profile);
    await customerHistory.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    expect(await one(env, "SELECT count(*) n FROM customer_records WHERE profile_id=?", f.profile)).toEqual(count);
    expect(await customerHistory.maintain(env, f.profile, { remainingStatements: 2, remainingItems: 20 })).toEqual({ statements: 0, items: 0, pending: true });
  });

  it("não reconstrói por número, por associação posterior ou após restrição", async () => {
    const f = await setup();
    await ticket(f, uid(), f.at - 100, false);
    await kiosk(f);
    for (let n = 0; n < 3; n++) await customerHistory.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    expect((await read(f)).incomplete).toBe(true);
    expect((await read(f)).items.map(i => i.kind)).toEqual(["conversation"]);
    await exec(env, "UPDATE contacts SET identity_state='erasing' WHERE id=?", f.contact);
    expect((await read(f)).items).toEqual([]);
    await customerHistory.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    expect(await all(env, "SELECT * FROM customer_records WHERE profile_id=? AND module_id='tickets'", f.profile)).toEqual([]);
  });

  it("queda no lote não avança checkpoint; nova tentativa retoma os mesmos registros", async () => {
    const f = await setup();
    await ticket(f, uid(), f.at, false);
    const failedEnv = { ...env, DB: { prepare: env.DB.prepare.bind(env.DB), batch: async () => { throw new Error("falha simulada antes do commit"); } } } as any;
    await expect(customerHistory.maintain(failedEnv, f.profile, { remainingStatements: 40, remainingItems: 20 })).rejects.toThrow("falha simulada");
    expect(await one(env, "SELECT * FROM customer_progress WHERE profile_id=?", f.profile)).toBeNull();
    expect(await all(env, "SELECT * FROM customer_records WHERE profile_id=?", f.profile)).toEqual([]);
    await customerHistory.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    expect((await read(f)).items).toHaveLength(2);
  });

  it("não inventa a data da sessão reaberta nem reaponta a sessão anterior", async () => {
    const f = await setup();
    await customerHistory.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    await exec(env, "UPDATE conversations SET session=?,epoch=epoch+1,updated=? WHERE id=?", uid(), now(), f.cid);
    for (let n = 0; n < 2; n++) await customerHistory.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    const result = await read(f);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ sourceKey: `conversation:${f.cid}:${f.c.session}`, occurredAt: f.at, status: "closed" });
    expect(result.incomplete).toBe(true);
  });
});
