// Capacidade F3: prova D1 no transporte, propriedade SQLite na transação.
// Nenhum campo recebido por HTTP é uma instância de capacidade.
import { createHash } from "node:crypto";
import { canonical, commandId, F3_NAMESPACES, hash, uuid5 } from "../../integrations/keys.ts";
import type { CommercialPolicy, CommercialSnapshot, IntegrationEvent, IntegrationModule, IntegrationResult, PreparedErpRequest, SourceRef } from "../../integrations/contracts.ts";
import type { IdentityPort } from "./identity.ts";
import type { RpcArgs, RpcContext } from "./registry.ts";
import { one, type SqlDriver } from "./driver.ts";
import { ErpError, raise } from "./errors.ts";

export const MODULE_RPCS = ["erp_module_apply", "erp_module_origin_get", "erp_module_command_close", "erp_module_manual_apply"] as const;
export const INTEGRATION_MODULES = ["os", "pedido", "mesas", "entrega", "mensalidade", "agenda", "reserva", "suporte"] as const;
export const ORIGIN_POLICY = "wabotia-module-origin-v1";
export interface ModuleExecutionEvidence {
  profile: string; module: IntegrationModule; source_id: string; seq: number; event_id: string;
  command_id: string; event_hash: string; request_hash: string; mode: "system" | "human";
}
export type OriginOperation = "document_prepare" | "document_transition" | "stock_post" | "stock_reverse" |
  "title_create" | "title_settle" | "title_cancel" | "settlement_reverse" | "receipt_read" | "command_close";
export interface VerifiedOriginScope {
  readonly evidence: ModuleExecutionEvidence;
  readonly operation: OriginOperation;
  readonly target_ids: ReadonlySet<string>;
  readonly original_effect_ids: ReadonlySet<string>;
}
export interface OriginAnchor {
  policy: typeof ORIGIN_POLICY; type: "anchor"; source: SourceRef; slot: string;
  target: { kind: string; id: string }; actor: string; command_id: string;
}
export interface OriginReceipt {
  policy: typeof ORIGIN_POLICY; type: "receipt"; source: SourceRef; actor: string; request_hash: string;
  result: IntegrationResult; components: Record<string, ComponentState>;
}
export interface ComponentState {
  snapshot: CommercialSnapshot;
  parameters?: Pick<CommercialPolicy, "warehouse_id" | "revenue_category_id" | "payment_method_id">;
  executed: boolean;
  commercial_hash: string; first_execution_at: number | null; delivered_at: number | null; warranty_until: number | null;
  stock_posted: boolean; finance_posted: boolean; base_status: string; source_revision: number;
  effects: { kind: string; id: string; actor: string; command_id: string; receipt_key: string | null; version: number | null; amount_cents?: number }[];
}
export interface ModuleTransportProof {
  readonly rpc: string; readonly identity_hash: string;
  readonly evidence: ModuleExecutionEvidence; readonly request: PreparedErpRequest; readonly event: IntegrationEvent;
  readonly open: { document: boolean; stock: boolean; finance: boolean };
  /** Predecessor remoto após os saltos locais sem pedido nem efeito. */
  readonly previous_seq: number;
}
const proofs = new WeakSet<object>();
const scopes = new WeakMap<RpcContext, { proof: ModuleTransportProof; scope: VerifiedOriginScope; previous: OriginReceipt | null }>();
// Um driver novo é passado explicitamente aos núcleos legados que recebem db.
// O driver original nunca recebe autoridade; o empréstimo é revogado em finally.
const drivers = new WeakMap<SqlDriver, RpcContext>();
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const opaque = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v);
const same = (a: unknown, b: unknown) => { try { return canonical(a) === canonical(b); } catch { return false; } };
const denied = (): never => raise("42501", "module_origin_denied");
export function readModuleEvidence(v: any): ModuleExecutionEvidence | undefined {
  if (!v || !INTEGRATION_MODULES.includes(v.module) || !opaque(v.profile) || !opaque(v.source_id) ||
      !Number.isSafeInteger(v.seq) || v.seq < 1 || !UUID.test(v.event_id) || !UUID.test(v.command_id) ||
      !SHA.test(v.event_hash) || !SHA.test(v.request_hash) || !["system", "human"].includes(v.mode)) return undefined;
  return Object.freeze(Object.fromEntries(["profile", "module", "source_id", "seq", "event_id", "command_id", "event_hash", "request_hash", "mode"].map(k => [k, v[k]]))) as unknown as ModuleExecutionEvidence;
}
export function moduleSystemUser(module: string): string {
  const d = createHash("sha256").update(`wabotia-erp-system:${module}`).digest();
  d[6] = (d[6] & 15) | 80; d[8] = (d[8] & 63) | 128;
  const h = d.subarray(0, 16).toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export const isModuleActor = (identity: IdentityPort) => INTEGRATION_MODULES.some(m => moduleSystemUser(m) === identity.actor?.user_id);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}

