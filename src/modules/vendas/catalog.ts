// Vendas: catálogo de produtos por área (categorias, produtos com foto,
// códigos, estoque e dados fiscais). O Caixa usa o mesmo catálogo pela
// interface de ./public.ts. Lê a tabela de mídia do núcleo (fotos), sem gravar
// em tabelas do núcleo.
import { all, batch, exec, one } from "../../db";
import { ApiError, type Actor, json, now, requireValue, uid } from "../../types";
import { admin } from "../../security";
import type { ModuleContext } from "../api";
import {
  cents,
  ean,
  flag,
  fromMilli,
  milli,
  sku,
  text,
  unit,
  validateFiscal,
  type ProductFiscal,
} from "./model";

export const CATALOG_LIMITS = { categories: 100, products: 5000 } as const;

const notFound = (what: string) =>
  new ApiError(404, "not_found", `${what} não encontrado no catálogo.`);

const position = (value: unknown) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 100_000,
    "Posição: inteiro de 0 a 100.000.",
  );
  return value as number;
};

/** Endereço da foto para o painel e os apps (exige a sessão ou a chave). */
export const photoPath = (profile: string, media: string | null) =>
  media
    ? `/api/v1/profiles/${encodeURIComponent(profile)}/media/${encodeURIComponent(media)}/content`
    : null;

// ---------------------------------------------------------------------------
// Formatos da API (docs/API.md, Vendas)

export const categoryView = (row: any) => ({
  id: row.id,
  name: row.name,
  color: row.color || null,
  position: row.position,
  created: row.created,
  updated: row.updated,
});

export function productView(row: any) {
  const tracked = !!row.track_stock;
  return {
    id: row.id,
    category_id: row.category_id || null,
    name: row.name,
    description: row.description,
    price_cents: row.price_cents,
    cost_cents: row.cost_cents ?? null,
    unit: row.unit,
    fractional: !!row.fractional,
    ean: row.ean || null,
    sku: row.sku || null,
    photo_media_id: row.photo_media_id || null,
    photo_path: photoPath(row.profile_id, row.photo_media_id),
    active: !!row.active,
    track_stock: tracked,
    allow_negative: !!row.allow_negative,
    stock: tracked ? fromMilli(row.stock_milli) : null,
    min_stock: tracked ? fromMilli(row.min_stock_milli) : null,
    low_stock:
      tracked &&
      row.min_stock_milli > 0 &&
      row.stock_milli <= row.min_stock_milli,
    out_of_stock: tracked && !row.allow_negative && row.stock_milli <= 0,
    fiscal: json(row.fiscal, {}) as ProductFiscal,
    position: row.position,
    created: row.created,
    updated: row.updated,
  };
}
export type ProductView = ReturnType<typeof productView>;

/** Visão sem custo nem dados de estoque exatos (bots e o cliente). */
export const publicProductView = (row: any) => ({
  id: row.id,
  category_id: row.category_id || null,
  name: row.name,
  description: row.description,
  price_cents: row.price_cents,
  unit: row.unit,
  fractional: !!row.fractional,
  available:
    !!row.active &&
    (!row.track_stock || !!row.allow_negative || row.stock_milli > 0),
});

// ---------------------------------------------------------------------------
// Leitura

export async function loadProduct(ctx: ModuleContext, id: unknown) {
  const row = await one(
    ctx.env,
    "SELECT * FROM vendas_products WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Produto");
  return row;
}

/** Produtos por id, em lotes (o D1 aceita até 100 parâmetros). */
export async function productsByIds(ctx: ModuleContext, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows: any[] = [];
  for (let i = 0; i < unique.length; i += 90) {
    const part = unique.slice(i, i + 90);
    rows.push(
      ...(await all(
        ctx.env,
        `SELECT * FROM vendas_products WHERE profile_id=? AND id IN (${part.map(() => "?").join(",")})`,
        ctx.profile,
        ...part,
      )),
    );
  }
  return new Map(rows.map((row) => [row.id as string, row]));
}

