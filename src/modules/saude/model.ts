import { z } from "zod";
import { ApiError } from "../../types";

export const DAY = 86_400_000;
export const LEASE = 5 * 60_000;
export const LIMIT = 10 * 1024 * 1024;
export const prescriptionNotice = "Registro interno. Não constitui receita emitida para dispensação.";
export function fail(status: number, code: string): never {
  const messages: Record<string, string> = {
    forbidden: "Papel clínico ou sessão humana não autorizado.",
    not_found: "Registro não encontrado nesta área.",
    immutable: "Registro assinado: registre um adendo para corrigir.",
    author_required: "Somente o autor pode editar ou assinar a evolução.",
    retention: "Exclusão bloqueada pela política de guarda, impedimento ou envio em andamento.",
    version_conflict: "O registro mudou. Atualize a tela.",
    upload_busy: "Há um envio em andamento. Aguarde a tentativa atual.",
    upload_expired: "A tentativa de envio expirou. Inicie outra tentativa.",
    content_mismatch: "O conteúdo não corresponde ao anexo reservado.",
  };
  throw new ApiError(status, code, messages[code] || "Não foi possível concluir a operação clínica.");
}
const text = (max: number) => z.string().trim().min(1).max(max);
export const idSchema = text(100).regex(/^[a-zA-Z0-9_-]+$/);
export const versionSchema = z.number().int().positive().safe();
export const subjectSchema = z.object({
  kind: z.enum(["human", "animal"]), name: text(160),
  birth_date: z.iso.date().optional(), species: text(100).optional(),
  tutor: z.object({ name: text(160), reference: text(160) }).strict().optional(),
}).strict().refine(v => v.kind !== "animal" || (!!v.species && !!v.tutor));
export const recordSchema = z.object({
  episode_id: idSchema,
  kind: z.enum(["evolution", "prescription", "exam_request", "exam_result"]),
  text: text(20000),
  addendum_of: idSchema.optional(), reason: text(2000).optional(),
  request_id: idSchema.optional(), origin: text(240).optional(),
  received_at: z.number().int().nonnegative().safe().optional(),
}).strict().refine(v => !v.addendum_of || (v.kind === "evolution" && !!v.reason))
  .refine(v => v.kind !== "exam_result" || (!!v.request_id && !!v.origin && v.received_at !== undefined));
export const attachmentSchema = z.object({
  episode_id: idSchema, name: text(180).regex(/^[^\r\n/\\]+$/),
  mime_type: z.enum(["application/pdf", "image/jpeg", "image/png", "text/plain"]),
  expected_bytes: z.number().int().min(1).max(LIMIT),
}).strict();
export const policySchema = z.object({
  retention_days: z.number().int().min(1).max(36500).nullable(),
  deletion_enabled: z.boolean(), version: z.number().int().nonnegative(),
}).strict().refine(v => !v.deletion_enabled || v.retention_days !== null);
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "invalid_request", "Confira os campos obrigatórios e seus limites.");
  return result.data;
}
export type Subject = {
  profile_id: string; id: string; kind: "human" | "animal"; payload_enc: string | null;
  created: number; last_activity: number; retain_until: number | null;
  legal_hold: number; state: "active" | "deleting" | "deleted"; version: number;
};
export type RecordRow = {
  profile_id: string; id: string; subject_id: string; episode_id: string;
  kind: "evolution" | "prescription" | "exam_request" | "exam_result";
  payload_enc: string; author: string; created: number; version: number;
  signed_at: number | null; digest: string | null; addendum_of: string | null; request_id: string | null;
};
export type Attachment = {
  profile_id: string; id: string; subject_id: string; episode_id: string;
  payload_enc: string; mime_type: string; expected_bytes: number; state: "pending" | "ready";
  sensitive: 1; client_visible: 0; version: number; created: number; author: string;
  upload_key: string | null; attempt: string | null; lease_until: number | null;
  r2_key: string | null; sha256: string | null;
};
export type Policy = { retention_days: number | null; deletion_enabled: number; version: number };
