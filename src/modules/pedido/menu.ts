// Pedido: cardápio (categorias, itens, grupos de adicionais e imagens do
// cardápio) e o catálogo entregue à página de carrinho do passo web. Os
// limites seguem os da página (src/web-cart.ts), então o cardápio salvo
// sempre vira um catálogo válido. Lê a tabela de mídia do núcleo (fotos);
// não grava em tabelas do núcleo.
import { all, batch, exec, one, cachedAll } from "../../db";
import {
  ApiError,
  type Actor,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import { admin } from "../../security";
import type { ModuleContext } from "../api";

export const MENU_LIMITS = {
  categories: 30,
  itemsPerCategory: 100,
  items: 300,
  groups: 100,
  groupsPerItem: 10,
  options: 30,
  images: 10,
} as const;

export interface MenuOption {
  id: string;
  name: string;
  price_cents: number;
  available: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,60}$/;

export const text = (
  value: unknown,
  max: number,
  what: string,
  required = false,
): string => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  const out = (value as string).trim();
  requireValue(!required || out, `Informe ${what}.`);
  return out;
};

export const cents = (value: unknown, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 10_000_000,
    `${what[0].toUpperCase()}${what.slice(1)} em centavos (inteiro de 0 a 10.000.000).`,
  );
  return value as number;
};

const flag = (value: unknown, what: string) => {
  requireValue(typeof value === "boolean", `${what}: verdadeiro ou falso.`);
  return value as boolean;
};

const position = (value: unknown) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 10_000,
    "Posição: inteiro de 0 a 10.000.",
  );
  return value as number;
};

const notFound = (what: string) =>
  new ApiError(404, "not_found", `${what} não encontrado no cardápio.`);

// ---------------------------------------------------------------------------
// Formatos da API (docs/API.md, Pedido)

export const categoryView = (row: any) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  position: row.position,
  created: row.created,
  updated: row.updated,
});

export const itemView = (row: any, groupIds: string[] = []) => ({
  id: row.id,
  category_id: row.category_id,
  name: row.name,
  description: row.description,
  price_cents: row.price_cents,
  photo_media_id: row.photo_media_id || null,
  image_url: row.image_url || null,
  available: !!row.available,
  max_quantity: row.max_quantity,
  retailer_id: row.retailer_id || null,
  position: row.position,
  group_ids: groupIds,
  created: row.created,
  updated: row.updated,
});

export const groupView = (row: any) => ({
  id: row.id,
  name: row.name,
  min: row.min,
  max: row.max,
  options: json(row.options, []) as MenuOption[],
  created: row.created,
  updated: row.updated,
});

async function itemGroupIds(ctx: ModuleContext, itemIds?: string[]) {
  const rows = await cachedAll(
    ctx.env,
    "SELECT item_id,group_id FROM pedido_item_groups WHERE profile_id=? ORDER BY position,rowid",
    ctx.profile,
  );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (itemIds && !itemIds.includes(row.item_id)) continue;
    map.set(row.item_id, [...(map.get(row.item_id) || []), row.group_id]);
  }
  return map;
}

/** GET pedido/menu: o cardápio inteiro, na ordem de exibição. */
export async function loadMenu(ctx: ModuleContext) {
  const [categories, items, groups, images, links] = await Promise.all([
    cachedAll(
      ctx.env,
      "SELECT * FROM pedido_categories WHERE profile_id=? ORDER BY position,created,id",
      ctx.profile,
    ),
    cachedAll(
      ctx.env,
      "SELECT * FROM pedido_items WHERE profile_id=? ORDER BY position,created,id",
      ctx.profile,
    ),
    cachedAll(
      ctx.env,
      "SELECT * FROM pedido_groups WHERE profile_id=? ORDER BY name COLLATE NOCASE,created,id",
      ctx.profile,
    ),
    menuImages(ctx),
    itemGroupIds(ctx),
  ]);
  return {
    categories: categories.map((category) => ({
      ...categoryView(category),
      items: items
        .filter((item) => item.category_id === category.id)
        .map((item) => itemView(item, links.get(item.id) || [])),
    })),
    groups: groups.map(groupView),
    images,
  };
}
export type Menu = Awaited<ReturnType<typeof loadMenu>>;

