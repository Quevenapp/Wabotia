// Endereço da entrega para o app do entregador: campos separados, cidade e UF
// da loja quando o pedido não as tem, a loja como referência de busca e a
// localização do cliente como destino (achado no iPhone X e no iPad: "Rua das
// Flores, 200" sem cidade caía no Porto, em Portugal).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { perform } from "../src/service";
import { json, uid } from "../src/types";
import { completeAddress, formatAddress, readAddress } from "../src/modules/entrega/address";
import { addressExtras } from "../src/modules/pedido/address";
import { bearer, drain, latest, outbox, receive, type Fixture } from "./service-center-fixture";
import { MENUS, codeIn, pedidoSetup, run, say, seedMenu, submitCart } from "./pedido-fixture";

const STORE_POS = { lat: -22.9056, lng: -47.0608 };

async function setup(establishment: Record<string, unknown> | null) {
  const { f } = await pedidoSetup({
    menus: MENUS,
    config: {
      store_name: "Lanchonete da Ana",
      delivery: true,
      delivery_fee_cents: 700,
      payments: { cash: false, card: true },
    },
  });
  await perform(env, f.admin, f.profile, "module.set", { id: "entrega", enabled: true }, uid());
  await run(f, f.admin, "user.update", { id: f.member.id, access: ["*", "entrega:courier"] });
  (f.member as any).access = ["*", "entrega:courier"];
  // Pela API de Gestão (PUT /settings), com a validação do núcleo.
  if (establishment) await run(f, f.admin, "settings", { establishment });
  const menu = await seedMenu(f);
  return { f, menu };
}

/** Pedido com entrega pelo carrinho, só rua e número e bairro (sem cidade). */
async function cartOrder(f: Fixture, menu: Awaited<ReturnType<typeof seedMenu>>, phone: string) {
  await say(f, "oi", phone);
  const c = await say(f, "1", phone);
  const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
  await submitCart(codeIn(link.text), {
    [`q_${menu.suco.id}`]: "1",
    fulfillment: "delivery",
    name: "Caio",
    street: "Rua das Flores, 200",
    district: "Centro",
    confirm: "1",
  });
  const order = await one(env, "SELECT * FROM pedido_orders WHERE conversation_id=? ORDER BY number DESC LIMIT 1", c.id);
  return { c, order };
}