/** Única fábrica de prova; somente SELECT no D1, antes de entrar no motor. */
export async function verifyModuleTransport(db: D1Database | undefined, profile: string, rpc: string, args: RpcArgs, identity: IdentityPort): Promise<ModuleTransportProof> {
  const e = readModuleEvidence(args.p_evidence), actor = identity.actor;
  if (!db || !MODULE_RPCS.includes(rpc as any) || !e || e.profile !== profile || !actor ||
      !identity.module_execution || !same(e, identity.module_execution) || args.p_user_id !== actor.user_id) denied();
  const row = await db!.prepare(`SELECT e.*,r.actor_id,r.request_hash,r.expected_json,r.body_json
    FROM module_erp_events e JOIN module_erp_requests r ON r.event_id=e.id
    WHERE e.id=? AND e.profile_id=? AND e.module_id=? AND e.source_id=?`).bind(e!.event_id, profile, e!.module, e!.source_id).first<any>();
  if (!row) denied();
  let event: IntegrationEvent, request: PreparedErpRequest;
  try {
    event = JSON.parse(row.payload_json);
    request = { schema: 1, command_id: row.command_id, actor_id: row.actor_id, source: event.source,
      seq: row.seq, event_hash: row.event_hash, expected: JSON.parse(row.expected_json), body: JSON.parse(row.body_json) };
    if (!same(request, args.p_request) || hash(request) !== row.request_hash || hash(event) !== row.event_hash ||
        e!.request_hash !== row.request_hash || e!.event_hash !== row.event_hash || e!.command_id !== row.command_id ||
        e!.seq !== row.seq || event.seq !== row.seq || event.source_revision !== row.source_revision ||
        event.id !== row.id || event.command_id !== row.command_id || commandId(event.source, event.seq) !== event.command_id ||
        event.source.profile !== profile || event.source.module !== e!.module || event.source.source_id !== e!.source_id ||
        !opaque(event.source.component) || request.body.operation !== event.operation) denied();
    if (request.body.close_only === true) {
      if (!["erp_module_origin_get", "erp_module_command_close"].includes(rpc) ||
          !same(request.body, { mode: "system", operation: event.operation, close_only: true })) denied();
    } else if (!same(request.body.epochs, event.epochs) || !same(request.body.eligible, event.eligible) || request.body.occurred_ms !== event.occurred_ms) denied();
  } catch { return denied(); }
  const system = actor!.is_agent && actor!.user_id === moduleSystemUser(e!.module) && actor!.erp_role === "vendas" &&
    actor!.aal === "aal1" && !actor!.verified_factor && actor!.session_id === null;
  if (e!.mode === "system" ? !system : actor!.is_agent) denied();
  if (rpc === "erp_module_apply" && (!system || request!.actor_id !== actor!.user_id || request!.body.mode !== "system")) denied();
  if (rpc === "erp_module_manual_apply" && (e!.mode !== "human" || actor!.is_agent || request!.actor_id !== actor!.user_id || request!.body.mode !== "human")) denied();
  const receipt = request!.body.receipt as any;
  if (request!.body.close_only === true) { /* Fechamento sem preparação comercial nem efeito. */ }
  else if (["receive", "reverse"].includes(event!.operation)) {
    const saved = await db!.prepare("SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?").bind(profile, event!.receipt_key).first<any>();
    const allocation = await db!.prepare(`SELECT coalesce(sum(amount_cents),0) amount_cents FROM module_erp_allocations
      WHERE profile_id=? AND receipt_key=? AND module_id=? AND source_id=? AND component=?`)
      .bind(profile, event!.receipt_key, e!.module, e!.source_id, event!.source.component).first<any>();
    const total = await db!.prepare("SELECT coalesce(sum(amount_cents),0) amount_cents FROM module_erp_allocations WHERE profile_id=? AND receipt_key=?").bind(profile, event!.receipt_key).first<any>();
    if (!saved || !receipt || !same({ ...saved }, receipt.receipt) || receipt.amount_cents !== allocation?.amount_cents ||
        !Number.isSafeInteger(receipt.amount_cents) || receipt.amount_cents <= 0 || total.amount_cents > saved.amount_cents ||
        saved.kind !== event!.operation || (saved.evidence === "manual" && !saved.actor_id) ||
        saved.reverses_key !== event!.reverses_receipt_key) denied();
    if (event!.operation === "reverse") {
      const original = await db!.prepare("SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?").bind(profile, saved.reverses_key).first<any>();
      const allocated = await db!.prepare(`SELECT coalesce(sum(amount_cents),0) amount_cents FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND module_id=? AND source_id=? AND component=?`)
        .bind(profile, saved.reverses_key, e!.module, e!.source_id, event!.source.component).first<any>();
      if (!original || original.kind !== "receive" || original.owner_module !== saved.owner_module || original.source_id !== saved.source_id ||
          original.amount_cents !== saved.amount_cents || allocated?.amount_cents !== receipt.amount_cents) denied();
    }
  } else if (receipt !== null) denied();
  const rows = await db!.prepare("SELECT * FROM module_erp_activation WHERE profile_id=?").bind(profile).all<any>();
  const open = (ids: string[]) => [e!.module, "erp", ...ids].every(id => {
    const a = rows.results.find(a => a.module_id === id);
    const factAt = event!.operation === "execute" && e!.module === "os" && request!.body.mode === "system" ? event!.snapshot.lifecycle.first_execution_at : event!.occurred_ms;
    return a?.enabled === 1 && a.epoch === event!.epochs[id] && a.enabled_since_ms !== null && factAt !== null && factAt >= a.enabled_since_ms;
  });
  let previousSeq = e!.seq - 1;
  while (previousSeq > 0) {
    const previous = await db!.prepare(`SELECT e.seq,e.command_id,e.event_hash,e.payload_json,d.state,d.receipt_json,r.event_id prepared
      FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id
      LEFT JOIN module_erp_requests r ON r.event_id=e.id
      WHERE e.profile_id=? AND e.module_id=? AND e.source_id=? AND e.seq=? LIMIT 1`)
      .bind(profile, e!.module, e!.source_id, previousSeq).all<any>();
    const row = previous.results[0];
    if (!row) break;
    if (row.seq !== previousSeq || row.prepared || row.state !== "done" || !row.receipt_json) break;
    let fact: IntegrationEvent, result: IntegrationResult;
    try { fact = JSON.parse(row.payload_json); result = JSON.parse(row.receipt_json); } catch { break; }
    if (hash(fact) !== row.event_hash || fact.seq !== previousSeq || fact.command_id !== row.command_id ||
        fact.source.profile !== profile || fact.source.module !== e!.module || fact.source.source_id !== e!.source_id ||
        fact.command_id !== commandId(request!.source, previousSeq) ||
        !same(fact.eligible, { document: false, stock: false, finance: false }) ||
        !same(result, { command_id: fact.command_id, seq: previousSeq, replayed: false, outcome: "skipped", links: [],
          effects: { stock: "not_requested", finance: "not_requested" }, reason_code: "part_disabled" })) break;
    previousSeq--;
  }
  const proof = freeze({ rpc, identity_hash: hash(identity), evidence: e!, request: request!, event: event!, previous_seq: previousSeq, open: {
    document: event!.eligible.document && (open(["erp-vendas"]) || event!.eligible.finance && open(["erp-financeiro"]) || event!.eligible.stock && open(["erp-produtos", "erp-estoque"])),
    stock: event!.eligible.stock && open(["erp-produtos", "erp-estoque"]), finance: event!.eligible.finance && open(["erp-financeiro"]),
  } });
  proofs.add(proof); return proof;
}

