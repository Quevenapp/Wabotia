/** Acervo, vínculos e pendências da adoção (B1 e B2): um só mecanismo.
 * Cadastros usam as tabelas da versão 12; documentos e contas, as da versão
 * 13 (o CHECK de entidade da 12 não se reescreve). As funções escolhem a
 * tabela pela entidade, e o resto do código não precisa saber. */
import { createHash } from "node:crypto";
import type { SqlDriver } from "../engine/driver.ts";
import { BlingAdoptionError, isAdoptionB2, type BlingAdoptionEntity, type BlingAdoptionMissing, type BlingAdoptionReason } from "./adoption-contracts.ts";
import { parseHistoricalPayload } from "./projection.ts";

export type Json = Record<string, unknown>;

export const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** UUID determinístico: repetir a mesma adoção reaproveita o comando do domínio. */
export function commandUuid(...parts: string[]): string {
  const h = sha(parts.join("\u0000"));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const object = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
export const at = (v: unknown, ...path: string[]): unknown => { for (const p of path) { if (!object(v)) return undefined; v = v[p]; } return v; };
/** Texto limpo; vazio vira null. Números do acervo chegam lexicais (string). */
export const text = (v: unknown): string | null => {
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t : null;
};
export const fold = (v: unknown) => text(v)?.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "") ?? null;
export const clip = (v: string | null, n = 200) => v === null ? null : v.length > n ? v.slice(0, n - 1) + "…" : v;
export const SOURCE_ID = /^[1-9]\d{0,39}$/;
/** Id do Bling de uma referência ({ id }) ou null. */
export const sourceOf = (v: unknown): string | null => { const id = text(object(v) ? v.id : v); return id && SOURCE_ID.test(id) && id !== "0" ? id : null; };

// ---------------------------------------------------------------------------
// Acervo

export interface AdoptionRaw { source_id: string; version: number; hash: string; payload: Json; deleted: boolean }
export function readRaw(db: SqlDriver, entity: BlingAdoptionEntity, source: string): AdoptionRaw | null {
  const row = db.exec(`SELECT r.source_id, r.version, r.version_hash, r.payload,
      CASE WHEN json_type(r.payload,'$._brufap_source.deleted')='true' OR coalesce(m.deleted_observed,0)=1 THEN 1 ELSE 0 END AS deleted
    FROM origin_sync__raw_record r LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.version
    WHERE r.entity=? AND r.source_id=?`, entity, source).rows[0];
  if (!row) return null;
  let payload: Json;
  try { payload = parseHistoricalPayload(String(row.payload)).payload as Json; } catch { payload = {}; }
  return { source_id: String(row.source_id), version: Number(row.version), hash: String(row.version_hash), payload, deleted: Number(row.deleted) === 1 };
}
export function archiveAvailable(db: SqlDriver): boolean {
  const control = db.exec("SELECT account_id, state FROM wb_bling_control WHERE id=1").rows[0];
  return !!control?.account_id && control.state !== "purging";
}

// ---------------------------------------------------------------------------
// Vínculos e revisões

/** Tabelas de vínculo e revisão da entidade (versão 12 ou 13). */
export function adoptionTables(entity: BlingAdoptionEntity): { link: string; review: string } {
  return isAdoptionB2(entity) ? { link: "wb_bling_adoption_doc_link", review: "wb_bling_adoption_doc_review" } : { link: "wb_bling_adoption_link", review: "wb_bling_adoption_review" };
}
export interface LinkRow { record_id: string; source_version: number; mode: string }
export function linkOf(db: SqlDriver, entity: BlingAdoptionEntity, source: string): LinkRow | null {
  const r = db.exec(`SELECT record_id, source_version, mode FROM ${adoptionTables(entity).link} WHERE entity=? AND source_id=?`, entity, source).rows[0];
  return r ? { record_id: String(r.record_id), source_version: Number(r.source_version), mode: String(r.mode) } : null;
}
export const linkedTo = (db: SqlDriver, entity: BlingAdoptionEntity, record: string) =>
  (db.exec(`SELECT source_id FROM ${adoptionTables(entity).link} WHERE entity=? AND record_id=?`, entity, record).rows[0]?.source_id as string | undefined) ?? null;
