// Funcionários: o subteste "funcionários" de
// workers/erp-api/test/contacts-lane-sql.test.mjs do Fagoo, na fixture dupla
// (cada chamada roda nos dois motores e compara resposta, erro e tabelas).
// Fora: o subteste de GRANT/RLS/SECURITY DEFINER (o motor não tem papéis do
// Postgres; o acesso é o employee_admin, provado aqui).
// Mais um diferencial aleatório de formulário, busca e paginação.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

const EMPLOYEE = {
  name: "Funcionária Sintética", cpf: "529.982.247-25", rg: null, job_title: "Vendedora", pis: null, ctps: null, code: "F-1",
  phone: null, mobile: "(19) 90000-0001", email: "func@sintetico.test", emergency_phone: null, postal_code: null, state: "SP",
  city: "Piracicaba", district: null, street: null, number: null, complement: null, birth_date: "1990-01-02",
  admission_date: "2026-01-05", salary: "3500.5", notes: null,
};
const fails = (promise, code) => assert.rejects(promise, (e) => e.code === code || e.message === code);

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const save = (data, { id = null, version = 0, situation = null, user = f.users.admin, command = randomUUID() } = {}) =>
  f.rpc("erp_catalog_employee_save", {
    p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data, p_situation: situation,
  });

test("funcionários: administrador only, valid and unique CPF, PIS digits, Desligar keeps the record and no personal data in the command", async () => {
  await fails(save(EMPLOYEE, { user: f.users.financeiro }), "42501");
  for (const data of [
    { ...EMPLOYEE, cpf: "111.111.111-11" }, { ...EMPLOYEE, pis: "12345678901" }, { ...EMPLOYEE, salary: "1,5" },
    { ...EMPLOYEE, state: "XX" }, { ...EMPLOYEE, name: null }, { ...EMPLOYEE, extra: 1 },
  ])
    await fails(save(data), "22023");
  const command = randomUUID(),
    created = await save({ ...EMPLOYEE, pis: "120.50218.74-7" }, { command });
  assert.deepEqual(Object.keys(created.item).sort(), ["id", "version"]);
  assert.equal(
    JSON.stringify(await f.scalar("select result v from erp_catalog.command where command_id=$1", [command])).includes("529"),
    false,
    "no CPF in the stored command",
  );
  const item = (await f.rpc("erp_catalog_employee_get", { p_user_id: f.users.admin, p_id: created.item.id })).item;
  assert.deepEqual([item.cpf, item.pis, item.salary, item.situation], ["52998224725", "12050218747", "3500.50", "ativo"]);
  await fails(save({ ...EMPLOYEE, name: "Outra" }), "23505");
  const off = await save(null, { id: item.id, version: 1, situation: "desligado" });
  assert.equal(off.item.version, 2);
  assert.deepEqual((await f.rpc("erp_catalog_employee_page", { p_user_id: f.users.admin, p_situation: "ativos" })).items, []);
  assert.equal(
    (await f.rpc("erp_catalog_employee_page", { p_user_id: f.users.admin, p_situation: "todas", p_query: "vendedora" })).total,
    1,
  );
  await fails(f.rpc("erp_catalog_employee_get", { p_user_id: f.users.consulta, p_id: item.id }), "42501");
});

test("recibo, versão e argumentos batem nos dois motores", async () => {
  const command = randomUUID();
  const data = { ...EMPLOYEE, name: "Recibo Sintético", cpf: "153.509.460-56", code: null };
  const created = await save(data, { command });
  const replay = await save(data, { command });
  assert.equal(replay.replayed, true);
  await fails(save({ ...data, name: "Outro" }, { command }), "40001");
  await fails(save(data, { command, user: f.users.inactive }), "42501");
  const same = await save(data, { id: created.item.id, version: 1 });
  assert.equal(same.item.version, 1, "nada mudou: a versão fica");
  await fails(save(data, { id: created.item.id, version: 2 }), "40001");
  await fails(save(data, { id: randomUUID(), version: 1 }), "P0002");
  await fails(save(data, { id: null, version: 1 }), "22023");
  await fails(save(data, { id: created.item.id, version: 1, situation: "férias" }), "22023");
  await fails(save(data, { id: "nao-e-uuid", version: 1 }), "22P02");
  await fails(save(data, { id: created.item.id, version: 1.5 }), "22P02");
  await fails(f.rpc("erp_catalog_employee_get", { p_user_id: f.users.admin, p_id: null }), "P0002");
  for (const args of [{ p_page: 0 }, { p_size: 101 }, { p_query: "x".repeat(121) }, { p_query: "a\u0001" }, { p_situation: "x" }, { p_situation: null }])
    await fails(f.rpc("erp_catalog_employee_page", { p_user_id: f.users.admin, ...args }), "22023");
  await fails(f.rpc("erp_catalog_employee_page", { p_user_id: f.users.vendas }), "42501");
});

