/** Efeitos locais por eixo. Instalar estes slots somente na integração final.
 * Cada chamada termina sua própria transação: a ponte chama stock e finance
 * separadamente, depois do commit fiscal. Nunca chamar ambos dentro de um RPC.
 * O helper effect-policy não depende deste módulo nem dos domínios executores.
 */
import { randomUUID } from "node:crypto";
import { one, type Row } from "../../../engine/driver.ts";
import { toScaled } from "../../../engine/dec.ts";
import { ErpError, fromSqlite, raise } from "../../../engine/errors.ts";
import { invokeRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { withErpMaintenance, type ErpMaintenanceAction } from "../../../engine/parts-gate.ts";
import type { EffectAxis, EffectInput, EffectView, ImmutableRevision, JsonObject, StoredEmission } from "../../../commercial-nfe/contracts.ts";
import { com1Authority, requireCom1Access, requireCom1SensitivePolicy } from "./access.ts";
import {
  COM1_TABLES, com1Hash, com1Uuid, finishCommand, getEffects,
  getStoredEmission, getStoredRevision, replayCommand, saveEffect, startCommand, transferEffect,
} from "./store.ts";
import { withCom1Compensation } from "./effect-policy.ts";
import { BANK_WRITEOFF_ACTION, liveBankCollection } from "../../finance/internal.ts";

export interface Com1EffectPorts {
  /** Porta síncrona: usa as mesmas RPCs, permissões, previews e comandos locais. */
  invoke(ctx: RpcContext, name: string, args: RpcArgs): unknown;
}
const object = (value: unknown): Row => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
};
const array = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v)) as JsonObject;
const codeOf = (error: unknown): string => {
  const converted = fromSqlite(error);
  return converted.code === "XX000" ? "com1_effect_local_failure" : converted.message;
};
const bodyOf = (revision: ImmutableRevision): Row => {
  const document = revision.snapshot.document;
  return document.body != null ? object(document.body) : document;
};
const currentDocument = (ctx: RpcContext, id: string): Row => {
  const d = one(ctx.db, 'SELECT *,CAST(total AS TEXT) AS total FROM erp_documents__document WHERE id=?', id);
  if (!d || d.kind !== "sales_orders" || d.deleted_at != null) raise("55000", "com1_effect_document_unavailable");
  return d;
};
const dayOf = (ctx: RpcContext): string => new Date(Number(ctx.clock.next() / 1000n)).toISOString().slice(0, 10);
const pending = (reason: string): never => raise("55000", reason);
const decimal = (value: unknown, scale: number): string => {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(String(value))) return pending("com1_effect_snapshot_incomplete");
  return String(toScaled(String(value), scale));
};
const bodyItems = (revision: ImmutableRevision): Row[] => {
  const body = bodyOf(revision);
  return array(Array.isArray(body.items) ? body.items : revision.snapshot.items).map(item => item.data != null
    ? { ...object(item.data),product_id:item.product_id ?? object(item.data).product_id } : item);
};
/** Commercial comparison deliberately ignores only technical document metadata.
 * Normalized body and source items remain immutable after sending; posting bumps
 * and the choice of an operational warehouse do not create a fiscal revision.
 */