/** Produto ativo pelo código de barras (EAN) ou pelo código interno (SKU). */
export async function productByCode(ctx: ModuleContext, code: unknown) {
  const value = String(code ?? "").trim();
  requireValue(value && value.length <= 60, "Informe o código (code).");
  const digits = value.replace(/\s/g, "");
  const row = await one(
    ctx.env,
    "SELECT * FROM vendas_products WHERE profile_id=? AND active=1 AND (ean=? OR sku=? OR sku=?) ORDER BY ean=? DESC LIMIT 1",
    ctx.profile,
    digits,
    value,
    value.toUpperCase(),
    digits,
  );
  if (!row)
    throw new ApiError(
      404,
      "product_not_found",
      `Nenhum produto ativo com o código ${value}.`,
    );
  return productView(row);
}

export async function listCategories(ctx: ModuleContext) {
  return (
    await all(
      ctx.env,
      "SELECT * FROM vendas_categories WHERE profile_id=? ORDER BY position,name COLLATE NOCASE,id",
      ctx.profile,
    )
  ).map(categoryView);
}

/**
 * GET vendas/products?q=&category_id=&active=1|0|all&low=1&limit=&cursor=.
 * Ordem: categoria, posição, nome. cursor é o deslocamento.
 */
export async function listProducts(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"];
  const args: any[] = [ctx.profile];
  const active = query.active ?? "1";
  if (active === "1" || active === "0") {
    where.push("active=?");
    args.push(Number(active));
  } else requireValue(active === "all", "active: 1, 0 ou all.");
  if (query.category_id) {
    if (query.category_id === "none") where.push("category_id IS NULL");
    else {
      where.push("category_id=?");
      args.push(query.category_id);
    }
  }
  if (query.low === "1")
    where.push(
      "track_stock=1 AND min_stock_milli>0 AND stock_milli<=min_stock_milli",
    );
  if (query.q) {
    const q = clipQuery(query.q);
    where.push(
      "(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR sku LIKE ? ESCAPE '\\' COLLATE NOCASE OR ean=?)",
    );
    args.push(`%${q}%`, `%${q}%`, query.q.replace(/\s/g, ""));
  }
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.cursor) || 0, 0);
  const rows = await all(
    ctx.env,
    `SELECT * FROM vendas_products WHERE ${where.join(" AND ")} ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?`,
    ...args,
    limit + 1,
    offset,
  );
  return {
    data: rows.slice(0, limit).map(productView),
    next_cursor: rows.length > limit ? String(offset + limit) : null,
  };
}
const clipQuery = (q: string) =>
  Array.from(q.trim())
    .slice(0, 60)
    .join("")
    .replace(/[\\%_]/g, (m) => "\\" + m);

/**
 * Grade do caixa: categorias e produtos ativos, na ordem de exibição, com o
 * necessário para vender por toque (foto, preço, unidade, códigos, saldo).
 */
export async function catalogGrid(ctx: ModuleContext) {
  const [categories, products] = await Promise.all([
    listCategories(ctx),
    all(
      ctx.env,
      "SELECT * FROM vendas_products WHERE profile_id=? AND active=1 ORDER BY position,name COLLATE NOCASE,id",
      ctx.profile,
    ),
  ]);
  return {
    categories,
    products: products.map((row) => {
      const view = productView(row);
      return {
        id: view.id,
        category_id: view.category_id,
        name: view.name,
        price_cents: view.price_cents,
        unit: view.unit,
        fractional: view.fractional,
        ean: view.ean,
        sku: view.sku,
        photo_media_id: view.photo_media_id,
        photo_path: view.photo_path,
        track_stock: view.track_stock,
        stock: view.stock,
        low_stock: view.low_stock,
        out_of_stock: view.out_of_stock,
        position: view.position,
      };
    }),
    generated_at: now(),
  };
}