export async function menuImages(ctx: ModuleContext) {
  return (
    await cachedAll(
      ctx.env,
      "SELECT i.media_id,i.caption,i.position,m.name,m.type FROM pedido_menu_images i LEFT JOIN media m ON m.id=i.media_id AND m.profile_id=i.profile_id WHERE i.profile_id=? ORDER BY i.position,i.rowid",
      ctx.profile,
    )
  ).map((row) => ({
    media_id: row.media_id,
    caption: row.caption,
    position: row.position,
    name: row.name || "",
    type: row.type || "",
  }));
}

async function changed(
  ctx: ModuleContext,
  actor: Actor,
  what: "category" | "item" | "group" | "images",
  id: string,
  action: "saved" | "deleted" | "availability",
  extra: Record<string, unknown> = {},
) {
  await ctx.publish("pedido.menu_changed", id, {
    what,
    id,
    action,
    actor: actor.id,
    ...extra,
  });
}

/** Foto da área (tabela media do núcleo, só leitura): JPG ou PNG. */
async function photo(ctx: ModuleContext, value: unknown, what: string) {
  if (value === undefined || value === null || value === "") return null;
  requireValue(typeof value === "string", `${what} inválida.`);
  const row = await one(
    ctx.env,
    "SELECT id,type FROM media WHERE id=? AND profile_id=?",
    value,
    ctx.profile,
  );
  requireValue(
    row && /^image\/(jpeg|png)(;|$)/i.test(row.type),
    `${what}: envie uma imagem JPG ou PNG pelo envio de arquivos desta área.`,
  );
  return row.id as string;
}

const nextPosition = async (ctx: ModuleContext, sql: string, ...args: any[]) =>
  ((await one<{ p: number | null }>(ctx.env, sql, ...args))?.p ?? -1) + 1;

// ---------------------------------------------------------------------------
// Categorias

export async function saveCategory(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM pedido_categories WHERE id=? AND profile_id=?",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing) throw notFound("Categoria");
  const has = (key: string) => Object.hasOwn(data, key);
  const name =
    has("name") || !existing
      ? text(data.name, 60, "o nome da categoria", true)
      : existing.name;
  const description = has("description")
    ? text(data.description, 300, "a descrição da categoria")
    : existing?.description || "";
  const at = now();
  if (existing) {
    const pos = has("position") ? position(data.position) : existing.position;
    await exec(
      ctx.env,
      "UPDATE pedido_categories SET name=?,description=?,position=?,updated=? WHERE id=? AND profile_id=?",
      name,
      description,
      pos,
      at,
      existing.id,
      ctx.profile,
    );
  } else {
    const count = await one<{ n: number }>(
      ctx.env,
      "SELECT count(*) n FROM pedido_categories WHERE profile_id=?",
      ctx.profile,
    );
    requireValue(
      (count?.n || 0) < MENU_LIMITS.categories,
      `Cardápio: até ${MENU_LIMITS.categories} categorias.`,
    );
    const pos = has("position")
      ? position(data.position)
      : await nextPosition(
          ctx,
          "SELECT max(position) p FROM pedido_categories WHERE profile_id=?",
          ctx.profile,
        );
    data = { ...data, id: uid() };
    await exec(
      ctx.env,
      "INSERT INTO pedido_categories(id,profile_id,name,description,position,created,updated) VALUES(?,?,?,?,?,?,?)",
      data.id,
      ctx.profile,
      name,
      description,
      pos,
      at,
      at,
    );
  }
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_categories WHERE id=?",
    existing?.id || data.id,
  );
  await changed(ctx, actor, "category", row.id, "saved");
  return categoryView(row);
}

export async function deleteCategory(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  admin(actor);
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_categories WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Categoria");
  const items = await one<{ n: number }>(
    ctx.env,
    "SELECT count(*) n FROM pedido_items WHERE profile_id=? AND category_id=?",
    ctx.profile,
    row.id,
  );
  if (items?.n)
    throw new ApiError(
      409,
      "category_not_empty",
      `A categoria "${row.name}" ainda tem ${items.n === 1 ? "1 item" : `${items.n} itens`}. Mova ou exclua os itens antes.`,
    );
  await exec(
    ctx.env,
    "DELETE FROM pedido_categories WHERE id=? AND profile_id=?",
    row.id,
    ctx.profile,
  );
  await changed(ctx, actor, "category", row.id, "deleted");
  return { id: row.id, deleted: true };
}

