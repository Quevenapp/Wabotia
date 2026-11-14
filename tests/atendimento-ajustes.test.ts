import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, handoff, perform } from "../src/service";
import { botAllowsLine } from "../src/line-service";
import { documentText, searchKnowledge } from "../src/knowledge";
import { conversationalAnswer } from "../src/engine";
import { isOnlyProtocolNumber, protocolNumber } from "../src/protocol-lookup";
import { json, uid } from "../src/types";
import {
  bot,
  configure,
  drain,
  fixture,
  latest,
  receive,
  tickets,
  type Fixture,
} from "./service-center-fixture";

async function say(f: Fixture, text: string, phone: string) {
  const c = await receive(f, f.line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}

describe("número de protocolo digitado pelo cliente", () => {
  it("aceita minúsculas e espaços no meio de uma mensagem curta", () => {
    expect(protocolNumber("WA-mweq9z2z-a 185")).toBe("WA-MWEQ9Z2Z-A185");
    expect(protocolNumber(" wa-mweq9z2z-a185 ")).toBe("WA-MWEQ9Z2Z-A185");
    expect(isOnlyProtocolNumber("WA-mweq9z2z-a 185")).toBe(true);
    expect(protocolNumber("meu protocolo é WA-MWEQ9Z2Z-A185, ok?")).toBe(
      "WA-MWEQ9Z2Z-A185",
    );
    expect(isOnlyProtocolNumber("meu protocolo é WA-MWEQ9Z2Z-A185")).toBe(
      false,
    );
    expect(protocolNumber("preciso de ajuda com o pedido")).toBeUndefined();
  });

  it("número novo: só dígitos, com protocolo ou # na frente", () => {
    expect(protocolNumber("10001")).toBe("10001");
    expect(protocolNumber("protocolo 10.001")).toBe("10001");
    expect(protocolNumber("Protocolo: 10001")).toBe("10001");
    expect(protocolNumber("#10001")).toBe("10001");
    expect(isOnlyProtocolNumber("10 001")).toBe(true);
    // Menu options, phone numbers and numbers inside a sentence are not.
    expect(protocolNumber("2")).toBeUndefined();
    expect(protocolNumber("5511999990000")).toBeUndefined();
    expect(protocolNumber("o pedido 10001 atrasou")).toBeUndefined();
  });

  it("numera os protocolos em sequência, a partir de 10001", async () => {
    const f = await fixture();
    const first = await say(f, "quero falar com um atendente", "5511920000010");
    const second = await say(
      f,
      "quero falar com um atendente",
      "5511920000011",
    );
    const [a] = await tickets(first.id);
    const [b] = await tickets(second.id);
    expect(a.number).toMatch(/^\d{5,}$/);
    expect(Number(a.number)).toBeGreaterThanOrEqual(10001);
    expect(Number(b.number)).toBe(Number(a.number) + 1);
  });

  it("consulta o protocolo em vez de abrir outro", async () => {
    const f = await fixture();
    const phone = "5511920000001";
    const c = await say(f, "quero falar com um atendente", phone);
    const [ticket] = await tickets(c.id);
    expect(ticket).toBeTruthy();
    // Typed with a separator in the middle, as people do on the phone.
    await say(
      f,
      ticket.number.slice(0, 2) + " " + ticket.number.slice(2),
      phone,
    );
    expect(await tickets(c.id)).toHaveLength(1);
    expect((await latest(c.id)).text).toContain(ticket.number);
    expect((await latest(c.id)).automation).toBe("protocols");

    // Old numbers, typed as in the report: lower case and a space.
    await exec(
      env,
      "UPDATE tickets SET number='WA-MWEQ9Z2Z-A185' WHERE id=?",
      ticket.id,
    );
    await say(f, "WA-mweq9z2z-a 185", phone);
    expect(await tickets(c.id)).toHaveLength(1);
    expect((await latest(c.id)).text).toContain("WA-MWEQ9Z2Z-A185");
  });

  it("dígitos que não são protocolo do cliente seguem o atendimento", async () => {
    const f = await fixture();
    const c = await say(f, "55555", "5511920000012");
    const sent = await latest(c.id);
    expect(sent?.automation).not.toBe("protocols");
  });
});

describe("equipe ausente: devolver a conversa ao bot", () => {
  it("abre o protocolo e a conversa volta ao bot, fora da fila", async () => {
    const f = await fixture();
    const attendant = await bot(f);
    await configure(f, {
      attendant_bot: attendant,
      absence_return_to_bot: true,
    });
    let c = await say(f, "oi", "5511920000013");
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
    c = await conversation(env, c.id, f.profile);
    await handoff(env, c, "Cliente solicitou atendimento humano.");
    c = await conversation(env, c.id, f.profile);
    expect(c.state).toBe("ai");
    expect(await tickets(c.id)).toHaveLength(1);
    expect((await latest(c.id)).text).toContain("sigo por aqui");

    // A failure of the bot itself keeps the conversation in the queue.
    await handoff(env, c, "Falha do bot.", null, null, false);
    expect((await conversation(env, c.id, f.profile)).state).toBe("waiting");
    expect(await tickets(c.id)).toHaveLength(1);
  });

  it("desligado, ou sem bot que possa atender, a conversa fica na fila", async () => {
    const f = await fixture();
    const attendant = await bot(f);
    await configure(f, { attendant_bot: attendant });
    let c = await say(f, "oi", "5511920000014");
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
    await handoff(
      env,
      await conversation(env, c.id, f.profile),
      "Cliente solicitou atendimento humano.",
    );
    expect((await conversation(env, c.id, f.profile)).state).toBe("waiting");

    await configure(f, { absence_return_to_bot: true });
    await exec(
      env,
      "UPDATE connections SET status='paused' WHERE id=(SELECT connection_id FROM bots WHERE id=?)",
      attendant,
    );
    const other = await say(f, "oi", "5511920000015");
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", other.id);
    await handoff(
      env,
      await conversation(env, other.id, f.profile),
      "Cliente solicitou atendimento humano.",
    );
    expect((await conversation(env, other.id, f.profile)).state).toBe(
      "waiting",
    );
  });
});

describe("bot indisponível e protocolo de ausência", () => {
  it("bot com conexão pausada não atende nem dá nome ao protocolo", async () => {
    const f = await fixture();
    const attendant = await bot(f);
    await configure(f, { attendant_bot: attendant });
    const owner = (
      await one(env, "SELECT connection_id FROM bots WHERE id=?", attendant)
    ).connection_id;
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", owner);
    expect(await botAllowsLine(env, attendant, f.profile, f.line)).toBe(false);
    expect(await botAllowsLine(env, attendant, f.profile, f.line, false)).toBe(
      true,
    );

    const c = await say(f, "Preciso da segunda via do boleto", "5511920000002");
    expect(
      await all(env, "SELECT id FROM bot_runs WHERE conversation_id=?", c.id),
    ).toHaveLength(0);
    expect(c.state).toBe("waiting");
    const [ticket] = await tickets(c.id);
    expect(ticket.title).toBe("Preciso da segunda via do boleto");
  });

  it("o resumo do bot dá nome ao protocolo; o motivo interno, não", async () => {
    const f = await fixture();
    let c = await say(f, "oi", "5511920000003");
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
    c = await conversation(env, c.id, f.profile);
    const summary =
      "Cliente quer cancelar o plano mensal e pediu o reembolso da última cobrança, feita em 10/11.";
    await handoff(
      env,
      c,
      "Conexão com o provedor de IA pausada.",
      null,
      summary,
    );
    const [ticket] = await tickets(c.id);
    expect(ticket.title).toBe(summary);
    expect(ticket.title).not.toContain("provedor");

    // A later request goes into the open protocol as an internal note.
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
    const again =
      "Cliente usa iPhone e recebe erro 400 ao abrir o app desde ontem.";
    for (let i = 0; i < 2; i++) {
      await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
      await handoff(
        env,
        await conversation(env, c.id, f.profile),
        "Bot transferiu para a equipe humana.",
        null,
        again,
      );
    }
    expect(await tickets(c.id)).toHaveLength(1);
    const notes = await all(
      env,
      "SELECT text,internal FROM ticket_updates WHERE ticket_id=?",
      ticket.id,
    );
    expect(notes).toEqual([
      { text: `Nova solicitação nesta conversa: ${again}`, internal: 1 },
    ]);

    // Without a summary, the customer's last message names it.
    const other = await say(f, "Meu pedido 4411 não chegou", "5511920000004");
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", other.id);
    await handoff(
      env,
      await conversation(env, other.id, f.profile),
      "Resposta automática sem fundamentação suficiente.",
      null,
      null,
    );
    const titles = (await tickets(other.id)).map((t: any) => t.title);
    expect(titles.at(-1)).toBe("Meu pedido 4411 não chegou");
  });
});

describe("cumprimento e fila", () => {
  it("resposta sem fonte a um cumprimento não vai para a equipe", () => {
    const answer = { action: "answer", text: "Olá! Como posso ajudar?" };
    expect(conversationalAnswer({ ...answer, citations: [] }, "Olá")).toBe(
      true,
    );
    expect(conversationalAnswer(answer, "Bom dia!! tudo bem?")).toBe(true);
    expect(conversationalAnswer(answer, "obrigada")).toBe(true);
    // A real question still needs a source.
    expect(
      conversationalAnswer(answer, "Olá, qual o preço do plano anual?"),
    ).toBe(false);
    expect(conversationalAnswer({ ...answer, action: "human" }, "Olá")).toBe(
      false,
    );
  });

  it("tempo de espera desligado não mostra estimativa", async () => {
    const f = await fixture();
    const run = (op: string, data: any) =>
      perform(env, f.admin, f.profile, op, data, uid());
    const queue = await run("queue.save", {
      name: "Geral",
      wait_mode: "off",
      service_minutes: 10,
    });
    expect(queue.wait_mode).toBe("off");
    const counter = await run("counter.save", {
      name: "Guichê 1",
      queue_ids: [queue.id],
    });
    await perform(
      env,
      f.member,
      f.profile,
      "counter.state",
      { id: counter.id, status: "open" },
      uid(),
    );
    const issue = () =>
      run("queue.issue", {
        queue_id: queue.id,
        preferential: false,
        source: "staff",
      });
    await issue();
    const hidden = await issue();
    expect(hidden.ahead).toBe(1);
    expect(hidden.wait_minutes).toBeNull();

    // Back on: the mode kept underneath is used again.
    const again = await run("queue.save", { id: queue.id, wait_mode: "fixed" });
    expect(again.wait_mode).toBe("fixed");
    expect((await issue()).wait_minutes).toBe(20);
    // Saving other fields keeps "off" when it is on.
    await run("queue.save", { id: queue.id, wait_mode: "off" });
    expect(
      (await run("queue.save", { id: queue.id, name: "Caixa" })).wait_mode,
    ).toBe("off");
  });
});

describe("bots e conhecimento", () => {
  it("renomeia o bot e guarda o nome na conexão", async () => {
    const f = await fixture();
    const id = await bot(f, true, "default");
    await perform(
      env,
      f.admin,
      f.profile,
      "bot.update",
      { id, name: " Bia " },
      uid(),
    );
    const row = await one(
      env,
      "SELECT b.name,c.config FROM bots b JOIN connections c ON c.id=b.connection_id WHERE b.id=?",
      id,
    );
    expect(row.name).toBe("Bia");
    expect(json(row.config).bot_names).toEqual({ default: "Bia" });
    await expect(
      perform(env, f.admin, f.profile, "bot.update", { id, name: "  " }, uid()),
    ).rejects.toThrow("nome do bot");
  });

  it("edita o texto e a orientação de uso de uma fonte", async () => {
    const f = await fixture();
    const original = "Horário de atendimento: segunda a sexta. ".repeat(80);
    const { id } = await perform(
      env,
      f.admin,
      f.profile,
      "knowledge.create",
      { title: "Horários", kind: "text", text: original },
      uid(),
    );
    // Saved trimmed, then rebuilt from overlapping passages without repeats.
    expect(await documentText(env, f.profile, id)).toBe(original.trim());

    const changed = "Plantão de feriados: das 8h às 12h, só por WhatsApp.";
    await perform(
      env,
      f.admin,
      f.profile,
      "knowledge.update",
      {
        id,
        title: "Plantão",
        text: changed,
        usage: "Use só quando o cliente perguntar de feriados.",
      },
      uid(),
    );
    expect(await documentText(env, f.profile, id)).toBe(changed);
    const doc = await one(env, "SELECT * FROM documents WHERE id=?", id);
    expect(doc).toMatchObject({ title: "Plantão", status: "ready" });
    const [source] = await searchKnowledge(env, f.profile, ["feriados"]);
    expect(source).toMatchObject({
      document_id: id,
      title: "Plantão",
      usage: "Use só quando o cliente perguntar de feriados.",
    });
    expect(await searchKnowledge(env, f.profile, ["segunda"])).toHaveLength(0);
  });
});
