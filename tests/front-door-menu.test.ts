import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { conversation, handoff, perform } from "../src/service";
import { now, uid } from "../src/types";
import {
  bot,
  claim,
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const menus = [
  { id: "info", label: "Horários", type: "content", content: "Seg a sex." },
  { id: "pessoa", label: "Falar com a equipe", type: "human" },
];
const menuText = "Como podemos ajudar?\n1. Horários";
const queued = "Vou encaminhar sua solicitação para nossa equipe.";

async function say(f: Fixture, text: string, phone: string, line = f.line) {
  const c = await receive(f, line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const texts = async (id: string) =>
  (await outbox(id)).map((m) => String(m.text));
const setLine = (line: string, service: any) =>
  exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({ service }),
    line,
  );

describe("menu como porta de entrada sem bot", () => {
  it("abre o menu principal na primeira mensagem, seja qual for o texto", async () => {
    const f = await fixture();
    await configure(f, { menus });
    const c = await say(f, "Preciso de ajuda com o sistema", "5511910000001");
    const sent = await latest(c.id);
    expect(sent.text.startsWith(menuText)).toBe(true);
    expect(sent.automation).toBe("menu");
    expect(c.state).toBe("ai");
    expect(c.menu_active).toBe(1);
    expect(await texts(c.id)).toHaveLength(1);

    // The option still works after the free text that opened the menu.
    const chosen = await say(f, "1", "5511910000001");
    expect((await latest(chosen.id)).text).toBe("Seg a sex.");
  });

  it("não prende o cliente: o texto livre seguinte vai para a fila", async () => {
    const f = await fixture();
    await configure(f, { menus });
    await say(f, "Preciso de ajuda", "5511910000002");
    const c = await say(f, "Meu pedido não chegou", "5511910000002");
    expect(c.state).toBe("waiting");
    const sent = await texts(c.id);
    expect(sent.filter((t) => t.startsWith(menuText))).toHaveLength(1);
    expect(sent.at(-1)).toContain("Protocolo");

    // In the queue, further messages get neither menu nor another notice.
    await say(f, "Alguém aí?", "5511910000002");
    expect(await texts(c.id)).toHaveLength(sent.length);
  });

  it("volta a oferecer o menu depois de 24 horas da última apresentação", async () => {
    const f = await fixture();
    await configure(f, { menus });
    let c = await say(f, "Preciso de ajuda", "5511910000003");
    await say(f, "1", "5511910000003");
    await exec(
      env,
      "UPDATE conversations SET menu_expires_at=? WHERE id=?",
      now() - 1000,
      c.id,
    );
    c = await say(f, "Tenho outra dúvida", "5511910000003");
    expect(c.state).toBe("ai");
    expect((await latest(c.id)).text.startsWith(menuText)).toBe(true);
  });

  it("pedido explícito de atendente continua indo direto para a fila", async () => {
    const f = await fixture();
    await configure(f, { menus });
    const c = await say(f, "quero falar com um atendente", "5511910000004");
    expect(c.state).toBe("waiting");
    expect((await texts(c.id)).some((t) => t.startsWith(menuText))).toBe(false);
  });

  it("avisa o cliente de novo quando a conversa volta à fila depois de atendida", async () => {
    const f = await fixture();
    await configure(f, { menus });
    let c = await say(f, "quero falar com um atendente", "5511910000044");
    expect(c.state).toBe("waiting");
    const first = (await texts(c.id)).length;
    expect(first).toBeGreaterThan(0);

    // Still waiting: a repeated handoff does not repeat the notice.
    await handoff(env, c, "Cliente insistiu.");
    await drain(f);
    expect(await texts(c.id)).toHaveLength(first);

    // A person answered and returned the conversation to the bot, in the same
    // session. The next handoff is a new one and the customer must be told.
    await exec(
      env,
      "UPDATE conversations SET state='ai',epoch=epoch+1 WHERE id=?",
      c.id,
    );
    c = await conversation(env, c.id, f.profile);
    await handoff(env, c, "Resposta automática sem fundamentação suficiente.");
    await drain(f);
    expect(await texts(c.id)).toHaveLength(first + 1);
  });

  it("linha com atendimento humano mostra o menu só na mensagem que abre a sessão", async () => {
    const f = await fixture();
    await configure(f, { menus });
    await setLine(f.line, { mode: "human", menu_mode: "automatic" });
    let c = await say(f, "Boa tarde, preciso de um orçamento", "5511910000005");
    expect(c.state).toBe("waiting");
    expect((await texts(c.id)).filter((t) => t.startsWith(menuText))).toEqual([
      expect.any(String),
    ]);
    // Already queued: the next messages are for the team, not for the menu.
    c = await say(f, "É para amanhã", "5511910000005");
    expect(await texts(c.id)).toHaveLength(1);

    // Someone answering keeps the menu away.
    const g = await receive(
      f,
      f.line,
      "Olá, preciso de ajuda",
      "5511910000006",
    );
    await claim(f, f.member, g.id);
    await drain(f);
    expect(await texts(g.id)).toHaveLength(0);
  });

  it("não se aplica com menu manual, menu desligado, sem opções ou em grupo", async () => {
    const f = await fixture();
    // No menu configured: the previous behavior (queue) is kept.
    let c = await say(f, "Preciso de ajuda", "5511910000007");
    expect(c.state).toBe("waiting");
    expect(await texts(c.id)).toHaveLength(1);

    await configure(f, { menus });
    for (const [mode, phone] of [
      ["manual", "5511910000008"],
      ["off", "5511910000009"],
    ]) {
      await setLine(f.second, { mode: "inherit", menu_mode: mode });
      c = await say(f, "Preciso de ajuda", phone, f.second);
      expect((await texts(c.id)).some((t) => t.startsWith(menuText))).toBe(
        false,
      );
    }

    // A group never gets the menu from a free text.
    const g = await receive(f, f.qr, "Preciso de ajuda", "grupo-porta");
    await exec(
      env,
      "UPDATE conversations SET chat_type='group',bot_policy='all',title='Clientes' WHERE id=?",
      g.id,
    );
    await drain(f);
    expect(
      (await texts(g.id)).some((t) => t.startsWith("Como podemos ajudar?")),
    ).toBe(false);
  });

  it("a área pode ser ativada só com menu automático, sem bot nem linha humana", async () => {
    const f = await fixture();
    await exec(env, "UPDATE profiles SET enabled=0 WHERE id=?", f.profile);
    const activate = () =>
      perform(env, f.admin, f.profile, "activate", {}, uid());
    await expect(activate()).rejects.toMatchObject({ status: 400 });
    // A manual-only or disabled menu is not a front door.
    await configure(f, {
      menus: [
        { ...menus[0], trigger: "manual" },
        { ...menus[1], enabled: false },
      ],
    });
    await expect(activate()).rejects.toMatchObject({ status: 400 });
    await configure(f, { menus });
    expect(await activate()).toEqual({ enabled: true });
    const c = await say(f, "Preciso de ajuda", "5511910000011");
    expect((await latest(c.id)).text.startsWith(menuText)).toBe(true);
  });

  it("com bot habilitado para a linha a mensagem segue para o bot", async () => {
    const f = await fixture();
    const id = await bot(f);
    await configure(f, { menus, attendant_bot: id });
    const c = await say(f, "Preciso de ajuda", "5511910000010");
    expect(c.state).toBe("ai");
    expect((await texts(c.id)).some((t) => t.startsWith(menuText))).toBe(false);
  });
});
