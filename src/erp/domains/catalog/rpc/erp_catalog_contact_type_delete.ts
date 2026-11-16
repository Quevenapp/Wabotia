// public.erp_catalog_contact_type_delete: arquiva o tipo (só administrador)
// e desfaz os vínculos; a trilha guarda a linha anterior e os contatos.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { requireAccess } from "../access.ts";
import { uuidArg } from "../args.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { compareText } from "../fields.ts";

export function erpCatalogContactTypeDelete(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const command = uuidArg(a, "p_command_id");
  const id = uuidArg(a, "p_id");
  const db = ctx.db;
  const role = requireAccess(db, user, "contacts", false);
  if (role !== "admin") raise("42501", "erp_catalog_access_denied");
  if (command === null || id === null) raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-type-delete-v1", actor: user, id });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const t = one(
    db,
    `SELECT id, slug, label, system, deletable, role_backed, position, active, created_by,
     CAST(created_at AS TEXT) created_at, deleted_by, CAST(deleted_at AS TEXT) deleted_at
     FROM "erp_catalog__contact_type" WHERE id=?`,
    id,
  );
  if (!t || !Number(t.active)) raise("P0002", "erp_catalog_not_found");
  if (!Number(t.deletable)) raise("42501", "erp_catalog_contact_type_protected");
  // to_jsonb(v_type): a linha antes do arquivamento.
  const before = {
    id: t.id,
    slug: t.slug,
    label: t.label,
    system: !!Number(t.system),
    deletable: !!Number(t.deletable),
    role_backed: !!Number(t.role_backed),
    position: Number(t.position),
    active: true,
    created_by: t.created_by,
    created_at: jsonTimestamp(String(t.created_at)),
    deleted_by: t.deleted_by,
    deleted_at: t.deleted_at === null ? null : jsonTimestamp(String(t.deleted_at)),
  };
  const links = db
    .exec('SELECT contact_id FROM "erp_catalog__contact_type_link" WHERE type_id=?', id)
    .rows.map((l) => String(l.contact_id))
    .sort(compareText);
  db.exec('DELETE FROM "erp_catalog__contact_type_link" WHERE type_id=?', id);
  db.exec(
    'UPDATE "erp_catalog__contact_type" SET active=0, deleted_by=?, deleted_at=? WHERE id=?',
    user, ctx.clock.next().toString(), id,
  );
  const result = { scope: "contact_type_delete", data_mode: "erp_native", replayed: false, id, unlinked: links.length };
  auxiliaryAudit(ctx, {
    actor: user!, command, subject: "contact_type", subjectId: id, action: "archive", before, after: { unlinked_contacts: links },
  });
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_type_delete", erpCatalogContactTypeDelete);
