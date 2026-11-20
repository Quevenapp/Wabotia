// Segunda revisão independente (acesso e bots):
// - M4: leitura sensível do ERP pelo caminho do bot, da proposta à
//   confirmação pela pessoa e à entrega do resultado (GET continua GET);
// - B3: sem delegação, a leitura sensível pelo bot recebe 403 explícito, ao
//   lado do portão antigo (que não pega o papel Consulta);
// - item 15: concessões do bot pela pessoa agindo por bot só com proposta
//   confirmada; o administrador sem bot continua gravando.
// O ERP ainda é repasse sem onRead/onRoute: a operação é montada como o
// catálogo a montaria, sem inscrever rota nova (como em erp-commercial-bot).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { exec, one } from "../src/db";
import { internalCall } from "../src/internal-api";
import { authenticate, sha } from "../src/security";
import { setMfaPolicy } from "../src/mfa";
import { perform } from "../src/service";
import { botActionContext, createProposal, confirmProposal, runBotTool, newToolState } from "../src/bot-actions/actions";
import { erpSensitiveRead, operationView, type CatalogOperation } from "../src/bot-actions/catalog";
import { erpCommercialOperations } from "../src/modules/erp/commercial-operations";
import { bearer, bot, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { now, uid, type Actor } from "../src/types";

const PERIOD = { de: "2026-11-01", ate: "2026-11-19" };

async function confirmingSession(actor: Actor) {
  await setMfaPolicy(env, "financial");
  const token = await bearer(actor);
  const request = new Request("https://test/api/v1/me", { headers: { Authorization: "Bearer " + token } });
  const person = await authenticate(env, request);
  expect(person.sessionId).toBeTruthy();
  await exec(env, "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?", now(), await sha(token));
  const confirmed = await authenticate(env, request);
  expect(confirmed).toMatchObject({ sessionId: person.sessionId, aal: 2 });
  return confirmed;
}

async function setup(erp_operations: string[] = []) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T15:00:00Z"));
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  await setModule(f.profile, "erp-cobranca", true, f.admin.id);
  const botId = await bot(f);
  if (erp_operations.length)
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations, erp_data_acknowledged: true }, uid());
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

const activitySpec = erpCommercialOperations.find(op => op.id === "erp.activity.list")!;
/** A consulta como fullCatalog() a montaria se a rota tivesse onRead. */
const activityOp = (): CatalogOperation => ({
  name: `consulta:erp${activitySpec.path}`, kind: "read", method: "GET", path: "erp" + activitySpec.path, module: "erp",
  summary: activitySpec.summary, description: activitySpec.description, params: activitySpec.params,
  sensitive: erpSensitiveRead("erp" + activitySpec.path), scope: "erp:read",
});

describe("M4: leitura sensível com proposta confirmada pelo bot", () => {
  it("o catálogo marca a leitura sensível como exige proposta; leitura comum não", () => {
    expect(erpSensitiveRead("erp/v1/registro-atividades")).toBe(true);
    expect(erpSensitiveRead("erp/v1/retornos-operacionais/files/:id/download")).toBe(true);
    expect(erpSensitiveRead("erp/v1/meu-negocio/metas")).toBe(false);
    expect(operationView(activityOp())).toMatchObject({ tipo: "consulta", exige_proposta: true });
  });

  it("concessão sem opção autônoma: propõe, a pessoa confirma e recebe o resultado; GET continua GET", { timeout: 120_000 }, async () => {
    const { f, chat, run } = await setup(["erp.activity.list"]);
    const ctx = (await botActionContext(env, run))!;
    const direct = () => internalCall(env, ctx.actor, { path: `/profiles/${f.profile}/erp/v1/registro-atividades`, query: PERIOD });
    // B3: direto, sem proposta, recusa explícita.
    const refused = await direct();
    expect(refused.status).toBe(403);
    expect((await refused.json<any>()).error.code).toBe("erp_bot_proposal_required");
    const proposal = await createProposal(ctx, activityOp(), PERIOD, "Consultar o registro de atividades de novembro");
    expect(proposal).toMatchObject({ method: "GET", status: "pending", sensitive: 1 });
    // Um id de proposta ainda não confirmada não vale.
    const forged = await internalCall(env, { ...ctx.actor, via: { ...ctx.actor.via!, proposal_id: proposal.id } },
      { path: `/profiles/${f.profile}/erp/v1/registro-atividades`, query: PERIOD });
    expect(forged.status).toBe(403);
    // O próprio bot não confirma.
    await expect(confirmProposal(env, ctx.actor, f.profile, chat.id, proposal.id)).rejects.toMatchObject({ code: "person_required" });
    const done = await confirmProposal(env, await confirmingSession(f.admin), f.profile, chat.id, proposal.id);
    expect(done.status, JSON.stringify(done)).toBe("done");
    expect(done.result).not.toBeNull();
    expect(JSON.stringify(done.result)).toContain("items");
    // Entregue à pessoa que confirmou: mensagem de resultado na conversa
    // interna com o resultado no payload. O histórico do modelo leva só o
    // texto (team.ts), que não traz o resultado.
    const message = await one(env, "SELECT author,text,payload FROM internal_messages WHERE id=?", `proposal-result:${proposal.id}`);
    expect(JSON.parse(message.payload).proposal.result).toEqual(done.result);
    expect(message.text).not.toContain("items");
    // Sem nova proposta, a leitura direta continua recusada.
    expect((await direct()).status).toBe(403);
  });

  it("sem a concessão nominal continua recusado; com a opção autônoma, direto", { timeout: 120_000 }, async () => {
    const { f, run, botId } = await setup();
    const ctx = (await botActionContext(env, run))!;
    const direct = () => internalCall(env, ctx.actor, { path: `/profiles/${f.profile}/erp/v1/registro-atividades`, query: PERIOD });
    await expect(createProposal(ctx, activityOp(), PERIOD, "Consultar atividades")).rejects.toMatchObject({ code: "erp_bot_grant_required" });
    expect((await direct()).status).toBe(403);
    // A opção sozinha, sem a concessão nominal, não vale.
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: [], erp_autonomous_operations: ["erp.activity.list"], erp_data_acknowledged: true }, uid());
    expect((await direct()).status).toBe(403);
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: ["erp.activity.list"], erp_autonomous_operations: ["erp.activity.list"], erp_data_acknowledged: true }, uid());
    const allowed = await direct();
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    // Origem externa não ganha contexto de equipe.
    expect(await botActionContext(env, { ...run, conversation_id: uid() })).toBeNull();
  });

  it("propor_acao continua recusando consulta comum (só leitura sensível se propõe)", { timeout: 120_000 }, async () => {
    const { run } = await setup();
    const ctx = (await botActionContext(env, run))!;
    const answer = JSON.parse(await runBotTool(ctx, newToolState(), "propor_acao", { operacao: "consulta:erp-comercial-nfe/config", resumo: "Ver configuração" }));
    expect(answer.erro).toMatch(/Ação desconhecida/);
  });
});

