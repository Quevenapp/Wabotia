import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { customerHistory, customerTextHistory, projectCustomerInput } from "../src/customer/history";
import { processInbox, processRun } from "../src/engine";
import { lookupProtocols, protocolSummary } from "../src/protocol-lookup";
import { conversation } from "../src/service";
import { setSecret } from "../src/security";
import { defaults, now, uid, type Run } from "../src/types";
import { bot, fixture } from "./service-center-fixture";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function contact(profile: string, at: number) {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente','','automatic','test','test',?,?)", id, profile, at, at);
  return id;
}
async function setup(persisted = true) {
  const f = await fixture(), at = now() - 10000, cid = uid(), session = uid();
  const a = await contact(f.profile, at - 10), b = await contact(f.profile, at - 10);
  await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,'5511999990001','5511999990001','ready',?,?,?,?)", cid, f.profile, f.qr, `channel:${f.qr}`, cid, session, at, at, at);
  await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',?)", cid, f.profile, a, at - 1);
  const result = { ...f, at, cid, session, a, b };
  if (persisted) await sessionRecord(result, "conversations", a);
  return result;
}
type F = Awaited<ReturnType<typeof setup>>;
async function sessionRecord(f: Pick<F, "profile" | "cid" | "session" | "at">, module: "core" | "conversations", owner: string, at = f.at) {
  await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,?,?,?,?,?,'origem-preservada',?)", f.profile, module, module === "core" ? "conversation" : "session", `${f.cid}:${f.session}`, owner, f.cid, at);
}
async function ticket(f: F, owner: string | null = f.a, at = f.at + 1, id = uid()) {
  const number = `WA-${uid().replaceAll("-", "").slice(0, 12)}-ABCD`.toUpperCase();
  await exec(env, "INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,created,updated) VALUES(?,?,?,?,'Texto do titular A','open',?,?)", id, number, f.profile, f.cid, at, at);
  if (owner) await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'tickets','ticket',?,?,?,'test',?)", f.profile, id, owner, f.cid, at);
  return { id, number };
}
async function message(f: F, text: string, content: any = {}, at = f.at + 10, direction = "in") {
  const id = uid();
  await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,content,created) VALUES(?,?,?,?,?,?,?,?)", id, f.profile, f.cid, direction, "test", text, JSON.stringify(content), at);
  return id;
}
const read = (f: F, owner = f.a) => customerHistory.read(env, f.admin, f.profile, { contactId: owner }, { limit: 50 });
const maintain = (f: F, items = 4) => customerHistory.maintain(env, f.profile, { remainingStatements: 9, remainingItems: items });

