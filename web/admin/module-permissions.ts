// Tela de pessoa → permissões por módulo: regras puras da seção de cada
// módulo (nível rápido, "Personalizar" ação por ação, resumo na lista). O
// modelo e os nomes das ações vêm de src/security-modules.ts (o catálogo de
// GET /access traz as ações de cada módulo); aqui só se monta a lista.
import {
  LEVEL_LABELS,
  actionItem,
  actionsForLevel,
  grantedActions,
  isErpModule,
  levelItem,
  levelOfActions,
  migrateErpAccess,
  parsePermissionItem,
  storedLevel,
  type PermissionLevel,
} from "../../src/security-modules";

export type ShownLevel = PermissionLevel | "personalizado";
export { LEVEL_LABELS };

/** Níveis da caixa de escolha, na ordem da tela. */
export const LEVEL_OPTIONS: [ShownLevel, string][] = [
  ["nenhum", LEVEL_LABELS.nenhum],
  ["ver", LEVEL_LABELS.ver],
  ["operar", LEVEL_LABELS.operar],
  ["administrar", LEVEL_LABELS.administrar],
  ["personalizado", "Personalizar…"],
];

/**
 * Lista ao abrir a tela: o papel antigo do ERP vira os níveis equivalentes
 * (ao salvar, a pessoa passa ao modelo novo sem perder nada).
 */
export const prepareAccess = (list: readonly string[]) => migrateErpAccess(list);

const ownItem = (moduleId: string) => (item: string) => {
  const parsed = parsePermissionItem(item);
  return item === moduleId || parsed?.module === moduleId;
};

/** A pessoa alcança o módulo pela regra antiga ("*", o módulo ou um papel dele)? */
const legacyReach = (list: readonly string[], moduleId: string) =>
  !isErpModule(moduleId) &&
  (list.includes("*") || list.includes(moduleId) || list.some((id) => id.startsWith(moduleId + ":")));

/** Ações que a pessoa tem no módulo (sem item novo: a regra antiga). */
export function moduleActions(list: readonly string[], moduleId: string): string[] {
  const granted = grantedActions(list, moduleId);
  if (granted) return granted;
  if (isErpModule(moduleId)) return [];
  return legacyReach(list, moduleId) ? actionsForLevel(moduleId, "administrar") : [];
}

/** Nível mostrado: o guardado, o que as ações formam, ou "Personalizado". */
export function moduleLevel(list: readonly string[], moduleId: string): ShownLevel {
  const stored = storedLevel(list, moduleId);
  if (stored) return stored;
  return levelOfActions(moduleId, moduleActions(list, moduleId)) ?? "personalizado";
}

/**
 * Tira os itens do módulo e, no ERP, garante "Sem acesso" nas outras partes
 * ainda sem item (o ERP passa inteiro ao modelo novo, e o papel antigo sai:
 * o servidor deriva o papel do motor).
 */
function withoutModule(list: readonly string[], moduleId: string, erpModules: readonly string[]) {
  let next = list.filter((item) => !ownItem(moduleId)(item));
  if (isErpModule(moduleId)) {
    next = next.filter((item) => !item.startsWith("erp:"));
    for (const id of erpModules)
      if (id !== moduleId && !next.some(ownItem(id))) next.push(levelItem(id, "nenhum"));
  }
  return next;
}

/** Escolhe o nível rápido do módulo. */
export function setModuleLevel(
  list: readonly string[],
  moduleId: string,
  level: PermissionLevel,
  erpModules: readonly string[] = [],
): string[] {
  return [...withoutModule(list, moduleId, erpModules), levelItem(moduleId, level)];
}

/** Marca as ações uma a uma; se formarem um nível, guarda o nível. */
export function setModuleActions(
  list: readonly string[],
  moduleId: string,
  actions: readonly string[],
  erpModules: readonly string[] = [],
): string[] {
  const level = levelOfActions(moduleId, actions);
  if (level) return setModuleLevel(list, moduleId, level, erpModules);
  return [...withoutModule(list, moduleId, erpModules), ...actions.map((id) => actionItem(moduleId, id))];
}

/** Liga ou desliga uma ação no "Personalizar". */
export function toggleModuleAction(
  list: readonly string[],
  moduleId: string,
  action: string,
  on: boolean,
  order: readonly string[],
  erpModules: readonly string[] = [],
): string[] {
  const current = new Set(moduleActions(list, moduleId));
  if (on) current.add(action);
  else current.delete(action);
  return setModuleActions(list, moduleId, order.filter((id) => current.has(id)), erpModules);
}

/** Resumo de um módulo para a lista de pessoas ("Financeiro: Só ver"). */
export function moduleSummary(list: readonly string[], moduleId: string, label: string): string | null {
  const level = moduleLevel(list, moduleId);
  if (level === "nenhum") return null;
  return `${label}: ${LEVEL_LABELS[level]}`;
}

/** Algum módulo do ERP aberto, mas Cadastros sem acesso: avisar. */
export function cadastrosHint(list: readonly string[], erpModules: readonly string[]): boolean {
  return (
    erpModules.includes("erp") &&
    moduleActions(list, "erp").length === 0 &&
    erpModules.some((id) => id !== "erp" && moduleActions(list, id).length > 0)
  );
}
