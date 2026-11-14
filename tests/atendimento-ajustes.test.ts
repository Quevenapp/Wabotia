import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, handoff, perform } from "../src/service";
import { botAllowsLine } from "../src/line-service";
import { documentText, searchKnowledge } from "../src/knowledge";
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

  it("consulta o protocolo em vez de abrir outro", async () => {
    const f = await fixture();
    const phone = "5511920000001";
    const c = await say(f, "quero falar com um atendente", phone);
    const [ticket] = await tickets(c.id);
    expect(ticket).toBeTruthy();
    // Typed as in the report: lower case and a space before the last part.
    const typed =
      ticket.number.slice(0, -3).toLowerCase() + " " + ticket.number.slice(-3);
    await say(f, typed, phone);
    expect(await tickets(c.id)).toHaveLength(1);
    expect((await latest(c.id)).text).toContain(ticket.number);
    expect((await latest(c.id)).automation).toBe("protocols");
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
