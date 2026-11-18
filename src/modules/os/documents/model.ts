import { ApiError, requireValue } from "../../../types";
import type { CreateDocumentRequest, DocumentMetadata } from "../contracts";

export const DOCUMENT_LIMIT = 10 * 1024 * 1024;
export const UPLOAD_TTL = 24 * 60 * 60 * 1000;
export const UPLOAD_LEASE = 5 * 60 * 1000;
// Sem HTML, SVG, executáveis ou tipos genéricos que escondam conteúdo ativo.
export const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export interface DocumentRow {
  id: string;
  profile_id: string;
  order_id: string;
  name: string;
  mime_type: string;
  expected_bytes: number;
  byte_length: number | null;
  sha256: string | null;
  r2_key: string | null;
  state: "pending" | "ready" | "aborted";
  upload_attempt: string | null;
  upload_request_key: string | null;
  upload_lease_until: number | null;
  upload_expires_at: number;
  source_message_id: string | null;
  source_media_id: string | null;
  client_visible: number;
  sensitive: number;
  version: number;
  created_by: string;
  created: number;
  updated: number;
  archived_at: number | null;
}

export function fail(status: number, code: string): never {
  // Não repetir nome, texto, chave R2 ou dados recebidos em erros/auditoria.
  throw new ApiError(status, code, `Documento: ${code}.`);
}

export function validateDocument(
  data: Record<string, unknown>,
): CreateDocumentRequest {
  for (const key of Object.keys(data))
    requireValue(
      [
        "id",
        "name",
        "mime_type",
        "expected_bytes",
        "client_visible",
        "sensitive",
      ].includes(key),
      "Propriedade de documento não permitida.",
    );
  requireValue(typeof data.name === "string", "name: texto obrigatório.");
  const name = data.name.trim();
  requireValue(
    Array.from(name).length > 0 &&
      Array.from(name).length <= 200 &&
      !/[\x00-\x1f\x7f/\\]/.test(name),
    "name: nome inválido.",
  );
  requireValue(
    typeof data.mime_type === "string",
    "mime_type: texto obrigatório.",
  );
  const mime_type = data.mime_type.trim().toLowerCase();
  if (!DOCUMENT_MIME_TYPES.has(mime_type)) fail(415, "unsupported_media_type");
  requireValue(
    Number.isSafeInteger(data.expected_bytes) &&
      Number(data.expected_bytes) > 0,
    "expected_bytes: inteiro positivo obrigatório.",
  );
  if (Number(data.expected_bytes) > DOCUMENT_LIMIT)
    fail(413, "document_too_large");
  requireValue(
    typeof data.client_visible === "boolean",
    "client_visible: booleano obrigatório.",
  );
  requireValue(
    typeof data.sensitive === "boolean",
    "sensitive: booleano obrigatório.",
  );
  requireValue(
    !data.sensitive || !data.client_visible,
    "sensitive: documento não pode ser público.",
  );
  return {
    name,
    mime_type,
    expected_bytes: Number(data.expected_bytes),
    client_visible: data.client_visible,
    sensitive: data.sensitive,
  };
}

export function versionOf(value: unknown): number {
  requireValue(
    Number.isSafeInteger(value) && Number(value) > 0,
    "version: inteiro positivo obrigatório.",
  );
  return Number(value);
}

export function documentMetadata(row: DocumentRow): DocumentMetadata {
  return {
    id: row.id,
    order_id: row.order_id,
    version: row.version,
    name: row.name,
    mime_type: row.mime_type,
    expected_bytes: row.expected_bytes,
    byte_length: row.byte_length,
    sha256: row.sha256,
    state: row.state,
    upload_expires_at: row.upload_expires_at,
    client_visible: !!row.client_visible,
    sensitive: !!row.sensitive,
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
    archived_at: row.archived_at,
  };
}

export const documentPrefix = (profile: string) =>
  `os-documents/${encodeURIComponent(profile)}/`;
export const objectKey = (
  row: Pick<DocumentRow, "profile_id" | "order_id" | "id" | "sensitive">,
  attempt: string,
) =>
  `${documentPrefix(row.profile_id)}${row.sensitive ? "sensitive" : "staff"}/${encodeURIComponent(row.order_id)}/${encodeURIComponent(row.id)}/${attempt}`;
