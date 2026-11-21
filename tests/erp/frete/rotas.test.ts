// Frete pelo Worker (/erp-expedicao/frete): os provedores nascem desligados e
// em teste; as credenciais digitadas vão para o cofre do núcleo (cifradas) e
// nunca voltam nem ficam na tabela; ligar sem credencial recusa dizendo o que
// falta; a configuração é do administrador; com a parte Expedição desligada a
// rota recusa dizendo o que ligar; o bot sem concessão não cota; o rastreio do
// alarme lê o provedor simulado, grava a linha do tempo e para na entrega,
// sem aviso pelo WhatsApp enquanto o ajuste estiver desligado. Sem rede.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../../../src/db";
import { erpExpedicaoRoute } from "../../../src/erp/expedicao/routes.ts";
import { freightSecretId, providersView, saveProvider } from "../../../src/erp/frete/config.ts";
import { markShipped, runTrackingRound, type FreightDeps } from "../../../src/erp/frete/service.ts";
import { ERP_BOT_OPERATIONS, erpBotModules } from "../../../src/modules/erp/bot-access";
import { now, uid, type Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

const BASE = ["erp", "erp-produtos", "erp-vendas", "erp-estoque"];
const ORDER = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
const SECRET = "codigo-de-acesso-que-nao-pode-vazar";

async function area(withShipping: boolean) {
  const a = await vaultArea();
  for (const id of BASE) await setModule(a.profile, id, true, "teste");
  if (withShipping) await setModule(a.profile, "erp-expedicao", true, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpExpedicaoRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-expedicao/frete/${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { ...a, call, admin: await member("admin", a.profile) };
}

/** Correios simulado: token e rastro com postagem e entrega. */
function correios(events: unknown[]) {
  const calls: string[] = [];
  const http: FreightDeps["http"] = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/autentica/cartaopostagem")) return Response.json({ token: "tok" });
    if (path.startsWith("/srorastro/v1/objetos/")) return Response.json({ objetos: [{ eventos: events }] });
    return Response.json({ message: "não simulado" }, { status: 404 });
  };
  return { deps: { http, media: null } as FreightDeps, calls };
}

describe("Frete pelo Worker", () => {
  it("provedores nascem desligados e em teste; a credencial fica só no cofre e nunca volta", async () => {
    const { profile, admin } = await area(true);
    const first = await providersView(env, profile);
    expect(first.providers.map((p) => [p.id, p.enabled, p.sandbox, p.ready])).toEqual([["correios", false, true, false], ["melhorenvio", false, true, false]]);
    expect(first.settings.notify_whatsapp).toBe(false);
    await expect(saveProvider(env, profile, admin.id, "correios", { ligado: true })).rejects.toMatchObject({ code: "freight_provider_incomplete" });
    const saved = await saveProvider(env, profile, admin.id, "correios", {
      ligado: true, credenciais: { usuario: "empresa", codigo_acesso: SECRET, cartao_postagem: "0067599079" }, opcoes: { servicos: "03220,03298" },
    });
    const correiosView = saved.providers.find((p) => p.id === "correios")!;
    expect(correiosView).toMatchObject({ enabled: true, sandbox: true, ready: true, options: { servicos: "03220,03298" } });
    expect(correiosView.secret_fields.every((f) => f.saved)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    const row = await one<any>(env, "SELECT * FROM erp_frete_providers WHERE profile_id=? AND provider='correios'", profile);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    const vault = await one<any>(env, "SELECT value FROM secrets WHERE id=?", freightSecretId("correios", profile));
    expect(vault.value).not.toContain(SECRET);
    // Credencial vazia mantém a guardada.
    await saveProvider(env, profile, admin.id, "correios", { credenciais: { codigo_acesso: "" } });
    expect((await providersView(env, profile)).providers[0].ready).toBe(true);
    await expect(saveProvider(env, profile, admin.id, "correios", { credenciais: { senha: "x" } })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("parte desligada: 409 module_disabled dizendo qual módulo ligar", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(false);
    const refused = await call(admin, "GET", "provedores");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("module_disabled");
    expect(refused.body.error.message).toMatch(/Expedição, que está desligado/);
  });

  it("ligada: só o administrador configura; cotar pedido inexistente diz o que aconteceu; o bot sem concessão não cota", { timeout: 60_000 }, async () => {
    const { call, admin, profile } = await area(true);
    const list = await call(admin, "GET", "provedores");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.providers).toHaveLength(2);
    const seller = await member("operator", profile, ["erp:vendas"]);
    const denied = await call(seller, "GET", "provedores");
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/Só o administrador do ERP/);
    const bad = await call(admin, "POST", "ajustes", { cep_origem: "123" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/8 números do CEP/);
    const settings = await call(admin, "POST", "ajustes", { cep_origem: "01001-000" });
    expect(settings.body.settings).toMatchObject({ origin_postal_code: "01001000", notify_whatsapp: false });
    const missing = await call(admin, "GET", `pedidos/${ORDER}/cotacao`);
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
    expect(missing.body.error.message).toMatch(/Pedido de venda não encontrado/);
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    expect((await call(bot, "GET", `pedidos/${ORDER}/cotacao`)).status).toBe(403);
    expect((await call(bot, "POST", `pedidos/${ORDER}/envio`, {})).status).toBe(403);
  });

  it("bots: cotar e consultar são leitura; contratar e cancelar, sensíveis; o assunto Frete e rastreio depende da Expedição", () => {
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.group === "frete");
    expect(ops.filter((op) => op.sensitive).map((op) => op.id).sort()).toEqual(["erp.expedicao.frete.cancelar", "erp.expedicao.frete.contratar"]);
    expect(ops.filter((op) => !op.sensitive).map((op) => op.id).sort()).toEqual(["erp.expedicao.frete.cotar", "erp.expedicao.frete.pedido"]);
    expect([...erpBotModules(ops[0])].sort()).toEqual(["erp", "erp-estoque", "erp-expedicao", "erp-produtos", "erp-vendas"]);
  });

  it("rastreio no alarme: só pedidos expedidos; grava a linha do tempo, para na entrega e não avisa com o ajuste desligado", async () => {
    const { profile, admin } = await area(true);
    await saveProvider(env, profile, admin.id, "correios", { ligado: true, credenciais: { usuario: "u", codigo_acesso: SECRET, cartao_postagem: "1" } });
    const shipment = uid(), at = now();
    await exec(env, `INSERT INTO erp_frete_shipments(id,profile_id,document_id,order_number,provider,sandbox,service_code,service_name,price_cents,status,provider_ref,tracking_code,
      notify_phone,customer_name,created,created_by,updated) VALUES(?,?,?,?,?,1,'03220','SEDEX',3210,'contracted','PP1','AB123456789BR','5511987654321','Maria',?,?,?)`,
    shipment, profile, ORDER, 12, "correios", at, admin.id, at);
    const { deps, calls } = correios([
      { codigo: "PO", tipo: "01", dtHrCriado: "2026-11-21T09:00:00", descricao: "Objeto postado", unidade: { endereco: { cidade: "São Paulo", uf: "SP" } } },
      { codigo: "BDE", tipo: "01", dtHrCriado: "2026-11-23T14:10:00", descricao: "Objeto entregue ao destinatário", unidade: { endereco: { cidade: "Rio de Janeiro", uf: "RJ" } } },
    ]);
    // Ainda não expedido: o alarme não consulta.
    expect(await runTrackingRound(env, profile, at, deps)).toEqual({ checked: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    await markShipped(env, profile, [ORDER], at);
    expect(await runTrackingRound(env, profile, at + 1, deps)).toEqual({ checked: 1, failed: 0 });
    const events = await all<any>(env, "SELECT status, location, notified FROM erp_frete_events WHERE shipment_id=? ORDER BY happened_at", shipment);
    expect(events.map((e) => [e.status, e.location, e.notified])).toEqual([["posted", "São Paulo/SP", 0], ["delivered", "Rio de Janeiro/RJ", 0]]);
    const row = await one<any>(env, "SELECT tracking_status, delivered_at, tracking_next FROM erp_frete_shipments WHERE id=?", shipment);
    expect(row.tracking_status).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
    expect(row.tracking_next).toBeNull();
    // Entregue: sai da rodada; ler de novo não duplica eventos.
    expect(await runTrackingRound(env, profile, at + 10 * 3_600_000, deps)).toEqual({ checked: 0, failed: 0 });
    expect((await all(env, "SELECT 1 FROM erp_frete_events WHERE shipment_id=?", shipment))).toHaveLength(2);
    expect(await one(env, "SELECT 1 FROM outbox WHERE dedupe LIKE ?", `erp-frete:${shipment}:%`)).toBeNull();
  });
});
