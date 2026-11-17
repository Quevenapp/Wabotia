// CNAB, bloco C2: perfis e remessa de homologação nos dois motores, pelo app
// do Fagoo (workers/erp-api/src/cnab.mjs) sobre a fixture dupla. Adaptado do
// Fagoo workers/erp-api/test/cnab-app.test.mjs, na mesma ordem. Adaptações:
// - privilégios do Postgres (RLS, GRANT, SECURITY DEFINER) e políticas do
//   Storage: fora, declarados; sem equivalente no motor;
// - configuração do bucket (público, limite, MIME) e o adaptador real do
//   Storage: fora, declarados; vivem na camada /storage/v1 da sessão A
//   (src/erp-storage.ts, testada em tests/erp-storage.test.ts). Aqui a
//   conferência do objeto (caminho, tamanho, tipo) segue a do Fagoo;
// - o retorno (return_commit) é escrita do C4: roda no Postgres e é espelhada;
// - novo: o caminho errado no finalize e no download (objeto ausente) e a
//   exclusão da remessa reservada (213) pelo erp_cnab_remittance_exclude.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { cnabFixture, CNPJ } from "./fixture.mjs";
import { returnFile } from "./cnab-core-fixtures.mjs";

let f, itau, firstTitle, firstBody, firstResult;
const state = (code) => (error) => error.code === code;
const scalar = (sql, args = []) => f.scalar(sql, args);
const profileList = () => f.rpc("erp_cnab_profiles", { p_user_id: f.users.admin });
const currentProfile = async (id) => (await profileList()).items.find((item) => item.id === id);
const http = (path, body, extra = {}) => f.app(path, body, extra.userId ?? f.users.financeiro, extra, true);
const ITAU = { bank: "341", layout: "itau-cnab400-2017-01", agency: "0057", account: "12345", accountDigit: "7", wallet: "109" };
const INTER = { bank: "077", layout: "inter-cnab400-v2.2-2024-08-26", agency: "0001", account: "000123456", accountDigit: "7", wallet: "112" };
async function newProfile(source = ITAU, changes = {}) {
  const account = await f.account();
  const data = {
    ...source,
    cnpj: CNPJ,
    companyName: "EMPRESA FICTICIA TESTE",
    contractVerified: true,
    agreementReference: "SYNTHETIC-TEST-ONLY",
    simpleCollectionPolicyVerified: true,
    account_id: account.id,
    ourNumberStart: source.bank === "341" ? "00000001" : source.wallet === "110" ? "0000000030" : null,
    remittanceSequenceStart: "1",
    ...changes,
  };
  const result = await http("/profiles", { expected_version: 0, command_id: randomUUID(), data }, { userId: f.users.admin });
  return { ...result.body.profile, data };
}
const newTitle = (amount = "12345") => f.title(amount);
const generation = (profile, title, extra = {}) => ({
  profile_id: profile.id,
  expected_version: profile.version,
  command_id: randomUUID(),
  generated_on: f.today,
  titles: [{ title_id: title.id, expected_version: title.version, document_number: `D${Math.random().toString(16).slice(2, 10).toUpperCase()}`, ...(profile.bank === "077" ? { payment_limit_days: 30 } : {}) }],
  ...extra,
});
const day = (value) => value.slice(8, 10) + value.slice(5, 7) + value.slice(2, 4);
const titleUpdate = (title, description) =>
  f.rpc("erp_finance_execute", { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: "title_update", p_data: { id: title.id, expected_version: title.version, description } });

before(async () => {
  f = await cnabFixture();
});
after(() => f?.close());

test("papéis explícitos; o perfil só o administrador grava", async () => {
  assert.equal((await http("", null, { userId: f.users.consulta })).body.write, false);
  await assert.rejects(() => http("", null, { userId: f.users.vendas }), state("42501"));
  await assert.rejects(() => f.rpc("erp_cnab_profile_save", { p_user_id: f.users.financeiro, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: {} }), state("42501"));
});

