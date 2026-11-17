// O documento espelhado do Origin (origin/authority 'origin') nas escritas e leituras nativas:
// erp_document_mirror.require_visible e os gatilhos aa_mirror_authority (guard_document,
// guard_item e guard_effect). Leem linhas que o motor tem (o documento espelhado existe quando
// foi importado); sem documento espelhado, não fazem nada.
// erp_document_mirror.writing() é a checagem do papel erp_document_mirror_writer do Postgres:
// falso no motor, que não tem papéis.
// guard_effect (das tabelas que apontam para documento: situação, ocorrência, auditoria,
// lançamentos, operação de comissão...) só recusa documento com authority 'origin'. Nos escritores
// do Documentos e do Financeiro ele não alcança nada a mais: o require_visible de escrita no começo
// e o guard_document no UPDATE do documento já recusam esse documento antes. Fica exportado
// (mirrorGuardEffect no public.ts) para quem escreve nessas tabelas por outro caminho.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import * as sync from "../sync/public.ts";
import { contactScope, contactVisibleTo } from "../catalog/public.ts";

type Row = Record<string, unknown>;
const WRITER = false;

/** erp_document_mirror.require_visible(usuário, documento, escrita) */
export function requireVisible(db: SqlDriver, user: string | null, document: string | null, write: boolean) {
  if (document === null || !one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND origin='origin'`, document)) return;
  // erp_document_mirror.visible: para o documento espelhado, só a visibilidade do contato (sem o consumidor do PDV).
  const contact = (one(db, 'SELECT contact_id FROM "erp_documents__document" WHERE id=?', document)?.contact_id as string | null | undefined) ?? null;
  if (!contactVisibleTo(db, contactScope(db, user), contact)) raise("P0002", "erp_document_not_found");
  if (write && one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND authority='origin'`, document)) raise("42501", "erp_document_mirror_readonly");
}

/** erp_document_mirror.guard_effect(coluna): a linha não pode apontar para documento espelhado. */
export function guardEffect(db: SqlDriver, ...documents: unknown[]) {
  for (const d of documents)
    if (d !== null && d !== undefined && d !== "" && one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND authority='origin'`, d))
      raise("42501", "erp_document_mirror_effect_forbidden");
}

/** erp_document_mirror.guard_document (aa_mirror_authority em document) */
export function guardDocument(ctx: RpcContext, op: "INSERT" | "UPDATE" | "DELETE", o: Row | null, n: Row | null) {
  const applying = sync.applying(ctx);
  if (op === "DELETE") {
    if (o!.authority === "origin" && !applying) raise("42501", "erp_document_mirror_readonly");
    return;
  }
  if (op === "UPDATE" && (n!.origin !== o!.origin || n!.id !== o!.id || n!.kind !== o!.kind)) raise("42501", "erp_document_mirror_identity_immutable");
  if (op === "UPDATE" && n!.authority !== o!.authority && !applying) raise("42501", "erp_document_mirror_identity_immutable");
  if (n!.authority === "origin") {
    if (!(WRITER || applying) || (WRITER && n!.origin !== "origin")) raise("42501", "erp_document_mirror_readonly");
  } else if (WRITER) raise("42501", "erp_document_mirror_writer_native_denied");
  if (n!.source_proposal_id !== null && n!.source_proposal_id !== undefined) guardEffect(ctx.db, n!.source_proposal_id);
}

/** erp_document_mirror.guard_item (aa_mirror_authority em item) */
export function guardItem(ctx: RpcContext, op: "INSERT" | "UPDATE" | "DELETE", o: Row | null, n: Row | null) {
  const db = ctx.db;
  const mirrored = (doc: unknown) => !!one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND authority='origin'`, doc);
  const oldMirror = op !== "INSERT" && mirrored(o!.document_id);
  const newMirror = op !== "DELETE" && mirrored(n!.document_id);
  if (oldMirror || newMirror) {
    if (!(WRITER || sync.applying(ctx)) || (op === "UPDATE" && o!.document_id !== n!.document_id)) raise("42501", "erp_document_mirror_readonly");
  } else if (WRITER) raise("42501", "erp_document_mirror_writer_native_denied");
}

const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const stamp = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(v as bigint));

/** erp_document_mirror.metadata(documento): o estado do espelho (null sem linha em origin_mirror). */
export function mirrorMetadata(db: SqlDriver, document: string): Row | null {
  const m = one(db, 'SELECT * FROM "erp_documents__origin_mirror" WHERE document_id=?', document);
  if (!m) return null;
  return {
    entity: m.entity, source_id: m.source_id, source_version: m.applied_version === null ? null : String(m.applied_version), source_hash: m.applied_hash,
    mapper_version: m.mapper_version, source_number: m.source_number, source_status: m.source_status, source_status_label: m.source_status_label,
    observed_at: stamp(m.observed_at), source_updated_at: stamp(m.source_updated_at), source_deleted: m.source_deleted === null ? null : Number(m.source_deleted) === 1,
    state: m.state, partial: m.state === null ? null : m.state !== "synced", issues: parse(m.issues), reconciliation: parse(m.reconciliation), effects: parse(m.effects),
  };
}

/** erp_document_mirror.detail(documento): o documento espelhado, só leitura (null sem linha em origin_mirror). */
export function mirrorDetail(db: SqlDriver, document: string): Row | null {
  const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', document);
  const m = d ? one(db, 'SELECT source_number, reconciliation FROM "erp_documents__origin_mirror" WHERE document_id=?', document) : undefined;
  if (!d || !m) return null;
  const body = parse(d.body);
  if (body === null) return null;
  const rec = parse(m.reconciliation) as Row | null;
  const total = rec && typeof rec === "object" && !Array.isArray(rec) ? rec.source_total : undefined;
  const items = db
    .exec('SELECT id, position, product_id, data FROM "erp_documents__item" WHERE document_id=? ORDER BY position', document)
    .rows.map((i) => {
      const data = parse(i.data);
      return data === null ? null : { ...(data as Row), id: i.id, position: i.position, product_id: i.product_id };
    });
  return Object.assign({}, body as Row, {
    id: d.id, kind: d.kind, number: m.source_number, version: d.version, status: d.status, contact_id: d.contact_id, contact_snapshot: parse(d.contact_snapshot),
    warehouse_id: d.warehouse_id, total: total === undefined || total === null ? null : typeof total === "string" ? total : JSON.stringify(total),
    origin: d.origin, authority: d.authority, readonly: true, mirror: mirrorMetadata(db, document), created_at: stamp(d.created_at), updated_at: stamp(d.updated_at), items,
  });
}