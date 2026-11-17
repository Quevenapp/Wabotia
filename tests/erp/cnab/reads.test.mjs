// CNAB, bloco C1: leituras de homologação, do operacional e da conferência
// humana, nos dois motores. Os dados vêm pelas escritas do Fagoo (perfil,
// aprovação, reserva, remessa e retorno de homologação pelo app cnab.mjs),
// que ainda rodam no Postgres e são espelhadas. Adaptados do Fagoo:
// - cnab-app.test.mjs: perfis, remessa e retorno de homologação, review e paginação;
// - cnab-review-app.test.mjs: lista, detalhe e histórico da conferência humana, contexto alterado;
// - cnab-operational-v2-sql.test.mjs: perfis e aprovação v2, reserva v2 e leituras discriminadas (v1 × v2);
// - cnab-operational.test.mjs: aprovação e reserva v1, eventos e baixa operacional (só as leituras).
// Fora, declarados: as escritas (C2 a C4), os bytes do arquivo e o Storage, a
// baixa (C5) e erp_itau_legacy_readiness (rota externa: depende do Origin).
// erp_cnab_operational_settlement_get com baixa existente lê erp_finance.dto,
// que o Financeiro (O) ainda não exportou: aqui só o caminho sem baixa.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { cnabFixture, LEGACY, OBSERVED } from "./fixture.mjs";

let f;
before(async () => {
  f = await cnabFixture();
});
after(() => f?.close());
/** Código do erro (o f.rpc já conferiu que os dois motores recusam igual). */
const code = (p) => p.then(
  () => null,
  (e) => e.code ?? e.message,
);
const rpc = (name, args) => f.rpc(name, args);

test("acesso por papel: leitura para os papéis do Financeiro; configurar só o administrador", async () => {
  const seen = {};
  for (const [role, user] of Object.entries(f.users)) {
    seen[role] = await rpc("erp_cnab_access", { p_user_id: user }).catch((e) => e.code);
    for (const name of ["erp_cnab_profiles", "erp_cnab_operational_profiles", "erp_cnab_operational_profiles_v2"]) await code(rpc(name, { p_user_id: user }));
  }
  assert.equal(seen.admin.configure, true);
  assert.equal(seen.financeiro.write, true);
  assert.equal(seen.consulta.write, false);
  for (const role of ["vendas", "estoque", "inactive"]) assert.equal(seen[role], "42501", role);
  assert.equal(await code(rpc("erp_cnab_access", { p_user_id: randomUUID() })), "42501");
  assert.equal(await code(rpc("erp_cnab_access", { p_user_id: null })), "42501");
});

test("homologação: perfis, contexto, reserva e arquivos com paginação", async () => {
  const itau = await f.profile();
  const inter = await f.profile({ bank: "077" });
  const profiles = await rpc("erp_cnab_profiles", { p_user_id: f.users.consulta });
  assert.deepEqual(
    profiles.items.filter((p) => [itau.id, inter.id].includes(p.id)).map((p) => [p.bank, p.account_mask]),
    [itau, inter].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => [p.bank, "***" + p.data.account.slice(-3)]),
  );
  const context = await rpc("erp_cnab_profile_context", { p_user_id: f.users.financeiro, p_profile_id: itau.id });
  assert.equal(context.accountId, itau.account_id);
  assert.equal(await code(rpc("erp_cnab_profile_context", { p_user_id: f.users.consulta, p_profile_id: itau.id })), "42501");
  assert.equal(await code(rpc("erp_cnab_profile_context", { p_user_id: f.users.financeiro, p_profile_id: randomUUID() })), "P0002");
  assert.equal(await code(rpc("erp_cnab_profile_context", { p_user_id: f.users.financeiro, p_profile_id: null })), "P0002");

  const made = [];
  for (let i = 0; i < 3; i++) made.push(await f.homologationRemittance(itau, [await f.title(String(10000 + i), "2026-12-30")]));
  const reservation = await rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: made[0].id });
  assert.equal(reservation.state, "ready");
  assert.equal(await code(rpc("erp_cnab_reservation", { p_user_id: f.users.consulta, p_id: made[0].id })), "42501");
  assert.equal(await code(rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: randomUUID() })), "P0002");

  // Paginação por id: duas páginas de 2 cobrem as três remessas.
  const first = await rpc("erp_cnab_files", { p_user_id: f.users.consulta, p_kind: "remittance", p_limit: 2, p_after: null });
  assert.equal(first.has_more, true);
  const second = await rpc("erp_cnab_files", { p_user_id: f.users.consulta, p_kind: "remittance", p_limit: 2, p_after: first.next_cursor });
  assert.deepEqual([...first.items, ...second.items].map((x) => x.id).sort(), made.map((x) => x.id).sort());
  assert.ok(first.items.every((x) => /^ITAU_TESTE_\d{7}\.REM$/.test(x.filename) && x.titles === 1));
  for (const bad of [{ p_kind: "x" }, { p_limit: 0 }, { p_limit: 101 }, { p_limit: null }])
    assert.equal(await code(rpc("erp_cnab_files", { p_user_id: f.users.consulta, p_kind: "remittance", p_limit: 10, p_after: null, ...bad })), "22023");
  assert.deepEqual((await rpc("erp_cnab_files", { p_user_id: f.users.consulta, p_kind: null, p_limit: 10, p_after: null })).items, []);
});

