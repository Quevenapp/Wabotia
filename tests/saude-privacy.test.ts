import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { fullCatalog, resetCatalogCache } from "../src/bot-actions/catalog";
import { authorizedOrder } from "../src/modules/os/public";
import { projectChildForBot, projectChildForCustomer, projectOrderForBot, projectOrderForCustomer } from "../src/modules/os/privacy";
import { saudeModule } from "../src/modules/saude/definition";
import { saudeExtension } from "../src/modules/saude/saude";
import { readSubject, timeline } from "../src/modules/saude/store";
import { resolveStates } from "../src/modules/registry";
import { perform } from "../src/service";
import { uid, type Actor } from "../src/types";
import { api, bearer, receive } from "./service-center-fixture";
import { saudeFixture, SECRET } from "./saude-fixture";

describe("Saúde: nenhum canal comum transporta prontuário", () => {
  it("vem desligado, depende de os e não declara menu, eventos, ferramentas ou agendador", async () => {
    const f = await saudeFixture();
    expect(saudeModule.default_enabled).toBe(false);
    expect(saudeModule.requires).toEqual(["os"]);
    expect(saudeModule.menu_item_types).toEqual([]);
    expect(saudeModule.events).toEqual([]);
    expect(saudeExtension).not.toHaveProperty("tools");
    expect(saudeExtension).not.toHaveProperty("runDue");
    expect(resolveStates({ os: 0, saude: 1 }).saude).toBe(false);
    await perform(env, f.admin, f.profile, "module.set", { id: "saude", enabled: false }, uid());
    await expect(readSubject(f.ctx, f.clinician, f.patient.id)).rejects.toMatchObject({ code: "module_disabled" });
    const response = await api(await bearer(f.clinician), `/profiles/${f.profile}/saude/subjects`);
    expect(response.status).toBe(409);
  });
  it("bot.deny cobre todos os descritores; cada manipulador recusa via, bot, aplicação, conector e credencial", async () => {
    const f = await saudeFixture();
    resetCatalogCache();
    expect(fullCatalog().filter(item => item.module === "saude")).toEqual([]);
    for (const item of [...saudeExtension.binaryReads, ...saudeExtension.binaryUploads])
      expect(saudeModule.bot!.deny!.some(prefix => item.path.startsWith(prefix))).toBe(true);
    for (const item of saudeExtension.commands) {
      expect(saudeModule.bot!.deny!.some(prefix => item.op.startsWith(prefix))).toBe(true);
      expect(saudeModule.bot!.sensitive!.some(prefix => item.op.startsWith(prefix))).toBe(true);
    }
    const actors: Actor[] = [
      { ...f.clinician, via: { kind: "bot", bot_id: "b", run_id: "r", masked: false } },
      { ...f.clinician, via: { kind: "bot", bot_id: "b", run_id: "r", masked: true } },
      { ...f.clinician, id: "bot:admin" },
      { ...f.clinician, kind: "app", scopes: ["conversations:read", "conversations:write"] },
      { ...f.clinician, kind: "connector" },
      { ...f.clinician, credential: { id: "c", module: "saude", subject: f.patient.id } },
      { ...f.clinician, module: { id: "os", reach: ["saude"] } },
    ];
    for (const actor of actors) {
      for (const item of saudeExtension.binaryReads)
        await expect(item.handler(f.ctx, actor, { params: { subject_id: f.patient.id, order_id: f.order.id }, query: {}, request: new Request("https://test.invalid") })).rejects.toMatchObject({ status: 403 });
      for (const item of saudeExtension.commands)
        await expect(item.handler(f.ctx, actor, { subject_id: f.patient.id }, { requestId: uid() })).rejects.toMatchObject({ status: 403 });
      await expect(saudeExtension.binaryUploads[0].handler.authorize(f.ctx, actor, { params: { subject_id: f.patient.id, document_id: "id" }, query: {}, request: new Request("https://test.invalid") })).rejects.toMatchObject({ status: 403 });
    }
  });
  it("cliente verificado recebe somente a ordem pública; outro telefone não obtém a ordem nem prontuário", async () => {
    const f = await saudeFixture();
    await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    const owner = await receive(f, f.line, "oi", "5511960010203");
    const stranger = await receive(f, f.line, "oi", "5511960010299");
    const order = await authorizedOrder(f.ctx, f.clinician, f.order.id, { conversation_id: owner.id });
    const customer = projectOrderForCustomer(f.ctx, f.clinician, order);
    expect(JSON.stringify(customer)).not.toContain(SECRET);
    expect(JSON.stringify(customer)).not.toContain(f.patient.id);
    expect(JSON.stringify(projectOrderForBot(f.ctx, f.clinician, order))).not.toContain(SECRET);
    await expect(authorizedOrder(f.ctx, f.clinician, f.order.id, { conversation_id: stranger.id })).rejects.toMatchObject({ status: 404 });
    const clinical = (await timeline(f.ctx, f.clinician, f.patient.id, {})).data[0]!;
    expect(projectChildForCustomer(clinical)).toBeNull();
    expect(projectChildForBot(clinical)).toBeNull();
  });
  it("não escreve em WhatsApp, histórico, eventos, documentos comuns, campos extras ou mídia compartilhável", async () => {
    const f = await saudeFixture();
    const history = await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=?", f.profile, f.order.id);
    const events = await all(env, "SELECT * FROM events WHERE profile_id=?", f.profile);
    const outbox = await all(env, "SELECT * FROM outbox WHERE profile_id=?", f.profile);
    const r = await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await f.run("record.sign", { record_id: r.id, version: 1, confirm: true });
    await f.run("attachment.reserve", { episode_id: f.episode.id, name: `${SECRET}.pdf`, mime_type: "application/pdf", expected_bytes: 3 });
    expect(await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=?", f.profile, f.order.id)).toEqual(history);
    expect(await all(env, "SELECT * FROM events WHERE profile_id=?", f.profile)).toEqual(events);
    expect(await all(env, "SELECT * FROM outbox WHERE profile_id=?", f.profile)).toEqual(outbox);
    for (const table of ["os_orders", "os_documents", "media", "receipts", "audit"]) {
      // Recibos têm escopo, não profile_id; não contêm conteúdo de nenhum prontuário.
      const rows = table === "receipts" ? await all(env, "SELECT * FROM receipts") : await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile);
      expect(JSON.stringify(rows)).not.toContain(SECRET);
      if (table !== "audit" && table !== "receipts") expect(JSON.stringify(rows)).not.toContain(r.id);
    }
    const token = await bearer(f.clinician);
    const common = await api(token, `/profiles/${f.profile}/service-orders/${f.order.id}`);
    expect(await common.text()).not.toContain(SECRET);
    // Caminho público não registra rota clínica nem entrega bytes da exportação.
    const publicResponse = await SELF.fetch(`https://test/api/public/saude/subjects/${f.patient.id}/export`);
    expect(await publicResponse.text()).not.toContain(SECRET);
    const noAuth = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/saude/subjects/${f.patient.id}/export`);
    expect(noAuth.status).not.toBe(200);
  });
  it("HTTP retorna no-store, rejeita administrador sem papel e faz parâmetros do caminho vencerem o corpo", async () => {
    const f = await saudeFixture(), other = await saudeFixture();
    const token = await bearer(f.clinician);
    const base = `/profiles/${f.profile}/saude/subjects/${f.patient.id}`;
    const response = await api(token, base);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json<any>()).name).toBe("Paciente teste");
    expect((await api(await bearer(f.admin), base)).status).toBe(403);
    const write = await api(token, `${base}/records`, "POST", {
      profile: other.profile, subject_id: other.patient.id, episode_id: f.episode.id, kind: "evolution", text: SECRET,
    }, uid());
    expect(write.status).toBe(200);
    const result = await write.json<any>();
    expect(result).toEqual({ id: expect.any(String), version: 1 });
    expect(JSON.stringify(await all(env, "SELECT * FROM saude_records WHERE profile_id=?", other.profile))).not.toContain(result.id);
  });
});
