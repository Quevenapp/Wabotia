import { all, one } from "../../../db";
import { sha } from "../../../security";
import { now, requireValue, type Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { DocumentMetadata, DocumentReservation, Page } from "../contracts";
import { commitChild } from "../public";
import {
  projectChildForBot,
  projectChildForCustomer,
  projectChildForStaff,
} from "../privacy";
import {
  authorizedDocument,
  customerCeiling,
  documentOrder,
  type DocumentAccess,
} from "./access";
import {
  documentMetadata,
  fail,
  UPLOAD_TTL,
  validateDocument,
  versionOf,
  type DocumentRow,
} from "./model";

export async function mutationKey(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  requestId: string,
  action: string,
) {
  requireValue(
    typeof requestId === "string" && requestId.length > 0,
    "Chave de repetição obrigatória.",
  );
  return `document:${await sha(JSON.stringify([ctx.profile, actor.id, orderId, action, requestId]))}`;
}

export async function reserveDocument(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  data: Record<string, unknown>,
  requestId: string,
  access: DocumentAccess = {},
  source?: { message_id: string; media_id: string },
): Promise<DocumentReservation> {
  const order = await documentOrder(ctx, actor, orderId, {
    ...access,
    write: true,
  });
  const input = validateDocument(data);
  if (input.sensitive !== !!access.private) fail(403, "sensitive_forbidden");
  if (customerCeiling(actor) && !input.client_visible)
    fail(403, "document_not_shareable");
  const key = await mutationKey(ctx, actor, orderId, requestId, "reserve");
  const id = (
    await sha(
      source ? JSON.stringify([ctx.profile, orderId, source.media_id]) : key,
    )
  ).slice(0, 32);
  const previous = await one<DocumentRow>(
    ctx.env,
    "SELECT * FROM os_documents WHERE profile_id=? AND order_id=? AND id=?",
    ctx.profile,
    orderId,
    id,
  );
  if (
    previous &&
    (previous.name !== input.name ||
      previous.mime_type !== input.mime_type ||
      previous.expected_bytes !== input.expected_bytes ||
      !!previous.sensitive !== input.sensitive ||
      !!previous.client_visible !== input.client_visible)
  )
    fail(409, "idempotency_conflict");
  if (!previous) {
    const count = await one<{ total: number }>(
      ctx.env,
      "SELECT COUNT(*) total FROM os_documents WHERE profile_id=? AND order_id=?",
      ctx.profile,
      orderId,
    );
    if (count!.total >= 500) fail(409, "collection_limit");
  }
  const at = previous?.created ?? now();
  const expires = previous?.upload_expires_at ?? at + UPLOAD_TTL;
  const ref = await commitChild(ctx, actor, order, {
    entity_kind: "document",
    id,
    expected_version: null,
    mutation_key: key,
    changed_fields: [
      "name",
      "mime_type",
      "expected_bytes",
      "client_visible",
      "sensitive",
      "state",
    ],
    event: "os.document_reserved",
    statements: [
      [
        `INSERT INTO os_documents
      (id,profile_id,order_id,name,mime_type,expected_bytes,upload_expires_at,
       source_message_id,source_media_id,client_visible,sensitive,created_by,created,updated)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM os_orders WHERE profile_id=? AND id=?)`,
        [
          id,
          ctx.profile,
          orderId,
          input.name,
          input.mime_type,
          input.expected_bytes,
          expires,
          source?.message_id ?? null,
          source?.media_id ?? null,
          +input.client_visible,
          +input.sensitive,
          actor.id,
          at,
          at,
          ctx.profile,
          orderId,
        ],
      ],
    ],
  });
  const collection = access.private ? "private-documents" : "documents";
  return {
    ...ref,
    upload_url: `/api/v1/profiles/${encodeURIComponent(ctx.profile)}/service-orders/${encodeURIComponent(orderId)}/${collection}/${id}/content`,
    expires_at: expires,
  };
}

export async function listDocuments(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  query: Record<string, string> = {},
  access: DocumentAccess = {},
): Promise<Page<DocumentMetadata>> {
  await documentOrder(ctx, actor, orderId, access);
  const publicOnly = !!access.conversation_id || customerCeiling(actor);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  requireValue(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    "limit: inteiro entre 1 e 100.",
  );
  const scope = JSON.stringify([
    ctx.profile,
    orderId,
    "documents",
    !!access.private,
    publicOnly,
    access.conversation_id ?? null,
  ]);
  let after: [number, string] | null = null;
  if (query.cursor) {
    try {
      const cursor = JSON.parse(decodeURIComponent(atob(query.cursor)));
      if (
        cursor.scope !== scope ||
        !Number.isSafeInteger(cursor.created) ||
        cursor.created < 0 ||
        typeof cursor.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(cursor.id)
      )
        throw new Error();
      after = [cursor.created, cursor.id];
    } catch {
      fail(400, "invalid_cursor");
    }
  }
  const rows = await all<DocumentRow>(
    ctx.env,
    `SELECT * FROM os_documents WHERE profile_id=? AND order_id=? AND archived_at IS NULL AND sensitive=?
     ${publicOnly ? "AND client_visible=1 AND state='ready'" : ""}
     ${after ? "AND (created>? OR (created=? AND id>?))" : ""}
     ORDER BY created,id LIMIT ?`,
    ctx.profile,
    orderId,
    access.private ? 1 : 0,
    ...(after ? [after[0], after[0], after[1]] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const data: DocumentMetadata[] = [];
  for (const row of page) {
    const dto = documentMetadata(row);
    const visible = customerCeiling(actor)
      ? projectChildForBot(dto)
      : access.conversation_id
        ? projectChildForCustomer(dto)
        : await projectChildForStaff(ctx, actor, dto);
    if (visible) data.push(visible);
  }
  const last = page.at(-1);
  return {
    data,
    next_cursor:
      rows.length > limit && last
        ? btoa(
            encodeURIComponent(
              JSON.stringify({ scope, created: last.created, id: last.id }),
            ),
          )
        : null,
  };
}

export async function archiveDocument(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  value: unknown,
  requestId: string,
  access: DocumentAccess = {},
) {
  const { row, order } = await authorizedDocument(ctx, actor, orderId, id, {
    ...access,
    write: true,
    archived: true,
  });
  const version = versionOf(value);
  // O núcleo resolve o replay pela chave antes do CAS, inclusive após arquivar.
  if (
    row.version !== version &&
    !(row.archived_at !== null && row.version === version + 1)
  )
    fail(409, "version_conflict");
  const at = row.archived_at ?? now();
  return commitChild(ctx, actor, order, {
    entity_kind: "document",
    id,
    expected_version: version,
    mutation_key: await mutationKey(
      ctx,
      actor,
      orderId,
      requestId,
      `archive:${id}`,
    ),
    changed_fields: ["archived_at"],
    event: "os.document_archived",
    statements: [
      [
        `UPDATE os_documents SET archived_at=?,updated=?,version=version+1
      WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL`,
        [at, at, ctx.profile, orderId, id, version],
      ],
    ],
  });
}
