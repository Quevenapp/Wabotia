/** Balcão com NFC-e (modelo 65): a venda finalizada no Caixa / PDV vira um
 * PedidoNfce pela mesma máquina da NF-e comercial (preparo congelado, claim,
 * evidência, retomada, cancelamento, efeitos e auditoria), nas tabelas irmãs
 * counter_*. Tudo aqui é síncrono e sem I/O; o cofre é chamado pelo serviço
 * HTTP entre estas transações (commercial-nfe/nfce-service.ts).
 */
import { createHash } from "node:crypto";
import { one, type Row } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireErpParts } from "../../../engine/parts-gate.ts";
import { erpRequirement } from "../../../parts.ts";
import type { EmissionView, FiscalBlocker, FiscalChoices, JsonObject, PedidoNfe, PreparationResult } from "../../../commercial-nfe/contracts.ts";
import { formatScaled } from "../../../engine/dec.ts";
import { cnpj as normalizeCnpj, cpfValid } from "../../company/internal.ts";
import { contactScope, contactVisibleTo } from "../../catalog/contact.ts";
import { requireCom1Access } from "./access.ts";
import { withCom1Compensation } from "./effect-policy.ts";
import { mapPreparation } from "./mapper.ts";
import { COM1_MODEL_TABLES, NFCE_SETTINGS_TABLE, withCom1Model } from "./model.ts";
import { preparationEffectsPreview } from "./prepare.ts";
import { requireCommercialEmissionVisible } from "./reads.ts";
import { readCommercialSettings } from "./settings.ts";
import { capturePreparationSources, type PreparationSources } from "./source.ts";
import {
  appendCom1Audit, com1Reference, com1Uuid, findOrderEmission, finishCommand, getEmissionView, replayCommand, savePreparation, startCommand,
} from "./store.ts";
import { calculatePreparationTaxes } from "./taxes.ts";

type Obj = Record<string, unknown>;
const T = COM1_MODEL_TABLES.nfce;
const invalid = (code = "com1_input_invalid"): never => raise("22023", code);
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
const PAYMENT_TYPES = new Set(["01", "02", "03", "04", "05", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "90", "91", "99"]);
/** Emissão do cupom que já foi ao cofre: nunca reescrever, só consultar. */
export const NFCE_IN_FLIGHT = ["enviando", "processando", "incerta"] as const;
/** Grupos e campos que o modelo 65 não tem: os bloqueios da NF-e sobre eles não valem para o cupom. */
const NFE_ONLY = /^(destinatario|recipient\.|transporte|cobranca|pagamentos|dataSaida|destinoOperacao|consumidorFinal|presenca|totais|troco)/;

