// Anexos dos documentos e dos contatos na fixture dupla. Adaptados do Fagoo:
// - contact-files-sql.test.mjs (pelo Worker real, como o original): "Anexos: reserve, upload…", "Foto: PNG or JPEG…" e
//   "Anexos dos documentos…"; fora, declarado: "170 grants" (GRANT/SECURITY DEFINER);
// - attachments.test.mjs (RPCs diretos): "reservation replay…", "leases reject…" e "expired leases…". Adaptação: o objeto de
//   tamanho errado e o certo vão em dois anexos (f.putObject só insere); fora, declarados: as escritas diretas que provam os
//   gatilhos de imutabilidade e os subtestes de ACL, Storage e roteamento do Worker (sem RPC do motor).
// O objeto enviado entra nos dois lados por f.putObject (storage.objects no Postgres, ctx.objects no motor).
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { createHandler } from "../../../src/erp/fagoo/workers/erp-api/src/index.mjs";

let f, handler, contact;
const files = new Map();
const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", ALLOWED_ORIGINS: "https://synthetic.invalid" };
const text = new TextEncoder().encode("Contrato social sintético.\n");
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=", "base64"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fails = (fn, code, message) => assert.rejects(fn, (e) => e.code === code && (!message || e.message === message));
before(async () => {
  f = await dualFixture();
  contact = await f.catalog("contacts", { name: "Cliente com anexos" });
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
const base = (id) => `/v1/anexos-cadastros/contatos/${id ?? contact.id}`;
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
  return { status: response.status, value, bytes, type: response.headers.get("Content-Type") };
}
const send = async (purpose, bytes, mime, filename, user = f.users.admin) => {
  const reserved = await call(base(), "POST", { command_id: randomUUID(), purpose, filename, mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes) }, user);
  if (reserved.status !== 200) return reserved;
  return call(`${base()}/${reserved.value.attachment.id}/upload`, "PUT", bytes, user, mime);
};
async function salesOrder() {
  return (
    await f.rpc("erp_document_save", {
      p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date: "2024-10-15", contact_id: contact.id, items: [{ description: "Item fictício", unit: "UN", quantity: "1", unit_price: "1" }] },
    })
  ).document;
}

test("Anexos: reserve, upload checked by SHA-256, list with the owner, download, logical deletion and its replay", async () => {
  const uploaded = await send("attachment", text, "text/plain", "contrato.txt");
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.value));
  const id = uploaded.value.attachment.id;
  assert.deepEqual([uploaded.value.attachment.status, uploaded.value.attachment.purpose, uploaded.value.attachment.filename], ["ready", "attachment", "anexo-contrato.txt"]);
  const listed = await call(base(), "GET", undefined, f.users.consulta);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.items.map((item) => item.id), [id]);
  assert.equal(listed.value.photo, null);
  const download = await call(`${base()}/${id}/download`, "GET", undefined, f.users.consulta);
  assert.equal(download.status, 200);
  assert.deepEqual([...download.bytes], [...text]);
  assert.equal((await call(`${base()}/${id}/exclusao`, "POST", { command_id: randomUUID() }, f.users.consulta)).status, 403, "consulta does not delete");
  const command = randomUUID();
  const deleted = await call(`${base()}/${id}/exclusao`, "POST", { command_id: command });
  assert.equal(deleted.status, 200);
  assert.deepEqual([deleted.value.attachment.deleted, deleted.value.replayed], [true, false]);
  assert.equal((await call(`${base()}/${id}/exclusao`, "POST", { command_id: command })).value.replayed, true);
  assert.equal((await call(`${base()}/${id}/exclusao`, "POST", { command_id: randomUUID() })).status, 409, "already deleted");
  assert.deepEqual((await call(base())).value.items, []);
  assert.equal((await call(`${base()}/${id}/download`)).status, 409, "a deleted file is not delivered");
  assert.equal(await f.scalar("select count(*)::int v from erp_attachments.contact_file_audit where file_id=$1", [id]), 3, "reserve, finalize and delete are audited");
});