// ---------------------------------------------------------------------------
// Diferencial aleatório (semente fixa: falha reproduzível).

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function cpfWith(base) {
  const d = [...base].map(Number);
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * (n + 1 - i);
    d.push((sum * 10) % 11 % 10);
  }
  return d.join("");
}
function pisWith(base) {
  const w = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...base].reduce((s, c, i) => s + Number(c) * w[i], 0);
  const digit = 11 - (sum % 11);
  return base + (digit >= 10 ? 0 : digit);
}

test("diferencial aleatório: formulário, situação, busca e páginas", async () => {
  const r = rng(20261116);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const field = (good, bad) => pick(r() < 0.92 ? good : bad);
  const digits = (n) =>Array.from({ length: n }, () => Math.floor(r() * 10)).join("");
  const names = ["Ana Ábaco", "JOÃO da Silva", "Çelia Ñuñez", "Ωmega ΑΣ", "  espaços  ", "Bruna", "bruna", "Zé", "ana", "Ünal"];
  const texts = [null, "", "  ", "abc", "A\nB", "x\u0007", "ﬁ", " nbsp", "😀 emoji", 7, true, ["a"]];
  const ids = [];
  for (let i = 0; i < 120; i++) {
    const valid = r() < 0.7;
    const cpf = valid ? cpfWith(digits(9)) : pick([digits(11), "111.111.111-11", "", null, cpfWith(digits(9)) + "0"]);
    const data = {
      ...EMPLOYEE,
      name: valid ? pick(names) + " " + digits(2) : pick([...names, ...texts]),
      cpf: r() < 0.5 && typeof cpf === "string" && cpf.length === 11 ? `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}` : cpf,
      pis: r() < 0.3 ? pisWith(digits(10)) : r() < 0.2 ? digits(11) : null,
      job_title: pick(["Vendedora", "Gerente de Loja", null, "Caixa 2"]),
      code: r() < 0.5 ? `F-${digits(3)}` : null,
      email: field([null, "a@b.co", "a@b.co; c@d.ef", "a x@b.co"], ["a@b.co,", "sem-arroba", "a　@b.co"]),
      state: field(["SP", "sp", "ex", null, "ſp"], ["XX", "S"]),
      birth_date: field([null, "1990-01-02", ""], ["1899-12-31", "2026-02-30", "2099-01-01", "02/01/1990"]),
      admission_date: field([null, "2026-01-05", " 2026-01-05 "], ["2026-13-01"]),
      salary: field([null, "0", "3500.5", "9999999999999999.99", ""], ["3500.555", "01", "1,5", 3500]),
      notes: field([null, "linha 1\nlinha 2\ttab"], ["x\u0001", "x".repeat(4001)]),
    };
    if (r() < 0.05) delete data.notes;
    if (ids.length && r() < 0.3) {
      const [id, version] = pick(ids);
      try {
        const out = await save(r() < 0.3 ? null : data, { id, version, situation: pick([null, "ativo", "desligado"]) });
        ids[ids.findIndex((x) => x[0] === id)] = [id, out.item.version];
      } catch (e) {
        assert.ok(e.code, String(e));
      }
    } else {
      try {
        const out = await save(data);
        ids.push([out.item.id, out.item.version]);
      } catch (e) {
        assert.ok(e.code, String(e));
      }
    }
  }
  assert.ok(ids.length > 20, `poucos funcionários criados: ${ids.length}`);
  for (let i = 0; i < 60; i++) {
    await f.rpc("erp_catalog_employee_page", {
      p_user_id: f.users.admin,
      p_page: pick([1, 1, 2, 3]),
      p_size: pick([1, 5, 10, 100]),
      p_query: pick([null, "", "ana", "ANA", "abaco", "ábaco", "529", "529.982", "f-1", "f1", "vend ger", "ασ", "ας", "ç", "  ", "12a"]),
      p_situation: pick(["todas", "ativos", "desligados"]),
    });
  }
  for (const [id] of ids.slice(0, 10)) await f.rpc("erp_catalog_employee_get", { p_user_id: f.users.admin, p_id: id });
  assert.ok(f.stats.ported > 150);
});