function requireBalcaoParts(ctx: RpcContext): void {
  requireErpParts(ctx, erpRequirement("erp-vendas", "erp-fiscal", "erp-pdv"));
}
function input(args: RpcArgs, allowed: readonly string[], required: readonly string[]): Obj {
  const value = object(args.p_input);
  if (args.p_input !== value || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}
const expectedPerson = (args: RpcArgs): string => typeof args.p_user_id === "string" ? args.p_user_id : invalid();
/** Subcomando determinístico do comando público (mesma regra do erp_pos.step). */
export function nfceStep(command: string, name: string): string {
  const h = createHash("sha256").update(`${command}:nfce:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------- Natureza do cupom

interface NatureChoice { id: string; description: string }
function natureCandidates(ctx: RpcContext): NatureChoice[] {
  const crt = one(ctx.db, 'SELECT crt FROM "erp_company__fiscal" WHERE singleton=1')?.crt ?? null;
  return ctx.db.exec(`SELECT id,description FROM "erp_fiscal_invoices__nature" WHERE direction='1' AND active=1 AND deleted_at IS NULL
    AND return_operation=0 AND invoiced=1 AND crt=? ORDER BY final_consumer DESC,description,id`, crt).rows
    .map(row => ({ id: String(row.id), description: String(row.description) }));
}
interface NfceConfig { version: number; nature_id: string | null; resolved_nature_id: string | null; natures: NatureChoice[]; updated_at: string | null; updated_by: string | null }
export function readNfceConfig(ctx: RpcContext): NfceConfig {
  const row = one(ctx.db, `SELECT version,nature_id,CAST(updated_at AS TEXT) updated_at,updated_by FROM ${NFCE_SETTINGS_TABLE} WHERE id=1`);
  const natures = natureCandidates(ctx);
  const chosen = typeof row?.nature_id === "string" && natures.some(n => n.id === row.nature_id) ? String(row.nature_id) : null;
  // Sem escolha, só uma natureza possível é usada sozinha; duas ou mais pedem a escolha.
  return { version: Number(row?.version ?? 1), nature_id: row?.nature_id == null ? null : String(row.nature_id),
    resolved_nature_id: chosen ?? (natures.length === 1 ? natures[0].id : null), natures,
    updated_at: row?.updated_at == null ? null : String(row.updated_at), updated_by: row?.updated_by == null ? null : String(row.updated_by) };
}
function saveNfceConfig(ctx: RpcContext, value: Obj): NfceConfig {
  const actor = requireCom1Access(ctx, "configure");
  com1Uuid(value.command_id);
  if (!Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1) invalid();
  if (value.nature_id !== null) com1Uuid(value.nature_id);
  return ctx.db.transaction(() => {
    const args = { scope: "nfce_config", expected_version: value.expected_version, nature_id: value.nature_id };
    const replay = replayCommand(ctx, { command_id: String(value.command_id), action: "config_save", args });
    if (replay) return readNfceConfig(ctx);
    const before = readNfceConfig(ctx);
    if (before.version !== value.expected_version) raise("40001", "fiscal_config_conflict");
    if (value.nature_id !== null && !before.natures.some(n => n.id === value.nature_id)) raise("22023", "fiscal_nature_missing");
    const at = String(ctx.clock.next());
    ctx.db.exec(`INSERT INTO ${NFCE_SETTINGS_TABLE} (id,version,nature_id,updated_at,updated_by) VALUES (1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,nature_id=excluded.nature_id,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      before.version + 1, value.nature_id, at, actor.user_id);
    const command = startCommand(ctx, { command_id: String(value.command_id), action: "config_save", args });
    finishCommand(ctx, command.id, "completed", { version: before.version + 1 });
    appendCom1Audit(ctx, { command, action: "nfce_config_save", before: { version: before.version }, after: { version: before.version + 1 } });
    return readNfceConfig(ctx);
  });
}

// ---------------------------------------------------------------- Preparo do cupom

interface SalePayment { position: number; payment_type: string; method_name: string; days: number; amount_cents: bigint;
  card_brand: unknown; card_integration: unknown; card_cnpj: unknown }
function salePayments(ctx: RpcContext, saleId: string): SalePayment[] {
  return ctx.db.exec(`SELECT p.position,p.payment_type,p.method_name,p.days,CAST(p.amount_cents AS TEXT) amount_cents,
      m.card_brand,m.card_integration,m.card_cnpj FROM "erp_pos__sale_payment" p
    LEFT JOIN "erp_catalog__payment_method" m ON m.id=p.payment_method_id WHERE p.sale_id=? ORDER BY p.position`, saleId).rows
    .map(row => ({ position: Number(row.position), payment_type: text(row.payment_type), method_name: text(row.method_name), days: Number(row.days),
      amount_cents: BigInt(String(row.amount_cents)), card_brand: row.card_brand, card_integration: row.card_integration, card_cnpj: row.card_cnpj }));
}
const money = (cents: bigint): number => Number(formatScaled(cents, 2));
const validCnpj = (value: string): boolean => { try { return normalizeCnpj(value) === value; } catch { return false; } };

/** CPF/CNPJ opcional informado no fechamento. Só dígitos (o CNPJ pode ter letras). */
export function nfceConsumer(value: unknown): { cpf: string } | { cnpj: string } | null {
  if (value === undefined || value === null || value === "") return null;
  const document = typeof value === "string" ? value.replace(/[ .\-/]/g, "").toUpperCase() : "";
  if (/^\d{11}$/.test(document) && cpfValid(document)) return { cpf: document };
  if (/^[0-9A-Z]{12}\d{2}$/.test(document) && validCnpj(document)) return { cnpj: document };
  return raise("22023", "fiscal_consumer_document_invalid");
}

