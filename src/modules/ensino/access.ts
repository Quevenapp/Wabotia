import { all, one } from "../../db";
import { hmac } from "../../security";
import { BRASILIA_OFFSET_MS } from "../../business-time";
import { ApiError, type Actor, type Conversation } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import { authorizedOrder } from "../os/public";
import type { WorkTypeView } from "../os/contracts";
import { projectPrivateFields } from "../os/privacy";
import { projectOrderForStaff, projectChildForBot, projectChildForStaff } from "../os/privacy";
import { id, type Period, type Rule, type Slot } from "./model";

export interface ClassRow {
  id: string; profile_id: string; name: string; school_year: string;
  start_date: string; end_date: string; teacher_id: string; type_id: string; capacity: number;
  schedule_json: string; periods_json: string; rule_json: string; justified_counts: number;
  version: number; created: number;
}
export interface Enrollment {
  id: string; class_id: string; order_id: string; start_date: string; end_date: string; ended: number;
}
export function notFound(): never { throw new ApiError(404, "not_found", "Registro não encontrado."); }
export function forbidden(): never { throw new ApiError(403, "forbidden", "Acesso escolar não autorizado."); }
export const isHuman = (actor: Actor) => actor.kind === "user" && !actor.via && !actor.module &&
  !actor.credential && !actor.id.startsWith("bot:") && !actor.bots.length;

export async function staff(ctx: ModuleContext, actor: Actor, write = false) {
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  await ctx.requireEnabled();
  if (!isHuman(actor)) forbidden();
  const secretary = await ctx.granted(actor, "secretaria");
  if (!secretary && !(await ctx.granted(actor, "professor"))) forbidden();
  return secretary;
}
export async function classroom(ctx: ModuleContext, actor: Actor, classId: unknown, write = false, secretaryOnly = false) {
  const secretary = await staff(ctx, actor, write);
  if (secretaryOnly && !secretary) forbidden();
  const row = await one<ClassRow>(ctx.env,
    "SELECT * FROM ensino_classes WHERE profile_id=? AND id=? AND (?=1 OR teacher_id=?)",
    ctx.profile, id(classId), +secretary, actor.id);
  if (!row) notFound();
  return row;
}
export const classView = (r: ClassRow) => ({ id: r.id, name: r.name, school_year: r.school_year,
  start_date: r.start_date, end_date: r.end_date, teacher_id: r.teacher_id, type_id: r.type_id,
  capacity: r.capacity, version: r.version, schedule: JSON.parse(r.schedule_json) as Slot[],
  periods: JSON.parse(r.periods_json) as Period[], rule: JSON.parse(r.rule_json) as Rule,
  justified_counts: !!r.justified_counts });

export async function enrollment(ctx: ModuleContext, classId: string, value: unknown) {
  const row = await one<Enrollment>(ctx.env,
    "SELECT id,class_id,order_id,start_date,end_date,ended FROM ensino_enrollments WHERE profile_id=? AND class_id=? AND id=?",
    ctx.profile, classId, id(value));
  if (!row) notFound();
  return row;
}
/** Só a secretaria chama a API do motor, nunca como ator técnico elevado. */
export function privateSchoolType(type: WorkTypeView) {
  if (type.fields.some(f => !f.sensitive)) return false;
  if (!type.features.customer_open && type.stages.every(s => !s.message)) return true;
  // Modelos administrativos aceitam pedidos públicos sem identificar o aluno.
  // Seu nome vem exclusivamente do campo privado; mensagens só usam referências.
  return type.fields.some(f => f.id === "nome_aluno" && f.kind === "text" && f.sensitive && !f.client_visible) &&
    type.stages.every(s => [...s.message.matchAll(/\{([^}]+)\}/g)].every(m => ["numero", "identificador", "estado", "tipo"].includes(m[1])));
}
// Consultas pedagógicas já autorizadas pela turma/vínculo. Não reutilizar em canais comuns.
export const studentNameSql = `CASE WHEN EXISTS (SELECT 1 FROM json_each(o.type_snapshot_json,'$.type.fields') f
  WHERE json_extract(f.value,'$.id')='nome_aluno' AND json_extract(f.value,'$.sensitive')=1)
  THEN coalesce(json_extract(o.extra_json,'$.nome_aluno'),'') ELSE o.customer_name END`;
