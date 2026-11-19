/** Fixtures sintéticas: formato do plano; a conferir com a conta real.
 * Kernel, identidade, outbox e conclusão reais; somente fornecedores simulados. */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, now, uid, type Conversation, type Env } from "../src/types";
import type { ChannelAction, ChannelOperationContext, ChannelOutboxRow } from "../src/channel-c2-contracts";
import { instagramCommentsExtension } from "../src/c2/comments";
import { authorizeChannelAction, loadChannelOperationContext, prepareChannelAction } from "../src/channel-extension-kernel";
import { completeChannelDelivery, loadChannelDeliveryContext } from "../src/delivery";
import { removeConnection } from "../src/connection-removal";
import { dispatchChannelDelivery, enqueueChannelPlan, recoverChannelDeliveries } from "../src/engine";
import { setSecret } from "../src/security";
import { c2Command, c2Fixture, c2ZernioWebhook, installTestExtension, measure, quietCoordinator, type C2Fixture } from "./c2-fixtures";

const HOUR = 3_600_000;
const profiles = new Set<string>();
const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
const unexpected: string[] = [];
let responseFor: ((call: typeof calls[number]) => Response | Promise<Response>) | null;
beforeEach(() => {
  calls.length = 0; unexpected.length = 0; responseFor = null;
  // Somente relógio lógico: nenhum caso depende de concluir antes de um prazo real.
  vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!responseFor) {
      unexpected.push("chamada externa inesperada");
      throw new Error("Rede não autorizada pela fixture.");
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>; }
    catch { unexpected.push("corpo remoto inesperado"); throw new Error("Formato não autorizado pela fixture."); }
    const call = { url, method: init?.method ?? "GET", body };
    calls.push(call);
    return responseFor(call);
  });
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
}, 30_000);

