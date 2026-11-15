import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation } from "../src/service";
import { json, now, type Conversation } from "../src/types";
import {
  agendaTurn,
  loadState,
  PAGE_SIZE,
  startBooking,
  startMine,
} from "../src/modules/agenda/chat";
import {
  configure,
  drain,
  latest,
  outbox,
  receive,
} from "./service-center-fixture";
import { agendaSetup, at, future, type AgendaSetup } from "./agenda-fixture";

const ORIGIN = "https://agenda.example.com";
const menus = [
  { id: "agendar", label: "Agendar horário", type: "agenda" },
  { id: "meus", label: "Meus agendamentos", type: "agenda_mine" },
  { id: "humano", label: "Falar com atendente", type: "human" },
];

async function setup() {
  const s = await agendaSetup();
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)",
    ORIGIN,
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900002222" }),
    s.f.line,
    s.f.qr,
  );
  await configure(s.f, { menus });
  return s;
}
async function say(s: AgendaSetup, text: string, phone: string, line: string) {
  const c = await receive(s.f, line, text, phone);
  await drain(s.f);
  return conversation(env, c.id, s.f.profile);
}
const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;
const submit = (code: string, body: Record<string, string>) =>
  SELF.fetch(`https://test/api/w/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://test",
    },
    body: new URLSearchParams(body).toString(),
  });
const appointments = (s: AgendaSetup) =>
  all(
    env,
    "SELECT * FROM agenda_appointments WHERE profile_id=? ORDER BY starts",
    s.f.profile,
  );

describe("agenda no WhatsApp: módulo desligado", () => {
  it("o item some do menu e volta ao religar", async () => {
    const s = await setup();
    const phone = "5511970000001";
    let c = await say(s, "oi", phone, s.f.qr);
    expect((await latest(c.id)).text).toContain("Agendar horário");
    await s.run("module.set", { id: "agenda", enabled: false });
    c = await say(s, "menu", phone, s.f.qr);
    const text = (await latest(c.id)).text;
    expect(text).not.toContain("Agendar horário");
    expect(text).not.toContain("Meus agendamentos");
    expect(text).toContain("Falar com atendente");
    await s.run("module.set", { id: "agenda", enabled: true });
    c = await say(s, "menu", phone, s.f.qr);
    expect((await latest(c.id)).text).toContain("1. Agendar horário");
  });
});

describe("agenda no WhatsApp pela conversa, pelo motor de ponta a ponta", () => {
  // Mensagens reais pelo processInbox: o núcleo entrega cada resposta à
  // Agenda pelo gancho onConversationTurn.
  it("linha QR: oi → menu → serviço → profissional → dia → horário → confirmar", async () => {
    const s = await setup();
    const phone = "5511970000010";
    const qr = s.f.qr;
    await say(s, "oi", phone, qr);
    let c = await say(s, "1", phone, qr);
    expect((await latest(c.id)).text).toContain("Qual serviço você quer?");
    c = await say(s, "2", phone, qr);
    expect((await latest(c.id)).text).toContain("Com quem você quer Corte?");
    c = await say(s, "Ana", phone, qr);
    const day = future(3);
    const days = (await loadState(s.ctx, c.id))!.data.options!;
    c = await say(
      s,
      String(days.findIndex((d) => d.id === day) + 1),
      phone,
      qr,
    );
    expect((await latest(c.id)).text).toContain("Horários livres em");
    c = await say(s, "08:30", phone, qr);
    expect((await latest(c.id)).text).toContain("Confirma Corte com Ana");
    c = await say(s, "1", phone, qr);
    expect((await latest(c.id)).text).toContain("Agendado! Corte com Ana");
    const [booked] = (await appointments(s)).filter(
      (a) => a.conversation_id === c.id,
    );
    expect(booked).toMatchObject({
      starts: at(day, "08:30"),
      source: "whatsapp",
      status: "booked",
    });
    // Sem pergunta aberta, "1" volta a ser o menu (Agendar horário).
    c = await say(s, "menu", phone, qr);
    c = await say(s, "2", phone, qr);
    expect((await latest(c.id)).text).toContain("Seus agendamentos:");
    c = await say(s, "MENU", phone, qr);
    expect((await latest(c.id)).text).toContain("1. Agendar horário");
  });

  it("linha oficial: toques em lista e botões chegam com o replyId", async () => {
    const s = await setup();
    const phone = "5511970000011";
    const line = s.f.line;
    const tap = async (row: any) => {
      const c = await receive(s.f, line, row.title, phone, {
        interactive_reply_id: row.id,
      });
      await drain(s.f);
      return conversation(env, c.id, s.f.profile);
    };
    await say(s, "oi", phone, line);
    let c = await say(s, "1", phone, line);
    let sent = await latest(c.id);
    expect(sent.content.interactive.type).toBe("button");
    const services = sent.content.interactive.action.buttons.map(
      (b: any) => b.reply,
    );
    c = await tap(services.find((b: any) => b.title === "Corte"));
    sent = await latest(c.id);
    c = await tap(
      sent.content.interactive.action.buttons.map((b: any) => b.reply)[0],
    );
    sent = await latest(c.id);
    expect(sent.content.interactive.type).toBe("list");
    const day = future(4);
    c = await tap(
      sent.content.interactive.action.sections[0].rows.find((r: any) =>
        r.id.endsWith(":" + day),
      ),
    );
    sent = await latest(c.id);
    c = await tap(
      sent.content.interactive.action.sections[0].rows.find(
        (r: any) => r.title === "10:00",
      ),
    );
    sent = await latest(c.id);
    c = await tap(sent.content.interactive.action.buttons[0].reply);
    expect((await latest(c.id)).text).toContain("Agendado! Corte com");
    expect(
      (await appointments(s)).filter((a) => a.conversation_id === c.id),
    ).toHaveLength(1);
  });
});

describe("agenda no WhatsApp pela página do link (web_page)", () => {
  it("menu → serviço, profissional e dia → horário → agendado; depois cancela", async () => {
    const s = await setup();
    await configure(s.f, { agenda: { web_page: true } });
    const phone = "5511970000002";
    const day = future(3);
    await say(s, "oi", phone, s.f.line);
    let c = await say(s, "1", phone, s.f.line);
    let sent = await latest(c.id);
    // Linha oficial: botão com URL para a página.
    expect(sent.content.interactive.action.parameters.display_text).toBe(
      "Escolher dia",
    );
    let code = codeIn(sent.text);
    const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    expect(page).toContain("Corte (30 min, R$ 50,00)");
    expect(page).toContain("Qualquer um");
    // A Bia não faz barba: o módulo pede de novo.
    let done = await submit(code, {
      f_servico: "Barba (60 min)",
      f_profissional: "Bia",
      f_dia: day,
    });
    expect(done.status).toBe(200);
    sent = await latest(c.id);
    expect(sent.text).toContain("Bia não atende Barba");
    code = codeIn(sent.text);
    done = await submit(code, {
      f_servico: "Corte (30 min, R$ 50,00)",
      f_profissional: "Ana",
      f_dia: day,
    });
    expect(done.status).toBe(200);
    sent = await latest(c.id);
    expect(sent.text).toContain("20 horários livres");
    const timeCode = codeIn(sent.text);
    const timePage = await (
      await SELF.fetch(`https://test/api/w/${timeCode}`)
    ).text();
    expect(timePage).toContain("Mostrando os 19 primeiros");
    expect(timePage).toContain("Escolher outro dia");

    // Alguém ocupa 09:00 com a Ana antes de o cliente enviar.
    await s.run("agenda.book", {
      service_id: s.corte.id,
      professional_id: s.ana.id,
      starts: at(day, "09:00"),
      customer_name: "Outra",
    });
    done = await submit(timeCode, { f_horario: "09:00" });
    expect(done.status).toBe(200);
    const texts = (await outbox(c.id)).map((m) => m.text);
    expect(texts).toContain("Esse horário acabou de ser ocupado.");
    const retry = codeIn((await latest(c.id)).text);
    done = await submit(retry, { f_horario: "10:30" });
    expect(done.status).toBe(200);
    const booked = (await appointments(s)).find(
      (a) => a.conversation_id === c.id,
    );
    expect(booked).toMatchObject({
      professional_id: s.ana.id,
      starts: at(day, "10:30"),
      source: "whatsapp",
      customer_phone: phone,
      status: "booked",
    });
    expect((await latest(c.id)).text).toContain("Agendado! Corte com Ana");

    // Meus agendamentos → cancelar.
    c = await say(s, "menu", phone, s.f.line);
    c = await say(s, "2", phone, s.f.line);
    sent = await latest(c.id);
    expect(sent.text).toContain("Você tem 1 agendamento");
    done = await submit(codeIn(sent.text), { f_acao: "Cancelar" });
    expect(done.status).toBe(200);
    expect(
      (
        await one(
          env,
          "SELECT status FROM agenda_appointments WHERE id=?",
          booked.id,
        )
      ).status,
    ).toBe("cancelled");
    expect((await latest(c.id)).text).toContain("foi cancelado");
  });
});

