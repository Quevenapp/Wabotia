import { z } from "zod";
import { all, one } from "../../db";
import { ApiError, now, type Actor } from "../../types";
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
