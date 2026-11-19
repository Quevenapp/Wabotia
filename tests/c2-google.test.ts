/** Formato do plano; a conferir com a conta real. Somente fronteiras remotas
 * são simuladas: Worker, Coordinator, D1, outbox, conclusão e push são reais. */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Actor, type Env } from "../src/types";
import type { ChannelOutboxRow, ChannelReview, ExtensionConnection } from "../src/channel-c2-contracts";
import { googleReviewsDriver, googleReviewsExtension } from "../src/c2/google-reviews";
import { loadChannelOperationContext, prepareChannelAction } from "../src/channel-extension-kernel";
import { dispatchChannelDelivery, enqueueChannelPlan, listReadyChannelDeliveries, recoverChannelDeliveries } from "../src/engine";
import { completeChannelDelivery } from "../src/delivery";
import { setSecret } from "../src/security";
import { processPush } from "../src/push";
import { assertNoChannelEffects, bearer, c2Command, c2Fixture, c2Request, c2ZernioWebhook,
  denyNetwork, installTestExtension, measure, quietCoordinator, reviewFixtureEvent, type C2Fixture } from "./c2-fixtures";

const profiles = new Set<string>();
// O alarme real do runtime não pode cair no passado enquanto o Date está parado.
const realNow = Date.now.bind(Date);
let network: ReturnType<typeof denyNetwork>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(realNow() + 3_600_000);
  network = denyNetwork();
  await exec(env, "DELETE FROM secrets WHERE id='push:config'");
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  network.restore();
  vi.useRealTimers();
  network.assertNone();
});

async function setup() {
  const f = await c2Fixture();
  profiles.add(f.profile);
  const activation = now() - 10_000;
  await exec(env, "UPDATE connections SET created=? WHERE id=?", activation, f.line);
  await installTestExtension(f, googleReviewsExtension);
  const connection = (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=?", f.line))!;
  expect(await googleReviewsDriver.configure({ env: env as Env, actor: f.admin, profileId: f.profile,
    connection, input: { config: { reviews_enabled: true } }, commandId: uid(), now: activation }))
    .toMatchObject({ status: "active", configured: true });
  return f;
}
function event(f: C2Fixture, remoteId = uid(), kind = "review.new", at = now() - 1000) {
  const source = reviewFixtureEvent(f);
  return { ...source, event: kind, review: { ...source.review, id: remoteId,
    publishedAt: now() - 1000, updatedAt: at } };
}
async function receive(f: C2Fixture, input = event(f)) {
  const response = await c2ZernioWebhook(f, input);
  expect(response.ok, await response.clone().text()).toBe(true);
  const row = await one<ChannelReview>(env, "SELECT * FROM reviews WHERE connection_id=? AND remote_id=?", f.line, input.review.id);
  expect(row).not.toBeNull();
  return row!;
}
async function route(f: C2Fixture, method: string, path: string, input: unknown = {}, actor = f.admin, key = uid()) {
  return c2Command(f, "c2.route", { method, path, input }, key, actor);
}
async function grant(f: C2Fixture, actor = f.member) {
  const response = await route(f, "PUT", `/review-publishers/${actor.id}`);
  expect(response.status, await response.clone().text()).toBe(200);
}
async function enqueue(f: C2Fixture, review: ChannelReview, text: string, actor: Actor = f.admin) {
  const ctx = await loadChannelOperationContext(env as Env, actor, f.profile, { kind: "review", id: review.id }, uid());
  const action = { type: "google.reply" as const, version: review.version, text };
  const plan = await prepareChannelAction(ctx, action);
  const id = await enqueueChannelPlan(ctx, plan, action);
  return (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
}
async function noConversations(profile: string) {
  for (const table of ["contacts", "conversations", "messages", "inbox", "bot_runs"])
    expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, profile), table).toEqual([]);
}

