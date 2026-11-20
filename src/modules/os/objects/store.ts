import { all, batch, one } from "../../../db";
import { ApiError, now, uid, type Actor } from "../../../types";
import { hash } from "../../../integrations/keys";
import { isBound } from "../../../visibility";
import type { ModuleContext } from "../../api";
import type { ExtraValues, ObjectOpeningRequest, ServiceObjectSnapshot, ServiceObjectType, WorkTypeView } from "../contracts";
import type { ObjectAudience, ObjectContactMergeInput, ObjectContactMergePlan, ObjectOpeningContext, ObjectOpeningPlan, Os2CommandOperation } from "../os2-ports";
import { planOrderFieldIndex } from "../os2-ports";
import { authorizedOrder, resolveWorkType, type AuthorizedOrder, type ChildStatement, type WorkOrderRow } from "../public";
import { casGuard, checkVersion, versionConflict } from "../mutations";
import { resolveWorkFields } from "../work-types";
import { jsonBytes, validateObjectType, validateObjectValues } from "../validation";
import { authorizeObjectAccess, authorizeObjectContact, requireObjectPrivateAccess, resolveObjectConversationContact } from "./access";
import { projectObjectType, projectServiceObject } from "./projection";
import { OBJECT_LIMITS, type LegacyObjectLinkPreview, type ObjectMutationRef, type ObjectReceipt, type ObjectRow, type PreparedObject } from "./contracts";

