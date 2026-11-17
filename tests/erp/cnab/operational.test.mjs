// CNAB, bloco C3: remessa operacional v1 e v2 (codificação Itaú 109) e a
// prévia do boleto Itaú, nos dois motores. Adaptados do Fagoo:
// - cnab-operational.test.mjs (v1, pelo app cnab-operational.mjs): aprovação,
//   prévia sem efeito, geração, envio interrompido e retomada, revogação,
//   identidade alterada, Inter 112, títulos do Origin, espaço Unicode na referência;
// - cnab-operational-v2-sql.test.mjs (v2, direto nos RPCs, arquivo do cnab-core);
// - boleto-preview.test.mjs (066): contexto e itens da prévia, só pelo SQL.
// Fora, declarados: privilégios do Postgres (GRANT, RLS), o gatilho de
// auditoria injetado (DDL no teste), o arquivo de retorno operacional (C4) e a
// renderização HTML do boleto (app, sem RPC novo). A fixture já começa com a
// identidade da empresa; "identidade ausente" fica fora.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { cnabFixture, LEGACY, OBSERVED } from "./fixture.mjs";
import { generateOperationalRemittance, generateOperationalRemittanceV2 } from "../../../src/erp/fagoo/packages/cnab-core/src/index.mjs";

let f, profile, firstBody, firstAck, approvalBody;
let ordinal = 0;
const state = (code) => (e) => e.code === code;
const scalar = (sql, args = []) => f.scalar(sql, args);
const api = (path, body, extra = {}) => f.op(path, body, extra.userId ?? f.users.financeiro, extra);
const company = () => scalar("select (select version from erp_company.identity where singleton) v");
const current = async (id) => (await api("/profiles")).body.items.find((x) => x.profile.id === id);
async function approval(id, enabled = true, extra = {}) {
  const s = await current(id);
  const body = {
    command_id: randomUUID(), expected_approval_version: s.approval.approval_version, expected_profile_version: s.profile.version,
    expected_identity_version: (await company()) ?? null, enabled, confirmed_on: f.today, reference: "DECLARACAO SINTETICA SEM EVIDENCIA BANCARIA", ...extra,
  };
  return { body, result: await api(`/profiles/${id}/approval`, body, { userId: f.users.admin }) };
}
const previewBody = (b) => {
  const { preview_hash, ...v } = b;
  return { ...v, confirm_operational: false };
};
async function generation(id) {
  const s = await current(id),
    t = await f.title();
  const b = {
    command_id: randomUUID(), profile_id: id, expected_version: s.profile.version, expected_approval_version: s.approval.approval_version || 1, generated_on: f.today,
    confirm_operational: true,
    titles: [{ title_id: t.id, expected_version: t.version, document_number: "T" + String(++ordinal).padStart(8, "0"), ...(s.profile.bank === "077" ? { payment_limit_days: 30 } : {}) }],
  };
  return { ...b, preview_hash: s.approval.effective_enabled ? (await api("/remittances/preview", previewBody(b))).body.preview_hash : "a".repeat(64) };
}
const financeDigest = () =>
  scalar("select md5(jsonb_build_object('titles',(select jsonb_agg(to_jsonb(t) order by id) from erp_finance.title t),'settlements',(select jsonb_agg(to_jsonb(t) order by id) from erp_finance.settlement t),'movements',(select jsonb_agg(to_jsonb(t) order by id) from erp_finance.movement t))::text) v");
const setMembership = async (user, active) => {
  await f.db.query("update erp_access.membership set active=$2 where user_id=$1", [user, active]);
  await f.sync();
};

before(async () => {
  f = await cnabFixture();
});
after(() => f?.close());

// ---------------------------------------------------------------------------
// v1 (042)

