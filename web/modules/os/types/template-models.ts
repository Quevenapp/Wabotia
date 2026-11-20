import type { AreaTemplate, CustomWorkType, WorkField } from "../work-contracts";

/** Os IDs publicados pelo aplicador conservam a origem mesmo após editar o nome. */
export function templateSource(type: CustomWorkType, templates: readonly AreaTemplate[]) {
  for (const template of templates) {
    const standard = template.work_types.find(
      (candidate) => type.id === `area_${template.id}__${candidate.id}`,
    );
    if (standard) return { template, type: standard };
  }
  return undefined;
}

export function missingTemplateFields(type: CustomWorkType, standard: CustomWorkType): WorkField[] {
  const used = new Set([...type.fields.map((field) => field.id), ...type.retired_field_ids]);
  return standard.fields.filter((field) => !used.has(field.id));
}

function appendFields(type: CustomWorkType, fields: WorkField[]): CustomWorkType {
  if (!fields.length) return type;
  const next = { ...type, fields: [...type.fields, ...structuredClone(fields)] };
  if (next.fields.length > 24)
    throw new Error("O modelo admite até 24 campos. Revise os campos antes de adicionar.");
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 12 * 1024)
    throw new Error("O modelo excederia 12 KiB. Revise o conteúdo antes de adicionar.");
  return next;
}

/** Não altera campos existentes nem ressuscita IDs aposentados pelo administrador. */
export function addMissingTemplateFields(type: CustomWorkType, standard: CustomWorkType): CustomWorkType {
  return appendFields(type, missingTemplateFields(type, standard));
}

/** Novo campo vazio: jamais muda a classificação nem copia os valores da placa antiga. */
export function publicPlateField(type: CustomWorkType): WorkField | undefined {
  if (!type.fields.some((field) => field.id === "placa" && field.sensitive) ||
    type.fields.some((field) => field.id === "placa_visivel") ||
    type.retired_field_ids.includes("placa_visivel")) return undefined;
  return {
    id: "placa_visivel", label: "Placa", help: "Identifica o veículo no atendimento. Novo campo visível ao cliente.",
    kind: "text", multiline: false, max_length: 10,
    required: false, client_visible: true, sensitive: false,
  };
}

export function addPublicPlateField(type: CustomWorkType): CustomWorkType {
  const field = publicPlateField(type);
  return appendFields(type, field ? [field] : []);
}
