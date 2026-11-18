// Excluir selecionados dos relatórios e das etiquetas (migração 149):
// public.erp_preferences_framework_delete. Tudo ou nada, cada item pela versão.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { accessRequireAdmin } from "../../access/public.ts";
import { json, text, uuid } from "../args.ts";
import { frameworkHash, frameworkKeys, frameworkReplay, frameworkVersion } from "../framework.ts";
import { compareText } from "../order.ts";
import { labelDto } from "../label-defaults.ts";

/** erp_preferences.report_dto */
export function reportDto(r: Record<string, unknown>) {
  return {
    id: r.id,
    base: r.base,
    title: r.title,
    columns: JSON.parse(String(r.columns)),
    filters: JSON.parse(String(r.filters)),
    view_limit: Number(r.view_limit),
    with_totals: Number(r.with_totals) === 1,
    users: (JSON.parse(String(r.users)) as string[]).map(String).sort(compareText),
    version: Number(r.version),
    updated_at: jsonTimestamp(String(r.updated_at)),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function audit(db: SqlDriver, at: string, actor: string, command: string, area: string, action: string, target: string, before: unknown) {
  db.exec(
    `INSERT INTO "erp_preferences__framework_audit"(created_at, actor, command_id, area, action, target, before_data, after_data) VALUES (?,?,?,?,?,?,?,NULL)`,
    at,
    actor,
    command,
    area,
    action,
    target,
    jsonbText(before),
  );
}

export function erpPreferencesFrameworkDelete(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const target = text(a, "p_target");
  const items = json(a, "p_items") as Record<string, unknown>[] | null;
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  // NULL em p_items: como no Postgres, nenhuma das condições é verdadeira e o comando passa com count nulo.
  if (
    command === null ||
    target === null ||
    !["reports", "labels"].includes(target) ||
    (items !== null &&
      (jsonType(items) !== "array" ||
        items.length < 1 ||
        items.length > 100 ||
        items.some(
          (x) => !frameworkKeys(x, ["expected_version", "id"]) || jsonType(x.id) !== "string" || !UUID.test(x.id as string) || frameworkVersion(x.expected_version) === null,
        ) ||
        new Set(items.map((x) => x.id)).size !== items.length))
  )
    raise("22023", "erp_preferences_framework_input_invalid");
  const hash = frameworkHash({ op: "framework_delete", actor: user, target, items });
  const replay = frameworkReplay(db, command!, user!, target!, hash);
  if (replay) return replay;
  const at = ctx.clock.next().toString();
  const result = {
    scope: `${target}_command`,
    data_mode: "erp_native",
    receipt: {
      command_id: command,
      action: target === "reports" ? "reports_delete" : "labels_delete",
      target: null,
      count: items === null ? null : items.length,
      changed_at: jsonTimestamp(at),
    },
  };
  db.exec(
    'INSERT INTO "erp_preferences__framework_command"(id, actor, area, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    target,
    hash,
    jsonbText(result),
    at,
  );
  for (const i of [...(items ?? [])].sort((x, y) => compareText(x.id as string, y.id as string))) {
    const id = i.id as string;
    const expected = frameworkVersion(i.expected_version);
    if (target === "reports") {
      const r = one(db, 'SELECT * FROM "erp_preferences__report" WHERE id=?', id);
      if (!r) raise("P0002", "erp_preferences_report_not_found");
      if (Number(r.version) !== expected) raise("40001", "erp_preferences_report_version_conflict");
      db.exec('DELETE FROM "erp_preferences__report" WHERE id=?', id);
      audit(db, at, user!, command!, "reports", "report_delete", id, reportDto(r));
    } else {
      const t = one(db, 'SELECT * FROM "erp_preferences__label_template" WHERE id=?', id);
      if (!t) raise("P0002", "erp_preferences_label_not_found");
      if (Number(t.version) !== expected) raise("40001", "erp_preferences_label_version_conflict");
      db.exec('DELETE FROM "erp_preferences__label_template" WHERE id=?', id);
      audit(db, at, user!, command!, "labels", "label_delete", id, labelDto(t));
    }
  }
  return { ...result, replayed: false };
}

registerRpc("erp_preferences_framework_delete", erpPreferencesFrameworkDelete);