test("042 sem aprovação não há uso operacional; a aprovação é do administrador", async () => {
  profile = await f.profile();
  const status = (await current(profile.id)).approval;
  assert.equal(status.effective_enabled, false);
  assert.deepEqual(status.issues, ["OPERATIONAL_APPROVAL_MISSING"]);
  const placeholder = {
    command_id: randomUUID(), profile_id: profile.id, expected_version: 1, expected_approval_version: 1, generated_on: f.today, confirm_operational: true,
    preview_hash: "a".repeat(64), titles: [{ title_id: randomUUID(), expected_version: 1, document_number: "TESTE" }],
  };
  await assert.rejects(() => api("/remittances", placeholder), state("40001"));
  const value = await approval(profile.id);
  approvalBody = value.body;
  assert.equal(value.result.body.approval.effective_enabled, true);
  await assert.rejects(() => api(`/profiles/${profile.id}/approval`, approvalBody), state("42501"));
  await assert.rejects(() => api("/profiles", undefined, { userId: f.users.vendas }), state("42501"));
  // Recusas do SQL (erp_cnab_operational_approve).
  const s = await current(profile.id);
  const call = (patch) =>
    f.rpc("erp_cnab_operational_approve", {
      p_user_id: f.users.admin, p_profile_id: profile.id, p_command_id: randomUUID(), p_expected_approval: s.approval.approval_version, p_expected_profile: s.profile.version,
      p_expected_identity: f.identity.version, p_enabled: true, p_confirmed_on: f.today, p_reference: "REFERENCIA SINTETICA", ...patch,
    });
  for (const [patch, code] of [
    [{ p_reference: "ab" }, "22023"],
    [{ p_reference: "a\u0001bc" }, "22023"],
    [{ p_confirmed_on: "1999-12-31" }, "22023"],
    [{ p_expected_profile: 0 }, "22023"],
    [{ p_enabled: null }, "22023"],
    [{ p_expected_approval: 0 }, "40001"],
    [{ p_expected_identity: 99 }, "40001"],
    [{ p_profile_id: randomUUID() }, "P0002"],
    [{ p_user_id: f.users.financeiro }, "42501"],
  ])
    await assert.rejects(() => call(patch), state(code), JSON.stringify(patch));
});

test("042 a prévia não grava; a geração é explícita, exata e nunca baixa título", async () => {
  firstBody = await generation(profile.id);
  const nativeBefore = await financeDigest(),
    before = await scalar("select count(*)::int v from erp_cnab.audit");
  const preview = (await api("/remittances/preview", previewBody(firstBody))).body;
  assert.equal(preview.total_cents, "12345");
  assert.equal(preview.persisted, false);
  assert.equal(preview.preview_hash, firstBody.preview_hash);
  assert.equal(preview.items[0].payer.document_mask, "*******8909");
  assert.equal((await current(profile.id)).profile.next_sequence, "1");
  assert.equal(await scalar("select count(*)::int v from erp_cnab.audit"), before);
  firstAck = (await api("/remittances", firstBody)).body;
  assert.equal(firstAck.state, "ready");
  assert.equal(firstAck.filename, "ITAU_COBRANCA_0000001.REM");
  assert.equal(firstAck.bankTransmissionPerformed, false);
  assert.equal(await financeDigest(), nativeBefore);
  const replay = (await api("/remittances", firstBody)).body;
  assert.deepEqual([replay.id, replay.replayed], [firstAck.id, true]);
  assert.equal((await current(profile.id)).profile.next_sequence, "2");
  const downloaded = await api(`/files/remittance/${firstAck.id}`, undefined, { userId: f.users.consulta });
  assert.equal(downloaded.bytes.length, 1206);
  const r = await f.rpc("erp_cnab_operational_reservation", { p_user_id: f.users.admin, p_id: firstAck.id, p_expected_approval: 1 });
  assert.equal(r.snapshot.titles[0].ourNumber, "00000001");
  assert.equal((await generateOperationalRemittance(r.snapshot)).fileHash, firstAck.file_hash);
});