/** Catálogo para bots e integrações: sem custo nem saldo exato. */
export async function publicCatalog(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const page = await listProducts(ctx, {
    q: query.q || "",
    category_id: query.category_id || "",
    active: "1",
    limit: query.limit || "50",
    cursor: query.cursor || "",
  });
  const rows = await productsByIds(
    ctx,
    page.data.map((p) => p.id),
  );
  return {
    categories: await listCategories(ctx),
    data: page.data.map((p) => publicProductView(rows.get(p.id))),
    next_cursor: page.next_cursor,
  };
}

// ---------------------------------------------------------------------------
// Escrita

async function changed(
  ctx: ModuleContext,
  actor: Actor,
  what: "category" | "product",
  id: string,
  action: "saved" | "archived" | "deleted",
) {
  await ctx.publish("vendas.product_changed", id, {
    what,
    id,
    action,
    actor: actor.id,
  });
}

/** Foto da área (tabela media do núcleo, só leitura): JPG, PNG ou WebP. */
async function photo(ctx: ModuleContext, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  requireValue(typeof value === "string", "Foto do produto inválida.");
  const row = await one(
    ctx.env,
    "SELECT id,type FROM media WHERE id=? AND profile_id=?",
    value,
    ctx.profile,
  );
  requireValue(
    row && /^image\/(jpeg|png|webp)(;|$)/i.test(row.type),
    "Foto do produto: envie uma imagem JPG, PNG ou WebP pelo envio de arquivos desta área.",
  );
  return row.id as string;
}

export async function saveCategory(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM vendas_categories WHERE id=? AND profile_id=?",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing) throw notFound("Categoria");
  const has = (k: string) => Object.hasOwn(data, k) || !existing;
  const name = has("name")
    ? text(data.name, 40, "o nome da categoria", true)
    : existing.name;
  let color = existing?.color || "";
  if (Object.hasOwn(data, "color")) {
    color = text(data.color, 7, "a cor");
    requireValue(
      !color || /^#[0-9a-fA-F]{6}$/.test(color),
      "Cor: use #RRGGBB.",
    );
  }
  const at = now();
  const id = existing?.id || uid();
  if (existing) {
    await exec(
      ctx.env,
      "UPDATE vendas_categories SET name=?,color=?,position=?,updated=? WHERE id=? AND profile_id=?",
      name,
      color,
      Object.hasOwn(data, "position")
        ? position(data.position)
        : existing.position,
      at,
      id,
      ctx.profile,
    );
  } else {
    const count = await one<{ n: number; p: number | null }>(
      ctx.env,
      "SELECT count(*) n, max(position) p FROM vendas_categories WHERE profile_id=?",
      ctx.profile,
    );
    requireValue(
      (count?.n || 0) < CATALOG_LIMITS.categories,
      `Catálogo: até ${CATALOG_LIMITS.categories} categorias.`,
    );
    await exec(
      ctx.env,
      "INSERT INTO vendas_categories(id,profile_id,name,color,position,created,updated) VALUES(?,?,?,?,?,?,?)",
      id,
      ctx.profile,
      name,
      color,
      Object.hasOwn(data, "position")
        ? position(data.position)
        : (count?.p ?? -1) + 1,
      at,
      at,
    );
  }
  await changed(ctx, actor, "category", id, "saved");
  return categoryView(
    await one(ctx.env, "SELECT * FROM vendas_categories WHERE id=?", id),
  );
}

/** Excluir categoria: os produtos ficam sem categoria ("Outros"). */
export async function deleteCategory(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  admin(actor);
  const row = await one(
    ctx.env,
    "SELECT id FROM vendas_categories WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Categoria");
  await batch(ctx.env, [
    [
      "UPDATE vendas_products SET category_id=NULL,updated=? WHERE profile_id=? AND category_id=?",
      [now(), ctx.profile, row.id],
    ],
    [
      "DELETE FROM vendas_categories WHERE id=? AND profile_id=?",
      [row.id, ctx.profile],
    ],
  ]);
  await changed(ctx, actor, "category", row.id, "deleted");
  return { id: row.id, deleted: true };
}

const constraint = (error: unknown) =>
  String((error as Error)?.message || error);