// ---------------------------------------------------------------------------
// Itens

async function validGroupIds(ctx: ModuleContext, value: unknown) {
  requireValue(
    Array.isArray(value) && value.length <= MENU_LIMITS.groupsPerItem,
    `Item: até ${MENU_LIMITS.groupsPerItem} grupos de adicionais.`,
  );
  const ids = value as unknown[];
  requireValue(
    ids.every((id) => typeof id === "string") &&
      new Set(ids).size === ids.length,
    "Item: grupos de adicionais inválidos ou repetidos.",
  );
  if (!ids.length) return [];
  const found = await all(
    ctx.env,
    `SELECT id FROM pedido_groups WHERE profile_id=? AND id IN (${ids.map(() => "?").join(",")})`,
    ctx.profile,
    ...ids,
  );
  requireValue(
    found.length === ids.length,
    "Item: grupo de adicionais não encontrado.",
  );
  return ids as string[];
}

export async function saveItem(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM pedido_items WHERE id=? AND profile_id=?",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing) throw notFound("Item");
  const has = (key: string) => Object.hasOwn(data, key) || !existing;
  const out: Record<string, any> = existing ? { ...existing } : {};
  if (has("category_id")) {
    requireValue(
      typeof data.category_id === "string",
      "Item: informe a categoria (category_id).",
    );
    const category = await one(
      ctx.env,
      "SELECT id FROM pedido_categories WHERE id=? AND profile_id=?",
      data.category_id,
      ctx.profile,
    );
    if (!category) throw notFound("Categoria");
    out.category_id = category.id;
  }
  if (has("name")) out.name = text(data.name, 80, "o nome do item", true);
  if (has("description"))
    out.description = text(data.description, 300, "a descrição do item");
  if (has("price_cents"))
    out.price_cents = cents(data.price_cents, "o preço do item");
  if (has("photo_media_id"))
    out.photo_media_id = await photo(ctx, data.photo_media_id, "Foto do item");
  if (has("image_url")) {
    const url = text(data.image_url, 500, "o endereço da foto pública");
    requireValue(
      !url || /^https:\/\/[^\s"'<>]+$/.test(url),
      "Foto pública: use um endereço HTTPS.",
    );
    out.image_url = url || null;
  }
  if (has("available"))
    out.available =
      data.available === undefined
        ? 1
        : flag(data.available, "Disponível")
          ? 1
          : 0;
  if (has("max_quantity")) {
    const max = data.max_quantity ?? 20;
    requireValue(
      Number.isInteger(max) && max >= 1 && max <= 99,
      "Item: quantidade máxima por pedido de 1 a 99.",
    );
    out.max_quantity = max;
  }
  if (has("retailer_id")) {
    const retailer = text(
      data.retailer_id,
      100,
      "o código do item no catálogo da Meta (retailer_id)",
    );
    requireValue(
      !retailer || !/[\u0000-\u001f]/.test(retailer),
      "Código do catálogo da Meta inválido.",
    );
    if (retailer) {
      const taken = await one(
        ctx.env,
        "SELECT id,name FROM pedido_items WHERE profile_id=? AND retailer_id=? AND id<>?",
        ctx.profile,
        retailer,
        existing?.id || "",
      );
      if (taken)
        throw new ApiError(
          409,
          "retailer_id_taken",
          `O código ${retailer} do catálogo da Meta já está no item "${taken.name}".`,
        );
    }
    out.retailer_id = retailer || null;
  }
  const groupIds = Object.hasOwn(data, "group_ids")
    ? await validGroupIds(ctx, data.group_ids)
    : null;
  const at = now();
  if (!existing || out.category_id !== existing.category_id) {
    const counts = await one<{ total: number; here: number }>(
      ctx.env,
      "SELECT count(*) total, coalesce(sum(category_id=?),0) here FROM pedido_items WHERE profile_id=?",
      out.category_id,
      ctx.profile,
    );
    requireValue(
      existing || (counts?.total || 0) < MENU_LIMITS.items,
      `Cardápio: até ${MENU_LIMITS.items} itens.`,
    );
    requireValue(
      (counts?.here || 0) < MENU_LIMITS.itemsPerCategory,
      `Cardápio: até ${MENU_LIMITS.itemsPerCategory} itens por categoria.`,
    );
  }
  if (Object.hasOwn(data, "position")) out.position = position(data.position);
  else if (!existing || out.category_id !== existing.category_id)
    out.position = await nextPosition(
      ctx,
      "SELECT max(position) p FROM pedido_items WHERE profile_id=? AND category_id=?",
      ctx.profile,
      out.category_id,
    );
  const id = existing?.id || uid();
  const statements: [string, any[]][] = [
    existing
      ? [
          "UPDATE pedido_items SET category_id=?,name=?,description=?,price_cents=?,photo_media_id=?,image_url=?,available=?,max_quantity=?,retailer_id=?,position=?,updated=? WHERE id=? AND profile_id=?",
          [
            out.category_id,
            out.name,
            out.description,
            out.price_cents,
            out.photo_media_id ?? null,
            out.image_url ?? null,
            out.available,
            out.max_quantity,
            out.retailer_id ?? null,
            out.position,
            at,
            id,
            ctx.profile,
          ],
        ]
      : [
          "INSERT INTO pedido_items(id,profile_id,category_id,name,description,price_cents,photo_media_id,image_url,available,max_quantity,retailer_id,position,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            id,
            ctx.profile,
            out.category_id,
            out.name,
            out.description,
            out.price_cents,
            out.photo_media_id ?? null,
            out.image_url ?? null,
            out.available,
            out.max_quantity,
            out.retailer_id ?? null,
            out.position,
            at,
            at,
          ],
        ],
  ];
  if (groupIds) {
    statements.push([
      "DELETE FROM pedido_item_groups WHERE item_id=? AND profile_id=?",
      [id, ctx.profile],
    ]);
    groupIds.forEach((groupId, index) =>
      statements.push([
        "INSERT INTO pedido_item_groups(profile_id,item_id,group_id,position) VALUES(?,?,?,?)",
        [ctx.profile, id, groupId, index],
      ]),
    );
  }
  await batch(ctx.env, statements);
  const item = await getItem(ctx, id);
  await changed(ctx, actor, "item", id, "saved");
  return item;
}

