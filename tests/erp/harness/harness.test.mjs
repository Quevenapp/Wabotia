// Testes do próprio harness do diferencial: as divergências plantadas têm de
// ser acusadas, e os casos legítimos (id gerado que não volta na resposta,
// id derivado, semeadura com uuid aleatório, coluna __fold) têm de passar.
//   node --test tests/erp/harness/harness.test.mjs
// Duas camadas: o comparador puro (compareState, dados sintéticos nas
// colunas reais) e a fixture dupla de ponta a ponta (Postgres e SQLite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { oracleDb } from "../../../scripts/erp/oracle-db.mjs";
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";
import { fold } from "../../../src/erp/domains/catalog/internal.ts";
import { derivedIds, registerDerivedId, registerNewIdOrder } from "./derived-ids.mjs";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { dualFixture } from "./dual-fixture.mjs";
import { pgIdentity } from "./identity.mjs";
import { freshLite } from "./node-driver.mjs";
import { SEED_LEAVES_NORMALIZED_NULL, applyDeviationsBoth, seedDifferences, withoutTriggers } from "./seed-align.mjs";
import { IdMap, compareState, diffValues } from "./state-compare.mjs";

const U = () => randomUUID();
const row = (table, values) => ({ ...Object.fromEntries(Object.keys(ERP_TABLES[table].columns).map((n) => [n, null])), ...values });
const compare = (data, known = []) => {
  const ids = new IdMap(new Set(known));
  return { diffs: compareState(data, ids).diffs, ids };
};
// IdMap da resposta do RPC que declara a ordem dos borderos.
const bIds = () => Object.assign(new IdMap(new Set(KNOWN)), { rpc: "erp_finance_bordero_execute" });
const equal = (data, known) => assert.deepEqual(compare(data, known).diffs, []);
const differs = (data, known) => assert.notDeepEqual(compare(data, known).diffs, [], "a divergência plantada não foi acusada");

// Ids que existiam antes da chamada (conta, títulos, ator, comando).
const A = U(),
  A2 = U(),
  T = U(),
  ACTOR = U(),
  CMD = U();
const KNOWN = [A, A2, T, ACTOR, CMD];
const mov = (id, v = {}) =>
  row("erp_finance__movement", {
    id, account_id: A, kind: "opening", delta_cents: "150000", posted_on: "2026-11-16", actor: ACTOR, command_id: CMD, created_at: "1", ...v,
  });
const set = (id, v = {}) =>
  row("erp_finance__settlement", {
    id, title_id: T, account_id: A, kind: "payment", posted_on: "2026-11-16", principal_cents: "1000", interest_cents: "0",
    penalty_cents: "0", discount_cents: "0", fee_cents: "0", net_cash_cents: "1000", actor: ACTOR, command_id: CMD, created_at: "1", ...v,
  });
const bor = (id) =>
  row("erp_finance__bordero", { id, kind: "payable", posted_on: "2026-11-16", account_id: A, grouped: 1, version: "1", actor: ACTOR, command_id: CMD, created_at: "1" });
const item = (settlement_id, bordero_id) => row("erp_finance__bordero_item", { settlement_id, bordero_id });

// ---------------------------------------------------------------------------
// Item 1: linhas novas cujo id não volta na resposta

test("item 1: liga o id de linha nova que não vem na resposta (saldo inicial do account_create)", () => {
  const p = U(),
    l = U();
  const { diffs, ids } = compare({ erp_finance__movement: { pg: [mov(p)], lite: [mov(l)] } }, KNOWN);
  assert.deepEqual(diffs, []);
  assert.equal(ids.map(l), p);
});

test("item 1: linha a mais e linha a menos", () => {
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [mov(U()), mov(U(), { kind: "adjustment" })] } }, KNOWN);
  differs({ erp_finance__movement: { pg: [mov(U()), mov(U(), { delta_cents: "5" })], lite: [mov(U())] } }, KNOWN);
  // O motor não grava a linha.
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [] } }, KNOWN);
});

test("item 1: valor diferente numa linha cujo id não vem na resposta", () => {
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [mov(U(), { delta_cents: "150001" })] } }, KNOWN);
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [mov(U(), { note: "x" })] } }, KNOWN);
  // A linha nova casa certo, mas uma linha que já existia (sem id livre)
  // foi alterada diferente na mesma chamada.
  const S = U();
  differs(
    {
      erp_finance__movement: { pg: [mov(U())], lite: [mov(U())] },
      erp_finance__settlement: { pg: [set(S, { note: "baixa" })], lite: [set(S, { note: "baixa errada" })] },
    },
    [...KNOWN, S],
  );
});

