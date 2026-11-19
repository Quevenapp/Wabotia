import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { sha } from "../src/security";
import { conversation } from "../src/service";
import { modulesApi } from "../src/modules/api";
import { now, uid, type Actor, type Conversation } from "../src/types";
import {
  areaEmailCount, configureEmail, EMAIL_AREA_DAILY, sendConversationEmail,
  type ConversationEmailInput,
} from "../src/email";
import {
  conversationEmailOptions, previewConversationEmail, sendConversationTranscript,
} from "../src/conversation-email";
import { fixture, receive, type Fixture } from "./service-center-fixture";

// Respostas sintéticas da fronteira de e-mail. Nenhuma chamada de rede é permitida.
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const mailUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`;
let sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
let unexpected: string[] = [];
let reply: (to: string) => Response;
beforeEach(async () => {
  sent = [];
  unexpected = [];
  reply = (to) => Response.json({ success: true, result: { delivered: [to], queued: [], permanent_bounces: [] } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== mailUrl || request.method !== "POST") {
      unexpected.push(request.url);
      throw new Error(`Rede inesperada: ${request.url}`);
    }
    const body = await request.json() as typeof sent[number];
    sent.push(body);
    return reply(body.to);
  });
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
  expect(unexpected).toEqual([]);
});

async function email(f: Fixture, extra: Record<string, unknown> = {}) {
  return configureEmail(env, f.admin, {
    account_id: ACCOUNT, token: "token-simulado-de-envio-1234567890",
    from_address: "atendimento@example.test", from_name: "Empresa de teste", ...extra,
  });
}
async function setup() {
  const f = await fixture();
  const id = uid(), at = now() - 1000;
  await exec(env,
    "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated,title) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id, f.profile, f.line, `channel:${f.line}`, "5511999988776", "5511999988776", uid(), at, at, at, "Contato",
  );
  const c = await conversation(env, id, f.profile);
  await addMessage(c, "customer", "Olá, preciso de atendimento.");
  await email(f);
  return { f, c };
}
async function addMessage(c: Conversation, direction: string, text: string,
  extra: { attachments?: string[]; content?: object; created?: number; author?: string } = {}) {
  const id = uid();
  await exec(env,
    "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,content,created) VALUES(?,?,?,?,?,?,?,?,?)",
    id, c.profile_id, c.id, direction, extra.author ?? (direction === "customer" ? `customer:${c.external_namespace}:${c.external_id}` : "external"),
    text, JSON.stringify(extra.attachments ?? []), JSON.stringify({ customerSession: c.session, ...extra.content }), extra.created ?? now() - 500,
  );
  return id;
}
async function grant(f: Fixture) {
  const access = ["conversations", "conversations:email", "contacts"];
  await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(access), f.member.id);
  return { ...f.member, access };
}
async function contact(c: Conversation, actor: Actor, address = "cliente@example.test") {
  const id = uid(), at = now();
  await exec(env,
    "INSERT INTO contacts(id,profile_id,namespace,name,email,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente',?,'cliente','manual',?,?,?,?)",
    id, c.profile_id, address, actor.id, actor.id, at, at,
  );
  await exec(env,
    "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
    c.id, c.profile_id, id, actor.id, at,
  );
  return id;
}
async function app(f: Fixture, scopes = ["conversations:read", "conversations:email"]): Promise<Actor> {
  const id = uid();
  await exec(env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,'Aplicação',?,?,'[]',?)",
    id, JSON.stringify([f.profile]), JSON.stringify(scopes), now(),
  );
  return { id: `app:${id}`, kind: "app", role: "service", name: "Aplicação", profiles: [f.profile], scopes, bots: [], rate: 60, runLimit: 3 };
}
const self = { destination: { kind: "self" }, range: { kind: "session" } } as const;
const custom = (address = "destino@example.test") => ({ destination: { kind: "custom" as const, address }, range: { kind: "session" as const } });
const preview = (actor: Actor, c: Conversation) => previewConversationEmail(env, actor, c, self);
async function lowInput(f: Fixture, c: Conversation, key = uid(), actorId = f.admin.id): Promise<ConversationEmailInput> {
  return { profileId: f.profile, actorId, conversationId: c.id, key, requestHash: await sha(key),
    to: "destino@example.test", subject: "Conversa de atendimento · 19/11/2026", text: "Conteúdo aprovado.", html: "<p>Conteúdo aprovado.</p>" };
}
async function reservations(f: Fixture, c: Conversation, count: number, actor: (i: number) => string,
  purpose = "conversation.email", moduleId: string | null = null, created = now()) {
  await env.DB.batch(Array.from({ length: count }, (_, i) => env.DB.prepare(
    "INSERT INTO email_log(id,profile_id,module_id,user_id,conversation_id,purpose,to_masked,to_hash,status,created) VALUES(?,?,?,?,?,?,?,'hash','unknown',?)",
  ).bind(uid(), f.profile, moduleId, actor(i), c.id, purpose, "d***@example.test", created)));
}

describe("transcrição autorizada de conversa", () => {
  it("só WhatsApp: webhook repetido produz uma mensagem exportável e não altera o atendimento", async () => {
    const f = await fixture();
    await email(f);
    const event = uid();
    const c = await receive(f, f.line, "Mensagem única do webhook", "5511998877665", {}, { message_id: event });
    const repeated = await receive(f, f.line, "Mensagem única do webhook", "5511998877665", {}, { message_id: event });
    expect(repeated.id).toBe(c.id);
    const before = await conversation(env, c.id, f.profile);
    const p = await preview(f.admin, c);
    expect(p.messageCount).toBe(1);
    const result = await sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken });
    expect(result.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].text.match(/Mensagem única do webhook/g)).toHaveLength(1);
    expect(sent[0].text).toContain("WhatsApp");
    expect(await conversation(env, c.id, f.profile)).toEqual(before);
    expect(await one(env, "SELECT count(*) n FROM messages WHERE conversation_id=? AND direction='customer'", c.id)).toMatchObject({ n: 1 });
  });

  it("sem configuração fica indisponível; '*' não permite exportar", async () => {
    const { f, c } = await setup();
    await exec(env, "DELETE FROM secrets WHERE id='email:config'");
    const options = await conversationEmailOptions(env, f.admin, c);
    expect(options.available).toBe(false);
    expect(options.reason).toContain("E-mail");
    await expect(preview(f.admin, c)).rejects.toMatchObject({ status: 409 });
    await email(f);
    expect((await conversationEmailOptions(env, f.member, c)).available).toBe(false);
    await expect(preview(f.member, c)).rejects.toMatchObject({ status: 403 });
    expect(sent).toHaveLength(0);
  });

  it("reautoriza a pessoa também no replay depois da revogação", async () => {
    const { f, c } = await setup(), actor = await grant(f);
    const p = await preview(actor, c), key = uid();
    await sendConversationTranscript(env, actor, c, key, { previewToken: p.previewToken });
    await exec(env, "UPDATE users SET access='[\"conversations\"]' WHERE id=?", actor.id);
    await expect(sendConversationTranscript(env, actor, c, key, { previewToken: p.previewToken })).rejects.toMatchObject({ status: 403 });
    expect(sent).toHaveLength(1);
  });

  it("aplicação exige dois escopos explícitos, respeita namespace e não tem destino self", async () => {
    const { f, c } = await setup();
    await email(f, { transcript_custom_enabled: true });
    const actor = await app(f);
    expect((await conversationEmailOptions(env, actor, c)).destinations).not.toContain("self");
    await expect(preview(actor, c)).rejects.toMatchObject({ status: 403 });
    const p = await previewConversationEmail(env, actor, c, custom());
    await sendConversationTranscript(env, actor, c, uid(), { previewToken: p.previewToken, confirmedRecipient: p.recipient });
    for (const scopes of [["*"], ["conversations:read"], ["conversations:email"]])
      await expect(previewConversationEmail(env, await app(f, scopes), c, custom())).rejects.toMatchObject({ status: 403 });
    await exec(env, "UPDATE conversations SET external_namespace=? WHERE id=?", "app:outra-aplicacao", c.id);
    await expect(previewConversationEmail(env, actor, c, custom())).rejects.toMatchObject({ status: 404 });
    expect(sent).toHaveLength(1);
    await exec(env, "UPDATE conversations SET external_namespace=?,connection_id=NULL WHERE id=?", `app:${actor.id}`, c.id);
    const own = await previewConversationEmail(env, actor, c, custom());
    await sendConversationTranscript(env, actor, c, uid(), { previewToken: own.previewToken, confirmedRecipient: own.recipient });
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain("Canal: Aplicação");
    expect(sent[1].text).not.toContain("WhatsApp");
  });

  it("bot, ator delegado, módulo e conector não exportam; grupo e equipe são recusados", async () => {
    const { f, c } = await setup();
    for (const actor of [
      { ...f.admin, via: { kind: "bot" as const, bot_id: "bot", run_id: "run", masked: true } },
      { ...f.admin, kind: "connector" as const },
      { ...f.admin, module: { id: "os", reach: [] } },
    ]) await expect(preview(actor, c)).rejects.toMatchObject({ status: 403 });
    for (const kind of ["group", "internal"]) {
      await exec(env, "UPDATE conversations SET chat_type=? WHERE id=?", kind, c.id);
      await expect(preview(f.admin, c)).rejects.toMatchObject({ status: 409 });
    }
    expect(sent).toHaveLength(0);
  });

  it("só seleciona customer/outbound, exclui notas e campos laterais e esconde texto apagado", async () => {
    const { f, c } = await setup();
    await addMessage(c, "note", "NOTA CONFIDENCIAL");
    await addMessage(c, "system", "CAMPO LATERAL");
    await addMessage(c, "outbound", "<script>alert('oi')</script>", { author: f.admin.id, content: { form: "RESPOSTA FORMULÁRIO", billing: "COBRANÇA PRIVADA" } });
    await addMessage(c, "customer", "TEXTO APAGADO SECRETO", { content: { deleted: true } });
    const p = await preview(f.admin, c);
    expect(p.messageCount).toBe(3);
    await sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken });
    const body = sent[0].text + sent[0].html;
    for (const hidden of ["NOTA CONFIDENCIAL", "CAMPO LATERAL", "RESPOSTA FORMULÁRIO", "COBRANÇA PRIVADA", "TEXTO APAGADO SECRETO"])
      expect(body).not.toContain(hidden);
    expect(sent[0].text.toLowerCase()).toContain("mensagem apagada");
    expect(sent[0].html).toContain("&lt;script&gt;");
    expect(sent[0].html).not.toContain("<script>");
  });

  it("anexo é apenas tipo/nome e documento sensível ou não visível não revela nem o nome", async () => {
    const { f, c } = await setup();
    const order = uid();
    await exec(env, "INSERT INTO os_orders(id,profile_id,number,item,problem,source,created_by,created,updated) VALUES(?,?,1,'Item','Problema','panel',?,?,?)", order, f.profile, f.admin.id, now(), now());
    for (const [index, name] of ["publico.pdf", "SEGREDO_SENSIVEL.pdf", "SEGREDO_INTERNO.pdf"].entries()) {
      const media = uid();
      await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,'application/pdf',20,?,?,?)", media, f.profile, name, `https://private.example.test/${media}?token=SEGREDO_TOKEN`, f.admin.id, now());
      const message = await addMessage(c, "customer", "Arquivo", { attachments: [media], content: { media_url: "https://temporary.example.test/token" } });
      if (index) await exec(env,
        "INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,upload_expires_at,source_message_id,source_media_id,client_visible,sensitive,created_by,created,updated) VALUES(?,?,?,?,'application/pdf',20,?,?,?,0,?,?,?,?)",
        uid(), f.profile, order, name, now() + 60000, message, media, index === 1 ? 1 : 0, f.admin.id, now(), now(),
      );
    }
    // Documento enviado por OS: vínculo pelo recibo/outbox, sem origem de entrada no documento.
    const outboundDocument = uid(), outboundDelivery = uid();
    await exec(env,
      "INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,upload_expires_at,client_visible,sensitive,created_by,created,updated) VALUES(?,?,?,'SEGREDO_SAIDA.pdf','application/pdf',20,?,0,1,?,?,?)",
      outboundDocument, f.profile, order, now() + 60000, f.admin.id, now(), now(),
    );
    await exec(env,
      "INSERT INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,?,'message',?,'{}','sent',?,?,?)",
      outboundDelivery, f.profile, c.id, f.line, c.epoch, "module:os", `module:os:${c.id}:document:${outboundDocument}:1`, now(), now(),
    );
    const outboundMessage = await addMessage(c, "outbound", "SEGREDO_SAIDA.pdf");
    await exec(env, "UPDATE messages SET source_key=? WHERE id=?", `delivery:${outboundDelivery}`, outboundMessage);
    const p = await preview(f.admin, c);
    await sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken });
    expect(sent[0].text).toContain("publico.pdf");
    expect(sent[0].text).toContain("[documento não incluído]");
    for (const hidden of ["SEGREDO_SENSIVEL", "SEGREDO_INTERNO", "SEGREDO_SAIDA", "private.example", "temporary.example", "SEGREDO_TOKEN"])
      expect(sent[0].text + sent[0].html).not.toContain(hidden);
  });

  it("contato exige solicitação do cliente e confirmação; mudança cadastral invalida a prévia", async () => {
    const { f, c } = await setup(), id = await contact(c, f.admin);
    const p = await previewConversationEmail(env, f.admin, c, { ...self, destination: { kind: "contact" } });
    expect(p).toMatchObject({ recipient: "cliente@example.test", requiresConfirmation: true, requiresCustomerRequest: true });
    for (const confirmation of [{}, { confirmedRecipient: p.recipient }, { customerRequested: true }, { customerRequested: true, confirmedRecipient: "outra@example.test" }])
      await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken, ...confirmation })).rejects.toMatchObject({ status: 400 });
    await exec(env, "UPDATE contacts SET email='alterado@example.test',version=version+1 WHERE id=?", id);
    await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken, confirmedRecipient: p.recipient, customerRequested: true })).rejects.toMatchObject({ status: 409 });
    expect(sent).toHaveLength(0);
  });

  it("endereço digitado começa desligado, exige confirmação e domínio exatamente permitido", async () => {
    const { f, c } = await setup();
    await expect(previewConversationEmail(env, f.admin, c, custom())).rejects.toMatchObject({ status: 403 });
    await email(f, { transcript_custom_enabled: true, transcript_allowed_domains: ["EXAMPLE.TEST"] });
    for (const address of ["a@example.test.evil", "a@evil-example.test", "a@sub.example.test", "a@example.test,b@example.test"])
      await expect(previewConversationEmail(env, f.admin, c, custom(address))).rejects.toBeInstanceOf(Error);
    const p = await previewConversationEmail(env, f.admin, c, custom("Destino@EXAMPLE.TEST"));
    expect(p.recipient).toBe("destino@example.test");
    await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken })).rejects.toMatchObject({ status: 400 });
    await sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken, confirmedRecipient: p.recipient });
    expect(sent).toHaveLength(1);
  });

  it("destino digitado mascara CPF/CNPJ no texto, nomes de arquivo e cabeçalhos", async () => {
    const { f, c } = await setup();
    await email(f, { transcript_custom_enabled: true });
    await exec(env, "UPDATE conversations SET title='Cliente 123.456.789-09' WHERE id=?", c.id);
    await exec(env, "UPDATE users SET name='Pessoa 12.345.678/0001-90' WHERE id=?", f.admin.id);
    const media = uid();
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'CPF_12345678909.pdf','application/pdf',20,'privado',?,?)", media, f.profile, f.admin.id, now());
    await addMessage(c, "customer", "CPF 123.456.789-09 CNPJ 12.345.678/0001-90", { attachments: [media] });
    const p = await previewConversationEmail(env, f.admin, c, custom());
    await sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken, confirmedRecipient: p.recipient });
    for (const value of ["123.456.789-09", "12.345.678/0001-90", "12345678909"])
      expect(sent[0].text + sent[0].html).not.toContain(value);
  });

  it("sessão legada sem marcação exige datas; a prévia não incorpora mensagem nova", async () => {
    const { f, c } = await setup();
    await exec(env, "UPDATE messages SET content='{}' WHERE conversation_id=?", c.id);
    await expect(preview(f.admin, c)).rejects.toMatchObject({ status: 409 });
    const p = await previewConversationEmail(env, f.admin, c, { destination: { kind: "self" }, range: { kind: "dates", from: c.created - 1000, to: now() } });
    await addMessage(c, "customer", "MENSAGEM POSTERIOR", { created: now() + 1 });
    await sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken });
    expect(sent[0].text).not.toContain("MENSAGEM POSTERIOR");
    expect(p.messageCount).toBe(1);
  });

  it("sessão com mistura de mensagens marcadas e legadas também exige datas", async () => {
    const { f, c } = await setup();
    await addMessage(c, "outbound", "Saída legada", { content: { customerSession: null } });
    expect((await conversationEmailOptions(env, f.admin, c)).ranges).toEqual(["dates"]);
    await expect(preview(f.admin, c)).rejects.toMatchObject({ status: 409, code: "session_unavailable" });
    const p = await previewConversationEmail(env, f.admin, c, { destination: { kind: "self" }, range: { kind: "dates", from: c.created - 1000, to: now() } });
    expect(p.messageCount).toBe(2);
  });

  it("token é vinculado ao ator, assinado, expira em dez minutos e não contém a transcrição", async () => {
    const { f, c } = await setup(), actor = await grant(f);
    const p = await preview(f.admin, c);
    const payload = atob(p.previewToken.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"));
    expect(payload).not.toContain("preciso de atendimento");
    await expect(sendConversationTranscript(env, actor, c, uid(), { previewToken: p.previewToken })).rejects.toBeInstanceOf(Error);
    await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: `x${p.previewToken}` })).rejects.toBeInstanceOf(Error);
    vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken })).rejects.toMatchObject({ status: 410 });
    expect(sent).toHaveLength(0);
  });

  it("alteração do conteúdo aprovado exige nova prévia", async () => {
    const { f, c } = await setup(), p = await preview(f.admin, c);
    await exec(env, "UPDATE messages SET text='Texto editado' WHERE conversation_id=?", c.id);
    await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken })).rejects.toMatchObject({ status: 409 });
    expect(sent).toHaveLength(0);
  });

  it("replay após expirar a prévia lê o recibo autorizado, mas uma chave nova exige nova prévia", async () => {
    const { f, c } = await setup(), p = await preview(f.admin, c), key = uid();
    const first = await sendConversationTranscript(env, f.admin, c, key, { previewToken: p.previewToken });
    vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    expect(await sendConversationTranscript(env, f.admin, c, key, { previewToken: p.previewToken }))
      .toMatchObject({ id: first.id, status: "sent", duplicate: true });
    await expect(sendConversationTranscript(env, f.admin, c, uid(), { previewToken: p.previewToken }))
      .rejects.toMatchObject({ status: 410, code: "preview_expired" });
    expect(sent).toHaveLength(1);
  });

  it("replay após editar mensagem lê o recibo, sem regenerar ou reenviar a transcrição", async () => {
    const { f, c } = await setup(), p = await preview(f.admin, c), key = uid();
    const first = await sendConversationTranscript(env, f.admin, c, key, { previewToken: p.previewToken });
    await exec(env, "UPDATE messages SET text='Conteúdo posterior' WHERE conversation_id=? AND direction='customer'", c.id);
    expect(await sendConversationTranscript(env, f.admin, c, key, { previewToken: p.previewToken }))
      .toMatchObject({ id: first.id, status: "sent", duplicate: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toContain("Conteúdo posterior");
  });

  it("recusa excesso de texto e de HTML, sem truncar", async () => {
    const { f, c } = await setup();
    for (const text of ["x".repeat(50001), '"'.repeat(34000)]) {
      await exec(env, "UPDATE messages SET text=? WHERE conversation_id=?", text, c.id);
      await expect(preview(f.admin, c)).rejects.toMatchObject({ status: 413, code: "transcript_too_large" });
    }
    expect(sent).toHaveLength(0);
  });

  it("lê até 2.001 mensagens para detectar excesso, sem cortar as 2.000 exportáveis", async () => {
    const { f, c } = await setup();
    await exec(env,
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
       INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,content,created)
       SELECT ?||':'||x,?,?,'customer','customer','x',json_object('customerSession',?),? FROM n`,
      uid(), f.profile, c.id, c.session, now() - 500,
    );
    await expect(preview(f.admin, c)).rejects.toMatchObject({ status: 413, code: "transcript_too_large" });
    expect(sent).toHaveLength(0);
  });
});

describe("reserva de cota e resultado de envio", () => {
  it("concorrência reserva apenas a décima cota do ator", async () => {
    const { f, c } = await setup();
    await reservations(f, c, 9, () => f.admin.id);
    const results = await Promise.allSettled([sendConversationEmail(env, await lowInput(f, c)), sendConversationEmail(env, await lowInput(f, c))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { status: 429, code: "email_limit" } }]);
    expect(sent).toHaveLength(1);
    expect(await one(env, "SELECT count(*) n FROM email_log WHERE profile_id=? AND purpose='conversation.email'", f.profile)).toMatchObject({ n: 10 });
  });

  it("concorrência reserva apenas a quinquagésima cota da área; reservas vencidas não contam", async () => {
    const { f, c } = await setup();
    await reservations(f, c, 49, (i) => `ator:${i}`);
    await reservations(f, c, 15, () => f.admin.id, "conversation.email", null, now() - 86400001);
    const results = await Promise.allSettled([sendConversationEmail(env, await lowInput(f, c)), sendConversationEmail(env, await lowInput(f, c, uid(), f.other.id))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { code: "email_limit" } }]);
    expect(sent).toHaveLength(1);
  });

  it("duplo clique é replay e chave com outro corpo é conflito sem consumir cota", async () => {
    const { f, c } = await setup(), p = await preview(f.admin, c), key = uid();
    const results = await Promise.all([
      sendConversationTranscript(env, f.admin, c, key, { previewToken: p.previewToken }),
      sendConversationTranscript(env, f.admin, c, key, { previewToken: p.previewToken }),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const input = await lowInput(f, c, "outra-chave");
    await sendConversationEmail(env, input);
    await expect(sendConversationEmail(env, { ...input, text: "Outro corpo", requestHash: await sha("outro corpo") })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(sent).toHaveLength(2);
    const rows = await all(env, "SELECT * FROM email_log WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(2);
    expect(await one(env, "SELECT count(*) n FROM messages WHERE conversation_id=? AND direction='note'", c.id)).toMatchObject({ n: 2 });
    expect(await one(env, "SELECT count(*) n FROM audit WHERE profile_id=? AND operation='conversation.email'", f.profile)).toMatchObject({ n: 2 });
    for (const row of rows) {
      expect(row.conversation_id).toBe(c.id);
      expect(row.user_id).toBe(f.admin.id);
      expect(row.request_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(row)).not.toContain("destino@example.test");
      expect(JSON.stringify(row)).not.toContain("Conteúdo aprovado");
    }
  });

  it("queda após reserva conserva resultado indeterminado e não reenvia", async () => {
    const { f, c } = await setup(), input = await lowInput(f, c);
    reply = () => { throw new Error("conexão interrompida após reserva"); };
    expect(await sendConversationEmail(env, input)).toMatchObject({ status: "unknown", duplicate: false });
    expect(await sendConversationEmail(env, input)).toMatchObject({ status: "unknown", duplicate: true });
    expect(sent).toHaveLength(1);
    expect(await one(env, "SELECT count(*) n FROM email_log WHERE profile_id=?", f.profile)).toMatchObject({ n: 1 });
  });

  it("queda ao confirmar depois da resposta do provedor também impede reenvio", async () => {
    const { f, c } = await setup(), input = await lowInput(f, c);
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") return (statements: D1PreparedStatement[]) => {
          if (sent.length) throw new Error("queda antes de persistir confirmação");
          return target.batch(statements);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await sendConversationEmail({ ...env, DB: db }, input)).toMatchObject({ status: "unknown", duplicate: false });
    expect(await sendConversationEmail(env, input)).toMatchObject({ status: "unknown", duplicate: true });
    expect(sent).toHaveLength(1);
    expect(await one(env, "SELECT status FROM email_log WHERE profile_id=?", f.profile)).toMatchObject({ status: "unknown" });
  });

  it("recusa confirmada também consome cota e seu replay não chama o provedor", async () => {
    const { f, c } = await setup(), input = await lowInput(f, c);
    await reservations(f, c, 9, () => f.admin.id);
    reply = () => Response.json({ success: false, errors: [{ code: 10101 }] }, { status: 401 });
    expect(await sendConversationEmail(env, input)).toMatchObject({ status: "failed", duplicate: false });
    expect(await sendConversationEmail(env, input)).toMatchObject({ status: "failed", duplicate: true });
    await expect(sendConversationEmail(env, await lowInput(f, c))).rejects.toMatchObject({ code: "email_limit" });
    expect(sent).toHaveLength(1);
  });

  it("cotas de transcrição e módulos são independentes e o teto dos módulos continua 200", async () => {
    const { f, c } = await setup();
    await reservations(f, c, 49, (i) => `outro:${i}`);
    expect(await areaEmailCount(env, f.profile)).toBe(0);
    expect(EMAIL_AREA_DAILY).toBe(200);
    await reservations(f, c, EMAIL_AREA_DAILY, () => f.admin.id, "booking", "reserva");
    expect(await areaEmailCount(env, f.profile)).toBe(200);
    expect(await sendConversationEmail(env, await lowInput(f, c))).toMatchObject({ status: "sent" });
    expect(await areaEmailCount(env, f.profile)).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("cota dos módulos conta avisos legados, mas exclui outras finalidades, áreas e registros vencidos", async () => {
    const { f } = await setup();
    const at = now();
    const rows = [
      ...["billing", "scheduling", "order", "booking"].map((purpose) =>
        ({ profile: f.profile, module: null, purpose, status: "failed", created: at })),
      // Um registro identificado conta uma única vez, mesmo com finalidade legada.
      { profile: f.profile, module: "forms", purpose: "booking", status: "sent", created: at },
      { profile: f.profile, module: "forms", purpose: "outra", status: "sending", created: at },
      ...["conversation.email", "account.invite", "account.reset", "account.forgot", "test", "outra"].map((purpose) =>
        ({ profile: f.profile, module: null, purpose, status: "unknown", created: at })),
      { profile: f.profile, module: null, purpose: "booking", status: "sent", created: at - 86400001 },
      { profile: f.profile, module: "forms", purpose: "booking", status: "sent", created: at - 86400001 },
      { profile: uid(), module: null, purpose: "booking", status: "sent", created: at },
      { profile: uid(), module: "forms", purpose: "booking", status: "sent", created: at },
    ];
    await env.DB.batch(rows.map((row) => env.DB.prepare(
      "INSERT INTO email_log(id,profile_id,module_id,purpose,to_masked,to_hash,status,created) VALUES(?,?,?,?,'d***@example.test','hash',?,?)",
    ).bind(uid(), row.profile, row.module, row.purpose, row.status, row.created)));
    expect(await areaEmailCount(env, f.profile)).toBe(6);
    expect(sent).toHaveLength(0);
  });

  it("só WhatsApp: avisos legados preservam o limite de 200 e o replay sem consumir a cota de transcrição", async () => {
    const { f, c } = await setup();
    const ctx = modulesApi(env, f.profile, "forms");
    const message = { to: "cliente@example.test", subject: "Reserva confirmada", text: "Reserva para sábado." };
    await ctx.recordConsent(c, { purpose: "booking", source: "panel" });
    const first = await ctx.sendEmail(c, message, { purpose: "booking", key: "primeiro" });
    // Mesmo formato do histórico usado pelo teste antigo: sem module_id ou
    // metadados da transcrição. O único aviso novo já ocupa a primeira vaga.
    await env.DB.batch(Array.from({ length: EMAIL_AREA_DAILY - 1 }, () => env.DB.prepare(
      "INSERT INTO email_log(id,profile_id,purpose,to_masked,to_hash,status,created) VALUES(?,?,'booking','d***@example.test','hash','sent',?)",
    ).bind(uid(), f.profile, now())));
    expect(await areaEmailCount(env, f.profile)).toBe(EMAIL_AREA_DAILY);
    await expect(ctx.sendEmail(c, message, { purpose: "booking", key: "excedente" }))
      .rejects.toMatchObject({ status: 429, code: "email_limit" });
    expect(await ctx.sendEmail(c, message, { purpose: "booking", key: "primeiro" }))
      .toMatchObject({ id: first.id, repeated: true });
    expect(sent).toHaveLength(1);
    expect(await sendConversationEmail(env, await lowInput(f, c))).toMatchObject({ status: "sent" });
    expect(await areaEmailCount(env, f.profile)).toBe(EMAIL_AREA_DAILY);
    expect(sent).toHaveLength(2);
  });
});
