// Conferência B9 (resíduo baixo): a ação "Abrir OS" exigia quem atende, mas
// a rota REST com conversation_id abria a OS e avisava o cliente sem
// conferir; o mesmo em pedido, agendamento e reserva (com cobrança).
// Agora quem não atende a conversa cria o registro sem falar com o cliente.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { api, bearer, receive } from "./service-center-fixture";
import { agendaSetup, at, future } from "./agenda-fixture";
import { future as reservaDay, reservaSetup } from "./reserva-fixture";
import { MENUS, pedidoSetup, seedMenu } from "./pedido-fixture";

const sent = async (conversationId: string) =>
  (
    await all(
      env,
      "SELECT id FROM outbox WHERE conversation_id=?",
      conversationId,
    )
  ).length;

describe("criar pela API sem atender a conversa não fala com o cliente (conferência B9)", () => {
  it("OS e agendamento: criados, sem aviso", async () => {
    const s = await agendaSetup();
    await s.run("module.set", { id: "os", enabled: true });
    const c = await receive(s.f, s.f.line, "oi", "5511986200001");
    const before = await sent(c.id);
    const member = await bearer(s.f.member);
    const os = await api(
      member,
      `/profiles/${s.f.profile}/service-orders`,
      "POST",
      {
        conversation_id: c.id,
        item: "Notebook",
        problem: "Não liga",
      },
    );
    expect(os.status).toBe(200);
    const appt = await api(
      member,
      `/profiles/${s.f.profile}/agenda/appointments`,
      "POST",
      {
        conversation_id: c.id,
        service_id: s.corte.id,
        professional_id: s.ana.id,
        starts: at(future(4), "10:00"),
      },
    );
    expect(appt.status).toBe(200);
    expect(await sent(c.id)).toBe(before);
    // O administrador (ou quem assumiu) avisa.
    const admin = await bearer(s.f.admin);
    await api(admin, `/profiles/${s.f.profile}/service-orders`, "POST", {
      conversation_id: c.id,
      item: "Celular",
      problem: "Tela",
    });
    expect(await sent(c.id)).toBeGreaterThan(before);
  });

  it("Reserva com sinal e pedido: criados, sem aviso nem cobrança", async () => {
    const s = await reservaSetup({
      rules: { deposit_type: "percent", deposit_percent: 30 },
    });
    const c = await receive(s.f, s.f.line, "oi", "5511986200002");
    const before = await sent(c.id);
    const member = await bearer(s.f.member);
    const res = await api(
      member,
      `/profiles/${s.f.profile}/reserva/bookings`,
      "POST",
      {
        conversation_id: c.id,
        unit_id: s.jardim.id,
        start_date: reservaDay(10),
        nights: 1,
        deposit: true,
      },
    );
    expect(res.status).toBe(200);
    expect(await sent(c.id)).toBe(before);
    expect(
      await all(env, "SELECT id FROM payments WHERE conversation_id=?", c.id),
    ).toHaveLength(0);

    const p = await pedidoSetup({ menus: MENUS });
    const menu = await seedMenu(p.f);
    const pc = await receive(p.f, p.f.line, "oi", "5511986200003");
    const pBefore = await sent(pc.id);
    const order = await api(
      await bearer(p.f.member),
      `/profiles/${p.f.profile}/pedido/orders`,
      "POST",
      {
        conversation_id: pc.id,
        fulfillment: "pickup",
        payment_method: "cash",
        items: [{ item_id: menu.suco.id, quantity: 1 }],
      },
    );
    expect(order.status).toBe(200);
    expect(await sent(pc.id)).toBe(pBefore);
  });
});
