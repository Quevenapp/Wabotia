// Bots alcançando o ERP pelo catálogo: a operação nominal só aparece para o
// bot que tem a concessão daquela operação naquela área, e o caminho inteiro
// passa pelas ferramentas do bot (catálogo → proposta → confirmação →
// resultado), sem inserir proposta no banco. Leitura comum vai direto;
// leitura sensível e escrita, por proposta que a pessoa confirma.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { exec, one } from "../src/db";
import { internalCall } from "../src/internal-api";
import { authenticate, sha } from "../src/security";
import { setMfaPolicy } from "../src/mfa";
import { perform } from "../src/service";
import { botActionContext, confirmProposal, newToolState, runBotTool } from "../src/bot-actions/actions";
import { catalogFor, fullCatalog } from "../src/bot-actions/catalog";
import { ERP_BOT_OPERATIONS } from "../src/modules/erp/bot-access";
import { bearer, bot, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { now, uid, type Actor } from "../src/types";

async function setup(erp_operations: string[] = [], erp_autonomous_operations: string[] = []) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  const botId = await bot(f);
  if (erp_operations.length)
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations, erp_autonomous_operations, erp_data_acknowledged: true }, uid());
  const chat = await perform(env, f.admin, f.profile, "internal.create", { peer_id: `bot:${botId}` }, uid());
  const sent = await perform(env, f.admin, f.profile, "internal.send", { id: chat.id, text: "Ver as metas do ERP" }, uid());
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", sent.run_id);
  const ctx = (await botActionContext(env, run))!;
  expect(ctx).not.toBeNull();
  const state = newToolState();
  const tool = async (name: string, args: any) => JSON.parse(await runBotTool(ctx, state, name, args));
  return { f, chat, run, botId, ctx, tool };
}

/** Sessão real da pessoa, com o segundo fator concluído na sessão. */
async function confirmedSession(actor: Actor) {
  await setMfaPolicy(env, "financial");
  const token = await bearer(actor);
  const request = new Request("https://test/api/v1/me", { headers: { Authorization: "Bearer " + token } });
  const person = await authenticate(env, request);
  await exec(env, "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?", now(), await sha(token));
  return { person, confirmed: await authenticate(env, request) };
}

const goal = () => ({ command_id: uid(), goal_id: null, expected_version: 0,
  data: { name: "Meta pelo bot", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "750.00", active: true } });

afterEach(async () => {
  try { await setMfaPolicy(env, "off"); } finally { vi.useRealTimers(); }
});

