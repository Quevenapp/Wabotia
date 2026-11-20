import { all } from "../../../db";
import { hash } from "../../../integrations/keys";
import { seal, unseal } from "../../../security";
import { ApiError, type Actor } from "../../../types";
import { isBound } from "../../../visibility";
import type { ModuleContext } from "../../api";
import type { Order, OrderFieldFilter } from "../contracts";
import { isStatus, phoneDigits } from "../model";
import { projectObjectPage, type FilteredOrderPage } from "../os2-ports";
import { customerProjection, mayReadSensitive } from "../privacy";
import { workCustomerScope, type ChildStatement, type WorkOrderRow } from "../public";
import { orderView, visibleOrder } from "../store";
import { snapshotType } from "../work-types";
import { fieldKey, normalizeIndexValue, projectOrderFields, publishedFieldIndex, readFieldIndexState,
  type IndexedFieldDefinition } from "./index-store";

const invalid = (message = "Filtro de campo inválido. Selecione um campo e uma igualdade ou intervalo permitido."): never => {
  throw new ApiError(400, "invalid_fields", message);
};
const invalidCursor = (): never => { throw new ApiError(400, "invalid_cursor", "Cursor inválido para este filtro. Reinicie a lista."); };
interface Filter { field: IndexedFieldDefinition; operator: "eq" | "range"; from: string | number; to: string | number }
export interface FieldCandidate { order_id: string; order_number: number; value: string | number }

function filterValue(field: IndexedFieldDefinition, value: unknown): string | number {
  try {
    const normalized = normalizeIndexValue(field.field, value);
    if (!normalized) return invalid("Informe um valor; filtros de ausência não estão disponíveis.");
    return normalized.text ?? normalized.number!;
  } catch { return invalid(); }
}
function parseFilter(raw: string, fields: IndexedFieldDefinition[]): Filter {
  if (raw.length > 2048) return invalid();
  let input: OrderFieldFilter;
  try { input = JSON.parse(raw); } catch { return invalid(); }
  if (!input || typeof input !== "object" || Array.isArray(input) || !input.ref ||
      !["order", "object"].includes(input.ref.scope) || typeof input.ref.field_id !== "string" ||
      Object.keys(input.ref).some(key => !["scope", "field_id"].includes(key))) return invalid();
  const field = fields.find(entry => entry.key === fieldKey(input.ref));
  if (!field || field.field.sensitive) return invalid();
  if (input.operator === "eq" && !Object.keys(input).some(key => !["ref", "operator", "value"].includes(key))) {
    const value = filterValue(field, input.value);
    return { field, operator: "eq", from: value, to: value };
  }
  if (input.operator === "range" && ["date", "integer", "decimal"].includes(field.field.kind) &&
      !Object.keys(input).some(key => !["ref", "operator", "from", "to"].includes(key))) {
    const from = filterValue(field, input.from), to = filterValue(field, input.to);
    if (from > to) return invalid("O início do intervalo deve ser menor ou igual ao fim.");
    return { field, operator: "range", from, to };
  }
  return invalid();
}

/** Cada ramo procura diretamente no índice tipado, inclusive em páginas tardias.
 * UNION ALL ordenado permite ao SQLite intercalar os dois percursos do índice
 * até o limite global, sem materializar lotes nem varrer o prefixo já consumido. */
export function fieldCandidateStatement(profile: string, typeId: string, generation: string, filter: Filter, after?: FieldCandidate): ChildStatement {
  const numeric = typeof filter.from === "number";
  const column = numeric ? "value_number" : "value_text";
  const index = numeric ? "os_order_field_number" : "os_order_field_text";
  const source = `FROM os_order_field_index INDEXED BY ${index}
    WHERE profile_id=? AND type_id=? AND generation=? AND field_key=? AND ${column} IS NOT NULL`;
  const prefix = [profile, typeId, generation, filter.field.key];
  const select = `SELECT order_id,order_number,${column} AS value ${source}`;
  if (filter.operator === "eq") return [
    `${select} AND ${column}=?${after ? " AND (order_number,order_id)<(?,?)" : ""}
      ORDER BY order_number DESC,order_id DESC LIMIT 200`,
    [...prefix, filter.from, ...(after ? [after.order_number, after.order_id] : [])],
  ];
  if (!after) return [
    `${select} AND ${column}>=? AND ${column}<=? ORDER BY ${column},order_number DESC,order_id DESC LIMIT 200`,
    [...prefix, filter.from, filter.to],
  ];
  return [
    `${select} AND ${column}=? AND (order_number,order_id)<(?,?)
      UNION ALL
      ${select} AND ${column}>? AND ${column}<=?
      ORDER BY value,order_number DESC,order_id DESC LIMIT 200`,
    [...prefix, after.value, after.order_number, after.order_id, ...prefix, after.value, filter.to],
  ];
}