test("Foto: PNG or JPEG up to 2 MB; a new foto replaces the previous; reservations can be cancelled; refusals", async () => {
  assert.equal((await send("photo", text, "text/plain", "foto.txt")).status, 400, "a foto is an image");
  const first = await send("photo", png, "image/png", "foto.png");
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.equal((await call(base())).value.photo.id, first.value.attachment.id);
  const second = await send("photo", png, "image/png", "nova.png");
  assert.equal((await call(base())).value.photo.id, second.value.attachment.id);
  assert.equal(await f.scalar("select deleted_at is not null v from erp_attachments.contact_file where id=$1", [first.value.attachment.id]), true, "the previous foto is kept, logically deleted");
  const reserved = await call(base(), "POST", { command_id: randomUUID(), purpose: "photo", filename: "outra.png", mime_type: "image/png", size_bytes: png.length, sha256: sha(png) });
  assert.deepEqual((await call(base())).value.pending_photos.map((item) => item.id), [reserved.value.attachment.id]);
  const aborted = await call(`${base()}/${reserved.value.attachment.id}/abort`, "POST", {});
  assert.equal(aborted.value.attachment.status, "aborted");
  assert.equal((await send("attachment", text, "text/plain", "x.txt", f.users.consulta)).status, 403);
  assert.equal((await call(base(randomUUID()))).status, 404);
  assert.equal(
    (await call(base(), "POST", { command_id: randomUUID(), purpose: "attachment", filename: "x.txt", mime_type: "text/plain", size_bytes: 1, sha256: "x" })).status,
    400,
  );
  const wrong = await call(base(), "POST", { command_id: randomUUID(), purpose: "attachment", filename: "y.txt", mime_type: "text/plain", size_bytes: text.length, sha256: sha(text) });
  const other = text.slice();
  other[0] = 0x63;
  assert.equal((await call(`${base()}/${wrong.value.attachment.id}/upload`, "PUT", other, f.users.admin, "text/plain")).status, 409, "bytes that differ from the reservation are refused");
});

test('Anexos dos documentos: owner in the list and "Excluir selecionados" (logical, audited, replayed by command)', async () => {
  const doc = await salesOrder();
  const docBase = `/v1/documentos/sales_orders/${doc.id}/anexos`;
  const reserved = await call(docBase, "POST", { command_id: randomUUID(), filename: "pedido.txt", mime_type: "text/plain", size_bytes: text.length, sha256: sha(text) });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.value));
  const id = reserved.value.attachment.id;
  assert.equal((await call(`${docBase}/${id}/upload`, "PUT", text, f.users.admin, "text/plain")).value.attachment.status, "ready");
  const listed = await call(docBase);
  assert.deepEqual(listed.value.items.map((item) => [item.id, item.deleted, Object.hasOwn(item, "owner_name")]), [[id, false, true]]);
  assert.equal((await call(`${docBase}/${id}/exclusao`, "POST", { command_id: randomUUID() }, f.users.consulta)).status, 403);
  const command = randomUUID();
  const deleted = await call(`${docBase}/${id}/exclusao`, "POST", { command_id: command });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.value));
  assert.deepEqual([deleted.value.attachment.deleted, deleted.value.replayed], [true, false]);
  assert.equal((await call(`${docBase}/${id}/exclusao`, "POST", { command_id: command })).value.replayed, true);
  assert.deepEqual((await call(docBase)).value.items, []);
  assert.equal((await call(`${docBase}/${id}/download`)).status, 409, "a deleted attachment is not delivered");
  assert.equal(await f.scalar("select count(*)::int v from erp_attachments.audit where attachment_id=$1 and action='delete'", [id]), 1);
});

const args = (doc, id) => ({ p_user_id: f.users.admin, p_kind: doc.kind, p_document_id: doc.id, ...(id ? { p_id: id } : {}) });
const reserve = (doc, options = {}) =>
  f.rpc("erp_attachment_reserve", {
    ...args(doc), p_command_id: options.command || randomUUID(), p_filename: "anexo-ficticio.txt", p_mime_type: "text/plain", p_size_bytes: text.length, p_sha256: sha(text),
    ...options.override,
  });

test("reservation replay binds actor and all metadata; abort never frees the lifetime document quota", async () => {
  const doc = await salesOrder(),
    command = randomUUID();
  const first = await reserve(doc, { command });
  assert.equal((await reserve(doc, { command })).attachment.id, first.attachment.id);
  assert.equal((await reserve(doc, { command })).replayed, true);
  await fails(() => reserve(doc, { command, override: { p_size_bytes: text.length + 1 } }), "40001");
  await fails(() => reserve(doc, { command, override: { p_user_id: f.users.vendas } }), "40001");
  await f.rpc("erp_attachment_stop", { ...args(doc, first.attachment.id), p_abort: true });
  assert.equal((await reserve(doc, { command })).attachment.status, "aborted");
  for (let i = 1; i < 100; i++) await reserve(doc);
  await fails(() => reserve(doc), "54000");
  assert.equal((await f.rpc("erp_attachment_list", args(doc))).items.length, 100);
  await fails(() => f.rpc("erp_attachment_list", { ...args(doc), p_kind: "purchase_orders" }), "P0002", "erp_attachment_document_not_found");
  await fails(() => f.rpc("erp_attachment_object", { ...args(doc, first.attachment.id), p_write: null }), "22023", "erp_attachment_invalid_action");
  assert.equal((await f.rpc("erp_attachment_list", { ...args(doc), p_user_id: f.users.estoque })).items.length, 100, "estoque lê pedidos de venda");
  await fails(() => f.rpc("erp_attachment_list", { ...args(doc), p_user_id: f.users.inactive }), "42501");
});