describe("S2 — protocolos respeitam a titularidade histórica", () => {
  it("a conversa original e o mesmo telefone não autorizam B a ler o protocolo de A", async () => {
    const f = await setup(), t = await ticket(f), stale = await conversation(env, f.cid, f.profile);
    expect(await lookupProtocols(env, stale, t.number)).toHaveLength(1);
    await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", f.b, now(), f.cid);
    await exec(env, "UPDATE conversations SET session=? WHERE id=?", uid(), f.cid);
    // Inclui o objeto anterior à reassociação: a autorização deve ser relida.
    const denied = await lookupProtocols(env, stale, t.number);
    expect(denied).toEqual([]);
    expect(protocolSummary(denied, true)).toBe(protocolSummary(await lookupProtocols(env, stale, "999999999"), true));
  });

  it.each(["blocked", "excluded", "ambiguous"])("o estado %s não reabre o fallback nem na origem", async state => {
    const f = await setup(), t = await ticket(f), stale = await conversation(env, f.cid, f.profile);
    await exec(env, "UPDATE conversations SET customer_link_state=? WHERE id=?", state, f.cid);
    expect(await lookupProtocols(env, stale, t.number)).toEqual([]);
  });

  it.each(["blocked", "excluded", "ambiguous"])("histórico %s permanece vazio e conserva a pendência apenas da ambiguidade", async state => {
    const f = await setup();
    await ticket(f);
    await exec(env, "UPDATE conversations SET customer_link_state=? WHERE id=?", state, f.cid);
    const history = () => customerHistory.read(env, f.admin, f.profile, { conversationId: f.cid }, {});
    expect(await history()).toEqual({ items: [], nextCursor: null, incomplete: state === "ambiguous" });
    await exec(env, "UPDATE contacts SET identity_state='erasing' WHERE id=?", f.a);
    expect(await history()).toEqual({ items: [], nextCursor: null, incomplete: false });
  });

  it.each(["restricted", "erasing", "erased"])("a restrição %s prevalece sobre o número e a conversa", async state => {
    const f = await setup(), t = await ticket(f);
    await exec(env, "UPDATE contacts SET identity_state=? WHERE id=?", state, f.a);
    expect(await lookupProtocols(env, await conversation(env, f.cid, f.profile), t.number)).toEqual([]);
  });

  it("exige module/kind exatos e não usa uma sessão conflitante como prova", async () => {
    const f = await setup(), t = await ticket(f, f.b);
    // Mesmo ID em outra fonte não concede acesso ao protocolo cujo dono é B.
    await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'queue','ticket',?,?,?,'test',?)", f.profile, t.id, f.a, f.cid, f.at);
    expect(await lookupProtocols(env, await conversation(env, f.cid, f.profile), t.number)).toEqual([]);
    const own = await ticket(f);
    await sessionRecord(f, "core", f.b);
    expect(await lookupProtocols(env, await conversation(env, f.cid, f.profile), own.number)).toEqual([]);
  });

  it("mantém o legado com continuidade e recusa a associação posterior", async () => {
    const f = await setup(false), t = await ticket(f, null);
    await message(f, "Pedido autenticado", {}, f.at);
    expect(await lookupProtocols(env, await conversation(env, f.cid, f.profile), t.number)).toHaveLength(1);
    await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", f.b, now(), f.cid);
    expect(await lookupProtocols(env, await conversation(env, f.cid, f.profile), t.number)).toEqual([]);
  });

  it("o vínculo persistido autoriza entre linhas mesmo durante preenchimento pendente", async () => {
    const f = await setup(), t = await ticket(f), cid = uid(), session = uid();
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,'5511999990001','5511999990001','pending',?,?,?,?)", cid, f.profile, f.second, `channel:${f.second}`, cid, session, f.at, f.at, f.at);
    await sessionRecord({ ...f, cid, session }, "conversations", f.a);
    expect(await lookupProtocols(env, await conversation(env, cid, f.profile), t.number)).toHaveLength(1);
  });

  it("recupera legado entre linhas pela associação anterior, nunca só pelo telefone", async () => {
    const f = await setup(false), t = await ticket(f, null), cid = uid(), session = uid();
    await exec(env, "UPDATE conversations SET epoch=5 WHERE id=?", f.cid);
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,'5511999990001','5511999990001','pending',?,?,?,?)", cid, f.profile, f.second, `channel:${f.second}`, cid, session, f.at, f.at, f.at);
    await sessionRecord({ ...f, cid, session }, "conversations", f.a);
    const current = await conversation(env, cid, f.profile);
    expect(await lookupProtocols(env, current, t.number)).toHaveLength(1);
    await exec(env, "DELETE FROM conversation_contacts WHERE conversation_id=?", f.cid);
    expect(await lookupProtocols(env, current, t.number)).toEqual([]);
  });
});