function commonFilters(query: Record<string, string>, actor: Actor, mayContact: boolean) {
  const where: string[] = [], args: unknown[] = [];
  if (query.type_ids) {
    const ids = [...new Set(query.type_ids.split(","))];
    if (ids.length > 21 || ids.some(id => !/^[a-z][a-z0-9_]{0,63}$/.test(id))) invalid();
    if (!ids.includes(query.type_id)) where.push("0");
  }
  if (query.stage) { where.push("COALESCE(stage,status)=?"); args.push(query.stage); }
  if (query.assignee) {
    where.push(query.assignee === "unassigned" ? "assignee IS NULL" : "assignee=?");
    if (query.assignee !== "unassigned") args.push(query.assignee === "me" ? actor.id : query.assignee);
  }
  for (const [key, comparison] of [["due_from", ">="], ["due_to", "<="]] as const) if (query[key]) {
    const at = Number(query[key]);
    if (!Number.isSafeInteger(at) || at < 0) invalid("Prazo inválido; use milissegundos Unix.");
    where.push(`due_at${comparison}?`); args.push(at);
  }
  if (query.due_from && query.due_to && Number(query.due_from) > Number(query.due_to)) invalid("Intervalo de prazo inválido.");
  const statuses = [...new Set((query.status || "").split(",").filter(Boolean))];
  if (statuses.some(status => !isStatus(status))) invalid("Estado desconhecido no filtro.");
  if (statuses.length) { where.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
  else if (query.open === "1") where.push("status NOT IN ('delivered','cancelled')");
  if (query.conversation_id) { where.push("conversation_id=?"); args.push(query.conversation_id); }
  if (query.phone) {
    if (!mayContact) throw new ApiError(403, "forbidden", "Sem permissão para consultar dados de contato.");
    where.push("phone=?"); args.push(phoneDigits(query.phone));
  }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like = "%" + q.toLowerCase().replace(/[%_\\]/g, match => "\\" + match) + "%";
    const parts = ["lower(item) LIKE ? ESCAPE '\\'", "lower(problem) LIKE ? ESCAPE '\\'"];
    args.push(like, like);
    if (mayContact) { parts.push("lower(customer_name) LIKE ? ESCAPE '\\'"); args.push(like); }
    const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    if (digits) { parts.push("number=?"); args.push(Number(digits)); }
    if (digits.length >= 4 && mayContact) { parts.push("phone LIKE ?"); args.push("%" + digits + "%"); }
    where.push(`(${parts.join(" OR ")})`);
  }
  return { where, args };
}

