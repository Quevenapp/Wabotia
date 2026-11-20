import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture, COM1_PEOPLE } from "./fixtures.mjs";
import { installCommercialNfePreparation, prepareCommercialNfe } from "../../../src/erp/domains/fiscal/comnfe/prepare.ts";
import { capturePreparationSources, recapturePreparationFingerprint } from "../../../src/erp/domains/fiscal/comnfe/source.ts";
import { calculatePreparationTaxes } from "../../../src/erp/domains/fiscal/comnfe/taxes.ts";
import { mapPreparation } from "../../../src/erp/domains/fiscal/comnfe/mapper.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { bindCom1Authority } from "../../../src/erp/domains/fiscal/comnfe/access.ts";
import { COM1_TABLES as T, com1Hash, claimStoredOperation, recordExternalEvidence, getStoredRevision } from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const connection = com1Hash("cofre de ensaio sem rede");
const commercial = { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
  transport: { freight_mode: "9", volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } };
function fixture(t, options = {}) {
  const f = com1Fixture(t, options);
  t.after(installCommercialNfePreparation());
  const complete = { ...f.orderBody, payment_means: "15", payment_indicator: "1", commercial,
    items: f.orderBody.items.map((item, index) => ({ ...item, code: `P${index + 1}` })) };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: f.order.version,
    p_command_id: randomUUID(), p_body: complete }).document;
  t.after(installCommercialConnectionResolver(() => ({ fingerprint: connection, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: "1795089600000000", compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao"], series: [{ environment: "homologacao", series: 1 }] })));
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  f.input = (overrides = {}) => ({ document_id: f.order.id, expected_document_version: f.order.version, command_id: randomUUID(),
    choices: { nature_id: f.nature.id, presence: "presencial", final_consumer: true }, ...overrides });
  f.prepare = (input = f.input(), env) => f.rpc("erp_com1_prepare", { p_input: input }, env);
  return f;
}
const error = message => value => value.message === message;
const count = (f, table) => Number(f.db.exec(`SELECT count(*) n FROM ${table}`).rows[0].n);
const codes = result => result.blockers.map(value => value.code);
function ready(result) { assert.deepEqual(result.blockers, []); assert.equal(result.emission.status, "preparada"); return result.emission; }
function claim(f, emission) {
  return f.transaction(ctx => claimStoredOperation(ctx, { emission_id: emission.id, command_id: randomUUID(), action: "emit", expected_version: emission.version,
    body_revision: emission.current_body_revision, body_hash: emission.revision.body_hash, source_fingerprint: emission.revision.source_fingerprint, connection_fingerprint: connection }));
}
function evidence(claimed, result) {
  return { emission_id: claimed.emission.id, command_id: claimed.command.id, claim_token: claimed.command.token,
    connection_fingerprint: connection, result };
}

function mapped(f, change = () => {}) {
  const sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  change(sources);
  return mapPreparation(sources, calculatePreparationTaxes(sources), { environment: "homologacao", reference: `wb.${f.order.id}.v1` });
}

test("cliente e transportadora conservam CNPJ alfanumérico do cadastro ao PedidoNfe", t => {
  const f = fixture(t, { customer: { document: "12.abc.345/01de-35" } });
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: f.order.version,
    p_command_id: randomUUID(), p_body: { ...f.orderBody, payment_means: "15", payment_indicator: "1", carrier_id: f.customer.id,
      commercial: { ...commercial, transport: { ...commercial.transport, freight_mode: "0" } },
      items: f.orderBody.items.map((item, index) => ({ ...item, code: `P${index + 1}`, detailed_description: null })),
      installments: f.orderBody.installments.map(item => ({ ...item, note: null, payment_reference: null })) } }).document;
  const prepared = ready(f.prepare());
  assert.equal(prepared.revision.snapshot.recipient.document, "12.abc.345/01de-35");
  assert.equal(prepared.revision.snapshot.transport.carrier.document, "12.abc.345/01de-35");
  assert.equal(prepared.revision.body.destinatario.cnpj, "12ABC34501DE35");
  assert.equal(prepared.revision.body.transporte.transportadora.cnpj, "12ABC34501DE35");
  const invalid = mapped(f, sources => { sources.snapshot.recipient.document = "12ABC34501DE34"; sources.snapshot.transport.carrier.document = "12ABC34501DEAA"; });
  assert.equal(invalid.body, null);
  assert.ok(invalid.blockers.some(blocker => blocker.field === "destinatario.cnpj"));
  assert.ok(invalid.blockers.some(blocker => blocker.field === "transporte.transportadora.documento"));
});

test("pagamentos conservam valor bruto e agrupam apenas os mesmos detalhes fiscais", t => {
  const f = fixture(t);
  const withCards = (sources, distinct) => {
    sources.snapshot.document.payment_means = "03";
    sources.snapshot.payments = [1, 2].map(position => ({ position, due_date: "2026-12-19", amount: "25.50", details: {
      payment_type: "03", integration_type: "1", acquirer_cnpj: "11222333000181", card_brand: "01",
      authorization_code: distinct ? `AUT${position}` : "AUT1", fee_amount: "1.50", received_amount: "24.00",
    } }));
  };
  const separate = mapped(f, sources => withCards(sources, true));
  assert.deepEqual(separate.blockers, []);
  assert.equal(separate.body.pagamentos.length, 2);
  assert.equal(separate.body.pagamentos.reduce((sum, payment) => sum + payment.valor, 0), 51);
  assert.equal(separate.body.pagamentos[0].cartao.integracao, "integrado");
  assert.equal(separate.body.cobranca.duplicatas.length, 2);
  const grouped = mapped(f, sources => withCards(sources, false));
  assert.deepEqual(grouped.blockers, []);
  assert.deepEqual(grouped.body.pagamentos.map(payment => payment.valor), [51]);
  const missing = mapped(f, sources => { withCards(sources, false); delete sources.snapshot.payments[0].details.authorization_code; });
  assert.equal(missing.body, null);
  assert.ok(missing.blockers.some(blocker => blocker.field === "pagamentos[0].cartao.autorizacao"));
});

test("totais e parcelas divergentes bloqueiam sem corrigir a origem", t => {
  const f = fixture(t);
  const wrongParcel = mapped(f, sources => { sources.snapshot.payments[0].amount = "50.99"; });
  assert.equal(wrongParcel.body, null);
  assert.ok(codes(wrongParcel).includes("fiscal_total_mismatch"));
  assert.equal(wrongParcel.calculation.installment_total_cents, "5099");
  assert.equal(wrongParcel.calculation.fiscal_total_cents, "5100");
  const wrongStored = mapped(f, sources => { sources.snapshot.document.stored_total = "50.99"; });
  assert.ok(codes(wrongStored).includes("fiscal_total_mismatch"));
  assert.equal(ready(f.prepare()).revision.body.pagamentos[0].valor, 51);
});

test("limites localizam texto, GTIN e quantidade sem truncamento ou arredondamento", t => {
  const f = fixture(t);
  const bad = mapped(f, sources => {
    sources.snapshot.company.legal_name = "A".repeat(61);
    sources.snapshot.items[0].description = "A".repeat(121);
    sources.snapshot.items[0].quantity = "2.00001";
    sources.snapshot.products[0].gtin = "12345671";
  });
  assert.equal(bad.body, null);
  for (const field of ["emitente.nome", "itens[0].descricao", "itens[0].quantidade", "itens[0].ean"])
    assert.ok(bad.blockers.some(blocker => blocker.field === field && blocker.correction.screen && blocker.message), field);
  const valid = mapped(f, sources => { sources.snapshot.products[0].gtin = "12345670"; });
  assert.deepEqual(valid.blockers, []);
  assert.equal(valid.body.itens[0].ean, "12345670");
  assert.equal(valid.body.itens[0].tributavel.ean, "12345670");
  const absent = mapped(f);
  assert.equal(Object.hasOwn(absent.body.itens[0], "ean"), false);
  assert.equal(Object.hasOwn(absent.body.itens[0], "seguro"), false);
  assert.equal(absent.body.itens[0].quantidade, 2);
  assert.equal(absent.body.itens[0].desconto, 0);
});

test("dados condicionais completos são mapeados e incompletos não desaparecem", t => {
  const f = fixture(t);
  const complete = mapped(f, sources => {
    sources.snapshot.document.ship_datetime = "2026-11-20T10:00:00-03:00";
    sources.snapshot.transport = { freight_mode: "3", vehicle: { plate: "ABC1D23", state: "SP", rntc: "1234" },
      volumes: [{ volume_count: "2.000000", species: "Caixa", brand: "Ensaio", numbering: "1-2", gross_weight: "5.250000", net_weight: "5.000000" }] };
    sources.snapshot.items[0].tributavel = { unit: "CX", quantity: "1", unit_price: "51" };
  });
  assert.deepEqual(complete.blockers, []);
  assert.equal(complete.body.dataSaida, "2026-11-20T10:00:00-03:00");
  assert.equal(complete.body.transporte.veiculo.placa, "ABC1D23");
  assert.deepEqual(complete.body.transporte.volumes[0], { quantidade: 2, pesoBruto: 5.25, pesoLiquido: 5, especie: "Caixa", marca: "Ensaio", numeracao: "1-2" });
  assert.deepEqual(complete.body.itens[0].tributavel, { unidade: "CX", quantidade: 1, valorUnitario: 51 });
  const missing = mapped(f, sources => {
    sources.snapshot.document.ship_date = "2026-11-20";
    sources.snapshot.transport = { freight_mode: "3", vehicle: { state: "SP" }, volume_count: "1.5" };
    sources.snapshot.items[0].tributavel = { unit: "CX" };
  });
  assert.equal(missing.body, null);
  for (const field of ["dataSaida", "transporte.veiculo.placa", "transporte.volumes[0].quantidade", "itens[0].tributavel.quantidade", "itens[0].tributavel.valorUnitario"])
    assert.ok(missing.blockers.some(blocker => blocker.field === field), field);
});

test("operação fora do contrato mantém bloqueio em vez de perder informações", t => {
  const f = fixture(t);
  const result = mapped(f, sources => {
    sources.snapshot.document.notasReferenciadas = ["1".repeat(44)];
    sources.snapshot.document.intermediador = { cnpj: "11222333000181", identificacao: "Ensaio" };
    sources.snapshot.document.delivery_address = { street: "Outro endereço", city: "São Paulo" };
    sources.snapshot.transport = {};
  });
  assert.equal(result.body, null);
  for (const field of ["notasReferenciadas", "intermediador", "delivery_address", "transporte.modalidade"])
    assert.ok(result.blockers.some(blocker => blocker.field === field), field);
  assert.equal(codes(result).includes("fiscal_transport_incomplete"), true);
});

test("configuração comercial incompatível não perde seus detalhes fiscais", t => {
  const f = fixture(t);
  const noPayment = mapped(f, sources => { sources.snapshot.document.payment_means = "90"; });
  assert.ok(noPayment.blockers.some(blocker => blocker.field === "pagamentos[0].valor"));
  const payableOnly = mapped(f, sources => { sources.snapshot.payments[0].payment_method = { applicable: "pagamentos", payment_type: "15" }; });
  assert.ok(codes(payableOnly).includes("fiscal_payment_incomplete"));
  const pix = mapped(f, sources => { sources.snapshot.payments[0].payment_method = { applicable: "recebimentos", payment_type: "17", pix_cnpj: "11222333000181", pix_integration: "sem" }; });
  assert.ok(pix.blockers.some(blocker => blocker.field === "pagamentos[0].pix"));
  const unsupportedNature = mapped(f, sources => { sources.snapshot.nature.return_operation = true; sources.snapshot.nature.invoiced = false; });
  assert.equal(unsupportedNature.body, null);
  for (const field of ["nature.return_operation", "nature.invoiced"]) assert.ok(unsupportedNature.blockers.some(blocker => blocker.field === field));
});

test("CNAE formatado e observações públicas preservam dados salvos sem expor notas internas", t => {
  const f = fixture(t);
  const result = mapped(f, sources => {
    sources.snapshot.company.cnae = "4711-3/02";
    sources.snapshot.company.municipal_registration = "12345";
    sources.snapshot.document.notes = "Observação pública do pedido.";
    sources.snapshot.document.internal_notes = "Informação interna, não enviar.";
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.body.emitente.cnae, "4711302");
  assert.equal(result.body.emitente.inscricaoMunicipal, "12345");
  assert.equal(result.body.informacoesComplementares, "Observação pública do pedido.");
  assert.equal(JSON.stringify(result.body).includes("Informação interna"), false);
  const mismatch = mapped(f, sources => { sources.snapshot.company.municipality_code = "3304557"; });
  assert.ok(mismatch.blockers.some(blocker => blocker.field === "emitente.endereco.codigoMunicipio"));
});

test("pedido completo congela corpo, cálculo, fontes e hash sem criar efeitos", t => {
  const f = fixture(t), input = f.input(), output = f.prepare(input), view = ready(output);
  assert.equal(view.reference, `wb.${f.order.id}.v1`);
  assert.equal(view.revision.body.ambiente, "homologacao");
  assert.equal(view.revision.body.emitente.cnpj, f.company.cnpj);
  assert.equal(view.revision.body.destinatario.endereco.codigoMunicipio, "3550308");
  assert.equal(view.revision.body.itens[0].ncm, "84713012");
  assert.equal(view.revision.body_hash, com1Hash(view.revision.body));
  assert.ok(view.revision.snapshot.sources.length >= 5);
  assert.equal(count(f, T.effect), 0);
  assert.equal(count(f, T.emission), 1);
  const serialized = JSON.stringify(view.revision.body);
  for (const key of ["ibsCbs", "impostoSeletivo", "dataEmissao"]) assert.equal(serialized.includes(key), false, key);
  const again = f.prepare(input);
  assert.equal(again.replayed, true);
  assert.equal(again.emission.revision.body_hash, view.revision.body_hash);
  assert.equal(count(f, T.revision), 1);
});

test("campos fiscais não podem vir do navegador nem de choices", t => {
  const f = fixture(t);
  for (const extra of [{ status: "autorizada" }, { impostos: {} }, { body: {} }, { access_key: "1".repeat(44) }])
    assert.throws(() => f.prepare({ ...f.input(), ...extra }), error("com1_input_invalid"));
  const input = f.input();
  assert.throws(() => f.prepare({ ...input, choices: { ...input.choices, icms: { value: "0" } } }), error("com1_input_invalid"));
  assert.equal(count(f, T.emission), 0);
});

test("recibo, duplo clique e duas abas não criam outra emissão", t => {
  const f = fixture(t), input = f.input(), first = ready(f.prepare(input));
  assert.equal(f.prepare(input).emission.id, first.id);
  assert.throws(() => f.prepare(f.input()), error("com1_version_conflict"));
  assert.throws(() => f.prepare({ ...input, choices: { ...input.choices, presence: "internet" } }), error("fiscal_command_conflict"));
  const second = ready(f.prepare(f.input({ expected_emission_version: first.version })));
  assert.equal(second.id, first.id);
  assert.equal(second.reference, first.reference);
  assert.equal(second.revision.body_hash, first.revision.body_hash);
  assert.equal(count(f, T.emission), 1);
  assert.equal(count(f, T.effect), 0);
});

test("resposta perdida preserva bytes e referência; preparo não modifica emissão incerta", t => {
  const f = fixture(t), input = f.input(), view = ready(f.prepare(input)), claimed = claim(f, view);
  const uncertain = f.transaction(ctx => recordExternalEvidence(ctx, { ...evidence(claimed, null), error: { code: "timeout", message: "Resposta perdida no ensaio" } }));
  assert.equal(uncertain.status, "incerta");
  assert.equal(f.prepare(input).emission.revision.body_hash, view.revision.body_hash);
  assert.throws(() => f.prepare(f.input({ expected_emission_version: uncertain.version })), error("fiscal_emission_open"));
  f.clock.advance(120000);
  const resume = f.transaction(ctx => claimStoredOperation(ctx, { emission_id: view.id, command_id: randomUUID(), action: "resume",
    expected_version: uncertain.version, body_revision: view.current_body_revision, body_hash: view.revision.body_hash, connection_fingerprint: connection }));
  assert.equal(resume.command.request.body_text, claimed.command.request.body_text);
  assert.equal(resume.command.request.reference, claimed.command.request.reference);
  assert.equal(count(f, T.revision), 1);
});

test("replay revalida privacidade sem recapturar nem substituir fontes", t => {
  const f = fixture(t), input = f.input(), view = ready(f.prepare(input));
  assert.throws(() => f.transaction(ctx => {
    ctx.identity.customer_privacy = { restricted_contact_ids: [f.customer.id] };
    return prepareCommercialNfe(ctx, input);
  }), error("erp_customer_restricted"));
  assert.equal(f.transaction(ctx => getStoredRevision(ctx, view.id)).body_hash, view.revision.body_hash);
  assert.equal(count(f, T.revision), 1);
});

test("configuração ausente, incompatível, série e ambiente retornam bloqueios próprios", t => {
  const f = fixture(t);
  f.db.exec(`UPDATE ${T.settings} SET connection_fingerprint=NULL,connection_public=NULL WHERE id=1`);
  let result = f.prepare();
  assert.ok(codes(result).includes("fiscal_provider_not_configured"));
  const publicConnection = { compatible: false, issuer_cnpj: "19131243000197", environments: [],
    series: [{ environment: "homologacao", series: 1 }, { environment: "homologacao", series: 2 }] };
  f.db.exec(`UPDATE ${T.settings} SET connection_fingerprint=?,connection_public=? WHERE id=1`, connection, JSON.stringify(publicConnection));
  result = f.prepare(f.input({ expected_emission_version: result.emission.version }));
  for (const code of ["fiscal_provider_incompatible", "fiscal_environment_not_allowed", "fiscal_issuer_mismatch", "fiscal_series_required"])
    assert.ok(codes(result).includes(code), code);
  assert.equal(count(f, T.emission), 1);
  assert.equal(result.emission.revision.body, null);
});

test("rejeição conclusiva permite nova revisão na mesma versão e referência", t => {
  const f = fixture(t), view = ready(f.prepare()), claimed = claim(f, view);
  const rejected = f.transaction(ctx => recordExternalEvidence(ctx, evidence(claimed, { kind: "nfe", provider_ref: "vault-rejected", reference: view.reference,
    environment: "homologacao", status: "rejected", messages: [{ code: "999", description: "Rejeição simulada" }],
    number: 0, series: "1", access_key: null, protocol: null, issued_at: null, authorized_at: null, total: null,
    nfse_number: null, qr_code: null, consult_url: null, corrections: 0, xml_available: false, replayed: false, event_repeated: null, contingency: null })));
  assert.equal(rejected.status, "rejeitada");
  const corrected = ready(f.prepare(f.input({ expected_emission_version: rejected.version, choices: { nature_id: f.nature.id, presence: "internet", final_consumer: true } })));
  assert.equal(corrected.reference, view.reference);
  assert.equal(corrected.fiscal_version, 1);
  assert.equal(corrected.current_body_revision, 2);
  assert.notEqual(corrected.revision.body_hash, view.revision.body_hash);
  assert.equal(f.transaction(ctx => getStoredRevision(ctx, view.id, 1)).body_hash, view.revision.body_hash);
});

test("versão técnica não altera fingerprints, alteração comercial exige revisar", t => {
  const f = fixture(t), view = ready(f.prepare());
  f.db.exec("UPDATE erp_documents__document SET version=version+1 WHERE id=?", f.order.id);
  const unchanged = f.transaction(ctx => recapturePreparationFingerprint(ctx, view.revision));
  assert.equal(unchanged, view.revision.source_fingerprint);
  f.db.exec("UPDATE erp_documents__document SET body=json_set(body,'$.notes','Observação fiscal alterada') WHERE id=?", f.order.id);
  const changed = f.transaction(ctx => recapturePreparationFingerprint(ctx, view.revision));
  assert.notEqual(changed, view.revision.source_fingerprint);
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, { emission_id: view.id, command_id: randomUUID(), action: "emit", expected_version: view.version,
    body_revision: 1, body_hash: view.revision.body_hash, source_fingerprint: changed, connection_fingerprint: connection })), error("fiscal_source_changed"));
});

