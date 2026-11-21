// Várias empresas pelo Worker (/erp-empresas): o seletor só mostra as áreas
// com ERP ligado em que a pessoa tem papel no ERP; o consolidado é só do
// administrador do ERP; a prévia da cópia compara duas empresas sem gravar;
// a parte desligada recusa dizendo o que ligar; o bot sem concessão não
// copia; adicionar empresa é do administrador da conta e cria a área com o
// ERP ligado e as pessoas escolhidas. Sem rede: áreas de ensaio no D1 local.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpEmpresasRoute, erpPort, newCompanyInput } from "../../../src/erp/multiempresa/routes.ts";
import { ERP_BOT_OPERATIONS, erpBotInventory, erpBotModules } from "../../../src/modules/erp/bot-access";
import { exec, one } from "../../../src/db";
import { now, uid, type Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member } from "../emissor/helpers";

const PARTS = ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro", "erp-fiscal"];

async function area(name: string, withErp = true) {
  const profile = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)", profile, name, "{}", now());
  if (withErp) for (const id of PARTS) await setModule(profile, id, true, "teste");
  return profile;
}

/** Pessoa da conta com acesso às áreas e o papel do ERP dado (operador, não administrador da conta). */
async function person(areas: string[], access: string[]) {
  const who = await member("operator", areas[0], access);
  await exec(env, "UPDATE users SET profiles=? WHERE id=?", JSON.stringify(areas), who.id);
  return { ...who, profiles: areas } as Actor;
}

const call = async (who: Actor, profile: string, method: string, sub: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await erpEmpresasRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${profile}/erp-empresas${sub}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
  return { status: response.status, body: await response.json<any>() };
};