test("042 homologação e operacional dividem os contadores e nunca expõem o arquivo do outro", async () => {
  const body = await generation(profile.id);
  const { expected_approval_version, confirm_operational, preview_hash, ...homologation } = body;
  const h = await f.app("/remittances", homologation);
  assert.equal(h.sequence, "2");
  const op = (await api("/remittances", await generation(profile.id))).body;
  assert.equal(op.sequence, "3");
  for (const id of [firstAck.id, op.id]) {
    await assert.rejects(() => f.rpc("erp_cnab_file", { p_user_id: f.users.consulta, p_kind: "remittance", p_id: id }), state("P0002"));
    await assert.rejects(
      () => f.rpc("erp_cnab_finalize", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_id: id, p_hash: "a".repeat(64), p_size: 1206, p_path: "x", p_manifest: [] }),
      state("P0002"),
    );
  }
  await assert.rejects(() => api(`/remittances/${h.id}/resume`, { expected_approval_version: 1 }), state("P0002"));
  await assert.rejects(() => api(`/files/remittance/${h.id}`), state("P0002"));
});

test("042 envio incerto consome o número uma vez; revogar e reconfirmar exige a aprovação atual para retomar", async () => {
  const b = await generation(profile.id),
    before = BigInt((await current(profile.id)).profile.next_sequence);
  await assert.rejects(() => api("/remittances", b, { storeFile: async () => { throw new Error("synthetic interruption"); } }), /synthetic interruption/);
  const id = await scalar("select remittance_id v from erp_cnab.billing_title where title_id=$1", [b.titles[0].title_id]);
  assert.equal((await current(profile.id)).profile.next_sequence, (before + 1n).toString());
  await approval(profile.id, false);
  await assert.rejects(() => api("/remittances", b), state("40001"));
  await assert.rejects(() => api(`/remittances/${id}/resume`, { expected_approval_version: 1 }), state("40001"));
  await assert.rejects(() => api(`/files/remittance/${firstAck.id}`), state("40001"));
  assert.equal((await api(`/profiles/${profile.id}/approval`, approvalBody, { userId: f.users.admin })).body.replayed, true);
  await approval(profile.id, true);
  await assert.rejects(() => api(`/remittances/${id}/resume`, { expected_approval_version: 1 }), state("40001"));
  const resumed = (await api(`/remittances/${id}/resume`, { expected_approval_version: 3 })).body;
  assert.deepEqual([resumed.id, resumed.state], [id, "ready"]);
  await setMembership(f.users.financeiro, false);
  try {
    await assert.rejects(() => api(`/remittances/${id}/resume`, { expected_approval_version: 3 }), state("42501"));
  } finally {
    await setMembership(f.users.financeiro, true);
  }
});

test("042 o download confere bytes e autoridade; identidade ou configuração alteradas invalidam a liberação", async () => {
  await assert.rejects(() => api(`/files/remittance/${firstAck.id}`, undefined, { getFile: async () => new Uint8Array([1]) }), (e) => e.code === "ERP_CNAB_STORED_FILE_MISMATCH");
  await assert.rejects(
    () => f.rpc("erp_cnab_operational_finalize", { p_user_id: f.users.admin, p_id: firstAck.id, p_command_id: randomUUID(), p_hash: firstAck.file_hash, p_size: firstAck.byte_size, p_path: "x", p_manifest: [], p_expected_approval: null }),
    state("22023"),
  );
  const data = await scalar("select data v from erp_company.identity where singleton");
  const version = await company();
  await f.rpc("erp_company_save_identity", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_expected_version: version, p_data: { ...data, trade_name: "EMPRESA FICTICIA ATUALIZADA" }, p_reason: "Nome fantasia sintético",
  });
  assert.ok((await current(profile.id)).approval.issues.includes("OPERATIONAL_APPROVAL_STALE"));
  await assert.rejects(() => api(`/files/remittance/${firstAck.id}`), state("40001"));
  await approval(profile.id, true);
  await assert.rejects(() => api(`/files/remittance/${firstAck.id}`), state("40001"), "o retrato guardou a identidade antiga");
  const s = await current(profile.id);
  await f.rpc("erp_cnab_approve", { p_user_id: f.users.admin, p_id: profile.id, p_expected_version: s.profile.version, p_command_id: randomUUID(), p_data: { contract_verified: false, policy_verified: true, reference: "SYNTHETIC CHANGE" } });
  assert.ok((await current(profile.id)).approval.issues.includes("BANK_CONTRACT_OR_POLICY_PENDING"));
});

