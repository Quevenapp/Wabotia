import { z } from "zod";
import { all, exec, one } from "../../db";
import { now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { fail, get, id, page, parse, resident, staff, text } from "./common";

const audience = `m.notices=1 AND m.role!='dependente' AND m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?)
 AND ph.starts_at<=? AND (ph.ends_at IS NULL OR ph.ends_at>?)
 AND (n.audience='all' OR (n.audience='block' AND u.block_id=json_extract(n.target_json,'$[0]'))
 OR (n.audience='units' AND u.id IN (SELECT value FROM json_each(n.target_json))))`;

export async function noticeCommand(
  ctx: ModuleContext,
  actor: Actor,
  action: string,
  input: unknown,
  key: string,
) {
  await staff(ctx, actor, ["admin"], true);
  if (action === "create") {
    const d = parse(
      z.object({
        title: text(120),
        body: text(6000),
        audience: z.enum(["all", "block", "units"]),
        targets: z.array(id).max(100).default([]),
      }),
      input,
    );
    if (
      (d.audience === "all" && d.targets.length) ||
      (d.audience === "block" && d.targets.length !== 1) ||
      (d.audience === "units" && !d.targets.length)
    )
      fail("invalid_audience", 400);
    // Uma consulta para validar todo o público, sem leitura por unidade.
    if (d.targets.length) {
      const kind = d.audience === "block" ? "blocks" : "units";
      const found = await one(
        ctx.env,
        `SELECT COUNT(*) AS n FROM cond_${kind} WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))`,
        ctx.profile,
        JSON.stringify([...new Set(d.targets)]),
      );
      if (found?.n !== new Set(d.targets).size) fail();
    }
    await exec(
      ctx.env,
      "INSERT INTO cond_notices(profile_id,id,title,body,audience,target_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
      ctx.profile,
      key,
      d.title,
      d.body,
      d.audience,
      JSON.stringify(d.targets),
      now(),
    );
    return { id: key };
  }
  const d = parse(
    z.object({ id, reviewed_public_content: z.boolean().optional() }),
    input,
  );
  const row = await get(ctx, "notices", d.id);
  if (action === "approve") {
    if (!d.reviewed_public_content)
      fail(
        "review_required",
        400,
        "Confirme que o conteúdo é adequado a todo o público escolhido e não contém dados pessoais ou financeiros individuais.",
      );
    await exec(
      ctx.env,
      "UPDATE cond_notices SET status='approved',approved_by=? WHERE profile_id=? AND id=? AND status='draft'",
      actor.id,
      ctx.profile,
      row.id,
    );
  } else if (action === "send") {
    if (!["approved", "sending", "sent"].includes(row.status))
      fail("not_approved", 409);
    if (row.status === "approved") {
      const at = now();
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO cond_notice_recipients(profile_id,notice_id,phone)
          SELECT DISTINCT n.profile_id,n.id,ph.phone FROM cond_notices n
          JOIN cond_memberships m ON m.profile_id=n.profile_id JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
          JOIN cond_phones ph ON ph.profile_id=m.profile_id AND ph.person_id=m.person_id
          WHERE n.profile_id=? AND n.id=? AND n.status='approved' AND ${audience}
          ON CONFLICT(profile_id,notice_id,phone) DO NOTHING`,
        ).bind(ctx.profile, row.id, at, at, at, at),
        ctx.env.DB.prepare(
          "UPDATE cond_notices SET status='sending' WHERE profile_id=? AND id=? AND status='approved'",
        ).bind(ctx.profile, row.id),
      ]);
      await exec(
        ctx.env,
        "UPDATE cond_notices SET status='sent' WHERE profile_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?)",
        ctx.profile,
        row.id,
        ctx.profile,
        row.id,
      );
      await ctx.wake();
    }
  } else if (action === "retry") {
    await exec(
      ctx.env,
      "UPDATE cond_notice_recipients SET status='pending' WHERE profile_id=? AND notice_id=? AND status='failed' AND attempts<3",
      ctx.profile,
      row.id,
    );
    await ctx.wake();
  } else fail();
  return { id: row.id };
}

export async function listNotices(
  ctx: ModuleContext,
  actor: Actor,
  query: Record<string, string>,
  accessId?: string,
) {
  if (!accessId) {
    await staff(ctx, actor, ["admin"]);
    return page(
      await all(
        ctx.env,
        `SELECT n.id,n.title,n.body,n.audience,n.status,
      (SELECT COUNT(*) FROM cond_notice_recipients r WHERE r.profile_id=n.profile_id AND r.notice_id=n.id AND r.status='queued') AS queued,
      (SELECT COUNT(*) FROM cond_notice_recipients r WHERE r.profile_id=n.profile_id AND r.notice_id=n.id AND r.status='failed') AS failed
      FROM cond_notices n WHERE n.profile_id=? AND n.id>? ORDER BY n.id LIMIT 51`,
        ctx.profile,
        query.cursor || "",
      ),
    );
  }
  const r = await resident(ctx, actor, accessId);
  return page(
    await all(
      ctx.env,
      `SELECT n.id,n.title,n.body FROM cond_notices n WHERE n.profile_id=? AND n.id>? AND n.status!='draft'
    AND EXISTS(SELECT 1 FROM cond_memberships m JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
      WHERE m.profile_id=n.profile_id AND m.person_id=? AND m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?)
      AND (n.audience='all' OR (n.audience='block' AND u.block_id=json_extract(n.target_json,'$[0]')) OR (n.audience='units' AND u.id IN (SELECT value FROM json_each(n.target_json)))))
    ORDER BY n.id LIMIT 51`,
      ctx.profile,
      query.cursor || "",
      r.person,
      now(),
      now(),
    ),
  );
}

/** Lote de cinco, sem abrir conexão externa: apenas a fila durável do atendimento. */
export async function sendDueNotices(ctx: ModuleContext) {
  await ctx.requireEnabled();
  const rows = await all(
    ctx.env,
    "SELECT notice_id,phone FROM cond_notice_recipients WHERE profile_id=? AND status='pending' AND attempts<3 ORDER BY notice_id,phone LIMIT 5",
    ctx.profile,
  );
  for (const row of rows) {
    const at = now();
    const eligible = await one(
      ctx.env,
      `SELECT ph.id FROM cond_notices n
      JOIN cond_memberships m ON m.profile_id=n.profile_id JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
      JOIN cond_phones ph ON ph.profile_id=m.profile_id AND ph.person_id=m.person_id
      WHERE n.profile_id=? AND n.id=? AND ph.phone=? AND n.status IN ('sending','sent') AND ${audience} LIMIT 1`,
      ctx.profile,
      row.notice_id,
      row.phone,
      at,
      at,
      at,
      at,
    );
    let status = "skipped",
      error: string | null = null;
    if (eligible) {
      try {
        const c = await ctx.conversationByPhone(row.phone, { open: true });
        if (
          !c ||
          c.chat_type === "group" ||
          c.profile_id !== ctx.profile ||
          ctx.verifiedPhone(c) !== row.phone
        )
          fail();
        // Nem título nem corpo livre entram no WhatsApp. Janela, consentimento e modelo são do núcleo.
        await ctx.sendMessage(
          c,
          {
            text: "Há um comunicado do condomínio. Acesse Minha unidade no menu para consultar.",
          },
          { key: `notice:${row.notice_id}:${row.phone}`, notification: true },
        );
        status = "queued";
      } catch {
        status = "failed";
        error = "delivery_unavailable";
      }
    }
    await exec(
      ctx.env,
      "UPDATE cond_notice_recipients SET status=?,attempts=attempts+1,error_code=? WHERE profile_id=? AND notice_id=? AND phone=? AND status='pending'",
      status,
      error,
      ctx.profile,
      row.notice_id,
      row.phone,
    );
    await exec(
      ctx.env,
      "UPDATE cond_notices SET status='sent' WHERE profile_id=? AND id=? AND status='sending' AND NOT EXISTS(SELECT 1 FROM cond_notice_recipients WHERE profile_id=? AND notice_id=? AND status='pending')",
      ctx.profile,
      row.notice_id,
      ctx.profile,
      row.notice_id,
    );
  }
  if (rows.length === 5) await ctx.wake();
}
