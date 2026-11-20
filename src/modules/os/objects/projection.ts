import { ApiError } from "../../../types";
import type { Actor } from "../../../types";
import { isBound } from "../../../visibility";
import type { ModuleContext } from "../../api";
import type { ExtraValues, ServiceObjectSnapshot, ServiceObjectSnapshotView, ServiceObjectType, ServiceObjectView, WorkField } from "../contracts";
import type { ObjectAudience, WorkObjectContext } from "../os2-ports";
import type { ServiceObjectRow, WorkOrderRow } from "../public";
import { validateObjectType } from "../validation";
import { authorizeObjectAccess, authorizeObjectContact } from "./access";

/** A política é resolvida antes deste helper puro; cliente nunca recebe opt-in. */
export function objectFieldAllowed(field: WorkField, audience: ObjectAudience): boolean {
  if (audience.allowed_field_ids && !audience.allowed_field_ids.includes(field.id)) return false;
  if (audience.kind === "commercial") return !field.sensitive && !!audience.allowed_field_ids?.includes(field.id);
  if (audience.kind === "customer") return !field.sensitive && field.client_visible;
  if (audience.kind === "bot") {
    if (field.sensitive) return audience.ai_access?.enabled === true && audience.ai_access.sensitive === true;
    return field.client_visible || (audience.ai_access?.enabled === true && audience.ai_access.internal === true);
  }
  return !field.sensitive;
}

export function projectObjectType(type: ServiceObjectType, audience: ObjectAudience): ServiceObjectSnapshotView["type"] {
  const fields = type.fields.filter(field => objectFieldAllowed(field, audience));
  return {
    schema_version: 1, id: type.id, revision: type.revision,
    labels: { singular: type.labels.singular, plural: type.labels.plural },
    fields: structuredClone(fields),
    ...(fields.some(field => field.id === type.identifier_field_id) ? { identifier_field_id: type.identifier_field_id } : {}),
  };
}

function valuesFor(type: ServiceObjectSnapshotView["type"], raw: ExtraValues): ExtraValues {
  return Object.fromEntries(type.fields.filter(field => Object.hasOwn(raw, field.id))
    .map(field => [field.id, raw[field.id]]));
}

function identifierFor(id: string, type: ServiceObjectSnapshotView["type"], values: ExtraValues): string {
  const value = type.identifier_field_id ? values[type.identifier_field_id] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : `${type.labels.singular} · ${id.slice(-6).toUpperCase()}`;
}

function storedValues(raw: unknown): ExtraValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.values(raw).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value)))
    throw new ApiError(409, "object_definition_conflict", "Os dados do objeto estão indisponíveis. Reabra o cadastro.");
  return raw as ExtraValues;
}

/** Ficha atual projetada explicitamente, sem autoria ou JSON de persistência. */
export function projectServiceObject(row: ServiceObjectRow, audience: ObjectAudience): ServiceObjectView {
  const adopted = validateObjectType(JSON.parse(row.type_snapshot_json));
  if (adopted.id !== row.type_id || adopted.revision !== row.type_revision)
    throw new ApiError(409, "object_definition_conflict", "A definição adotada pelo objeto está indisponível.");
  const type = projectObjectType(adopted, audience);
  const values = valuesFor(type, storedValues(JSON.parse(row.values_json)));
  return {
    id: row.id, ...(audience.kind === "staff" || (audience.kind === "bot" && audience.ai_access?.enabled)
      ? { contact_id: row.contact_id } : {}),
    type_id: row.type_id, type_revision: row.type_revision, type, values,
    archived: row.archived === 1, version: row.row_version,
    identifier: identifierFor(row.id, type, values), created: row.created, updated: row.updated,
  };
}

