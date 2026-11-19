import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { batch, exec, one } from "../src/db";
import { customerHistory, projectCustomerInput, projectCustomerMemory } from "../src/customer/history";
import { customerProvider, customerRecordStatements } from "../src/customer/ports";
import type { Namespace } from "../src/customer/contracts";
import { CUSTOMER_MEMORY_TOOL, customerToolContext, customerToolDefs, customerTools, runCustomerTool } from "../src/bot-actions/customer";
import { newToolState } from "../src/bot-actions/actions";
import { createPiiMask } from "../src/pii-mask";
import { conversation } from "../src/service";
import { fixture } from "./service-center-fixture";
import { now, uid } from "../src/types";

vi.mock("../src/customer/ports", async (importOriginal) => {
  const ports = await importOriginal<typeof import("../src/customer/ports")>();
  const { one } = await import("../src/db");
  ports.installIdentityPort({
  async resolve(e, c) {
    const link = await one(e, "SELECT contact_id FROM conversation_contacts WHERE profile_id=? AND conversation_id=?", c.profile_id, c.id);
    return { profileId: c.profile_id, namespace: (c.external_namespace.startsWith("app:") ? c.external_namespace : "team") as Namespace,
      state: c.customer_link_state ?? "pending", contactId: link?.contact_id ?? null, verifiedPhone: c.verified_phone ?? null, version: 1, erp: null };
  },
  async prepareInbound() { return { statements: [], state: "pending", verifiedPhone: null }; },
  async indexContact() { return []; },
  async maintain() { return { statements: 0, items: 0, pending: false }; },
  });
  // Preserva a simulação quando a implementação paralela for integrada.
  return { ...ports, installIdentityPort: () => {} };
});

async function setup() {
  const f = await fixture(), contact = uid(), at = now() - 10000;
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','test','test',?,?)", contact, f.profile, at, at);
  const conversations = [];
  for (let i = 0; i < 2; i++) {
    const id = uid(), session = uid(), ticket = uid();
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,'5511999999999','5511999999999','ready',?,?,?,?)", id, f.profile, f.qr, `channel:${f.qr}`, id, session, at, at, at);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',?)", id, f.profile, contact, at);
    await exec(env, "INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,created,updated) VALUES(?,?,?,?,?,'open',?,?)", ticket, uid(), f.profile, id, "CONTEÚDO PROCESSUAL PRIVADO", at, at);
    await batch(env, [
      ...customerRecordStatements({ profileId: f.profile, contactId: contact, moduleId: "tickets", kind: "ticket", recordId: ticket, conversationId: id, linkedBy: "test", occurredAt: at }),
      ...customerRecordStatements({ profileId: f.profile, contactId: contact, moduleId: "conversations", kind: "session", recordId: `${id}:${session}`, conversationId: id, linkedBy: "test", occurredAt: at }),
    ]);
    conversations.push(await conversation(env, id, f.profile));
  }
  const runId = uid(), bot = uid();
  await exec(env, "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,phase,context,created,updated) VALUES(?,?,?,'test',?,0,'running','{}','attendant','{}',?,?)", runId, f.profile, bot, conversations[0].id, at, at);
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", runId);
  const ctx = (await customerToolContext(env, run))!;
  return { ...f, contact, at, a: conversations[0], b: conversations[1], ctx };
}