test("perfil sem confirmação não reserva número; identidade e contadores iniciais não voltam", async () => {
  itau = await newProfile(ITAU, { contractVerified: false });
  firstTitle = await newTitle();
  await assert.rejects(() => http("/remittances", generation(itau, firstTitle)), state("40001"));
  assert.equal((await currentProfile(itau.id)).next_sequence, "1");
  const changed = { ...itau.data, contractVerified: true };
  const approved = await http("/profiles", { id: itau.id, expected_version: 1, command_id: randomUUID(), data: changed }, { userId: f.users.admin });
  itau = { ...approved.body.profile, data: changed };
  await assert.rejects(
    () => http("/profiles", { id: itau.id, expected_version: 2, command_id: randomUUID(), data: { ...changed, ourNumberStart: "00000002" } }, { userId: f.users.admin }),
    state("40001"),
  );
  // Validações do perfil (Fagoo: erp_cnab_profile_save).
  const save = (data, id = null, version = 0) => f.rpc("erp_cnab_profile_save", { p_user_id: f.users.admin, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_data: data });
  const base = { ...itau.data, account_id: (await f.account()).id, account: "54321" };
  for (const [patch, code] of [
    [{ x: 1 }, "22023"],
    [{ bank: 341 }, "22023"],
    [{ wallet: "110" }, "22023"],
    [{ agency: "0000" }, "22023"],
    [{ account: "00000" }, "22023"],
    [{ companyName: "minúsculas" }, "22023"],
    [{ contractVerified: "true" }, "22023"],
    [{ remittanceSequenceStart: "0" }, "22023"],
    [{ ourNumberStart: "00000000" }, "22023"],
    [{ ourNumberStart: 1 }, "22023"],
    [{ reservedRange: { verified: true, start: "1", end: "2" } }, "22023"],
    [{ account_id: randomUUID() }, "22023"],
    [{ account_id: "x" }, "22023"],
  ])
    await assert.rejects(() => save({ ...base, ...patch }), state(code), JSON.stringify(patch));
  await assert.rejects(() => save(base, null, 1), state("40001"));
  await assert.rejects(() => save(base, randomUUID(), 1), state("P0002"));
  await assert.rejects(() => save({ ...base, account_id: itau.account_id }, itau.id, 2), state("40001"), "a identidade não muda");
  // Mesmo comando, mesmo pedido: o recibo volta; outro pedido: conflito.
  const command = randomUUID();
  const created = await f.rpc("erp_cnab_profile_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: command, p_data: base });
  const replay = await f.rpc("erp_cnab_profile_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: command, p_data: base });
  assert.deepEqual([replay.replayed, replay.profile.id], [true, created.profile.id]);
  await assert.rejects(
    () => f.rpc("erp_cnab_profile_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: command, p_data: { ...base, companyName: "OUTRA" } }),
    state("40001"),
  );
});

test("a geração reserva uma vez, congela o retrato, confere os bytes e repete sem numerar de novo", async () => {
  firstBody = generation(itau, firstTitle);
  firstResult = await http("/remittances", firstBody);
  assert.equal(firstResult.body.state, "ready");
  assert.equal(firstResult.body.productionReady, false);
  assert.equal((await currentProfile(itau.id)).next_sequence, "2");
  const reservation = await f.rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: firstResult.body.id });
  assert.equal(reservation.snapshot.titles[0].amountCents, firstTitle.amount_cents);
  assert.equal(reservation.snapshot.titles[0].ourNumber, "00000001");
  assert.equal(reservation.snapshot.profile.accountId, itau.account_id);
  const replay = await http("/remittances", firstBody);
  assert.equal(replay.body.file_hash, firstResult.body.file_hash);
  assert.equal((await currentProfile(itau.id)).next_sequence, "2");
  const download = await http(`/files/remittance/${firstResult.body.id}`, null, { userId: f.users.consulta });
  assert.equal(download.type, "download");
  assert.equal(download.bytes.length, 1206);
  assert.equal(download.filename, "ITAU_TESTE_0000001.REM");
  assert.equal(await scalar("SELECT count(*)::int value FROM erp_finance.settlement"), 0);
});

test("queda depois da reserva mantém número e sequência; o mesmo comando retoma depois da falha de envio", async () => {
  const p = await currentProfile(itau.id),
    title = await newTitle(),
    body = generation(p, title);
  let failed = false;
  await assert.rejects(
    () => http("/remittances", body, { storeFile: async () => { failed = true; throw new Error("synthetic upload interruption"); } }),
    /synthetic upload/,
  );
  assert.equal(failed, true);
  assert.equal((await currentProfile(itau.id)).next_sequence, "3");
  const reserved = (await f.db.query("SELECT r.id,b.our_number_base FROM erp_cnab.remittance r JOIN erp_cnab.billing_title b ON b.remittance_id=r.id WHERE b.title_id=$1", [title.id])).rows[0];
  assert.equal(reserved.our_number_base, "00000002");
  await assert.rejects(async () => http("/remittances", generation(await currentProfile(itau.id), title)), state("40001"));
  const resumed = await http("/remittances", body);
  assert.equal(resumed.body.id, reserved.id);
  assert.equal(resumed.body.state, "ready");
  assert.equal((await currentProfile(itau.id)).next_sequence, "3");
});

test("bytes corrompidos e objeto fora do caminho registrado são recusados", async () => {
  await assert.rejects(() => http(`/files/remittance/${firstResult.body.id}`, null, { getFile: async () => new Uint8Array([1, 2, 3]) }), (e) => e.code === "ERP_CNAB_STORED_FILE_MISMATCH");
  const reservation = await f.rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: firstResult.body.id });
  const finalize = (patch) =>
    f.rpc("erp_cnab_finalize", {
      p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_id: reservation.id, p_hash: reservation.file_hash, p_size: reservation.byte_size, p_path: reservation.object_path,
      p_manifest: [], ...patch,
    });
  await assert.rejects(() => finalize({ p_path: `profiles/${itau.id}/remittances/${"b".repeat(64)}.rem` }), state("40001"));
  await assert.rejects(() => finalize({ p_size: reservation.byte_size + 1 }), state("40001"));
  await assert.rejects(() => finalize({ p_hash: "x" }), state("22023"));
  await assert.rejects(() => finalize({}), state("40001"), "manifesto diferente do gravado");
  await assert.rejects(() => finalize({ p_id: randomUUID() }), state("P0002"));
  for (const [kind, code] of [["x", "22023"], ["return", "P0002"]])
    await assert.rejects(() => f.rpc("erp_cnab_file", { p_user_id: f.users.consulta, p_kind: kind, p_id: reservation.id }), state(code), kind);
  const file = await f.rpc("erp_cnab_file", { p_user_id: f.users.consulta, p_kind: "remittance", p_id: reservation.id });
  assert.deepEqual([file.filename, file.size, file.path], ["ITAU_TESTE_0000001.REM", 1206, reservation.object_path]);
});