test("retornos de homologação: review, conferência humana com histórico e contexto do retorno", async () => {
  const p = await f.profile();
  const titles = [await f.title("12345", "2026-12-30"), await f.title("22000", "2026-12-30"), await f.title("5000", "2026-12-30")];
  const r = await f.homologationRemittance(p, titles);
  const bts = (await rpc("erp_cnab_reservation", { p_user_id: f.users.financeiro, p_id: r.id })).snapshot.titles;
  const day = f.ddmmyy(f.today);
  const event = (bt, over = {}) => ({ control: bt.control, documentNumber: bt.documentNumber, ourNumber: bt.ourNumber, amount: bt.amountCents, paid: bt.amountCents, dueDate: f.ddmmyy(bt.dueOn), occurrenceDate: day, creditDate: day, ...over });
  const file = await f.homologationReturn(p, [
    event(bts[0]),
    event(bts[1], { occurrence: "02", paid: "0" }),
    event(bts[2], { paid: "4900", fee: "100" }),
    event(bts[0], { control: "SEM-VINCULO-0001", documentNumber: "X0001", amount: "777" }),
  ]);
  const review = await rpc("erp_cnab_review", { p_user_id: f.users.consulta, p_file_id: file.id, p_limit: 2, p_after: 1 });
  assert.deepEqual([review.items.length, review.has_more, review.next_cursor], [2, true, 3]);
  const rest = await rpc("erp_cnab_review", { p_user_id: f.users.consulta, p_file_id: file.id, p_limit: 2, p_after: review.next_cursor });
  assert.deepEqual([rest.items.map((x) => x.line), rest.has_more], [[4, 5], false]);
  for (const bad of [{ p_limit: 0 }, { p_after: 0 }, { p_after: null }]) assert.equal(await code(rpc("erp_cnab_review", { p_user_id: f.users.consulta, p_file_id: file.id, p_limit: 2, p_after: 1, ...bad })), "22023");
  assert.equal(await code(rpc("erp_cnab_review", { p_user_id: f.users.consulta, p_file_id: randomUUID(), p_limit: 2, p_after: 1 })), "P0002");

  const list = await rpc("erp_cnab_human_review_list", { p_user_id: f.users.consulta, p_file_id: file.id, p_limit: 100, p_after: 1 });
  assert.deepEqual(list.items.map((x) => [x.line, x.review_status, x.review_version, x.context_changed]), [[2, "pending", 0, false], [3, "pending", 0, false], [4, "pending", 0, false], [5, "pending", 0, false]]);
  const reasons = [];
  for (const item of list.items) {
    const d = await rpc("erp_cnab_human_review_get", { p_user_id: f.users.consulta, p_event_id: item.event_id, p_file_id: file.id, p_line: item.line });
    reasons.push(d.context.comparison.reason);
  }
  assert.equal(reasons[3], "UNLINKED_EVENT");
  assert.equal(reasons[1], "NON_PAYMENT_EVENT");
  assert.equal(new Set(reasons).size, reasons.length, reasons.join());

  // Duas revisões da conferência (escrita do C4, só no Postgres) e o contexto que muda depois.
  const target = list.items[0];
  let detail = await rpc("erp_cnab_human_review_get", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_file_id: file.id, p_line: target.line });
  for (const [status, version] of [["pending_issue", 0], ["confirmed", 1]]) {
    await rpc("erp_cnab_human_review_save", {
      p_user_id: f.users.financeiro, p_event_id: target.event_id, p_file_id: file.id, p_line: target.line, p_command_id: randomUUID(),
      p_expected_review_version: version, p_expected_context_hash: detail.context_hash, p_status: status, p_reason: "Conferência sintética " + version,
    });
    detail = await rpc("erp_cnab_human_review_get", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_file_id: file.id, p_line: target.line });
  }
  assert.deepEqual([detail.review_version, detail.review.status, detail.review.context_changed], [2, "confirmed", false]);
  const history = await rpc("erp_cnab_human_review_history", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_limit: 1, p_before: null });
  assert.deepEqual([history.items.map((x) => x.version), history.has_more, history.next_cursor], [[2], true, 2]);
  const older = await rpc("erp_cnab_human_review_history", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_limit: 5, p_before: 2 });
  assert.deepEqual([older.items.map((x) => x.version), older.has_more], [[1], false]);
  for (const bad of [{ p_limit: 0 }, { p_before: 0 }])
    assert.equal(await code(rpc("erp_cnab_human_review_history", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_limit: 1, p_before: null, ...bad })), "22023");
  assert.equal(await code(rpc("erp_cnab_human_review_history", { p_user_id: f.users.consulta, p_event_id: randomUUID(), p_limit: 1, p_before: null })), "P0002");
  // O título é baixado à parte: o contexto muda e a lista o mostra.
  await f.db.query("update erp_finance.title set settled_cents=100 where id=$1", [titles[0].id]);
  await f.sync();
  const changed = await rpc("erp_cnab_human_review_list", { p_user_id: f.users.consulta, p_file_id: file.id, p_limit: 1, p_after: 1 });
  assert.deepEqual([changed.items[0].review_status, changed.items[0].context_changed], ["confirmed", true]);
  assert.equal((await rpc("erp_cnab_human_review_get", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_file_id: file.id, p_line: 2 })).review.context_changed, true);
  for (const bad of [{ p_line: 3 }, { p_file_id: randomUUID() }, { p_event_id: randomUUID() }, { p_line: null }])
    assert.equal(await code(rpc("erp_cnab_human_review_get", { p_user_id: f.users.consulta, p_event_id: target.event_id, p_file_id: file.id, p_line: 2, ...bad })), "P0002");
  for (const bad of [{ p_limit: 101 }, { p_after: 0 }, { p_after: 10001 }])
    assert.equal(await code(rpc("erp_cnab_human_review_list", { p_user_id: f.users.consulta, p_file_id: file.id, p_limit: 1, p_after: 1, ...bad })), "22023");

  // Contexto do retorno (o app o pede antes de gravar outro retorno).
  const hash = (await rpc("erp_cnab_files", { p_user_id: f.users.consulta, p_kind: "return", p_limit: 100, p_after: null })).items.find((x) => x.id === file.id).file_hash;
  const ctx = await rpc("erp_cnab_return_context", {
    p_user_id: f.users.financeiro, p_profile_id: p.id, p_file_hash: hash, p_event_hashes: list.items.map((x) => x.event_hash), p_controls: bts.map((b) => b.control),
  });
  assert.deepEqual([ctx.titles.length, ctx.seenFileHashes, ctx.seenEventHashes.length], [3, [hash], 4]);
  assert.deepEqual(ctx.titles.map((t) => t.status).sort(), ["open", "open", "open"]);
  for (const bad of [{ p_file_hash: "x" }, { p_event_hashes: ["x"] }])
    assert.equal(await code(rpc("erp_cnab_return_context", { p_user_id: f.users.financeiro, p_profile_id: p.id, p_file_hash: hash, p_event_hashes: [], p_controls: [], ...bad })), "22023");
  // Hash nulo: o Fagoo não recusa (a conferência de formato dá nulo) e nada é visto.
  const none = await rpc("erp_cnab_return_context", { p_user_id: f.users.financeiro, p_profile_id: p.id, p_file_hash: null, p_event_hashes: null, p_controls: null });
  assert.deepEqual([none.titles, none.seenFileHashes, none.seenEventHashes], [[], [], []]);
  assert.equal(await code(rpc("erp_cnab_return_context", { p_user_id: f.users.financeiro, p_profile_id: randomUUID(), p_file_hash: hash, p_event_hashes: [], p_controls: [] })), "P0002");
  assert.equal(await code(rpc("erp_cnab_return_context", { p_user_id: f.users.consulta, p_profile_id: p.id, p_file_hash: hash, p_event_hashes: [], p_controls: [] })), "42501");
});

