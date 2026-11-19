import { useApp } from "../../app/AppContext";
import { useWorkApi, useWorkResource } from "./work-hooks";
import { hasCustomTypes, workCollectionLabel } from "./work-vocabulary";
import { canOpenPage } from "../../workspace-navigation";
import type { WorkTypeView } from "./work-contracts";

export const activeNavigationTypes = (types: readonly WorkTypeView[]) =>
  types.filter((type) => !type.archived).sort((a, b) => a.id.localeCompare(b.id));

/** Somente a casa consulta o catálogo autorizado; nunca busca registros/contadores. */
export function useWorkNavigation() {
  const app = useApp(),
    api = useWorkApi();
  const catalog = useWorkResource(
    app.statusLoaded && app.modules?.os === true && app.profile &&
      canOpenPage("work", app.me.role, app.modules, app.me.access)
      ? JSON.stringify([app.root, app.me.id, app.me.role, app.me.access,
        app.contextGeneration, app.status.settings_revision || ""])
      : null,
    () => api.types(),
  );
  const types = activeNavigationTypes(catalog.data?.data || []);
  return {
    types,
    hasCustom: hasCustomTypes(types),
    label: workCollectionLabel(types, app.settings.os_vocabulary),
    railLabel: workCollectionLabel(types, app.settings.os_vocabulary, true),
    tasksEnabled: types.some((type) => type.features.tasks),
  };
}
