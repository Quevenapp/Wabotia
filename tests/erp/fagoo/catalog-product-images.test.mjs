// Imagens do produto (migração 202610200193) na fixture dupla: os RPCs que
// não tocam o storage (images, order, delete, stop).
// Adaptado de workers/erp-api/test/produtos-d-images-sql.test.mjs:
// - o original passa pelo Worker do Fagoo com um Storage em memória; reserve,
//   claim, object e finish (storage_ready e storage.objects) esperam a
//   decisão da N sobre o storage no motor (R2) e ficam fora por enquanto;
// - por isso as imagens prontas e reservadas são semeadas por SQL direto no
//   Postgres (f.write) e copiadas; as asserções de ordem, exclusão, trilha,
//   recusas e versão do produto são as do original;
// - fora, declarado: o subteste "193 routes, grants and the private tables"
//   (rotas da erp-api e GRANT/SECURITY DEFINER do Postgres).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fails, productsFixture } from "./catalog-products-fixture.mjs";

let f, product, other;
const sha = (text) => createHash("sha256").update(text).digest("hex");
before(async () => {
  f = await productsFixture();
  product = await f.product({ name: "Cadeira com fotos" });
  other = await f.product({ name: "Outro produto" });
});
after(() => f?.close());

/** Imagem semeada no Postgres: pronta na posição dada, ou reservada (com ou sem posse). */
async function seed(productId, { status = "ready", position = null, lease = null, leaseSeconds = 120, name = "frente", bytes = 70 } = {}) {
  const id = await f.write(
    `insert into erp_catalog.product_stored_image(product_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,position,
       finished_by,finished_at,lease_token,lease_actor,lease_until)
     values($1,$2,$3,$4,$5,'image/png',$6,$7,$8,$9,
       case when $8='ready' then $3::uuid end, case when $8='ready' then clock_timestamp() end,
       $10::uuid, case when $10::uuid is not null then $3::uuid end, case when $10::uuid is not null then clock_timestamp()+make_interval(secs=>$11) end)
     returning id v`,
    [productId, randomUUID(), f.users.admin, sha(randomUUID()), `anexo-${name}.png`, bytes, sha(name + randomUUID()), status, position, lease, leaseSeconds],
  );
  return id;
}
const images = (id = product.id, user = f.users.admin) => f.rpc("erp_catalog_product_images", { p_user_id: user, p_product_id: id });
const order = (ids, { command = randomUUID(), user = f.users.admin, id = product.id } = {}) =>
  f.rpc("erp_catalog_product_image_order", { p_user_id: user, p_product_id: id, p_command_id: command, p_ids: ids });
const remove = (image, { command = randomUUID(), user = f.users.admin, id = product.id } = {}) =>
  f.rpc("erp_catalog_product_image_delete", { p_user_id: user, p_product_id: id, p_id: image, p_command_id: command });
const stop = (image, abort, { lease = null, user = f.users.admin, id = product.id } = {}) =>
  f.rpc("erp_catalog_product_image_stop", { p_user_id: user, p_product_id: id, p_id: image, p_abort: abort, p_lease: lease });

test("193 list in order, reorder, deletion and their replays", async () => {
  const first = await seed(product.id, { position: 1, name: "frente", bytes: 70 });
  const second = await seed(product.id, { position: 2, name: "lado", bytes: 18 });
  const third = await seed(product.id, { position: 3, name: "costas", bytes: 5 });
  const listed = await images(product.id, f.users.consulta);
  assert.deepEqual([listed.items.map((item) => item.id), listed.stored_bytes, listed.limit], [[first, second, third], "93", 20]);
  // Order: every ready image once; the same command replays; a stale list is refused.
  const command = randomUUID();
  const ordered = await order([third, first, second], { command });
  assert.deepEqual([ordered.items.map((item) => [item.id, item.position]), ordered.replayed], [[[third, 1], [first, 2], [second, 3]], false]);
  assert.equal((await order([third, first, second], { command })).replayed, true);
  await fails(assert, order([first]), "40001");
  await fails(assert, order([first, second, third], { command }), "40001");
  await fails(assert, order([second, first, third], { user: f.users.vendas }), "42501");
  for (const ids of [[], [first, first, second], Array.from({ length: 21 }, () => randomUUID())]) await fails(assert, order(ids), "22023");
  // Deletion: logical, audited, replayed; the next images move up.
  const removal = randomUUID();
  const deleted = await remove(first, { command: removal });
  assert.deepEqual([deleted.image.deleted, deleted.image.position, deleted.replayed], [true, null, false]);
  assert.equal((await remove(first, { command: removal })).replayed, true);
  await fails(assert, remove(first, { command: removal, user: f.users.estoque }), "40001");
  await fails(assert, remove(second, { command }), "40001");
  await fails(assert, remove(first), "40001");
  assert.deepEqual((await images()).items.map((item) => [item.id, item.position]), [[third, 1], [second, 2]]);
  await fails(assert, remove(third, { id: other.id }), "P0002");
  assert.deepEqual(
    (await f.rows("select action from erp_catalog.product_image_audit where product_id=$1 order by id", [product.id])).map((row) => row.action),
    ["order", "delete"],
  );
  assert.equal(await f.scalar("select version v from erp_catalog.record where id=$1", [product.id]), product.version, "images do not change the product version");
  // Order again after the deletion, then delete the first one: two positions move.
  await order([second, third]);
  await remove(second);
  assert.deepEqual((await images()).items.map((item) => [item.id, item.position]), [[third, 1]]);
});