function assertSource(ctx: RpcContext, emission: StoredEmission, revision: ImmutableRevision): Row {
  const d = currentDocument(ctx, emission.document_id), body = object(d.body), frozen = bodyOf(revision);
  const contact = frozen.contact_id ?? revision.snapshot.document.contact_id;
  if (!contact || contact !== d.contact_id || String(d.total) !== emission.total) pending("com1_effect_source_changed");
  const technical = new Set(["id", "version", "status", "updated_at", "updated_by", "created_at", "created_by", "warehouse_id", "category_id", "payment_account_id", "internal_notes", "items"]);
  const commercialBody = (value:Row) => Object.fromEntries(Object.entries(value).filter(([key]) =>
    !technical.has(key) && !["kind", "authority", "number", "body", "total", "stored_total", "origin", "contact_snapshot", "deleted_at"].includes(key)));
  if (com1Hash(commercialBody(frozen)) !== com1Hash(commercialBody(body))) pending("com1_effect_source_changed");
  const items = bodyItems(revision), actual = ctx.db.exec('SELECT data,product_snapshot,product_id,position FROM erp_documents__item WHERE document_id=? ORDER BY position', d.id).rows.map(row => {
    const data = object(row.data), product = object(row.product_snapshot);
    return { ...data, product_id: row.product_id, position: row.position,
      code: Object.hasOwn(data, "code") ? data.code : product.code ?? null };
  });
  if (!items.length || items.length !== actual.length) pending("com1_effect_source_changed");
  for (let n = 0; n < items.length; n++) {
    const commercialItem = (value:Row) => Object.fromEntries(Object.entries({ ...value, code: value.code ?? null }).filter(([key]) =>
      !["id","document_id","data","product_snapshot","lots","created_at","updated_at","version"].includes(key)));
    // Compare the entire normalized commercial item, including the ten-digit
    // unit price and conditional fields; never round a mismatch into equality.
    if (com1Hash(commercialItem(items[n])) !== com1Hash(commercialItem(actual[n]))) pending("com1_effect_source_changed");
  }
  return d;
}
interface StockLine { product_id: string; unit: string; quantity: string; lots: { lot_id: string; quantity: string }[] }
function expectedStock(ctx: RpcContext, emission: StoredEmission, revision: ImmutableRevision): StockLine[] {
  const map = new Map<string, { product_id: string; unit: string; quantity: bigint; lots: Map<string, bigint> }>();
  const operational = ctx.db.exec('SELECT data FROM erp_documents__item WHERE document_id=? ORDER BY position',emission.document_id).rows.map(row => object(row.data));
  for (const [index,item] of bodyItems(revision).entries()) {
    if (!item.product_id || !item.unit) pending("com1_effect_snapshot_incomplete");
    const key = `${item.product_id}|${item.unit}`;
    const row = map.get(key) ?? { product_id: String(item.product_id), unit: String(item.unit), quantity: 0n, lots: new Map<string, bigint>() };
    const quantity = BigInt(decimal(item.quantity, 6));
    if (quantity <= 0n) pending("com1_effect_snapshot_incomplete");
    row.quantity += quantity;
    // Lote é escolha física corrigível depois do preparo; produto/unidade e
    // quantidade continuam vindo exclusivamente do snapshot fiscal.
    for (const lot of array(operational[index] ? operational[index].lots : item.lots)) {
      if (!lot.lot_id) pending("com1_effect_snapshot_incomplete");
      row.lots.set(String(lot.lot_id), (row.lots.get(String(lot.lot_id)) ?? 0n) + BigInt(decimal(lot.quantity, 6)));
    }
    map.set(key, row);
  }
  return [...map.values()].map(row => ({ ...row, quantity: String(row.quantity), lots: [...row.lots].map(([lot_id, quantity]) => ({ lot_id, quantity: String(quantity) })).sort((a,b) => a.lot_id.localeCompare(b.lot_id)) })).sort((a,b) => a.product_id.localeCompare(b.product_id));
}
function stockContent(positions: Row[], reservation = false): StockLine[] {
  return positions.map(p => ({ product_id: String(p.product_id), unit: String(p.unit),
    quantity: String((reservation ? 1n : -1n) * BigInt(decimal(p.quantity, 6))),
    lots: array(p.lots).map(lot => ({ lot_id: String(lot.lot_id), quantity: String((reservation ? 1n : -1n) * BigInt(decimal(lot.quantity, 6))) })).sort((a,b) => a.lot_id.localeCompare(b.lot_id)),
  })).sort((a,b) => a.product_id.localeCompare(b.product_id));
}
interface Found { origin: "document" | "legacy_invoice" | "grouped_billing"; ids: JsonObject; fingerprint: string; posting?: Row; result: JsonObject }
function stockFound(ctx: RpcContext, emission: StoredEmission, revision: ImmutableRevision): Found | null {
  const rows = ctx.db.exec(`SELECT p.*,NULL AS invoice_id,'document' AS origin FROM erp_stock__document_posting p WHERE document_id=? AND state='active'`, emission.document_id).rows;
  const legacy = ctx.db.exec(`SELECT p.*,'legacy_invoice' AS origin FROM erp_stock__invoice_posting p JOIN erp_fiscal_invoices__invoice_order o ON o.invoice_id=p.invoice_id WHERE o.document_id=? AND p.state='active'`, emission.document_id).rows;
  const all = [...rows, ...legacy];
  if (all.length > 1) pending("com1_effect_multiple_origins");
  if (!all.length) return null;
  const p = all[0], snap = object(p.snapshot), positions = array(snap.positions);
  if (com1Hash(stockContent(positions)) !== com1Hash(expectedStock(ctx,emission,revision))) pending("com1_effect_stock_content_mismatch");
  if (p.invoice_id && Number(one(ctx.db, 'SELECT COUNT(*) n FROM erp_fiscal_invoices__invoice_order WHERE invoice_id=?', p.invoice_id)!.n) !== 1) pending("com1_effect_legacy_grouped");
  const movement = one(ctx.db, 'SELECT * FROM erp_stock__movement WHERE id=?', p.movement_id);
  const entries = ctx.db.exec('SELECT *,CAST(quantity AS TEXT) q FROM erp_stock__entry WHERE movement_id=? ORDER BY product_id,warehouse_id', p.movement_id).rows;
  if (!movement || movement.kind !== "issue" || entries.length !== positions.length || entries.some(e => !positions.some(v => v.product_id === e.product_id && v.warehouse_id === e.warehouse_id && v.unit === e.unit && decimal(v.quantity, 6) === String(e.q)))) pending("com1_effect_stock_content_mismatch");
  for (const position of positions) {
    const lots=ctx.db.exec('SELECT lot_id,CAST(quantity AS TEXT) quantity FROM erp_stock__lot_entry WHERE movement_id=? AND product_id=? AND warehouse_id=? ORDER BY lot_id',p.movement_id,position.product_id,position.warehouse_id).rows.map(lot => ({lot_id:String(lot.lot_id),quantity:String(lot.quantity)}));
    const snapshotLots=array(position.lots).map(lot => ({lot_id:lot.lot_id,quantity:decimal(lot.quantity,6)})).sort((a,b) => String(a.lot_id).localeCompare(String(b.lot_id)));
    if (com1Hash(lots) !== com1Hash(snapshotLots)) pending("com1_effect_stock_lot_mismatch");
  }
  const ids: JsonObject = { posting_id: String(p.id), movement_id: String(p.movement_id), ...(p.invoice_id ? { invoice_id: String(p.invoice_id) } : {}) };
  const consumed = one(ctx.db, `SELECT id FROM erp_stock__reservation WHERE document_id=? AND state='consumed' AND consumed_command_id=?`, emission.document_id, p.command_id);
  if (consumed) ids.reservation_id = String(consumed.id);
  return { origin: p.origin as Found["origin"], ids, posting: p, fingerprint: com1Hash({ ids, positions: positions.map(v => ({ product_id: v.product_id, warehouse_id: v.warehouse_id, unit: v.unit, quantity: decimal(v.quantity,6), lots: v.lots ?? [] })) }), result: { proof: "movement_and_snapshot", document_version: Number(currentDocument(ctx, emission.document_id).version) } };
}
function expectedInstallments(ctx: RpcContext, emission: StoredEmission, revision: ImmutableRevision): Row[] {
  const body = bodyOf(revision), parts = array(body.installments);
  const localBody=object(currentDocument(ctx,emission.document_id).body);
  if (!parts.length) pending("com1_effect_snapshot_incomplete");
  return parts.map((part, index) => ({ position: index + 1, amount_cents: decimal(part.amount, 2), due_on: part.due_date,
    payment_method_id: part.payment_method_id ?? null, account_id: object(part.details).account_id ?? localBody.payment_account_id ?? null }));
}
function titles(ctx: RpcContext, origin: Found["origin"], id: unknown): Row[] {
  const table = origin === "document" ? "erp_finance__document_title" : origin === "legacy_invoice" ? "erp_finance__invoice_title" : "erp_finance__grouped_billing_title";
  const key = origin === "grouped_billing" ? "billing_id" : "posting_id";
  return ctx.db.exec(`SELECT t.*,l.position,CAST(t.amount_cents AS TEXT) amount_cents,CAST(t.settled_cents AS TEXT) settled_cents FROM ${table} l JOIN erp_finance__title t ON t.id=l.title_id WHERE l.${key}=? ORDER BY l.position`, id).rows;
}
/** Título cancelado pela declaração de boleto baixado no banco: na
 * compensação ele já está encerrado e não desfaz a prova do lançamento. */
