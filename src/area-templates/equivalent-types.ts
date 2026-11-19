import type { CustomWorkType } from "../modules/os/contracts";

const normalized = (label: string) => label.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");

/** Aviso de possível duplicação, sem fundir tipos, alterar IDs ou impedir a escolha. */
export function equivalentWorkTypes(type: CustomWorkType, existing: readonly CustomWorkType[], templateId: string) {
  const targetId = `area_${templateId}__${type.id}`;
  return existing.filter((candidate) => candidate.id !== targetId && (
    candidate.id.endsWith(`__${type.id}`) || (
      normalized(candidate.labels.plural) === normalized(type.labels.plural) &&
      normalized(candidate.labels.item) === normalized(type.labels.item)
    )
  ));
}
