import { all, one } from "../../../db";
import { canonical, hash } from "../../../integrations/keys";
import { ApiError, now } from "../../../types";
import type { ModuleContext } from "../../api";
import type { CustomWorkType, FieldIndexRebuildRequest, FieldIndexState, FieldRef, ServiceObjectSnapshot, WorkField } from "../contracts";
import { atomic } from "../mutations";
import type { OrderFieldIndexInput } from "../os2-ports";
import type { ChildStatement, WorkOrderRow } from "../public";
import { validateExtra } from "../validation";
import { resolveWorkFields, snapshotType } from "../work-types";

export interface IndexValue {
  kind: WorkField["kind"];
  text: string | null;
  number: number | null;
}
export interface IndexedFieldDefinition {
  ref: FieldRef;
  key: string;
  field: WorkField;
  signature: string;
}
export interface FieldIndexDefinition {
  profile_id: string;
  type: CustomWorkType;
  object_type_revision?: number;
  generation: string;
  fields: IndexedFieldDefinition[];
}
export interface OrderFieldProjection {
  values: Array<{ field_key: string; value: IndexValue }>;
  /** Número de referências incompatíveis, não de valores opcionais ausentes. */
  excluded_count: number;
}

const invalid = () => new ApiError(400, "invalid_fields", "Filtro inválido. Escolha um dos campos publicados para este modelo.");
const conflict = () => new ApiError(409, "version_conflict", "A construção do índice mudou. Atualize o progresso antes de continuar.");
export const fieldKey = (ref: FieldRef): string => `${ref.scope}:${ref.field_id}`;

/** Rótulos, ajuda, revisão e obrigatoriedade não mudam a interpretação do índice. */
export function indexFieldSignature(field: WorkField): string {
  const common = { kind: field.kind, sensitive: field.sensitive, client_visible: field.client_visible };
  switch (field.kind) {
    case "text": return canonical({ ...common, multiline: field.multiline, max_length: field.max_length });
    case "choice": return canonical({ ...common, options: field.options.map(option => option.id).sort() });
    case "decimal": return canonical({ ...common, min: field.min, max: field.max, scale: field.scale });
    case "integer": case "date": return canonical({ ...common, min: field.min, max: field.max });
    case "boolean": return canonical(common);
  }
}

/** Somente configuração; não lê estado/projeções nem procura o cadastro do objeto. */
export async function publishedFieldIndex(ctx: ModuleContext, typeId: string): Promise<FieldIndexDefinition> {
  const settings = await ctx.settings();
  const type: CustomWorkType | undefined = settings.os_work_types?.find((entry: CustomWorkType) => entry.id === typeId);
  if (!type || type.kind !== "custom") throw new ApiError(404, "not_found", "Modelo não encontrado.");
  const objectType = settings.os_object_types?.find((entry: { id: string }) => entry.id === type.object_type_id);
  const resolved = resolveWorkFields(type, objectType);
  const filters = type.list_fields?.filter(rule => rule.filter) ?? [];
  if (filters.length > 4) throw invalid();
  const keys = new Set<string>();
  const fields = filters.map(rule => {
    const key = fieldKey(rule.ref);
    const field = resolved[rule.ref.scope]?.find(entry => entry.id === rule.ref.field_id);
    if (!field || field.sensitive || keys.has(key) || (field.kind === "text" && (field.multiline || field.max_length > 240))) throw invalid();
    keys.add(key);
    return { ref: { ...rule.ref }, key, field, signature: indexFieldSignature(field) };
  }).sort((a, b) => a.key.localeCompare(b.key, "en"));
  const generation = hash({ schema_version: 1, fields: fields.map(entry => ({
    ref: entry.ref, signature: entry.signature,
    ...(entry.ref.scope === "object" ? { object_type_id: type.object_type_id } : {}),
  })) });
  return { profile_id: ctx.profile, type, generation, fields,
    ...(fields.some(entry => entry.ref.scope === "object") ? { object_type_revision: objectType.revision as number } : {}) };
}
export const resolveFieldIndexDefinition = publishedFieldIndex;

