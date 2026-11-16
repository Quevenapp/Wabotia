import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadState } from "../src/modules/reserva/chat";
import { atClock, shortDay } from "../src/modules/reserva/config";
import { latest } from "./service-center-fixture";
import {
  bookings,
  chatSetup,
  future,
  pick,
  qrToSummary,
  say,
  tap,
} from "./reserva-fixture";
describe("reserva no WhatsApp: módulo desligado", () => {
  it("os itens somem do menu e voltam ao religar", async () => {
    const s = await chatSetup();
    const phone = "5511971000001";
    let c = await say(s, "oi", phone, s.f.qr);
    expect((await latest(c.id)).text).toContain("Fazer reserva");
    await s.run("module.set", { id: "reserva", enabled: false });
    c = await say(s, "menu", phone, s.f.qr);
    const text = (await latest(c.id)).text;
    expect(text).not.toContain("Fazer reserva");
    expect(text).not.toContain("Minhas reservas");
    expect(text).toContain("Falar com atendente");
    await s.run("module.set", { id: "reserva", enabled: true });
    c = await say(s, "menu", phone, s.f.qr);
    expect((await latest(c.id)).text).toContain("1. Fazer reserva");
  });
});

describe("reserva no WhatsApp de ponta a ponta", () => {
  it("linha QR: menu → unidade → entrada → diárias → pessoas → resumo → confirmar", async () => {
    const s = await chatSetup({
      cancellation_policy: "Grátis até 7 dias antes.",
    });
    const phone = "5511971000010";
    const start = future(6);
    let c = await qrToSummary(s, phone, start);
    const summary = (await latest(c.id)).text;
    expect(summary).toContain("Resumo da reserva:");
    expect(summary).toContain(`Entrada: ${shortDay(start)} às 14:00`);
    expect(summary).toContain("2 diárias · 2 pessoas");
    expect(summary).toContain("Total: R$ 600,00");
    expect(summary).toContain("Cancelamento: Grátis até 7 dias antes.");
    expect(summary).not.toContain("Sinal");
    c = await say(s, "1", phone, s.f.qr);
    expect((await latest(c.id)).text).toContain("Reserva #1 confirmada!");
    const [booked] = await bookings(s);
    expect(booked).toMatchObject({
      unit_id: s.mar.id,
      starts: atClock(start, "00:00"),
      arrival_at: atClock(start, "14:00"),
      guests: 2,
      status: "confirmed",
      source: "whatsapp",
      conversation_id: c.id,
      customer_phone: phone,
      price_cents: 60000,
    });
    // Sem pergunta aberta, "1" volta a ser o menu.
    c = await say(s, "menu", phone, s.f.qr);
    expect((await latest(c.id)).text).toContain("1. Fazer reserva");
  });

  it("data digitada, entrada ocupada e 'Mudar datas'", async () => {
    const s = await chatSetup();
    await s.run("reserva.book", {
      unit_id: s.mar.id,
      start_date: future(20),
      end_date: future(22),
      customer_name: "Ocupado",
    });
    const phone = "5511971000011";
    const qr = s.f.qr;
    await say(s, "oi", phone, qr);
    let c = await say(s, "1", phone, qr);
    c = await say(s, await pick(s, c.id, s.mar.id), phone, qr);
    const [y, m, d] = future(21).split("-");
    c = await say(s, `${d}/${m}/${y}`, phone, qr);
    expect((await latest(c.id)).text).toContain(
      "Essa unidade já está reservada nesse período.",
    );
    const [y2, m2, d2] = future(22).split("-");
    c = await say(s, `${d2}/${m2}`, phone, qr);
    expect((await latest(c.id)).text).toContain("Quantas diárias");
    c = await say(s, "1", phone, qr);
    c = await say(s, "1", phone, qr);
    expect((await latest(c.id)).text).toContain("Resumo da reserva:");
    c = await say(s, "2", phone, qr);
    expect((await latest(c.id)).text).toContain("Qual a data de entrada");
    c = await say(s, "MENU", phone, qr);
    expect((await latest(c.id)).text).toContain("1. Fazer reserva");
    expect(await loadState(s.ctx, c.id)).toBe(null);
    expect(y2).toBeTruthy();
  });

  it("linha oficial: quadra por hora com lista e botões tocados", async () => {
    const s = await chatSetup({ min_hours: 1, max_hours: 2 });
    const phone = "5511971000012";
    const day = future(3);
    let c = await say(s, "oi", phone, s.f.line);
    let out = await latest(c.id);
    const menuRow =
      out.content.interactive.action.sections?.[0].rows[0] ||
      out.content.interactive.action.buttons[0].reply;
    c = await tap(s, menuRow, phone);
    out = await latest(c.id);
    expect(out.content.interactive.type).toBe("list");
    const unitRow = out.content.interactive.action.sections[0].rows.find(
      (r: any) => r.title === "Quadra de areia",
    );
    expect(unitRow.id).toMatch(/^reserva:/);
    c = await tap(s, unitRow, phone);
    out = await latest(c.id);
    expect(out.text).toContain("Qual dia para Quadra de areia?");
    const dayRow = out.content.interactive.action.sections[0].rows.find(
      (r: any) => r.title === shortDay(day),
    );
    c = await tap(s, dayRow, phone);
    out = await latest(c.id);
    expect(out.text).toContain("Por quanto tempo");
    // Duas opções curtas com descrição: lista.
    const twoHours = out.content.interactive.action.sections[0].rows[1];
    expect(twoHours.title).toBe("2 horas");
    c = await tap(s, twoHours, phone);
    out = await latest(c.id);
    expect(out.text).toContain("Horários livres em");
    const six = out.content.interactive.action.sections[0].rows.find(
      (r: any) => r.title === "14:00",
    );
    expect(six.description).toContain("até 16:00");
    c = await tap(s, six, phone);
    out = await latest(c.id);
    expect(out.text).toContain("Quantas pessoas? Digite o número (até 12).");
    c = await say(s, "10", phone, s.f.line);
    out = await latest(c.id);
    expect(out.text).toContain("das 14:00 às 16:00 · 10 pessoas");
    expect(out.text).toContain("Total: R$ 160,00");
    expect(out.content.interactive.type).toBe("button");
    const confirm = out.content.interactive.action.buttons[0].reply;
    expect(confirm.title).toBe("Confirmar");
    // Toque numa mensagem antiga é recusado sem sair do fluxo.
    c = await tap(s, six, phone);
    expect((await latest(c.id)).text).toContain("mensagem anterior");
    c = await tap(s, confirm, phone);
    expect((await latest(c.id)).text).toContain("Reserva #1 confirmada!");
    const [booked] = await bookings(s);
    expect(booked).toMatchObject({
      unit_id: s.quadra.id,
      starts: atClock(day, "14:00"),
      ends: atClock(day, "16:00"),
      guests: 10,
      price_cents: 16000,
    });
  });

  it("dois clientes escolhem as mesmas datas: o segundo recebe outras", async () => {
    const s = await chatSetup();
    // Na primeira página (9 datas) a qualquer hora: antes do horário de
    // entrada a lista começa hoje, depois começa amanhã.
    const start = future(7);
    const a = await qrToSummary(s, "5511971000021", start);
    const b = await qrToSummary(s, "5511971000022", start);
    let ca = await say(s, "1", "5511971000021", s.f.qr);
    expect((await latest(ca.id)).text).toContain("Reserva #1 confirmada!");
    let cb = await say(s, "1", "5511971000022", s.f.qr);
    expect((await latest(cb.id)).text).toContain(
      "Essas datas acabaram de ser reservadas.",
    );
    expect((await loadState(s.ctx, cb.id))!.step).toBe("date");
    expect(await bookings(s)).toHaveLength(1);
    expect(a.id).not.toBe(b.id);
  });

  it("Minhas reservas: ver e cancelar dentro da política; fora dela, só a equipe", async () => {
    const s = await chatSetup({ customer_cancel_hours: 72 });
    const phone = "5511971000030";
    const qr = s.f.qr;
    let c = await qrToSummary(s, phone, future(5));
    c = await say(s, "1", phone, qr);
    // Uma reserva próxima, feita pela equipe para o mesmo telefone.
    await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(1),
      nights: 1,
      customer_name: "Cliente",
      customer_phone: phone,
    });
    await say(s, "menu", phone, qr);
    c = await say(s, "2", phone, qr);
    let text = (await latest(c.id)).text;
    expect(text).toContain("Suas reservas:");
    expect(text).toContain("1. #2");
    expect(text).toContain("2. #1");
    c = await say(s, "1", phone, qr);
    text = (await latest(c.id)).text;
    expect(text).toContain("Reserva #2 (confirmada)");
    expect(text).toContain("fale com a equipe");
    expect(text).not.toContain("Cancelar reserva");
    c = await say(s, "1", phone, qr); // Voltar
    c = await say(s, "2", phone, qr);
    text = (await latest(c.id)).text;
    // Reserva feita pela conversa: check-in, cancelar e voltar.
    expect(text).toContain("1. Fazer check-in");
    expect(text).toContain("2. Cancelar reserva");
    c = await say(s, "2", phone, qr);
    expect((await latest(c.id)).text).toContain("Cancelar a reserva #1");
    c = await say(s, "1", phone, qr);
    expect((await latest(c.id)).text).toContain("A reserva #1");
    expect((await latest(c.id)).text).toContain("foi cancelada");
    const rows = await bookings(s);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "confirmed"]);
    expect(rows[0].cancelled_by).toBe("customer");
  });
});
