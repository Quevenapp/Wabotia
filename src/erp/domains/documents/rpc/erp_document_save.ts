// public.erp_document_save: criar e editar documento (proposta, pedido de venda e de compra, OS),
// passo a passo como o original. As escritas passam pela camada de linha (documents/rows.ts),
// com os gatilhos e os adiados (commission_operation_capture e cost_apply_capture).
// erp_document_mirror.require_visible: documents/mirror.ts (o documento espelhado do Origin).
// O auto_finance (lançamento automático das contas pelas Preferências) usa a ponte do B5.
import { createHash } from "node:crypto";
import { originScope, targetOrigin } from "../../../engine/module-origin.ts";
import { linkedDocumentGuard } from "../module-policy.ts";
import { decText, toScaled } from "../../../engine/dec.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { one } from "../../../engine/driver.ts";
import { fromSqlite, raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, requireRpcParts, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { erpEntityRequirement, erpRequirementMet } from "../../../parts-requirements.ts";
import { dto as catalogDto } from "../../catalog/public.ts";
import * as finance from "../../finance/public.ts";
import { approvalSituations, autoProducts, documentDto, documentSituationJson, documentView, preference, uuidValue } from "../internal.ts";
import { checkCustomFields, extensionKeys, hasCommercialData, normalize } from "../normalize.ts";
import { guardEffect, requireVisible } from "../mirror.ts";
import { contactUsable, requireAccess } from "../reads-g.ts";
import { insertDocument, updateDocument, upsertItem, deleteItem } from "../rows.ts";
import {
  checkCreditLimit,
  checkLinks,
  checkPaymentLinks,
  checkPreferenceRules,
  commandReplay,
  currentVersion,
  documentFinanceCategory,
  editable,
  elements,
  fieldText,
  initialStatus,
  nextNumber,
  numberEditable,
  pathText,
  preserveUnavailableFields,
  restoreUnavailableFields,
  withoutUnavailableLinks,
  proposalSuperseded,
  recordOccurrence,
  requireOsPermission,
  requireSeller,
  sellerRules,
} from "../save-checks.ts";

type Data = Record<string, unknown>;
const has = (o: unknown, k: string) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k);
const isObject = (o: unknown): o is Data => o !== null && typeof o === "object" && !Array.isArray(o);
const without = (o: Data, ...keys: string[]) => {
  const r = { ...o };
  for (const k of keys) delete r[k];
  return r;
};
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** (texto)::numeric numa coluna com escala: inteiro escalado, ou null */
const scaled = (t: string | null, scale: number) => (t === null ? null : toScaled(decText(t, 30, false), scale).toString());

/** erp_documents.require_commercial_input(atual, entrada) */
export function requireCommercialInput(current: Data, input: Data) {
  const inputItems = elements(input.items ?? null);
  const inputParts = elements(input.installments ?? null);
  if (
    hasCommercialData(current) &&
    (!has(input, "commercial") || inputItems.some((i) => !has(i, "detailed_description")) || inputParts.some((p) => !(has(p, "note") && has(p, "payment_reference"))))
  )
    raise("40001", "erp_document_commercial_fields_required");
  const present = (o: unknown, k: string) => has(o, k) && (o as Data)[k] !== null;
  if (extensionKeys().some((k) => present(current, k) && !has(input, k))) raise("40001", "erp_document_fields_required");
  const curItems = elements(current.items ?? null),
    curParts = elements(current.installments ?? null);
  const taxNonZero = (k: string) => {
    const t = fieldText(current, k) ?? "0";
    return toScaled(decText(t, 30, false), 30) !== 0n;
  };
  if (
    (curItems.some((i) => present(i, "list_price") || present(i, "supplier_code")) && inputItems.some((i) => !(has(i, "list_price") && has(i, "supplier_code")))) ||
    (curParts.some((p) => present(p, "payment_method_id") || present(p, "details")) && inputParts.some((p) => !(has(p, "payment_method_id") && has(p, "details")))) ||
    ((taxNonZero("tax_ipi") || taxNonZero("tax_icms_st")) && !(has(input, "tax_ipi") && has(input, "tax_icms_st")))
  )
    raise("40001", "erp_document_fields_required");
  // 268: OS com grupo nos itens só é gravada por quem manda grupo, Orçar e OK de cada item.
  if (curItems.some((i) => has(i, "group")) && inputItems.some((i) => !(has(i, "group") && has(i, "quote") && has(i, "done")))) raise("40001", "erp_document_fields_required");
}

