// Fila de senhas e menu pelo Instagram (pedido do dono de 21/11), simulado:
// a mensagem do cliente entra direto na caixa de entrada da área (como a
// entrada da Zernio faria) e as respostas ficam na outbox, sem rede.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { processInbox } from "../src/engine";
import { installChannelAccountsPort, installChannelIdentityPort, installSocialTransportPort,
  type ChannelAccountsPort, type ChannelIdentityPort } from "../src/channel-ports";
import { zernioSocialTransport } from "../src/zernio-social";
import { listTickets } from "../src/queue";
import { setSecret } from "../src/security";
import { defaults, json, now, uid, type Actor } from "../src/types";

vi.hoisted(() => vi.resetModules());
const HOUR = 3_600_000;
let unexpected: string[] = [];
const absent = async (): Promise<never> => { throw new Error("Port de outra tarefa não deve executar neste teste."); };
beforeAll(() => {
  installChannelAccountsPort({ channels: ["instagram", "facebook"], discover: absent, importAccount: absent,
    validateConfiguration: absent, removeLink: absent } satisfies ChannelAccountsPort);
  installChannelIdentityPort({ channels: ["instagram", "facebook"], prepareInbound: absent, readChannels: absent,
    previewMerge: absent, merge: absent, undoMerge: absent } satisfies ChannelIdentityPort);
  installSocialTransportPort(zernioSocialTransport);
});
beforeEach(() => {
  unexpected = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    unexpected.push("chamada externa inesperada");
    throw new Error("Rede inesperada.");
  });
});
afterEach(() => {
  try { expect(unexpected).toEqual([]); }
  finally { vi.restoreAllMocks(); }
});

const menus = [
  { id: "fila", label: "Entrar na fila de espera", type: "queue" },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];

