// Vendas: estoque. Toda mudança de saldo é um movimento com chave única por
// área e vai no mesmo lote (transação do D1) que a atualização do saldo:
// - a chave repetida (venda reenviada, gancho repetido) falha e desfaz o lote,
//   então a mesma baixa nunca acontece duas vezes;
// - o CHECK de vendas_products (migração 0060) recusa saldo negativo em
//   produto que não permite, e desfaz o lote inteiro (venda e outras linhas).
// Os comandos da área já rodam em série no Coordinator; o banco garante o
// resto mesmo assim (docs/VENDAS.md, "Estoque").
import { all, batch } from "../../db";
import { ApiError, type Actor, now, requireValue, uid } from "../../types";
import type { ModuleContext } from "../api";
import { productsByIds, productView } from "./catalog";
import {
  MOVE_LABELS,
  MOVE_TYPES,
  cents,
  fromMilli,
  milli,
  quantityLabel,
  text,
  vendasSettings,
  type MoveType,
} from "./model";

export interface StockChange {
  product_id: string;
  /** Variação em milésimos (negativa nas saídas). */
  delta_milli: number;
  type: MoveType;
  /** Única por área: repetir a mesma chave desfaz o lote. */
  key: string;
  ref_type: "sale" | "return" | "manual";
  ref_id: string | null;
  note?: string;
  cost_cents?: number | null;
}

/** Instruções do lote: saldo e movimento (com o saldo depois) por mudança. */
export function stockStatements(
  ctx: ModuleContext,
  changes: StockChange[],
  actor: string,
  at = now(),
): [string, any[]][] {
  return changes.flatMap(
    (change): [string, any[]][] => [
      [
        "UPDATE vendas_products SET stock_milli=stock_milli+?,updated=? WHERE id=? AND profile_id=? AND track_stock=1",
        [change.delta_milli, at, change.product_id, ctx.profile],
      ],
      [
        "INSERT INTO vendas_stock_moves(id,profile_id,product_id,type,quantity_milli,balance_milli,ref_type,ref_id,key,cost_cents,note,actor,created) SELECT ?,?,id,?,?,stock_milli,?,?,?,?,?,?,? FROM vendas_products WHERE id=? AND profile_id=? AND track_stock=1",
        [
          uid(),
          ctx.profile,
          change.type,
          change.delta_milli,
          change.ref_type,
          change.ref_id,
          change.key,
          change.cost_cents ?? null,
          change.note || "",
          actor,
          at,
          change.product_id,
          ctx.profile,
        ],
      ],
    ],
  );
}

export type StockFailure = "insufficient" | "duplicate";

/** Falha do lote: saldo insuficiente (CHECK) ou chave repetida (UNIQUE). */
export function stockFailure(error: unknown): StockFailure | null {
  const message = String((error as Error)?.message || error);
  if (/CHECK constraint/i.test(message)) return "insufficient";
  if (/UNIQUE constraint/i.test(message)) return "duplicate";
  return null;
}

/**
 * 409 out_of_stock com os produtos sem saldo para as quantidades pedidas
 * (relidos depois da falha).
 */
export async function outOfStock(
  ctx: ModuleContext,
  wanted: { product_id: string; quantity_milli: number }[],
) {
  const totals = new Map<string, number>();
  for (const w of wanted)
    totals.set(w.product_id, (totals.get(w.product_id) || 0) + w.quantity_milli);
  const rows = await productsByIds(ctx, [...totals.keys()]);
  const short = [...totals.entries()]
    .map(([id, quantity]) => ({ row: rows.get(id), quantity }))
    .filter(
      ({ row, quantity }) =>
        row &&
        row.track_stock &&
        !row.allow_negative &&
        row.stock_milli < quantity,
    )
    .map(({ row, quantity }) => ({
      product_id: row.id as string,
      name: row.name as string,
      requested: fromMilli(quantity),
      available: fromMilli(Math.max(row.stock_milli, 0)),
      unit: row.unit as string,
    }));
  const error = new ApiError(
    409,
    "out_of_stock",
    short.length
      ? `Estoque insuficiente: ${short
          .map(
            (s) =>
              `${s.name} (pedido ${quantityLabel(s.requested * 1000)} ${s.unit}, saldo ${quantityLabel(s.available * 1000)} ${s.unit})`,
          )
          .join("; ")}.`
      : "Estoque insuficiente.",
  );
  (error as any).details = { products: short };
  return error;
}