test("item 1: grupo de linhas iguais a menos do id: multiconjunto", () => {
  const ps = [U(), U(), U()],
    ls = [U(), U(), U()];
  equal({ erp_finance__movement: { pg: ps.map((i) => mov(i)), lite: ls.map((i) => mov(i)) } }, KNOWN);
  differs({ erp_finance__movement: { pg: ps.map((i) => mov(i)), lite: ls.slice(0, 2).map((i) => mov(i)) } }, KNOWN);
});

test("item 1: FK de outra tabela desfaz o empate; FK para a linha errada do grupo é acusada", () => {
  const [p1, p2, l1, l2] = [U(), U(), U(), U()];
  const [pm1, pm2, lm1, lm2] = [U(), U(), U(), U()];
  const pg = { erp_finance__settlement: [set(p1), set(p2)], erp_finance__movement: [mov(pm1, { settlement_id: p1, delta_cents: "5" }), mov(pm2, { settlement_id: p2, delta_cents: "7" })] };
  const ok = { erp_finance__settlement: [set(l1), set(l2)], erp_finance__movement: [mov(lm1, { settlement_id: l1, delta_cents: "5" }), mov(lm2, { settlement_id: l2, delta_cents: "7" })] };
  const both = (lite) => Object.fromEntries(Object.keys(pg).map((t) => [t, { pg: pg[t], lite: lite[t] }]));
  const { diffs, ids } = compare(both(ok), KNOWN);
  assert.deepEqual(diffs, []);
  assert.equal(ids.map(l1), p1, "a liquidação do movimento de 5 é a mesma nos dois");
  assert.equal(ids.map(l2), p2);
  // Os dois movimentos apontam para a mesma liquidação do grupo.
  differs(both({ ...ok, erp_finance__movement: [mov(lm1, { settlement_id: l1, delta_cents: "5" }), mov(lm2, { settlement_id: l1, delta_cents: "7" })] }), KNOWN);
});

test("item 1: a ordem das tabelas não importa (FK para linha que só se liga depois)", () => {
  // bordero_item vem antes e só tem FKs; as liquidações são iguais entre si;
  // quem desfaz o empate são os movimentos, em outra tabela.
  const [ps1, ps2, pb, ls1, ls2, lb] = [U(), U(), U(), U(), U(), U()];
  const data = (litems) => ({
    erp_finance__bordero_item: { pg: [item(ps1, pb), item(ps2, pb)], lite: litems },
    erp_finance__bordero: { pg: [bor(pb)], lite: [bor(lb)] },
    erp_finance__settlement: { pg: [set(ps1), set(ps2)], lite: [set(ls1), set(ls2)] },
    erp_finance__movement: {
      pg: [mov(U(), { settlement_id: ps1, delta_cents: "5" }), mov(U(), { settlement_id: ps2, delta_cents: "7" })],
      lite: [mov(U(), { settlement_id: ls1, delta_cents: "5" }), mov(U(), { settlement_id: ls2, delta_cents: "7" })],
    },
  });
  equal(data([item(ls1, lb), item(ls2, lb)]), KNOWN);
  differs(data([item(ls1, lb), item(ls1, lb)]), KNOWN);
  differs(data([item(ls1, lb), item(ls2, U())]), KNOWN);
});

test("item 1: estrutura regular que a cor sozinha não separa (2 pares × 1 ciclo de 4) é acusada", () => {
  const p = [U(), U(), U(), U()],
    l = [U(), U(), U(), U()];
  const m = (id, other) => mov(id, { kind: "transfer", compensates_id: other });
  equal({ erp_finance__movement: { pg: [m(p[0], p[1]), m(p[1], p[0]), m(p[2], p[3]), m(p[3], p[2])], lite: [m(l[0], l[1]), m(l[1], l[0]), m(l[2], l[3]), m(l[3], l[2])] } }, KNOWN);
  differs({ erp_finance__movement: { pg: [m(p[0], p[1]), m(p[1], p[0]), m(p[2], p[3]), m(p[3], p[2])], lite: [m(l[0], l[1]), m(l[1], l[2]), m(l[2], l[3]), m(l[3], l[0])] } }, KNOWN);
});