test("042 Inter 112 continua com número do banco e pede aprovação própria", async () => {
  const inter = await f.profile({ bank: "077" });
  await approval(inter.id, true);
  const b = await generation(inter.id),
    r = (await api("/remittances", b)).body;
  assert.equal(r.filename, "CI400_001_0000001.REM");
  const snap = await f.rpc("erp_cnab_operational_reservation", { p_user_id: f.users.admin, p_id: r.id, p_expected_approval: 1 });
  assert.equal(snap.snapshot.titles[0].ourNumber, undefined);
});

test("042 título do Origin não entra em prévia nem reserva sem vínculo legado", async () => {
  const p = await f.profile();
  await approval(p.id);
  const b = await generation(p.id),
    t = b.titles[0].title_id;
  const command = await scalar("select id v from erp_finance.command where result->'items'->0->>'id'=$1", [t]);
  await f.db.query("insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence) values('receivables','999990042',$1,$2,'{}')", [t, command]);
  await f.sync();
  await assert.rejects(() => api("/remittances/preview", previewBody(b)), state("40001"));
  await assert.rejects(() => api("/remittances", b), state("40001"));
  assert.equal((await current(p.id)).profile.next_sequence, "1");
});

test("042 a prévia amarra o pagador e o conteúdo; confirmação vencida desfaz a reserva", async () => {
  const p = await f.profile();
  await approval(p.id);
  const b = await generation(p.id),
    before = await scalar("select count(*)::int v from erp_cnab.command");
  await f.db.query("update erp_catalog.record set name='PAGADOR FICTICIO REVISADO', version=version+1 where id=$1", [f.contact.id]);
  await f.sync();
  try {
    await assert.rejects(() => api("/remittances", b), (e) => e.code === "40001" && e.message === "erp_cnab_operational_preview_changed");
    assert.equal((await current(p.id)).profile.next_sequence, "1");
    assert.equal(await scalar("select count(*)::int v from erp_cnab.command"), before);
    const revised = (await api("/remittances/preview", previewBody(b))).body;
    assert.notEqual(revised.preview_hash, b.preview_hash);
    const ack = (await api("/remittances", { ...b, preview_hash: revised.preview_hash })).body;
    assert.equal(ack.state, "ready");
  } finally {
    await f.db.query("update erp_catalog.record set name='PAGADOR FICTICIO TESTE', version=version+1 where id=$1", [f.contact.id]);
    await f.sync();
  }
});

test("042 revogação durante o envio barra o finalize; a aprovação atual retoma a mesma sequência", async () => {
  const p = await f.profile();
  await approval(p.id);
  const b = await generation(p.id);
  await assert.rejects(() => api("/remittances", b, { storeFile: async (input) => { await f.storeFile(input); await approval(p.id, false); } }), state("40001"));
  const id = await scalar("select remittance_id v from erp_cnab.billing_title where title_id=$1", [b.titles[0].title_id]);
  assert.equal(await scalar("select state v from erp_cnab.remittance where id=$1", [id]), "reserved");
  await approval(p.id, true);
  assert.equal((await api(`/remittances/${id}/resume`, { expected_approval_version: 3 })).body.state, "ready");
  assert.equal((await current(p.id)).profile.next_sequence, "2");
});

