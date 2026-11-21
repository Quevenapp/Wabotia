// Bots nos módulos de área (Condomínio, Ensino, Jurídico e Saúde): o
// bloqueio fixo virou opção do administrador (src/bot-actions/area.ts).
// Prova que tudo nasce desligado, que ligar sem a confirmação do aviso é
// recusado e fica registrado, que o campo sensível não sai sem a opção
// própria, que o bot nunca faz o que a pessoa não pode e que o teto de
// cliente vale (atendimento no WhatsApp não alcança estas operações).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { moduleRoutes } from "../src/modules/hooks";
import { botActionContext, confirmProposal, newToolState, runBotTool } from "../src/bot-actions/actions";
import { catalogFor, fullCatalog, resetCatalogCache } from "../src/bot-actions/catalog";
import { customerTools } from "../src/bot-actions/customer";
import { AREA_BOT_MODULES, areaBotGrants, areaBotInventory, areaKind } from "../src/bot-actions/area";
import { moduleStates } from "../src/modules/registry";
import { setMfaPolicy } from "../src/mfa";
import { uid, type Actor } from "../src/types";
import { bot } from "./service-center-fixture";
import { saudeFixture, SECRET } from "./saude-fixture";

const RECORDS = "consulta:saude/subjects/:subject_id/records";
const grant = (f: { admin: Actor; profile: string }, botId: string, data: Record<string, unknown>, actor: Actor = f.admin) =>
  perform(env, actor, f.profile, "bot.area_grant", { id: botId, ...data }, uid());

async function setup() {
  const f = await saudeFixture();
  const botId = await bot(f as any);
  // A clínica conversa com o bot pela Equipe (conversa interna, pelo app).
  const chat = await perform(env, f.clinician, f.profile, "internal.create", { peer_id: `bot:${botId}` }, uid());
  const sent = await perform(env, f.clinician, f.profile, "internal.send", { id: chat.id, text: "Ler o prontuário" }, uid());
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", sent.run_id);
  const ctx = (await botActionContext(env, run))!;
  expect(ctx).not.toBeNull();
  const state = newToolState();
  const tool = async (name: string, args: any) => JSON.parse(await runBotTool(ctx, state, name, args));
  return { f, botId, chat, run, ctx, tool };
}

afterEach(async () => {
  await setMfaPolicy(env, "off");
});

