// OS4: agendar a execução da ordem pela Agenda (ou data combinada sem ela),
// com a confirmação e o lembrete pelo mecanismo que a Agenda e a ordem já
// usam. Linha de WhatsApp simulada; nenhuma rede.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { changeStatus, createOrder, loadOrder } from "../src/modules/os/store";
import { MANUAL_REMINDER_HOURS, runScheduleDue } from "../src/modules/os/maintenance/schedule";
import { move } from "../src/modules/agenda/appointments";
import { config as agendaConfig } from "../src/modules/agenda/agenda";
import { configure, drain, outbox, receive } from "./service-center-fixture";
import { agendaSetup, at, future } from "./agenda-fixture";

async function setup(options: { agenda?: boolean } = {}) {
  const s = await agendaSetup({ enabled: options.agenda !== false });
  const run = (op: string, data: any = {}, actor = s.f.admin) => perform(env, actor, s.f.profile, op, data, uid());
  await run("module.set", { id: "os", enabled: true });
  await exec(env, "UPDATE connections SET config=? WHERE id IN (?,?)", JSON.stringify({ number: "5511900003333" }), s.f.line, s.f.qr);
  await configure(s.f, { menus: [{ id: "humano", label: "Falar com atendente", type: "human" }] });
  const ctx = modulesApi(env, s.f.profile, "os");
  return { ...s, run, os: ctx };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function orderWithConversation(s: Setup, phone: string) {
  const received = await receive(s.f, s.f.line, "bom dia", phone);
  await drain(s.f);
  const c = await conversation(env, received.id, s.f.profile);
  const { order } = await createOrder(s.os, { conversation: c, item: "Geladeira", problem: "Não gela", source: "agent", sourceKey: uid(), actor: s.f.admin.id, assignee: s.f.admin.id, notify: false });
  return { c, order };
}
const texts = async (conversationId: string) => (await outbox(conversationId)).map(m => String(m.text ?? m.body ?? JSON.stringify(m)));

describe("OS4 agendar a execução pela Agenda", () => {
  it("reserva nos horários livres, confirma pelo WhatsApp da Agenda e a lista mostra Agendado para", async () => {
    const s = await setup();
    const { c, order } = await orderWithConversation(s, "5511961000401");
    const options = await s.os.read(s.f.admin, "service-orders/schedule-options");
    expect(options.agenda.enabled).toBe(true);
    expect(options.services.map((x: any) => x.name)).toEqual(expect.arrayContaining(["Corte", "Barba"]));
    const day = future(3);
    const slots = await s.os.read(s.f.admin, "service-orders/schedule-slots", { service_id: s.corte.id, professional_id: s.ana.id, from: day, days: "1" });
    const starts = at(day, "10:00");
    expect(slots.days[0].slots.map((x: any) => x.starts)).toContain(starts);
    const view = await s.run("os.schedule.set", { id: order.id, mode: "agenda", service_id: s.corte.id, professional_id: s.ana.id, starts });
    expect(view.schedule).toMatchObject({ mode: "agenda", state: "active", starts, professional: { name: "Ana" }, appointment: { status: "booked" } });
    expect(view.whatsapp.ready).toBe(true);
    const appointment = await one(env, "SELECT * FROM agenda_appointments WHERE id=?", view.schedule.appointment.id);
    expect(appointment).toMatchObject({ conversation_id: c.id, status: "booked", starts });
    await drain(s.f);
    expect((await texts(c.id)).some(t => /agendad|confirmad|marcad/i.test(t))).toBe(true);
    // Horário ocupado não é oferecido a outra ordem.
    const again = await s.os.read(s.f.admin, "service-orders/schedule-slots", { service_id: s.corte.id, professional_id: s.ana.id, from: day, days: "1" });
    expect(again.days[0].slots.map((x: any) => x.starts)).not.toContain(starts);
    // Lista: coluna e filtro "Agendado para".
    const list = await s.os.read(s.f.admin, "service-orders", { scheduled_from: String(starts - 1), scheduled_to: String(starts + 1) });
    expect(list.data.map((o: any) => [o.id, o.scheduled_at])).toEqual([[order.id, starts]]);
    expect((await s.os.read(s.f.admin, "service-orders", { scheduled_from: String(starts + 1) })).data).toEqual([]);
    // Meus prazos: a pessoa responsável vê a execução.
    const mine = await s.os.read(s.f.admin, "service-orders/my-schedule", { from: String(starts - 1), to: String(starts + 1) });
    expect(mine.data).toEqual([expect.objectContaining({ id: order.id, scheduled_at: starts, mode: "agenda" })]);
  });

  it("remarcar pela Agenda reflete na ordem; reagendar pela ordem remarca a Agenda; cancelar a ordem cancela o agendamento", async () => {
    const s = await setup();
    const { order } = await orderWithConversation(s, "5511961000402");
    const day = future(4);
    const first = await s.run("os.schedule.set", { id: order.id, mode: "agenda", service_id: s.corte.id, professional_id: s.ana.id, starts: at(day, "09:00") });
    const id = first.schedule.appointment.id;
    await move(s.ctx, await agendaConfig(s.ctx), { id, starts: at(day, "11:00"), actor: s.f.admin.id, rules: { staff: true } });
    const reflected = await s.os.read(s.f.admin, `service-orders/${order.id}/schedule`);
    expect(reflected.schedule).toMatchObject({ starts: at(day, "11:00"), changed_by_agenda: true });
    const moved = await s.run("os.schedule.set", { id: order.id, mode: "agenda", service_id: s.corte.id, professional_id: s.ana.id, starts: at(day, "14:00") });
    expect(moved.schedule.appointment.id).toBe(id);
    expect((await one(env, "SELECT starts,status FROM agenda_appointments WHERE id=?", id))).toEqual({ starts: at(day, "14:00"), status: "booked" });
    await s.run("os.status", { id: order.id, status: "cancelled", note: "Cliente desistiu" });
    expect((await one(env, "SELECT status FROM agenda_appointments WHERE id=?", id)).status).toBe("cancelled");
    expect((await s.os.read(s.f.admin, `service-orders/${order.id}/schedule`)).schedule.state).toBe("cancelled");
  });

  it("cancelar pela ordem cancela na Agenda; cancelar pela Agenda aparece na ordem", async () => {
    const s = await setup();
    const { order } = await orderWithConversation(s, "5511961000403");
    const day = future(5);
    const view = await s.run("os.schedule.set", { id: order.id, mode: "agenda", service_id: s.barba.id, starts: at(day, "15:00") });
    const id = view.schedule.appointment.id;
    const cancelled = await s.run("os.schedule.cancel", { id: order.id, reason: "Cliente viaja" });
    expect(cancelled.schedule.state).toBe("cancelled");
    expect((await one(env, "SELECT status FROM agenda_appointments WHERE id=?", id)).status).toBe("cancelled");
    const again = await s.run("os.schedule.set", { id: order.id, mode: "agenda", service_id: s.barba.id, starts: at(day, "16:00") });
    await s.run("agenda.cancel", { id: again.schedule.appointment.id, reason: "Profissional doente" });
    const reflected = await s.os.read(s.f.admin, `service-orders/${order.id}/schedule`);
    expect(reflected.schedule).toMatchObject({ state: "cancelled", changed_by_agenda: true });
    expect((await s.os.read(s.f.admin, "service-orders", { scheduled: "1" })).data).toEqual([]);
  });
});

describe("OS4 data combinada (sem a Agenda)", () => {
  it("aceita só data e hora digitadas, sem conflito; confirmação e lembrete pela conversa da ordem", async () => {
    const s = await setup({ agenda: false });
    const options = await s.os.read(s.f.admin, "service-orders/schedule-options");
    expect(options.agenda).toMatchObject({ enabled: false, message: expect.stringContaining("ligue o módulo Agenda") });
    const { c, order } = await orderWithConversation(s, "5511961000404");
    await expect(s.run("os.schedule.set", { id: order.id, mode: "agenda", service_id: "x", starts: now() + 86_400_000 })).rejects.toMatchObject({ code: "module_disabled" });
    const starts = now() + 2 * 86_400_000;
    const view = await s.run("os.schedule.set", { id: order.id, mode: "manual", starts, note: "Portão lateral" });
    expect(view.schedule).toMatchObject({ mode: "manual", state: "active", starts, note: "Portão lateral" });
    // Outra ordem no mesmo horário: sem conflito de horário.
    const other = await orderWithConversation(s, "5511961000405");
    await s.run("os.schedule.set", { id: other.order.id, mode: "manual", starts });
    await drain(s.f);
    expect((await texts(c.id)).some(t => t.includes("execução combinada para"))).toBe(true);
    // Lembrete: uma vez, dentro da janela.
    await exec(env, "UPDATE os_order_schedules SET updated=? WHERE profile_id=? AND order_id=?", starts - 3 * 86_400_000, s.f.profile, order.id);
    await runScheduleDue(s.os, starts - (MANUAL_REMINDER_HOURS - 1) * 3_600_000);
    await runScheduleDue(s.os, starts - (MANUAL_REMINDER_HOURS - 2) * 3_600_000);
    await drain(s.f);
    expect((await texts(c.id)).filter(t => t.startsWith("Lembrete: ordem de serviço")).length).toBe(1);
  });

  it("sem conversa do WhatsApp, nada é enviado e a resposta diz", async () => {
    const s = await setup({ agenda: false });
    const { order } = await createOrder(s.os, { item: "Fogão", problem: "Boca entupida", phone: "5511961000406", source: "panel", sourceKey: uid(), actor: s.f.admin.id, notify: false });
    const view = await s.run("os.schedule.set", { id: order.id, mode: "manual", starts: now() + 86_400_000 });
    expect(view.whatsapp).toMatchObject({ ready: false, reason: expect.stringContaining("não serão enviados") });
    expect(view.warnings.join(" ")).toContain("não serão enviados");
    expect((await loadOrder(s.os, order.id)).conversation_id).toBeNull();
  });

  it("ordem encerrada não é agendada", async () => {
    const s = await setup({ agenda: false });
    const { order } = await createOrder(s.os, { item: "Fogão", problem: "Boca", phone: "5511961000407", source: "panel", sourceKey: uid(), actor: s.f.admin.id, notify: false });
    await changeStatus(s.os, order, "cancelled", s.f.admin.id, "Teste");
    await expect(s.run("os.schedule.set", { id: order.id, mode: "manual", starts: now() + 86_400_000 })).rejects.toMatchObject({ code: "order_closed" });
  });
});
