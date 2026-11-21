// Compra pela nota recebida pelo Worker (/erp-recebidas) contra o cofre
// simulado oficial (tests/erp/emissor/fake-vault.ts): busca por ação da
// pessoa, guarda de frequência, produção só com autorização do administrador,
// XML no R2 da área, conferência, interruptor e manifestação (resultado
// incerto não é reenviado sem consulta e confirmação), parte desligada e bot
// sem concessão. Nada fala com governo ou cofre real.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpRecebidasRoute } from "../../../src/erp/recebidas/routes.ts";
import { uid, type Actor } from "../../../src/types";
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
    const text = await response.text();
    const key = /NFe([0-9A-Z]{44})/.exec(text)![1];
    return new Response(nfeXml({ key, recipient: "99888777000166" }), { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpRecebidasRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-recebidas/${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who, { fetch });
    const type = response.headers.get("Content-Type") ?? "";
    return { status: response.status, body: type.includes("json") ? await response.json<any>() : await response.text() };
  };
  const admin = await member("admin", a.profile);
  return { ...a, call, admin };
}

describe("buscar no cofre", () => {
  it("por ação da pessoa: grava o índice, o XML no R2 e respeita a guarda de frequência", { timeout: 60_000 }, async () => {
    const { profile, call, admin, vault } = await area();
    const summaryOnly = vault.addReceived();
    const complete = vault.addReceived();
    vault.deliverXml(complete.id);
    // Nada foi buscado sozinho.
    expect(vault.calls.filter((c) => c.path.startsWith("/v1/nfe-recebidas"))).toHaveLength(0);
    const fetched = await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    expect(fetched.body).toMatchObject({ created: 2, with_xml: 1, environment: "homologacao" });
    const list = await call(admin, "GET", "notas");
    expect(list.body.total).toBe(2);
    const withXml = list.body.items.find((n: any) => n.access_key === complete.chaveAcesso);
    const resumo = list.body.items.find((n: any) => n.access_key === summaryOnly.chaveAcesso);
    expect(withXml.xml.key).toBe(`erp/${profile}/recebidas/xml/${withXml.xml.sha256}.xml`);
    expect(await env.MEDIA.get(withXml.xml.key)).not.toBeNull();
    expect(resumo.xml).toBeNull();
    expect(resumo.vault.xml_available).toBe(false);
    // Logo em seguida: espera, sem chamar o cofre de novo.
    const before = vault.calls.length;
    const again = await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("recebidas_wait");
    expect(vault.calls.length).toBe(before);
    // Ler não vai ao governo.
    expect(vault.sefazSends.size).toBe(0);
    // Conferência: com XML, a revisão completa; só com o resumo, o aviso.
    const reviewed = await call(admin, "GET", `notas/${withXml.id}`);
    expect(reviewed.body).toMatchObject({ missing_xml: false, review: { header: { purpose: "compra" } } });
    expect(reviewed.body.review.lines).toHaveLength(2);
    expect((await call(admin, "GET", `notas/${resumo.id}`)).body).toMatchObject({ missing_xml: true, review: null });
    const xml = await call(admin, "GET", `notas/${withXml.id}/xml`);
    expect(xml.body).toContain(complete.chaveAcesso);
  });

  it("produção só pelo administrador e com a autorização marcada naquela busca", { timeout: 60_000 }, async () => {
    const { profile, call, admin, vault } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    expect((await call(admin, "POST", "buscar", { ambiente: "producao" })).body.code).toBe("inbound_production_authorization_required");
    expect((await call(fiscal, "POST", "buscar", { ambiente: "producao", autorizacao_producao: true })).body.code).toBe("inbound_production_authorization_required");
    expect(vault.calls.filter((c) => c.path.startsWith("/v1/nfe-recebidas"))).toHaveLength(0);
    expect((await call(admin, "POST", "buscar", { ambiente: "producao", autorizacao_producao: true })).status).toBe(200);
  });

  it("Compras desligado: recusa com parte desligada e diz qual ligar; Fiscal desligado: só a busca e a manifestação param", { timeout: 60_000 }, async () => {
    const { profile, call, admin } = await area();
    await setModule(profile, "erp-fiscal", false, "teste");
    const fetchOff = await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    expect(fetchOff.status).toBe(409);
    expect(fetchOff.body).toMatchObject({ code: "module_disabled" });
    expect(fetchOff.body.message).toMatch(/Fiscal/);
    expect((await call(admin, "GET", "notas")).status).toBe(200);
    await setModule(profile, "erp-compras", false, "teste");
    const off = await call(admin, "GET", "notas");
    expect(off.status).toBe(409);
    expect(off.body.message).toMatch(/Compras/);
  });

  it("bot sem concessão não alcança; ação só de tela recusa pelo bot", { timeout: 60_000 }, async () => {
    const { call, admin } = await area();
    const bot: Actor = { ...admin, via: { kind: "internal_bot", bot_id: uid(), run_id: uid() } as any };
    expect((await call(bot, "GET", "notas")).body.code).toBe("erp_bot_grant_required");
    expect((await call(bot, "PUT", "configuracao", { expected_version: 0, manifestar: true, ciente_ato_fiscal: true })).body.code).toBe("erp_bot_grant_required");
  });

  it("importar XML sem o CNPJ da empresa: diz o que preencher", { timeout: 60_000 }, async () => {
    const { call, admin } = await area();
    const imported = await call(admin, "POST", "importar", { xml: nfeXml() });
    expect(imported.status).toBe(422);
    expect(imported.body.message).toMatch(/Dados da empresa/);
    expect((await call(admin, "POST", "importar", { xml: "não é xml" })).body.message).toMatch(/XML/);
  });
});

