import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { one } from "../src/db";
import { internalCall } from "../src/internal-api";
import { authenticate } from "../src/security";
import { setMfaPolicy } from "../src/mfa";
import { perform } from "../src/service";
import { botActionContext, createProposal, confirmProposal } from "../src/bot-actions/actions";
import type { CatalogOperation } from "../src/bot-actions/catalog";
import { BLING_OPERATIONS } from "../src/erp/bling/schema.ts";
import { bearer, bot, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { uid, type Actor } from "../src/types";

async function setup(granted = true) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Nenhum transporte externo neste ensaio."); });
  await setMfaPolicy(env, "off");
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  const botId = await bot(f);
  const grant = (operations: string[]) => perform(env, f.admin, f.profile, "bot.update", { id: botId, erp_operations: operations, erp_data_acknowledged: true }, uid());
  if (granted) await grant(["erp_bling_status", "erp_bling_disable"]);
  const chat = await perform(env, f.admin, f.profile, "internal.create", { peer_id: `bot:${botId}` }, uid());
  const sent = await perform(env, f.admin, f.profile, "internal.send", { id: chat.id, text: "Consultar recebimento do Bling" }, uid());
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", sent.run_id);
  const context = (await botActionContext(env, run))!;
  const token = await bearer(f.admin);
  const person = await authenticate(env, new Request("https://test/api/v1/me", { headers: { Authorization: "Bearer " + token } }));
  const call = (suffix = "", actor: Actor = context.actor, body?: unknown) => internalCall(env, actor, {
    method: body ? "POST" : "GET", path: `/profiles/${f.profile}/erp/v1/receber-bling${suffix}`, ...(body ? { body } : {}),
  });
  return { f, botId, grant, chat, run, context, person, call };
}
afterEach(async () => { await setMfaPolicy(env, "off"); vi.restoreAllMocks(); vi.useRealTimers(); });
const definition = BLING_OPERATIONS.erp_bling_disable;
const operation: CatalogOperation = { name: definition.name, kind: "write", method: definition.method, path: "erp/v1/receber-bling" + definition.path,
  module: "erp", summary: definition.summary, description: definition.description, params: { type: "object", properties: {}, required: [] }, sensitive: definition.sensitive, scope: "erp:write" };

describe("junção Bling: concessão nominal do ERP e confirmação existente", () => {
  it("sem concessão recusa; concessão única lê mascarado; revogação e origem externa fecham", { timeout: 120_000 }, async () => {
    const s = await setup(false);
    expect((await s.call()).status).toBe(403);
    await s.grant(["erp_bling_status"]);
    const response = await s.call(), data = await response.json<any>();
    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(data.configuration.collect_enabled).toBe(false);
    expect(data.configuration.access.bots).toEqual([]);
    expect(await botActionContext(env, { ...s.run, conversation_id: uid(), actor: s.f.admin.id })).toBeNull();
    const external = { ...s.context.actor, kind: "app", id: "bot:attendant", scopes: ["conversations:bound"], via: undefined } as Actor;
    await expect(s.call("", external)).rejects.toThrow();
    await s.grant([]);
    expect((await s.call()).status).toBe(403);
  });

  it("escrita sensível padrão só executa pela proposta reclamada e confirmada, nunca por id solto", { timeout: 120_000 }, async () => {
    const s = await setup();
    const status = await (await s.call()).json<any>();
    const input = { command_id: uid(), expected_revision: status.configuration.revision };
    expect((await s.call("/desligar", s.context.actor, input)).status).toBe(403);
    const proposal = await createProposal(s.context, operation, input, "Desligar recebimento do Bling");
    const forged = { ...s.person, via: { ...s.context.actor.via!, proposal_id: proposal.id } };
    expect((await s.call("/desligar", forged, input)).status).toBe(403);
    const result = await confirmProposal(env, s.person, s.f.profile, s.chat.id, proposal.id);
    expect(result.status, JSON.stringify(result)).toBe("done");
    expect(result.result.configuration.collect_enabled).toBe(false);
    const revision = result.result.configuration.revision;
    const revoked = await createProposal(s.context, operation, { command_id: uid(), expected_revision: revision }, "Desligar novamente");
    await s.grant(["erp_bling_status"]);
    expect((await confirmProposal(env, s.person, s.f.profile, s.chat.id, revoked.id)).status).toBe("failed");
  });

  it("administrador pode liberar a categoria sensível; a lista antiga de operações não é outra concessão", { timeout: 120_000 }, async () => {
    const s = await setup();
    const before = await (await s.call()).json<any>();
    const configured = await s.call("/configuracao", s.person, { command_id: uid(), expected_revision: before.configuration.revision,
      selections: [], daily_call_limit: 200, ai_disclosure_acknowledged: true,
      access: { reader_user_ids: [], bots: [{ bot_id: s.botId, operations: [], entities: [], data_scopes: ["public"], allow_sensitive: true, mask_personal: true }],
        customer_delivery: { enabled: false, entities: [], require_verified_identity: true } } });
    const configuration = await configured.json<any>();
    expect(configured.status, JSON.stringify(configuration)).toBe(200);
    const response = await s.call("/desligar", s.context.actor, { command_id: uid(), expected_revision: configuration.configuration.revision });
    const result = await response.json<any>();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.configuration.collect_enabled).toBe(false);
  });
});