test("diferencial aleatório: ordem, exclusão, desistência e listagem", async () => {
  let s = 20261116;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const products = [];
  const pool = new Map(); // produto → imagens semeadas
  for (let p = 0; p < 4; p++) {
    const id = (await f.product({ name: `Diferencial ${p}` })).id;
    products.push(id);
    const ids = [];
    let position = 0;
    for (let i = 0; i < 2 + Math.floor(r() * 6); i++) {
      const status = pick(["ready", "ready", "ready", "reserved"]);
      ids.push(await seed(id, { status, position: status === "ready" ? ++position : null, lease: status === "reserved" && r() < 0.5 ? randomUUID() : null, bytes: 1 + Math.floor(r() * 2000) }));
    }
    pool.set(id, ids);
  }
  const commands = [randomUUID(), randomUUID(), randomUUID()];
  let ok = 0;
  for (let i = 0; i < 150; i++) {
    const id = pick(products);
    const ids = pool.get(id);
    const user = pick([f.users.admin, f.users.admin, f.users.estoque, f.users.vendas]);
    const command = r() < 0.2 ? pick(commands) : randomUUID();
    const op = pick(["order", "order", "delete", "stop", "images"]);
    try {
      if (op === "order") {
        const ready = (await f.rows("select id from erp_catalog.product_stored_image where product_id=$1 and position is not null", [id])).map((x) => x.id);
        const list = r() < 0.8 ? [...ready].sort(() => r() - 0.5) : ids.filter(() => r() < 0.5);
        if (list.length) await order(list, { id, user, command });
      } else if (op === "delete") await remove(pick(ids), { id: r() < 0.9 ? id : pick(products), user, command });
      else if (op === "stop") await stop(pick(ids), pick([true, false, null]), { id, user, lease: r() < 0.3 ? randomUUID() : null });
      else await images(id, pick([user, f.users.consulta, f.users.financeiro]));
      ok++;
    } catch (e) {
      if (!e.code || e.code === "ERR_ASSERTION") throw e;
    }
  }
  assert.ok(ok > 40, `poucas chamadas com sucesso: ${ok}`);
});

test("193 abort and lease release; refusals: permissions, deleted products and unknown products", async () => {
  const fresh = await f.product({ name: "Mesa" });
  const lease = randomUUID();
  const held = await seed(fresh.id, { status: "reserved", lease });
  const free = await seed(fresh.id, { status: "reserved" });
  const expired = await seed(fresh.id, { status: "reserved", lease: randomUUID(), leaseSeconds: -60 });
  const listed = await images(fresh.id);
  assert.deepEqual([listed.items, listed.pending.map((p) => p.id).sort()], [[], [held, free, expired].sort()]);
  await fails(assert, stop(held, true, { id: fresh.id }), "40001");
  assert.equal((await stop(held, false, { id: fresh.id, lease: randomUUID() })).image.status, "reserved", "another lease keeps it");
  await stop(held, false, { id: fresh.id, lease });
  assert.equal(await f.scalar("select lease_token v from erp_catalog.product_stored_image where id=$1", [held]), null);
  assert.equal((await stop(held, true, { id: fresh.id })).image.status, "aborted");
  assert.equal((await stop(held, true, { id: fresh.id })).image.status, "aborted", "aborting twice is quiet");
  assert.equal((await stop(expired, true, { id: fresh.id })).image.status, "aborted", "an expired lease does not hold the reservation");
  await fails(assert, stop(free, null, { id: fresh.id }), "22023");
  await fails(assert, stop(free, true, { id: fresh.id, user: f.users.vendas }), "42501");
  const ready = await seed(fresh.id, { position: 1 });
  await fails(assert, stop(ready, true, { id: fresh.id }), "40001");
  const gone = await f.product({ name: "Excluído" });
  const goneImage = await seed(gone.id, { position: 1 });
  await f.setDeleted(gone.id, gone.version, true);
  await fails(assert, remove(goneImage, { id: gone.id }), "40001");
  assert.equal((await images(gone.id)).items.length, 1, "but its images are still listed");
  await fails(assert, images(randomUUID()), "P0002");
  await fails(assert, images(fresh.id, f.users.financeiro), "42501");
  await fails(assert, stop(randomUUID(), true, { id: fresh.id }), "P0002");
});
