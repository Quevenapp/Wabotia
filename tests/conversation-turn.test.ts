import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi, onConversationTurn } from "../src/modules/api";
import {
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const menus = [
  { id: "atendente", label: "Falar com atendente", type: "human" },
  { id: "info", label: "Horário", type: "content", content: "9h às 18h" },
];
// Estado do "módulo" de teste: conversas aguardando resposta de orçamento.
const waiting = new Set<string>();
const seen: any[] = [];
onConversationTurn("forms", async (ctx, c, turn) => {
  seen.push({ conversation: c.id, ...turn });
  const mine = turn.replyId?.startsWith("forms:");
  if (!mine && !(waiting.has(c.id) && /^[12]$/.test(turn.text))) return false;
  waiting.delete(c.id);
  const choice = turn.replyId
    ? turn.replyId.split(":")[1]
    : turn.text === "1"
      ? "aprovar"
      : "recusar";
  await ctx.sendMessage(
    c,
    { text: `Orçamento: ${choice}` },
    { key: `quote:${turn.rowId}` },
  );
  return true;
});

async function say(
  f: Fixture,
  text: string,
  phone: string,
  content: any = {},
  line = f.line,
) {
  const c = await receive(f, line, text, phone, content);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const quote = {
  type: "list" as const,
  body: "Orçamento #12: R$ 150,00",
  button: "Responder",
  sections: [
    {
      rows: [
        { id: "forms:aprovar:12", title: "Aprovar" },
        { id: "forms:recusar:12", title: "Recusar" },
      ],
    },
  ],
};

describe("onConversationTurn e ctx.sendInteractive", () => {
  it("botão do módulo é tratado antes do menu (nada de 'opção indisponível')", async () => {
    const f = await fixture();
    await configure(f, { menus });
    const c = await say(f, "Aprovar", "5511980000001", {
      interactive_reply_id: "forms:aprovar:12",
    });
    expect((await latest(c.id)).text).toBe("Orçamento: aprovar");
    expect(
      (await outbox(c.id)).some((m) =>
        String(m.text).includes("não está mais disponível"),
      ),
    ).toBe(false);
  });

  it("texto numerado com estado aberto vai ao módulo; sem estado segue o menu", async () => {
    const f = await fixture();
    await configure(f, { menus });
    let c = await say(f, "oi", "5511980000002");
    expect((await latest(c.id)).text).toContain("Falar com atendente");
    waiting.add(c.id);
    c = await say(f, "2", "5511980000002");
    expect((await latest(c.id)).text).toBe("Orçamento: recusar");
    // Estado encerrado: "2" volta a ser a opção do menu.
    c = await say(f, "oi", "5511980000002");
    c = await say(f, "2", "5511980000002");
    expect((await latest(c.id)).text).toContain("9h às 18h");
  });

  it("módulo desligado não recebe a mensagem", async () => {
    const f = await fixture();
    await configure(f, { menus });
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "forms", enabled: false },
      uid(),
    );
    const before = seen.length;
    await say(f, "oi", "5511980000003");
    expect(seen.length).toBe(before);
  });

  it("sendInteractive: lista na oficial, texto numerado no QR, notificação fora da janela", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "forms");
    const official = await say(f, "bom dia", "5511980000004");
    await ctx.sendInteractive(official, quote, { key: "quote-12" });
    const sent = await latest(official.id);
    expect(sent.content.interactive.type).toBe("list");
    expect(sent.content.interactive.action.sections[0].rows[0].id).toBe(
      "forms:aprovar:12",
    );
    // Mesma chave: não repete.
    await ctx.sendInteractive(official, quote, { key: "quote-12" });
    expect(
      (await outbox(official.id)).filter((m) => m.content?.interactive),
    ).toHaveLength(1);

    const qr = await say(f, "bom dia", "5511980000005", {}, f.qr);
    await ctx.sendInteractive(qr, quote, { key: "quote-12" });
    const text = await latest(qr.id);
    expect(text.content).toBeUndefined();
    expect(text.text).toContain("1. Aprovar");

    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 2 * 86400000,
      official.id,
    );
    const closed = await conversation(env, official.id, f.profile);
    const id = await ctx.sendInteractive(closed, quote, {
      key: "lembrete-12",
      notification: true,
    });
    const row = await one(
      env,
      "SELECT kind,payload FROM outbox WHERE id=?",
      id,
    );
    expect(row.kind).toBe("notification");
    expect(json(row.payload).text).toContain("1. Aprovar");
  });
});
