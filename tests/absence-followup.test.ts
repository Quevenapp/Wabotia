import { env } from "cloudflare:test";
import { it, expect, describe, vi, afterEach } from "vitest";
import { exec, one, all } from "../src/db";
import { json, now, uid } from "../src/types";
import { conversation } from "../src/service";
import { processRun } from "../src/engine";
import { setSecret } from "../src/security";
import { zernioTyping } from "../src/zernio";
import {
  fixture,
  receive,
  configure,
  outbox,
  latest,
  drain,
  tickets,
  bot,
  type Fixture,
} from "./service-center-fixture";

afterEach(() => vi.unstubAllGlobals());

async function withBot() {
  const f = await fixture();
  const botId = await bot(f);
  await configure(f, { attendant_bot: botId });
  return { f, botId };
}
/** Customer asks for a person while nobody is present: the absence handoff. */
async function handedOff(f: Fixture, phone = "5511999998888") {
  await receive(f, f.line, "quero falar com um atendente", phone);
  await drain(f);
  const c = await one(
    env,
    "SELECT * FROM conversations WHERE profile_id=? AND phone=?",
    f.profile,
    phone,
  );
  expect(c.state).toBe("waiting");
  return conversation(env, c.id, f.profile);
}
const runs = (conversationId: string) =>
  all(
    env,
    "SELECT * FROM bot_runs WHERE conversation_id=? ORDER BY created,rowid",
    conversationId,
  );
/** Finishes a run with the given bot decision, as if Hermes had answered. */
async function finish(run: any, output: any) {
  await exec(
    env,
    "UPDATE bot_runs SET status='completed',result=? WHERE id=?",
    JSON.stringify(output),
    run.id,
  );
  await processRun(
    env,
    await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id),
  );
}
const present = (f: Fixture) =>
  exec(
    env,
    "INSERT INTO presence(profile_id,actor,present,updated) VALUES(?,?,1,?)",
    f.profile,
    f.member.id,
    now(),
  );

describe("protocolo com a equipe ausente", () => {
  it("abre o protocolo por padrão e não abre com a opção desligada", async () => {
    const on = await fixture();
    const c1 = await handedOff(on);
    expect(await tickets(c1.id)).toHaveLength(1);
    expect((await latest(c1.id)).text).toContain("Abrimos um protocolo");

    const off = await fixture();
    await configure(off, { absence_ticket: false });
    const c2 = await handedOff(off);
    expect(await tickets(c2.id)).toHaveLength(0);
    const text = (await latest(c2.id)).text;
    expect(text).toContain("ausente no momento");
    expect(text).not.toMatch(/protocolo/i);
  });
});