/** Opt-in exclusivo de field_filter; a lista comum e suas colunas não passam aqui. */
export async function queryOrdersByField(ctx: ModuleContext, query: Record<string, string>, actor: Actor): Promise<FilteredOrderPage> {
  ctx.access(actor, "conversations:read");
  await ctx.requireEnabled();
  if (actor.credential) throw new ApiError(404, "not_found", "Lista de ordens não encontrada.");
  const allowed = ["type_id", "type_ids", "field_filter", "stage", "assignee", "due_from", "due_to", "status", "open", "conversation_id", "phone", "q", "limit", "cursor", "facets"];
  if (Object.keys(query).some(key => !allowed.includes(key)) || !query.type_id || !query.field_filter) invalid();
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid("Use uma página entre 1 e 50 ordens.");
  const definition = await publishedFieldIndex(ctx, query.type_id);
  const filter = parseFilter(query.field_filter, definition.fields);
  const ai = !!actor.via || actor.id.startsWith("bot:") || !!actor.module;
  const policy = (await ctx.settings()).os2_ai_access;
  const bound = isBound(actor);
  const internal = !bound && (!ai || !!(policy?.enabled && policy.internal));
  if (ai && !bound && !policy?.enabled) throw new ApiError(403, "forbidden", "O administrador precisa habilitar o acesso da IA a estes dados.");
  if (!filter.field.field.client_visible && !internal) throw new ApiError(403, "forbidden", "Este campo não está disponível para consulta.");
  const mayContact = ctx.mayRead(actor, "contacts");
  if (filter.field.ref.scope === "object" && !mayContact) throw new ApiError(403, "forbidden", "Sem permissão para consultar objetos do cliente.");
  const common = commonFilters(query, actor, mayContact);
  let customerScope: Awaited<ReturnType<typeof workCustomerScope>> | undefined;
  if (bound) {
    if (!query.conversation_id) throw new ApiError(404, "not_found", "Conversa não encontrada.");
    customerScope = await workCustomerScope(ctx, await ctx.conversation(query.conversation_id, actor));
    // A operação nova de filtro usa o titular canônico comprovado. Não tenta
    // reconstruir propriedade por telefone/histórico para cada candidato.
    if (!customerScope.contactId || customerScope.sql === "0") common.where.push("0");
    else { common.where.push("os_orders.contact_id=?"); common.args.push(customerScope.contactId); }
  }
  // Um vínculo exige a mesma autorização de contato, calculada só para os IDs candidatos.
  common.where.push(mayContact ? `(object_id IS NULL OR EXISTS(SELECT 1 FROM contacts c
    WHERE c.profile_id=os_orders.profile_id AND c.id=os_orders.contact_id AND c.namespace='team' AND c.identity_state='active'))` : "object_id IS NULL");
  const binding = hash({ kind: "os.field-filter.v1", profile: ctx.profile,
    actor: JSON.parse(JSON.stringify(actor)), contacts: mayContact, notes: ctx.mayRead(actor, "notes"),
    internal, customer: customerScope?.contactId ?? null, type: definition.type.id, generation: definition.generation,
    filter: { key: filter.field.key, operator: filter.operator, from: filter.from, to: filter.to },
    common: Object.fromEntries(Object.entries(query).filter(([key]) => !["cursor", "limit", "field_filter", "facets"].includes(key))) });
  let after: FieldCandidate | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 32000) invalidCursor();
      const cursor = await unseal(ctx.env, atob(query.cursor));
      if (cursor.binding !== binding || !cursor.after || typeof cursor.after.order_id !== "string" ||
          !cursor.after.order_id || cursor.after.order_id.length > 128 || !Number.isSafeInteger(cursor.after.order_number) || cursor.after.order_number < 1 ||
          typeof cursor.after.value !== typeof filter.from || cursor.after.value < filter.from || cursor.after.value > filter.to) invalidCursor();
      after = cursor.after;
    } catch { invalidCursor(); }
  }
  const state = await readFieldIndexState(ctx, definition.type.id, definition);
  if (state.generation !== definition.generation || state.status !== "ready")
    throw new ApiError(409, "field_index_building", "O índice está sendo construído. Retome a construção para usar este filtro.");
  const [sql, params] = fieldCandidateStatement(ctx.profile, definition.type.id, state.generation, filter, after);
  const candidates = await all<FieldCandidate>(ctx.env, sql, ...params);
  // json_each contém no máximo 200 IDs. CROSS JOIN fixa a ordem dos loops e
  // o índice composto impede que SQLite escolha uma varredura do modelo inteiro.
  const rows = candidates.length ? await all<WorkOrderRow>(ctx.env, `SELECT os_orders.*,1 AS os2_contact_active
    FROM json_each(?) candidate CROSS JOIN os_orders INDEXED BY os_orders_profile_id
    WHERE os_orders.profile_id=? AND os_orders.id=candidate.value AND os_orders.type_id=?
    ${common.where.length ? "AND " + common.where.join(" AND ") : ""}`,
    JSON.stringify(candidates.map(candidate => candidate.order_id)), ctx.profile, definition.type.id, ...common.args) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const page: WorkOrderRow[] = [];
  let consumed = 0;
  for (const candidate of candidates) {
    consumed++;
    const row = byId.get(candidate.order_id);
    if (!row) continue;
    // Uma escrita pode ocorrer entre as duas leituras: não devolver um valor
    // que já deixou de satisfazer o filtro, nem reinterpretar snapshot antigo.
    const projected = projectOrderFields(row, definition).values.find(value => value.field_key === filter.field.key)?.value;
    const value = projected?.text ?? projected?.number;
    if (value === undefined || value === null || value !== candidate.value || value < filter.from || value > filter.to) continue;
    page.push(row);
    if (page.length === limit) break;
  }
  const customTasks = page.filter(row => snapshotType(row)?.features.tasks);
  const sensitive = customTasks.length > 0 && await mayReadSensitive(ctx, actor);
  const tasks = customTasks.length ? await all(ctx.env, `SELECT order_id,id,title,due_at FROM (
    SELECT order_id,id,title,due_at,row_number() OVER (PARTITION BY order_id ORDER BY due_at IS NULL,due_at,id) AS position
    FROM os_tasks WHERE profile_id=? AND order_id IN (SELECT value FROM json_each(?)) AND state='open' AND archived_at IS NULL
    ${sensitive ? "" : "AND sensitive=0"} ${internal ? "" : "AND client_visible=1"}) WHERE position=1`,
    ctx.profile, JSON.stringify(customTasks.map(row => row.id))) : [];
  const nextTasks = new Map(tasks.map(task => [task.order_id, { id: task.id, title: task.title, due_at: task.due_at }]));
  const objects = page.some(row => row.object_id) ? await projectObjectPage(ctx, actor, page) : new Map();
  const data: Order[] = page.map(row => {
    const original = orderView(row);
    let view = visibleOrder(ctx, actor, original) as Order;
    if (!internal) view = customerProjection(view);
    else { view.fields = original.fields; view.extra = original.extra; }
    if (row.object_id) {
      const object = objects.get(row.id);
      if (object) view.object = object; else delete view.object;
    }
    if (internal) view.next_task = nextTasks.get(row.id) ?? null;
    return view;
  });
  const last = candidates[consumed - 1];
  const more = consumed < candidates.length || candidates.length === 200;
  return { data, counts: null, counts_scope: "not_computed", order_by: filter.operator === "eq" ? "number_desc" : "field_value_asc",
    next_cursor: more && last ? btoa(await seal(ctx.env, { binding, after: last })) : null };
}
