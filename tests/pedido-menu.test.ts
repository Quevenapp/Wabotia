import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { perform } from "../src/service";
import { json, uid } from "../src/types";
import { validateCatalog } from "../src/web-cart";
import { cartCategories, loadMenu } from "../src/modules/pedido/menu";
import { api, bearer } from "./service-center-fixture";
import { media, pedidoSetup, run, seedMenu } from "./pedido-fixture";

describe("pedido: módulo desligado", () => {
  it("vem desligado e as rotas respondem 409 module_disabled", async () => {
    const { f } = await pedidoSetup({ enabled: false });
    const token = await bearer(f.admin);
    for (const [method, path, body] of [
      ["GET", "/pedido/menu", undefined],
      ["POST", "/pedido/categories", { name: "Lanches" }],
      ["POST", "/pedido/items", { name: "X", price_cents: 1 }],
    ] as const) {
      const res = await api(
        token,
        `/profiles/${f.profile}${path}`,
        method,
        body,
      );
      expect(res.status, path).toBe(409);
      expect((await res.json<any>()).error.code).toBe("module_disabled");
    }
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "pedido.category.save",
        { name: "Lanches" },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "module_disabled" });
    const modules = await (
      await api(token, `/profiles/${f.profile}/modules`)
    ).json<any>();
    expect(modules.data.find((m: any) => m.id === "pedido")).toMatchObject({
      enabled: false,
      default_enabled: false,
      menu_item_types: [
        expect.objectContaining({ type: "pedido_cardapio", label: "Cardápio" }),
        expect.objectContaining({ type: "pedido_acompanhar" }),
      ],
    });
  });
});