/** Pagamentos detalhados por forma, com troco (vPag inclui o troco do dinheiro). */
function nfcePayments(ctx: RpcContext, sale: Row, totalCents: bigint | null) {
  const blockers: FiscalBlocker[] = [];
  const problem = (field: string, message: string) => blockers.push({ code: "fiscal_payment_incomplete", field, message,
    correction: { screen: "payment_methods", field } });
  const rows = salePayments(ctx, String(sale.id)), change = BigInt(String(sale.change_cents ?? "0"));
  if (!rows.length) problem("pagamentos", "A venda não tem pagamento registrado; registre o pagamento no caixa.");
  let changeLeft = change, sum = 0n;
  const payments = rows.map((row, index) => {
    const field = `pagamentos[${index}]`;
    if (!PAYMENT_TYPES.has(row.payment_type)) problem(`${field}.forma`, `A forma de pagamento ${row.method_name} está sem o código fiscal. Confira em Formas de pagamento.`);
    let cents = row.amount_cents;
    if (changeLeft > 0n && row.days === 0 && row.payment_type === "01") { cents += changeLeft; changeLeft = 0n; }
    sum += cents;
    const payment: Obj = { forma: row.payment_type, valor: money(cents), indicador: row.days === 0 ? "a_vista" : "a_prazo" };
    if (row.payment_type === "99") payment.descricao = row.method_name.slice(0, 60).padEnd(2, ".");
    if (["03", "04"].includes(row.payment_type)) {
      const card: Obj = { integracao: text(row.card_integration) === "1" ? "integrado" : "nao_integrado" };
      const brand = text(row.card_brand), acquirer = text(row.card_cnpj).replace(/[ .\-/]/g, "").toUpperCase();
      if (brand) { if (/^\d{2}$/.test(brand)) card.bandeira = brand; else problem(`${field}.cartao.bandeira`, `Confira a bandeira do cartão da forma ${row.method_name}.`); }
      if (acquirer) { if (validCnpj(acquirer)) card.cnpjCredenciadora = acquirer; else problem(`${field}.cartao.cnpjCredenciadora`, `Confira o CNPJ da credenciadora da forma ${row.method_name}.`); }
      if (card.integracao === "integrado" && (!card.bandeira || !card.cnpjCredenciadora))
        problem(`${field}.cartao`, `Cartão integrado (TEF) precisa de bandeira e CNPJ da credenciadora na forma ${row.method_name}.`);
      payment.cartao = card;
    }
    return payment;
  });
  if (changeLeft > 0n) problem("troco", "O troco só sai em dinheiro: a venda tem troco sem pagamento à vista em dinheiro.");
  if (totalCents !== null && sum - change !== totalCents)
    blockers.push({ code: "fiscal_total_mismatch", field: "pagamentos.valor", message: "Os pagamentos da venda não fecham com o total do cupom. Confira a venda no caixa.",
      correction: { screen: "sales_orders", id: String(sale.document_id) } });
  return { payments, change, blockers };
}

function configurationBlockers(ctx: RpcContext, issuerCnpj: unknown, series: number | null, seriesCount: number | null): FiscalBlocker[] {
  const settings = readCommercialSettings(ctx), blockers: FiscalBlocker[] = [];
  const block = (code: string, field: string, message: string) => blockers.push({ code, field, message, correction: { screen: "fiscal_settings", field } });
  const connection = settings.connection_public;
  if (!connection || !settings.connection_fingerprint) block("fiscal_provider_not_configured", "connection", "Configure o endereço e a chave do cofre para emitir o cupom.");
  else {
    if (connection.compatible !== true) block("fiscal_provider_incompatible", "connection.version", "A versão do cofre não é compatível com esta integração.");
    if (!Array.isArray(connection.environments) || !connection.environments.includes(settings.environment))
      block("fiscal_environment_not_allowed", "environment", "A chave do cofre não permite o ambiente selecionado.");
    if (connection.issuer_cnpj !== issuerCnpj) block("fiscal_issuer_mismatch", "company.cnpj", "O CNPJ da empresa difere do emitente configurado no cofre.");
  }
  if (settings.environment === "producao" && (!settings.production_enabled_at || !settings.tax_limits_acknowledged_at))
    block("fiscal_production_not_enabled", "environment", "Um administrador precisa habilitar a emissão em produção.");
  if (seriesCount === 0 || (series === null && seriesCount !== null && seriesCount !== 1))
    block("fiscal_series_required", "choices.series", "O cofre não tem série de NFC-e para este ambiente. Cadastre a série de NFC-e no cofre e teste a conexão de novo.");
  return blockers;
}

