import { z } from "zod";
import { all, exec, one } from "../../db";
import { now, uid, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import {
  active,
  fail,
  get,
  id,
  instant,
  page,
  parse,
  resident,
  staff,
  text,
} from "./common";

const mesa = ["admin", "mesa"];
const objectId = z.object({ id });
async function owner(ctx: ModuleContext, person: string, unit: string) {
  return one(
    ctx.env,
    `SELECT id FROM cond_memberships WHERE profile_id=? AND person_id=? AND unit_id=? AND role='proprietario' AND ${active} ORDER BY id LIMIT 1`,
    ctx.profile,
    person,
    unit,
    now(),
    now(),
  );
}
async function proxyValid(
  ctx: ModuleContext,
  proxyId: string,
  person: string,
  unit: string,
  assembly: string,
  agenda?: string,
) {
  const p = await get(ctx, "proxies", proxyId);
  if (
    p.status !== "approved" ||
    p.person_id !== person ||
    p.unit_id !== unit ||
    p.assembly_id !== assembly ||
    (agenda && p.agenda_id && p.agenda_id !== agenda) ||
    p.expires_at <= now() ||
    !(await owner(ctx, p.grantor_id, unit))
  )
    fail("representation_invalid", 409);
  return p;
}
async function representation(ctx: ModuleContext, e: any, agenda: any) {
  if (e.proxy_id)
    return proxyValid(
      ctx,
      e.proxy_id,
      e.person_id,
      e.unit_id,
      agenda.assembly_id,
      agenda.id,
    );
  const m = await get(ctx, "memberships", e.membership_id);
  if (
    m.role !== "proprietario" ||
    m.person_id !== e.person_id ||
    m.unit_id !== e.unit_id ||
    m.starts_at > now() ||
    (m.ends_at !== null && m.ends_at <= now())
  )
    fail("representation_invalid", 409);
}

export async function assemblyCommand(
  ctx: ModuleContext,
  actor: Actor,
  action: string,
  input: unknown,
  key: string,
) {
  await staff(ctx, actor, mesa, true);
  if (action === "create") {
    const d = parse(
      z.object({ title: text(120), call_text: text(6000), starts_at: instant }),
      input,
    );
    await exec(
      ctx.env,
      "INSERT INTO cond_assemblies(profile_id,id,title,call_text,starts_at) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      ctx.profile,
      key,
      d.title,
      d.call_text,
      d.starts_at,
    );
    return { id: key };
  }
  if (action === "agenda") {
    const d = parse(
      z.object({
        id,
        title: text(300),
        options: z.array(text(80)).min(2).max(10),
        weighted: z.boolean().default(false),
        block_debt: z.boolean().default(false),
        closes_at: instant,
      }),
      input,
    );
    const a = await get(ctx, "assemblies", d.id);
    if (
      a.status !== "draft" ||
      new Set(d.options).size !== d.options.length ||
      d.closes_at <= a.starts_at
    )
      fail("invalid_agenda", 409);
    const count = await one(
      ctx.env,
      "SELECT COUNT(*) AS n FROM cond_agenda WHERE profile_id=? AND assembly_id=?",
      ctx.profile,
      a.id,
    );
    if (count!.n >= 50) fail("agenda_limit", 409);
    await exec(
      ctx.env,
      "INSERT INTO cond_agenda(profile_id,id,assembly_id,title,options_json,weighted,block_debt,closes_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      ctx.profile,
      key,
      a.id,
      d.title,
      JSON.stringify(d.options),
      +d.weighted,
      +d.block_debt,
      d.closes_at,
    );
    return { id: key };
  }
  if (action === "publish") {
    const d = parse(z.object({ id, reviewed: z.literal(true) }), input);
    const a = await get(ctx, "assemblies", d.id);
    if (a.status !== "draft") return { id: a.id };
    const agenda = await all(
      ctx.env,
      "SELECT title FROM cond_agenda WHERE profile_id=? AND assembly_id=? ORDER BY id LIMIT 50",
      ctx.profile,
      a.id,
    );
    if (!agenda.length) fail("agenda_required", 409);
    const noticeId = `assembly:${a.id}`;
    const body = `${a.call_text}\n\nPauta:\n${agenda.map((x, i) => `${i + 1}. ${x.title}`).join("\n")}`;
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO cond_notices(profile_id,id,title,body,audience,target_json,status,approved_by,created_at) VALUES(?,?,?,?,'all','[]','approved',?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      ).bind(ctx.profile, noticeId, a.title, body, actor.id, now()),
      ctx.env.DB.prepare(
        "UPDATE cond_assemblies SET status='published',notice_id=? WHERE profile_id=? AND id=? AND status='draft'",
      ).bind(noticeId, ctx.profile, a.id),
    ]);
    return { id: a.id, notice_id: noticeId };
  }
  if (action === "proxy") {
    const d = parse(
      z.object({
        assembly_id: id,
        agenda_id: id.nullable().default(null),
        unit_id: id,
        grantor_id: id,
        person_id: id,
        evidence: text(3000),
        expires_at: instant,
      }),
      input,
    );
    const a = await get(ctx, "assemblies", d.assembly_id);
    if (
      a.status === "closed" ||
      d.expires_at <= now() ||
      !(await owner(ctx, d.grantor_id, d.unit_id))
    )
      fail("representation_invalid", 409);
    await get(ctx, "people", d.person_id);
    if (
      d.agenda_id &&
      (await get(ctx, "agenda", d.agenda_id)).assembly_id !== a.id
    )
      fail();
    await exec(
      ctx.env,
      "INSERT INTO cond_proxies(profile_id,id,assembly_id,agenda_id,unit_id,grantor_id,person_id,evidence,expires_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      ctx.profile,
      key,
      a.id,
      d.agenda_id,
      d.unit_id,
      d.grantor_id,
      d.person_id,
      d.evidence,
      d.expires_at,
    );
    return { id: key };
  }
  if (action === "review-proxy" || action === "revoke-proxy") {
    const d = parse(z.object({ id, reviewed: z.literal(true) }), input);
    const p = await get(ctx, "proxies", d.id);
    if (
      action === "review-proxy" &&
      (p.status !== "pending" ||
        p.expires_at <= now() ||
        !(await owner(ctx, p.grantor_id, p.unit_id)))
    )
      fail("representation_invalid", 409);
    await exec(
      ctx.env,
      "UPDATE cond_proxies SET status=?,reviewed_by=? WHERE profile_id=? AND id=?",
      action === "review-proxy" ? "approved" : "revoked",
      actor.id,
      ctx.profile,
      p.id,
    );
    return { id: p.id };
  }
  if (action === "qualify") {
    const d = parse(
      z.object({
        id,
        unit_id: id,
        person_id: id,
        proxy_id: id.optional(),
        debt_status: z
          .enum(["unknown", "regular", "overdue"])
          .default("unknown"),
        debt_evidence: z.string().max(1000).default(""),
      }),
      input,
    );
    const a = await get(ctx, "agenda", d.id);
    if (a.status !== "draft") fail("electorate_frozen", 409);
    const unit = await get(ctx, "units", d.unit_id);
    await get(ctx, "people", d.person_id);
    const m = d.proxy_id ? null : await owner(ctx, d.person_id, d.unit_id);
    if (d.proxy_id)
      await proxyValid(
        ctx,
        d.proxy_id,
        d.person_id,
        d.unit_id,
        a.assembly_id,
        a.id,
      );
    else if (!m) fail("representation_invalid", 409);
    if (a.block_debt) {
      await staff(ctx, actor, ["admin"], true);
      if (d.debt_status === "unknown" || !d.debt_evidence.trim())
        fail("financial_review_required", 409);
    }
    if (a.weighted && !unit.fraction_ppb) fail("fraction_required", 409);
    await exec(
      ctx.env,
      `INSERT INTO cond_electors(profile_id,agenda_id,unit_id,person_id,membership_id,proxy_id,weight,debt_status,debt_evidence,reviewed_by)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,agenda_id,unit_id) DO UPDATE SET person_id=excluded.person_id,membership_id=excluded.membership_id,proxy_id=excluded.proxy_id,weight=excluded.weight,debt_status=excluded.debt_status,debt_evidence=excluded.debt_evidence,reviewed_by=excluded.reviewed_by`,
      ctx.profile,
      a.id,
      unit.id,
      d.person_id,
      m?.id || null,
      d.proxy_id || null,
      a.weighted ? unit.fraction_ppb : 1,
      a.block_debt ? d.debt_status : "unknown",
      a.block_debt ? d.debt_evidence : "",
      actor.id,
    );
    return { id: a.id, unit_id: unit.id };
  }
  if (action === "open") {
    const d = parse(objectId, input);
    const a = await get(ctx, "agenda", d.id);
    const assembly = await get(ctx, "assemblies", a.assembly_id);
    if (
      a.status !== "draft" ||
      assembly.status !== "published" ||
      now() < assembly.starts_at ||
      a.closes_at <= now()
    )
      fail("voting_unavailable", 409);
    const count = await one(
      ctx.env,
      "SELECT COUNT(*) AS n,SUM(CASE WHEN debt_status='unknown' THEN 1 ELSE 0 END) AS unknown FROM cond_electors WHERE profile_id=? AND agenda_id=?",
      ctx.profile,
      a.id,
    );
    if (!count?.n || (a.block_debt && count.unknown))
      fail("electorate_incomplete", 409);
    const at = now();
    const invalid = await one(
      ctx.env,
      `SELECT e.unit_id FROM cond_electors e WHERE e.profile_id=? AND e.agenda_id=? AND NOT (
      EXISTS(SELECT 1 FROM cond_memberships m WHERE m.profile_id=e.profile_id AND m.id=e.membership_id AND m.person_id=e.person_id AND m.unit_id=e.unit_id AND m.role='proprietario' AND m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?))
      OR EXISTS(SELECT 1 FROM cond_proxies p WHERE p.profile_id=e.profile_id AND p.id=e.proxy_id AND p.person_id=e.person_id AND p.unit_id=e.unit_id AND p.assembly_id=? AND (p.agenda_id IS NULL OR p.agenda_id=e.agenda_id) AND p.status='approved' AND p.expires_at>?
        AND EXISTS(SELECT 1 FROM cond_memberships m WHERE m.profile_id=p.profile_id AND m.person_id=p.grantor_id AND m.unit_id=p.unit_id AND m.role='proprietario' AND m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?)))) LIMIT 1`,
      ctx.profile,
      a.id,
      at,
      at,
      a.assembly_id,
      at,
      at,
      at,
    );
    if (invalid)
      fail(
        "representation_invalid",
        409,
        "Revise as representações antes de abrir a votação.",
      );
    if (a.weighted) {
      const fractions = await one(
        ctx.env,
        "SELECT COUNT(*) AS n,COUNT(fraction_ppb) AS filled,SUM(fraction_ppb) AS total FROM cond_units WHERE profile_id=?",
        ctx.profile,
      );
      if (fractions?.n !== fractions?.filled || fractions?.total !== 1000000000)
        fail(
          "fraction_total",
          409,
          "Confira todas as frações: a soma deve ser 1 bilhão de partes.",
        );
    }
    await exec(
      ctx.env,
      "UPDATE cond_agenda SET status='open',opened_at=? WHERE profile_id=? AND id=? AND status='draft'",
      now(),
      ctx.profile,
      a.id,
    );
    return { id: a.id };
  }
  if (action === "close" || action === "annul") {
    const d = parse(
      z.object({ id, reason: z.string().max(500).default("") }),
      input,
    );
    const a = await get(ctx, "agenda", d.id);
    if (action === "close" && a.status !== "open")
      fail("voting_unavailable", 409);
    if (action === "annul" && !d.reason.trim()) fail("reason_required", 400);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "UPDATE cond_agenda SET status=?,annul_reason=? WHERE profile_id=? AND id=?",
      ).bind(
        action === "close" ? "closed" : "annulled",
        d.reason,
        ctx.profile,
        a.id,
      ),
      // Retira a ata anterior se uma votação já apurada for anulada.
      ctx.env.DB.prepare(
        "UPDATE cond_assemblies SET minutes='',status='published' WHERE profile_id=? AND id=? AND status='closed'",
      ).bind(ctx.profile, a.assembly_id),
    ]);
    return { id: a.id };
  }
  if (action === "minutes") {
    const d = parse(objectId, input);
    const a = await get(ctx, "assemblies", d.id);
    if (a.status === "draft") fail("not_published", 409);
    const agenda = await all(
      ctx.env,
      "SELECT * FROM cond_agenda WHERE profile_id=? AND assembly_id=? ORDER BY id LIMIT 50",
      ctx.profile,
      a.id,
    );
    if (agenda.some((p) => !["closed", "annulled"].includes(p.status)))
      fail("voting_open", 409);
    // Uma agregação para todas as pautas; nenhum nome, unidade ou voto individual na ata.
    const totals = await all(
      ctx.env,
      `SELECT v.agenda_id,v.choice,COUNT(*) AS votes,SUM(v.weight) AS weight FROM cond_votes v
      JOIN cond_agenda a ON a.profile_id=v.profile_id AND a.id=v.agenda_id
      WHERE v.profile_id=? AND a.assembly_id=? GROUP BY v.agenda_id,v.choice`,
      ctx.profile,
      a.id,
    );
    const minutes = [
      `Ata — ${a.title}`,
      `Início previsto: ${new Date(a.starts_at).toISOString()}`,
      ...agenda.map((p) => {
        if (p.status === "annulled")
          return `${p.title}: votação anulada. Consulte a mesa.`;
        return `${p.title}\n${(JSON.parse(p.options_json) as string[])
          .map((choice) => {
            const t = totals.find(
              (v) => v.agenda_id === p.id && v.choice === choice,
            );
            return `${choice}: ${t?.votes || 0} voto(s), peso ${t?.weight || 0}.`;
          })
          .join("\n")}`;
      }),
      "Apuração numérica. A mesa deve conferir quórum e deliberações conforme as regras aprovadas.",
    ].join("\n\n");
    await exec(
      ctx.env,
      "UPDATE cond_assemblies SET minutes=?,status='closed' WHERE profile_id=? AND id=?",
      minutes,
      ctx.profile,
      a.id,
    );
    return { id: a.id, minutes };
  }
  fail();
}