test("partes locais desligadas são puladas; partes necessárias e papel fiscal são exigidos", t => {
  const f = fixture(t), input = f.input();
  const result = f.prepare(input, { parts: { stock: false, finance: false } });
  ready(result);
  assert.deepEqual(result.effects_preview.map(effect => [effect.state, effect.reason]), [["pulado", "part_disabled"], ["pulado", "part_disabled"]]);
  for (const part of ["customers", "products", "sales", "fiscal"])
    assert.throws(() => f.prepare(input, { parts: { [part]: false } }), value => value.code === "module_disabled");
  assert.throws(() => f.prepare(input, { role: "vendas" }), error("fiscal_forbidden"));
});

test("bot configurado usa a mesma preparação; sem concessão ou origem externa é recusado", t => {
  const f = fixture(t);
  const run = authority => f.transaction(ctx => { bindCom1Authority(ctx, authority); return prepareCommercialNfe(ctx, f.input()); }, { actor: { is_agent: true } });
  assert.throws(() => run({ origin: "application" }), error("fiscal_confirmation_required"));
  assert.throws(() => run({ origin: "external", autonomous: true }), error("fiscal_external_origin_forbidden"));
  ready(run({ origin: "application", proposed_by: "bot-fiscal", confirmed_by: COM1_PEOPLE.admin.user_id, confirmation_id: "approval-preparo" }));
  const audit = f.db.exec(`SELECT proposed_by,confirmed_by FROM ${T.audit} WHERE action='prepare'`).rows[0];
  assert.equal(audit.proposed_by, "bot-fiscal");
  assert.equal(audit.confirmed_by, COM1_PEOPLE.admin.user_id);
});

