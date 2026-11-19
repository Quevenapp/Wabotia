/** Formato do plano; a conferir com a conta real.
 * HMAC, Worker, Coordinator, D1 e identidade são reais. A entrada não deve
 * chamar fornecedor, IA, mídia remota ou push: rede inesperada falha o teste. */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { json, now, uid, type Conversation, type Env } from "../src/types";
import type { ChannelOutboxRow, ExtensionConnection } from "../src/channel-c2-contracts";
import { createChannelExtensionRegistry } from "../src/channel-extension-registry";
import { channelAutomationBlock, loadChannelOperationContext } from "../src/channel-extension-kernel";
import { dispatchChannelDelivery, processInbox } from "../src/engine";
import { completeChannelDelivery } from "../src/delivery";
import { prepareChannelInbound, resolveChannelCustomer } from "../src/customer/channel-identity";
import { commentConversationKey, commentsExtensions, facebookCommentsExtension, instagramCommentsExtension } from "../src/c2/comments";
import { assertNoChannelEffects, c2Command, c2Fixture, c2ZernioWebhook, denyNetwork, installTestExtension,
  measure, quietCoordinator, type C2Fixture } from "./c2-fixtures";

const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  network.restore();
  network.assertNone();
});

async function setup(channel: "instagram" | "facebook" = "instagram") {
  const f = await c2Fixture(channel);
  profiles.add(f.profile);
  await installTestExtension(f, channel === "instagram" ? instagramCommentsExtension : facebookCommentsExtension);
  return f;
}

function received(f: C2Fixture, remoteId = uid(), postId = "publicacao-1", authorId = "autor-1") {
  return {
    id: uid(), event: "comment.received",
    account: { accountId: f.account, platform: f.channel, profileId: f.remoteProfile },
    comment: { id: remoteId, text: "Olá, gostaria de informações.",
      author: { id: authorId, name: "Pessoa sintética", username: "pessoa_sintetica" },
      parentCommentId: undefined as string | undefined, createdAt: now() - 1_000 as number | string },
    post: { id: postId, text: "Publicação com atenção e informação.",
      permalink: "https://example.test/publicacao", imageUrl: "https://example.test/imagem.jpg" },
  };
}

async function accept(f: C2Fixture, event = received(f)) {
  const response = await c2ZernioWebhook(f, event);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
}

async function comments(profile: string) {
  return all<{ id: string; remote_id: string; post_id: string; author_id: string; parent_id: string | null;
    conversation_id: string; message_id: string; occurred_at: number | null; private_state: string; version: number }>(
    env, "SELECT * FROM channel_comments WHERE profile_id=? ORDER BY created,id", profile);
}

