// public.erp_catalog_contact_set_situation: Ativo, Inativo, Sem movimento ou
// Excluído (active é a projeção A/S). Fora (Origin desligado): o UPDATE de
// erp_catalog.origin ('local_modified').
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactRequireVisible, contactSituationOf } from "../contact.ts";
import { contactDto } from "../contact-core.ts";
import { capture } from "../internal.ts";
import { updateRecord } from "../record.ts";

const MAX_VERSION = 2147483647;

export function erpCatalogContactSetSituation(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const situation = (a.p_situation ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  if (
    id === null || command === null || expected === null || expected < 1 || expected > MAX_VERSION ||
    situation === null || !["A", "I", "S", "E"].includes(situation)
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-situation-v1", actor: user, id, version: expected, situation });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const row = one(db, `SELECT name, code, active, CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id);
  if (!row) raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, id);
  if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
  const from = contactSituationOf(db, id);
  const changed = from !== situation;
  let before: unknown = null;
  if (changed) {
    if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    before = contactDto(db, id);
    updateRecord(
      ctx, id, { entity: "contacts", active: !!Number(row.active) },
      { name: String(row.name), code: (row.code as string | null) ?? null, active: situation === "A" || situation === "S" },
      user!,
    );
    if (one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=?', id))
      db.exec('UPDATE "erp_catalog__contact_profile" SET situation=? WHERE record_id=?', situation, id);
    else db.exec('INSERT INTO "erp_catalog__contact_profile"(record_id, situation) VALUES(?,?)', id, situation);
    capture(ctx, id, "upsert"); // zz_origin_sync de contact_profile
  }
  const result = { entity: "contacts", record: contactDto(db, id), replayed: false, data_mode: "erp_native" };
  if (changed)
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,'contacts',?,?,?,?,?)`,
      user, command, id, situation === "E" ? "archive" : "transition", before === null ? null : jsonbText(before),
      result.record === null ? null : jsonbText(result.record), ctx.clock.next().toString(),
    );
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_set_situation", erpCatalogContactSetSituation);
