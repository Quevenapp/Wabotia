import { z } from "zod";
import { all, batch, one } from "../../db";
import { ApiError, now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import type { ChildStatement } from "../os/public";
import { staff } from "./access";
import { calendarSchema, idSchema, nationalSeed, parse, SEED_WARNING, stableId, versionSchema, type Calendar } from "./model";

export interface CalendarRow { id: string; revision: number; definition_json: string; seeded: number }
export const cas: ChildStatement = ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('juridico_version_conflict') END", []];
export async function atomic(ctx: ModuleContext, statements: ChildStatement[]) {
  try { await batch(ctx.env, statements); }
  catch (error) {
    if (/malformed JSON|juridico_version_conflict/.test(String(error))) throw new ApiError(409, "version_conflict", "O registro mudou. Atualize a tela.");
    throw error;
  }
}
export async function calendarRow(ctx: ModuleContext, id: string): Promise<CalendarRow> {
  const row = await one<CalendarRow>(ctx.env, `SELECT c.id,c.revision,v.definition_json,v.seeded FROM jur_calendars c
    JOIN jur_calendar_versions v ON v.profile_id=c.profile_id AND v.calendar_id=c.id AND v.revision=c.revision
    WHERE c.profile_id=? AND c.id=?`, ctx.profile, id);
  if (!row) throw new ApiError(404, "not_found", "Calendário não encontrado.");
  return row;
}
export async function listCalendars(ctx: ModuleContext, actor: Actor) {
  await staff(ctx, actor, false, "either");
  const rows = await all<CalendarRow>(ctx.env, `SELECT c.id,c.revision,v.definition_json,v.seeded FROM jur_calendars c
    JOIN jur_calendar_versions v ON v.profile_id=c.profile_id AND v.calendar_id=c.id AND v.revision=c.revision
    WHERE c.profile_id=? ORDER BY c.name,c.id LIMIT 101`, ctx.profile);
  return { data: rows.map(r => ({ id: r.id, revision: r.revision, calendar: JSON.parse(r.definition_json) as Calendar, seed_warning: r.seeded ? SEED_WARNING : null })), next_cursor: null };
}
export async function saveCalendar(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string) {
  await staff(ctx, actor, true, "curator");
  const data = parse(z.strictObject({ id: idSchema.optional(), revision: versionSchema.optional(), calendar: calendarSchema, seed_national: z.boolean().optional() }), input);
  const key = await stableId(ctx.profile, actor.id, "calendar", parse(idSchema, requestId));
  const previous = await one<{ calendar_id: string; revision: number }>(ctx.env,
    "SELECT calendar_id,revision FROM jur_calendar_versions WHERE profile_id=? AND request_key=?", ctx.profile, key);
  if (previous) return { id: previous.calendar_id, revision: previous.revision, recalculation_pending: previous.revision > 1 };
  const existing = data.id ? await calendarRow(ctx, data.id) : null;
  if (existing && (data.revision !== existing.revision || data.seed_national)) throw new ApiError(409, "version_conflict", "Recarregue o calendário; a carga inicial só está disponível na criação.");
  const id = existing?.id ?? `cal_${key}`, revision = (existing?.revision ?? 0) + 1;
  const calendar = parse(calendarSchema, { ...data.calendar, events: [...(data.seed_national ? nationalSeed(data.calendar.from, data.calendar.to) : []), ...data.calendar.events] });
  const at = now(), statements: ChildStatement[] = [];
  if (existing) statements.push(["UPDATE jur_calendars SET name=?,revision=?,updated=? WHERE profile_id=? AND id=? AND revision=?", [calendar.name, revision, at, ctx.profile, id, existing.revision]], cas);
  else statements.push([`INSERT INTO jur_calendars(profile_id,id,revision,name,created,updated)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM jur_calendars WHERE profile_id=?)<100`, [ctx.profile, id, revision, calendar.name, at, at, ctx.profile]], cas);
  statements.push([`INSERT INTO jur_calendar_versions(profile_id,calendar_id,revision,definition_json,seeded,created_by,created,request_key) VALUES(?,?,?,?,?,?,?,?)`,
    [ctx.profile, id, revision, JSON.stringify(calendar), Number(!!data.seed_national || !!existing?.seeded), actor.id, at, key]]);
  await atomic(ctx, statements);
  // A consulta do agendador deriva trabalho pendente das revisões persistidas.
  return { id, revision, recalculation_pending: !!existing };
}
