import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation } from "../src/service";
import { json, now } from "../src/types";
import { modulesApi, onWebStepCompleted } from "../src/modules/api";
import {
  cartSummary,
  validateCartOrder,
  validateCatalog,
} from "../src/web-cart";
import {
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

// Lanchonete de exemplo.
const catalog = {
  categories: [
    {
      id: "lanches",
      name: "Lanches",
      items: [
        {
          id: "xburger",
          name: "X-Burger",
          description: "Pão, carne 150 g e queijo",
          price_cents: 2500,
          image_url: "https://img.example.com/x.jpg",
          option_groups: [
            {
              id: "ponto",
              name: "Ponto da carne",
              min: 1,
              max: 1,
              options: [
                { id: "mal", name: "Mal passada" },
                { id: "bem", name: "Bem passada" },
              ],
            },
            {
              id: "adicionais",
              name: "Adicionais",
              min: 0,
              max: 2,
              options: [
                { id: "bacon", name: "Bacon", price_cents: 500 },
                { id: "ovo", name: "Ovo", price_cents: 300 },
                {
                  id: "cheddar",
                  name: "Cheddar",
                  price_cents: 400,
                  available: false,
                },
              ],
            },
          ],
        },
        {
          id: "misto",
          name: "Misto quente",
          price_cents: 1200,
          available: false,
        },
      ],
    },
    {
      id: "bebidas",
      name: "Bebidas",
      items: [
        {
          id: "suco",
          name: "Suco de laranja",
          price_cents: 800,
          max_quantity: 5,
        },
      ],
    },
  ],
  fulfillment: {
    pickup: true,
    delivery: true,
    delivery_fee_cents: 700,
    minimum_cents: 2000,
    eta: "Pronto em 30 min",
  },
};
const order = (fields: Record<string, string | string[]>) => {
  const input: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fields))
    input[k] = Array.isArray(v) ? v : [v];
  return input;
};
const good = {
  q_xburger: "2",
  o_xburger_ponto: "bem",
  o_xburger_adicionais: ["bacon", "ovo"],
  n_xburger: "sem cebola",
  q_suco: "1",
  fulfillment: "delivery",
  street: "Rua A, 10",
  district: "Centro",
  name: "Ana",
  note: "Interfone 12",
};

describe("carrinho: catálogo e cálculo no servidor", () => {
  it("valida o catálogo", () => {
    const ok = validateCatalog(catalog);
    expect(ok.categories[0].items[0].max_quantity).toBe(20);
    expect(ok.categories[0].items[1].available).toBe(false);
    const bad = (patch: any) => () => validateCatalog({ ...catalog, ...patch });
    expect(bad({ categories: [] })).toThrow(/1 a 30 categorias/);
    expect(bad({ fulfillment: { pickup: false, delivery: false } })).toThrow(
      /retirada, entrega/,
    );
    expect(
      bad({
        categories: [
          {
            id: "c",
            name: "C",
            items: [
              {
                id: "a",
                name: "A",
                price_cents: 1,
                image_url: "http://x.com/a.jpg",
              },
            ],
          },
        ],
      }),
    ).toThrow(/HTTPS/);
    expect(
      bad({
        categories: [
          {
            id: "c",
            name: "C",
            items: [
              { id: "a", name: "A", price_cents: 1 },
              { id: "a", name: "B", price_cents: 1 },
            ],
          },
        ],
      }),
    ).toThrow(/repetido/);
    expect(
      bad({
        categories: [
          {
            id: "c",
            name: "C",
            items: [{ id: "a", name: "A", price_cents: 1.5 }],
          },
        ],
      }),
    ).toThrow(/centavos/);
  });

  it("calcula linhas, adicionais, entrega e total a partir do catálogo", () => {
    const cart = validateCatalog(catalog);
    const v = validateCartOrder(
      cart,
      order({ ...good, total: "1", subtotal_cents: "1" }),
    );
    expect(v.ok).toBe(true);
    expect(v.order.lines).toEqual([
      expect.objectContaining({
        item_id: "xburger",
        quantity: 2,
        unit_cents: 2500 + 500 + 300,
        total_cents: 6600,
        note: "sem cebola",
      }),
      expect.objectContaining({
        item_id: "suco",
        quantity: 1,
        total_cents: 800,
      }),
    ]);
    expect(v.order).toMatchObject({
      subtotal_cents: 7400,
      delivery_fee_cents: 700,
      total_cents: 8100,
      fulfillment: "delivery",
      address: { street: "Rua A, 10", district: "Centro" },
      customer_name: "Ana",
    });
    expect(cartSummary(v.order)).toMatch(
      /2x X-Burger \(Bem passada, Bacon, Ovo\) — sem cebola: R\$\s66,00/,
    );
    expect(cartSummary(v.order)).toMatch(/Total: R\$\s81,00/);
    // Retirada: sem taxa.
    expect(
      validateCartOrder(cart, order({ ...good, fulfillment: "pickup" })).order
        .total_cents,
    ).toBe(7400);
  });

  it("recusa ponto ausente, adicional indisponível, item indisponível, quantidade e mínimo", () => {
    const cart = validateCatalog(catalog);
    const errors = (fields: any) =>
      validateCartOrder(cart, order(fields)).errors;
    expect(errors({ ...good, o_xburger_ponto: [] })["item:xburger"]).toMatch(
      /Escolha 1 em Ponto/,
    );
    expect(
      errors({ ...good, o_xburger_adicionais: ["cheddar"] })["item:xburger"],
    ).toMatch(/indisponível/);
    expect(
      errors({ ...good, o_xburger_adicionais: ["bacon", "ovo", "x"] })[
        "item:xburger"
      ],
    ).toMatch(/inválida/);
    expect(errors({ ...good, q_misto: "1" })["item:misto"]).toMatch(
      /indisponível/,
    );
    expect(errors({ ...good, q_suco: "6" })["item:suco"]).toMatch(/Até 5/);
    expect(
      errors({ q_suco: "1", fulfillment: "pickup", name: "Ana" }).cart,
    ).toMatch(/Pedido mínimo/);
    expect(errors({ ...good, street: "" }).street).toBeTruthy();
    expect(errors({ ...good, name: "" }).name).toBeTruthy();
    expect(errors({ fulfillment: "pickup", name: "Ana" }).cart).toMatch(
      /ao menos um item/,
    );
  });
});

