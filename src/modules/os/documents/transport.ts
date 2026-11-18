import { exec } from "../../../db";
import { hex } from "../../../security";
import { now, requireValue, uid, type Actor } from "../../../types";
import type {
  BinaryDownload,
  BinaryUploadHandler,
  ModuleContext,
} from "../../api";
import type { DocumentUploadResult } from "../contracts";
import { commitChild } from "../public";
import { authorizedDocument, type DocumentAccess } from "./access";
import {
  DOCUMENT_LIMIT,
  fail,
  objectKey,
  UPLOAD_LEASE,
  versionOf,
  type DocumentRow,
} from "./model";
import { mutationKey } from "./store";

function pending(row: DocumentRow) {
  if (row.state === "aborted" || row.upload_expires_at <= now())
    fail(409, "upload_expired");
  if (row.state !== "pending") fail(409, "document_not_pending");
}
function sameAttempt(row: DocumentRow, attempt: unknown) {
  requireValue(
    typeof attempt === "string" && attempt.length > 0,
    "upload_attempt: obrigatório.",
  );
  if (
    row.upload_attempt !== attempt ||
    !row.r2_key ||
    row.r2_key !== objectKey(row, attempt)
  )
    fail(409, "upload_incomplete");
}
function uploadResult(row: DocumentRow): DocumentUploadResult {
  if (!row.sha256 || !row.byte_length || !row.upload_attempt)
    fail(409, "upload_incomplete");
  return {
    id: row.id,
    version: row.state === "ready" ? row.version - 1 : row.version,
    upload_attempt: row.upload_attempt,
    byte_length: row.byte_length,
    sha256: row.sha256,
  };
}

/** Comando técnico serializado: não altera a versão de negócio nem publica conteúdo. */
export async function beginUpload(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  value: unknown,
  requestId: string,
  access: DocumentAccess = {},
) {
  const { row } = await authorizedDocument(ctx, actor, orderId, id, {
    ...access,
    write: true,
  });
  const version = versionOf(value);
  const key = await mutationKey(ctx, actor, orderId, requestId, `upload:${id}`);
  if (
    row.upload_request_key === key &&
    row.upload_attempt &&
    (row.state === "ready"
      ? row.version === version + 1
      : row.version === version)
  ) {
    if (row.state === "aborted") fail(409, "upload_expired");
    return { id, version, upload_attempt: row.upload_attempt };
  }
  if (row.version !== version) fail(409, "version_conflict");
  pending(row);
  if (row.upload_lease_until && row.upload_lease_until > now())
    fail(409, "upload_busy");
  const attempt = uid(),
    at = now();
  const result = await exec(
    ctx.env,
    `UPDATE os_documents SET upload_attempt=?,upload_request_key=?,
    upload_lease_until=?,r2_key=?,byte_length=NULL,sha256=NULL
    WHERE profile_id=? AND order_id=? AND id=? AND version=? AND state='pending'
      AND archived_at IS NULL AND upload_expires_at>? AND (upload_lease_until IS NULL OR upload_lease_until<=?)`,
    attempt,
    key,
    at + UPLOAD_LEASE,
    objectKey(row, attempt),
    ctx.profile,
    orderId,
    id,
    version,
    at,
    at,
  );
  if (result.meta.changes !== 1) fail(409, "upload_busy");
  return { id, version, upload_attempt: attempt };
}

/** Recalcula o hash dos bytes do R2: nenhum hash alegado por comando é autoridade. */
export async function inspectObject(ctx: ModuleContext, row: DocumentRow) {
  if (
    !row.r2_key ||
    !row.upload_attempt ||
    row.r2_key !== objectKey(row, row.upload_attempt)
  )
    fail(409, "upload_incomplete");
  const object = await ctx.env.MEDIA.get(row.r2_key);
  if (!object) fail(409, "upload_incomplete");
  if (object.size !== row.expected_bytes || object.size > DOCUMENT_LIMIT) {
    await object.body.cancel();
    fail(409, "content_mismatch");
  }
  const bytes = await object.arrayBuffer();
  const hash = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (
    bytes.byteLength !== row.expected_bytes ||
    object.customMetadata?.sha256 !== hash ||
    (row.sha256 !== null && row.sha256 !== hash) ||
    (row.byte_length !== null && row.byte_length !== bytes.byteLength)
  )
    fail(409, "content_mismatch");
  return { bytes, byte_length: bytes.byteLength, sha256: hash };
}

