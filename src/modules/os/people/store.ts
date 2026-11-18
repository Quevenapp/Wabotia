import { all, one } from "../../../db";
import { contactNamespace } from "../../../contacts";
import { sha } from "../../../security";
import { ApiError, now, requireValue, type Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { LinkedPerson, MutationRef, Page } from "../contracts";
import { authorizedOrder, commitChild } from "../public";
import { mayReadSensitive } from "../privacy";
import { PERSON_FIELDS, personBody, personText, personValues, personVersion, type PersonValues } from "./model";
import { personBotContext, personDto, projectPerson, type PersonRow } from "./privacy";

async function parent(ctx: ModuleContext, actor: Actor, id: unknown, write = false) {
  const order = await authorizedOrder(ctx, actor, personText(id, "id", 100, true), { write });
  if (!order.type.features.people)
    throw new ApiError(409, "feature_disabled", "Pessoas ligadas desativadas neste tipo de trabalho.");
  return order;
}

async function checkSensitive(ctx: ModuleContext, actor: Actor, sensitive: boolean) {
  if (sensitive && !(await mayReadSensitive(ctx, actor)))
    throw new ApiError(403, "sensitive_forbidden", "Acesso sensível não autorizado.");
}

async function checkContact(ctx: ModuleContext, actor: Actor, id: string | null) {
  if (!id) return;
  ctx.access(actor, "contacts:read");
  if (!ctx.mayRead(actor, "contacts"))
    throw new ApiError(403, "forbidden", "Acesso a contatos não autorizado.");
  const contact = await one(ctx.env,
    "SELECT id FROM contacts WHERE profile_id=? AND id=? AND (?=1 OR namespace=?)",
    ctx.profile, id, actor.kind === "user" ? 1 : 0, contactNamespace(actor));
  if (!contact) throw new ApiError(404, "contact_not_found", "Contato não encontrado.");
}

async function mutationKey(ctx: ModuleContext, actor: Actor, orderId: string, op: string, requestId: string) {
  requireValue(typeof requestId === "string" && requestId.length > 0, "Informe Idempotency-Key.");
  return "os.person:" + await sha(JSON.stringify([ctx.profile, actor.kind, actor.id, orderId, op, requestId]));
}

export async function createPerson(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string): Promise<MutationRef> {
  const data = personBody(input, "create");
  const order = await parent(ctx, actor, data.id, true);
  const values = personValues(data);
  await checkSensitive(ctx, actor, values.sensitive);
  await checkContact(ctx, actor, values.contact_id);
  const key = await mutationKey(ctx, actor, order.row.id, "create", requestId);
  // ID estável permite reenviar até no limite da coleção; commitChild resolve o replay.
  const id = await sha(key);
  const count = await one<{ total: number }>(ctx.env,
    "SELECT count(*) total FROM os_people WHERE profile_id=? AND order_id=? AND id<>?",
    ctx.profile, order.row.id, id);
  if ((count?.total ?? 0) >= 200)
    throw new ApiError(409, "collection_limit", "Limite de pessoas ligadas atingido.");
  const at = now();
  return commitChild(ctx, actor, order, {
    entity_kind: "person", id, expected_version: null, mutation_key: key,
    changed_fields: [...PERSON_FIELDS], event: "os.person.created",
    statements: [[
      `INSERT INTO os_people
       (id,profile_id,order_id,role,name,contact_id,phone,email,note,client_visible,sensitive,created_by,created,updated)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS
       (SELECT 1 FROM os_orders WHERE profile_id=? AND id=?)
       AND (SELECT count(*) FROM os_people WHERE profile_id=? AND order_id=?)<200`,
      [id, ctx.profile, order.row.id, values.role, values.name, values.contact_id,
        values.phone, values.email, values.note, +values.client_visible, +values.sensitive,
        actor.id, at, at, ctx.profile, order.row.id, ctx.profile, order.row.id],
    ]],
  });
}

async function loadPerson(ctx: ModuleContext, orderId: string, id: unknown) {
  const personId = personText(id, "person_id", 100, true);
  const row = await one<PersonRow>(ctx.env,
    "SELECT * FROM os_people WHERE profile_id=? AND order_id=? AND id=?",
    ctx.profile, orderId, personId);
  if (!row) throw new ApiError(404, "not_found", "Pessoa ligada não encontrada.");
  return row;
}

export async function updatePerson(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string): Promise<MutationRef> {
  const data = personBody(input, "update");
  const order = await parent(ctx, actor, data.id, true);
  const version = personVersion(data.version);
  const row = await loadPerson(ctx, order.row.id, data.person_id);
  await checkSensitive(ctx, actor, row.sensitive === 1);
  const before = personDto(row) as PersonValues;
  const values = personValues(data, before);
  await checkSensitive(ctx, actor, values.sensitive);
  if (Object.hasOwn(data, "contact_id")) await checkContact(ctx, actor, values.contact_id);
  const fields = PERSON_FIELDS.filter((field) => Object.hasOwn(data, field));
  requireValue(fields.length > 0, "Informe os campos da pessoa a alterar.");
  return commitChild(ctx, actor, order, {
    entity_kind: "person", id: row.id, expected_version: version,
    mutation_key: await mutationKey(ctx, actor, order.row.id, `update:${row.id}`, requestId),
    changed_fields: fields.filter((field) => values[field] !== before[field]),
    event: "os.person.updated",
    statements: [[
      `UPDATE os_people SET ${fields.map((field) => `${field}=?`).join(",")},version=version+1,updated=?
       WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL`,
      [...fields.map((field) => typeof values[field] === "boolean" ? +values[field] : values[field]),
        now(), ctx.profile, order.row.id, row.id, version],
    ]],
  });
}

export async function archivePerson(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string): Promise<MutationRef> {
  const data = personBody(input, "archive");
  const order = await parent(ctx, actor, data.id, true);
  const version = personVersion(data.version);
  const row = await loadPerson(ctx, order.row.id, data.person_id);
  await checkSensitive(ctx, actor, row.sensitive === 1);
  const at = now();
  return commitChild(ctx, actor, order, {
    entity_kind: "person", id: row.id, expected_version: version,
    mutation_key: await mutationKey(ctx, actor, order.row.id, `archive:${row.id}`, requestId),
    changed_fields: ["archived_at"], event: "os.person.archived",
    statements: [[
      `UPDATE os_people SET archived_at=?,updated=?,version=version+1
       WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL`,
      [at, at, ctx.profile, order.row.id, row.id, version],
    ]],
  });
}

export async function listPeople(ctx: ModuleContext, actor: Actor, id: string, query: Record<string, string> = {}): Promise<Page<LinkedPerson>> {
  const order = await parent(ctx, actor, id);
  if (Object.keys(query).some((key) => !["cursor", "limit"].includes(key)) ||
      (query.limit !== undefined && !/^[1-9]\d*$/.test(query.limit)))
    throw new ApiError(400, "invalid_filter", "Consulta de pessoas inválida.");
  const limit = Math.min(100, Number(query.limit ?? 50));
  const sensitive = await mayReadSensitive(ctx, actor);
  const bot = personBotContext(actor);
  // O contexto inclui os filtros de visibilidade; o cursor não revela pessoas omitidas.
  const scope = [1, ctx.profile, order.row.id, "people", sensitive && !bot, bot,
    ctx.mayRead(actor, "contacts"), ctx.mayRead(actor, "notes")];
  let after: [number, string] | null = null;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 2048) throw Error();
      const cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(query.cursor), (c) => c.charCodeAt(0))));
      if (!Array.isArray(cursor) || cursor.length !== 3 ||
          JSON.stringify(cursor[0]) !== JSON.stringify(scope) ||
          !Number.isSafeInteger(cursor[1]) || cursor[1] < 0 ||
          typeof cursor[2] !== "string" || !cursor[2] || cursor[2].length > 100) throw Error();
      after = [cursor[1], cursor[2]];
    } catch {
      throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
    }
  }
  const rows = await all<PersonRow>(ctx.env,
    `SELECT * FROM os_people WHERE profile_id=? AND order_id=? AND archived_at IS NULL
     AND (?=1 OR sensitive=0) AND (?=0 OR (client_visible=1 AND sensitive=0))
     AND (? IS NULL OR created>? OR (created=? AND id>?)) ORDER BY created,id LIMIT ?`,
    ctx.profile, order.row.id, sensitive && !bot ? 1 : 0, bot ? 1 : 0,
    after?.[0] ?? null, after?.[0] ?? 0, after?.[0] ?? 0, after?.[1] ?? "", limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const data: LinkedPerson[] = [];
  for (const row of page) {
    const dto = await projectPerson(ctx, actor, row);
    if (dto) data.push(dto);
  }
  const last = page.at(-1);
  return {
    data,
    next_cursor: more && last ? btoa(String.fromCharCode(...new TextEncoder().encode(
      JSON.stringify([scope, last.created, last.id])))) : null,
  };
}
