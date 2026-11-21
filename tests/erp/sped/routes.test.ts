// Obrigações em arquivo: rotas /erp-sped (src/erp/sped/routes.ts) e o objeto
// do ERP da área. Quem pode, parte Fiscal desligada, conferência em palavras
// com o atalho, arquivo com pendências que não sai, configuração e envio de
// arquivo que não está pronto. Nenhum cofre real, nada vai ao governo.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../../src/types";
import { erpSpedRoute } from "../../../src/erp/sped/routes.ts";
import { ERP_SPED_OPERATIONS } from "../../../src/erp/sped/contract.ts";
import { ERP_BOT_OPERATIONS } from "../../../src/modules/erp/bot-access.ts";
import { setModule } from "../../erp-module-helper";
import { fixture } from "../../service-center-fixture";
import { actor, member } from "../emissor/helpers";

const url = (profile: string, sub: string) => `https://wabotia.test/api/v1/profiles/${profile}/erp-sped${sub}`;
const MONTH = { de: "2026-10-01", ate: "2026-10-31" };

async function area() {
  const { profile } = await fixture();
  await setModule(profile, "erp", true, "teste");
  await setModule(profile, "erp-fiscal", true, "teste");
  const call = (who: Actor, method: string, sub: string, body?: unknown) =>
    erpSpedRoute(env, new Request(url(profile, sub), { method, body: body === undefined ? undefined : JSON.stringify(body) }), profile, who);
  return { profile, call };
}