describe("inventário dos módulos de área", () => {
  it("cada operação tem nome estável, descrição em português, grupo do módulo e rota que existe", () => {
    const routes = moduleRoutes();
    const ids = new Set<string>();
    expect(AREA_BOT_MODULES.map(m => m.module).sort()).toEqual(["condominio", "ensino", "juridico", "saude"]);
    for (const module of AREA_BOT_MODULES) {
      expect(module.warning.length).toBeGreaterThan(40);
      expect(module.direct_warning.length).toBeGreaterThan(40);
      expect(module.sensitive_warning.length).toBeGreaterThan(20);
      expect(module.sensitive_keys.length).toBeGreaterThan(0);
      expect(module.operations.length).toBeGreaterThan(4);
      for (const op of module.operations) {
        expect(ids.has(op.id), op.id).toBe(false);
        ids.add(op.id);
        expect(op.path.split("/")[0], op.id).toBe(module.module);
        expect(op.description.length, op.id).toBeGreaterThan(15);
        expect(op.title.length, op.id).toBeGreaterThan(3);
        // Acesso do morador ou do responsável pelo QR é dele: fora daqui.
        expect(op.path, op.id).not.toMatch(/^(condominio\/me|ensino\/access)\//);
        if (areaKind(op) === "read") {
          expect(op.id).toBe(`consulta:${op.path}`);
          expect(routes.read.some(r => r.path === op.path) || routes.binary.some(r => r.method === "GET" && r.path === op.path), op.id).toBe(true);
        } else {
          expect(routes.write.some(r => r.path === op.path && r.method === op.method), op.id).toBe(true);
        }
      }
    }
    // O catálogo comum continua sem esses módulos: só a concessão traz.
    resetCatalogCache();
    expect(fullCatalog().some(op => ["condominio", "ensino", "juridico", "saude"].includes(op.module))).toBe(false);
  });
});

describe("concessão dos módulos de área ao bot", () => {
  it("tudo nasce desligado para todo bot: inventário, catálogo e ferramentas", { timeout: 120_000 }, async () => {
    const { f, botId, ctx, tool } = await setup();
    const inventory = await areaBotInventory(env, f.profile, botId, await moduleStates(env, f.profile));
    expect(inventory.modules.map(m => m.module)).toEqual(["saude", "ensino", "juridico", "condominio"]);
    for (const module of inventory.modules) {
      expect(module.sensitive_fields).toBe(false);
      expect(module.operations.every(op => !op.enabled && !op.direct), module.module).toBe(true);
      expect(module.log).toEqual([]);
    }
    expect(inventory.modules.find(m => m.module === "saude")!.module_enabled).toBe(true);
    expect(inventory.modules.find(m => m.module === "condominio")!.module_enabled).toBe(false);
    const grants = await areaBotGrants(env, f.profile, botId);
    expect([grants.operations.size, grants.direct.size, grants.sensitive.size]).toEqual([0, 0, 0]);
    expect((await catalogFor(env, ctx.actor, f.profile)).some(op => op.area)).toBe(false);
    expect((await tool("buscar_operacoes", { texto: "prontuário paciente" })).operacoes.some((op: any) => op.modulo === "saude")).toBe(false);
    expect((await tool("consultar", { operacao: RECORDS, parametros: { subject_id: f.patient.id } })).erro).toMatch(/desconhecida/);
    expect((await tool("propor_acao", { operacao: "saude.record.create", parametros: {}, resumo: "Escrever" })).erro).toMatch(/desconhecida/);
  });

  it("ligar sem a confirmação do aviso é recusado; ligar e desligar ficam registrados", { timeout: 120_000 }, async () => {
    const { f, botId } = await setup();
    await expect(grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: true }))
      .rejects.toMatchObject({ code: "confirmation_required", message: expect.stringMatching(/dados de saúde e prontuário/) });
    await expect(grant(f, botId, { module: "saude", kind: "sensitive_fields", enabled: true }))
      .rejects.toMatchObject({ code: "confirmation_required" });
    // Execução direta: só com a operação ligada e com o segundo aviso.
    await expect(grant(f, botId, { module: "saude", kind: "direct", operation: "saude.record.create", enabled: true, direct_confirmed: true }))
      .rejects.toMatchObject({ code: "operation_off" });
    await grant(f, botId, { module: "saude", kind: "operation", operation: "saude.record.create", enabled: true, confirmed: true });
    await expect(grant(f, botId, { module: "saude", kind: "direct", operation: "saude.record.create", enabled: true, confirmed: true }))
      .rejects.toMatchObject({ code: "confirmation_required" });
    await expect(grant(f, botId, { module: "saude", kind: "direct", operation: RECORDS, enabled: true, direct_confirmed: true }))
      .rejects.toMatchObject({ code: "invalid_request" });
    // Só o administrador, em pessoa: nem atendente, nem pelo bot.
    await expect(grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: true, confirmed: true }, f.clinician))
      .rejects.toMatchObject({ status: 403 });
    await expect(grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: true, confirmed: true },
      { ...f.admin, via: { kind: "bot", bot_id: botId, run_id: "r", masked: true } })).rejects.toMatchObject({ status: 403 });
    await expect(grant(f, botId, { module: "saude", kind: "operation", operation: "saude.inventada", enabled: true, confirmed: true }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await grant(f, botId, { module: "saude", kind: "direct", operation: "saude.record.create", enabled: true, direct_confirmed: true });
    expect((await areaBotGrants(env, f.profile, botId)).direct.has("saude.record.create")).toBe(true);
    // Desligar a operação desliga junto a execução direta, e registra as duas.
    await grant(f, botId, { module: "saude", kind: "operation", operation: "saude.record.create", enabled: false });
    expect((await areaBotGrants(env, f.profile, botId)).operations.size).toBe(0);
    const log = await all(env, "SELECT kind,operation,action,actor,bot_id FROM bot_area_grant_log WHERE profile_id=? ORDER BY created,rowid", f.profile);
    expect(log).toEqual([
      { kind: "operation", operation: "saude.record.create", action: "on", actor: f.admin.id, bot_id: botId },
      { kind: "direct", operation: "saude.record.create", action: "on", actor: f.admin.id, bot_id: botId },
      { kind: "operation", operation: "saude.record.create", action: "off", actor: f.admin.id, bot_id: botId },
      { kind: "direct", operation: "saude.record.create", action: "off", actor: f.admin.id, bot_id: botId },
    ]);
    const screen = await areaBotInventory(env, f.profile, botId, await moduleStates(env, f.profile));
    expect(screen.modules.find(m => m.module === "saude")!.log).toHaveLength(4);
  });

  it("o campo sensível só vai ao bot com \"incluir campos sensíveis\" ligado para o bot e o módulo", { timeout: 120_000 }, async () => {
    const { f, botId, ctx, tool } = await setup();
    await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: true, confirmed: true });
    const catalog = await catalogFor(env, ctx.actor, f.profile);
    expect(catalog.filter(op => op.area).map(op => op.name)).toEqual([RECORDS]);
    const hidden = await runBotTool(ctx, newToolState(), "consultar", { operacao: RECORDS, parametros: { subject_id: f.patient.id } });
    expect(hidden).not.toContain(SECRET);
    expect(JSON.parse(hidden).data[0]).toMatchObject({ kind: "evolution", text: expect.stringMatching(/campo sensível/) });
    await grant(f, botId, { module: "saude", kind: "sensitive_fields", enabled: true, confirmed: true });
    expect(await runBotTool(ctx, newToolState(), "consultar", { operacao: RECORDS, parametros: { subject_id: f.patient.id } })).toContain(SECRET);
    // Cada uso pelo bot fica no registro, com a pessoa que pediu.
    expect(await all(env, "SELECT actor,operation FROM bot_area_grant_log WHERE profile_id=? AND action='used'", f.profile))
      .toEqual([{ actor: f.clinician.id, operation: RECORDS }, { actor: f.clinician.id, operation: RECORDS }]);
    // Desligada a opção, volta a esconder; desligada a operação, some.
    await grant(f, botId, { module: "saude", kind: "sensitive_fields", enabled: false });
    expect(await runBotTool(ctx, newToolState(), "consultar", { operacao: RECORDS, parametros: { subject_id: f.patient.id } })).not.toContain(SECRET);
    await grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: false });
    expect((await tool("consultar", { operacao: RECORDS, parametros: { subject_id: f.patient.id } })).erro).toMatch(/desconhecida/);
  });

  it("o bot nunca faz pela pessoa o que ela não pode (pessoa ∩ bot)", { timeout: 120_000 }, async () => {
    const { f, botId, ctx } = await setup();
    await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: true, confirmed: true });
    await grant(f, botId, { module: "saude", kind: "sensitive_fields", enabled: true, confirmed: true });
    // A pessoa perde a leitura clínica: o bot liberado não lê por ela.
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["*", "os:sensitive"]), f.clinician.id);
    const fresh = (await botActionContext(env, ctx.run))!;
    const answer = await runBotTool(fresh, newToolState(), "consultar", { operacao: RECORDS, parametros: { subject_id: f.patient.id } });
    expect(answer).not.toContain(SECRET);
    expect(JSON.parse(answer).erro).toMatch(/Papel clínico/);
  });

  it("escrita: o bot propõe e a pessoa confirma; execução direta só com o segundo aviso", { timeout: 120_000 }, async () => {
    const { f, botId, chat, ctx, tool } = await setup();
    await grant(f, botId, { module: "saude", kind: "operation", operation: "saude.record.create", enabled: true, confirmed: true });
    const params = { subject_id: f.patient.id, episode_id: f.episode.id, kind: "evolution", text: "Evolução proposta pelo bot" };
    const proposed = await tool("propor_acao", { operacao: "saude.record.create", parametros: params, resumo: "Registrar evolução" });
    expect(proposed.estado).toBe("aguardando_confirmacao");
    const row = await one(env, "SELECT * FROM bot_proposals WHERE id=?", proposed.proposta);
    expect(row.sensitive).toBe(1);
    expect(await one(env, "SELECT count(*) n FROM saude_records WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
    // Desligada antes da confirmação: não roda.
    await grant(f, botId, { module: "saude", kind: "operation", operation: "saude.record.create", enabled: false });
    await expect(confirmProposal(env, f.clinician, f.profile, chat.id, proposed.proposta)).rejects.toMatchObject({ code: "area_bot_grant_required" });
    await grant(f, botId, { module: "saude", kind: "operation", operation: "saude.record.create", enabled: true, confirmed: true });
    const done = await confirmProposal(env, f.clinician, f.profile, chat.id, proposed.proposta);
    expect(done).toMatchObject({ status: "done" });
    const record = await one(env, "SELECT author FROM saude_records WHERE profile_id=?", f.profile);
    expect(record).toEqual({ author: f.clinician.id });
    // Execução direta liberada: o bot grava sem proposta, como a pessoa.
    await grant(f, botId, { module: "saude", kind: "direct", operation: "saude.record.create", enabled: true, direct_confirmed: true });
    expect((await catalogFor(env, ctx.actor, f.profile)).find(op => op.name === "saude.record.create")).toMatchObject({ direct: true, sensitive: false });
    const direct = await runBotTool(ctx, newToolState(), "propor_acao", { operacao: "saude.record.create", parametros: { ...params, text: "Direto" }, resumo: "Registrar" });
    expect(JSON.parse(direct).erro).toBeUndefined();
    expect(await one(env, "SELECT count(*) n FROM saude_records WHERE profile_id=?", f.profile)).toEqual({ n: 2 });
    expect(await all(env, "SELECT detail FROM bot_area_grant_log WHERE profile_id=? AND action='used' ORDER BY created,rowid", f.profile))
      .toEqual([{ detail: "proposta confirmada pela pessoa" }, { detail: "execução direta" }]);
  });

  it("teto de cliente: com tudo ligado, o atendimento no WhatsApp não alcança os módulos de área", { timeout: 120_000 }, async () => {
    const { f, botId, ctx } = await setup();
    const before = (await customerTools(env, f.profile)).map(t => `${t.module}:${t.name}`);
    for (const op of AREA_BOT_MODULES.find(m => m.module === "saude")!.operations) {
      await grant(f, botId, { module: "saude", kind: "operation", operation: op.id, enabled: true, confirmed: true });
      if (areaKind(op) === "write")
        await grant(f, botId, { module: "saude", kind: "direct", operation: op.id, enabled: true, direct_confirmed: true });
    }
    await grant(f, botId, { module: "saude", kind: "sensitive_fields", enabled: true, confirmed: true });
    expect((await catalogFor(env, ctx.actor, f.profile)).filter(op => op.area).length).toBeGreaterThan(10);
    // Ferramentas do cliente: as mesmas de antes, nenhuma da Saúde.
    const after = await customerTools(env, f.profile);
    expect(after.map(t => `${t.module}:${t.name}`)).toEqual(before);
    expect(after.some(t => t.module === "saude")).toBe(false);
    // Execução de uma conversa de cliente não vira ação de equipe.
    expect(await botActionContext(env, { ...ctx.run, conversation_id: uid() })).toBeNull();
    // O bot preso à conversa do cliente, aplicação ou o bot sozinho: nada.
    const via = ctx.actor.via!;
    for (const actor of [
      { ...ctx.actor, scopes: ["conversations:bound"] },
      { ...ctx.actor, kind: "app" as const },
      { ...ctx.actor, id: `bot:${botId}` },
      { ...ctx.actor, via: undefined },
      { ...ctx.actor, via: { ...via, bot_id: uid() } },
    ] as Actor[])
      expect((await catalogFor(env, actor, f.profile)).some(op => op.area), JSON.stringify(actor.kind)).toBe(false);
  });

  it("módulo desligado na área: a operação liberada some do bot", { timeout: 120_000 }, async () => {
    const { f, botId, ctx } = await setup();
    await grant(f, botId, { module: "saude", kind: "operation", operation: RECORDS, enabled: true, confirmed: true });
    expect((await catalogFor(env, ctx.actor, f.profile)).some(op => op.name === RECORDS)).toBe(true);
    await perform(env, f.admin, f.profile, "module.set", { id: "saude", enabled: false }, uid());
    expect((await catalogFor(env, ctx.actor, f.profile)).some(op => op.area)).toBe(false);
  });
});
