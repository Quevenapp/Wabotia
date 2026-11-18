import { ApiError, json } from "../../types";
import type { CustomWorkType, WorkOrderAdditions, WorkTypeSnapshot, WorkTypeView } from "./contracts";
import { BUILTIN_WORK_TYPE } from "./contracts";
import { MANUAL_TRANSITIONS, OS_STATUSES, QUOTABLE, STATUS_LABELS, osSettings } from "./model";
import { jsonBytes, validateWorkType } from "./validation";

export function builtinWorkType(settings: unknown = {}): WorkTypeView {
  const cfg = osSettings(settings);
  return {
    ...BUILTIN_WORK_TYPE,
    archived: false,
    labels: {
      singular: "Ordem de serviço",
      plural: "Ordens de serviço",
      item: "Item",
      problem: "Problema",
      customer_singular: "Cliente",
      customer_plural: "Clientes",
    },
    number_prefix: "",
    terms: cfg.terms,
    fields: [],
    retired_field_ids: [],
    retired_stage_ids: [],
    initial_stage: "received",
    stages: OS_STATUSES.map((status) => ({
      id: status,
      label: STATUS_LABELS[status],
      base_status: status,
      message:
        status === "received"
          ? cfg.texts.opened
          : (cfg.texts[status as keyof typeof cfg.texts] ?? ""),
    })),
    transitions: OS_STATUSES.flatMap((from) =>
      MANUAL_TRANSITIONS[from].map((to) => ({
        id: `${from}_${to}`,
        from,
        to,
        label: STATUS_LABELS[to],
        kind: "manual" as const,
      })),
    ),
    features: {
      customer_open: true,
      tasks: false,
      people: false,
      documents: false,
      entries: false,
      quote: {
        default_valid_days: cfg.quote_valid_days,
        source_stages: [...QUOTABLE],
        sent_stage: "quoted",
        approved_stage: "approved",
        declined_stage: "declined",
        edited_stage: "analyzing",
      },
      warranty_days: cfg.warranty_days,
      pickup_reminder_days: cfg.pickup_reminder_days,
      stale_days: cfg.stale_days,
    },
    pickup_reminder_text: cfg.texts.pickup_reminder,
  };
}

/** A definição da linha prevalece sempre sobre a configuração atual. */
export function snapshotType(row: any): CustomWorkType | null {
  if (!row.type_id || row.type_id === "service_order") return null;
  let snapshot: WorkTypeSnapshot;
  try { snapshot = JSON.parse(row.type_snapshot_json); }
  catch { throw new ApiError(409, "invalid_snapshot", "Definição da ordem indisponível."); }
  if (snapshot?.schema_version !== 1 || snapshot.type?.id !== row.type_id)
    throw new ApiError(409, "invalid_snapshot", "Definição da ordem inválida.");
  return snapshot.type;
}
export function makeSnapshot(type: CustomWorkType): WorkTypeSnapshot {
  const snapshot = { schema_version: 1 as const, type: validateWorkType(type) };
  if (jsonBytes(snapshot) > 16 * 1024) throw new ApiError(413, "payload_too_large", "Cópia do tipo excede 16 KiB.");
  return snapshot;
}
export function effectiveStage(row: any) { return row.stage || row.status; }
export function legacyCustomStatuses(row: any, type: CustomWorkType) {
  const stage = effectiveStage(row);
  const candidates = type.transitions.filter(t => t.from === stage);
  const statuses = OS_STATUSES.filter(status => status !== row.status && candidates.filter(t => type.stages.find(s => s.id === t.to)?.base_status === status).length === 1 && candidates.some(t => t.kind === "manual" && type.stages.find(s => s.id === t.to)?.base_status === status));
  const q = type.features.quote;
  if (q && row.quote_items && q.source_stages.includes(stage)) statuses.push("quoted");
  if (q?.sent_stage === stage) statuses.push("approved", "declined");
  return [...new Set(statuses)];
}
export function workOrderAdditions(row: any, resolved?: WorkTypeView): WorkOrderAdditions {
  const type = resolved ?? snapshotType(row) ?? builtinWorkType();
  const stage = effectiveStage(row);
  const definition = type.stages.find(s => s.id === stage);
  if (!definition || definition.base_status !== row.status) throw new ApiError(409, "invalid_snapshot", "Etapa e estado da ordem divergem.");
  const fields = type.fields.filter(f => !f.sensitive);
  const values = json(row.extra_json, {});
  return {
    type_id: type.id, type_revision: type.revision,
    type_number: row.type_number ?? row.number,
    type_label: type.labels.singular, type_plural_label: type.labels.plural,
    display_number: type.kind === "builtin" ? String(row.number) : [type.number_prefix, row.type_number ?? row.number].filter(v => v !== "").join("-"),
    stage, stage_label: definition.label, labels: { ...type.labels }, fields,
    extra: Object.fromEntries(fields.filter(f => Object.hasOwn(values, f.id)).map(f => [f.id, values[f.id]])),
    version: row.row_version ?? 1,
    next_stages: type.transitions.filter(t => t.from === stage).map(t => {
      const dest = type.stages.find(s => s.id === t.to)!;
      return { transition_id: t.id, stage: dest.id, stage_label: dest.label, base_status: dest.base_status, kind: t.kind };
    }),
    stage_approval: json(row.stage_approval_json, null),
  };
}