export async function recordUpload(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  value: unknown,
  attempt: unknown,
  access: DocumentAccess = {},
): Promise<DocumentUploadResult> {
  const { row } = await authorizedDocument(ctx, actor, orderId, id, {
    ...access,
    write: true,
  });
  const version = versionOf(value);
  sameAttempt(row, attempt);
  if (row.state === "ready" && row.version === version + 1)
    return uploadResult(row);
  if (row.version !== version) fail(409, "version_conflict");
  pending(row);
  const content = await inspectObject(ctx, row);
  if (row.sha256) return uploadResult(row);
  if (!row.upload_lease_until || row.upload_lease_until <= now())
    fail(409, "upload_expired");
  const result = await exec(
    ctx.env,
    `UPDATE os_documents SET byte_length=?,sha256=?
    WHERE profile_id=? AND order_id=? AND id=? AND version=? AND state='pending'
      AND upload_attempt=? AND upload_lease_until>? AND archived_at IS NULL`,
    content.byte_length,
    content.sha256,
    ctx.profile,
    orderId,
    id,
    version,
    attempt,
    now(),
  );
  if (result.meta.changes !== 1) fail(409, "upload_expired");
  return uploadResult({
    ...row,
    byte_length: content.byte_length,
    sha256: content.sha256,
  });
}

export async function completeDocument(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  value: unknown,
  attempt: unknown,
  requestId: string,
  access: DocumentAccess = {},
) {
  const { row, order } = await authorizedDocument(ctx, actor, orderId, id, {
    ...access,
    write: true,
  });
  const version = versionOf(value);
  sameAttempt(row, attempt);
  if (
    row.version !== version &&
    !(row.state === "ready" && row.version === version + 1)
  )
    fail(409, "version_conflict");
  if (row.state !== "ready") pending(row);
  // Também recupera PUT concluído cujo comando de transporte perdeu o recibo.
  const content = await inspectObject(ctx, row);
  const at = now();
  return commitChild(ctx, actor, order, {
    entity_kind: "document",
    id,
    expected_version: version,
    mutation_key: await mutationKey(
      ctx,
      actor,
      orderId,
      requestId,
      `complete:${id}`,
    ),
    changed_fields: ["state", "byte_length", "sha256"],
    event: "os.document_ready",
    statements: [
      [
        `UPDATE os_documents SET state='ready',version=version+1,updated=?,upload_lease_until=NULL,byte_length=?,sha256=?
      WHERE profile_id=? AND order_id=? AND id=? AND version=? AND state='pending'
        AND upload_attempt=? AND r2_key=? AND archived_at IS NULL`,
        [
          at,
          content.byte_length,
          content.sha256,
          ctx.profile,
          orderId,
          id,
          version,
          attempt,
          row.r2_key,
        ],
      ],
    ],
  });
}

