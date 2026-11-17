// CNAB, bloco C4: retornos sem baixa, nos dois motores, pelas rotas do Fagoo
// (cnab-returns.mjs e cnab-review.mjs). Adaptados do Fagoo:
// - cnab-returns.test.mjs (043): importação, prévia, vínculo do Inter 112 e as
//   recusas. A baixa (/settle, erp_cnab_operational_settle) é o C5: aqui fica
//   só o que a prévia diz (settlement.allowed e issues), sem chamar a baixa;
// - cnab-review-app.test.mjs (024): a conferência humana pelo app, com a
//   releitura dos bytes, o recibo e o contexto que muda.
// Fora, declarados: privilégios do Postgres (GRANT, RLS), gatilhos injetados
// por DDL e as escritas diretas que provam imutabilidade (SQL no teste), e os
// modelos de tela (apps/erp).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { cnabFixture } from "./fixture.mjs";
import { replaceField, returnFile } from "./cnab-core-fixtures.mjs";

let f;
let ordinal = 0;
const state = (code) => (e) => e.code === code;
const scalar = (sql, args = []) => f.scalar(sql, args);
const company = () => scalar("select (select version from erp_company.identity where singleton) v");
const native = (action, data) => f.rpc("erp_finance_execute", { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const api = (path, body, extra = {}) => f.ret(path, body, extra.userId ?? f.users.financeiro, extra);
const day = (x) => x.slice(8, 10) + x.slice(5, 7) + x.slice(2, 4);
const current = (t) => f.rpc("erp_finance_get", { p_user_id: f.users.financeiro, p_entity: "titles", p_id: t });

/** Perfil aprovado (v1), um título e a remessa operacional pronta. */
async function prepare(bank = "itau") {
  const profile = await f.profile({ bank: bank === "itau" ? "341" : "077" });
  const s = (await f.op("/profiles")).body.items.find((x) => x.profile.id === profile.id);
  await f.op(
    `/profiles/${profile.id}/approval`,
    {
      command_id: randomUUID(), expected_approval_version: s.approval.approval_version, expected_profile_version: s.profile.version,
      expected_identity_version: await company(), enabled: true, confirmed_on: f.today, reference: "SYNTHETIC AUTHORIZATION ONLY",
    },
    f.users.admin,
  );
  const title = await f.title();
  const b = {
    command_id: randomUUID(), profile_id: profile.id, expected_version: s.profile.version, expected_approval_version: 1, generated_on: f.today,
    titles: [{ title_id: title.id, expected_version: title.version, document_number: "F" + String(++ordinal).padStart(8, "0"), ...(bank === "inter" ? { payment_limit_days: 30 } : {}) }],
    confirm_operational: false,
  };
  const preview = (await f.op("/remittances/preview", b)).body;
  const remittance = (await f.op("/remittances", { ...b, confirm_operational: true, preview_hash: preview.preview_hash })).body;
  const reservation = await f.rpc("erp_cnab_operational_reservation", { p_user_id: f.users.admin, p_id: remittance.id, p_expected_approval: 1 });
  return { bank, profile, title, remittance, snapshot: reservation.snapshot, bt: reservation.snapshot.titles[0] };
}
function source(g, patch = {}, sequence = "00001") {
  return returnFile({
    bank: g.snapshot.profile.bank, profile: g.snapshot.profile, generatedDate: day(f.today), fileSequence: sequence,
    events: [{ control: g.bt.control, documentNumber: g.bt.documentNumber, ourNumber: g.bt.ourNumber ?? "00000000001", amount: g.bt.amountCents, paid: g.bt.amountCents, dueDate: day(f.today), occurrenceDate: day(f.today), creditDate: day(f.today), ...patch }],
  });
}
async function importFile(g, bytes = source(g), extra = {}) {
  const body = { profile_id: g.profile.id, expected_approval_version: 1, command_id: randomUUID(), file_base64: Buffer.from(bytes).toString("base64"), obtained_from_bank: true, reference_id: "FICTITIOUS_BANK_DOWNLOAD", ...extra };
  const ack = (await api("/files", body)).body;
  const event = (await api(`/files/${ack.id}/events`)).body.items[0];
  return { body, bytes, ack, event };
}
const preview = async (i) => (await api(`/events/${i.event.event_id}/preview`, { file_id: i.ack.id, line: i.event.line })).body;
const command = (i, p) => ({ file_id: i.ack.id, line: i.event.line, command_id: randomUUID(), expected_approval_version: p.context.profile.approval_version, context_hash: p.context_hash, confirm: true });

before(async () => {
  f = await cnabFixture();
});
after(() => f?.close());

test("043 importação e prévia não lançam nada; o arquivo repetido não cria evento", async () => {
  const g = await prepare(),
    i = await importFile(g),
    before = await scalar("select count(*)::int v from erp_finance.settlement");
  const p = await preview(i);
  assert.deepEqual([p.bytes_verified, p.context.settlement.allowed, p.context.binding.allowed], [true, true, false]);
  assert.equal(await scalar("select count(*)::int v from erp_finance.settlement"), before);
  assert.ok((await api("/files")).body.items.some((x) => x.id === i.ack.id));
  assert.equal((await api("/files", i.body)).body.replayed, true);
  const duplicate = await importFile(g, source(g, {}, "00002"));
  assert.deepEqual([duplicate.ack.new_events, duplicate.ack.duplicate_events, duplicate.event.event_id], [0, 1, i.event.event_id]);
  const file = await f.rpc("erp_cnab_operational_return_file", { p_user_id: f.users.consulta, p_file_id: i.ack.id });
  assert.deepEqual([file.filename, file.approval_version], [`RETORNO_${i.ack.id}.RET`, 1]);
});

test("043 Inter 112: o registro pede vínculo explícito; o pagamento não inventa nem repete número", async () => {
  const g = await prepare("inter"),
    paid = await importFile(g),
    before = await preview(paid);
  assert.equal(before.context.settlement.allowed, false);
  assert.ok(before.context.settlement.issues.includes("BANK_NUMBER_NOT_MATCHED"));
  const registration = await importFile(g, source(g, { occurrence: "02", paid: "0" }, "00002")),
    p = await preview(registration);
  assert.equal(p.context.binding.allowed, true);
  const b = command(registration, p),
    ack = (await api(`/events/${registration.event.event_id}/bind`, b)).body;
  assert.equal(ack.our_number, "00000000001");
  assert.equal((await api(`/events/${registration.event.event_id}/bind`, b)).body.replayed, true);
  assert.equal((await current(g.title.id)).record.status, "open");
  assert.equal((await preview(paid)).context.settlement.allowed, true);
  // O mesmo número não vai para outro título do perfil.
  const title = await f.title();
  const s = (await f.op("/profiles")).body.items.find((x) => x.profile.id === g.profile.id);
  const body = {
    command_id: randomUUID(), profile_id: g.profile.id, expected_version: s.profile.version, expected_approval_version: 1, generated_on: f.today,
    titles: [{ title_id: title.id, expected_version: title.version, document_number: "SEGUNDO", payment_limit_days: 30 }], confirm_operational: false,
  };
  const pre = (await f.op("/remittances/preview", body)).body,
    r = (await f.op("/remittances", { ...body, confirm_operational: true, preview_hash: pre.preview_hash })).body;
  const snap = await f.rpc("erp_cnab_operational_reservation", { p_user_id: f.users.admin, p_id: r.id, p_expected_approval: 1 });
  const second = { ...g, title, snapshot: snap.snapshot, bt: snap.snapshot.titles[0] };
  const j = await importFile(second, source(second, { occurrence: "02", paid: "0" }, "00003")),
    q = await preview(j);
  assert.ok(q.context.binding.issues.includes("BANK_NUMBER_ALREADY_USED"));
  await assert.rejects(() => api(`/events/${j.event.event_id}/bind`, command(j, q)), state("40001"));
  for (const patch of [{ occurrence: "07", paid: "0", creditDate: "000000" }, { paid: "12500" }]) {
    const next = await importFile(g, source(g, patch, patch.occurrence ? "00004" : "00005")),
      review = await preview(next);
    assert.equal(review.context.settlement.allowed, false);
    assert.ok(review.context.settlement.issues.includes(patch.occurrence ? "EXACT_PAYMENT_06_REQUIRED" : "TRAILER_AGGREGATE_AMBIGUOUS"));
  }
});

test("043 título, conta e contexto alterados mudam a prévia; o vínculo recusa hash e confirmação errados", async () => {
  const g = await prepare("inter"),
    i = await importFile(g, source(g, { occurrence: "02", paid: "0" })),
    p = await preview(i),
    b = command(i, p);
  await native("title_update", { id: g.title.id, expected_version: 1, description: "NOVA DESCRICAO SINTETICA" });
  await assert.rejects(() => api(`/events/${i.event.event_id}/bind`, b), state("40001"));
  const bind = (patch) =>
    f.rpc("erp_cnab_operational_bind", {
      p_user_id: f.users.financeiro, p_event_id: i.event.event_id, p_file_id: i.ack.id, p_line: 2, p_expected_approval: 1, p_command_id: randomUUID(),
      p_context_hash: p.context_hash, p_confirm: true, ...patch,
    });
  for (const [patch, code] of [
    [{ p_confirm: false }, "22023"],
    [{ p_context_hash: "x" }, "22023"],
    [{ p_expected_approval: 0 }, "22023"],
    [{ p_expected_approval: 2 }, "40001"],
    [{ p_event_id: randomUUID() }, "P0002"],
    [{ p_line: 3 }, "P0002"],
    [{ p_user_id: f.users.consulta }, "42501"],
  ])
    await assert.rejects(() => bind(patch), state(code), JSON.stringify(patch));
  const account = await scalar("select account_id v from erp_cnab.profile where id=$1", [g.profile.id]);
  await f.db.query("update erp_finance.account set active=false where id=$1", [account]);
  await f.sync();
  assert.ok((await f.rpc("erp_cnab_operational_event", { p_user_id: f.users.consulta, p_event_id: i.event.event_id, p_file_id: i.ack.id, p_line: 2 })).context.settlement.issues.includes("BANK_ACCOUNT_UNAVAILABLE"));
});

test("043 diferenças, tarifas, parciais e baixas do banco ficam pendentes", async () => {
  for (const patch of [{ paid: "12344" }, { fee: "1" }, { occurrence: "07" }, { occurrence: "09" }, { creditDate: "000000" }]) {
    const g = await prepare(),
      i = await importFile(g, source(g, patch)),
      p = await preview(i);
    assert.equal(p.context.settlement.allowed, false, JSON.stringify(patch));
  }
});

test("043 bytes e permissões conferidos de novo; as rotas de homologação não leem o retorno operacional", async () => {
  const g = await prepare(),
    i = await importFile(g);
  await assert.rejects(() => api(`/events/${i.event.event_id}/preview`, { file_id: i.ack.id, line: 2 }, { getFile: async () => new Uint8Array([1]) }), (e) => e.code === "ERP_CNAB_RETURN_FILE_MISMATCH");
  await assert.rejects(() => api("/files", undefined, { userId: f.users.vendas }), state("42501"));
  await assert.rejects(() => f.app(`/files/return/${i.ack.id}`), state("P0002"));
  await assert.rejects(() => f.app(`/returns/${i.ack.id}/review`), state("P0002"));
  const file = await api(`/files/${i.ack.id}/download`);
  assert.deepEqual(file.bytes, i.bytes);
  assert.equal((await api(`/events/${i.event.event_id}?file_id=${i.ack.id}&line=2`, undefined, { userId: f.users.consulta })).body.bytes_verified, false);
  await assert.rejects(() => api(`/events/${i.event.event_id}/preview`, { file_id: i.ack.id, line: 2 }, { userId: f.users.consulta }), state("42501"));
});

test("043 banco, conta ou beneficiário diferentes são recusados antes de gravar", async () => {
  const g = await prepare(),
    valid = source(g),
    count = await scalar("select count(*)::int v from erp_cnab.return_file");
  for (const [pos, value] of [[24, "99999"], [4, "00000000000000"], [83, "110"], [94, "X"]])
    await assert.rejects(() => importFile(g, replaceField(valid, 2, pos, value)), (e) => e.status === 400 && e.code.startsWith("CNAB_"));
  assert.equal(await scalar("select count(*)::int v from erp_cnab.return_file"), count);
});

test("043 baixa manual anterior bloqueia mesmo estornada; título importado do Origin pede vínculo próprio", async () => {
  const g = await prepare(),
    i = await importFile(g);
  const settled = await native("settle", { id: g.title.id, expected_version: 1, account_id: await scalar("select account_id v from erp_cnab.profile where id=$1", [g.profile.id]), posted_on: f.today, principal_cents: "12345" });
  await native("reverse", { id: g.title.id, expected_version: 2, settlement_id: settled.settlement.id, posted_on: f.today, note: "ESTORNO SINTETICO" });
  assert.ok((await preview(i)).context.settlement.issues.includes("PRIOR_SETTLEMENT_HISTORY"));
  const h = await prepare(),
    j = await importFile(h);
  const createCommand = await scalar("select id v from erp_finance.command where result->'items'->0->>'id'=$1", [h.title.id]);
  await f.db.query("insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence) values('receivables',$1,$2,$3,'{}')", [String(900000 + ordinal), h.title.id, createCommand]);
  await f.sync();
  assert.ok((await preview(j)).context.settlement.issues.includes("LEGACY_BANK_BINDING_REQUIRED"));
});

test("043 datas futuras ou anteriores à emissão e referências desconhecidas nunca liberam baixa", async () => {
  const next = await scalar("select((clock_timestamp() at time zone 'America/Sao_Paulo')::date+1)::text v"),
    prior = await scalar("select((clock_timestamp() at time zone 'America/Sao_Paulo')::date-1)::text v");
  for (const patch of [{ occurrenceDate: day(next), creditDate: day(next) }, { occurrenceDate: day(prior), creditDate: day(prior) }, { control: "UNKNOWN-CONTROL" }, { documentNumber: "UNKNOWN" }]) {
    const g = await prepare(),
      i = await importFile(g, source(g, patch)),
      p = await preview(i);
    assert.equal(p.context.settlement.allowed, false, JSON.stringify(patch));
  }
});

test("043 arquivo vazio e evento repetido: paginação limitada e identidades exatas", async () => {
  const g = await prepare("inter"),
    empty = returnFile({ bank: "077", profile: g.snapshot.profile, generatedDate: day(f.today), events: [] });
  const body = { profile_id: g.profile.id, expected_approval_version: 1, command_id: randomUUID(), file_base64: Buffer.from(empty).toString("base64"), obtained_from_bank: true, reference_id: "SYNTHETIC_EMPTY" };
  const ack = (await api("/files", body)).body;
  const blank = (await api(`/files/${ack.id}/events`)).body;
  assert.deepEqual([blank.items, blank.has_more], [[], false]);
  const e = { control: g.bt.control, documentNumber: g.bt.documentNumber, ourNumber: "00000000001", amount: "12345", paid: "0", occurrence: "02", dueDate: day(f.today), occurrenceDate: day(f.today), creditDate: "000000" };
  const twice = await importFile(g, returnFile({ bank: "077", profile: g.snapshot.profile, generatedDate: day(f.today), events: [e, e] }));
  assert.deepEqual([twice.ack.new_events, twice.ack.duplicate_events], [1, 1]);
  const first = (await api(`/files/${twice.ack.id}/events?limit=1`)).body,
    last = (await api(`/files/${twice.ack.id}/events?limit=1&after=${first.next_cursor}`)).body;
  assert.deepEqual([first.items[0].event_id, last.items[0].duplicate, last.has_more], [last.items[0].event_id, true, false]);
  assert.doesNotMatch(JSON.stringify(first), /payer|cnpj|object_path|payload|accountDigit/);
});

test("043 a evidência de homologação não vira operacional nem é lida pelas rotas operacionais", async () => {
  const g = await prepare(),
    data = source(g, { control: "HOMO-UNMATCHED", documentNumber: "HOMO" });
  const old = await f.app("/returns", { profile_id: g.profile.id, command_id: randomUUID(), file_base64: Buffer.from(data).toString("base64"), obtained_from_bank: true, reference_id: "FICTITIOUS_HOMO" });
  const event = await scalar("select event_id v from erp_cnab.return_occurrence where file_id=$1", [old.id]),
    count = await scalar("select count(*)::int v from erp_cnab.return_file");
  await assert.rejects(() => importFile(g, data), state("40001"));
  assert.equal(await scalar("select count(*)::int v from erp_cnab.return_file"), count);
  for (const path of [`/files/${old.id}/events`, `/files/${old.id}/download`, `/events/${event}?file_id=${old.id}&line=2`]) await assert.rejects(() => api(path), state("P0002"), path);
  await assert.rejects(() => api(`/events/${event}/preview`, { file_id: old.id, line: 2 }), state("P0002"));
});

test("043 falha no envio não deixa arquivo nem comando; a repetição mantém a identidade", async () => {
  const g = await prepare(),
    data = source(g);
  const body = { profile_id: g.profile.id, expected_approval_version: 1, command_id: randomUUID(), file_base64: Buffer.from(data).toString("base64"), obtained_from_bank: true, reference_id: "SYNTHETIC_RETRY" };
  const count = await scalar("select count(*)::int v from erp_cnab.return_file");
  await assert.rejects(() => api("/files", body, { storeFile: async () => { throw new Error("SYNTHETIC_STORAGE_FAILURE"); } }), /SYNTHETIC_STORAGE_FAILURE/);
  assert.equal(await scalar("select count(*)::int v from erp_cnab.return_file"), count);
  assert.equal(await scalar("select count(*)::int v from erp_cnab.command where id=$1", [body.command_id]), 0);
  const ack = (await api("/files", body)).body;
  assert.equal((await api("/files", body)).body.id, ack.id);
  assert.equal(await scalar("select count(*)::int v from erp_cnab.return_file"), count + 1);
  // Recusas do SQL do commit operacional.
  const commit = (patch) =>
    f.rpc("erp_cnab_operational_return_commit", {
      p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_profile_id: g.profile.id, p_expected_approval: 1,
      p_file: { hash: "a".repeat(64), size: 10, path: "x", generated_on: f.today, century: 2000, record_count: 2, warnings: [], evidence: {} }, p_events: [], ...patch,
    });
  await assert.rejects(() => commit({ p_expected_approval: 0 }), state("22023"));
  await assert.rejects(() => commit({ p_events: {} }), state("22023"));
  await assert.rejects(() => commit({ p_file: { x: 1 } }), state("22023"));
  await assert.rejects(() => commit({}), state("40001"), "objeto ausente");
  await assert.rejects(() => commit({ p_profile_id: randomUUID() }), state("P0002"));
});

test("043 o principal alterado no Financeiro não reinterpreta a remessa original", async () => {
  const g = await prepare();
  await native("title_update", { id: g.title.id, expected_version: 1, amount_cents: "23456" });
  const i = await importFile(g, source(g, { amount: "23456", paid: "23456" })),
    p = await preview(i);
  assert.deepEqual([p.context.title.amount_cents, p.context.event.amount_cents], ["23456", "23456"]);
  assert.ok(p.context.settlement.issues.includes("REMITTANCE_SNAPSHOT_DIFFERS"));
  assert.equal(p.context.settlement.allowed, false);
});

test("024 conferência humana pelo app: prévia relê os bytes, revisão atômica e idempotente, contexto que muda", async () => {
  const g = await f.profile();
  const t = await f.title("12345", "2026-12-30");
  const r = await f.homologationRemittance(g, [t]);
  const bt = (await f.rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: r.id })).snapshot.titles[0];
  const d = f.ddmmyy(f.today);
  const imported = await f.homologationReturn(g, [{ control: bt.control, documentNumber: bt.documentNumber, ourNumber: bt.ourNumber, amount: bt.amountCents, paid: bt.amountCents, dueDate: f.ddmmyy(bt.dueOn), occurrenceDate: d, creditDate: d }]);
  const event = (await f.review(`/files/${imported.id}`)).items[0].event_id;
  const verified = await f.review(`/events/${event}/preview`, { file_id: imported.id, line: 2 });
  assert.equal(verified.bytes_verified, true);
  await assert.rejects(() => f.review(`/events/${event}/preview`, { file_id: imported.id, line: 2 }, f.users.financeiro, { getFile: async () => new Uint8Array([1]) }));
  const detail = await f.review(`/events/${event}?file_id=${imported.id}&line=2`);
  const body = { file_id: imported.id, line: 2, command_id: randomUUID(), expected_review_version: 0, expected_context_hash: detail.context_hash, status: "confirmed", reason: "Conferência fictícia de homologação." };
  assert.equal((await f.review(`/events/${event}/review`, body)).record.status, "confirmed");
  assert.equal((await f.review(`/events/${event}/review`, body)).replayed, true);
  await assert.rejects(() => f.review(`/events/${event}/review`, { ...body, command_id: randomUUID() }), state("40001"), "a versão esperada já passou");
  // Recusas do SQL.
  const save = (patch) =>
    f.rpc("erp_cnab_human_review_save", {
      p_user_id: f.users.financeiro, p_event_id: event, p_file_id: imported.id, p_line: 2, p_command_id: randomUUID(), p_expected_review_version: 1,
      p_expected_context_hash: detail.context_hash, p_status: "pending_issue", p_reason: "Motivo sintético", ...patch,
    });
  for (const [patch, code] of [
    [{ p_status: "x" }, "22023"],
    [{ p_reason: "ab" }, "22023"],
    [{ p_reason: "a\u0001bc" }, "22023"],
    [{ p_line: 1 }, "22023"],
    [{ p_expected_context_hash: "x" }, "22023"],
    [{ p_expected_context_hash: "b".repeat(64) }, "40001"],
    [{ p_event_id: randomUUID() }, "P0002"],
    [{ p_user_id: f.users.consulta }, "42501"],
  ])
    await assert.rejects(() => save(patch), state(code), JSON.stringify(patch));
  // Espaço Unicode nas pontas do motivo: o SQL guarda com btrim (só espaço comum) e a repetição devolve o recibo.
  const unicode = { ...body, command_id: randomUUID(), expected_review_version: 1, reason: " Motivo com espaço Unicode " };
  const saved = await f.review(`/events/${event}/review`, unicode);
  assert.equal(saved.record.reason, " Motivo com espaço Unicode ");
  assert.equal((await f.review(`/events/${event}/review`, unicode)).replayed, true);
  // O título baixado à parte muda o contexto: a prévia antiga não grava.
  await native("title_update", { id: t.id, expected_version: t.version, description: "ALTERADO NA CONFERENCIA" });
  await assert.rejects(() => f.review(`/events/${event}/review`, { ...body, command_id: randomUUID(), expected_review_version: 2 }), state("40001"));
  // Excluir o retorno com conferência: recusado (ocorrência aplicada).
  await assert.rejects(() => f.rpc("erp_cnab_return_exclude", { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_data: { id: imported.id } }), state("40001"));
});
