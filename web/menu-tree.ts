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
