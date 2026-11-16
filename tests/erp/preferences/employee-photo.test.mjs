// Foto do funcionário (migração 272) pelo Worker do Fagoo, como o original
// workers/erp-api/test/employee-photo-sql.test.mjs, na fixture dupla: cada RPC portado roda nos dois motores.
// Adaptações: o bucket já existe na fixture; o objeto enviado entra nos dois lados por f.putObject (storage.objects
// no Postgres, ctx.objects no motor). Fora, declarados: o subteste "272 grants…" (GRANT/SECURITY DEFINER, papéis do
// Postgres) e, no fim do segundo, as duas escritas diretas de SQL que provam os gatilhos de imutabilidade (no motor
// as linhas só mudam pelos RPCs).
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { createHandler } from "../../../src/erp/fagoo/workers/erp-api/src/index.mjs";

let f, handler, employee, other;
const files = new Map();
const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", ALLOWED_ORIGINS: "https://synthetic.invalid" };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=", "base64"));
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const KEYS = ["rg", "job_title", "pis", "ctps", "code", "phone", "mobile", "email", "emergency_phone", "postal_code", "state", "city", "district", "street", "number", "complement", "birth_date", "admission_date", "salary", "notes"];
const person = (name, cpf) => ({ name, cpf, ...Object.fromEntries(KEYS.map((key) => [key, null])) });
before(async () => {
  f = await dualFixture();
  const save = async (data) => (await f.rpc("erp_catalog_employee_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).item.id;
  employee = await save(person("Funcionária Sintética", "52998224725"));
  other = await save(person("Funcionário Sintético Dois", "11144477735"));
  handler = createHandler({
    fetchImpl: async (url, options = {}) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith("/auth/v1/user")) return Response.json({ id: options.headers.Authorization.slice(7) });
      const object = /^\/storage\/v1\/object\/(?:authenticated\/)?erp-attachments\/(.+)$/.exec(pathname);
      if (object) {
        if (options.method === "POST") {
          if (files.has(object[1])) return new Response(null, { status: 409 });
          const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
          files.set(object[1], bytes);
          await f.putObject("erp-attachments", object[1], bytes.length, options.headers["Content-Type"]);
          return new Response(null, { status: 200 });
        }
        const bytes = files.get(object[1]);
        return bytes ? new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }) : new Response(null, { status: 404 });
      }
      try {
        return Response.json(await f.rpc(pathname.split("/").at(-1), JSON.parse(options.body)));
      } catch (e) {
        if (!e.code) throw e;
        return Response.json({ code: e.code, message: "SANITIZE_SYNTHETIC_SQL_ERROR" }, { status: 400 });
      }
    },
  });
});
after(() => f?.close());
const base = (id) => `/v1/anexos-cadastros/funcionarios/${id ?? employee}`;
async function call(path, method = "GET", body, user = f.users.admin, type = "application/json") {
  const response = await handler(
    new Request("https://api.synthetic.invalid" + path, {
      method,
      headers: { Authorization: "Bearer " + user, Origin: "https://synthetic.invalid", ...(body !== undefined ? { "Content-Type": type } : {}) },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    }),
    env,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  let value = null;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* bytes */
  }
  return { status: response.status, value, bytes };
}
const reserve = (bytes, mime, filename, extra = {}, user = f.users.admin, id) =>
  call(base(id), "POST", { command_id: randomUUID(), purpose: "photo", filename, mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes), ...extra }, user);
const send = async (bytes, mime, filename, user = f.users.admin) => {
  const reserved = await reserve(bytes, mime, filename, {}, user);
  if (reserved.status !== 200) return reserved;
  return call(`${base()}/${reserved.value.attachment.id}/upload`, "PUT", bytes, user, mime);
};