function saleOf(ctx: RpcContext, saleId: unknown): Row {
  com1Uuid(saleId);
  const sale = one(ctx.db, `SELECT s.*,CAST(s.total_cents AS TEXT) total_cents,CAST(s.change_cents AS TEXT) change_cents,d.version d_version,d.status d_status
    FROM "erp_pos__sale" s JOIN "erp_documents__document" d ON d.id=s.document_id WHERE s.id=?`, saleId);
  if (!sale) raise("P0002", "erp_pos_not_found");
  return sale!;
}

/** Outra família (NF-e do pedido) já usou esta venda: o cupom não sai por cima dela. */
function nfeInUse(ctx: RpcContext, documentId: string): boolean {
  const other = withCom1Model("nfe", () => findOrderEmission(ctx, documentId));
  return !!other && !["bloqueada", "preparada", "rejeitada", "cancelada", "denegada", "arquivada"].includes(other.status);
}

export function prepareNfce(ctx: RpcContext, value: Obj): PreparationResult {
  return withCom1Model("nfce", () => {
    requireCom1Access(ctx, "prepare");
    requireBalcaoParts(ctx);
    com1Uuid(value.command_id);
    const series = value.series === undefined || value.series === null ? null : Number(value.series);
    const seriesCount = value.series_count === undefined ? null : Number(value.series_count);
    if ((series !== null && (!Number.isSafeInteger(series) || series < 0 || series > 889)) ||
        (seriesCount !== null && (!Number.isSafeInteger(seriesCount) || seriesCount < 0 || seriesCount > 1000)) ||
        (value.expected_emission_version !== undefined && (!Number.isSafeInteger(value.expected_emission_version) || Number(value.expected_emission_version) < 1))) invalid();
    const consumer = nfceConsumer(value.consumer_document);
    return ctx.db.transaction(() => {
      const args = { ...value };
      const receipt = replayCommand(ctx, { command_id: String(value.command_id), action: "prepare", args });
      if (receipt?.emission_id) {
        const emission = getEmissionView(ctx, receipt.emission_id);
        requireCommercialEmissionVisible(ctx, emission);
        return { emission, blockers: emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, emission.id), replayed: true };
      }
      const sale = saleOf(ctx, value.sale_id), documentId = String(sale.document_id);
      if (sale.state !== "finished") raise("55000", "nfce_sale_not_finished");
      if (nfeInUse(ctx, documentId)) raise("40001", "fiscal_emission_open");
      const settings = readCommercialSettings(ctx);
      const previous = findOrderEmission(ctx, documentId);
      if (previous && previous.environment !== settings.environment) raise("40001", "fiscal_environment_conflict");
      if (previous && !["bloqueada", "preparada", "rejeitada"].includes(previous.status)) raise("40001", "fiscal_emission_open");
      if (previous && previous.version !== value.expected_emission_version) raise("40001", "com1_version_conflict");
      const fiscalVersion = previous?.fiscal_version ?? 1, reference = com1Reference(documentId, fiscalVersion);
      const config = readNfceConfig(ctx);
      const choices: FiscalChoices = { nature_id: config.resolved_nature_id ?? "", presence: "presencial", final_consumer: true, series };
      const captured = capturePreparationSources(ctx, { document_id: documentId, expected_document_version: Number(sale.d_version),
        command_id: String(value.command_id), choices });
      // O cupom é de consumidor final, presencial e interno: o cadastro do
      // "Consumidor final" do caixa não precisa de endereço nem de IE.
      const company = object(captured.snapshot.company);
      const sources: PreparationSources = { ...captured, snapshot: { ...captured.snapshot,
        recipient: { state: (company.state ?? null) as string | null, taxpayer: "9", ...(consumer ?? {}) } },
        blockers: captured.blockers.filter(b => !NFE_ONLY.test(b.field)) };
      const taxes = calculatePreparationTaxes(sources);
      const mapped = mapPreparation(sources, taxes, { environment: settings.environment, reference, series });
      const total = taxes.total_cents !== null && /^\d+$/.test(taxes.total_cents) ? BigInt(taxes.total_cents) : null;
      const paid = nfcePayments(ctx, sale, total);
      const nature = config.resolved_nature_id ? [] : [{ code: "fiscal_nature_missing", field: "naturezaOperacao",
        message: config.natures.length ? "Escolha a natureza de operação do cupom em Preferências do Fiscal (há mais de uma possível)." : "Cadastre uma natureza de operação de venda para o cupom fiscal.",
        correction: { screen: "fiscal_natures", field: "naturezaOperacao" } } as FiscalBlocker];
      const blockers = [...new Map([...mapped.blockers.filter(b => !NFE_ONLY.test(b.field)), ...nature, ...paid.blockers,
        ...configurationBlockers(ctx, company.cnpj, series, seriesCount)].map(b => [`${b.field}|${b.code}|${b.item_id ?? ""}`, b])).values()]
        .sort((a, b) => a.field < b.field ? -1 : a.field > b.field ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
      const draft = object(mapped.draft);
      const body: Obj = { ambiente: settings.environment, referencia: reference, naturezaOperacao: draft.naturezaOperacao, finalidade: "normal",
        presenca: "presencial", emitente: draft.emitente, itens: draft.itens, pagamentos: paid.payments };
      if (series !== null) body.serie = series;
      if (paid.change > 0n) body.troco = money(paid.change);
      if (consumer) body.destinatario = consumer;
      for (const key of ["informacoesComplementares", "informacoesFisco", "responsavelTecnico"]) if (draft[key] !== undefined) body[key] = draft[key];
      const calculation = { ...mapped.calculation, model: "nfce", sale_id: String(sale.id), payments: paid.payments,
        change_cents: paid.change.toString(), consumer_identified: !!consumer } as JsonObject;
      const saved = savePreparation(ctx, { command_id: String(value.command_id), args, document_id: documentId,
        expected_document_version: Number(sale.d_version), ...(previous ? { expected_emission_version: previous.version } : {}),
        environment: settings.environment, connection_fingerprint: settings.connection_fingerprint,
        snapshot: sources.snapshot, tax_sources: sources.tax_sources, commercial_hash: sources.commercial_hash,
        source_fingerprint: captured.source_fingerprint, body: blockers.length ? null : body as unknown as PedidoNfe, calculation, blockers });
      return { ...saved, blockers: saved.emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, saved.emission.id) };
    });
  });
}