test("042 espaço Unicode não serve de referência da autorização", async () => {
  const p = await f.profile(),
    identity = await company();
  await assert.rejects(() => approval(p.id, true, { reference: "  ﻿" }), (e) => e.status === 400);
  await assert.rejects(
    () => f.rpc("erp_cnab_operational_approve", { p_user_id: f.users.admin, p_profile_id: p.id, p_command_id: randomUUID(), p_expected_approval: 0, p_expected_profile: 1, p_expected_identity: identity, p_enabled: true, p_confirmed_on: f.today, p_reference: "  ﻿" }),
    state("22023"),
  );
  const v = await approval(p.id, true, { reference: " REFERENCIA SINTETICA " });
  assert.equal(v.result.body.approval.reference, " REFERENCIA SINTETICA ");
  assert.equal((await api(`/profiles/${p.id}/approval`, v.body, { userId: f.users.admin })).body.replayed, true);
});

// ---------------------------------------------------------------------------
// v2 (067), direto nos RPCs

const read = (id, approvalVersion = 1) => f.rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.financeiro, p_id: id, p_expected_approval: approvalVersion });
async function finalizeV2(r, approvalVersion = 1, overrides = {}) {
  const value = await read(r.id, approvalVersion),
    generated = await generateOperationalRemittanceV2(value.snapshot),
    path = `profiles/${r.profile_id}/remittances/${generated.fileHash}.rem`;
  await f.storeFile({ bucket: "brufap-cnab", path, bytes: generated.bytes, upsert: false });
  const args = {
    p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_id: r.id, p_hash: generated.fileHash, p_size: generated.bytes.length, p_path: path, p_manifest: generated.manifest,
    p_expected_approval: approvalVersion, ...overrides,
  };
  return { args, generated, result: await f.rpc("erp_cnab_operational_finalize_v2", args) };
}
const command = (id, actor = f.users.financeiro) => f.rpc("erp_cnab_operational_command_v2", { p_user_id: actor, p_command_id: id });
const preview = (args) => f.rpc("erp_cnab_operational_reserve_v2", args);
async function reserve(args, pr) {
  return f.rpc("erp_cnab_operational_reserve_v2", { ...args, p_preview: false, p_preview_hash: (pr ?? (await preview(args))).preview_hash, p_confirm_operational: true, p_confirm_encoding_profile: true });
}

test("067 aprovação observada é separada da política simples, e a prévia não reserva", async () => {
  const p = await f.profile({ simple: false });
  assert.equal(p.policy_verified, false);
  const a = await f.approveV2(p);
  assert.equal(a.approval.effective_enabled, true);
  assert.deepEqual(a.approval.allowed_encoding_profiles, [OBSERVED]);
  assert.equal((await f.rpc("erp_cnab_operational_profiles", { p_user_id: f.users.consulta })).items.find((x) => x.profile.id === p.id).approval.effective_enabled, false);
  const s = await f.selection(p, [await f.title()]),
    pr = await preview(s);
  assert.deepEqual([pr.can_reserve, pr.pending, pr.snapshot.profile.simpleCollectionPolicyVerified, pr.snapshot.titles[0].encodingTerms.dailyInterestCents], [true, [], false, "4"]);
  assert.equal(await scalar("select count(*)::int v from erp_cnab.remittance where profile_id=$1", [p.id]), 0);
  const r = await reserve(s, pr),
    fin = await finalizeV2(r);
  assert.equal(fin.result.state, "ready");
  assert.equal(fin.generated.bytes.length, 1608);
  const c = await command(s.p_command_id);
  assert.deepEqual([c.receipt.state, c.current.state, c.current.file_hash], ["reserved", "ready", fin.generated.fileHash]);
  assert.equal((await reserve(s, pr)).replayed, true);
  assert.equal(await scalar("select next_sequence::text v from erp_cnab.profile where id=$1", [p.id]), "2");
  const file = await f.rpc("erp_cnab_operational_file_v2", { p_user_id: f.users.consulta, p_id: r.id });
  assert.deepEqual([file.filename, file.encoding_profile, file.size], ["ITAU_COBRANCA_0000001.REM", OBSERVED, 1608]);
});

