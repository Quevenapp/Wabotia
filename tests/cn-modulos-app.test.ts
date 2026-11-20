import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { conversationAllowsModules } from "../src/channels";
import { all, exec } from "../src/db";
import { inbound, perform } from "../src/service";
import { now, uid } from "../src/types";
import {
  api, application, bearer, configure, drain, fixture, latest, quietCoordinator, type Fixture,
} from "./service-center-fixture";

// Regressão dos canais novos: conversas abertas por uma aplicação de
// integração (`app:`) tinham módulos na 0.23.0 e continuam tendo. Os canais
// novos seguem sem módulos, com a mesma resposta.
const profiles = new Set<string>();
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
});

async function setup() {
  const f = await fixture(); profiles.add(f.profile);
  await perform(env, f.admin, f.profile, "module.set", { id: "os", enabled: true }, uid());
  const app = await application(f, ["conversations:read", "conversations:write"]);
  return { f, app, token: await bearer(f.admin) };
}
async function appConversation(f: Fixture, appId: string, text = "oi") {
  const result = await inbound(env, f.profile, { external_id: "cliente-integracao", message_id: uid(), text },
    `app:${appId}`, null);
  await drain(f);
  return result.conversation_id as string;
}
async function socialConversation(f: Fixture, namespace?: string) {
  const line = uid(), id = uid();
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,channel,mode,status,config,created) VALUES(?,?,?,'zernio','instagram','direct','active','{}',?)",
    line, f.profile, "Instagram", now());
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,channel,owner,state)
    VALUES(?,?,?,?,?,?,?,?,?,'instagram',?,'human')`,
    id, f.profile, namespace ? null : line, namespace ?? `channel:${line}`, `dm:${uid()}`, uid(), now(), now(), now(), f.admin.id);
  return id;
}
const action = (token: string, f: Fixture, id: string, body: unknown) =>
  api(token, `/profiles/${f.profile}/conversations/${id}/actions`, "POST", body);
const serviceOrder = { action: "service_order", item: "Celular", problem: "Tela quebrada" };

describe("módulos em conversa de aplicação de integração (como na 0.23.0)", () => {
  it("a ação de módulo vale na conversa app:; Instagram continua recusado", async () => {
    const { f, app, token } = await setup();
    const id = await appConversation(f, app.id);
    const accepted = await action(token, f, id, serviceOrder);
    const body = await accepted.json<any>();
    expect(accepted.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ source: "agent", customer: { conversation_id: id } });
    // Quem não atende a conversa chega à regra do módulo, não à recusa do canal.
    const outsider = await action(await bearer(f.other), f, id, serviceOrder);
    expect(outsider.status).toBeGreaterThanOrEqual(400);
    expect((await outsider.json<any>()).error.code).not.toBe("unsupported_content");

    for (const social of [await socialConversation(f), await socialConversation(f, `app:${app.id}`)]) {
      const refused = await action(token, f, social, serviceOrder);
      expect(refused.status).toBe(422);
      expect((await refused.json<any>()).error).toMatchObject({ code: "unsupported_content",
        message: "Os módulos estão disponíveis somente em conversas do WhatsApp." });
    }
    expect(await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile)).toHaveLength(1);
    await quietCoordinator(f.profile);
  }, 60_000);

  it("os itens de menu de módulo aparecem na conversa app: e a escolha abre o módulo", async () => {
    const { f, app } = await setup();
    await configure(f, { menus: [
      { id: "abrir", label: "Abrir ordem de serviço", type: "os_open" },
      { id: "humano", label: "Falar com atendente", type: "human" },
    ] });
    const id = await appConversation(f, app.id);
    const menu = (await latest(id))?.text as string;
    expect(menu).toContain("Falar com atendente");
    expect(menu).toContain("Abrir ordem de serviço");
    await inbound(env, f.profile, { external_id: "cliente-integracao", message_id: uid(), text: "1" }, `app:${app.id}`, null);
    await drain(f);
    expect(await all(env, "SELECT id FROM web_steps WHERE conversation_id=?", id)).toHaveLength(1);
  }, 60_000);

  it("a decisão é pura: só conversas anteriores aos canais, sem canal novo gravado", () => {
    const app = { external_namespace: "app:x", chat_type: "direct" };
    expect(conversationAllowsModules({ ...app, channel: null }, null)).toBe(true);
    expect(conversationAllowsModules({ ...app, channel: "whatsapp" }, null)).toBe(true);
    for (const channel of ["instagram", "facebook", "telegram", "email", "tiktok", "googlebusiness", "desconhecido"])
      expect(conversationAllowsModules({ ...app, channel }, null), channel).toBe(false);
    for (const chat_type of ["team", "internal"])
      expect(conversationAllowsModules({ external_namespace: "channel:l", chat_type, channel: null }, null)).toBe(true);
    expect(conversationAllowsModules({ external_namespace: "channel:l", chat_type: "direct", channel: null }, null,
      { id: "l", profile_id: "p", kind: "ai", channel: null, config: "{}" } as any)).toBe(true);
    // Conversa de canal sem conexão que bata continua sem módulo.
    expect(conversationAllowsModules({ external_namespace: "channel:l", chat_type: "direct", channel: null }, null)).toBe(false);
    expect(conversationAllowsModules({ external_namespace: "channel:l", chat_type: "comment", channel: "instagram" }, null)).toBe(false);
    expect(conversationAllowsModules({ external_namespace: "channel:l", chat_type: "direct", channel: "whatsapp" }, "whatsapp")).toBe(true);
  });
});
