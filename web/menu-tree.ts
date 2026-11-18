export type MenuItem = {
  id: string;
  label: string;
  type: string;
  parent_id?: string | null;
  [key: string]: any;
};
export type MenuTreeNode = {
  item: MenuItem;
  children: MenuTreeNode[];
  detached: boolean;
};

export function menuSnapshot(item: MenuItem): string {
  const normalized = {
    ...item,
    parent_id: item.parent_id || null,
    enabled: item.enabled !== false,
    trigger: item.trigger || "automatic",
    line_ids: item.line_ids || [],
  };
  function stable(value: any): any {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, stable(value[key])]),
      );
    return value;
  }
  return JSON.stringify(stable(normalized));
}

export function menuListSnapshot(items: MenuItem[]): string {
  return `[${items.map(menuSnapshot).join(",")}]`;
}

/** Destinos do núcleo no editor de menus (fora submenu). */
export const coreMenuTypes: { type: string; label: string }[] = [
  { type: "human", label: "Equipe humana" },
  { type: "bot", label: "Bot" },
  { type: "app", label: "Aplicativo" },
  { type: "link", label: "Conteúdo com link" },
  { type: "content", label: "Mensagem informativa" },
  { type: "protocols", label: "Consultar protocolos" },
  { type: "ticket", label: "Abrir protocolo" },
  { type: "survey", label: "Avaliar atendimento" },
];

/**
 * Opções do destino de um item: as do núcleo, as dos módulos ligados
 * (GET /modules, menu_item_types) e sempre o tipo atual do item, para que
 * salvar nunca troque o tipo de um item de módulo sem a pessoa escolher.
 */
export function menuTypeOptions(
  modules: {
    enabled?: boolean;
    menu_item_types?: { type: string; label: string }[];
  }[],
  current?: string,
) {
  const options = [...coreMenuTypes];
  for (const module of modules)
    if (module.enabled !== false)
      for (const type of module.menu_item_types || [])
        if (!options.some((o) => o.type === type.type)) options.push(type);
  if (current && current !== "submenu" && !options.some((o) => o.type === current)) {
    const known = modules
      .flatMap((m) => m.menu_item_types || [])
      .find((t) => t.type === current);
    options.push({
      type: current,
      label: known ? `${known.label} (módulo desligado)` : current,
    });
  }
  return options;
}

export type MenuPlacement = "before" | "after" | "inside";

export function moveMenu(
  items: MenuItem[],
  sourceId: string,
  targetId: string | null,
  placement: MenuPlacement,
): MenuItem[] {
  if (!["before", "after", "inside"].includes(placement))
    throw new Error("Posição de movimentação inválida.");
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length)
    throw new Error("Os menus têm identificadores repetidos.");
  const source = byId.get(sourceId);
  if (!source)
    throw new Error("A opção que você tentou mover não foi encontrada.");
  const target = targetId === null ? null : byId.get(targetId);
  if (targetId !== null && !target)
    throw new Error("O destino da movimentação não foi encontrado.");
  if (targetId === null && placement !== "inside")
    throw new Error("O menu principal só aceita movimentação para o final.");
  if (sourceId === targetId)
    throw new Error("Escolha um destino diferente da própria opção.");
  const branchIds = menuDescendants(items, sourceId);
  branchIds.add(sourceId);
  if (targetId !== null && branchIds.has(targetId))
    throw new Error(
      "Uma opção não pode ser movida para dentro do próprio ramo.",
    );
  if (placement === "inside" && target && target.type !== "submenu")
    throw new Error("Somente submenus podem receber opções.");

  const parent = placement === "inside" ? targetId : target!.parent_id || null;
  const ancestors = new Set<string>();
  let ancestorId = parent;
  while (ancestorId) {
    if (ancestors.has(ancestorId) || branchIds.has(ancestorId))
      throw new Error("O destino contém um ciclo na hierarquia.");
    ancestors.add(ancestorId);
    const ancestor = byId.get(ancestorId);
    if (!ancestor || ancestor.type !== "submenu")
      throw new Error("O destino possui um menu pai inválido.");
    ancestorId = ancestor.parent_id || null;
  }

  const siblings = items.filter((item) => (item.parent_id || null) === parent);
  if ((source.parent_id || null) === parent) {
    const from = siblings.findIndex((item) => item.id === sourceId);
    const to = siblings.findIndex((item) => item.id === targetId);
    if (
      (placement === "inside" && from === siblings.length - 1) ||
      (placement === "before" && from === to - 1) ||
      (placement === "after" && from === to + 1)
    )
      return items;
  }

  const remaining = items.filter((item) => !branchIds.has(item.id));
  const branch = items
    .filter((item) => branchIds.has(item.id))
    .map((item) =>
      item.id === sourceId && (item.parent_id || null) !== parent
        ? { ...item, parent_id: parent }
        : item,
    );
  // The flat list determines sibling order, but descendants may be interleaved
  // with other branches. Anchor after a target at its next sibling, not after
  // the last descendant, which might lie beyond that sibling in the list.
  let anchor = placement === "before" ? targetId : null;
  if (placement === "after") {
    const peers = remaining.filter(
      (item) => (item.parent_id || null) === parent,
    );
    const index = peers.findIndex((item) => item.id === targetId);
    anchor = peers[index + 1]?.id || null;
  }
  const index =
    anchor === null
      ? remaining.length
      : remaining.findIndex((item) => item.id === anchor);
  return [...remaining.slice(0, index), ...branch, ...remaining.slice(index)];
}

export function menuDescendants(items: MenuItem[], id: string): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop();
    for (const item of items)
      if (item.parent_id === parent && item.id !== id && !found.has(item.id)) {
        found.add(item.id);
        pending.push(item.id);
      }
  }
  return found;
}

export function menuPath(items: MenuItem[], id?: string | null): string {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = id ? items.find((item) => item.id === id) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.label);
    current = items.find((item) => item.id === current!.parent_id);
  }
  return ["Menu principal", ...path].join(" › ");
}

export function menuParentChoices(items: MenuItem[], id: string) {
  const descendants = menuDescendants(items, id);
  return items.filter(
    (item) =>
      item.type === "submenu" && item.id !== id && !descendants.has(item.id),
  );
}

export function menuTree(items: MenuItem[]): MenuTreeNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const used = new Set<string>();
  function node(item: MenuItem, detached = false): MenuTreeNode {
    used.add(item.id);
    return {
      item,
      detached,
      children: items
        .filter((child) => child.parent_id === item.id && !used.has(child.id))
        .map((child) => node(child)),
    };
  }
  const roots = items
    .filter((item) => !item.parent_id || !byId.has(item.parent_id))
    .map((item) => node(item, !!item.parent_id));
  // Keep old malformed branches visible so an administrator can repair them.
  for (const item of items)
    if (!used.has(item.id)) roots.push(node(item, true));
  return roots;
}

/** OS antiga sem referência equivale ao tipo embutido. */
export function hasWorkMenu(items: { type?: string; type_id?: string }[], type: string, typeId = "service_order") {
  return items.some(item => item.type === type && (item.type_id || "service_order") === typeId);
}
