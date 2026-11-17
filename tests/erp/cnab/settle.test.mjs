// CNAB, bloco C5: a baixa pelo retorno operacional, nos dois motores, pelas
// rotas do Fagoo (cnab-returns.mjs, /settle e /settlements, e
// itau-net-credit.mjs, /v1/retornos-itau109). Adaptados do Fagoo:
// - cnab-returns.test.mjs (043): o pagamento exato 06, a repetição, o estorno
//   que não libera o evento, o contexto que muda e as datas e referências que
//   nunca baixam;
// - itau-net-credit.test.mjs (058): o crédito líquido com tarifa em duas
//   pernas, os ajustes não aceitos, a categoria que muda, o estorno pelo plano
//   original, a resposta perdida e o espaço de comandos comum com a transferência.
// Fora, declarados: privilégios do Postgres (GRANT, RLS), gatilhos injetados
// por DDL (a falha da auditoria depois do lançamento), as escritas diretas que
// provam imutabilidade (SQL no teste), as recusas só do adaptador HTTP
// (injeção de campos, codificação, calendário do recibo) e os modelos de tela.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { cnabFixture } from "./fixture.mjs";
import { replaceField, returnFile } from "./cnab-core-fixtures.mjs";
import { executeItauNetCreditRoute, parseItauNetCreditRoute } from "../../../src/erp/fagoo/workers/erp-api/src/itau-net-credit.mjs";
import { planItau109NetCredit } from "../../../src/erp/fagoo/packages/cnab-core/src/itau-net-credit.mjs";

let f;
let ordinal = 0;
const state = (code) => (e) => e.code === code;
const scalar = (sql, args = []) => f.scalar(sql, args);
const company = () => scalar("select (select version from erp_company.identity where singleton) v");
const native = (action, data) => f.rpc("erp_finance_execute", { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const api = (path, body, extra = {}) => f.ret(path, body, extra.userId ?? f.users.financeiro, extra);
const day = (x) => x.slice(8, 10) + x.slice(5, 7) + x.slice(2, 4);
const current = (t) => f.rpc("erp_finance_get", { p_user_id: f.users.financeiro, p_entity: "titles", p_id: t });
const settlements = () => scalar("select count(*)::int v from erp_finance.settlement");

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
    titles: [{ title_id: title.id, expected_version: title.version, document_number: "S" + String(++ordinal).padStart(8, "0"), ...(bank === "inter" ? { payment_limit_days: 30 } : {}) }],
    confirm_operational: false,
  };
  const preview = (await f.op("/remittances/preview", b)).body;
  const remittance = (await f.op("/remittances", { ...b, confirm_operational: true, preview_hash: preview.preview_hash })).body;
  const reservation = await f.rpc("erp_cnab_operational_reservation", { p_user_id: f.users.admin, p_id: remittance.id, p_expected_approval: 1 });
  const account = await scalar("select account_id v from erp_cnab.profile where id=$1", [profile.id]);
  return { bank, profile, account, title, remittance, snapshot: reservation.snapshot, bt: reservation.snapshot.titles[0] };
}
function source(g, patch = {}, sequence = "00001") {
  let bytes = returnFile({
    bank: g.snapshot.profile.bank, profile: g.snapshot.profile, generatedDate: day(f.today), fileSequence: sequence,
    events: [{ control: g.bt.control, documentNumber: g.bt.documentNumber, ourNumber: g.bt.ourNumber ?? "00000000001", amount: g.bt.amountCents, paid: g.bt.amountCents, dueDate: day(f.today), occurrenceDate: day(f.today), creditDate: day(f.today), ...patch }],
  });
  // Posições oficiais do detalhe do Itaú (como no fixture do Fagoo), fora do leitor do layout.
  for (const [key, position] of Object.entries({ iof: 215, abatement: 228, discount: 241, interest: 267, otherCredits: 280 }))
    if (patch[key] !== undefined) bytes = replaceField(bytes, 2, position, String(patch[key]).padStart(13, "0"));
  return bytes;
}
async function importFile(g, bytes = source(g), extra = {}) {
  const body = { profile_id: g.profile.id, expected_approval_version: 1, command_id: randomUUID(), file_base64: Buffer.from(bytes).toString("base64"), obtained_from_bank: true, reference_id: "FICTITIOUS_BANK_DOWNLOAD", ...extra };
  const ack = (await api("/files", body)).body;
  const event = (await api(`/files/${ack.id}/events`)).body.items[0];
  return { body, bytes, ack, event };
}
const preview = async (i) => (await api(`/events/${i.event.event_id}/preview`, { file_id: i.ack.id, line: i.event.line })).body;
const command = (i, p) => ({ file_id: i.ack.id, line: i.event.line, command_id: randomUUID(), expected_approval_version: p.context.profile.approval_version, context_hash: p.context_hash, confirm: true });

