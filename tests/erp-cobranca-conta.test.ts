// Cobrança de conta a receber do ERP (src/erp/conversa/charges.ts): o que a
// confirmação do provedor faz com a conta (baixa automática, sugestão de baixa,
// pendência, estorno), a preferência do administrador (nasce desligada, aviso e
// registro ao ligar), as operações dos bots no grupo Financeiro e o financeiro
// de exemplo dos modelos de ramo. Sem provedor nem ERP de verdade.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { uid, type Actor } from "../src/types";
import {
  chargeSettings, commandId, onChargeUpdated, saveChargeSettings, settleConflict, SETTLE_LABELS,
} from "../src/erp/conversa/charges";
import { ERP_CHARGE_OPERATIONS, ERP_CONVERSA_OPERATIONS, erpConversaOperationFor } from "../src/erp/conversa/contract";
import { ERP_BOT_OPERATIONS, erpBotModules } from "../src/modules/erp/bot-access";
import { templateExamples } from "../src/area-templates/examples";

const admin = { id: "u-admin", kind: "user", name: "Dona", role: "admin", profiles: ["*"], scopes: [], bots: [] } as unknown as Actor;
const member = { ...admin, id: "u-member", role: "operator" } as unknown as Actor;
const account = "11111111-1111-4111-8111-111111111111";

async function charge(profile: string, state = "aguardando") {
  const id = uid();
  await exec(env, `INSERT INTO erp_title_charges(id,profile_id,title_id,title_version,method,amount_cents,description,settle_state,actor,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,1,1)`, id, profile, "22222222-2222-4222-8222-222222222222", 3, "pix", 5000, "Conta de teste", state, admin.id);
  return id;
}
const stateOf = async (id: string) => (await one(env, "SELECT settle_state,note FROM erp_title_charges WHERE id=?", id))!;

describe("cobrança de conta a receber: confirmação do provedor", () => {
  it("desligada (o padrão), o pagamento confirmado vira sugestão de baixa, uma vez só", async () => {
    const profile = `p-${uid()}`;
    expect((await chargeSettings(env, profile)).auto_settle).toBe(false);
    const id = await charge(profile);
    await onChargeUpdated(env, profile, { id, status: "paid" });
    expect((await stateOf(id)).settle_state).toBe("sugestao");
    // O mesmo aviso de novo não muda nada.
    await onChargeUpdated(env, profile, { id, status: "paid" });
    expect((await stateOf(id)).settle_state).toBe("sugestao");
    expect(SETTLE_LABELS.sugestao).toBe("Pago: confirme a baixa");
  });

  it("ligada, o pagamento confirmado entra para o alarme baixar; estorno depois da baixa reabre", async () => {
    const profile = `p-${uid()}`;
    await saveChargeSettings(env, admin, profile, { baixar_sozinho: true, conta_financeira: account, confirmo: true });
    const id = await charge(profile);
    await onChargeUpdated(env, profile, { id, status: "paid" });
    expect((await stateOf(id)).settle_state).toBe("baixar");
    await exec(env, "UPDATE erp_title_charges SET settle_state='baixada',settlement_id='s1' WHERE id=?", id);
    await onChargeUpdated(env, profile, { id, status: "refunded" });
    expect((await stateOf(id)).settle_state).toBe("estornar");
  });

  it("vencida sem pagamento encerra; pago depois de vencer ainda vale", async () => {
    const profile = `p-${uid()}`;
    const id = await charge(profile);
    await onChargeUpdated(env, profile, { id, status: "expired" });
    expect(await stateOf(id)).toMatchObject({ settle_state: "encerrada", note: "A cobrança venceu sem pagamento." });
    await onChargeUpdated(env, profile, { id, status: "paid" });
    expect((await stateOf(id)).settle_state).toBe("sugestao");
  });

  it("estorno antes da baixa encerra com o motivo, sem mexer na conta", async () => {
    const profile = `p-${uid()}`;
    const id = await charge(profile, "sugestao");
    await onChargeUpdated(env, profile, { id, status: "refunded" });
    expect(await stateOf(id)).toMatchObject({ settle_state: "encerrada", note: expect.stringContaining("estornado no provedor antes da baixa") });
  });

  it("conta baixada ou mudada à mão vira pendência, não baixa", () => {
    const row = { title_version: 3, amount_cents: 5000 };
    expect(settleConflict(row, { status: "open", cancelled: false, version: 3, balance_cents: "5000" })).toBeNull();
    expect(settleConflict(row, { status: "settled", cancelled: false, version: 4, balance_cents: "0" })).toContain("já estava baixada");
    expect(settleConflict(row, { status: "partial", cancelled: false, version: 4, balance_cents: "5000" })).toContain("mudada à mão");
    expect(settleConflict(row, { status: "open", cancelled: false, version: 3, balance_cents: "4000" })).toContain("saldo");
  });

  it("o comando de baixa no ERP tem id estável por cobrança (repetir não baixa duas vezes)", async () => {
    const a = await commandId("erp-charge-settle:x"), b = await commandId("erp-charge-settle:x");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await commandId("erp-charge-settle:y")).not.toBe(a);
  });
});