test("bloqueios simultâneos localizam NCM, endereço, município e CFOP", t => {
  const f = fixture(t, { product: { ncm: null }, customer: { street: null, city: null }, nature: { rules: [
    { tax: "icms", data: { situation: "102" } }, { tax: "pis", data: { situation: "07" } }, { tax: "cofins", data: { situation: "07" } },
  ] } });
  const result = f.prepare();
  for (const code of ["fiscal_product_incomplete", "fiscal_recipient_incomplete", "fiscal_municipality_unresolved", "fiscal_cfop_missing"])
    assert.ok(codes(result).includes(code), `${code}: ${JSON.stringify(result.blockers)}`);
  assert.equal(result.emission.revision.body, null);
  for (const blocker of result.blockers) { assert.ok(blocker.field); assert.ok(blocker.message); assert.ok(blocker.correction.screen); }
});

test("quantidade de seis casas não é arredondada para emitir; totais divergentes bloqueiam", t => {
  const f = fixture(t);
  const sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  const first = structuredClone(sources);
  first.snapshot.items[0].quantity = "2.000001";
  assert.ok(calculatePreparationTaxes(first).blockers.length > 0);
  const changed = structuredClone(sources);
  changed.snapshot.payments[0].amount = "50.99";
  const taxes = calculatePreparationTaxes(changed);
  const result = mapPreparation(changed, taxes, { environment: "homologacao", reference: `wb.${f.order.id}.v1` });
  assert.ok(codes(result).includes("fiscal_total_mismatch"));
});