// Crédito líquido do Itaú 109 (itau-net-credit.mjs).
const itauPorts = (extra = {}) => ({ userId: f.users.financeiro, rpc: (name, args) => f.rpc(name, args), storeFile: f.storeFile, getFile: f.getFile, ...extra });
function itauRequest(path, body, signal) {
  return new Request(
    "https://test.invalid/v1/retornos-itau109" + path,
    body === undefined ? { signal } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal },
  );
}
const itau = async (path, body, extra = {}, signal) => executeItauNetCreditRoute(await parseItauNetCreditRoute(itauRequest(path, body, signal)), itauPorts(extra));
const category = async () => (await native("category_save", { expected_version: 0, name: "TARIFA FICTICIA " + ++ordinal, kind: "payable" })).record;
async function setup(patch = {}) {
  const x = await prepare(),
    c = await category(),
    i = await importFile(x, source(x, { fee: "345", paid: "12000", ...patch }));
  const selection = { file_id: i.ack.id, line: i.event.line, fee_category_id: c.id, expected_fee_category_version: c.version };
  const p = (await itau(`/events/${i.event.event_id}/preview`, selection)).body;
  return { x, c, i, p, selection, command: { ...selection, command_id: randomUUID(), expected_approval_version: 1, context_hash: p.context_hash, confirm: true } };
}

before(async () => {
  f = await cnabFixture();
});
after(() => f?.close());

test("043 o pagamento exato 06 cria uma baixa; a releitura é separada; o estorno não libera o evento", async () => {
  const g = await prepare(),
    i = await importFile(g),
    count = await settlements();
  const p = await preview(i);
  assert.deepEqual([p.bytes_verified, p.context.settlement.allowed], [true, true]);
  const b = command(i, p),
    ack = (await api(`/events/${i.event.event_id}/settle`, b)).body;
  assert.deepEqual([ack.financialMutationPerformed, ack.replayed, ack.receipt.principal_cents, ack.receipt.account_id], [true, false, "12345", g.account]);
  const read = (await api(`/settlements/${b.command_id}`)).body;
  assert.deepEqual([read.current_title.status, read.current_account.balance_cents, read.current_settlement.reversed], ["paid", "12345", false]);
  assert.equal((await api(`/events/${i.event.event_id}/settle`, b)).body.replayed, true);
  assert.equal(await settlements(), count + 1);
  await assert.rejects(() => api(`/events/${i.event.event_id}/settle`, { ...b, command_id: randomUUID() }), state("40001"));
  const duplicate = await importFile(g, source(g, {}, "00002"));
  assert.equal(duplicate.event.event_id, i.event.event_id);
  await native("reverse", { id: g.title.id, expected_version: 2, settlement_id: ack.receipt.settlement_id, posted_on: f.today, note: "ESTORNO SINTETICO DE REGRESSAO" });
  const later = (await api(`/settlements/${b.command_id}`)).body;
  assert.deepEqual([later.current_title.status, later.current_settlement.reversed], ["open", true]);
  assert.deepEqual(later.receipt, ack.receipt);
  assert.equal((await api(`/events/${i.event.event_id}/settle`, b)).body.replayed, true);
  const again = await preview(duplicate);
  assert.ok(again.context.settlement.issues.includes("OPERATIONAL_PAYMENT_ALREADY_APPLIED"));
  await assert.rejects(() => api(`/events/${duplicate.event.event_id}/settle`, command(duplicate, again)), state("40001"));
});

