import type { OsExtension } from "../extensions";
import { archivePerson, createPerson, listPeople, updatePerson } from "./store";

/** O integrador registra este descritor; importar não altera o runtime. */
export const peopleExtension: OsExtension = {
  id: "people",
  reads: [{
    path: "service-orders/:id/people",
    handler: (ctx, actor, { params, query }) => listPeople(ctx, actor, params.id, query),
  }],
  writes: [
    { method: "POST", path: "service-orders/:id/people", op: "os.person.create" },
    { method: "PATCH", path: "service-orders/:id/people/:person_id", op: "os.person.update" },
    { method: "POST", path: "service-orders/:id/people/:person_id/archive", op: "os.person.archive" },
  ],
  commands: [
    { op: "os.person.create", handler: (ctx, actor, data, { requestId }) => createPerson(ctx, actor, data, requestId) },
    { op: "os.person.update", handler: (ctx, actor, data, { requestId }) => updatePerson(ctx, actor, data, requestId) },
    { op: "os.person.archive", handler: (ctx, actor, data, { requestId }) => archivePerson(ctx, actor, data, requestId) },
  ],
};
