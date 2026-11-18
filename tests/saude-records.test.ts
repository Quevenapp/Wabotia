import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import * as db from "../src/db";
import { uid } from "../src/types";
import { command, readSubject, listSubjects, timeline, attendance, episodes } from "../src/modules/saude/store";
import { auditPage, decrypt } from "../src/modules/saude/access";
import { exportRecord } from "../src/modules/saude/export";
import { saudeFixture, SECRET } from "./saude-fixture";

afterEach(() => vi.restoreAllMocks());
describe("Saúde: prontuário e autoria", () => {
  it("cria paciente e vários animais do mesmo tutor, cifrados e com identidade própria; repetição é idempotente", async () => {
    const f = await saudeFixture();
    const body = { kind: "animal", name: "Lua", species: "Canina", tutor: { name: "Tutor", reference: "Cadastro conferido" } };
    const key = uid();
    const a = await command(f.ctx, f.clinician, "subject.create", body, key);
    expect(await command(f.ctx, f.clinician, "subject.create", body, key)).toEqual(a);
    const b = await command(f.ctx, f.clinician, "subject.create", { ...body, name: "Sol" }, uid());
    expect(b.id).not.toBe(a.id);
    expect(await readSubject(f.ctx, f.clinician, a.id)).toMatchObject(body);
    const row = await one(env, "SELECT payload_enc FROM saude_subjects WHERE profile_id=? AND id=?", f.profile, a.id);
    expect(row!.payload_enc).not.toContain("Lua");
    await expect(command(f.ctx, f.clinician, "subject.create", { ...body, tutor: undefined }, uid())).rejects.toMatchObject({ status: 400 });
    await expect(command(f.ctx, f.clinician, "subject.create", { ...body, name: "Outro" }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("vincula uma ordem uma única vez e não aceita ordem de outra área", async () => {
    const f = await saudeFixture(), other = await saudeFixture();
    await expect(f.run("episode.create", { order_id: f.order.id })).rejects.toMatchObject({ code: "order_already_linked" });
    await expect(f.run("episode.create", { order_id: other.order.id })).rejects.toMatchObject({ status: 404 });
    expect((await episodes(f.ctx, f.clinician, f.patient.id, {})).data).toHaveLength(1);
  });
  it("separa leitura, escrita, administrador, recepção e responsável técnico", async () => {
    const f = await saudeFixture();
    const reader = { ...f.clinician, access: ["saude:clinical_read", "os:sensitive"] };
    const writerOnly = { ...f.clinician, access: ["saude:clinical_write", "os:sensitive"] };
    const responsible = { ...f.clinician, access: ["saude:responsible"] };
    expect(await readSubject(f.ctx, reader, f.patient.id)).toHaveProperty("name");
    for (const actor of [f.admin, f.other, writerOnly, responsible, { ...reader, access: ["saude:clinical_read"] }])
      await expect(readSubject(f.ctx, actor, f.patient.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET }, reader)).rejects.toMatchObject({ status: 403 });
    await expect(auditPage(f.ctx, reader, {})).rejects.toMatchObject({ status: 403 });
    expect((await auditPage(f.ctx, responsible, {})).data.length).toBeGreaterThan(0);
    expect(await attendance(f.ctx, f.other, f.order.id)).toEqual({ order_id: f.order.id, number: f.order.number, status: "received", attendance_exists: true });
  });
  it("registra cada leitura e não devolve dados quando a auditoria falha", async () => {
    const f = await saudeFixture();
    const r = await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await readSubject(f.ctx, f.clinician, f.patient.id);
    await readSubject(f.ctx, f.clinician, f.patient.id);
    await listSubjects(f.ctx, f.clinician, {});
    await timeline(f.ctx, f.clinician, f.patient.id, {});
    const audits = await all(env, "SELECT * FROM saude_access_audit WHERE profile_id=?", f.profile);
    expect(audits.filter(a => a.action === "subject.read")).toHaveLength(2);
    expect(audits.find(a => a.action === "records.read")).toMatchObject({ actor: f.clinician.id, resources_json: JSON.stringify([`${r.id}:v1`]) });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(readSubject(f.ctx, f.clinician, f.patient.id)).rejects.toThrow("audit unavailable");
    await expect(exec(env, "DELETE FROM saude_access_audit WHERE profile_id=?", f.profile)).rejects.toThrow();
  });
  it("só o autor edita e assina; CAS e assinatura imutável; correção preserva o original por adendo", async () => {
    const f = await saudeFixture();
    const r = await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    const other = { ...f.clinician, id: f.other.id };
    await expect(f.run("record.edit", { record_id: r.id, version: 1, text: "outro" }, other)).rejects.toMatchObject({ code: "author_required" });
    await expect(f.run("record.sign", { record_id: r.id, version: 1, confirm: true }, other)).rejects.toMatchObject({ code: "author_required" });
    await f.run("record.edit", { record_id: r.id, version: 1, text: "Rascunho revisado" });
    await expect(f.run("record.edit", { record_id: r.id, version: 1, text: "Não deve gravar" })).rejects.toMatchObject({ code: "version_conflict" });
    const revisions = await all(env, "SELECT * FROM saude_revisions WHERE profile_id=? AND record_id=?", f.profile, r.id);
    expect(revisions).toHaveLength(1);
    expect((await decrypt(f.ctx, r.id, revisions[0].payload_enc)).text).toBe(SECRET);
    await f.run("record.sign", { record_id: r.id, version: 2, confirm: true });
    const signed = await one(env, "SELECT * FROM saude_records WHERE profile_id=? AND id=?", f.profile, r.id);
    expect(signed!.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(f.run("record.edit", { record_id: r.id, version: 3, text: "Alteração" })).rejects.toMatchObject({ code: "immutable" });
    await expect(exec(env, "UPDATE saude_records SET payload_enc='x' WHERE profile_id=? AND id=?", f.profile, r.id)).rejects.toThrow();
    const addendum = await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: "Correção", reason: "Retificação", addendum_of: r.id });
    await f.run("record.sign", { record_id: addendum.id, version: 1, confirm: true });
    expect(await one(env, "SELECT * FROM saude_records WHERE profile_id=? AND id=?", f.profile, r.id)).toEqual(signed);
    const page = await timeline(f.ctx, f.clinician, f.patient.id, {});
    expect(page.data).toHaveLength(2);
    expect(page.data.find(x => x!.id === addendum.id)).toMatchObject({ addendum_of: r.id, reason: "Retificação" });
    await expect(exec(env, "DELETE FROM saude_records WHERE profile_id=? AND id=?", f.profile, r.id)).rejects.toThrow();
  });
  it("adendo exige original assinado, motivo, paciente e episódio corretos", async () => {
    const f = await saudeFixture(), other = await saudeFixture();
    const draft = await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    const input = { episode_id: f.episode.id, kind: "evolution", text: "Correção", addendum_of: draft.id, reason: "Motivo" };
    await expect(f.run("record.create", input)).rejects.toMatchObject({ code: "invalid_addendum" });
    await f.run("record.sign", { record_id: draft.id, version: 1, confirm: true });
    await expect(f.run("record.create", { ...input, reason: undefined })).rejects.toMatchObject({ status: 400 });
    await expect(other.run("record.create", { ...input, episode_id: other.episode.id })).rejects.toMatchObject({ status: 404 });
  });
  it("prescrição interna e resultado exigem vínculo ao pedido e origem; não anunciam revisão clínica", async () => {
    const f = await saudeFixture();
    await f.run("record.create", { episode_id: f.episode.id, kind: "prescription", text: SECRET });
    const request = await f.run("record.create", { episode_id: f.episode.id, kind: "exam_request", text: "Solicitação" });
    await expect(f.run("record.create", { episode_id: f.episode.id, kind: "exam_result", text: SECRET })).rejects.toMatchObject({ status: 400 });
    await f.run("record.create", { episode_id: f.episode.id, kind: "exam_result", text: SECRET, request_id: request.id, origin: "Laboratório informado", received_at: Date.now() });
    const page = await timeline(f.ctx, f.clinician, f.patient.id, {});
    expect(page.data.find(r => r!.kind === "prescription")).toHaveProperty("notice", "Registro interno. Não constitui receita emitida para dispensação.");
    expect(page.data.find(r => r!.kind === "exam_result")).toHaveProperty("review", "received_unreviewed");
  });
  it("isola sujeito, episódios, registros, auditoria e exportação por área", async () => {
    const f = await saudeFixture(), other = await saudeFixture();
    await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await expect(readSubject(other.ctx, other.clinician, f.patient.id)).rejects.toMatchObject({ status: 404 });
    await expect(timeline(other.ctx, other.clinician, f.patient.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(exportRecord(other.ctx, other.clinician, f.patient.id)).rejects.toMatchObject({ status: 404 });
    expect((await auditPage(other.ctx, other.clinician, { subject_id: f.patient.id })).data).toEqual([]);
    await expect(other.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: "errado" })).rejects.toMatchObject({ status: 404 });
  });
  it("pagina sem duplicar e exporta só o paciente autorizado com registro de conclusão", async () => {
    const f = await saudeFixture();
    for (let i = 0; i < 3; i++) await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: `${SECRET}_${i}` });
    const a = await timeline(f.ctx, f.clinician, f.patient.id, { limit: "2" });
    const b = await timeline(f.ctx, f.clinician, f.patient.id, { limit: "2", cursor: a.next_cursor! });
    expect(new Set([...a.data, ...b.data].map(r => r!.id)).size).toBe(3);
    expect(b.next_cursor).toBeNull();
    await expect(exportRecord(f.ctx, f.admin, f.patient.id)).rejects.toMatchObject({ status: 403 });
    const download = await exportRecord(f.ctx, { ...f.clinician, access: ["os:sensitive", "saude:clinical_read"] }, f.patient.id);
    expect(new Headers(download.headers).get("Cache-Control")).toBe("no-store");
    const content = await new Response(download.body).text();
    expect(content).toContain(SECRET);
    expect(JSON.parse(content.trim().split("\n").at(-1)!)).toEqual({ type: "complete", subject_id: f.patient.id });
    expect(await one(env, "SELECT actor FROM saude_access_audit WHERE profile_id=? AND subject_id=? AND action='export.complete'", f.profile, f.patient.id)).toEqual({ actor: f.clinician.id });
  });
});