test("mudança financeira depois do envio bloqueia o finalize e não devolve o número", async () => {
  const profile = await currentProfile(itau.id),
    title = await newTitle(),
    body = generation(profile, title);
  const before = BigInt(profile.next_sequence);
  await assert.rejects(
    () => http("/remittances", body, { storeFile: async (input) => { await f.storeFile(input); await titleUpdate(title, "ALTERACAO CONCORRENTE SINTETICA"); } }),
    state("40001"),
  );
  assert.equal((await currentProfile(itau.id)).next_sequence, (before + 1n).toString());
  assert.equal(await scalar("SELECT r.state value FROM erp_cnab.remittance r JOIN erp_cnab.billing_title bt ON bt.remittance_id=r.id WHERE bt.title_id=$1", [title.id]), "reserved");
  await assert.rejects(() => http("/remittances", body), state("40001"));
});

test("outro perfil não fura a unicidade da conta trocando carteira ou beneficiário", async () => {
  await newProfile({ ...ITAU, account: "23456" });
  await assert.rejects(() => newProfile({ ...ITAU, account: "23456" }), state("23505"));
});

test("retorno com casamento exato só propõe conferência e não duplica arquivo nem evento", async () => {
  const reservation = await f.rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: firstResult.body.id }),
    title = reservation.snapshot.titles[0],
    profile = reservation.snapshot.profile;
  const event = { control: title.control, documentNumber: title.documentNumber, ourNumber: title.ourNumber, amount: title.amountCents, paid: title.amountCents, dueDate: day(f.today), occurrenceDate: day(f.today), creditDate: day(f.today) };
  const bytes = returnFile({ profile, generatedDate: day(f.today), events: [event] });
  const body = { profile_id: itau.id, command_id: randomUUID(), file_base64: Buffer.from(bytes).toString("base64"), obtained_from_bank: true, reference_id: "SYNTHETIC_BANK_DOWNLOAD" };
  const result = await http("/returns", body);
  assert.equal(result.body.new_events, 1);
  assert.equal(result.body.canSettle, false);
  const review = await http(`/returns/${result.body.id}/review`);
  assert.equal(review.body.items[0].action, "PROPOSE_SETTLEMENT_REVIEW");
  assert.equal(review.body.items[0].billing_title_id, title.id);
  assert.equal((await http("/returns", body)).body.replayed, true);
  assert.equal((await http("/returns", { ...body, command_id: randomUUID() })).body.duplicate_file, true);
  const download = await http(`/files/return/${result.body.id}`, null, { userId: f.users.consulta });
  assert.deepEqual([download.type, download.bytes.length], ["download", bytes.length]);
  assert.equal(await scalar("SELECT count(*)::int value FROM erp_finance.settlement"), 0);
});