describe("preferência do Financeiro: baixar sozinho as contas pagas por Pix ou link", () => {
  it("só o administrador muda, ligar pede a conta e o aviso, e tudo fica registrado", async () => {
    const profile = `p-${uid()}`;
    await expect(saveChargeSettings(env, member, profile, { baixar_sozinho: true })).rejects.toMatchObject({ status: 403 });
    await expect(saveChargeSettings(env, admin, profile, { baixar_sozinho: true, confirmo: true })).rejects.toMatchObject({ code: "erp_charge_account_required" });
    await expect(saveChargeSettings(env, admin, profile, { baixar_sozinho: true, conta_financeira: account })).rejects.toMatchObject({ code: "erp_charge_confirm_required" });
    const on = await saveChargeSettings(env, admin, profile, { baixar_sozinho: true, conta_financeira: account, confirmo: true });
    expect(on).toMatchObject({ auto_settle: true, account_id: account, enabled_by: admin.id });
    const off = await saveChargeSettings(env, admin, profile, { baixar_sozinho: false });
    expect(off).toMatchObject({ auto_settle: false, enabled_by: null });
    const audit = await all(env, "SELECT action,actor FROM erp_title_charge_audit WHERE profile_id=? ORDER BY created,rowid", profile);
    expect(audit.map(row => row.action)).toEqual(["auto_settle_on", "auto_settle_off"]);
    expect(audit.every(row => row.actor === admin.id)).toBe(true);
  });
});

describe("operações com nome estável", () => {
  it("gerar cobrança e confirmar a sugestão de baixa são do grupo Financeiro, sensíveis", () => {
    const ids = ["erp.financeiro.cobranca.gerar", "erp.financeiro.cobranca.confirmar_baixa"];
    for (const id of ids) {
      const op = ERP_BOT_OPERATIONS.find(item => item.id === id)!;
      expect(op).toMatchObject({ group: "financeiro", sensitive: true });
      expect(op.description.length).toBeGreaterThan(60);
      expect(erpBotModules(op)).toContain("erp-financeiro");
    }
    // A preferência é só da tela do administrador.
    expect(ERP_BOT_OPERATIONS.some(op => op.id.startsWith("erp.financeiro.cobranca.preferencias"))).toBe(false);
    // O envio pelo WhatsApp continua com as mesmas quatro operações.
    expect(ERP_CONVERSA_OPERATIONS.map(op => op.name)).toEqual(["erp.conversa.linhas", "erp.conversa.preparar", "erp.conversa.envios", "erp.conversa.enviar"]);
    expect(ERP_CHARGE_OPERATIONS.every(op => op.conversations === false)).toBe(true);
  });
  it("as rotas da cobrança não se confundem com as do envio", () => {
    expect(erpConversaOperationFor("GET", "erp-conversa/financeiro/preferencias")!.operation.name).toBe("erp.financeiro.cobranca.preferencias");
    expect(erpConversaOperationFor("POST", "erp-conversa/conta/abc/cobranca")!.operation.name).toBe("erp.financeiro.cobranca.gerar");
    expect(erpConversaOperationFor("POST", "erp-conversa/conta/abc/cobranca/xyz/baixar")!.params).toEqual({ id: "abc", cobranca: "xyz" });
    expect(erpConversaOperationFor("GET", "erp-conversa/conta/abc")!.operation.name).toBe("erp.conversa.preparar");
  });
});

describe("modelos de ramo: financeiro básico de exemplo", () => {
  it("com Financeiro, formas, categorias e a conta Caixa; só Vendas, só as formas; sem ERP, nada", () => {
    const full = templateExamples({ id: "comercio", modules: { erp: true, "erp-vendas": true, "erp-financeiro": true } }).financeiro!;
    expect(full.payment_methods.map(item => item.description)).toEqual(["Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito", "Boleto"]);
    expect(full.categories.map(item => item.name.replace(" (exemplo)", ""))).toEqual(["Receita de vendas", "Receita de serviços", "Compras", "Despesas fixas", "Impostos"]);
    expect(full.account).toEqual({ name: "Caixa" });
    const sales = templateExamples({ id: "x", modules: { erp: true, "erp-vendas": true } }).financeiro!;
    expect(sales.categories).toEqual([]);
    expect(sales.account).toBeNull();
    expect(templateExamples({ id: "x", modules: { os: true } }).financeiro).toBeUndefined();
  });
});
