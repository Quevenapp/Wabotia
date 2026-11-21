// Fila de senhas e menu em todos os canais de conversa (pedido do dono de
// 21/11): chat do site (aplicação de integração, app:) e Telegram, simulados.
// O Instagram fica em fila-canais-instagram.test.ts (instala os ports sociais).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { inbound, perform } from "../src/service";
import { json, now, uid, type Actor, type Conversation } from "../src/types";
import {
  MENU_MODULE_CHANNELS,
  channelRefusalText,
  conversationAllowsMenuModules,
  conversationChannelLabel,
} from "../src/channels";
import { listTickets, queueConversationChannel, queueTakesConversations } from "../src/queue";
import { setSecret } from "../src/security";
import { telegramExtension } from "../src/c2/telegram";
import {
  application,
  configure,
  drain,
  fixture,
  outbox,
  quietCoordinator,
  type Fixture,
} from "./service-center-fixture";
import { c2Fixture, c2TelegramWebhook, installTestExtension } from "./c2-fixtures";

const menus = [
  { id: "fila", label: "Entrar na fila de espera", type: "queue" },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];
const profiles = new Set<string>();
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
});
const run = (f: Fixture, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function queueSetup(f: Fixture, queueSettings: any = { front_door: true }) {
  profiles.add(f.profile);
  const queue = await run(f, f.admin, "queue.save", { name: "Geral", service_minutes: 10 });
  const counter = await run(f, f.admin, "counter.save", { name: "Guichê 1", queue_ids: [queue.id] });
  await run(f, f.member, "counter.state", { id: counter.id, status: "open" });
  await configure(f, { menus, queue: queueSettings });
  return { queue, counter };
}
const texts = async (id: string) => (await outbox(id)).map((m) => String(m.text ?? ""));
const lastText = async (id: string) => (await texts(id)).at(-1) ?? "";
const tickets = (profile: string) =>
  all(env, "SELECT * FROM queue_tickets WHERE profile_id=? ORDER BY created_at,seq", profile);

describe("regra de canais do menu e da fila", () => {
  it("menu e fila valem em toda conversa direta dos canais de conversa", () => {
    for (const channel of MENU_MODULE_CHANNELS)
      expect(conversationAllowsMenuModules(
        { channel, external_namespace: "channel:l", chat_type: "direct" }, channel), channel).toBe(true);
    // Canal sem conversa com o cliente, comentário, canal trocado e aplicação
    // com canal social gravado continuam sem menu de módulos.
    for (const channel of ["email", "googlebusiness"] as const)
      expect(conversationAllowsMenuModules({ channel, external_namespace: "channel:l", chat_type: "direct" }, channel)).toBe(false);
    expect(conversationAllowsMenuModules({ channel: "instagram", external_namespace: "channel:l", chat_type: "comment" }, "instagram")).toBe(false);
    expect(conversationAllowsMenuModules({ channel: "instagram", external_namespace: "channel:l", chat_type: "direct",
      channel_context: JSON.stringify({ context: "comment" }) }, "instagram")).toBe(false);
    expect(conversationAllowsMenuModules({ channel: "facebook", external_namespace: "channel:l", chat_type: "direct" }, "instagram")).toBe(false);
    expect(conversationAllowsMenuModules({ channel: "instagram", external_namespace: "app:x", chat_type: "direct" }, "instagram")).toBe(false);
    // Chat do site (aplicação de integração) e WhatsApp, como antes.
    expect(conversationAllowsMenuModules({ channel: null, external_namespace: "app:x", chat_type: "direct" }, null)).toBe(true);
    expect(conversationAllowsMenuModules({ channel: null, external_namespace: "channel:l", chat_type: "direct" }, "whatsapp")).toBe(true);
  });

  it("canal da senha, nome do canal e resposta em palavras", () => {
    const base = { id: "c", profile_id: "p", connection_id: "l", external_namespace: "channel:l", chat_type: "direct" } as Conversation;
    expect(queueConversationChannel({ ...base, channel: null })).toBe("whatsapp");
    expect(queueConversationChannel({ ...base, channel: "telegram" })).toBe("telegram");
    expect(queueConversationChannel({ ...base, channel: "instagram" })).toBe("instagram");
    expect(queueConversationChannel({ ...base, channel: "email" })).toBeNull();
    expect(queueConversationChannel({ ...base, channel: null, connection_id: null, external_namespace: "app:x" })).toBe("app");
    expect(queueConversationChannel({ ...base, channel: null, chat_type: "group" })).toBeNull();
    expect(queueTakesConversations({ channels: '["whatsapp","kiosk"]' })).toBe(true);
    expect(queueTakesConversations({ channels: '["kiosk"]' })).toBe(false);
    expect(conversationChannelLabel({ channel: "telegram" })).toBe("Telegram");
    expect(conversationChannelLabel({ channel: null, external_namespace: "app:x" })).toBe("site");
    expect(channelRefusalText({ channel: "instagram" }, { code: "unsupported_content", message: "x" }))
      .toBe("Esta opção ainda não funciona pelo Instagram. Envie MENU para ver as outras opções ou fale com a gente pelo WhatsApp.");
    expect(channelRefusalText({ channel: "instagram" }, { code: "window_closed" })).toContain("depois da sua última mensagem");
  });
});

describe("fila pelo chat do site (aplicação de integração)", () => {
  async function setup() {
    const f = await fixture();
    const { queue, counter } = await queueSetup(f, { front_door: true, notify_ahead: 1 });
    const app = await application(f, ["conversations:read", "conversations:write"]);
    const external = "visitante-" + uid();
    const say = async (text: string) => {
      const result = await inbound(env, f.profile, { external_id: external, message_id: uid(), text }, `app:${app.id}`, null);
      await drain(f);
      return result.conversation_id as string;
    };
    return { f, queue, counter, say };
  }

  it("menu numerado, senha pela conversa, posição, aviso de chamada e desistência", async () => {
    const { f, counter, say } = await setup();
    let id = await say("oi");
    let sent = await lastText(id);
    expect(sent.startsWith("Como podemos ajudar?\n1. Entrar na fila de espera\n2. Falar com atendente")).toBe(true);
    expect((await outbox(id)).at(-1).content).toBeUndefined();

    id = await say("1");
    sent = await lastText(id);
    expect(sent).toContain("Geral");
    expect(sent).not.toContain("*");
    expect(sent).toContain("Deseja entrar na fila?\n\n1. Sim\n2. Não\n3. Voltar ao menu");
    id = await say("sim");
    expect(await lastText(id)).toContain("1. Normal\n2. Preferencial\n3. Voltar");
    id = await say("normal");
    sent = await lastText(id);
    expect(sent).toContain("Sua senha é N001 (Geral).");
    expect(sent).toContain("Avisaremos aqui quando for chamada.");
    const [ticket] = await tickets(f.profile);
    expect(ticket).toMatchObject({ code: "N001", source: "whatsapp", channel: "app", phone: null, conversation_id: id });

    // A equipe vê o canal de origem; o chat do site não tem janela.
    const listed = await listTickets(env, f.member, f.profile, {});
    expect(listed.data[0]).toMatchObject({ code: "N001", channel: "app", window_open: true });

    id = await say("SENHA");
    expect(await lastText(id)).toContain("Você é o próximo!");

    // Repetir o caminho devolve a mesma senha (uma ativa por fila).
    id = await say("menu");
    id = await say("1");
    expect(await lastText(id)).toContain("Sua senha é N001");

    const called = await run(f, f.member, "queue.call_next", { id: counter.id });
    expect(called).toMatchObject({ code: "N001", channel: "app" });
    expect(await lastText(id)).toBe("🔔 Senha N001: é a sua vez! Dirija-se ao Guichê 1.");
    const notice = (await all(env, "SELECT kind FROM outbox WHERE conversation_id=? ORDER BY created,rowid", id)).at(-1);
    expect(notice?.kind).toBe("text");

    id = await say("sair");
    expect(await lastText(id)).toContain("Senha N001 cancelada");
    expect((await tickets(f.profile))[0]).toMatchObject({ status: "cancelled", cancel_reason: "customer" });
  }, 60_000);

  it("o limite diário da área vale para a conversa", async () => {
    const { f, say } = await setup();
    await configure(f, { queue: { front_door: true, max_daily_per_contact: 1 } });
    let id = await say("oi");
    id = await say("1");
    id = await say("sim");
    id = await say("normal");
    id = await say("sair");
    id = await say("menu");
    id = await say("1");
    id = await say("sim");
    id = await say("normal");
    expect(await lastText(id)).toContain("Você já retirou 1 senhas hoje, o limite diário.");
    expect(await tickets(f.profile)).toHaveLength(1);
  }, 60_000);

  it("fila só do totem: o item some do menu do chat", async () => {
    const { f, queue, say } = await setup();
    await run(f, f.admin, "queue.save", { id: queue.id, name: "Geral", service_minutes: 10, channels: ["kiosk"] });
    const id = await say("oi");
    const sent = await lastText(id);
    expect(sent).not.toContain("Entrar na fila de espera");
    expect(sent).toContain("Falar com atendente");
  }, 60_000);
});

describe("fila pelo Telegram (bot simulado)", () => {
  const SUBJECT = 702345678;
  let BOT_ID: string, TOKEN: string;
  let unexpected: string[];
  beforeEach(() => {
    BOT_ID = String(1_000_000_000 + Number.parseInt(uid().replaceAll("-", "").slice(0, 12), 16));
    TOKEN = `${BOT_ID}:synthetic_telegram_secret_1234567890`;
    unexpected = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      unexpected.push("chamada externa inesperada");
      throw new Error("Rede não prevista pela fixture.");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(unexpected).toEqual([]);
  });

  async function setup() {
    const f = await c2Fixture("telegram");
    profiles.add(f.profile);
    await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://telegram.example.test',?)", now());
    // Linha com o atendimento padrão (menus automáticos), como no WhatsApp.
    await exec(env, "UPDATE connections SET config=json_remove(json_set(config,'$.bot_id',?,'$.account_id',?,'$.username','sintetico_bot'),'$.service') WHERE id=?",
      BOT_ID, BOT_ID, f.line);
    await setSecret(env, `connection:${f.line}`, { bot_token: TOKEN, webhook_secret: f.webhookSecret });
    await installTestExtension({ ...f, account: BOT_ID }, telegramExtension);
    const { counter } = await queueSetup(f);
    let update = 0;
    const say = async (text: string) => {
      update++;
      const response = await c2TelegramWebhook(f, { update_id: update, message: { message_id: update, date: Math.floor(now() / 1000),
        chat: { id: SUBJECT, type: "private" }, from: { id: SUBJECT, is_bot: false, first_name: "Pessoa sintética" }, text } });
      expect(response.status, await response.clone().text()).toBe(202);
      await drain(f);
      const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND connection_id=?", f.profile, f.line);
      return c!.id;
    };
    return { f, counter, say };
  }
  const sentTexts = async (id: string) =>
    (await all(env, "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created,rowid", id))
      .map((row) => { const p = json(row.payload); return String(p.c2?.action?.text ?? p.text ?? ""); });

  it("menu numerado, senha, posição e aviso de chamada na conversa do Telegram", async () => {
    const { f, counter, say } = await setup();
    let id = await say("oi");
    expect((await sentTexts(id)).join("\n")).toContain("1. Entrar na fila de espera");
    id = await say("1");
    expect((await sentTexts(id)).at(-1)).toContain("Deseja entrar na fila?\n\n1. Sim\n2. Não\n3. Voltar ao menu");
    id = await say("1");
    id = await say("2");
    expect((await sentTexts(id)).at(-1)).toContain("Sua senha é P001 (Geral, preferencial).");
    const [ticket] = await tickets(f.profile);
    expect(ticket).toMatchObject({ code: "P001", channel: "telegram", phone: null, conversation_id: id });
    id = await say("senha");
    expect((await sentTexts(id)).at(-1)).toContain("Você é o próximo!");
    await run(f, f.member, "queue.call_next", { id: counter.id });
    expect((await sentTexts(id)).at(-1)).toContain("Senha P001: é a sua vez! Dirija-se ao Guichê 1.");
  }, 60_000);
});