/** Dependências resolvidas pelos vínculos (nunca pelo nome). */
export function linkedRecord(db: SqlDriver, entity: BlingAdoptionEntity, source: unknown): string | null {
  const id = sourceOf(source);
  return id ? linkOf(db, entity, id)?.record_id ?? null : null;
}
export function writeLink(db: SqlDriver, entity: BlingAdoptionEntity, raw: Pick<AdoptionRaw, "source_id" | "version" | "hash">, record: string, mode: "created" | "linked" | "updated", actor: string, now: number) {
  const other = linkedTo(db, entity, record);
  if (other !== null && other !== raw.source_id) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", isAdoptionB2(entity) ? "O documento ou a conta do ERP já está ligado a outro registro do Bling." : "O cadastro do ERP já está ligado a outro registro do Bling.");
  const t = adoptionTables(entity);
  db.exec(`INSERT INTO ${t.link}(entity,source_id,record_id,source_version,source_hash,mode,adopted_by,adopted_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(entity,source_id) DO UPDATE SET record_id=excluded.record_id, source_version=excluded.source_version, source_hash=excluded.source_hash, mode=excluded.mode, adopted_by=excluded.adopted_by, adopted_at=excluded.adopted_at`,
    entity, raw.source_id, record, raw.version, raw.hash, mode, actor, now);
  db.exec(`DELETE FROM ${t.review} WHERE entity=? AND source_id=?`, entity, raw.source_id);
}
export function writeReview(db: SqlDriver, entity: BlingAdoptionEntity, raw: Pick<AdoptionRaw, "source_id" | "version" | "hash">, reason: BlingAdoptionReason, candidates: string[], now: number, detail?: string | null, missing: BlingAdoptionMissing[] = []) {
  const t = adoptionTables(entity);
  if (isAdoptionB2(entity)) {
    db.exec(`INSERT INTO ${t.review}(entity,source_id,state,reason,detail,candidates,missing,source_version,source_hash,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?,?,?)
      ON CONFLICT(entity,source_id) DO UPDATE SET state='pending', reason=excluded.reason, detail=excluded.detail, candidates=excluded.candidates, missing=excluded.missing, source_version=excluded.source_version, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
      entity, raw.source_id, reason, clip(detail ?? null), JSON.stringify(candidates.slice(0, 5)), JSON.stringify(missing.slice(0, 20)), raw.version, raw.hash, now, now);
    return;
  }
  db.exec(`INSERT INTO ${t.review}(entity,source_id,state,reason,detail,candidates,source_version,source_hash,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?,?)
    ON CONFLICT(entity,source_id) DO UPDATE SET state='pending', reason=excluded.reason, detail=excluded.detail, candidates=excluded.candidates, source_version=excluded.source_version, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
    entity, raw.source_id, reason, clip(detail ?? null), JSON.stringify(candidates.slice(0, 5)), raw.version, raw.hash, now, now);
}
export function reviewOf(db: SqlDriver, entity: BlingAdoptionEntity, source: string) {
  const r = db.exec(`SELECT state, source_version, source_hash, candidates FROM ${adoptionTables(entity).review} WHERE entity=? AND source_id=?`, entity, source).rows[0];
  return r ? { state: String(r.state), source_version: Number(r.source_version), source_hash: String(r.source_hash), candidates: JSON.parse(String(r.candidates)) as string[] } : null;
}
export function ignoreReview(db: SqlDriver, entity: BlingAdoptionEntity, source: string, now: number) {
  db.exec(`UPDATE ${adoptionTables(entity).review} SET state='ignored', updated_at=? WHERE entity=? AND source_id=?`, now, entity, source);
}
export function deleteLink(db: SqlDriver, entity: BlingAdoptionEntity, source: string) {
  db.exec(`DELETE FROM ${adoptionTables(entity).link} WHERE entity=? AND source_id=?`, entity, source);
}
