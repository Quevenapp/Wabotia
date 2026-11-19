import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChannelRuntime } from "../src/channel-runtime";
import { all, batch, exec, one } from "../src/db";
import { configureEmail } from "../src/email";
import { refreshChannelSummaryStatements } from "../src/channel-accounts";
import { now, uid } from "../src/types";
import { setSecret } from "../src/security";
import { api, application, bearer, fixture, quietCoordinator, type Fixture } from "./service-center-fixture";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const mailUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`;
const profiles = new Set<string>();
let unexpected: string[], sent: any[];
beforeEach(async () => {
  installChannelRuntime();
  unexpected = []; sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== mailUrl || request.method !== "POST") {
      unexpected.push(request.url);
      throw new Error("Rede inesperada no teste HTTP dos canais.");
    }
    const body = await request.json() as any; sent.push(body);
    return Response.json({ success: true, result: { delivered: [body.to], queued: [], permanent_bounces: [] } });
  });
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

async function setup() {
  const f = await fixture(); profiles.add(f.profile);
  return { ...f, token: await bearer(f.admin) };
}
async function mail(f: Fixture) {
  await configureEmail(env, f.admin, { account_id: ACCOUNT, token: "token-sintetico-de-email-1234567890", from_address: "atendimento@example.test", from_name: "Loja" });
}
async function dialog(f: Fixture, extra: { channel?: string; connection?: string | null; namespace?: string; updated?: number } = {}) {
  const id = uid(), session = uid(), at = extra.updated ?? now() - 1000;
  const connection = extra.connection === undefined ? f.line : extra.connection;
  await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,title,last_customer,created,updated,channel) VALUES(?,?,?,?,?,?,'Ana',?,?,?,?)",
    id, f.profile, connection, extra.namespace ?? `channel:${connection}`, uid(), session, at, at, at, extra.channel ?? null);
  await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,content,created) VALUES(?,?,?,'customer','customer','Olá da conversa',?,?)",
    uid(), f.profile, id, JSON.stringify({ customerSession: session }), at);
  return id;
}
async function contact(f: Fixture, name: string) {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,email,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team',?,'cliente@example.test',?,'manual',?,?,?,?)",
    id, f.profile, name, name.toLowerCase(), f.admin.id, f.admin.id, now(), now());
  return id;
}
async function post(token: string, f: Fixture, path: string, body: unknown, key = uid()) {
  const response = await api(token, `/profiles/${f.profile}${path}`, "POST", body, key);
  await quietCoordinator(f.profile);
  return response;
}
const previewBody = { destination: { kind: "self" }, range: { kind: "session" } };

describe("DTOs, filtros e escopos das rotas públicas", () => {
  it("só WhatsApp preserva as chaves antigas e diferencia permissão de configuração de e-mail", async () => {
    const f = await setup(), id = await dialog(f);
    const status = await (await api(f.token, `/profiles/${f.profile}/status`)).json<any>();
    expect(status).toMatchObject({ connected_channels: ["whatsapp"], conversation_channels: ["whatsapp"], multichannel: false, email_transcript: { available: false } });
    expect(status.email_transcript.reason).toContain("Gestão → Sistema → E-mail");
    const denied = await (await api(await bearer(f.member), `/profiles/${f.profile}/status`)).json<any>();
    expect(denied.email_transcript).toMatchObject({ available: false });
    expect(denied.email_transcript.reason).not.toBe(status.email_transcript.reason);
    const response = await api(f.token, `/profiles/${f.profile}/conversations/${id}`);
    expect(response.status).toBe(200);
    const detail = await response.json<any>();
    expect(detail).toMatchObject({ channel: "whatsapp", multichannel: false, connection_kind: "zernio", conversation: { id }, other_conversations: [] });
    for (const key of ["text", "image", "document", "reply", "reaction", "groups", "upgrade_required"])
      expect(detail.capabilities[key], key).toBeTypeOf("boolean");
    expect(detail.messages).toHaveLength(1);
    expect(detail.email_transcript).toMatchObject({ available: false, destinations: [] });
  });

  it("capacidades sociais vêm do registro e expõem limites locais de mídia", async () => {
    const f = await setup();
    await exec(env, "UPDATE connections SET channel='instagram',account_label='@loja' WHERE id=?", f.line);
    await batch(env, refreshChannelSummaryStatements(f.profile));
    const response = await api(f.token, `/profiles/${f.profile}/connections/${f.line}/capabilities`);
    expect(response.status).toBe(200);
    const caps = await response.json<any>();
    expect(caps).toMatchObject({ channel: "instagram", account_label: "@loja", multichannel: true, templates: false, modules: false, reply: false, can_initiate: false, text_limit: 640 });
    expect(caps.media_limits.image).toMatchObject({ send: true, maxSendBytes: 3 * 1024 * 1024 });
    expect(caps.media_limits.document).toMatchObject({ send: true, maxSendBytes: 8 * 1024 * 1024 });
    expect(caps.media_limits.image.mimeTypes).toContain("image/jpeg");
  });

  it("filtra antes de paginar, oculta outros namespaces e vincula cursor ao filtro", async () => {
    const f = await setup(), app = await application(f, ["conversations:read"]), at = now();
    await exec(env, "UPDATE connections SET channel='instagram' WHERE id=?", f.line);
    const expected = [];
    for (let i = 0; i < 3; i++) expected.push(await dialog(f, { channel: "instagram", updated: at - i * 10 }));
    await dialog(f, { channel: "instagram", namespace: "app:app:outra-aplicacao", updated: at + 100 });
    await dialog(f, { connection: f.second, updated: at + 200 });
    const base = `/profiles/${f.profile}/conversations?channel=instagram&limit=1`;
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await api(app.token, base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      expect(response.status).toBe(200);
      const page = await response.json<any>();
      expect(page.data).toHaveLength(1);
      expect(page.data[0].channel).toBe("instagram");
      ids.push(page.data[0].id); cursor = page.next_cursor;
      if (i === 0) {
        const mismatch = await api(app.token, `/profiles/${f.profile}/conversations?channel=facebook&cursor=${encodeURIComponent(cursor!)}`);
        expect(mismatch.status).toBe(400);
        expect((await mismatch.json<any>()).error.code).toBe("invalid_cursor");
      }
    }
    expect(ids).toEqual(expected);
    expect(cursor).toBeNull();
    expect((await api(app.token, `/profiles/${f.profile}/conversations?channel=desconhecido`)).status).toBe(400);
    expect((await (await api(app.token, `/profiles/${f.profile}/conversations?channel=tiktok`)).json<any>()).data).toEqual([]);
  });

  it("não infere WhatsApp para conversa de aplicação e oculta conversa de outra área", async () => {
    const f = await setup(), foreign = await setup();
    const id = await dialog(f, { connection: null, namespace: "app:integracao" });
    const detail = await (await api(f.token, `/profiles/${f.profile}/conversations/${id}`)).json<any>();
    expect(detail.channel).toBeNull();
    const foreignId = await dialog(foreign);
    expect((await api(f.token, `/profiles/${f.profile}/conversations/${foreignId}`)).status).toBe(404);
    expect((await post(f.token, f, `/conversations/${foreignId}/email/preview`, previewBody)).status).toBe(404);
  });

  it("POST /connections recusa criação social fora da importação e canal existente é imutável", async () => {
    const f = await setup();
    const create = await post(f.token, f, "/connections", { name: "Instagram forjado", kind: "zernio", channel: "instagram", config: { account_id: "forjado", multichannel: true } });
    expect(create.status).toBeGreaterThanOrEqual(400);
    const change = await post(f.token, f, "/connections", { id: f.line, name: "Instagram forjado", kind: "zernio", channel: "instagram", config: {} });
    expect(change.status).toBeGreaterThanOrEqual(400);
    expect(await one(env, "SELECT channel FROM connections WHERE id=?", f.line)).toEqual({ channel: "whatsapp" });
  });

  it("descobre e importa conta pelo Coordinator real, sem registrar telefone ou repetir consulta remota", async () => {
    const f = await setup(), integration = uid(), account = uid().replaceAll("-", "").slice(0, 24);
    const remote = uid().replaceAll("-", "").slice(0, 24);
    await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Integração',?,'zernio',?,?)", integration, f.profile, `zernio:${remote}`, remote, now());
    await setSecret(env, `zernio-account:${integration}`, { api_key: "chave-sintetica", webhook_secret: "segredo-sintetico" });
    let calls = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.origin !== "https://zernio.com" || url.pathname !== "/api/v1/accounts" ||
          url.searchParams.get("profileId") !== remote || request.method !== "GET" ||
          request.headers.get("Authorization") !== "Bearer chave-sintetica") {
        unexpected.push(request.url); throw new Error("Chamada Zernio fora da fixture.");
      }
      calls++;
      return Response.json({ accounts: url.searchParams.get("platform") === "instagram"
        ? [{ _id: account, platform: "instagram", profileId: remote, username: "@loja", isActive: true }] : [], pagination: { nextCursor: null } });
    });
    const discovery = await post(f.token, f, `/router/accounts/${integration}/discover-channels`, {});
    expect(discovery.status).toBe(200);
    expect((await discovery.json<any>()).accounts).toMatchObject([{ channel: "instagram", accountId: account, importable: true }]);
    const key = uid(), body = { channel: "instagram", accountId: account }, path = `/router/accounts/${integration}/channel-connections`;
    const imported = await post(f.token, f, path, body, key);
    expect(imported.status).toBe(200);
    const result = await imported.json<any>(), afterImport = calls;
    expect(result.connection).toMatchObject({ profile_id: f.profile, channel: "instagram", account_label: "@loja" });
    expect((await post(f.token, f, path, body, key)).status).toBe(200);
    expect(calls).toBe(afterImport);
    expect(await all(env, "SELECT * FROM meta_numbers WHERE connection_id=?", result.connection.id)).toEqual([]);
    expect(await one(env, "SELECT count(*) n FROM zernio_channel_accounts WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
    const status = await (await api(f.token, `/profiles/${f.profile}/status`)).json<any>();
    expect(status.connected_channels).toEqual(expect.arrayContaining(["whatsapp", "instagram"]));
    expect(status.multichannel).toBe(true);
  });
});

describe("transcrição pela API e recibos do Coordinator", () => {
  it("prévia e envio reais excluem notas e repetem chave sem novo e-mail ou cota", async () => {
    const f = await setup(), id = await dialog(f); await mail(f);
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'note',?,'SEGREDO DA NOTA',?)", uid(), f.profile, id, f.admin.id, now());
    const previewResponse = await post(f.token, f, `/conversations/${id}/email/preview`, previewBody);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<any>();
    expect(preview).toMatchObject({ recipient: `${f.admin.id}@example.test`, messageCount: 1 });
    expect(sent).toEqual([]);
    const key = uid(), body = { previewToken: preview.previewToken };
    const first = await post(f.token, f, `/conversations/${id}/email`, body, key);
    expect(first.status).toBe(200);
    const result = await first.json<any>();
    expect(result).toMatchObject({ status: "sent", duplicate: false });
    const replay = await post(f.token, f, `/conversations/${id}/email`, body, key);
    expect(replay.status).toBe(200);
    expect((await replay.json<any>()).id).toBe(result.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].text + sent[0].html).not.toContain("SEGREDO DA NOTA");
    expect(await one(env, "SELECT count(*) n FROM email_log WHERE profile_id=? AND purpose='conversation.email'", f.profile)).toEqual({ n: 1 });
    const conflict = await post(f.token, f, `/conversations/${id}/email`, { ...body, confirmedRecipient: "outro@example.test" }, key);
    expect(conflict.status).toBe(409);
    expect((await conflict.json<any>()).error.code).toBe("idempotency_conflict");
  });

  it("replay de e-mail reautoriza permissão revogada após o envio", async () => {
    const f = await setup(), id = await dialog(f); await mail(f);
    const preview = await (await post(f.token, f, `/conversations/${id}/email/preview`, previewBody)).json<any>();
    const key = uid(), body = { previewToken: preview.previewToken };
    expect((await post(f.token, f, `/conversations/${id}/email`, body, key)).status).toBe(200);
    await exec(env, "UPDATE users SET role='operator',access='[\"*\"]' WHERE id=?", f.admin.id);
    expect((await post(f.token, f, `/conversations/${id}/email`, body, key)).status).toBe(403);
    // O Coordinator recebe deliberadamente o snapshot antigo do ator: a
    // reautorização do recibo também deve funcionar sem depender do Worker.
    const stale = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/command", {
      method: "POST", body: JSON.stringify({ profile: f.profile, actor: f.admin, operation: "conversation.email", data: { ...body, id }, key, requestId: uid() }),
    });
    expect(stale.status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  it("aplicação exige escopo explícito e não recebe destino self", async () => {
    const f = await setup(), id = await dialog(f); await mail(f);
    const catalog = await (await api(f.token, "/applications")).json<any>();
    expect(catalog.scopes).toContain("conversations:email");
    const denied = await application(f, ["conversations:read"]);
    expect((await post(denied.token, f, `/conversations/${id}/email/preview`, previewBody)).status).toBe(403);
    const allowed = await application(f, ["conversations:read", "conversations:email"]);
    const view = await (await api(allowed.token, `/profiles/${f.profile}/conversations/${id}`)).json<any>();
    expect(view.email_transcript.destinations).not.toContain("self");
    expect((await post(allowed.token, f, `/conversations/${id}/email/preview`, previewBody)).status).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
  });

  it("mutações exigem chave idempotente também na prévia", async () => {
    const f = await setup(), id = await dialog(f);
    const response = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/conversations/${id}/email/preview`, {
      method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" }, body: JSON.stringify(previewBody),
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("junção e desfazer pelas rotas públicas", () => {
  async function mergeSetup() {
    const f = await setup(), source = await contact(f, "Origem"), target = await contact(f, "Destino");
    const response = await post(f.token, f, `/contacts/${source}/merge-preview`, { targetId: target });
    expect(response.status).toBe(200);
    const preview = await response.json<any>();
    expect(preview.blockers).toEqual([]);
    const body = { targetId: target, sourceVersion: preview.source.version, targetVersion: preview.target.version, previewToken: preview.previewToken, fieldChoices: {} };
    return { f, source, target, body };
  }

  it("junta e desfaz com implementação real, sem duplicar auditoria", async () => {
    const { f, source, target, body } = await mergeSetup(), key = uid();
    const response = await post(f.token, f, `/contacts/${source}/merge`, body, key);
    expect(response.status).toBe(200);
    const result = await response.json<any>();
    expect(result).toMatchObject({ sourceId: source, targetId: target, state: "applied" });
    expect(await one(env, "SELECT merged_into,identity_state FROM contacts WHERE id=?", source)).toEqual({ merged_into: target, identity_state: "active" });
    const repeated = await post(f.token, f, `/contacts/${source}/merge`, body, key);
    expect(repeated.status).toBe(200);
    expect((await repeated.json<any>()).id).toBe(result.id);
    expect(await one(env, "SELECT count(*) n FROM customer_merges WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
    const undoKey = uid(), path = `/contacts/${source}/merges/${result.id}/undo`;
    expect((await post(f.token, f, path, {}, undoKey)).status).toBe(200);
    expect((await post(f.token, f, path, {}, undoKey)).status).toBe(200);
    expect(await one(env, "SELECT merged_into FROM contacts WHERE id=?", source)).toEqual({ merged_into: null });
    expect(await one(env, "SELECT state FROM customer_merges WHERE id=?", result.id)).toEqual({ state: "undone" });
  });

  it("recusa replay de junção após revogação e corpo diferente com a mesma chave", async () => {
    const { f, source, body } = await mergeSetup(), key = uid(), path = `/contacts/${source}/merge`;
    expect((await post(f.token, f, path, body, key)).status).toBe(200);
    const conflict = await post(f.token, f, path, { ...body, reason: "outro pedido" }, key);
    expect(conflict.status).toBe(409);
    await exec(env, "UPDATE users SET role='operator',access='[\"*\"]' WHERE id=?", f.admin.id);
    expect((await post(f.token, f, path, body, key)).status).toBe(403);
    const stale = await env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)).fetch("https://coordinator/command", {
      method: "POST", body: JSON.stringify({ profile: f.profile, actor: f.admin, operation: "contact.merge", data: { ...body, id: source }, key, requestId: uid() }),
    });
    expect(stale.status).toBe(403);
    expect(await one(env, "SELECT count(*) n FROM customer_merges WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
  });

  it("oculta alvo de outra área e aplicação não pode juntar", async () => {
    const f = await setup(), other = await setup(), source = await contact(f, "Origem"), target = await contact(other, "Oculto");
    expect((await post(f.token, f, `/contacts/${source}/merge-preview`, { targetId: target })).status).toBe(404);
    const app = await application(f, ["contacts:read", "contacts:write", "contacts:merge"]);
    expect((await post(app.token, f, `/contacts/${source}/merge-preview`, { targetId: source })).status).toBe(403);
    expect(await all(env, "SELECT id FROM customer_merges WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("mensagem nova após a junção impede desfazer o manifesto", async () => {
    const f = await setup(), source = await contact(f, "Origem"), target = await contact(f, "Destino"), id = await dialog(f);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'teste',?)", id, f.profile, source, now());
    const preview = await (await post(f.token, f, `/contacts/${source}/merge-preview`, { targetId: target })).json<any>();
    const body = { targetId: target, sourceVersion: preview.source.version, targetVersion: preview.target.version, previewToken: preview.previewToken, fieldChoices: {} };
    const merged = await post(f.token, f, `/contacts/${source}/merge`, body);
    expect(merged.status).toBe(200);
    const result = await merged.json<any>();
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','customer','Mensagem posterior',?)", uid(), f.profile, id, now());
    const undo = await post(f.token, f, `/contacts/${source}/merges/${result.id}/undo`, {});
    expect(undo.status).toBe(409);
    expect((await undo.json<any>()).error.code).toBe("merge_changed");
    expect(await one(env, "SELECT merged_into FROM contacts WHERE id=?", source)).toEqual({ merged_into: target });
  });
});

it("relatório filtra e exporta canal, preservando origem desconhecida fora do filtro WhatsApp", async () => {
  const f = await setup();
  await exec(env, "UPDATE connections SET channel='instagram' WHERE id=?", f.line);
  const social = await dialog(f, { channel: "instagram" });
  const whatsapp = await dialog(f, { connection: f.second });
  await dialog(f, { connection: null, namespace: "app:outra" });
  for (const [channel, id] of [["instagram", social], ["whatsapp", whatsapp]]) {
    const response = await api(f.token, `/profiles/${f.profile}/reports?section=conversations&format=jsonl&channel=${channel}`);
    expect(response.status).toBe(200);
    const rows = (await response.text()).trim().split("\n").filter(Boolean).map(row => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, channel });
  }
  expect((await api(f.token, `/profiles/${f.profile}/reports?channel=desconhecido`)).status).toBe(400);
});