/**
 * POST/PUT vendas/products: administrador. `stock` só na criação (vira o
 * movimento "Saldo inicial"); depois, o saldo muda por movimentos.
 */
export async function saveProduct(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM vendas_products WHERE id=? AND profile_id=?",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing) throw notFound("Produto");
  const has = (k: string) => Object.hasOwn(data, k) || !existing;
  const out: Record<string, any> = existing ? { ...existing } : {};
  if (has("category_id")) {
    const category = data.category_id ?? null;
    if (category !== null) {
      requireValue(typeof category === "string", "Categoria inválida.");
      const found = await one(
        ctx.env,
        "SELECT id FROM vendas_categories WHERE id=? AND profile_id=?",
        category,
        ctx.profile,
      );
      if (!found) throw notFound("Categoria");
    }
    out.category_id = category;
  }
  if (has("name")) out.name = text(data.name, 120, "o nome do produto", true);
  if (has("description"))
    out.description = text(data.description, 500, "a descrição");
  if (has("price_cents"))
    out.price_cents = cents(data.price_cents, "o preço do produto");
  if (has("cost_cents"))
    out.cost_cents =
      data.cost_cents === null || data.cost_cents === undefined
        ? null
        : cents(data.cost_cents, "o custo do produto");
  if (has("unit")) out.unit = unit(data.unit);
  if (has("fractional"))
    out.fractional =
      data.fractional === undefined
        ? 0
        : flag(data.fractional, "Vende fracionado")
          ? 1
          : 0;
  if (has("ean")) out.ean = ean(data.ean);
  if (has("sku")) out.sku = sku(data.sku);
  if (has("photo_media_id"))
    out.photo_media_id = await photo(ctx, data.photo_media_id);
  if (has("active"))
    out.active =
      data.active === undefined ? 1 : flag(data.active, "Ativo") ? 1 : 0;
  if (has("track_stock"))
    out.track_stock =
      data.track_stock === undefined
        ? 1
        : flag(data.track_stock, "Controla estoque")
          ? 1
          : 0;
  if (has("allow_negative"))
    out.allow_negative =
      data.allow_negative === undefined
        ? 0
        : flag(data.allow_negative, "Permite saldo negativo")
          ? 1
          : 0;
  if (has("min_stock"))
    out.min_stock_milli =
      data.min_stock === undefined || data.min_stock === null
        ? 0
        : milli(data.min_stock, "Estoque mínimo", {
            fractional: !!out.fractional,
            allowZero: true,
          });
  if (has("fiscal")) out.fiscal = JSON.stringify(validateFiscal(data.fiscal));
  if (Object.hasOwn(data, "position")) out.position = position(data.position);
  else if (!existing) out.position = 0;
  let initial = 0;
  if (Object.hasOwn(data, "stock") && data.stock !== null) {
    requireValue(
      !existing,
      "O saldo de um produto existente muda por movimentos de estoque (POST /vendas/stock/moves).",
    );
    initial = milli(data.stock, "Estoque inicial", {
      fractional: !!out.fractional,
      allowZero: true,
    });
  }
  // Códigos repetidos na área: mensagem clara antes do índice único.
  for (const [k, label] of [
    ["ean", "código de barras"],
    ["sku", "código interno"],
  ] as const)
    if (out[k]) {
      const taken = await one(
        ctx.env,
        `SELECT name FROM vendas_products WHERE profile_id=? AND ${k}=? AND id<>?`,
        ctx.profile,
        out[k],
        existing?.id || "",
      );
      if (taken)
        throw new ApiError(
          409,
          `${k}_taken`,
          `O ${label} ${out[k]} já está no produto "${taken.name}".`,
        );
    }
  const at = now();
  const id = existing?.id || uid();
  const values = [
    out.category_id ?? null,
    out.name,
    out.description,
    out.price_cents,
    out.cost_cents ?? null,
    out.unit,
    out.fractional,
    out.ean ?? null,
    out.sku ?? null,
    out.photo_media_id ?? null,
    out.active,
    out.track_stock,
    out.allow_negative,
    out.min_stock_milli,
    out.fiscal ?? "{}",
    out.position,
  ];
  const statements: [string, any[]][] = [];
  if (existing)
    statements.push([
      "UPDATE vendas_products SET category_id=?,name=?,description=?,price_cents=?,cost_cents=?,unit=?,fractional=?,ean=?,sku=?,photo_media_id=?,active=?,track_stock=?,allow_negative=?,min_stock_milli=?,fiscal=?,position=?,updated=? WHERE id=? AND profile_id=?",
      [...values, at, id, ctx.profile],
    ]);
  else {
    const count = await one<{ n: number }>(
      ctx.env,
      "SELECT count(*) n FROM vendas_products WHERE profile_id=?",
      ctx.profile,
    );
    requireValue(
      (count?.n || 0) < CATALOG_LIMITS.products,
      `Catálogo: até ${CATALOG_LIMITS.products} produtos.`,
    );
    statements.push([
      "INSERT INTO vendas_products(category_id,name,description,price_cents,cost_cents,unit,fractional,ean,sku,photo_media_id,active,track_stock,allow_negative,min_stock_milli,fiscal,position,id,profile_id,stock_milli,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        ...values,
        id,
        ctx.profile,
        out.track_stock ? initial : 0,
        at,
        at,
      ],
    ]);
    if (out.track_stock && initial)
      statements.push([
        "INSERT INTO vendas_stock_moves(id,profile_id,product_id,type,quantity_milli,balance_milli,ref_type,ref_id,key,cost_cents,note,actor,created) VALUES(?,?,?,'entrada',?,?,'manual',NULL,?,?,'Saldo inicial',?,?)",
        [
          uid(),
          ctx.profile,
          id,
          initial,
          initial,
          `initial:${id}`,
          out.cost_cents ?? null,
          actor.id,
          at,
        ],
      ]);
  }
  try {
    await batch(ctx.env, statements);
  } catch (error) {
    const message = constraint(error);
    if (/CHECK constraint/i.test(message))
      throw new ApiError(
        409,
        "negative_stock",
        "O saldo deste produto está negativo. Ajuste o estoque antes de proibir saldo negativo.",
      );
    if (/UNIQUE constraint/i.test(message))
      throw new ApiError(
        409,
        "code_taken",
        "Código de barras ou código interno já usado em outro produto.",
      );
    throw error;
  }
  await changed(ctx, actor, "product", id, "saved");
  return productView(await loadProduct(ctx, id));
}