export async function attendance(
  ctx: ModuleContext,
  actor: Actor,
  input: unknown,
  accessId?: string,
) {
  const d = parse(
    z.object({
      assembly_id: id,
      unit_id: id,
      person_id: id.optional(),
      proxy_id: id.optional(),
      leave: z.boolean().default(false),
    }),
    input,
  );
  let person: string;
  if (accessId) person = (await resident(ctx, actor, accessId)).person;
  else {
    await staff(ctx, actor, mesa, true);
    person = parse(id, d.person_id);
  }
  const a = await get(ctx, "assemblies", d.assembly_id);
  if (a.status !== "published") fail("assembly_unavailable", 409);
  if (d.proxy_id) await proxyValid(ctx, d.proxy_id, person, d.unit_id, a.id);
  else if (
    !(await one(
      ctx.env,
      `SELECT id FROM cond_memberships WHERE profile_id=? AND unit_id=? AND person_id=? AND ${active}`,
      ctx.profile,
      d.unit_id,
      person,
      now(),
      now(),
    ))
  )
    fail();
  if (d.leave)
    await exec(
      ctx.env,
      "UPDATE cond_attendance SET left_at=? WHERE profile_id=? AND assembly_id=? AND unit_id=? AND person_id=? AND left_at IS NULL",
      now(),
      ctx.profile,
      a.id,
      d.unit_id,
      person,
    );
  else
    await exec(
      ctx.env,
      "INSERT INTO cond_attendance(profile_id,assembly_id,unit_id,person_id,arrived_at) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,assembly_id,unit_id,person_id) DO UPDATE SET arrived_at=excluded.arrived_at,left_at=NULL",
      ctx.profile,
      a.id,
      d.unit_id,
      person,
      now(),
    );
  return { assembly_id: a.id, unit_id: d.unit_id };
}