test("043 Inter 112: o pagamento baixa depois do vínculo explícito", async () => {
  const g = await prepare("inter"),
    paid = await importFile(g),
    registration = await importFile(g, source(g, { occurrence: "02", paid: "0" }, "00002"));
  const p = await preview(registration);
  await api(`/events/${registration.event.event_id}/bind`, command(registration, p));
  const ready = await preview(paid);
  assert.equal(ready.context.settlement.allowed, true);
  const pay = (await api(`/events/${paid.event.event_id}/settle`, command(paid, ready))).body;
  assert.equal(pay.receipt.principal_cents, "12345");
  assert.equal((await current(g.title.id)).record.status, "paid");
});

test("043 título, conta e contexto alterados recusam a baixa; as recusas do SQL", async () => {
  const g = await prepare(),
    i = await importFile(g),
    p = await preview(i),
    b = command(i, p);
  await native("title_update", { id: g.title.id, expected_version: 1, description: "NOVA DESCRICAO SINTETICA" });
  await assert.rejects(() => api(`/events/${i.event.event_id}/settle`, b), state("40001"));
  assert.equal((await current(g.title.id)).record.status, "open");
  const again = await preview(i);
  assert.equal(again.context.settlement.allowed, true);
  const settle = (patch) =>
    f.rpc("erp_cnab_operational_settle", {
      p_user_id: f.users.financeiro, p_event_id: i.event.event_id, p_file_id: i.ack.id, p_line: 2, p_expected_approval: 1, p_command_id: randomUUID(),
      p_context_hash: again.context_hash, p_confirm: true, ...patch,
    });
  for (const [patch, code] of [
    [{ p_confirm: false }, "22023"],
    [{ p_command_id: null }, "22023"],
    [{ p_context_hash: "x" }, "22023"],
    [{ p_expected_approval: 0 }, "22023"],
    [{ p_expected_approval: 2 }, "40001"],
    [{ p_context_hash: "b".repeat(64) }, "40001"],
    [{ p_event_id: randomUUID() }, "P0002"],
    [{ p_line: 3 }, "P0002"],
    [{ p_user_id: f.users.consulta }, "42501"],
  ])
    await assert.rejects(() => settle(patch), state(code), JSON.stringify(patch));
  // Comando já usado pelo Financeiro (espaço de comandos comum).
  const used = await scalar("select id v from erp_finance.command limit 1");
  await assert.rejects(() => settle({ p_command_id: used }), state("40001"));
  await f.db.query("update erp_finance.account set active=false where id=$1", [g.account]);
  await f.sync();
  await assert.rejects(() => api(`/events/${i.event.event_id}/settle`, command(i, again)), state("40001"));
  assert.ok((await preview(i)).context.settlement.issues.includes("BANK_ACCOUNT_UNAVAILABLE"));
  assert.equal((await current(g.title.id)).record.version, 2);
});

test("043 baixa manual anterior e datas ou referências fora nunca baixam", async () => {
  const g = await prepare(),
    i = await importFile(g),
    settled = await native("settle", { id: g.title.id, expected_version: 1, account_id: g.account, posted_on: f.today, principal_cents: "12345" });
  await native("reverse", { id: g.title.id, expected_version: 2, settlement_id: settled.settlement.id, posted_on: f.today, note: "ESTORNO SINTETICO" });
  const p = await preview(i);
  assert.ok(p.context.settlement.issues.includes("PRIOR_SETTLEMENT_HISTORY"));
  await assert.rejects(() => api(`/events/${i.event.event_id}/settle`, command(i, p)), state("40001"));
  const next = await scalar("select((clock_timestamp() at time zone 'America/Sao_Paulo')::date+1)::text v");
  for (const patch of [{ occurrenceDate: day(next), creditDate: day(next) }, { control: "UNKNOWN-CONTROL" }]) {
    const h = await prepare(),
      j = await importFile(h, source(h, patch)),
      q = await preview(j);
    assert.equal(q.context.settlement.allowed, false, JSON.stringify(patch));
    await assert.rejects(() => api(`/events/${j.event.event_id}/settle`, command(j, q)), state("40001"));
    assert.equal((await current(h.title.id)).record.version, 1);
  }
});

