import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json } from "../src/types";
import { runDue } from "../src/modules/agenda/reminders";
import { agendaTurn, loadState } from "../src/modules/agenda/chat";
import { runModuleSchedules } from "../src/modules/schedule";
import { configure, drain, outbox, receive } from "./service-center-fixture";
import { agendaSetup, at, future, type AgendaSetup } from "./agenda-fixture";

async function booked(
  s: AgendaSetup,
  line: string,
  phone: string,
  starts: number,
) {
  const c = await receive(s.f, line, "bom dia", phone);
  await drain(s.f);
  const a = await s.run("agenda.book", {
    service_id: s.corte.id,
    professional_id: s.ana.id,
    starts,
    conversation_id: c.id,
    notify: false,
  });
  return { c, a };
}
const reminders = async (conversationId: string) =>
  (
    await all(
      env,
      "SELECT kind,payload,dedupe FROM outbox WHERE conversation_id=? AND dedupe LIKE '%reminder:%'",
      conversationId,
    )
  ).map((row) => ({ ...row, payload: json(row.payload) }));

describe("agenda: lembrete", () => {
  it("vence na janela, sai uma vez como notificação e respeita as regras", async () => {
    const s = await agendaSetup();
    await configure(s.f, { agenda: { reminder_hours: 2 } });
    const day = future(3);
    const { c, a } = await booked(s, s.f.qr, "5511960000001", at(day, "10:00"));
    const other = await booked(s, s.f.qr, "5511960000002", at(day, "11:00"));
    await s.run("agenda.confirm", { id: other.a.id });

    // Ainda não venceu.
    expect((await runDue(s.ctx, at(day, "07:30"))).sent).toEqual([]);
    // Venceu: só o não confirmado.
    const result = await runDue(s.ctx, at(day, "08:30"));
    expect(result.sent).toEqual([a.id]);
    const [sent] = await reminders(c.id);
    expect(sent.kind).toBe("notification");
    expect(sent.payload.text).toContain("Lembrete: Corte com Ana");
    expect(sent.payload.text).toContain("às 10:00. Você confirma?");
    expect(sent.payload.text).toContain("Meus agendamentos");
    expect(
      (
        await one(
          env,
          "SELECT reminded_at FROM agenda_appointments WHERE id=?",
          a.id,
        )
      ).reminded_at,
    ).toBe(at(day, "08:30"));
    // Rodada repetida: nada novo.
    expect((await runDue(s.ctx, at(day, "08:35"))).sent).toEqual([]);
    expect(await reminders(c.id)).toHaveLength(1);
    expect(await reminders(other.c.id)).toHaveLength(0);

    // Remarcar zera o lembrete; quem marca dentro da janela não recebe.
    await s.run("agenda.move", {
      id: a.id,
      starts: at(day, "15:00"),
      notify: false,
    });
    await exec(
      env,
      "UPDATE agenda_appointments SET booked_at=? WHERE id=?",
      at(day, "14:00"),
      a.id,
    );
    expect((await runDue(s.ctx, at(day, "14:01"))).sent).toEqual([]);
    await exec(
      env,
      "UPDATE agenda_appointments SET booked_at=? WHERE id=?",
      at(day, "12:00"),
      a.id,
    );
    expect((await runDue(s.ctx, at(day, "14:01"))).sent).toEqual([a.id]);
    expect(
      (await reminders(c.id)).map((r) =>
        r.dedupe.split(":").slice(-2).join(":"),
      ),
    ).toEqual([`${a.id}:0`, `${a.id}:1`]);

    // Lembrete desligado.
    await configure(s.f, { agenda: { reminder_hours: 0 } });
    const third = await booked(s, s.f.qr, "5511960000003", at(day, "17:00"));
    expect((await runDue(s.ctx, at(day, "16:30"))).sent).toEqual([]);
    expect(await reminders(third.c.id)).toHaveLength(0);
  });

  it("pelo gancho periódico do núcleo, só com o módulo ligado", async () => {
    const s = await agendaSetup();
    const day = future(4);
    const { c } = await booked(s, s.f.qr, "5511960000004", at(day, "10:00"));
    await s.run("module.set", { id: "agenda", enabled: false });
    expect(
      await runModuleSchedules(env, s.f.profile, at(day, "09:00")),
    ).toEqual([]);
    await s.run("module.set", { id: "agenda", enabled: true });
    const outcome = await runModuleSchedules(
      env,
      s.f.profile,
      at(day, "09:00"),
    );
    expect(outcome).toContainEqual({ module: "agenda", ok: true });
    expect(await reminders(c.id)).toHaveLength(1);
  });

  it("com o gancho de turno: botões Confirmar, Remarcar e Cancelar", async () => {
    const s = await agendaSetup();
    const day = future(3);
    // Linha oficial: botões com o id do agendamento.
    const official = await booked(
      s,
      s.f.line,
      "5511960000005",
      at(day, "10:00"),
    );
    const qr = await booked(s, s.f.qr, "5511960000006", at(day, "11:00"));
    const result = await runDue(s.ctx, at(day, "09:00"), { chat: true });
    expect(result.sent.sort()).toEqual([official.a.id, qr.a.id].sort());
    const [button] = await reminders(official.c.id);
    const buttons = button.payload.content.interactive.action.buttons;
    expect(buttons.map((b: any) => b.reply.title)).toEqual([
      "Confirmar",
      "Remarcar",
      "Cancelar",
    ]);
    expect(buttons[0].reply.id).toBe(`agenda:remind:${official.a.id}:confirm`);
    const [numbered] = await reminders(qr.c.id);
    expect(numbered.payload.content).toBeUndefined();
    expect(numbered.payload.text).toContain(
      "1. Confirmar\n2. Remarcar\n3. Cancelar",
    );
    expect((await loadState(s.ctx, qr.c.id))!.step).toBe("reminder");

    // Toque em Confirmar (antes do horário).
    const c1 = await (
      await import("../src/service")
    ).conversation(env, official.c.id, s.f.profile);
    expect(
      await agendaTurn(
        s.ctx,
        c1,
        { text: "Confirmar", replyId: buttons[0].reply.id, rowId: "r1" },
        at(day, "09:05"),
      ),
    ).toBe(true);
    expect(
      (
        await one(
          env,
          "SELECT status FROM agenda_appointments WHERE id=?",
          official.a.id,
        )
      ).status,
    ).toBe("confirmed");
    // Botão de outra conversa não vale aqui.
    expect(
      await agendaTurn(
        s.ctx,
        c1,
        {
          text: "Cancelar",
          replyId: `agenda:remind:${qr.a.id}:cancel`,
          rowId: "r2",
        },
        at(day, "09:06"),
      ),
    ).toBe(false);

    // QR: "3" cancela, se ainda estiver no prazo; outra mensagem solta a pergunta.
    await configure(s.f, { agenda: { customer_change_hours: 0 } });
    const c2 = await (
      await import("../src/service")
    ).conversation(env, qr.c.id, s.f.profile);
    expect(
      await agendaTurn(s.ctx, c2, { text: "3", rowId: "r3" }, at(day, "09:10")),
    ).toBe(true);
    expect(
      (
        await one(
          env,
          "SELECT status FROM agenda_appointments WHERE id=?",
          qr.a.id,
        )
      ).status,
    ).toBe("cancelled");
    const texts = (await outbox(qr.c.id)).map((m) => m.text);
    expect(texts.at(-1)).toContain("foi cancelado");
    const events = await all(
      env,
      "SELECT kind FROM events WHERE profile_id=? AND kind IN ('agenda.confirmed','agenda.cancelled') ORDER BY id",
      s.f.profile,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "agenda.confirmed",
      "agenda.cancelled",
    ]);
  });

  it("marcar ausência depois do início", async () => {
    const s = await agendaSetup();
    const starts = at(future(0), "00:00") - 3600000;
    const a = await s.run("agenda.book", {
      service_id: s.corte.id,
      professional_id: s.ana.id,
      starts,
      customer_name: "Ana Cliente",
      force: true,
    });
    const absent = await s.run("agenda.no_show", { id: a.id });
    expect(absent).toMatchObject({ status: "no_show" });
    expect(absent.no_show_at).toBeGreaterThan(0);
    await expect(s.run("agenda.cancel", { id: a.id })).rejects.toMatchObject({
      code: "appointment_closed",
    });
    const [event] = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='agenda.no_show'",
      s.f.profile,
    );
    expect(json(event.payload).appointment.id).toBe(a.id);
  });
});