test("Inter 112: número do banco só proposto; Inter 110: faixa esgotada nunca reusa número", async () => {
  const p = await newProfile(INTER),
    generated = await http("/remittances", generation(p, await newTitle()));
  const reservation = await f.rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: generated.body.id });
  assert.equal(reservation.snapshot.titles[0].ourNumber, undefined);
  assert.equal(reservation.snapshot.titles[0].paymentLimitDays, 30);
  const range = await newProfile({ ...INTER, wallet: "110", account: "000123457" }, { reservedRange: { verified: true, start: "0000000030", end: "0000000030" } });
  await http("/remittances", generation(range, await newTitle()));
  await assert.rejects(async () => http("/remittances", generation(await currentProfile(range.id), await newTitle())), state("40001"));
  // Inter 077 recusa título abaixo de R$ 2,50 e prazo de pagamento acima de 60 dias (o app
  // recusa antes; aqui, direto no RPC).
  const reserve = async (title, days) => {
    const g = generation(await currentProfile(p.id), title);
    return f.rpc("erp_cnab_reserve", {
      p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_profile_id: g.profile_id, p_expected_version: g.expected_version, p_generated_on: f.today,
      p_titles: [{ ...g.titles[0], payment_limit_days: days }], p_preview: true,
    });
  };
  await assert.rejects(async () => reserve(await newTitle("249"), 30), state("40001"));
  await assert.rejects(async () => reserve(await newTitle(), 61), state("22023"));
  await assert.rejects(async () => reserve(await newTitle(), 0), state("22023"));
});

test("vínculo revogado bloqueia a repetição; entradas de produção e campos privados ficam fora", async () => {
  const profiles = (await http("/profiles")).body;
  assert.doesNotMatch(JSON.stringify(profiles), /"cnpj"|"agency"|"accountDigit"|"reservedRange"/);
  await f.db.query("UPDATE erp_access.membership SET active=false WHERE user_id=$1", [f.users.financeiro]);
  await f.sync();
  try {
    await assert.rejects(() => http("/remittances", firstBody), state("42501"));
  } finally {
    await f.db.query("UPDATE erp_access.membership SET active=true WHERE user_id=$1", [f.users.financeiro]);
    await f.sync();
  }
  await assert.rejects(() => http("/remittances", { ...firstBody, purpose: "production" }), (e) => e.status === 400);
  await assert.rejects(() => http("/returns", { profile_id: itau.id, command_id: randomUUID(), file_base64: "%%%" }), (e) => e.status === 400);
  await assert.rejects(() => http(`/files/remittance/${firstResult.body.id}?path=other`), (e) => e.status === 404);
});

test("conta trocada de tipo antes do finalize recusa a remessa reservada", async () => {
  const profile = await currentProfile(itau.id),
    body = generation(profile, await newTitle());
  const kind = async (k) => {
    await f.db.query("UPDATE erp_finance.account SET kind=$2 WHERE id=$1", [itau.account_id, k]);
    await f.sync();
  };
  try {
    await assert.rejects(() => http("/remittances", body, { storeFile: async (input) => { await f.storeFile(input); await kind("cash"); } }), state("40001"));
    await assert.rejects(async () => http("/remittances", generation(await currentProfile(itau.id), await newTitle())), state("40001"));
  } finally {
    await kind("bank");
  }
});