test("município exige cidade inteira e UF com uma única correspondência", t => {
  const f = fixture(t);
  f.db.exec("UPDATE erp_catalog__contact SET city='Sao Paulo' WHERE record_id=?", f.customer.id);
  let sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.equal(sources.snapshot.recipient.municipality_code, "3550308");
  f.db.exec("UPDATE erp_catalog__contact SET city='São' WHERE record_id=?", f.customer.id);
  sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.equal(sources.snapshot.recipient.municipality_code, undefined);
  assert.ok(codes(sources).includes("fiscal_municipality_unresolved"));
  f.db.exec("UPDATE erp_catalog__contact SET city='São Paulo' WHERE record_id=?", f.customer.id);
  f.db.exec("INSERT INTO erp_reference__municipality(code,name,uf,key) SELECT '3599999',name,uf,key FROM erp_reference__municipality WHERE code='3550308'");
  sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.equal(sources.snapshot.recipient.municipality_code, undefined);
  assert.ok(codes(sources).includes("fiscal_municipality_unresolved"));
  assert.equal(count(f, T.revision), 0);
});

test("captura direta respeita privacidade sem depender do hook do RPC", t => {
  const f = fixture(t);
  assert.throws(() => f.transaction(ctx => {
    ctx.identity = { ...ctx.identity, customer_privacy: { restricted_contact_ids: [f.customer.id] } };
    return capturePreparationSources(ctx, f.input());
  }), error("erp_customer_restricted"));
  assert.equal(count(f, T.emission), 0);
  assert.equal(count(f, T.revision), 0);
});