const missing = () => new ApiError(404, "not_found", "Objeto ou cliente não encontrado ou não acessível.");
const invalid = () => new ApiError(400, "invalid_fields", "Informe somente os campos permitidos para esta operação.");
const definitionConflict = () => new ApiError(409, "object_definition_conflict", "A definição do objeto não é compatível. Revise o cadastro antes de continuar.");
const idempotencyConflict = () => new ApiError(409, "idempotency_conflict", "Esta chave já identifica outro comando. Use uma chave nova para outra alteração.");
const objectLimit = () => new ApiError(409, "object_limit", "O cliente atingiu o limite de 100 objetos ou 30 ativos deste tipo. Arquive um cadastro ativo ou revise a seleção.");
const actorKey = (actor: Actor) => hash([actor.kind, actor.id, actor.via?.bot_id ?? null, actor.module?.id ?? null, actor.credential?.id ?? null]);
const contactGuard = (profile: string, contact: string): ChildStatement => [
  "SELECT CASE WHEN EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active' AND merged_into IS NULL) THEN 1 ELSE json('os_version_conflict') END", [profile, contact],
];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  return value as Record<string, unknown>;
}
function only(data: Record<string, unknown>, keys: string[]) {
  if (Object.keys(data).some(key => !keys.includes(key))) throw invalid();
}
function stringId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value) throw invalid();
  return value;
}
function normalized(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [key, normalized(entry)]));
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw invalid();
}
export async function loadObject(ctx: ModuleContext, id: string): Promise<ObjectRow> {
  const row = await one<ObjectRow>(ctx.env, "SELECT * FROM os_objects WHERE profile_id=? AND id=?", ctx.profile, id);
  if (!row) throw missing();
  return row;
}
export function adoptedType(row: ObjectRow): ServiceObjectType {
  try {
    const type = validateObjectType(JSON.parse(row.type_snapshot_json));
    if (type.id !== row.type_id || type.revision !== row.type_revision) throw definitionConflict();
    return type;
  } catch { throw definitionConflict(); }
}
async function currentType(ctx: ModuleContext, id: string): Promise<ServiceObjectType> {
  const raw = (await ctx.settings()).os_object_types?.find((type: ServiceObjectType) => type.id === id);
  if (!raw) throw definitionConflict();
  const type = validateObjectType(raw);
  if (type.archived) throw new ApiError(409, "object_archived", "Este tipo de objeto está arquivado. Escolha um tipo ativo.");
  return type;
}
function valuesFor(type: ServiceObjectType, value: unknown, audience: ObjectAudience, previous?: ExtraValues, privateFields = false): ExtraValues {
  const input = record(value);
  const identifier = input[type.identifier_field_id] ?? previous?.[type.identifier_field_id];
  if (typeof identifier === "string" && /[\r\n\u2028\u2029]/.test(identifier)) throw invalid();
  const permitted = new Set(projectObjectType(type, audience).fields.map(field => field.id));
  for (const key of Object.keys(input)) {
    const field = type.fields.find(field => field.id === key);
    if (!field || (privateFields ? !field.sensitive : field.sensitive || !permitted.has(key))) throw invalid();
  }
  try { return validateObjectValues(type, input, { mode: privateFields ? "private" : audience.kind === "customer" ? "customer" : "staff", previous }); }
  catch (error) {
    if (error instanceof ApiError && (audience.kind === "customer" || (audience.kind === "bot" && !audience.ai_access?.internal)))
      throw new ApiError(error.status, error.code, "Os dados do objeto precisam ser revisados. Confira os campos disponíveis ou solicite ajuda à equipe.");
    throw error;
  }
}
async function checkLimits(ctx: ModuleContext, contact: string, type: string, adding: boolean) {
  const count = await one<{ total: number; active: number }>(ctx.env,
    "SELECT count(*) total,coalesce(sum(CASE WHEN type_id=? AND archived=0 THEN 1 ELSE 0 END),0) active FROM os_objects WHERE profile_id=? AND contact_id=?", type, ctx.profile, contact);
  if ((adding && (count?.total ?? 0) >= OBJECT_LIMITS.perContact) || (count?.active ?? 0) >= OBJECT_LIMITS.activePerType) throw objectLimit();
}
function limitGuard(profile: string, contact: string, type: string, adding: boolean): ChildStatement {
  return [`SELECT CASE WHEN ${adding ? "(SELECT count(*) FROM os_objects WHERE profile_id=? AND contact_id=?)<100 AND " : ""}
    (SELECT count(*) FROM os_objects WHERE profile_id=? AND contact_id=? AND type_id=? AND archived=0)<30
    THEN 1 ELSE json('os_object_limit') END`, [...(adding ? [profile, contact] : []), profile, contact, type]];
}
function history(row: ObjectRow, kind: string, changed: string[], key: string): ChildStatement {
  return ["INSERT INTO os_object_history(id,profile_id,object_id,object_version,kind,actor,changed_fields_json,created) VALUES(?,?,?,?,?,?,?,?)",
    [hash([key, row.id, row.row_version, kind]), row.profile_id, row.id, row.row_version, kind, row.updated_by, JSON.stringify(changed.sort()), row.updated]];
}
async function newObject(ctx: ModuleContext, contact: string, type: ServiceObjectType, values: ExtraValues, actor: string, at: number, key: string): Promise<PreparedObject> {
  await checkLimits(ctx, contact, type.id, true);
  const row: ObjectRow = { id: uid(), profile_id: ctx.profile, contact_id: contact, type_id: type.id, type_revision: type.revision,
    type_snapshot_json: JSON.stringify(type), values_json: JSON.stringify(values), archived: 0, row_version: 1, created_by: actor, updated_by: actor, created: at, updated: at };
  return { row, type, before: [contactGuard(ctx.profile, contact), limitGuard(ctx.profile, contact, type.id, true),
    ["INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,archived,row_version,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,0,1,?,?,?,?)",
      [row.id, ctx.profile, contact, type.id, type.revision, row.type_snapshot_json, row.values_json, actor, actor, at, at]], casGuard],
    after: [history(row, "os.object.created", Object.keys(values), key)] };
}
function receiptStatement(receipt: ObjectReceipt): ChildStatement {
  return ["INSERT INTO os2_receipts(profile_id,actor_key,operation,request_id,payload_hash,object_id,order_id,result_version,created) VALUES(?,?,?,?,?,?,?,?,?)",
    [receipt.profile_id, receipt.actor_key, receipt.operation, receipt.request_id, receipt.payload_hash, receipt.object_id, receipt.order_id, receipt.result_version, receipt.created]];
}
async function readReceipt(ctx: ModuleContext, key: string, operation: string, requestId: string, fingerprint: string) {
  const saved = await one<ObjectReceipt>(ctx.env, "SELECT * FROM os2_receipts WHERE profile_id=? AND actor_key=? AND operation=? AND request_id=?", ctx.profile, key, operation, requestId);
  if (saved && saved.payload_hash !== fingerprint) throw idempotencyConflict();
  return saved;
}
async function mutationRef(ctx: ModuleContext, receipt: ObjectReceipt): Promise<ObjectMutationRef> {
  const changed = receipt.operation === "os.objects.private.update" ? await one<{ changed_fields_json: string }>(ctx.env,
    "SELECT changed_fields_json FROM os_object_history WHERE profile_id=? AND id=?", ctx.profile,
    hash([`${receipt.actor_key}:${receipt.request_id}`, receipt.object_id, receipt.result_version, "os.object.private_fields_changed"])) : null;
  return { id: receipt.order_id ?? receipt.object_id!, version: receipt.result_version,
    ...(receipt.order_id ? { order_id: receipt.order_id, object_id: receipt.object_id! } : {}),
    ...(receipt.operation === "os.objects.private.update" ? { changed_fields: changed ? JSON.parse(changed.changed_fields_json) as string[] : [] } : {}) };
}
async function publishReceipt(ctx: ModuleContext, receipt: ObjectReceipt) {
  const events: Record<string, string> = { "os.objects.create": "os.object.created", "os.objects.update": "os.object.updated", "os.objects.archive": "os.object.archived", "os.objects.private.update": "os.object.private_fields_changed", "os.object.link": "os.object.linked" };
  const event = events[receipt.operation];
  if (event) await ctx.publish(event, receipt.object_id!, { id: receipt.object_id!, version: receipt.result_version,
    ...(receipt.order_id ? { order_id: receipt.order_id } : {}) }, { key: `object:${hash([receipt.profile_id, receipt.actor_key, receipt.operation, receipt.request_id])}` });
}
async function replay(ctx: ModuleContext, actor: Actor, receipt: ObjectReceipt, conversationId?: string): Promise<ObjectMutationRef> {
  const object = await loadObject(ctx, receipt.object_id!);
  const access = await authorizeObjectContact(ctx, actor, object.contact_id, { write: true, conversation_id: conversationId });
  if (receipt.operation === "os.objects.private.update") {
    if (access.audience.kind === "customer") throw new ApiError(403, "sensitive_forbidden", "Campos privados não estão disponíveis na conversa do cliente.");
    await requireObjectPrivateAccess(ctx, actor);
  }
  if (receipt.order_id) {
    const order = await authorizedOrder(ctx, actor, receipt.order_id, { write: true, conversation_id: conversationId });
    if (order.row.contact_id !== object.contact_id || order.row.object_id !== object.id) throw missing();
  }
  await publishReceipt(ctx, receipt);
  return mutationRef(ctx, receipt);
}
function selection(raw: unknown): ObjectOpeningRequest {
  const value = record(raw);
  if (value.mode === "existing") {
    only(value, ["mode", "id", "version"]);
    if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw invalid();
    return { mode: "existing", id: stringId(value.id), version: Number(value.version) };
  }
  if (value.mode === "new") {
    only(value, ["mode", "type_id", "values"]);
    return { mode: "new", type_id: stringId(value.type_id), values: record(value.values) as ExtraValues };
  }
  throw invalid();
}
function snapshot(row: ObjectRow, type: ServiceObjectType, origin: ServiceObjectSnapshot["origin"], at: number): ServiceObjectSnapshot {
  const out: ServiceObjectSnapshot = { schema_version: 1, object_id: row.id, object_version: row.row_version, captured_at: at, origin, type: structuredClone(type), values: JSON.parse(row.values_json) };
  if (jsonBytes(out) > 32768) throw new ApiError(413, "payload_too_large", "A cópia do objeto excede 32 KiB. Reduza os dados antes de abrir a ordem.");
  return out;
}
function objectGuard(row: ObjectRow): ChildStatement {
  return ["SELECT CASE WHEN EXISTS(SELECT 1 FROM os_objects WHERE profile_id=? AND id=? AND contact_id=? AND type_id=? AND type_revision=? AND row_version=? AND archived=0) THEN 1 ELSE json('os_version_conflict') END",
    [row.profile_id, row.id, row.contact_id, row.type_id, row.type_revision, row.row_version]];
}
async function prepareSelection(ctx: ModuleContext, request: ObjectOpeningRequest, contact: string, type: WorkTypeView, audience: ObjectAudience, actor: string, at: number, key: string, origin: ServiceObjectSnapshot["origin"]): Promise<ObjectOpeningPlan> {
  let prepared: PreparedObject;
  if (request.mode === "new") {
    if (request.type_id !== type.object_type_id) throw definitionConflict();
    const objectType = await currentType(ctx, request.type_id);
    const values = valuesFor(objectType, request.values, audience);
    prepared = await newObject(ctx, contact, objectType, values, actor, at, key);
  } else {
    const row = await loadObject(ctx, request.id);
    if (row.contact_id !== contact) throw missing();
    if (row.type_id !== type.object_type_id) throw definitionConflict();
    if (row.archived) throw new ApiError(409, "object_archived", "Objeto arquivado. Desarquive o cadastro antes de selecioná-lo.");
    checkVersion(row, request.version);
    prepared = { row, type: adoptedType(row), before: [contactGuard(ctx.profile, contact), objectGuard(row)], after: [] };
  }
  try { resolveWorkFields(type, prepared.type); }
  catch { throw definitionConflict(); }
  return { contact_id: contact, object_id: prepared.row.id, snapshot: snapshot(prepared.row, prepared.type, origin, at), before: prepared.before, after: prepared.after };
}
async function openingAccess(ctx: ModuleContext, input: ObjectOpeningContext["input"], canonicalContact: string | null) {
  await ctx.requireEnabled();
  if (input.source === "customer") {
    if (!input.conversation) throw new ApiError(409, "customer_required", "Confirme o contato antes de cadastrar o objeto.");
    const contact_id = await resolveObjectConversationContact(ctx, input.conversation);
    if ((canonicalContact && canonicalContact !== contact_id) || (input.contact_id && input.contact_id !== contact_id)) throw missing();
    return { contact_id, audience: { kind: "customer" } as ObjectAudience };
  }
  if (!input.authority) throw missing();
  const contact = canonicalContact ?? input.contact_id;
  if (!contact) throw new ApiError(409, "customer_required", "Selecione um contato confirmado antes de cadastrar o objeto.");
  const options = { write: true, conversation_id: isBound(input.authority) ? input.conversation?.id : undefined };
  const access = await authorizeObjectContact(ctx, input.authority, contact, options);
  if (input.contact_id && input.contact_id !== access.contact_id) {
    const supplied = await authorizeObjectContact(ctx, input.authority, input.contact_id, options);
    if (supplied.contact_id !== access.contact_id) throw missing();
  }
  return access;
}
export async function prepareObjectOpening(ctx: ModuleContext, context: ObjectOpeningContext): Promise<ObjectOpeningPlan> {
  const { input, type, at } = context;
  if (!type.object_type_id || type.kind === "builtin") throw invalid();
  if (!input.object) throw new ApiError(409, "object_required", "Selecione ou cadastre o objeto do serviço.");
  const access = await openingAccess(ctx, input, context.contact_id);
  const request = selection(input.object);
  const plan = await prepareSelection(ctx, request, access.contact_id, type, access.audience, input.actor, at, input.sourceKey, "opening");
  plan.after.push(receiptStatement({ profile_id: ctx.profile, actor_key: input.authority ? actorKey(input.authority) : hash(["customer", access.contact_id]),
    operation: "os.object.open", request_id: input.sourceKey, payload_hash: hash(normalized({ object: request, type_id: type.id, contact_id: access.contact_id })), object_id: plan.object_id,
    order_id: context.order_id, result_version: 1, created: at }));
  return plan;
}
export async function reauthorizeObjectOpening(ctx: ModuleContext, row: WorkOrderRow, input: ObjectOpeningContext["input"]): Promise<void> {
  if (!row.object_id || row.profile_id !== ctx.profile || !row.contact_id) throw missing();
  const access = await openingAccess(ctx, input, row.contact_id);
  const object = await loadObject(ctx, row.object_id);
  if (object.contact_id !== access.contact_id) throw missing();
  // Não reaplicar regras da abertura: revisões, arquivamento e valores podem ter mudado.
}
export async function prepareLegacyObjectLink(ctx: ModuleContext, actor: Actor, order: AuthorizedOrder, data: Record<string, unknown>, requestId: string): Promise<ObjectOpeningPlan> {
  if (order.row.profile_id !== ctx.profile || order.type.kind !== "custom") throw invalid();
  if (!order.row.contact_id) throw new ApiError(409, "customer_required", "Vincule primeiro um contato confirmado à ordem.");
  const access = await authorizeObjectContact(ctx, actor, order.row.contact_id, { write: true, conversation_id: typeof data.conversation_id === "string" ? data.conversation_id : undefined });
  if (order.row.object_id) throw new ApiError(409, "version_conflict", "Esta ordem já tem objeto vinculado. A associação não pode ser trocada.");
  checkVersion(order.row, data.version);
  // A ordem antiga conserva a definição e os valores. Só a compatibilidade de
  // associação vem do modelo atual quando a cópia antiga ainda não tinha objeto.
  const current = order.type.object_type_id ? order.type : await resolveWorkType(ctx, order.type.id);
  if (current.kind !== "custom" || !current.object_type_id) throw definitionConflict();
  const request = selection(data.object);
  return prepareSelection(ctx, request, access.contact_id, current, access.audience, actor.id, now(), requestId, "legacy_link");
}