describe("quem pode", () => {
  it("fiscal, administrador e consulta veem; consulta não gera; vendas, sem papel e bot sem concessão não", { timeout: 60_000 }, async () => {
    const { profile, call } = await area();
    const check = `/conferencia?tipo=efd_icms_ipi&de=${MONTH.de}&ate=${MONTH.ate}`;
    for (const who of [await member("operator", profile, ["erp:fiscal"]), await member("admin", profile), await member("operator", profile, ["erp:consulta"])])
      expect((await call(who, "GET", check)).status).toBe(200);
    const consulta = await member("operator", profile, ["erp:consulta"]);
    expect(await call(consulta, "POST", "/arquivos", { tipo: "sintegra", ...MONTH }).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    expect(await call(consulta, "PUT", "/configuracao", { perfil: "B" }).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    const vendas = await member("operator", profile, ["erp:vendas"]);
    expect(await call(vendas, "GET", check).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    expect(await call(actor("operator", [profile]), "GET", check).catch((e) => e)).toMatchObject({ status: 403, code: "erp_role_required" });
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const viaBot: Actor = { ...fiscal, via: { kind: "internal_bot", bot_id: "b", run_id: "r" } as any };
    expect(await call(viaBot, "POST", "/envios", { arquivo: "0123456789abcdef" }).catch((e) => e)).toMatchObject({ status: 403, code: "erp_bot_grant_required" });
    expect(await call(viaBot, "GET", "/configuracao").catch((e) => e)).toMatchObject({ status: 403, code: "erp_bot_grant_required" });
  });

  it("parte Fiscal desligada: 409 module_disabled dizendo qual módulo ligar", async () => {
    const { profile, call } = await area();
    await setModule(profile, "erp-fiscal", false, "teste");
    const refused = await call(actor("admin", [profile]), "GET", `/conferencia?tipo=sintegra&de=${MONTH.de}&ate=${MONTH.ate}`).catch((e) => e);
    expect(refused).toMatchObject({ status: 409, code: "module_disabled" });
    expect(refused.message).toMatch(/Fiscal/);
  });

  it("operações com nome estável no assunto NF-e; só enviar é sensível", () => {
    const bot = ERP_BOT_OPERATIONS.filter((op) => op.id.startsWith("nfe.sped."));
    expect(bot.map((op) => op.id).sort()).toEqual(["nfe.sped.arquivos", "nfe.sped.conferir", "nfe.sped.enviar", "nfe.sped.gerar"]);
    expect(bot.filter((op) => op.sensitive).map((op) => op.id)).toEqual(["nfe.sped.enviar"]);
    expect(bot.every((op) => op.group === "nfe")).toBe(true);
    expect(ERP_SPED_OPERATIONS.filter((op) => op.bot === false).every((op) => !bot.some((b) => b.id === op.name))).toBe(true);
  });
});

describe("conferência e geração", () => {
  it("sem os dados da empresa: a lista diz o que falta com o atalho, e o arquivo fica com pendências", { timeout: 60_000 }, async () => {
    const { profile, call } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const check = await (await call(fiscal, "GET", `/conferencia?tipo=efd_icms_ipi&de=${MONTH.de}&ate=${MONTH.ate}`)).json<any>();
    expect(check.pode_gerar).toBe(false);
    expect(check.pendencias[0]).toMatchObject({ kind: "empresa", blocking: true, link: "/empresa-configuracoes" });
    expect(check.pendencias[0].message).toMatch(/dados da empresa/);
    const created = await call(fiscal, "POST", "/arquivos", { tipo: "efd_icms_ipi", ...MONTH });
    expect(created.status).toBe(201);
    const { arquivo } = await created.json<any>();
    expect(arquivo).toMatchObject({ state: "blocked", kind: "efd_icms_ipi", label: "10/2026", filename: null });
    const list = await (await call(fiscal, "GET", "/arquivos")).json<any>();
    expect(list.arquivos.map((f: any) => f.id)).toContain(arquivo.id);
    expect(await call(fiscal, "GET", `/arquivos/${arquivo.id}/conteudo`).catch((e) => e)).toMatchObject({ status: 404 });
    expect(await call(fiscal, "POST", "/envios", { arquivo: arquivo.id }).catch((e) => e)).toMatchObject({ status: 409, code: "sped_file_not_ready" });
  });

  it("período: SPED é do mês inteiro; SINTEGRA dentro de um mês; inventário até o fim do período", async () => {
    const { profile, call } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    expect(await call(fiscal, "POST", "/arquivos", { tipo: "efd_icms_ipi", de: "2026-10-01", ate: "2026-10-15" }).catch((e) => e)).toMatchObject({ status: 400 });
    expect(await call(fiscal, "GET", "/conferencia?tipo=sintegra&de=2026-10-01&ate=2026-11-15").catch((e) => e)).toMatchObject({ status: 400 });
    expect(await call(fiscal, "GET", "/conferencia?tipo=sintegra&de=2026-10-01&ate=2026-10-31&inventario=2026-11-30").catch((e) => e)).toMatchObject({ status: 400 });
    expect(await call(fiscal, "POST", "/arquivos", { tipo: "dctf", ...MONTH }).catch((e) => e)).toMatchObject({ status: 400 });
    expect(await call(fiscal, "POST", "/arquivos", { tipo: "sintegra", ...MONTH, extra: 1 }).catch((e) => e)).toMatchObject({ status: 400 });
  });
});

describe("configuração", () => {
  it("grava, confere o CPF do contador e sugere o cadastro de Para o contador", { timeout: 60_000 }, async () => {
    const { profile, call } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const first = await (await call(fiscal, "GET", "/configuracao")).json<any>();
    expect(first.configuracao).toMatchObject({ perfil: "A", atividade: "1", no_pacote: true });
    expect(first.pode_editar).toBe(true);
    expect(await call(fiscal, "PUT", "/configuracao", { contador: { cpf: "111.111.111-11" } }).catch((e) => e)).toMatchObject({ status: 400, code: "invalid_request" });
    const saved = await (await call(fiscal, "PUT", "/configuracao", { perfil: "B", contador: { nome: "Contadora", cpf: "123.456.789-09", crc: "SP123456O1" }, codigo_receita_icms: "046-2" })).json<any>();
    expect(saved.configuracao).toMatchObject({ perfil: "B", codigo_receita_icms: "046-2", contador: { nome: "Contadora", cpf: "12345678909", crc: "SP123456O1" } });
    const again = await (await call(await member("operator", profile, ["erp:consulta"]), "GET", "/configuracao")).json<any>();
    expect(again.configuracao.perfil).toBe("B");
    expect(again.pode_editar).toBe(false);
  });
});
