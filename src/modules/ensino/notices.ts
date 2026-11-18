import { all, exec, one } from "../../db";
import { ApiError, now, type Actor, type Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { classroom, guardianOrders, notFound, today } from "./access";
import { date, id, invalid, object, text } from "./model";
import { change, mutationId } from "./store";

export async function notices(ctx: ModuleContext, actor: Actor, classId: string) {
  const c = await classroom(ctx, actor, classId);
  return { version: c.version, data: await all(ctx.env,
    `SELECT n.id,n.text,n.audience_date,n.published_at,
      (SELECT count(*) FROM ensino_deliveries d WHERE d.profile_id=n.profile_id AND d.notice_id=n.id AND d.status='queued') queued,
      (SELECT count(*) FROM ensino_deliveries d WHERE d.profile_id=n.profile_id AND d.notice_id=n.id AND d.status='pending') pending,
      (SELECT count(*) FROM ensino_deliveries d WHERE d.profile_id=n.profile_id AND d.notice_id=n.id AND d.status='blocked') blocked,
      (SELECT count(*) FROM ensino_deliveries d WHERE d.profile_id=n.profile_id AND d.notice_id=n.id AND d.status='cancelled') cancelled
     FROM ensino_notices n WHERE n.profile_id=? AND n.class_id=? ORDER BY n.id LIMIT 100`, ctx.profile, c.id) };
}
export async function createNotice(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "text", "audience_date"]);
  const c = await classroom(ctx, actor, d.id, true), day = date(d.audience_date);
  if (day < c.start_date || day > c.end_date) invalid("data dos destinatários");
  const count = await one<{ n: number }>(ctx.env, "SELECT count(*) n FROM ensino_notices WHERE profile_id=? AND class_id=?", ctx.profile, c.id);
  if ((count?.n ?? 0) >= 100) throw new ApiError(409, "collection_limit", "Limite de 100 comunicados por turma.");
  const entityId = await mutationId(ctx, actor, "notice.create", key);
  return change(ctx, actor, "notice.create", key, d, c, entityId, [[
    "INSERT INTO ensino_notices(profile_id,id,class_id,text,audience_date,created_by) VALUES(?,?,?,?,?,?)",
    [ctx.profile, entityId, c.id, text(d.text, "comunicado", 3000), day, actor.id],
  ]]);
}
export async function publishNotice(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "notice_id", "reviewed"]);
  const c = await classroom(ctx, actor, d.id, true, true);
  const n = await one(ctx.env, "SELECT id,audience_date,published_at FROM ensino_notices WHERE profile_id=? AND class_id=? AND id=?", ctx.profile, c.id, id(d.notice_id));
  if (!n) notFound();
  if (d.reviewed !== true) invalid("revisão do comunicado coletivo, sem dados individuais");
  return change(ctx, actor, "notice.publish", key, d, c, n.id, [
    ["UPDATE ensino_notices SET published_at=coalesce(published_at,?) WHERE profile_id=? AND class_id=? AND id=?", [now(), ctx.profile, c.id, n.id]],
    [`INSERT OR IGNORE INTO ensino_deliveries(profile_id,notice_id,phone_hash)
      SELECT DISTINCT g.profile_id,?,g.phone_hash FROM ensino_guardians g
      JOIN os_people p ON p.profile_id=g.profile_id AND p.order_id=g.order_id AND p.id=g.person_id
      JOIN ensino_enrollments e ON e.profile_id=g.profile_id AND e.order_id=g.order_id
      WHERE g.profile_id=? AND e.class_id=? AND e.start_date<=? AND e.end_date>=?
      AND g.revoked_at IS NULL AND g.valid_until>=? AND p.version=g.person_version
      AND p.archived_at IS NULL AND p.sensitive=1 AND p.client_visible=0`, [n.id, ctx.profile, c.id, n.audience_date, n.audience_date, today()]],
  ]);
}
/** Dez destinatários por comando. O painel continua os lotes e exibe bloqueios. */
export async function sendNoticeBatch(ctx: ModuleContext, actor: Actor, input: unknown) {
  const d = object(input, ["id", "notice_id", "retry"]);
  const c = await classroom(ctx, actor, d.id, true, true);
  const notice = await one(ctx.env, "SELECT id,audience_date FROM ensino_notices WHERE profile_id=? AND class_id=? AND id=? AND published_at IS NOT NULL", ctx.profile, c.id, id(d.notice_id));
  if (!notice) notFound();
  if (d.retry !== undefined && typeof d.retry !== "boolean") invalid("repetição");
  if (d.retry) await exec(ctx.env,
    "UPDATE ensino_deliveries SET status='pending',error_code=NULL WHERE profile_id=? AND notice_id=? AND status='blocked'", ctx.profile, notice.id);
  const deliveries = await all<{ phone_hash: string; conversation_id: string | null }>(ctx.env,
    "SELECT phone_hash,conversation_id FROM ensino_deliveries WHERE profile_id=? AND notice_id=? AND status='pending' ORDER BY phone_hash LIMIT 10", ctx.profile, notice.id);
  for (const target of deliveries) {
    const people = await all<{ phone: string; order_id: string }>(ctx.env,
      `SELECT DISTINCT p.phone,g.order_id FROM ensino_guardians g JOIN os_people p ON p.profile_id=g.profile_id AND p.order_id=g.order_id AND p.id=g.person_id
       JOIN ensino_enrollments e ON e.profile_id=g.profile_id AND e.order_id=g.order_id
       WHERE g.profile_id=? AND g.phone_hash=? AND e.class_id=? AND e.start_date<=? AND e.end_date>=?
       AND g.revoked_at IS NULL AND g.valid_until>=? AND p.version=g.person_version
       AND p.archived_at IS NULL AND p.sensitive=1 AND p.client_visible=0 LIMIT 100`, ctx.profile, target.phone_hash, c.id, notice.audience_date, notice.audience_date, today());
    let status = "cancelled", message: string | null = null, errorCode: string | null = null;
    if (people.length) {
      const phones = [...new Set(people.map(p => p.phone))];
      const conversations = await all<Conversation>(ctx.env,
        `SELECT * FROM conversations WHERE profile_id=? AND phone IN (SELECT value FROM json_each(?)) AND chat_type<>'group'
         AND (? IS NULL OR id=?) ORDER BY last_customer DESC LIMIT 10`, ctx.profile, JSON.stringify(phones), target.conversation_id, target.conversation_id);
      status = "blocked"; errorCode = "conversation_unavailable";
      for (const conversation of conversations) {
        if (!ctx.verifiedPhone(conversation) || !ctx.mayMessage(actor, conversation)) continue;
        const identity = await guardianOrders(ctx, conversation);
        if (identity.hash !== target.phone_hash || !people.some(p => identity.orderIds.includes(p.order_id))) continue;
        // Fixar antes de enfileirar: recuperar uma falha não escolhe outra conversa do mesmo telefone.
        if (!target.conversation_id) await exec(ctx.env,
          "UPDATE ensino_deliveries SET conversation_id=? WHERE profile_id=? AND notice_id=? AND phone_hash=? AND conversation_id IS NULL",
          conversation.id, ctx.profile, notice.id, target.phone_hash);
        try {
          // Conteúdo livre permanece no portal autenticado; mensagem e contexto IA só recebem este texto fixo.
          message = await ctx.sendMessage(conversation,
            { text: "Há um comunicado escolar disponível. Escolha Boletim e frequência no menu para abrir sua consulta protegida." },
            { key: `notice:${notice.id}:${target.phone_hash}`, actor: actor.id, notification: true, purpose: "order" });
          status = "queued"; errorCode = null;
        } catch (error) {
          // Sem texto do provedor/cliente nos logs da área. Falha de banco continua recuperável com a chave estável.
          if (!(error instanceof ApiError)) throw error;
          errorCode = "sending_not_allowed";
        }
        break;
      }
    }
    await exec(ctx.env,
      "UPDATE ensino_deliveries SET status=?,message_id=?,error_code=?,attempts=attempts+1 WHERE profile_id=? AND notice_id=? AND phone_hash=? AND status='pending'",
      status, message, errorCode, ctx.profile, notice.id, target.phone_hash);
  }
  return { processed: deliveries.length, counts: await all(ctx.env,
    "SELECT status,count(*) total FROM ensino_deliveries WHERE profile_id=? AND notice_id=? GROUP BY status", ctx.profile, notice.id) };
}
