// public.erp_finance_category_execute e public.erp_finance_category_tree:
// Categorias Financeiras em árvore (criar, alterar, ativar/inativar com as
// subcategorias, excluir sem uso, mover lançamentos, padrões e importação).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import {
  bool,
  byLowerThenId,
  categoryDefaultKind,
  categoryDre,
  categoryInUse,
  categoryName,
  categoryRow,
  categorySiblingTaken,
  categorySubtree,
  categoryView,
  cmpText,
  expected,
  field,
  flushDeferred,
  hasKey,
  insertAudit,
  insertCategory,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  reclassifyBorderos,
  reclassifyMovements,
  replayed,
  requestHash,
  requireAccess,
  setFlag,
  titleUpdateGuards,
  captureFinance,
  txt,
  updateCategory,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";

const ACTIONS = [
  "category_create",
  "category_update",
  "category_set_active",
  "category_delete",
  "category_move",
  "category_set_default",
  "category_import",
];

export function erpFinanceCategoryExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);

  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 131072) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;

  let result: Record<string, unknown>;
  let before: unknown = null;

  if (action === "category_create") {
    keys(data, ["kind", "parent_id", "name", "dre_group"]);
    const kind = txt(data, "kind", 20, true)!;
    if (!["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    const parent = uuidValue(field(data, "parent_id"), false);
    const name = categoryName(data, "name");
    const dre = categoryDre(field(data, "dre_group"), kind, parent === null);
    if (parent !== null) {
      const target = categoryRow(db, parent);
      if (!target || target.deleted_at !== null || target.kind !== kind) raise("22023", "erp_finance_invalid_parent");
      if (!bool(target.active)) raise("40001", "erp_finance_category_parent_inactive");
    }
    if (categorySiblingTaken(db, kind, parent, name, null)) raise("23505", "erp_finance_category_duplicate");
    const id = insertCategory(ctx, { name, kind, parent_id: parent, dre_group: dre });
    result = { record: categoryView(db, id) };
  } else if (["category_update", "category_set_active", "category_delete"].includes(action)) {
    keys(
      data,
      action === "category_update"
        ? ["id", "expected_version", "name", "dre_group"]
        : action === "category_set_active"
          ? ["id", "expected_version", "active"]
          : ["id", "expected_version"],
    );
    const id = uuidValue(field(data, "id"))!;
    const category = categoryRow(db, id);
    if (!category || category.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    if (category.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    before = categoryView(db, id);
    if (action === "category_update") {
      const name = categoryName(data, "name");
      const dre = hasKey(data, "dre_group")
        ? categoryDre(field(data, "dre_group"), String(category.kind), category.parent_id === null)
        : (category.dre_group as string | null);
      if (categorySiblingTaken(db, String(category.kind), category.parent_id as string | null, name, id))
        raise("23505", "erp_finance_category_duplicate");
      updateCategory(ctx, id, { name, dre_group: dre });
      result = { record: categoryView(db, id) };
    } else if (action === "category_set_active") {
      const active = field(data, "active");
      if (jsonType(active) !== "boolean") raise("22023", "erp_finance_invalid_active");
      if (active === bool(category.active)) raise("40001", "erp_finance_version_conflict");
      if (active) {
        if (
          category.parent_id !== null &&
          !one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1', category.parent_id)
        )
          raise("40001", "erp_finance_category_parent_inactive");
        updateCategory(ctx, id, { active: true });
      } else {
        // Inativar a categoria inativa também as subcategorias.
        const ids = categorySubtree(db, id).sort(cmpText);
        for (const sub of ids) {
          const row = categoryRow(db, sub);
          if (row && bool(row.active)) updateCategory(ctx, sub, { active: false });
        }
      }
      result = { record: categoryView(db, id) };
    } else {
      // Excluir só categoria sem subcategorias e sem lançamentos.
      if (
        one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE parent_id=? AND deleted_at IS NULL LIMIT 1', id) ||
        categoryInUse(db, id) ||
        one(db, 'SELECT 1 x FROM "erp_finance__category_default" WHERE category_id=? LIMIT 1', id)
      )
        raise("40001", "erp_finance_category_in_use");
      const now = ctx.clock.next().toString();
      updateCategory(ctx, id, { active: false, deleted_at: now, deleted_by: user });
      result = { record: { id, deleted: true } };
    }
  } else if (action === "category_move") {
    // Mover categorias: todos os lançamentos da categoria e das subcategorias passam para a de destino.
    keys(data, ["id", "expected_version", "target_id", "confirmed"]);
    if (field(data, "confirmed") !== true) raise("22023", "erp_finance_move_unconfirmed");
    const id = uuidValue(field(data, "id"))!;
    const targetId = uuidValue(field(data, "target_id"))!;
    const category = categoryRow(db, id);
    if (!category || category.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    if (category.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    const target = categoryRow(db, targetId);
    if (!target || target.deleted_at !== null || !bool(target.active) || target.kind !== category.kind)
      raise("22023", "erp_finance_invalid_category");
    const ids = categorySubtree(db, id).sort(cmpText);
    if (ids.includes(targetId)) raise("22023", "erp_finance_invalid_category");
    before = categoryView(db, id);
    setFlag(ctx, "erp_finance.reclassify", "on");
    // Contas excluídas ficam como estão; as demais mudam de versão, como numa edição.
    const titles = db.exec(
      `SELECT * FROM "erp_finance__title" WHERE category_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
      JSON.stringify(ids),
    ).rows;
    for (const t of titles) {
      const set = titleUpdateGuards(ctx, t, {
        category_id: targetId,
        version: Number(t.version) + 1,
        updated_at: ctx.clock.next().toString(),
      });
      writeRow(ctx, "erp_finance__title", "id", t.id, set);
      captureFinance(ctx, "title", String(t.id));
    }
    const { borderos, items } = reclassifyBorderos(ctx, ids, targetId);
    const movements = reclassifyMovements(
      ctx,
      "category_id IN (SELECT value FROM json_each(?))",
      [JSON.stringify(ids)],
      targetId,
    );
    setFlag(ctx, "erp_finance.reclassify", "");
    result = {
      record: categoryView(db, id),
      target: categoryView(db, targetId),
      moved: { titles: titles.length, borderos, settlements: items, movements },
    };
  } else if (action === "category_set_default") {
    keys(data, ["key", "category_id", "expected_version"]);
    const key = txt(data, "key", 40, true)!;
    const current = one(db, 'SELECT key, category_id, version FROM "erp_finance__category_default" WHERE key=?', key);
    if (!current) raise("22023", "erp_finance_invalid_data");
    if (current.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    const id = uuidValue(field(data, "category_id"), false);
    if (id !== null) {
      const category = categoryRow(db, id);
      if (!category || category.deleted_at !== null || !bool(category.active) || category.kind !== categoryDefaultKind(key))
        raise("22023", "erp_finance_invalid_category");
    }
    before = { key, category_id: current.category_id, version: current.version };
    db.exec(
      'UPDATE "erp_finance__category_default" SET category_id=?, version=version+1, actor=?, updated_at=? WHERE key=?',
      id,
      user,
      ctx.clock.next().toString(),
      key,
    );
    result = { record: { key, category_id: id, version: Number(current.version) + 1 } };
  } else {
    // Importar categorias: pais antes dos filhos; nomes que já existem no mesmo nível ficam.
    keys(data, ["kind", "rows"]);
    const kind = txt(data, "kind", 20, true)!;
    if (!["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    const rows = field(data, "rows");
    if (jsonType(rows) !== "array" || (rows as unknown[]).length < 1 || (rows as unknown[]).length > 500)
      raise("22023", "erp_finance_invalid_items");
    const created: string[] = [];
    let skipped = 0;
    for (const row of rows as unknown[]) {
      keys(row, ["name", "parent", "dre_group"]);
      const name = categoryName(row, "name");
      let parent: string | null = null;
      if (hasKey(row, "parent") && field(row, "parent") !== null) {
        const parentName = pgLower(categoryName(row, "parent"));
        const matches = db
          .exec('SELECT id, name FROM "erp_finance__category" WHERE kind=? AND deleted_at IS NULL', kind)
          .rows.filter((r) => pgLower(String(r.name)) === parentName)
          .map((r) => String(r.id))
          .sort(cmpText);
        if (matches.length !== 1) raise("22023", "erp_finance_import_parent");
        parent = matches[0];
        // Uma subcategoria nunca nasce ativa sob uma categoria inativa.
        if (!one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1', parent))
          raise("40001", "erp_finance_category_parent_inactive");
      }
      if (categorySiblingTaken(db, kind, parent, name, null)) {
        skipped++;
        continue;
      }
      created.push(insertCategory(ctx, { name, kind, parent_id: parent, dre_group: categoryDre(field(row, "dre_group"), kind, parent === null) }));
    }
    result = { created, skipped };
  }

  requireAccess(db, user, true);
  result = { ...result, entity: "categories_tree", action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  flushDeferred(ctx);
  return result;
}

export function erpFinanceCategoryTree(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const kind = (a.p_kind as string | null) ?? null;
  requireAccess(db, user, false);
  if (kind === null || !["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_query");
  const rows = db.exec('SELECT id, name FROM "erp_finance__category" WHERE kind=? AND deleted_at IS NULL', kind).rows;
  if (rows.length > 2000) raise("54000", "erp_finance_category_limit");
  const items = rows.sort(byLowerThenId("name")).map((r) => categoryView(db, String(r.id)));
  const defaults = db.exec('SELECT key, category_id, version FROM "erp_finance__category_default"').rows;
  return {
    entity: "category_tree",
    kind,
    items,
    defaults: defaults.length
      ? Object.fromEntries(defaults.map((d) => [d.key, { category_id: d.category_id, version: d.version }]))
      : null,
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_category_execute", erpFinanceCategoryExecute);
registerRpc("erp_finance_category_tree", erpFinanceCategoryTree);