export async function getItem(ctx: ModuleContext, id: unknown) {
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_items WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Item");
  return itemView(row, (await itemGroupIds(ctx, [row.id])).get(row.id) || []);
}

export async function deleteItem(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  admin(actor);
  const row = await one(
    ctx.env,
    "SELECT id FROM pedido_items WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Item");
  await batch(ctx.env, [
    [
      "DELETE FROM pedido_item_groups WHERE item_id=? AND profile_id=?",
      [row.id, ctx.profile],
    ],
    [
      "DELETE FROM pedido_items WHERE id=? AND profile_id=?",
      [row.id, ctx.profile],
    ],
  ]);
  await changed(ctx, actor, "item", row.id, "deleted");
  return { id: row.id, deleted: true };
}

/**
 * Esgotado ou disponível de novo. Qualquer pessoa da equipe (a cozinha) pode
 * mudar; aplicações precisam de conversations:write.
 */
export async function setItemAvailability(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  ctx.access(actor, "conversations:write");
  const available = flag(data.available, "Disponível");
  const result = await exec(
    ctx.env,
    "UPDATE pedido_items SET available=?,updated=? WHERE id=? AND profile_id=?",
    available ? 1 : 0,
    now(),
    data.id,
    ctx.profile,
  );
  if (!result.meta.changes) throw notFound("Item");
  await changed(ctx, actor, "item", data.id, "availability", { available });
  return getItem(ctx, data.id);
}

// ---------------------------------------------------------------------------
// Grupos de adicionais

