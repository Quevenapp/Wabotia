import { batch, one } from "../../db";
import { hmac } from "../../security";
import { ApiError, now, type Actor } from "../../types";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";
import type { ModuleContext } from "../api";
import { classroom, enrollment, forbidden, notFound, staff, today } from "./access";
import { canonical, id, object } from "./model";
import { mutationId, replayChange } from "./store";

export const ensinoCustomerErasure = {
  state: "retained", reason: "private_retention_review",
} as const;

async function contact(ctx: ModuleContext, contactId: string) {
  if (!await one(ctx.env,
    "SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active'",
    ctx.profile, contactId)) notFound();
}

export const ensinoCustomerProvider: CustomerModuleProvider = {
  async section(ctx, actor, contactId, sectionId) {
    await staff(ctx, actor);
    if (sectionId !== "private") notFound();
    await contact(ctx, id(contactId));
    // Nenhuma consulta a alunos, responsáveis ou débitos para construir navegação.
    return { version: 1, writable: false, schema: "private.navigation.v1", data: {
      target: { module: "ensino", resource: "home", id: "ensino" },
      erasure: ensinoCustomerErasure,
    } };
  },
  async saveSection(ctx, actor) {
    await staff(ctx, actor, true);
    forbidden();
  },
};

/** Não concede/revalida autorização pedagógica e não altera a pessoa protegida. */
export async function linkEnsinoCustomer(
  ctx: ModuleContext, actor: Actor, raw: unknown, commandId: string, kind: "guardian" | "billing",
) {
  const d = object(raw, ["id", "enrollment_id", "contact_id", ...(kind === "guardian" ? ["guardian_id"] : [])]);
  const c = await classroom(ctx, actor, d.id, true, true);
  const e = await enrollment(ctx, c.id, d.enrollment_id);
  const contactId = id(d.contact_id);
  await contact(ctx, contactId);
  const entityId = kind === "guardian" ? id(d.guardian_id) : e.id;
  const table = kind === "guardian" ? "ensino_guardians" : "ensino_enrollments";
  const column = kind === "guardian" ? "contact_id" : "billing_contact_id";
  const row = await one<{ contact_id: string | null }>(ctx.env,
    `SELECT ${column} contact_id FROM ${table} WHERE profile_id=? AND id=? AND order_id=?`,
    ctx.profile, entityId, e.order_id);
  if (!row) notFound();
  if (kind === "guardian" && !await one(ctx.env,
    `SELECT g.id FROM ensino_guardians g JOIN os_people p
     ON p.profile_id=g.profile_id AND p.order_id=g.order_id AND p.id=g.person_id
     WHERE g.profile_id=? AND g.id=? AND g.order_id=? AND g.revoked_at IS NULL AND g.valid_until>=?
     AND p.archived_at IS NULL AND p.version=g.person_version AND p.sensitive=1 AND p.client_visible=0`,
    ctx.profile, entityId, e.order_id, today())) notFound();
  const op = `customer.${kind}.link`;
  const previous = await replayChange(ctx, actor, op, commandId, d);
  if (previous) return { contactId };
  // Uma nova identificação nunca reaponta o vínculo antigo silenciosamente.
  if (row.contact_id && row.contact_id !== contactId)
    throw new ApiError(409, "contact_conflict", "O registro já tem outro contato vinculado.");
  const key = await mutationId(ctx, actor, op, commandId);
  const guard = `ensino:customer:${key}`;
  const guardianGuard = kind === "guardian" ? `AND EXISTS(
    SELECT 1 FROM os_people p WHERE p.profile_id=ensino_guardians.profile_id
    AND p.order_id=ensino_guardians.order_id AND p.id=ensino_guardians.person_id
    AND p.archived_at IS NULL AND p.version=ensino_guardians.person_version
    AND p.sensitive=1 AND p.client_visible=0)
    AND revoked_at IS NULL AND valid_until>=?` : "";
  try { await batch(ctx.env, [
    [`UPDATE ${table} SET ${column}=? WHERE profile_id=? AND id=? AND order_id=?
      AND (${column} IS NULL OR ${column}=?)
      AND EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active') ${guardianGuard}`,
    [contactId, ctx.profile, entityId, e.order_id, contactId, ctx.profile, contactId, ...(kind === "guardian" ? [today()] : [])]],
    ["INSERT INTO customer_assert(id,ok) VALUES(?,changes())", [guard]],
    ["UPDATE ensino_classes SET version=version+1 WHERE profile_id=? AND id=? AND version=?", [ctx.profile, c.id, c.version]],
    [`INSERT INTO ensino_audit(profile_id,id,class_id,entity_id,operation,actor_id,version,request_hash,changed,created)
      VALUES(?,?,?,?,?,?,?,?,changes(),?)`,
    [ctx.profile, key, c.id, entityId, op, actor.id, c.version + 1, await hmac(ctx.env.MASTER_KEY, canonical(d)), now()]],
    ["DELETE FROM customer_assert WHERE id=?", [guard]],
  ]); } catch (error) {
    if (/CHECK constraint|UNIQUE constraint/.test(String(error)))
      throw new ApiError(409, "contact_conflict", "O vínculo mudou. Atualize a tela antes de continuar.");
    throw error;
  }
  return { contactId };
}
