// Régua de cobrança pelo Worker (/erp-regua) e o envio no alarme da área:
// a parte é o Financeiro (desligado: 409 module_disabled dizendo o que
// ligar); nasce desligada; ligar é só do administrador, pela tela, com o
// aviso confirmado; o bot só consulta; o envio usa a conversa com a chave da
// etapa (repetir não manda duas vezes), fica como falha com o motivo quando a
// conversa bloqueia (sem telefone, sem linha, sem consentimento fora da
// janela) e tenta de novo quando a falha passa sozinha; o e-mail usa a função
// registrada, quando existir. Sem rede: a conversa é simulada.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { erpReguaRoute, reguaRpc, reguaSettings } from "../../../src/erp/regua/routes.ts";
import { runRegua, sendByWhatsapp } from "../../../src/erp/regua/sender.ts";
import { nextSettings, REGUA_DEFAULTS } from "../../../src/erp/regua/contract.ts";
import { registerReguaEmail, reguaEmailReady } from "../../../src/erp/regua/email-hook.ts";
import { modules } from "../../../src/modules/registry";
import { ERP_BOT_OPERATIONS, erpBotModules } from "../../../src/modules/erp/bot-access";
import { ERP_MANAGEMENT_ITEMS } from "../../../src/modules/erp/panel-menu";
import { erpDestinationRequirement } from "../../../src/erp/parts-requirements";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