/** Autoriza antes de abrir R2; todos os objetos, públicos ou sensíveis, são privados. */
export async function downloadDocument(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  access: DocumentAccess = {},
): Promise<BinaryDownload> {
  const { row } = await authorizedDocument(ctx, actor, orderId, id, access);
  if (row.state !== "ready") fail(409, "document_not_ready");
  sameAttempt(row, row.upload_attempt);
  const object = await ctx.env.MEDIA.get(row.r2_key!);
  if (!object) fail(404, "not_found");
  return {
    body: object.body,
    headers: {
      "Content-Type": row.mime_type,
      "Content-Length": String(row.byte_length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  };
}

export function uploadHandler(privateRoute = false): BinaryUploadHandler {
  const prefix = privateRoute
    ? "os.private.document.upload"
    : "os.document.upload";
  const access = { private: privateRoute, write: true };
  return {
    operations: [`${prefix}.begin`, `${prefix}.record`],
    async authorize(ctx, actor, { params }) {
      await authorizedDocument(
        ctx,
        actor,
        params.id,
        params.document_id,
        access,
      );
    },
    async upload(ctx, actor, request) {
      // Repetir a autorização também aqui protege chamadas diretas do adaptador.
      await authorizedDocument(
        ctx,
        actor,
        request.params.id,
        request.params.document_id,
        access,
      );
      const key = await mutationKey(
        ctx,
        actor,
        request.params.id,
        request.key,
        `upload:${request.params.document_id}`,
      );
      let grant: { upload_attempt: string };
      try {
        grant = (await request.command(`${prefix}.begin`, {
          version: request.version,
          upload_key: request.key,
        })) as typeof grant;
      } catch (error) {
        // F0 pode deixar recibo sem resposta ao interromper o comando. Só recuperar
        // a concessão já gravada para a mesma área/ator/documento/chave.
        const { row: recovered } = await authorizedDocument(
          ctx,
          actor,
          request.params.id,
          request.params.document_id,
          access,
        );
        if (recovered.upload_request_key !== key || !recovered.upload_attempt)
          throw error;
        grant = { upload_attempt: recovered.upload_attempt };
      }
      // O recibo do Coordinator pode ser antigo: reler a concessão efetiva antes do R2.
      const { row } = await authorizedDocument(
        ctx,
        actor,
        request.params.id,
        request.params.document_id,
        access,
      );
      if (row.upload_request_key !== key) fail(409, "upload_incomplete");
      sameAttempt(row, grant.upload_attempt);
      if (row.state === "ready" || row.sha256) {
        if (
          row.state === "ready"
            ? row.version !== request.version + 1
            : row.version !== request.version
        )
          fail(409, "version_conflict");
        if (row.state !== "ready") pending(row);
        return uploadResult(row);
      }
      pending(row);
      if (row.version !== request.version) fail(409, "version_conflict");
      if (!row.upload_lease_until || row.upload_lease_until <= now())
        fail(409, "upload_expired");
      // Se R2 gravou e a resposta se perdeu, recupera sem consumir/regravar o corpo.
      if (!(await ctx.env.MEDIA.head(row.r2_key!))) {
        const content = await request.content();
        if (content.byte_length !== row.expected_bytes)
          fail(409, "content_mismatch");
        if (row.upload_lease_until <= now()) fail(409, "upload_expired");
        // PUT condicional evita duas requisições da mesma chave sobrescreverem o objeto.
        await ctx.env.MEDIA.put(row.r2_key!, content.bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: row.mime_type },
          customMetadata: { sha256: content.sha256 },
          sha256: content.sha256,
        });
      }
      try {
        return await request.command(`${prefix}.record`, {
          version: request.version,
          upload_attempt: grant.upload_attempt,
        });
      } catch (error) {
        // Não escrever D1 no Worker nem depender de poder reexecutar o recibo F0.
        // O objeto verificado basta para /complete confirmar negócio atomicamente.
        const { row: recovered } = await authorizedDocument(
          ctx,
          actor,
          request.params.id,
          request.params.document_id,
          access,
        );
        sameAttempt(recovered, grant.upload_attempt);
        if (
          recovered.version !== request.version ||
          recovered.upload_request_key !== key
        )
          throw error;
        pending(recovered);
        const content = await inspectObject(ctx, recovered);
        return {
          id: recovered.id,
          version: recovered.version,
          upload_attempt: grant.upload_attempt,
          byte_length: content.byte_length,
          sha256: content.sha256,
        };
      }
    },
  };
}