test("043 permissões e bytes conferidos de novo antes da baixa", async () => {
  const g = await prepare(),
    i = await importFile(g),
    p = await preview(i),
    b = command(i, p);
  await assert.rejects(() => api(`/events/${i.event.event_id}/settle`, b, { userId: f.users.consulta }), state("42501"));
  await assert.rejects(() => api(`/events/${i.event.event_id}/settle`, b, { getFile: async () => new Uint8Array([1]) }), (e) => e.code === "ERP_CNAB_RETURN_FILE_MISMATCH");
  assert.equal((await current(g.title.id)).record.status, "open");
});

test("058 prévia, duas pernas atômicas, releitura e a categoria guardada no recibo", async () => {
  const { x, c, i, p, command: cmd } = await setup();
  assert.deepEqual([p.bytes_verified, p.context.settlement.allowed], [true, true]);
  assert.equal((await preview(i)).context.settlement.allowed, false);
  const expected = planItau109NetCredit({
    bank: "341", wallet: "109", nominal_cents: "12345", credited_cents: "12000", adjustments: p.context.base.event.adjustments, fee_category: p.context.category, expected_fee_category_version: 1,
  });
  assert.deepEqual(p.context.plan, expected);
  const ack = (await itau(`/events/${i.event.event_id}/settle`, cmd)).body;
  assert.equal(ack.replayed, false);
  assert.equal(ack.receipt.posting.fee_category.id, c.id);
  assert.deepEqual(ack.receipt.movements.map((m) => m.delta_cents), ["12345", "-345"]);
  const read = (await itau(`/commands/${cmd.command_id}`)).body;
  assert.deepEqual([read.current_title.balance_cents, read.current_settlement.net_cash_cents, read.current_account.balance_cents], ["0", "12000", "12000"]);
  assert.deepEqual(read.receipt, ack.receipt);
  assert.equal((await itau(`/events/${i.event.event_id}/settle`, cmd)).body.replayed, true);
  assert.equal(await scalar("select count(*)::int v from erp_finance.movement where settlement_id=$1", [ack.receipt.settlement_id]), 2);
  assert.equal(await scalar("select fee_cents::int v from erp_finance.cnab_cash_plan where command_id=$1", [cmd.command_id]), 345);
  assert.equal((await current(x.title.id)).record.status, "paid");
});

test("058 ajustes, encargos e categoria alterada bloqueiam sem gravar", async () => {
  for (const patch of [{ interest: "10", paid: "12010" }, { iof: "1" }, { abatement: "1" }, { discount: "1" }, { otherCredits: "1" }, { paid: "12001" }, { occurrence: "07" }]) {
    const t = await setup(patch);
    assert.equal(t.p.context.settlement.allowed, false, JSON.stringify(patch));
    await assert.rejects(() => itau(`/events/${t.i.event.event_id}/settle`, t.command), state("ERP_CONFLICT"), JSON.stringify(patch));
    assert.equal((await current(t.x.title.id)).record.settled_cents, "0");
  }
  const t = await setup();
  await native("category_save", { id: t.c.id, expected_version: 1, name: "CATEGORIA ALTERADA", kind: "payable" });
  await assert.rejects(() => itau(`/events/${t.i.event.event_id}/settle`, t.command), state("ERP_CONFLICT"));
  const changed = (await itau(`/events/${t.i.event.event_id}/preview`, t.selection)).body;
  assert.ok(changed.context.settlement.issues.includes("FEE_CATEGORY_VERSION_CHANGED"));
  assert.equal(changed.context.plan.posting, null);
  // Recusas do SQL.
  const net = (patch) =>
    f.rpc("erp_cnab_itau_net_credit_settle", {
      p_user_id: f.users.financeiro, p_event_id: t.i.event.event_id, p_file_id: t.i.ack.id, p_line: 2, p_fee_category_id: t.c.id, p_expected_fee_category_version: 2,
      p_expected_approval: 1, p_command_id: randomUUID(), p_context_hash: t.p.context_hash, p_confirm: true, ...patch,
    });
  for (const [patch, code] of [
    [{ p_confirm: false }, "22023"],
    [{ p_fee_category_id: null }, "22023"],
    [{ p_expected_fee_category_version: 0 }, "22023"],
    [{ p_context_hash: "x" }, "22023"],
    [{ p_context_hash: "c".repeat(64) }, "40001"],
    [{ p_event_id: randomUUID() }, "P0002"],
    [{ p_user_id: f.users.consulta }, "42501"],
  ])
    await assert.rejects(() => net(patch), state(code), JSON.stringify(patch));
  const pre = (patch) =>
    f.rpc("erp_cnab_itau_net_credit_preview", {
      p_user_id: f.users.financeiro, p_event_id: t.i.event.event_id, p_file_id: t.i.ack.id, p_line: 2, p_fee_category_id: t.c.id, p_expected_fee_category_version: 2, ...patch,
    });
  await assert.rejects(() => pre({ p_fee_category_id: null }), state("22023"));
  await assert.rejects(() => pre({ p_user_id: f.users.consulta }), state("42501"));
  const missing = await pre({ p_fee_category_id: randomUUID() });
  assert.deepEqual([missing.context.category, missing.context.settlement.issues.includes("FEE_CATEGORY_NOT_READY")], [null, true]);
});

