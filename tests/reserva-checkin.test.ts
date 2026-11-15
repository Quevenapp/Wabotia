import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { runDue } from "../src/modules/reserva/schedule";
import { runModuleSchedules } from "../src/modules/schedule";
import {
  api,
  bearer,
  drain,
  latest,
  outbox,
  receive,
} from "./service-center-fixture";
import {
  bookings,
  chatSetup,
  future,
  say,
  type ReservaSetup,
} from "./reserva-fixture";

const H = 3600000;
const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;
const submit = (code: string, body: Record<string, string>) =>
  SELF.fetch(`https://test/api/w/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://test",
    },
    body: new URLSearchParams(
      Object.fromEntries(Object.entries(body).map(([k, v]) => [`f_${k}`, v])),
    ).toString(),
  });
const events = (s: ReservaSetup, kind: string) =>
  all(
    env,
    "SELECT * FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    s.f.profile,
    kind,
  );

/** Reserva da equipe ligada a uma conversa (o cliente escreveu agora). */
async function linked(
  s: ReservaSetup,
  phone: string,
  line: string,
  body: Record<string, unknown> = {},
) {
  const c = await receive(s.f, line, "oi", phone);
  await drain(s.f);
  const booking = await s.run("reserva.book", {
    unit_id: s.jardim.id,
    start_date: future(5),
    nights: 2,
    guests: 3,
    conversation_id: c.id,
    ...body,
  });
  return { c, booking };
}

describe("reserva: check-in pelo passo web", () => {
  it("o gancho periódico envia o link antes da entrada e as respostas ficam na reserva", async () => {
    const s = await chatSetup({
      checkin_hours_before: 48,
      checkin_fields: {
        document: true,
        companions: true,
        arrival_time: true,
        rules: true,
      },
      checkin_questions: ["Placa do carro"],
      house_rules: "Silêncio depois das 22h. Proibido fumar nos quartos.",
    });
    const { c, booking } = await linked(s, "5511973000001", s.f.qr);
    // Antes da janela, nada.
    expect((await runDue(s.ctx, booking.arrival_at - 49 * H)).checkin).toEqual(
      [],
    );
    const due = await runDue(s.ctx, booking.arrival_at - 47 * H);
    expect(due.checkin).toEqual([booking.id]);
    // Repetir a rodada não manda de novo.
    expect((await runDue(s.ctx, booking.arrival_at - 46 * H)).checkin).toEqual(
      [],
    );
    const message = await latest(c.id);
    expect(message.text).toContain("Faça o check-in online da reserva #1");
    const code = codeIn(message.text);
    expect(code).toBeTruthy();
    const [sent] = await bookings(s);
    expect(sent).toMatchObject({ checkin_status: "sent" });
    const step = await one(
      env,
      "SELECT * FROM web_steps WHERE id=?",
      sent.checkin_step_id,
    );
    expect(step).toMatchObject({
      module_id: "reserva",
      kind: "checkin",
      ref_id: booking.id,
    });
    const page = await SELF.fetch(`https://test/api/w/${code}`);
    const html = await page.text();
    expect(html).toContain("Check-in da reserva #1");
    expect(html).toContain("Nome dos acompanhantes (2)");
    expect(html).toContain("Placa do carro");
    expect(html).toContain("Proibido fumar nos quartos.");
    // Sem o aceite das regras, recusa.
    const missing = await submit(code, {
      documento: "123.456.789-00",
      chegada: "15h",
    });
    expect((await bookings(s))[0].checkin_status).toBe("sent");
    expect(missing.status).toBeGreaterThanOrEqual(200);
    const ok = await submit(code, {
      documento: "123.456.789-00",
      acompanhantes: "Bia\nCaio",
      chegada: "15h",
      pergunta_1: "ABC1D23",
      regras: "on",
    });
    expect(ok.status).toBe(200);
    const [done] = await bookings(s);
    expect(done.checkin_status).toBe("completed");
    expect(JSON.parse(done.checkin_answers)).toMatchObject({
      documento: "123.456.789-00",
      acompanhantes: "Bia\nCaio",
      chegada: "15h",
      pergunta_1: "ABC1D23",
      regras: true,
    });
    expect(await events(s, "reserva.checkin_completed")).toHaveLength(1);
    await drain(s.f);
    expect((await outbox(c.id)).map((m) => m.text).join("\n")).toContain(
      "Check-in da reserva #1 recebido.",
    );
    // O link é de uso único.
    const again = await submit(code, {
      documento: "x",
      chegada: "x",
      regras: "on",
    });
    expect(await again.text()).toContain("já foi usado");
    const view = await (
      await api(
        await bearer(s.f.member),
        `/profiles/${s.f.profile}/reserva/bookings/${booking.id}`,
      )
    ).json<any>();
    expect(view.checkin_answers.documento).toBe("123.456.789-00");
  });

  it("linha oficial com a janela fechada: convite por notificação e link quando o cliente responde", async () => {
    const s = await chatSetup();
    const phone = "5511973000002";
    const { c, booking } = await linked(s, phone, s.f.line);
    const due = await runDue(s.ctx, booking.arrival_at - 47 * H);
    expect(due.checkin).toEqual([booking.id]);
    const invite = (
      await all(
        env,
        "SELECT kind,payload FROM outbox WHERE conversation_id=? ORDER BY created,rowid",
        c.id,
      )
    ).at(-1)!;
    expect(invite.kind).toBe("notification");
    expect(JSON.parse(invite.payload).text).toContain("responda CHECKIN");
    expect((await bookings(s))[0].checkin_status).toBe("invited");
    const after = await say(s, "checkin", phone, s.f.line);
    const out = await latest(after.id);
    expect(out.text).toContain("Faça o check-in online da reserva #1");
    expect(out.content?.interactive?.type).toBe("cta_url");
    expect((await bookings(s))[0].checkin_status).toBe("sent");
    // Sem reserva pendente, CHECKIN segue para o menu.
    const other = await say(s, "checkin", "5511973000099", s.f.line);
    expect((await latest(other.id)).text).not.toContain("check-in");
  });

  it("a equipe envia pelo painel e o cliente pede em Minhas reservas", async () => {
    const s = await chatSetup();
    const phone = "5511973000003";
    const { c, booking } = await linked(s, phone, s.f.qr);
    const admin = await bearer(s.f.admin);
    const sent = await (
      await api(
        admin,
        `/profiles/${s.f.profile}/reserva/bookings/${booking.id}/checkin`,
        "POST",
        {},
      )
    ).json<any>();
    expect(sent.checkin_status).toBe("sent");
    expect((await latest(c.id)).text).toContain("/api/w/");
    expect(await events(s, "reserva.checkin_sent")).toHaveLength(1);
    // Minhas reservas oferece reenviar.
    await say(s, "menu", phone, s.f.qr);
    let conv = await say(s, "2", phone, s.f.qr);
    conv = await say(s, "1", phone, s.f.qr);
    expect((await latest(conv.id)).text).toContain("1. Reenviar check-in");
    conv = await say(s, "1", phone, s.f.qr);
    expect((await latest(conv.id)).text).toContain(
      "Faça o check-in online da reserva #1",
    );
    // Reserva sem conversa não recebe.
    const loose = await api(
      admin,
      `/profiles/${s.f.profile}/reserva/bookings`,
      "POST",
      {
        unit_id: s.mar.id,
        start_date: future(5),
        nights: 1,
        customer_name: "Balcão",
      },
    );
    const id = (await loose.json<any>()).id;
    const refused = await api(
      admin,
      `/profiles/${s.f.profile}/reserva/bookings/${id}/checkin`,
      "POST",
      {},
    );
    expect(refused.status).toBe(400);
  });
});