// ---------------------------------------------------------------- Cupons das vendas

export interface NfceSaleRow {
  sale_id: string; document_id: string; number: string | null; sale_state: string; kind: string; total_cents: string;
  finished_at: string | null; cash_session_id: string | null; contact_name: string; sale_version: number;
  coupon: null | { emission_id: string; status: string; provider_status: string | null; version: number; body_revision: number;
    body_hash: string | null; messages: { code: string; description: string }[]; blockers: FiscalBlocker[];
    number: number | null; series: number | null; access_key: string | null; authorized_at: string | null;
    cancellation: null | { state: string; messages: { code: string; description: string }[] }; environment: string };
  /** autorizado | pendente | cancelado | sem_cupom (venda cancelada sem cupom). */
  situation: "autorizado" | "pendente" | "cancelado" | "sem_cupom";
}
const micros = (day: string, end: boolean) => String(BigInt(Date.parse(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}-03:00`)) * 1000n);
function listNfceSales(ctx: RpcContext, value: Obj) {
  return withCom1Model("nfce", () => {
    requireCom1Access(ctx, "read");
    requireBalcaoParts(ctx);
    if (!["homologacao", "producao"].includes(String(value.environment))) invalid("com1_environment_required");
    const page = value.page === undefined ? 1 : Number(value.page), per = value.per_page === undefined ? 50 : Number(value.per_page);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(per) || per < 1 || per > 100) invalid("com1_invalid_page");
    const day = /^\d{4}-\d{2}-\d{2}$/;
    for (const key of ["from", "to"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !day.test(value[key] as string))) invalid();
    if (value.pending_only !== undefined && typeof value.pending_only !== "boolean") invalid();
    if (value.cash_session_id !== undefined) com1Uuid(value.cash_session_id);
    if (value.sale_id !== undefined) com1Uuid(value.sale_id);
    const filters = ["s.state IN ('finished','cancelled')"], values: unknown[] = [];
    if (value.sale_id) { filters.push("s.id=?"); values.push(value.sale_id); }
    if (value.cash_session_id) { filters.push("s.cash_session_id=?"); values.push(value.cash_session_id); }
    if (value.from) { filters.push("s.finished_at>=?"); values.push(micros(String(value.from), false)); }
    if (value.to) { filters.push("s.finished_at<=?"); values.push(micros(String(value.to), true)); }
    // Sem caixa, venda nem período: só as vendas que já pediram cupom e ainda não têm nota.
    const scoped = !!(value.sale_id || value.cash_session_id || value.from || value.to);
    const latest = `(SELECT e.id FROM ${T.emission} e WHERE e.document_id=s.document_id AND e.environment=? ORDER BY e.fiscal_version DESC LIMIT 1)`;
    const rows = ctx.db.exec(`SELECT s.id,s.document_id,s.state,s.kind,s.version,s.cash_session_id,CAST(s.total_cents AS TEXT) total_cents,
        CAST(s.finished_at AS TEXT) finished_at,CAST(d.number AS TEXT) number,d.contact_snapshot,d.body,${latest} emission_id
      FROM "erp_pos__sale" s JOIN "erp_documents__document" d ON d.id=s.document_id
      WHERE ${filters.join(" AND ")} ORDER BY s.finished_at DESC,s.id`, value.environment, ...values).rows;
    const restricted = new Set(ctx.identity.customer_privacy?.restricted_contact_ids ?? []);
    const scope = contactScope(ctx.db, ctx.identity.actor?.user_id ?? null);
    const items: NfceSaleRow[] = [];
    for (const row of rows) {
      const body = object(JSON.parse(String(row.body ?? "{}"))), contact = typeof body.contact_id === "string" ? body.contact_id : null;
      if ((contact && restricted.has(contact)) || !contactVisibleTo(ctx.db, scope, contact)) continue;
      const view: EmissionView | null = row.emission_id ? getEmissionView(ctx, String(row.emission_id)) : null;
      const situation: NfceSaleRow["situation"] = view?.status === "autorizada" ? "autorizado" : view?.status === "cancelada" ? "cancelado"
        : row.state === "cancelled" ? "sem_cupom" : "pendente";
      if (!scoped && (!view || situation !== "pendente")) continue;
      if (value.pending_only && situation !== "pendente") continue;
      items.push({ sale_id: String(row.id), document_id: String(row.document_id), number: row.number == null ? null : String(row.number),
        sale_state: String(row.state), kind: String(row.kind), total_cents: String(row.total_cents), finished_at: row.finished_at == null ? null : String(row.finished_at),
        cash_session_id: row.cash_session_id == null ? null : String(row.cash_session_id),
        contact_name: text(object(JSON.parse(String(row.contact_snapshot ?? "{}"))).name).slice(0, 200), sale_version: Number(row.version),
        coupon: view ? { emission_id: view.id, status: view.status, provider_status: view.provider_status, version: view.version,
          body_revision: view.current_body_revision, body_hash: view.revision.body_hash, messages: view.messages, blockers: view.revision.blockers,
          number: view.number, series: view.series, access_key: view.access_key, authorized_at: view.authorized_at, environment: view.environment,
          cancellation: view.cancellation ? { state: view.cancellation.state, messages: view.cancellation.messages } : null } : null,
        situation });
    }
    const counts = { autorizado: 0, pendente: 0, cancelado: 0 };
    for (const item of items) if (item.situation !== "sem_cupom") counts[item.situation]++;
    return { items: items.slice((page - 1) * per, page * per), total: items.length, page, per_page: per, counts };
  });
}

// ---------------------------------------------------------------- Cancelamento da venda

/** Depois do cancelamento fiscal confirmado, cancela a venda do caixa pelo RPC
 * do PDV dentro da capacidade da compensação (effect-policy): o estorno de
 * estoque e títulos do pedido fica permitido só para este pedido. */
function cancelNfceSale(ctx: RpcContext, value: Obj) {
  return withCom1Model("nfce", () => {
    const actor = requireCom1Access(ctx, "cancel");
    requireBalcaoParts(ctx);
    com1Uuid(value.emission_id); com1Uuid(value.command_id);
    if (typeof value.reason !== "string" || [...value.reason.trim()].length < 3 || [...value.reason].length > 1000) invalid("erp_pos_reason_required");
    if (value.physical_return_confirmed !== undefined && typeof value.physical_return_confirmed !== "boolean") invalid();
    const view = getEmissionView(ctx, String(value.emission_id));
    requireCommercialEmissionVisible(ctx, view);
    if (view.status !== "cancelada") raise("55000", "com1_effect_requires_cancellation");
    const sale = one(ctx.db, 'SELECT id,version,state FROM "erp_pos__sale" WHERE document_id=?', view.document_id);
    if (!sale) raise("P0002", "erp_pos_not_found");
    if (sale!.state === "finished") {
      const stock = one(ctx.db, `SELECT 1 FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, view.document_id);
      if (stock && value.physical_return_confirmed !== true) raise("55000", "com1_physical_return_required");
      withCom1Compensation(ctx, view.document_id, () => invokeRpc(ctx, "erp_pos_sale_execute", { p_user_id: actor.user_id,
        p_command_id: nfceStep(String(value.command_id), "sale_cancel"), p_action: "sale_cancel",
        p_data: { sale_id: String(sale!.id), expected_version: Number(sale!.version), reason: String(value.reason).trim() } }));
    }
    return one(ctx.db, 'SELECT id,state,version FROM "erp_pos__sale" WHERE id=?', sale!.id);
  });
}