describe("carrinho: página pública e conclusão", () => {
  const seen: any[] = [];
  onWebStepCompleted("forms", async (_ctx, step, answers) => {
    if (step.page === "cart") seen.push(answers);
  });

  async function setup() {
    const f: Fixture = await fixture();
    await exec(
      env,
      "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://x.example.com',?)",
      now(),
    );
    const r = await receive(f, f.line, "quero pedir", "5511991000001");
    await drain(f);
    const c = await conversation(env, r.id, f.profile);
    const opened = await modulesApi(env, f.profile, "forms").openWebStep(c, {
      kind: "cart",
      ref: "cardapio",
      trigger: "module",
      actor: "system",
      sourceKey: "cardapio-1",
      button: "Fazer pedido",
      spec: {
        page: "cart",
        title: "Lanchonete da Ana",
        fields: [],
        cart: catalog as any,
      },
    });
    const url = opened.url!.replace("https://x.example.com", "https://test");
    return { f, c, url, step: opened.step };
  }
  const post = (url: string, fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields))
      for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
    return SELF.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  };

  it("monta, revisa com o total do servidor, confirma uma vez e entrega o pedido ao módulo", async () => {
    const { f, c, url, step } = await setup();
    const pageResponse = await SELF.fetch(url);
    expect(pageResponse.headers.get("Content-Security-Policy")).toContain(
      "img-src https:",
    );
    const html = await pageResponse.text();
    expect(html).toContain("X-Burger");
    expect(html).toMatch(/R\$\s25,00/);
    expect(html).toContain('name="q_xburger"');
    expect(html).toContain('type="radio" name="o_xburger_ponto"');
    expect(html).not.toContain('name="q_misto"'); // indisponível: sem quantidade
    expect(html).not.toContain("<script");

    // Incompleto: volta com os erros, nada muda.
    const bad = await post(url, { ...good, o_xburger_ponto: [] });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain("Escolha 1 em Ponto da carne");

    // Revisão: total calculado no servidor; valores forjados são ignorados.
    const review = await post(url, {
      ...good,
      total_cents: "100",
      unit_cents: "1",
    });
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Confira seu pedido");
    expect(reviewHtml).toMatch(/Total<\/td><td>R\$\s81,00/);
    expect(
      (await one(env, "SELECT status FROM web_steps WHERE id=?", step.id))
        .status,
    ).toBe("opened");

    // Voltar e alterar mantém as escolhas.
    const edit = await post(url, { ...good, step: "edit" });
    expect(await edit.text()).toContain('value="sem cebola"');

    // Confirmar.
    const done = await post(url, { ...good, confirm: "1" });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Pedido enviado!");
    const row = await one(env, "SELECT * FROM web_steps WHERE id=?", step.id);
    expect(row.status).toBe("completed");
    expect(json(row.result)).toMatchObject({
      type: "cart",
      total_cents: 8100,
      item_count: 3,
    });
    expect(seen.at(-1)).toMatchObject({
      total_cents: 8100,
      customer_name: "Ana",
    });
    expect((await latest(c.id)).text).toMatch(
      /^Recebemos seu pedido\. Total: R\$\s81,00\.$/,
    );
    const note = await one(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note' ORDER BY created DESC LIMIT 1",
      c.id,
    );
    expect(note.text).toContain("pedido enviado pelo cliente");
    expect(note.text).toContain("Entrega: Rua A, 10, Centro");

    // Uso único.
    const again = await post(url, { ...good, confirm: "1" });
    expect(again.status).toBe(410);
    expect((await post(url, good)).status).toBe(410);
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='web_step.completed'",
        f.profile,
      ),
    ).toHaveLength(1);
  });

  it("link vencido não revisa nem conclui", async () => {
    const { url, step } = await setup();
    await exec(
      env,
      "UPDATE web_steps SET expires_at=? WHERE id=?",
      now() - 1000,
      step.id,
    );
    expect((await post(url, good)).status).toBe(410);
    expect((await post(url, { ...good, confirm: "1" })).status).toBe(410);
  });
});