test("atualização cadastral fiscal muda fontes sem reescrever revisão; preço atual não substitui preço salvo", t => {
  const f = fixture(t), input = f.input(), view = ready(f.prepare(input));
  f.db.exec("UPDATE erp_catalog__product SET price='999.00' WHERE record_id=?", f.product.id);
  f.db.exec("UPDATE erp_catalog__record SET version=version+1 WHERE id=?", f.product.id);
  let sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.equal(sources.source_fingerprint, view.revision.source_fingerprint);
  assert.equal(sources.snapshot.items[0].unit_price, view.revision.snapshot.items[0].unit_price);
  f.db.exec("UPDATE erp_catalog__product SET ncm='84713019' WHERE record_id=?", f.product.id);
  sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.notEqual(sources.source_fingerprint, view.revision.source_fingerprint);
  assert.equal(sources.commercial_hash, view.revision.commercial_hash);
  assert.equal(sources.snapshot.products[0].ncm, "84713019");
  const original = f.transaction(ctx => getStoredRevision(ctx, view.id, 1));
  assert.equal(original.snapshot.products[0].ncm, "84713012");
  assert.equal(original.body_hash, view.revision.body_hash);
  assert.equal(f.prepare(input).emission.revision.snapshot.products[0].ncm, "84713012");
});

test("classificação de reforma cadastrada participa das fontes e do fingerprint", t => {
  const f = fixture(t);
  const before = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  f.db.exec(`INSERT INTO erp_fiscal_reform__product_class(product_id,cst,cclasstrib,nbs,version,updated_by,updated_at)
    VALUES(?,'000','000001',NULL,1,?,?)`, f.product.id, COM1_PEOPLE.admin.user_id, String(f.clock.next()));
  const after = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.notEqual(after.source_fingerprint, before.source_fingerprint);
  assert.equal(after.commercial_hash, before.commercial_hash);
  assert.deepEqual(after.snapshot.products[0].reform_class, { cst: "000", cclasstrib: "000001", nbs: null, source: "product" });
  assert.deepEqual(after.tax_sources.reform_by_product[f.product.id], after.snapshot.products[0].reform_class);
});

