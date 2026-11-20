import type { CustomWorkType, ServiceObjectType, WorkField } from "../modules/os/contracts";
import { validateObjectType, validateWorkType, validateWorkTypeChanges } from "../modules/os/validation";
import { ApiError } from "../types";

export interface ObjectUpgradeInput {
  current: CustomWorkType;
  /** Padrão anteriormente aplicado, necessário para reconhecer personalizações. */
  previous_standard: CustomWorkType;
  standard: CustomWorkType;
  /** IDs já remapeados para a área pelo chamador. */
  object_type: ServiceObjectType;
  existing_object_type?: ServiceObjectType;
  resolutions?: Record<string, "move" | "keep">;
  rule_resolution?: "standard" | "keep";
}
export interface ObjectUpgradePlan {
  can_apply: boolean;
  object_action: "create" | "use";
  work_type: CustomWorkType;
  object_type: ServiceObjectType;
  retained_fields: string[];
  moved_fields: string[];
  added_fields: string[];
  conflicts: Array<{ path: string; code: string; message: string }>;
  changes: Array<{ field_id: string; from: "order" | null; to: "order" | "object" }>;
  notice: string;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** Rótulo/ajuda podem mudar; validação e classificação continuam sendo significado. */
const meaning = ({ label: _label, help: _help, ...field }: WorkField) => field;

/** Plano puro de configuração: não recebe valores, não copia ordens e não faz I/O. */
export function planObjectUpgrade(input: ObjectUpgradeInput): ObjectUpgradePlan {
  const current = validateWorkType(input.current);
  const before = validateWorkType(input.previous_standard);
  const standard = validateWorkType(input.standard);
  const proposedObject = validateObjectType(input.object_type);
  const object = input.existing_object_type ? validateObjectType(input.existing_object_type) : proposedObject;
  const next = structuredClone(current);
  const conflicts: ObjectUpgradePlan["conflicts"] = [];
  const changes: ObjectUpgradePlan["changes"] = [];
  const moved: string[] = [], added: string[] = [];
  const conflict = (path: string, code: string, message: string) => conflicts.push({ path, code, message });
  if (!standard.object_type_id)
    conflict("object_type_id", "object_required", "O novo padrão precisa declarar o tipo de objeto.");
  else if (standard.object_type_id !== proposedObject.id)
    conflict("object_type_id", "object_definition_conflict", "O tipo de objeto proposto precisa corresponder à referência do novo padrão.");
  if (object.id !== proposedObject.id || object.archived)
    conflict("object_type", "object_definition_conflict", "Selecione um tipo de objeto ativo com o identificador proposto.");
  if (current.object_type_id && current.object_type_id !== object.id)
    conflict("object_type_id", "object_definition_conflict", "O modelo já usa outro tipo de objeto. Resolva a associação explicitamente.");
  if (!input.existing_object_type && object.revision !== 1)
    conflict("object_type.revision", "object_definition_conflict", "Um tipo de objeto novo deve começar na revisão 1.");
  for (const field of proposedObject.fields) {
    const adopted = object.fields.find((entry) => entry.id === field.id);
    if (!adopted || !equal(meaning(adopted), meaning(field)))
      conflict(`object_type.fields.${field.id}`, "object_definition_conflict", "O tipo compartilhado tem uma definição diferente. Revise os modelos afetados antes de alterá-lo.");
  }
  next.object_type_id = object.id;
  for (const field of current.fields) {
    if (standard.fields.some((entry) => entry.id === field.id)) continue;
    const destination = proposedObject.fields.find((entry) => entry.id === field.id);
    const original = before.fields.find((entry) => entry.id === field.id);
    if (!destination || !original || input.resolutions?.[field.id] === "keep") continue;
    const personalized = !equal(meaning(field), meaning(original));
    if (field.sensitive || (personalized && input.resolutions?.[field.id] !== "move")) {
      conflict(`fields.${field.id}`, field.sensitive ? "sensitive_field" : "personalized_field",
        field.sensitive
          ? "O campo privado será preservado. Escolha mantê-lo e informe os dados públicos expressamente no novo cadastro."
          : "O campo foi personalizado. Escolha mantê-lo nesta ordem ou confirme a mudança de localização sem copiar valores.");
      continue;
    }
    if (field.kind !== destination.kind) {
      conflict(`fields.${field.id}`, "field_definition_conflict", "A mudança de tipo exige outro identificador de campo.");
      continue;
    }
    next.fields = next.fields.filter((entry) => entry.id !== field.id);
    next.retired_field_ids = [...new Set([...next.retired_field_ids, field.id])];
    moved.push(field.id);
    changes.push({ field_id: field.id, from: "order", to: "object" });
  }
  for (const field of standard.fields) {
    if (next.fields.some((entry) => entry.id === field.id)) continue;
    if (next.retired_field_ids.includes(field.id)) {
      conflict(`fields.${field.id}`, "retired_field", "O padrão usa um identificador aposentado nesta área. Defina outro identificador.");
      continue;
    }
    next.fields.push(structuredClone(field)); added.push(field.id);
    changes.push({ field_id: field.id, from: null, to: "order" });
  }
  for (const key of ["stage_field_rules", "list_fields"] as const) {
    if (input.rule_resolution === "keep") continue;
    if (input.rule_resolution === "standard" || equal(current[key] ?? [], before[key] ?? [])) {
      if (standard[key] === undefined) delete next[key];
      else Object.assign(next, { [key]: structuredClone(standard[key]) });
    } else if (!equal(current[key] ?? [], standard[key] ?? []))
      conflict(key, "personalized_rules", "As regras foram personalizadas. Escolha preservar as atuais ou adotar as regras do padrão.");
  }
  next.revision = current.revision + (equal({ ...next, revision: 0 }, { ...current, revision: 0 }) ? 0 : 1);
  try {
    validateWorkTypeChanges(
      { os_work_types: [current], os_object_types: input.existing_object_type ? [object] : [] },
      { os_work_types: [next], os_object_types: [object] },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    conflict("configuration", error.code, error.message);
  }
  return {
    can_apply: conflicts.length === 0, object_action: input.existing_object_type ? "use" : "create",
    work_type: next, object_type: structuredClone(object),
    retained_fields: next.fields.filter((field) => !added.includes(field.id)).map((field) => field.id),
    moved_fields: moved, added_fields: added, conflicts, changes,
    notice: "Ordens existentes e suas cópias não mudam. Nenhum valor é transferido; os dados do objeto devem ser informados no novo cadastro.",
  };
}
