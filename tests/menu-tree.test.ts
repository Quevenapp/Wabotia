import { describe, expect, it } from "vitest";
import {
  menuDescendants,
  menuParentChoices,
  menuPath,
  menuTree,
  menuSnapshot,
  menuListSnapshot,
  moveMenu,
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

describe("menu movement", () => {
  const leaf = (id: string, parent_id?: string): MenuItem => ({
    id,
    label: id,
    type: "content",
    content: `Conteúdo ${id}`,
    parent_id,
  });
  const roots = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
  const siblings = (items: MenuItem[], parent: string | null = null) =>
    items
      .filter((item) => (item.parent_id || null) === parent)
      .map((item) => item.id);
  function frozen(items: MenuItem[]) {
    for (const item of items) {
      for (const value of Object.values(item))
        if (value && typeof value === "object") Object.freeze(value);
      Object.freeze(item);
    }
    return Object.freeze(items) as unknown as MenuItem[];
  }

  it.each([
    ["d", "b", "before", ["a", "d", "b", "c"]],
    ["a", "c", "after", ["b", "c", "a", "d"]],
    ["c", "a", "after", ["a", "c", "b", "d"]],
    ["b", "d", "before", ["a", "c", "b", "d"]],
  ] as const)(
    "moves %s %s %s among four siblings",
    (source, target, placement, expected) => {
      const original = frozen([...roots]);
      expect(siblings(moveMenu(original, source, target, placement))).toEqual(
        expected,
      );
      expect(siblings(original)).toEqual(["a", "b", "c", "d"]);
    },
  );

  it("moves a complete interleaved branch without changing descendant order or data", () => {
    const original = frozen([
      {
        id: "help",
        label: "Suporte",
        type: "submenu",
        enabled: false,
        trigger: "manual",
        line_ids: ["line-a"],
      },
      { id: "sales", label: "Comercial", type: "submenu" },
      {
        id: "device",
        label: "Equipamentos",
        type: "submenu",
        parent_id: "help",
      },
      leaf("quote", "sales"),
      { ...leaf("printer", "device"), enabled: false, line_ids: ["line-b"] },
      leaf("news"),
      leaf("human", "help"),
    ]);
    const before = menuListSnapshot(original);
    const moved = moveMenu(original, "help", "sales", "after");
    expect(moved.map((item) => item.id)).toEqual([
      "sales",
      "quote",
      "help",
      "device",
      "printer",
      "human",
      "news",
    ]);
    expect(siblings(moved)).toEqual(["sales", "help", "news"]);
    expect(siblings(moved, "help")).toEqual(["device", "human"]);
    for (const item of original)
      expect(moved.find((row) => row.id === item.id)).toBe(item);
    expect(menuListSnapshot(original)).toBe(before);
  });

  it("anchors after a target before its next sibling even when target descendants lie later", () => {
    const original = [
      { id: "a", label: "A", type: "submenu" },
      leaf("b"),
      leaf("c"),
      leaf("a-child", "a"),
    ];
    const moved = moveMenu(original, "c", "a", "after");
    expect(siblings(moved)).toEqual(["a", "c", "b"]);
    expect(siblings(moved, "a")).toEqual(["a-child"]);
  });

  it("reparents a branch as the last child and then as the last root", () => {
    const original = frozen([...items, leaf("quote", "sales"), leaf("news")]);
    const moved = moveMenu(original, "help", "sales", "inside");
    expect(siblings(moved)).toEqual(["sales", "news"]);
    expect(siblings(moved, "sales")).toEqual(["quote", "help"]);
    expect(siblings(moved, "help")).toEqual(["device", "human"]);
    expect(siblings(moved, "device")).toEqual(["printer"]);
    expect(moved.find((item) => item.id === "help")).toEqual({
      ...original[0],
      parent_id: "sales",
    });
    expect(moved.find((item) => item.id === "printer")).toBe(original[3]);
    const rooted = moveMenu(moved, "help", null, "inside");
    expect(siblings(rooted)).toEqual(["sales", "news", "help"]);
    expect(rooted.find((item) => item.id === "help")?.parent_id).toBeNull();
    expect(siblings(rooted, "help")).toEqual(["device", "human"]);
    expect(original[0].parent_id).toBeUndefined();
  });

  it.each(["before", "after"] as const)(
    "adopts a target sibling's parent for %s",
    (placement) => {
      const moved = moveMenu(
        [...items, leaf("quote", "sales")],
        "device",
        "quote",
        placement,
      );
      expect(siblings(moved, "sales")).toEqual(
        placement === "before" ? ["device", "quote"] : ["quote", "device"],
      );
      expect(siblings(moved, "help")).toEqual(["human"]);
      expect(moved.find((item) => item.id === "printer")?.parent_id).toBe(
        "device",
      );
    },
  );

  it("keeps the exact array for positions that already match, without regrouping descendants", () => {
    const original = frozen([...items]);
    expect(moveMenu(original, "help", "sales", "before")).toBe(original);
    expect(moveMenu(original, "sales", "help", "after")).toBe(original);
    expect(moveMenu(original, "sales", null, "inside")).toBe(original);
    expect(moveMenu(original, "human", "help", "inside")).toBe(original);
    expect(moveMenu(original, "human", "device", "after")).toBe(original);
  });

  it.each([
    ["help", "help", "before"],
    ["help", "help", "after"],
    ["help", "help", "inside"],
    ["help", "device", "inside"],
    ["help", "printer", "before"],
    ["help", "human", "after"],
    ["missing", "help", "inside"],
    ["help", "missing", "inside"],
    ["sales", "human", "inside"],
    ["help", null, "before"],
    ["help", null, "after"],
  ] as const)(
    "rejects invalid move %s to %s (%s) without changing inputs",
    (source, target, placement) => {
      const original = frozen([...items]),
        before = menuListSnapshot(original);
      expect(() => moveMenu(original, source, target, placement)).toThrow(
        Error,
      );
      expect(menuListSnapshot(original)).toBe(before);
    },
  );

  it("rejects cyclic or missing destination ancestors and repeated identifiers", () => {
    const original = [
      leaf("source"),
      { id: "a", label: "A", type: "submenu", parent_id: "b" },
      { id: "b", label: "B", type: "submenu", parent_id: "a" },
      leaf("orphan", "missing"),
    ];
    expect(() => moveMenu(original, "source", "a", "inside")).toThrow("ciclo");
    expect(() => moveMenu(original, "source", "orphan", "before")).toThrow(
      "pai inválido",
    );
    expect(() => moveMenu([...roots, roots[0]], "a", "b", "before")).toThrow(
      "repetidos",
    );
    expect(() => moveMenu(roots, "a", "b", "invalid" as any)).toThrow(
      "Posição",
    );
  });

  it("detects changes in full list order and nested data while normalizing legacy defaults", () => {
    const original = [...items];
    expect(menuListSnapshot(original)).toBe(
      menuListSnapshot(
        original.map((item) => ({
          ...item,
          parent_id: item.parent_id || null,
          enabled: true,
          trigger: "automatic",
          line_ids: [],
        })),
      ),
    );
    expect(menuListSnapshot(original)).not.toBe(
      menuListSnapshot(moveMenu(original, "sales", "help", "before")),
    );
    expect(menuListSnapshot(original)).not.toBe(
      menuListSnapshot(
        original.map((item) =>
          item.id === "human" ? { ...item, line_ids: ["line-a"] } : item,
        ),
      ),
    );
    expect(menuListSnapshot(original)).not.toBe(
      menuListSnapshot(
        original.map((item) =>
          item.id === "printer" ? { ...item, content: "Novo conteúdo" } : item,
        ),
      ),
    );
  });
});
