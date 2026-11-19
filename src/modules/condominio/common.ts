import { z } from "zod";
import { all, one } from "../../db";
import { ApiError, now, type Actor, type Conversation } from "../../types";
import { normalizeCustomerPhone } from "../../customer/phone";
import type { Statement } from "../../customer/contracts";
import type { ModuleContext } from "../api";

export const id = z.string().trim().min(1).max(160);
export const text = (max: number) => z.string().trim().min(1).max(max);
export const instant = z.number().int().nonnegative().max(8640000000000000);
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new ApiError(
      400,
      "invalid_request",
      "Confira os campos e períodos informados.",
    );
  return result.data;
}
export function fail(
  code = "not_found",
  status = 404,
  message = "Registro indisponível.",
): never {
  throw new ApiError(status, code, message);
}
export function human(actor: Actor) {
  return (
    actor.kind === "user" &&
    !actor.via &&
    !actor.module &&
    !actor.credential &&
    !actor.id.startsWith("bot:")
  );
}
export async function staff(
  ctx: ModuleContext,
  actor: Actor,
  roles = ["admin"],
  write = false,
) {
  await ctx.requireEnabled();
  // Escopos de aplicação não habilitam acesso às operações privadas da equipe.
  if (!human(actor)) fail("forbidden", 403);
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  for (const role of roles) if (await ctx.granted(actor, role)) return;
  fail("forbidden", 403, "Papel do condomínio necessário para esta ação.");
}
export const active = "starts_at<=? AND (ends_at IS NULL OR ends_at>?)";
export const activeMembership =
  "m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?)";

// Sem marcador de maioridade no legado, dependentes ficam no domínio protegido.
export const publicPerson = `NOT EXISTS(SELECT 1 FROM cond_memberships protected
  WHERE protected.profile_id=p.profile_id AND protected.person_id=p.id AND protected.role='dependente')`;

export async function verifiedCustomer(ctx: ModuleContext, c: Conversation) {
  const ref = await ctx.customer(c);
  if (ref.state === "ambiguous")
    fail("customer_ambiguous", 409, "Confira a identidade do telefone antes de continuar.");
  const phone = normalizeCustomerPhone(ref.verifiedPhone, "international");
  if (c.profile_id !== ctx.profile || c.chat_type === "group" ||
      c.external_namespace.startsWith("app:") || ref.profileId !== ctx.profile ||
      ref.namespace !== "team" || ref.state !== "ready" || !ref.contactId ||
      !phone || phone !== ref.verifiedPhone || ctx.verifiedPhone(c) !== phone)
    fail("phone_not_verified", 409);
  if (!await one(ctx.env, `SELECT id FROM contacts WHERE profile_id=? AND id=?
    AND namespace='team' AND identity_state='active'`, ctx.profile, ref.contactId)) fail();
  return { contactId: ref.contactId, phone };
}

/** Cadastro canônico sozinho nunca substitui o telefone confirmado da extensão. */
export async function personIdentity(ctx: ModuleContext, c: Conversation, personId: string) {
  const identity = await verifiedCustomer(ctx, c);
  const at = now();
  const rows = await all(ctx.env, `SELECT ph.person_id FROM cond_phones ph
    JOIN cond_people p ON p.profile_id=ph.profile_id AND p.id=ph.person_id
    WHERE ph.profile_id=? AND ph.phone=? AND ph.starts_at<=? AND (ph.ends_at IS NULL OR ph.ends_at>?)
    AND p.contact_id=?`, ctx.profile, identity.phone, at, at, identity.contactId);
  if (rows.length !== 1 || rows[0].person_id !== personId) fail();
  return identity;
}

/** Comandos antigos também invalidam a versão da seção, no mesmo lote. */
export function touchUnits(profile: string, personId: string): Statement {
  return [`INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id,version)
    SELECT p.profile_id,p.contact_id,'condominio','units',2 FROM cond_people p
    WHERE p.profile_id=? AND p.id=? AND p.contact_id IS NOT NULL AND changes()=1
    ON CONFLICT(profile_id,contact_id,module_id,section_id) DO UPDATE SET version=version+1`,
    [profile, personId]];
}
export const tables = [
  "blocks",
  "units",
  "people",
  "phones",
  "memberships",
  "assets",
  "access",
  "works",
  "notices",
  "assemblies",
  "agenda",
  "proxies",
] as const;
export type Table = (typeof tables)[number];
export async function get(ctx: ModuleContext, table: Table, value: unknown) {
  const row = await one(
    ctx.env,
    `SELECT * FROM cond_${table} WHERE profile_id=? AND id=?`,
    ctx.profile,
    parse(id, value),
  );
  if (!row) fail();
  return row;
}
export function page(rows: any[], limit = 50) {
  const data = rows.slice(0, limit);
  return { data, next_cursor: rows.length > limit ? data.at(-1)!.id : null };
}
export async function memberships(
  ctx: ModuleContext,
  person: string,
  at = now(),
) {
  return all(
    ctx.env,
    `SELECT m.id,m.unit_id,m.role,u.number,b.name AS block
    FROM cond_memberships m JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
    JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE m.profile_id=? AND m.person_id=? AND ${activeMembership} ORDER BY m.unit_id,m.id LIMIT 201`,
    ctx.profile,
    person,
    at,
    at,
  );
}
export async function resident(
  ctx: ModuleContext,
  actor: Actor,
  accessId: string,
) {
  await ctx.requireEnabled();
  if (
    actor.via ||
    actor.module ||
    actor.id.startsWith("bot:") ||
    actor.credential?.module !== "condominio" ||
    actor.credential.subject !== accessId ||
    !actor.profiles.includes(ctx.profile)
  )
    fail("forbidden", 403);
  const access = await get(ctx, "access", accessId);
  if (access.expires_at <= now()) fail("access_expired", 410);
  const c = await ctx.conversation(access.conversation_id);
  if (
    c.profile_id !== ctx.profile ||
    c.chat_type === "group" ||
    ctx.verifiedPhone(c) !== access.phone
  )
    fail();
  const phone = await one(
    ctx.env,
    `SELECT person_id FROM cond_phones WHERE profile_id=? AND phone=? AND person_id=? AND ${active}`,
    ctx.profile,
    access.phone,
    access.person_id,
    now(),
    now(),
  );
  if (!phone) fail();
  await personIdentity(ctx, c, access.person_id);
  const units = await memberships(ctx, access.person_id);
  if (units.length > 200)
    fail(
      "too_many_units",
      409,
      "Procure a administração para revisar seus vínculos.",
    );
  return { access, c, units, person: access.person_id as string };
}
export type Resident = Awaited<ReturnType<typeof resident>>;
export function selected(r: Resident, explicit?: string) {
  const unit =
    explicit ||
    r.access.selected_unit_id ||
    (new Set(r.units.map((u) => u.unit_id)).size === 1
      ? r.units[0]?.unit_id
      : null);
  if (!unit)
    fail("unit_required", 409, "Escolha a unidade antes de continuar.");
  const membership = r.units.find((u) => u.unit_id === unit);
  if (!membership) fail();
  return membership;
}
