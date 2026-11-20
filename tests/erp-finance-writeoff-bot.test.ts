// Declaração de boleto baixado no banco (segunda revisão, M3): escrita
// sensível do Financeiro. O bot só chega a ela pela concessão nominal e pela
// proposta confirmada por uma pessoa; a origem externa não chega.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { exec, one } from "../src/db";
import { internalCall } from "../src/internal-api";
import { authenticate, sha } from "../src/security";
import { setMfaPolicy } from "../src/mfa";
import { perform } from "../src/service";
import { botActionContext, createProposal, confirmProposal } from "../src/bot-actions/actions";
import type { CatalogOperation } from "../src/bot-actions/catalog";
import { erpCommercialOperations } from "../src/modules/erp/commercial-operations";
import { ERP_BOT_OPERATIONS } from "../src/modules/erp/bot-access";
import { bearer, bot, fixture } from "./service-center-fixture";
import { enableErpParts } from "./erp-module-helper";
import { now, uid, type Actor } from "../src/types";

const ID = "erp_finance_title_bank_writeoff";
const spec = erpCommercialOperations.find(op => op.id === ID)!;
const op: CatalogOperation = { name: spec.id, kind: "write", method: spec.method, path: "erp" + spec.path,
  module: "erp", summary: spec.summary, description: spec.description, params: spec.params, sensitive: spec.sensitive, scope: "erp:write" };
const params = () => ({ command_id: uid(), data: { id: uid(), expected_version: 1, reason: "Boleto baixado no banco pelo gerente" } });

async function secondFactor(actor: Actor) {
  await setMfaPolicy(env, "financial");
  const token = await bearer(actor);
  const request = new Request("https://test/api/v1/me", { headers: { Authorization: "Bearer " + token } });
  const person = await authenticate(env, request);
  await exec(env, "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?", now(), await sha(token));
  return { person, confirmed: await authenticate(env, request) };
}

async function setup(granted: boolean) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  const botId = await bot(f);
  if (granted) await perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: [ID], erp_data_acknowledged: true }, uid());
  const chat = await perform(env, f.admin, f.profile, "internal.create", { peer_id: `bot:${botId}` }, uid());
  const sent = await perform(env, f.admin, f.profile, "internal.send", { id: chat.id, text: "Baixar boleto" }, uid());
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", sent.run_id);
  return { f, chat, run };
}
afterEach(async () => {
  try { await setMfaPolicy(env, "off"); } finally { vi.useRealTimers(); }
});

describe("declaração de boleto baixado no banco para bots", () => {
  it("é operação nominal e sensível do ERP, na rota que o painel usa", () => {
    expect(spec).toMatchObject({ method: "POST", path: "/v1/financeiro/actions/title_bank_writeoff", sensitive: true });
    expect(spec.params.properties.data.required).toEqual(["id", "expected_version", "reason"]);
    expect(ERP_BOT_OPERATIONS.find(item => item.id === ID)).toMatchObject({ sensitive: true, path: "erp/v1/financeiro/actions/title_bank_writeoff" });
  });

  it("bot configurado propõe, a pessoa confirma com segundo fator e a escrita chega ao Financeiro", { timeout: 120_000 }, async () => {
    const { f, chat, run } = await setup(true);
    const ctx = (await botActionContext(env, run))!;
    // Sem proposta, o próprio bot não escreve.
    const direct = await internalCall(env, ctx.actor, { method: "POST", path: `/profiles/${f.profile}/erp/v1/financeiro/actions/title_bank_writeoff`, body: params() });
    expect(direct.status, await direct.clone().text()).toBe(403);
    const proposal = await createProposal(ctx, op, params(), "Cancelar conta declarando o boleto baixado no banco");
    expect(proposal.status).toBe("pending");
    const session = await secondFactor(f.admin);
    await expect(confirmProposal(env, session.person, f.profile, chat.id, proposal.id)).rejects.toMatchObject({ code: "mfa_required" });
    const result = await confirmProposal(env, session.confirmed, f.profile, chat.id, proposal.id);
    // A conta inventada não existe: a recusa vem do motor (404 de registro),
    // depois do portão do bot, igual à mesma chamada feita pela pessoa.
    expect(result.status, JSON.stringify(result)).toBe("failed");
    expect(result.error).toBe("Falha HTTP 404.");
    const same = await internalCall(env, session.confirmed, { method: "POST", path: `/profiles/${f.profile}/erp/v1/financeiro/actions/title_bank_writeoff`, body: params() });
    const body = await same.json<any>();
    expect(same.status, JSON.stringify(body)).toBe(404);
    expect(body.error.code).toBe("ERP_NOT_FOUND");
    // A rota existe e valida a entrada (motivo obrigatório): o 404 é da conta.
    const invalid = await internalCall(env, session.confirmed, { method: "POST", path: `/profiles/${f.profile}/erp/v1/financeiro/actions/title_bank_writeoff`,
      body: { command_id: uid(), data: { id: uid(), expected_version: 1 } } });
    expect(invalid.status, await invalid.clone().text()).toBe(400);
  });

  it("bot sem a configuração é recusado e a origem externa não alcança", { timeout: 120_000 }, async () => {
    const { run } = await setup(false);
    const ctx = (await botActionContext(env, run))!;
    await expect(createProposal(ctx, op, params(), "Cancelar conta")).rejects.toMatchObject({ code: "erp_bot_grant_required" });
    expect(await botActionContext(env, { ...run, conversation_id: uid() })).toBeNull();
  });
});