test("item 1: id que já existia nunca é ligado a outro (FK para linha existente errada)", () => {
  // Conta existente trocada.
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [mov(U(), { account_id: A2 })] } }, KNOWN);
  // Conta inexistente no motor.
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [mov(U(), { account_id: U() })] } }, KNOWN);
  // O motor reaproveita um id existente como id da linha nova.
  differs({ erp_finance__movement: { pg: [mov(U())], lite: [mov(T)] } }, KNOWN);
});

test("item 1: na resposta, id existente diferente é divergência (antes ligava)", () => {
  const ids = new IdMap(new Set(KNOWN));
  assert.match(diffValues({ id: A }, { id: A2 }, ids)[0].why, /já existia/);
  const p = U(),
    l = U();
  assert.deepEqual(diffValues({ id: p, items: [{ id: p }] }, { id: l, items: [{ id: l }] }, ids), []);
  assert.match(diffValues({ a: p, b: U() }, { a: l, b: l }, ids)[0].why, /sem correspondência/);
});

test("item 1: array da resposta ordenado por id novo (settle_batch sem agrupamento)", () => {
  // Cada lado ordena os borderôs novos pelos próprios ids.
  const sideBy = (ids, amounts) =>
    ids
      .map((id, i) => ({ id, amount_cents: amounts[i], settlements: [{ id: U(), title_id: T }] }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  const make = (amounts) => {
    // Gera até a ordem dos dois lados ficar trocada (o caso que divergia).
    for (;;) {
      const p = sideBy([U(), U()], amounts),
        l = sideBy([U(), U()], amounts);
      if (p[0].amount_cents !== l[0].amount_cents) return { p, l };
    }
  };
  const { p, l } = make([100, 250]);
  const ids = bIds();
  assert.deepEqual(diffValues({ borderos: p }, { borderos: l }, ids), []);
  assert.equal(ids.map(l[0].id), p.find((x) => x.amount_cents === l[0].amount_cents).id, "ligou pelo conteúdo, não pela posição");

  // Valor diferente num elemento: acusado.
  const bad = structuredClone(l);
  bad[0].amount_cents += 1;
  assert.notDeepEqual(diffValues({ borderos: p }, { borderos: bad }, bIds()), []);
  // O motor não ordena pelo id: acusado (3 elementos, ordem nem crescente nem
  // decrescente nos ids do motor e diferente da do Postgres; se a ordem
  // errada coincidir com a do Postgres, a posição bate e passa: o limite).
  const p3 = sideBy([U(), U(), U()], [100, 250, 400]);
  for (;;) {
    const l3 = sideBy([U(), U(), U()], [100, 250, 400]);
    const wrong = [l3[1], l3[0], l3[2]];
    if (wrong.map((x) => x.amount_cents).join() === p3.map((x) => x.amount_cents).join()) continue;
    assert.deepEqual(diffValues({ borderos: p3 }, { borderos: l3 }, bIds()), [], "ordenado pelos próprios ids: passa");
    assert.notDeepEqual(diffValues({ borderos: p3 }, { borderos: wrong }, bIds()), []);
    break;
  }
  // Ordem diferente sem id novo como chave (ordenado por id que já existia): acusado.
  const byKnown = (arr) => arr.map((x, i) => ({ ...x, id: [A, A2][i] }));
  assert.notDeepEqual(
    diffValues({ borderos: byKnown(p) }, { borderos: byKnown(p).reverse() }, bIds()),
    [],
  );
  // Lista que não tem id: ordem é ordem.
  assert.notDeepEqual(diffValues({ v: [1, 2] }, { v: [2, 1] }, new IdMap(new Set(KNOWN))), []);
  // Elemento a mais: acusado.
  assert.notDeepEqual(diffValues({ borderos: p }, { borderos: [...l, l[0]] }, bIds()), []);
});

test("item 1: o mesmo array gravado em json nas tabelas (auditoria e recibo)", () => {
  const ordered = (arr) => [...arr].sort((a, b) => (a.id < b.id ? -1 : 1));
  const elems = (ids, amounts) => ids.map((id, i) => ({ id, amount_cents: amounts[i] }));
  const audit = (borderos) =>
    row("erp_finance__audit", { id: "1", actor: ACTOR, command_id: CMD, action: "settle_batch", after_data: JSON.stringify({ borderos }), created_at: "1" });
  const data = (pIds, lArr) => ({
    erp_finance__bordero: { pg: pIds.map((i) => bor(i)), lite: lArr.map((x) => bor(x.id)) },
    erp_finance__audit: { pg: [audit(ordered(elems(pIds, [100, 250, 400])))], lite: [audit(lArr)] },
  });
  for (let n = 0; n < 20; n++) {
    const pIds = [U(), U(), U()],
      lIds = [U(), U(), U()];
    const l = ordered(elems(lIds, [100, 250, 400]));
    equal(data(pIds, l), KNOWN);
    // Valor diferente num elemento do json.
    differs(data(pIds, l.map((x, i) => (i === 1 ? { ...x, amount_cents: 251 } : x))), KNOWN);
    // Elemento a menos.
    differs(data(pIds, l.slice(0, 2)), KNOWN);
    // O motor fora da ordem declarada (sempre acusado, mesmo que coincida).
    differs(data(pIds, [l[1], l[0], l[2]]), KNOWN);
    differs(data(pIds, [...l].reverse()), KNOWN);
  }
  // Array sem id novo como chave: ordem é ordem.
  const fixed = (v) => row("erp_finance__audit", { id: "1", actor: ACTOR, command_id: CMD, action: "x", after_data: JSON.stringify({ v }), created_at: "1" });
  differs({ erp_finance__audit: { pg: [fixed([{ id: A }, { id: A2 }])], lite: [fixed([{ id: A2 }, { id: A }])] } }, KNOWN);
  // Array não declarado com ids novos: dois elementos estão sempre "em
  // ordem" num sentido; a ordem tem de valer mesmo assim.
  const [p1, p2, l1, l2] = [U(), U(), U(), U()];
  const items = (a, b) => row("erp_finance__audit", { id: "1", actor: ACTOR, command_id: CMD, action: "x", after_data: JSON.stringify({ items: [{ id: a, n: 1 }, { id: b, n: 2 }] }), created_at: "1" });
  equal({ erp_finance__bordero: { pg: [bor(p1), bor(p2)], lite: [bor(l1), bor(l2)] }, erp_finance__audit: { pg: [items(p1, p2)], lite: [items(l1, l2)] } }, KNOWN);
  const swapped = row("erp_finance__audit", { id: "1", actor: ACTOR, command_id: CMD, action: "x", after_data: JSON.stringify({ items: [{ id: l2, n: 2 }, { id: l1, n: 1 }] }), created_at: "1" });
  differs({ erp_finance__bordero: { pg: [bor(p1), bor(p2)], lite: [bor(l1), bor(l2)] }, erp_finance__audit: { pg: [items(p1, p2)], lite: [swapped] } }, KNOWN);
});

test("item 1: a declaração de ordem por id novo é conferida", () => {
  assert.throws(() => registerNewIdOrder({ id: "teste.sem_chave", by: "id" }), /chaves/);
  assert.throws(() => registerNewIdOrder({ id: "teste.dir", keys: ["x"], dir: "acima" }), /asc ou desc/);
  const ok = { rpcs: ["erp_x"], reason: "chave de ordenação aleatória no oráculo, só para o teste do harness" };
  assert.throws(() => registerNewIdOrder({ id: "teste.coluna", keys: ["x"], columns: ["erp_finance__bordero.note"], ...ok }), /não é json/);
  assert.throws(() => registerNewIdOrder({ id: "teste.sem_rpc", keys: ["x"], reason: ok.reason }), /RPCs/);
  assert.throws(() => registerNewIdOrder({ id: "teste.sem_motivo", keys: ["x"], rpcs: ["erp_x"], reason: "aleatório" }), /justifique/);
  assert.throws(() => registerNewIdOrder({ id: "finance.settle_batch_borderos", keys: ["x"] }), /já registrada/);
  // Ids em ordem crescente nos dois lados: só a declaração separa os casos.
  const two = () => [U(), U()].sort();
  const [p1, p2] = two(),
    [l1, l2] = two();
  // Na resposta, array não declarado com ids novos: a ordem vale.
  assert.notDeepEqual(diffValues({ items: [{ id: p1, n: 1 }, { id: p2, n: 2 }] }, { items: [{ id: l1, n: 2 }, { id: l2, n: 1 }] }, new IdMap(new Set(KNOWN))), []);
  // Declarado: a mesma troca passa.
  assert.deepEqual(diffValues({ borderos: [{ id: p1, n: 1 }, { id: p2, n: 2 }] }, { borderos: [{ id: l1, n: 2 }, { id: l2, n: 1 }] }, bIds()), []);
  // A mesma chave na resposta de outro RPC: a ordem vale.
  const other = new IdMap(new Set(KNOWN));
  other.rpc = "erp_finance_execute";
  assert.notDeepEqual(diffValues({ borderos: [{ id: p1, n: 1 }, { id: p2, n: 2 }] }, { borderos: [{ id: l1, n: 2 }, { id: l2, n: 1 }] }, other), []);
  // Na tabela, a chave declarada numa coluna não declarada (before_data): a ordem vale.
  const at = (col, borderos) => row("erp_finance__audit", { id: "1", actor: ACTOR, command_id: CMD, action: "x", [col]: JSON.stringify({ borderos }), created_at: "1" });
  const data = (col) => ({
    erp_finance__bordero: { pg: [bor(p1), bor(p2)], lite: [bor(l1), bor(l2)] },
    erp_finance__audit: { pg: [at(col, [{ id: p1, n: 1 }, { id: p2, n: 2 }])], lite: [at(col, [{ id: l1, n: 2 }, { id: l2, n: 1 }])] },
  });
  equal(data("after_data"), KNOWN);
  differs(data("before_data"), KNOWN);
});

// ---------------------------------------------------------------------------
// Item 2: identificadores derivados de uuid

const type = (id, v = {}) =>
  row("erp_catalog__contact_type", {
    id, slug: "t" + id.replace(/-/g, ""), label: "Parceiro", system: 0, deletable: 1, role_backed: 0, position: "4", active: 1, created_by: ACTOR, created_at: "1",
    label__fold: "parceiro", ...v,
  });

test("item 2: slug derivado do id liga junto com o id; resposta com o slug também", () => {
  const p = U(),
    l = U();
  equal({ erp_catalog__contact_type: { pg: [type(p)], lite: [type(l)] } }, KNOWN);
  const ids = new IdMap(new Set(KNOWN));
  const slug = (u) => "t" + u.replace(/-/g, "");
  assert.deepEqual(diffValues({ item: { id: p, slug: slug(p) }, types: [slug(p)] }, { item: { id: l, slug: slug(l) }, types: [slug(l)] }, ids), []);
});

test("item 2: slug apontando para outro registro é acusado", () => {
  const [p1, p2, l1, l2] = [U(), U(), U(), U()];
  const slug = (u) => "t" + u.replace(/-/g, "");
  // Slugs trocados entre os dois tipos novos.
  differs(
    { erp_catalog__contact_type: { pg: [type(p1, { label: "A", label__fold: "a" }), type(p2, { label: "B", label__fold: "b" })], lite: [type(l1, { label: "A", label__fold: "a", slug: slug(l2) }), type(l2, { label: "B", label__fold: "b", slug: slug(l1) })] } },
    KNOWN,
  );
  // Slug de um tipo que já existia.
  differs({ erp_catalog__contact_type: { pg: [type(p1)], lite: [type(l1, { slug: slug(T) })] } }, KNOWN);
  // Slug de um id que não existe em lugar nenhum.
  differs({ erp_catalog__contact_type: { pg: [type(p1)], lite: [type(l1, { slug: slug(U()) })] } }, KNOWN);
  // Na resposta: o slug de outro tipo novo, sob a chave declarada.
  const ids = new IdMap(new Set(KNOWN));
  assert.notDeepEqual(diffValues({ item: { id: p1, slug: slug(p1) } }, { item: { id: l1, slug: slug(l2) } }, ids), []);
});

test("item 2: fora das colunas e chaves declaradas o texto é comparado literalmente", () => {
  const p = U(),
    l = U();
  const slug = (u) => "t" + u.replace(/-/g, "");
  differs({ erp_catalog__contact_type: { pg: [type(p, { label: slug(p) })], lite: [type(l, { label: slug(l) })] } }, KNOWN);
  const ids = new IdMap(new Set(KNOWN));
  assert.deepEqual(diffValues({ id: p }, { id: l }, ids), []);
  assert.notDeepEqual(diffValues({ note: slug(p) }, { note: slug(l) }, ids), [], "chave 'note' não declarada");
});

test("item 2: a declaração é conferida (regex ancorada, lugares, ida e volta)", () => {
  const base = { pattern: /^x([0-9a-f]{32})$/, toUuid: () => "", fromUuid: (u) => "x" + u.replace(/-/g, ""), columns: ["erp_catalog__contact_type.slug"] };
  assert.throws(() => registerDerivedId({ ...base, id: "teste.solto", pattern: /x([0-9a-f]{32})/ }), /ancorada/);
  assert.throws(() => registerDerivedId({ ...base, id: "teste.sem_lugar", columns: [] }), /onde/);
  assert.throws(() => registerDerivedId({ ...base, id: "teste.json", columns: ["erp_catalog__audit.after_data"] }), /chaves/);
  assert.throws(() => registerDerivedId({ ...base, id: "teste.coluna", columns: ["erp_catalog__contact_type.nada"] }), /não existe/);
  assert.throws(() => registerDerivedId({ ...base, id: "teste.volta" }), /ida e volta/);
  assert.throws(() => registerDerivedId({ ...derivedIds()[0] }), /já registrado/);
});

// ---------------------------------------------------------------------------
// Item 3: colunas normalizadas

test("item 3: coluna __fold com valor errado é acusada (comparador)", () => {
  const p = U(),
    l = U();
  differs({ erp_catalog__contact_type: { pg: [type(p)], lite: [type(l, { label__fold: "Parceiro" })] } }, KNOWN);
  differs({ erp_catalog__contact_type: { pg: [type(p)], lite: [type(l, { label__fold: null })] } }, KNOWN);
});

// ---------------------------------------------------------------------------
// Item 4: semeadura

test("item 4: semeadura com uuid aleatório alinha; desalinhada de propósito para", async () => {
  const pg = await oracleDb();
  // Como na fixture: desvios aplicados nos dois lados antes de comparar.
  const check = async (tamper = null, opts = {}) => {
    const lite = freshLite();
    await applyDeviationsBoth(pg, lite);
    if (tamper) {
      lite.exec("PRAGMA foreign_keys=OFF");
      withoutTriggers(lite, /(?:UPDATE|FROM|INTO)\s+(\w+)/.exec(tamper)[1], () => lite.exec(tamper));
    }
    return seedDifferences(pg, lite, opts);
  };
  try {
    const fresh = await check();
    assert.deepEqual(fresh.diffs, []);
    // Se o cache do oráculo é do mesmo build que gerou a semeadura, os uuids
    // aleatórios já coincidem e não há o que alinhar; o alinhamento é provado
    // trocando o uuid de propósito (N, ao juntar: dependia do ambiente).
    const moved = await check(`UPDATE erp_a1__installation SET vault_id='${U()}'`);
    assert.deepEqual(moved.diffs, []);
    assert.ok(moved.align.includes("erp_a1__installation"), "erp_a1__installation alinhada");
    // A lacuna conhecida da semeadura (SEED_LEAVES_NORMALIZED_NULL): quando a
    // semeadura passar a preencher __fold, este teste manda pôr false.
    if (SEED_LEAVES_NORMALIZED_NULL)
      assert.ok(fresh.gaps.includes("erp_catalog__contact_type.label__fold"), "a semeadura já preenche __fold: ponha SEED_LEAVES_NORMALIZED_NULL=false");
    assert.notDeepEqual((await check(null, { allowNormalizedGap: false })).diffs, [], "sem a exceção, a lacuna é divergência");

    const tamper = async (sql) => (await check(sql)).diffs;
    assert.notDeepEqual(await tamper(`UPDATE erp_catalog__contact_type SET label='Freguês' WHERE slug='customer'`), []);
    assert.notDeepEqual(await tamper(`DELETE FROM erp_catalog__contact_type WHERE slug='carrier'`), []);
    assert.notDeepEqual(await tamper(`UPDATE erp_catalog__contact_type SET position=9 WHERE slug='customer'`), []);
    assert.notDeepEqual(
      await tamper(
        `INSERT INTO erp_catalog__contact_type(id,slug,label,system,deletable,role_backed,position,active,created_at) VALUES('${U()}','extra','Extra',0,1,0,9,1,1)`,
      ),
      [],
    );
    assert.notDeepEqual(await tamper(`DELETE FROM erp_a1__installation`), []);
    assert.notDeepEqual(await tamper(`UPDATE erp_preferences__definition SET default_value='"9"' WHERE rowid=(SELECT min(rowid) FROM erp_preferences__definition)`), []);
    assert.notDeepEqual(await tamper(`UPDATE erp_reference__country SET name=name||' ' WHERE rowid=1`), []);
    // Uuid fixo diferente nos dois lados, fora de RANDOM_SEED_COLUMNS: os
    // dois ids só existem num lado cada (seriam "livres"), mas não são
    // alinhados.
    await pg.exec("begin");
    try {
      await pg.exec("set session_replication_role = replica");
      await pg.query("update erp_pos.settings set consumer_contact_id=$1", [U()]);
      const d = await tamper(`UPDATE erp_pos__settings SET consumer_contact_id='${U()}'`);
      assert.match(JSON.stringify(d), /RANDOM_SEED_COLUMNS/);
    } finally {
      await pg.exec("rollback");
    }
  } finally {
    await pg.close();
  }
});

// ---------------------------------------------------------------------------
// Porta de identidade: f.rpc(…, { as }) / f.rpcAs, papel e nível de sessão

test("identidade: RPC como pessoa com papel e sessão aal1/aal2 nos dois motores; envelope errado é acusado", async () => {
  const f = await dualFixture();
  try {
    const { admin, vendas, financeiro } = f.users;
    const s1 = await f.session(admin, "aal1"),
      s2 = await f.session(admin, "aal2"),
      old = await f.session(admin, "aal2", { expired: true }),
      fin = await f.session(financeiro, "aal1");
    await f.factor(admin);
    const gate = (user, session) => f.rpcAs("erp_access_gate_v2", { p_user_id: user, p_session_id: session });
    for (const s of [null, s1, s2, old]) await gate(admin, s);
    // Política de MFA: só com aal2 e fator verificado (o motor vê o mesmo).
    await assert.rejects(
      f.rpcAs("erp_access_security_policy_save", { p_user_id: admin, p_session_id: s1, p_command_id: U(), p_expected_version: 0, p_mfa_required: true }),
      (e) => e.code === "28000",
    );
    await f.rpcAs("erp_access_security_policy_save", { p_user_id: admin, p_session_id: s2, p_command_id: U(), p_expected_version: 0, p_mfa_required: true });
    assert.equal((await gate(admin, s1)).mfa_ok, false);
    assert.equal((await gate(admin, s2)).mfa_ok, true);
    await gate(financeiro, fin);
    assert.equal((await f.rpcAs("erp_access_permissions_me", { p_user_id: vendas })).role, "vendas");
    // `as` com outra pessoa que não a dos argumentos.
    await f.rpc("erp_access_profile_me", { p_user_id: admin }, { as: { user: admin, session: s2 } });

    // Envelope adulterado só no motor: a divergência aparece.
    const pgCall = (name, args) => async () => {
      await f.db.exec("set role service_role");
      try {
        const e = Object.entries(args);
        return (await f.db.query(`select public.${name}(${e.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) v`, e.map(([, v]) => v))).rows[0]?.v;
      } finally {
        await f.db.exec("reset role");
      }
    };
    const tampered = async (name, args, session, change) => {
      const identity = await pgIdentity(f.db, args.p_user_id, session);
      change(identity);
      return f.dual(name, pgCall(name, args), () => callRpc(f.driver, name, structuredClone(args), f.clock, { objects: f.objectLookup, listing: [], identity }));
    };
    const diverges = (p) => assert.rejects(p, /os motores divergem/);
    // O motor projeta `people` (papel e nome) e lê a sessão do `actor`: o
    // envelope adulterado muda os dois, como um Worker errado mandaria.
    const set = (i, user, field, value) => {
      i.actor[field] = value;
      i.people.find((p) => p.user_id === user)[field] = value;
    };
    await diverges(tampered("erp_access_permissions_me", { p_user_id: vendas }, null, (i) => set(i, vendas, "erp_role", "admin")));
    await diverges(tampered("erp_access_gate_v2", { p_user_id: admin, p_session_id: s1 }, s1, (i) => (i.actor.aal = "aal2")));
    await diverges(tampered("erp_access_profile_me", { p_user_id: admin }, null, (i) => set(i, admin, "name", "Outra pessoa")));
    // E o envelope certo continua passando depois.
    assert.equal((await gate(admin, s2)).mfa_ok, true);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Ponta a ponta: a fixture dupla com as escritas plantadas

test("ponta a ponta: espelho, ids novos, __fold, ids existentes e resposta", async () => {
  const f = await dualFixture();
  try {
    // Espelho e alinhamento: tipos do sistema com o fold do Postgres.
    const pgFold = (await f.db.query("select id::text, erp_catalog.fold(label) f from erp_catalog.contact_type")).rows;
    for (const r of pgFold)
      assert.equal(f.lite.prepare("SELECT label__fold FROM erp_catalog__contact_type WHERE id=?").get(r.id)?.label__fold, r.f);

    const replica = async (fn) => {
      await f.db.exec("set session_replication_role = replica");
      try {
        return await fn();
      } finally {
        await f.db.exec("set session_replication_role = origin");
      }
    };
    const pgDeposit = (name, description = "Fundos", recordId = null) =>
      replica(async () => {
        const id = recordId ?? (await f.db.query("insert into erp_catalog.record(entity,name) values('warehouses',$1) returning id::text", [name])).rows[0].id;
        await f.db.query("insert into erp_catalog.warehouse(record_id,description) values($1,$2)", [id, description]);
        return null;
      });
    const liteDeposit = (name, { description = "Fundos", nameFold = fold(name), recordId = null } = {}) => {
      const id = recordId ?? U();
      if (!recordId)
        f.lite
          .prepare("INSERT INTO erp_catalog__record(id,entity,name,active,version,human_edited,created_at,updated_at,name__fold) VALUES(?,'warehouses',?,1,1,0,1,1,?)")
          .run(id, name, nameFold);
      f.lite.prepare("INSERT INTO erp_catalog__warehouse(record_id,description) VALUES(?,?)").run(id, description);
      return null;
    };
    const diverges = (p) => assert.rejects(p, /os motores divergem/);

    // Ids novos que não voltam na resposta: passam.
    await f.dual("plantado.ok", () => pgDeposit("Depósito Ação"), () => liteDeposit("Depósito Ação"));
    // Valor diferente na linha nova.
    await diverges(f.dual("plantado.descricao", () => pgDeposit("Depósito B"), () => liteDeposit("Depósito B", { description: "Frente" })));
    // Linha a mais / a menos.
    await diverges(f.dual("plantado.a_mais", () => pgDeposit("Depósito C"), () => (liteDeposit("Depósito C"), liteDeposit("Depósito D"))));
    await diverges(f.dual("plantado.a_menos", () => pgDeposit("Depósito E"), () => null));
    // __fold errado (sem tirar o acento) e __fold vazio.
    await diverges(f.dual("plantado.fold", () => pgDeposit("Depósito Ação 2"), () => liteDeposit("Depósito Ação 2", { nameFold: "depósito ação 2" })));
    await diverges(f.dual("plantado.fold_nulo", () => pgDeposit("Depósito F"), () => liteDeposit("Depósito F", { nameFold: null })));
    // FK para um registro que já existia (o do primeiro passo), em vez do novo.
    const existing = f.lite.prepare("SELECT id FROM erp_catalog__record WHERE name='Depósito Ação'").get().id;
    await f.dual(
      "plantado.limpa",
      () => replica(async () => void (await f.db.query("delete from erp_catalog.warehouse"))),
      () => void f.lite.exec("DELETE FROM erp_catalog__warehouse"),
    );
    await diverges(
      f.dual(
        "plantado.fk_existente",
        () => pgDeposit("Depósito G"),
        () => {
          f.lite.prepare("INSERT INTO erp_catalog__record(id,entity,name,active,version,human_edited,created_at,updated_at,name__fold) VALUES(?,'warehouses','Depósito G',1,1,0,1,1,'deposito g')").run(U());
          return liteDeposit("x", { recordId: existing });
        },
      ),
    );
    // Resposta: id de usuário existente trocado (antes ligava).
    await diverges(f.dual("plantado.resposta", async () => ({ by: f.users.admin }), () => ({ by: f.users.consulta })));
    // E o caso certo segue passando depois de tudo (o SQLite foi realinhado).
    await f.dual("plantado.ok2", () => pgDeposit("Depósito H"), () => liteDeposit("Depósito H"));
  } finally {
    await f.close();
  }
});
