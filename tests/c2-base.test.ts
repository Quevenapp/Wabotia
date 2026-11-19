import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { all, batch, exec, one } from "../src/db";
import { now, uid, type Conversation, type Env } from "../src/types";
import { channelRules } from "../src/channels";
import { createChannelExtensionRegistry, extensionKey, registerChannelExtension, removeChannelExtensionForTests, replaceChannelExtensionForTests } from "../src/channel-extension-registry";
import { CHANNEL_EXTENSION_STUBS } from "../src/channel-extension-stubs";
import { assertPublicChannelData, assertVerifiedIngress, authorizeChannelAction, loadChannelOperationContext,
  channelAutomationBlock, findChannelServerRoute, parseChannelAction, prepareChannelAction, signVerifiedIngress, validateChannelWritePlan, verifyIngressTicket } from "../src/channel-extension-kernel";
import { prepareChannelInbound, resolveChannelCustomer } from "../src/customer/channel-identity";
import { dispatchChannelDelivery, enqueueChannelPlan, listReadyChannelDeliveries, nextChannelDeliveryAt, recoverChannelDeliveries } from "../src/engine";
import { completeChannelDelivery } from "../src/delivery";
import { inbound } from "../src/service";
import { sendInteractive } from "../src/line-service";
import { canonical, sha } from "../src/security";
import { ChannelComposerFields, ChannelContactActions, ChannelConversationHeader, ChannelConversationInfo,
  ChannelMessageMetadata, channelCatalogVisible, prepareChannelUiAction, registerChannelUi } from "../web/channel-extensions";
import { channelConversation } from "../web/conversations/model";
import { ContactProfile } from "../web/contact-profile/ContactProfile";
import type { ChannelDraft, ChannelUiExtension } from "../web/channel-extension-contracts";
import { removeConnection, removePendingConnections } from "../src/connection-removal";
import type { ChannelExtension, ChannelOperationContext, ChannelOutboxRow, ChannelReview, ExtensionConnection, VerifiedIngress } from "../src/channel-c2-contracts";
import { assertNoChannelEffects, bearer, c2Fixture, c2Ingress, c2Request, c2TelegramWebhook, c2ZernioWebhook,
  c2Command, denyNetwork, installSyntheticReview, installTestExtension, measure, quietCoordinator, reviewFixtureEvent,
  syntheticReviewExtension, type C2Fixture } from "./c2-fixtures";

