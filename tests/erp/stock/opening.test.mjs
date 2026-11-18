// Abertura: leituras, classificação da Origem e adoção contra o oráculo local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stockObservationId } from "../../../src/erp/domains/sync/public.ts";
import { dualFixture } from "../harness/dual-fixture.mjs";
let f, u, wh, command;
const code = p => p.then(() => "ok", e => e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message);
before(async () => {
  f = await dualFixture(); u = f.users;
  wh = (await f.catalog("warehouses", { name: "Depósito abertura" })).id;
});
after(() => f?.close());
test("depósitos vinculados: vazio, fonte higienizada e papéis", async () => {
  const list = user => f.rpc("erp_stock_opening_warehouses", { p_user_id: user });
  assert.equal((await list(u.admin)).items.length, 0);
  for (const role of ["estoque", "consulta", "vendas", "inactive"]) assert.match(await code(list(u[role])), /^42501:stock_opening_access_denied/);
  await f.db.query(`insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)
    values('123',$1::uuid,(select command_id from erp_catalog.command where result#>>'{record,id}'=$1::text limit 1),repeat('a',64),1,now(),'{}',$2::jsonb,'{}')`,
    [wh, JSON.stringify({ name: "  Origem\nDepósito\t " })]);
  await f.sync();
  const r = await list(u.admin); assert.equal(r.items[0].source_name, "Origem Depósito");
  assert.equal(r.items[0].warehouse_id, wh);
});
test("consulta de comando: recibo, estado atual, repetição e acesso", async () => {
  command = randomUUID();
  const get = (patch = {}) => f.rpc("erp_stock_opening_command", { p_user_id: u.admin, p_command_id: command, ...patch });
  assert.match(await code(get({ p_command_id: null })), /^22023:stock_opening_query_invalid/);
  assert.match(await code(get()), /^P0002:stock_opening_command_not_found/);
  for (const role of ["estoque", "consulta", "vendas", "inactive"]) assert.match(await code(get({ p_user_id: u[role] })), /^42501:stock_opening_access_denied/);
  await f.db.query(`insert into erp_stock.opening_command(id,actor,request_hash,warehouse_source_id,occurred_on,preview_hash,result)
    values($1,$2,repeat('b',64),'123','2026-01-01',repeat('c',64),'{"scope":"stock_opening_command","receipt":{"items":[]}}')`, [command, u.admin]);
  await f.sync();
  const product = (await f.catalog("products", { name: "Produto zero", kind: "P", unit: "UN" })).id;
  await f.db.query(`insert into erp_stock.opening_receipt(product_id,warehouse_id,warehouse_source_id,product_source_id,command_id,outcome,target,
    previous_quantity,adjustment,unit,source_hash,source_version,source_seen_at,occurred_on,actor)
    values($1,$2,'123','456',$3,'adopted_zero',0,0,0,'UN',repeat('d',64),1,now(),'2026-01-01',$4)`, [product, wh, command, u.admin]);
  await f.sync();
  const r = await get(); assert.equal(r.replayed, true); assert.equal(r.current[0].state, "adopted_zero");
  assert.deepEqual(await get(), r);
  await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: product });
});

const day = "2026-01-01";
const page = (patch = {}) => f.rpc("erp_stock_opening_page", { p_user_id: u.admin, p_warehouse_source_id: "123", ...patch });
const batch = (patch = {}) => f.rpc("erp_stock_opening_batch", { p_user_id: u.admin, p_warehouse_source_id: "123", p_occurred_on: day, ...patch });
const core = row => ({ product_source_id: row.product_source_id, product_id: row.product.id, unit: row.product.unit,
  source_hash: row.source.source_hash, source_version: row.source.source_version, target: row.target });
const applyArgs = b => ({ p_user_id: u.admin, p_warehouse_source_id: "123", p_occurred_on: day, p_items: b.items.map(core),
  p_preview_hash: b.preview_hash, p_command_id: randomUUID(), p_confirmed: true });