/** A prévia nunca usa campos privados como candidato a um identificador público. */
export async function previewLegacyObjectLink(ctx: ModuleContext, actor: Actor, order: AuthorizedOrder, data: Record<string, unknown>): Promise<LegacyObjectLinkPreview> {
  if (order.row.profile_id !== ctx.profile || order.type.kind !== "custom") throw invalid();
  if (!order.row.contact_id) throw new ApiError(409, "customer_required", "Vincule primeiro um contato confirmado à ordem.");
  const access = await authorizeObjectContact(ctx, actor, order.row.contact_id, { write: true,
    conversation_id: typeof data.conversation_id === "string" ? data.conversation_id : undefined });
  checkVersion(order.row, data.version);
  if (order.row.object_id) throw versionConflict();
  const current = order.type.object_type_id ? order.type : await resolveWorkType(ctx, order.type.id);
  const request = selection(data.object);
  if (request.mode !== "new" || current.kind !== "custom" || current.object_type_id !== request.type_id) throw definitionConflict();
  const type = await currentType(ctx, request.type_id);
  try { resolveWorkFields(current, type); } catch { throw definitionConflict(); }
  const permitted = new Set(projectObjectType(type, access.audience).fields.map(field => field.id));
  const source = JSON.parse(order.row.extra_json ?? "{}") as ExtraValues;
  const compatible: ExtraValues = {};
  const visitOnly = new Set(["quilometragem", "km", "combustivel", "combustivel_entrada", "nivel_combustivel", "ultima_manutencao", "ultima_manutencao_informada"]);
  for (const field of type.fields) {
    const old = order.type.fields.find(entry => entry.id === field.id);
    if (!old || old.sensitive || field.sensitive || visitOnly.has(field.id) || !permitted.has(field.id) ||
        (access.audience.kind === "customer" && !old.client_visible) ||
        (access.audience.kind === "bot" && !old.client_visible && !access.audience.ai_access?.internal) || !Object.hasOwn(source, field.id)) continue;
    // Mesmo ID/tipo e as mesmas validações: nomes parecidos não provam significado.
    const semantics = ({ id: _id, label: _label, help: _help, required: _required, client_visible: _visible, sensitive: _sensitive, ...rest }: typeof field) => rest;
    if (hash(semantics(old)) !== hash(semantics(field))) continue;
    try {
      const value = validateObjectValues(type, { [field.id]: source[field.id] }, { partial: true });
      if (field.id !== type.identifier_field_id || typeof value[field.id] !== "string" || !/[\r\n\u2028\u2029]/.test(value[field.id] as string))
        compatible[field.id] = value[field.id];
    } catch { /* Valor incompatível não é sugerido nem reinterpretado. */ }
  }
  return { preview: true, order_id: order.row.id, version: order.row.row_version ?? 1,
    type: projectObjectType(type, access.audience), compatible_values: compatible };
}