const taxRule = (tax, data) => ({ tax, data, position: 1, product_scope: "any", destinations: [], ncms: [], product_ids: [], group_ids: [], additional_info: null, fiscal_info: null });
function taxSources(f, crt = "3", icms = {}) {
  const source = structuredClone(f.transaction(ctx => capturePreparationSources(ctx, f.input())));
  source.snapshot.items = [{ ...source.snapshot.items[0], quantity: "1.0000", unit_price: "100.0000000000", gross: "100.00", discount: "0.00", total: "100.00" }];
  source.snapshot.document = { ...source.snapshot.document, stored_total: "100.00", freight: "0.00", other_expenses: "0.00",
    totals: { gross: "100.00", line_discount: "0.00", discount: "0.00", freight: "0.00", other_expenses: "0.00", total: "100.00", ipi: "0.00", icms_st: "0.00" } };
  source.snapshot.company.crt = crt;
  source.snapshot.company.state = "SP";
  source.snapshot.recipient.state = "SP";
  source.snapshot.recipient.taxpayer = "9";
  source.snapshot.nature.crt = crt;
  source.snapshot.nature.others = {};
  source.snapshot.nature.retentions = {};
  const normal = ["2", "3"].includes(crt);
  source.snapshot.nature.rules = [taxRule("icms", { ...(normal ? { situation: "00", bc_mode: "3", base_rate: "100.0000", rate: "18.0000" } : { situation: "102" }), cfop: "5102", ...icms }),
    taxRule("pis", { situation: "07" }), taxRule("cofins", { situation: "07" })];
  return source;
}
const fiscalTotal = (sources, total, extra = {}) => {
  Object.assign(sources.snapshot.document.totals, { total, ...extra });
  sources.snapshot.document.stored_total = total;
};

test("motor cobre CRT 1, 2, 3 e 4 com grupo próprio e zero explícito distinto de ausência", t => {
  const f = fixture(t);
  for (const crt of ["1", "2", "3", "4"]) {
    const source = taxSources(f, crt), result = calculatePreparationTaxes(source), icms = result.item_taxes[0].icms;
    assert.deepEqual(result.blockers, [], `CRT ${crt}`);
    assert.equal(result.total_cents, "10000");
    if (["1", "4"].includes(crt)) {
      assert.equal(icms.csosn, "102"); assert.equal(Object.hasOwn(icms, "cst"), false);
      assert.equal(Object.hasOwn(icms, "valor"), false);
    } else {
      assert.equal(icms.cst, "00"); assert.equal(Object.hasOwn(icms, "csosn"), false);
      assert.equal(icms.baseCalculo, 100); assert.equal(icms.valor, 18);
    }
  }
  const zero = taxSources(f, "3", { rate: "0.0000" });
  zero.snapshot.nature.rules[1].data = { situation: "01", base_rate: "100.0000", rate: "0.0000" };
  let result = calculatePreparationTaxes(zero);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.item_taxes[0].icms.aliquota, 0);
  assert.equal(result.item_taxes[0].icms.valor, 0);
  assert.equal(result.item_taxes[0].pis.valor, 0);
  delete zero.snapshot.nature.rules[0].data.rate;
  delete zero.snapshot.nature.rules[1].data.rate;
  result = calculatePreparationTaxes(zero);
  assert.ok(result.blockers.some(b => b.field === "items.0.icms.rate"));
  assert.ok(result.blockers.some(b => b.field === "items.0.pis.rate"));
});

test("CRT 2 com CSOSN legado e retenção sem percentual da base ficam bloqueados", t => {
  const f = fixture(t, { nature: { crt: "2" } });
  f.rpc("erp_company_confirm_fiscal", { p_expected_version: 2, p_expected_identity_version: 1,
    p_command_id: randomUUID(), p_crt: "2", p_confirmed: true, p_reason: "Conferência de CRT 2 no ensaio" });
  const prepared = f.prepare();
  assert.equal(prepared.emission.status, "bloqueada");
  assert.equal(prepared.emission.revision.body, null);
  assert.ok(prepared.blockers.some(blocker => blocker.code === "fiscal_tax_data_missing" && blocker.field === "items.0.icms.CST compatível com CRT"));
  const retained = taxSources(f, "3", { situation: "60", retained_rate: "18.0000" });
  retained.tax_sources.settings.st_retained_from_sale = true;
  const result = calculatePreparationTaxes(retained);
  assert.ok(result.blockers.some(blocker => blocker.code === "fiscal_tax_data_missing" && blocker.field === "items.0.icms.retained_base_rate"));
});

