// Compra sem retrabalho pelo Worker (/erp-recebidas): produto a partir do item
// do XML (prévia, cadastro e repetição), reposição pelo mínimo e máximo,
// inventário valorizado em planilha e a parte desligada dizendo qual ligar.
// Nada fala com governo ou cofre real: o XML é importado à mão.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpRecebidasRoute } from "../../../src/erp/recebidas/routes.ts";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";
import { nfeXml } from "./xml-fixture.mjs";

const PARTS = ["erp", "erp-produtos", "erp-compras", "erp-estoque", "erp-financeiro", "erp-fiscal"];

async function area() {
  const a = await vaultArea();
  for (const id of PARTS) await setModule(a.profile, id, true, "teste");
  // O XML completo do simulado é só a casca; aqui o cofre devolve uma NF-e inteira com a chave da nota.
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const m = /^\/v1\/nfe-recebidas\/([^/]+)\/xml$/.exec(url.pathname);
    const response = await a.vault.fetch(input as any, init);
    if (!m || response.status !== 200) return response;
    const key = /NFe([0-9A-Z]{44})/.exec(await response.text())![1];
    return new Response(nfeXml({ key, recipient: "99888777000166" }), { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpRecebidasRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-recebidas/${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who, { fetch });
    const type = response.headers.get("Content-Type") ?? "";
    return { status: response.status, type, body: type.includes("json") ? await response.json<any>() : await response.text() };
  };
  const admin = await member("admin", a.profile);
  return { ...a, call, admin };
}

describe("compra sem retrabalho pela rota", () => {
  it("produto pelo XML: prévia, fornecedor antes, cadastro ligado ao código e repetição sem duplicar", { timeout: 60_000 }, async () => {
    const { call, admin, vault } = await area();
    const complete = vault.addReceived();
    vault.deliverXml(complete.id);
    const fetched = await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    const id = (await call(admin, "GET", "notas")).body.items.find((n: any) => n.access_key === complete.chaveAcesso).id;
    // Sem fornecedor no cadastro: a prévia mostra os dois itens e diz o que falta.
    const preview = await call(admin, "GET", `notas/${id}/produto`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.items.map((i: any) => i.position)).toEqual([1, 2]);
    expect(preview.body.items[0].proposal).toMatchObject({ name: "Biscoito de polvilho pacote", unit: "CX", ncm: "19053100", gtin: "7891234567895" });
    expect(preview.body).toMatchObject({ can_create: false, blockers: ["supplier_missing"] });
    const blocked = await call(admin, "POST", `notas/${id}/produto`, { command_id: crypto.randomUUID(), itens: [{ position: 1 }] });
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toContain("Cadastre o fornecedor");
    expect((await call(admin, "POST", `notas/${id}/fornecedor`, { command_id: crypto.randomUUID() })).status).toBe(200);
    const command = crypto.randomUUID();
    const created = await call(admin, "POST", `notas/${id}/produto`, { command_id: command, itens: [{ position: 1 }, { position: 2, name: "Leite integral 1 L" }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.created.map((c: any) => c.product.name)).toEqual(["Biscoito de polvilho pacote", "Leite integral 1 L"]);
    const again = await call(admin, "POST", `notas/${id}/produto`, { command_id: command, itens: [{ position: 1 }, { position: 2, name: "Leite integral 1 L" }] });
    expect(again.status).toBe(200);
    expect(again.body.created.map((c: any) => c.product.id)).toEqual(created.body.created.map((c: any) => c.product.id));
    // Na conferência, os dois itens casam pelo código do fornecedor, na unidade da nota.
    const review = await call(admin, "GET", `notas/${id}`);
    expect(review.body.review.lines.map((l: any) => [l.matched_by, l.factor])).toEqual([["supplier_code", "1"], ["supplier_code", "1"]]);
    // Agora nada falta virar produto.
    expect((await call(admin, "GET", `notas/${id}/produto`)).body.items).toEqual([]);
    expect((await call(admin, "GET", `notas/${id}/produto?posicoes=abc`)).status).toBe(400);
  });

  it("reposição e inventário: consulta, planilha e parte desligada com o módulo a ligar", { timeout: 60_000 }, async () => {
    const { profile, call, admin } = await area();
    const list = await call(admin, "GET", "reposicao");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ scope: "inbound_replenishment", total: 0, can_order: true });
    const empty = await call(admin, "POST", "reposicao/pedidos", { command_id: crypto.randomUUID(), itens: [] });
    expect(empty.status).toBe(422);
    const inventory = await call(admin, "GET", "inventario?data=2026-11-21");
    expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
    expect(inventory.body).toMatchObject({ scope: "inbound_inventory", filters: { date: "2026-11-21" }, total: 0 });
    const csv = await call(admin, "GET", "inventario?data=2026-11-21&formato=csv");
    expect(csv.status).toBe(200);
    expect(csv.type).toContain("text/csv");
    expect(String(csv.body)).toContain("Código;Produto;Unidade;Depósito;Quantidade");
    expect((await call(admin, "GET", "inventario?data=21-11-2026")).body.message).toContain("data do inventário");
    await setModule(profile, "erp-estoque", false, "teste");
    const off = await call(admin, "GET", "inventario?data=2026-11-21");
    expect(off.status).toBe(409);
    expect(off.body.message).toContain("O inventário valorizado depende de");
    expect((await call(admin, "GET", "reposicao")).body.message).toContain("A reposição pelo estoque mínimo depende de");
  });
});
