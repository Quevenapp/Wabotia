import type { WorkTypeView, OsVocabulary } from "./work-contracts";
export const hasCustomTypes = (types: Pick<WorkTypeView, "kind">[]) =>
  types.some((type) => type.kind === "custom");
export function workCollectionLabel(
  _types: WorkTypeView[],
  vocabulary?: Partial<OsVocabulary>,
  _rail = false,
) {
  return vocabulary?.collection_label || "Ordens de serviço";
}
