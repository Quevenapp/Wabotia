// public.erp_catalog_contact_comments (os 200 comentários mais recentes do
// contato) e public.erp_catalog_contact_comment_add (inclui um, até 1000 por
// contato), com erp_catalog.comment_dto.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { actorLabel } from "../../access/public.ts";
import { allowed, requireAccess } from "../access.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactRequireVisible } from "../contact.ts";

/** erp_catalog.comment_dto(p_id) */
function commentDto(db: SqlDriver, id: string) {
  const c = one(db, 'SELECT id, body, author, CAST(created_at AS TEXT) created_at FROM "erp_catalog__contact_comment" WHERE id=?', id);
  if (!c) return null;
  return { id: c.id, body: c.body, author_name: actorLabel(db, String(c.author)), created_at: jsonTimestamp(String(c.created_at)) };
}

const contactExists = (db: SqlDriver, id: string | null) =>
  id !== null && !!one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id);

export function erpCatalogContactComments(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const contact = (a.p_contact_id ?? null) as string | null;
  const db = ctx.db;
  const role = requireAccess(db, user, "contacts", false);
  if (!contactExists(db, contact)) raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, contact);
  const ids = db
    .exec('SELECT id FROM "erp_catalog__contact_comment" WHERE contact_id=? ORDER BY created_at DESC, id LIMIT 200', contact)
    .rows.map((r) => String(r.id));
  return {
    scope: "contact_comments",
    data_mode: "erp_native",
    contact_id: contact,
    can_comment: allowed(role, "contacts", true),
    items: ids.map((id) => commentDto(db, id)),
  };
}

export function erpCatalogContactCommentAdd(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const command = (a.p_command_id ?? null) as string | null;
  const contact = (a.p_contact_id ?? null) as string | null;
  const raw = (a.p_body ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  // btrim(p_body): só espaços; [[:cntrl:]] fora \n, \r e \t.
  const body = raw === null ? null : pgBtrim(raw);
  if (
    command === null || contact === null || body === null || pgLength(body) < 1 || pgLength(body) > 2000 ||
    pgHasCntrl.test(body.replace(/[\n\r\t]/g, ""))
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-comment-v1", actor: user, contact, body });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  if (!contactExists(db, contact)) raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, contact);
  const count = one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__contact_comment" WHERE contact_id=?', contact)!;
  if (Number(count.n) >= 1000) raise("22023", "erp_catalog_comment_limit");
  const id = crypto.randomUUID();
  db.exec(
    'INSERT INTO "erp_catalog__contact_comment"(id, contact_id, author, body, command_id, created_at) VALUES(?,?,?,?,?,?)',
    id, contact, user, body, command, ctx.clock.next().toString(),
  );
  const result = { scope: "contact_comment", data_mode: "erp_native", replayed: false, contact_id: contact, item: commentDto(db, id) };
  auxiliaryAudit(ctx, { actor: user!, command, subject: "contact_comment", subjectId: id, action: "create", after: { contact_id: contact } });
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_comments", erpCatalogContactComments);
registerRpc("erp_catalog_contact_comment_add", erpCatalogContactCommentAdd);