test("IPI, PIS, COFINS e FCP mapeiam bases e valores calculados no servidor", t => {
  const source = taxSources(fixture(t), "3", { fcp_rate: "2.0000" });
  source.snapshot.nature.rules[1].data = { situation: "01", base_rate: "100.0000", rate: "1.6500" };
  source.snapshot.nature.rules[2].data = { situation: "01", base_rate: "100.0000", rate: "7.6000" };
  source.snapshot.nature.rules.push(taxRule("ipi", { situation: "50", framing_code: "999", base_rate: "100.0000", rate: "5.0000" }));
  fiscalTotal(source, "105.00", { ipi: "5.00" });
  const result = calculatePreparationTaxes(source);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.item_taxes[0].icms.fcp, { baseCalculo: 100, aliquota: 2, valor: 2 });
  assert.deepEqual(result.item_taxes[0].ipi, { cst: "50", codigoEnquadramento: "999", baseCalculo: 100, aliquota: 5, valor: 5 });
  assert.deepEqual(result.item_taxes[0].pis, { cst: "01", baseCalculo: 100, aliquota: 1.65, valor: 1.65 });
  assert.deepEqual(result.item_taxes[0].cofins, { cst: "01", baseCalculo: 100, aliquota: 7.6, valor: 7.6 });
  assert.equal(result.total_cents, "10500");
});

test("ST, diferimento, crédito e retenção anterior preservam o significado de cada valor", t => {
  const f = fixture(t);
  const st = taxSources(f, "3", { situation: "10", st_bc_mode: "4", st_base_rate: "100.0000", st_mva: "40.0000", st_rate: "18.0000" });
  st.snapshot.products[0].cest = "0100100";
  fiscalTotal(st, "107.20", { icms_st: "7.20" });
  let result = calculatePreparationTaxes(st);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.item_taxes[0].icms.st, { modalidadeBc: 4, mva: 40, reducaoBc: 0, baseCalculo: 140, aliquota: 18, valor: 7.2 });
  delete st.snapshot.products[0].cest;
  assert.ok(calculatePreparationTaxes(st).blockers.some(b => b.code === "fiscal_product_incomplete" && b.field === "items.0.cest" && b.correction.screen === "products" && b.correction.id === st.snapshot.items[0].product_id));
  st.snapshot.products[0].cest = "0100100";
  delete st.snapshot.nature.rules[0].data.st_mva;
  assert.ok(calculatePreparationTaxes(st).blockers.some(b => b.field === "items.0.icms.st_mva"));
  const deferred = taxSources(f, "3", { situation: "51", deferral_rate: "33.3333" });
  result = calculatePreparationTaxes(deferred);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.item_taxes[0].icms.diferimento, { valorOperacao: 18, percentual: 33.3333, valorDiferido: 6 });
  assert.equal(result.item_taxes[0].icms.valor, 12);
  const credit = taxSources(f, "1", { situation: "101", credit_rate: "3.2000" });
  result = calculatePreparationTaxes(credit);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.item_taxes[0].icms.creditoSimples, { aliquota: 3.2, valor: 3.2 });
  const retained = taxSources(f, "1", { situation: "500", retained_rate: "18.0000" });
  Object.assign(retained.snapshot.products[0], { icms_st_retention_base: "80.00", icms_st_retention_value: "12.00", icms_own_substitute_value: "2.00" });
  result = calculatePreparationTaxes(retained);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.item_taxes[0].icms.retidoAnteriormente, { baseCalculo: 80, aliquotaConsumidorFinal: 18, valor: 12, valorSubstituto: 2 });
});

test("DIFAL usa destino, alíquotas e FCP calculados sem base presumida", t => {
  const source = taxSources(fixture(t), "3", { cfop: "6102", rate: "12.0000", difal_base_rate: "100.0000", difal_internal_rate: "18.0000", difal_fcp_rate: "2.0000" });
  source.snapshot.recipient.state = "RJ";
  source.tax_sources.settings.difal_default = "goods";
  let result = calculatePreparationTaxes(source);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.item_taxes[0].difal, { baseCalculo: 100, aliquotaInterna: 18, aliquotaInterestadual: 12, valorDestino: 6,
    fcp: { baseCalculo: 100, aliquota: 2, valor: 2 } });
  source.tax_sources.settings.difal_default = "validated";
  result = calculatePreparationTaxes(source);
  assert.ok(codes(result).includes("fiscal_operation_unsupported"));
  assert.ok(result.blockers.some(b => b.field === "items.0.icms.difal_base"));
});

test("rateios em centavos são estáveis, exatos e não alteram totais comerciais", t => {
  const source = taxSources(fixture(t), "1");
  source.snapshot.items = [0, 1, 2].map(i => ({ ...source.snapshot.items[0], id: randomUUID(), position: i + 1, unit_price: "1.00", gross: "1.00", total: "1.00" }));
  Object.assign(source.snapshot.document, { freight: "0.01", other_expenses: "0.02" });
  Object.assign(source.snapshot.document.totals, { gross: "3.00", discount: "0.01", freight: "0.01", other_expenses: "0.02" });
  fiscalTotal(source, "3.02");
  const result = calculatePreparationTaxes(source);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.allocations.freight, ["0", "0", "1"]);
  assert.deepEqual(result.allocations.other_expenses, ["0", "0", "2"]);
  assert.deepEqual(result.allocations.discount, ["0", "0", "1"]);
  assert.equal(result.total_cents, "302");
  assert.deepEqual(calculatePreparationTaxes(source), result);
  source.snapshot.document.totals.total = "3.01";
  assert.ok(codes(calculatePreparationTaxes(source)).includes("fiscal_total_mismatch"));
  source.snapshot.items[0].quantity = "1.00001";
  assert.ok(calculatePreparationTaxes(source).blockers.some(b => b.field === "items.0.quantity"));
  source.snapshot.items[0].quantity = "100000000000.0000";
  assert.ok(calculatePreparationTaxes(source).blockers.some(b => b.field === "items.0.quantity"));
});

