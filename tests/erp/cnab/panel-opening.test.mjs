// Contrato das leituras reais de abertura e paginação limitada da migração
// 067. RPCs já portados: compara saída e estado com o PostgreSQL original.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { cnabFixture, LEGACY } from "./fixture.mjs";
import { executeCnabOperationalV2Route, parseCnabOperationalV2Route } from "../../../src/erp/fagoo/workers/erp-api/src/cnab-operational-v2.mjs";
import { callRpc } from "../../../src/erp/engine/registry.ts";

let f;
before(async () => { f = await cnabFixture(); });
after(() => f?.close());

const api = async (path, body, user = f.users.admin) => {
  const route = await parseCnabOperationalV2Route(new Request(`https://local.invalid/v1/cobranca-operacional-v2${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return executeCnabOperationalV2Route(route, { userId: user, rpc: (name, args) => f.rpc(name, args), storeFile: f.storeFile, getFile: f.getFile });
};

test("abertura vazia: cobrança faz 2 RPCs/4 SELECTs, retornos 3 RPCs/5 SELECTs", async () => {
  const exec = f.driver.exec.bind(f.driver), seen = [];
  f.driver.exec = (sql, ...args) => { if (/^\s*SELECT\b/i.test(sql)) seen.push(sql); return exec(sql, ...args); };
  try {
    const profiles = (await api("/profiles")).body, files = (await api("/remittances?limit=25")).body;
    assert.deepEqual(profiles.items, []);
    assert.deepEqual(files.items, []);
    assert.equal(seen.length, 4, seen.join("\n"));
    seen.length = 0;
    assert.equal((await f.app("", undefined, f.users.admin)).read, true);
    assert.deepEqual((await f.op("/profiles", undefined, f.users.admin)).body.items, []);
    assert.deepEqual((await f.ret("/files?limit=25", undefined, f.users.admin)).body.items, []);
    assert.equal(seen.length, 5, seen.join("\n"));
  } finally { f.driver.exec = exec; }
});

test("leituras de abertura recusam papel fora do Financeiro e Cobrança desligada", async () => {
  await assert.rejects(() => api("/profiles", undefined, f.users.vendas), { code: "ERP_FORBIDDEN", status: 403 });
  await assert.rejects(() => f.ret("/files", undefined, f.users.vendas), { code: "42501" });
  for (const name of ["erp_cnab_operational_profiles_v2", "erp_cnab_operational_files_v2", "erp_cnab_operational_profiles", "erp_cnab_operational_files"]) {
    assert.throws(() => callRpc(f.driver, name, { p_user_id: f.users.admin, ...(name === "erp_cnab_operational_files" ? { p_kind: "return" } : {}) }, f.clock, { parts: { billing: false } }),
      (error) => error.code === "module_disabled");
  }
});

test("v2 pela erp-api: prévia, geração, download, recibo e paginação equivalem ao oráculo", async () => {
  const profile = await f.profile();
  await f.approveV2(profile, [LEGACY]);
  const ids = [];
  for (let index = 0; index < 3; index++) {
    const title = await f.title(), current = (await api("/profiles")).body.items.find(x => x.profile.id === profile.id);
    const command = {
      command_id: randomUUID(), profile_id: profile.id, expected_version: current.profile.version,
      expected_approval_version: current.approval.approval_version, generated_on: f.today,
      titles: [{ title_id: title.id, expected_version: title.version, document_number: `TESTE${index}` }],
      encoding_profile: LEGACY, confirm_encoding_profile: false, zero_daily_title_ids: [], confirm_operational: false,
    };
    const preview = (await api("/remittances/preview", command)).body;
    assert.equal(preview.persisted, false);
    assert.equal(preview.total_cents, "12345");
    const ack = (await api("/remittances", { ...command, preview_hash: preview.preview_hash, confirm_operational: true, confirm_encoding_profile: true })).body;
    assert.equal(ack.state, "ready");
    assert.equal(ack.bankTransmissionPerformed, false);
    assert.equal(ack.financialMutationPerformed, false);
    const download = await api(`/files/remittance/${ack.id}`);
    assert.equal(download.bytes.length, ack.byte_size);
    const receipt = (await api(`/commands/${command.command_id}`)).body;
    assert.equal(receipt.current.state, "ready");
    ids.push(ack.id);
  }
  ids.sort();
  const exec = f.driver.exec.bind(f.driver), queries = [];
  f.driver.exec = (sql, ...args) => {
    const result = exec(sql, ...args);
    if (sql.includes('FROM "erp_cnab__remittance"')) queries.push({ sql, rows: result.rows.length, args });
    return result;
  };
  try {
    const first = (await api("/remittances?limit=1")).body;
    assert.deepEqual(first.items.map(x => x.id), [ids[0]]);
    assert.equal(first.has_more, true);
    const second = (await api(`/remittances?limit=1&after=${first.next_cursor}`)).body;
    assert.deepEqual(second.items.map(x => x.id), [ids[1]]);
    const third = (await api(`/remittances?limit=1&after=${second.next_cursor}`)).body;
    assert.deepEqual(third.items.map(x => x.id), [ids[2]]);
    assert.equal(third.has_more, false);
    assert.equal(queries.length, 3);
    for (const query of queries) {
      assert.match(query.sql, /LIMIT \?/);
      assert.match(query.sql, /json_extract\(snapshot,'\$\.profile\.bank'\)='341'/);
      assert.ok(query.rows <= 2);
    }
    assert.match(queries[1].sql, /AND id>\?/);
    const cursorPlan = f.lite.prepare(`EXPLAIN QUERY PLAN ${queries[1].sql}`).all(...queries[1].args).map(row => row.detail).join("\n");
    assert.match(cursorPlan, /SEARCH .* USING INDEX .* \(id>\?\)/);
  } finally { f.driver.exec = exec; }
});
