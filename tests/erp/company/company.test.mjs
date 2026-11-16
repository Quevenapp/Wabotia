// Empresa nos dois motores: acesso, identidade, regime fiscal, dados
// complementares, sócios, arquivos e logotipo (com o objeto confirmado no
// armazenamento), e as normalizações com entradas aleatórias.
//   node --test tests/erp/company/company.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import * as company from "../../../src/erp/domains/company/internal.ts";

const f = await dualFixture();
test.after(() => f.close());
const { users } = f;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (e.code === "ERR_ASSERTION") throw e;
    return { error: e.code };
  }
};
const identity = (over = {}) => ({
  legal_name: "Empresa Sintética de QA", trade_name: null, cnpj: "12.ABC.345/01DE-35", ie: null, postal_code: "13400-000",
  street: "Rua fictícia", number: "S/N", complement: null, district: "Centro fictício", city: "Piracicaba",
  municipality_code: "3538709", state: "sp", phone: "+55 (19) 99999-0000", email: "empresa@example.invalid", ...over,
});
const extra = (over = {}) => ({
  billing_email: null, cnae: null, company_size: null, contacts: null, employees: null, ie_exempt: false, mobile: null,
  municipal_registration: null, person_type: "juridica", revenue: null, segments: ["comercio"], site: null,
  substitute_ies: [], suframa: null, ...over,
});
const version = async (table) => (await f.db.query(`select version from erp_company.${table} where singleton`)).rows[0]?.version ?? 0;

test("acesso e leitura por papel; empresa vazia", async () => {
  for (const user of Object.values(users)) {
    await outcome(f.rpc("erp_company_access", { p_user_id: user }));
    for (const section of ["identity", "fiscal", "x", null]) await outcome(f.rpc("erp_company_get", { p_user_id: user, p_section: section }));
  }
});

test("identidade, regime fiscal e troca de CNPJ com motivo", async () => {
  const save = (data, reason = null, user = users.admin, command = randomUUID()) =>
    version("identity").then((v) => f.rpc("erp_company_save_identity", { p_user_id: user, p_expected_version: v, p_command_id: command, p_data: data, p_reason: reason }));
  for (const bad of [{ cnpj: "bad" }, { state: "XX" }, { municipality_code: "3304557" }, { postal_code: "00000000" }, { street: "" }, { legal_name: "\nx" }, { email: "bad@" }, { phone: "call-me" }, { crt: "1" }])
    assert.equal((await outcome(save(identity(bad)))).error, "22023");
  assert.equal((await outcome(save(identity(), null, users.vendas))).error, "42501");
  const cmd = randomUUID();
  const first = await save(identity(), null, users.admin, cmd);
  assert.equal(first.record.data.cnpj, "12ABC34501DE35");
  assert.equal((await f.rpc("erp_company_save_identity", { p_user_id: users.admin, p_expected_version: 0, p_command_id: cmd, p_data: identity(), p_reason: null })).replayed, true);
  // Nome fantasia também é dado travado: sem motivo recusa, com motivo grava.
  assert.equal((await outcome(save(identity({ trade_name: "Marca fictícia" })))).error, "22023");
  await save(identity({ trade_name: "Marca fictícia" }), "Nome fantasia sintético");
  const fiscal = (o) =>
    f.rpc("erp_company_confirm_fiscal", {
      p_user_id: users.fiscal, p_expected_version: o.version, p_expected_identity_version: o.identity, p_command_id: randomUUID(),
      p_crt: "crt" in o ? o.crt : "3", p_confirmed: o.confirmed ?? true, p_reason: o.reason ?? "Confirmação sintética para QA",
    });
  for (const o of [{ confirmed: false }, { crt: "0" }, { reason: "no" }, { identity: 1 }, { version: 0 }])
    await outcome(fiscal({ version: 1, identity: 2, ...o }));
  await fiscal({ version: 1, identity: 2 });
  // CNPJ novo exige motivo e zera o regime.
  assert.equal((await outcome(save(identity({ cnpj: "11.222.333/0001-81" })))).error, "22023");
  await save(identity({ cnpj: "11.222.333/0001-81" }), "Troca sintética de CNPJ");
  await outcome(fiscal({ version: 3, identity: 2 }));
  await fiscal({ version: 3, identity: 3, crt: null, confirmed: false, reason: "Retirar confirmação" });
});