test("067 juros diários zero exigem confirmação por título; ids errados recusam", async () => {
  const p = await f.profile();
  await f.approveV2(p);
  const small = await f.title("1499"),
    large = await f.title("1500"),
    s = await f.selection(p, [small, large]);
  const pr = await preview(s);
  assert.deepEqual([pr.can_reserve, pr.pending], [false, [{ code: "ZERO_DAILY_FIELD_UNCONFIRMED", title_id: small.id }]]);
  await assert.rejects(() => reserve(s, pr), state("22023"));
  for (const ids of [[large.id], [randomUUID()], [small.id, small.id]]) await assert.rejects(() => preview({ ...s, p_zero_daily_title_ids: ids }), state("22023"));
  const confirmed = { ...s, p_zero_daily_title_ids: [small.id] },
    p2 = await preview(confirmed);
  assert.equal(p2.can_reserve, true);
  await assert.rejects(() => reserve(confirmed, pr), state("40001"));
  const r = await reserve(confirmed, p2),
    fin = await finalizeV2(r);
  assert.equal(fin.generated.bytes.length, 2412);
  assert.equal(fin.generated.manifest[0].encodingTerms.dailyInterestCents, "0");
});

test("067 sem seleção implícita, confirmações exatas e só o administrador aprova", async () => {
  // Como no Fagoo: perfil sem a política de cobrança simples (a sem encargos a exige).
  const p = await f.profile({ simple: false });
  for (const overrides of [
    { p_allowed_encoding_profiles: [] },
    { p_allowed_encoding_profiles: [OBSERVED, OBSERVED] },
    { p_compatibility_confirmed: false },
    { p_permanent_instructions_acknowledged: null },
    { p_allowed_encoding_profiles: [LEGACY], p_compatibility_confirmed: false, p_permanent_instructions_acknowledged: false },
  ])
    await assert.rejects(() => f.approveV2(p, [OBSERVED], overrides), undefined, JSON.stringify(overrides));
  await assert.rejects(() => f.approveV2(p, [OBSERVED], { p_user_id: f.users.financeiro }), state("42501"));
  await f.approveV2(p);
  const s = await f.selection(p, [await f.title()]);
  for (const patch of [
    { p_encoding_profile: null },
    { p_zero_daily_title_ids: null },
    { p_zero_daily_title_ids: [null] },
    { p_preview: null },
    { p_confirm_encoding_profile: null },
    { p_confirm_operational: true },
    { p_preview_hash: "a".repeat(64) },
  ])
    await assert.rejects(() => preview({ ...s, ...patch }), state("22023"), JSON.stringify(patch));
});

test("067 aprovação e termos capturados sobrevivem à reconfirmação; revogada bloqueia os bytes", async () => {
  const p = await f.profile();
  await f.approveV2(p);
  const s = await f.selection(p, [await f.title()]),
    r = await reserve(s),
    beforeSnap = (await read(r.id)).snapshot;
  await f.approveV2(p, []);
  await assert.rejects(() => read(r.id, 2), state("40001"));
  assert.equal((await command(s.p_command_id)).current.state, "reserved");
  await f.approveV2(p, [OBSERVED], { p_reference: "NEW REVIEW DOES NOT REWRITE OLD CAPTURE" });
  const value = await read(r.id, 3);
  assert.deepEqual(value.snapshot, beforeSnap);
  assert.deepEqual([value.approval_version, value.snapshot.encoding_authorization.approval_version], [3, 1]);
  await finalizeV2(r, 3);
  const c = await command(s.p_command_id);
  assert.deepEqual([c.receipt.approval_version, c.current.state], [1, "ready"]);
  await setMembership(f.users.financeiro, false);
  try {
    await assert.rejects(() => command(s.p_command_id), state("42501"));
  } finally {
    await setMembership(f.users.financeiro, true);
  }
  await assert.rejects(() => command(s.p_command_id, f.users.admin), state("P0002"));
});