export async function schoolOrder(ctx: ModuleContext, actor: Actor, orderId: unknown, typeId: string) {
  const os = modulesApi(ctx.env, ctx.profile, "os");
  const order = await authorizedOrder(os, actor, id(orderId));
  if (order.type.id !== typeId || order.type.kind !== "custom" || !order.type.features.people)
    throw new ApiError(409, "invalid_enrollment", "Selecione uma matrícula do tipo configurado na turma, com pessoas ligadas.");
  if (!privateSchoolType(order.type))
    throw new ApiError(409, "private_type_required", "A matrícula escolar exige extras sensíveis e mensagens sem dados do aluno.");
  if (order.row.status === "cancelled") throw new ApiError(409, "closed_order", "Matrícula cancelada.");
  const name = order.type.fields.some(f => f.id === "nome_aluno")
    ? (await projectPrivateFields(os, actor, order)).extra.nome_aluno
    : projectOrderForStaff(os, actor, order).customer.name;
  return { order, name: typeof name === "string" ? name : "" };
}
export async function responsiblePerson(ctx: ModuleContext, actor: Actor, orderId: string, personId: unknown) {
  // Contrato público do motor, com suas projeções e autorização humana sensível.
  let cursor: string | null = null;
  for (let i = 0; i < 2; i++) {
    const result = await ctx.read(actor, `service-orders/${encodeURIComponent(orderId)}/people`,
      { limit: "100", ...(cursor ? { cursor } : {}) });
    const person = result.data.find((p: any) => p.id === id(personId));
    if (person) {
      const projected = await projectChildForStaff(ctx, actor, person);
      if (!projected || !person.sensitive || person.client_visible || projectChildForBot(person) !== null || !person.phone)
        throw new ApiError(409, "private_person_required", "Use uma pessoa ligada sensível, com telefone, e acesso humano os:sensitive.");
      return person as { id: string; version: number; phone: string; name: string };
    }
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  notFound();
}
export const digits = (v: string) => v.replace(/\D/g, "");
export const phoneHash = (ctx: ModuleContext, phone: string) =>
  hmac(ctx.env.MASTER_KEY, `ensino:${ctx.profile}:${digits(phone)}`);
export const today = (at = Date.now()) => new Date(at - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Leitura relacional estreita da identidade existente, não uma nova API da OS.
 * O contrato público não autoriza responsáveis: o poder vem de ensino_guardians.
 * Nunca devolve colunas de os_people ou os_orders para o cliente.
 */
export async function guardianOrders(ctx: ModuleContext, c: Conversation) {
  await ctx.requireEnabled();
  if (c.profile_id !== ctx.profile || c.chat_type === "group") notFound();
  const phone = ctx.verifiedPhone(c);
  if (!phone) notFound();
  const hash = await phoneHash(ctx, phone);
  const rows = await all<{ order_id: string; phone: string }>(ctx.env,
    `SELECT DISTINCT g.order_id,p.phone FROM ensino_guardians g JOIN os_people p
     ON p.profile_id=g.profile_id AND p.order_id=g.order_id AND p.id=g.person_id
     WHERE g.profile_id=? AND g.phone_hash=? AND g.revoked_at IS NULL AND g.valid_until>=?
     AND p.archived_at IS NULL AND p.version=g.person_version AND p.sensitive=1 AND p.client_visible=0
     ORDER BY g.order_id LIMIT 101`, ctx.profile, hash, today());
  if (rows.length > 100) throw new ApiError(409, "review_required", "Solicite a conferência dos vínculos à secretaria.");
  return { hash, orderIds: rows.filter(r => digits(r.phone) === digits(phone)).map(r => r.order_id) };
}
