// Transporte comum; metadados só mudam por comandos serializados do Coordinator.
import { ApiError, requireValue, type Actor, type Env } from "../types";
import { hex } from "../security";
import { routeData } from "./hooks";

export const MODULE_BINARY_LIMIT = 10 * 1024 * 1024;
export interface BinaryContent {
  bytes: ArrayBuffer;
  byte_length: number;
  sha256: string;
}

/** Conta bytes reais (Content-Length não é autoridade) antes de tocar no R2. */
export async function readBinaryContent(
  request: Request,
  limit = MODULE_BINARY_LIMIT,
): Promise<BinaryContent> {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new ApiError(413, "document_too_large", "Documento acima do limite.");
  const reader = request.body?.getReader();
  requireValue(reader, "Envie o conteúdo binário do documento.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader!.cancel();
        throw new ApiError(
          413,
          "document_too_large",
          "Documento acima do limite.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader!.releaseLock();
  }
  requireValue(length > 0, "Documento vazio.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    bytes: bytes.buffer,
    byte_length: length,
    sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
  };
}

export function binaryResponse(
  body: BodyInit | null,
  headers: HeadersInit = {},
): Response {
  const safe = new Headers(headers);
  safe.set("Cache-Control", "no-store");
  safe.set("X-Content-Type-Options", "nosniff");
  safe.set("Content-Security-Policy", "sandbox; default-src 'none'");
  return new Response(body, { headers: safe });
}

export type BinaryCommand = (
  operation: string,
  data: Record<string, unknown>,
) => Promise<unknown>;
/** Não exporta chave R2 nem aceita operação fora das declaradas pelo upload. */
export function binaryCommand(
  env: Env,
  actor: Actor,
  profile: string,
  params: Record<string, string>,
  operations: readonly string[],
  key: string,
): BinaryCommand {
  return async (operation, data) => {
    if (!operations.includes(operation))
      throw new Error(`Comando binário não declarado: ${operation}`);
    const response = await env.COORDINATOR.get(
      env.COORDINATOR.idFromName(profile),
    ).fetch("https://coordinator/command", {
      method: "POST",
      body: JSON.stringify({
        profile,
        actor,
        operation,
        key,
        data: routeData(data, params),
      }),
    });
    const value = await response.json<any>();
    if (!response.ok)
      throw new ApiError(
        response.status,
        value.error?.code || "upload_failed",
        value.error?.message || "Falha no comando de documento.",
      );
    return value;
  };
}
