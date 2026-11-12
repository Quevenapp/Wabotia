import { describe, expect, it } from "vitest";
import {
  menuDescendants,
  menuParentChoices,
  menuPath,
  menuTree,
  menuSnapshot,
  type MenuItem,
} from "../web/menu-tree";

const items: MenuItem[] = [
  { id: "help", label: "Suporte", type: "submenu" },
  { id: "sales", label: "Comercial", type: "submenu" },
  { id: "device", label: "Equipamentos", type: "submenu", parent_id: "help" },
  { id: "printer", label: "Impressora", type: "content", parent_id: "device" },
  { id: "human", label: "Equipe", type: "human", parent_id: "help" },
];
describe("menu hierarchy editor", () => {
  it("compares persisted edits without confusing omitted legacy defaults or key order", () => {
    const original = { id: "menu", label: "Suporte", type: "submenu" };
    expect(menuSnapshot(original)).toBe(
      menuSnapshot({
        label: "Suporte",
        type: "submenu",
        id: "menu",
        parent_id: null,
        enabled: true,
        trigger: "automatic",
        line_ids: [],
      }),
    );
    expect(menuSnapshot(original)).not.toBe(
      menuSnapshot({ ...original, label: "Suporte novo" }),
    );
  });
  it("groups children at all depths while preserving sibling order", () => {
    const tree = menuTree(items);
    expect(tree.map((node) => node.item.id)).toEqual(["help", "sales"]);
    expect(tree[0].children.map((node) => node.item.id)).toEqual([
      "device",
      "human",
    ]);
    expect(tree[0].children[0].children[0].item.id).toBe("printer");
    expect(menuPath(items, "printer")).toBe(
      "Menu principal › Suporte › Equipamentos › Impressora",
    );
  });
  it("excludes self and descendant submenus from move destinations", () => {
    expect(menuParentChoices(items, "help").map((item) => item.id)).toEqual([
      "sales",
    ]);
    expect(menuDescendants(items, "help")).toEqual(
      new Set(["device", "human", "printer"]),
    );
  });
  it("keeps malformed orphan and cyclic items visible without recursion loops", () => {
    const malformed = [
      { id: "orphan", label: "Órfão", type: "human", parent_id: "missing" },
      { id: "a", label: "A", type: "submenu", parent_id: "b" },
      { id: "b", label: "B", type: "submenu", parent_id: "a" },
    ];
    const tree = menuTree(malformed);
    expect(tree.map((node) => node.item.id)).toEqual(["orphan", "a"]);
    expect(tree.every((node) => node.detached)).toBe(true);
    expect(tree[1].children[0].item.id).toBe("b");
  });
});
