import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { uid } from "../src/types";
import { validGtin, validateFiscal } from "../src/modules/vendas/model";
import { api, bearer } from "./service-center-fixture";
import { cash, failure, run, seedCatalog, vendasSetup } from "./vendas-fixture";

const stock = async (id: string) =>
  (await one(env, "SELECT stock_milli FROM vendas_products WHERE id=?", id))!
    .stock_milli as number;
const moves = (id: string) =>
  all(env, "SELECT * FROM vendas_stock_moves WHERE product_id=? ORDER BY created,rowid", id);

describe("vendas: catálogo", () => {
  it("valida código de barras, dados fiscais e códigos repetidos", async () => {
    expect(validGtin("7894900011517")).toBe(true);
    expect(validGtin("7894900011518")).toBe(false);
    expect(validGtin("96385074")).toBe(true);
    expect(validateFiscal({ ncm: "2202.10.00", icms_csosn: "102", pis_rate: 1.65 })).toEqual({
      ncm: "22021000",
      icms_csosn: "102",
      pis_rate: 1.65,
    });
    expect(() => validateFiscal({ ncm: "123" })).toThrow(/NCM/);
    expect(() => validateFiscal({ icms_cst: "00", icms_csosn: "102" })).toThrow(/não os dois/);
    expect(() => validateFiscal({ cfop: "9999" })).toThrow(/CFOP/);
    expect(() => validateFiscal({ origin: 9 })).toThrow(/Origem/);
    expect(() => validateFiscal({ icms_csosn: "105" })).toThrow(/CSOSN/);
    expect(() => validateFiscal({ nada: 1 })).toThrow(/desconhecido/);

    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    expect(p.refri).toMatchObject({
      ean: "7894900011517",
      stock: 10,
      unit: "UN",
      fiscal: { ncm: "22021000", cest: "0300700", cfop: "5405", icms_csosn: "500" },
    });
    expect(p.queijo).toMatchObject({ unit: "KG", fractional: true, stock: 3.5 });
    expect(p.agua).toMatchObject({ track_stock: false, stock: null });
    expect(
      await failure(
        run(f, f.admin, "vendas.product.save", { name: "X", price_cents: 1, ean: "7894900011518" }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await failure(
        run(f, f.admin, "vendas.product.save", { name: "X", price_cents: 1, sku: "REF-350" }),
      ),
    ).toMatchObject({ status: 409, code: "sku_taken" });
    // Equipe não cadastra produto; o saldo de um produto existente não muda pelo cadastro.
    expect(
      await failure(run(f, f.member, "vendas.product.save", { name: "X", price_cents: 1 })),
    ).toMatchObject({ status: 403, code: "admin_required" });
    expect(
      await failure(run(f, f.admin, "vendas.product.save", { id: p.cafe.id, stock: 50 })),
    ).toMatchObject({ status: 400 });
    // Fracionado só com unidade que aceita: 1,5 un recusado.
    expect(
      await failure(
        run(f, f.member, "vendas.sale.create", {
          lines: [{ product_id: p.cafe.id, quantity: 1.5 }],
          payments: cash(10000),
        }),
      ),
    ).toMatchObject({ status: 400 });
    // Leitor de código de barras e arquivamento.
    const token = await bearer(f.member);
    const found = await (
      await api(token, `/profiles/${f.profile}/vendas/lookup?code=7894900011517`)
    ).json<any>();
    expect(found.id).toBe(p.refri.id);
    expect(
      (await api(token, `/profiles/${f.profile}/vendas/lookup?code=000`)).status,
    ).toBe(404);
    await run(f, f.admin, "vendas.sale.create", {
      lines: [{ product_id: p.agua.id, quantity: 1 }],
      payments: cash(300),
    });
    expect(await run(f, f.admin, "vendas.product.delete", { id: p.agua.id })).toMatchObject({
      archived: true,
    });
    expect(
      await failure(
        run(f, f.admin, "vendas.sale.create", {
          lines: [{ product_id: p.agua.id, quantity: 1 }],
          payments: cash(300),
        }),
      ),
    ).toMatchObject({ code: "product_inactive" });
  });
});

describe("vendas: estoque", () => {
  it("duas vendas simultâneas da última unidade: só uma passa, sem saldo negativo", async () => {
    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    await run(f, f.admin, "vendas.stock.move", {
      type: "ajuste",
      items: [{ product_id: p.cafe.id, quantity: 1 }],
    });
    // Direto no serviço, sem a fila do Coordinator: só o banco segura.
    const results = await Promise.allSettled(
      [f.member, f.other, f.admin].map((actor) =>
        run(f, actor, "vendas.sale.create", {
          lines: [{ product_id: p.cafe.id, quantity: 1 }],
          payments: cash(1890),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason.code);
    expect(errors).toEqual(["out_of_stock", "out_of_stock"]);
    expect(await stock(p.cafe.id)).toBe(0);
    const sales = await all(env, "SELECT number FROM vendas_sales WHERE profile_id=?", f.profile);
    expect(sales.map((s) => s.number)).toEqual([1]);

    // Pela API (o Coordinator serializa): reposição de 2 e três pedidos de 1.
    await run(f, f.member, "vendas.stock.move", {
      type: "entrada",
      items: [{ product_id: p.cafe.id, quantity: 2, cost_cents: 1200 }],
    });
    const token = await bearer(f.member);
    const statuses = await Promise.all(
      [1, 2, 3].map(() =>
        api(token, `/profiles/${f.profile}/vendas/sales`, "POST", {
          lines: [{ product_id: p.cafe.id, quantity: 1 }],
          payments: cash(1890),
        }).then((r) => r.status),
      ),
    );
    expect(statuses.sort()).toEqual([200, 200, 409]);
    expect(await stock(p.cafe.id)).toBe(0);
    expect((await one(env, "SELECT cost_cents FROM vendas_products WHERE id=?", p.cafe.id))!.cost_cents).toBe(1200);
  });

  it("venda com um item sem saldo não grava nada (nem número, nem baixa dos outros)", async () => {
    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    const err = await failure(
      run(f, f.member, "vendas.sale.create", {
        lines: [
          { product_id: p.refri.id, quantity: 3 },
          { product_id: p.cafe.id, quantity: 5 },
        ],
        payments: cash(20000),
      }),
    );
    expect(err).toMatchObject({ status: 409, code: "out_of_stock" });
    expect(err.message).toContain("Café 500 g");
    expect(await stock(p.refri.id)).toBe(10000);
    expect(await moves(p.refri.id)).toHaveLength(1); // só o saldo inicial
    const sale = await run(f, f.member, "vendas.sale.create", {
      lines: [{ product_id: p.refri.id, quantity: 3 }],
      payments: cash(2000),
    });
    expect(sale).toMatchObject({ number: 1, total_cents: 1800, change_cents: 200, status: "completed" });
  });

  it("mesma Idempotency-Key e mesma origem não baixam duas vezes", async () => {
    const { f, ctx } = await vendasSetup();
    const p = await seedCatalog(f);
    const token = await bearer(f.member);
    const key = uid();
    const body = {
      lines: [{ product_id: p.queijo.id, quantity: 0.75 }],
      payments: cash(5000),
    };
    const first = await (await api(token, `/profiles/${f.profile}/vendas/sales`, "POST", body, key)).json<any>();
    const again = await (await api(token, `/profiles/${f.profile}/vendas/sales`, "POST", body, key)).json<any>();
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ total_cents: 3375, lines: [{ quantity: 0.75, unit: "KG" }] });
    expect(await stock(p.queijo.id)).toBe(2750);
    // A mesma origem chamada de novo dentro do módulo devolve a mesma venda.
    const { createSale } = await import("../src/modules/vendas/sales");
    const a = await createSale(ctx, f.member, { ...body, source: "api", sourceKey: "origem-x" });
    const b = await createSale(ctx, f.member, { ...body, source: "api", sourceKey: "origem-x" });
    expect(b.id).toBe(a.id);
    expect(await stock(p.queijo.id)).toBe(2000);
    // Cancelar devolve o estoque uma vez só.
    await run(f, f.admin, "vendas.sale.cancel", { id: a.id, reason: "teste" });
    await run(f, f.admin, "vendas.sale.cancel", { id: a.id });
    expect(await stock(p.queijo.id)).toBe(2750);
    const kinds = (await moves(p.queijo.id)).map((m) => [m.type, m.quantity_milli, m.balance_milli]);
    expect(kinds).toEqual([
      ["entrada", 3500, 3500],
      ["venda", -750, 2750],
      ["venda", -750, 2000],
      ["cancelamento", 750, 2750],
    ]);
  });

  it("movimentos manuais, devolução parcial e aviso de estoque baixo", async () => {
    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    expect(
      await failure(
        run(f, f.member, "vendas.stock.move", {
          type: "ajuste",
          items: [{ product_id: p.refri.id, quantity: 5 }],
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await failure(
        run(f, f.admin, "vendas.stock.move", {
          type: "saida",
          items: [{ product_id: p.refri.id, quantity: 11 }],
        }),
      ),
    ).toMatchObject({ code: "out_of_stock" });
    const adjusted = await run(f, f.admin, "vendas.stock.move", {
      type: "ajuste",
      items: [{ product_id: p.refri.id, quantity: 7 }],
      note: "Inventário",
    });
    expect(adjusted.products[0].stock).toBe(7);
    // Café: 2 com mínimo 1. Vender 1 cruza o mínimo e avisa uma vez.
    const sale = await run(f, f.member, "vendas.sale.create", {
      lines: [
        { product_id: p.cafe.id, quantity: 1 },
        { product_id: p.refri.id, quantity: 2, discount_cents: 100 },
      ],
      discount_cents: 90,
      payments: [
        { method: "card_debit", amount_cents: 2000 },
        { method: "cash", amount_cents: 1000 },
      ],
    });
    expect(sale).toMatchObject({
      subtotal_cents: 3090,
      discount_cents: 190,
      total_cents: 2900,
      change_cents: 100,
    });
    const low = await all(
      env,
      "SELECT * FROM events WHERE profile_id=? AND kind='vendas.stock_low'",
      f.profile,
    );
    expect(low.map((e) => JSON.parse(e.payload).product_id)).toEqual([p.cafe.id]);
    // Devolução de 1 refrigerante, depois do resto.
    const part = await run(f, f.admin, "vendas.sale.return", {
      id: sale.id,
      items: [{ index: 1, quantity: 1 }],
      method: "cash",
    });
    expect(part.sale.status).toBe("completed");
    expect(await stock(p.refri.id)).toBe(6000);
    const rest = await run(f, f.admin, "vendas.sale.return", { id: sale.id, method: "cash" });
    expect(rest.sale.status).toBe("returned");
    expect(rest.sale.refunded_cents).toBe(2900);
    expect(await stock(p.refri.id)).toBe(7000);
    expect(await stock(p.cafe.id)).toBe(2000);
    // Equipe não devolve nem cancela sem a regra ligada; desconto acima do limite.
    expect(
      await failure(run(f, f.member, "vendas.sale.return", { id: sale.id })),
    ).toMatchObject({ status: 409 });
    expect(
      await failure(
        run(f, f.member, "vendas.sale.create", {
          lines: [{ product_id: p.refri.id, quantity: 1 }],
          discount_percent: 50,
          payments: cash(300),
        }),
      ),
    ).toMatchObject({ status: 403, code: "discount_limit" });
    expect(
      await failure(
        run(f, f.member, "vendas.sale.create", {
          lines: [{ product_id: p.refri.id, quantity: 1, unit_cents: 1 }],
          payments: cash(1),
        }),
      ),
    ).toMatchObject({ status: 400 });
  });
});

describe("vendas: escopos e módulo desligado", () => {
  it("rotas respondem 409 com o módulo desligado; aplicação precisa de billing:write para vender", async () => {
    const { f } = await vendasSetup({ vendas: false });
    const token = await bearer(f.admin);
    const off = await api(token, `/profiles/${f.profile}/vendas/products`);
    expect(off.status).toBe(409);
    expect((await off.json<any>()).error.code).toBe("module_disabled");
    await run(f, f.admin, "module.set", { id: "vendas", enabled: true });
    const p = await seedCatalog(f);
    const { application } = await import("./service-center-fixture");
    const reader = await application(f, ["conversations:read", "conversations:write"]);
    const list = await (await api(reader.token, `/profiles/${f.profile}/vendas/products`)).json<any>();
    expect(list.data).toHaveLength(4);
    const denied = await api(reader.token, `/profiles/${f.profile}/vendas/sales`, "POST", {
      lines: [{ product_id: p.refri.id, quantity: 1 }],
      payments: cash(600),
    });
    expect(denied.status).toBe(403);
    const seller = await application(f, ["conversations:read", "billing:write"]);
    const sold = await api(seller.token, `/profiles/${f.profile}/vendas/sales`, "POST", {
      lines: [{ product_id: p.refri.id, quantity: 1 }],
      payments: cash(600),
      customer_name: "Ana",
      customer_document: "52998224725",
      notes: "cliente fiel",
    });
    expect(sold.status).toBe(200);
    const body = await sold.json<any>();
    // Sem contacts:read e notes:read: sem documento nem observação interna.
    expect(body.customer).toEqual(expect.objectContaining({ name: "Ana" }));
    expect(body.customer.document).toBeUndefined();
    expect(body.notes).toBeUndefined();
    const staff = await (await api(token, `/profiles/${f.profile}/vendas/sales/${body.id}`)).json<any>();
    expect(staff.customer.document).toBe("52998224725");
    // Pessoa de outra área não enxerga.
    const other = await vendasSetup();
    const foreign = await api(await bearer(other.f.member), `/profiles/${f.profile}/vendas/sales/${body.id}`);
    expect(foreign.status).toBe(404);
  });
});