const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); network.restore(); network.assertNone();
});
async function setup(channel: Parameters<typeof c2Fixture>[0] = "googlebusiness") {
  const fixture = await c2Fixture(channel); profiles.add(fixture.profile); return fixture;
}
async function review(f: C2Fixture) {
  await installSyntheticReview(f);
  const response = await c2Ingress(f, reviewFixtureEvent(f));
  expect(response.status).toBe(202);
  const row = await one<ChannelReview>(env, "SELECT * FROM reviews WHERE profile_id=?", f.profile);
  expect(row).not.toBeNull(); return row!;
}
async function emailConversation(f: C2Fixture) {
  const id = uid();
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
    channel,channel_account_id,channel_subject_id,channel_context,customer_link_state,last_customer,created,updated)
    VALUES(?,?,?,?,?,?,'email',?,?,'{"version":1,"context":"direct"}','pending',?,?,?)`,
    id, f.profile, f.line, `channel:${f.line}`, "email:pessoa@example.test", id, f.account, "pessoa@example.test", now(), now(), now());
  return (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", id))!;
}

describe("c2-base: encaixe web sem implementação futura", () => {
  const marker = () => React.createElement("span", null, "Extensão sintética");
  const emailUi: ChannelUiExtension = {
    key: "email/direct", conversationHeader: marker, conversationInfo: marker,
    composerFields: marker, messageMetadata: marker, contactActions: marker,
    prepareAction: draft => ({ type: "email.send", text: draft.text, subject: String(draft.fields.subject ?? ""), attachments: draft.attachmentDetails }),
  };
  const commentUi: ChannelUiExtension = { key: "instagram/comment", contactActions: marker };
  it("slots instalados continuam vazios para WhatsApp e DMs da primeira leva", () => {
    registerChannelUi(emailUi); registerChannelUi(commentUi);
    const api = async () => { throw new Error("Slot ausente não faz requisição."); };
    for (const channel of ["whatsapp", "instagram", "facebook"]) {
      const conversation = { channel, chat_type: "direct" };
      const props = { conversation, detail: {}, api, root: "v1/profiles/area", now: 1, refresh: async () => undefined };
      const draft: ChannelDraft = { conversation, text: "Olá", attachments: [], attachmentDetails: [], content: {}, fields: {} };
      for (const element of [
        React.createElement(ChannelConversationHeader, props), React.createElement(ChannelConversationInfo, props),
        React.createElement(ChannelComposerFields, { ...props, draft, disabled: false, change() {} }),
        React.createElement(ChannelMessageMetadata, { ...props, message: {}, previousMessage: null, content: {} }),
        React.createElement(ChannelContactActions, { ...props, contactId: "contact", contact: {}, channels: [], extensionKeys: [] }),
      ]) expect(renderToStaticMarkup(element)).toBe("");
      expect(prepareChannelUiAction(draft)).toBeNull();
    }
    expect(channelCatalogVisible({}, "")).toBe(false);
    expect(channelCatalogVisible(undefined, "")).toBe(false);
    expect(channelCatalogVisible({ connected_channels: ["whatsapp", "instagram"] }, "")).toBe(false);
    expect(channelCatalogVisible({}, "?canais=2")).toBe(true);
    expect(channelCatalogVisible(undefined, "?canais=2")).toBe(true);
  });
  it("preserva metadados/assunto e congela uma cópia da ação e dos anexos", () => {
    registerChannelUi(emailUi);
    const metadata = { metadata: { email: { subject: "Pedido 123", identityTrust: "unverified_sender" } } };
    const conversation = channelConversation({ conversation: { id: "email", channel: "email" }, channel_extension: metadata });
    expect(conversation.channel_extension).toEqual(metadata);
    const attachments = [{ mediaId: "media", kind: "document" as const, mimeType: "application/pdf", bytes: 3 }];
    const draft: ChannelDraft = { conversation, text: "Olá", attachments: ["media"], attachmentDetails: attachments,
      content: {}, fields: { subject: "Pedido 123 — https://example.test" } };
    const action = prepareChannelUiAction(draft);
    attachments[0].mediaId = "changed";
    draft.fields = { subject: "Outro assunto" };
    expect(action).toEqual({ type: "email.send", text: "Olá", subject: "Pedido 123 — https://example.test",
      attachments: [{ mediaId: "media", kind: "document", mimeType: "application/pdf", bytes: 3 }] });
  });
  it("abre a ficha independente sem AppProvider e sem requisitar canais no render", () => {
    const markup = renderToStaticMarkup(React.createElement(ContactProfile, {
      api: async () => { throw new Error("Render não faz requisições."); }, root: "v1/profiles/area",
      contactId: "contact", scopeKey: "standalone", onClose() {},
    }));
    expect(markup).toContain("Carregando ficha");
    expect(markup).not.toContain("Extensão sintética");
  });
});

describe("c2-base: ações de canal na ficha independente", () => {
  it("projeta conexões ativas sem expor configuração e preserva a resposta sem canal", async () => {
    const f = await setup("email"), id = uid();
    await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated)
      VALUES(?,?,'team','Pessoa','pessoa','manual',?,?,?,?)`, id, f.profile, f.admin.id, f.admin.id, now(), now());
    const token = await bearer(f.admin), path = `/api/v1/profiles/${f.profile}/contacts/${id}/profile`;
    const request = () => c2Request(path, { headers: { Authorization: `Bearer ${token}` } });
    // A composição já instala o e-mail real; este caso prova o antes e o depois da instalação.
    removeChannelExtensionForTests("email/direct");
    const before = await request();
    expect(before.status, await before.clone().text()).toBe(200);
    const legacy = await before.json();
    expect(legacy).not.toHaveProperty("channel_extensions");
    registerChannelExtension({ ...CHANNEL_EXTENSION_STUBS["email/direct"],
      enabled: connection => JSON.parse(String(connection.config)).c2_enabled === true });
    const active = await request();
    expect(active.status, await active.clone().text()).toBe(200);
    const result = await active.json() as { channel_extensions: string[]; channel_status: {
      connected_channels: string[]; can_reply: boolean; connections: unknown[];
    } };
    expect(result.channel_extensions).toEqual(["email/direct"]);
    expect(result.channel_status.connected_channels).toEqual(["email"]);
    expect(result.channel_status.can_reply).toBe(true);
    expect(result.channel_status.connections).toEqual([{ id: f.line, name: f.line, kind: "email", channel: "email",
      status: "active", account_label: "Conta sintética", can_reply: true, send_ready: false }]);
    expect(JSON.stringify(result.channel_status)).not.toContain("config");
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", f.line);
    const paused = await request();
    expect(await paused.json()).toEqual(legacy);
  });
});