/**
 * Avisa (vendas.stock_low) os produtos que cruzaram o estoque mínimo com
 * estas mudanças: estavam acima e ficaram no mínimo ou abaixo.
 */
export async function stockAlerts(ctx: ModuleContext, changes: StockChange[]) {
  if (!changes.length) return;
  const cfg = vendasSettings(await ctx.settings());
  const rows = await productsByIds(
    ctx,
    changes.map((c) => c.product_id),
  );
  const delta = new Map<string, number>();
  for (const c of changes)
    delta.set(c.product_id, (delta.get(c.product_id) || 0) + c.delta_milli);
  if (!cfg.low_stock_alert) return;
  for (const [id, d] of delta) {
    const row = rows.get(id);
    if (!row?.track_stock || row.min_stock_milli <= 0) continue;
    const before = row.stock_milli - d;
    if (row.stock_milli <= row.min_stock_milli && before > row.min_stock_milli)
      await ctx.publish(
        "vendas.stock_low",
        id,
        {
          product_id: id,
          name: row.name,
          stock: fromMilli(row.stock_milli),
          min_stock: fromMilli(row.min_stock_milli),
          unit: row.unit,
        },
        { key: `low:${changes.find((c) => c.product_id === id)!.key}` },
      );
  }
}

// ---------------------------------------------------------------------------
// Movimentos manuais: entrada, saída e ajuste de inventário

/**
 * POST vendas/stock/moves {type, items:[{product_id, quantity, cost_cents?}], note?}.
 * Entrada: qualquer pessoa da equipe. Saída e ajuste: administrador. Ajuste:
 * `quantity` é o saldo contado (o movimento registra a diferença).
 * Aplicações: billing:write.
 */
export async function manualMoves(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  if (actor.kind === "app") ctx.access(actor, "billing:write");
  const type = data.type as MoveType;
  requireValue(
    ["entrada", "saida", "ajuste"].includes(type),
    "Tipo do movimento: entrada, saida ou ajuste.",
  );
  if (type !== "entrada" && actor.kind === "user")
    requireValue(
      actor.role === "admin",
      "Saída e ajuste de estoque: somente administradores.",
    );
  const items = Array.isArray(data.items)
    ? data.items
    : data.product_id
      ? [
          {
            product_id: data.product_id,
            quantity: data.quantity,
            cost_cents: data.cost_cents,
          },
        ]
      : null;
  requireValue(
    items && items.length >= 1 && items.length <= 100,
    "Informe de 1 a 100 itens (items).",
  );
  const note = text(data.note, 300, "a observação");
  const rows = await productsByIds(
    ctx,
    items.map((i: any) => String(i?.product_id ?? "")),
  );
  const seen = new Set<string>();
  const at = now();
  const changes: StockChange[] = [];
  const statements: [string, any[]][] = [];
  items.forEach((item: any, index: number) => {
    const row = rows.get(String(item?.product_id ?? ""));
    if (!row)
      throw new ApiError(404, "not_found", "Produto não encontrado no catálogo.");
    requireValue(
      row.track_stock,
      `"${row.name}" não controla estoque. Ligue o controle no produto antes.`,
    );
    requireValue(
      !seen.has(row.id),
      `"${row.name}" aparece duas vezes no mesmo movimento.`,
    );
    seen.add(row.id);
    const quantity = milli(item.quantity, `Quantidade de "${row.name}"`, {
      fractional: !!row.fractional,
      allowZero: type === "ajuste",
    });
    const cost =
      item.cost_cents === undefined || item.cost_cents === null
        ? null
        : cents(item.cost_cents, "o custo unitário");
    const key = `manual:${requestId}:${index}`;
    if (type === "ajuste") {
      // Saldo contado: o movimento guarda a diferença; o saldo vira o contado.
      statements.push(
        [
          "INSERT INTO vendas_stock_moves(id,profile_id,product_id,type,quantity_milli,balance_milli,ref_type,ref_id,key,cost_cents,note,actor,created) SELECT ?,?,id,'ajuste',?-stock_milli,?,'manual',NULL,?,?,?,?,? FROM vendas_products WHERE id=? AND profile_id=?",
          [
            uid(),
            ctx.profile,
            quantity,
            quantity,
            key,
            cost,
            note,
            actor.id,
            at,
            row.id,
            ctx.profile,
          ],
        ],
        [
          "UPDATE vendas_products SET stock_milli=?,updated=? WHERE id=? AND profile_id=?",
          [quantity, at, row.id, ctx.profile],
        ],
      );
      changes.push({
        product_id: row.id,
        delta_milli: quantity - row.stock_milli,
        type,
        key,
        ref_type: "manual",
        ref_id: null,
      });
    } else {
      const change: StockChange = {
        product_id: row.id,
        delta_milli: type === "entrada" ? quantity : -quantity,
        type,
        key,
        ref_type: "manual",
        ref_id: null,
        note,
        cost_cents: cost,
      };
      changes.push(change);
      statements.push(...stockStatements(ctx, [change], actor.id, at));
    }
    // Entrada com custo atualiza o custo do produto (último custo).
    if (type === "entrada" && cost !== null)
      statements.push([
        "UPDATE vendas_products SET cost_cents=? WHERE id=? AND profile_id=?",
        [cost, row.id, ctx.profile],
      ]);
  });
  try {
    await batch(ctx.env, statements);
  } catch (error) {
    const failure = stockFailure(error);
    if (failure === "insufficient")
      throw await outOfStock(
        ctx,
        changes.map((c) => ({
          product_id: c.product_id,
          quantity_milli: -c.delta_milli,
        })),
      );
    // Mesma requisição repetida: o recibo do comando já devolve a resposta.
    if (failure !== "duplicate") throw error;
  }
  await ctx.publish(
    "vendas.stock_moved",
    `manual:${requestId}`,
    {
      type,
      items: changes.map((c) => ({
        product_id: c.product_id,
        quantity: fromMilli(c.delta_milli),
      })),
      actor: actor.id,
    },
    { key: `manual:${requestId}` },
  );
  await stockAlerts(ctx, changes);
  const updated = await productsByIds(
    ctx,
    changes.map((c) => c.product_id),
  );
  return {
    type,
    products: changes.map((c) => productView(updated.get(c.product_id))),
  };
}