export async function objectCommand(ctx: ModuleContext, actor: Actor, operation: Os2CommandOperation, data: Record<string, unknown>, meta: { requestId: string }): Promise<ObjectMutationRef | LegacyObjectLinkPreview | { preview: true; object: ReturnType<typeof projectServiceObject>; removed_field_ids: string[] }> {
  if (!["os.objects.create", "os.objects.update", "os.objects.archive", "os.objects.private.update", "os.object.link"].includes(operation)) throw new ApiError(501, "not_implemented", "Operação não pertence ao cadastro de objetos.");
  const conversationId = data.conversation_id === undefined ? undefined : stringId(data.conversation_id);
  const audience = await authorizeObjectAccess(ctx, actor, { write: true, conversation_id: conversationId });
  const requestId = stringId(meta.requestId), key = actorKey(actor), fingerprint = hash(normalized(data));
  const existing = await readReceipt(ctx, key, operation, requestId, fingerprint);
  if (existing) return replay(ctx, actor, existing, conversationId);
  const at = now();
  let row: ObjectRow | undefined;
  let receipt: ObjectReceipt;
  let statements: ChildStatement[];
  let adding = false, activating = false;
  let linkLimit: { contact: string; type: string } | undefined;
  if (operation === "os.objects.create") {
    only(data, ["contact_id", "type_id", "values", "conversation_id"]);
    const access = await authorizeObjectContact(ctx, actor, stringId(data.contact_id), { write: true, conversation_id: conversationId });
    const type = await currentType(ctx, stringId(data.type_id));
    const plan = await newObject(ctx, access.contact_id, type, valuesFor(type, data.values, access.audience), actor.id, at, requestId);
    row = plan.row; adding = true;
    statements = [...plan.before, ...plan.after];
    receipt = { profile_id: ctx.profile, actor_key: key, operation, request_id: requestId, payload_hash: fingerprint, object_id: row.id, order_id: null, result_version: 1, created: at };
  } else if (operation === "os.object.link") {
    only(data, ["id", "version", "object", "conversation_id", "preview"]);
    const order = await authorizedOrder(ctx, actor, stringId(data.id), { write: true, conversation_id: conversationId });
    if (data.preview !== undefined) {
      if (data.preview !== true) throw invalid();
      return previewLegacyObjectLink(ctx, actor, order, data);
    }
    const plan = await prepareLegacyObjectLink(ctx, actor, order, data, requestId);
    if (record(data.object).mode === "new") linkLimit = { contact: plan.contact_id, type: plan.snapshot.type.id };
    const version = (order.row.row_version ?? 1) + 1;
    const next = { ...order.row, object_id: plan.object_id, object_snapshot_json: JSON.stringify(plan.snapshot), row_version: version, updated: at };
    const index = await planOrderFieldIndex(ctx, { row: next, previous: order.row, type: order.type });
    statements = [...plan.before,
      objectGuard({ id: plan.object_id, profile_id: ctx.profile, contact_id: plan.contact_id, type_id: plan.snapshot.type.id, type_revision: plan.snapshot.type.revision, row_version: plan.snapshot.object_version } as ObjectRow),
      ["UPDATE os_orders SET object_id=?,object_snapshot_json=?,row_version=?,updated=? WHERE profile_id=? AND id=? AND row_version=? AND contact_id=? AND object_id IS NULL AND type_id<>'service_order'",
        [plan.object_id, next.object_snapshot_json, version, at, ctx.profile, order.row.id, order.row.row_version ?? 1, plan.contact_id]], casGuard,
      ["INSERT INTO os_history(id,profile_id,order_id,kind,actor,created,entity_version,mutation_key,changed_fields_json) VALUES(?,?,?,'os.object.linked',?,?,?,?,?)",
        [uid(), ctx.profile, order.row.id, actor.id, at, version, `object-link:${key}:${requestId}`, '["object_id"]']], ...index, ...plan.after];
    receipt = { profile_id: ctx.profile, actor_key: key, operation, request_id: requestId, payload_hash: fingerprint, object_id: plan.object_id, order_id: order.row.id, result_version: version, created: at };
  } else {
    only(data, ["object_id", "version", "conversation_id", ...(operation === "os.objects.archive" ? ["archived"] : operation === "os.objects.private.update" ? ["values"] : ["values", "adopt_revision", "preview"])]);
    row = await loadObject(ctx, stringId(data.object_id));
    const access = await authorizeObjectContact(ctx, actor, row.contact_id, { write: true, conversation_id: conversationId });
    const privateFields = operation === "os.objects.private.update";
    if (privateFields) {
      if (access.audience.kind === "customer") throw new ApiError(403, "sensitive_forbidden", "Campos privados não estão disponíveis na conversa do cliente.");
      await requireObjectPrivateAccess(ctx, actor);
    }
    checkVersion(row, data.version);
    let type = adoptedType(row), values: ExtraValues = JSON.parse(row.values_json), archived = row.archived;
    let removed: string[] = [];
    const changed: string[] = [];
    if (operation === "os.objects.archive") {
      if (typeof data.archived !== "boolean") throw invalid();
      archived = data.archived ? 1 : 0;
      activating = !!row.archived && !archived;
      if (activating) await checkLimits(ctx, row.contact_id, row.type_id, false);
      changed.push("archived");
    } else {
      if (data.adopt_revision !== undefined) {
        if (!Number.isSafeInteger(data.adopt_revision) || Number(data.adopt_revision) <= type.revision) throw definitionConflict();
        const next = await currentType(ctx, row.type_id);
        if (next.revision !== data.adopt_revision) throw definitionConflict();
        for (const old of type.fields) {
          const replacement = next.fields.find(field => field.id === old.id);
          if (replacement && (replacement.kind !== old.kind || (old.sensitive && !replacement.sensitive))) throw definitionConflict();
        }
        removed = type.fields.filter(field => !next.fields.some(nextField => nextField.id === field.id)).map(field => field.id);
        // Dados retirados não são transpostos para outro ID nem para a cópia de uma ordem.
        values = Object.fromEntries(Object.entries(values).filter(([id]) => next.fields.some(field => field.id === id)));
        type = next; changed.push("type_revision");
      }
      const incoming = data.values ?? {};
      if (data.values === undefined && data.adopt_revision === undefined) throw invalid();
      values = valuesFor(type, incoming, access.audience, values, privateFields);
      // Valida também valores conservados contra as opções/limites da revisão adotada.
      if (data.adopt_revision !== undefined) {
        const common = Object.fromEntries(Object.entries(values).filter(([id]) => !type.fields.find(field => field.id === id)?.sensitive));
        const sensitive = Object.fromEntries(Object.entries(values).filter(([id]) => type.fields.find(field => field.id === id)?.sensitive));
        validateObjectValues(type, common);
        validateObjectValues(type, sensitive, { mode: "private", previous: common });
      }
      changed.push(...Object.keys(record(incoming)));
    }
    const next: ObjectRow = { ...row, type_revision: type.revision, type_snapshot_json: JSON.stringify(type), values_json: JSON.stringify(values), archived, row_version: row.row_version + 1, updated_by: actor.id, updated: at };
    if (data.preview !== undefined) {
      if (data.preview !== true || data.adopt_revision === undefined) throw invalid();
      return { preview: true, object: projectServiceObject(next, audience), removed_field_ids: removed.filter(id => projectObjectType(adoptedType(row!), audience).fields.some(field => field.id === id)) };
    }
    statements = [contactGuard(ctx.profile, row.contact_id), ...(activating ? [limitGuard(ctx.profile, row.contact_id, row.type_id, false)] : []),
      ["UPDATE os_objects SET type_revision=?,type_snapshot_json=?,values_json=?,archived=?,row_version=?,updated_by=?,updated=? WHERE profile_id=? AND id=? AND contact_id=? AND row_version=?",
        [next.type_revision, next.type_snapshot_json, next.values_json, next.archived, next.row_version, actor.id, at, ctx.profile, row.id, row.contact_id, row.row_version]], casGuard,
      history(next, operation === "os.objects.archive" ? "os.object.archived" : privateFields ? "os.object.private_fields_changed" : "os.object.updated", changed, `${key}:${requestId}`)];
    receipt = { profile_id: ctx.profile, actor_key: key, operation, request_id: requestId, payload_hash: fingerprint, object_id: row.id, order_id: null, result_version: next.row_version, created: at };
  }
  try { await batch(ctx.env, [...statements, receiptStatement(receipt)]); }
  catch (error) {
    const winner = await readReceipt(ctx, key, operation, requestId, fingerprint);
    if (winner) return replay(ctx, actor, winner, conversationId);
    if (row && (adding || activating)) await checkLimits(ctx, row.contact_id, row.type_id, adding);
    if (linkLimit) await checkLimits(ctx, linkLimit.contact, linkLimit.type, true);
    if (/malformed JSON|os_version_conflict|os_object_limit/i.test(String(error))) throw versionConflict();
    throw error;
  }
  await publishReceipt(ctx, receipt);
  return mutationRef(ctx, receipt);
}