function objectSnapshot(row: WorkOrderRow): ServiceObjectSnapshot | undefined {
  if (!row.object_id) return undefined;
  try {
    const raw = JSON.parse(row.object_snapshot_json ?? "null") as ServiceObjectSnapshot;
    if (!raw || raw.schema_version !== 1 || raw.object_id !== row.object_id ||
        !Number.isSafeInteger(raw.object_version) || raw.object_version < 1 ||
        !Number.isSafeInteger(raw.captured_at) || raw.captured_at < 0 ||
        !["opening", "legacy_link"].includes(raw.origin)) throw Error();
    return { schema_version: 1, object_id: raw.object_id, object_version: raw.object_version,
      captured_at: raw.captured_at, origin: raw.origin,
      type: validateObjectType(raw.type), values: storedValues(raw.values) };
  } catch {
    throw new ApiError(409, "object_definition_conflict", "A cópia do objeto desta ordem está indisponível.");
  }
}

/** Nunca consulta o cadastro atual: uma visita conserva a sua própria cópia. */
export function projectObjectSnapshot(row: WorkOrderRow, audience: ObjectAudience): ServiceObjectSnapshotView | undefined {
  const snapshot = objectSnapshot(row);
  if (!snapshot) return undefined;
  const type = projectObjectType(snapshot.type, audience), values = valuesFor(type, snapshot.values);
  return { schema_version: 1, object_id: snapshot.object_id, object_version: snapshot.object_version,
    captured_at: snapshot.captured_at, origin: snapshot.origin, type, values,
    identifier: identifierFor(snapshot.object_id, type, values) };
}

/** Sem objeto não acrescenta consultas nem propriedades ao caminho legado. */
export async function projectObjectForActor(ctx: ModuleContext, actor: Actor, row: WorkOrderRow): Promise<ServiceObjectSnapshotView | undefined> {
  if (!row.object_id || row.profile_id !== ctx.profile || !row.contact_id) return undefined;
  try {
    const access = await authorizeObjectContact(ctx, actor, row.contact_id,
      isBound(actor) && row.conversation_id ? { conversation_id: row.conversation_id } : {});
    if (access.contact_id !== row.contact_id) return undefined;
    return projectObjectSnapshot(row, access.audience);
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) return undefined;
    throw error;
  }
}

/** A consulta da lista já materializou a autorização de contato por linha. */
export async function projectObjectPage(ctx: ModuleContext, actor: Actor, rows: readonly WorkOrderRow[]): Promise<ReadonlyMap<string, ServiceObjectSnapshotView>> {
  const result = new Map<string, ServiceObjectSnapshotView>();
  if (!rows.some(row => row.object_id)) return result;
  let audience: ObjectAudience;
  try { audience = await authorizeObjectAccess(ctx, actor); }
  catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) return result;
    throw error;
  }
  for (const row of rows) {
    if (!row.object_id || row.profile_id !== ctx.profile || !row.contact_id || row.os2_contact_active !== 1) continue;
    const projected = projectObjectSnapshot(row, audience);
    if (projected) result.set(row.id, projected);
  }
  return result;
}

export function publicObjectLabel(row: WorkOrderRow): string {
  return projectObjectSnapshot(row, { kind: "customer" })?.identifier ?? "";
}

export function getWorkObjectContext(row: WorkOrderRow, audience: ObjectAudience): WorkObjectContext | undefined {
  const view = projectObjectSnapshot(row, audience);
  if (!view) return undefined;
  const allowed_fields = view.type.fields.filter(field => Object.hasOwn(view.values, field.id))
    .map(field => ({ field, value: view.values[field.id] }));
  const text = allowed_fields.filter(({ field, value }) => field.id !== view.type.identifier_field_id && value !== null && value !== "")
    .map(({ field, value }) => `${field.label}: ${field.kind === "choice"
      ? field.options.find(option => option.id === value)?.label ?? value
      : typeof value === "boolean" ? value ? "Sim" : "Não" : value}`);
  return { object_id: view.object_id, type_id: view.type.id, object_version: view.object_version,
    captured_at: view.captured_at, origin: view.origin, identifier: view.identifier, allowed_fields,
    equipment_text: [view.identifier, ...text].join(" · ").replace(/[\r\n\t]+/g, " ").slice(0, 500) };
}
