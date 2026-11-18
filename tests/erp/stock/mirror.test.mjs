import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { product, error, seed, readEffects } from "./invoice-fixture.mjs";
let f, p, w;
before(async () => {
  f = await dualFixture();
  p = await product(f);
  w = await f.catalog("warehouses", { name: "Espelho final" });
});
after(() => f?.close());
const call = (name, a = {}) =>
  f.rpc("erp_stock_mirror_" + name, {
    ...(name === "project" ? {} : { p_user_id: f.users.estoque }),
    ...a,
  });
async function source(id, version, payload) {
  await seed(
    f,
    `insert into erp_stock_mirror.source_version(product_source_id,source_version,source_hash,payload,observed_at)values($1,$2,$3,$4,'2026-10-15T12:00:00Z')`,
    [id, version, String(version).padStart(64, "0"), JSON.stringify(payload)],
  );
  await seed(
    f,
    `insert into erp_stock_mirror.pending(product_source_id,source_version,retry_at)values($1,$2,'2026-01-01')`,
    [id, version],
  );
}
test("espelho: leitura vazia, sem vínculo, projetar, repetir e atualização", async () => {
  assert.equal((await call("list")).items.length, 0);
  assert.equal(
    (await call("product_summary", { p_product_ids: [p.id] })).items[0].state,
    "unlinked",
  );
  await source("101", 1, {
    produto: { id: "101", codigo: "A" },
    depositos: [{ id: "1", saldoFisico: "10.125", saldoVirtual: "8" }],
  });
  assert.deepEqual(await call("project"), {
    processed: 1,
    applied: 1,
    failed: 0,
    pending: 0,
  });
  assert.equal((await call("project")).processed, 0);
  const shown = await call("list");
  assert.equal(shown.items[0].physical, "10.125");
  assert.equal(shown.items[0].reserved, "2.125");
  assert.equal((await call("list", { p_query: "%Orig_n%" })).items.length, 1);
  await call("list", { p_state: "pending", p_query: "Origin", p_limit: 1 });
  await source("101", 2, {
    produto: { id: "101" },
    depositos: [{ id: "1", saldoFisico: "-1e-3", saldoVirtual: null }],
  });
  await call("project");
  assert.equal(
    (await call("list", { p_state: "negative" })).items[0].physical,
    "-0.001",
  );
  await source("101", 3, {
    produto: { id: "101" },
    _brufap_source: { deleted: true },
    depositos: [],
  });
  await call("project");
  assert.equal((await call("list")).items.length, 0);
  assert.ok((await call("list", { p_state: "deleted" })).items.length > 0);
  await readEffects(f, p.id);
});
test("espelho: fontes inválidas e limites", async () => {
  await source("bad", 1, { produto: { id: "bad" }, depositos: [] });
  assert.equal((await call("project")).applied, 0);
  await source("102", 1, {
    produto: { id: "103" },
    depositos: [
      { id: "2", saldoFisico: "1.0000000000001", saldoVirtual: "1e24" },
    ],
  });
  await call("project");
  assert.equal(
    (await call("list", { p_warehouse_source_id: "2" })).items[0]
      .physical_state,
    "invalid",
  );
  for (const patch of [
    { p_limit: 0 },
    { p_limit: null },
    { p_after: -1 },
    { p_after: "9007199254740992" },
    { p_query: "x\n" },
    { p_state: "x" },
    { p_warehouse_source_id: "0" },
  ])
    await assert.rejects(
      call("list", patch),
      error("stock_mirror_invalid_query"),
    );
  for (const ids of [
    null,
    [null],
    [p.id, p.id],
    Array.from({ length: 251 }, () => randomUUID()),
  ])
    await assert.rejects(
      call("product_summary", { p_product_ids: ids }),
      error("stock_mirror_invalid_query"),
    );
  await assert.rejects(
    call("product_summary", {
      p_product_ids: [],
      p_warehouse_id: randomUUID(),
    }),
    error("stock_mirror_warehouse_not_found", "P0002"),
  );
  for (const limit of [null, 0, 101])
    await assert.rejects(
      call("project", { p_limit: limit }),
      error("stock_mirror_invalid_limit"),
    );
  for (const role of [
    "admin",
    "consulta",
    "estoque",
    "vendas",
    "financeiro",
    "fiscal",
    "inactive",
  ])
    for (const [name, args] of [
      ["list", {}],
      ["product_summary", { p_product_ids: [p.id], p_warehouse_id: w.id }],
    ])
      try {
        await call(name, { ...args, p_user_id: f.users[role] });
      } catch (e) {
        assert.equal(e.code, "42501");
      }
});

