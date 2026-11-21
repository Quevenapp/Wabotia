// Boleto pela API do banco (src/erp/boleto-api/service.ts) no D1, com o banco
// simulado no lugar da rede: interruptor de cada banco (desligado por padrão,
// aviso para produção), aviso de pagamento conferido pela consulta, sugestão
// de baixa ou baixa automática (a mesma opção do Pix e do link), idempotência,
// consulta periódica, parte desligada e segredos fora das tabelas e das
// respostas. Nenhuma chamada a banco de verdade.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { uid, type Actor } from "../src/types";
import { secret, setSecret, sha } from "../src/security";
import type { BankHttp, BankHttpRequest } from "../src/erp/boleto-api/adapter";
import {
  applyRecord, bankSwitches, boletoSettleConflict, boletoView, boletoWebhook, processBoletos, requireBilling, saveBankSwitch, setBoletoTransport,
  type BoletoRow,
} from "../src/erp/boleto-api/service";
import { saveChargeSettings } from "../src/erp/conversa/charges";
import { ERP_BOT_OPERATIONS, erpBotModules } from "../src/modules/erp/bot-access";
import { erpCobrancaModule } from "../src/modules/erp/definition";
import { setModule } from "./erp-module-helper";

const admin = { id: "u-admin", kind: "user", name: "Dona", role: "admin", profiles: ["*"], scopes: [], bots: [] } as unknown as Actor;
const member = { ...admin, id: "u-member", role: "operator" } as unknown as Actor;
const account = "11111111-1111-4111-8111-111111111111";
const titleId = "22222222-2222-4222-8222-222222222222";

afterEach(() => setBoletoTransport(null));

/** Banco Inter simulado: devolve a situação pedida e guarda os pedidos. */
function interBank(situation: () => Record<string, unknown>) {
  const requests: BankHttpRequest[] = [];
  const http: BankHttp = async request => {
    requests.push(request);
    if (request.url.includes("/oauth/v2/token")) return { status: 200, body: { access_token: "tok" } };
    if (request.method === "GET" && request.url.includes("/cobranca/v3/cobrancas/")) return { status: 200, body: { cobranca: { codigoSolicitacao: "SOL-1", ...situation() } } };
    return { status: 404, body: null };
  };
  setBoletoTransport(() => http);
  return requests;
}

/** Área com Cadastros, Financeiro e Cobrança bancária, o Inter ligado e uma conta financeira pela API. */
async function area(options: { billing?: boolean } = {}) {
  const profile = `p-${uid()}`;
  for (const id of ["erp", "erp-financeiro"]) await setModule(profile, id, true, admin.id);
  await setModule(profile, "erp-cobranca", options.billing !== false, admin.id);
  await saveBankSwitch(env, admin, profile, "inter", { ligado: true, ambiente: "sandbox" });
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("");
  await setSecret(env, `erp-boleto-api:${profile}:${account}`, { client_id: "id", client_secret: "segredo-do-banco", certificado: "PEM", chave_privada: "KEY", webhook_token: token });
  await exec(env, `INSERT INTO erp_boleto_api_accounts(profile_id,account_id,mode,bank,hybrid,settings,secret_fields,webhook_hash,updated_by,updated)
    VALUES(?,?,'api','inter',1,'{}',?,?,?,1)`, profile, account, JSON.stringify(["client_id", "client_secret", "certificado", "chave_privada"]), await sha(token), admin.id);
  return { profile, token };
}