const writtenOff = (ctx: RpcContext, title: Row): boolean => !!Number(title.cancelled) && Number(title.settled_cents) === 0 &&
  !!one(ctx.db,`SELECT 1 FROM erp_cnab__billing_title b JOIN erp_cnab__audit a ON a.record_id=b.id AND a.action=? WHERE b.title_id=? LIMIT 1`,BANK_WRITEOFF_ACTION,title.id);
function financeFound(ctx: RpcContext, emission: StoredEmission, revision: ImmutableRevision, reverse = false): Found | null {
  const own = ctx.db.exec(`SELECT p.*,NULL AS invoice_id,'document' AS origin FROM erp_finance__document_posting p WHERE document_id=? AND state='active'`, emission.document_id).rows;
  const legacy = ctx.db.exec(`SELECT p.*,'legacy_invoice' AS origin FROM erp_finance__invoice_posting p JOIN erp_fiscal_invoices__invoice_order o ON o.invoice_id=p.invoice_id WHERE o.document_id=? AND p.state='active'`, emission.document_id).rows;
  const grouped = ctx.db.exec(`SELECT b.*,'grouped_billing' AS origin,CAST(g.total_cents AS TEXT) allocated FROM erp_finance__grouped_billing b JOIN erp_finance__grouped_billing_document g ON g.billing_id=b.id WHERE g.document_id=? AND g.active=1 AND b.state='active'`, emission.document_id).rows;
  const groupedInvoices = ctx.db.exec(`SELECT b.*,'grouped_billing' AS origin,CAST(g.total_cents AS TEXT) allocated,g.invoice_id FROM erp_finance__grouped_billing b JOIN erp_finance__grouped_billing_invoice g ON g.billing_id=b.id JOIN erp_fiscal_invoices__invoice_order o ON o.invoice_id=g.invoice_id WHERE o.document_id=? AND g.active=1 AND b.state='active'`, emission.document_id).rows;
  const all = [...own, ...legacy, ...grouped, ...groupedInvoices];
  if (all.length > 1) pending("com1_effect_multiple_origins");
  if (!all.length) return null;
  const p = all[0], origin = p.origin as Found["origin"], rows = titles(ctx, origin, p.id), contact = bodyOf(revision).contact_id ?? revision.snapshot.document.contact_id;
  if (!rows.length || rows.some(t => t.kind !== "receivable" || t.contact_id !== contact || !!Number(t.cancelled) && !(reverse && writtenOff(ctx,t))))
    pending("com1_effect_finance_content_mismatch");
  if (p.invoice_id && Number(one(ctx.db, 'SELECT COUNT(*) n FROM erp_fiscal_invoices__invoice_order WHERE invoice_id=?', p.invoice_id)!.n) !== 1) pending("com1_effect_legacy_grouped");
  if (origin === "grouped_billing") {
    const allocations = ctx.db.exec(`SELECT CAST(total_cents AS TEXT) amount FROM erp_finance__grouped_billing_document WHERE billing_id=? AND active=1 UNION ALL SELECT CAST(total_cents AS TEXT) amount FROM erp_finance__grouped_billing_invoice WHERE billing_id=? AND active=1`, p.id, p.id).rows;
    const sum = (values: Row[], key: string) => values.reduce((total, item) => total + BigInt(String(item[key])), 0n);
    if (String(p.allocated) !== emission.total || p.contact_id !== contact || sum(allocations,"amount") !== BigInt(String(p.total_cents)) || sum(rows,"amount_cents") !== BigInt(String(p.total_cents))) pending("com1_effect_grouped_content_mismatch");
  } else {
    const expected = expectedInstallments(ctx,emission,revision), snap = object(p.snapshot);
    if (String(snap.total_cents) !== emission.total || rows.length !== expected.length || rows.some((row,n) =>
      String(row.amount_cents) !== expected[n].amount_cents || row.due_on !== expected[n].due_on || Number(row.position) !== expected[n].position ||
      expected[n].payment_method_id !== null && row.payment_method_id !== expected[n].payment_method_id ||
      expected[n].account_id !== null && row.account_id !== expected[n].account_id)) pending("com1_effect_finance_content_mismatch");
  }
  const ids: JsonObject = { [origin === "grouped_billing" ? "billing_id" : "posting_id"]: String(p.id), title_ids: rows.map(t => String(t.id)), ...(p.invoice_id ? { invoice_id: String(p.invoice_id) } : {}) };
  return { origin, ids, posting: p, fingerprint: com1Hash({ ids, installments: rows.map(t => ({ id:t.id, amount_cents:String(t.amount_cents), due_on:t.due_on, contact_id:t.contact_id, payment_method_id:t.payment_method_id ?? null, account_id:t.account_id ?? null })) }), result: { proof: origin === "grouped_billing" ? "group_allocation_and_titles" : "posting_and_titles", document_version: Number(currentDocument(ctx, emission.document_id).version) } };
}
const find = (ctx: RpcContext, emission: StoredEmission, revision: ImmutableRevision, axis: EffectAxis, reverse = false): Found | null =>
  axis === "stock" ? stockFound(ctx,emission,revision) : financeFound(ctx,emission,revision,reverse);