test("dados complementares (CNAE oficial) e sócios", async () => {
  const saveExtra = async (data, command = randomUUID()) =>
    f.rpc("erp_company_extra_save", { p_user_id: users.admin, p_command_id: command, p_expected_version: await version("extra"), p_data: data });
  for (const bad of [{ segments: [] }, { segments: ["x"] }, { cnae: "9999-9/99" }, { ie_exempt: "no" }, { substitute_ies: [{ uf: "SP", ie: "1" }] }, { site: "sem ponto" }])
    assert.equal((await outcome(saveExtra(extra(bad)))).error, "22023");
  const cmd = randomUUID();
  await saveExtra(extra({ cnae: "4744-0/01", segments: ["servicos", "comercio"], substitute_ies: [{ uf: "RJ", ie: "12.345-6" }], billing_email: "fin@example.invalid" }), cmd);
  assert.equal((await outcome(saveExtra(extra({ cnae: "4744001", segments: ["comercio", "servicos"], substitute_ies: [{ uf: "RJ", ie: "12.345-6" }], billing_email: "fin@example.invalid" })))).error, "22023");
  await f.rpc("erp_company_extra_save", { p_user_id: users.admin, p_command_id: cmd, p_expected_version: 0, p_data: extra({ cnae: "4744-0/01", segments: ["servicos", "comercio"], substitute_ies: [{ uf: "RJ", ie: "12.345-6" }], billing_email: "fin@example.invalid" }) });
  await f.rpc("erp_company_extra_get", { p_user_id: users.consulta });
  const partner = (o = {}) => ({ name: "Sócia Sintética", cpf: "529.982.247-25", share: "50.5", role: "Administradora", email: "SOCIA@example.invalid", phone: null, ...o });
  const savePartners = async (list) =>
    f.rpc("erp_company_partners_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_expected_version: await version("partners"), p_partners: list });
  assert.equal((await outcome(savePartners([]))).error, "22023");
  for (const bad of [[partner({ cpf: "111.111.111-11" })], [partner(), partner()], [partner({ share: "101" })], [partner({ name: null })], [partner({ share: "60" }), partner({ cpf: "111.444.777-35", share: "50" })]])
    assert.equal((await outcome(savePartners(bad))).error, "22023");
  await savePartners([partner(), partner({ cpf: "111.444.777-35", share: "10", name: "Sócio Dois", email: null })]);
  await f.rpc("erp_company_partners_get", { p_user_id: users.admin });
});

test("arquivos e logotipo: reserva, aluguel, objeto confirmado, exclusão e troca do logo", async () => {
  const bytes = (n) => createHash("sha256").update("arquivo sintético " + n).digest("hex");
  const reserve = (n, user = users.admin) =>
    f.rpc("erp_company_file_reserve", { p_user_id: user, p_command_id: randomUUID(), p_filename: `arquivo-contrato${n}.pdf`, p_mime_type: "application/pdf", p_size_bytes: 1000 + n, p_sha256: bytes(n) });
  assert.equal((await outcome(reserve(1, users.vendas))).error, "42501");
  const file = (await reserve(1)).file;
  const lease = randomUUID();
  await f.rpc("erp_company_file_claim", { p_user_id: users.admin, p_id: file.id, p_lease: lease });
  assert.equal((await outcome(f.rpc("erp_company_file_claim", { p_user_id: users.admin, p_id: file.id, p_lease: randomUUID() }))).error, "40001");
  // Sem o objeto no armazenamento a conclusão recusa; com ele, conclui.
  assert.equal((await outcome(f.rpc("erp_company_file_finish", { p_user_id: users.admin, p_id: file.id, p_lease: lease, p_sha256: file.sha256, p_size_bytes: file.size_bytes }))).error, "40001");
  await f.putObject("erp-attachments", `company/files/${file.id}/${file.sha256}`, file.size_bytes, "application/pdf");
  await f.rpc("erp_company_file_finish", { p_user_id: users.admin, p_id: file.id, p_lease: lease, p_sha256: file.sha256, p_size_bytes: file.size_bytes });
  await f.rpc("erp_company_file_finish", { p_user_id: users.admin, p_id: file.id, p_lease: lease, p_sha256: file.sha256, p_size_bytes: file.size_bytes });
  await f.rpc("erp_company_file_object", { p_user_id: users.admin, p_id: file.id, p_write: false });
  const del = randomUUID();
  await f.rpc("erp_company_file_delete", { p_user_id: users.admin, p_id: file.id, p_command_id: del });
  await f.rpc("erp_company_file_delete", { p_user_id: users.admin, p_id: file.id, p_command_id: del });
  const other = (await reserve(2)).file;
  await f.rpc("erp_company_file_stop", { p_user_id: users.admin, p_id: other.id, p_abort: true, p_lease: null });
  assert.equal((await outcome(f.rpc("erp_company_file_object", { p_user_id: users.admin, p_id: other.id, p_write: true }))).error, "40001");

  const logo = async (n) => {
    const reserved = (await f.rpc("erp_company_logo_reserve", { p_user_id: users.admin, p_command_id: randomUUID(), p_mime_type: "image/png", p_size_bytes: 500 + n, p_sha256: bytes(100 + n) })).logo;
    const l = randomUUID();
    await f.rpc("erp_company_logo_claim", { p_user_id: users.admin, p_id: reserved.id, p_lease: l });
    await f.putObject("erp-attachments", `company/logo/${reserved.id}/${reserved.sha256}`, reserved.size_bytes, "image/png");
    return f.rpc("erp_company_logo_finish", { p_user_id: users.admin, p_id: reserved.id, p_lease: l, p_sha256: reserved.sha256, p_size_bytes: reserved.size_bytes });
  };
  await logo(1);
  const second = (await logo(2)).logo; // o segundo substitui o primeiro
  const delLogo = randomUUID();
  await f.rpc("erp_company_logo_delete", { p_user_id: users.admin, p_id: second.id, p_command_id: delLogo });
  await f.rpc("erp_company_logo_delete", { p_user_id: users.admin, p_id: second.id, p_command_id: delLogo });
  const pendingLogo = (await f.rpc("erp_company_logo_reserve", { p_user_id: users.admin, p_command_id: randomUUID(), p_mime_type: "image/png", p_size_bytes: 9, p_sha256: bytes(300) })).logo;
  const l2 = randomUUID();
  await f.rpc("erp_company_logo_claim", { p_user_id: users.admin, p_id: pendingLogo.id, p_lease: l2 });
  await f.rpc("erp_company_logo_stop", { p_user_id: users.admin, p_id: pendingLogo.id, p_abort: false, p_lease: l2 });
  await f.rpc("erp_company_logo_stop", { p_user_id: users.admin, p_id: pendingLogo.id, p_abort: true, p_lease: null });
  await f.rpc("erp_company_logo_reserve", { p_user_id: users.admin, p_command_id: randomUUID(), p_mime_type: "image/jpeg", p_size_bytes: 10, p_sha256: bytes(200) });
  for (const user of [users.admin, users.vendas, users.inactive]) await outcome(f.rpc("erp_company_logo_get", { p_user_id: user }));
  assert.equal((await outcome(f.rpc("erp_company_logo_object", { p_user_id: users.admin, p_id: randomUUID(), p_write: null }))).error, "22023");
});

/** Gerador (mulberry32) de objetos para as normalizações da empresa. */
function generator(seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const docs = ["12.ABC.345/01DE-35", "11222333000181", "529.982.247-25", "52998224725", "00000000000000", "123", " 11.222.333/0001-81 ", null, 5];
  const id = () => {
    // Metade válida (o caminho de aceitação também conta).
    if (rand() < 0.5)
      return identity({
        cnpj: pick(["12.ABC.345/01DE-35", "11222333000181", " 11.222.333/0001-81 "]), state: pick(["sp", "SP"]),
        phone: pick([null, "+55 (19) 99999-0000"]), email: pick([null, "a@b.co"]), trade_name: pick([null, "  Marca  ", ""]),
      });
    const o = identity({
      cnpj: pick(docs), state: pick(["sp", "SP", "RJ", "XX", null]), postal_code: pick(["13400-000", "13400000", "00000-000", "1340", null]),
      municipality_code: pick(["3538709", "3304557", "35387", null]), phone: pick([null, "+55 (19) 99999-0000", "call", "1234567"]),
      email: pick([null, "a@b.co", "bad@", "a b@c.d"]), legal_name: pick(["Empresa", "  Empresa  ", "", "x".repeat(201), "Ctl\u0001"]),
    });
    if (rand() < 0.1) o.extra = "x";
    if (rand() < 0.1) delete o.city;
    return o;
  };
  const ex = () => extra({
    cnae: pick([null, "", "4744-0/01", "4744001", "47440", "4744-0/0"]), segments: pick([["comercio"], [], ["industria", "comercio"], ["x"], "comercio"]),
    substitute_ies: pick([[], [{ uf: "SP", ie: "123" }], [{ uf: "SP", ie: "123" }, { uf: "SP", ie: "456" }], [{ uf: "XX", ie: "1" }]]),
    person_type: pick([null, "fisica", "juridica", "outro"]), site: pick([null, "www.x.com", "sem"]), mobile: pick([null, "(11) 99999-0000", "abc"]),
    ie_exempt: pick([true, false, "no"]),
  });
  const partner = () => ({
    name: pick(["Ana", null, "", " Ana "]), cpf: pick(["529.982.247-25", "11144477735", "111.111.111-11", 1]), share: pick([null, "10", "100", "100.01", "33.33", "0.5"]),
    role: pick([null, "Sócia"]), email: pick([null, "A@B.CO", "bad"]), phone: pick([null, "123", "(19) 99999-0000"]),
  });
  const exValid = () => extra({ cnae: pick([null, "4744-0/01", "4744001"]), segments: pick([["comercio"], ["industria", "comercio"]]), person_type: pick([null, "fisica"]), site: pick([null, "www.x.com"]) });
  return () => ({
    identity: id(),
    kind: pick(["cnpj", "any", "any", "cpf", "x"]),
    extra: rand() < 0.5 ? exValid() : ex(),
    partners: Array.from({ length: Math.floor(rand() * 3) }, partner),
  });
}

test("normalizações da empresa: entradas aleatórias, mesmo resultado ou mesmo erro", async () => {
  const next = generator(Number(process.env.ERP_DIFF_SEED || 20261116));
  const n = Number(process.env.ERP_DIFF_N || 150);
  const tally = {};
  const run = async (label, sql, args, ts) => {
    const r = await outcome(f.dual(label, async () => (await f.db.query(sql, args)).rows[0].v, () => inTransaction(f.driver, ts, f.clock)));
    const key = `${label}:${r.error ?? "ok"}`;
    tally[key] = (tally[key] ?? 0) + 1;
  };
  for (let i = 0; i < n; i++) {
    const c = next();
    await run("normalize_identity", "select erp_company.normalize_identity($1::jsonb, $2) v", [JSON.stringify(c.identity), c.kind], () => company.normalizeIdentity(c.identity, c.kind));
    await run("extra_normalize", "select erp_company.extra_normalize($1::jsonb) v", [JSON.stringify(c.extra)], () => company.extraNormalize(c.extra));
    await run("partners_normalize", "select erp_company.partners_normalize($1::jsonb) v", [JSON.stringify(c.partners)], () => company.partnersNormalize(c.partners));
  }
  console.log("empresa, normalizações:", JSON.stringify(tally));
  assert.ok(Object.keys(tally).some((k) => k.endsWith(":ok")));
});