describe("catálogo do bot com as operações nominais do ERP", () => {
  it("o catálogo comum continua sem o repasse; o inventário tem assunto e descrição", () => {
    expect(fullCatalog().some(op => op.path.startsWith("erp/v1/"))).toBe(false);
    for (const op of ERP_BOT_OPERATIONS) {
      expect(op.group, op.id).toMatch(/^(negocio|financeiro|cobranca|nfe|importacao|atividades|bling|backup|conversa|producao|expedicao|frete|lojas)$/);
      expect(op.description.length, op.id).toBeGreaterThan(10);
      expect(op.description, op.id).not.toMatch(/\.mjs\b/);
    }
  });

  it("sem concessão a operação nem aparece para o bot e a consulta é recusada", { timeout: 120_000 }, async () => {
    const { f, ctx, tool } = await setup();
    const catalog = await catalogFor(env, ctx.actor, f.profile);
    expect(catalog.some(op => op.path.startsWith("erp/v1/"))).toBe(false);
    const found = await tool("buscar_operacoes", { texto: "metas comerciais" });
    expect(found.operacoes.map((op: any) => op.operacao)).not.toContain("erp.business.goals");
    expect((await tool("consultar", { operacao: "erp.business.goals" })).erro).toMatch(/desconhecida/);
    expect((await tool("propor_acao", { operacao: "erp.business.goal.save", parametros: goal(), resumo: "Salvar meta" })).erro).toMatch(/desconhecida/);
    // A pessoa, sem o bot, não ganha nem perde nada: o catálogo dela não muda.
    expect((await catalogFor(env, { ...ctx.actor, via: undefined }, f.profile)).some(op => op.path.startsWith("erp/v1/"))).toBe(false);
  });

  it("concedida: lê direto, propõe a escrita, a pessoa confirma com segundo fator e o resultado chega", { timeout: 120_000 }, async () => {
    const { f, chat, botId, ctx, tool } = await setup(["erp.business.goals", "erp.business.goal.save"]);
    const catalog = await catalogFor(env, ctx.actor, f.profile);
    expect(catalog.filter(op => op.module === "erp" && op.path.startsWith("erp/v1/")).map(op => [op.name, op.kind]).sort())
      .toEqual([["erp.business.goal.save", "write"], ["erp.business.goals", "read"]]);
    const found = await tool("buscar_operacoes", { texto: "meta comercial" });
    expect(found.operacoes).toEqual(expect.arrayContaining([
      expect.objectContaining({ operacao: "erp.business.goals", tipo: "consulta", modulo: "erp" }),
      expect.objectContaining({ operacao: "erp.business.goal.save", tipo: "acao", exige_segundo_fator: true }),
    ]));
    // Leitura comum: direto, como a pessoa.
    expect((await tool("consultar", { operacao: "erp.business.goals" })).items).toEqual([]);
    // Escrita: só proposta; consultar não executa ação.
    expect((await tool("consultar", { operacao: "erp.business.goal.save", parametros: goal() })).erro).toBeTruthy();
    const proposed = await tool("propor_acao", { operacao: "erp.business.goal.save", parametros: goal(), resumo: "Salvar meta de R$ 750,00" });
    expect(proposed).toMatchObject({ estado: "aguardando_confirmacao" });
    expect(await one(env, "SELECT status,operation,path FROM bot_proposals WHERE id=?", proposed.proposta))
      .toMatchObject({ status: "pending", operation: "erp.business.goal.save", path: "erp/v1/meu-negocio/metas" });
    // Nada mudou antes da confirmação; o bot não confirma.
    expect((await tool("consultar", { operacao: "erp.business.goals" })).items).toEqual([]);
    await expect(confirmProposal(env, ctx.actor, f.profile, chat.id, proposed.proposta)).rejects.toMatchObject({ code: "person_required" });
    const session = await confirmedSession(f.admin);
    await expect(confirmProposal(env, session.person, f.profile, chat.id, proposed.proposta)).rejects.toMatchObject({ code: "mfa_required" });
    const result = await confirmProposal(env, session.confirmed, f.profile, chat.id, proposed.proposta);
    expect(result.status, JSON.stringify(result)).toBe("done");
    const listed = await tool("consultar", { operacao: "erp.business.goals" });
    expect(listed.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Meta pelo bot", target: "750.00" })]));
    // Revogada: some do catálogo do bot na hora.
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: [] }, uid());
    expect((await catalogFor(env, ctx.actor, f.profile)).some(op => op.path.startsWith("erp/v1/"))).toBe(false);
  });

  it("leitura sensível concedida vai por proposta; autônoma, só se o administrador ligar", { timeout: 120_000 }, async () => {
    const params = { de: "2026-11-01", ate: "2026-11-30" };
    const { f, chat, botId, ctx, tool } = await setup(["erp.activity.list"]);
    const view = (await tool("buscar_operacoes", { texto: "atividades exclusões" })).operacoes.find((op: any) => op.operacao === "erp.activity.list");
    expect(view).toMatchObject({ tipo: "consulta", exige_proposta: true });
    expect((await tool("consultar", { operacao: "erp.activity.list", parametros: params })).erro).toMatch(/proponha|confirm/i);
    const proposed = await tool("propor_acao", { operacao: "erp.activity.list", parametros: params, resumo: "Ver o registro de atividades de novembro" });
    const token = await bearer(f.admin);
    const person = await authenticate(env, new Request("https://test/api/v1/me", { headers: { Authorization: "Bearer " + token } }));
    const result = await confirmProposal(env, person, f.profile, chat.id, proposed.proposta);
    expect(result.status, JSON.stringify(result)).toBe("done");
    expect(Array.isArray(result.result.items)).toBe(true);
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: ["erp.activity.list"], erp_autonomous_operations: ["erp.activity.list"], erp_data_acknowledged: true }, uid());
    const direct = (await catalogFor(env, ctx.actor, f.profile)).find(op => op.name === "erp.activity.list");
    expect(direct).toMatchObject({ kind: "read", sensitive: false });
    expect(Array.isArray((await tool("consultar", { operacao: "erp.activity.list", parametros: params })).items)).toBe(true);
  });

  it("parte do ERP desligada tira a operação do catálogo; origem externa não tem contexto de bot", { timeout: 120_000 }, async () => {
    const { f, run, ctx } = await setup(["erp_finance_title_bank_writeoff", "erp.business.goals"]);
    const names = async () => (await catalogFor(env, ctx.actor, f.profile)).map(op => op.name);
    expect(await names()).toEqual(expect.arrayContaining(["erp_finance_title_bank_writeoff", "erp.business.goals"]));
    await setModule(f.profile, "erp-financeiro", false, f.admin.id);
    expect(await names()).not.toContain("erp_finance_title_bank_writeoff");
    expect(await names()).toContain("erp.business.goals");
    expect(await botActionContext(env, { ...run, conversation_id: uid() })).toBeNull();
  });

  it("o inventário para a tela do bot é só do administrador", { timeout: 120_000 }, async () => {
    const f = await fixture();
    await enableErpParts(f.profile, f.admin.id);
    const response = await internalCall(env, f.admin, { path: `/profiles/${f.profile}/bots/erp-operations` });
    const body = await response.json<any>();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.groups.map((group: any) => group.id)).toEqual(["negocio", "financeiro", "cobranca", "nfe", "importacao", "atividades", "bling", "backup", "conversa", "producao", "expedicao", "frete", "lojas"]);
    const all = body.groups.flatMap((group: any) => group.operations);
    expect(all.map((op: any) => op.id).sort()).toEqual(ERP_BOT_OPERATIONS.map(op => op.id).sort());
    expect(all.find((op: any) => op.id === "erp.activity.list")).toMatchObject({ kind: "read", sensitive: true, autonomous: true });
    expect(all.find((op: any) => op.id === "erp_finance_title_bank_writeoff")).toMatchObject({ kind: "write", autonomous: false,
      modules: expect.arrayContaining([{ id: "erp-financeiro", title: expect.any(String), enabled: true }]) });
    expect((await internalCall(env, f.member, { path: `/profiles/${f.profile}/bots/erp-operations` })).status).toBe(403);
  });
});
