// ERP ainda é repasse: prova do caminho existente de identidade/proposta,
// sem simular uma inscrição no catálogo nem inventar executor para o bot.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { exec, one } from "../src/db";
import { internalCall } from "../src/internal-api";
import { perform } from "../src/service";
import { botActionContext, createProposal, confirmProposal } from "../src/bot-actions/actions";
import { fullCatalog, type CatalogOperation } from "../src/bot-actions/catalog";
import { erpCommercialOperations } from "../src/modules/erp/commercial-operations";
import { bot, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { uid } from "../src/types";

async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T15:00:00Z"));
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  await setModule(f.profile, "erp-cobranca", true, f.admin.id);
  const botId = await bot(f);
  const chat = await perform(env, f.admin, f.profile, "internal.create", { peer_id: `bot:${botId}` }, uid());
  const sent = await perform(env, f.admin, f.profile, "internal.send", { id: chat.id, text: "Consultar ERP" }, uid());
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", sent.run_id);
  return { f, chat, run, botId };
}
afterEach(() => vi.useRealTimers());

describe("contratos ERP prontos para o catálogo do bot", () => {
  it("expõe contratos sem fingir que o repasse já tem registro onRead/onRoute", () => {
    expect(erpCommercialOperations.length).toBeGreaterThan(20);
    expect(fullCatalog().some(op => op.path.startsWith("erp/v1/"))).toBe(false);
  });

  it("bot escolhido na conversa interna alcança as três consultas novas pela identidade da pessoa", { timeout: 120_000 }, async () => {
    const { f, run } = await setup();
    const ctx = await botActionContext(env, run);
    expect(ctx).not.toBeNull();
    for (const path of ["cobranca-operacional", "cobranca-operacional-v2", "retornos-operacionais"]) {
      const response = await internalCall(env, ctx!.actor, { path: `/profiles/${f.profile}/erp/v1/${path}` });
      const body = await response.json<any>();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.items).toEqual([]);
      // Sem vínculo deste bot com a conversa não há contexto de equipe.
      expect(await botActionContext(env, { ...run, bot_id: uid() })).toBeNull();
      // A origem externa mantém o teto de cliente, mesmo informando o ator admin.
      expect(await botActionContext(env, { ...run, conversation_id: uid(), actor: f.admin.id })).toBeNull();
    }
  });

  it("meta usa a proposta e confirmação existentes, pela mesma rota e papel humano", { timeout: 120_000 }, async () => {
    const { f, chat, run } = await setup();
    const ctx = await botActionContext(env, run);
    const spec = erpCommercialOperations.find(op => op.id === "erp.business.goal.save")!;
    const op: CatalogOperation = { name: spec.id, kind: "write", method: spec.method, path: "erp" + spec.path,
      module: "erp", summary: spec.summary, description: spec.description, params: spec.params, sensitive: spec.sensitive, scope: "erp:write" };
    const proposal = await createProposal(ctx!, op, { command_id: uid(), goal_id: null, expected_version: 0,
      data: { name: "Meta via proposta", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "500.00", active: true } }, "Salvar meta comercial de R$ 500,00");
    expect(proposal.status).toBe("pending");
    await expect(confirmProposal(env, ctx!.actor, f.profile, chat.id, proposal.id)).rejects.toMatchObject({ code: "person_required" });
    await expect(confirmProposal(env, { ...f.admin, aal: 1, mfa: { factor: false, policy: "financial" } }, f.profile, chat.id, proposal.id))
      .rejects.toMatchObject({ code: "mfa_required" });
    expect((await one(env, "SELECT status FROM bot_proposals WHERE id=?", proposal.id)).status).toBe("pending");
    const before = await internalCall(env, f.admin, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect((await before.json<any>()).items).toEqual([]);
    const result = await confirmProposal(env, f.admin, f.profile, chat.id, proposal.id);
    expect(result.status, JSON.stringify(result)).toBe("done");
    const response = await internalCall(env, f.admin, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect((await response.json<any>()).items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Meta via proposta", target: "500.00" })]));
  });

  it("perda de papel da pessoa entre proposta e confirmação recusa a escrita", { timeout: 120_000 }, async () => {
    const { f, chat, run } = await setup();
    const ctx = await botActionContext(env, run);
    const spec = erpCommercialOperations.find(op => op.id === "erp.business.goal.save")!;
    const op: CatalogOperation = { name: spec.id, kind: "write", method: spec.method, path: "erp" + spec.path,
      module: "erp", summary: spec.summary, description: spec.description, params: spec.params, sensitive: spec.sensitive, scope: "erp:write" };
    const proposal = await createProposal(ctx!, op, { command_id: uid(), goal_id: null, expected_version: 0,
      data: { name: "Meta recusada", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "500.00", active: true } }, "Salvar meta comercial de R$ 500,00");
    await exec(env, "UPDATE users SET role='operator',access=? WHERE id=?", JSON.stringify(["*"]), f.admin.id);
    const current = await botActionContext(env, run);
    expect(current).not.toBeNull();
    const denied = await internalCall(env, current!.actor, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect(denied.status).toBe(403);
    expect((await denied.json<any>()).error.code).toBe("erp_role_required");
    // Mesmo recebendo o ator anterior, confirmar relê a pessoa antes de executar.
    const result = await confirmProposal(env, f.admin, f.profile, chat.id, proposal.id);
    expect(result.status, JSON.stringify(result)).toBe("failed");
    await exec(env, "UPDATE users SET role='admin' WHERE id=?", f.admin.id);
    const response = await internalCall(env, f.admin, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect(response.status).toBe(200);
    expect((await response.json<any>()).items).toEqual([]);
  });
});