describe("agenda no WhatsApp pela conversa (com o gancho de turno)", () => {
  // O núcleo ainda não chama agendaTurn sozinho: o teste faz o papel do
  // gancho onConversationTurn, entregando cada resposta do cliente.
  let row = 0;
  async function reply(
    s: AgendaSetup,
    c: Conversation,
    text: string,
    replyId?: string,
  ) {
    const handled = await agendaTurn(s.ctx, c, {
      text,
      replyId,
      rowId: `row-${++row}`,
    });
    return { handled, sent: await latest(c.id) };
  }
  const state = (s: AgendaSetup, c: Conversation) => loadState(s.ctx, c.id);

  it("linha QR: texto numerado, páginas, confirmação e conflito na hora de confirmar", async () => {
    const s = await setup();
    const c = await say(s, "bom dia", "5511970000003", s.f.qr);
    await startBooking(s.ctx, c, { key: "menu:x1" });
    let sent = await latest(c.id);
    expect(sent.content).toBeUndefined();
    expect(sent.text).toContain("Qual serviço você quer?");
    expect(sent.text).toContain("1. Barba - 60 min");
    expect(sent.text).toContain("2. Corte - 30 min · R$ 50,00");
    // Resposta pelo nome; depois "qualquer um".
    ({ sent } = await reply(s, c, "corte"));
    expect(sent.text).toContain("Com quem você quer Corte?");
    expect(sent.text).toContain("1. Qualquer um");
    ({ sent } = await reply(s, c, "1"));
    expect(sent.text).toContain("Qual dia para Corte?");
    const days = (await state(s, c))!.data.options!;
    expect(days).toHaveLength(PAGE_SIZE + 1);
    expect(days.at(-1)!.id).toBe("more");
    const day = future(2);
    const index = days.findIndex((d) => d.id === day);
    expect(index).toBeGreaterThanOrEqual(0);
    ({ sent } = await reply(s, c, String(index + 1)));
    // 20 horários: página 1 com 9 e "Mais opções".
    expect(sent.text).toContain("1. 08:00");
    expect(sent.text).toContain("10. Mais opções - Mais 11");
    ({ sent } = await reply(s, c, "10"));
    expect(sent.text).toContain("1. 12:30");
    ({ sent } = await reply(s, c, "abc"));
    expect(sent.text).toContain("Não entendi");
    ({ sent } = await reply(s, c, "12:30"));
    expect(sent.text).toContain("Confirma Corte");
    expect(sent.text).toContain("às 12:30? Valor: R$ 50,00.");

    // Enquanto o cliente pensa, Ana e Bia ficam ocupadas às 12:30.
    for (const p of [s.ana, s.bia])
      await s.run("agenda.book", {
        service_id: s.corte.id,
        professional_id: p.id,
        starts: at(day, "12:30"),
        customer_name: "Outro",
      });
    ({ sent } = await reply(s, c, "1"));
    expect(sent.text).toContain("Esse horário acabou de ser ocupado.");
    expect(sent.text).not.toContain("12:30");
    ({ sent } = await reply(s, c, "Mais opções"));
    expect(sent.text).toContain("1. 13:00");
    ({ sent } = await reply(s, c, "13:00"));
    const { handled, sent: last } = await reply(s, c, "Confirmar");
    expect(handled).toBe(true);
    expect(last.text).toContain("Agendado! Corte com");
    expect(last.text).toContain("às 13:00");
    expect(await state(s, c)).toBeNull();
    const mine = (await appointments(s)).filter(
      (a) => a.conversation_id === c.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      source: "whatsapp",
      starts: at(day, "13:00"),
    });

    // Sem pergunta aberta, a Agenda não pega a mensagem.
    expect((await reply(s, c, "1")).handled).toBe(false);
  });

  it("linha oficial: lista e botões, toque antigo, MENU sai, remarcar e cancelar", async () => {
    const s = await setup();
    const c = await say(s, "bom dia", "5511970000004", s.f.line);
    await startBooking(s.ctx, c, { key: "menu:y1", serviceId: s.corte.id });
    let sent = await latest(c.id);
    // Serviço fixo no item de menu: começa no profissional, com botões.
    expect(sent.content.interactive.type).toBe("button");
    const first = await state(s, c);
    const ids = sent.content.interactive.action.buttons.map(
      (b: any) => b.reply.id,
    );
    expect(ids[0]).toBe(`agenda:${first!.token}:any`);
    ({ sent } = await reply(s, c, "Ana", ids[1]));
    expect(sent.content.interactive.type).toBe("list");
    const rows = sent.content.interactive.action.sections[0].rows;
    expect(rows).toHaveLength(10);
    // Toque numa mensagem anterior.
    ({ sent } = await reply(s, c, "Qualquer um", ids[0]));
    expect(sent.text).toContain("mensagem anterior");
    const day = future(2);
    const dayRow = rows.find((r: any) => r.id.endsWith(":" + day));
    ({ sent } = await reply(s, c, dayRow.title, dayRow.id));
    const nine = sent.content.interactive.action.sections[0].rows.find(
      (r: any) => r.title === "09:00",
    );
    ({ sent } = await reply(s, c, "09:00", nine.id));
    expect(sent.content.interactive.type).toBe("button");
    const yes = sent.content.interactive.action.buttons[0];
    expect(yes.reply.title).toBe("Confirmar");
    ({ sent } = await reply(s, c, "Confirmar", yes.reply.id));
    expect(sent.text).toContain("Agendado! Corte com Ana");
    const [booked] = (await appointments(s)).filter(
      (a) => a.conversation_id === c.id,
    );

    // MENU numa pergunta aberta: a Agenda sai e deixa o menu com o núcleo.
    await startMine(s.ctx, c, { key: "menu:y2" });
    expect((await reply(s, c, "MENU")).handled).toBe(false);
    expect(await state(s, c)).toBeNull();

    // Meus agendamentos → remarcar para 15:00 com qualquer um.
    await startMine(s.ctx, c, { key: "menu:y3" });
    sent = await latest(c.id);
    expect(sent.text).toContain("Seus agendamentos:");
    ({ sent } = await reply(s, c, "1"));
    expect(sent.text).toContain("O que você quer fazer?");
    ({ sent } = await reply(s, c, "Remarcar"));
    ({ sent } = await reply(s, c, "Qualquer um"));
    const days = (await state(s, c))!.data.options!;
    ({ sent } = await reply(
      s,
      c,
      String(days.findIndex((d) => d.id === day) + 1),
    ));
    const slots = (await state(s, c))!.data.options!;
    ({ sent } = await reply(s, c, "Mais opções"));
    ({ sent } = await reply(s, c, "15:00"));
    expect(sent.text).toContain("Remarcar para Corte");
    ({ sent } = await reply(s, c, "1"));
    expect(sent.text).toContain("Remarcado!");
    expect(slots.length).toBe(10);
    const moved = await one(
      env,
      "SELECT * FROM agenda_appointments WHERE id=?",
      booked.id,
    );
    expect(moved).toMatchObject({
      starts: at(day, "15:00"),
      moves: 1,
      status: "booked",
    });

    // Cancelar pelo chat.
    await startMine(s.ctx, c, { key: "menu:y4" });
    await reply(s, c, "1");
    ({ sent } = await reply(s, c, "Cancelar horário"));
    expect(sent.text).toContain("foi cancelado");
    expect(
      (
        await one(
          env,
          "SELECT status FROM agenda_appointments WHERE id=?",
          booked.id,
        )
      ).status,
    ).toBe("cancelled");
    const kinds = (
      await all(
        env,
        "SELECT kind,payload FROM events WHERE profile_id=? AND kind LIKE 'agenda.%' ORDER BY id",
        s.f.profile,
      )
    ).map((e) => [e.kind, json(e.payload).actor]);
    expect(kinds).toEqual([
      ["agenda.booked", "customer"],
      ["agenda.rescheduled", "customer"],
      ["agenda.cancelled", "customer"],
    ]);
  });

  it("prazo para mudar e conversa em grupo", async () => {
    const s = await setup();
    await configure(s.f, { agenda: { customer_change_hours: 48 } });
    const c = await say(s, "bom dia", "5511970000005", s.f.qr);
    const day = future(1);
    await s.run("agenda.book", {
      service_id: s.corte.id,
      professional_id: s.ana.id,
      starts: at(day, "16:00"),
      conversation_id: c.id,
    });
    await startMine(s.ctx, c, { key: "menu:z1" });
    const { sent } = await reply(s, c, "1");
    expect(sent.text).toContain("Faltam menos de 48 horas");
    expect(
      await agendaTurn(
        s.ctx,
        { ...c, chat_type: "group" },
        { text: "1", rowId: "g" },
      ),
    ).toBe(false);
  });
});