interface CommentRow {
  id: string; conversation_id: string; remote_id: string; post_id: string; message_id: string;
  private_state: string; private_attempted_at: number | null; private_command_id: string | null;
  private_conversation_id: string | null; private_thread_id: string | null; hidden: number; version: number;
}
async function setup() {
  const f = await c2Fixture("instagram"); profiles.add(f.profile);
  await installTestExtension(f, instagramCommentsExtension);
  return f;
}
async function receive(f: C2Fixture, options: {
  id?: string; post?: string; author?: string; at?: unknown; text?: string;
} = {}): Promise<CommentRow> {
  const remote = options.id ?? uid();
  const response = await c2ZernioWebhook(f, {
    event: "comment.received", account: { accountId: f.account, platform: "instagram", profileId: f.remoteProfile },
    comment: { id: remote, text: options.text ?? "Qual o horário de atendimento?", createdAt: options.at === undefined ? now() - HOUR : options.at,
      author: { id: options.author ?? "author-sintetico", name: "Maria Sintética", username: "maria_sintetica" } },
    post: { id: options.post ?? "post-sintetico", text: "Publicação de atendimento", permalink: "https://www.instagram.com/p/sintetico/" },
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const row = await one<CommentRow>(env, "SELECT * FROM channel_comments WHERE connection_id=? AND remote_id=?", f.line, remote);
  expect(row).not.toBeNull();
  await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=? AND profile_id=?", f.admin.id, row!.conversation_id, f.profile);
  return row!;
}
async function receiveDm(f: C2Fixture, thread: string, subject: string) {
  const response = await c2ZernioWebhook(f, { id: uid(), event: "message.received",
    account: { accountId: f.account, platform: "instagram", profileId: f.remoteProfile },
    conversation: { id: thread, participantId: subject, type: "direct", accountId: f.account, platform: "instagram" },
    message: { platformMessageId: uid(), conversationId: thread, direction: "incoming", sentAt: now(), text: "Olá, recebi sua mensagem.",
      sender: { id: subject, name: "Pessoa da DM" } },
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}
const readComment = (id: string) => one<CommentRow>(env, "SELECT * FROM channel_comments WHERE id=?", id);
const readDelivery = async (id: string) => (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
const context = (f: C2Fixture, row: CommentRow, commandId = uid()) => loadChannelOperationContext(env as Env, f.admin, f.profile,
  { kind: "conversation", id: row.conversation_id }, commandId);
async function enqueue(f: C2Fixture, row: CommentRow, action: ChannelAction, commandId = uid()) {
  const ctx = await context(f, row, commandId);
  const plan = await prepareChannelAction(ctx, action);
  const id = await enqueueChannelPlan(ctx, plan, action);
  await quietCoordinator(f.profile);
  return { ctx, plan, id };
}
function provider(path: string, payload: unknown, status = 200) {
  responseFor = call => {
    if (call.url !== `https://zernio.com/api/v1/${path}`) {
      unexpected.push("endpoint inesperado");
      throw new Error("Endpoint não autorizado pela fixture.");
    }
    return Response.json(payload, { status });
  };
}
const privateAction = (row: CommentRow): ChannelAction => ({ type: "comment.private", commentId: row.id, text: "Vamos continuar em privado." });
const privatePath = (row: CommentRow) => `inbox/comments/${encodeURIComponent(row.post_id)}/${encodeURIComponent(row.remote_id)}/private-reply`;

describe("comentários: autorização e contexto da publicação", () => {
  it("canal não usado mantém entregas antigas sem consulta ou escrita adicional", async () => {
    const measured = await measure(env as Env, async counted => {
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(measured.count).toMatchObject({ calls: 0, statements: 0 });
    expect(calls).toEqual([]);
  });

  it("resposta humana aponta o comentário escolhido, sem janela pública ou segunda entrega", async () => {
    const f = await setup(), row = await receive(f, { at: now() - 500 * HOUR });
    const action: ChannelAction = { type: "comment.reply", commentId: row.id, text: "Atendemos de segunda a sexta." };
    const queued = await enqueue(f, row, action);
    provider(`inbox/comments/${row.post_id}`, { success: true, comment: { id: "resposta-publica" } });
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", body: { accountId: f.account, platform: "instagram", commentId: row.remote_id } });
    expect(calls[0].body.text).toContain(action.text);
    expect(await readDelivery(queued.id)).toMatchObject({ status: "sent", completion_handled: 1 });
    const sent = await all<{ text: string }>(env, "SELECT text FROM messages WHERE conversation_id=? AND direction='outbound'", row.conversation_id);
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain(action.text);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("recusa comentário de outra publicação como alvo da conversa", async () => {
    const f = await setup(), own = await receive(f), foreign = await receive(f, { post: "outra-publicacao" });
    const ctx = await context(f, own);
    await expect(prepareChannelAction(ctx, { type: "comment.reply", commentId: foreign.id, text: "Resposta" }))
      .rejects.toMatchObject({ status: 404 });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("bot, aplicação e pessoa via bot não publicam nem sugerem pelo contexto humano", async () => {
    const f = await setup(), row = await receive(f), ctx = await context(f, row);
    const invalid: ChannelOperationContext[] = [
      { ...ctx, authorization: { ...ctx.authorization, origin: "bot" } },
      { ...ctx, authorization: { ...ctx.authorization, actor: { ...f.admin, kind: "app" } } },
      { ...ctx, authorization: { ...ctx.authorization, actor: { ...f.admin, via: { kind: "bot", bot_id: "b", run_id: "r", masked: true } } } },
    ];
    for (const forged of invalid) for (const type of ["comment.reply", "comment.private", "comment.suggest"] as const) {
      const action = { type, commentId: row.id, text: "Não deve publicar" };
      await expect(authorizeChannelAction(forged, action)).rejects.toMatchObject({ code: "human_only" });
      await expect(instagramCommentsExtension.prepareSend(forged, action)).rejects.toMatchObject({ code: "human_only" });
    }
    await expect(instagramCommentsExtension.prepareSend(ctx, { type: "message.send", text: "Envio genérico" })).rejects.toBeInstanceOf(ApiError);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("sugere somente texto mascarado e não reserva outbox nem busca histórico privado", async () => {
    const f = await setup(), row = await receive(f, { text: "Maria Sintética @maria_sintetica author-sintetico pessoa@example.test" });
    const ai = uid();
    await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'ai','direct','active',?,?)",
      ai, f.profile, "IA sintética", JSON.stringify({ provider: "deepseek", model: "deepseek-chat" }), now());
    await setSecret(env, `connection:${ai}`, { api_key: "chave-ia-sintetica" });
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'note','system',?,?)",
      uid(), f.profile, row.conversation_id, "CONTEÚDO PRIVADO NÃO ENVIAR AO MODELO", now());
    responseFor = call => {
      if (call.url !== "https://api.deepseek.com/chat/completions") {
        unexpected.push("endpoint de IA inesperado"); throw new Error("Rede inesperada.");
      }
      const body = JSON.stringify(call.body);
      for (const personal of ["Maria Sintética", "maria_sintetica", "author-sintetico", "pessoa@example.test", "CONTEÚDO PRIVADO"])
        expect(body).not.toContain(personal);
      expect(body).toContain("[NAME_"); expect(body).toContain("[SOCIAL_ID_");
      return Response.json({ choices: [{ message: { role: "assistant", content: "Olá, [NAME_1]. Podemos ajudar." }, finish_reason: "stop" }] });
    };
    const result = await c2Command(f, "message.action", { id: row.conversation_id, action: "channel",
      channel_action: { type: "comment.suggest", commentId: row.id, text: "Prepare uma resposta cordial." } });
    expect(result.ok, await result.clone().text()).toBe(true);
    expect(await result.json()).toMatchObject({ status: "suggestion", suggestion: expect.stringContaining("[NAME_1]") });
    expect(calls).toHaveLength(1);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect((await readComment(row.id))?.private_state).toBe("available");
  }, 30_000);
});

describe("comentários: ocultação humana confirmada", () => {
  it("ocultar e mostrar enfileirados antes da confirmação preservam as duas intenções humanas", async () => {
    const f = await setup(), row = await receive(f);
    await exec(env, "UPDATE connections SET config=json_set(config,'$.comments_visibility_contract','v1') WHERE id=?", f.line);
    const hide = await enqueue(f, row, { type: "comment.visibility", commentId: row.id, hidden: true });
    const show = await enqueue(f, row, { type: "comment.visibility", commentId: row.id, hidden: false });
    expect(hide.id).toBeTruthy(); expect(show.id).toBeTruthy(); expect(show.id).not.toBe(hide.id);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect((await readComment(row.id))?.hidden).toBe(0);
    provider(`inbox/comments/${row.post_id}/${row.remote_id}`, { success: true, comment: { id: row.remote_id, hidden: true } });
    await dispatchChannelDelivery(env as Env, await readDelivery(hide.id));
    expect((await readComment(row.id))?.hidden).toBe(1);
    provider(`inbox/comments/${row.post_id}/${row.remote_id}`, { success: true, comment: { id: row.remote_id, hidden: false } });
    await dispatchChannelDelivery(env as Env, await readDelivery(show.id));
    expect((await readComment(row.id))?.hidden).toBe(0);
    expect(calls.map(call => call.body.hidden)).toEqual([true, false]);
    expect(await readDelivery(hide.id)).toMatchObject({ status: "sent", completion_handled: 1 });
    expect(await readDelivery(show.id)).toMatchObject({ status: "sent", completion_handled: 1 });
    expect((await prepareChannelAction(await context(f, row), { type: "comment.visibility", commentId: row.id, hidden: false })).deliveries).toEqual([]);
  }, 30_000);

  it("bloqueia contrato não confirmado e altera ocultação somente após confirmação", async () => {
    const f = await setup(), row = await receive(f);
    const action: ChannelAction = { type: "comment.visibility", commentId: row.id, hidden: true };
    await expect(prepareChannelAction(await context(f, row), action)).rejects.toMatchObject({ code: "provider_contract_unverified" });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    await exec(env, "UPDATE connections SET config=json_set(config,'$.comments_visibility_contract','v1') WHERE id=?", f.line);
    const hide = await enqueue(f, row, action);
    expect((await readComment(row.id))?.hidden).toBe(0);
    provider(`inbox/comments/${row.post_id}/${row.remote_id}`, { success: true, comment: { id: row.remote_id, hidden: true } });
    await dispatchChannelDelivery(env as Env, await readDelivery(hide.id));
    expect((await readComment(row.id))?.hidden).toBe(1);
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { hidden: true } });
    const unchanged = await prepareChannelAction(await context(f, row), action);
    expect(unchanged.deliveries).toEqual([]);
    const show = await enqueue(f, row, { ...action, hidden: false });
    provider(`inbox/comments/${row.post_id}/${row.remote_id}`, { success: false, error: "recusado" }, 400);
    await dispatchChannelDelivery(env as Env, await readDelivery(show.id));
    expect((await readComment(row.id))?.hidden).toBe(1);
    const confirmed = await enqueue(f, row, { ...action, hidden: false });
    provider(`inbox/comments/${row.post_id}/${row.remote_id}`, { success: true, comment: { id: row.remote_id, hidden: false } });
    await dispatchChannelDelivery(env as Env, await readDelivery(confirmed.id));
    expect((await readComment(row.id))?.hidden).toBe(0);
    expect(calls).toHaveLength(3);
  }, 30_000);
});

describe("comentários: tentativa privada única", () => {
  it("168 horas exatas e datas inválidas não reservam; um milissegundo antes ainda permite", async () => {
    const f = await setup();
    for (const at of [now() - 168 * HOUR, null, "inválido", now() + HOUR]) {
      const row = await receive(f, { at });
      await expect(prepareChannelAction(await context(f, row), privateAction(row))).rejects.toMatchObject({ code: "private_reply_expired" });
      expect(await readComment(row.id)).toMatchObject({ private_state: "available", private_attempted_at: null });
    }
    const allowed = await receive(f, { at: now() - 168 * HOUR + 1 });
    expect((await prepareChannelAction(await context(f, allowed), privateAction(allowed))).deliveries).toHaveLength(1);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  }, 30_000);

  it("duas reservas concorrentes e replay produzem uma outbox e uma chamada remota", async () => {
    const f = await setup(), row = await receive(f), action = privateAction(row);
    const first = await context(f, row), second = await context(f, row);
    const plans = await Promise.all([prepareChannelAction(first, action), prepareChannelAction(second, action)]);
    const results = await Promise.allSettled([enqueueChannelPlan(first, plans[0], action), enqueueChannelPlan(second, plans[1], action)]);
    await quietCoordinator(f.profile);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? 0 : 1;
    const id = (results[winner] as PromiseFulfilledResult<string>).value;
    expect(await enqueueChannelPlan(winner === 0 ? first : second, plans[winner], action)).toBe(id);
    await quietCoordinator(f.profile);
    provider(privatePath(row), { success: true });
    await dispatchChannelDelivery(env as Env, await readDelivery(id));
    await dispatchChannelDelivery(env as Env, await readDelivery(id));
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(calls).toHaveLength(1);
    expect(await readComment(row.id)).toMatchObject({ private_state: "sent", private_attempted_at: now(), private_conversation_id: null });
    await expect(prepareChannelAction(await context(f, row), action)).rejects.toMatchObject({ code: "private_reply_used" });
    const projection = await instagramCommentsExtension.view!(await context(f, row));
    expect(projection.metadata.comment).toMatchObject({ privateState: "sent", privateLinkPending: true });
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=? AND chat_type='direct'", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=? AND subject_namespace='dm'", f.profile)).toEqual([]);
  }, 30_000);

  it.each([400, 500])("falha remota HTTP %s consome tentativa sem repetir nem expor resposta", async status => {
    const f = await setup(), row = await receive(f), action = privateAction(row);
    const queued = await enqueue(f, row, action);
    provider(privatePath(row), { success: false, error: "Bearer chave-sintetica-c2 https://fornecedor.test/segredo", payload: "corpo-remoto-proibido" }, status);
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    await recoverChannelDeliveries(env as Env, f.profile);
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    const state = status === 400 ? "failed" : "unknown";
    expect(await readComment(row.id)).toMatchObject({ private_state: state, private_attempted_at: now() });
    await expect(prepareChannelAction(await context(f, row), action)).rejects.toMatchObject({ code: "private_reply_used" });
    expect(calls).toHaveLength(1);
    const persisted = JSON.stringify({ delivery: await readDelivery(queued.id), comment: await readComment(row.id),
      sidecar: await one(env, "SELECT * FROM channel_delivery_state WHERE outbox_id=?", queued.id) });
    for (const value of ["chave-sintetica-c2", "fornecedor.test", "corpo-remoto-proibido"]) expect(persisted).not.toContain(value);
  }, 30_000);

  it("falha de validação antes da rede libera a reserva sem consumir a tentativa", async () => {
    const f = await setup(), row = await receive(f), action = privateAction(row);
    await expect(prepareChannelAction(await context(f, row), { type: "comment.private", commentId: row.id, text: "" })).rejects.toBeInstanceOf(ApiError);
    expect(await readComment(row.id)).toMatchObject({ private_state: "available", private_attempted_at: null });
    const queued = await enqueue(f, row, action);
    await setSecret(env, `zernio-account:${f.integration}`, { webhook_secret: f.webhookSecret });
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(await readDelivery(queued.id)).toMatchObject({ status: "failed", completion_handled: 1 });
    expect(await readComment(row.id)).toMatchObject({ private_state: "available", private_attempted_at: null, private_command_id: null });
    expect(calls).toEqual([]);
    await setSecret(env, `zernio-account:${f.integration}`, { api_key: "chave-sintetica-c2", webhook_secret: f.webhookSecret });
    expect((await prepareChannelAction(await context(f, row), action)).deliveries).toHaveLength(1);
  }, 30_000);

  it("reconfere o prazo na entrega sem consumir uma reserva que venceu na fila", async () => {
    const f = await setup(), row = await receive(f, { at: now() - 168 * HOUR + 1 });
    const queued = await enqueue(f, row, privateAction(row));
    vi.mocked(Date.now).mockReturnValue(now() + 1);
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(await readDelivery(queued.id)).toMatchObject({ status: "failed", error: "private_reply_expired" });
    expect(await readComment(row.id)).toMatchObject({ private_state: "available", private_attempted_at: null });
    expect(calls).toEqual([]);
  }, 30_000);

  it("expiração durante a guarda anterior ao fetch libera também o marcador da outbox", async () => {
    const f = await setup(), row = await receive(f, { at: now() - 168 * HOUR + 1 });
    const queued = await enqueue(f, row, privateAction(row));
    await exec(env, "UPDATE outbox SET status='sending' WHERE id=?", queued.id);
    const delivery = await readDelivery(queued.id);
    const loaded = await loadChannelDeliveryContext(env as Env, delivery);
    const authorize = loaded.context.beforeFetch;
    // Injeta somente a passagem do tempo na fronteira. A autorização continua
    // sendo a real; o marcador reproduz a reserva do engine antes do fetch.
    loaded.context.beforeFetch = async () => {
      await authorize();
      await exec(env, "UPDATE channel_delivery_state SET attempted_at=?,updated=? WHERE outbox_id=?", now(), now(), queued.id);
      vi.mocked(Date.now).mockReturnValue(now() + 1);
    };
    const result = await instagramCommentsExtension.deliver(loaded.context);
    expect(result).toEqual({ kind: "failed", code: "private_reply_expired" });
    expect(await one(env, "SELECT attempted_at FROM channel_delivery_state WHERE outbox_id=?", queued.id)).toEqual({ attempted_at: null });
    expect((await readComment(row.id))?.private_attempted_at).toBeNull();
    await exec(env, "UPDATE outbox SET status='failed',error='private_reply_expired' WHERE id=?", queued.id);
    await completeChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(await readComment(row.id)).toMatchObject({ private_state: "available", private_attempted_at: null, private_command_id: null });
    expect(calls).toEqual([]);
  }, 30_000);

  it("prova explícita da DM cria vínculo e notas sem janela de bot ou junção cadastral", async () => {
    const f = await setup(), row = await receive(f), queued = await enqueue(f, row, privateAction(row));
    provider(privatePath(row), { success: true, privateReply: { commentId: row.remote_id, postId: row.post_id,
      accountId: f.account, platform: "instagram", profileId: f.remoteProfile,
      conversationId: "thread-confirmada", participantId: "author-sintetico", messageId: "privada-confirmada" } });
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    await recoverChannelDeliveries(env as Env, f.profile);
    const comment = (await readComment(row.id))!;
    expect(comment.private_conversation_id).toBeTruthy();
    expect(comment.private_thread_id).toBe("thread-confirmada");
    const dm = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", comment.private_conversation_id);
    expect(dm).toMatchObject({ chat_type: "direct", external_id: "dm:author-sintetico", last_customer: 0, phone: null, verified_phone: null });
    const identities = await all<{ subject_namespace: string; contact_id: string }>(env,
      "SELECT subject_namespace,contact_id FROM customer_channel_ids WHERE profile_id=? ORDER BY subject_namespace", f.profile);
    expect(identities.map(identity => identity.subject_namespace)).toEqual(["comment-author", "dm"]);
    expect(new Set(identities.map(identity => identity.contact_id)).size).toBe(2);
    for (const id of [row.conversation_id, comment.private_conversation_id])
      expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='note' AND json_extract(content,'$.type')='channel_link'", id)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM bot_runs WHERE profile_id=?", f.profile)).toEqual([]);
    expect(calls).toHaveLength(1);
  }, 30_000);

  it("identificador parecido e resposta de outra conta deixam o vínculo privado pendente", async () => {
    const f = await setup(), row = await receive(f), queued = await enqueue(f, row, privateAction(row));
    provider(privatePath(row), { success: true, privateReply: { commentId: row.remote_id, postId: row.post_id,
      accountId: "outra-conta", platform: "instagram", profileId: f.remoteProfile,
      conversationId: "thread-sem-prova", participantId: "author-sintetico", messageId: "privada-confirmada" } });
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(await readComment(row.id)).toMatchObject({ private_state: "sent", private_conversation_id: null, private_thread_id: null });
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=? AND subject_namespace='dm'", f.profile)).toEqual([]);
    expect((await instagramCommentsExtension.view!(await context(f, row))).metadata.comment).toMatchObject({ privateLinkPending: true });
  }, 30_000);

  it("thread comprovada sem sujeito aguarda a DM real e reconcilia uma vez no gancho próprio", async () => {
    const f = await setup(), row = await receive(f), queued = await enqueue(f, row, privateAction(row));
    provider(privatePath(row), { success: true, privateReply: { commentId: row.remote_id, postId: row.post_id,
      accountId: f.account, platform: "instagram", profileId: f.remoteProfile, conversationId: "thread-pendente" } });
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(await readComment(row.id)).toMatchObject({ private_state: "sent", private_thread_id: "thread-pendente", private_conversation_id: null });
    const maintenance = instagramCommentsExtension.maintenance![0];
    await maintenance.run({ env: env as Env, profileId: f.profile, now: now() });
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=? AND chat_type='direct'", f.profile)).toEqual([]);
    responseFor = null;
    await receiveDm(f, "thread-pendente", "sujeito-dm-confirmado");
    await maintenance.run({ env: env as Env, profileId: f.profile, now: now() });
    await maintenance.run({ env: env as Env, profileId: f.profile, now: now() });
    const updated = (await readComment(row.id))!;
    expect(updated.private_conversation_id).toBeTruthy();
    const dm = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", updated.private_conversation_id);
    expect(dm).toMatchObject({ channel_subject_id: "sujeito-dm-confirmado", chat_type: "direct", last_customer: now() });
    for (const id of [row.conversation_id, updated.private_conversation_id])
      expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND json_extract(content,'$.type')='channel_link'", id)).toHaveLength(1);
    expect((await instagramCommentsExtension.view!(await context(f, row))).metadata.comment).toMatchObject({ privateLinkPending: false });
    expect(calls).toHaveLength(1);
  }, 30_000);

  it("prova completa que conflita com a thread de outro sujeito mantém vínculo pendente", async () => {
    const f = await setup();
    await receiveDm(f, "thread-ja-vinculada", "outro-sujeito");
    const row = await receive(f), queued = await enqueue(f, row, privateAction(row));
    provider(privatePath(row), { success: true, privateReply: { commentId: row.remote_id, postId: row.post_id,
      accountId: f.account, platform: "instagram", profileId: f.remoteProfile, conversationId: "thread-ja-vinculada",
      participantId: "sujeito-incompativel", messageId: "privada-confirmada" } });
    await dispatchChannelDelivery(env as Env, await readDelivery(queued.id));
    expect(await readComment(row.id)).toMatchObject({ private_state: "sent", private_thread_id: null, private_conversation_id: null });
    const maintenance = instagramCommentsExtension.maintenance![0];
    await maintenance.run({ env: env as Env, profileId: f.profile, now: now() });
    await maintenance.run({ env: env as Env, profileId: f.profile, now: now() });
    expect(await readComment(row.id)).toMatchObject({ private_thread_id: null, private_conversation_id: null });
    expect(await all(env, "SELECT channel_subject_id FROM conversations WHERE profile_id=? AND chat_type='direct'", f.profile))
      .toEqual([{ channel_subject_id: "outro-sujeito" }]);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND json_extract(content,'$.type')='channel_link'", row.conversation_id)).toEqual([]);
    expect(calls).toHaveLength(1);
  }, 30_000);
});

describe("comentários: recuperação e reautorização", () => {
  it("recupera confirmação pública interrompida uma vez, sem repetir a rede", async () => {
    const f = await setup(), row = await receive(f);
    const queued = await enqueue(f, row, { type: "comment.reply", commentId: row.id, text: "Resposta recuperada." });
    await exec(env, "UPDATE outbox SET status='sent',external_id='resposta-confirmada' WHERE id=?", queued.id);
    await recoverChannelDeliveries(env as Env, f.profile);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", row.conversation_id)).toHaveLength(1);
    expect(await readDelivery(queued.id)).toMatchObject({ status: "sent", completion_handled: 1 });
    expect(calls).toEqual([]);
  }, 30_000);

  it("conclui privada confirmada após remoção da conexão sem perder histórico ou criar DM", async () => {
    const f = await setup(), row = await receive(f), queued = await enqueue(f, row, privateAction(row));
    // A resposta remota confirmou, mas o processo caiu antes da conclusão.
    await exec(env, "UPDATE outbox SET status='sent',external_id='privada-confirmada' WHERE id=?", queued.id);
    await exec(env, "UPDATE channel_delivery_state SET attempted_at=?,result_context=? WHERE outbox_id=?", now(),
      JSON.stringify({ dm: { threadId: "thread-confirmada", subjectId: "sujeito-dm", accountId: f.account, channel: "instagram" },
        privateThreadId: "thread-confirmada", privateLinkPending: false }), queued.id);
    const removed = await removeConnection(env as Env, f.admin, f.profile, f.line);
    expect(removed).toMatchObject({ deleted: true });
    expect(await one(env, "SELECT id FROM connections WHERE id=?", f.line)).toBeNull();
    expect(await one(env, "SELECT connection_id,external_namespace FROM conversations WHERE id=?", row.conversation_id))
      .toEqual({ connection_id: null, external_namespace: `channel:${f.line}` });
    await recoverChannelDeliveries(env as Env, f.profile);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await readDelivery(queued.id)).toMatchObject({ status: "sent", completion_handled: 1 });
    expect(await readComment(row.id)).toMatchObject({ private_state: "sent", private_attempted_at: now(), private_conversation_id: null });
    expect(await all(env, "SELECT id FROM messages WHERE id=?", `delivery:${queued.id}`)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=? AND chat_type='direct'", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=? AND subject_namespace='dm'", f.profile)).toEqual([]);
    expect(calls).toEqual([]);
  }, 30_000);

  it("revogação antes da publicação impede a rede e replay reautoriza", async () => {
    const f = await setup(), row = await receive(f), key = uid();
    const data = { id: row.conversation_id, action: "channel", channel_action: { type: "comment.reply", commentId: row.id, text: "Não publicar após revogação." } };
    const first = await c2Command(f, "message.action", data, key);
    expect(first.ok, await first.clone().text()).toBe(true);
    const outbox = await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE profile_id=?", f.profile);
    expect(outbox).not.toBeNull();
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.admin.id);
    const replay = await c2Command(f, "message.action", data, key);
    expect(replay.ok).toBe(false);
    await dispatchChannelDelivery(env as Env, outbox!);
    expect(await readDelivery(outbox!.id)).toMatchObject({ status: "failed", completion_handled: 1 });
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", row.conversation_id)).toEqual([]);
    expect(calls).toEqual([]);
  }, 30_000);
});
