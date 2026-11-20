// ERP ainda é repasse: prova do caminho existente de identidade/proposta,
// sem simular uma inscrição no catálogo nem inventar executor para o bot.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { exec, one } from "../src/db";
import { internalCall } from "../src/internal-api";
import { authenticate, sha } from "../src/security";
import { setMfaPolicy } from "../src/mfa";
import { perform } from "../src/service";
import { botActionContext, createProposal, confirmProposal } from "../src/bot-actions/actions";
import { catalogFor, fullCatalog, type CatalogOperation } from "../src/bot-actions/catalog";
import { erpCommercialOperations } from "../src/modules/erp/commercial-operations";
import { bearer, bot, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { now, uid, type Actor } from "../src/types";

async function confirmingSession(actor: Actor) {
  await setMfaPolicy(env, "financial");
  const token = await bearer(actor);
  const request = new Request("https://test/api/v1/me", { headers: { Authorization: "Bearer " + token } });
  const person = await authenticate(env, request);
  // A fixture de serviço não tem sessão; o guarda financeiro só trata como
  // pessoa quem tem sessionId (ou via). Aqui usamos a mesma autenticação da API.
  expect(person.sessionId).toBeTruthy();
  expect(person).toMatchObject({ aal: 1, mfa: { factor: false, policy: "financial" } });
  return {
    person,
    async withSecondFactor() {
      // Como nos testes de MFA do núcleo, simula o desafio concluído na sessão.
      await exec(env, "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?", now(), await sha(token));
      const confirmed = await authenticate(env, request);
      expect(confirmed).toMatchObject({ sessionId: person.sessionId, aal: 2 });
      return confirmed;
    },
  };
}

async function setup(configured = true) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T15:00:00Z"));
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  await setModule(f.profile, "erp-cobranca", true, f.admin.id);
  const botId = await bot(f);
  if (configured) await perform(env, f.admin, f.profile, "bot.update", {
    id: botId, erp_operations: ["erp_cnab_operational_index", "erp_cnab_operational_index_v2", "erp_cnab_operational_returns_index",
      "erp.business.goals", "erp.business.goal.save", "erp_cnab_operational_generate_v2"], erp_data_acknowledged: true,
  }, uid());
  const chat = await perform(env, f.admin, f.profile, "internal.create", { peer_id: `bot:${botId}` }, uid());
  const sent = await perform(env, f.admin, f.profile, "internal.send", { id: chat.id, text: "Consultar ERP" }, uid());
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", sent.run_id);
  return { f, chat, run, botId };
}
afterEach(async () => {
  try {
    await setMfaPolicy(env, "off");
  } finally {
    vi.useRealTimers();
  }
});

