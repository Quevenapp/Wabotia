// Revisão de segurança M6 e M7 nos módulos Agenda, OS, Reserva e Pedido.
// M6: com só conversations:read, a aplicação lia telefone, endereço,
// documento do check-in e notas internas. M7: uma integração criava conversa
// com external_id igual ao telefone de outra pessoa e via ou aprovava as
// ordens e pedidos dela.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { agendaSetup, at, future } from "./agenda-fixture";
import { future as reservaDay, reservaSetup } from "./reserva-fixture";
import {
  api,
  application,
  bearer,
  drain,
  receive,
} from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  pedidoSetup,
  say,
  seedMenu,
  submitCart,
} from "./pedido-fixture";
import { outbox } from "./service-center-fixture";

const READ = ["conversations:read", "conversations:write"];
const FULL = [...READ, "contacts:read", "notes:read"];

async function json(response: Response) {
  expect(response.status).toBe(200);
  return response.json<any>();
}

describe("dados pessoais e notas nas leituras dos módulos (revisão M6)", () => {
  it("Agenda: telefone e observação só com contacts:read e notes:read", async () => {
    const s = await agendaSetup();
    const a = await s.run("agenda.book", {
      service_id: s.corte.id,
      professional_id: s.ana.id,
      starts: at(future(4), "10:00"),
      customer_name: "Cliente",
      customer_phone: "5511966660001",
      notes: "Alergia a produto X",
    });
    const path = `/profiles/${s.f.profile}/agenda/appointments/${a.id}`;
    const bare = await json(
      await api((await application(s.f, READ)).token, path),
    );
    expect(bare.customer_phone).toBeUndefined();
    expect(bare.notes).toBeUndefined();
    expect(bare.customer_name).toBe("Cliente");
    const full = await json(
      await api((await application(s.f, FULL)).token, path),
    );
    expect(full).toMatchObject({
      customer_phone: "5511966660001",
      notes: "Alergia a produto X",
    });
    // A lista também.
    const list = await json(
      await api(
        (await application(s.f, READ)).token,
        `/profiles/${s.f.profile}/agenda/appointments?from=${Date.now()}&to=${Date.now() + 10 * 86400000}`,
      ),
    );
    expect(JSON.stringify(list)).not.toContain("5511966660001");
    expect(JSON.stringify(list)).not.toContain("Alergia");
  });

  it("OS: telefone, observações e notas do histórico", async () => {
    const s = await agendaSetup();
    const f = s.f;
    await s.run("module.set", { id: "os", enabled: true });
    const order = await s.run("os.create", {
      item: "Notebook",
      problem: "Não liga",
      phone: "5511966660002",
      customer_name: "Cliente",
      notes: "Senha do aparelho 1234",
    });
    await s.run("os.status", {
      id: order.id,
      status: "analyzing",
      note: "Nota interna do técnico",
    });
    const path = `/profiles/${f.profile}/service-orders/${order.id}`;
    const bare = await json(
      await api((await application(f, READ)).token, path),
    );
    const text = JSON.stringify(bare);
    expect(text).not.toContain("5511966660002");
    expect(text).not.toContain("Senha do aparelho");
    expect(text).not.toContain("Nota interna do técnico");
    expect(bare.item).toBe("Notebook");
    const full = await json(
      await api((await application(f, FULL)).token, path),
    );
    expect(JSON.stringify(full)).toContain("Nota interna do técnico");
    expect(full.customer.phone).toBe("5511966660002");
    // Pessoa da equipe (sessão) vê tudo.
    const staff = await perform(
      env,
      f.member,
      f.profile,
      "os.update",
      { id: order.id, assignee: f.member.id },
      uid(),
    );
    expect(staff.notes).toBe("Senha do aparelho 1234");
    // A resposta de comando de aplicação também sai sem os campos.
    const updated = await json(
      await api((await application(f, READ)).token, path, "PATCH", {
        assignee: f.admin.id,
      }),
    );
    expect(updated.notes).toBeUndefined();
  });

  it("Reserva: telefone, respostas do check-in e observação", async () => {
    const s = await reservaSetup();
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: reservaDay(6),
      nights: 1,
      customer_name: "Hóspede",
      customer_phone: "5511966660003",
      notes: "Chega tarde",
    });
    await exec(
      env,
      "UPDATE reserva_bookings SET checkin_answers=? WHERE id=?",
      JSON.stringify({ documento: "123.456.789-09" }),
      b.id,
    );
    const path = `/profiles/${s.f.profile}/reserva/bookings/${b.id}`;
    const bare = await json(
      await api((await application(s.f, READ)).token, path),
    );
    const text = JSON.stringify(bare);
    expect(text).not.toContain("5511966660003");
    expect(text).not.toContain("123.456.789-09");
    expect(text).not.toContain("Chega tarde");
    expect(bare.unit_id).toBe(s.jardim.id);
    const full = await json(
      await api((await application(s.f, FULL)).token, path),
    );
    expect(full.checkin_answers).toEqual({ documento: "123.456.789-09" });
    expect(full.customer_phone).toBe("5511966660003");
  });

  it("Pedido: telefone, endereço e notas internas (lista, detalhe e comanda)", async () => {
    const { f } = await pedidoSetup({ menus: MENUS });
    const menu = await seedMenu(f);
    const phone = "5511966660004";
    await say(f, "oi", phone);
    const c = await say(f, "1", phone);
    const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
    await submitCart(codeIn(link.text), {
      [`q_${menu.suco.id}`]: "1",
      fulfillment: "delivery",
      street: "Rua Secreta, 99",
      district: "Centro",
      name: "Ana",
      payment: "cash",
      confirm: "1",
    });
    const order = await one(
      env,
      "SELECT id FROM pedido_orders WHERE conversation_id=?",
      c.id,
    );
    await exec(
      env,
      "UPDATE pedido_orders SET fulfillment='delivery',address=? WHERE id=?",
      JSON.stringify({ street: "Rua Secreta, 99", district: "Centro" }),
      order.id,
    );
    await perform(
      env,
      f.admin,
      f.profile,
      "pedido.order.update",
      { id: order.id, notes: "Cliente difícil" },
      uid(),
    );
    const token = (await application(f, READ)).token;
    for (const path of [
      `/profiles/${f.profile}/pedido/orders/${order.id}`,
      `/profiles/${f.profile}/pedido/orders`,
      `/profiles/${f.profile}/pedido/orders/${order.id}/ticket`,
      `/profiles/${f.profile}/pedido/board`,
    ]) {
      const text = JSON.stringify(await json(await api(token, path)));
      expect(text, path).not.toContain("Rua Secreta");
      expect(text, path).not.toContain(phone);
      expect(text, path).not.toContain("Cliente difícil");
    }
    const full = await json(
      await api(
        (await application(f, FULL)).token,
        `/profiles/${f.profile}/pedido/orders/${order.id}`,
      ),
    );
    expect(full.address_text).toContain("Rua Secreta");
    expect(full.notes).toBe("Cliente difícil");
  });
});