test("espelho: produto vinculado, filtros e mais de um depósito", async () => {
  const linked = await product(f, { name: "Espelho Árvore", code: "ESP-1" });
  await seed(
    f,
    "insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) values('products','201',$1,1,'{}','[]')",
    ["a".repeat(64)],
  );
  await seed(
    f,
    "insert into erp_catalog.origin(entity,source_id,record_id,latest_hash,state) values('products','201',$1,$2,'synced')",
    [linked.id, "a".repeat(64)],
  );
  await source("201", 1, {
    produto: { id: "201" },
    depositos: [{ id: "3", saldoFisico: "5", saldoVirtual: "4" }],
  });
  await call("project");
  assert.equal(
    (await call("product_summary", { p_product_ids: [linked.id] })).items[0]
      .state,
    "observed",
  );
  assert.equal(
    (
      await call("product_summary", {
        p_product_ids: [linked.id],
        p_warehouse_id: w.id,
      })
    ).items[0].state,
    "warehouse_unlinked",
  );
  assert.equal(
    (await call("list", { p_product_id: linked.id, p_query: "árvore" })).items
      .length,
    1,
  );
  await source("201", 2, {
    produto: { id: "201" },
    depositos: [
      { id: "3", saldoFisico: "5", saldoVirtual: "4" },
      { id: "4", saldoFisico: "7", saldoVirtual: "6" },
    ],
  });
  await call("project");
  // position.observation_id é referência identity declarada no harness
  // (registerIdentityRef): o comparador não vê o número, então a junção é
  // conferida aqui, em cada motor, e com o saldo físico de cada depósito.
  const join = `p.product_source_id,p.warehouse_source_id,o.product_source_id op,o.warehouse_source_id ow,o.physical
    FROM erp_stock_mirror%position p JOIN erp_stock_mirror%observation o ON o.id=p.observation_id
    WHERE p.product_source_id='201' ORDER BY p.warehouse_source_id`;
  const pgJoin = (await f.db.query("SELECT " + join.replace(/%/g, "."))).rows;
  const liteJoin = f.lite.prepare("SELECT " + join.replace(/erp_stock_mirror%(\w+)/g, '"erp_stock_mirror__$1"')).all();
  for (const rows of [pgJoin, liteJoin]) {
    assert.deepEqual(rows.map((r) => [r.warehouse_source_id, r.op, r.ow]), [["3", "201", "3"], ["4", "201", "4"]]);
    assert.deepEqual(rows.map((r) => Number(r.physical)), [5, 7]);
  }
  assert.equal(
    (await call("product_summary", { p_product_ids: [linked.id] })).items[0]
      .state,
    "multiple_warehouses",
  );
  const first = await call("list", { p_product_id: linked.id, p_limit: 1 });
  assert.equal(first.has_more, true);
  assert.equal(
    (
      await call("list", {
        p_product_id: linked.id,
        p_limit: 1,
        p_after: first.next_after,
      })
    ).items.length,
    1,
  );
});

test("espelho: identidade da fonte recusa quebra final e instante não finito", async () => {
  for (const [id, stamp] of [
    ["301\n", "2026-10-15T12:00:00Z"],
    ["302", "infinity"],
    ["303", "-infinity"],
  ]) {
    await seed(
      f,
      "insert into erp_stock_mirror.source_version(product_source_id,source_version,source_hash,payload,observed_at) values($1,1,$2,$3,$4::timestamptz)",
      [
        id,
        "a".repeat(64),
        JSON.stringify({
          produto: { id },
          depositos: [{ id: "1", saldoFisico: "2" }],
        }),
        stamp,
      ],
    );
    await seed(
      f,
      "insert into erp_stock_mirror.pending(product_source_id,source_version,retry_at) values($1,1,'2026-01-01')",
      [id],
    );
    assert.deepEqual(await call("project"), {
      processed: 1,
      applied: 0,
      failed: 0,
      pending: 0,
    });
    assert.equal(
      await f.scalar(
        "select code from erp_stock_mirror.issue where product_source_id=$1",
        [id],
      ),
      "SOURCE_IDENTITY_INVALID",
    );
    assert.equal(
      await f.scalar(
        "select count(*) from erp_stock_mirror.observation where product_source_id=$1",
        [id],
      ),
      0,
    );
  }
});

test("espelho: depósito e quantidade não aceitam quebra de linha final", async () => {
  await source("304", 1, {
    produto: { id: "304" },
    depositos: [{ id: "1\n", saldoFisico: "2" }],
  });
  await call("project");
  const invalid = (await call("list")).items.find(
    (x) => x.product_source_id === "304",
  );
  assert.equal(invalid.physical_state, "invalid");
  assert.ok(invalid.issues.includes("WAREHOUSE_LIST_INVALID"));
  await source("305", 1, {
    produto: { id: "305" },
    depositos: [{ id: "1", saldoFisico: "2\n", saldoVirtual: "1" }],
  });
  await call("project");
  assert.equal(
    (await call("list")).items.find((x) => x.product_source_id === "305")
      .physical_state,
    "invalid",
  );
});

test("espelho: versão no limite seguro e replay da versão aplicada", async () => {
  const version = "9007199254740991";
  await source("306", version, {
    produto: { id: "306" },
    depositos: [{ id: "1", saldoFisico: "2" }],
  });
  assert.deepEqual(await call("project"), {
    processed: 1,
    applied: 1,
    failed: 0,
    pending: 0,
  });
  await seed(
    f,
    "insert into erp_stock_mirror.pending(product_source_id,source_version,retry_at) values('306',$1,'2026-01-01')",
    [version],
  );
  assert.deepEqual(await call("project"), {
    processed: 1,
    applied: 0,
    failed: 0,
    pending: 0,
  });
  assert.equal(
    await f.scalar(
      "select count(*) from erp_stock_mirror.observation where product_source_id='306'",
    ),
    1,
  );
});

test("espelho: carimbo não finito do staging conserva o instante da observação", async () => {
  await source("307", 1, {
    produto: { id: "307" },
    depositos: [{ id: "1", saldoFisico: "2" }],
  });
  await call("project");
  await seed(
    f,
    "insert into origin_sync.resource_state(resource) values('stock_balances') on conflict do nothing",
  );
  await seed(
    f,
    "insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,version,last_seen_at) values('stock_balances','stock_balances','307','{}',$1,1,'infinity')",
    ["1".padStart(64, "0")],
  );
  for (const stamp of ["infinity", "-infinity"]) {
    await seed(
      f,
      "update origin_sync.raw_record set last_seen_at=$1::timestamptz where entity='stock_balances' and source_id='307'",
      [stamp],
    );
    const row = (await call("list")).items.find(
      (x) => x.product_source_id === "307",
    );
    assert.equal(row.observed_at, "2026-10-15T12:00:00+00:00");
  }
});