test("a prévia confere leiaute e pagador sem reservar linha, contador ou auditoria", async () => {
  const profile = await currentProfile(itau.id),
    body = generation(profile, await newTitle());
  const counts = () => scalar("SELECT jsonb_build_array((SELECT count(*) FROM erp_cnab.remittance),(SELECT count(*) FROM erp_cnab.billing_title),(SELECT count(*) FROM erp_cnab.audit)) value");
  const before = await counts(),
    preview = await http("/remittances/preview", body);
  assert.equal(preview.body.preview, true);
  assert.equal(preview.body.total_cents, "12345");
  assert.equal(preview.body.sequence, profile.next_sequence);
  assert.equal((await currentProfile(itau.id)).next_sequence, profile.next_sequence);
  assert.deepEqual(await counts(), before);
  assert.doesNotMatch(JSON.stringify(preview.body), /cnpj|payer|agency|ourNumber/);
  const postal = async (v) => {
    await f.db.query("UPDATE erp_catalog.contact SET postal_code=$2 WHERE record_id=$1", [f.contact.id, v]);
    await f.sync();
  };
  await postal("0");
  try {
    await assert.rejects(() => http("/remittances/preview", body), (e) => e.status === 400);
    assert.deepEqual(await counts(), before);
  } finally {
    await postal("13400000");
  }
  // Recusas da reserva (Fagoo: erp_cnab.reserve_for_purpose).
  const reserve = (patch) =>
    f.rpc("erp_cnab_reserve", {
      p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_profile_id: body.profile_id, p_expected_version: body.expected_version, p_generated_on: f.today,
      p_titles: body.titles, p_preview: true, ...patch,
    });
  const t = body.titles[0];
  for (const [patch, code] of [
    [{ p_preview: null }, "22023"],
    [{ p_titles: [] }, "22023"],
    [{ p_titles: { x: 1 } }, "22023"],
    [{ p_titles: [t, t] }, "22023"],
    [{ p_titles: [{ ...t, title_id: "x" }] }, "22023"],
    [{ p_titles: [{ ...t, extra: 1 }] }, "22023"],
    [{ p_titles: [{ ...t, document_number: "minúscula" }] }, "22023"],
    [{ p_titles: [{ ...t, payment_limit_days: 30 }] }, "22023"],
    [{ p_titles: [{ ...t, expected_version: 9 }] }, "40001"],
    [{ p_titles: [{ ...t, title_id: randomUUID() }] }, "P0002"],
    [{ p_generated_on: "2099-01-01" }, "22023"],
    [{ p_expected_version: 999 }, "40001"],
    [{ p_profile_id: randomUUID() }, "P0002"],
  ])
    await assert.rejects(() => reserve(patch), state(code), JSON.stringify(patch));
  await assert.rejects(() => reserve({ p_titles: [{ ...t, document_number: firstBody.titles[0].document_number }] }), state("40001"), "número de documento já usado no perfil");
  await assert.rejects(() => reserve({ p_user_id: f.users.consulta }), state("42501"));
});

test("lista paginada só com metadados seguros; comando perdido retoma pela reserva", async () => {
  const profile = await currentProfile(itau.id),
    body = generation(profile, await newTitle());
  await assert.rejects(() => http("/remittances", body, { storeFile: async () => { throw new Error("synthetic crash"); } }), /synthetic crash/);
  const reservation = await scalar("SELECT remittance_id value FROM erp_cnab.billing_title WHERE title_id=$1", [body.titles[0].title_id]);
  const first = (await http("/remittances?limit=1")).body;
  assert.equal(first.items.length, 1);
  assert.equal(first.has_more, true);
  assert.doesNotMatch(JSON.stringify(first), /snapshot|cnpj|object_path|payer/);
  const second = (await http(`/remittances?limit=1&after=${first.next_cursor}`)).body;
  assert.notEqual(first.items[0].id, second.items[0].id);
  const counter = (await currentProfile(itau.id)).next_sequence;
  const resumed = await http(`/remittances/${reservation}/resume`, {});
  assert.equal(resumed.body.state, "ready");
  assert.equal((await currentProfile(itau.id)).next_sequence, counter);
  const otherUser = await http(`/remittances/${reservation}/resume`, {}, { userId: f.users.admin });
  assert.equal(otherUser.body.file_hash, resumed.body.file_hash);
  await assert.rejects(() => http(`/remittances/${reservation}/resume`, {}, { userId: f.users.consulta }), state("42501"));
});

