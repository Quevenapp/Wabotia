import { z } from "zod";
import { all, exec, one } from "../../db";
import { now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import {
  active,
  activeMembership,
  fail,
  get,
  id,
  instant,
  page,
  parse,
  staff,
  text,
} from "./common";

const period = {
  starts_at: instant,
  ends_at: instant.nullable().default(null),
};
export async function cadastro(
  ctx: ModuleContext,
  actor: Actor,
  action: string,
  input: unknown,
  key: string,
) {
  await staff(ctx, actor, ["admin"], true);
  const profile = ctx.profile;
  if (action === "block") {
    const d = parse(z.object({ name: text(80) }), input);
    await exec(
      ctx.env,
      "INSERT INTO cond_blocks(profile_id,id,name) VALUES(?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      profile,
      key,
      d.name,
    );
  } else if (action === "unit") {
    const d = parse(
      z.object({
        block_id: id,
        number: text(40),
        fraction_ppb: z
          .number()
          .int()
          .min(1)
          .max(1000000000)
          .nullable()
          .default(null),
      }),
      input,
    );
    await get(ctx, "blocks", d.block_id);
    await exec(
      ctx.env,
      "INSERT INTO cond_units(profile_id,id,block_id,number,fraction_ppb) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      profile,
      key,
      d.block_id,
      d.number,
      d.fraction_ppb,
    );
  } else if (action === "person") {
    const d = parse(z.object({ name: text(120) }), input);
    await exec(
      ctx.env,
      "INSERT INTO cond_people(profile_id,id,name) VALUES(?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      profile,
      key,
      d.name,
    );
  } else if (action === "phone") {
    const d = parse(
      z.object({
        person_id: id,
        conversation_id: id,
        confirmed: z.literal(true),
      }),
      input,
    );
    await get(ctx, "people", d.person_id);
    const c = await ctx.conversation(d.conversation_id, actor);
    const phone = ctx.verifiedPhone(c);
    if (!phone || c.chat_type === "group" || c.profile_id !== profile)
      fail("phone_not_verified", 409);
    const other = await one(
      ctx.env,
      "SELECT id FROM cond_phones WHERE profile_id=? AND phone=? AND ends_at IS NULL",
      profile,
      phone,
    );
    if (other && other.id !== key)
      fail(
        "phone_in_use",
        409,
        "Encerre o vínculo anterior após conferir a identidade.",
      );
    await exec(
      ctx.env,
      "INSERT INTO cond_phones(profile_id,id,person_id,phone,verified_by,starts_at) VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      profile,
      key,
      d.person_id,
      phone,
      actor.id,
      now(),
    );
  } else if (action === "membership") {
    const d = parse(
      z.object({
        person_id: id,
        unit_id: id,
        role: z.enum([
          "proprietario",
          "inquilino",
          "dependente",
          "funcionario",
        ]),
        ...period,
        notices: z.boolean().default(false),
      }),
      input,
    );
    if (d.ends_at !== null && d.ends_at <= d.starts_at)
      fail("invalid_period", 400);
    if (d.role === "dependente" && d.notices)
      fail(
        "invalid_recipient",
        400,
        "Comunicados a dependentes devem passar pelo responsável.",
      );
    await get(ctx, "people", d.person_id);
    await get(ctx, "units", d.unit_id);
    await exec(
      ctx.env,
      "INSERT INTO cond_memberships(profile_id,id,person_id,unit_id,role,starts_at,ends_at,verified_by,notices) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      profile,
      key,
      d.person_id,
      d.unit_id,
      d.role,
      d.starts_at,
      d.ends_at,
      actor.id,
      +d.notices,
    );
  } else if (action === "end-membership" || action === "end-phone") {
    const d = parse(z.object({ id }), input);
    const table = action === "end-phone" ? "phones" : "memberships";
    const row = await get(ctx, table, d.id);
    const at = now();
    // Vínculo futuro pode ser cancelado; não chega a conceder acesso.
    await exec(
      ctx.env,
      `UPDATE cond_${table} SET ends_at=? WHERE profile_id=? AND id=? AND (ends_at IS NULL OR ends_at>?)`,
      Math.max(at, row.starts_at),
      profile,
      row.id,
      at,
    );
    return { id: row.id };
  } else if (action === "asset") {
    const d = parse(
      z.object({
        unit_id: id,
        person_id: id,
        kind: z.enum(["vehicle", "animal"]),
        label: text(80),
        detail: text(160),
      }),
      input,
    );
    if (
      !(await one(
        ctx.env,
        `SELECT id FROM cond_memberships WHERE profile_id=? AND unit_id=? AND person_id=? AND ${active}`,
        profile,
        d.unit_id,
        d.person_id,
        now(),
        now(),
      ))
    )
      fail();
    await exec(
      ctx.env,
      "INSERT INTO cond_assets(profile_id,id,unit_id,person_id,kind,label,detail) VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      profile,
      key,
      d.unit_id,
      d.person_id,
      d.kind,
      d.label,
      d.detail,
    );
  } else fail();
  return { id: key };
}

export async function directory(
  ctx: ModuleContext,
  actor: Actor,
  kind: string,
  query: Record<string, string>,
) {
  await staff(
    ctx,
    actor,
    kind === "contacts" ? ["admin", "portaria"] : ["admin"],
  );
  const after = query.cursor || "";
  if (kind === "contacts") {
    // Portaria: somente nome, unidade e telefone. Sem papel, veículo ou finanças.
    const rows = await all(
      ctx.env,
      `SELECT m.id,m.person_id,m.unit_id,p.name,b.name AS block,u.number AS unit,
      (SELECT ph.phone FROM cond_phones ph WHERE ph.profile_id=p.profile_id AND ph.person_id=p.id AND ph.starts_at<=? AND (ph.ends_at IS NULL OR ph.ends_at>?) ORDER BY ph.id LIMIT 1) AS phone
      FROM cond_memberships m JOIN cond_people p ON p.profile_id=m.profile_id AND p.id=m.person_id
      JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
      JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
      WHERE m.profile_id=? AND m.id>? AND ${activeMembership} ORDER BY m.id LIMIT 51`,
      now(),
      now(),
      ctx.profile,
      after,
      now(),
      now(),
    );
    return page(rows);
  }
  const cols: Record<string, string> = {
    blocks: "id,name",
    units: "id,block_id,number,fraction_ppb",
    people: "id,name",
    memberships: "id,person_id,unit_id,role,starts_at,ends_at,notices",
    phones: "id,person_id,phone,starts_at,ends_at",
    assets: "id,unit_id,person_id,kind,label,detail",
  };
  if (!cols[kind]) fail();
  if (kind === "memberships")
    return page(
      await all(
        ctx.env,
        `SELECT m.id,m.person_id,m.unit_id,m.role,m.starts_at,m.ends_at,m.notices,p.name AS person_name,b.name||' · '||u.number AS unit_label
    FROM cond_memberships m JOIN cond_people p ON p.profile_id=m.profile_id AND p.id=m.person_id
    JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE m.profile_id=? AND m.id>? ORDER BY m.id LIMIT 51`,
        ctx.profile,
        after,
      ),
    );
  if (kind === "phones")
    return page(
      await all(
        ctx.env,
        `SELECT ph.id,ph.person_id,ph.phone,ph.starts_at,ph.ends_at,p.name AS person_name
    FROM cond_phones ph JOIN cond_people p ON p.profile_id=ph.profile_id AND p.id=ph.person_id
    WHERE ph.profile_id=? AND ph.id>? ORDER BY ph.id LIMIT 51`,
        ctx.profile,
        after,
      ),
    );
  if (kind === "units")
    return page(
      await all(
        ctx.env,
        `SELECT u.id,u.block_id,u.number,u.fraction_ppb,b.name AS block
    FROM cond_units u JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE u.profile_id=? AND u.id>? ORDER BY u.id LIMIT 51`,
        ctx.profile,
        after,
      ),
    );
  return page(
    await all(
      ctx.env,
      `SELECT ${cols[kind]} FROM cond_${kind} WHERE profile_id=? AND id>? ORDER BY id LIMIT 51`,
      ctx.profile,
      after,
    ),
  );
}