/** Outra emissão do mesmo pedido que responde pelo mesmo lançamento. */
function otherOwner(ctx: RpcContext, emission: StoredEmission, axis: EffectAxis, ids: JsonObject): EffectView | null {
  const key = com1Hash(ids);
  for (const row of ctx.db.exec(`SELECT id FROM ${COM1_TABLES.emission} WHERE document_id=? AND id<>? ORDER BY fiscal_version DESC`, emission.document_id, emission.id).rows) {
    const other = getEffects(ctx, String(row.id)).find(e => e.axis === axis);
    if (other?.fingerprint && ["aplicado","reconhecido"].includes(other.state) && !["revertido","transferido"].includes(String(other.compensation_state)) &&
        com1Hash(other.ids) === key) return other;
  }
  return null;
}
const TRANSFERRED = "com1_effect_transferred";
function localAccess(ctx: RpcContext, axis: EffectAxis): boolean {
  try { requireCom1Access(ctx, axis === "stock" ? "effect_stock" : "effect_finance"); return true; }
  catch (e) {
    if (!(e instanceof ErpError) || e.code !== "42501") throw e;
    // O responsável fiscal pode registrar a falta do papel; nunca o recebe.
    requireCom1Access(ctx, "emit"); return false;
  }
}
function freshView(ctx: RpcContext, input: EffectInput): EffectView {
  return { emission_id:input.emission_id, axis:input.axis, state:"pendente", origin:null, ids:{}, fingerprint:null, reason:null,
    responsible_role:input.axis === "stock" ? "estoque" : "financeiro", person_id:ctx.identity.actor!.user_id,
    command_id:input.command_id, result:null, compensation_state:null, compensation_command_id:null, compensation_result:null, updated_at:String(ctx.clock.next()) };
}
function validate(ctx: RpcContext, input: EffectInput, reverse: boolean) {
  com1Uuid(input.emission_id); com1Uuid(input.command_id);
  if (!["stock","finance"].includes(input.axis) || !Number.isInteger(input.expected_version) || input.expected_version < 1 ||
      !(reverse ? input.intent === "reverse" : ["apply","apply_skipped","reconcile"].includes(input.intent)) ||
      input.physical_return_confirmed !== undefined && typeof input.physical_return_confirmed !== "boolean") raise("22023","com1_effect_input_invalid");
  if (!ctx.identity.actor) raise("42501","fiscal_forbidden");
  requireCom1SensitivePolicy(ctx.identity.actor, input.axis === "stock" ? "effect_stock" : "effect_finance", com1Authority(ctx));
}
/** Drain only callbacks generated by this stage so a deferred local failure is
 * caught inside its savepoint too. The caller's earlier callbacks stay intact. */