function validateOptions(value: unknown, old: MenuOption[]): MenuOption[] {
  requireValue(
    Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= MENU_LIMITS.options,
    `Grupo de adicionais: de 1 a ${MENU_LIMITS.options} opções.`,
  );
  const ids = new Set<string>();
  return (value as any[]).map((raw, index) => {
    requireValue(raw && typeof raw === "object", "Opção inválida.");
    let id = raw.id;
    if (id === undefined || id === null || id === "")
      id = uid().slice(0, 8) + index;
    requireValue(
      typeof id === "string" && ID.test(id) && !ids.has(id),
      "Opção: identificador inválido ou repetido (letras, números, - e _).",
    );
    ids.add(id);
    const previous = old.find((o) => o.id === id);
    return {
      id,
      name: text(raw.name, 60, `o nome da opção ${index + 1}`, true),
      price_cents: cents(raw.price_cents ?? 0, "o preço da opção"),
      available:
        raw.available === undefined
          ? (previous?.available ?? true)
          : flag(raw.available, "Opção disponível"),
    };
  });
}

export async function saveGroup(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM pedido_groups WHERE id=? AND profile_id=?",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing) throw notFound("Grupo de adicionais");
  const has = (key: string) => Object.hasOwn(data, key) || !existing;
  const name = has("name")
    ? text(data.name, 60, "o nome do grupo", true)
    : existing.name;
  const options = has("options")
    ? validateOptions(data.options, existing ? json(existing.options, []) : [])
    : (json(existing.options, []) as MenuOption[]);
  const min = has("min") ? (data.min ?? 0) : existing.min;
  const max = has("max") ? (data.max ?? 1) : existing.max;
  requireValue(
    Number.isInteger(min) &&
      Number.isInteger(max) &&
      min >= 0 &&
      max >= 1 &&
      min <= max &&
      max <= options.length,
    `Grupo "${name}": mínimo de 0 a ${options.length}, máximo de 1 a ${options.length} e mínimo até o máximo.`,
  );
  const at = now();
  const id = existing?.id || uid();
  if (existing)
    await exec(
      ctx.env,
      "UPDATE pedido_groups SET name=?,min=?,max=?,options=?,updated=? WHERE id=? AND profile_id=?",
      name,
      min,
      max,
      JSON.stringify(options),
      at,
      id,
      ctx.profile,
    );
  else {
    const count = await one<{ n: number }>(
      ctx.env,
      "SELECT count(*) n FROM pedido_groups WHERE profile_id=?",
      ctx.profile,
    );
    requireValue(
      (count?.n || 0) < MENU_LIMITS.groups,
      `Cardápio: até ${MENU_LIMITS.groups} grupos de adicionais.`,
    );
    await exec(
      ctx.env,
      "INSERT INTO pedido_groups(id,profile_id,name,min,max,options,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      id,
      ctx.profile,
      name,
      min,
      max,
      JSON.stringify(options),
      at,
      at,
    );
  }
  const row = await one(ctx.env, "SELECT * FROM pedido_groups WHERE id=?", id);
  await changed(ctx, actor, "group", id, "saved");
  return groupView(row);
}

export async function deleteGroup(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  admin(actor);
  const row = await one(
    ctx.env,
    "SELECT id FROM pedido_groups WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Grupo de adicionais");
  await batch(ctx.env, [
    [
      "DELETE FROM pedido_item_groups WHERE group_id=? AND profile_id=?",
      [row.id, ctx.profile],
    ],
    [
      "DELETE FROM pedido_groups WHERE id=? AND profile_id=?",
      [row.id, ctx.profile],
    ],
  ]);
  await changed(ctx, actor, "group", row.id, "deleted");
  return { id: row.id, deleted: true };
}

/** Uma opção esgotada (bacon acabou) sem editar o grupo: equipe. */
export async function setOptionAvailability(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  ctx.access(actor, "conversations:write");
  const available = flag(data.available, "Disponível");
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_groups WHERE id=? AND profile_id=?",
    data.id,
    ctx.profile,
  );
  if (!row) throw notFound("Grupo de adicionais");
  const options: MenuOption[] = json(row.options, []);
  requireValue(
    options.some((o) => o.id === data.option_id),
    "Opção não encontrada neste grupo.",
  );
  const next = options.map((o) =>
    o.id === data.option_id ? { ...o, available } : o,
  );
  await exec(
    ctx.env,
    "UPDATE pedido_groups SET options=?,updated=? WHERE id=? AND profile_id=? AND updated=?",
    JSON.stringify(next),
    now(),
    row.id,
    ctx.profile,
    row.updated,
  );
  await changed(ctx, actor, "group", row.id, "availability", {
    option_id: data.option_id,
    available,
  });
  return groupView(
    await one(ctx.env, "SELECT * FROM pedido_groups WHERE id=?", row.id),
  );
}

