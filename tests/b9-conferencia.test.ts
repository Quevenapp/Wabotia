// Conferência B9 (resíduo baixo): a ação "Abrir OS" exigia quem atende, mas
// a rota REST com conversation_id abria a OS e avisava o cliente sem
// conferir; o mesmo em pedido, agendamento e reserva (com cobrança).
// Agora quem não atende a conversa cria o registro sem falar com o cliente.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { api, application, bearer, receive } from "./service-center-fixture";
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

describe("segunda conferência B9: outras operações pela API", () => {
  it("aplicação que não atende a conversa remarca, cancela, muda estado e envia orçamento sem avisar; a equipe avisa", async () => {
    const s = await agendaSetup();
    await s.run("module.set", { id: "os", enabled: true });
    const p = s.f.profile;
    const c = await receive(s.f, s.f.line, "oi", "5511986200011");
    const admin = await bearer(s.f.admin);
    const make = async () =>
      (
        await api(admin, `/profiles/${p}/service-orders`, "POST", {
          conversation_id: c.id,
          item: "Notebook",
          problem: "Não liga",
        })
      ).json<any>();
    const first = await make();
    const second = await make();
    const appt = await s.run("agenda.book", {
      service_id: s.corte.id,
      professional_id: s.ana.id,
      starts: at(future(4), "10:00"),
      conversation_id: c.id,
    });
    const app = (
      await application(s.f, ["conversations:read", "conversations:write"])
    ).token;
    const before = await sent(c.id);
    const ok = async (r: Response) => expect(r.status).toBe(200);
    await ok(
      await api(
        app,
        `/profiles/${p}/service-orders/${first.id}/status`,
        "POST",
        {
          status: "in_progress",
        },
      ),
    );
    await ok(
      await api(
        app,
        `/profiles/${p}/service-orders/${second.id}/quote`,
        "PUT",
        {
          items: [{ description: "Troca da fonte", unit_cents: 15000 }],
        },
      ),
    );
    await ok(
      await api(
        app,
        `/profiles/${p}/service-orders/${second.id}/quote/send`,
        "POST",
        {},
      ),
    );
    await ok(
      await api(
        app,
        `/profiles/${p}/agenda/appointments/${appt.id}/move`,
        "POST",
        { starts: at(future(5), "11:00") },
      ),
    );
    await ok(
      await api(
        app,
        `/profiles/${p}/agenda/appointments/${appt.id}/cancel`,
        "POST",
        {},
      ),
    );
    expect(await sent(c.id)).toBe(before);
    // A equipe, pelo painel, continua avisando ("pronto").
    await ok(
      await api(
        await bearer(s.f.member),
        `/profiles/${p}/service-orders/${first.id}/status`,
        "POST",
        { status: "ready" },
      ),
    );
    expect(await sent(c.id)).toBeGreaterThan(before);
  });

  it("aplicação que não atende a conversa não manda o link do check-in", async () => {
    const s = await reservaSetup();
    const c = await receive(s.f, s.f.line, "oi", "5511986200012");
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: reservaDay(11),
      nights: 1,
      conversation_id: c.id,
    });
    const app = (
      await application(s.f, ["conversations:read", "conversations:write"])
    ).token;
    const before = await sent(c.id);
    const r = await api(
      app,
      `/profiles/${s.f.profile}/reserva/bookings/${b.id}/checkin`,
      "POST",
      {},
    );
    expect(r.status).toBe(403);
    expect(await sent(c.id)).toBe(before);
  });
});