test("Foto do funcionário: send, read back checked by SHA-256, replace, remove; replays and refusals", async () => {
  assert.deepEqual((await call(base())).value, { employee_id: employee, items: [], photo: null, pending_photos: [], data_mode: "erp_native" });
  const first = await send(png, "image/png", "retrato.png");
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.deepEqual([first.value.attachment.status, first.value.attachment.filename, first.value.attachment.purpose], ["ready", "anexo-retrato.png", "photo"]);
  const photo = first.value.attachment;
  assert.equal(files.has(`employees/${employee}/${photo.id}/${sha(png)}`), true, "immutable key under employees/");
  const listed = await call(base());
  assert.deepEqual([listed.value.photo.id, listed.value.photo.owner_name !== undefined], [photo.id, true]);
  const download = await call(`${base()}/${photo.id}/download`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(download.bytes), Buffer.from(png));
  // Replay of the same reservation command answers the same row.
  const command = randomUUID(),
    body = { command_id: command, purpose: "photo", filename: "nova.jpg", mime_type: "image/jpeg", size_bytes: jpeg.length, sha256: sha(jpeg) };
  const reserved = await call(base(), "POST", body),
    again = await call(base(), "POST", body);
  assert.deepEqual([reserved.value.replayed, again.value.replayed, again.value.attachment.id], [false, true, reserved.value.attachment.id]);
  assert.equal((await call(base(), "POST", { ...body, filename: "outra.jpg" })).status, 409, "same command with another body");
  assert.equal((await call(base())).value.pending_photos.length, 1);
  const uploaded = await call(`${base()}/${reserved.value.attachment.id}/upload`, "PUT", jpeg, f.users.admin, "image/jpeg");
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.value));
  const now = await call(base());
  assert.deepEqual([now.value.photo.id, now.value.pending_photos.length], [reserved.value.attachment.id, 0], "a new foto replaces the previous one");
  assert.equal(await f.scalar("select deleted_at is not null v from erp_attachments.employee_file where id=$1", [photo.id]), true, "the previous foto is kept, logically deleted");
  assert.equal((await call(`${base()}/${photo.id}/download`)).status, 409, "a deleted foto is never delivered");
  // Remover foto: once, with replay.
  const removal = randomUUID(),
    current = now.value.photo.id;
  const removed = await call(`${base()}/${current}/exclusao`, "POST", { command_id: removal });
  const replay = await call(`${base()}/${current}/exclusao`, "POST", { command_id: removal });
  assert.deepEqual([removed.status, removed.value.attachment.deleted, replay.value.replayed], [200, true, true]);
  assert.equal((await call(base())).value.photo, null);
  assert.deepEqual(
    (await f.db.query("select action from erp_attachments.employee_file_audit where file_id=$1 order by id", [current])).rows.map((r) => r.action),
    ["reserve", "finalize", "delete"],
  );
});

test("only PNG or JPEG up to 2 MB, only the administrator, only the funcionário of the route", async () => {
  assert.equal((await reserve(png, "application/pdf", "doc.pdf")).status, 400);
  assert.equal((await reserve(png, "image/png", "grande.png", { size_bytes: 2 * 1024 * 1024 + 1 })).status, 400);
  assert.equal((await reserve(png, "image/png", "foto.png", { purpose: "attachment" })).status, 400, "a funcionário has only the foto");
  assert.equal((await reserve(png, "image/png", "foto.png", { extra: 1 })).status, 400);
  // Bytes that are not a PNG are refused before the storage.
  const fake = new TextEncoder().encode("não é uma imagem");
  const reserved = await reserve(fake, "image/png", "falsa.png");
  assert.equal((await call(`${base()}/${reserved.value.attachment.id}/upload`, "PUT", fake, f.users.admin, "image/png")).status, 415);
  assert.equal((await call(`${base()}/${reserved.value.attachment.id}/abort`, "POST", {})).value.attachment.status, "aborted");
  for (const user of [f.users.vendas, f.users.financeiro, f.users.estoque, f.users.consulta, f.users.fiscal]) {
    assert.equal((await call(base(), "GET", undefined, user)).status, 403);
    assert.equal((await reserve(png, "image/png", "foto.png", {}, user)).status, 403);
  }
  assert.equal((await call(base(randomUUID()))).status, 404);
  const mine = await send(png, "image/png", "outra.png");
  assert.equal((await call(`${base(other)}/${mine.value.attachment.id}/download`)).status, 404, "a foto of another funcionário is not found");
  assert.equal((await call(`${base()}?x=1`)).status, 400);
  assert.equal((await call(base(), "PUT", png, f.users.admin, "image/png")).status, 405);
});