/**
 * DELETE vendas/products/:id: arquiva (some da grade e das buscas) quando o
 * produto já tem movimentos, vendas ou orçamentos; senão, exclui.
 */
export async function deleteProduct(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  admin(actor);
  const row = await loadProduct(ctx, id);
  const used = await one(
    ctx.env,
    "SELECT 1 x FROM vendas_stock_moves WHERE profile_id=? AND product_id=? UNION ALL SELECT 1 FROM vendas_sales WHERE profile_id=? AND instr(lines,?)>0 UNION ALL SELECT 1 FROM vendas_quotes WHERE profile_id=? AND instr(lines,?)>0 LIMIT 1",
    ctx.profile,
    row.id,
    ctx.profile,
    `"product_id":"${row.id}"`,
    ctx.profile,
    `"product_id":"${row.id}"`,
  );
  if (used) {
    await exec(
      ctx.env,
      "UPDATE vendas_products SET active=0,updated=? WHERE id=? AND profile_id=?",
      now(),
      row.id,
      ctx.profile,
    );
    await changed(ctx, actor, "product", row.id, "archived");
    return { id: row.id, deleted: false, archived: true };
  }
  await exec(
    ctx.env,
    "DELETE FROM vendas_products WHERE id=? AND profile_id=?",
    row.id,
    ctx.profile,
  );
  await changed(ctx, actor, "product", row.id, "deleted");
  return { id: row.id, deleted: true, archived: false };
}