describe("telefone verificado nos módulos (revisão M7)", () => {
  it("conversa de integração com o telefone de outra pessoa não vê nem aprova a OS dela", async () => {
    const s = await agendaSetup();
    const f = s.f;
    await s.run("module.set", { id: "os", enabled: true });
    const victim = "5511966660005";
    // Ordem de balcão só com o telefone da vítima, já com orçamento enviado.
    const order = await s.run("os.create", {
      item: "Celular",
      problem: "Tela",
      phone: victim,
      customer_name: "Vítima",
    });
    await s.run("os.quote.save", {
      id: order.id,
      items: [{ description: "Tela", unit_cents: 30000 }],
    });
    await s.run("os.quote.send", { id: order.id, notify: false });
    // Integração cria conversa com external_id = telefone da vítima.
    const app = await application(f, READ);
    const actor = {
      id: `app:app:${app.id}`,
      kind: "app" as const,
      name: "App",
      role: "operator" as const,
      profiles: [f.profile],
      scopes: READ,
      bots: [],
      rate: 60,
      runLimit: 3,
    };
    await api(app.token, `/profiles/${f.profile}/inbound`, "POST", {
      external_id: victim,
      phone: victim,
      message_id: uid(),
      text: `APROVAR ${order.number}`,
    });
    await drain(f);
    expect(
      (await one(env, "SELECT decision FROM os_orders WHERE id=?", order.id))
        .decision,
    ).toBeNull();
    const conversationId = (
      await one(
        env,
        "SELECT id FROM conversations WHERE profile_id=? AND external_namespace=?",
        f.profile,
        `app:app:${app.id}`,
      )
    ).id;
    const mine = await json(
      await api(
        app.token,
        `/profiles/${f.profile}/service-orders/conversation/${conversationId}`,
      ),
    );
    expect(mine.data).toEqual([]);
    // Não puxou a ordem para a conversa da integração.
    expect(
      (
        await one(
          env,
          "SELECT conversation_id FROM os_orders WHERE id=?",
          order.id,
        )
      ).conversation_id,
    ).toBeNull();
    void actor;
    // O cliente de verdade, pelo canal, vê a ordem.
    const real = await receive(f, f.line, "oi", victim);
    const own = await json(
      await api(
        await bearer(f.admin),
        `/profiles/${f.profile}/service-orders/conversation/${real.id}`,
      ),
    );
    expect(own.data.map((o: any) => o.id)).toEqual([order.id]);
  });

  it("Pedido: conversa de integração não lista pedidos de outro telefone", async () => {
    const { f } = await pedidoSetup({ menus: MENUS });
    await seedMenu(f);
    const victim = "5511966660006";
    await say(f, "oi", victim);
    const real = await say(f, "1", victim);
    await exec(
      env,
      "INSERT INTO pedido_orders(id,profile_id,number,status,status_at,conversation_id,customer_name,phone,source,fulfillment,lines,item_count,subtotal_cents,delivery_fee_cents,total_cents,payment_status,created_by,created,updated) VALUES(?,?,?,'received',?,NULL,'Vítima',?,'panel','pickup','[]',1,100,0,100,'pending','admin',?,?)",
      uid(),
      f.profile,
      9001,
      Date.now(),
      victim,
      Date.now(),
      Date.now(),
    );
    const app = await application(f, READ);
    await api(app.token, `/profiles/${f.profile}/inbound`, "POST", {
      external_id: victim,
      phone: victim,
      message_id: uid(),
      text: "oi",
    });
    const fake = await one(
      env,
      "SELECT id FROM conversations WHERE profile_id=? AND external_namespace=?",
      f.profile,
      `app:app:${app.id}`,
    );
    const seen = await json(
      await api(
        app.token,
        `/profiles/${f.profile}/pedido/conversations/${fake.id}`,
      ),
    );
    expect(seen.data).toEqual([]);
    const own = await json(
      await api(
        await bearer(f.admin),
        `/profiles/${f.profile}/pedido/conversations/${real.id}`,
      ),
    );
    expect(own.data.map((o: any) => o.number)).toContain(9001);
  });
});
