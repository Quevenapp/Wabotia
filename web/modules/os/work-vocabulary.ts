import type { WorkTypeView, OsVocabulary } from "./work-contracts";
export const hasCustomTypes = (types: Pick<WorkTypeView, "kind">[]) =>
  types.some((type) => type.kind === "custom");
export function workCollectionLabel(
  types: WorkTypeView[],
  vocabulary?: Partial<OsVocabulary>,
  rail = false,
) {
  if (!hasCustomTypes(types)) return rail ? "Ordens" : "Ordens de serviço";
  const active = types.filter((type) => !type.archived);
  return active.length === 1
    ? active[0].labels.plural
    : vocabulary?.collection_label || "Trabalhos";
}