describe("autorização de notificações ao abrir protocolo", () => {
  const notifications = {
    enabled: true,
    template_name: "aviso",
    language: "pt_BR",
  };
  it("pergunta uma vez, com botões, e registra a resposta pelo botão", async () => {
    const f = await fixture();
    await configure(f, { notifications });
    const c = await handedOff(f);
    const sent = await outbox(c.id);
    const question = sent.at(-1);
    expect(sent.at(-2).text).toContain("Abrimos um protocolo");
    expect(question.text).toContain("AUTORIZO ou NÃO AUTORIZO");
    expect(
      question.content.interactive.action.buttons.map((b: any) => [
        b.reply.id,
        b.reply.title,
      ]),
    ).toEqual([
      ["wconsent:granted", "Autorizo"],
      ["wconsent:revoked", "Não autorizo"],
    ]);
    expect(
      await all(
        env,
        "SELECT status FROM consents WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual([{ status: "pending" }]);

    await receive(f, f.line, "", "5511999998888", {
      interactive_reply_id: "wconsent:granted",
    });
    await drain(f);
    expect(
      (
        await one(
          env,
          "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
          c.id,
        )
      ).status,
    ).toBe("granted");
    expect((await latest(c.id)).text).toBe("Autorização registrada.");
    // A resposta ao consentimento não vira acompanhamento nem nova pergunta.
    const count = (await outbox(c.id)).length;
    await receive(f, f.line, "PROTOCOLO");
    await drain(f);
    await receive(f, f.line, "meu aplicativo não abre");
    await drain(f);
    expect(await tickets(c.id)).toHaveLength(2);
    expect(
      (await outbox(c.id))
        .slice(count)
        .filter((p) => /AUTORIZO ou NÃO/.test(p.text)),
    ).toHaveLength(0);
  });
  it("não pergunta com as notificações desligadas nem com a opção desligada", async () => {
    const plain = await fixture();
    const c1 = await handedOff(plain);
    expect((await outbox(c1.id)).some((p) => /AUTORIZO/.test(p.text))).toBe(
      false,
    );
    const off = await fixture();
    await configure(off, { notifications, protocol_consent_prompt: false });
    const c2 = await handedOff(off);
    expect((await outbox(c2.id)).some((p) => /AUTORIZO/.test(p.text))).toBe(
      false,
    );
    expect(
      await all(env, "SELECT id FROM consents WHERE conversation_id=?", c2.id),
    ).toEqual([]);
  });
});

describe("acompanhamento pelo bot com a equipe ausente", () => {
  it("responde à pergunta do cliente sem tirar a conversa da fila", async () => {
    const { f, botId } = await withBot();
    const c = await handedOff(f);
    const [ticket] = await tickets(c.id);
    await receive(f, f.line, "Será que resolve rápido?");
    await drain(f);
    const [run] = await runs(c.id);
    expect(run.phase).toBe("attendant");
    const context = json(run.context);
    expect(context.followup).toBe(true);
    expect(context.sources[0].id).toBe("atendimento");
    expect(context.sources[0].text).toContain(ticket.number);

    await finish(run, {
      action: "answer",
      text: "Seu protocolo está em análise e a equipe responde dentro do prazo.",
      citations: ["atendimento"],
    });
    const answer = await latest(c.id);
    expect(answer.text).toContain("está em análise");
    const after = await conversation(env, c.id, f.profile);
    expect(after.state).toBe("waiting");
    expect(after.epoch).toBe(c.epoch);
    expect(await tickets(c.id)).toHaveLength(1);
    expect(
      (
        await one(
          env,
          "SELECT actor FROM outbox WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
          c.id,
        )
      ).actor,
    ).toBe("bot:" + botId);
  });
  it("troca qualquer outra decisão do bot por uma confirmação fixa, sem repetir", async () => {
    const { f } = await withBot();
    const c = await handedOff(f);
    const [ticket] = await tickets(c.id);
    for (const [text, decision] of [
      ["E agora?", { action: "human", text: "Vou transferir." }],
      ["Alô?", { action: "ticket", text: "abrir outro" }],
    ] as const) {
      await receive(f, f.line, text);
      await drain(f);
      await finish((await runs(c.id)).at(-1), decision);
    }
    const sent = (await outbox(c.id)).filter((p) =>
      p.text.startsWith("Recebemos sua mensagem"),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(ticket.number);
    const after = await conversation(env, c.id, f.profile);
    expect(after.state).toBe("waiting");
    expect(after.epoch).toBe(c.epoch);
    expect(await tickets(c.id)).toHaveLength(1);
  });
  it("fica em silêncio com alguém presente ou com a opção desligada", async () => {
    const a = await withBot();
    const c1 = await handedOff(a.f);
    await present(a.f);
    await receive(a.f, a.f.line, "Será que resolve rápido?");
    await drain(a.f);
    expect(await runs(c1.id)).toHaveLength(0);

    const b = await withBot();
    await configure(b.f, { absence_followup: false });
    const c2 = await handedOff(b.f);
    await receive(b.f, b.f.line, "Será que resolve rápido?");
    await drain(b.f);
    expect(await runs(c2.id)).toHaveLength(0);
  });
});

describe("indicador de digitando", () => {
  it("usa a rota de digitação da conversa Zernio conhecida", async () => {
    const f = await fixture();
    const account = "a".repeat(24);
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({
        account_id: account,
        zernio_profile_id: "b".repeat(24),
      }),
      f.line,
    );
    await setSecret(env, `connection:${f.line}`, {
      api_key: "test-only-key",
      webhook_secret: "test-only-secret",
    });
    const conn = await one(env, "SELECT * FROM connections WHERE id=?", f.line);
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      calls.push([String(input.url || input), init.method, init.body]);
      return Response.json({ success: true });
    });
    // Conversa ainda desconhecida: nada é enviado.
    expect(await zernioTyping(env, conn, "5511999998888")).toBe(false);
    expect(calls).toHaveLength(0);
    await exec(
      env,
      "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,?)",
      f.line,
      "5511999998888",
      "conv_123",
    );
    expect(await zernioTyping(env, conn, "5511999998888")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(
      "https://zernio.com/api/v1/inbox/conversations/conv_123/typing",
    );
    expect(calls[0][1]).toBe("POST");
    expect(JSON.parse(calls[0][2])).toEqual({ accountId: account });
  });
});