describe("c2-base: instalação e fachadas tardias", () => {
  it("registra o mesmo objeto uma vez, rejeita substituição e não executa nenhum hook", () => {
    const registry = createChannelExtensionRegistry(); let called = 0;
    const descriptor: ChannelExtension = { ...syntheticReviewExtension, normalize: async () => { called++; throw new Error("I/O não permitido na instalação"); } };
    registry.registerChannelExtension(descriptor); registry.registerChannelExtension(descriptor);
    expect(() => registry.registerChannelExtension({ ...descriptor })).toThrow(/já registrada/);
    expect(registry.channelExtension(descriptor.key)).toBe(descriptor);
    expect(called).toBe(0);
  });
  it("mantém stubs permanentes sem SQL, rede, credenciais ou projeção", async () => {
    const registry = createChannelExtensionRegistry();
    const stub = registry.channelExtension("telegram/direct");
    const trap = new Proxy({}, { get() { throw new Error("I/O proibido"); } });
    await expect(stub.prepareInbound(trap as ChannelOperationContext, {} as never)).rejects.toMatchObject({ status: 503, code: "channel_not_ready" });
    await expect(stub.prepareSend(trap as ChannelOperationContext, { type: "message.send", text: "Olá" })).rejects.toMatchObject({ status: 503 });
    expect(stub.view).toBeUndefined(); expect(stub.maintenance).toBeUndefined();
    registry.registerChannelExtension({ ...stub, enabled: () => true });
    expect(stub).toBe(CHANNEL_EXTENSION_STUBS["telegram/direct"]);
    expect(stub.spec.enabled).toBe(false);
  });
  it("consulta rotas na invocação, mesmo quando o consumidor precede a instalação", () => {
    const registry = createChannelExtensionRegistry(); const lookup = registry.findChannelRoute;
    expect(lookup("GET", "/reviews/one")).toBeNull();
    registry.registerChannelExtension({ ...syntheticReviewExtension,
      routes: [{ method: "GET", path: "/reviews/:id", authorization: "reviews.read", handler: async ctx => ({ id: ctx.params.id }) }] });
    expect(lookup("GET", "/c2/reviews/one")?.params).toEqual({ id: "one" });
    expect(lookup("GET", "/reviews/a%2Fb")).toBeNull();
  });
  it("canal não usado não consulta SQL e preserva WhatsApp fora do registro", async () => {
    const measured = await measure(env as Env, async counted => {
      expect(extensionKey("whatsapp")).toBeNull();
      expect(extensionKey("instagram")).toBeNull();
      expect(extensionKey("facebook")).toBeNull();
      const rules = channelRules({ id: "legacy", profile_id: "area", kind: "qr", channel: "whatsapp", config: "{}" });
      expect(rules?.enabled).toBe(true); expect(rules?.templates).toBe(false);
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      for (const channel of ["whatsapp", "instagram", "facebook"] as const)
        expect(await channelAutomationBlock(counted, { channel, chat_type: "direct" } as Conversation, "old")).toBeNull();
      expect(await channelAutomationBlock(counted, { channel: "instagram", chat_type: "comment" } as Conversation, "comment"))
        .toMatchObject({ code: "human_only" });
      expect(await channelAutomationBlock(counted, { channel: "email", chat_type: "direct" } as Conversation, "email"))
        .toMatchObject({ code: "human_only" });
    });
    expect(measured.count).toMatchObject({ calls: 0, statements: 0 });
  });
  it("não aceita publicação pública automática nem prova embutida na ação", async () => {
    const f = await setup();
    const ctx = { env, connection: { channel: "googlebusiness" }, resource: { kind: "review", id: "r" },
      authorization: { actor: { ...f.admin, kind: "app" }, profileId: f.profile, origin: "bot", permissions: [] } } as unknown as ChannelOperationContext;
    await expect(authorizeChannelAction(ctx, { type: "google.reply", version: 1, text: "Resposta" })).rejects.toMatchObject({ code: "human_only" });
    expect(() => parseChannelAction({ type: "message.send", text: "Olá", origin: "human", verified: true })).toThrow();
    expect(() => parseChannelAction({ type: "email.auto-reply", subject: "Assunto", text: "Olá" })).toThrow();
    expect(() => assertPublicChannelData({ bot_token: "segredo" })).toThrow();
    expect(() => assertPublicChannelData({ url: "https://api.telegram.org/file/bot000:segredo/arquivo" })).toThrow();
    await assertNoChannelEffects(f.profile);
  });
  it("encaminha opção de menu com link à outbox da extensão sem duplicar no replay", async () => {
    const f = await setup("tiktok"), id = uid(), command = uid();
    const stub = CHANNEL_EXTENSION_STUBS["tiktok/direct"];
    replaceChannelExtensionForTests({
      ...stub, spec: { ...stub.spec, enabled: true, contexts: { direct: { enabled: true, bot: true, publicReply: false } } },
      enabled: () => true,
      async prepareSend(ctx, action) {
        if (ctx.resource?.kind !== "conversation" || action.type !== "message.send")
          throw new Error("A fixture aceita somente texto em conversa.");
        return { resource: { kind: "conversation", id: ctx.resource.id }, operation: action.type,
          orderKey: `conversation:${ctx.resource.id}`, deliveries: [{ key: "link", payload: { text: action.text } }] };
      },
    });
    await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
      channel,channel_account_id,channel_subject_id,chat_type,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,'tiktok',?,'person','direct',?,?,?)`,
      id, f.profile, f.line, `channel:${f.line}`, "dm:person", id, f.account, now(), now(), now());
    const conversation = (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", id))!;
    const spec = { type: "cta_url" as const, body: "Acesse", display_text: "Abrir", url: "https://example.test" };
    const delivery = await sendInteractive(env as Env, "system", conversation, spec, command, "menu");
    await quietCoordinator(f.profile);
    expect(await sendInteractive(env as Env, "system", conversation, spec, command, "menu")).toBe(delivery);
    await quietCoordinator(f.profile);
    const rows = await all<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("channel");
    const payload = JSON.parse(rows[0].payload);
    expect(payload.c2.action.type).toBe("message.send");
    expect(payload.c2.delivery.text).toContain("https://example.test");
    expect(payload.c2.delivery).not.toHaveProperty("content");
  });
});

describe("c2-base: autenticidade, identidade e deduplicação", () => {
  it("confere a mensagem do comentário na mesma área, conversa e conta", async () => {
    const f = await setup("instagram"), other = await setup("instagram"), id = uid(), foreignId = uid(), commentId = uid();
    for (const [fixture, conversationId] of [[f, id], [other, foreignId]] as const)
      await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
        channel,channel_account_id,chat_type,owner,state,last_customer,created,updated)
        VALUES(?,?,?,?,?,?,'instagram',?,'comment',?,'human',?,?,?)`,
        conversationId, fixture.profile, fixture.line, `channel:${fixture.line}`, `post:${conversationId}`, conversationId,
        fixture.account, fixture.admin.id, now(), now(), now());
    const foreignMessage = uid(), localMessage = uid();
    for (const [fixture, conversationId, messageId] of [[f, id, localMessage], [other, foreignId, foreignMessage]] as const)
      await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','customer','Comentário',?)",
        messageId, fixture.profile, conversationId, now());
    // A FK simples da mensagem não basta: o kernel deve rejeitar o vínculo cruzado.
    await exec(env, `INSERT INTO channel_comments(id,profile_id,connection_id,channel,account_id,post_id,remote_id,author_id,
      conversation_id,message_id,created,updated) VALUES(?,?,?,'instagram',?,'post','remote','author',?,?,?,?)`,
      commentId, f.profile, f.line, f.account, id, foreignMessage, now(), now());
    const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=?", f.line))!;
    const conversation = (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", id))!;
    const ctx: ChannelOperationContext = { env: env as Env, connection, resource: { kind: "conversation", id, conversation },
      authorization: { actor: f.admin, profileId: f.profile, origin: "human", permissions: ["conversations:write"] }, now: now(), commandId: uid() };
    const action = { type: "comment.reply" as const, commentId, text: "Resposta humana" };
    await expect(authorizeChannelAction(ctx, action)).rejects.toMatchObject({ status: 404 });
    await exec(env, "UPDATE channel_comments SET message_id=? WHERE id=?", localMessage, commentId);
    await expect(authorizeChannelAction(ctx, action)).resolves.toBeUndefined();
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("não substitui o runtime de e-mail por API administrativa ou comando forjado", async () => {
    const f = await setup("email");
    const data = { channel: "email", verified: true, origin: "worker_email", connection_id: f.line,
      external_id: "pessoa@example.test", text: "Authentication-Results: dmarc=pass", channel_context: { context: "direct" } };
    const response = await c2Request(`/api/v1/profiles/${f.profile}/inbound`, {
      method: "POST", headers: { Authorization: `Bearer ${await bearer(f.admin)}`, "Content-Type": "application/json", "Idempotency-Key": uid() },
      body: JSON.stringify(data),
    });
    expect(response.status).toBe(403);
    expect((await c2Command(f, "inbound", data)).status).toBe(403);
    await assertNoChannelEffects(f.profile);
  });
  it("recusa ticket/escopo fabricado antes de efeitos e vincula o conteúdo ao ticket", async () => {
    const f = await setup();
    const scope = { profileId: f.profile, connectionId: f.line, channel: "googlebusiness", context: "review", accountId: f.account, source: "zernio_hmac" } as const;
    expect(() => assertVerifiedIngress(scope)).toThrow();
    const ticket = await signVerifiedIngress(env as Env, scope, { event: "original" });
    const parsed = await verifyIngressTicket(env as Env, ticket);
    expect(() => assertVerifiedIngress(parsed.scope)).not.toThrow();
    expect(() => assertVerifiedIngress(JSON.parse(JSON.stringify(parsed.scope)) as VerifiedIngress)).toThrow();
    const altered = JSON.parse(ticket); altered.body = altered.body.replace("original", "forjado");
    await expect(verifyIngressTicket(env as Env, JSON.stringify(altered))).rejects.toMatchObject({ status: 403 });
    const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/c2-inbound", {
      method: "POST", body: JSON.stringify({ profile: f.profile, ticket: JSON.stringify(altered), verified: true }),
    });
    expect(response.status).toBe(403); await assertNoChannelEffects(f.profile);
  });
  it("Worker real recusa HMAC Zernio e segredo Telegram errados sem efeitos", async () => {
    const google = await setup(); await installSyntheticReview(google);
    expect((await c2ZernioWebhook(google, reviewFixtureEvent(google), "00")).status).toBe(403);
    await assertNoChannelEffects(google.profile);
    const telegram = await setup("telegram");
    expect((await c2TelegramWebhook(telegram, { update_id: 1 }, "segredo-incorreto")).status).toBe(403);
    const malformed = await c2Request(`/webhooks/telegram-bot/${telegram.line}`, { method: "POST", body: "{", headers: { "X-Telegram-Bot-Api-Secret-Token": "errado" } });
    expect(malformed.status).toBe(403); await assertNoChannelEffects(telegram.profile);
  });
  it("Worker → Coordinator repete concorrentemente um evento sem criar duas avaliações", async () => {
    const f = await setup(); await installSyntheticReview(f); const event = reviewFixtureEvent(f);
    const responses = await Promise.all([c2ZernioWebhook(f, event), c2ZernioWebhook(f, event)]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    expect(await all(env, "SELECT version FROM reviews WHERE profile_id=?", f.profile)).toEqual([{ version: 1 }]);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("e-mail mantém vínculo operacional, nunca prova de pessoa ou telefone", async () => {
    const f = await setup("email"), c = await emailConversation(f);
    const scope: VerifiedIngress = { profileId: f.profile, connectionId: f.line, channel: "email", context: "direct", accountId: f.account, source: "worker_email" };
    await signVerifiedIngress(env as Env, scope, { authenticationResults: "dmarc=pass" });
    const plan = await prepareChannelInbound(env as Env, c, { channel: "email", provider: "email", accountId: f.account,
      subjectId: "pessoa@example.test", subjectNamespace: "email-address", ingress: scope });
    expect(plan.customer).toMatchObject({ verifiedPhone: null, verifiedChannel: null, identityTrust: "unverified_sender" });
    await batch(env, plan.statements);
    const persisted = (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", c.id))!;
    expect(await resolveChannelCustomer(env as Env, persisted)).toMatchObject({ state: "ready", verifiedPhone: null, verifiedChannel: null, identityTrust: "unverified_sender" });
    await expect(inbound(env as Env, f.profile, { channel: "email", verified: true, origin: "worker_email", text: "Falso", external_id: "pessoa@example.test" }, `channel:${f.line}`, f.line)).rejects.toMatchObject({ code: "invalid_channel_evidence" });
  });
});

describe("c2-base: outbox sem conversa e recuperação", () => {
  it("retoma recibo interrompido antes/depois da outbox e reautoriza o replay", async () => {
    const f = await setup(), resource = await review(f), key = uid();
    const data = { method: "PUT", path: `/reviews/${resource.id}/reply`, input: { version: resource.version, text: "Resposta idempotente." } };
    const scope = `${f.admin.id}:${f.profile}:c2.route`;
    await exec(env, "INSERT INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)", scope, key, await sha(canonical(data)), now());
    const first = await c2Command(f, "c2.route", data, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json();
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    // A outbox gravou, mas a resposta do comando se perdeu.
    await exec(env, "UPDATE receipts SET response=NULL WHERE scope=? AND key=?", scope, key);
    const again = await c2Command(f, "c2.route", data, key);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toEqual(result);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.admin.id);
    expect((await c2Command(f, "c2.route", data, key)).status).toBe(404);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
  });
  it("não aceita recurso de outra área mesmo se o plano não informa conversationId", async () => {
    const f = await setup(), own = await review(f), other = await setup(), foreign = await review(other);
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "review", id: own.id }, uid());
    await expect(validateChannelWritePlan({ ...ctx, resource: null }, {
      statements: [], wake: false, resource: { kind: "review", id: foreign.id },
    })).rejects.toMatchObject({ status: 404 });
    expect(await one(env, "SELECT version FROM reviews WHERE id=?", foreign.id)).toEqual({ version: 1 });
  });
  it("conclui no descritor e recupera sent sem criar balão nem enviar novamente", async () => {
    const f = await setup(), resource = await review(f);
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "review", id: resource.id }, uid());
    const action = { type: "google.reply" as const, version: resource.version, text: "Obrigada pela avaliação." };
    const plan = await prepareChannelAction(ctx, action);
    const id = await enqueueChannelPlan(ctx, plan, action);
    expect(await enqueueChannelPlan(ctx, plan, action)).toBe(id);
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    expect(row.conversation_id).toBeNull();
    // Queda depois da confirmação remota e antes da conclusão local.
    await exec(env, "UPDATE outbox SET status='sent',external_id='confirmed' WHERE id=?", id);
    await recoverChannelDeliveries(env as Env, f.profile);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await one(env, "SELECT reply_text,version FROM reviews WHERE id=?", resource.id)).toEqual({ reply_text: action.text, version: 2 });
    expect(await one(env, "SELECT completion_handled FROM outbox WHERE id=?", id)).toEqual({ completion_handled: 1 });
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("respeita retry futuro e unknown bloqueia a ordem do recurso", async () => {
    const f = await setup(), resource = await review(f);
    const action = { type: "google.reply" as const, version: resource.version, text: "Resposta" };
    const ctx = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "review", id: resource.id }, uid());
    const first = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    const time = now() + 60_000;
    await exec(env, "UPDATE channel_delivery_state SET not_before=? WHERE outbox_id=?", time, first);
    expect(await listReadyChannelDeliveries(env as Env, f.profile, 10)).toEqual([]);
    expect(await nextChannelDeliveryAt(env as Env, f.profile)).toBe(time);
    const nextCtx = { ...ctx, commandId: uid() };
    await enqueueChannelPlan(nextCtx, await prepareChannelAction(nextCtx, action), action);
    await exec(env, "UPDATE outbox SET status='unknown',completion_handled=1 WHERE id=?", first);
    expect(await listReadyChannelDeliveries(env as Env, f.profile, 10)).toEqual([]);
    expect(await nextChannelDeliveryAt(env as Env, f.profile)).toBeNull();
  });
  it("revalida concessão imediatamente antes da publicação", async () => {
    const f = await setup(), resource = await review(f);
    await exec(env, "INSERT INTO channel_public_grants(profile_id,user_id,permission,granted_by,created) VALUES(?,?,'google.reply',?,?)", f.profile, f.member.id, f.admin.id, now());
    const ctx = await loadChannelOperationContext(env as Env, f.member, f.profile, { kind: "review", id: resource.id }, uid());
    const action = { type: "google.reply" as const, version: resource.version, text: "Resposta" };
    const id = await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action);
    await exec(env, "DELETE FROM channel_public_grants WHERE profile_id=? AND user_id=?", f.profile, f.member.id);
    await dispatchChannelDelivery(env as Env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!);
    expect((await one(env, "SELECT status FROM outbox WHERE id=?", id)).status).toBe("failed");
    expect((await one(env, "SELECT reply_text FROM reviews WHERE id=?", resource.id)).reply_text).toBe("");
  });
  it("rotas instaladas depois do Worker usam autorização atual", async () => {
    const f = await setup(); await installSyntheticReview(f);
    const token = await bearer(f.admin);
    const response = await c2Request(`/api/v1/profiles/${f.profile}/c2/reviews`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.admin.id);
    expect((await c2Request(`/api/v1/profiles/${f.profile}/c2/reviews`, { headers: { Authorization: `Bearer ${token}` } })).ok).toBe(false);
  });
});