test("067 manifesto com termos, dígito e tipos exatos; o objeto confere antes de ficar pronto", async () => {
  const p = await f.profile();
  await f.approveV2(p);
  const s = await f.selection(p, [await f.title()]),
    r = await reserve(s);
  const v = await read(r.id),
    g = await generateOperationalRemittanceV2(v.snapshot),
    path = `profiles/${p.id}/remittances/${g.fileHash}.rem`;
  await f.storeFile({ bucket: "brufap-cnab", path, bytes: g.bytes, upsert: false });
  const args = { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_id: r.id, p_hash: g.fileHash, p_size: g.bytes.length, p_path: path, p_manifest: g.manifest, p_expected_approval: 1 };
  for (const change of [
    (m) => { m[0].encodingTerms.dailyInterestCents = "5"; },
    (m) => { m[0].ourNumber = m[0].ourNumber.slice(0, -1) + ((Number(m[0].ourNumber.at(-1)) + 1) % 10); },
    (m) => { m[0].amountCents = 12345; },
    (m) => { m[0].x = true; },
    (m) => { delete m[0].encodingTerms; },
  ]) {
    const m = structuredClone(g.manifest);
    change(m);
    await assert.rejects(() => f.rpc("erp_cnab_operational_finalize_v2", { ...args, p_command_id: randomUUID(), p_manifest: m }));
    assert.equal((await command(s.p_command_id)).current.state, "reserved");
  }
  await assert.rejects(() => f.rpc("erp_cnab_operational_finalize_v2", { ...args, p_size: g.bytes.length + 1 }), state("40001"));
  const done = await f.rpc("erp_cnab_operational_finalize_v2", args);
  assert.equal(done.state, "ready");
  assert.equal((await f.rpc("erp_cnab_operational_finalize_v2", args)).replayed, true);
  await assert.rejects(() => f.rpc("erp_cnab_operational_finalize_v2", { ...args, p_command_id: randomUUID(), p_manifest: [] }), state("40001"));
});

test("067 v1 segue igual byte a byte; a família v2 não retoma pela v1; as duas dividem comando e contador", async () => {
  const legacy = await f.profile();
  await approval(legacy.id);
  const ack = (await api("/remittances", await generation(legacy.id))).body;
  const p = await f.profile();
  await f.approveV2(p, [LEGACY, OBSERVED]);
  const s = await f.selection(p, [await f.title()], LEGACY),
    r = await reserve(s),
    fin = await finalizeV2(r);
  assert.equal(fin.generated.bytes.length, 1206);
  assert.equal("encodingTerms" in fin.generated.manifest[0], false);
  for (const [name, args] of [["erp_cnab_operational_reservation", { p_id: r.id, p_expected_approval: 1 }], ["erp_cnab_operational_file", { p_id: r.id }]])
    await assert.rejects(() => f.rpc(name, { p_user_id: f.users.financeiro, ...args }), state("P0002"), name);
  assert.equal((await f.rpc("erp_cnab_operational_file", { p_user_id: f.users.financeiro, p_id: ack.id })).hash, ack.file_hash);
  await assert.rejects(() => f.rpc("erp_cnab_operational_file_v2", { p_user_id: f.users.financeiro, p_id: ack.id }), state("P0002"));
  const page = await f.rpc("erp_cnab_operational_files_v2", { p_user_id: f.users.consulta, p_limit: 100, p_after: null });
  assert.equal(page.items.find((x) => x.id === r.id).encoding_profile, LEGACY);
});