async function setup() {
  const profile = uid(), line = uid(), integration = uid(), id = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Instagram',?,1,?)", profile,
    JSON.stringify({ ...defaults, sender_signature: false }), now());
  await exec(env, "INSERT INTO profile_erp_parts_managed(profile_id) VALUES(?)", profile);
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created,channel) VALUES(?,?,'Instagram','zernio','direct','active',?,?,'instagram')",
    line, profile, JSON.stringify({ account_id: "business", platform: "instagram", zernio_workspace_id: integration }), now());
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,'Integração',?,'zernio',?)", integration, profile, uid(), now());
  await exec(env, "INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,created,updated) VALUES(?,?,?,?,?,?,?)",
    line, profile, integration, "instagram", "business", now(), now());
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated,channel,channel_account_id,channel_subject_id,state)
    VALUES(?,?,?,?,?,NULL,?,?,?,?,'instagram','business','123456789','ai')`,
    id, profile, line, `channel:${line}`, "social:123456789", uid(), now(), now(), now());
  await exec(env, "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,'thread')", line, "social:123456789");
  await setSecret(env, `zernio-account:${integration}`, { api_key: "chave-sintetica" });
  const admin: Actor = { id: uid(), name: "Dona", kind: "user", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 10 };
  const member: Actor = { ...admin, id: uid(), name: "Guichê", role: "operator" };
  for (const actor of [admin, member])
    await exec(env, "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      actor.id, `${actor.id}@example.test`, actor.name, "test", actor.role, JSON.stringify([profile]), now());
  const op = (actor: Actor, name: string, data: any = {}) => perform(env, actor, profile, name, data, uid());
  const queue = await op(admin, "queue.save", { name: "Geral", service_minutes: 10 });
  const counter = await op(admin, "counter.save", { name: "Guichê 1", queue_ids: [queue.id] });
  await op(member, "counter.state", { id: counter.id, status: "open" });
  await op(admin, "settings", { menus, queue: { front_door: true } });
  /** Mensagem do cliente (texto ou toque numa opção) e o processamento dela. */
  const say = async (text: string, replyId?: string) => {
    const c = await one(env, "SELECT * FROM conversations WHERE id=?", id);
    const rowId = uid();
    await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", now(), id);
    await exec(env, "INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
      rowId, profile, rowId, id, JSON.stringify({ text, content: replyId ? { interactive_reply_id: replyId } : {},
        attachments: [], message_id: rowId, epoch: c.epoch, session: c.session }), now());
    while (await one(env, "SELECT id FROM inbox WHERE profile_id=? AND status='pending'", profile))
      await processInbox(env, profile);
    return one(env, "SELECT * FROM conversations WHERE id=?", id);
  };
  const sent = async () =>
    (await all(env, "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created,rowid", id))
      .map((row) => json(row.payload));
  return { profile, id, queue, counter, member, op, say, sent };
}

describe("fila pelo Instagram (simulado)", () => {
  it("menu com respostas rápidas, senha pelos botões, aviso de chamada e o limite da janela em palavras", async () => {
    const { profile, id, counter, member, op, say, sent } = await setup();
    await say("oi");
    let last = (await sent()).at(-1);
    expect(last.text.startsWith("Como podemos ajudar?")).toBe(true);
    // "Entrar na fila de espera" passa de 20 caracteres: texto numerado.
    expect(last.text).toContain("1. Entrar na fila de espera");

    let c = await say("1");
    last = (await sent()).at(-1);
    expect(last.text).toContain("Deseja entrar na fila?");
    expect(last.text).not.toContain("*");
    expect(last.content).toMatchObject({ type: "buttons" });
    expect(last.content.options.map((o: any) => o.title)).toEqual(["Sim", "Não", "Voltar ao menu"]);

    c = await say("", `wqueue:${c.session}:yes`);
    last = (await sent()).at(-1);
    expect(last.text).toContain("Qual tipo de senha?");
    expect(last.content.options.map((o: any) => o.title)).toEqual(["Normal", "Preferencial", "Voltar"]);

    c = await say("", `wqueue:${c.session}:normal`);
    last = (await sent()).at(-1);
    expect(last.text).toContain("Sua senha é N001 (Geral).");
    expect(last.text).toContain("Pelo Instagram só conseguimos avisar até 24 horas depois da sua última mensagem.");
    const [ticket] = await all(env, "SELECT * FROM queue_tickets WHERE profile_id=?", profile);
    expect(ticket).toMatchObject({ code: "N001", channel: "instagram", phone: null, conversation_id: id });
    expect((await listTickets(env, member, profile, {})).data[0]).toMatchObject({ channel: "instagram", window_open: true });

    await say("senha");
    expect((await sent()).at(-1).text).toContain("Você é o próximo!");

    await op(member, "queue.call_next", { id: counter.id });
    expect((await sent()).at(-1).text).toBe("🔔 Senha N001: é a sua vez! Dirija-se ao Guichê 1.");
  }, 60_000);

  it("fora da janela do Instagram o aviso não sai e o guichê vê a janela fechada", async () => {
    const { profile, id, counter, member, op, say, sent } = await setup();
    await say("oi");
    await say("1");
    await say("sim");
    await say("preferencial");
    expect((await sent()).at(-1).text).toContain("Sua senha é P001");
    await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", now() - 30 * HOUR, id);
    const before = (await sent()).length;
    const called = await op(member, "queue.call_next", { id: counter.id });
    expect(called).toMatchObject({ code: "P001", channel: "instagram", window_open: false });
    expect((await sent()).length).toBe(before);
    expect((await all(env, "SELECT status FROM queue_tickets WHERE profile_id=?", profile))[0].status).toBe("called");
  }, 60_000);

  it("item de módulo do menu (abrir ordem de serviço) manda o link pelo Instagram", async () => {
    const { profile, id, op, say, sent } = await setup();
    const admin = { id: (await one(env, "SELECT id FROM users WHERE profiles=? AND role='admin'", JSON.stringify([profile]))).id,
      name: "Dona", kind: "user", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 10 } as Actor;
    await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://loja.example.test',?)", now());
    await op(admin, "module.set", { id: "os", enabled: true });
    await op(admin, "settings", { menus: [
      { id: "abrir", label: "Abrir OS", type: "os_open" },
      { id: "atendente", label: "Falar com atendente", type: "human" },
    ] });
    await say("oi");
    const menu = (await sent()).at(-1);
    expect(menu.content.options.map((o: any) => o.title)).toEqual(["Abrir OS", "Falar com atendente"]);
    const c = await say("1");
    expect(c.id).toBe(id);
    expect(await all(env, "SELECT id FROM web_steps WHERE conversation_id=?", id), JSON.stringify((await sent()).at(-1))).toHaveLength(1);
    const link = (await sent()).at(-1);
    expect(link.text).toMatch(/https?:\/\//);
    expect(link.content?.type ?? "text").not.toBe("interactive");
  }, 60_000);

  it("SAIR desiste da senha pelo Instagram", async () => {
    const { profile, say, sent } = await setup();
    await say("oi");
    await say("1");
    await say("sim");
    await say("normal");
    await say("sair");
    expect((await sent()).at(-1).text).toContain("Senha N001 cancelada");
    expect((await all(env, "SELECT status,cancel_reason FROM queue_tickets WHERE profile_id=?", profile))[0])
      .toMatchObject({ status: "cancelled", cancel_reason: "customer" });
  }, 60_000);
});