test("operacional: aprovações v1 e v2, reservas discriminadas, arquivos e eventos", async () => {
  const p = await f.profile();
  const before = (await f.profilesV2()).find((x) => x.profile.id === p.id);
  assert.deepEqual(before.approval.issues, ["OPERATIONAL_APPROVAL_MISSING"]);
  await f.approveV2(p, [LEGACY, OBSERVED]);
  const approved = (await f.profilesV2()).find((x) => x.profile.id === p.id);
  assert.deepEqual([approved.approval.effective_enabled, approved.approval.approval_version], [true, 1]);
  const v1 = (await rpc("erp_cnab_operational_profiles", { p_user_id: f.users.consulta })).items.find((x) => x.profile.id === p.id);
  assert.equal(v1.approval.effective_enabled, true);

  // Reserva v2 (observada) e reserva v1 (sem encargos), lidas cada uma pela sua família.
  const v2 = await f.reserveV2(await f.selection(p, [await f.title()]));
  const read2 = await rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.financeiro, p_id: v2.id, p_expected_approval: 1 });
  assert.deepEqual([read2.state, read2.encoding_profile, read2.approval_version], ["reserved", OBSERVED, 1]);
  assert.equal(await code(rpc("erp_cnab_operational_reservation", { p_user_id: f.users.financeiro, p_id: v2.id, p_expected_approval: 1 })), "P0002");
  assert.equal(await code(rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.financeiro, p_id: v2.id, p_expected_approval: 2 })), "40001");
  assert.equal(await code(rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.financeiro, p_id: v2.id, p_expected_approval: 0 })), "22023");
  assert.equal(await code(rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.consulta, p_id: v2.id, p_expected_approval: 1 })), "42501");
  const t1 = await f.title();
  const current = (await f.profilesV2()).find((x) => x.profile.id === p.id);
  const args = {
    p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_profile_id: p.id, p_expected_version: current.profile.version, p_expected_approval: 1, p_generated_on: f.today,
    p_titles: [{ title_id: t1.id, expected_version: t1.version, document_number: "W00000001" }], p_confirm_operational: false, p_preview: true, p_preview_hash: null,
  };
  const preview = await rpc("erp_cnab_operational_reserve", args);
  const old = await rpc("erp_cnab_operational_reserve", { ...args, p_preview: false, p_confirm_operational: true, p_preview_hash: preview.preview_hash });
  const read1 = await rpc("erp_cnab_operational_reservation", { p_user_id: f.users.financeiro, p_id: old.id, p_expected_approval: 1 });
  assert.deepEqual([read1.state, read1.approval_version], ["reserved", 1]);
  assert.equal(await code(rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.financeiro, p_id: old.id, p_expected_approval: 1 })), "P0002");

  const files = await rpc("erp_cnab_operational_files", { p_user_id: f.users.consulta, p_kind: "remittance", p_limit: 100, p_after: null });
  assert.ok([v2.id, old.id].every((id) => files.items.some((x) => x.id === id)));
  const files2 = await rpc("erp_cnab_operational_files_v2", { p_user_id: f.users.consulta, p_limit: 100, p_after: null });
  assert.equal(files2.items.find((x) => x.id === old.id).encoding_profile, null);
  assert.equal(files2.items.find((x) => x.id === v2.id).encoding_profile, OBSERVED);
  const one = await rpc("erp_cnab_operational_files_v2", { p_user_id: f.users.consulta, p_limit: 1, p_after: null });
  assert.equal(one.has_more, true);
  await rpc("erp_cnab_operational_files_v2", { p_user_id: f.users.consulta, p_limit: 1, p_after: one.next_cursor });
  for (const bad of [{ p_limit: 0 }, { p_limit: 101 }]) assert.equal(await code(rpc("erp_cnab_operational_files_v2", { p_user_id: f.users.consulta, p_limit: 1, p_after: null, ...bad })), "22023");

  // Aprovação revogada: a reserva fica legível só com a versão nova, e sem efeito.
  await f.approveV2(p, []);
  assert.equal(await code(rpc("erp_cnab_operational_reservation_v2", { p_user_id: f.users.financeiro, p_id: v2.id, p_expected_approval: 2 })), "40001");
  const revoked = (await f.profilesV2()).find((x) => x.profile.id === p.id);
  assert.deepEqual([revoked.approval.enabled, revoked.approval.effective_enabled], [false, false]);

  // Eventos operacionais e baixa: sem arquivo e sem baixa, as recusas dos dois motores.
  for (const bad of [{ p_limit: 0 }, { p_after: 0 }, { p_after: 10000 }])
    assert.equal(await code(rpc("erp_cnab_operational_events", { p_user_id: f.users.consulta, p_file_id: randomUUID(), p_limit: 10, p_after: 1, ...bad })), "22023");
  assert.equal(await code(rpc("erp_cnab_operational_events", { p_user_id: f.users.consulta, p_file_id: randomUUID(), p_limit: 10, p_after: 1 })), "P0002");
  assert.equal(await code(rpc("erp_cnab_operational_settlement_get", { p_user_id: f.users.consulta, p_command_id: randomUUID() })), "P0002");
  assert.equal(await code(rpc("erp_cnab_operational_settlement_get", { p_user_id: f.users.vendas, p_command_id: randomUUID() })), "42501");
  // O controle de um título operacional não serve à homologação.
  const control = read1.snapshot.titles[0].control;
  assert.equal(
    await code(rpc("erp_cnab_return_context", { p_user_id: f.users.financeiro, p_profile_id: p.id, p_file_hash: "a".repeat(64), p_event_hashes: [], p_controls: [control] })),
    "40001",
  );
});
