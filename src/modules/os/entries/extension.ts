import type { OsExtension } from "../extensions";
import { archiveEntry, createEntry, listEntries, reviseEntry, summarizeEntries } from "./store";

export const entriesExtension: OsExtension = {
  id: "entries",
  reads: [
    {
      path: "service-orders/conversation/:id/orders/:order_id/entries",
      handler: (ctx, actor, { params, query }) =>
        listEntries(ctx, actor, params.order_id, query, params.id),
    },
    {
      path: "service-orders/:id/entries/summary",
      handler: (ctx, actor, { params, query }) => summarizeEntries(ctx, actor, params.id, query),
    },
    {
      path: "service-orders/:id/entries",
      handler: (ctx, actor, { params, query }) => listEntries(ctx, actor, params.id, query),
    },
  ],
  writes: [
    { method: "POST", path: "service-orders/:id/entries", op: "os.entry.create" },
    { method: "POST", path: "service-orders/:id/entries/:entry_id/revisions", op: "os.entry.revise" },
    { method: "POST", path: "service-orders/:id/entries/:entry_id/archive", op: "os.entry.archive" },
  ],
  commands: [
    { op: "os.entry.create", handler: (ctx, actor, data, { requestId }) => createEntry(ctx, actor, data, requestId) },
    { op: "os.entry.revise", handler: (ctx, actor, data, { requestId }) => reviseEntry(ctx, actor, data, requestId) },
    { op: "os.entry.archive", handler: (ctx, actor, data, { requestId }) => archiveEntry(ctx, actor, data, requestId) },
  ],
};