/** Usa a validação do motor; zero e false têm representações indexadas próprias. */
export function normalizeIndexValue(field: WorkField, value: unknown): IndexValue | null {
  if (field.sensitive) throw invalid();
  if (value === undefined || value === null) return null;
  const normalized = validateExtra([field], { [field.id]: value }, { partial: true })[field.id];
  if (normalized === null || normalized === "") return null;
  switch (field.kind) {
    case "text":
      if (field.multiline || field.max_length > 240 || /[\r\n]/.test(String(normalized))) throw invalid();
      return { kind: field.kind, text: String(normalized).trim().normalize("NFC").toLowerCase().normalize("NFC"), number: null };
    case "choice": case "date": return { kind: field.kind, text: String(normalized), number: null };
    case "boolean": return { kind: field.kind, text: null, number: normalized === true ? 1 : 0 };
    case "integer": case "decimal": return { kind: field.kind, text: null, number: Number(normalized) };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/** Histórico interpretado pelo próprio snapshot, nunca pela ficha atual do objeto. */
export function projectOrderFields(row: WorkOrderRow, definition: FieldIndexDefinition): OrderFieldProjection {
  const out: OrderFieldProjection = { values: [], excluded_count: 0 };
  if (row.profile_id !== definition.profile_id) return { values: [], excluded_count: definition.fields.length };
  let type: CustomWorkType | null = null;
  let values: Record<string, unknown> = {};
  let object: ServiceObjectSnapshot | null = null;
  try { type = snapshotType(row); values = record(JSON.parse(row.extra_json ?? "{}")); } catch { /* Excluído abaixo. */ }
  try {
    const captured = JSON.parse(row.object_snapshot_json ?? "null") as ServiceObjectSnapshot | null;
    if (captured?.schema_version === 1 && captured.object_id === row.object_id && captured.type?.id === definition.type.object_type_id)
      object = captured;
  } catch { /* Um snapshot inválido nunca vira índice público. */ }
  for (const entry of definition.fields) {
    const fields = entry.ref.scope === "order" ? type?.fields : object?.type.fields;
    const field = fields?.find(candidate => candidate.id === entry.ref.field_id);
    if (!type || type.id !== definition.type.id || !field || field.sensitive || indexFieldSignature(field) !== entry.signature) {
      out.excluded_count++;
      continue;
    }
    try {
      const source = entry.ref.scope === "order" ? values : record(object!.values);
      const value = normalizeIndexValue(field, source[field.id]);
      if (value) out.values.push({ field_key: entry.key, value });
    } catch { out.excluded_count++; }
  }
  return out;
}

/** A guarda permite ao rebuild ignorar uma leitura ultrapassada por uma mutação. */
function projectionStatements(ctx: ModuleContext, row: WorkOrderRow, definition: FieldIndexDefinition, projection: OrderFieldProjection): ChildStatement[] {
  const guard = "EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND id=? AND type_id=? AND row_version=?)";
  const scope = [ctx.profile, row.id, definition.type.id, row.row_version ?? 1];
  const statements: ChildStatement[] = [[
    `DELETE FROM os_order_field_index WHERE profile_id=? AND order_id=? AND generation=? AND ${guard}`,
    [ctx.profile, row.id, definition.generation, ...scope],
  ]];
  for (const entry of projection.values) statements.push([
    `INSERT INTO os_order_field_index(profile_id,type_id,generation,field_key,value_kind,value_text,value_number,order_id,order_number,order_version)
      SELECT profile_id,type_id,?,?,?,?,?,id,number,row_version FROM os_orders
      WHERE profile_id=? AND id=? AND type_id=? AND row_version=?
      ON CONFLICT(profile_id,type_id,generation,field_key,order_id) DO UPDATE SET
        value_kind=excluded.value_kind,value_text=excluded.value_text,value_number=excluded.value_number,
        order_number=excluded.order_number,order_version=excluded.order_version`,
    [definition.generation, entry.field_key, entry.value.kind, entry.value.text, entry.value.number, ...scope],
  ]);
  return statements;
}

/** O alarme e comandos podem observar caches distintos. A revisão é conferida
 * dentro do batch; uma configuração publicada no intervalo reverte o pai e o
 * índice juntos. O JSON percorrido aqui é só a configuração limitada da área. */
function configurationGuard(ctx: ModuleContext, definition: FieldIndexDefinition): ChildStatement {
  const object = definition.object_type_revision !== undefined;
  return [
    `SELECT CASE WHEN EXISTS(SELECT 1 FROM profiles p WHERE p.id=?
      AND EXISTS(SELECT 1 FROM json_each(p.settings,'$.os_work_types') t
        WHERE json_extract(t.value,'$.id')=? AND json_extract(t.value,'$.revision')=?)
      ${object ? `AND EXISTS(SELECT 1 FROM json_each(p.settings,'$.os_object_types') o
        WHERE json_extract(o.value,'$.id')=? AND json_extract(o.value,'$.revision')=?)` : ""})
      THEN 1 ELSE json('os_version_conflict') END`,
    [ctx.profile, definition.type.id, definition.type.revision,
      ...(object ? [definition.type.object_type_id, definition.object_type_revision] : [])],
  ];
}

/** Integra o batch do pai: não confirma nada e não inicializa reconstrução. */
export async function planOrderFieldIndex(ctx: ModuleContext, input: OrderFieldIndexInput): Promise<ChildStatement[]> {
  if (input.type.kind === "builtin") return [];
  if (input.row.profile_id !== ctx.profile || input.row.type_id !== input.type.id) throw new ApiError(404, "not_found", "Ordem não encontrada.");
  let definition: FieldIndexDefinition;
  try { definition = await publishedFieldIndex(ctx, input.type.id); }
  catch (error) {
    // Snapshots históricos continuam editáveis mesmo quando a configuração
    // importada já não contém aquele modelo. Não há filtro atual a manter.
    if (error instanceof ApiError && error.code === "not_found") return [];
    throw error;
  }
  if (!definition.fields.length) return [];
  return [configurationGuard(ctx, definition), ...projectionStatements(ctx, input.row, definition, projectOrderFields(input.row, definition))];
}

async function persistedState(ctx: ModuleContext, typeId: string): Promise<FieldIndexState | null> {
  return one<FieldIndexState>(ctx.env,
    "SELECT type_id,generation,status,cursor_number,ceiling_number,excluded_count,updated FROM os_field_index_state WHERE profile_id=? AND type_id=?",
    ctx.profile, typeId);
}

/** GET apenas observa. Uma configuração ainda não construída aparece incompleta. */
export async function readFieldIndexState(ctx: ModuleContext, typeId: string, definition?: FieldIndexDefinition): Promise<FieldIndexState> {
  const current = definition ?? await publishedFieldIndex(ctx, typeId);
  const state = await persistedState(ctx, typeId);
  return state?.generation === current.generation ? state : {
    type_id: typeId, generation: current.generation, status: "building",
    cursor_number: 0, ceiling_number: 0, excluded_count: 0, updated: 0,
  };
}

/** Comando explícito e retomável: inicializa OU processa no máximo cinco ordens. */
export async function rebuildFieldIndex(ctx: ModuleContext, typeId: string, request: FieldIndexRebuildRequest = {}): Promise<FieldIndexState> {
  const definition = await publishedFieldIndex(ctx, typeId);
  if (!definition.fields.length) throw invalid();
  if ((request.generation !== undefined && request.generation !== definition.generation) ||
    (request.cursor_number !== undefined && (!Number.isSafeInteger(request.cursor_number) || request.cursor_number < 0))) throw conflict();
  const state = await persistedState(ctx, typeId);
  if (!state || state.generation !== definition.generation) {
    if (request.cursor_number !== undefined && request.cursor_number !== 0) throw conflict();
    await atomic(ctx, [configurationGuard(ctx, definition), [
      `WITH ceiling AS (SELECT COALESCE((SELECT number FROM os_orders INDEXED BY os_orders_type_list
         WHERE profile_id=? AND type_id=? ORDER BY number DESC LIMIT 1),0) n)
       INSERT INTO os_field_index_state(profile_id,type_id,generation,status,cursor_number,ceiling_number,excluded_count,updated)
       SELECT ?,?,?,CASE WHEN n=0 THEN 'ready' ELSE 'building' END,0,n,0,? FROM ceiling WHERE true
       ON CONFLICT(profile_id,type_id) DO UPDATE SET generation=excluded.generation,status=excluded.status,
         cursor_number=0,ceiling_number=excluded.ceiling_number,excluded_count=0,updated=excluded.updated
       WHERE os_field_index_state.generation<>excluded.generation`,
      [ctx.profile, typeId, ctx.profile, typeId, definition.generation, now()],
    ]]);
    return (await persistedState(ctx, typeId))!;
  }
  // A repetição da inicialização não consome o próximo lote. Cada avanço traz
  // a posição que o administrador efetivamente observou na resposta anterior.
  if (request.generation === undefined && request.cursor_number === undefined) return state;
  if (request.generation === undefined || request.cursor_number === undefined || request.cursor_number > state.cursor_number) throw conflict();
  if (request.cursor_number < state.cursor_number || state.status === "ready") return state;
  const rows = await all<WorkOrderRow>(ctx.env,
    `SELECT * FROM os_orders INDEXED BY os_orders_type_list WHERE profile_id=? AND type_id=? AND number>? AND number<=? ORDER BY number ASC LIMIT 5`,
    ctx.profile, typeId, state.cursor_number, state.ceiling_number);
  const statements: ChildStatement[] = [configurationGuard(ctx, definition), [
    `SELECT CASE WHEN EXISTS(SELECT 1 FROM os_field_index_state WHERE profile_id=? AND type_id=? AND generation=?
      AND status='building' AND cursor_number=? AND ceiling_number=?) THEN 1 ELSE json('os_version_conflict') END`,
    [ctx.profile, typeId, definition.generation, state.cursor_number, state.ceiling_number],
  ]];
  const exclusionTerms: string[] = [];
  const exclusionBindings: unknown[] = [];
  for (const row of rows) {
    const projection = projectOrderFields(row, definition);
    statements.push(...projectionStatements(ctx, row, definition, projection));
    if (projection.excluded_count) {
      exclusionTerms.push("CASE WHEN EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND id=? AND row_version=?) THEN ? ELSE 0 END");
      exclusionBindings.push(ctx.profile, row.id, row.row_version ?? 1, projection.excluded_count);
    }
  }
  const cursor = rows.length < 5 ? state.ceiling_number : rows[rows.length - 1].number;
  statements.push([
    `UPDATE os_field_index_state SET cursor_number=?,status=?,excluded_count=excluded_count+(${exclusionTerms.join("+") || "0"}),updated=?
      WHERE profile_id=? AND type_id=? AND generation=? AND cursor_number=?`,
    [cursor, cursor >= state.ceiling_number ? "ready" : "building", ...exclusionBindings, now(), ctx.profile, typeId, definition.generation, state.cursor_number],
  ]);
  try { await atomic(ctx, statements); }
  catch (error) {
    // Dois comandos podem ter lido o mesmo cursor antes do CAS. O perdedor
    // reautoriza na camada de comando e observa o lote já confirmado, sem
    // repetir inserções nem somar exclusões outra vez.
    if (error instanceof ApiError && error.code === "version_conflict") {
      const winner = await persistedState(ctx, typeId);
      if (winner?.generation === definition.generation && winner.cursor_number > state.cursor_number) return winner;
    }
    throw error;
  }
  return (await persistedState(ctx, typeId))!;
}