/** Plano para o lote da junção. O chamador reatribui também as ordens antes de after. */
export async function planObjectContactMerge(ctx: ModuleContext, input: ObjectContactMergeInput): Promise<ObjectContactMergePlan> {
  if (input.profile_id !== ctx.profile || input.namespace !== "team" || input.source_contact_id === input.target_contact_id) throw invalid();
  const source = await authorizeObjectContact(ctx, input.actor, input.source_contact_id, { write: true });
  const target = await authorizeObjectContact(ctx, input.actor, input.target_contact_id, { write: true });
  const key = actorKey(input.actor), operation = "os.objects.contact_merge", requestId = stringId(input.merge_key);
  const fingerprint = hash([input.profile_id, input.namespace, input.source_contact_id, input.target_contact_id]);
  const previous = await readReceipt(ctx, key, operation, requestId, fingerprint);
  if (previous) {
    const object = await loadObject(ctx, previous.object_id!);
    if (object.contact_id !== target.contact_id) throw missing();
    const prefix = `${hash([ctx.profile, key, requestId])}:`;
    const histories = await all<{ id: string; object_id: string }>(ctx.env,
      "SELECT h.id,h.object_id FROM os_object_history h JOIN os_objects o ON o.profile_id=h.profile_id AND o.id=h.object_id WHERE h.profile_id=? AND h.id>=? AND h.id<? AND o.contact_id=? ORDER BY h.id LIMIT 100",
      ctx.profile, prefix, `${prefix}~`, target.contact_id);
    return { before: [], after: [], object_ids: histories.map(entry => entry.object_id), audit_refs: histories.map(entry => entry.id) };
  }
  if (source.contact_id !== input.source_contact_id || target.contact_id !== input.target_contact_id) throw missing();
  const rows = await all<ObjectRow>(ctx.env, "SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? ORDER BY id LIMIT 101", ctx.profile, source.contact_id);
  if (!rows.length) return { before: [], after: [], object_ids: [], audit_refs: [] };
  const counts = await all<{ type_id: string; total: number; active: number }>(ctx.env,
    "SELECT type_id,count(*) total,sum(CASE WHEN archived=0 THEN 1 ELSE 0 END) active FROM os_objects WHERE profile_id=? AND contact_id IN (?,?) GROUP BY type_id", ctx.profile, source.contact_id, target.contact_id);
  if (rows.length > 100 || counts.reduce((sum, count) => sum + count.total, 0) > 100 || counts.some(count => count.active > 30)) throw objectLimit();
  const at = now(), ids = rows.map(row => row.id);
  const before: ChildStatement[] = [contactGuard(ctx.profile, source.contact_id), contactGuard(ctx.profile, target.contact_id),
    ["SELECT CASE WHEN (SELECT count(*) FROM os_objects WHERE profile_id=? AND contact_id IN (?,?))<=100 AND NOT EXISTS(SELECT 1 FROM os_objects WHERE profile_id=? AND contact_id IN (?,?) AND archived=0 GROUP BY type_id HAVING count(*)>30) THEN 1 ELSE json('os_object_limit') END",
      [ctx.profile, source.contact_id, target.contact_id, ctx.profile, source.contact_id, target.contact_id]],
    ["SELECT CASE WHEN (SELECT count(*) FROM os_objects WHERE profile_id=? AND contact_id=?)=? THEN 1 ELSE json('os_version_conflict') END", [ctx.profile, source.contact_id, rows.length]],
    ["UPDATE os_objects SET contact_id=?,row_version=row_version+1,updated_by=?,updated=? WHERE profile_id=? AND contact_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND row_version=(SELECT json_extract(value,'$.version') FROM json_each(?) WHERE json_extract(value,'$.id')=os_objects.id)",
      [target.contact_id, input.actor.id, at, ctx.profile, source.contact_id, JSON.stringify(rows.map(row => ({ id: row.id, version: row.row_version }))), JSON.stringify(rows.map(row => ({ id: row.id, version: row.row_version })))]],
    ["SELECT CASE WHEN changes()=? THEN 1 ELSE json('os_version_conflict') END", [rows.length]]];
  const auditRefs = rows.map(row => `${hash([ctx.profile, key, requestId])}:${row.id}`);
  const after: ChildStatement[] = [
    ["SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND object_id IN (SELECT value FROM json_each(?)) AND contact_id IS NOT ?) THEN 1 ELSE json('os_version_conflict') END", [ctx.profile, JSON.stringify(ids), target.contact_id]],
    ["INSERT INTO os_object_history(id,profile_id,object_id,object_version,kind,actor,changed_fields_json,created) SELECT json_extract(value,'$.audit'),?,json_extract(value,'$.id'),json_extract(value,'$.version')+1,'os.object.contact_merged',?,'[\"contact_id\"]',? FROM json_each(?)",
      [ctx.profile, input.actor.id, at, JSON.stringify(rows.map((row, index) => ({ id: row.id, version: row.row_version, audit: auditRefs[index] })))]],
    receiptStatement({ profile_id: ctx.profile, actor_key: key, operation, request_id: requestId, payload_hash: fingerprint, object_id: ids[0], order_id: null, result_version: rows[0].row_version + 1, created: at }),
  ];
  return { before, after, object_ids: ids, audit_refs: auditRefs };
}