/** erp_documents.replace_items(documento, itens) */
export function replaceItems(ctx: RpcContext, document: string, items: unknown) {
  const db = ctx.db;
  const next: Data[] = [];
  for (const v of elements(items)) {
    const idText = fieldText(v, "id");
    const id = idText === null ? crypto.randomUUID() : (uuidValue(idText) as string);
    const productText = fieldText(v, "product_id");
    const product = productText === null ? null : (uuidValue(productText) as string);
    let snapshot: unknown = null;
    const old = one(db, 'SELECT document_id, product_id, product_snapshot FROM "erp_documents__item" WHERE id=?', id);
    if (old && old.document_id !== document) raise("22023", "erp_document_foreign_item");
    if (product !== null) {
      if (old && old.product_id === product) snapshot = old.product_snapshot === null ? null : JSON.parse(String(old.product_snapshot));
      else {
        if (!one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=? AND r.active=1', product))
          raise("22023", "erp_document_product_unavailable");
        snapshot = catalogDto(db, product);
      }
    }
    next.push({ ...(v as Data), id, product_snapshot: snapshot });
  }
  const keep = new Set(next.map((v) => String(v.id)));
  for (const r of db.exec('SELECT id FROM "erp_documents__item" WHERE document_id=?', document).rows) if (!keep.has(String(r.id))) deleteItem(ctx, String(r.id));
  for (const v of next) {
    const text = (k: string) => fieldText(v, k);
    const position = text("position");
    const row = {
      id: v.id, document_id: document, position: position === null ? null : Number(position), product_id: text("product_id") === null ? null : uuidValue(text("product_id")),
      product_snapshot: v.product_snapshot === null ? null : JSON.stringify(v.product_snapshot), quantity: scaled(text("quantity"), 6),
      unit_price: text("unit_price") === null ? null : decText(text("unit_price")!, 10, false), discount_percent: scaled(text("discount_percent"), 4), total: scaled(text("total"), 2),
      data: JSON.stringify(without(v, "product_snapshot")),
    };
    if (!upsertItem(ctx, row)) raise("22023", "erp_document_foreign_item");
  }
}

/** INSERT em erp_documents.audit (id identity, na posição da coluna) */
function audit(ctx: RpcContext, a: { actor: string; command: string; document: string; action: string; reason?: string | null; before: unknown; after: unknown }) {
  guardEffect(ctx.db, a.document); // aa_mirror_authority
  ctx.db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), a.actor, a.command, a.document, a.action, a.reason ?? null,
    a.before === null || a.before === undefined ? null : JSON.stringify(a.before), a.after === null || a.after === undefined ? null : JSON.stringify(a.after),
    ctx.clock.next().toString(),
  );
}

