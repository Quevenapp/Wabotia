// public.erp_catalog_contact_type_create: tipo de contato do usuário (até 100
// ativos; rótulo único sem acento nem caixa entre os ativos).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { textArg, uuidArg } from "../args.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { CNTRL, btrim, chars } from "../fields.ts";
import { fold } from "../internal.ts";

export function erpCatalogContactTypeCreate(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const command = uuidArg(a, "p_command_id");
  const raw = textArg(a, "p_label");
  const label = raw === null ? null : btrim(raw);
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  if (command === null || label === null || chars(label) < 1 || chars(label) > 60 || CNTRL.test(label))
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-type-create-v1", actor: user, label });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const key = fold(label);
  const active = db.exec('SELECT label FROM "erp_catalog__contact_type" WHERE active=1').rows;
  if (active.some((t) => fold(String(t.label)) === key)) raise("23505", "erp_catalog_contact_type_exists");
  if (active.length >= 100) raise("22023", "erp_catalog_contact_type_limit");
  const id = crypto.randomUUID();
  const slug = "t" + id.replace(/-/g, "");
  const position = Number(one(db, 'SELECT coalesce(max(position),0)+1 p FROM "erp_catalog__contact_type"')!.p);
  db.exec(
    `INSERT INTO "erp_catalog__contact_type"(id, slug, label, system, deletable, role_backed, position, active, created_by, created_at, label__fold)
     VALUES (?,?,?,0,1,0,?,1,?,?,?)`,
    id, slug, label, position, user, ctx.clock.next().toString(), key,
  );
  const item = { id, slug, label, system: false, deletable: true, position, contacts: 0 };
  const result = { scope: "contact_type", data_mode: "erp_native", replayed: false, item };
  auxiliaryAudit(ctx, { actor: user!, command, subject: "contact_type", subjectId: id, action: "create", after: item });
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_type_create", erpCatalogContactTypeCreate);
