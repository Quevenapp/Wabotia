import type { IntegrationResult } from "../../../../integrations/contracts.ts";
import { one } from "../../../engine/driver.ts";
import { hash } from "../../../../integrations/keys.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { execution, internalCommand, moduleReceipt, originAnchor, previousReceipt, writeModuleReceipt, writeOriginAnchor, withOriginOperation, type ComponentState } from "../../../engine/module-origin.ts";
import { moduleDocumentBody, moduleStatus, nextComponent, requestedDestinations, validateModuleBody } from "../module-policy.ts";
import { updateDocument } from "../rows.ts";
import { erpDocumentSave } from "./erp_document_save.ts";
import { cancelModuleTitles, createModuleTitles, postModuleDocument, requireManualDestinations, reverseModuleSettlements, settleModuleTitles } from "../../finance/module-posting.ts";

const table = { document: "erp_documents__document", title: "erp_finance__title", stock_posting: "erp_stock__document_posting" } as const;
function links(ctx: RpcContext, components: Record<string, ComponentState>): IntegrationResult["links"] {
  const result: IntegrationResult["links"][number][] = [];
  const source = execution(ctx).request.source;
  for (const [component, state] of Object.entries(components)) {
    for (const effect of state.effects) if (effect.kind === "finance_posting" || effect.kind === "stock_posting" || effect.kind === "title")
      effect.version = Number(one(ctx.db, `SELECT version FROM ${effect.kind === "finance_posting" ? "erp_finance__document_posting" : table[effect.kind as "title" | "stock_posting"]} WHERE id=?`, effect.id)?.version);
    const document = originAnchor(ctx.db, { ...source, component }, "document");
    const values = [...(document ? [{ kind: "document", id: document.target.id }] : []), ...state.effects];
    for (const value of values) if (["document", "title", "stock_posting", "settlement"].includes(value.kind)) {
      const kind = value.kind as IntegrationResult["links"][number]["kind"];
      result.push({ slot: `${component}:${kind}:${value.id}`, kind, id: value.id,
        version: kind === "settlement" ? null : Number(one(ctx.db, `SELECT version FROM ${table[kind]} WHERE id=?`, value.id)?.version) });
    }
  }
  return result;
}
function checkVersions(ctx: RpcContext) {
  const r = execution(ctx).request, previous = previousReceipt(ctx);
  const expected = r.expected;
  const valid = new Map((previous?.result.links ?? []).filter(l => l.version !== null).map(l => [`${l.kind === "stock_posting" ? "posting" : l.kind}:${l.id}`, l]));
  for (const state of Object.values(previous?.components ?? {})) for (const effect of state.effects) if (effect.kind === "finance_posting" &&
      Number(one(ctx.db, "SELECT version FROM erp_finance__document_posting WHERE id=?", effect.id)?.version) !== effect.version) raise("40001", "module_version_conflict");
  if (Object.keys(expected).length !== valid.size) raise("40001", "module_version_conflict");
  for (const [key, link] of valid) {
    const t = table[link.kind as keyof typeof table];
    if (!t || expected[key] !== link.version || Number(one(ctx.db, `SELECT version FROM ${t} WHERE id=?`, link.id)?.version) !== expected[key]) raise("40001", "module_version_conflict");
  }
}
function result(ctx: RpcContext, outcome: IntegrationResult["outcome"], reason: string | null = null): IntegrationResult {
  const r = execution(ctx).request;
  return { command_id: r.command_id, replayed: false, seq: r.seq, outcome, links: previousReceipt(ctx)?.result.links ?? [],
    effects: { stock: "not_requested", finance: "not_requested" }, reason_code: reason };
}
export function erpModuleOriginGet(ctx: RpcContext) {
  const receipt = moduleReceipt(ctx);
  // Apenas recibo da requisição verificada; nenhuma leitura financeira genérica.
  return { receipt: receipt ? { ...receipt.result, replayed: true } : null };
}
export function erpModuleCommandClose(ctx: RpcContext, a: RpcArgs) {
  const receipt = moduleReceipt(ctx);
  if (receipt) return { ...receipt.result, replayed: true };
  const reason = a.p_reason_code;
  if (typeof reason !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(reason)) raise("22023", "module_reason_required");
  const r = execution(ctx).request;
  if (execution(ctx).previous_seq > 0 && !previousReceipt(ctx)) raise("40001", "module_sequence_conflict");
  return writeModuleReceipt(ctx, result(ctx, "closed", reason), previousReceipt(ctx)?.components ?? {});
}
export function erpModuleApply(ctx: RpcContext) {
  const receipt = moduleReceipt(ctx);
  if (receipt) return { ...receipt.result, replayed: true };
  checkVersions(ctx);
  const b = validateModuleBody(ctx), destinations = requestedDestinations(ctx, b), r = execution(ctx).request;
  requireManualDestinations(ctx, b);
  const components = structuredClone(previousReceipt(ctx)?.components ?? {});
  const previous = components[r.source.component];
  const state = nextComponent(b, previous);
  components[r.source.component] = state;
  const out = result(ctx, "applied");
  let document = originAnchor(ctx.db, r.source, "document")?.target.id;
  const prepare = b.route !== "title" && ["prepare", "execute"].includes(b.operation);
  if (prepare && !document && destinations.document) {
    const saved = withOriginOperation(ctx, "document_prepare", [], [], inner => erpDocumentSave(inner, {
      p_user_id: r.actor_id, p_kind: b.route === "work" ? "service_orders" : "sales_orders", p_id: null, p_expected_version: 0,
      p_command_id: internalCommand(r.command_id, "save"), p_body: moduleDocumentBody(ctx, b),
    })) as { document: { id: string } };
    document = saved.document.id;
    writeOriginAnchor(ctx, "document", "document", document);
  } else if (prepare && document && previous && !previous.stock_posted && !previous.finance_posted && previous.commercial_hash !== state.commercial_hash) {
    withOriginOperation(ctx, "document_prepare", [document], [], inner => erpDocumentSave(inner, {
      p_user_id: r.actor_id, p_kind: b.route === "work" ? "service_orders" : "sales_orders", p_id: document,
      p_expected_version: Number(one(ctx.db, "SELECT version FROM erp_documents__document WHERE id=?", document)?.version),
      p_command_id: internalCommand(r.command_id, "save"), p_body: moduleDocumentBody(ctx, b),
    }));
  }
  if (b.route !== "title" && !document && ["receive", "reverse", "lifecycle"].includes(b.operation)) raise("40001", "historical_origin_unlinked");
  if (document && Number(one(ctx.db, "SELECT total FROM erp_documents__document WHERE id=?", document)?.total) !== b.snapshot.total_cents)
    raise("40001", "module_total_mismatch");
  // Cancelar primeiro reverte os efeitos. Qualquer bloqueador desfaz toda a chamada.
  if (b.operation === "cancel") {
    if (document) {
      if (destinations.finance && state.effects.some(e => e.kind === "finance_posting")) {
        postModuleDocument(ctx, b, state, document, "finance", true); out.effects.finance = "reversed";
      }
      if (destinations.stock && state.effects.some(e => e.kind === "stock_posting")) {
        postModuleDocument(ctx, b, state, document, "stock", true); out.effects.stock = "reversed";
      }
    } else if (destinations.finance && state.finance_posted) { cancelModuleTitles(ctx, b, state); out.effects.finance = "reversed"; }
  }
  if (document && ["prepare", "execute", "lifecycle", "cancel"].includes(b.operation)) {
    const status = moduleStatus(b);
    if (!status) raise("22023", "module_transition_invalid");
    withOriginOperation(ctx, "document_transition", [document], [], inner => {
      const row = one(inner.db, "SELECT * FROM erp_documents__document WHERE id=?", document)!;
      if (row.status !== status) {
        const command = internalCommand(r.command_id, "transition"), version = Number(row.version) + 1;
        updateDocument(inner, document!, { status, version, updated_by: r.actor_id, updated_at: inner.clock.next().toString() });
        const transition = { document_id: document, before: row.status, status, version };
        inner.db.exec("INSERT INTO erp_documents__command(command_id,actor,request_hash,result,created_at) VALUES(?,?,?,?,?)",
          command, r.actor_id, hash({ ...transition, expected_version: row.version }), JSON.stringify(transition), inner.clock.next().toString());
        inner.db.exec("INSERT INTO erp_documents__audit(id,actor,command_id,document_id,action,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          nextIdentity(inner, "erp_documents__audit", "id"), r.actor_id, command, document, "transition", b.reason_code,
          JSON.stringify({ status: row.status, version: row.version }), JSON.stringify({ status, version }), inner.clock.next().toString());
      }
    });
  }
  const firstExecution = b.operation === "execute" && !previous?.executed ||
    execution(ctx).evidence.mode === "human" && ["execute", "lifecycle"].includes(b.operation) && state.first_execution_at !== null;
  if (document && firstExecution) {
    if (destinations.stock && !state.stock_posted) {
      state.stock_posted = postModuleDocument(ctx, b, state, document, "stock");
      out.effects.stock = state.stock_posted ? "posted" : "skipped";
    } else if (b.requested.stock && !state.stock_posted) out.effects.stock = "skipped";
    if (destinations.finance && !state.finance_posted) {
      postModuleDocument(ctx, b, state, document, "finance"); state.finance_posted = true; out.effects.finance = "posted";
    } else if (b.requested.finance && !state.finance_posted) out.effects.finance = "skipped";
  }
  if (b.route === "title" && b.operation === "recognize" && !state.finance_posted) {
    if (destinations.finance) { createModuleTitles(ctx, b, state); out.effects.finance = "posted"; }
    else out.effects.finance = "skipped";
  }
  if (b.operation === "receive") {
    if (destinations.finance && !state.effects.some(e => e.kind === "title")) raise("40001", "historical_origin_unlinked");
    if (destinations.finance) { if (settleModuleTitles(ctx, b, state)) out.effects.finance = "settled"; }
    else out.effects.finance = ctx.parts.finance && execution(ctx).open.finance && !b.requested.finance ? "not_requested" : "skipped";
  }
  if (b.operation === "reverse" && destinations.finance && reverseModuleSettlements(ctx, b, state)) out.effects.finance = "reversed";
  if (b.operation === "execute") state.executed = true;
  out.links = links(ctx, components);
  if (Object.values(out.effects).includes("skipped")) out.reason_code =
    out.effects.stock === "skipped" && (!ctx.parts.stock || !execution(ctx).open.stock) ||
    out.effects.finance === "skipped" && (!ctx.parts.finance || !execution(ctx).open.finance) ? "part_disabled" : "unlinked_item";
  return writeModuleReceipt(ctx, out, components);
}
registerRpc("erp_module_apply", erpModuleApply);
registerRpc("erp_module_manual_apply", erpModuleApply);
registerRpc("erp_module_origin_get", erpModuleOriginGet);
registerRpc("erp_module_command_close", erpModuleCommandClose);
