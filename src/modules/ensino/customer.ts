import { studentNameSql } from "./access";
import { all, exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { guardianOrders, notFound, phoneHash, type ClassRow, type Enrollment } from "./access";
import { studentFrequency } from "./diary";
import { id, object, page } from "./model";

interface AccessRow { id: string; conversation_id: string; session: string; phone_hash: string; expires: number }
export const accessReply = { status: "request_processed", message: "Pedido processado pelo atendimento. Consulte a mensagem enviada no WhatsApp." };

/** Somente o canal autenticado inicia acesso; o modelo nunca recebe link/token/dados. */
export async function requestAccess(ctx: ModuleContext, c: Conversation, sourceKey: string) {
  const live = await one<Conversation>(ctx.env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", ctx.profile, c.id);
  if (!live || live.session !== c.session) notFound();
  const identity = await guardianOrders(ctx, live);
  // O outbox é a confirmação durável. Um turno repetido não revoga o link já enfileirado.
  const deliveryKey = `access:${sourceKey}`;
  if (await one(ctx.env, "SELECT id FROM outbox WHERE profile_id=? AND conversation_id=? AND dedupe=?",
    ctx.profile, live.id, `module:ensino:${live.id}:${deliveryKey}`)) return accessReply;
  if (!identity.orderIds.length) {
    await ctx.sendMessage(live, { text: "Não foi possível abrir a consulta escolar. Peça à secretaria que confira sua autorização." }, { key: `access-denied:${sourceKey}` });
    return accessReply;
  }
  const accessId = `responsavel:${live.id}`;
  // Link de uso único em 5 min; sessão escolar de no máximo 15 min, mesmo se o claim for tardio.
  await exec(ctx.env,
    `INSERT INTO ensino_access(profile_id,id,conversation_id,session,phone_hash,expires) VALUES(?,?,?,?,?,?)
     ON CONFLICT(profile_id,id) DO UPDATE SET session=excluded.session,phone_hash=excluded.phone_hash,expires=excluded.expires`,
    ctx.profile, accessId, live.id, live.session, identity.hash, now() + 15 * 60000);
  const claim = await ctx.issueCredential(accessId, { actor: "system", claimMinutes: 5, ttlMinutes: 15 });
  const issued = new URL(claim.url);
  // Fragmento não vai a logs HTTP ou Referer; só a página de acesso consome o segredo.
  const url = `${issued.origin}/ensino/acesso#${issued.pathname.split("/").at(-1)}`;
  await ctx.sendMessage(live, { text: `Abra sua consulta escolar protegida: ${url}\nO link é pessoal, de uso único, e vence em 5 minutos.` }, { key: deliveryKey });
  return accessReply;
}
export async function customerAction(ctx: ModuleContext, actor: Actor, c: Conversation, data: unknown, requestId: string) {
  object(data, ["action"]);
  await ctx.requireEnabled();
  const live = await ctx.conversation(c.id, actor);
  if (!ctx.mayMessage(actor, live)) throw new ApiError(403, "forbidden", "Assuma a conversa antes de enviar a consulta.");
  return requestAccess(ctx, live, `action:${actor.id}:${requestId}`);
}
async function session(ctx: ModuleContext, subject: string) {
  await ctx.requireEnabled();
  const access = await one<AccessRow>(ctx.env,
    "SELECT id,conversation_id,session,phone_hash,expires FROM ensino_access WHERE profile_id=? AND id=? AND expires>?", ctx.profile, subject, now());
  if (!access) notFound();
  const c = await one<Conversation>(ctx.env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", ctx.profile, access.conversation_id);
  if (!c || c.session !== access.session || !ctx.verifiedPhone(c) || await phoneHash(ctx, ctx.verifiedPhone(c)!) !== access.phone_hash) notFound();
  const identity = await guardianOrders(ctx, c);
  if (!identity.orderIds.length) notFound();
  return { access, identity };
}
export async function claimAccess(ctx: ModuleContext, credential: { subject: string }) {
  const { access } = await session(ctx, credential.subject);
  // O claim público não transporta conteúdo escolar.
  return { ready: true, expires_at: access.expires };
}
async function privateSession(ctx: ModuleContext, actor: Actor, accessId: string) {
  if (actor.via || actor.module || actor.bots.length || actor.id.startsWith("bot:") ||
      actor.credential?.module !== "ensino" || actor.credential.subject !== accessId ||
      !actor.profiles.includes(ctx.profile)) notFound();
  const result = await session(ctx, accessId);
  await exec(ctx.env, "INSERT INTO ensino_access_log(profile_id,id,access_id,created) VALUES(?,?,?,?)", ctx.profile, uid(), accessId, now());
  return result;
}
export async function ownStudents(ctx: ModuleContext, actor: Actor, accessId: string, query: Record<string, string>) {
  const { identity } = await privateSession(ctx, actor, accessId);
  const p = page(query, `${ctx.profile}:${accessId}:students`);
  const rows = await all(ctx.env,
    `SELECT e.id,${studentNameSql} name,c.name class_name,c.school_year FROM ensino_enrollments e
     JOIN os_orders o ON o.profile_id=e.profile_id AND o.id=e.order_id
     JOIN ensino_classes c ON c.profile_id=e.profile_id AND c.id=e.class_id
     WHERE e.profile_id=? AND e.order_id IN (SELECT value FROM json_each(?)) AND e.id>? ORDER BY e.id LIMIT ?`,
    ctx.profile, JSON.stringify(identity.orderIds), p.after, p.limit + 1);
  return { data: rows.slice(0, p.limit), next_cursor: rows.length > p.limit ? p.cursor(rows[p.limit - 1].id) : null };
}
export async function ownReport(ctx: ModuleContext, actor: Actor, accessId: string, enrollmentId: string) {
  const { identity } = await privateSession(ctx, actor, accessId);
  const e = await one<Enrollment>(ctx.env,
    "SELECT id,class_id,order_id,start_date,end_date,ended FROM ensino_enrollments WHERE profile_id=? AND id=?", ctx.profile, id(enrollmentId));
  if (!e || !identity.orderIds.includes(e.order_id)) notFound();
  const c = await one<ClassRow>(ctx.env, "SELECT * FROM ensino_classes WHERE profile_id=? AND id=?", ctx.profile, e.class_id);
  if (!c) notFound();
  const reports = await all<{ revision: number; snapshot_json: string; created: number }>(ctx.env,
    `SELECT r.revision,r.snapshot_json,r.created FROM ensino_reports r WHERE r.profile_id=? AND r.enrollment_id=?
     AND r.revision=(SELECT max(x.revision) FROM ensino_reports x WHERE x.profile_id=r.profile_id AND x.enrollment_id=r.enrollment_id AND x.period_id=r.period_id)
     ORDER BY r.created LIMIT 8`, ctx.profile, e.id);
  const notices = await all(ctx.env,
    "SELECT id,text,audience_date FROM ensino_notices WHERE profile_id=? AND class_id=? AND published_at IS NOT NULL AND audience_date>=? AND audience_date<=? ORDER BY published_at DESC LIMIT 100",
    ctx.profile, c.id, e.start_date, e.end_date);
  return { reports: reports.map(r => ({ revision: r.revision, published_at: r.created, ...JSON.parse(r.snapshot_json) })),
    frequency: await studentFrequency(ctx, c, e), notices };
}