test("aprovação administrativa com versão e recibo; revogar antes do finalize bloqueia a geração", async () => {
  let profile = await currentProfile(itau.id);
  const data = { contract_verified: false, policy_verified: false, reference: "SYNTHETIC_REVIEW" };
  const body = { expected_version: profile.version, command_id: randomUUID(), data };
  await assert.rejects(() => http(`/profiles/${profile.id}/approval`, body), state("42501"));
  const approved = await http(`/profiles/${profile.id}/approval`, body, { userId: f.users.admin });
  assert.equal(approved.body.profile.contract_verified, false);
  assert.equal((await http(`/profiles/${profile.id}/approval`, body, { userId: f.users.admin })).body.replayed, true);
  await assert.rejects(() => http(`/profiles/${profile.id}/approval`, { ...body, command_id: randomUUID() }, { userId: f.users.admin }), state("40001"));
  const approve = (patch) => f.rpc("erp_cnab_approve", { p_user_id: f.users.admin, p_id: profile.id, p_expected_version: profile.version, p_command_id: randomUUID(), p_data: data, ...patch });
  profile = await currentProfile(itau.id);
  for (const [patch, code] of [
    [{ p_data: { ...data, contract_verified: "sim" } }, "22023"],
    [{ p_data: { ...data, reference: " " } }, "22023"],
    [{ p_data: { ...data, range_verified: true } }, "22023"],
    [{ p_data: { ...data, x: 1 } }, "22023"],
    [{ p_id: randomUUID() }, "P0002"],
  ])
    await assert.rejects(() => approve(patch), state(code), JSON.stringify(patch));
  const allow = async () => {
    profile = await currentProfile(itau.id);
    await http(`/profiles/${profile.id}/approval`, { expected_version: profile.version, command_id: randomUUID(), data: { ...data, contract_verified: true, policy_verified: true } }, { userId: f.users.admin });
  };
  await allow();
  profile = await currentProfile(itau.id);
  await assert.rejects(
    async () =>
      http("/remittances", generation(profile, await newTitle()), {
        storeFile: async (input) => {
          await f.storeFile(input);
          const current = await currentProfile(itau.id);
          await http(`/profiles/${current.id}/approval`, { expected_version: current.version, command_id: randomUUID(), data }, { userId: f.users.admin });
        },
      }),
    state("40001"),
  );
  await allow();
});

test("213 excluir a remessa reservada: só sem arquivo, os títulos voltam e o último número retorna", async () => {
  const profile = await currentProfile(itau.id),
    title = await newTitle(),
    body = generation(profile, title);
  await assert.rejects(() => http("/remittances", body, { storeFile: async () => { throw new Error("synthetic crash"); } }), /synthetic crash/);
  const id = await scalar("SELECT remittance_id value FROM erp_cnab.billing_title WHERE title_id=$1", [title.id]);
  const sequence = await scalar("SELECT sequence::text value FROM erp_cnab.remittance WHERE id=$1", [id]);
  const exclude = (data, user = f.users.financeiro, command = randomUUID()) => f.rpc("erp_cnab_remittance_exclude", { p_user_id: user, p_command_id: command, p_data: data });
  await assert.rejects(() => exclude({ id: firstResult.body.id, sequence: "1" }), state("40001"), "remessa com arquivo fica");
  await assert.rejects(() => exclude({ id, sequence }, f.users.consulta), state("42501"));
  await assert.rejects(() => exclude({ id, sequence: "9999" }), state("40001"), "o número visto na lista precisa ser o atual");
  await assert.rejects(() => exclude({ id }), state("40001"));
  await assert.rejects(() => exclude({ id, sequence, x: 1 }), state("22023"));
  await assert.rejects(() => exclude(null), state("22023"));
  await assert.rejects(() => exclude({ id: randomUUID(), sequence }), state("P0002"));
  const command = randomUUID();
  const done = await exclude({ id, sequence }, f.users.financeiro, command);
  assert.deepEqual(done.record, { id, sequence, titles: 1, released_sequence: true });
  assert.equal((await exclude({ id, sequence }, f.users.financeiro, command)).replayed, true);
  assert.equal(await scalar("SELECT next_sequence::text value FROM erp_cnab.profile WHERE id=$1", [itau.id]), sequence);
  assert.equal(await scalar("SELECT count(*)::int value FROM erp_cnab.billing_title WHERE title_id=$1", [title.id]), 0, "o título saiu da remessa");
  assert.equal(await scalar("SELECT jsonb_array_length(titles)::int value FROM erp_cnab.remittance_exclusion WHERE remittance_id=$1", [id]), 1);
  // O título volta a ser candidato e entra numa nova remessa com o mesmo número.
  const again = await http("/remittances", generation(await currentProfile(itau.id), { ...title }));
  assert.equal(again.body.sequence, sequence);
});