describe("B3: recusa explícita da leitura sensível pelo bot", () => {
  it("papel Consulta, fora do portão antigo, recebe 403 explícito no download do retorno sem proposta", { timeout: 120_000 }, async () => {
    const { f, run, botId } = await setup();
    await exec(env, "UPDATE users SET role='operator',access=? WHERE id=?", JSON.stringify(["erp:consulta", "team"]), f.admin.id);
    const ctx = (await botActionContext(env, run))!;
    const download = (actor: Actor = ctx.actor) => internalCall(env, actor, { path: `/profiles/${f.profile}/erp/v1/retornos-operacionais/files/${uid()}/download` });
    for (const grant of [[], ["erp_cnab_operational_return_file"]]) {
      await exec(env, "UPDATE users SET role='admin' WHERE id=?", f.admin.id);
      await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: grant, erp_data_acknowledged: true }, uid());
      await exec(env, "UPDATE users SET role='operator' WHERE id=?", f.admin.id);
      const response = await download((await botActionContext(env, run))!.actor);
      expect(response.status).toBe(403);
      expect((await response.json<any>()).error.code).toBe("erp_bot_proposal_required");
    }
    // A pessoa sem bot não muda: segue para o ERP (arquivo inexistente).
    const alone = await download({ ...ctx.actor, via: undefined });
    expect((await alone.json<any>()).error?.code).not.toBe("erp_bot_proposal_required");
  });
});

describe("item 15: quem grava as concessões do bot", () => {
  it("pessoa agindo por bot sem proposta confirmada é recusada; administrador sem bot grava", { timeout: 120_000 }, async () => {
    const { f, run, chat, botId } = await setup();
    const ctx = (await botActionContext(env, run))!;
    const grant = { id: botId, erp_operations: ["erp.activity.list"], erp_autonomous_operations: ["erp.activity.list"], erp_data_acknowledged: true };
    const options = async () => JSON.parse((await one(env,
      "SELECT c.config FROM bots b JOIN connections c ON c.id=b.connection_id WHERE b.id=?", botId)).config).bot_options?.default ?? {};
    for (const data of [grant, { id: botId, erp_autonomous_operations: [] }, { id: botId, mask_personal: false }, { id: botId, image_to_team: true }])
      await expect(perform(env, ctx.actor, f.profile, "bot.update", data, uid())).rejects.toMatchObject({ code: "proposal_required" });
    // Id de proposta solto, sem proposta confirmada, também não vale.
    await expect(perform(env, { ...ctx.actor, via: { ...ctx.actor.via!, proposal_id: uid() } }, f.profile, "bot.update", grant, uid()))
      .rejects.toMatchObject({ code: "proposal_required" });
    expect(await options()).not.toHaveProperty("erp_operations");
    // Com proposta confirmada pela pessoa (estado em que a confirmação a deixa ao executar), grava.
    const proposal = uid();
    await exec(env, `INSERT INTO bot_proposals(id,profile_id,mode,actor,bot_id,run_id,chat_id,operation,method,path,params,summary,sensitive,status,expires_at,decided_at,created,updated)
      VALUES(?,?,'team',?,?,?,?,'bot.update','PATCH','bots/:id',?,'Liberar leitura',1,'running',?,?,?,?)`,
      proposal, f.profile, f.admin.id, botId, run.id, chat.id, JSON.stringify(grant), now() + 60000, now(), now(), now());
    await perform(env, { ...ctx.actor, via: { ...ctx.actor.via!, proposal_id: proposal } }, f.profile, "bot.update", grant, uid());
    expect(await options()).toMatchObject({ erp_operations: ["erp.activity.list"], erp_autonomous_operations: ["erp.activity.list"] });
    // Administrador sem bot continua gravando; nada muda para ele.
    await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: [], erp_autonomous_operations: [] }, uid());
    expect(await options()).toMatchObject({ erp_operations: [], erp_autonomous_operations: [] });
  });
});