registerRpc("erp_com1_nfce_config_get", (ctx, a) => withCom1Model("nfce", () => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  return readNfceConfig(ctx);
}));
registerRpc("erp_com1_nfce_config_save", (ctx, a) => withCom1Model("nfce", () => {
  requireCom1Access(ctx, "configure", expectedPerson(a));
  return saveNfceConfig(ctx, input(a, ["command_id", "expected_version", "nature_id"], ["command_id", "expected_version", "nature_id"]));
}));
registerRpc("erp_com1_nfce_prepare", (ctx, a) => withCom1Model("nfce", () => {
  requireCom1Access(ctx, "prepare", expectedPerson(a));
  return prepareNfce(ctx, input(a, ["sale_id", "command_id", "consumer_document", "series", "series_count", "expected_emission_version"], ["sale_id", "command_id"]));
}));
registerRpc("erp_com1_nfce_sales", (ctx, a) => withCom1Model("nfce", () => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  return listNfceSales(ctx, input(a, ["environment", "sale_id", "cash_session_id", "from", "to", "pending_only", "page", "per_page"], ["environment"]));
}));
registerRpc("erp_com1_nfce_sale_cancel", (ctx, a) => withCom1Model("nfce", () => {
  requireCom1Access(ctx, "cancel", expectedPerson(a));
  return cancelNfceSale(ctx, input(a, ["emission_id", "command_id", "reason", "physical_return_confirmed"], ["emission_id", "command_id", "reason"]));
}));

