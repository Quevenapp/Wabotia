import { env } from "cloudflare:test";
import { afterAll, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Actor } from "../src/types";
import { claim, credentialActor } from "../src/module-credentials";
import { guardianOrders } from "../src/modules/ensino/access";
import { claimAccess, customerAction, ownReport, ownStudents, requestAccess } from "../src/modules/ensino/customer";
import { revokeGuardian } from "../src/modules/ensino/store";
import { createNotice, publishNotice, sendNoticeBatch } from "../src/modules/ensino/notices";
import { ensinoTool } from "../src/modules/ensino/ensino";
import { receive, claim as ownConversation } from "./service-center-fixture";
import { installEnsinoTest, linkedGuardian, schoolFixture, type SchoolFixture } from "./ensino-fixture";

const cleanup = installEnsinoTest();
afterAll(cleanup);
async function access(f: SchoolFixture, phone: string) {
  await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)", "https://school.example.test", now());
  const c = await receive(f, f.qr, "boletim", phone), key = uid();
  const response = await requestAccess(f.ctx, c, key);
  const outgoing = await one<{ payload: string }>(env, "SELECT payload FROM outbox WHERE profile_id=? AND conversation_id=? AND dedupe=?", f.profile, c.id, `module:ensino:${c.id}:access:${key}`);
  const code = JSON.parse(outgoing!.payload).text.match(/#([2-9A-HJ-NP-Za-km-np-z]{32})/)[1];
  const claimed = await claim(env, { code, name: "Responsável", device: "test", ip: "local" }, r => claimAccess(f.ctx, r));
  const actor = (await credentialActor(env, claimed.token))!;
  return { c, key, code, response, claimed, actor };
}
describe("Ensino: identidade e consulta do responsável", () => {
  it("não concede acesso só por telefone principal ou por existir pessoa ligada", async () => {
    const f = await schoolFixture();
    const c = await receive(f, f.qr, "boletim", "5511988887777");
    expect((await guardianOrders(f.ctx, c)).orderIds).toEqual([]);
    await exec(env, `INSERT INTO os_people(id,profile_id,order_id,role,name,phone,sensitive,client_visible,created_by,created,updated)
      VALUES(?,?,?,?,?,?,1,0,?,?,?)`, uid(), f.profile, f.order.id, "Responsável", "Maria", c.phone, f.secretary.id, now(), now());
    expect((await guardianOrders(f.ctx, c)).orderIds).toEqual([]);
  });
  it("confere canal, área e grupo; telefone digitado nunca serve de credencial", async () => {
    const f = await schoolFixture(), g = await linkedGuardian(f);
    const c = await receive(f, f.qr, "boletim", g.phone);
    expect((await guardianOrders(f.ctx, c)).orderIds).toEqual([f.order.id]);
    for (const fake of [{ ...c, chat_type: "group" }, { ...c, external_namespace: "app:fake" }, { ...c, connection_id: null }, { ...c, profile_id: uid() }])
      await expect(guardianOrders(f.ctx, fake)).rejects.toMatchObject({ status: 404 });
    await expect(customerAction(f.ctx, f.secretary, c, { action: "ensino_boletim", phone: g.phone }, uid())).rejects.toMatchObject({ status: 400 });
  });
  it("só lista os próprios alunos; segredo troca uma vez e nenhuma nota retorna ao bot", async () => {
    const f = await schoolFixture(), other = await schoolFixture(), g = await linkedGuardian(f);
    await linkedGuardian(other, 2, g.phone); // Mesmo telefone, outra área.
    const a = await access(f, g.phone);
    expect(a.response).toEqual({ status: "request_processed", message: expect.any(String) });
    expect(JSON.stringify(a.response)).not.toMatch(/Ana|5511|token|revision|score|https/);
    expect(a.claimed.data).toEqual({ ready: true, expires_at: expect.any(Number) });
    const children = await ownStudents(f.ctx, a.actor, a.claimed.subject, {});
    expect(children.data.map(c => c.id)).toEqual([f.student.id]);
    expect(await ownReport(f.ctx, a.actor, a.claimed.subject, f.student.id)).toMatchObject({ reports: [], notices: [] });
    await expect(ownReport(f.ctx, a.actor, a.claimed.subject, other.student.id)).rejects.toMatchObject({ status: 404 });
    await expect(ownStudents(other.ctx, a.actor, a.claimed.subject, {})).rejects.toMatchObject({ status: 404 });
    await expect(ownStudents(f.ctx, f.secretary, a.claimed.subject, {})).rejects.toMatchObject({ status: 404 });
    await expect(claim(env, { code: a.code, name: "Xx", device: "outro", ip: "local" }, r => claimAccess(f.ctx, r))).rejects.toMatchObject({ code: "claim_used" });
    // Reprocessar o mesmo turno não invalida a credencial já entregue.
    await requestAccess(f.ctx, a.c, a.key);
    expect(await credentialActor(env, a.claimed.token)).not.toBeNull();
    const bot: Actor = { ...a.actor, id: "bot:fake", credential: undefined, scopes: ["conversations:read"] };
    await expect(ownStudents(f.ctx, bot, a.claimed.subject, {})).rejects.toMatchObject({ status: 404 });
    expect(ensinoTool.call({ conversation_id: a.c.id }, f.profile)).toMatchObject({ method: "POST", body: { action: "ensino_boletim" } });
  });
  it("revoga imediatamente e preserva o outro responsável", async () => {
    const f = await schoolFixture(), first = await linkedGuardian(f), second = await linkedGuardian(f, 3, "5511977776666");
    const a = await access(f, first.phone), b = await access(f, second.phone);
    await revokeGuardian(f.ctx, f.secretary, { id: f.classroom.id, version: 4, enrollment_id: f.student.id, guardian_id: first.grant.id }, uid());
    await expect(ownStudents(f.ctx, a.actor, a.claimed.subject, {})).rejects.toMatchObject({ status: 404 });
    expect((await ownStudents(f.ctx, b.actor, b.claimed.subject, {})).data).toHaveLength(1);
  });
  it.each(["phone", "archived", "expired", "session"])("invalida acesso após alteração de %s", async kind => {
    const f = await schoolFixture(), g = await linkedGuardian(f), a = await access(f, g.phone);
    if (kind === "phone") await exec(env, "UPDATE os_people SET phone='5511999990000',version=version+1 WHERE profile_id=? AND id=?", f.profile, g.personId);
    if (kind === "archived") await exec(env, "UPDATE os_people SET archived_at=? WHERE profile_id=? AND id=?", now(), f.profile, g.personId);
    if (kind === "expired") await exec(env, "UPDATE ensino_guardians SET valid_until='2000-01-01' WHERE profile_id=? AND id=?", f.profile, g.grant.id);
    if (kind === "session") await exec(env, "UPDATE conversations SET session=? WHERE profile_id=? AND id=?", uid(), f.profile, a.c.id);
    await expect(ownStudents(f.ctx, a.actor, a.claimed.subject, {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("Ensino: comunicado coletivo", () => {
  it("professor prepara; secretaria publica; envio usa permissão, fila, finalidade e chave estável", async () => {
    const f = await schoolFixture(), g = await linkedGuardian(f);
    const c = await receive(f, f.qr, "oi", g.phone);
    const n = await createNotice(f.ctx, f.professor, { id: f.classroom.id, version: 3, text: "CONTEUDO_PRIVADO_COMUNICADO", audience_date: "2025-02-03" }, uid());
    await expect(publishNotice(f.ctx, f.professor, { id: f.classroom.id, version: 4, notice_id: n.id, reviewed: true }, uid())).rejects.toMatchObject({ status: 403 });
    await publishNotice(f.ctx, f.secretary, { id: f.classroom.id, version: 4, notice_id: n.id, reviewed: true }, uid());
    // Não atende a conversa: fica bloqueado, sem burlar mayMessage.
    expect((await sendNoticeBatch(f.ctx, f.secretary, { id: f.classroom.id, notice_id: n.id })).counts).toContainEqual({ status: "blocked", total: 1 });
    await ownConversation(f, f.secretary, c.id);
    const sender = vi.spyOn(f.ctx, "sendMessage");
    const sent = await sendNoticeBatch(f.ctx, f.secretary, { id: f.classroom.id, notice_id: n.id, retry: true });
    expect(sent.counts).toContainEqual({ status: "queued", total: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ id: c.id }), expect.objectContaining({ text: expect.not.stringContaining("CONTEUDO_PRIVADO_COMUNICADO") }), expect.objectContaining({ notification: true, purpose: "order", key: expect.stringContaining(n.id) }));
    await sendNoticeBatch(f.ctx, f.secretary, { id: f.classroom.id, notice_id: n.id, retry: true });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await all(env, "SELECT payload FROM outbox WHERE profile_id=?", f.profile))).not.toContain("CONTEUDO_PRIVADO_COMUNICADO");
    sender.mockRestore();
  });
  it("deduplica responsáveis e cancela destinatário revogado antes de enfileirar", async () => {
    const f = await schoolFixture(), g = await linkedGuardian(f);
    await linkedGuardian(f, 3, g.phone);
    const n = await createNotice(f.ctx, f.professor, { id: f.classroom.id, version: 4, text: "Reunião da turma", audience_date: "2025-02-03" }, uid());
    await publishNotice(f.ctx, f.secretary, { id: f.classroom.id, version: 5, notice_id: n.id, reviewed: true }, uid());
    expect(await all(env, "SELECT phone_hash FROM ensino_deliveries WHERE profile_id=? AND notice_id=?", f.profile, n.id)).toHaveLength(1);
    await exec(env, "UPDATE ensino_guardians SET revoked_at=? WHERE profile_id=?", now(), f.profile);
    expect((await sendNoticeBatch(f.ctx, f.secretary, { id: f.classroom.id, notice_id: n.id })).counts).toContainEqual({ status: "cancelled", total: 1 });
  });
});