describe("pedido: cardápio", () => {
  it("categorias, itens, adicionais e imagens pela API, na ordem de exibição", async () => {
    const { f, ctx } = await pedidoSetup();
    const seeded = await seedMenu(f);
    const token = await bearer(f.member);
    const menu = await (
      await api(token, `/profiles/${f.profile}/pedido/menu`)
    ).json<any>();
    expect(menu.categories.map((c: any) => c.name)).toEqual([
      "Lanches",
      "Bebidas",
    ]);
    expect(menu.categories[0].items.map((i: any) => i.name)).toEqual([
      "X-Burger",
      "Misto quente",
    ]);
    expect(menu.categories[0].items[0]).toMatchObject({
      price_cents: 2500,
      available: true,
      max_quantity: 20,
      retailer_id: "XB-01",
      group_ids: [seeded.ponto.id, seeded.adicionais.id],
      image_url: "https://img.example.com/x.jpg",
      photo_media_id: null,
    });
    expect(menu.categories[0].items[1].available).toBe(false);
    expect(
      menu.groups.find((g: any) => g.name === "Adicionais").options,
    ).toEqual([
      { id: "bacon", name: "Bacon", price_cents: 500, available: true },
      { id: "ovo", name: "Ovo", price_cents: 300, available: true },
      { id: "cheddar", name: "Cheddar", price_cents: 400, available: false },
    ]);

    // Foto pelo caminho de mídia do núcleo (JPG ou PNG desta área).
    const foto = await media(f);
    const updated = await run(f, f.admin, "pedido.item.save", {
      id: seeded.suco.id,
      photo_media_id: foto,
      position: 0,
    });
    expect(updated).toMatchObject({
      photo_media_id: foto,
      name: "Suco de laranja",
      price_cents: 800,
    });
    const audio = await media(f, "audio/ogg", "a.ogg");
    await expect(
      run(f, f.admin, "pedido.item.save", {
        id: seeded.suco.id,
        photo_media_id: audio,
      }),
    ).rejects.toThrow(/JPG ou PNG/);

    // Imagens do cardápio enviadas no WhatsApp: imagens ou PDF.
    const pdf = await media(f, "application/pdf", "cardapio.pdf");
    const images = await run(f, f.admin, "pedido.images.save", {
      images: [
        { media_id: foto, caption: "Lanches" },
        { media_id: pdf, caption: "Cardápio completo" },
      ],
    });
    expect(images.images.map((i: any) => [i.media_id, i.caption])).toEqual([
      [foto, "Lanches"],
      [pdf, "Cardápio completo"],
    ]);
    await expect(
      run(f, f.admin, "pedido.images.save", {
        images: [{ media_id: audio }],
      }),
    ).rejects.toThrow(/JPG ou PNG, ou um PDF/);

    // O catálogo do carrinho sai válido para a página do núcleo.
    const categories = cartCategories(await loadMenu(ctx));
    const catalog = validateCatalog({
      categories,
      fulfillment: { pickup: true },
    });
    expect(catalog.categories[0].items[0].option_groups[0]).toMatchObject({
      name: "Ponto da carne",
      min: 1,
      max: 1,
    });
    expect(catalog.categories[0].items[1].available).toBe(false);
    expect(
      (
        await all(
          env,
          "SELECT id FROM events WHERE profile_id=? AND kind='pedido.menu_changed'",
          f.profile,
        )
      ).length,
    ).toBeGreaterThan(5);
  });

  it("adicionais com mínimo e máximo conferidos e código da Meta único", async () => {
    const { f } = await pedidoSetup();
    const seeded = await seedMenu(f);
    await expect(
      run(f, f.admin, "pedido.group.save", {
        name: "Sabores",
        min: 3,
        max: 2,
        options: [{ name: "A" }, { name: "B" }, { name: "C" }],
      }),
    ).rejects.toThrow(/mínimo/);
    await expect(
      run(f, f.admin, "pedido.group.save", {
        name: "Sabores",
        min: 0,
        max: 4,
        options: [{ name: "A" }, { name: "B" }],
      }),
    ).rejects.toThrow(/máximo de 1 a 2/);
    await expect(
      run(f, f.admin, "pedido.group.save", {
        name: "Vazio",
        options: [],
      }),
    ).rejects.toThrow(/1 a 30 opções/);
    const sabores = await run(f, f.admin, "pedido.group.save", {
      name: "Sabores",
      min: 1,
      max: 2,
      options: [{ name: "Calabresa", price_cents: 0 }, { name: "Frango" }],
    });
    expect(sabores.options.map((o: any) => o.id)).toHaveLength(2);
    expect(
      sabores.options.every((o: any) => /^[A-Za-z0-9_-]+$/.test(o.id)),
    ).toBe(true);
    await expect(
      run(f, f.admin, "pedido.item.save", {
        category_id: seeded.lanches.id,
        name: "Outro suco",
        price_cents: 900,
        retailer_id: "SUCO-500",
      }),
    ).rejects.toMatchObject({ code: "retailer_id_taken" });
    await expect(
      run(f, f.admin, "pedido.item.save", {
        category_id: seeded.lanches.id,
        name: "Meio real",
        price_cents: 12.5,
      }),
    ).rejects.toThrow(/centavos/);
    await expect(
      run(f, f.admin, "pedido.item.save", {
        category_id: seeded.lanches.id,
        name: "Sem grupo",
        price_cents: 100,
        group_ids: ["nao-existe"],
      }),
    ).rejects.toThrow(/não encontrado/);
    // Excluir o grupo tira do item.
    await run(f, f.admin, "pedido.group.delete", { id: seeded.adicionais.id });
    const item = await (
      await api(
        await bearer(f.member),
        `/profiles/${f.profile}/pedido/items/${seeded.xburger.id}`,
      )
    ).json<any>();
    expect(item.group_ids).toEqual([seeded.ponto.id]);
    // Categoria com itens não é excluída.
    await expect(
      run(f, f.admin, "pedido.category.delete", { id: seeded.lanches.id }),
    ).rejects.toMatchObject({ code: "category_not_empty" });
  });

  it("equipe marca esgotado; cadastro só por administrador; Idempotency-Key repetida não duplica", async () => {
    const { f } = await pedidoSetup();
    const seeded = await seedMenu(f);
    const member = await bearer(f.member);
    const admin = await bearer(f.admin);
    const denied = await api(
      member,
      `/profiles/${f.profile}/pedido/items`,
      "POST",
      { category_id: seeded.lanches.id, name: "X-Salada", price_cents: 2300 },
    );
    expect(denied.status).toBe(403);
    const off = await api(
      member,
      `/profiles/${f.profile}/pedido/items/${seeded.xburger.id}/availability`,
      "POST",
      { available: false },
    );
    expect(off.status).toBe(200);
    expect((await off.json<any>()).available).toBe(false);
    const option = await api(
      member,
      `/profiles/${f.profile}/pedido/groups/${seeded.adicionais.id}/availability`,
      "POST",
      { option_id: "bacon", available: false },
    );
    expect(
      (await option.json<any>()).options.find((o: any) => o.id === "bacon")
        .available,
    ).toBe(false);

    const key = uid();
    const body = {
      category_id: seeded.lanches.id,
      name: "X-Salada",
      price_cents: 2300,
    };
    const first = await api(
      admin,
      `/profiles/${f.profile}/pedido/items`,
      "POST",
      body,
      key,
    );
    const again = await api(
      admin,
      `/profiles/${f.profile}/pedido/items`,
      "POST",
      body,
      key,
    );
    expect(first.status).toBe(200);
    const created = await first.json<any>();
    expect(await again.json<any>()).toEqual(created);
    expect(
      await all(
        env,
        "SELECT id FROM pedido_items WHERE profile_id=? AND name='X-Salada'",
        f.profile,
      ),
    ).toHaveLength(1);
    const row = await one(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='pedido.menu_changed' ORDER BY id DESC LIMIT 1",
      f.profile,
    );
    expect(json(row.payload)).toMatchObject({
      what: "item",
      action: "saved",
      module_id: "pedido",
    });
  });
});
