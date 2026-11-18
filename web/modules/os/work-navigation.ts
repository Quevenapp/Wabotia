import { useApp } from "../../app/AppContext";
import { useWorkApi, useWorkResource } from "./work-hooks";
import { hasCustomTypes, workCollectionLabel } from "./work-vocabulary";
/** Compartilhado com Gestão; Shell e Mais podem adotar este resolvedor. */
export function useWorkNavigation() {
  const app = useApp(),
    api = useWorkApi();
  const catalog = useWorkResource(
    app.moduleOn("os") && app.profile
      ? app.root + "/navigation-types/" + (app.status.settings_revision || "")
      : null,
    () => api.types(true),
  );
  const types = catalog.data?.data || [];
  return {
    hasCustom: hasCustomTypes(types),
    label: workCollectionLabel(types, app.settings.os_vocabulary),
    railLabel: workCollectionLabel(types, app.settings.os_vocabulary, true),
    tasksEnabled: types.some((type) => type.features.tasks),
  };
}
