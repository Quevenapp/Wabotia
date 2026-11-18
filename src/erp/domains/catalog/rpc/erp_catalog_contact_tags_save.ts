// public.erp_catalog_contact_tags_save: troca (replace, com versão) ou
// acrescenta (add) etiquetas de contato, até 50 por contato. Versão e
// auditoria só quando o conjunto muda; contato Excluído é só leitura.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactRequireVisible, contactSituationOf } from "../contact.ts";
import { contactTagBump, contactTagIds, contactTagsData } from "../contact-tags.ts";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function erpCatalogContactTagsSave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  // jsonb: texto JSON vira valor (texto inválido → 22P02, como o cast do Postgres).
  const tagIds = jsonArg(a, "p_tag_ids");
  const mode = (a.p_mode ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  const list = Array.isArray(tagIds) ? (tagIds as unknown[]) : null;
  if (
    id === null ||
    command === null ||
    mode === null ||
    !["replace", "add"].includes(mode) ||
    (mode === "replace" && (expected === null || expected < 0 || expected > 2147483646)) ||
    (mode === "add" && expected !== null) ||
    list === null ||
    list.length > 50 ||
    (mode === "add" && list.length === 0) ||
    list.some((t) => typeof t !== "string" || !UUID.test(t))
  )
    raise("22023", "erp_catalog_invalid_command");
  // (t#>>'{}')::uuid: forma canônica, minúscula.
  const tags = [...new Set((list as string[]).map((t) => t.toLowerCase()))];
  if (tags.length !== list.length) raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ actor: user, action: "contact_tags", id, version: expected, mode, tags: tagIds });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const valid = tags.filter((t) =>
    one(db, `SELECT 1 x FROM "erp_catalog__taxonomy" WHERE id=? AND kind='tags' AND tag_type='contacts'`, t),
  ).length;
  if (valid !== tags.length) raise("22023", "erp_catalog_invalid_reference");
  if (!one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id)) raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, id);
  if (contactSituationOf(db, id) === "E") raise("22023", "erp_catalog_contact_deleted");
  const state = one(db, 'SELECT CAST(version AS TEXT) version FROM "erp_catalog__contact_tag_state" WHERE record_id=?', id);
  const current = state ? Number(state.version) : 0;
  if (mode === "replace" && current !== expected) raise("40001", "erp_catalog_version_conflict");
  const before = contactTagIds(db, id);
  if (mode === "replace")
    for (const old of before) if (!tags.includes(old)) db.exec('DELETE FROM "erp_catalog__contact_tag" WHERE record_id=? AND tag_id=?', id, old);
  for (const t of tags) db.exec('INSERT INTO "erp_catalog__contact_tag"(record_id, tag_id) VALUES (?,?) ON CONFLICT DO NOTHING', id, t);
  const total = Number(one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__contact_tag" WHERE record_id=?', id)!.n);
  if (total > 50) raise("22023", "erp_catalog_invalid_list");
  const after = contactTagIds(db, id);
  const changed = jsonbText(after) !== jsonbText(before);
  if (changed) {
    contactTagBump(ctx, user!, id);
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES (?,?,'contacts',?,?,?,?,?)`,
      user,
      command,
      id,
      mode === "add" ? "tags_added" : "tags_update",
      jsonbText({ tag_ids: before }),
      jsonbText({ tag_ids: after }),
      ctx.clock.next().toString(),
    );
  }
  const result = { entity: "contacts", contact: contactTagsData(db, id), changed, replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_tags_save", erpCatalogContactTagsSave);