describe("contratos ERP prontos para o catálogo do bot", () => {
  it("expõe contratos sem fingir que o repasse já tem registro onRead/onRoute", () => {
    expect(erpCommercialOperations.length).toBeGreaterThan(20);
    expect(fullCatalog().some(op => op.path.startsWith("erp/v1/"))).toBe(false);
  });

  it("bot configurado na área alcança as três consultas novas pela identidade da pessoa", { timeout: 120_000 }, async () => {
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

  it("concessão é nominal, por bot/área e relida; origem externa e pessoa sem papel não ganham acesso", { timeout: 120_000 }, async () => {
    const { f, run, botId } = await setup(false);
    const ctx = (await botActionContext(env, run))!;
    const read = (path = "cobranca-operacional", actor = ctx.actor) =>
      internalCall(env, actor, { path: `/profiles/${f.profile}/erp/v1/${path}` });
    expect((await read()).status).toBe(403);
    await perform(env, f.admin, f.profile, "bot.update", {
      id: botId, erp_operations: ["erp_cnab_operational_index"], erp_data_acknowledged: true,
    }, uid());
    expect((await read()).status).toBe(200);
    expect((await read("retornos-operacionais")).status).toBe(403);
    expect((await read("cobranca-operacional", { ...ctx.actor, via: { ...ctx.actor.via!, bot_id: uid() } })).status).toBe(403);
    expect(await botActionContext(env, { ...run, conversation_id: uid() })).toBeNull();
    const another = await fixture();
    expect((await internalCall(env, ctx.actor, { path: `/profiles/${another.profile}/erp/v1/me` })).status).not.toBe(200);
    await exec(env, "UPDATE users SET role='operator',access=? WHERE id=?", JSON.stringify(["erp:vendas", "team"]), f.admin.id);
    const sales = (await botActionContext(env, run))!;
    expect((await read("cobranca-operacional", sales.actor)).status).toBe(403);
    await exec(env, "UPDATE users SET role='admin' WHERE id=?", f.admin.id);
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: [] }, uid());
    expect((await read()).status).toBe(403);
  });

  it("concessão exige administrador e aviso; marca de confirmação não substitui proposta nem concessão atual", { timeout: 120_000 }, async () => {
    const { f, run, chat, botId } = await setup(false);
    const grant = { id: botId, erp_operations: ["erp.business.goal.save"], erp_data_acknowledged: true };
    await expect(perform(env, f.member, f.profile, "bot.update", grant, uid())).rejects.toMatchObject({ code: "admin_required" });
    await expect(perform(env, f.admin, f.profile, "bot.update", { ...grant, erp_data_acknowledged: false }, uid())).rejects.toMatchObject({ code: "invalid_request" });
    await expect(perform(env, f.admin, f.profile, "bot.update", { ...grant, erp_operations: ["*"] }, uid())).rejects.toMatchObject({ code: "invalid_request" });
    const ctx = (await botActionContext(env, run))!;
    const spec = erpCommercialOperations.find(op => op.id === "erp.business.goal.save")!;
    const op: CatalogOperation = { name: spec.id, kind: "write", method: spec.method, path: "erp" + spec.path,
      module: "erp", summary: spec.summary, description: spec.description, params: spec.params, sensitive: true, scope: "erp:write" };
    const params = { command_id: uid(), goal_id: null, expected_version: 0,
      data: { name: "Meta com concessão", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "100.00", active: true } };
    await expect(createProposal(ctx, op, params, "Salvar meta")).rejects.toMatchObject({ code: "erp_bot_grant_required" });
    await perform(env, f.admin, f.profile, "bot.update", grant, uid());
    const proposal = await createProposal(ctx, op, params, "Salvar meta");
    const session = await confirmingSession(f.admin), person = await session.withSecondFactor();
    const forged = await internalCall(env, { ...person, via: { ...ctx.actor.via!, proposal_id: proposal.id } },
      { method: "POST", path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas`, body: params });
    expect(forged.status).toBe(403);
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: [] }, uid());
    expect((await confirmProposal(env, person, f.profile, chat.id, proposal.id)).status).toBe("failed");
    const response = await internalCall(env, person, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect((await response.json<any>()).items).toEqual([]);
  });

  it("importação configurada usa proposta e confirmação; NF-e revalida concessão antes de normalizar agente", { timeout: 120_000 }, async () => {
    const { f, run, chat, botId } = await setup(false);
    // O núcleo do ERP não liga Fiscal: sem esta parte a rota é recusada
    // por module_disabled antes de chegar à política nominal do bot.
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    const ctx = (await botActionContext(env, run))!;
    const fiscal = () => internalCall(env, ctx.actor, { path: `/profiles/${f.profile}/erp-comercial-nfe/config` });
    const unconfigured = await fiscal();
    expect(unconfigured.status).toBe(403);
    expect(await unconfigured.json<any>()).toMatchObject({ code: "erp_bot_grant_required" });
    const fiscalCatalog = async () => (await catalogFor(env, ctx.actor, f.profile)).filter(op => op.path.startsWith("erp-comercial-nfe/"));
    expect(await fiscalCatalog()).toEqual([]);
    await perform(env, f.admin, f.profile, "bot.update", {
      id: botId, erp_operations: ["erp_preferences_import_batch", "com1.config.get"], erp_data_acknowledged: true,
    }, uid());
    const configured = await fiscal();
    expect(configured.status).toBe(200);
    expect(await configured.json<any>()).toMatchObject({ environment: "homologacao", stock_timing: "existing", finance_timing: "existing" });
    expect((await fiscalCatalog()).map(op => op.name)).toEqual(["consulta:erp-comercial-nfe/config"]);
    const session = await confirmingSession(f.admin);
    const op: CatalogOperation = { name: "erp_preferences_import_batch", kind: "write", method: "POST", path: "erp/v1/importacoes/:tipo/lote",
      module: "erp", summary: "Importar produtos", description: "Importação confirmada", params: { type: "object", properties: {}, required: [] }, sensitive: true, scope: "erp:write" };
    const proposal = await createProposal(ctx, op, { tipo: "produtos", command_id: uid(), job_id: uid(), file_name: "bot.csv", total_rows: 1, dry_run: false,
      items: [{ row: 2, lines: [2], data: { name: "Produto via concessão" } }] }, "Importar produto");
    const result = await confirmProposal(env, await session.withSecondFactor(), f.profile, chat.id, proposal.id);
    expect(result.status, JSON.stringify(result)).toBe("done");
    expect(result.result.items[0].status).toBe("created");
    await exec(env, "UPDATE bots SET enabled=0 WHERE id=?", botId);
    const disabled = await fiscal();
    expect(disabled.status).toBe(403);
    expect(await disabled.json<any>()).toMatchObject({ code: "erp_bot_grant_required" });
  });

  it("meta usa a proposta e confirmação existentes, pela mesma rota e papel humano", { timeout: 120_000 }, async () => {
    const { f, chat, run } = await setup();
    const session = await confirmingSession(f.admin);
    const ctx = await botActionContext(env, run);
    const spec = erpCommercialOperations.find(op => op.id === "erp.business.goal.save")!;
    // O contrato já é sensível: a política existente pede MFA ao confirmar,
    // mesmo que salvar uma meta não movimente dinheiro.
    expect(spec.sensitive).toBe(true);
    const op: CatalogOperation = { name: spec.id, kind: "write", method: spec.method, path: "erp" + spec.path,
      module: "erp", summary: spec.summary, description: spec.description, params: spec.params, sensitive: spec.sensitive, scope: "erp:write" };
    const proposal = await createProposal(ctx!, op, { command_id: uid(), goal_id: null, expected_version: 0,
      data: { name: "Meta via proposta", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "500.00", active: true } }, "Salvar meta comercial de R$ 500,00");
    expect(proposal.status).toBe("pending");
    await expect(confirmProposal(env, ctx!.actor, f.profile, chat.id, proposal.id)).rejects.toMatchObject({ code: "person_required" });
    expect(await one(env, "SELECT status,decided_at,result FROM bot_proposals WHERE id=?", proposal.id))
      .toMatchObject({ status: "pending", decided_at: null, result: null });
    await expect(confirmProposal(env, session.person, f.profile, chat.id, proposal.id))
      .rejects.toMatchObject({ code: "mfa_required" });
    expect(await one(env, "SELECT status,decided_at,result FROM bot_proposals WHERE id=?", proposal.id))
      .toMatchObject({ status: "pending", decided_at: null, result: null });
    const before = await internalCall(env, f.admin, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect((await before.json<any>()).items).toEqual([]);
    const result = await confirmProposal(env, await session.withSecondFactor(), f.profile, chat.id, proposal.id);
    expect(result.status, JSON.stringify(result)).toBe("done");
    const response = await internalCall(env, f.admin, { path: `/profiles/${f.profile}/erp/v1/meu-negocio/metas` });
    expect((await response.json<any>()).items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Meta via proposta", target: "500.00" })]));
  });

  it("remessa financeira recusa o próprio bot e a sessão humana sem segundo fator", { timeout: 120_000 }, async () => {
    const { f, chat, run } = await setup();
    const session = await confirmingSession(f.admin);
    const ctx = await botActionContext(env, run);
    const spec = erpCommercialOperations.find(op => op.id === "erp_cnab_operational_generate_v2")!;
    expect(spec.sensitive).toBe(true);
    const op: CatalogOperation = { name: spec.id, kind: "write", method: spec.method, path: "erp" + spec.path,
      module: "erp", summary: spec.summary, description: spec.description, params: spec.params, sensitive: spec.sensitive, scope: "erp:write" };
    // A recusa deve ocorrer antes da execução e da busca de perfil/título.
    // O fluxo financeiro válido completo está em erp-cnab-operacional-rotas.
    const proposal = await createProposal(ctx!, op, {
      command_id: uid(), profile_id: uid(), expected_version: 1, expected_approval_version: 1,
      generated_on: "2026-11-19", titles: [{ title_id: uid(), expected_version: 1, document_number: "TESTE001" }],
      confirm_operational: true, preview_hash: "0".repeat(64), encoding_profile: "itau109-no-charges-v1",
      confirm_encoding_profile: true, zero_daily_title_ids: [],
    }, "Gerar remessa operacional de cobrança");
    for (const [actor, code] of [[ctx!.actor, "person_required"], [session.person, "mfa_required"]] as const) {
      await expect(confirmProposal(env, actor, f.profile, chat.id, proposal.id)).rejects.toMatchObject({ code });
      expect(await one(env, "SELECT status,decided_at,result FROM bot_proposals WHERE id=?", proposal.id))
        .toMatchObject({ status: "pending", decided_at: null, result: null });
    }
    const response = await internalCall(env, session.person, { path: `/profiles/${f.profile}/erp/v1/cobranca-operacional-v2/remittances` });
    expect(response.status).toBe(200);
    expect((await response.json<any>()).items).toEqual([]);
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