describe("manifestação do destinatário", () => {
  it("desligada até o administrador ligar com a ciência; a ciência fica registrada", { timeout: 60_000 }, async () => {
    const { profile, call, admin, vault } = await area();
    const n = vault.addReceived();
    await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    const note = (await call(admin, "GET", "notas")).body.items[0];
    const off = await call(admin, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "ciencia" });
    expect(off.status).toBe(403);
    expect(off.body.message).toMatch(/desligada/);
    expect(vault.sefazSends.size).toBe(0);
    expect((await call(admin, "PUT", "configuracao", { expected_version: 0, manifestar: true })).body.code).toBe("inbound_fiscal_act_acknowledgement_required");
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    expect((await call(fiscal, "PUT", "configuracao", { expected_version: 0, manifestar: true, ciente_ato_fiscal: true })).status).toBe(403);
    expect((await call(admin, "PUT", "configuracao", { expected_version: 0, manifestar: true, ciente_ato_fiscal: true })).body).toMatchObject({ manifest_enabled: true });
    const done = await call(fiscal, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "ciencia" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // O cofre baixa o XML completo depois da ciência; ele chega na próxima busca.
    expect(done.body).toMatchObject({ state: "registrado", consulted: false });
    expect(vault.sefazSends.get(n.id)).toBe(1);
    const after = (await call(admin, "GET", "notas")).body.items[0];
    expect(after.vault.manifestation.type).toBe("ciencia");
    expect(after.vault.pending).toBeNull();
    // Repetir a mesma ciência com outro pedido: o cofre devolve "repetido", nada novo vai ao governo.
    const again = await call(fiscal, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "ciencia" });
    expect(again.body).toMatchObject({ state: "registrado", repeated: true });
    expect(vault.sefazSends.get(n.id)).toBe(1);
  });

  it("sem resposta conclusiva: fica incerta; repetir consulta antes e só reenvia com a confirmação", { timeout: 60_000 }, async () => {
    const { call, admin, vault } = await area();
    const n = vault.addReceived();
    await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    await call(admin, "PUT", "configuracao", { expected_version: 0, manifestar: true, ciente_ato_fiscal: true });
    const note = (await call(admin, "GET", "notas")).body.items[0];
    vault.plan.push("inconclusive");
    const lost = await call(admin, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "ciencia" });
    expect(lost.status).toBe(503);
    expect(lost.body.code).toBe("recebidas_manifest_uncertain");
    const posts = () => vault.calls.filter((c) => c.method === "POST" && c.path.includes("manifestar")).length;
    const sent = posts();
    const blind = await call(admin, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "ciencia" });
    expect(blind.status).toBe(409);
    expect(blind.body.code).toBe("recebidas_manifest_uncertain");
    expect(posts()).toBe(sent);
    expect((await call(admin, "GET", "notas")).body.items[0].vault.pending).toMatchObject({ type: "ciencia", state: "incerto" });
    const confirmed = await call(admin, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "ciencia", reenviar: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.state).toBe("registrado");
    expect(posts()).toBe(sent + 1);
    expect(vault.sefazSends.get(n.id)).toBeGreaterThanOrEqual(1);
    expect((await call(admin, "GET", "notas")).body.items[0].vault.pending).toBeNull();
  });

  it("operação não realizada exige justificativa; nota importada à mão não manifesta pelo cofre", { timeout: 60_000 }, async () => {
    const { call, admin, vault } = await area();
    vault.addReceived();
    await call(admin, "POST", "buscar", { ambiente: "homologacao" });
    await call(admin, "PUT", "configuracao", { expected_version: 0, manifestar: true, ciente_ato_fiscal: true });
    const note = (await call(admin, "GET", "notas")).body.items[0];
    const short = await call(admin, "POST", `notas/${note.id}/manifestar`, { command_id: uid(), tipo: "nao_realizada", justificativa: "curta" });
    expect(short.body.message).toMatch(/15 a 255/);
    expect(vault.sefazSends.size).toBe(0);
  });
});