describe("memória administrativa e privacidade", () => {
  it.each([true, false])("remove dados privados antes da máscara (ligada=%s)", (enabled) => {
    const input = JSON.stringify({ request: "Qual o andamento?", customerMemory: { previousInteractions: 3, pendingActions: 1, lastInteractionAt: 10, topicCode: "previous_service", answers: "RESPOSTA PRIVADA" },
      customer_history: [{ title: "PRONTUÁRIO" }], notes: "NOTA INTERNA", checkin_answers: "DOCUMENTO PRIVADO", identity_cipher: "IDENTIDADE CIFRADA",
      history: [{ direction: "in", text: "Olá" }, { direction: "note", text: "NOTA PRIVADA" }],
      sources: [{ module_id: "saude", text: "DIAGNÓSTICO" }, { module: "ensino", text: "MENOR" }, { module: "juridico", text: "PROCESSO PRIVADO" }, { id: "public", text: "Horário público" }],
    });
    const projected = projectCustomerInput(input);
    const result = JSON.parse(createPiiMask(enabled).maskInput(projected));
    expect(result.customerMemory).toEqual({ previousInteractions: 3, pendingActions: 1, lastInteractionAt: 10, topicCode: "previous_service" });
    expect(result.history).toEqual([{ direction: "in", text: "Olá" }]);
    expect(result.sources).toEqual([{ id: "public", text: "Horário público" }]);
    for (const secret of ["PRONTUÁRIO", "RESPOSTA PRIVADA", "NOTA INTERNA", "NOTA PRIVADA", "DOCUMENTO PRIVADO", "IDENTIDADE CIFRADA", "DIAGNÓSTICO", "MENOR", "PROCESSO PRIVADO"]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("o bot não escolhe contato nem conversa, mesmo compartilhando o mesmo contato", async () => {
    const f = await setup();
    const result = JSON.parse(await runCustomerTool(f.ctx, newToolState(), CUSTOMER_MEMORY_TOOL, { conversation_id: f.b.id, contactId: f.contact, profile: "outra", limit: 5000 }));
    expect(result).toEqual({ previousInteractions: 2, pendingActions: 1, lastInteractionAt: f.at, topicCode: "previous_service" });
    expect(Object.keys(result).sort()).toEqual(["lastInteractionAt", "pendingActions", "previousInteractions", "topicCode"]);
    expect(JSON.stringify(result)).not.toContain("PRIVADO");
    await expect(customerHistory.memory(env, f.ctx.bound, f.b)).rejects.toMatchObject({ status: 404 });
    await expect(customerHistory.read(env, { ...f.ctx.bound, scopes: [...f.ctx.bound.scopes, "contacts:read"] }, f.profile, { contactId: f.contact }, {})).rejects.toMatchObject({ status: 403 });
    await expect(customerHistory.memory(env, f.admin, f.a)).rejects.toMatchObject({ status: 403 });
    await exec(env, "UPDATE conversations SET epoch=epoch+1,session=? WHERE id=?", uid(), f.a.id);
    await expect(customerHistory.memory(env, f.ctx.bound, f.a)).rejects.toMatchObject({ status: 404 });
  });

  it("módulos desligados não retiram a ferramenta de memória nem acionam o ERP", async () => {
    const f = await setup();
    for (const module of ["queue", "forms", "reserva", "erp", "saude", "ensino", "juridico"]) await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,0,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=0", f.profile, module, f.at);
    expect(customerToolDefs(await customerTools(env, f.profile)).some(t => t.name === CUSTOMER_MEMORY_TOOL)).toBe(true);
    const moduleTools = await customerTools(env, f.profile);
    expect(moduleTools.some(t => ["saude", "ensino", "juridico"].includes(t.module))).toBe(false);
    const memory = await customerHistory.memory({ ...env, COORDINATOR: new Proxy({}, { get() { throw new Error("O ERP não pode ser chamado."); } }) } as any, f.ctx.bound, f.a);
    expect(memory.previousInteractions).toBe(2);
    await expect(customerProvider("queue")!.list!({ env, profile: f.profile } as any, f.admin, f.contact, "tickets", { limit: 25 })).rejects.toMatchObject({ code: "module_disabled" });
  });

  it("filtra autorização antes de paginar e não permite trocar o filtro com o cursor", async () => {
    const f = await setup();
    const restricted = { ...f.member, access: ["contacts", "conversations"] };
    const result = await customerHistory.read(env, restricted, f.profile, { contactId: f.contact }, { limit: 1 });
    expect(result.items[0].kind).toBe("conversation");
    expect(result.nextCursor).toBeTruthy();
    const changed = { ...restricted, access: ["contacts", "conversations", "tickets"] };
    await expect(customerHistory.read(env, changed, f.profile, { contactId: f.contact }, { limit: 1, cursor: result.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(customerHistory.read(env, { ...restricted, profiles: [] }, f.profile, { contactId: f.contact }, {})).rejects.toMatchObject({ status: 404 });
    const app = { ...f.ctx.bound, id: "integration", via: undefined, scopes: ["contacts:read"] };
    await expect(customerHistory.read(env, app, f.profile, { contactId: f.contact }, {})).rejects.toMatchObject({ status: 404 });
  });

  it("ambiguidade não amplia leitura por telefone e exclusão não usa fallback", async () => {
    const f = await setup();
    await exec(env, "UPDATE conversations SET customer_link_state='ambiguous' WHERE id=?", f.a.id);
    const ambiguous = await customerHistory.read(env, f.admin, f.profile, { conversationId: f.a.id }, {});
    expect(ambiguous.items).toEqual([]);
    expect(ambiguous.incomplete).toBe(true);
    await exec(env, "UPDATE contacts SET identity_state='erasing' WHERE id=?", f.contact);
    expect((await customerHistory.read(env, f.admin, f.profile, { conversationId: f.a.id }, {})).items).toEqual([]);
  });

  it("memória tem limite fixo e não propaga propriedades ou códigos arbitrários", async () => {
    expect(projectCustomerMemory({ previousInteractions: 1000, pendingActions: -1, lastInteractionAt: "texto privado", topicCode: "diagnóstico", extra: "segredo" })).toEqual({ previousInteractions: 50, pendingActions: 0, lastInteractionAt: null, topicCode: null });
    const f = await setup();
    const state = newToolState();
    for (let i = 0; i < 6; i++) await runCustomerTool(f.ctx, state, CUSTOMER_MEMORY_TOOL, {});
    expect(JSON.parse(await runCustomerTool(f.ctx, state, CUSTOMER_MEMORY_TOOL, {})).erro).toContain("Limite");
  });
});