test("RPCs diretos: fronteiras de lease, abort, stop e delete", async () => {
  const rpc = (name, args) => f.rpc(name, { p_user_id: f.users.admin, p_employee_id: employee, ...args });
  const fails = (fn, code, message) => assert.rejects(fn, (e) => e.code === code && (!message || e.message === message));
  const r = (await rpc("erp_attachment_employee_reserve", { p_command_id: randomUUID(), p_filename: "anexo-x.png", p_mime_type: "image/png", p_size_bytes: png.length, p_sha256: sha(png) })).attachment;
  await fails(() => rpc("erp_attachment_employee_claim", { p_id: r.id, p_lease: null }), "22023", "erp_attachment_invalid_lease");
  await fails(() => rpc("erp_attachment_employee_stop", { p_id: r.id, p_abort: null }), "22023", "erp_attachment_invalid_action");
  await fails(() => rpc("erp_attachment_employee_object", { p_id: r.id, p_write: null }), "22023", "erp_attachment_invalid_action");
  await fails(() => rpc("erp_attachment_employee_object", { p_id: r.id }), "40001", "erp_attachment_not_ready");
  assert.equal((await rpc("erp_attachment_employee_object", { p_id: r.id, p_write: true })).object_key, `employees/${employee}/${r.id}/${sha(png)}`);
  const lease = randomUUID();
  await rpc("erp_attachment_employee_claim", { p_id: r.id, p_lease: lease });
  await fails(() => rpc("erp_attachment_employee_claim", { p_id: r.id, p_lease: randomUUID() }), "40001", "erp_attachment_upload_conflict");
  await fails(() => rpc("erp_attachment_employee_stop", { p_id: r.id, p_abort: true }), "40001", "erp_attachment_upload_conflict");
  await fails(() => rpc("erp_attachment_employee_finish", { p_id: r.id, p_lease: lease, p_sha256: sha(jpeg), p_size_bytes: png.length }), "40001", "erp_attachment_integrity_conflict");
  await fails(() => rpc("erp_attachment_employee_finish", { p_id: r.id, p_lease: lease, p_sha256: sha(png), p_size_bytes: png.length }), "40001", "erp_attachment_object_unconfirmed");
  await rpc("erp_attachment_employee_stop", { p_id: r.id, p_abort: false, p_lease: randomUUID() });
  await rpc("erp_attachment_employee_stop", { p_id: r.id, p_abort: false, p_lease: lease });
  await fails(() => rpc("erp_attachment_employee_delete", { p_id: r.id, p_command_id: randomUUID() }), "40001", "erp_attachment_not_ready");
  await fails(() => rpc("erp_attachment_employee_delete", { p_id: r.id, p_command_id: null }), "22023", "erp_attachment_invalid_action");
  const stopped = await rpc("erp_attachment_employee_stop", { p_id: r.id, p_abort: true });
  assert.equal(stopped.attachment.status, "aborted");
  assert.equal((await rpc("erp_attachment_employee_stop", { p_id: r.id, p_abort: true })).attachment.status, "aborted");
  await fails(() => rpc("erp_attachment_employee_claim", { p_id: r.id, p_lease: randomUUID() }), "40001", "erp_attachment_upload_conflict");
  await fails(() => rpc("erp_attachment_employee_list", { p_employee_id: null }), "P0002", "erp_attachment_employee_not_found");
  await fails(() => rpc("erp_attachment_employee_object", { p_id: randomUUID(), p_write: true }), "P0002", "erp_attachment_not_found");
  await fails(() => rpc("erp_attachment_employee_reserve", { p_command_id: randomUUID(), p_filename: "anexo-x.jpg", p_mime_type: "image/png", p_size_bytes: 1, p_sha256: sha(png) }), "22023");
  await fails(() => rpc("erp_attachment_employee_reserve", { p_command_id: randomUUID(), p_filename: "anexo-x.png", p_mime_type: "image/png", p_size_bytes: 1, p_sha256: "A".repeat(64) }), "22023");
});
