// Projeções puras: mensagens nunca consultam a ficha atual do objeto.
import { ApiError, json } from "../../types";
import type { ExtraValues, ServiceObjectSnapshot, ServiceObjectSnapshotView, ServiceObjectType, ServiceObjectView, WorkField } from "./contracts";
import type { ObjectAudience, WorkObjectContext } from "./os2-ports";
import type { ServiceObjectRow, WorkOrderRow } from "./public";
import { validateExtra, validateObjectType } from "./validation";

const invalidSnapshot = () => new ApiError(409, "object_definition_conflict", "A definição do objeto está indisponível. Peça à equipe para conferir o cadastro.");

/** Uma política administrativa já autorizada pode ampliar o contexto da IA.
 * A projeção pública usa sempre customer, inclusive quando solicitada por bot. */
function allowedFields(type: ServiceObjectType, audience: ObjectAudience): WorkField[] {
  return type.fields.filter(field => {
    if (audience.allowed_field_ids && !audience.allowed_field_ids.includes(field.id)) return false;
    if (audience.kind === "commercial") return !!audience.allowed_field_ids && !field.sensitive;
    if (audience.kind === "staff") return !field.sensitive;
    if (audience.kind === "customer") return field.client_visible && !field.sensitive;
    if (field.sensitive) return audience.ai_access?.enabled === true && audience.ai_access.sensitive === true;
    return field.client_visible || (audience.ai_access?.enabled === true && audience.ai_access.internal === true);
  });
}

function valuesForFields(fields: WorkField[], raw: unknown): ExtraValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidSnapshot();
  const values = raw as Record<string, unknown>;
  const out: ExtraValues = {};
  try {
    // Valida só a projeção autorizada, sem devolver nomes de campos ocultos em erros.
    for (const field of fields) if (Object.hasOwn(values, field.id)) {
      Object.assign(out, validateExtra([field], { [field.id]: values[field.id] }, {
        mode: field.sensitive ? "private" : "staff", partial: true,
      }));
    }
  } catch { throw invalidSnapshot(); }
  return out;
}

export function objectIdentifier(type: Pick<ServiceObjectType, "labels" | "identifier_field_id">,
  id: string, fields: readonly WorkField[], values: ExtraValues): string {
  const field = fields.find(entry => entry.id === type.identifier_field_id && entry.kind === "text" && !entry.sensitive);
  const value = field ? values[field.id] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : `${type.labels.singular} · ${id.slice(-6).toUpperCase()}`;
}

function objectType(raw: unknown): ServiceObjectType {
  try { return validateObjectType(raw); } catch { throw invalidSnapshot(); }
}

/** Não copia arquivamento, IDs aposentados ou campos não autorizados do tipo. */
function definitionView(type: ServiceObjectType, fields: WorkField[]): ServiceObjectSnapshotView["type"] {
  return {
    schema_version: 1, id: type.id, revision: type.revision,
    labels: { ...type.labels }, fields: structuredClone(fields),
    ...(fields.some(field => field.id === type.identifier_field_id) ? { identifier_field_id: type.identifier_field_id } : {}),
  };
}

export function projectChannelObjectSnapshot(row: WorkOrderRow, audience: ObjectAudience = { kind: "customer" }): ServiceObjectSnapshotView | undefined {
  if (!row.object_id) return undefined;
  const snapshot = json(row.object_snapshot_json, null) as ServiceObjectSnapshot | null;
  if (!snapshot || snapshot.schema_version !== 1 || snapshot.object_id !== row.object_id ||
      !Number.isSafeInteger(snapshot.object_version) || snapshot.object_version < 1 ||
      !Number.isSafeInteger(snapshot.captured_at) || snapshot.captured_at < 0 ||
      !["opening", "legacy_link"].includes(snapshot.origin)) throw invalidSnapshot();
  const type = objectType(snapshot.type), fields = allowedFields(type, audience);
  const values = valuesForFields(fields, snapshot.values);
  return {
    schema_version: 1, object_id: snapshot.object_id, object_version: snapshot.object_version,
    captured_at: snapshot.captured_at, origin: snapshot.origin,
    type: definitionView(type, fields), values,
    identifier: objectIdentifier(type, snapshot.object_id, fields, values),
  };
}

export function publicObjectLabel(row: WorkOrderRow): string {
  return projectChannelObjectSnapshot(row, { kind: "customer" })?.identifier ?? "";
}

/** A audiência commercial precisa fornecer a lista explícita de campos da política comercial. */
export function getWorkObjectContext(row: WorkOrderRow, audience: ObjectAudience): WorkObjectContext | undefined {
  const snapshot = projectChannelObjectSnapshot(row, audience);
  if (!snapshot) return undefined;
  return {
    object_id: snapshot.object_id, type_id: snapshot.type.id, object_version: snapshot.object_version,
    captured_at: snapshot.captured_at, origin: snapshot.origin, identifier: snapshot.identifier,
    allowed_fields: snapshot.type.fields.filter(field => Object.hasOwn(snapshot.values, field.id))
      .map(field => ({ field, value: snapshot.values[field.id] })),
    equipment_text: snapshot.identifier,
  };
}

/** O chamador já autorizou área, conversa e contato; não exporta colunas D1. */
export function publicObjectView(row: ServiceObjectRow): ServiceObjectView {
  const type = objectType(json(row.type_snapshot_json, null));
  if (type.id !== row.type_id || type.revision !== row.type_revision) throw invalidSnapshot();
  const fields = allowedFields(type, { kind: "customer" });
  const values = valuesForFields(fields, json(row.values_json, null));
  return {
    id: row.id, type_id: type.id, type_revision: type.revision,
    type: definitionView(type, fields), values, archived: row.archived === 1,
    version: row.row_version, identifier: objectIdentifier(type, row.id, fields, values),
    created: row.created, updated: row.updated,
  };
}
