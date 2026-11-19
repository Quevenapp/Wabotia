import { z } from "zod";
import { all, batch, exec, one } from "../../db";
import { now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { authorizedOrder, resolveWorkType } from "../os/public";
import { projectOrderForCustomer, projectOrderForStaff } from "../os/privacy";
import {
  active,
  activeMembership,
  fail,
  get,
  id,
  page,
  parse,
  resident,
  selected,
  staff,
  text,
  publicPerson,
} from "./common";

export const workTypes = {
  ocorrencia: "area_condominios__ocorrencia",
  encomenda: "area_condominios__encomenda",
  visitante: "area_condominios__visitante",
} as const;
export async function workCatalog(
  ctx: ModuleContext,
  actor: Actor,
  accessId?: string,
) {
  if (accessId) await resident(ctx, actor, accessId);
  else await staff(ctx, actor, ["admin", "portaria"]);
  const admin = !accessId && (await ctx.granted(actor, "admin"));
  const types = [];
  for (const [kind, typeId] of Object.entries(workTypes)) {
    if (
      (!admin && !accessId && kind === "ocorrencia") ||
      (accessId && kind === "encomenda")
    )
      continue;
    const t = await resolveWorkType(ctx, typeId);
    if (!t.archived)
      types.push({
        kind,
        label: t.labels.singular,
        fields: t.fields.filter(
          (f) => f.client_visible && !f.sensitive && f.id !== "unidade",
        ),
      });
  }
  return { data: types };
}
const createSchema = z.object({
  kind: z.enum(["ocorrencia", "encomenda", "visitante"]),
  unit_id: id.optional(),
  person_id: id.optional(),
  visitor_person_id: id.nullable().optional(),
  delivery_source: z.enum(["marketplace", "correios", "outro"]).nullable().optional(),
  item: text(200),
  problem: text(2000),
  extra: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
});
export async function createWork(
  ctx: ModuleContext,
  actor: Actor,
  input: unknown,
  key: string,
  accessId?: string,
) {
  const d = parse(createSchema, input);
  if ((d.visitor_person_id && d.kind !== "visitante") || (d.delivery_source && d.kind !== "encomenda"))
    fail("invalid_request", 400);
  let membership: any,
    phone: string,
    person: string,
    conversationId: string | undefined;
  if (accessId) {
    const r = await resident(ctx, actor, accessId);
    membership = selected(r, d.unit_id);
    person = r.person;
    phone = r.access.phone;
    conversationId = r.c.id;
    if (d.kind === "encomenda")
      fail(
        "forbidden",
        403,
        "O recebimento de encomenda é registrado pela portaria.",
      );
  } else {
    await staff(
      ctx,
      actor,
      d.kind === "ocorrencia" ? ["admin"] : ["admin", "portaria"],
      true,
    );
    person = parse(id, d.person_id);
    membership = await one(
      ctx.env,
      `SELECT m.id,m.unit_id,u.number,b.name AS block FROM cond_memberships m
      JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
      JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
      WHERE m.profile_id=? AND m.person_id=? AND m.unit_id=? AND ${activeMembership} ORDER BY m.id LIMIT 1`,
      ctx.profile,
      person,
      parse(id, d.unit_id),
      now(),
      now(),
    );
    if (!membership) fail();
    const p = await one(
      ctx.env,
      `SELECT phone FROM cond_phones WHERE profile_id=? AND person_id=? AND ${active} ORDER BY id LIMIT 1`,
      ctx.profile,
      person,
      now(),
      now(),
    );
    if (!p)
      fail(
        "phone_required",
        409,
        "Vincule um telefone verificado antes de abrir o trabalho.",
      );
    phone = p.phone;
  }
  if (d.visitor_person_id) {
    // Cadastro de visitante recorrente identifica a visita; não autoriza entrada.
    if (!await one(ctx.env, `SELECT p.id FROM cond_people p JOIN cond_person_functions f
      ON f.profile_id=p.profile_id AND f.person_id=p.id WHERE p.profile_id=? AND p.id=?
      AND ${publicPerson} AND f.role='visitante_recorrente' AND f.unit_id=?
      AND f.starts_at<=? AND (f.ends_at IS NULL OR f.ends_at>?)`,
      ctx.profile, d.visitor_person_id, membership.unit_id, now(), now())) fail();
  }
  const type = await resolveWorkType(ctx, workTypes[d.kind]);
  if (accessId && !type.features.customer_open) fail("feature_disabled", 409);
  if (
    type.archived ||
    !type.fields.some((f) => f.id === "unidade")
  )
    fail("type_unavailable", 409);
  // Nunca permitir que cliente ou portaria injete campos internos/sensíveis.
  for (const field of Object.keys(d.extra))
    if (
      field !== "unidade" &&
      !type.fields.some(
        (f) => f.id === field && f.client_visible && !f.sensitive,
      )
    )
      fail("private_field", 400);
  const unitLabel = `${membership.block} · ${membership.number}`;
  const motorActor = ctx.moduleActor({ reach: ["os"] });
  const personRow = await get(ctx, "people", person);
  if (!await one(ctx.env, `SELECT p.id FROM cond_people p WHERE p.profile_id=? AND p.id=? AND ${publicPerson}`,
    ctx.profile, person)) fail("forbidden", 403);
  const order = await ctx.run(
    motorActor,
    "os.create",
    {
      type_id: type.id,
      conversation_id: conversationId,
      phone,
      customer_name: personRow.name,
      item: d.item,
      problem: d.problem,
      // A unidade privada do modelo corrigido vive no vínculo cond_works.
      // O ator técnico não recebe permissão clínica/sensível do motor.
      extra: { ...Object.fromEntries(Object.entries(d.extra).filter(([id]) => id !== "unidade")),
        ...(type.fields.some(f => f.id === "unidade" && !f.sensitive) ? { unidade: unitLabel } : {}) },
      notify: false,
    },
    `cond-work:${key}`,
  );
  const guard = `cond-work:${ctx.profile}:${key}:details`;
  await batch(ctx.env, [
    ["INSERT INTO cond_works(profile_id,id,unit_id,person_id,membership_id,kind,created_at,source_key) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,source_key) DO NOTHING",
      [ctx.profile, order.id, membership.unit_id, person, membership.id, d.kind, now(), key]],
    ["INSERT INTO cond_portaria_details(profile_id,work_id,visitor_person_id,delivery_source) VALUES(?,?,?,?) ON CONFLICT(profile_id,work_id) DO NOTHING",
      [ctx.profile, order.id, d.visitor_person_id ?? null, d.delivery_source ?? null]],
    [`INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM cond_works w
      JOIN cond_portaria_details pd ON pd.profile_id=w.profile_id AND pd.work_id=w.id
      WHERE w.profile_id=? AND w.id=? AND w.source_key=? AND w.person_id=? AND w.unit_id=?
      AND w.membership_id=? AND w.kind=? AND pd.visitor_person_id IS ? AND pd.delivery_source IS ?) THEN 1 ELSE 0 END)`,
      [guard, ctx.profile, order.id, key, person, membership.unit_id, membership.id, d.kind, d.visitor_person_id ?? null, d.delivery_source ?? null]],
    ["DELETE FROM customer_assert WHERE id=?", [guard]],
  ]);
  return { id: order.id, unit: unitLabel };
}

export async function works(
  ctx: ModuleContext,
  actor: Actor,
  query: Record<string, string>,
  accessId?: string,
) {
  let person: string | undefined, membership: any;
  if (accessId) {
    const r = await resident(ctx, actor, accessId);
    membership = selected(r, query.unit_id);
    person = r.person;
  } else await staff(ctx, actor, ["admin", "portaria"]);
  const admin = !accessId && (await ctx.granted(actor, "admin"));
  return page(
    await all(
      ctx.env,
      `SELECT w.id,w.kind,u.number AS unit,b.name AS block
    FROM cond_works w JOIN cond_units u ON u.profile_id=w.profile_id AND u.id=w.unit_id
    JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE w.profile_id=? AND w.id>? ${person ? "AND w.person_id=? AND w.unit_id=? AND w.membership_id=?" : admin ? "" : "AND w.kind IN ('encomenda','visitante')"}
    ORDER BY w.id LIMIT 51`,
      ctx.profile,
      query.cursor || "",
      ...(person ? [person, membership.unit_id, membership.id] : []),
    ),
  );
}

export async function workDetail(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  accessId?: string,
) {
  if (!accessId) await staff(ctx, actor, ["admin", "portaria"]);
  const link = await get(ctx, "works", orderId);
  let motorActor = actor;
  if (accessId) {
    const r = await resident(ctx, actor, accessId);
    const m = r.units.find(
      (u) => u.unit_id === link.unit_id && u.id === link.membership_id,
    );
    if (!m || r.person !== link.person_id) fail();
    motorActor = ctx.moduleActor({ reach: ["os"] });
    const order = await authorizedOrder(ctx, motorActor, orderId, {
      conversation_id: r.c.id,
    });
    return projectOrderForCustomer(ctx, motorActor, order);
  }
  const admin = await ctx.granted(actor, "admin");
  if (!admin && !["encomenda", "visitante"].includes(link.kind)) fail();
  const order = await authorizedOrder(ctx, actor, orderId);
  const view = projectOrderForStaff(ctx, actor, order);
  const portaria = await one(ctx.env, `SELECT visitor_person_id,delivery_source,version
    FROM cond_portaria_details WHERE profile_id=? AND work_id=?`, ctx.profile, orderId);
  if (admin) return { ...view, portaria };
  // Lista explícita: orçamento, observações, relatos, placas e documentos nunca entram.
  const unit = await get(ctx, "units", link.unit_id);
  return {
    id: view.id,
    kind: link.kind,
    name: view.customer.name,
    phone: order.row.phone,
    unit: unit.number,
    block_id: unit.block_id,
    stage: view.stage_label,
    version: view.version,
    portaria,
    actions: view.next_stages
      .filter((s) => s.kind === "manual")
      .map((s) => ({ id: s.transition_id, label: s.stage_label })),
  };
}

export async function moveWork(
  ctx: ModuleContext,
  actor: Actor,
  input: unknown,
  key: string,
) {
  await staff(ctx, actor, ["admin", "portaria"], true);
  const d = parse(
    z.object({ id, transition_id: id, version: z.number().int().positive() }),
    input,
  );
  const link = await get(ctx, "works", d.id);
  if (
    !(await ctx.granted(actor, "admin")) &&
    !["encomenda", "visitante"].includes(link.kind)
  )
    fail();
  const order = await authorizedOrder(ctx, actor, d.id, { write: true });
  if (
    order.type.id !== workTypes[link.kind as keyof typeof workTypes] ||
    !order.type.transitions.some(
      (t) => t.id === d.transition_id && t.kind === "manual",
    )
  )
    fail();
  const result = await ctx.run(
    ctx.moduleActor({ reach: ["os"] }),
    "os.stage",
    d,
    `cond-stage:${key}`,
  );
  await exec(
    ctx.env,
    "INSERT INTO cond_audit(profile_id,id,entity_id,action,actor_id,created_at) VALUES(?,?,?,'work_stage',?,?) ON CONFLICT(profile_id,id) DO NOTHING",
    ctx.profile,
    `stage:${key}`,
    d.id,
    actor.id,
    now(),
  );
  return { id: result.id, version: result.version };
}