async function area(modulesOn: string[], modulesOff: string[] = []) {
  const a = await vaultArea();
  for (const id of modulesOn) await setModule(a.profile, id, true, "teste");
  for (const id of modulesOff) await setModule(a.profile, id, false, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpReguaRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-regua${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { ...a, call, admin: await member("admin", a.profile) };
}

/** A conversa simulada: responde a prévia e o envio, e guarda o que foi pedido. */
function conversa(prepare: unknown, send: unknown = { envio: { id: "envio1" } }, status = 200) {
  const requests: Request[] = [];
  const call = async (request: Request) => {
    requests.push(request);
    const body = request.method === "GET" ? prepare : send;
    return Response.json(body, { status: request.method === "GET" ? 200 : status });
  };
  return { call, requests };
}
const step = { id: "11111111-1111-4111-8111-111111111111", title_id: "22222222-2222-4222-8222-222222222222" };

afterEach(() => registerReguaEmail(null));

describe("régua de cobrança pelo Worker", () => {
  it("é do Financeiro: rota no módulo, item no menu, destino com a parte; o bot só consulta", () => {
    const finance = modules.find((m) => m.id === "erp-financeiro")!;
    expect(finance.routes).toContain("erp-regua");
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.id.startsWith("erp.regua."));
    expect(ops.map((op) => [op.id, op.method, op.sensitive])).toEqual([["erp.regua.ver", "GET", false], ["erp.regua.recorrentes", "GET", false]]);
    expect(ops.every((op) => (op as any).group === "financeiro")).toBe(true);
    expect([...erpBotModules(ops[0])].sort()).toEqual(["erp", "erp-financeiro"]);
    const menu = ERP_MANAGEMENT_ITEMS.filter((item) => ["erp.dunning", "erp.recurring"].includes(item.id));
    expect(menu.map((item) => [item.id, item.module, item.target.to])).toEqual([
      ["erp.recurring", "erp-financeiro", "/financeiro-empresa?area=recorrentes"], ["erp.dunning", "erp-financeiro", "/regua-cobranca"],
    ]);
    expect(erpDestinationRequirement("/regua-cobranca")?.owner).toBe("erp-financeiro");
  });

  it("configuração: desligada por padrão, horário e canal conferidos", () => {
    expect(REGUA_DEFAULTS.enabled).toBe(false);
    expect(nextSettings(REGUA_DEFAULTS, { ligada: true, hora_inicio: 9, hora_fim: 17 })).toMatchObject({ enabled: true, hour_from: 9, hour_to: 17 });
    expect(() => nextSettings(REGUA_DEFAULTS, { hora_inicio: 18, hora_fim: 8 })).toThrow(/termina depois de começar/);
    expect(() => nextSettings(REGUA_DEFAULTS, { ligada: true, whatsapp: false })).toThrow(/pelo menos um canal/);
    expect(() => nextSettings(REGUA_DEFAULTS, { pagamento: "cheque" })).toThrow(/pagamento/);
  });

  it("Financeiro desligado: 409 module_disabled dizendo o que ligar", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(["erp"], ["erp-financeiro"]);
    const refused = await call(admin, "GET", "");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("module_disabled");
    expect(refused.body.error.message).toMatch(/Financeiro/);
  });

  it("ligada só pelo administrador, com o aviso confirmado; o bot e outros papéis não ligam", { timeout: 60_000 }, async () => {
    const { call, admin, profile } = await area(["erp", "erp-financeiro"]);
    const first = await call(admin, "GET", "");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.regua).toMatchObject({ ligada: false, whatsapp: true, hora_inicio: 8, hora_fim: 18 });
    expect(first.body).toMatchObject({ pode_mudar: true, today_items: [], email_disponivel: false });
    const operator = await member("operator", profile);
    expect((await call(operator, "POST", "/configuracao", { ligada: true, confirmo: true })).status).toBe(403);
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    expect((await call(bot, "POST", "/configuracao", { ligada: true, confirmo: true })).status).toBe(403);
    expect((await call(bot, "POST", `/recorrentes/${step.id}`, { automatica: true })).status).toBe(403);
    const unconfirmed = await call(admin, "POST", "/configuracao", { ligada: true });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body.error.message).toMatch(/Confirme o aviso/);
    expect((await call(admin, "POST", "/configuracao", { hora_inicio: 20, hora_fim: 8 })).status).toBe(400);
    const on = await call(admin, "POST", "/configuracao", { ligada: true, confirmo: true, hora_inicio: 9 });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.regua).toMatchObject({ ligada: true, hora_inicio: 9, ligada_por: admin.name, remetente_ativo: true });
    expect((await reguaSettings(env, profile)).enabled_by).toBe(admin.id);
    const off = await call(admin, "POST", "/configuracao", { ligada: false });
    expect(off.body.regua.ligada).toBe(false);
    // Desligada: a rodada do alarme não faz nada.
    expect((await runRegua(env, profile, Date.now())).status).toBe("off");
  });

  it("envio pela conversa: chave da etapa, falha com o motivo e nova tentativa quando a falha passa", async () => {
    const ok = conversa({ destino: { digitos: "5511987654321", linha: "linha1", modo: "modelo" } });
    expect(await sendByWhatsapp(ok.call, "area1", step, "pix")).toEqual({ outcome: "sent", reason: null, ref: "envio1" });
    const [prepare, post] = ok.requests;
    expect(new URL(prepare.url).pathname).toBe(`/api/v1/profiles/area1/erp-conversa/conta/${step.title_id}`);
    expect(new URL(prepare.url).searchParams.get("pagamento")).toBe("pix");
    expect(post.method).toBe("POST");
    expect(post.headers.get("Idempotency-Key")).toBe(`regua:${step.id}`);
    expect(await post.json()).toEqual({ telefone: "5511987654321", linha: "linha1", pagamento: "pix" });

    const blocked = conversa({ destino: { digitos: "5511987654321", linha: "linha1", modo: "bloqueado", motivo: "O cliente não escreve há mais de 24 horas. Fora da janela de 24 horas o modelo só vai a quem autorizou avisos de cobrança." } });
    const refused = await sendByWhatsapp(blocked.call, "area1", step, "auto");
    expect(refused).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/autorizou avisos de cobrança/) });
    expect(blocked.requests).toHaveLength(1);
    expect(new URL(blocked.requests[0].url).search).toBe("");

    expect(await sendByWhatsapp(conversa({ destino: null, conectar: "Conecte uma linha" }).call, "area1", step, "auto"))
      .toMatchObject({ outcome: "failed", reason: expect.stringMatching(/linha de WhatsApp/) });
    expect(await sendByWhatsapp(conversa({ destino: null, conectar: null }).call, "area1", step, "auto"))
      .toMatchObject({ outcome: "failed", reason: expect.stringMatching(/telefone no cadastro/) });
    const down = conversa({ destino: { digitos: "5511987654321", linha: "linha1", modo: "arquivo" } }, { error: { code: "dependency_unavailable", message: "O ERP está temporariamente indisponível." } }, 503);
    expect(await sendByWhatsapp(down.call, "area1", step, "auto")).toMatchObject({ outcome: "retry" });
  });

  it("rodada do alarme: a conta que vence hoje sai uma vez só, pela conversa da conta, em nome de quem ligou", { timeout: 60_000 }, async () => {
    const { call, admin, profile } = await area(["erp", "erp-financeiro"]);
    const rpc = (name: string, args: Record<string, unknown>) => reguaRpc(env, profile, admin, "POST", name, args);
    const customer = (await rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_acknowledged: null,
      p_data: { name: "Cliente da Régua", person_type: "J", document: "19131243000197", roles: ["customer"], taxpayer: "9" } })).record;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const created = await rpc("erp_finance_recurrence_execute", { p_command_id: crypto.randomUUID(), p_action: "recurrence_create", p_data: {
      kind: "receivable", contact_id: customer.id, description: "Mensalidade", issued_on: today, competence_on: today, due_on: today,
      amount_cents: "9900", frequency: "monthly", due_day: Number(today.slice(8, 10)) } });
    // O dia inteiro e todo dia: o teste não depende da hora em que roda. Os dias são os da régua
    // (as preferências de Contas a receber pedem a Cobrança bancária, desligada aqui).
    const on = await call(admin, "POST", "/configuracao", { ligada: true, confirmo: true, no_vencimento: true, dias_antes: 0, dias_depois: 0, hora_inicio: 0, hora_fim: 24, so_dias_uteis: false });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.rules).toMatchObject({ source: "regua", on_due: true, before: 0, after: 0 });
    const fake = conversa({ destino: { digitos: "5511987654321", linha: "linha1", modo: "arquivo" } });
    const first = await runRegua(env, profile, Date.now(), { call: fake.call });
    expect(first).toEqual({ status: "ran", sent: 1, failed: 0 });
    expect(new URL(fake.requests[0].url).pathname).toBe(`/api/v1/profiles/${profile}/erp-conversa/conta/${created.title.id}`);
    // A próxima rodada espera o intervalo; vencido o intervalo, nada sai de novo.
    expect((await runRegua(env, profile, Date.now(), { call: fake.call })).status).toBe("waiting");
    expect(await runRegua(env, profile, Date.now() + 3_600_000, { call: fake.call })).toEqual({ status: "ran", sent: 0, failed: 0 });
    expect(fake.requests).toHaveLength(2);
    const view = await call(admin, "GET", "");
    expect(view.body.sent.map((s: any) => [s.title_id, s.stage, s.status])).toEqual([[created.title.id, "due", "sent"]]);
    expect(view.body.today_items).toEqual([]);
    expect(view.body.regua).toMatchObject({ ultimo_erro: null, remetente_ativo: true });
    expect(view.body.regua.ultima_rodada).toBeGreaterThan(0);
  });

  it("e-mail: o ponto de encaixe fica vazio até o canal existir", () => {
    expect(reguaEmailReady()).toBe(false);
    registerReguaEmail(async () => ({ ok: true, ref: "email1" }));
    expect(reguaEmailReady()).toBe(true);
  });
});
