/** Executor assíncrono privado. Uma reserva e, no máximo, um GET por acordada. */
import { BLING_BUDGET, BlingError, type BlingCheckpoint, type BlingContext, type BlingEntity, type BlingExpectedState, type BlingRawRecord, type BlingSelection, type BlingUnit, type BlingWakeResult, type JsonObject, type ResourceDescriptor } from "./contracts.ts";
import type { ArchivePort, AuthorizationPort, BlingCommitInput, BlingDataPort, BlingWakeBudget, BlingWakePort } from "./ports.ts";
import { readErpPartsSnapshot, type ErpPartsSnapshot } from "../parts.ts";
import { BLING_RESOURCES, assertResourceConfirmed, buildBlingListQuery, exactSourceId, getBlingResource, resourceVariants } from "./resources.ts";
import { parseBlingResponse, parseLexicalJson, type BlingClientTimer } from "./client.ts";
import { remoteTimestampMillis, semanticHash, type SqliteCollectionStore } from "./repository.ts";
import { COLLECTION_POLICY, advanceWindow, captureRepairEligible, chooseFair, collectionBackoff, financeRefreshEligible, finishPageItem, nextCheckpoint, nextWindow, pageSlice, type PageCursor, type WindowState } from "./planner.ts";

export interface BlingWakeDependencies {
  collection: SqliteCollectionStore; data: BlingDataPort; authorization: AuthorizationPort; archive: ArchivePort;
  readParts(): Promise<ErpPartsSnapshot | null>;
  revalidate(ctx: BlingContext, expected: BlingExpectedState): Promise<void>;
  randomId(): string;
  resources?: readonly ResourceDescriptor[];
  timer?: BlingClientTimer;
}
type Candidate = { key: string; entity: string; last_served_at: number; not_before: number; resource: ResourceDescriptor; selection: BlingSelection; checkpoint: BlingCheckpoint; pending?: BlingUnit };
const bytes = (text: string) => new TextEncoder().encode(text);
const iso = (ctx: BlingContext) => new Date(ctx.clock.now()).toISOString();
const fail = () => new BlingError("BLING_RESPONSE_INVALID");
const expectation = (record: BlingRawRecord | null, identity: BlingRawRecord["identity"]) => ({ identity, version: record?.version ?? null, semantic_hash: record?.semantic_hash ?? null });
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const stateExpected = (control: Record<string, unknown>, partsRevision: string): BlingExpectedState => ({ generation: String(control.generation), authorization_revision: String(control.authorization_revision), credential_revision: String(control.credential_revision), configuration_revision: String(control.revision), account_id: String(control.account_id), parts_revision: partsRevision });
function selections(control: Record<string, unknown>): BlingSelection[] {
  try {
    const selected = JSON.parse(String(control.selection)), dates = JSON.parse(String(control.date_selection ?? "{}"));
    if (!Array.isArray(selected)) throw fail();
    return selected.map((item: string | BlingSelection) => typeof item === "string" ? { key: item, selected: true, from: dates[item]?.from ?? null, to: dates[item]?.to ?? null } : item).filter(item => item.selected);
  } catch { throw fail(); }
}
export function createBlingWake(deps: BlingWakeDependencies): BlingWakePort {
  const store = deps.collection, catalog = deps.resources ?? BLING_RESOURCES;
  const owner = deps.randomId();
  const timer: BlingClientTimer = deps.timer ?? { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  async function bounded<T>(ctx: BlingContext, deadline: number, start: () => Promise<T>): Promise<T> {
    if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
    let handle: unknown;
    const timeout = new Promise<never>((_, reject) => { handle = timer.set(() => reject(new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 })), deadline - ctx.clock.now()); });
    try {
      const result = await Promise.race([start(), timeout]);
      if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
      return result;
    } finally { timer.clear(handle); }
  }
  async function context(ctx: BlingContext, deadline = ctx.clock.now() + 1000): Promise<BlingContext | null> {
    const snapshot = readErpPartsSnapshot(await bounded(ctx, deadline, deps.readParts), ctx.profile, ctx.clock.now());
    if (!snapshot?.parts.customers) return null;
    const { parts, ...partsControl } = snapshot;
    return { ...ctx, identity: { ...ctx.identity, parts, partsControl } };
  }
  function enabled(ctx: BlingContext) {
    const control = store.control(ctx);
    if (!control || !control.collect_enabled || !control.approved_by || !control.account_id || ["off", "purging", "blocked_capacity"].includes(String(control.state)) || !["ready", "expired"].includes(String(control.credential_status))) return null;
    return control;
  }
  function candidates(ctx: BlingContext, control: Record<string, unknown>): Candidate[] {
    const current = stateExpected(control, ctx.identity.partsControl!.revision);
    const outstanding = store.pending(ctx).filter(unit => Object.entries(current).every(([key, value]) => unit.expected[key as keyof BlingExpectedState] === value));
    const result: Candidate[] = [], seen = new Set<string>();
    const selected = selections(control);
    for (const selection of selected) {
      const resource = getBlingResource(selection.key, catalog);
      try { assertResourceConfirmed(resource); } catch { continue; }
      for (const lane of resourceVariants(selection.key, catalog)) {
        if (seen.has(lane.key)) continue;
        seen.add(lane.key);
        const cp = store.checkpoint(lane.key), pending = outstanding.find(unit => unit.resource_key === lane.key);
        const scopeBlocked = outstanding.some(unit => unit.entity === lane.entity && unit.phase === "blocked");
        if (scopeBlocked || pending?.phase === "blocked") continue;
        const due = pending ? Math.max(pending.not_before, pending.lease?.expires_at ?? 0) : Number(cp.cursor.not_before ?? 0);
        result.push({ key: lane.key, entity: lane.entity, resource: lane, selection, checkpoint: cp, pending,
          last_served_at: Number(cp.cursor.last_served_at ?? 0), not_before: due });
      }
    }
    return result;
  }
  function dueAt(ctx: BlingContext, control: Record<string, unknown>, items: Candidate[]): number | null {
    if (!items.length) return null;
    return Math.max(ctx.clock.now(), Number(control.next_allowed_at ?? 0), Math.min(...items.map(item => item.not_before)));
  }
  async function revalidate(ctx: BlingContext, unit: BlingUnit, deadline: number): Promise<BlingContext> {
    const fresh = await context(ctx, deadline);
    if (!fresh) throw new BlingError("BLING_DISABLED");
    await bounded(fresh, deadline, () => deps.revalidate(fresh, unit.expected));
    store.assertExpected(fresh, unit.expected, unit.resource_key ?? undefined);
    assertResourceConfirmed(getBlingResource(String(unit.plan.target_resource_key ?? unit.resource_key), catalog));
    return fresh;
  }
  function identity(ctx: BlingContext, unit: BlingUnit, id: string, entity = unit.entity!) {
    return { profile: ctx.profile, account_id: unit.expected.account_id, entity, source_id: id };
  }
  async function makeUnit(ctx: BlingContext, candidate: Candidate, expected: BlingExpectedState): Promise<BlingUnit> {
    const cp = candidate.checkpoint, resource = candidate.resource;
    const id = deps.randomId();
    const unit: BlingUnit = { work_id: id, attempt_id: deps.randomId(), command_id: deps.randomId(), request_hash: "", kind: "list", entity: resource.entity, source_id: null, resource_key: resource.key, phase: "queued", expected,
      checkpoint: cp, lease: null, not_before: ctx.clock.now(), plan: {}, page: null, progress: {} };
    const currentPage = cp.cursor.page as unknown as PageCursor | undefined;
    const round = Number(cp.cursor.turn ?? 0);
    // Uma manutenção em cada quatro unidades, com cursor próprio e limitado.
    if (round % 4 === 3 && !resource.variants[0]?.deleted && resource.entity !== "stock_balances") {
      const after = String(cp.cursor.maintenance_after ?? "");
      const sources = store.scanSources(ctx, resource.entity, after, 10);
      const repair = resource.entity === "products" ? undefined : sources.find(record => captureRepairEligible(record) && store.isCaptureRepairAllowed(ctx, record));
      const finance = sources.find(record => financeRefreshEligible(record, ctx.clock.now()));
      const chosen = finance ?? repair;
      if (chosen) {
        unit.kind = finance ? "finance_refresh" : "capture_repair"; unit.source_id = chosen.identity.source_id;
        unit.plan = { target_resource_key: resource.key, path: resource.detail!.path.replace("{id}", unit.source_id), query: {}, source_expectations: [expectation(chosen, chosen.identity)] as unknown as JsonObject[], source_seen_at: chosen.observed_at, maintenance_after: unit.source_id };
      } else if (resource.entity === "sales_proposals" && sources.length) {
        const witness = sources[0], payload = object(await parseLexicalJson(witness.payload_text));
        const refs: { entity: BlingEntity; id: string }[] = [];
        if (store.isReferenceWitnessAllowed(ctx, witness) && bytes(witness.payload_text).length <= 524288 && exactSourceId(payload.id) === witness.identity.source_id && ["Rascunho", "Pendente", "Aguardando"].includes(payload.situacao) && Array.isArray(payload.itens) && payload.itens.length >= 1 && payload.itens.length <= 250) {
          const add = (entity: BlingEntity, value: unknown) => { try { const id = exactSourceId(value); if (!refs.some(ref => ref.entity === entity && ref.id === id)) refs.push({ entity, id }); } catch { /* referência inválida permanece no bruto */ } };
          add("contacts", payload.contato?.id);
          for (const item of payload.itens) add("products", item?.produto?.id);
        }
        const cursor = Number(cp.cursor.reference_offset ?? 0), ordered = refs.sort((a, b) => a.entity.localeCompare(b.entity) || a.id.localeCompare(b.id));
        let target: { entity: BlingEntity; id: string } | undefined;
        let targetCurrent: BlingRawRecord | null = null, index = cursor;
        for (; index < ordered.length; index++) {
          const ref = ordered[index];
          if (!selections(store.control(ctx)!).some(sel => getBlingResource(sel.key, catalog).entity === ref.entity)) continue;
          const existing = store.readCurrent(ctx, identity(ctx, unit, ref.id, ref.entity));
          if (!existing || captureRepairEligible(existing)) { target = ref; targetCurrent = existing; break; }
        }
        if (target) {
          const targetResource = getBlingResource(target.entity, catalog); assertResourceConfirmed(targetResource);
          unit.entity = target.entity; unit.source_id = target.id; unit.kind = targetCurrent ? "capture_repair" : "reference";
          unit.plan = { target_resource_key: targetResource.key, path: targetResource.detail!.path.replace("{id}", target.id), query: {}, source_expectations: [expectation(targetCurrent, identity(ctx, unit, target.id)), expectation(witness, witness.identity)] as unknown as JsonObject[], witness_seen_at: witness.observed_at,
            maintenance_after: after, reference_offset: index + 1 };
        } else unit.plan = { local_only: true, maintenance_after: witness.identity.source_id, reference_offset: 0 };
      } else unit.plan = { local_only: true, maintenance_after: sources.length === 10 ? sources.at(-1)!.identity.source_id : "" };
      if (!unit.plan.path) unit.kind = "capture_repair";
    } else if (resource.entity === "stock_balances") {
      unit.kind = "stock";
      // Dez também satisfaz o teto de 25 IDs e mantém cada commit em até dez fontes.
      const stock = object(cp.cursor.stock), ids = Array.isArray(stock.ids) ? stock.ids as string[] : store.knownProducts(String(stock.after ?? ""), 10);
      const partition = Number(stock.partition ?? 0);
      unit.plan = { path: resource.path!, query: { "idsProdutos[]": ids, filtroSaldoEstoque: String(partition) }, stock_ids: ids, stock_partition: partition, stock_group: stock.group ?? id, local_only: ids.length === 0 };
      unit.page = { ids, subcursor: 0, fingerprint: semanticHash(JSON.stringify(ids), []) };
    } else if (currentPage) {
      unit.source_id = currentPage.ids[currentPage.subcursor];
      unit.kind = currentPage.fallback_id ? "list" : "detail";
      unit.page = { ids: currentPage.ids, subcursor: currentPage.subcursor, fingerprint: currentPage.fingerprint };
      unit.plan = currentPage.fallback_id ? { fallback_id: currentPage.fallback_id, path: resource.path!, query: listQuery(resource, currentPage.state) } : { path: resource.detail!.path.replace("{id}", unit.source_id), query: {} };
    } else {
      const window = nextWindow(resource, cp.cursor, ctx.clock.now(), candidate.selection);
      unit.plan = { path: resource.path!, query: listQuery(resource, window), window: window as unknown as JsonObject };
    }
    if (unit.source_id && !unit.plan.source_expectations) {
      const key = identity(ctx, unit, unit.source_id);
      unit.plan.source_expectations = [expectation(store.readCurrent(ctx, key), key)] as unknown as JsonObject[];
    }
    if (unit.kind === "stock") unit.plan.source_expectations = (unit.page?.ids ?? []).map(id => { const key = identity(ctx, unit, id); return expectation(store.readCurrent(ctx, key), key); }) as unknown as JsonObject[];
    unit.request_hash = semanticHash(JSON.stringify({ kind: unit.kind, resource: unit.resource_key, entity: unit.entity, source_id: unit.source_id, expected, checkpoint: cp, plan: unit.plan }), []);
    return unit;
  }
  function listQuery(resource: ResourceDescriptor, window: WindowState) {
    const dateOnly = ["D", "E"].includes(resource.dateFilter!.kind), { from, to, page } = window.cursor;
    return buildBlingListQuery(resource.key, { from: dateOnly ? from?.slice(0, 10) : from, to: dateOnly ? to?.slice(0, 10) : to, page, limit: 10 });
  }
  function afterUnit(unit: BlingUnit, cursor: JsonObject, now: number): BlingCheckpoint {
    cursor.last_served_at = now; cursor.turn = Number(unit.checkpoint.cursor.turn ?? 0) + 1;
    return nextCheckpoint(unit.checkpoint, cursor, now);
  }
  function maintenanceCursor(unit: BlingUnit): JsonObject {
    return { ...unit.checkpoint.cursor, maintenance_after: unit.plan.maintenance_after ?? "", reference_offset: unit.plan.reference_offset ?? 0 };
  }
  async function commit(ctx: BlingContext, unit: BlingUnit, resource: ResourceDescriptor, response: Awaited<ReturnType<typeof parseBlingResponse>> | null, responseBytes: Uint8Array | null, deadline: number) {
    let cursor: JsonObject = structuredClone(unit.checkpoint.cursor), records: BlingRawRecord[] = [];
    const counts: Record<string, number> = { units: 1, requests: Number(unit.progress.requests ?? (response ? 1 : 0)), ...(unit.progress.unavailable ? { unavailable: 1 } : {}) };
    let expected = (unit.plan.source_expectations ?? []) as unknown as BlingCommitInput["source_expectations"];
    const maintenance = ["reference", "finance_refresh", "capture_repair"].includes(unit.kind);
    if (maintenance) cursor = maintenanceCursor(unit);
    if (unit.kind === "stock") {
      const ids = unit.page?.ids ?? [], partition = Number(unit.plan.stock_partition);
      const stock = object(cursor.stock), startedAt = stock.started_at ?? iso(ctx);
      cursor.stock = ids.length && partition < 2 ? { ids, partition: partition + 1, after: stock.after ?? "", group: unit.plan.stock_group, started_at: startedAt } : { after: ids.at(-1) ?? "", partition: 0, started_at: startedAt };
      if (!ids.length) { cursor.stock = { after: "", partition: 0 }; cursor.not_before = ctx.clock.now() + COLLECTION_POLICY.sweep_ms; cursor.unfilteredPassStartedAt = startedAt; cursor.unfilteredPassCompletedAt = iso(ctx); }
      if (response?.items.some(item => !ids.includes(item.id))) throw fail();
      counts.unavailable = ids.length - (response?.items.length ?? 0);
    } else if (unit.plan.fallback_id) {
      if (!resource.variants[0]?.deleted) throw fail();
      const found = response?.items.find(item => item.id === unit.plan.fallback_id);
      // A ausência na releitura mutável não comprova exclusão.
      response = response && { ...response, items: found ? [found] : [] };
      cursor = finishPageItem(unit.checkpoint, resource, ctx.clock.now());
      counts.unavailable = found ? 0 : 1;
    } else if (unit.kind === "list") {
      const state = unit.plan.window as unknown as WindowState, ids = response!.items.map(item => item.id);
      const page = pageSlice(state, ids, semanticHash(JSON.stringify(ids), []), resource.pagination?.strategy === "source_page");
      unit.page = { ids: page.ids, fingerprint: page.fingerprint, subcursor: 0 };
      cursor = page.ids.length ? { ...state.cp, page: page as unknown as JsonObject } : advanceWindow(state, ids.length, ctx.clock.now(), resource.pagination?.strategy === "source_page");
      counts.discovered = page.ids.length;
    } else if (!maintenance) cursor = finishPageItem(unit.checkpoint, resource, ctx.clock.now());
    if (response && (unit.kind !== "list" || unit.plan.fallback_id)) {
      if (unit.source_id && (response.items.length !== 1 || response.items[0].id !== unit.source_id) && !unit.plan.fallback_id) throw fail();
      for (const item of response.items) {
        const key = identity(ctx, unit, item.id), old = store.readCurrent(ctx, key);
        const payload = object(item.value);
        const links = old?.document_links ?? [];
        const hash = semanticHash(item.payload_text, links), version = old && old.semantic_hash === hash ? old.version : String(BigInt(old?.version ?? "0") + 1n);
        // Só data explicitamente remota; nunca fabricar alteração a partir do GET.
        const remote = [payload.dataAlteracao, payload.dataAtualizacao].find(v => typeof v === "string") as string | undefined;
        const validRemote = !!remote && remoteTimestampMillis(remote) !== null;
        const record: BlingRawRecord = { identity: key, version, semantic_hash: hash, payload_text: item.payload_text, document_links: links, observed_at: iso(ctx), source_updated_at: remote ?? null, source_time_quality: remote ? validRemote ? "remote" : "invalid" : "unknown",
          deleted: resource.variants[0]?.deleted === true, deletion_evidence: resource.variants[0]?.deleted ? "explicit_deleted_variant:" + resource.key : null,
          capture: item.capture ? { ...item.capture, revision: String(BigInt(old?.capture?.revision ?? "0") + 1n), semantic_hash: hash, semantic_version: version } : null };
        deps.archive.validateCapture(ctx, { record, bytes: responseBytes! });
        records.push(record);
      }
    }
    if (records.length > 10) throw fail();
    // CAS de observação nas famílias de recaptura, além da versão/hash.
    if (unit.plan.source_seen_at && unit.source_id && store.readCurrent(ctx, identity(ctx, unit, unit.source_id))?.observed_at !== unit.plan.source_seen_at) throw new BlingError("BLING_REVISION_CONFLICT");
    if (unit.plan.witness_seen_at && expected[1] && store.readCurrent(ctx, expected[1].identity)?.observed_at !== unit.plan.witness_seen_at) throw new BlingError("BLING_REVISION_CONFLICT");
    if (unit.kind === "capture_repair" && unit.source_id) {
      const source = store.readCurrent(ctx, identity(ctx, unit, unit.source_id));
      if (source && !store.isCaptureRepairAllowed(ctx, source)) throw new BlingError("BLING_REVISION_CONFLICT");
    }
    if (unit.plan.witness_seen_at && expected[1]) {
      const witness = store.readCurrent(ctx, expected[1].identity);
      if (!witness || !store.isReferenceWitnessAllowed(ctx, witness)) throw new BlingError("BLING_REVISION_CONFLICT");
    }
    unit.progress = { coverage_complete: false, ...(unit.kind === "stock" ? { partition: Number(unit.plan.stock_partition) } : {}) };
    if (unit.page && unit.kind !== "list") unit.page = { ...unit.page, subcursor: Math.min(unit.page.ids.length, unit.page.subcursor + 1) };
    if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
    store.commitBatch(ctx, { unit, expected: unit.expected, fence: unit.lease!.fence, request_hash: unit.request_hash, records, next_checkpoint: afterUnit(unit, cursor, ctx.clock.now()), source_expectations: expected, counts });
  }
  return {
    async nextWake(raw) {
      let ctx: BlingContext | null;
      try { ctx = await context(raw); } catch { return raw.clock.now() + 1000; }
      if (!ctx) return null;
      const control = enabled(ctx); return control ? dueAt(ctx, control, candidates(ctx, control)) : null;
    },
    async runOne(raw: BlingContext, budget: BlingWakeBudget): Promise<BlingWakeResult> {
      const started = raw.clock.now(), deadline = Math.min(budget.deadline, started + BLING_BUDGET.wall_ms, budget.nextOperationalAt === null ? Infinity : budget.nextOperationalAt - BLING_BUDGET.operational_reserve_ms);
      if (deadline - started < BLING_BUDGET.minimum_available_ms) return { worked: false, nextWake: started + 1000, requests: 0 };
      let ctx: BlingContext | null;
      try { ctx = await context(raw, deadline); } catch { return { worked: false, nextWake: raw.clock.now() + 1000, requests: 0, error: new BlingError("BLING_RETRY_WAIT").toJSON() }; }
      if (!ctx) return { worked: false, nextWake: null, requests: 0 };
      const control = enabled(ctx); if (!control) return { worked: false, nextWake: null, requests: 0 };
      store.retireObsolete(ctx, stateExpected(control, ctx.identity.partsControl!.revision));
      const items = candidates(ctx, control), now = ctx.clock.now();
      const next = dueAt(ctx, control, items);
      if (next === null || next > now || deadline - now < BLING_BUDGET.minimum_available_ms) return { worked: false, nextWake: next === null ? null : Math.max(next, now + 1000), requests: 0 };
      const chosen = chooseFair(items, now); if (!chosen) return { worked: false, nextWake: next, requests: 0 };
      let unit: BlingUnit | null = null, requests: 0 | 1 = 0;
      try {
        unit = chosen.pending ?? await bounded(ctx, deadline, () => makeUnit(ctx!, chosen, stateExpected(control, ctx!.identity.partsControl!.revision)));
        if (control.credential_status === "expired") unit.progress.needs_renewal = true;
        const reserved = store.reserve(ctx, { unit, owner, lease_until: deadline + 1000 });
        if (reserved.receipt) return { worked: true, requests: 0, nextWake: now + 700 };
        unit = reserved.unit;
        if (control.credential_status === "expired") unit.progress.needs_renewal = true;
        if (unit.progress.needs_renewal) {
          // A porta de autorização toma sua posse exclusiva/CAS. A intenção é
          // durável e esta acordada não inicia GET nem uma segunda renovação.
          await bounded(ctx, deadline, () => deps.authorization.renew(ctx!, { expected: unit!.expected, lease: unit!.lease! }));
          const renewed = store.control(ctx)!;
          if (String(renewed.credential_revision) === unit.expected.credential_revision) throw new BlingError("BLING_AUTH_REQUIRED");
          store.retireObsolete(ctx, stateExpected(renewed, ctx.identity.partsControl!.revision));
          return { worked: true, requests: 0, nextWake: ctx.clock.now() + 700 };
        }
        ctx = await revalidate(ctx, unit, deadline);
        if (deadline - ctx.clock.now() < 1000) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
        unit = store.markFetching(ctx, unit);
        if (unit.plan.local_only || unit.progress.unavailable) { await commit(ctx, unit, chosen.resource, null, null, deadline); }
        else {
          store.takeCall(ctx, unit);
          requests = 1;
          const result = await bounded(ctx, deadline - 250, () => deps.data.get(ctx!, { method: "GET", resource_key: String(unit!.plan.target_resource_key ?? unit!.resource_key), path: String(unit!.plan.path), query: unit!.plan.query as Record<string, string | string[]>, deadline: Math.min(deadline - 250, ctx!.clock.now() + 3000), expected: unit!.expected }));
          unit.progress.requests = Number(unit.progress.requests ?? 0) + 1;
          ctx = await revalidate(ctx, unit, deadline);
          if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
          if (result.kind !== "success") {
            if (result.kind === "failure" && result.status === 404 && unit.kind === "detail" && chosen.resource.variants[0]?.deleted) {
              const cursor = structuredClone(unit.checkpoint.cursor), page = cursor.page as unknown as PageCursor;
              page.fallback_id = unit.source_id!;
              store.commitBatch(ctx, { unit, expected: unit.expected, fence: unit.lease!.fence, request_hash: unit.request_hash, records: [], source_expectations: (unit.plan.source_expectations ?? []) as unknown as BlingCommitInput["source_expectations"], next_checkpoint: afterUnit(unit, cursor, ctx.clock.now()), counts: { unavailable: 1, requests: 1 } });
            } else {
              const status = result.kind === "failure" ? result.status : result.error.code === "BLING_RATE_WAIT" ? 429 : 503;
              const retryAt = Math.max(result.kind === "retry" ? result.retry_at : 0, collectionBackoff(unit.kind, status, Number(unit.progress.failures ?? 0) + 1, ctx.clock.now(), unit.command_id));
              const error = new BlingError(result.error.code, { retry_at: retryAt }).toJSON();
              unit.progress = { ...unit.progress, failures: Number(unit.progress.failures ?? 0) + 1, ...(status === 404 && unit.source_id ? { unavailable: true } : {}), ...(result.error.code === "BLING_AUTH_REQUIRED" ? { needs_renewal: true } : {}) };
              if (status === 429) store.pauseAccount(ctx, unit, retryAt, error);
              // 401 agenda a porta OAuth para outra acordada; não há renovação escondida no cliente.
              store.reschedule(ctx, { unit, not_before: retryAt, error, blocked: status === 403 });
              return { worked: true, requests, nextWake: dueAt(ctx, store.control(ctx)!, candidates(ctx, store.control(ctx)!)), error };
            }
          } else {
            const parsed = await parseBlingResponse(String(unit.plan.target_resource_key ?? unit.resource_key), String(unit.plan.path), result.bytes, catalog);
            ctx = await revalidate(ctx, unit, deadline);
            if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
            await commit(ctx, unit, chosen.resource, parsed, result.bytes, deadline);
          }
        }
        const current = enabled(ctx);
        return { worked: true, requests, nextWake: current ? dueAt(ctx, current, candidates(ctx, current)) : null };
      } catch (cause) {
        const error = cause instanceof BlingError ? cause : fail();
        const retryAt = error.retry_at ?? collectionBackoff(unit?.kind ?? "list", 503, Number(unit?.progress.failures ?? 0) + 1, ctx.clock.now(), unit?.command_id);
        if (unit?.lease) {
          // Uma resposta do commit pode se perder. Recibo precede qualquer nova tentativa.
          const receipt = store.receipt(ctx, { command_id: unit.command_id, request_hash: unit.request_hash, generation: unit.expected.generation });
          if (receipt) return { worked: true, requests, nextWake: ctx.clock.now() + 700 };
          if (error.code === "BLING_REVISION_CONFLICT") {
            try { store.supersede(ctx, unit); } catch {
              const current = enabled(ctx);
              if (current) store.retireObsolete(ctx, stateExpected(current, ctx.identity.partsControl!.revision));
            }
            return { worked: true, requests, nextWake: ctx.clock.now() + 700, error: error.toJSON() };
          }
          try { store.reschedule(ctx, { unit, not_before: retryAt, error: new BlingError(error.code, { retry_at: retryAt }).toJSON(), blocked: ["BLING_CAPACITY_STOP", "BLING_SCOPE_REQUIRED", "BLING_RESOURCE_UNCONFIRMED"].includes(error.code) }); } catch { /* revisão/geração invalidada não pode ser ressuscitada */ }
        }
        const current = enabled(ctx);
        return { worked: !!unit, requests, nextWake: current ? dueAt(ctx, current, candidates(ctx, current)) ?? retryAt : null, error: new BlingError(error.code, { retry_at: retryAt }).toJSON() };
      }
    },
  };
}