describe("E1 e E4 — sessões antigas e manutenção com pendências", () => {
  it("lê as duas chaves uma única vez e conserva a data original", async () => {
    const f = await setup(false);
    await sessionRecord(f, "core", f.a, f.at - 100);
    expect((await read(f)).items).toEqual([expect.objectContaining({ sourceKey: `conversation:${f.cid}:${f.session}`, occurredAt: f.at - 100 })]);
    await sessionRecord(f, "conversations", f.a, f.at);
    expect((await read(f)).items).toHaveLength(1);
    expect((await read(f)).items[0].occurredAt).toBe(f.at - 100);
    const byConversation = await customerHistory.read(env, f.admin, f.profile, { conversationId: f.cid }, {});
    expect(byConversation.items).toHaveLength(1);
  });

  it("converte em lote sem reconstruir dono, data ou origem pelo vínculo atual", async () => {
    const f = await setup(false);
    await sessionRecord(f, "core", f.a, f.at - 123);
    await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", f.b, now(), f.cid);
    await maintain(f);
    expect(await one(env, "SELECT contact_id,conversation_id,record_id,linked_by,occurred_at FROM customer_records WHERE profile_id=? AND module_id='conversations'", f.profile)).toEqual({ contact_id: f.a, conversation_id: f.cid, record_id: `${f.cid}:${f.session}`, linked_by: "origem-preservada", occurred_at: f.at - 123 });
    expect((await read(f)).items).toHaveLength(1);
    expect((await read(f, f.b)).items).toEqual([]);
    await maintain(f);
    expect(await all(env, "SELECT record_id FROM customer_records WHERE profile_id=? AND module_id='conversations'", f.profile)).toHaveLength(1);
  });

  it("converte sessões encerradas em lotes limitados e mantém suas datas", async () => {
    const f = await setup();
    for (let n = 0; n < 7; n++) await sessionRecord({ ...f, session: `antiga-${n}` }, "core", f.a, f.at - 700 + n);
    for (let n = 0; n < 4; n++) {
      const result = await maintain(f, 2);
      expect(result.items).toBeLessThanOrEqual(2);
      expect(result.statements).toBeLessThanOrEqual(9);
    }
    const converted = await all(env, "SELECT record_id,occurred_at,linked_by FROM customer_records WHERE profile_id=? AND module_id='conversations' AND record_id LIKE ? ORDER BY record_id", f.profile, `${f.cid}:antiga-%`);
    expect(converted).toEqual(Array.from({ length: 7 }, (_, n) => ({ record_id: `${f.cid}:antiga-${n}`, occurred_at: f.at - 700 + n, linked_by: "origem-preservada" })));
    expect((await read(f)).items).toHaveLength(8);
  });

  it("donos conflitantes ficam pendentes, sem atribuição nem exposição a qualquer dono", async () => {
    const f = await setup();
    await sessionRecord(f, "core", f.b, f.at - 1);
    expect((await read(f)).items).toEqual([]);
    expect((await read(f, f.b)).items).toEqual([]);
    expect((await maintain(f)).pending).toBe(true);
    const progress = await one(env, "SELECT * FROM customer_progress WHERE profile_id=? AND task='history:v1'", f.profile);
    expect(progress.complete).toBe(0);
    expect(JSON.parse(progress.cursor_json).unresolved).toBe(true);
    expect(await all(env, "SELECT module_id,contact_id FROM customer_records WHERE profile_id=? ORDER BY module_id", f.profile)).toEqual([{ module_id: "conversations", contact_id: f.a }, { module_id: "core", contact_id: f.b }]);
  });

  it("avança além de pendências permanentes, não repete a rodada e permite revisita controlada", async () => {
    const f = await setup();
    for (let n = 0; n < 9; n++) await ticket(f, null, f.at - 100, `${f.profile}-a${n}`);
    const valid = await ticket(f, null, f.at + 100, `${f.profile}-z`);
    for (let n = 0; n < 4; n++) {
      const result = await maintain(f);
      expect(result.statements).toBeLessThanOrEqual(9);
      expect(result.items).toBeLessThanOrEqual(4);
    }
    expect(await one(env, "SELECT contact_id FROM customer_records WHERE profile_id=? AND module_id='tickets' AND record_id=?", f.profile, valid.id)).toEqual({ contact_id: f.a });
    const progress = await one(env, "SELECT cursor_json,complete FROM customer_progress WHERE profile_id=? AND task='history:v1'", f.profile);
    expect(progress.complete).toBe(0);
    expect(JSON.parse(progress.cursor_json)).toMatchObject({ key: `tickets:ticket:${valid.id}`, unresolved: true, revisitAt: expect.any(Number) });
    expect(await maintain(f)).toMatchObject({ pending: true, items: 0, statements: 3 });
    expect((await read(f)).incomplete).toBe(true);
    await exec(env, "UPDATE customer_progress SET cursor_json=json_set(cursor_json,'$.revisitAt',1) WHERE profile_id=? AND task='history:v1'", f.profile);
    expect((await maintain(f)).items).toBe(4);
  });
});

