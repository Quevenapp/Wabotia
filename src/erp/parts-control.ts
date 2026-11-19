// Somente KV; seguro importar antes do motor e de seu esquema.
import { readErpPartsSnapshot, sameErpParts, type ErpPartsSnapshot } from "./parts.ts";

export const ERP_PARTS_KEY = "erp_parts";
export type ErpPartsFailure = "erp_parts_unavailable" | "erp_parts_stale";
export class ErpPartsControlError extends Error {
  readonly code: ErpPartsFailure;
  readonly status: 409 | 503;
  constructor(code: ErpPartsFailure) { super(code); this.code = code; this.status = code === "erp_parts_stale" ? 409 : 503; }
}
export interface ErpPartsKV {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface ErpPartsStore extends ErpPartsKV {
  transaction<T>(fn: (txn: ErpPartsKV) => Promise<T>): Promise<T>;
}
/** Entrega serializada: revisão antiga nunca substitui uma nova. */
export async function applyErpPartsSnapshot(storage: ErpPartsStore, profile: string, input: unknown, now = Date.now()): Promise<ErpPartsSnapshot> {
  const next = readErpPartsSnapshot(input, profile, now);
  if (!next) throw new ErpPartsControlError("erp_parts_unavailable");
  return storage.transaction(async tx => {
    const bound = await tx.get<string>("erp_profile");
    const kind = await tx.get<string>("kind");
    if ((bound && bound !== profile) || (kind && kind !== "erp") || await tx.get("profile"))
      throw new ErpPartsControlError("erp_parts_unavailable");
    const saved = await tx.get<ErpPartsSnapshot>(ERP_PARTS_KEY);
    if (!readErpPartsSnapshot(next, profile, Math.max(now, Date.now()))) throw new ErpPartsControlError("erp_parts_unavailable");
    if (saved && (BigInt(saved.revision) > BigInt(next.revision) ||
        (saved.revision === next.revision && !sameErpParts(saved.parts, next.parts))))
      throw new ErpPartsControlError("erp_parts_stale");
    // Conserva emissão e vencimento juntos ao ignorar uma renovação mais curta.
    const snapshot = saved?.revision === next.revision && saved.expires_at >= next.expires_at ? saved : next;
    if (!kind) await tx.put("kind", "erp");
    if (!bound) await tx.put("erp_profile", profile);
    // O Hub valida antes do import; o endpoint revalida a mesma entrega.
    if (snapshot !== saved) await tx.put(ERP_PARTS_KEY, snapshot);
    return snapshot;
  });
}
export async function currentErpParts(storage: ErpPartsKV, profile: string, now = Date.now()): Promise<ErpPartsSnapshot | null> {
  const saved = await storage.get(ERP_PARTS_KEY);
  return readErpPartsSnapshot(saved, profile, Math.max(now, Date.now()));
}
/** Revalidação depois de I/O e imediatamente antes da transação síncrona. */
export async function requireCurrentErpParts(storage: ErpPartsKV, profile: string, input: unknown, now = Date.now()): Promise<ErpPartsSnapshot> {
  const incoming = readErpPartsSnapshot(input, profile, now);
  if (!incoming) throw new ErpPartsControlError("erp_parts_unavailable");
  const saved = await storage.get<ErpPartsSnapshot>(ERP_PARTS_KEY);
  if (!readErpPartsSnapshot(incoming, profile, Math.max(now, Date.now()))) throw new ErpPartsControlError("erp_parts_unavailable");
  if (saved && (BigInt(saved.revision) > BigInt(incoming.revision) ||
      (saved.revision === incoming.revision && !sameErpParts(saved.parts, incoming.parts))))
    throw new ErpPartsControlError("erp_parts_stale");
  return incoming;
}
export async function handleErpParts(storage: ErpPartsStore, profile: string, request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const s = await applyErpPartsSnapshot(storage, profile, await request.json());
    return Response.json({ profile: s.profile, revision: s.revision });
  } catch (error) {
    const e = error instanceof ErpPartsControlError ? error : new ErpPartsControlError("erp_parts_unavailable");
    return Response.json({ error: { code: e.code, message: "Estado das partes indisponível." } }, { status: e.status });
  }
}