describe("c2-comentarios: descritores e canal não usado", () => {
  it("instala cada contexto isoladamente, sem executar hooks nem habilitar bot", () => {
    expect(commentsExtensions).toEqual([instagramCommentsExtension, facebookCommentsExtension]);
    for (const descriptor of commentsExtensions) {
      const registry = createChannelExtensionRegistry();
      registry.registerChannelExtension(descriptor);
      registry.registerChannelExtension(descriptor);
      expect(registry.registeredChannelExtensions()).toEqual([descriptor]);
      expect(registry.channelExtension(descriptor.key)).toBe(descriptor);
      expect(descriptor.spec.contexts.comment).toMatchObject({ enabled: true, bot: false, publicReply: true });
      expect(descriptor.spec.window).toEqual({ kind: "none" });
      expect(descriptor.enabled?.({ id: "conexao", profile_id: "area", kind: "zernio", channel: descriptor.spec.id, config: "{}" })).toBe(false);
    }
  });

  it("canal não usado mantém WhatsApp e DMs sem consultas ou entregas da extensão", async () => {
    const result = await measure(env as Env, async counted => {
      for (const channel of ["whatsapp", "instagram", "facebook"] as const) {
        expect(await channelAutomationBlock(counted, { channel, chat_type: "direct" } as Conversation, "legado")).toBeNull();
      }
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(result.count).toMatchObject({ calls: 0, statements: 0 });
  });

  it("ignora comentário legítimo quando a ativação falta ou está desligada", async () => {
    const f = await setup();
    for (const enabled of [null, false]) {
      const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=?", f.line))!;
      const config = json(connection.config);
      if (enabled === null) delete config.comments_enabled;
      else config.comments_enabled = enabled;
      await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify(config), f.line);
      expect(await (await accept(f)).json()).toMatchObject({ received: true, ignored: true });
      await assertNoChannelEffects(f.profile);
      expect(await comments(f.profile)).toEqual([]);
    }
  }, 30_000);

  it("codifica publicação e autor sem colisão por separador", () => {
    expect(commentConversationKey("a:b", "c")).not.toBe(commentConversationKey("a", "b:c"));
    expect(commentConversationKey("a", "bc")).not.toBe(commentConversationKey("ab", "c"));
    expect(commentConversationKey("publicação/\"", "autor:ç")).toBe(commentConversationKey("publicação/\"", "autor:ç"));
  });
});

describe("c2-comentarios: autenticidade e entrada", () => {
  it("recusa HMAC errado antes de contato, mensagem, mídia, fila ou auditoria de sucesso", async () => {
    const f = await setup();
    const response = await c2ZernioWebhook(f, received(f), "00");
    expect(response.status).toBe(403);
    await assertNoChannelEffects(f.profile);
    expect(await comments(f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM audit WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("não aceita comando administrativo como prova de comentário", async () => {
    const f = await setup();
    const response = await c2Command(f, "inbound", { channel: "instagram", verified: true,
      channel_context: { context: "comment" }, origin: "zernio_hmac", external_id: "autor-1", text: "Forjado" });
    expect(response.status).toBe(403);
    await assertNoChannelEffects(f.profile);
    expect(await comments(f.profile)).toEqual([]);
  }, 30_000);

  it("confere conta, plataforma e perfil do fornecedor antes de qualquer efeito", async () => {
    const f = await setup();
    for (const wrong of [{ accountId: "conta-errada" }, { profileId: "perfil-errado" }, { platform: "facebook" }]) {
      const event = received(f);
      Object.assign(event.account, wrong);
      const response = await accept(f, event);
      expect(await response.json()).toMatchObject({ ignored: true });
    }
    await assertNoChannelEffects(f.profile);
    expect(await comments(f.profile)).toEqual([]);
  }, 30_000);

  it("ignora formatos desconhecidos sem presumir edição, exclusão ou comentário TikTok", async () => {
    const f = await setup();
    for (const kind of ["comment.updated", "comment.deleted", "comment.restored"]) {
      const event = { ...received(f), event: kind };
      const response = await c2ZernioWebhook(f, event);
      expect(response.ok, await response.clone().text()).toBe(true);
    }
    const tiktok = { ...received(f), account: { accountId: f.account, profileId: f.remoteProfile, platform: "tiktok" } };
    expect((await c2ZernioWebhook(f, tiktok)).ok).toBe(true);
    await assertNoChannelEffects(f.profile);
    expect(await comments(f.profile)).toEqual([]);
  }, 30_000);

  it.each(["instagram", "facebook"] as const)("%s: webhook concorrente e ID de envelope novo não duplicam o comentário", async channel => {
    const f = await setup(channel), event = received(f);
    const responses = await Promise.all([c2ZernioWebhook(f, event), c2ZernioWebhook(f, event)]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    const replay = { ...event, id: uid(), comment: { ...event.comment, createdAt: now(), text: "Retry não edita a entrada." } };
    expect((await c2ZernioWebhook(f, replay)).ok).toBe(true);
    const rows = await comments(f.profile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remote_id: event.comment.id, post_id: event.post.id, author_id: event.comment.author.id,
      occurred_at: event.comment.createdAt, private_state: "available", version: 1 });
    expect(await all(env, "SELECT text FROM messages WHERE profile_id=? AND direction='customer'", f.profile)).toEqual([{ text: event.comment.text }]);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(1);
    await processInbox(env as Env, f.profile);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
  }, 40_000);

  it("agrupa publicação/autor e mantém resposta de outro autor na própria conversa", async () => {
    const f = await setup();
    const first = received(f, "comentario-a1", "publicacao-1", "alice");
    const reply = received(f, "comentario-b1", "publicacao-1", "bob");
    reply.comment.parentCommentId = first.comment.id;
    const secondPost = received(f, "comentario-a2", "publicacao-2", "alice");
    const samePost = received(f, "comentario-a3", "publicacao-1", "alice");
    samePost.comment.parentCommentId = reply.comment.id;
    for (const event of [first, reply, secondPost, samePost]) await accept(f, event);
    const rows = await comments(f.profile);
    const byId = new Map(rows.map(row => [row.remote_id, row]));
    expect(byId.get(first.comment.id)!.conversation_id).toBe(byId.get(samePost.comment.id)!.conversation_id);
    expect(byId.get(first.comment.id)!.conversation_id).not.toBe(byId.get(reply.comment.id)!.conversation_id);
    expect(byId.get(first.comment.id)!.conversation_id).not.toBe(byId.get(secondPost.comment.id)!.conversation_id);
    expect(byId.get(reply.comment.id)!.parent_id).toBe(first.comment.id);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).toHaveLength(3);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(await all(env, "SELECT id FROM messages WHERE profile_id=? AND direction='customer'", f.profile)).toHaveLength(4);
    const aliceConversations = await all<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND channel_subject_id='alice'", f.profile);
    expect(new Set(aliceConversations.map(row => row.channel_identity_id)).size).toBe(1);
    for (const c of aliceConversations) {
      expect(c.external_namespace).toBe(`channel:${f.line}`);
      expect(c.verified_phone).toBeNull();
      expect(await resolveChannelCustomer(env as Env, c)).toMatchObject({ state: "ready", verifiedPhone: null,
        verifiedChannel: null, identityTrust: "none" });
    }
    expect(await all(env, "SELECT DISTINCT subject_namespace FROM customer_channel_ids WHERE profile_id=?", f.profile))
      .toEqual([{ subject_namespace: "comment-author" }]);
  }, 40_000);

  it("mesmo autor e ID remoto em contas diferentes não compartilham conversa nem identidade", async () => {
    const f = await setup();
    const original = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=?", f.line))!;
    const second = { ...f, line: f.second, account: uid().replaceAll("-", "").slice(0, 24) };
    await exec(env, "UPDATE connections SET channel='instagram',config=? WHERE id=? AND profile_id=?",
      JSON.stringify({ ...json(original.config), account_id: second.account }), second.line, f.profile);
    await exec(env, `INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,created,updated)
      VALUES(?,?,?,'instagram',?,?,?,?)`, second.line, f.profile, f.integration, second.account, f.remoteProfile, now(), now());
    await accept(f, received(f, "mesmo-comentario", "mesma-publicacao", "mesmo-autor"));
    await accept(second, received(second, "mesmo-comentario", "mesma-publicacao", "mesmo-autor"));
    const rows = await comments(f.profile);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.conversation_id)).size).toBe(2);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toHaveLength(2);
  }, 40_000);

  it("ID de autor igual ao de DM existente não une contatos nem renova a janela privada", async () => {
    const f = await setup(), dmId = uid(), subjectId = "id-igual", lastCustomer = now() - 48 * 60 * 60 * 1000;
    await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
      channel,channel_account_id,channel_subject_id,chat_type,customer_link_state,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,'instagram',?,?,'direct','pending',?,?,?)`,
      dmId, f.profile, f.line, `channel:${f.line}`, `dm:${subjectId}`, dmId, f.account, subjectId, lastCustomer, now(), now());
    const dm = (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", dmId))!;
    const identity = await prepareChannelInbound(env as Env, dm, { channel: "instagram", provider: "zernio",
      accountId: f.account, subjectId, subjectNamespace: "dm", displayName: "Pessoa da DM" });
    await batch(env, identity.statements);
    await accept(f, received(f, "comentario-id-igual", "publicacao", subjectId));
    const namespaces = await all<{ subject_namespace: string; contact_id: string }>(env,
      "SELECT subject_namespace,contact_id FROM customer_channel_ids WHERE profile_id=? ORDER BY subject_namespace", f.profile);
    expect(namespaces.map(row => row.subject_namespace)).toEqual(["comment-author", "dm"]);
    expect(new Set(namespaces.map(row => row.contact_id)).size).toBe(2);
    expect(await one(env, "SELECT last_customer FROM conversations WHERE id=?", dmId)).toEqual({ last_customer: lastCustomer });
    expect(await all(env, "SELECT id FROM customer_merges WHERE profile_id=?", f.profile)).toEqual([]);
    const [comment] = await comments(f.profile);
    expect(comment.conversation_id).not.toBe(dmId);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=? AND profile_id=?",
      f.admin.id, comment.conversation_id, f.profile);
    const context = await loadChannelOperationContext(env as Env, f.admin, f.profile,
      { kind: "conversation", id: comment.conversation_id }, uid());
    expect((await instagramCommentsExtension.view!(context)).metadata.comment?.privateConversationId).toBeNull();
  }, 40_000);

  it("timestamp inválido não ganha prazo pelo recebimento ou pelo retry", async () => {
    const f = await setup(), event = received(f);
    event.comment.createdAt = "não é uma data";
    await accept(f, event);
    await accept(f, { ...event, id: uid(), comment: { ...event.comment, createdAt: now() } });
    const [row] = await comments(f.profile);
    expect(row.occurred_at).toBeNull();
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=? AND profile_id=?",
      f.admin.id, row.conversation_id, f.profile);
    const context = await loadChannelOperationContext(env as Env, f.admin, f.profile, { kind: "conversation", id: row.conversation_id }, uid());
    const view = await instagramCommentsExtension.view!(context);
    expect(view.metadata.comment).toMatchObject({ id: row.id, privateExpiresAt: null });
    expect(view.metadata.identityTrust).toBe("none");
    expect(view.capabilities.window).toEqual({ kind: "none" });
  }, 30_000);

  it("identidade bloqueada ou apagada não recria ficha em outra publicação", async () => {
    const f = await setup();
    await accept(f, received(f, "primeiro", "publicacao-1", "autor-fixo"));
    await exec(env, "UPDATE customer_channel_ids SET state='blocked' WHERE profile_id=?", f.profile);
    await accept(f, received(f, "bloqueado", "publicacao-2", "autor-fixo"));
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    await exec(env, "UPDATE customer_channel_ids SET state='erased',contact_id=NULL WHERE profile_id=?", f.profile);
    await accept(f, received(f, "apagado", "publicacao-3", "autor-fixo"));
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toHaveLength(1);
    const linked = await all<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND external_id=?", f.profile,
      commentConversationKey("publicacao-3", "autor-fixo"));
    expect(linked).toHaveLength(1);
    expect(linked[0].customer_link_state).toBe("excluded");
    expect(await resolveChannelCustomer(env as Env, linked[0])).toMatchObject({ contactId: null,
      verifiedPhone: null, verifiedChannel: null });
  }, 40_000);
});