describe("reserva: lembrete e mensagem de saída", () => {
  it("lembrete na véspera e saída, uma vez cada, e a reserva se encerra", async () => {
    const s = await chatSetup({
      checkin_enabled: false,
      checkout_minutes_before: 60,
    });
    const { c, booking } = await linked(s, "5511973000004", s.f.qr);
    expect((await runDue(s.ctx, booking.arrival_at - 25 * H)).reminded).toEqual(
      [],
    );
    expect((await runDue(s.ctx, booking.arrival_at - 23 * H)).reminded).toEqual(
      [booking.id],
    );
    expect((await runDue(s.ctx, booking.arrival_at - 22 * H)).reminded).toEqual(
      [],
    );
    const reminder = (await outbox(c.id)).filter((m) =>
      m.text.includes("Lembrete da sua reserva #1"),
    );
    expect(reminder).toHaveLength(1);
    expect(reminder[0].text).not.toContain("CHECKIN");
    const kinds = await all(
      env,
      "SELECT kind FROM outbox WHERE conversation_id=? AND payload LIKE '%Lembrete da sua reserva%'",
      c.id,
    );
    expect(kinds.map((k) => k.kind)).toEqual(["notification"]);
    expect(
      (await runDue(s.ctx, booking.departure_at - 61 * 60000)).checkout,
    ).toEqual([]);
    expect(
      (await runDue(s.ctx, booking.departure_at - 30 * 60000)).checkout,
    ).toEqual([booking.id]);
    expect((await latest(c.id)).text).toContain("Sua saída de Chalé Jardim é");
    const end = await runDue(s.ctx, booking.departure_at + 60000);
    expect(end.checkout).toEqual([]);
    expect(end.completed).toEqual([booking.id]);
    expect((await bookings(s))[0].status).toBe("completed");
    expect(await events(s, "reserva.completed")).toHaveLength(1);
  });

  it("reserva feita dentro da janela não recebe lembrete; a rodada do núcleo chama o módulo", async () => {
    const s = await chatSetup({ reminder_hours: 168, checkin_enabled: false });
    const { booking } = await linked(s, "5511973000005", s.f.qr);
    expect((await runDue(s.ctx, booking.arrival_at - 23 * H)).reminded).toEqual(
      [],
    );
    const outcomes = await runModuleSchedules(env, s.f.profile, Date.now());
    expect(outcomes).toContainEqual({ module: "reserva", ok: true });
  });
});