describe("Várias empresas pelo Worker", () => {
  it("inventário dos bots: ver e consolidar é leitura comum; prévia e cópia são sensíveis; nova empresa fica fora", () => {
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.group === "multiempresa");
    expect(ops.map((op) => op.id).sort()).toEqual(["erp.empresas.consolidado", "erp.empresas.copiar", "erp.empresas.copiar_previa", "erp.empresas.listar"]);
    expect([...erpBotModules(ops[0])]).toEqual(["erp"]);
    const group = erpBotInventory({ erp: true }).groups.find((g) => g.id === "multiempresa")!;
    expect(group.operations.find((op) => op.id === "erp.empresas.consolidado")).toMatchObject({ kind: "read", sensitive: false });
    expect(group.operations.find((op) => op.id === "erp.empresas.copiar")).toMatchObject({ kind: "write", sensitive: true });
  });

  it("seletor e consolidado: só as áreas com ERP, só com papel no ERP, consolidado só do administrador do ERP", { timeout: 120_000 }, async () => {
    const a = await area("Loja Centro"), b = await area("Loja Praia"), c = await area("Só atendimento", false);
    const admin = await person([a, b, c], ["erp:admin"]);
    const list = await call(admin, a, "GET", "");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.empresas.map((e: any) => [e.area, e.area_nome, e.atual])).toEqual([[a, "Loja Centro", true], [b, "Loja Praia", false]]);
    const seller = await person([a, b], ["erp:vendas"]);
    expect((await call(seller, a, "GET", "")).body.empresas).toHaveLength(2);
    const denied = await call(seller, a, "GET", "/consolidado");
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/administrador do ERP/);
    const nobody = await person([a, b], ["conversations"]);
    expect((await call(nobody, a, "GET", "")).status).toBe(403);
    const report = await call(admin, a, "GET", "/consolidado?periodo=12m");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.empresas.map((e: any) => e.area)).toEqual([a, b]);
    for (const row of report.body.empresas) expect(row.resumo, JSON.stringify(row)).toMatchObject({ saldo_contas_centavos: "0" });
    expect(report.body.total).toMatchObject({ vendas_centavos: "0", receber_centavos: "0", pagar_centavos: "0" });
    expect((await call(admin, a, "GET", "/consolidado?periodo=2anos")).status).toBe(400);
    expect((await call(admin, a, "GET", `/consolidado?empresas=${c}`)).status).toBe(404);
  });

  it("cópia: prévia sem gravar, origem igual ao destino recusada, parte desligada diz o que ligar, bot sem concessão não copia", { timeout: 120_000 }, async () => {
    const a = await area("Matriz"), b = await area("Filial");
    const admin = await person([a, b], ["erp:admin"]);
    const preview = await call(admin, a, "GET", `/copiar/previa?origem=${b}&cadastros=formas_pagamento,categorias_financeiras`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.cadastros.map((k: any) => k.cadastro)).toEqual(["formas_pagamento", "categorias_financeiras"]);
    expect((await call(admin, a, "GET", `/copiar/previa?origem=${a}&cadastros=produtos`)).status).toBe(400);
    expect((await call(admin, a, "GET", `/copiar/previa?origem=${b}&cadastros=estoque`)).status).toBe(400);
    await setModule(b, "erp-fiscal", false, "teste");
    const off = await call(admin, a, "GET", `/copiar/previa?origem=${b}&cadastros=naturezas`);
    expect(off.status).toBe(409);
    expect(off.body.error.message).toMatch(/Fiscal está desligado em Filial/);
    // Uma forma de pagamento e uma categoria financeira na filial; a cópia traz para a matriz uma vez só.
    const filial = await erpPort(env, b, admin, `/api/v1/profiles/${b}/erp-empresas`, "POST", false, "Filial");
    await filial("erp_catalog_payment_method_save", { p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: {
      description: "Pix da filial", payment_type: "17", condition: null, destination: "contas", account_id: null, business_days: false, applicable: "ambos",
      interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null, auto_settle: false, pix_integration: null, pix_cnpj: null,
      fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null } });
    await filial("erp_finance_category_execute", { p_command_id: crypto.randomUUID(), p_action: "category_create", p_data: { kind: "receivable", parent_id: null, name: "Vendas da filial" } });
    const kinds = ["formas_pagamento", "categorias_financeiras"];
    const planned = await call(admin, a, "GET", `/copiar/previa?origem=${b}&cadastros=${kinds.join(",")}`);
    expect(planned.body.cadastros.map((k: any) => [k.cadastro, k.novos])).toEqual([["formas_pagamento", 1], ["categorias_financeiras", 1]]);
    const copied = await call(admin, a, "POST", "/copiar", { origem: b, cadastros: kinds }, { "Idempotency-Key": "copia-1" });
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    expect(copied.body.cadastros.map((k: any) => [k.cadastro, k.criados, k.recusados.length])).toEqual([["formas_pagamento", 1, 0], ["categorias_financeiras", 1, 0]]);
    const twice = await call(admin, a, "POST", "/copiar", { origem: b, cadastros: kinds }, { "Idempotency-Key": "copia-2" });
    expect(twice.body.cadastros.map((k: any) => [k.criados, k.ja_existiam])).toEqual([[0, 1], [0, 1]]);
    const seller = await person([a, b], ["erp:vendas"]);
    expect((await call(seller, a, "POST", "/copiar", { origem: b, cadastros: kinds })).status).toBe(403);
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    expect((await call(bot, a, "POST", "/copiar", { origem: b, cadastros: ["formas_pagamento"] })).status).toBe(403);
    await setModule(a, "erp", false, "teste");
    expect((await call(admin, a, "GET", "")).status).toBe(409);
  });

  it("nova empresa: só o administrador da conta; dados conferidos; a área nasce com o ERP e as pessoas escolhidas", { timeout: 120_000 }, async () => {
    const a = await area("Empresa atual");
    await setModule(a, "erp-compras", true, "teste");
    const owner = await member("admin", a);
    const clerk = await person([a], ["erp:vendas"]);
    const data = { nome_fantasia: "Nova Filial", razao_social: "Nova Filial Comércio Ltda.", cnpj: "45.723.174/0001-10", ie: "", regime: "simples",
      endereco: { cep: "01001-000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "sp", codigo_municipio: "3550308" }, pessoas: [clerk.id] };
    expect(() => newCompanyInput({ ...data, cnpj: "45.723.174/0001-11" })).toThrow(/CNPJ não confere/);
    expect(() => newCompanyInput({ ...data, regime: "lucro" })).toThrow(/regime/);
    expect(newCompanyInput(data).identity).toMatchObject({ cnpj: "45723174000110", state: "SP", postal_code: "01001000", ie: null });
    const refused = await call(clerk, a, "POST", "/nova", data, { "Idempotency-Key": "nova-1" });
    expect(refused.status).toBe(403);
    const created = await call(owner, a, "POST", "/nova", data, { "Idempotency-Key": "nova-2" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.area;
    expect(await one(env, "SELECT name FROM profiles WHERE id=?", id)).toMatchObject({ name: "Nova Filial" });
    const modules = await (await import("../../../src/modules/registry")).moduleStates(env, id);
    expect(modules).toMatchObject({ erp: true, "erp-produtos": true, "erp-compras": true, "erp-financeiro": true });
    const row = await one(env, "SELECT profiles FROM users WHERE id=?", clerk.id);
    expect(JSON.parse(row.profiles)).toContain(id);
    expect(created.body.passos.find((p: any) => p.passo === "Ligar o ERP")).toMatchObject({ ok: true });
    // Os dados da empresa entram no ERP novo; o regime pede o segundo fator do administrador (sem ele, o passo diz onde confirmar).
    expect(created.body.passos.find((p: any) => p.passo === "Gravar os dados da empresa"), JSON.stringify(created.body.passos)).toMatchObject({ ok: true });
    const regime = created.body.passos.find((p: any) => p.passo === "Confirmar o regime tributário");
    expect(regime.ok || /Dados da empresa/.test(regime.mensagem), JSON.stringify(regime)).toBe(true);
    // No seletor: o nome fantasia e o CNPJ lidos do ERP novo.
    const listed = await call(owner, id, "GET", "");
    const mine = listed.body.empresas.find((e: any) => e.area === id);
    expect(mine, JSON.stringify(listed.body)).toMatchObject({ nome_fantasia: "Nova Filial", razao_social: "Nova Filial Comércio Ltda.", dados: true, atual: true });
    expect(String(mine.cnpj).replace(/\D/g, "")).toBe("45723174000110");
    const again = await call(owner, a, "POST", "/nova", data, { "Idempotency-Key": "nova-3" });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.message).toMatch(/Já existe uma empresa com este CNPJ: Nova Filial/);
  });
});