const courierView = async (f: Fixture, id: string) =>
  (
    await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/entrega/deliveries/${id}/courier`, {
      headers: { Authorization: "Bearer " + (await bearer(f.member)) },
    })
  ).json<any>();

describe("entrega: endereço completo para o app do entregador", () => {
  it("sem cidade no pedido: completa com a da loja, manda os campos separados e a loja como referência", async () => {
    const { f, menu } = await setup({
      name: "Lanchonete da Ana",
      address: "Av. Brasil, 10 - Centro, Campinas - SP",
      city: "Campinas",
      state: "SP",
      latitude: STORE_POS.lat,
      longitude: STORE_POS.lng,
    });
    const { order } = await cartOrder(f, menu, "5511973" + String(Math.random()).slice(2, 8));
    // O pedido já sai com a cidade da loja.
    expect(json(order.address)).toMatchObject({ street: "Rua das Flores, 200", district: "Centro", city: "Campinas", state: "SP" });
    const created = await run(f, f.admin, "entrega.create", { source: "pedido", ref_id: order.id, courier_id: f.member.id });
    expect(created.address).toEqual({
      street: "Rua das Flores, 200",
      number: "",
      complement: "",
      district: "Centro",
      city: "Campinas",
      state: "SP",
      postal_code: "",
      reference: "",
    });
    expect(created.address_text).toBe("Rua das Flores, 200 - Centro, Campinas - SP");
    expect(created.address_incomplete).toBe(false);
    expect(created.destination).toBeNull();
    const view = await courierView(f, created.id);
    expect(view.address.city).toBe("Campinas");
    expect(view.address_incomplete).toBe(false);
    expect(view.store).toEqual({ name: "Lanchonete da Ana", city: "Campinas", state: "SP", position: STORE_POS });
    // A configuração do app também leva a loja.
    const cfg = await api(f, "GET", "/entrega");
    expect(cfg.store.position).toEqual(STORE_POS);
  });

  it("sem cidade no pedido nem na loja: manda como hoje e marca address_incomplete", async () => {
    const { f, menu } = await setup(null);
    const { order } = await cartOrder(f, menu, "5511974" + String(Math.random()).slice(2, 8));
    const created = await run(f, f.admin, "entrega.create", { source: "pedido", ref_id: order.id, courier_id: f.member.id });
    expect(created.address_text).toBe("Rua das Flores, 200 - Centro");
    expect(created.address.city).toBe("");
    expect(created.address_incomplete).toBe(true);
    const view = await courierView(f, created.id);
    expect(view.address_incomplete).toBe(true);
    expect(view.store.position).toBeNull();
  });

  it("localização mandada antes da entrega existir: o pedido guarda e a entrega já nasce com o destino", async () => {
    const { f, menu } = await setup({ city: "Campinas", state: "SP" });
    const phone = "5511975" + String(Math.random()).slice(2, 8);
    const { c, order } = await cartOrder(f, menu, phone);
    await say(f, "", phone, f.line, {
      type: "location",
      location: { latitude: -22.91, longitude: -47.05, name: "Casa" },
    });
    expect((await latest(c.id)).text).toContain("Vamos usar a sua localização para a entrega");
    const saved = json((await one(env, "SELECT address FROM pedido_orders WHERE id=?", order.id)).address);
    expect([saved.lat, saved.lng]).toEqual([-22.91, -47.05]);
    const created = await run(f, f.admin, "entrega.create", { source: "pedido", ref_id: order.id, courier_id: f.member.id });
    expect(created.destination).toEqual({ lat: -22.91, lng: -47.05, source: "customer" });
    expect(created.address_incomplete).toBe(false);
    // Com a entrega aberta, a próxima localização é do módulo Entrega (o pedido não muda).
    await say(f, "", phone, f.line, { type: "location", location: { latitude: -22.92, longitude: -47.06 } });
    const after = json((await one(env, "SELECT address FROM pedido_orders WHERE id=?", order.id)).address);
    expect([after.lat, after.lng]).toEqual([-22.91, -47.05]);
  });

  it("localização no lugar do endereço digitado (catálogo da Meta): vira o endereço com as coordenadas", async () => {
    const { f } = await setup({ city: "Campinas", state: "SP" });
    const phone = "5511976" + String(Math.random()).slice(2, 8);
    await say(f, "Pedido pelo catálogo", phone, f.line, {
      type: "order",
      order: {
        catalog_id: "cat-1",
        items: [{ product_retailer_id: "SUCO-500", quantity: 3, item_price: 1, currency: "BRL" }],
      },
    });
    await receive(f, f.line, "Entrega", phone, { interactive_reply_id: "pedido:receber:delivery" });
    await drain(f);
    await say(f, "", phone, f.line, {
      type: "location",
      location: { latitude: -22.9, longitude: -47.07, name: "Portaria", address: "Rua das Flores, 200 - Centro" },
    });
    const order = await one(env, "SELECT * FROM pedido_orders WHERE profile_id=? ORDER BY number DESC LIMIT 1", f.profile);
    expect(json(order.address)).toMatchObject({
      street: "Rua das Flores, 200 - Centro",
      reference: "Portaria",
      city: "Campinas",
      state: "SP",
      lat: -22.9,
      lng: -47.07,
    });
  });

  it("pedido manual: número, cidade, UF, CEP e localização validados; sem cidade, a da loja", async () => {
    expect(addressExtras({ number: "200", state: "sp", postal_code: "13010-000" })).toEqual({
      number: "200",
      state: "SP",
      postal_code: "13010000",
    });
    expect(() => addressExtras({ state: "XX" })).toThrow(/UF/);
    expect(() => addressExtras({ postal_code: "123" })).toThrow(/CEP/);
    expect(() => addressExtras({ lat: -22.9 })).toThrow(/lat e lng/);
    // Texto livre que já cita a cidade da loja não ganha a cidade de novo.
    expect(completeAddress(null, "Rua X, 1, Campinas", { city: "Campinas", state: "SP" }).address_text).toBe("Rua X, 1, Campinas");
    expect(completeAddress(null, "Rua X, 1", { city: "Campinas", state: "SP" }).address_text).toBe("Rua X, 1, Campinas - SP");
    expect(formatAddress(readAddress({ street: "Rua X", number: "1", district: "Centro", city: "Campinas", state: "SP", reference: "fundos" })!)).toBe(
      "Rua X, 1 - Centro, Campinas - SP (fundos)",
    );
  });
});

describe("estabelecimento: endereço estruturado e posição da loja", () => {
  it("valida, monta o endereço só para leitura, guarda o texto livre e expõe a posição", async () => {
    const { f } = await setup({
      name: "Lanchonete da Ana",
      address: "Texto livre antigo",
      street: "Av. Brasil",
      number: "10",
      district: "Centro",
      city: "Campinas",
      state: "sp",
      postal_code: "13010-000",
      municipality_code: "3509502",
      latitude: STORE_POS.lat,
      longitude: STORE_POS.lng,
    });
    const est = await api(f, "GET", "/establishment");
    expect(est).toMatchObject({
      address: "Av. Brasil, 10 - Centro, Campinas/SP, CEP 13010-000",
      address_free: "Texto livre antigo",
      state: "SP",
      postal_code: "13010000",
      municipality_code: "3509502",
      position: STORE_POS,
    });
    // Limpou rua e cidade: volta o texto livre, sem perda.
    await run(f, f.admin, "settings", { establishment: { name: "Lanchonete da Ana", address: "Texto livre antigo" } });
    const back = await api(f, "GET", "/establishment");
    expect([back.address, back.position, back.city]).toEqual(["Texto livre antigo", null, ""]);
    for (const [bad, message] of [
      [{ state: "XX" }, /UF/],
      [{ postal_code: "123" }, /CEP/],
      [{ state: "RJ", municipality_code: "3509502" }, /IBGE/],
      [{ latitude: -22.9 }, /latitude/],
      [{ latitude: 91, longitude: 0 }, /latitude/],
    ] as const)
      await expect(run(f, f.admin, "settings", { establishment: bad })).rejects.toThrow(message);
  });

  it("formulário do carrinho: cidade e UF da loja já preenchidas; o cliente troca; UF validada", async () => {
    const { f, menu } = await setup({ city: "Campinas", state: "SP" });
    const phone = "5511977" + String(Math.random()).slice(2, 8);
    await say(f, "oi", phone);
    const c = await say(f, "1", phone);
    const code = codeIn((await outbox(c.id)).find((m) => codeIn(String(m.text)))!.text);
    const html = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    expect(html).toContain('name="city" maxlength="100" value="Campinas"');
    expect(html).toContain('name="state" maxlength="2" value="SP"');
    const fields = {
      [`q_${menu.suco.id}`]: "1",
      fulfillment: "delivery",
      name: "Caio",
      street: "Rua das Flores, 200",
      district: "Centro",
    };
    const refused = await submitCart(code, { ...fields, city: "Valinhos", state: "XX", confirm: "1" });
    expect(await refused.text()).toContain("UF: use a sigla do estado");
    await submitCart(code, { ...fields, city: "Valinhos", state: "sp", confirm: "1" });
    const order = await one(env, "SELECT address FROM pedido_orders WHERE conversation_id=? ORDER BY number DESC LIMIT 1", c.id);
    expect(json(order.address)).toMatchObject({ city: "Valinhos", state: "SP" });
  });
});

const api = async (f: Fixture, method: string, path: string) =>
  (
    await SELF.fetch(`https://test/api/v1/profiles/${f.profile}${path}`, {
      method,
      headers: { Authorization: "Bearer " + (await bearer(f.member)) },
    })
  ).json<any>();