describe("c2-google: autenticação e versões sem conversa", { timeout: 30_000 }, () => {
  it("canal não usado mantém os atalhos antigos sem SQL e ignora Google desligado", async () => {
    const measured = await measure(env as Env, async counted => {
      for (const channel of ["whatsapp", "instagram", "facebook"] as const)
        expect(googleReviewsExtension.enabled!({ id: "legado", profile_id: "área", kind: "zernio", channel, config: "{}" })).toBe(false);
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(measured.count).toMatchObject({ statements: 0, calls: 0 });
    const f = await setup();
    await exec(env, "UPDATE connections SET config=json_set(config,'$.c2_enabled',json('false'),'$.reviews_enabled',json('false')) WHERE id=?", f.line);
    const response = await c2ZernioWebhook(f, event(f));
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ ignored: true });
    await assertNoChannelEffects(f.profile);
  });

  it("HMAC incorreto é recusado antes de qualquer efeito", async () => {
    const f = await setup();
    const syncBefore = await all(env, "SELECT * FROM channel_sync_state WHERE profile_id=?", f.profile);
    expect(syncBefore).toHaveLength(1);
    expect((await c2ZernioWebhook(f, event(f), "00")).status).toBe(403);
    await assertNoChannelEffects(f.profile);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT * FROM channel_sync_state WHERE profile_id=?", f.profile)).toEqual(syncBefore);
  });

  it("webhooks concorrentes e replay criam uma avaliação e um aviso", async () => {
    const f = await setup(), input = event(f);
    const responses = await Promise.all([c2ZernioWebhook(f, input), c2ZernioWebhook(f, input)]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    expect((await c2ZernioWebhook(f, input)).ok).toBe(true);
    expect(await all(env, "SELECT version FROM reviews WHERE profile_id=?", f.profile)).toEqual([{ version: 1 }]);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='google.review.new'", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(1);
    await noConversations(f.profile);
  });

  it("evento sem ID usa hash normalizado e também deduplica entre invocações", async () => {
    const f = await setup(), input = { ...event(f), id: undefined };
    const responses = await Promise.all([c2ZernioWebhook(f, input), c2ZernioWebhook(f, { ...input, ignoredMetadata: "Não faz parte do recurso" })]);
    for (const response of responses) expect(response.ok, await response.clone().text()).toBe(true);
    expect(await all(env, "SELECT version FROM reviews WHERE profile_id=?", f.profile)).toEqual([{ version: 1 }]);
    expect(await all(env, "SELECT event_key FROM channel_events WHERE connection_id=?", f.line)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='google.review.new'", f.profile)).toHaveLength(1);
    await noConversations(f.profile);
  });

  it("atualiza, preserva tombstone contra atraso e restaura só com estado posterior", async () => {
    const f = await setup(), input = event(f), original = await receive(f, input);
    const edited = event(f, input.review.id, "review.updated", now() - 800);
    edited.review.text = "Atendimento atualizado com atenção.";
    const second = await receive(f, edited);
    expect(second).toMatchObject({ text: edited.review.text, state: "active", version: original.version + 1 });
    const deleted = await receive(f, event(f, input.review.id, "review.deleted", now() - 600));
    expect(deleted.state).toBe("deleted");
    const stale = event(f, input.review.id, "review.updated", now() - 700);
    stale.review.text = "Texto atrasado";
    expect(await receive(f, stale)).toMatchObject({ state: "deleted", version: deleted.version, text: deleted.text });
    expect(await receive(f, event(f, input.review.id, "review.restored", now() - 900)))
      .toMatchObject({ state: "deleted", version: deleted.version });
    const restored = await receive(f, event(f, input.review.id, "review.restored", now() - 400));
    expect(restored).toMatchObject({ state: "active", version: deleted.version + 1 });
    await noConversations(f.profile);
  });

  it("ignora histórico anterior ao marco e não aceita conta diferente", async () => {
    const f = await setup(), old = event(f);
    old.review.publishedAt = now() - 20_000;
    old.review.updatedAt = now() - 500;
    expect((await c2ZernioWebhook(f, old)).ok).toBe(true);
    const foreign = event(f);
    foreign.account.accountId = uid();
    await c2ZernioWebhook(f, foreign);
    expect(await all(env, "SELECT id FROM reviews WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='google.review.new'", f.profile)).toEqual([]);
    await noConversations(f.profile);
  });

  it("tombstone sem data de publicação não permite restaurar uma avaliação histórica", async () => {
    const f = await setup(), remoteId = uid(), source = event(f, remoteId, "review.deleted", now() - 800);
    const deleted = { ...source, review: { id: remoteId, updatedAt: now() - 800 } };
    expect((await c2ZernioWebhook(f, deleted)).ok).toBe(true);
    const tombstone = (await one<ChannelReview>(env, "SELECT * FROM reviews WHERE connection_id=? AND remote_id=?", f.line, remoteId))!;
    expect(tombstone).toMatchObject({ state: "deleted", published_at: null });
    const historical = event(f, remoteId, "review.restored", now() - 400);
    historical.review.publishedAt = now() - 20_000;
    expect(await receive(f, historical)).toMatchObject({ state: "deleted", published_at: null, version: tombstone.version });
    const detail = await c2Request(`/api/v1/profiles/${f.profile}/c2/reviews/${tombstone.id}`,
      { headers: { Authorization: `Bearer ${await bearer(f.admin)}` } });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ state: "deleted", rating: null, can_reply: false });
    const report = await googleReviewsExtension.report!({ env: env as Env, actor: f.admin, profileId: f.profile, query: new URLSearchParams() });
    expect(await report.json()).toEqual({ channel: "googlebusiness", data: [] });
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='google.review.new'", f.profile)).toEqual([]);
    await noConversations(f.profile);
  });
});