describe("c2-base: remoção de conexão própria", () => {
  it("despacha setup tardio no servidor e retoma a limpeza preservando segredo e histórico", async () => {
    const f = await setup("telegram");
    let confirmed = false;
    const calls: string[] = [];
    const configured: string[] = [];
    const descriptor: ChannelExtension = {
      ...CHANNEL_EXTENSION_STUBS["telegram/direct"],
      connectionDriver: {
        channel: "telegram",
        validate: () => ({ channel: "telegram", config: {} }),
        configure: async ctx => { configured.push(ctx.commandId); return { status: "paused", configured: false }; },
        probe: async () => ({ status: "paused", configured: false }),
        async remove(ctx) {
          calls.push(ctx.actor.kind);
          expect(ctx.connection.status).toBe("paused");
          expect(await one(env, "SELECT 1 present FROM secrets WHERE id=?", `connection:${f.line}`)).toEqual({ present: 1 });
          return confirmed ? { status: "paused", configured: false } : { status: "removal_pending", configured: true };
        },
      },
    };
    await installTestExtension(f, descriptor);
    const registry = createChannelExtensionRegistry(); registry.registerChannelExtension(descriptor);
    // O catálogo compartilhado só conhece rotas explícitas do descritor.
    expect(registry.findChannelRoute("GET", `/connections/${f.line}/setup`)).toBeNull();
    expect(findChannelServerRoute("GET", `/c2/connections/${f.line}/setup`, "telegram")?.route.authorization).toBe("admin");
    expect(findChannelServerRoute("GET", `/connections/${f.line}/setup`, "email")).toBeNull();
    expect(findChannelServerRoute("GET", "/connections/a%2Fb/setup", "telegram")).toBeNull();
    const token = await bearer(f.admin), path = `/api/v1/profiles/${f.profile}/c2/connections/${f.line}/setup`;
    const get = await c2Request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ id: f.line, channel: "telegram", status: "active", credential: "configurado", configured: true });
    const member = await bearer(f.member);
    expect((await c2Request(path, { headers: { Authorization: `Bearer ${member}` } })).status).toBe(403);
    const other = await setup("telegram"), otherToken = await bearer(other.admin);
    expect((await c2Request(`/api/v1/profiles/${other.profile}/c2/connections/${f.line}/setup`,
      { headers: { Authorization: `Bearer ${otherToken}` } })).status).toBe(404);
    const key = uid(), request = { method: "POST", headers: { Authorization: `Bearer ${token}`,
      "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ config: {} }) };
    const saved = await c2Request(path, request);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const replay = await c2Request(path, request);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(await saved.json());
    expect(configured).toEqual([(await sha(`${f.admin.id}:${f.profile}:c2.route\n${key}`)).slice(0, 32)]);
    const conversationId = uid();
    await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,channel,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,'telegram',?,?,?)`, conversationId, f.profile, f.line, `channel:${f.line}`, "telegram:123", conversationId, now(), now(), now());
    expect(await removeConnection(env as Env, f.admin, f.profile, f.line)).toMatchObject({ deleted: false, pending: true });
    await removePendingConnections(env as Env, f.profile);
    expect(calls).toEqual(["user", "connector"]);
    expect(await one(env, "SELECT status,json_extract(config,'$.remove_pending') pending FROM connections WHERE id=?", f.line))
      .toEqual({ status: "paused", pending: 1 });
    expect(await one(env, "SELECT 1 present FROM secrets WHERE id=?", `connection:${f.line}`)).toEqual({ present: 1 });
    confirmed = true;
    await removePendingConnections(env as Env, f.profile);
    expect(calls).toEqual(["user", "connector", "connector"]);
    expect(await one(env, "SELECT id FROM connections WHERE id=?", f.line)).toBeNull();
    expect(await one(env, "SELECT id FROM secrets WHERE id=?", `connection:${f.line}`)).toBeNull();
    expect(await one(env, "SELECT connection_id,channel,state FROM conversations WHERE id=?", conversationId))
      .toEqual({ connection_id: null, channel: "telegram", state: "closed" });
  });
});