async function boleto(profile: string, extra: Partial<BoletoRow> = {}) {
  const id = uid();
  await exec(env, `INSERT INTO erp_boleto_api_titles(id,profile_id,title_id,title_version,account_id,bank,environment,seu_numero,bank_ref,amount_cents,due_on,issued_on,
      status,settle_state,next_poll_at,actor,created,updated) VALUES(?,?,?,?,?,'inter','sandbox','1234567890',?,5000,'2026-12-10','2026-11-21',?,'aguardando',?,?,1,1)`,
    id, profile, titleId, 3, account, extra.bank_ref ?? "SOL-1", extra.status ?? "registrado", extra.next_poll_at ?? null, admin.id);
  return id;
}
const rowOf = async (id: string) => (await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", id))!;

describe("interruptor de cada banco", () => {
  it("nasce desligado em homologação; só o administrador muda; produção pede o aviso; fica registrado", async () => {
    const profile = `p-${uid()}`;
    const view = await bankSwitches(env, admin, profile);
    expect(view.bancos.map(item => [item.banco, item.ligado, item.ambiente])).toEqual([["inter", false, "sandbox"], ["sicoob", false, "sandbox"], ["bb", false, "sandbox"], ["itau", false, "sandbox"]]);
    await expect(saveBankSwitch(env, member, profile, "inter", { ligado: true })).rejects.toMatchObject({ status: 403 });
    await expect(saveBankSwitch(env, admin, profile, "inter", { ligado: true, ambiente: "producao" })).rejects.toMatchObject({ code: "erp_boleto_confirm_required" });
    await saveBankSwitch(env, admin, profile, "inter", { ligado: true, ambiente: "producao", confirmo: true });
    await saveBankSwitch(env, admin, profile, "inter", { ligado: false });
    await expect(saveBankSwitch(env, admin, profile, "caixa", { ligado: true })).rejects.toMatchObject({ status: 404 });
    const audit = await all(env, "SELECT action,actor FROM erp_boleto_api_audit WHERE profile_id=? ORDER BY created,rowid", profile);
    expect(audit.map(row => row.action)).toEqual(["bank_on", "bank_off"]);
    // A lista dos campos não traz valor nenhum, só os rótulos.
    for (const bank of (await bankSwitches(env, admin, profile)).bancos)
      for (const field of bank.campos) expect(Object.keys(field).sort()).toEqual(["chave", "dica", "obrigatorio", "rotulo", "segredo", "varias_linhas"]);
  });
});

describe("aviso de pagamento do banco", () => {
  it("vale só depois da consulta: pago vira sugestão de baixa, uma vez só", async () => {
    const { profile, token } = await area();
    const requests = interBank(() => ({ situacao: "RECEBIDO", valorTotalRecebido: "50.00", dataSituacao: "2026-12-09", origemRecebimento: "BOLETO" }));
    const id = await boleto(profile);
    expect(await boletoWebhook(env, token, [{ codigoSolicitacao: "SOL-1", situacao: "RECEBIDO" }])).toEqual({ received: true, consultados: 1 });
    expect(await rowOf(id)).toMatchObject({ status: "pago", settle_state: "sugestao", paid_cents: 5000, paid_on: "2026-12-09", paid_via: "boleto" });
    expect(requests.some(item => item.method === "GET" && item.url.endsWith("/cobranca/v3/cobrancas/SOL-1"))).toBe(true);
    expect(requests.every(item => item.mtls)).toBe(true);
    // O mesmo aviso de novo não muda nada nem registra de novo.
    expect(await boletoWebhook(env, token, [{ codigoSolicitacao: "SOL-1" }])).toEqual({ received: true, consultados: 0 });
    const audit = await all(env, "SELECT action FROM erp_boleto_api_audit WHERE profile_id=? AND boleto_id=?", profile, id);
    expect(audit.map(row => row.action)).toEqual(["paid_sugestao"]);
    expect(boletoView(await rowOf(id))).toMatchObject({ pode_confirmar_baixa: true, baixa_rotulo: "Pago: confirme a baixa" });
  });

  it("o corpo do aviso não basta: o banco ainda em aberto deixa o boleto em aberto", async () => {
    const { profile, token } = await area();
    interBank(() => ({ situacao: "A_RECEBER" }));
    const id = await boleto(profile);
    await boletoWebhook(env, token, [{ codigoSolicitacao: "SOL-1", situacao: "RECEBIDO", valorTotalRecebido: "50.00" }]);
    expect(await rowOf(id)).toMatchObject({ status: "registrado", settle_state: "aguardando" });
  });

  it("com a baixa automática ligada (a opção do Pix e do link), o pago entra para o alarme baixar", async () => {
    const { profile, token } = await area();
    await saveChargeSettings(env, admin, profile, { baixar_sozinho: true, conta_financeira: account, confirmo: true });
    interBank(() => ({ situacao: "RECEBIDO", valorTotalRecebido: "50.00", dataSituacao: "2026-12-09" }));
    const id = await boleto(profile);
    await boletoWebhook(env, token, { codigoSolicitacao: "SOL-1" });
    expect((await rowOf(id)).settle_state).toBe("baixar");
  });

  it("endereço desconhecido é 404; aviso de outro boleto não consulta nada; nada responde dado do boleto", async () => {
    const { profile, token } = await area();
    const requests = interBank(() => ({ situacao: "RECEBIDO" }));
    await boleto(profile);
    await expect(boletoWebhook(env, "cd".repeat(24), [{ codigoSolicitacao: "SOL-1" }])).rejects.toMatchObject({ status: 404 });
    await expect(boletoWebhook(env, "nao-e-codigo", {})).rejects.toMatchObject({ status: 404 });
    expect(await boletoWebhook(env, token, [{ codigoSolicitacao: "OUTRO" }])).toEqual({ received: true, consultados: 0 });
    expect(requests).toHaveLength(0);
  });

  it("com a Cobrança bancária desligada, o aviso é recebido e não mexe em nada; a rota diz o que ligar", async () => {
    const { profile, token } = await area({ billing: false });
    interBank(() => ({ situacao: "RECEBIDO" }));
    const id = await boleto(profile);
    expect(await boletoWebhook(env, token, [{ codigoSolicitacao: "SOL-1" }])).toEqual({ received: true, consultados: 0 });
    expect((await rowOf(id)).status).toBe("registrado");
    await expect(requireBilling(env, profile)).rejects.toMatchObject({ status: 409, code: "module_disabled", message: expect.stringContaining("Cobrança bancária") });
  });
});

describe("consulta periódica e baixa", () => {
  it("o alarme consulta o boleto vencido de consulta e marca a sugestão; banco fora do ar só adia", async () => {
    const { profile } = await area();
    let down = true;
    setBoletoTransport(() => async request => {
      if (down) throw new TypeError("network");
      if (request.url.includes("/oauth/")) return { status: 200, body: { access_token: "tok" } };
      return { status: 200, body: { cobranca: { situacao: "RECEBIDO", valorTotalRecebido: "50.00", dataSituacao: "2026-12-10" } } };
    });
    const id = await boleto(profile, { next_poll_at: 0 });
    await processBoletos(env, profile);
    const later = await rowOf(id);
    expect(later.status).toBe("registrado");
    expect(later.next_poll_at).toBeGreaterThan(Date.now());
    down = false;
    await exec(env, "UPDATE erp_boleto_api_titles SET next_poll_at=0 WHERE id=?", id);
    await processBoletos(env, profile);
    expect(await rowOf(id)).toMatchObject({ status: "pago", settle_state: "sugestao", next_poll_at: null });
  });

  it("baixado no banco sem pagamento encerra; aplicar o mesmo resultado duas vezes não muda nada", async () => {
    const { profile } = await area();
    const id = await boleto(profile);
    const closed = { bank_ref: "SOL-1", our_number: null, status: "baixado" as const, barcode: null, digitable_line: null, pix_code: null, pix_txid: null,
      due_on: null, amount_cents: null, paid_cents: null, paid_on: null, paid_via: null, receipt: null };
    await applyRecord(env, profile, await rowOf(id), closed, "bank");
    await applyRecord(env, profile, await rowOf(id), closed, "bank");
    expect(await rowOf(id)).toMatchObject({ status: "baixado", settle_state: "encerrada" });
    expect((await all(env, "SELECT action FROM erp_boleto_api_audit WHERE boleto_id=?", id)).map(row => row.action)).toEqual(["closed_by_bank"]);
  });

  it("conta mudada à mão, baixada ou paga a menor vira pendência, não baixa", () => {
    const row = { title_version: 3, amount_cents: 5000, paid_cents: 5000 };
    expect(boletoSettleConflict(row, { status: "open", cancelled: false, version: 3, balance_cents: "5000" })).toBeNull();
    expect(boletoSettleConflict(row, { status: "partial", cancelled: false, version: 4, balance_cents: "5000" })).toContain("depois que o boleto foi registrado");
    expect(boletoSettleConflict(row, { status: "settled", cancelled: false, version: 4, balance_cents: "0" })).toContain("já estava baixada");
    expect(boletoSettleConflict({ ...row, paid_cents: 4000 }, { status: "open", cancelled: false, version: 3, balance_cents: "5000" })).toContain("menor que o boleto");
    // Pago a mais (juros, multa): baixa, a diferença vai como juros.
    expect(boletoSettleConflict({ ...row, paid_cents: 5200 }, { status: "open", cancelled: false, version: 3, balance_cents: "5000" })).toBeNull();
  });
});

describe("segredos e bots", () => {
  it("os segredos ficam só no cofre, cifrados; a tabela guarda só os nomes", async () => {
    const { profile } = await area();
    const row = await one(env, "SELECT * FROM erp_boleto_api_accounts WHERE profile_id=?", profile);
    expect(JSON.stringify(row)).not.toContain("segredo-do-banco");
    const stored = await one(env, "SELECT value FROM secrets WHERE id=?", `erp-boleto-api:${profile}:${account}`);
    expect(String(stored!.value)).not.toContain("segredo-do-banco");
    expect((await secret(env, `erp-boleto-api:${profile}:${account}`)).client_secret).toBe("segredo-do-banco");
  });

  it("consultar é leitura; registrar, alterar, baixar e confirmar são sensíveis, no assunto Cobrança no banco", () => {
    const ops = ERP_BOT_OPERATIONS.filter(op => op.id.startsWith("erp.boleto."));
    expect(ops.map(op => [op.id, op.sensitive]).sort()).toEqual([
      ["erp.boleto.baixar", true], ["erp.boleto.confirmar_baixa", true], ["erp.boleto.consultar_banco", false],
      ["erp.boleto.registrar", true], ["erp.boleto.vencimento", true], ["erp.boleto.ver", false],
    ]);
    for (const op of ops) {
      expect(op.group).toBe("cobranca");
      expect(erpBotModules(op)).toContain("erp-cobranca");
    }
    expect(erpCobrancaModule.routes).toEqual(["erp-boleto"]);
  });
});
