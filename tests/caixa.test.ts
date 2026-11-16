import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { uid } from "../src/types";
import { api, application, bearer } from "./service-center-fixture";
import { cash, failure, run, seedCatalog, vendasSetup } from "./vendas-fixture";

describe("caixa", () => {
  it("depende de Vendas: não liga sozinho e desliga junto", async () => {
    const { f } = await vendasSetup({ vendas: false });
    expect(
      await failure(run(f, f.admin, "module.set", { id: "caixa", enabled: true })),
    ).toMatchObject({ status: 409, code: "module_requires" });
    await run(f, f.admin, "module.set", { id: "vendas", enabled: true });
    await run(f, f.admin, "module.set", { id: "caixa", enabled: true });
    const off = await run(f, f.admin, "module.set", {
      id: "vendas",
      enabled: false,
      cascade: true,
    });
    expect(off.also_disabled).toEqual(["caixa"]);
    const res = await api(await bearer(f.admin), `/profiles/${f.profile}/caixa`);
    expect(res.status).toBe(409);
  });

  it("abre com troco, vende por toque e por código, sangria, suprimento, devolução e fecha", async () => {
    const { f } = await vendasSetup({ caixa: true });
    const p = await seedCatalog(f);
    const register = await run(f, f.admin, "caixa.register.save", { name: "Caixa 1" });
    expect(
      await failure(run(f, f.member, "caixa.register.save", { name: "Caixa 2" })),
    ).toMatchObject({ code: "admin_required" });
    const token = await bearer(f.member);
    const root = `/profiles/${f.profile}/caixa`;
    const grid = await (await api(token, `${root}/grid`)).json<any>();
    expect(grid.categories.map((c: any) => c.name)).toEqual(["Bebidas", "Mercearia"]);
    expect(grid.products.find((x: any) => x.id === p.refri.id)).toMatchObject({
      price_cents: 600,
      ean: "7894900011517",
      stock: 10,
    });
    const scanned = await (await api(token, `${root}/lookup?code=REF-350`)).json<any>();
    expect(scanned.id).toBe(p.refri.id);

    const openKey = uid();
    const opened = await (
      await api(token, `${root}/registers/${register.id}/open`, "POST", { opening_cents: 10000 }, openKey)
    ).json<any>();
    expect(opened).toMatchObject({ status: "open", number: 1, opening_cents: 10000 });
    // Mesma chave: mesma sessão; outra abertura do mesmo caixa: 409.
    const same = await (
      await api(token, `${root}/registers/${register.id}/open`, "POST", { opening_cents: 10000 }, openKey)
    ).json<any>();
    expect(same.id).toBe(opened.id);
    const twice = await api(token, `${root}/registers/${register.id}/open`, "POST", { opening_cents: 0 });
    expect(twice.status).toBe(409);
    expect((await twice.json<any>()).error.code).toBe("session_open");

    const sale = await (
      await api(token, `${root}/sessions/${opened.id}/sales`, "POST", {
        lines: [
          { product_id: p.refri.id, quantity: 2 },
          { product_id: p.queijo.id, quantity: 0.5 },
        ],
        payments: cash(5000),
      })
    ).json<any>();
    expect(sale).toMatchObject({
      source: "caixa",
      session_id: opened.id,
      total_cents: 3450,
      change_cents: 1550,
    });
    const card = await (
      await api(token, `${root}/sessions/${opened.id}/sales`, "POST", {
        lines: [{ product_id: p.agua.id, quantity: 2 }],
        payments: [{ method: "card_credit", amount_cents: 600 }],
      })
    ).json<any>();
    const supply = await api(token, `${root}/sessions/${opened.id}/moves`, "POST", {
      kind: "supply",
      amount_cents: 2000,
    });
    expect(supply.status).toBe(200);
    const tooMuch = await api(token, `${root}/sessions/${opened.id}/moves`, "POST", {
      kind: "withdrawal",
      amount_cents: 100000,
    });
    expect((await tooMuch.json<any>()).error.code).toBe("insufficient_cash");
    await api(token, `${root}/sessions/${opened.id}/moves`, "POST", {
      kind: "withdrawal",
      amount_cents: 5000,
      note: "Cofre",
    });
    // Devolução de 1 refrigerante em dinheiro: só administrador (regra padrão).
    const adminToken = await bearer(f.admin);
    const back = await api(adminToken, `${root}/sessions/${opened.id}/returns`, "POST", {
      sale_id: sale.id,
      items: [{ index: 0, quantity: 1 }],
      method: "cash",
    });
    expect(back.status).toBe(200);
    const live = await (await api(token, `${root}/sessions/${opened.id}`)).json<any>();
    // 100 + 20 - 50 + (50 - 15,50) - 6 = 98,50
    expect(live.summary.cash).toEqual({
      sales_cents: 3450,
      returns_cents: 600,
      expected_cents: 9850,
    });
    expect(live.summary.by_method).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "card_credit", amount_cents: 600 }),
      ]),
    );
    expect(live.sales).toHaveLength(2);

    // Fechar: só quem abriu ou administrador.
    const otherToken = await bearer(f.other);
    expect(
      (await api(otherToken, `${root}/sessions/${opened.id}/close`, "POST", { counted_cents: 9800 })).status,
    ).toBe(400);
    const closed = await (
      await api(token, `${root}/sessions/${opened.id}/close`, "POST", { counted_cents: 9800 })
    ).json<any>();
    expect(closed).toMatchObject({
      status: "closed",
      expected_cash_cents: 9850,
      counted_cents: 9800,
      difference_cents: -50,
    });
    const report = await (await api(token, `${root}/sessions/${opened.id}/report?columns=42`)).json<any>();
    expect(report.text).toContain("FECHAMENTO DO CAIXA");
    expect(report.text).toContain("Falta");
    // Sessão fechada: não vende; a venda dela não se cancela (devolução no caixa aberto).
    const closedSale = await api(token, `${root}/sessions/${opened.id}/sales`, "POST", {
      lines: [{ product_id: p.agua.id, quantity: 1 }],
      payments: cash(300),
    });
    expect((await closedSale.json<any>()).error.code).toBe("session_closed");
    expect(
      await failure(run(f, f.admin, "vendas.sale.cancel", { id: card.id })),
    ).toMatchObject({ code: "session_closed" });
    expect(
      await failure(run(f, f.admin, "vendas.sale.cancel", { id: sale.id })),
    ).toMatchObject({ code: "sale_partially_returned" });
    expect(
      (await one(env, "SELECT stock_milli FROM vendas_products WHERE id=?", p.refri.id))!.stock_milli,
    ).toBe(9000);
  });

  it("aplicação precisa de billing:write para vender no caixa", async () => {
    const { f } = await vendasSetup({ caixa: true });
    const p = await seedCatalog(f);
    const register = await run(f, f.admin, "caixa.register.save", { name: "Balcão" });
    const session = await run(f, f.member, "caixa.open", { id: register.id, opening_cents: 0 });
    const reader = await application(f, ["conversations:read", "conversations:write"]);
    const denied = await api(reader.token, `/profiles/${f.profile}/caixa/sessions/${session.id}/sales`, "POST", {
      lines: [{ product_id: p.agua.id, quantity: 1 }],
      payments: cash(300),
    });
    expect(denied.status).toBe(403);
    const grid = await api(reader.token, `/profiles/${f.profile}/caixa/grid`);
    expect(grid.status).toBe(200);
  });
});