// ---------------------------------------------------------------------------
// Imagens do cardápio (WhatsApp)

/** PUT pedido/menu-images {images:[{media_id, caption?}]}: troca a lista. */
export async function saveMenuImages(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  admin(actor);
  requireValue(
    Array.isArray(data.images) && data.images.length <= MENU_LIMITS.images,
    `Imagens do cardápio: até ${MENU_LIMITS.images}.`,
  );
  const seen = new Set<string>();
  const images: { media_id: string; caption: string }[] = [];
  for (const raw of data.images as any[]) {
    requireValue(
      raw && typeof raw.media_id === "string" && !seen.has(raw.media_id),
      "Imagens do cardápio: arquivo inválido ou repetido.",
    );
    seen.add(raw.media_id);
    const media = await one(
      ctx.env,
      "SELECT id,type FROM media WHERE id=? AND profile_id=?",
      raw.media_id,
      ctx.profile,
    );
    requireValue(
      media && /^(image\/(jpeg|png)|application\/pdf)(;|$)/i.test(media.type),
      "Imagens do cardápio: envie imagens JPG ou PNG, ou um PDF, pelo envio de arquivos desta área.",
    );
    images.push({
      media_id: media.id,
      caption: text(raw.caption, 300, "a legenda da imagem"),
    });
  }
  await batch(ctx.env, [
    ["DELETE FROM pedido_menu_images WHERE profile_id=?", [ctx.profile]],
    ...images.map(
      (image, index) =>
        [
          "INSERT INTO pedido_menu_images(profile_id,media_id,caption,position) VALUES(?,?,?,?)",
          [ctx.profile, image.media_id, image.caption, index],
        ] as [string, any[]],
    ),
  ]);
  await changed(ctx, actor, "images", ctx.profile, "saved", {
    count: images.length,
  });
  return { images: await menuImages(ctx) };
}

// ---------------------------------------------------------------------------
// Catálogo do carrinho (src/web-cart.ts)

/**
 * Cardápio no formato da página de carrinho: só categorias com itens, itens
 * esgotados aparecem sem quantidade. `fulfillment` vem das regras da loja.
 * null quando não há nenhum item.
 */
export function cartCategories(menu: Menu) {
  const groups = new Map(menu.groups.map((g) => [g.id, g]));
  const categories = menu.categories
    .filter((category) => category.items.length)
    .map((category) => ({
      id: category.id,
      name: category.name,
      items: category.items.map((item) => ({
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        price_cents: item.price_cents,
        ...(item.image_url ? { image_url: item.image_url } : {}),
        // Foto enviada para a área: a página do carrinho a serve pelo link.
        ...(item.photo_media_id ? { image_media_id: item.photo_media_id } : {}),
        available: item.available,
        max_quantity: item.max_quantity,
        option_groups: item.group_ids
          .map((id) => groups.get(id))
          .filter((g): g is NonNullable<typeof g> => !!g)
          .map((group) => ({
            id: group.id,
            name: group.name,
            min: group.min,
            max: group.max,
            options: group.options.map((option) => ({
              id: option.id,
              name: option.name,
              price_cents: option.price_cents,
              available: option.available,
            })),
          })),
      })),
    }));
  return categories.length ? categories : null;
}

/** Itens do cardápio pelo retailer_id do catálogo da Meta. */
export async function itemsByRetailer(ctx: ModuleContext, ids: string[]) {
  // Em lotes: o D1 aceita até 100 parâmetros por instrução (revisão B10).
  const unique = [...new Set(ids)];
  const rows: any[] = [];
  for (let i = 0; i < unique.length; i += 90) {
    const part = unique.slice(i, i + 90);
    rows.push(
      ...(await all(
        ctx.env,
        `SELECT * FROM pedido_items WHERE profile_id=? AND retailer_id IN (${part.map(() => "?").join(",")})`,
        ctx.profile,
        ...part,
      )),
    );
  }
  return rows;
}