/** erp_documents.auto_finance(usuário, documento, comando): o lançamento automático das contas. */
export function autoFinance(ctx: RpcContext, user: string, id: string, command: string): Data | null {
  if (originScope(ctx) || targetOrigin(ctx.db, "document", id)) return null;
  const db = ctx.db;
  const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', id);
  if (!d) return null;
  // Decidir antes de ler contas, categorias ou montar a prévia. Religamento não retoma comandos antigos.
  const owner = erpEntityRequirement(d.kind);
  if (!ctx.parts.finance || owner !== null && !erpRequirementMet(ctx.parts, owner)) {
    const eligible = d.kind === "purchase_orders"
      ? preference(db, "compras.automacao_contas_pagar") === true &&
        !!one(db, `SELECT 1 x FROM "erp_documents__audit" WHERE document_id=? AND command_id=? AND action='create' LIMIT 1`, id, command) &&
        ["open", "in_progress", "partially_fulfilled", "fulfilled"].includes(String(d.status))
      : d.kind === "sales_orders" && preference(db, "vendas.contas_automaticas_pedido") === true &&
        ["verified", "in_progress", "partially_fulfilled", "fulfilled"].includes(String(d.status));
    return eligible ? { outcome: "skipped", reason: "part_disabled" } : null;
  }
  const posted = () => !!one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id);
  if (d.kind === "purchase_orders") {
    if (
      preference(db, "compras.automacao_contas_pagar") !== true ||
      !one(db, `SELECT 1 x FROM "erp_documents__audit" WHERE document_id=? AND command_id=? AND action='create' LIMIT 1`, id, command) ||
      !["open", "in_progress", "partially_fulfilled", "fulfilled"].includes(String(d.status)) ||
      posted()
    )
      return null;
  } else if (
    d.kind !== "sales_orders" ||
    preference(db, "vendas.contas_automaticas_pedido") !== true ||
    !["verified", "in_progress", "partially_fulfilled", "fulfilled"].includes(String(d.status)) ||
    posted() ||
    !!one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', id)
  )
    return null;
  if (!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role IN ('admin','financeiro')`, user)) return { outcome: "skipped", reason: "erp_finance_access_denied" };
  if (d.total !== null && BigInt(String(d.total)) <= 0n) return { outcome: "skipped", reason: "erp_document_finance_zero_total" };
  const body = JSON.parse(String(d.body));
  const parts = body?.installments ?? [];
  if (jsonType(parts) !== "array") raise("22023", `cannot get array length of ${jsonType(parts) === "object" ? "a non-array" : "a scalar"}`);
  let plan: unknown = null;
  if ((parts as unknown[]).length === 0) {
    // O pedido de compra lança as parcelas dele (Origin); o de venda sem parcelas lança uma à vista na data.
    if (d.kind === "purchase_orders") return { outcome: "skipped", reason: "erp_document_finance_no_installments" };
    plan = [{ amount_cents: d.total === null ? null : String(d.total), due_on: fieldText(body, "date"), method: null }];
  }
  const category = documentFinanceCategory(db, d, null);
  // begin ... exception when 22023, 40001, 42501, P0002: a subtransação desfaz a tentativa.
  try {
    return db.transaction(() => {
      const preview = (finance.erpDocumentFinancePreview(ctx, {
        p_user_id: user, p_kind: d.kind, p_document_id: id, p_expected_version: d.version, p_category_id: category, p_plan: plan,
      }) as Data).preview as Data;
      const post = finance.erpDocumentFinancePost(ctx, {
        p_user_id: user, p_kind: d.kind, p_document_id: id, p_expected_version: d.version, p_command_id: transitionCommand(command, "auto_finance"),
        p_preview_hash: preview.preview_hash, p_category_id: category, p_plan: plan,
      }) as Data;
      return { outcome: "done", posting_id: pathText(post, ["posting", "id"]) };
    });
  } catch (e) {
    const err = fromSqlite(e);
    if (!["22023", "40001", "42501", "P0002"].includes(err.code)) throw err;
    return { outcome: "skipped", reason: /^erp_[a-z0-9_]{1,80}$/.test(err.message) ? err.message : "erp_document_finance_refused" };
  }
}

/** erp_documents.transition_command(comando, ação): md5(...)::uuid */
export function transitionCommand(command: string, action: string) {
  const h = createHash("md5").update(`situation-transition:${action}:${command}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function erpDocumentSave(ctx: RpcContext, a: RpcArgs) {
  if (originScope(ctx)) requireRpcParts(ctx, "erp_document_save", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const id = (a.p_id as string | null) ?? null;
  if (ctx.workEnabled && kind === "service_orders" && id === null && !originScope(ctx)) raise("work_required", "Crie o trabalho para gerar sua parte comercial.");
  linkedDocumentGuard(db, id, ctx);
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const body0 = a.p_body === undefined ? null : jsonbArg(a.p_body);
  requireVisible(db, user, id, true);
  requireAccess(db, user, kind, true);
  if (expected === null || (id === null && expected !== 0) || (id !== null && expected < 1)) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "save", actor: user, kind, id, version: expected, body: body0 }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  if (!isObject(body0)) raise("22023", "erp_document_body_invalid");
  let body: Data = body0;
  let number: number | null = null;
  if (has(body0, "number")) {
    const n = body0.number;
    if (typeof n !== "string" || !/^[1-9][0-9]{0,9}$/.test(n)) raise("22023", "erp_document_number_invalid");
    number = Number(n);
    body = without(body0, "number");
  }
  let refresh = false;
  if (has(body, "refresh_contact")) {
    if (body.refresh_contact !== true) raise("22023", "erp_document_body_invalid");
    refresh = true;
    body = without(body, "refresh_contact");
  }
  let sourceId: string | null = null,
    sourceVersion = 0;
  if (has(body, "source_proposal")) {
    const sp = body.source_proposal;
    const ev = isObject(sp) ? sp.expected_version : undefined;
    const evText = ev === undefined || ev === null ? null : jsonbText(ev);
    if (
      id !== null || !["sales_orders", "service_orders"].includes(String(kind)) || !isObject(sp) || Object.keys(sp).some((k) => k !== "id" && k !== "expected_version") ||
      jsonType(ev) !== "number" || evText === null || !/^[1-9][0-9]{0,9}$/.test(evText) || Number(evText) > 2147483647
    )
      raise("22023", "erp_document_body_invalid");
    sourceId = uuidValue((sp as Data).id ?? null, true) as string;
    sourceVersion = Number(evText);
    body = without(body, "source_proposal");
  }
  let savedFields: Data | null = null;
  if (id !== null && (!ctx.parts.stock || !ctx.parts.finance)) {
    const current = one(db, 'SELECT body, warehouse_id FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
    if (current) savedFields = {
      ...JSON.parse(String(current.body)), warehouse_id: current.warehouse_id,
      items: db.exec('SELECT data FROM "erp_documents__item" WHERE document_id=? ORDER BY position', id).rows.map(i => JSON.parse(String(i.data))),
    };
  }
  body = preserveUnavailableFields(ctx, body, savedFields);
  const suspended = !ctx.parts.stock || !ctx.parts.finance;
  let data = normalize(kind, suspended ? withoutUnavailableLinks(ctx, body) : body) as Data;
  if (suspended) data = restoreUnavailableFields(ctx, data, body);
  const contact = fieldText(data, "contact_id"),
    warehouse = fieldText(data, "warehouse_id"),
    seller = fieldText(data, "seller_id");
  data = { ...data, items: originScope(ctx) ? data.items : autoProducts(ctx, user, kind, command, data.items) };
  checkPreferenceRules(db, kind!, data, ctx.parts);
  // 239: as regras do vendedor com a aprovação do desconto.
  const approval = sellerRules(db, user, kind!, data);
  let row: Data | null = null,
    before: Data | null = null;
  if (id !== null) {
    row = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind) ?? null;
    if (!row) raise("P0002", "erp_document_not_found");
    // 238: documento de contato que o usuário não vê não existe para ele.
    if (!contactUsable(db, user, row.contact_id as string | null)) raise("P0002", "erp_document_not_found");
    if (row.version !== expected || row.version === 2147483647) raise("40001", "erp_document_version_conflict");
    if (!editable(row.status) && !originScope(ctx)) raise("40001", "erp_document_state_locked");
    // 269: proposta com versão mais nova fica só leitura.
    if (kind === "sales_proposals" && proposalSuperseded(db, id)) raise("40001", "erp_document_version_locked");
    before = documentDto(ctx, id);
    requireCommercialInput(before!, body);
    if (number !== null && number === Number(row.number)) number = null;
  }
  const rowBody = row === null ? null : { ...JSON.parse(String(row.body)), ...(savedFields ? { items: savedFields.items } : {}) } as Data;
  if (seller !== null && (id === null || fieldText(rowBody, "seller_id") !== seller)) requireSeller(db, seller);
  checkLinks(db, kind!, data, rowBody, ctx.parts);
  // p_data->'custom_fields': chave ausente é NULL do SQL (undefined, na convenção do normalize.ts).
  if (kind === "service_orders") checkCustomFields(db, kind, data.custom_fields, id !== null ? rowBody : undefined);
  checkPaymentLinks(db, kind!, data, rowBody, ctx.parts);
  // 239: a Forma que a OS ainda não tem pede "Alterar forma de pagamento".
  if (kind === "service_orders" && !originScope(ctx)) {
    const old = new Set(elements(rowBody?.installments ?? null).map((o) => fieldText(o, "payment_method_id")));
    if (elements(data.installments ?? null).some((p) => fieldText(p, "payment_method_id") !== null && !old.has(fieldText(p, "payment_method_id"))))
      requireOsPermission(db, user, kind, "forma_pagamento");
  }
  checkCreditLimit(db, user, kind!, data, rowBody === null ? null : { ...rowBody, contact_id: row!.contact_id }, ctx.parts);
  let source: Data | null = null,
    sourceBefore: Data | null = null;
  if (sourceId !== null) {
    // As regras do erp_proposal_convert (164): um documento por proposta, nunca um modelo.
    requireAccess(db, user, "sales_proposals", true);
    source = one(db, `SELECT * FROM "erp_documents__document" WHERE id=? AND kind='sales_proposals'`, sourceId) ?? null;
    if (!source) raise("P0002", "erp_document_not_found");
    if (source.version !== sourceVersion || source.version === 2147483647) raise("40001", "erp_document_version_conflict");
    if (one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE source_proposal_id=? LIMIT 1', sourceId)) raise("40001", "erp_proposal_already_converted");
    const template = fieldText(JSON.parse(String(source.body)), "template");
    if (["cancelled", "completed"].includes(String(source.status)) || template === "true") raise("22023", "erp_proposal_not_approved");
    sourceBefore = documentDto(ctx, sourceId);
  }
  // check_tax_preference: sem regra.
  if (number !== null) {
    if (!numberEditable(db, kind!)) raise("22023", "erp_document_number_locked");
    // Origin: número já usado vira o próximo livre (novo) ou fica o atual (edição).
    if (one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE kind=? AND number=? LIMIT 1', kind, number)) number = null;
    else db.exec('UPDATE "erp_documents__numbering" SET last_number=max(last_number, ?) WHERE kind=?', number, kind);
  }
  // 238: contato novo ou trocado precisa ser visível ao usuário.
  if ((id === null || row!.contact_id !== contact) && !contactUsable(db, user, contact)) raise("22023", "erp_document_contact_unavailable");
  let snapshot: unknown;
  if (id !== null && row!.contact_id === contact && !refresh) snapshot = row!.contact_snapshot === null ? null : JSON.parse(String(row!.contact_snapshot));
  else {
    if (!one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.active=1', contact)) raise("22023", "erp_document_contact_unavailable");
    snapshot = catalogDto(db, contact!);
  }
  if (warehouse !== null && (id === null || row!.warehouse_id !== warehouse) && !one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.id=? AND r.active=1', warehouse))
    raise("22023", "erp_document_warehouse_unavailable");
  const total = scaled(pathText(data, ["totals", "total"]), 2);
  const stored = JSON.stringify(without(data, "items"));
  let docId: string;
  if (id === null) {
    docId = crypto.randomUUID();
    const now = ctx.clock.next().toString();
    insertDocument(ctx, {
      id: docId, kind, number: number ?? nextNumber(db, kind!), version: 1, status: initialStatus(kind!), contact_id: contact, warehouse_id: warehouse,
      contact_snapshot: snapshot === null ? null : JSON.stringify(snapshot), body: stored, total, source_proposal_id: sourceId, created_by: user, updated_by: user,
      created_at: now, updated_at: now, deleted_at: null, deleted_by: null, delete_reason: null, origin: "brufap", authority: "brufap",
    });
  } else {
    docId = id;
    updateDocument(ctx, docId, {
      version: Number(row!.version) + 1, contact_id: contact, warehouse_id: warehouse, contact_snapshot: snapshot === null ? null : JSON.stringify(snapshot),
      number: number ?? row!.number, body: stored, total, updated_by: user, updated_at: ctx.clock.next().toString(),
    });
  }
  replaceItems(ctx, docId, data.items);
  if (sourceId !== null) {
    updateDocument(ctx, sourceId, { status: "completed", version: Number(currentVersion(db, sourceId)) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
    recordOccurrence(ctx, { document: sourceId, actor: user, command: command!, version: Number(source!.version) + 1, before: source!.status, after: "completed", text: null });
    audit(ctx, { actor: user, command: command!, document: sourceId, action: kind === "sales_orders" ? "convert_to_sale" : "convert_to_service", before: sourceBefore, after: documentDto(ctx, sourceId) });
  }
  audit(ctx, { actor: user, command: command!, document: docId, action: sourceId !== null ? "create_from_proposal" : id === null ? "create" : "edit", before, after: documentDto(ctx, docId) });
  // 239: pedido acima do limite de desconto do vendedor vai a Em digitação na situação de aprovação.
  if (approval !== null) {
    const situations = approvalSituations(db) as string[];
    const current = one(db, 'SELECT situation_id FROM "erp_documents__document_situation" WHERE document_id=?', docId);
    if (!(current && situations.includes(String(current.situation_id)))) {
      const saved = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', docId)!;
      if (
        saved.status !== "draft" &&
        (!!one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, docId) ||
          !!one(db, `SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, docId) ||
          !!one(db, `SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active' LIMIT 1`, docId))
      )
        raise("22023", "erp_document_seller_discount_limit");
      const situationBefore = documentSituationJson(db, docId);
      updateDocument(ctx, docId, { status: "draft", version: Number(saved.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
      db.exec('DELETE FROM "erp_documents__document_situation" WHERE document_id=?', docId);
      db.exec(
        `INSERT INTO "erp_documents__document_situation"(document_id, kind, situation_id, base_status, actor, command_id, set_at) VALUES(?,?,?,'draft',?,?,?)`,
        docId, kind, approval, user, command, ctx.clock.next().toString(),
      );
      recordOccurrence(ctx, {
        document: docId, actor: user, command: command!, version: currentVersion(db, docId), before: saved.status, after: saved.status !== "draft" ? "draft" : null,
        text: "Venda enviada para aprovação do desconto", situationBefore, situationAfter: documentSituationJson(db, docId),
      });
      audit(ctx, { actor: user, command: command!, document: docId, action: "discount_approval", reason: "Venda enviada para aprovação do desconto", before: null, after: documentView(ctx, docId) });
    }
  }
  const auto = autoFinance(ctx, user, docId, command!);
  let result: Data = { kind, document: documentDto(ctx, docId), replayed: false, data_mode: "erp_native", operational_effects: false };
  if (approval !== null) result = { ...result, discount_approval: { situation: documentSituationJson(db, docId) } };
  if (auto !== null) result = { ...result, auto_finance: auto };
  if (sourceId !== null) {
    const s = one(db, 'SELECT id, number, version, status FROM "erp_documents__document" WHERE id=?', sourceId)!;
    result = { ...result, source_proposal: { id: s.id, number: s.number === null ? null : String(s.number), version: s.version, status: s.status } };
  }
  db.exec('INSERT INTO "erp_documents__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, user, hash, JSON.stringify(result), ctx.clock.next().toString());
  return result;
}

registerRpc("erp_document_save", erpDocumentSave);