test("reforma e grupos não representáveis nunca desaparecem silenciosamente", t => {
  const f = fixture(t);
  const source = taxSources(f, "3", { situation: "02", st_pis_rate: "1.0000", st_cofins_rate: "2.0000" });
  source.snapshot.products[0].ipi_fixed_value = "1.00";
  source.snapshot.products[0].reform_class = { cst: "000", cclasstrib: "000001" };
  source.snapshot.nature.rules[1].data = { situation: "03", unit_value: "1.0000" };
  const result = calculatePreparationTaxes(source);
  assert.ok(codes(result).includes("fiscal_reform_required"));
  for (const field of ["items.0.icms.situation", "items.0.icms.st_pis_rate", "items.0.icms.st_cofins_rate", "items.0.product.ipi_fixed_value", "items.0.pis.situation"])
    assert.ok(result.blockers.some(b => b.field === field), field);
  assert.equal(JSON.stringify(result.item_taxes).includes("ibsCbs"), false);
  assert.equal(JSON.stringify(result.item_taxes).includes("impostoSeletivo"), false);
});

test("redução e desoneração fecham total; campos desconhecidos e textos longos bloqueiam", t => {
  const source = taxSources(fixture(t), "3", { situation: "20", base_rate: "50.0000", deson_reason: "9", deson_deduct: true, benefit_code: "SP123456" });
  fiscalTotal(source, "91.00");
  let result = calculatePreparationTaxes(source);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.item_taxes[0].icms.baseCalculo, 50);
  assert.equal(result.item_taxes[0].icms.reducaoBc, 50);
  assert.deepEqual(result.item_taxes[0].icms.desoneracao, { valor: 9, motivo: 9, deduzDoTotal: true });
  assert.equal(result.item_details[0].codigoBeneficioFiscal, "SP123456");
  source.snapshot.nature.rules[0].data.st_fcp_value = "1.00";
  source.snapshot.nature.rules[0].data.grupo_futuro = { valor: "1.00" };
  source.snapshot.nature.additional_info = "A".repeat(5000);
  source.snapshot.nature.rules[0].additional_info = "Informação fiscal que não pode ser descartada.";
  result = calculatePreparationTaxes(source);
  for (const field of ["items.0.icms.st_fcp_value", "items.0.icms.grupo_futuro", "nature.additional_info"])
    assert.ok(result.blockers.some(b => b.field === field), field);
});

test("base calculada por pauta respeita o limite do cofre mesmo com imposto zero e total baixo", t => {
  const f = fixture(t), source = taxSources(f, "3", { bc_mode: "1", pauta_value: "99999999999.0000", rate: "0.0000" });
  const options = { environment: "homologacao", reference: `wb.${f.order.id}.v1` };
  const setQuantity = (quantity, gross) => {
    Object.assign(source.snapshot.items[0], { quantity, unit_price: "0.0100000000", gross, total: gross });
    source.snapshot.document.totals.gross = gross;
    fiscalTotal(source, gross);
    source.snapshot.payments = [{ ...source.snapshot.payments[0], amount: gross }];
  };
  setQuantity("100.0000", "1.00");
  let taxes = calculatePreparationTaxes(source);
  assert.deepEqual(taxes.blockers, []);
  assert.equal(taxes.item_taxes[0].icms.baseCalculo, 9999999999900);
  let mapped = mapPreparation(source, taxes, options);
  assert.deepEqual(mapped.blockers, []);
  assert.notEqual(mapped.body, null);
  setQuantity("101.0000", "1.01");
  taxes = calculatePreparationTaxes(source);
  assert.equal(taxes.calculation.items[0].icms.base, "10099999999899.00");
  assert.equal(taxes.total_cents, "101");
  assert.ok(taxes.blockers.some(b => b.code === "fiscal_tax_data_missing" && b.field === "items.0.icms.baseCalculo"));
  assert.equal(Object.hasOwn(taxes.item_taxes[0].icms, "baseCalculo"), false);
  mapped = mapPreparation(source, taxes, options);
  assert.equal(mapped.body, null);
  assert.deepEqual(codes(mapped), ["fiscal_tax_data_missing"]);
});

test("modalidades inválidas bloqueiam e origem e retenção apontam o cadastro do produto", t => {
  const f = fixture(t), source = taxSources(f, "3", { bc_mode: "9" });
  let result = calculatePreparationTaxes(source);
  assert.ok(result.blockers.some(b => b.field === "items.0.icms.modalidadeBc"));
  assert.equal(Object.hasOwn(result.item_taxes[0].icms, "modalidadeBc"), false);
  source.snapshot.nature.rules[0].data.bc_mode = "3";
  delete source.snapshot.products[0].origin;
  result = calculatePreparationTaxes(source);
  assert.ok(result.blockers.some(b => b.code === "fiscal_product_incomplete" && b.field === "items.0.origin" && b.correction.screen === "products" && b.correction.id === f.product.id));
  const retained = taxSources(f, "1", { situation: "500", retained_rate: "18.0000" });
  delete retained.snapshot.products[0].icms_st_retention_base;
  retained.snapshot.products[0].icms_st_retention_value = "inválido";
  result = calculatePreparationTaxes(retained);
  for (const field of ["icms_st_retention_base", "icms_st_retention_value"])
    assert.ok(result.blockers.some(b => b.field === `items.0.product.${field}` && b.correction.screen === "products" && b.correction.id === f.product.id));
});
