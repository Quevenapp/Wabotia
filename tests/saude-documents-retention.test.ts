import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import * as db from "../src/db";
import { now, uid } from "../src/types";
import { readBinaryContent } from "../src/modules/binary";
import { command, policy, readSubject } from "../src/modules/saude/store";
import { attachmentUpload, beginUpload, completeUpload, downloadAttachment, listAttachments } from "../src/modules/saude/documents";
import { exportRecord } from "../src/modules/saude/export";
import { purge, retentionView } from "../src/modules/saude/retention";
import { DAY, LIMIT } from "../src/modules/saude/model";
import { saudeFixture, SECRET, type SaudeFixture } from "./saude-fixture";

afterEach(() => vi.restoreAllMocks());
const reserve = (f: SaudeFixture, bytes = 3) => f.run("attachment.reserve", { episode_id: f.episode.id, name: "exame.txt", mime_type: "text/plain", expected_bytes: bytes });
function bucketContext(f: SaudeFixture, overrides: Partial<R2Bucket>) {
  const media = new Proxy(env.MEDIA, { get(target, property) {
    if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...f.ctx, env: { ...f.ctx.env, MEDIA: media } };
}
async function upload(f: SaudeFixture, id: string, key = uid(), body = "abc") {
  const content = vi.fn(() => readBinaryContent(new Request("https://test.invalid", { method: "PUT", body })));
  const result = await attachmentUpload.upload(f.ctx, f.clinician, {
    params: { subject_id: f.patient.id, document_id: id }, query: {}, request: new Request("https://test.invalid"),
    key, version: 1, content,
    command: (op, data) => op.endsWith("begin")
      ? beginUpload(f.ctx, f.clinician, f.patient.id, id, data.version as number, data.upload_key as string)
      : completeUpload(f.ctx, f.clinician, f.patient.id, id, data.version as number, data.attempt as string),
  });
  return { result, content };
}
async function setPolicy(f: SaudeFixture, days: number | null, enabled = false) {
  const before = await policy(f.ctx);
  return command(f.ctx, f.clinician, "policy.set", { retention_days: days, deletion_enabled: enabled, version: before.version }, uid());
}
const age = (f: SaudeFixture) => exec(env,
  "UPDATE saude_subjects SET last_activity=?,retain_until=? WHERE profile_id=? AND id=?", now() - 10 * DAY, now() - DAY, f.profile, f.patient.id);

describe("Saúde: documentos sempre sensíveis", () => {
  it("usa o transporte do motor, confere bytes/hash, repete sem sobrescrever e exporta os bytes", async () => {
    const f = await saudeFixture();
    const doc = await reserve(f);
    const key = uid();
    await upload(f, doc.id, key);
    expect((await upload(f, doc.id, key, "XYZ")).content).not.toHaveBeenCalled();
    const row = await one(env, "SELECT * FROM saude_attachments WHERE profile_id=? AND id=?", f.profile, doc.id);
    expect(row).toMatchObject({ sensitive: 1, client_visible: 0, state: "ready", version: 2 });
    expect(row!.sha256).toMatch(/^[a-f0-9]{64}$/);
    const downloaded = await downloadAttachment(f.ctx, f.clinician, f.patient.id, doc.id);
    expect(await new Response(downloaded.body).text()).toBe("abc");
    expect(new Headers(downloaded.headers).get("Cache-Control")).toBe("no-store");
    expect(await one(env, "SELECT actor FROM saude_access_audit WHERE profile_id=? AND action='attachment.download'", f.profile)).toEqual({ actor: f.clinician.id });
    const exported = await exportRecord(f.ctx, f.clinician, f.patient.id);
    const lines = (await new Response(exported.body).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.find(r => r.type === "attachment_bytes")).toMatchObject({ id: doc.id, offset: 0, base64: "YWJj" });
    await expect(exec(env, "UPDATE saude_attachments SET client_visible=1 WHERE profile_id=? AND id=?", f.profile, doc.id)).rejects.toThrow();
    expect(await all(env, "SELECT id FROM os_documents WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("recusa reclassificação, pendente, tamanho, conflito de tentativa e conclusão com hash incorreto", async () => {
    const f = await saudeFixture();
    await expect(f.run("attachment.reserve", { episode_id: f.episode.id, name: "x.pdf", mime_type: "application/pdf", expected_bytes: 3, sensitive: false })).rejects.toMatchObject({ status: 400 });
    await expect(reserve(f, LIMIT + 1)).rejects.toMatchObject({ status: 400 });
    const doc = await reserve(f);
    await expect(downloadAttachment(f.ctx, f.clinician, f.patient.id, doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(upload(f, doc.id, "size", "abcde")).rejects.toMatchObject({ code: "content_mismatch" });
    await expect(beginUpload(f.ctx, f.clinician, f.patient.id, doc.id, 1, "another")).rejects.toMatchObject({ code: "upload_busy" });
    const row = await one(env, "SELECT * FROM saude_attachments WHERE profile_id=? AND id=?", f.profile, doc.id);
    await env.MEDIA.put(row!.r2_key, "abc", { customMetadata: { sha256: "invalid" } });
    await expect(completeUpload(f.ctx, f.clinician, f.patient.id, doc.id, 1, row!.attempt)).rejects.toMatchObject({ code: "content_mismatch" });
    await expect(readBinaryContent(new Request("https://test.invalid", { method: "PUT", body: "abcd" }), 3)).rejects.toMatchObject({ status: 413 });
  });
  it("autoriza antes dos bytes/R2 e bloqueia área alheia e administrador; auditoria falha fechada no download", async () => {
    const f = await saudeFixture(), other = await saudeFixture();
    const doc = await reserve(f);
    await upload(f, doc.id);
    const get = vi.fn(env.MEDIA.get.bind(env.MEDIA));
    const ctx = bucketContext(f, { get });
    await expect(downloadAttachment(ctx, f.admin, f.patient.id, doc.id)).rejects.toMatchObject({ status: 403 });
    await expect(downloadAttachment(other.ctx, other.clinician, other.patient.id, doc.id)).rejects.toMatchObject({ status: 404 });
    expect(get).not.toHaveBeenCalled();
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("audit failed"));
    await expect(downloadAttachment(ctx, f.clinician, f.patient.id, doc.id)).rejects.toThrow("audit failed");
    expect(get).not.toHaveBeenCalled();
    await expect(listAttachments(other.ctx, other.clinician, f.patient.id, {})).rejects.toMatchObject({ status: 404 });
  });
  it("tentativa expirada usa nova chave sem perder inventário do objeto anterior", async () => {
    const f = await saudeFixture(), doc = await reserve(f);
    await beginUpload(f.ctx, f.clinician, f.patient.id, doc.id, 1, "old");
    await exec(env, "UPDATE saude_attachments SET lease_until=? WHERE profile_id=? AND id=?", now() - 1, f.profile, doc.id);
    await expect(upload(f, doc.id, "old")).rejects.toMatchObject({ code: "upload_expired" });
    await upload(f, doc.id, "new");
    expect(await all(env, "SELECT * FROM saude_objects WHERE profile_id=? AND subject_id=?", f.profile, f.patient.id)).toHaveLength(2);
  });
});

describe("Saúde: guarda e descarte", () => {
  it("política desconhecida, exclusão desligada, prazo, impedimento e envio ativo bloqueiam descarte", async () => {
    const f = await saudeFixture();
    await expect(purge(f.ctx, f.clinician, f.patient.id, true)).rejects.toMatchObject({ code: "retention" });
    await setPolicy(f, 1);
    await age(f);
    await expect(purge(f.ctx, f.clinician, f.patient.id, true)).rejects.toMatchObject({ code: "retention" });
    await setPolicy(f, 1, true);
    await exec(env, "UPDATE saude_subjects SET retain_until=? WHERE profile_id=? AND id=?", now() + DAY, f.profile, f.patient.id);
    await expect(purge(f.ctx, f.clinician, f.patient.id, true)).rejects.toMatchObject({ code: "retention" });
    await age(f);
    let view = await retentionView(f.ctx, f.clinician, f.patient.id);
    await f.run("hold.set", { version: view.version, legal_hold: true });
    await expect(purge(f.ctx, f.clinician, f.patient.id, true)).rejects.toMatchObject({ code: "retention" });
    view = await retentionView(f.ctx, f.clinician, f.patient.id);
    await f.run("hold.set", { version: view.version, legal_hold: false });
    const doc = await reserve(f);
    await beginUpload(f.ctx, f.clinician, f.patient.id, doc.id, 1, "active");
    await age(f);
    await expect(purge(f.ctx, f.clinician, f.patient.id, true)).rejects.toMatchObject({ code: "retention" });
    await expect(exec(env, "UPDATE saude_subjects SET state='deleting' WHERE profile_id=? AND id=?", f.profile, f.patient.id)).rejects.toThrow();
  });
  it("só responsável configura; diminuir prazo não encurta guarda existente; atividade renova prazo", async () => {
    const f = await saudeFixture();
    await expect(command(f.ctx, f.admin, "policy.set", { retention_days: 1, deletion_enabled: true, version: 0 }, uid())).rejects.toMatchObject({ status: 403 });
    await setPolicy(f, 10, true);
    const before = await retentionView(f.ctx, f.clinician, f.patient.id);
    await setPolicy(f, 1, true);
    expect((await retentionView(f.ctx, f.clinician, f.patient.id)).retain_until).toBe(before.retain_until);
    await setPolicy(f, null);
    await setPolicy(f, 1, true);
    expect((await retentionView(f.ctx, f.clinician, f.patient.id)).retain_until).toBe(before.retain_until);
    await age(f);
    await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    expect((await retentionView(f.ctx, f.clinician, f.patient.id)).retain_until).toBeGreaterThan(now());
  });
  it("descarte exige responsável e escrita clínica; remove bytes e versões, preserva auditoria e tombstone", async () => {
    const f = await saudeFixture();
    await setPolicy(f, 1, true);
    const r = await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await f.run("record.edit", { record_id: r.id, version: 1, text: "revisado" });
    await f.run("record.sign", { record_id: r.id, version: 2, confirm: true });
    const doc = await reserve(f); await upload(f, doc.id);
    const object = await one(env, "SELECT r2_key FROM saude_attachments WHERE profile_id=? AND id=?", f.profile, doc.id);
    await age(f);
    await expect(purge(f.ctx, { ...f.clinician, access: ["os:sensitive", "saude:clinical_read", "saude:clinical_write"] }, f.patient.id, true)).rejects.toMatchObject({ status: 403 });
    await expect(purge(f.ctx, { ...f.clinician, access: ["saude:responsible"] }, f.patient.id, true)).rejects.toMatchObject({ status: 403 });
    expect(await purge(f.ctx, f.clinician, f.patient.id, true)).toMatchObject({ has_more: true });
    await expect(readSubject(f.ctx, f.clinician, f.patient.id)).rejects.toMatchObject({ status: 404 });
    expect(await purge(f.ctx, f.clinician, f.patient.id, true)).toMatchObject({ state: "deleted", has_more: false });
    expect(await env.MEDIA.get(object!.r2_key)).toBeNull();
    for (const table of ["saude_records", "saude_revisions", "saude_attachments", "saude_episodes", "saude_objects"])
      expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=? AND subject_id=?`, f.profile, f.patient.id)).toEqual([]);
    expect(await one(env, "SELECT state,payload_enc FROM saude_subjects WHERE profile_id=? AND id=?", f.profile, f.patient.id)).toEqual({ state: "deleted", payload_enc: null });
    expect(await one(env, "SELECT action FROM saude_access_audit WHERE profile_id=? AND subject_id=? AND action='purge.complete'", f.profile, f.patient.id)).not.toBeNull();
    expect(await purge(f.ctx, f.clinician, f.patient.id, true)).toMatchObject({ state: "deleted" });
  });
  it("falha R2 deixa descarte retomável e não declara sucesso", async () => {
    const f = await saudeFixture();
    await setPolicy(f, 1, true);
    const doc = await reserve(f); await upload(f, doc.id); await age(f);
    const ctx = bucketContext(f, { delete: vi.fn().mockRejectedValueOnce(new Error("R2 unavailable")) });
    await expect(purge(ctx, f.clinician, f.patient.id, true)).rejects.toThrow("R2 unavailable");
    expect((await retentionView(f.ctx, f.clinician, f.patient.id)).state).toBe("deleting");
    await purge(f.ctx, f.clinician, f.patient.id, true);
    expect(await purge(f.ctx, f.clinician, f.patient.id, true)).toMatchObject({ state: "deleted" });
  });
  it("exportação não conclui se o prontuário mudar durante a leitura", async () => {
    const f = await saudeFixture();
    const download = await exportRecord(f.ctx, f.clinician, f.patient.id);
    const reader = (download.body as ReadableStream).getReader();
    await reader.read();
    await f.run("record.create", { episode_id: f.episode.id, kind: "evolution", text: SECRET });
    await expect((async () => { while (!(await reader.read()).done) { /* consome cópia */ } })()).rejects.toMatchObject({ code: "version_conflict" });
    expect(await one(env, "SELECT id FROM saude_access_audit WHERE profile_id=? AND action='export.complete'", f.profile)).toBeNull();
  });
});