function localTransaction<T>(ctx: RpcContext, run: () => T): T {
  const start = ctx.deferred.length;
  try { return ctx.db.transaction(() => { const result = run(); while (ctx.deferred.length > start) ctx.deferred.splice(start,1)[0](); return result; }); }
  catch (error) { ctx.deferred.splice(start); throw error; }
}

export function createCom1EffectHandlers(ports: Partial<Com1EffectPorts> = {}) {
  const invoke = ports.invoke ?? invokeRpc;
  function execute(ctx: RpcContext, input: EffectInput, reverse: boolean): EffectView {
    validate(ctx,input,reverse);
    return ctx.db.transaction(() => {
      const action = reverse ? "effect_reverse" as const : "effect_apply" as const;
      const replay = replayCommand(ctx,{ command_id:input.command_id,action,args:input });
      if (replay) {
        localAccess(ctx,input.axis);
        if (!replay.result?.effect) raise("40001","com1_effect_attempt_incomplete");
        return replay.result.effect as unknown as EffectView;
      }
      const emission = getStoredEmission(ctx,input.emission_id);
      if (emission.version !== input.expected_version) raise("40001","com1_version_conflict");
      if (reverse ? emission.status !== "cancelada" : emission.status !== "autorizada") raise("55000",reverse ? "com1_effect_requires_cancellation" : "com1_effect_requires_authorization");
      const revision = getStoredRevision(ctx,emission.id), old = getEffects(ctx,emission.id).find(e => e.axis === input.axis);
      // A nova emissão do pedido adotou o lançamento: esta não o estorna.
      if (reverse && old?.compensation_state === "transferido") raise("55000",TRANSFERRED);
      const allowed = localAccess(ctx,input.axis);
      const command = { id:input.command_id };
      let started = false;
      const ensureCommand = (request?: JsonObject) => {
        if (!started) {
          startCommand(ctx,{command_id:command.id,action,args:input,emission_id:emission.id,body_revision:emission.current_body_revision,request});
          started = true;
        }
      };
      let effect = old ? { ...old } : freshView(ctx,input);
      if (reverse && !ctx.parts[input.axis] && !old?.fingerprint) effect = { ...effect,state:"pulado",reason:"part_disabled" };
      const finish = (next: EffectView) => {
        ensureCommand();
        const applied = ["aplicado","reconhecido"].includes(next.state);
        const previouslyApplied = old && ["aplicado","reconhecido"].includes(old.state);
        const saved = saveEffect(ctx,reverse ? {...next,compensation_command_id:command.id} : {
          ...next,command_id:command.id,person_id:ctx.identity.actor!.user_id,
          result:{...next.result,...(applied ? {
            application_command_id:previouslyApplied ? old.result?.application_command_id ?? old.command_id : command.id,
            application_person_id:previouslyApplied ? old.result?.application_person_id ?? old.person_id : ctx.identity.actor!.user_id,
          } : {})},
        },{apply_skipped:input.intent === "apply_skipped"});
        finishCommand(ctx,command.id,"completed",{effect:json(saved)});
        return saved;
      };
      const fail = (reason: string): EffectView => {
        if (reverse) return finish({ ...effect, compensation_state:"compensacao_pendente", compensation_command_id:command.id,
          compensation_result:{reason, responsible_role:effect.responsible_role, corrective_action:input.axis === "stock" ? "Conferir retorno físico e reverter o lançamento de estoque." : "Conferir títulos e cobrança no Financeiro."} });
        if (old && ["aplicado","reconhecido"].includes(old.state)) return finish({ ...old, reason,
          result:{ ...old.result, reconciliation:{state:"pendente",reason} } });
        return finish({ ...effect, state:"pendente", reason, person_id:ctx.identity.actor!.user_id, command_id:command.id,
          result:{reason,responsible_role:effect.responsible_role,corrective_action:"Corrigir a pendência na área responsável e iniciar um novo comando."} });
      };
      if (!reverse && old?.state === "pulado" && input.intent !== "apply_skipped") return finish(old);
      if (!reverse && !ctx.parts[input.axis] && !old?.fingerprint) return finish({ ...effect,state:"pulado",reason:"part_disabled",command_id:command.id,result:{reason:"part_disabled",explicit_retry_required:true} });
      if (!allowed) return fail("local_role_required");
      if (reverse && old?.compensation_state === "revertido") return finish(old);
      try {
        if (!reverse) assertSource(ctx,emission,revision);
        const found = find(ctx,emission,revision,input.axis,reverse);
        if (reverse) {
          // Também sem registro anterior do efeito: quem reconheceu o lançamento responde por ele.
          const owner = found ? otherOwner(ctx,emission,input.axis,found.ids) : null;
          if (owner) {
            // Reconhecimento sem transferência registrada (efeito anterior a
            // ela ou atalho do fingerprint): registra agora, pelo comando que
            // reconheceu, para a pendência desta versão sair da tela.
            if (old?.fingerprint && ["aplicado","reconhecido"].includes(old.state) && old.compensation_state !== "revertido" &&
                com1Hash(old.ids) === com1Hash(found!.ids) && owner.command_id)
              return transferEffect(ctx,old,{ emission_id:owner.emission_id,command_id:owner.command_id });
            raise("55000",TRANSFERRED);
          }
          if (!found) {
            // Só reconhece reversão anterior com prova no posting exato.
            if (old?.ids.posting_id && ["document","legacy_invoice"].includes(old.origin ?? "")) {
              const owner = old.origin === "document" ? "document" : "invoice";
              const table = `erp_${input.axis}__${owner}_posting`;
              const p = one(ctx.db,`SELECT * FROM ${table} WHERE id=? AND ${owner}_id=? AND state='reversed'`,old.ids.posting_id,owner === "document" ? emission.document_id : old.ids.invoice_id);
              if (p && (input.axis === "finance" || p.reversal_movement_id)) return finish({ ...old,compensation_state:"revertido",compensation_command_id:command.id,compensation_result:{proof:"previous_reversal",posting_id:String(p.id),reversal_movement_id:p.reversal_movement_id ? String(p.reversal_movement_id) : null} });
            }
            return fail("com1_effect_no_reversible_posting");
          }
          if (!old?.fingerprint) effect = { ...effect,state:effect.state === "pulado" ? "pulado" : "reconhecido",origin:found.origin,ids:found.ids,fingerprint:found.fingerprint,result:found.result };
          if (old?.fingerprint && (old.fingerprint !== found.fingerprint || com1Hash(old.ids) !== com1Hash(found.ids))) return fail("com1_effect_reconciliation_required");
          if (found.origin === "grouped_billing") return fail("grouped_billing_requires_manual_review");
          if (input.axis === "stock" && input.physical_return_confirmed !== true) return fail("physical_return_required");
          if (input.axis === "finance") {
            const rows = titles(ctx,found.origin,found.posting!.id);
            if (rows.some(t => BigInt(String(t.settled_cents)) !== 0n)) return fail("received_title_requires_manual_review");
            // Boleto vivo: a revisão manual é declarar a baixa no banco (title_bank_writeoff).
            if (rows.some(t => liveBankCollection(ctx.db,t.id))) return fail("bank_collection_requires_manual_review");
          }
        } else if (found) {
          if (old?.fingerprint && (old.fingerprint !== found.fingerprint || com1Hash(old.ids) !== com1Hash(found.ids))) return fail("com1_effect_reconciliation_required");
          if (old?.fingerprint) return finish({ ...old,reason:null,result:{...old.result,...found.result,reconciliation:null} });
          // Nova versão fiscal sem retorno da mercadoria: a emissão cancelada
          // transfere a responsabilidade pelo lançamento a esta emissão.
          const previous = otherOwner(ctx,emission,input.axis,found.ids);
          if (previous) { ensureCommand(); transferEffect(ctx,previous,{ emission_id:emission.id,command_id:command.id }); }
          return finish({ ...effect,state:"reconhecido",origin:found.origin,ids:found.ids,fingerprint:found.fingerprint,reason:null,command_id:command.id,
            result:previous ? { ...found.result,transferred_from:{ emission_id:previous.emission_id,
              application_command_id:String(previous.result?.application_command_id ?? previous.command_id) } } : found.result });
        } else if (old?.fingerprint) return fail("com1_effect_reconciliation_required");
        else if (input.intent === "reconcile") return fail("local_effect_not_found");
        if (!reverse && !ctx.parts[input.axis]) return fail("part_disabled");
        // A versão técnica é relida em cada eixo/tentativa, nunca reutilizada da preparação.
        const d = currentDocument(ctx,emission.document_id), localCommand = randomUUID();
        const base: RpcArgs = { p_user_id:ctx.identity.actor!.user_id,p_kind:"sales_orders",p_document_id:d.id,p_expected_version:d.version };
        const day = dayOf(ctx), reason = reverse ? "Cancelamento fiscal: retorno e efeitos locais conferidos" : "Autorização fiscal: efeito comercial do pedido";
        let rpc: string, args: RpcArgs;
        const maintenance = <T>(name: string, fn: () => T): T => {
          if (!reverse) return fn();
          const invoiceActions: Record<string,ErpMaintenanceAction> = {
            erp_stock_invoice_reverse_preview:"invoice_stock_reverse_preview",erp_stock_invoice_reverse:"invoice_stock_reverse",
            erp_finance_invoice_finance_reverse:"invoice_finance_reverse",
          };
          const action = invoiceActions[name] ?? name.replace(/^erp_/,"") as ErpMaintenanceAction;
          const origin = found?.origin === "legacy_invoice" ? {type:"nfe",id:String(found.ids.invoice_id)} : {type:"sales_orders",id:emission.document_id};
          // A compensação já conferiu cancelamento, responsável e retorno físico.
          return withErpMaintenance(ctx,{origin,action},() => withCom1Compensation(ctx,emission.document_id,fn));
        };
        if (reverse && found!.origin === "legacy_invoice") {
          if (input.axis === "stock") {
            const previewArgs = {p_user_id:base.p_user_id,p_invoice_id:found!.ids.invoice_id,p_posting_id:found!.posting!.id,p_posting_version:found!.posting!.version};
            const preview=object(object(maintenance("erp_stock_invoice_reverse_preview",() => invoke(ctx,"erp_stock_invoice_reverse_preview",previewArgs))).preview);
            rpc="erp_stock_invoice_reverse";args={...previewArgs,p_command_id:localCommand,p_preview_hash:preview.preview_hash};
          } else {
            rpc="erp_finance_invoice_finance_reverse";
            args={p_user_id:base.p_user_id,p_command_id:localCommand,p_data:{invoice_id:found!.ids.invoice_id,posting_id:found!.posting!.id,
              expected_version:found!.posting!.version,titles:titles(ctx,found!.origin,found!.posting!.id).map(t => ({id:t.id,version:t.version})),reason}};
          }
        } else if (reverse) {
          const prefix = input.axis === "stock" ? "erp_document_stock_reverse" : "erp_document_finance_reverse";
          const previewArgs = { ...base,p_posting_id:found!.posting!.id,p_posting_version:found!.posting!.version,
            ...(input.axis === "stock" ? {p_occurred_on:day,p_reason:reason} : {}) };
          const preview = object(object(maintenance(`${prefix}_preview`,() => invoke(ctx,`${prefix}_preview`,previewArgs))).preview);
          rpc=prefix;
          args={...previewArgs,p_command_id:localCommand,p_preview_hash:preview.preview_hash,p_reason:reason,
            ...(input.axis === "finance" ? {p_title_versions:array(preview.titles).map(t => ({id:t.id,version:t.version}))} : {})};
        } else if (input.axis === "stock") {
          const reserve = one(ctx.db,`SELECT * FROM erp_stock__reservation WHERE document_id=? AND state='active'`,d.id);
          if (reserve) {
            const reserveArgs={p_user_id:base.p_user_id,p_document_id:d.id,p_expected_version:d.version,p_action:"consume",p_reservation_id:reserve.id,p_reservation_version:reserve.version,p_occurred_on:day,p_reason:reason};
            const preview=object(object(invoke(ctx,"erp_stock_reservation_preview",reserveArgs)).preview);
            if (com1Hash(stockContent(array(preview.positions),true)) !== com1Hash(expectedStock(ctx,emission,revision))) pending("com1_effect_reservation_content_mismatch");
            rpc="erp_stock_reservation_apply";args={...reserveArgs,p_command_id:localCommand,p_preview_hash:preview.preview_hash};
          } else {
            const previewArgs={...base,p_occurred_on:day,p_reason:reason};
            const preview=object(object(invoke(ctx,"erp_document_stock_preview",previewArgs)).preview);
            if (com1Hash(stockContent(array(preview.positions))) !== com1Hash(expectedStock(ctx,emission,revision)) || array(preview.ignored).length) pending("com1_effect_stock_content_mismatch");
            rpc="erp_document_stock_post";args={...previewArgs,p_command_id:localCommand,p_preview_hash:preview.preview_hash,p_ignored_item_ids:[]};
          }
        } else {
          const preview=object(object(invoke(ctx,"erp_document_finance_preview",base)).preview);
          rpc="erp_document_finance_post";args={...base,p_command_id:localCommand,p_preview_hash:preview.preview_hash};
        }
        // A tentativa conserva ator, versão, preview e UUID locais exatos. Novo
        // ator ou novos argumentos requerem outro command_id da fatia.
        ensureCommand(json({rpc,args,local_command_id:localCommand}));
        return localTransaction(ctx,() => {
          const result=json(maintenance(rpc,() => invoke(ctx,rpc,args)));
          if (reverse) return finish({ ...effect,compensation_state:"revertido",compensation_command_id:command.id,
            compensation_result:{local_command_id:localCommand,result,physical_return_confirmed:input.physical_return_confirmed === true} });
          const applied=find(ctx,emission,revision,input.axis) ?? pending("com1_effect_missing_local_proof");
          return finish({ ...effect,state:"aplicado",origin:applied.origin,ids:applied.ids,fingerprint:applied.fingerprint,
            reason:null,command_id:command.id,person_id:ctx.identity.actor!.user_id,result:{...applied.result,local_command_id:localCommand,result} });
        });
      } catch(error) {
        if (error instanceof ErpError && error.message === TRANSFERRED) throw error;
        return fail(codeOf(error));
      }
    });
  }
  return { applyEffects:(ctx:RpcContext,input:EffectInput) => execute(ctx,input,false),reverseEffects:(ctx:RpcContext,input:EffectInput) => execute(ctx,input,true) };
}
const defaults=createCom1EffectHandlers();
export const applyEffects=defaults.applyEffects;
export const reverseEffects=defaults.reverseEffects;
