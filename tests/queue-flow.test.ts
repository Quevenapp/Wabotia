import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid, type Actor } from "../src/types";
import {
  bot,
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const menus = [
  { id: "fila", label: "Entrar na fila de espera", type: "queue" },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];
const run = (f: Fixture, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup(queueSettings: any = { front_door: true }) {
  const f = await fixture();
  const queue = await run(f, f.admin, "queue.save", {
    name: "Geral",
    service_minutes: 10,
  });
  const counter = await run(f, f.admin, "counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run(f, f.member, "counter.state", { id: counter.id, status: "open" });
  await configure(f, { menus, queue: queueSettings });
  return { f, queue, counter };
}
async function say(
  f: Fixture,
  text: string,
  phone: string,
  line = f.line,
  content: any = {},
) {
  const c = await receive(f, line, text, phone, content);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const button = (c: any, value: string) => ({
  interactive_reply_id: `wqueue:${c.session}:${value}`,
});
const tickets = (profile: string) =>
  all(
    env,
    "SELECT * FROM queue_tickets WHERE profile_id=? ORDER BY created_at,seq",
    profile,
  );

describe("fila pelo WhatsApp", () => {
  it("qualquer mensagem abre o menu, mesmo com bot, e o cliente tira a senha pelos botões", async () => {
    const { f } = await setup();
    const botId = await bot(f);
    await configure(f, { attendant_bot: botId });
    const phone = "5511920000001";
    let c = await say(f, "?", phone);
    let sent = await latest(c.id);
    expect(
      sent.text.startsWith(
        "Como podemos ajudar?\n1. Entrar na fila de espera\n2. Falar com atendente",
      ),
    ).toBe(true);
    // "Entrar na fila de espera" is over 20 characters: a list, not buttons.
    expect(sent.content.interactive.type).toBe("list");
    expect(
      await all(env, "SELECT id FROM bot_runs WHERE conversation_id=?", c.id),
    ).toHaveLength(0);

    c = await say(f, "1", phone);
    sent = await latest(c.id);
    expect(sent.text).toContain("*Geral*");
    expect(sent.text).toContain("Senha normal: 0 pessoas aguardando");
    expect(sent.text).toContain("Deseja entrar na fila?");
    expect(
      sent.content.interactive.action.buttons.map((b: any) => b.reply.title),
    ).toEqual(["Sim", "Não", "Voltar ao menu"]);

    c = await say(f, "", phone, f.line, button(c, "yes"));
    sent = await latest(c.id);
    expect(sent.text).toContain("Qual tipo de senha?");
    expect(sent.text).toContain("60 anos");
    expect(
      sent.content.interactive.action.buttons.map((b: any) => b.reply.title),
    ).toEqual(["Normal", "Preferencial", "Voltar"]);

    c = await say(f, "", phone, f.line, button(c, "preferential"));
    expect((await latest(c.id)).text).toContain("Sua senha é *P001*");
    const [t] = await tickets(f.profile);
    expect(t).toMatchObject({
      code: "P001",
      source: "whatsapp",
      phone,
      conversation_id: c.id,
    });

    // The menu is not repeated in the session; SENHA shows the position.
    c = await say(f, "SENHA", phone);
    expect((await latest(c.id)).text).toContain("Você é o próximo!");
    const menusShown = (await outbox(c.id)).filter((m) =>
      String(m.text).startsWith("Como podemos ajudar?"),
    );
    expect(menusShown).toHaveLength(1);
  });

  it("linha QR recebe opções numeradas e respostas digitadas funcionam", async () => {
    const { f } = await setup();
    const phone = "5511920000002";
    let c = await say(f, "bom dia", phone, f.qr);
    c = await say(f, "1", phone, f.qr);
    let sent = await latest(c.id);
    expect(sent.content).toBeUndefined();
    expect(sent.text).toContain("1. Sim\n2. Não\n3. Voltar ao menu");
    c = await say(f, "sim", phone, f.qr);
    c = await say(f, "1", phone, f.qr);
    expect((await latest(c.id)).text).toContain("*N001*");
  });

  it("Não encerra, Voltar ao menu reabre o menu e SAIR desiste", async () => {
    const { f } = await setup();
    const phone = "5511920000003";
    let c = await say(f, "oi", phone);
    c = await say(f, "1", phone);
    c = await say(f, "não", phone);
    expect((await latest(c.id)).text).toContain("Se mudar de ideia");
    c = await say(f, "menu", phone);
    c = await say(f, "1", phone);
    c = await say(f, "", phone, f.line, button(c, "menu"));
    expect((await latest(c.id)).text.startsWith("Como podemos ajudar?")).toBe(
      true,
    );

    c = await say(f, "1", phone);
    c = await say(f, "sim", phone);
    c = await say(f, "normal", phone);
    c = await say(f, "sair", phone);
    expect((await latest(c.id)).text).toContain("Senha N001 cancelada");
    expect((await tickets(f.profile))[0]).toMatchObject({
      status: "cancelled",
      cancel_reason: "customer",
    });
  });

  it("sem porta de entrada da fila, o bot continua atendendo", async () => {
    const { f } = await setup({ front_door: false });
    const botId = await bot(f);
    await configure(f, { attendant_bot: botId });
    const c = await say(f, "Preciso de ajuda", "5511920000004");
    expect(
      (await outbox(c.id)).some((m) =>
        String(m.text).startsWith("Como podemos ajudar?"),
      ),
    ).toBe(false);
    expect(
      await all(env, "SELECT id FROM bot_runs WHERE conversation_id=?", c.id),
    ).toHaveLength(1);
  });

  it("botão expirado não emite senha", async () => {
    const { f } = await setup();
    const phone = "5511920000005";
    let c = await say(f, "oi", phone);
    c = await say(f, "1", phone);
    await exec(
      env,
      "UPDATE conversations SET queue_prompt_expires_at=? WHERE id=?",
      now() - 1,
      c.id,
    );
    c = await say(f, "", phone, f.line, button(c, "yes"));
    expect((await latest(c.id)).text).toContain("expirou");
    expect(await tickets(f.profile)).toHaveLength(0);
  });

  it("chamada avisa pelo WhatsApp; fora da janela vai como modelo e o 'faltam' não sai", async () => {
    const { f, queue, counter } = await setup({
      front_door: true,
      notify_ahead: 1,
    });
    const take = async (phone: string) => {
      let c = await say(f, "oi", phone);
      c = await say(f, "1", phone);
      c = await say(f, "sim", phone);
      return say(f, "normal", phone);
    };
    const a = await take("5511920000006");
    const b = await take("5511920000007");
    const call = await run(f, f.member, "queue.call_next", { id: counter.id });
    expect(call.code).toBe("N001");
    const rows = await all(
      env,
      "SELECT kind,payload FROM outbox WHERE conversation_id=? ORDER BY created,rowid",
      a.id,
    );
    const notice = rows.at(-1)!;
    expect(notice.kind).toBe("notification");
    expect(json(notice.payload)).toMatchObject({
      text: "🔔 Senha N001: é a sua vez! Dirija-se ao Guichê 1.",
      ticket_id: "Senha N001",
      queue_ticket_id: call.id,
    });
    // B is now next: told so while its window is open.
    expect((await latest(b.id)).text).toBe(
      "Senha N002: você é o próximo! Fique por perto.",
    );

    // Outside the window: the call is still queued (template), other notices are not.
    const c = await take("5511920000008");
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 2 * 86400000,
      c.id,
    );
    await run(f, f.member, "queue.call_next", { id: counter.id });
    expect(
      (await outbox(c.id)).some((m) => String(m.text).includes("próximo!")),
    ).toBe(false);
    const staff = await run(f, f.member, "queue.call_next", { id: counter.id });
    expect(staff.window_open).toBe(false);
    expect((await latest(c.id)).text).toContain("é a sua vez");
    expect(queue.id).toBeTruthy();
  });

  it("cupom do totem: SENHA <código> vincula a senha e passa a avisar", async () => {
    const { f, queue, counter } = await setup();
    const kiosk = await run(f, f.admin, "queue.issue", {
      queue_id: queue.id,
      preferential: false,
      source: "staff",
    });
    const row = await one(
      env,
      "SELECT link_code FROM queue_tickets WHERE id=?",
      kiosk.id,
    );
    const phone = "5511920000009";
    const c = await say(f, `SENHA ${kiosk.code} ${row.link_code}`, phone);
    expect((await latest(c.id)).text).toContain(
      "Pronto! Vamos avisar por aqui.",
    );
    await run(f, f.member, "queue.call_next", { id: counter.id });
    expect((await latest(c.id)).text).toContain("é a sua vez");

    const wrong = await say(f, "SENHA N999 ABCDEF", "5511920000010");
    expect((await latest(wrong.id)).text).toContain(
      "Não encontramos essa senha",
    );
  });
});