const apply = args => f.rpc("erp_stock_opening_apply", args);
async function raw(entity, id, payload, badHash = false) {
  await f.db.query(`insert into origin_sync.resource_state(resource) values($1) on conflict do nothing`, [entity]);
  await f.db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)
    values($1,$1,$2,$3::jsonb,case when $4 then repeat('f',64) else encode(sha256(convert_to(jsonb_build_object('payload',$3::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex') end)
    on conflict(entity,source_id) do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1`,
  [entity, id, JSON.stringify(payload), badHash]);
}
async function seed(id, physical, { payload, missing = false, native = true, product = {}, badHash = false } = {}) {
  const { active, ...data } = product;
  const p = native ? await f.catalog("products", { name: `Abertura ${id}`, code: `AB${id}`, kind: "P", unit: "UN", ...data }) : null;
  if (p) {
    if (active === false) await f.db.query("update erp_catalog.record set active=false where id=$1", [p.id]);
    await f.db.query(`insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)
      values('products',$1,repeat('a',64),1,'{}','[]')`, [id]);
    await f.db.query(`insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)
      values('products',$1,$2,repeat('a',64),repeat('a',64),'synced')`, [id, p.id]);
  }
  await raw("products", id, { id, nome: ` Fonte\n${id} `, codigo: ` OR${id} ` });
  if (!missing) await raw("stock_balances", id, payload ?? { produto: { id, codigo: ` OBS${id} ` }, depositos: [{ id: "123", saldoFisico: physical }] }, badHash);
  await f.sync();
  return p;
}

test("stock_observation_id: limite numérico, zeros, texto exato e tipos recusados", async () => {
  for (const v of [null, true, {}, [], "", "0", "000", "001", "9".repeat(40), "9".repeat(41), " 1", "1\n", "1\r", "1.0", -1, 0, 1.25, 1, 9007199254740991, 9007199254740992]) {
    const expected = await f.scalar("select erp_cutover.stock_observation_id($1::jsonb) v", [JSON.stringify(v)]);
    assert.equal(stockObservationId(v), expected, JSON.stringify(v));
  }
});

test("page e batch: entradas inválidas, datas, depósito ausente e acesso só admin", async () => {
  for (const p of [{ p_limit: null }, { p_limit: 0 }, { p_limit: 51 }, { p_after: "00" }, { p_after: " 1" }, { p_after: "1\n" }, { p_group: "missing" },
    { p_warehouse_source_id: null }, { p_warehouse_source_id: "0" }]) assert.match(await code(page(p)), /^22023:stock_opening_query_invalid/);
  assert.match(await code(page({ p_warehouse_source_id: "9999999" })), /^P0002:stock_opening_warehouse_not_found/);
  for (const p of [{ p_limit: 0 }, { p_limit: 101 }, { p_limit: null }]) assert.match(await code(batch(p)), /^22023:stock_opening_query_invalid/);
  for (const d of [null, "1899-12-31", "9999-01-01"]) assert.match(await code(batch({ p_occurred_on: d })), /^22023:stock_opening_date_invalid/);
  for (const role of ["estoque", "consulta", "vendas", "fiscal", "inactive"]) {
    assert.match(await code(page({ p_user_id: u[role] })), /^42501:stock_opening_access_denied/);
    assert.match(await code(batch({ p_user_id: u[role] })), /^42501:stock_opening_access_denied/);
    assert.match(await code(apply({ ...applyArgs({ items: [], preview_hash: null }), p_user_id: u[role] })), /^42501:stock_opening_access_denied/);
  }
  assert.equal((await batch()).preview_hash, null);
});

test("observação missing/invalid/available, motivos, contagens e paginação C", async () => {
  await seed("10", 3.125);
  await seed("2", 0);
  await seed("30", -2);
  await seed("31", null, { missing: true });
  await seed("32", 4, { badHash: true });
  await seed("33", 4, { native: false });
  const cases = [
    ["34", { produto: { id: "34" } }, "WAREHOUSE_LIST_MISSING"],
    ["35", { produto: { id: "35" }, depositos: [] }, "WAREHOUSE_ABSENT"],
    ["36", { produto: { id: "36" }, depositos: [{ id: "123" }, { id: 123 }] }, "WAREHOUSE_LIST_INVALID"],
    ["37", { produto: { id: "37" }, depositos: [{ id: "0" }] }, "WAREHOUSE_LIST_INVALID"],
    ["38", { produto: { id: "38" }, depositos: [{ id: "123", saldoFisico: "2" }] }, "PHYSICAL_INVALID"],
    ["39", { produto: { id: "39" }, depositos: [{ id: "123", saldoFisico: null }] }, "PHYSICAL_NULL"],
    ["40", { produto: { id: "40" }, depositos: [{ id: "123" }] }, "PHYSICAL_ABSENT"],
    ["41", { produto: { id: "41" }, depositos: [{ id: "123", saldoFisico: 0.0000001 }] }, "PHYSICAL_PRECISION"],
    ["42", { produto: { id: "42" }, depositos: [{ id: "123", saldoFisico: 1000000000000 }] }, "PHYSICAL_RANGE"],
    ["43", { produto: { id: "different" }, depositos: [] }, "SOURCE_INVALID"],
    ["44", { produto: { id: "44" }, depositos: {} }, "WAREHOUSE_LIST_INVALID"],
  ];
  for (const [id, payload] of cases) await seed(id, null, { payload });
  await seed("45", 1, { product: { active: false } });
  await seed("46", 1, { product: { kind: "S" } });
  const r = await page({ p_limit: 50 }), byId = Object.fromEntries(r.items.map(x => [x.product_source_id, x]));
  assert.equal(byId["10"].status, "positive"); assert.equal(byId["10"].target, "3.125000");
  assert.equal(byId["10"].source.name, "Fonte 10"); assert.equal(byId["10"].source.code, "OBS10");
  assert.equal(byId["2"].status, "zero"); assert.equal(byId["30"].status, "negative_blocked");
  assert.equal(byId["31"].reason, "OBSERVATION_MISSING"); assert.equal(byId["32"].reason, "SOURCE_INVALID");
  assert.equal(byId["33"].reason, "NATIVE_PRODUCT_MISSING");
  for (const [id, , reason] of cases) assert.equal(byId[id].reason, reason, id);
  for (const id of ["45", "46"]) assert.equal(byId[id].reason, "PRODUCT_UNAVAILABLE");
  // As etiquetas da consulta Origin correspondem às mesmas fontes classificadas pela abertura.
  for (const [id, state] of [["31", "missing"], ["32", "invalid"], ["10", "available"]])
    assert.equal(await f.scalar("select erp_cutover.stock_observation_row($1,'123')#>>'{observation,state}'", [id]), state);
  assert.equal(r.counts.total, 19); assert.equal(r.counts.pending, 2); assert.equal(r.counts.negative_blocked, 1);
  const first = await page({ p_limit: 1 }); assert.equal(first.items[0].product_source_id, "10");
  assert.equal(first.next_cursor, "10"); assert.equal(first.has_more, true);
  const next = await page({ p_limit: 1, p_after: first.next_cursor }); assert.equal(next.items[0].product_source_id, "2");
  const invalid = await page({ p_group: "invalid", p_limit: 50 }); assert.equal(invalid.items.length, r.counts.invalid);
  assert.deepEqual(invalid.counts, r.counts);
  assert.equal((await batch({ p_limit: 1 })).pending, 2);
});

test("apply: validação completa, hash da prévia, adoção positiva/zero e idempotência", async () => {
  const b = await batch(), args = applyArgs(b);
  assert.deepEqual(b.items.map(r => r.product_source_id), ["10", "2"]);
  for (const p of [{ p_command_id: null }, { p_confirmed: false }, { p_preview_hash: null }, { p_preview_hash: "bad" },
    { p_preview_hash: args.p_preview_hash + "\n" }, { p_warehouse_source_id: "0" }])
    assert.match(await code(apply({ ...args, ...p })), /^22023:stock_opening_input_invalid/);
  for (const items of [null, {}, [], [null], [1], [...args.p_items, args.p_items[0]], [{ ...args.p_items[0], unknown: true }],
    [{ ...args.p_items[0], unit: "" }], [{ ...args.p_items[0], unit: "U".repeat(65) }], [{ ...args.p_items[0], product_id: "invalid" }],
    [{ ...args.p_items[0], product_source_id: "000" }], [{ ...args.p_items[0], source_hash: "x" }], [{ ...args.p_items[0], source_version: "0" }],
    [{ ...args.p_items[0], target: "1.0" }], [{ ...args.p_items[0], target: "-0.000000" }],
    [{ ...args.p_items[0], source_hash: args.p_items[0].source_hash + "\n" }], [{ ...args.p_items[0], target: "1.000000\n" }]])
    assert.match(await code(apply({ ...args, p_items: items })), /^22023:stock_opening_items_invalid/);
  assert.match(await code(apply({ ...args, p_preview_hash: "a".repeat(64) })), /^40001:stock_opening_preview_conflict/);
  assert.match(await code(apply({ ...args, p_occurred_on: "1899-01-01" })), /^22023:stock_opening_date_invalid/);
  const r = await apply(args);
  assert.equal(r.replayed, false); assert.deepEqual(r.receipt.summary, { adopted: 1, adopted_zero: 1, skipped: 0 });
  assert.equal(r.current[0].state, "adopted"); assert.equal(r.current[1].state, "adopted_zero");
  assert.equal(r.current[0].adjustment, "3.125000"); assert.equal(r.current[1].movement_id, null);
  const count = await f.scalar("select count(*) from erp_stock.entry where product_id=$1", [b.items[0].product.id]);
  const repeated = await apply(args); assert.equal(repeated.replayed, true); assert.deepEqual(repeated.receipt, r.receipt);
  assert.equal(await f.scalar("select count(*) from erp_stock.entry where product_id=$1", [b.items[0].product.id]), count);
  assert.deepEqual((await f.rpc("erp_stock_opening_command", { p_user_id: u.admin, p_command_id: args.p_command_id })).receipt, r.receipt);
  assert.match(await code(apply({ ...args, p_occurred_on: "2026-01-02" })), /^40001:stock_opening_command_conflict/);
  const skipped = await apply({ ...args, p_command_id: randomUUID() }); assert.equal(skipped.receipt.summary.skipped, 2);
  assert.ok(skipped.receipt.items.every(x => x.reason === "ALREADY_ADOPTED"));
  assert.equal((await page({ p_group: "adopted" })).items.length, 2);
  assert.equal((await batch()).preview_hash, null);
});

test("prévia antiga: fonte, unidade e movimentos nativos mudados são recusados por item", async () => {
  const p60 = await seed("60", 1), p61 = await seed("61", 2), p62 = await seed("62", 3);
  const args = applyArgs(await batch());
  await raw("stock_balances", "60", { produto: { id: "60" }, depositos: [{ id: "123", saldoFisico: 4 }] });
  await f.db.query("update erp_catalog.product set unit='KG' where record_id=$1", [p61.id]);
  await f.sync();
  await f.rpc("erp_stock_post", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: day,
    p_reason: "Movimento após prévia", p_items: [{ product_id: p62.id, warehouse_id: wh, quantity: "1", expected_version: 0 }] });
  const r = await apply(args);
  assert.deepEqual(r.receipt.items.map(x => x.reason), ["SOURCE_CHANGED", "UNIT_CHANGED", "NATIVE_MOVEMENTS"]);
  assert.deepEqual(r.receipt.summary, { adopted: 0, adopted_zero: 0, skipped: 3 });
  assert.equal(r.current.length, 0);
  assert.equal((await page({ p_group: "native_movements" })).items[0].product.id, p62.id);
  assert.equal((await apply(applyArgs(await batch()))).receipt.summary.adopted, 2);
  assert.equal((await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: p60.id })).items.length > 0, true);
});

test("política negativa relida na aplicação e depósito inativo", async () => {
  const policy = async (allow, version) => f.rpc("erp_stock_policy_set", { p_user_id: u.admin, p_command_id: randomUUID(),
    p_expected_version: version, p_allow_negative: allow, p_reason: "Política da abertura", p_confirmed: true });
  await policy(true, 0);
  const b = await batch(); assert.equal(b.items[0].status, "negative");
  const args = applyArgs(b);
  await policy(false, 1);
  assert.equal((await apply(args)).receipt.items[0].reason, "NEGATIVE_NOT_ALLOWED");
  await policy(true, 2);
  await f.db.query("update erp_catalog.record set active=false where id=$1", [wh]); await f.sync();
  const next = applyArgs(await batch());
  assert.match(await code(apply(next)), /^22023:stock_opening_warehouse_unavailable/);
  await f.db.query("update erp_catalog.record set active=true where id=$1", [wh]); await f.sync();
  const r = await apply(next); assert.equal(r.receipt.summary.adopted, 1); assert.equal(r.current[0].target, "-2.000000");
});

test("conflito no comando derivado reverte o lote inteiro", async () => {
  await seed("70", 2); const p = await seed("71", 3);
  const args = applyArgs(await batch());
  const { createHash } = await import("node:crypto");
  const h = createHash("md5").update(`${args.p_command_id}:${p.id}:${wh}`).digest("hex");
  const derived = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const unrelated = await f.catalog("products", { name: "Comando já usado", kind: "P", unit: "UN" });
  await f.rpc("erp_stock_post", { p_user_id: u.admin, p_command_id: derived, p_kind: "receipt", p_occurred_on: day,
    p_reason: "Ocupar comando", p_items: [{ product_id: unrelated.id, warehouse_id: wh, quantity: "1", expected_version: 0 }] });
  assert.match(await code(apply(args)), /^40001:stock_opening_command_conflict/);
  assert.equal(await f.scalar("select count(*) from erp_stock.opening_receipt where command_id=$1", [args.p_command_id]), 0);
  assert.equal(await f.scalar("select count(*) from erp_stock.entry where product_id=$1", [args.p_items[0].product_id]), 0);
  assert.equal((await apply({ ...args, p_command_id: randomUUID() })).receipt.summary.adopted, 2);
});

test("fonte com instante não finito é invalid, preservando o carimbo exibido", async () => {
  await seed("90", 1);
  for (const stamp of ["infinity", "-infinity"]) {
    await f.db.query("update origin_sync.raw_record set last_seen_at=$1::timestamptz where entity='stock_balances' and source_id='90'", [stamp]);
    await f.sync();
    const r = (await page({ p_after: "89" })).items[0];
    assert.equal(r.reason, "SOURCE_INVALID"); assert.equal(r.source.last_seen_at, stamp);
  }
});

test("JSON da fonte conserva escala e dígitos no hash e na validação de IDs", async () => {
  const { openingSource } = await import("../../../src/erp/domains/stock/rpc/opening-source.ts");
  for (const raw of ['{"produto":{"id":1.0},"n":999999999999.999999}', '{"n":1e-7,"id":9007199254740992}',
    '{"n":-0.000000,"id":9007199254740991}', '{"n":1.2300e2,"id":"001"}', '{"z":[],"á":{},"a":"x\\n"}']) {
    const parsed = openingSource(raw);
    assert.equal(parsed.canonical(), await f.scalar("select $1::jsonb::text", [raw]));
    for (const key of ["id", "n"]) assert.equal(parsed.id(parsed.field(parsed.root, key)),
      await f.scalar("select erp_cutover.stock_observation_id($1::jsonb->$2)", [raw, key]));
  }
});
