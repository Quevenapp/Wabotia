import { afterEach, describe, expect, it } from "vitest";
import { registerFiscalProvider, unregisterFiscalProvider } from "../src/modules/vendas/fiscal";
import { cash, failure, run, seedCatalog, vendasSetup } from "./vendas-fixture";

afterEach(() => unregisterFiscalProvider("teste"));

const EMITTER = {
  regime: "simples",
  legal_name: "Mercadinho Exemplo Ltda",
  ie: "123456789",
  street: "Rua das Flores",
  number: "100",
  district: "Centro",
  city: "Campinas",
  city_code: "3509502",
  uf: "SP",
  cep: "13010000",
};

describe("vendas: nota fiscal", () => {
  it("prévia aponta o que falta; sem emissor, a emissão responde 409", async () => {
    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    const sale = await run(f, f.member, "vendas.sale.create", {
      lines: [
        { product_id: p.refri.id, quantity: 1 },
        { product_id: p.agua.id, quantity: 1 },
      ],
      payments: [{ method: "pix_manual", amount_cents: 900 }],
    });
    const { modulesApi } = await import("../src/modules/api");
    const { env } = await import("cloudflare:test");
    const { fiscalPreview } = await import("../src/modules/vendas/fiscal");
    const ctx = modulesApi(env, f.profile, "vendas");
    const before = await fiscalPreview(ctx, sale.id, {});
    const fields = before.issues.map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining(["fiscal.regime", "establishment.document", "lines[1].ncm"]),
    );
    expect(before.ready).toBe(false);
    expect(before.document.payments).toEqual([
      { tpag: "20", method: "pix_manual", amount_cents: 900 },
    ]);
    expect(
      await failure(run(f, f.member, "vendas.fiscal.emit", { id: sale.id })),
    ).toMatchObject({ status: 409, code: "fiscal_provider_not_configured" });
    // Configuração fiscal validada.
    expect(
      await failure(run(f, f.admin, "settings", { vendas: { fiscal: { ...EMITTER, city_code: "12" } } })),
    ).toMatchObject({ status: 400 });
    await run(f, f.admin, "settings", {
      establishment: { name: "Mercadinho", document: "11222333000181" },
      vendas: { fiscal: { ...EMITTER, provider: "teste" } },
    });
    await run(f, f.admin, "vendas.product.save", { id: p.agua.id, fiscal: { ncm: "22011000" } });
    const after = await fiscalPreview(ctx, sale.id, {});
    // A venda guardou a cópia fiscal do momento: a água continua sem NCM nela.
    expect(after.issues.map((i) => i.field)).toEqual(["lines[1].ncm"]);
    expect(after.document.items[0]).toMatchObject({
      ncm: "22021000",
      cfop: "5405",
      ean: "7894900011517",
      icms: { csosn: "500", cst: null, origin: 0 },
    });
    expect(after.document).toMatchObject({ model: "65", crt: 1, emitter: { cnpj: "11222333000181" } });
  });

  it("com um emissor registrado, emite uma vez e guarda o resultado", async () => {
    const calls: any[] = [];
    registerFiscalProvider({
      id: "teste",
      name: "Emissor de teste",
      models: ["nfce"],
      async emit(_env, _profile, document, { key }) {
        calls.push({ document, key });
        return { status: "authorized", number: 1, series: 1, access_key: "3".repeat(44), protocol: "135" };
      },
    });
    const { f } = await vendasSetup({
      config: { fiscal: { ...EMITTER, provider: "teste" } },
    });
    await run(f, f.admin, "settings", {
      establishment: { name: "Mercadinho", document: "11222333000181" },
    });
    const p = await seedCatalog(f);
    const sale = await run(f, f.member, "vendas.sale.create", {
      lines: [{ product_id: p.cafe.id, quantity: 1 }],
      payments: cash(2000),
    });
    const doc = await run(f, f.member, "vendas.fiscal.emit", { id: sale.id });
    expect(doc).toMatchObject({ status: "authorized", model: "nfce", access_key: "3".repeat(44) });
    const again = await run(f, f.member, "vendas.fiscal.emit", { id: sale.id });
    expect(again.id).toBe(doc.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].document.payments[0].tpag).toBe("01");
    expect(calls[0].document.change_cents).toBe(110);
    expect(
      await failure(run(f, f.member, "vendas.fiscal.emit", { id: sale.id, model: "nfe" })),
    ).toMatchObject({ status: 400 });
  });
});
