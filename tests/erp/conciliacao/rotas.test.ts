// Conciliação pelo Worker (/erp-conciliacao): com o Financeiro desligado a
// rota recusa dizendo o que ligar; ligado, lê o resumo, importa um OFX numa
// conta e lista as pendências com o saldo por dia; o arquivo repetido não
// duplica; o bot sem concessão não concilia; o módulo Financeiro e o
// inventário dos bots conhecem a conciliação (pendências: leitura; conciliar e
// receber: sensíveis). Sem rede: área de ensaio com o cofre simulado (sem uso aqui).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpConciliacaoRoute } from "../../../src/erp/conciliacao/routes.ts";
import { localFetch } from "../../../src/erp/api/local-fetch.ts";
import { erpIdentity } from "../../../src/modules/erp/identity";
import { modules } from "../../../src/modules/registry";
import { ERP_BOT_OPERATIONS, erpBotInventory, erpBotModules } from "../../../src/modules/erp/bot-access";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

async function area(withFinance: boolean) {
  const a = await vaultArea();
  await setModule(a.profile, "erp", true, "teste");
  await setModule(a.profile, "erp-financeiro", withFinance, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpConciliacaoRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-conciliacao/${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    return { status: response.status, body: await response.json<any>() };
  };
  const admin = await member("admin", a.profile);
  /** A conta do banco, pelo RPC do Financeiro (como a tela de contas financeiras faz). */
  const account = async () => {
    const identity = await erpIdentity(env, admin, a.profile, "POST", `/api/v1/profiles/${a.profile}/erp/v1/rpc`);
    const response = await localFetch(env, a.profile, admin, identity, { gate: { denied: null }, trackCustomers: false })("https://erp.wabotia.invalid/rest/v1/rpc/erp_finance_account_execute", {
      method: "POST", body: JSON.stringify({ p_user_id: identity.actor!.user_id, p_command_id: crypto.randomUUID(), p_action: "account_create", p_data: {
        account_type: "checking", institution_code: "341", institution_name: "Itaú", agency: "1234", account_number: "12345", account_digit: "6", name: "Banco do Ensaio",
        start_on: "2020-01-01", opening_cents: "0" } }) });
    const body = await response.json<any>();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return String(body.record.id);
  };
  return { ...a, call, admin, account };
}

const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><DTSTART>20261101<DTEND>20261105
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261102<TRNAMT>150.00<FITID>R1<MEMO>PIX RECEBIDO</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-12.90<FITID>R2<MEMO>TARIFA BANCARIA</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>137.10<DTASOF>20261105</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("Conciliação pelo Worker", () => {
  it("é do módulo Financeiro e entra no inventário dos bots: pendências leitura, conciliar e receber sensíveis", () => {
    const finance = modules.find((m) => m.id === "erp-financeiro")!;
    expect(finance.routes).toContain("erp-conciliacao");
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.group === "conciliacao");
    expect(ops.filter((op) => op.sensitive).map((op) => op.id).sort()).toEqual(["erp.conciliacao.banco.conciliar", "erp.conciliacao.cartao.receber"]);
    expect(ops.filter((op) => !op.sensitive).every((op) => op.method === "GET")).toBe(true);
    expect([...erpBotModules(ops[0])].sort()).toEqual(["erp", "erp-financeiro"]);
    const group = erpBotInventory({ erp: true }).groups.find((g) => g.id === "conciliacao")!;
    expect(group.title).toBe("Conciliação bancária e de cartões");
    expect(group.operations.find((op) => op.id === "erp.conciliacao.banco")).toMatchObject({ kind: "read", sensitive: false });
  });

  it("Financeiro desligado: 409 module_disabled dizendo qual módulo ligar", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(false);
    const refused = await call(admin, "GET", "resumo");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("module_disabled");
    expect(refused.body.error.message).toMatch(/Financeiro/);
  });

  it("ligado: resumo, importação do OFX sem duplicar, pendências com o saldo por dia e o bot sem concessão recusado", { timeout: 60_000 }, async () => {
    const { call, admin, account: createAccount } = await area(true);
    const account = await createAccount();
    const overview = await call(admin, "GET", "resumo");
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body).toMatchObject({ can_write: true, rules: [], rates: [] });
    expect(overview.body.accounts.map((a: any) => a.id)).toContain(account);
    const imported = await call(admin, "POST", `banco/${account}/importar`, { formato: "ofx", arquivo: "extrato.ofx", conteudo: ofx });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body).toMatchObject({ new_lines: 2, balances: 3, duplicate_file: false });
    // O mesmo pedido repetido (sem comando): a mesma resposta, sem gravar de novo.
    const replay = await call(admin, "POST", `banco/${account}/importar`, { formato: "ofx", arquivo: "extrato.ofx", conteudo: ofx });
    expect(replay.body).toMatchObject({ new_lines: 2, replayed: true });
    // O mesmo arquivo numa importação nova: nada a importar.
    const again = await call(admin, "POST", `banco/${account}/importar`, { formato: "ofx", arquivo: "extrato.ofx", conteudo: ofx, comando: crypto.randomUUID() });
    expect(again.body).toMatchObject({ new_lines: 0, duplicate_file: true });
    const lines = await call(admin, "GET", `banco/${account}?situacao=pendentes`);
    expect(lines.status).toBe(200);
    expect(lines.body.lines.map((l: any) => l.memo)).toEqual(["PIX RECEBIDO", "TARIFA BANCARIA"]);
    expect(lines.body.balances.find((b: any) => b.day === "2026-11-05")).toMatchObject({ bank_cents: "13710" });
    const bad = await call(admin, "GET", `banco/${account}?situacao=qualquer`);
    expect(bad.status).toBe(400);
    const broken = await call(admin, "POST", `banco/${account}/importar`, { formato: "ofx", conteudo: "não é OFX" });
    expect(broken.status).toBe(400);
    expect(broken.body.error.message).toMatch(/não parece um extrato OFX/);
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    const line = lines.body.lines[0];
    const denied = await call(bot, "POST", `banco/linhas/${line.id}`, { acao: "ignorar", versao: line.version, motivo: "teste do bot" });
    expect(denied.status).toBe(403);
    const importByBot = await call(bot, "POST", `banco/${account}/importar`, { formato: "ofx", conteudo: ofx });
    expect(importByBot.status).toBe(403);
  });
});
