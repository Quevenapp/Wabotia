// Mesas: cadastro das mesas e comandas (só administrador). O estado de cada
// uma (livre, ocupada, fechando) vem da conta aberta (./tabs.ts).
import { all, batch, exec, one } from "../../db";
import { ApiError, type Actor, now, requireValue, uid } from "../../types";
import { admin } from "../../security";
import type { ModuleContext } from "../api";
import { TABLE_KINDS, intIn, isLive, text, type TableKind } from "./model";

export const TABLE_LIMIT = 300;

export function tableView(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as TableKind,
    section: row.section as string,
    seats: row.seats as number,
    position: row.position as number,
  };
}
export type TableView = ReturnType<typeof tableView>;

const notFound = () => new ApiError(404, "not_found", "Mesa não encontrada.");

export async function loadTable(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound();
  const row = await one(
    ctx.env,
    "SELECT * FROM mesas_tables WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound();
  return row;
}

export const listTables = (ctx: ModuleContext) =>
  all(
    ctx.env,
    "SELECT * FROM mesas_tables WHERE profile_id=? ORDER BY section,position,name LIMIT ?",
    ctx.profile,
    TABLE_LIMIT,
  );

function fields(data: any, partial: boolean) {
  const out: Record<string, any> = {};
  if (!partial || data.name !== undefined)
    out.name = text(data.name, 30, "o nome da mesa", true);
  if (!partial || data.kind !== undefined) {
    const kind = data.kind ?? "table";
    requireValue(
      (TABLE_KINDS as readonly string[]).includes(kind),
      "kind: table (mesa) ou card (comanda).",
    );
    out.kind = kind;
  }
  if (!partial || data.section !== undefined)
    out.section = text(data.section, 40, "o ambiente");
  if (!partial || data.seats !== undefined)
    out.seats = intIn(data.seats ?? 0, 0, 99, "Lugares: inteiro de 0 a 99.");
  if (!partial || data.position !== undefined)
    out.position = intIn(
      data.position ?? 0,
      0,
      10_000,
      "Posição: inteiro de 0 a 10.000.",
    );
  return out;
}

const taken = (name: string) =>
  new ApiError(409, "table_name_taken", `Já existe uma mesa "${name}".`);

/**
 * POST mesas/tables: uma mesa ({name, kind?, section?, seats?, position?})
 * ou várias de uma vez ({prefix: "Mesa", from: 1, to: 20, kind?, section?,
 * seats?}), pulando os nomes que já existem.
 */
export async function createTables(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  admin(actor);
  const count = await one<{ n: number }>(
    ctx.env,
    "SELECT count(*) n FROM mesas_tables WHERE profile_id=?",
    ctx.profile,
  );
  const at = now();
  let rows: Record<string, any>[];
  if (data.from !== undefined || data.to !== undefined) {
    const from = intIn(data.from, 0, 9999, "from: inteiro de 0 a 9999.");
    const to = intIn(data.to, from, 9999, "to: inteiro de from até 9999.");
    requireValue(to - from < 100, "Até 100 mesas por vez.");
    const prefix = text(data.prefix ?? "Mesa", 20, "o prefixo");
    const base = fields({ ...data, name: "x" }, false);
    rows = [];
    for (let n = from; n <= to; n++)
      rows.push({
        ...base,
        name: prefix ? `${prefix} ${n}` : String(n),
        position: base.position || n,
      });
  } else rows = [fields(data, false)];
  requireValue(
    (count?.n || 0) + rows.length <= TABLE_LIMIT,
    `Até ${TABLE_LIMIT} mesas e comandas por área.`,
  );
  const existing = new Set(
    (
      await all(
        ctx.env,
        "SELECT name FROM mesas_tables WHERE profile_id=?",
        ctx.profile,
      )
    ).map((r) => r.name as string),
  );
  if (rows.length === 1 && existing.has(rows[0].name))
    throw taken(rows[0].name);
  const fresh = rows.filter((r) => !existing.has(r.name));
  const ids = fresh.map(() => uid());
  // Dez mesas por instrução (9 parâmetros cada; o D1 aceita até 100 por
  // instrução): 100 mesas são 10 instruções, não 100.
  const chunks: [string, any[]][] = [];
  for (let i = 0; i < fresh.length; i += 10) {
    const part = fresh.slice(i, i + 10);
    chunks.push([
      `INSERT INTO mesas_tables(id,profile_id,name,kind,section,seats,position,created,updated) VALUES ${part.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")} ON CONFLICT DO NOTHING`,
      part.flatMap((r, j) => [
        ids[i + j],
        ctx.profile,
        r.name,
        r.kind,
        r.section,
        r.seats,
        r.position,
        at,
        at,
      ]),
    ]);
  }
  if (chunks.length) await batch(ctx.env, chunks);
  if (fresh.length)
    await ctx.publish(
      "mesas.tables_changed",
      ctx.profile,
      { created: fresh.map((r) => r.name), actor: actor.id },
      { key: `tables:create:${ids[0]}` },
    );
  // Comandos da área rodam um de cada vez (Coordinator): as mesas criadas
  // agora são as com este `created`.
  const created = ids.length
    ? await all(
        ctx.env,
        "SELECT * FROM mesas_tables WHERE profile_id=? AND created=? ORDER BY position,name",
        ctx.profile,
        at,
      )
    : [];
  return {
    data: created.map(tableView),
    skipped: rows.filter((r) => existing.has(r.name)).map((r) => r.name),
  };
}

/** PUT mesas/tables/:id: nome, tipo, ambiente, lugares e posição. */
export async function updateTable(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const table = await loadTable(ctx, data.id);
  const sets = fields(data, true);
  const keys = Object.keys(sets).filter((k) => sets[k] !== table[k]);
  if (!keys.length) return tableView(table);
  if (sets.name !== undefined && sets.name !== table.name) {
    const clash = await one(
      ctx.env,
      "SELECT id FROM mesas_tables WHERE profile_id=? AND name=? AND id<>?",
      ctx.profile,
      sets.name,
      table.id,
    );
    if (clash) throw taken(sets.name);
  }
  await exec(
    ctx.env,
    `UPDATE mesas_tables SET ${keys.map((k) => k + "=?").join(",")},updated=? WHERE id=? AND profile_id=?`,
    ...keys.map((k) => sets[k]),
    now(),
    table.id,
    ctx.profile,
  );
  // Conta aberta nesta mesa: o nome novo vale para ela (os pedidos da
  // cozinha mudam na próxima leitura da conta).
  if (keys.includes("name"))
    await exec(
      ctx.env,
      "UPDATE mesas_tabs SET table_name=?,updated=? WHERE table_id=? AND profile_id=? AND status IN ('open','closing')",
      sets.name,
      now(),
      table.id,
      ctx.profile,
    );
  await ctx.publish(
    "mesas.tables_changed",
    table.id,
    { updated: [table.id], actor: actor.id },
    { key: `tables:update:${table.id}:${now()}` },
  );
  return tableView(await loadTable(ctx, table.id));
}

/** DELETE mesas/tables/:id: só sem conta aberta. As contas fechadas ficam. */
export async function deleteTable(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
) {
  admin(actor);
  const table = await loadTable(ctx, id);
  const open = await one(
    ctx.env,
    "SELECT status FROM mesas_tabs WHERE table_id=? AND profile_id=? AND status IN ('open','closing') LIMIT 1",
    table.id,
    ctx.profile,
  );
  if (open && isLive(open.status))
    throw new ApiError(
      409,
      "table_in_use",
      `${table.name} está com a conta aberta. Feche ou transfira antes de apagar.`,
    );
  await exec(
    ctx.env,
    "DELETE FROM mesas_tables WHERE id=? AND profile_id=?",
    table.id,
    ctx.profile,
  );
  await ctx.publish(
    "mesas.tables_changed",
    table.id,
    { deleted: [table.id], actor: actor.id },
    { key: `tables:delete:${table.id}` },
  );
  return { deleted: true, id: table.id };
}
