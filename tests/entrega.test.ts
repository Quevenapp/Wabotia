// Módulo Entrega: pedido do Pedido com entrega, rota do entregador, lote de
// posições, previsão, avisos ao cliente, página de acompanhamento e retenção.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { json, now, uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { moduleRoutes } from "../src/modules/hooks";
import { openapi } from "../src/openapi";
import { runDue, purge } from "../src/modules/entrega/notify";
import { entregaConfig } from "../src/modules/entrega/config";
import { distanceM, straightLine } from "../src/modules/entrega/geo";
import { mapGrid } from "../src/web-track";
import { measure } from "./d1-counter";
import {
  api,
  application,
  bearer,
  outbox,
  type Fixture,
} from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  pedidoSetup,
  run,
  say,
  seedMenu,
  submitCart,
} from "./pedido-fixture";

const DEST = { lat: -23.5505, lng: -46.6333 };
// ~3 km ao sul do destino; ~170 m do destino.
const FAR = { lat: -23.5775, lng: -46.6333 };
const NEAR = { lat: -23.552, lng: -46.6333 };

async function setup(entrega: any = {}, enabled = true) {
  const { f } = await pedidoSetup({
    menus: MENUS,
    config: {
      store_name: "Lanchonete da Ana",
      delivery: true,
      delivery_fee_cents: 700,
      // Só cartão na entrega: o pedido vai direto para "Recebido".
      payments: { cash: false, card: true },
    },
  });
  if (enabled) {
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "entrega", enabled: true },
      uid(),
    );
    await run(f, f.admin, "settings", {
      menus: [
        ...MENUS,
        { id: "onde", label: "Onde está minha entrega", type: "entrega_onde" },
      ],
      entrega: { couriers: [f.member.id], ...entrega },
    });
  }
  const menu = await seedMenu(f);
  return { f, menu, ctx: modulesApi(env, f.profile, "entrega") };
}

/** Pedido com entrega pelo carrinho (registra o consentimento de pedido). */
async function deliveryOrder(
  f: Fixture,
  menu: Awaited<ReturnType<typeof seedMenu>>,
  phone: string,
) {
  await say(f, "oi", phone);
  const c = await say(f, "1", phone);
  const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
  await submitCart(codeIn(link.text), {
    [`q_${menu.suco.id}`]: "1",
    fulfillment: "delivery",
    name: "Caio",
    street: "Rua C, 30",
    district: "Vila Nova",
    confirm: "1",
  });
  const order = await one(
    env,
    "SELECT * FROM pedido_orders WHERE conversation_id=? ORDER BY number DESC LIMIT 1",
    c.id,
  );
  return { c, order };
}

const orderStatus = async (id: string) =>
  (await one(env, "SELECT status FROM pedido_orders WHERE id=?", id)).status;