describe("S4 — texto autorizado antes da máscara", () => {
  it("mantém apenas o intervalo comprovado e a marca da sessão atual", async () => {
    const f = await setup(), next = uid(), since = f.at + 100;
    await message(f, "SEGREDO A", { customerSession: f.session }, f.at + 10);
    await message(f, "LEGADO A", {}, f.at + 20);
    await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", f.b, since, f.cid);
    await exec(env, "UPDATE conversations SET session=? WHERE id=?", next, f.cid);
    await sessionRecord({ ...f, session: next }, "conversations", f.b, since);
    await message(f, "MARCA ANTIGA", { customerSession: f.session }, since + 1);
    await message(f, "Mensagem atual", { customerSession: next }, since + 2);
    await message(f, "Legado no intervalo comprovado", {}, since + 3);
    expect(await customerTextHistory(env, { id: f.cid, profile_id: f.profile })).toEqual([
      { direction: "in", text: "Mensagem atual" }, { direction: "in", text: "Legado no intervalo comprovado" },
    ]);
  });

  it("sessão sem prova não inclui nem texto com marca isolada", async () => {
    const f = await setup(false);
    await exec(env, "UPDATE conversations SET epoch=8 WHERE id=?", f.cid);
    await message(f, "SEM PROVA", { customerSession: f.session });
    expect(await customerTextHistory(env, { id: f.cid, profile_id: f.profile })).toEqual([]);
  });

  it("filtra formulários e domínios privados antes do LIMIT, mantendo texto público", async () => {
    const f = await setup();
    await message(f, "Histórico público", { customerSession: f.session });
    for (let n = 0; n < 16; n++) await message(f, `SEGREDO ${n}`, { customerSession: f.session, metadata: { module_id: ["forms", "saude", "ensino", "juridico"][n % 4] } }, f.at + 20 + n);
    await message(f, "RESPOSTA", { answers: { campo: "valor" } }, f.at + 50);
    await message(f, "NOTA", {}, f.at + 60, "note");
    expect(await customerTextHistory(env, { id: f.cid, profile_id: f.profile })).toEqual([{ direction: "in", text: "Histórico público" }]);
  });

  it("remove texto privado copiado em history, sources e contexto serializado", () => {
    const result = projectCustomerInput(JSON.stringify({ request: "Qual o horário?",
      answers: { campo: "RESPOSTA PRIVADA" }, history: [{ direction: "in", text: "RESPOSTA PRIVADA" }, { text: "PRONTUÁRIO", content: { module_id: "saude" } }],
      sources: [{ id: "a", text: "PROCESSO", origin: { module: "juridico" } }, { id: "b", text: "MENOR", metadata: { module: "ensino" } }, { id: "public", text: "Horário público" }],
      context: { sources: [{ text: "Cópia: RESPOSTA PRIVADA" }], reused: JSON.stringify({ text: "FORMULÁRIO", module: "forms" }) },
    }));
    for (const secret of ["RESPOSTA PRIVADA", "PRONTUÁRIO", "PROCESSO", "MENOR", "FORMULÁRIO"]) expect(result).not.toContain(secret);
    expect(result).toContain("Horário público");
    expect(JSON.parse(result).request).toBe("Qual o horário?");
  });
});

async function aiSetup() {
  const f = await setup(), botId = await bot(f);
  const b = await one(env, "SELECT connection_id FROM bots WHERE id=?", botId);
  await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ provider: "anthropic", model: "claude-haiku-5-5", bot_options: { default: { mask_personal: false } }, text_only: true, verified_at: now() }), b.connection_id);
  await setSecret(env, `connection:${b.connection_id}`, { api_key: "test-key" });
  await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify({ ...defaults, attendant_bot: botId }), f.profile);
  await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ service: { menu_mode: "manual" } }), f.qr);
  return f;
}
async function prepareRun(f: F) {
  const c = await conversation(env, f.cid, f.profile), id = uid();
  const messageId = await message(f, "Preciso de ajuda atual", { customerSession: c.session }, now());
  await exec(env, "INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)", id, f.profile, uid(), f.cid,
    JSON.stringify({ text: "Preciso de ajuda atual", message_record_id: messageId, epoch: c.epoch, session: c.session }), now());
  await processInbox(env, f.profile);
  const run = await one<Run>(env, "SELECT * FROM bot_runs WHERE source_key=?", `inbox:${id}`);
  expect(run).toBeTruthy();
  return run!;
}
function captureModel() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    calls.push(String(init.body ?? (input instanceof Request ? await input.text() : "")));
    return Response.json({ id: `msg_${uid()}`, type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ action: "clarify", text: "Como posso ajudar?", citations: [], capability_id: null, menu_id: null, protocol_number: null, category_id: null }) }], usage: { input_tokens: 1, output_tokens: 1 } });
  }));
  return calls;
}