describe("c2-google: publicação humana e recuperação", { timeout: 30_000 }, () => {
  it("leitura não concede publicação; administrador concede e revoga google.reply", async () => {
    const f = await setup(), review = await receive(f);
    const path = `/reviews/${review.id}/reply`, input = { version: review.version, text: "Agradecemos a avaliação." };
    expect((await route(f, "PUT", path, input, f.member)).status).toBe(403);
    expect((await route(f, "PUT", `/review-publishers/${f.other.id}`, {}, f.member)).status).toBe(403);
    await grant(f);
    expect(await one(env, "SELECT permission FROM channel_public_grants WHERE profile_id=? AND user_id=?", f.profile, f.member.id))
      .toEqual({ permission: "google.reply" });
    const key = uid(), response = await route(f, "PUT", path, input, f.member, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const replay = await route(f, "PUT", path, input, f.member, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await response.json());
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await route(f, "DELETE", `/review-publishers/${f.member.id}`)).status).toBe(200);
    expect((await route(f, "PUT", path, input, f.member, key)).status).toBe(403);
    await noConversations(f.profile);
  });

  it("revogação antes da publicação impede a rede e não altera a resposta", async () => {
    const f = await setup(), review = await receive(f);
    await grant(f);
    const row = await enqueue(f, review, "Resposta autorizada inicialmente.", f.member);
    await route(f, "DELETE", `/review-publishers/${f.member.id}`);
    await dispatchChannelDelivery(env as Env, row);
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", row.id)).toEqual({ status: "failed" });
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "" });
    await noConversations(f.profile);
  });

  it("substituições concorrentes da mesma versão reservam apenas uma publicação", async () => {
    const f = await setup(), review = await receive(f), path = `/reviews/${review.id}/reply`;
    const responses = await Promise.all([
      route(f, "PUT", path, { version: review.version, text: "Resposta da primeira pessoa." }),
      route(f, "PUT", path, { version: review.version, text: "Resposta concorrente." }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const rows = await all<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBeNull();
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "" });
    expect(await all(env, "SELECT outbox_id FROM channel_delivery_state WHERE profile_id=?", f.profile)).toHaveLength(1);
    await noConversations(f.profile);
  });

  it("revogação de acesso a Avaliações impede leitura e publicação mesmo com concessão", async () => {
    const f = await setup(), review = await receive(f);
    await grant(f);
    const token = await bearer(f.member);
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["conversations"]), f.member.id);
    const response = await c2Request(`/api/v1/profiles/${f.profile}/c2/reviews/${review.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
    expect((await route(f, "PUT", `/reviews/${review.id}/reply`, { version: review.version, text: "Resposta" }, f.member)).status).toBe(403);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("recupera confirmação remota uma vez, sem balão e mesmo após revogação", async () => {
    const f = await setup(), review = await receive(f);
    const row = await enqueue(f, review, "Agradecemos sua avaliação.");
    expect(row.conversation_id).toBeNull();
    expect(await one(env, "SELECT resource_key FROM channel_delivery_state WHERE outbox_id=?", row.id))
      .toEqual({ resource_key: `review:${review.id}` });
    await exec(env, "UPDATE outbox SET status='sent',external_id='reply-confirmed' WHERE id=?", row.id);
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", f.admin.id);
    await recoverChannelDeliveries(env as Env, f.profile);
    const completed = await one<ChannelReview>(env, "SELECT * FROM reviews WHERE id=?", review.id);
    expect(completed?.reply_text).toBe("Agradecemos sua avaliação.");
    expect(completed!.version).toBeGreaterThan(review.version);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await one(env, "SELECT version FROM reviews WHERE id=?", review.id)).toEqual({ version: completed!.version });
    expect(await one(env, "SELECT completion_handled FROM outbox WHERE id=?", row.id)).toEqual({ completion_handled: 1 });
    await noConversations(f.profile);
  });

  it("retoma recibo incompleto depois da conclusão sem reenviar nem exigir a versão antiga", async () => {
    const f = await setup(), review = await receive(f), key = uid();
    await grant(f);
    const path = `/reviews/${review.id}/reply`, input = { version: review.version, text: "Resposta confirmada antes da queda." };
    const first = await route(f, "PUT", path, input, f.member, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json() as { delivery_id: string; status: string };
    expect(result.delivery_id).toBeTruthy();
    const scope = `${f.member.id}:${f.profile}:c2.route`;
    // O lote de saída chegou ao banco; a confirmação do comando foi perdida.
    const interrupted = await exec(env, "UPDATE receipts SET response=NULL WHERE scope=? AND key=?", scope, key);
    expect(interrupted.meta.changes).toBe(1);
    await exec(env, "UPDATE outbox SET status='sent',external_id='reply-confirmed' WHERE id=?", result.delivery_id);
    await recoverChannelDeliveries(env as Env, f.profile);
    const completed = (await one<ChannelReview>(env, "SELECT * FROM reviews WHERE id=?", review.id))!;
    expect(completed).toMatchObject({ reply_text: input.text });
    expect(completed.version).toBeGreaterThan(input.version);
    expect(await one(env, "SELECT completion_handled FROM outbox WHERE id=?", result.delivery_id)).toEqual({ completion_handled: 1 });
    const replay = await route(f, "PUT", path, input, f.member, key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([{ id: result.delivery_id }]);
    expect(await one(env, "SELECT version,reply_text FROM reviews WHERE id=?", review.id))
      .toEqual({ version: completed.version, reply_text: input.text });
    expect(await one(env, "SELECT permission FROM channel_public_grants WHERE profile_id=? AND user_id=?", f.profile, f.member.id))
      .toEqual({ permission: "google.reply" });
    // Reconstruir o recibo ainda exige a permissão atual da pessoa.
    await exec(env, "UPDATE receipts SET response=NULL WHERE scope=? AND key=?", scope, key);
    expect((await route(f, "DELETE", `/review-publishers/${f.member.id}`)).status).toBe(200);
    expect((await route(f, "PUT", path, input, f.member, key)).status).toBe(403);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([{ id: result.delivery_id }]);
    await noConversations(f.profile);
  });

  it("confere a versão novamente antes de publicar após atualização remota", async () => {
    const f = await setup(), source = event(f), review = await receive(f, source);
    const row = await enqueue(f, review, "Texto preparado antes da alteração.");
    const update = event(f, source.review.id, "review.updated", now() - 500);
    update.review.text = "A avaliação foi alterada depois da preparação.";
    await receive(f, update);
    await dispatchChannelDelivery(env as Env, row);
    expect(await one(env, "SELECT status,error FROM outbox WHERE id=?", row.id)).toEqual({ status: "failed", error: "resource_changed" });
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "" });
  });

  it("substitui e apaga somente a resposta confirmada pela outbox", async () => {
    const f = await setup(), source = event(f);
    const answered = { ...source, review: { ...source.review, reply: { text: "Resposta anterior.", updatedAt: now() - 900 } } };
    const review = await receive(f, answered);
    expect(review.reply_text).toBe("Resposta anterior.");
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.origin !== "https://zernio.com" || url.pathname !== `/api/v1/inbox/reviews/${encodeURIComponent(source.review.id)}/reply` ||
          !["POST", "DELETE"].includes(request.method)) {
        network.unexpected.push("chamada externa inesperada");
        throw new Error("Rede fora da fixture de resposta.");
      }
      expect(request.headers.get("Idempotency-Key")).toBeTruthy();
      calls.push({ method: request.method, body: request.method === "POST" ? await request.json() : null });
      return Response.json({ success: true, reply: { updatedAt: now() } });
    });
    const row = await enqueue(f, review, "Resposta substituída pela equipe.");
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "Resposta anterior." });
    await dispatchChannelDelivery(env as Env, row);
    const replaced = (await one<ChannelReview>(env, "SELECT * FROM reviews WHERE id=?", review.id))!;
    expect(replaced.reply_text).toBe("Resposta substituída pela equipe.");
    expect(calls).toEqual([{ method: "POST", body: { accountId: f.account, text: replaced.reply_text } }]);
    const response = await route(f, "DELETE", `/reviews/${review.id}/reply`, { version: replaced.version });
    expect(response.status, await response.clone().text()).toBe(200);
    const pending = await listReadyChannelDeliveries(env as Env, f.profile);
    expect(pending).toHaveLength(1);
    await dispatchChannelDelivery(env as Env, pending[0]);
    expect(await one(env, "SELECT state,reply_text,text FROM reviews WHERE id=?", review.id))
      .toEqual({ state: "active", reply_text: "", text: source.review.text });
    expect(calls.map(call => call.method)).toEqual(["POST", "DELETE"]);
    await noConversations(f.profile);
  });

  it("resultado indeterminado não é reenviado automaticamente", async () => {
    const f = await setup(), review = await receive(f), row = await enqueue(f, review, "Tentativa interrompida.");
    await exec(env, "UPDATE outbox SET status='sending',updated=? WHERE id=?", now() - 121_000, row.id);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", row.id)).toEqual({ status: "unknown" });
    expect(await listReadyChannelDeliveries(env as Env, f.profile)).toEqual([]);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(await one(env, "SELECT reply_text FROM reviews WHERE id=?", review.id)).toEqual({ reply_text: "" });
  });

  it("limite de 4.000 caracteres é local e versão é obrigatória", async () => {
    const f = await setup(), review = await receive(f), path = `/reviews/${review.id}/reply`;
    expect((await route(f, "PUT", path, { text: "Sem versão" })).ok).toBe(false);
    expect((await route(f, "PUT", path, { version: review.version + 1, text: "Versão incorreta" })).status).toBe(409);
    expect((await route(f, "PUT", path, { version: review.version, text: "a".repeat(4001) })).ok).toBe(false);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });
});

describe("c2-google: sugestão e aviso autorizado", { timeout: 30_000 }, () => {
  it("DTOs paginados e seção do relatório expõem só avaliações da área", async () => {
    const f = await setup(), first = await receive(f), second = await receive(f), other = await setup();
    await receive(other);
    const token = await bearer(f.member), headers = { Authorization: `Bearer ${token}` };
    const root = `/api/v1/profiles/${f.profile}/c2/reviews`;
    const response = await c2Request(`${root}?limit=1`, { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json() as { data: Array<{ id: string; can_reply: boolean }>; next_cursor: string; can_publish: boolean; reply_max_chars: number; reply_limit_source: string };
    expect(page).toMatchObject({ can_publish: false, reply_max_chars: 4000, reply_limit_source: "Wabotia" });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].can_reply).toBe(false);
    expect(page.next_cursor).toBeTruthy();
    const next = await c2Request(`${root}?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`, { headers });
    const following = await next.json() as { data: Array<{ id: string }>; next_cursor: string | null };
    expect([page.data[0].id, following.data[0].id].sort()).toEqual([first.id, second.id].sort());
    expect(following.next_cursor).toBeNull();
    const detail = await c2Request(`${root}/${first.id}`, { headers });
    expect(await detail.json()).toMatchObject({ id: first.id, account_label: "Conta sintética", can_reply: false, reply_limit_source: "Wabotia" });
    const report = await googleReviewsExtension.report!({ env: env as Env, actor: f.member, profileId: f.profile, query: new URLSearchParams() });
    expect(await report.json()).toEqual({ channel: "googlebusiness", data: [{ rating: 4, state: "active", total: 2, replied: 0 }] });
    expect(JSON.stringify(page)).not.toMatch(/webhook_secret|api_key|chave-sintetica|connection_config/);
    await noConversations(f.profile);
  });

  it.each(["Ana Silva", 'Ana "Silva" / Souza'])("sugestão mascara nome, identificador e e-mail sem publicar: %s", async author => {
    const f = await setup(), source = event(f);
    source.review.authorName = author;
    source.review.text = `Sou ${author}; meu e-mail é ana@example.test. ID ${source.review.id}.`;
    const review = await receive(f, source), aiId = uid();
    await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'IA sintética','ai','direct','active',?,?)",
      aiId, f.profile, JSON.stringify({ provider: "compatible", model: "fixture-model", base_url: "https://llm.example.com/v1" }), now());
    await setSecret(env, `connection:${aiId}`, { api_key: "chave-ia-sintetica" });
    const inputs: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://llm.example.com/v1/chat/completions" || request.method !== "POST") {
        network.unexpected.push("chamada externa inesperada");
        throw new Error("Rede fora da fixture de sugestão.");
      }
      inputs.push(await request.text());
      return Response.json({ choices: [{ message: { content: `Agradecemos o comentário, ${author}.` }, finish_reason: "stop" }] });
    });
    expect((await route(f, "POST", `/reviews/${review.id}/suggestion`, { version: review.version }, f.member)).status).toBe(403);
    const response = await route(f, "POST", `/reviews/${review.id}/suggestion`, { version: review.version });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as { suggestion: string };
    expect(inputs).toHaveLength(1);
    const sent = JSON.parse(inputs[0]) as { messages: Array<{ content: string }> };
    const messageTexts = sent.messages.map(message => message.content).join("\n");
    for (const personal of [author, "ana@example.test", source.review.id]) {
      const escaped = JSON.stringify(personal).slice(1, -1);
      expect(inputs[0]).not.toContain(personal);
      expect(inputs[0]).not.toContain(escaped);
      expect(messageTexts).not.toContain(personal);
      expect(messageTexts).not.toContain(escaped);
    }
    expect(inputs[0]).toContain("[NAME_");
    expect(result.suggestion).not.toContain(author);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    await noConversations(f.profile);
  });

  it.each([false, true])("push só alcança quem lê Avaliações; prévia mínima=%s", async minimal => {
    const f = await setup(), captured: Array<{ token: string; title: string; body: string; data: Record<string, string> }> = [];
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["conversations"]), f.other.id);
    await setSecret(env, "push:config", { mode: "gateway", gateway_url: "https://push.example.test", preview: minimal ? "minimal" : "preview", ticket_alert_minutes: 0 });
    for (const person of [f.admin, f.member, f.other]) await exec(env,
      "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,created,updated) VALUES(?,?,'android','fcm',?,'Teste','1',?,'https://test',?,?)",
      uid(), person.id, `device:${person.id}`, JSON.stringify([f.profile]), now(), now());
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://push.example.test/v1/push" || request.method !== "POST") {
        network.unexpected.push("chamada externa inesperada");
        throw new Error("Rede fora da fixture de push.");
      }
      const body = await request.json() as { messages: typeof captured };
      captured.push(...body.messages);
      return Response.json({ results: body.messages.map(message => ({ token: message.token, status: "ok" })) });
    });
    await processPush(env as Env, f.profile);
    const source = event(f), review = await receive(f, source);
    await processPush(env as Env, f.profile);
    expect(captured.map(item => item.token).sort()).toEqual([`device:${f.admin.id}`, `device:${f.member.id}`].sort());
    for (const message of captured) {
      expect(message.title).toBe(minimal ? "Wabotia" : "Google · nova avaliação de 4 estrelas");
      expect(message.data).toMatchObject({ type: "web", profile_id: f.profile, review_id: review.id });
      expect(message.data.url).toContain("area=reviews");
      expect(JSON.stringify(message)).not.toContain(source.review.authorName);
      expect(message.data).not.toHaveProperty("conversation_id");
    }
    await c2ZernioWebhook(f, source);
    await processPush(env as Env, f.profile);
    expect(captured).toHaveLength(2);
    expect(await all(env, "SELECT id FROM push_log WHERE profile_id=? AND kind='google_review'", f.profile)).toHaveLength(2);
    await noConversations(f.profile);
  });
});