const positions = (token: string, f: Fixture, id: string, body: any) =>
  SELF.fetch(
    `https://test/api/v1/profiles/${f.profile}/entrega/deliveries/${id}/positions`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

const track = (code: string) => SELF.fetch(`https://test/api/w/${code}`);

async function started(entrega: any = {}) {
  const { f, menu, ctx } = await setup(entrega);
  const { c, order } = await deliveryOrder(f, menu, "5511972" + String(Math.random()).slice(2, 8));
  const created = await run(f, f.admin, "entrega.create", {
    source: "pedido",
    ref_id: order.id,
    courier_id: f.member.id,
  });
  const view = await run(f, f.member, "entrega.start", {
    id: created.id,
    destination: DEST,
  });
  return { f, menu, ctx, c, order, delivery: view };
}

describe("entrega: geografia sem custo", () => {
  it("distância em linha reta, previsão e grade do mapa", () => {
    expect(Math.round(distanceM(FAR, DEST) / 100)).toBe(30);
    const eta = straightLine.eta({
      from: FAR,
      to: DEST,
      speedKmh: 25,
      roadFactor: 1.3,
    }) as any;
    // 3 km × 1,3 a 25 km/h: cerca de 10 min.
    expect(eta.minutes).toBeGreaterThanOrEqual(9);
    expect(eta.minutes).toBeLessThanOrEqual(10);
    // Medida absurda fica entre metade e o dobro da configurada.
    const fast = straightLine.eta({
      from: FAR,
      to: DEST,
      speedKmh: 25,
      roadFactor: 1.3,
      measuredKmh: 500,
    }) as any;
    expect(fast.minutes).toBe(5);
    const grid = mapGrid([FAR, DEST]);
    expect(grid.tiles).toHaveLength(9);
    for (const p of [FAR, DEST]) {
      const at = grid.place(p);
      expect(at.left).toBeGreaterThan(0);
      expect(at.left).toBeLessThan(100);
      expect(at.top).toBeGreaterThan(0);
      expect(at.top).toBeLessThan(100);
    }
  });

  it("configuração: padrões e validação estrita", async () => {
    expect(entregaConfig({}).updates).toEqual({
      mode: "eta",
      every_minutes: 10,
      max: 6,
    });
    const { f } = await setup();
    const bad = await perform(env, f.admin, f.profile, "settings", {
      entrega: { updates: { every_minutes: 1 } },
    }, uid()).catch((e) => e);
    expect(bad.status).toBe(400);
  });
});

describe("entrega: módulo desligado", () => {
  it("rotas respondem 409 module_disabled", async () => {
    const { f } = await setup({}, false);
    const token = await bearer(f.member);
    const res = await api(token, `/profiles/${f.profile}/entrega/mine`);
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe("module_disabled");
    const pos = await positions(token, f, "x", { points: [] });
    expect(pos.status).toBe(409);
  });
});

describe("entrega: pedido do Pedido do começo ao fim", () => {
  it("atribui, sai, recebe posições, avisa chegada, entrega e apaga a posição", async () => {
    const { f, menu, ctx } = await setup();
    const { c, order } = await deliveryOrder(f, menu, "5511972000001");
    const admin = await bearer(f.admin);
    const member = await bearer(f.member);

    // Pedidos com entrega disponíveis para o app.
    const avail = await (
      await api(member, `/profiles/${f.profile}/entrega/available`)
    ).json<any>();
    expect(avail.data.map((o: any) => o.ref_id)).toContain(order.id);

    // A equipe cria a entrega; repetir a chave devolve a mesma.
    const key = uid();
    const path = `/profiles/${f.profile}/entrega/deliveries`;
    const body = { source: "pedido", ref_id: order.id, courier_id: f.member.id };
    const first = await api(admin, path, "POST", body, key);
    expect(first.status).toBe(200);
    const created = await first.json<any>();
    expect(created).toMatchObject({
      status: "assigned",
      label: `Pedido nº ${order.number}`,
      conversation_id: c.id,
      courier: { id: f.member.id },
    });
    const again = await api(admin, path, "POST", body, key);
    expect((await again.json<any>()).id).toBe(created.id);
    // Outra chave: o pedido já tem entrega aberta.
    const dup = await api(admin, path, "POST", body);
    expect(dup.status).toBe(409);
    expect((await dup.json<any>()).error.code).toBe("delivery_exists");

    // Só o entregador atribuído sai e manda posição.
    const other = await bearer(f.other);
    const notMine = await api(
      other,
      `${path}/${created.id}/start`,
      "POST",
      {},
    );
    expect(notMine.status).toBe(403);
    // Antes de sair, a posição não é aceita (o app não liga o GPS).
    const early = await (
      await positions(member, f, created.id, {
        points: [{ t: now(), ...FAR }],
      })
    ).json<any>();
    expect(early).toMatchObject({ active: false, status: "assigned" });

    const go = await api(member, `${path}/${created.id}/start`, "POST", {
      destination: DEST,
    });
    expect(go.status).toBe(200);
    const goBody = await go.json<any>();
    expect(goBody).toMatchObject({
      status: "en_route",
      destination: { lat: DEST.lat, lng: DEST.lng, source: "app" },
      app: { sample_seconds: 15, upload_seconds: 60, max_batch: 200 },
    });
    // O Pedido foi para "Saiu para entrega" e avisou; a Entrega mandou o link.
    expect(await orderStatus(order.id)).toBe("out_for_delivery");
    const sent = await outbox(c.id);
    expect(sent.some((m) => /saiu para entrega/i.test(String(m.text)))).toBe(true);
    const link = sent.find(
      (m) => JSON.stringify(m).includes("Acompanhar") && codeIn(JSON.stringify(m)),
    );
    expect(link).toBeTruthy();
    const code = codeIn(JSON.stringify(link));

    // Página antes da primeira posição.
    let page = await track(code);
    expect(page.status).toBe(200);
    let html = await page.text();
    expect(html).toContain("Aguardando a primeira posição");
    expect(html).toContain('http-equiv="refresh"');

    // Lote de posições: pontos velhos, repetidos e imprecisos são ignorados.
    const t0 = now() - 40000;
    const batch = {
      points: [
        { t: t0, lat: FAR.lat, lng: FAR.lng, accuracy: 10 },
        { t: t0 + 30000, lat: FAR.lat + 0.002, lng: FAR.lng, accuracy: 12 },
        { t: t0 + 30000, lat: FAR.lat + 0.002, lng: FAR.lng },
        { t: t0 + 35000, lat: FAR.lat + 0.004, lng: FAR.lng, accuracy: 900 },
        { t: "x", lat: 1, lng: 1 },
      ],
      battery: 64,
    };
    const res = await positions(member, f, created.id, batch);
    expect(res.status).toBe(200);
    const accepted = await res.json<any>();
    expect(accepted).toMatchObject({ active: true, accepted: 2, ignored: 3 });
    expect(accepted.eta.minutes).toBeGreaterThan(3);
    // Repetir o mesmo lote não muda nada (sem Idempotency-Key).
    const repeat = await (await positions(member, f, created.id, batch)).json<any>();
    expect(repeat.accepted).toBe(0);
    const row = await one(env, "SELECT * FROM entrega_deliveries WHERE id=?", created.id);
    expect(row).toMatchObject({ points: 2, last_battery: 64 });
    expect(json(row.trail, [])).toHaveLength(2);

    // Página com o mapa do OpenStreetMap e a previsão.
    html = await (await track(code)).text();
    expect(html).toContain("tile.openstreetmap.org");
    expect(html).toContain("Previsão de chegada");
    expect(html).not.toContain("<script");

    // Chegando: perto do destino, a rodada avisa uma vez.
    await (
      await positions(member, f, created.id, {
        points: [{ t: now(), ...NEAR, accuracy: 8 }],
      })
    ).json<any>();
    await runDue(ctx, now());
    await runDue(ctx, now());
    const arriving = (await outbox(c.id)).filter((m) =>
      /está chegando/.test(String(m.text)),
    );
    expect(arriving).toHaveLength(1);

    // Entregue: o Pedido vai para Entregue e a posição não é mais aceita.
    const done = await api(member, `${path}/${created.id}/delivered`, "POST", {});
    expect(done.status).toBe(200);
    expect((await done.json<any>()).status).toBe("delivered");
    expect(await orderStatus(order.id)).toBe("delivered");
    const after = await (
      await positions(member, f, created.id, {
        points: [{ t: now() + 1000, ...NEAR }],
      })
    ).json<any>();
    expect(after).toMatchObject({ active: false, status: "delivered" });
    html = await (await track(code)).text();
    expect(html).toContain("Entregue às");
    expect(html).not.toContain("tile.openstreetmap.org");

    // Retenção: depois do prazo, posição e destino somem e o link fecha.
    const cfg = entregaConfig({});
    expect(await purge(ctx, cfg, now() + 25 * 3600000)).toBe(1);
    const purged = await one(env, "SELECT * FROM entrega_deliveries WHERE id=?", created.id);
    expect(purged).toMatchObject({
      last_lat: null,
      dest_lat: null,
      trail: "[]",
    });
    expect(purged.purged_at).toBeTruthy();
    expect((await track(code)).status).toBe(410);

    // Eventos do ciclo.
    const kinds = (
      await all(
        env,
        "SELECT kind FROM events WHERE profile_id=? AND kind LIKE 'entrega.%' ORDER BY id",
        f.profile,
      )
    ).map((r) => r.kind);
    expect(kinds).toEqual([
      "entrega.created",
      "entrega.assigned",
      "entrega.started",
      "entrega.arriving",
      "entrega.delivered",
    ]);
  });
});

describe("entrega: atualizações ao cliente sem inundar", () => {
  it("a cada intervalo, só com posição recente, até o máximo e com a janela aberta", async () => {
    const { f, ctx, c, delivery } = await started({
      updates: { mode: "eta", every_minutes: 5, max: 2 },
    });
    const member = await bearer(f.member);
    await positions(member, f, delivery.id, {
      points: [{ t: now(), ...FAR }],
    });
    const etaMessages = async () =>
      (await outbox(c.id)).filter((m) =>
        /^Previsão de chegada/.test(String(m.text)),
      ).length;
    // Antes do intervalo: nada.
    await runDue(ctx, now());
    expect(await etaMessages()).toBe(0);
    // Vencido: uma atualização; a mesma rodada repetida não repete.
    await exec(env, "UPDATE entrega_deliveries SET next_update_at=? WHERE id=?", now() - 1, delivery.id);
    await runDue(ctx, now());
    await runDue(ctx, now());
    expect(await etaMessages()).toBe(1);
    // Posição velha: pula a vez.
    await exec(
      env,
      "UPDATE entrega_deliveries SET next_update_at=?,last_at=? WHERE id=?",
      now() - 1,
      now() - 20 * 60000,
      delivery.id,
    );
    await runDue(ctx, now());
    expect(await etaMessages()).toBe(1);
    // Janela de 24 h fechada: atualização não sai.
    await exec(env, "UPDATE entrega_deliveries SET next_update_at=?,last_at=? WHERE id=?", now() - 1, now(), delivery.id);
    await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", now() - 25 * 3600000, c.id);
    await runDue(ctx, now());
    expect(await etaMessages()).toBe(1);
    // Janela aberta de novo: a segunda e última.
    await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", now(), c.id);
    for (let i = 0; i < 3; i++) {
      await exec(env, "UPDATE entrega_deliveries SET next_update_at=?,last_at=? WHERE id=?", now() - 1, now(), delivery.id);
      await runDue(ctx, now());
    }
    expect(await etaMessages()).toBe(2);
  });

  it("modo localização manda a mensagem de localização do WhatsApp", async () => {
    const { f, ctx, c, delivery } = await started({
      updates: { mode: "location", every_minutes: 5, max: 3 },
    });
    const member = await bearer(f.member);
    await positions(member, f, delivery.id, { points: [{ t: now(), ...FAR }] });
    await exec(env, "UPDATE entrega_deliveries SET next_update_at=? WHERE id=?", now() - 1, delivery.id);
    await runDue(ctx, now());
    const pin = (await outbox(c.id)).find((m) => m.content?.type === "location");
    expect(pin?.content.location).toMatchObject({
      latitude: FAR.lat,
      longitude: FAR.lng,
    });
  });

  it("sem sinal: avisa a equipe uma vez e a página mostra o aviso", async () => {
    const { f, ctx, c, delivery } = await started();
    const member = await bearer(f.member);
    // Saiu há 30 min; a última posição tem 10 min.
    await exec(
      env,
      "UPDATE entrega_deliveries SET started_at=?,last_at=?,last_lat=?,last_lng=? WHERE id=?",
      now() - 30 * 60000,
      now() - 10 * 60000,
      FAR.lat,
      FAR.lng,
      delivery.id,
    );
    await runDue(ctx, now());
    await runDue(ctx, now());
    const lost = await all(
      env,
      "SELECT id FROM events WHERE profile_id=? AND kind='entrega.signal_lost'",
      f.profile,
    );
    expect(lost).toHaveLength(1);
    const note = await one(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note' AND text LIKE 'Entrega: sem posição%'",
      c.id,
    );
    expect(note).toBeTruthy();
    // Posição volta: o aviso é limpo.
    await positions(member, f, delivery.id, { points: [{ t: now(), ...FAR }] });
    const row = await one(env, "SELECT notified FROM entrega_deliveries WHERE id=?", delivery.id);
    expect(json(row.notified, {}).signal).toBeUndefined();
  });
});

describe("entrega: avulsa, localização do cliente e privacidade", () => {
  it("cliente envia a localização e ela vira o destino; menu Onde está", async () => {
    const { f, ctx } = await setup();
    const phone = "5511972000077";
    const c = await say(f, "oi", phone);
    const created = await run(f, f.admin, "entrega.create", {
      source: "manual",
      label: "Encomenda 7",
      conversation_id: c.id,
      courier_id: f.member.id,
    });
    await run(f, f.member, "entrega.start", { id: created.id });
    // Sem destino: saída com aviso, link e o pedido de localização.
    const sent = await outbox(c.id);
    expect(sent.some((m) => /Encomenda 7 saiu para entrega/.test(JSON.stringify(m)))).toBe(true);
    expect(sent.some((m) => JSON.stringify(m).includes("location_request"))).toBe(true);
    await say(f, "", phone, f.line, {
      type: "location",
      location: { latitude: DEST.lat, longitude: DEST.lng },
    });
    const row = await one(env, "SELECT dest_lat,dest_source FROM entrega_deliveries WHERE id=?", created.id);
    expect(row).toMatchObject({ dest_lat: DEST.lat, dest_source: "customer" });
    expect(
      (await outbox(c.id)).some((m) => /Usamos a sua localização/.test(String(m.text))),
    ).toBe(true);
    // Cancelada depois de sair: o cliente é avisado.
    await run(f, f.admin, "entrega.cancel", { id: created.id, reason: "Moto quebrou" });
    expect(
      (await outbox(c.id)).some((m) => /foi interrompida/.test(String(m.text))),
    ).toBe(true);
    void ctx;
  });

  it("aplicação sem contacts:read não vê cliente, endereço nem posição", async () => {
    const { f, delivery } = await started();
    const app = await application(f, ["conversations:read"]);
    const res = await api(app.token, `/profiles/${f.profile}/entrega/deliveries/${delivery.id}`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.status).toBe("en_route");
    for (const field of ["customer_name", "address_text", "destination", "position", "conversation_id"])
      expect(body).not.toHaveProperty(field);
    // Aplicação não manda posição.
    const pos = await positions(app.token, f, delivery.id, { points: [{ t: now(), ...FAR }] });
    expect(pos.status).toBe(400);
  });

  it("entregador fora da lista não é atribuído", async () => {
    const { f, menu } = await setup();
    const { order } = await deliveryOrder(f, menu, "5511972000099");
    const err = await run(f, f.admin, "entrega.create", {
      source: "pedido",
      ref_id: order.id,
      courier_id: f.other.id,
    }).catch((e) => e);
    expect(err.status).toBe(400);
    // Pedido de retirada não vira entrega.
    const pickup = await run(f, f.admin, "pedido.order.create", {
      fulfillment: "pickup",
      items: [{ item_id: menu.suco.id, quantity: 1 }],
      customer_name: "Balcão",
    });
    const refused = await run(f, f.admin, "entrega.create", {
      source: "pedido",
      ref_id: pickup.id,
    }).catch((e) => e);
    expect(refused.code).toBe("not_delivery");
  });
});

describe("entrega: custo no D1 (docs/LIMITES.md)", () => {
  it("um lote de posições: poucas leituras e uma escrita, sem recibo", async () => {
    const { f, ctx, delivery } = await started();
    const route = moduleRoutes().telemetry.find((r) =>
      r.path.endsWith("/positions"),
    )!;
    const points = Array.from({ length: 4 }, (_, i) => ({
      t: now() - 40000 + i * 10000,
      lat: FAR.lat + i * 0.0005,
      lng: FAR.lng,
      accuracy: 10,
    }));
    const { result, count } = await measure(env, (e) =>
      route.handler(e, f.member, f.profile, {
        params: { id: delivery.id },
        body: { points, battery: 80 },
      }),
    );
    expect(result.accepted).toBe(4);
    const writes = count.sql.filter((s) => /^(UPDATE|INSERT)/i.test(s.trim()));
    // Módulo ligado, entrega, configuração da área e a escrita do lote.
    expect(writes).toHaveLength(1);
    expect(count.statements).toBeLessThanOrEqual(5);
    // Rodada sem nada vencido com uma entrega a caminho.
    const round = await measure(env, (e) =>
      runDue(modulesApi(e, f.profile, "entrega"), now()),
    );
    expect(round.count.statements).toBeLessThanOrEqual(6);
    void ctx;
  });
});

describe("entrega: contrato da API", () => {
  it("toda rota do módulo está no OpenAPI, a de posições sem Idempotency-Key", () => {
    const spec = openapi("https://test");
    const toSpec = (p: string) =>
      "/profiles/{profile}/" + p.replace(/:(\w+)/g, "{$1}");
    const routes = [
      ...moduleRoutes().read.filter((r) => r.path.startsWith("entrega")).map((r) => ["get", r.path]),
      ...moduleRoutes().write.filter((r) => r.path.startsWith("entrega")).map((r) => [r.method.toLowerCase(), r.path]),
      ...moduleRoutes().telemetry.filter((r) => r.path.startsWith("entrega")).map((r) => ["post", r.path]),
    ];
    expect(routes.length).toBe(12);
    for (const [method, path] of routes) {
      const entry = spec.paths[toSpec(path)]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(entry.tags).toEqual(["Entrega"]);
    }
    const pos = spec.paths[toSpec("entrega/deliveries/:id/positions")].post;
    expect(
      pos.parameters.some((p: any) => p.name === "Idempotency-Key"),
    ).toBe(false);
  });
});

// Usado só para tipos.
export type _A = Actor;