export const moveView = (row: any) => ({
  id: row.id,
  product_id: row.product_id,
  product_name: row.product_name ?? null,
  unit: row.unit ?? null,
  type: row.type as MoveType,
  type_label: MOVE_LABELS[row.type as MoveType] || row.type,
  quantity: fromMilli(row.quantity_milli),
  balance: fromMilli(row.balance_milli),
  ref_type: row.ref_type,
  ref_id: row.ref_id,
  cost_cents: row.cost_cents ?? null,
  note: row.note,
  actor: row.actor,
  created: row.created,
});

/** GET vendas/stock/moves?product_id=&type=&from=&to=&limit=&cursor=. */
export async function listMoves(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["m.profile_id=?"];
  const args: any[] = [ctx.profile];
  if (query.product_id) {
    where.push("m.product_id=?");
    args.push(query.product_id);
  }
  if (query.type) {
    requireValue(
      (MOVE_TYPES as readonly string[]).includes(query.type),
      `type: ${MOVE_TYPES.join(", ")}.`,
    );
    where.push("m.type=?");
    args.push(query.type);
  }
  if (query.from) {
    where.push("m.created>=?");
    args.push(Number(query.from) || 0);
  }
  if (query.to) {
    where.push("m.created<?");
    args.push(Number(query.to) || 0);
  }
  if (query.cursor) {
    const [created, id] = query.cursor.split(":");
    where.push("(m.created<? OR (m.created=? AND m.id<?))");
    args.push(Number(created) || 0, Number(created) || 0, id || "");
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const rows = await all(
    ctx.env,
    `SELECT m.*,p.name product_name,p.unit unit FROM vendas_stock_moves m LEFT JOIN vendas_products p ON p.id=m.product_id WHERE ${where.join(" AND ")} ORDER BY m.created DESC,m.id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(moveView),
    next_cursor:
      rows.length > limit && last ? `${last.created}:${last.id}` : null,
  };
}
