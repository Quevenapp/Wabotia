import { all, one } from "../../../db";
import { ApiError, now, requireValue, type Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { Entry, MutationRef, Page } from "../contracts";
import { authorizedOrder, commitChild, type AuthorizedOrder, type ChildStatement } from "../public";
import { mayReadSensitive, projectChildForBot, projectChildForCustomer, projectChildForStaff } from "../privacy";
import {
  ENTRY_FIELDS, ENTRY_LIMIT, decodeCursor, encodeCursor, entryFilters,
  entryId, entryInput, entryVersion, objectInput, onlyFields,
} from "./model";

type EntryRow = Omit<Entry, "client_visible" | "sensitive"> & {
  client_visible: number;
  sensitive: number;
};
const COLUMNS = "id,order_id,kind,text,quantity_milli,unit,occurred_at,replaces_id,client_visible,sensitive,version,created_by,created,updated,archived_at";
const botActor = (actor: Actor) => !!actor.via || !!actor.module || actor.id.startsWith("bot:");

function dto(row: EntryRow): Entry {
  // Lista explícita: nunca serializar a linha SQL ou a definição do pai.
  return {
    id: row.id, order_id: row.order_id, version: row.version,
    kind: row.kind, text: row.text, quantity_milli: row.quantity_milli,
    unit: row.unit, occurred_at: row.occurred_at, replaces_id: row.replaces_id,
    client_visible: row.client_visible === 1, sensitive: row.sensitive === 1,
    created_by: row.created_by, created: row.created, updated: row.updated,
    archived_at: row.archived_at,
  };
}

async function parent(
  ctx: ModuleContext, actor: Actor, id: string, write = false, conversationId?: string,
): Promise<AuthorizedOrder> {
  const order = await authorizedOrder(ctx, actor, entryId(id), {
    write, ...(conversationId === undefined ? {} : { conversation_id: entryId(conversationId) }),
  });
  if (!order.type.features.entries)
    throw new ApiError(409, "feature_disabled", "Lançamentos desativados neste tipo de trabalho.");
  return order;
}

async function visibleWhere(
  ctx: ModuleContext, actor: Actor, id: string, query: Record<string, string>, conversationId?: string,
) {
  const order = await parent(ctx, actor, id, false, conversationId);
  const customer = conversationId !== undefined;
  const filters = entryFilters(query, customer);
  const publicOnly = customer || botActor(actor);
  const sensitive = !publicOnly && await mayReadSensitive(ctx, actor);
  const clauses = ["profile_id=?", "order_id=?"];
  const bindings: unknown[] = [ctx.profile, order.row.id];
  if (!filters.include_archived) clauses.push("archived_at IS NULL");
  if (filters.kind !== null) { clauses.push("kind=?"); bindings.push(filters.kind); }
  // Filtrar antes de paginar/agregar: ocultos não influenciam cursor ou totais.
  if (!sensitive) clauses.push("sensitive=0");
  if (publicOnly) clauses.push("client_visible=1");
  const scope = JSON.stringify([ctx.profile, order.row.id, "entries", filters.kind,
    filters.include_archived, customer ? "customer" : publicOnly ? "bot" : "staff",
    sensitive, conversationId ?? null]);
  return { clauses, bindings, scope, filters, customer, publicOnly };
}

export async function listEntries(
  ctx: ModuleContext, actor: Actor, id: string, query: Record<string, string> = {}, conversationId?: string,
): Promise<Page<Entry>> {
  const view = await visibleWhere(ctx, actor, id, query, conversationId);
  const cursor = decodeCursor(query.cursor, view.scope);
  if (cursor) {
    view.clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
    view.bindings.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = await all<EntryRow>(ctx.env,
    `SELECT ${COLUMNS} FROM os_entries WHERE ${view.clauses.join(" AND ")}
     ORDER BY occurred_at DESC,id DESC LIMIT ?`, ...view.bindings, view.filters.limit + 1);
  const selected = rows.slice(0, view.filters.limit);
  const projected = await Promise.all(selected.map((row) => {
    const entry = dto(row);
    if (view.customer) return projectChildForCustomer(entry);
    if (view.publicOnly) return projectChildForBot(entry);
    return projectChildForStaff(ctx, actor, entry);
  }));
  const last = selected.at(-1);
  return {
    data: projected.filter((entry): entry is Entry => entry !== null),
    next_cursor: rows.length > view.filters.limit && last
      ? encodeCursor(view.scope, last.occurred_at, last.id) : null,
  };
}

/** Soma exata em texto: 10.000 × 10^12 pode ultrapassar o inteiro seguro JS. */
export interface EntryTotal {
  kind: string;
  unit: string;
  count: number;
  quantity_milli: string | null;
}

export async function summarizeEntries(
  ctx: ModuleContext, actor: Actor, id: string, query: Record<string, string> = {},
): Promise<{ data: EntryTotal[] }> {
  const view = await visibleWhere(ctx, actor, id, query);
  if (Object.keys(query).some((key) => key !== "kind" && key !== "include_archived"))
    throw new ApiError(400, "invalid_filter", "Resumo aceita apenas kind e include_archived.");
  const data = await all<EntryTotal>(ctx.env,
    `SELECT kind,unit,COUNT(*) AS count,CAST(SUM(quantity_milli) AS TEXT) AS quantity_milli
     FROM os_entries WHERE ${view.clauses.join(" AND ")}
     GROUP BY kind,unit ORDER BY kind,unit`, ...view.bindings);
  return { data };
}

async function load(ctx: ModuleContext, orderId: string, id: string): Promise<EntryRow | null> {
  return one<EntryRow>(ctx.env,
    `SELECT ${COLUMNS} FROM os_entries WHERE profile_id=? AND order_id=? AND id=?`,
    ctx.profile, orderId, id);
}

async function writable(ctx: ModuleContext, actor: Actor, row: EntryRow) {
  if (row.sensitive && !(await mayReadSensitive(ctx, actor)))
    throw new ApiError(403, "sensitive_forbidden", "Acesso sensível não autorizado.");
  if (botActor(actor) && !row.client_visible)
    throw new ApiError(404, "not_found", "Lançamento não encontrado.");
}

async function capacity(ctx: ModuleContext, orderId: string) {
  const count = await one<{ total: number }>(ctx.env,
    "SELECT COUNT(*) AS total FROM os_entries WHERE profile_id=? AND order_id=?", ctx.profile, orderId);
  if ((count?.total ?? 0) >= ENTRY_LIMIT)
    throw new ApiError(409, "collection_limit", "Limite de lançamentos desta ordem atingido.");
}

async function mutationIdentity(ctx: ModuleContext, actor: Actor, orderId: string, op: string, requestId: string, target = "") {
  requireValue(typeof requestId === "string" && requestId.length > 0, "Idempotency-Key obrigatória.");
  const bytes = new TextEncoder().encode(JSON.stringify([ctx.profile, actor.kind, actor.id, orderId, op, target, requestId]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return { id: `entry_${hash}`, key: `os.entry.${op}:${hash}` };
}

function insertStatement(
  ctx: ModuleContext, actor: Actor, orderId: string, id: string,
  input: ReturnType<typeof entryInput>, timestamp: number, original?: EntryRow, version?: number,
): ChildStatement {
  // A primeira instrução é a criação do NOVO filho. O CAS do anterior faz
  // parte deste INSERT SELECT; commitChild deve abortar se afetar zero linhas.
  const predicates = [
    "EXISTS (SELECT 1 FROM os_orders WHERE profile_id=? AND id=?)",
    "(SELECT COUNT(*) FROM os_entries WHERE profile_id=? AND order_id=?) < ?",
  ];
  const guards: unknown[] = [ctx.profile, orderId, ctx.profile, orderId, ENTRY_LIMIT];
  if (original) {
    predicates.push(`EXISTS (SELECT 1 FROM os_entries WHERE profile_id=? AND order_id=?
      AND id=? AND version=? AND archived_at IS NULL)`);
    guards.push(ctx.profile, orderId, original.id, version);
    predicates.push("NOT EXISTS (SELECT 1 FROM os_entries WHERE profile_id=? AND order_id=? AND replaces_id=?)");
    guards.push(ctx.profile, orderId, original.id);
  }
  return [
    `INSERT INTO os_entries (profile_id,${COLUMNS})
     SELECT ?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,NULL WHERE ${predicates.join(" AND ")}`,
    [ctx.profile, id, orderId, input.kind, input.text, input.quantity_milli, input.unit,
      input.occurred_at, original?.id ?? null, Number(input.client_visible), Number(input.sensitive),
      actor.id, timestamp, timestamp, ...guards],
  ];
}

export async function createEntry(
  ctx: ModuleContext, actor: Actor, value: unknown, requestId: string,
): Promise<MutationRef> {
  return saveEntry(ctx, actor, value, requestId, false);
}

export async function reviseEntry(
  ctx: ModuleContext, actor: Actor, value: unknown, requestId: string,
): Promise<MutationRef> {
  return saveEntry(ctx, actor, value, requestId, true);
}

async function saveEntry(ctx: ModuleContext, actor: Actor, value: unknown, requestId: string, revision: boolean): Promise<MutationRef> {
  const data = objectInput(value);
  const order = await parent(ctx, actor, entryId(data.id), true);
  onlyFields(data, ["id", ...ENTRY_FIELDS, ...(revision ? ["entry_id", "version"] : [])]);
  const input = entryInput(data);
  if (input.sensitive && !(await mayReadSensitive(ctx, actor)))
    throw new ApiError(403, "sensitive_forbidden", "Acesso sensível não autorizado.");
  const target = revision ? entryId(data.entry_id) : "";
  const version = revision ? entryVersion(data.version) : undefined;
  const identity = await mutationIdentity(ctx, actor, order.row.id, revision ? "revise" : "create", requestId, target);
  const existing = await load(ctx, order.row.id, identity.id);
  if (existing) {
    await writable(ctx, actor, existing);
    if (existing.replaces_id !== (target || null) ||
        ENTRY_FIELDS.some((key) => dto(existing)[key] !== input[key]))
      throw new ApiError(409, "idempotency_conflict", "Chave já utilizada para outro lançamento.");
  }
  let original: EntryRow | undefined;
  if (revision) {
    original = await load(ctx, order.row.id, target) ?? undefined;
    if (!original) throw new ApiError(404, "not_found", "Lançamento não encontrado.");
    await writable(ctx, actor, original);
    if (original.sensitive && !input.sensitive)
      throw new ApiError(400, "invalid_entry", "Correção não pode reduzir o sigilo do lançamento.");
    if (!existing) {
      const replacement = await one(ctx.env,
        "SELECT id FROM os_entries WHERE profile_id=? AND order_id=? AND replaces_id=? LIMIT 1",
        ctx.profile, order.row.id, target);
      if (replacement) throw new ApiError(409, "entry_replaced", "Lançamento já corrigido.");
      if (original.version !== version || original.archived_at !== null)
        throw new ApiError(409, "version_conflict", "Lançamento alterado; atualize a consulta.");
    }
  }
  if (!existing) await capacity(ctx, order.row.id);
  const timestamp = existing?.created ?? now();
  const statements = [insertStatement(ctx, actor, order.row.id, identity.id, input, timestamp, original, version)];
  if (original) statements.push([
    `UPDATE os_entries SET archived_at=?,updated=?,version=version+1
     WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL
       AND EXISTS (SELECT 1 FROM os_entries WHERE profile_id=? AND order_id=? AND id=? AND replaces_id=?)`,
    [timestamp, timestamp, ctx.profile, order.row.id, original.id, version,
      ctx.profile, order.row.id, identity.id, original.id],
  ]);
  // Não devolver o replay aqui: M ainda precisa recuperar publicação pendente.
  return commitChild(ctx, actor, order, {
    entity_kind: "entry", id: identity.id, expected_version: null, mutation_key: identity.key,
    changed_fields: [...ENTRY_FIELDS, ...(revision ? ["replaces_id", "archived_at"] : [])],
    statements, event: revision ? "os.entry.revised" : "os.entry.created",
  });
}

export async function archiveEntry(ctx: ModuleContext, actor: Actor, value: unknown, requestId: string): Promise<MutationRef> {
  const data = objectInput(value);
  const order = await parent(ctx, actor, entryId(data.id), true);
  onlyFields(data, ["id", "entry_id", "version"]);
  const id = entryId(data.entry_id);
  const version = entryVersion(data.version);
  const row = await load(ctx, order.row.id, id);
  if (!row) throw new ApiError(404, "not_found", "Lançamento não encontrado.");
  await writable(ctx, actor, row);
  const identity = await mutationIdentity(ctx, actor, order.row.id, "archive", requestId, id);
  const timestamp = now();
  // CAS e replay pertencem a M. Não rejeitar previamente uma repetição confirmada.
  return commitChild(ctx, actor, order, {
    entity_kind: "entry", id, expected_version: version, mutation_key: identity.key,
    changed_fields: ["archived_at"], event: "os.entry.archived",
    statements: [[
      `UPDATE os_entries SET archived_at=?,updated=?,version=version+1
       WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL`,
      [timestamp, timestamp, ctx.profile, order.row.id, id, version],
    ]],
  });
}
