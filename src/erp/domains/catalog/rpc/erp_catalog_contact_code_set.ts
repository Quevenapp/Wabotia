// public.erp_catalog_contact_code_set: próximo número do código de contato
// (só administrador; nunca volta a um código já usado).
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactCodeCounter, highestContactCode } from "../contact-code.ts";
import { contactCode } from "./erp_catalog_contact_code.ts";

export function erpCatalogContactCodeSet(ctx: RpcContext, a: RpcArgs) {
  const user = ((a.p_user_id ?? null) as string | null);
  const command = ((a.p_command_id ?? null) as string | null);
  const expected = ((a.p_expected_version ?? null) as number | null);
  const next = ((a.p_next_number ?? null) as string | null);
  const db = ctx.db;
  const role = requireAccess(db, user, "contacts", false);
  if (role !== "admin") raise("42501", "erp_catalog_access_denied");
  if (command === null || expected === null || expected < 0 || expected > 2147483646 || next === null || !/^[1-9][0-9]{0,14}$/.test(next))
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-code-v1", actor: user, version: expected, next });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const counter = contactCodeCounter(db);
  if ((counter?.version ?? 0) !== expected) raise("40001", "erp_catalog_version_conflict");
  if (BigInt(next) <= highestContactCode(db)) raise("22023", "erp_catalog_contact_code_used");
  const now = ctx.clock.next().toString();
  if (counter === null)
    db.exec(
      'INSERT INTO "erp_catalog__contact_code_counter"(id, next_number, version, updated_by, updated_at) VALUES (1,?,1,?,?)',
      next, user, now,
    );
  else
    db.exec(
      'UPDATE "erp_catalog__contact_code_counter" SET next_number=?, version=version+1, updated_by=?, updated_at=? WHERE id=1',
      next, user, now,
    );
  const result = { ...contactCode(ctx, user), replayed: false };
  auxiliaryAudit(ctx, {
    actor: user!,
    command,
    subject: "contact_code",
    subjectId: null,
    action: "next_number",
    before: { next_number: counter === null ? null : Number(counter.next) },
    after: { next_number: next },
  });
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_code_set", erpCatalogContactCodeSet);