const anchorKey = (source: SourceRef, slot: string) => uuid5(F3_NAMESPACES.origin, canonical([source.profile, source.module, source.source_id, source.component, slot]));
const reverseKey = (profile: string, kind: string, id: string) => uuid5(F3_NAMESPACES.reverse_origin, canonical([profile, kind, id]));
export const internalCommand = (command: string, action: string, slot = "") => uuid5(F3_NAMESPACES.internal, canonical([command, action, slot]));
function saved(db: SqlDriver, id: string): any {
  const r = one(db, "SELECT result FROM erp_documents__command WHERE command_id=?", id);
  return r ? JSON.parse(String(r.result)) : null;
}
export function originAnchor(db: SqlDriver, source: SourceRef, slot: string): OriginAnchor | null {
  const r = saved(db, anchorKey(source, slot));
  if (!r) return null;
  if (r.policy !== ORIGIN_POLICY || r.type !== "anchor" || !same(r.source, source) || r.slot !== slot) denied();
  const reverse = saved(db, reverseKey(source.profile, r.target.kind, r.target.id));
  if (!same(reverse, r)) denied();
  return r;
}
export function targetOrigin(db: SqlDriver, kind: string, id: string): OriginAnchor | null {
  // As âncoras reversas já são indexadas pela PK de command_id. Sem área
  // (núcleos legados/testes), conserva a busca defensiva, nunca supõe ausência.
  const profile = db.originProfile ?? drivers.get(db)?.identity.module_execution?.profile;
  if (profile) {
    const a = saved(db, reverseKey(profile, kind, id));
    if (!a) return null;
    if (a.policy !== ORIGIN_POLICY || a.type !== "anchor" || a.source?.profile !== profile ||
        a.target?.kind !== kind || a.target?.id !== id) denied();
    return originAnchor(db, a.source, a.slot);
  }
  const row = one(db, `SELECT result FROM erp_documents__command WHERE json_extract(result,'$.policy')=?
    AND json_extract(result,'$.type')='anchor' AND json_extract(result,'$.target.kind')=? AND json_extract(result,'$.target.id')=? LIMIT 1`, ORIGIN_POLICY, kind, id);
  if (!row) return null;
  const a = JSON.parse(String(row.result));
  return originAnchor(db, a.source, a.slot);
}
export function previousReceipt(ctx: RpcContext) { return scopes.get(ctx)?.previous ?? null; }
export function execution(ctx: RpcContext): ModuleTransportProof { return scopes.get(ctx)?.proof ?? denied(); }
export function originScope(ctx: RpcContext): VerifiedOriginScope | undefined { return scopes.get(ctx)?.scope; }
export function driverContext(db: SqlDriver): RpcContext | undefined { return drivers.get(db); }
export function systemScope(ctx: RpcContext): boolean { return !!originScope(ctx) && execution(ctx).evidence.mode === "system"; }
export function verifyModuleExecution(ctx: RpcContext, evidence: ModuleExecutionEvidence): VerifiedOriginScope {
  const current = scopes.get(ctx);
  if (!current || !same(current.proof.evidence, evidence)) denied();
  for (const id of current!.scope.target_ids) {
    const anchors = ["document", "title", "stock_posting", "finance_posting", "settlement"].map(k => targetOrigin(ctx.db, k, id)).filter(Boolean);
    if (!anchors.some(a => same(a!.source, current!.proof.request.source))) denied();
  }
  return current!.scope;
}
export function withModuleExecution<T>(ctx: RpcContext, name: string, args: RpcArgs, proof: ModuleTransportProof | undefined, run: () => T): T {
  if (!MODULE_RPCS.includes(name as any)) {
    if (ctx.identity.module_execution || isModuleActor(ctx.identity)) denied();
    return run();
  }
  if (!proof || !proofs.has(proof) || proof.rpc !== name || proof.identity_hash !== hash(ctx.identity) ||
      !same(args.p_request, proof.request) || !same(args.p_evidence, proof.evidence)) denied();
  if (!ctx.parts.customers) throw new ErpError("part_disabled", "part_disabled");
  if (!one(ctx.db, "SELECT 1 FROM erp_access__membership WHERE user_id=? AND active=1", ctx.identity.actor?.user_id ?? null)) denied();
  const r = proof!.request;
  const priorSeq = proof!.previous_seq;
  // Um retrato D1 incompatível não pode ocultar um recibo que existe no ERP.
  for (let seq = priorSeq + 1; seq < r.seq; seq++)
    if (saved(ctx.db, commandId(r.source, seq))) raise("40001", "module_sequence_conflict");
  const prior = priorSeq > 0 ? saved(ctx.db, commandId(r.source, priorSeq)) : null;
  // Leitura e fechamento podem reconciliar um comando ainda sem predecessor.
  if (["erp_module_apply", "erp_module_manual_apply"].includes(name) && priorSeq > 0 &&
      (!prior || prior.policy !== ORIGIN_POLICY || prior.type !== "receipt" || prior.result.seq !== priorSeq ||
       !same([prior.source.profile, prior.source.module, prior.source.source_id], [r.source.profile, r.source.module, r.source.source_id])))
    raise("40001", "module_sequence_conflict");
  const operation = name === "erp_module_command_close" ? "command_close" : "receipt_read";
  const scope: VerifiedOriginScope = Object.freeze({ evidence: proof!.evidence, operation, target_ids: new Set<string>(), original_effect_ids: new Set<string>() });
  scopes.set(ctx, { proof: proof!, scope, previous: prior });
  try { verifyModuleExecution(ctx, proof!.evidence); return run(); }
  finally { scopes.delete(ctx); }
}
export function withOriginOperation<T>(ctx: RpcContext, operation: OriginOperation, ids: readonly string[], effects: readonly string[], run: (inner: RpcContext) => T): T {
  const parent = scopes.get(ctx) ?? denied();
  const db: SqlDriver = { originProfile: parent.proof.request.source.profile,
    exec: (sql, ...params) => ctx.db.exec(sql, ...params), transaction: fn => ctx.db.transaction(fn) };
  const inner = { ...ctx, db };
  const scope = Object.freeze({ evidence: parent.proof.evidence, operation, target_ids: new Set(ids), original_effect_ids: new Set(effects) });
  scopes.set(inner, { ...parent, scope }); drivers.set(db, inner);
  try { verifyModuleExecution(inner, scope.evidence); return run(inner); }
  finally { drivers.delete(db); scopes.delete(inner); }
}
export function requireOriginOperation(ctx: RpcContext, operation: OriginOperation, targetId: string): void {
  const scope = verifyModuleExecution(ctx, execution(ctx).evidence);
  if (scope.operation !== operation || !scope.target_ids.has(targetId)) denied();
}
export function originAccess(db: SqlDriver, actor: string | null, operations: readonly OriginOperation[]): boolean {
  const ctx = driverContext(db), scope = ctx && originScope(ctx);
  if (!ctx || !scope) return false;
  verifyModuleExecution(ctx, scope.evidence);
  if (actor !== ctx.identity.actor?.user_id || !operations.includes(scope.operation)) denied();
  return true;
}
export function writeOriginAnchor(ctx: RpcContext, slot: string, kind: string, id: string): OriginAnchor {
  const { request } = execution(ctx);
  if (originAnchor(ctx.db, request.source, slot) || targetOrigin(ctx.db, kind, id)) raise("40001", "module_origin_conflict");
  const anchor: OriginAnchor = { policy: ORIGIN_POLICY, type: "anchor", source: request.source, slot, target: { kind, id }, actor: request.actor_id, command_id: request.command_id };
  for (const key of [anchorKey(request.source, slot), reverseKey(request.source.profile, kind, id)])
    ctx.db.exec("INSERT INTO erp_documents__command(command_id,actor,request_hash,result,created_at) VALUES(?,?,?,?,?)", key, request.actor_id, hash(anchor), canonical(anchor), ctx.clock.next().toString());
  return anchor;
}
export function moduleReceipt(ctx: RpcContext): OriginReceipt | null {
  const { request } = execution(ctx), r = saved(ctx.db, request.command_id);
  if (!r) return null;
  if (r.policy !== ORIGIN_POLICY || r.type !== "receipt" || r.actor !== request.actor_id || r.request_hash !== hash(request) || !same(r.source, request.source)) raise("40001", "module_command_conflict");
  return r;
}
export function writeModuleReceipt(ctx: RpcContext, result: IntegrationResult, components: Record<string, ComponentState>): IntegrationResult {
  const { request } = execution(ctx);
  const r: OriginReceipt = { policy: ORIGIN_POLICY, type: "receipt", source: request.source, actor: request.actor_id, request_hash: hash(request), result, components };
  ctx.db.exec("INSERT INTO erp_documents__command(command_id,actor,request_hash,result,created_at) VALUES(?,?,?,?,?)", request.command_id, request.actor_id, r.request_hash, canonical(r), ctx.clock.next().toString());
  return result;
}
export function assertOwnEffect(ctx: RpcContext, kind: string, id: string): void {
  const a = targetOrigin(ctx.db, kind, id), scope = originScope(ctx) ?? denied();
  if (!a) return denied();
  if (!same(a.source, execution(ctx).request.source) || !scope.original_effect_ids.has(id)) denied();
  if (systemScope(ctx) && a.actor !== ctx.identity.actor?.user_id) denied();
  const table = { stock_posting: "erp_stock__document_posting", finance_posting: "erp_finance__document_posting", settlement: "erp_finance__settlement" }[kind];
  if (table) {
    const row = one(ctx.db, `SELECT actor,command_id FROM ${table} WHERE id=?`, id);
    if (!row || row.actor !== a.actor) denied();
    const effect = previousReceipt(ctx)?.components[a.source.component]?.effects.find(x => x.id === id);
    if (!effect || effect.actor !== row.actor || effect.command_id !== row.command_id) denied();
  }
}