export async function ballot(
  ctx: ModuleContext,
  actor: Actor,
  accessId: string,
  agendaId: string,
  unitId: string,
) {
  const r = await resident(ctx, actor, accessId);
  const a = await get(ctx, "agenda", agendaId);
  const e = await one(
    ctx.env,
    "SELECT * FROM cond_electors WHERE profile_id=? AND agenda_id=? AND unit_id=? AND person_id=?",
    ctx.profile,
    a.id,
    unitId,
    r.person,
  );
  if (!e) fail();
  await representation(ctx, e, a);
  if (a.block_debt && e.debt_status !== "regular")
    fail("not_eligible", 409, "Habilitação pendente. Procure a administração.");
  const present = await one(
    ctx.env,
    "SELECT unit_id FROM cond_attendance WHERE profile_id=? AND assembly_id=? AND unit_id=? AND person_id=? AND left_at IS NULL",
    ctx.profile,
    a.assembly_id,
    unitId,
    r.person,
  );
  if (!present)
    fail(
      "presence_required",
      409,
      "Confirme sua presença pela unidade antes de votar.",
    );
  return { r, a, e };
}
export async function vote(
  ctx: ModuleContext,
  actor: Actor,
  accessId: string,
  input: unknown,
  key: string,
) {
  const d = parse(
    z.object({
      agenda_id: id,
      unit_id: id,
      choice: text(80),
      confirmed: z.literal(true),
    }),
    input,
  );
  const { r, a, e } = await ballot(
    ctx,
    actor,
    accessId,
    d.agenda_id,
    d.unit_id,
  );
  const replay = await one(
    ctx.env,
    "SELECT id,person_id,agenda_id,unit_id,choice FROM cond_votes WHERE profile_id=? AND request_key=?",
    ctx.profile,
    key,
  );
  if (replay) {
    if (
      replay.person_id !== r.person ||
      replay.agenda_id !== a.id ||
      replay.unit_id !== d.unit_id ||
      replay.choice !== d.choice
    )
      fail("idempotency_conflict", 409);
    return { id: replay.id, unit_id: d.unit_id, recorded: true };
  }
  if (a.status !== "open" || a.closes_at <= now()) fail("voting_closed", 409);
  if (!(JSON.parse(a.options_json) as string[]).includes(d.choice))
    fail("invalid_choice", 400);
  const voteId = uid(),
    at = now();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO cond_votes(profile_id,id,agenda_id,unit_id,person_id,actor_id,choice,weight,created_at,request_key)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cond_agenda WHERE profile_id=? AND id=? AND status='open' AND closes_at>?)`,
      ).bind(
        ctx.profile,
        voteId,
        a.id,
        d.unit_id,
        r.person,
        actor.id,
        d.choice,
        e.weight,
        at,
        key,
        ctx.profile,
        a.id,
        at,
      ),
      ctx.env.DB.prepare(
        "INSERT INTO cond_audit(profile_id,id,entity_id,action,actor_id,created_at) SELECT ?,?,?,'vote',?,? WHERE changes()=1",
      ).bind(ctx.profile, voteId, voteId, actor.id, at),
    ]);
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error)))
      fail("already_voted", 409, "Esta unidade já registrou o voto.");
    throw error;
  }
  if (
    !(await one(
      ctx.env,
      "SELECT id FROM cond_votes WHERE profile_id=? AND id=?",
      ctx.profile,
      voteId,
    ))
  )
    fail("voting_closed", 409);
  return { id: voteId, unit_id: d.unit_id, recorded: true };
}

export async function listAssemblies(
  ctx: ModuleContext,
  actor: Actor,
  query: Record<string, string>,
  accessId?: string,
) {
  if (accessId) {
    if (!(await resident(ctx, actor, accessId)).units.length) fail();
  } else await staff(ctx, actor, mesa);
  return page(
    await all(
      ctx.env,
      `SELECT id,title,call_text,starts_at,status,minutes,notice_id FROM cond_assemblies WHERE profile_id=? AND id>? ${accessId ? "AND status!='draft'" : ""} ORDER BY id LIMIT 51`,
      ctx.profile,
      query.cursor || "",
    ),
  );
}
export async function assemblyDetail(
  ctx: ModuleContext,
  actor: Actor,
  assemblyId: string,
  accessId?: string,
) {
  if (accessId) {
    if (!(await resident(ctx, actor, accessId)).units.length) fail();
  } else await staff(ctx, actor, mesa);
  const a = await get(ctx, "assemblies", assemblyId);
  if (accessId && a.status === "draft") fail();
  const agenda = await all(
    ctx.env,
    "SELECT id,title,options_json,weighted,block_debt,closes_at,status FROM cond_agenda WHERE profile_id=? AND assembly_id=? ORDER BY id LIMIT 50",
    ctx.profile,
    a.id,
  );
  return {
    id: a.id,
    title: a.title,
    call_text: a.call_text,
    minutes: a.minutes,
    agenda: agenda.map((p) => ({
      id: p.id,
      title: p.title,
      options: JSON.parse(p.options_json),
      weighted: !!p.weighted,
      block_debt: !!p.block_debt,
      closes_at: p.closes_at,
      status: p.status,
    })),
  };
}
export async function results(
  ctx: ModuleContext,
  actor: Actor,
  agendaId: string,
  accessId?: string,
) {
  if (accessId) {
    if (!(await resident(ctx, actor, accessId)).units.length) fail();
  } else await staff(ctx, actor, mesa);
  const a = await get(ctx, "agenda", agendaId);
  if (a.status !== "closed")
    fail(
      "results_unavailable",
      409,
      "A apuração é publicada após o encerramento.",
    );
  const rows = await all(
    ctx.env,
    "SELECT choice,COUNT(*) AS votes,SUM(weight) AS weight FROM cond_votes WHERE profile_id=? AND agenda_id=? GROUP BY choice",
    ctx.profile,
    a.id,
  );
  return {
    id: a.id,
    totals: (JSON.parse(a.options_json) as string[]).map((choice) => ({
      choice,
      votes: rows.find((r) => r.choice === choice)?.votes || 0,
      weight: rows.find((r) => r.choice === choice)?.weight || 0,
    })),
  };
}
export async function electoralRecords(
  ctx: ModuleContext,
  actor: Actor,
  assemblyId: string,
  kind: string,
  after = "",
) {
  await staff(ctx, actor, mesa);
  await get(ctx, "assemblies", assemblyId);
  if (kind === "attendance")
    return page(
      await all(
        ctx.env,
        `SELECT a.unit_id||':'||a.person_id AS id,a.unit_id,a.person_id,a.arrived_at,a.left_at,p.name AS person_name,b.name||' · '||u.number AS unit_label
    FROM cond_attendance a JOIN cond_people p ON p.profile_id=a.profile_id AND p.id=a.person_id
    JOIN cond_units u ON u.profile_id=a.profile_id AND u.id=a.unit_id JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE a.profile_id=? AND a.assembly_id=? AND (a.unit_id||':'||a.person_id)>? ORDER BY a.unit_id||':'||a.person_id LIMIT 51`,
        ctx.profile,
        assemblyId,
        after,
      ),
    );
  if (kind === "proxies") {
    // A evidência é privada e cada leitura é auditada, sem copiar conteúdo.
    await exec(
      ctx.env,
      "INSERT INTO cond_audit(profile_id,id,entity_id,action,actor_id,created_at) VALUES(?,?,?,'proxy_read',?,?)",
      ctx.profile,
      uid(),
      assemblyId,
      actor.id,
      now(),
    );
    return page(
      await all(
        ctx.env,
        "SELECT id,unit_id,grantor_id,person_id,agenda_id,evidence,expires_at,status FROM cond_proxies WHERE profile_id=? AND assembly_id=? AND id>? ORDER BY id LIMIT 51",
        ctx.profile,
        assemblyId,
        after,
      ),
    );
  }
  fail();
}
