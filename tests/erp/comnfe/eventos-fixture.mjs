// Montagem compartilhada dos testes de carta de correção, inutilização e
// devolução: pedido com depósito, conta e saldo; NF-e preparada, autorizada
// (cofre simulado, sem rede) e os efeitos da venda aplicados.
import { randomUUID } from "node:crypto";
import { com1Fixture, COM1_DATE } from "./fixtures.mjs";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { applyEffects, reverseEffects } from "../../../src/erp/domains/fiscal/comnfe/effects.ts";
import {
  com1Hash, com1Reference, savePreparation, claimStoredOperation, recordExternalEvidence, getStoredEmission,
} from "../../../src/erp/domains/fiscal/comnfe/store.ts";

export const connection = com1Hash("cofre-simulado-eventos");
export const accessKey = "35261111222333000181550010000000011000000010";
export const returnKey = "35261111222333000181550010000000021000000025";
export const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];
export const count = (f, table, where = "1=1", ...args) => Number(row(f, `SELECT count(*) n FROM ${table} WHERE ${where}`, ...args).n);
const current = f => row(f, "SELECT * FROM erp_documents__document WHERE id=?", f.order.id);
const version = f => current(f).version;
const items = f => f.db.exec("SELECT data,product_id FROM erp_documents__item WHERE document_id=? ORDER BY position", f.order.id).rows
  .map(i => ({ ...JSON.parse(i.data), product_id: i.product_id }));

export function authorizedResult(reference, changes = {}) {
  return { kind: "nfe", status: "authorized", provider_ref: "nfe_eventos", reference, environment: "homologacao",
    series: "1", number: 1, access_key: accessKey, protocol: "135260000000001", nfse_number: null, issued_at: "2026-11-19T12:00:00Z",
    authorized_at: "2026-11-19T12:00:01Z", total: 51, qr_code: null, consult_url: null, corrections: 0, messages: [], xml_available: true,
    replayed: false, event_repeated: null, contingency: null, ...changes };
}

/** Saldo em unidades com seis casas (a coluna guarda o valor escalado). */
export const balance = f => {
  const scaled = String(row(f, "SELECT CAST(quantity AS TEXT) q FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", f.product.id, f.warehouse.id).q).padStart(7, "0");
  return `${scaled.slice(0, -6)}.${scaled.slice(-6)}`;
};

export function eventsFixture(t, options = {}) {
  const f = com1Fixture(t);
  t.after(installCommercialNfeSlots({ applyEffects, reverseEffects }));
  f.warehouse = f.catalog("warehouses", { name: "Depósito do ensaio" });
  f.category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas do ensaio" } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa do ensaio", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.orderBody = { ...f.orderBody, warehouse_id: f.warehouse.id, category_id: f.category.id };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_body: f.orderBody }).document;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Saldo inicial do ensaio", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: f.warehouse.id, quantity: "100", expected_version: 0 }] });
  f.order = f.rpc("erp_document_transition", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_status: "verified", p_reason: "Conferência do pedido" }).document;
  const settings = f.rpc("erp_com1_config_get");
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: settings.version, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization" } });
  const d = current(f), body = JSON.parse(d.body), command = randomUUID();
  const prepared = f.transaction(ctx => savePreparation(ctx, {
    command_id: command, args: { document_id: d.id, command_id: command }, document_id: d.id, expected_document_version: d.version,
    environment: "homologacao", connection_fingerprint: connection,
    snapshot: { document: { ...d, body }, items: items(f), company: f.company, recipient: {}, products: [], nature: {}, payments: [], transport: {}, sources: [] },
    tax_sources: {}, commercial_hash: com1Hash(body), source_fingerprint: com1Hash(body),
    body: { ambiente: "homologacao", referencia: com1Reference(d.id, 1), serie: 1, naturezaOperacao: "Venda", presenca: "presencial", consumidorFinal: true,
      emitente: { cnpj: f.company.cnpj, razaoSocial: f.company.legal_name }, destinatario: { cnpj: "19131243000197", nome: "Cliente do Ensaio" },
      itens: [{ codigo: "P1", descricao: "Mercadoria do Ensaio", ncm: "84713012", cfop: options.cfop ?? "5102", unidade: "UN", quantidade: 2, valorUnitario: 25.5,
        valorTotal: 51, tributavel: { unidade: "UN", quantidade: 2, valorUnitario: 25.5 },
        impostos: { icms: { situacao: "102", origem: 0 }, pis: { situacao: "07" }, cofins: { situacao: "07", baseCalculo: 51, aliquota: 3, valor: 1.53 } } }],
      pagamentos: [{ forma: "15", valor: 51 }] },
    calculation: { total_cents: "5100" }, blockers: [],
  })).emission;
  const claimed = f.transaction(ctx => claimStoredOperation(ctx, { emission_id: prepared.id, command_id: randomUUID(), action: "emit",
    expected_version: prepared.version, body_revision: prepared.current_body_revision, body_hash: prepared.revision.body_hash,
    source_fingerprint: prepared.revision.source_fingerprint, connection_fingerprint: connection }));
  f.emission = f.transaction(ctx => recordExternalEvidence(ctx, { emission_id: prepared.id, command_id: claimed.command.id, claim_token: claimed.command.token,
    connection_fingerprint: connection, result: authorizedResult(prepared.reference) }));
  if (options.effects !== false) for (const axis of ["stock", "finance"]) {
    const emission = f.transaction(ctx => getStoredEmission(ctx, f.emission.id));
    f.rpc("erp_com1_effect_apply", { p_input: { emission_id: emission.id, command_id: randomUUID(), expected_version: emission.version, axis, intent: "apply" } });
  }
  return f;
}
