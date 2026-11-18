// Descritor sem efeitos de importação. O integrador chama registerJuridico().
import { onCommand, onRead, onRoute, onSchedule } from "../api";
import { assignees } from "./access";
import { listCalendars, saveCalendar } from "./calendars";
import { acknowledge, listAlerts, scheduleJuridico } from "./scheduler";
import { changeDeadline, createDeadline, deadlineDetail, listDeadlines, previewDeadline } from "./store";
import { idSchema, parse } from "./model";

export const juridicoReads: Array<{ path: string; handler: Parameters<typeof onRead>[2] }> = [
  { path: "juridico/calendars", handler: (ctx, actor) => listCalendars(ctx, actor) },
  { path: "juridico/assignees", handler: (ctx, actor) => assignees(ctx, actor) },
  { path: "juridico/alerts", handler: (ctx, actor) => listAlerts(ctx, actor) },
  { path: "juridico/deadlines", handler: (ctx, actor, { query }) => listDeadlines(ctx, actor, query) },
  { path: "juridico/deadlines/:id", handler: (ctx, actor, { params, query }) => deadlineDetail(ctx, actor, params.id, query.revision) },
];
export const juridicoWrites = [
  { method: "POST" as const, path: "juridico/calendars", op: "juridico.calendar.save" },
  { method: "PUT" as const, path: "juridico/calendars/:id", op: "juridico.calendar.save" },
  { method: "POST" as const, path: "juridico/preview", op: "juridico.preview" },
  { method: "POST" as const, path: "juridico/deadlines", op: "juridico.deadline.create" },
  { method: "POST" as const, path: "juridico/deadlines/:id/confirm", op: "juridico.deadline.confirm" },
  { method: "POST" as const, path: "juridico/deadlines/:id/complete", op: "juridico.deadline.complete" },
  { method: "POST" as const, path: "juridico/alerts/:id/acknowledge", op: "juridico.alert.acknowledge" },
];
export const juridicoCommands: Array<{ op: string; handler: Parameters<typeof onCommand>[2] }> = [
  { op: "juridico.calendar.save", handler: (ctx, actor, data, { requestId }) => saveCalendar(ctx, actor, data, requestId) },
  { op: "juridico.preview", handler: (ctx, actor, data) => previewDeadline(ctx, actor, data) },
  { op: "juridico.deadline.create", handler: (ctx, actor, data, { requestId }) => createDeadline(ctx, actor, data, requestId) },
  { op: "juridico.deadline.confirm", handler: (ctx, actor, data, { requestId }) => changeDeadline(ctx, actor, data, requestId, "confirm") },
  { op: "juridico.deadline.complete", handler: (ctx, actor, data, { requestId }) => changeDeadline(ctx, actor, data, requestId, "complete") },
  { op: "juridico.alert.acknowledge", handler: (ctx, actor, data) => acknowledge(ctx, actor, parse(idSchema, data.id)) },
];
export function registerJuridico() {
  for (const r of juridicoReads) onRead("juridico", r.path, r.handler);
  for (const r of juridicoWrites) onRoute("juridico", r);
  for (const r of juridicoCommands) onCommand("juridico", r.op, r.handler);
  onSchedule("juridico", scheduleJuridico);
}