test("067 a aprovação perdida lê o recibo histórico, separado da aprovação atual e da permissão atual", async () => {
  const p = await f.profile(),
    a = await f.approveV2(p);
  const args = (await f.db.query("select command_id v from erp_cnab.operational_approval_revision where profile_id=$1 and version=1", [p.id])).rows[0].v;
  await f.approveV2(p, []);
  const c = await command(args, f.users.admin);
  assert.deepEqual([c.kind, c.receipt.approval.enabled, c.current.approval.enabled, c.receipt.approval.approval_version, c.current.approval.approval_version], ["approval", true, false, 1, 2]);
  assert.equal(a.approval.approval_version, 1);
  await assert.rejects(() => command(args, f.users.financeiro), state("P0002"), "o comando é do administrador");
  await assert.rejects(() => command(randomUUID()), state("P0002"));
  await assert.rejects(() => f.rpc("erp_cnab_operational_profiles_v2", { p_user_id: f.users.vendas }), state("42501"));
});

// ---------------------------------------------------------------------------
// Prévia do boleto Itaú (066)

test("066 contexto e itens da prévia do boleto, só leitura, com o arquivo e a identidade atuais", async () => {
  const p = await f.profile();
  await f.approveV2(p);
  const printed = await f.title();
  const s = await f.selection(p, [printed]),
    r = await reserve(s),
    fin = await finalizeV2(r);
  const items = await f.rpc("erp_cnab_itau_boleto_items", { p_user_id: f.users.consulta, p_remittance_id: r.id });
  assert.deepEqual([items.items.length, items.remittance_hash, items.can_pay], [1, fin.generated.fileHash, false]);
  const b = items.items[0];
  const context = await f.rpc("erp_cnab_itau_boleto_context", { p_user_id: f.users.consulta, p_billing_title_id: b.billing_title_id });
  assert.deepEqual([context.profile, context.can_pay, context.source_purpose, context.current.approval_version], ["itau109-persisted-print-preview-v2", false, "operational", 1]);
  assert.deepEqual(context.manifest[0].encodingTerms, context.snapshot.titles[0].encodingTerms);
  assert.match(context.context_hash, /^[a-f0-9]{64}$/);
  // Homologação (v1 de impressão) também lê o contexto, sem aprovação operacional.
  const h = await f.homologationRemittance(p, [await f.title()]);
  const hb = (await f.rpc("erp_cnab_itau_boleto_items", { p_user_id: f.users.consulta, p_remittance_id: h.id })).items[0];
  const hc = await f.rpc("erp_cnab_itau_boleto_context", { p_user_id: f.users.consulta, p_billing_title_id: hb.billing_title_id });
  assert.deepEqual([hc.profile, hc.current.approval_version, hc.source_purpose], ["itau109-persisted-print-preview-v1", null, "homologation"]);
  // Recusas.
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_context", { p_user_id: f.users.consulta, p_billing_title_id: null }), state("22023"));
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_context", { p_user_id: f.users.consulta, p_billing_title_id: randomUUID() }), state("P0002"));
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_items", { p_user_id: f.users.consulta, p_remittance_id: randomUUID() }), state("P0002"));
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_items", { p_user_id: f.users.vendas, p_remittance_id: r.id }), state("42501"));
  // Remessa só reservada: ainda não há boleto.
  const pending = await reserve(await f.selection(p, [await f.title()]));
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_items", { p_user_id: f.users.consulta, p_remittance_id: pending.id }), state("40001"));
  // Perfil Inter: fora da impressão Itaú.
  const inter = await f.profile({ bank: "077" });
  const ir = await f.homologationRemittance(inter, [await f.title()]);
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_items", { p_user_id: f.users.consulta, p_remittance_id: ir.id }), state("0A000"));
  // O título muda depois do arquivo: o contexto recusa.
  await f.rpc("erp_finance_execute", {
    p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: "title_update", p_data: { id: printed.id, expected_version: printed.version, description: "ALTERADO DEPOIS" },
  });
  await assert.rejects(() => f.rpc("erp_cnab_itau_boleto_context", { p_user_id: f.users.consulta, p_billing_title_id: b.billing_title_id }), state("40001"));
});