test("leases reject competing upload/abort and finalize requires exact stored object metadata", async () => {
  const doc = await salesOrder(),
    a = (await reserve(doc)).attachment,
    b = (await reserve(doc)).attachment,
    lease = randomUUID();
  const claimed = await f.rpc("erp_attachment_claim", { ...args(doc, a.id), p_lease: lease });
  await fails(() => f.rpc("erp_attachment_claim", { ...args(doc, a.id), p_lease: randomUUID() }), "40001");
  await fails(() => f.rpc("erp_attachment_claim", { ...args(doc, a.id), p_lease: null }), "22023", "erp_attachment_invalid_lease");
  await fails(() => f.rpc("erp_attachment_stop", { ...args(doc, a.id), p_abort: true }), "40001");
  const finish = (x, l) => f.rpc("erp_attachment_finish", { ...args(doc, x.id), p_lease: l, p_sha256: x.sha256, p_size_bytes: x.size_bytes });
  await fails(() => finish(a, lease), "40001", "erp_attachment_object_unconfirmed");
  await fails(() => f.rpc("erp_attachment_finish", { ...args(doc, a.id), p_lease: lease, p_sha256: a.sha256, p_size_bytes: a.size_bytes + 1 }), "40001", "erp_attachment_integrity_conflict");
  const leaseB = randomUUID();
  const claimedB = await f.rpc("erp_attachment_claim", { ...args(doc, b.id), p_lease: leaseB });
  await f.putObject("erp-attachments", claimedB.object_key, b.size_bytes + 1, b.mime_type);
  await fails(() => finish(b, leaseB), "40001", "erp_attachment_object_unconfirmed");
  await f.putObject("erp-attachments", claimed.object_key, a.size_bytes, a.mime_type);
  assert.equal((await finish(a, lease)).attachment.status, "ready");
  assert.equal((await finish(a, lease)).replayed, true);
  assert.equal((await f.rpc("erp_attachment_object", { ...args(doc, a.id), p_write: false })).object_key, claimed.object_key);
  await fails(() => f.rpc("erp_attachment_object", { ...args(doc, b.id), p_write: false }), "40001", "erp_attachment_not_ready");
  await fails(() => f.rpc("erp_attachment_delete", { ...args(doc, b.id), p_command_id: randomUUID() }), "40001", "erp_attachment_not_ready");
  await fails(() => f.rpc("erp_attachment_delete", { ...args(doc, a.id), p_command_id: null }), "22023", "erp_attachment_invalid_action");
  await fails(() => f.rpc("erp_attachment_delete", { ...args(doc, randomUUID()), p_command_id: randomUUID() }), "P0002", "erp_attachment_not_found");
});

test("expired leases permit retries but stale tokens cannot finalize or release the new owner", async () => {
  const doc = await salesOrder(),
    a = (await reserve(doc)).attachment,
    oldLease = randomUUID(),
    nextLease = randomUUID();
  await f.rpc("erp_attachment_claim", { ...args(doc, a.id), p_lease: oldLease });
  await f.db.query("update erp_attachments.attachment set lease_until=clock_timestamp()-interval '1 second' where id=$1", [a.id]);
  await f.sync();
  await f.rpc("erp_attachment_claim", { ...args(doc, a.id), p_lease: nextLease });
  await f.rpc("erp_attachment_stop", { ...args(doc, a.id), p_abort: false, p_lease: oldLease });
  assert.equal(await f.scalar("select lease_token::text v from erp_attachments.attachment where id=$1", [a.id]), nextLease);
  await fails(() => f.rpc("erp_attachment_finish", { ...args(doc, a.id), p_lease: oldLease, p_sha256: a.sha256, p_size_bytes: a.size_bytes }), "40001");
  await f.rpc("erp_attachment_stop", { ...args(doc, a.id), p_abort: false, p_lease: nextLease });
  assert.equal((await f.rpc("erp_attachment_stop", { ...args(doc, a.id), p_abort: true })).attachment.status, "aborted");
  await fails(() => f.rpc("erp_attachment_claim", { ...args(doc, a.id), p_lease: randomUUID() }), "40001");
  await fails(() => f.rpc("erp_attachment_stop", { ...args(doc, a.id), p_abort: null }), "22023", "erp_attachment_invalid_action");
});