/** Portão restrito de partes para RPCs F3 e os núcleos chamados pelo executor. */
export function moduleParts(ctx: RpcContext, name: string, args: RpcArgs): boolean {
  const scope = originScope(ctx);
  if (!scope) return false;
  if (!ctx.parts.customers) throw new ErpError("part_disabled", "part_disabled");
  if (MODULE_RPCS.includes(name as any)) return true;
  const allowed: Partial<Record<OriginOperation, string[]>> = {
    document_prepare: ["erp_document_save"], document_transition: ["erp_document_transition"],
    stock_post: ["erp_document_stock_preview", "erp_document_stock_post"], stock_reverse: ["erp_document_stock_reverse_preview", "erp_document_stock_reverse"],
    title_create: ["erp_finance_title_execute", "erp_document_finance_preview", "erp_document_finance_post"],
    title_settle: ["erp_finance_execute"], title_cancel: ["erp_finance_execute", "erp_document_finance_reverse_preview", "erp_document_finance_reverse"],
    settlement_reverse: ["erp_finance_execute"],
  };
  if (!allowed[scope.operation]?.includes(name)) denied();
  const id = args.p_document_id ?? args.p_id ?? (args.p_data as any)?.id;
  if (id != null) requireOriginOperation(ctx, scope.operation, String(id));
  if (["stock_post", "title_create", "title_settle"].includes(scope.operation)) {
    const part = scope.operation === "stock_post" ? "stock" : "finance";
    if (!ctx.parts[part] || part === "stock" && !ctx.parts.products) throw new ErpError("part_disabled", "part_disabled");
  }
  return true;
}