test("058 o estorno segue o plano original; mudanças depois não reescrevem o recibo", async () => {
  const t = await setup(),
    ack = (await itau(`/events/${t.i.event.event_id}/settle`, t.command)).body;
  await native("category_save", { id: t.c.id, expected_version: 1, name: "NOVA CATEGORIA", kind: "payable", active: false });
  const reversed = await native("reverse", { id: t.x.title.id, expected_version: 2, settlement_id: ack.receipt.settlement_id, posted_on: f.today, note: "CORRECAO SINTETICA" });
  assert.deepEqual([reversed.account.balance_cents, reversed.record.balance_cents], ["0", "12345"]);
  const read = (await itau(`/commands/${t.command.command_id}`)).body;
  assert.deepEqual(read.receipt, ack.receipt);
  assert.equal(read.current_settlement.reversed, true);
  assert.equal((await itau(`/events/${t.i.event.event_id}/settle`, t.command)).body.replayed, true);
  await assert.rejects(() => itau(`/events/${t.i.event.event_id}/settle`, { ...t.command, command_id: randomUUID() }), state("ERP_CONFLICT"));
  // O recibo do crédito líquido não é lido pela rota da baixa simples, e vice-versa.
  await assert.rejects(() => itau(`/commands/${randomUUID()}`), state("ERP_NOT_FOUND"));
  const g = await prepare(),
    i = await importFile(g),
    p = await preview(i),
    b = command(i, p);
  await api(`/events/${i.event.event_id}/settle`, b);
  await assert.rejects(() => itau(`/commands/${b.command_id}`), state("ERP_NOT_FOUND"));
});

test("058 resposta perdida: a releitura mostra o lançamento feito uma vez", async () => {
  const t = await setup();
  let posts = 0;
  const rpc = async (name, args) => {
    const v = await f.rpc(name, args);
    if (name === "erp_cnab_itau_net_credit_settle") {
      posts++;
      throw new Error("PRIVATE_RESPONSE_SENTINEL");
    }
    return v;
  };
  await assert.rejects(() => itau(`/events/${t.i.event.event_id}/settle`, t.command, { rpc }), (e) => e.status === 503 && e.code === "ERP_RESULT_UNCONFIRMED" && !e.message.includes("PRIVATE"));
  const read = (await itau(`/commands/${t.command.command_id}`)).body;
  assert.deepEqual([read.current_account.balance_cents, posts, read.receipt.movements.length], ["12000", 1, 2]);
});

test("058 a transferência e o crédito líquido dividem o espaço de comandos", async () => {
  const t = await setup(),
    other = await f.account();
  const id = randomUUID(),
    data = { from_account_id: t.x.account, to_account_id: other.id, expected_from_version: 1, expected_to_version: 1, amount_cents: "123", posted_on: f.today, note: "TRANSFERENCIA SINTETICA", confirmed: true };
  await f.rpc("erp_finance_transfer_post", { p_user_id: f.users.financeiro, p_command_id: id, p_data: data });
  await assert.rejects(() => itau(`/events/${t.i.event.event_id}/settle`, { ...t.command, command_id: id }), (e) => e.status === 409);
  assert.equal((await current(t.x.title.id)).record.settled_cents, "0");
});