describe("S4 — fronteira real do provedor com mask_personal desligada", () => {
  it.each(["restricted", "erased", "reassociated"])("run preparado antes de %s não chega ao modelo", async change => {
    const f = await aiSetup();
    await message(f, "HISTÓRICO DO TITULAR A", { customerSession: f.session });
    const run = await prepareRun(f);
    expect(run.input).toContain("HISTÓRICO DO TITULAR A");
    if (change === "reassociated") await exec(env, "UPDATE conversation_contacts SET contact_id=?,created=? WHERE conversation_id=?", f.b, now(), f.cid);
    else await exec(env, "UPDATE contacts SET identity_state=? WHERE id=?", change, f.a);
    const calls = captureModel();
    await processRun(env, run);
    expect(calls).toEqual([]);
    expect((await one(env, "SELECT status FROM bot_runs WHERE id=?", run.id)).status).toBe("cancelled");
    const next = await prepareRun(f);
    expect(next.input).not.toContain("HISTÓRICO DO TITULAR A");
    await processRun(env, next);
    expect(calls).toHaveLength(change === "reassociated" ? 1 : 0);
    expect(calls.join("\n")).not.toContain("HISTÓRICO DO TITULAR A");
  });

  it("revalida runs antigos sem prova e não entrega resultado concluído após exclusão", async () => {
    const f = await aiSetup(), run = await prepareRun(f);
    const context = JSON.parse(run.context);
    delete context.customerHistoryProof;
    await exec(env, "UPDATE contacts SET identity_state='erased' WHERE id=?", f.a);
    await exec(env, "UPDATE bot_runs SET context=?,status='completed',result=? WHERE id=?", JSON.stringify(context), JSON.stringify({ action: "clarify", text: "RESULTADO ANTERIOR À EXCLUSÃO" }), run.id);
    const calls = captureModel();
    await processRun(env, (await one<Run>(env, "SELECT * FROM bot_runs WHERE id=?", run.id))!);
    expect(calls).toEqual([]);
    expect(JSON.stringify(await all(env, "SELECT payload FROM outbox WHERE conversation_id=?", f.cid))).not.toContain("RESULTADO ANTERIOR À EXCLUSÃO");
    expect((await one(env, "SELECT status FROM bot_runs WHERE id=?", run.id)).status).toBe("cancelled");
  });

  it("relê histórico pré-carregado e elimina fontes privadas do input e contexto reaproveitado", async () => {
    const f = await aiSetup();
    await message(f, "Mensagem pública anterior", { customerSession: f.session });
    await message(f, "RESPOSTA DE FORMULÁRIO", { customerSession: f.session, module_id: "forms", answers: { campo: "SEGREDO" } });
    const run = await prepareRun(f);
    expect(run.input).not.toContain("RESPOSTA DE FORMULÁRIO");
    const sources = [{ module: "saude", text: "PRONTUÁRIO PRIVADO" }, { origin: { module: "juridico" }, text: "PROCESSO PRIVADO" }, { id: "public", text: "Horário público" }];
    // A procedência ficou só no contexto; o input já tem uma cópia textual.
    const input = { ...JSON.parse(run.input), history: [{ direction: "in", text: "HISTÓRICO INJETADO" }], sources: [sources[2], { text: "Cópia: PROCESSO PRIVADO" }] };
    const context = { ...JSON.parse(run.context), sources, history: [{ direction: "in", text: "CONTEXTO ANTIGO" }] };
    await exec(env, "UPDATE bot_runs SET input=?,context=? WHERE id=?", JSON.stringify(input), JSON.stringify(context), run.id);
    const calls = captureModel();
    await processRun(env, (await one<Run>(env, "SELECT * FROM bot_runs WHERE id=?", run.id))!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Preciso de ajuda atual");
    expect(calls[0]).toContain("Mensagem pública anterior");
    for (const secret of ["RESPOSTA DE FORMULÁRIO", "PRONTUÁRIO PRIVADO", "PROCESSO PRIVADO", "HISTÓRICO INJETADO", "CONTEXTO ANTIGO"]) expect(calls[0]).not.toContain(secret);
    expect((await one(env, "SELECT status FROM bot_runs WHERE id=?", run.id)).status).toBe("completed");
  });
});
