/** Apagamento extraordinário do acervo. Nenhuma escrita operacional ou restore. */
import { createHash } from "node:crypto";
import { BLING_ENTITIES, BlingError, type BlingContext, type BlingEntity, type BlingPurgePreview, type BlingPurgeScope, type BlingReceipt } from "./contracts.ts";
import { authorizeBlingOperation, parseBlingOperationInput } from "./schema.ts";
import type { ArchivePort } from "./ports.ts";
import { one, type Row, type SqlDriver } from "../engine/driver.ts";
import { hasPendingXmlWrite, waitArchiveIo } from "./xml.ts";

export interface ArchivePurgeDependencies {
  db: SqlDriver;
  /** Banco e prefixo R2 pertencem exclusivamente a esta área. */
  profile: string;
  media: { delete(key: string): Promise<unknown>; get(key: string): Promise<unknown | null> };
  randomId(): string;
  /** Releitura da Base no núcleo antes e depois do I/O; não consulta o Bling. */
  requireBase(ctx: BlingContext): Promise<void>;
}
export interface ArchivePurge extends Pick<ArchivePort, "purgePreview" | "purge"> {
  /** Uma transação limitada OU uma operação R2 por chamada do alarme. */
  runPurgeStep(ctx: BlingContext, workId: string): Promise<{ done: boolean; receipt: BlingReceipt | null }>;
}

/** Só estes DELETE imutáveis do acervo podem ser suspensos. UPDATE permanece. */
export const ARCHIVE_PURGE_DELETE_TRIGGERS = Object.freeze({
  erp_document_mirror__immutable_source__0: "erp_document_mirror__source_version",
  origin_fiscal__fiscal_item_immutable__0: "origin_fiscal__item",
  origin_fiscal__fiscal_object_immutable__0: "origin_fiscal__object",
  origin_fiscal__fiscal_revision_immutable__0: "origin_fiscal__revision",
  wb_bling_record_version_immutable_delete: "wb_bling_record_version",
  wb_bling_receipt_immutable_delete: "wb_bling_receipt",
});
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const parse = (value: unknown): Record<string, any> => {
  try { const result = JSON.parse(String(value)); if (result && typeof result === "object" && !Array.isArray(result)) return result; } catch { /* Erro local enumerado. */ }
  throw new BlingError("BLING_RESPONSE_INVALID");
};
const affected = "entity IN (SELECT value FROM json_each(?))";
const sourceScope = `source IN (SELECT id FROM origin_fiscal__source WHERE ${affected})`;
const itemScope = `revision IN (SELECT id FROM origin_fiscal__revision WHERE ${sourceScope})`;
const objectKey = (profile: string, sha: string) => `erp/${profile}/bling/xml/${sha}`;
// Um DELETE que estourou o orçamento ainda pode terminar remotamente. O purge
// não confirma nem libera uma nova geração enquanto essa chamada estiver viva.
const pendingR2Deletions=new Set<string>();

/** A restauração dos SQLs originais e a verificação de FKs pertencem à mesma
 * transactionSync do lote. Uma exceção em qualquer ponto restaura tudo. */
export function archiveDeleteTransaction<T>(db: SqlDriver, body: () => T): T {
  if (body.constructor.name === "AsyncFunction") throw new BlingError("BLING_RESPONSE_INVALID");
  return db.transaction(() => {
    const names = Object.keys(ARCHIVE_PURGE_DELETE_TRIGGERS);
    const triggers = db.exec("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name IN (SELECT value FROM json_each(?)) ORDER BY name", JSON.stringify(names)).rows;
    if (triggers.length !== names.length) throw new BlingError("BLING_ARCHIVE_REFERENCED");
    for (const trigger of triggers) {
      const expectedTable = ARCHIVE_PURGE_DELETE_TRIGGERS[String(trigger.name) as keyof typeof ARCHIVE_PURGE_DELETE_TRIGGERS];
      if (trigger.tbl_name !== expectedTable || !/\bBEFORE\s+DELETE\s+ON\b/i.test(String(trigger.sql)) || /\b(?:BEFORE|AFTER)\s+UPDATE\b/i.test(String(trigger.sql))) throw new BlingError("BLING_ARCHIVE_REFERENCED");
      db.exec(`DROP TRIGGER ${quote(String(trigger.name))}`);
    }
    const result = body();
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") throw new BlingError("BLING_RESPONSE_INVALID");
    for (const trigger of triggers) db.exec(String(trigger.sql));
    const restored = db.exec("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name IN (SELECT value FROM json_each(?)) ORDER BY name", JSON.stringify(names)).rows;
    if (JSON.stringify(restored) !== JSON.stringify(triggers) || db.exec("PRAGMA foreign_key_check").rows.length) throw new BlingError("BLING_ARCHIVE_REFERENCED");
    return result;
  });
}

function selected(scope: BlingPurgeScope): BlingEntity[] {
  return scope.all ? [...BLING_ENTITIES].sort() : [...new Set(scope.entities)].sort();
}

/** Referências de adoção não possuem todas FK para o bruto. Esta lista é
 * deliberadamente explícita; as FKs restantes são verificadas antes de remover. */
function references(db: SqlDriver, entities: string): number {
  const entityTables = ["erp_sync__link", "erp_catalog__origin", "erp_catalog__origin_mirror", "erp_catalog__product_source_deletion", "erp_documents__origin_import_origin", "erp_documents__origin_mirror", "erp_finance__origin_import_origin", "erp_warehouse_import__binding", "erp_document_mirror__revision"];
  let count = 0;
  for (const table of entityTables) count += Number(one(db, `SELECT count(*) AS n FROM ${quote(table)} WHERE ${affected}`, entities)?.n ?? 0);
  count += Number(one(db, `SELECT count(*) AS n FROM erp_sync__outbox WHERE ${affected} AND (review_required=1 OR state IN ('pending','sending','failed'))`, entities)?.n ?? 0);
  const kinds = JSON.parse(entities) as string[];
  if (kinds.includes("products") || kinds.includes("stock_balances") || kinds.includes("warehouses")) {
    count += Number(one(db, "SELECT count(*) AS n FROM erp_stock__opening_receipt")?.n ?? 0);
    count += Number(one(db, "SELECT count(*) AS n FROM erp_sync__stock_import")?.n ?? 0);
  }
  if (kinds.includes("product_categories")) count += Number(one(db, "SELECT count(*) AS n FROM erp_catalog__taxonomy_source WHERE taxonomy_id IS NOT NULL")?.n ?? 0);
  // Legado fora desta fatia: nunca apagar silenciosamente uma dependência.
  for (const table of ["erp_document_mirror__pending", "erp_document_mirror__price_observation", "erp_document_mirror__source_dependency", "origin_finance_refresh__origin", "erp_fiscal_mirror__xml_cache"]) {
    count += Number(one(db, `SELECT count(*) AS n FROM ${quote(table)} WHERE ${affected}`, entities)?.n ?? 0);
  }
  count += Number(one(db,"SELECT count(*) AS n FROM erp_document_mirror__source_dependency WHERE ref_entity IN (SELECT value FROM json_each(?)) AND entity NOT IN (SELECT value FROM json_each(?))",entities,entities)?.n??0);
  return count;
}

export function createArchivePurge(deps: ArchivePurgeDependencies): ArchivePurge {
  const { db } = deps;
  function area(ctx: BlingContext): void {
    if (ctx.profile !== deps.profile || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(deps.profile)) throw new BlingError("BLING_SCOPE_REQUIRED");
    if (!ctx.identity.parts?.customers) throw new BlingError("BLING_DISABLED");
  }
  function authorizeScope(ctx: BlingContext, scope: BlingPurgeScope): void {
    if (ctx.identity.actor?.is_agent && selected(scope).some(entity => !ctx.authorization?.bot?.allowed_entities.includes(entity))) throw new BlingError("BLING_SCOPE_REQUIRED");
  }
  function control(): Row {
    const value = one(db, "SELECT * FROM wb_bling_control WHERE id=1");
    if (!value) throw new BlingError("BLING_DISABLED");
    return value;
  }
  function journalHashes(value: unknown): string[] {
    const xml = parse(value).xml;
    if (!xml || typeof xml !== "object") return [];
    const documents = [xml, ...(Array.isArray(xml.documents) ? xml.documents : [])];
    return [...new Set(documents.filter(item => item && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) && item.key === objectKey(deps.profile, item.sha256)).map(item => String(item.sha256)))];
  }
  function preview(scope: BlingPurgeScope, generation: string): BlingPurgePreview {
    const current = control();
    if (String(current.generation) !== generation) throw new BlingError("BLING_GENERATION_RETIRED");
    if (current.state === "purging") throw new BlingError("BLING_REVISION_CONFLICT");
    const entities = JSON.stringify(selected(scope));
    const counts: Record<string, number> = {};
    const digests: string[] = [];
    for (const [table, columns] of [
      ["origin_sync__raw_record", "entity,source_id,version,version_hash,last_seen_at"],
      ["wb_bling_extra_raw", "entity,source_id,version,version_hash,last_seen_at"],
      ["erp_document_mirror__source_version", "entity,source_id,source_version,source_hash,observed_at"],
      ["wb_bling_record_version", "entity,source_id,version,semantic_hash,last_seen_at,capture_revision"],
      ["origin_fiscal__source", "entity,source_id,id,last_fingerprint,current_attempt,current_revision"],
    ]) {
      const digest = createHash("sha256"); let cursor: string | null = null; let count = 0;
      while (true) {
        const rows: Row[] = db.exec(`SELECT CAST(rowid AS TEXT) AS preview_rowid,${columns} FROM ${quote(table)} WHERE ${affected} AND (? IS NULL OR rowid>?) ORDER BY rowid LIMIT 50`, entities, cursor, cursor).rows;
        if (!rows.length) break;
        for (const row of rows) digest.update(JSON.stringify(row) + "\n", "utf8");
        count += rows.length; cursor = String(rows[rows.length - 1].preview_rowid);
      }
      counts[table] = count; digests.push(digest.digest("hex"));
    }
    const objectDigest = createHash("sha256"); let objectCursor = "";
    while (true) {
      const rows = db.exec(`SELECT DISTINCT o.hash,o.size FROM origin_fiscal__object o JOIN origin_fiscal__item i ON i.object_hash=o.hash JOIN origin_fiscal__revision r ON r.id=i.revision JOIN origin_fiscal__source s ON s.id=r.source WHERE s.${affected} AND o.hash>? ORDER BY o.hash LIMIT 50`, entities, objectCursor).rows;
      if (!rows.length) break;
      for (const row of rows) objectDigest.update(JSON.stringify(row) + "\n", "utf8");
      objectCursor = String(rows[rows.length - 1].hash);
    }
    const pendingDigest = createHash("sha256"); let pendingCursor = "";
    while (true) {
      const rows = db.exec(`SELECT id,progress FROM wb_bling_unit WHERE ${affected} AND kind IN ('xml_fetch','xml_store','xml_verify','xml_commit') AND id>? ORDER BY id LIMIT 50`, entities, pendingCursor).rows;
      if (!rows.length) break;
      for (const row of rows) pendingDigest.update(JSON.stringify(row) + "\n", "utf8");
      pendingCursor = String(rows[rows.length - 1].id);
    }
    // UNION faz a deduplicação no SQLite: a prévia não materializa um Set de
    // todos os hashes no heap, inclusive os objetos ainda somente no journal.
    const files = Number(one(db, `WITH selected_xml AS (
      SELECT progress FROM wb_bling_unit WHERE ${affected} AND kind IN ('xml_fetch','xml_store','xml_verify','xml_commit')
    ), candidates AS (
      SELECT o.hash AS sha256 FROM origin_fiscal__object o JOIN origin_fiscal__item i ON i.object_hash=o.hash JOIN origin_fiscal__revision r ON r.id=i.revision JOIN origin_fiscal__source s ON s.id=r.source WHERE s.${affected}
      UNION SELECT json_extract(progress,'$.xml.sha256') FROM selected_xml WHERE json_extract(progress,'$.xml.key')=? || json_extract(progress,'$.xml.sha256')
      UNION SELECT json_extract(j.value,'$.sha256') FROM selected_xml u,json_each(u.progress,'$.xml.documents') j WHERE json_extract(j.value,'$.key')=? || json_extract(j.value,'$.sha256')
    ) SELECT count(*) AS n FROM candidates WHERE typeof(sha256)='text' AND length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'`, entities, entities, objectKey(deps.profile, ""), objectKey(deps.profile, ""))?.n ?? 0);
    const blocked = references(db, entities);
    const signature = { profile: deps.profile, account: current.account_id, generation, revision: current.revision, scope: JSON.parse(entities), counts, digests, objects: objectDigest.digest("hex"), pending: pendingDigest.digest("hex"), files, blocked };
    return { generation, preview_hash: hash(signature), counts, files, blocked_references: blocked };
  }
  function receipt(row: Row | null): BlingReceipt | null { return row ? parse(row.result) as unknown as BlingReceipt : null; }
  function assertJob(ctx: BlingContext, workId: string): { job: Row; plan: Record<string, any>; progress: Record<string, any> } {
    area(ctx);
    const job = one(db, "SELECT * FROM wb_bling_unit WHERE id=? AND kind='purge'", workId);
    if (!job || job.profile !== ctx.profile) throw new BlingError("BLING_SCOPE_REQUIRED");
    const plan = parse(job.plan); const current = control();
    if (current.state !== "purging" || String(current.generation) !== plan.next_generation || current.account_id !== job.account_id) throw new BlingError("BLING_GENERATION_RETIRED");
    return { job, plan, progress: parse(job.progress) };
  }
  function queueObject(ctx: BlingContext, job: Row, sha: string): void {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new BlingError("BLING_RESPONSE_INVALID");
    const command = `r2-${hash([job.id, sha]).slice(0, 48)}`;
    if (one(db, "SELECT id FROM wb_bling_unit WHERE command_id=?", command)) return;
    const id = deps.randomId(); const plan = { purge_work_id: job.id, profile: deps.profile, sha256: sha, key: objectKey(deps.profile, sha) };
    db.exec("INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,configuration_revision,account_id,parts_revision,kind,phase,plan,progress,profile,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'r2_delete','queued',?,'{}',?,?,?,?)", id, deps.randomId(), command, hash(plan), job.generation, job.authorization_revision, job.credential_revision, job.configuration_revision, job.account_id, job.parts_revision, JSON.stringify(plan), deps.profile, ctx.clock.now(), ctx.clock.now(), ctx.clock.now());
  }
  function finish(ctx: BlingContext, job: Row, plan: Record<string, any>, progress: Record<string, any>): BlingReceipt {
    const result: BlingReceipt = { command_id: String(job.command_id), request_hash: String(job.request_hash), generation: String(job.generation), operation: "erp_bling_purge_apply", state: "committed", committed_at: new Date(ctx.clock.now()).toISOString(), references: { work_id: String(job.id), retired_generation: String(job.generation), next_generation: plan.next_generation }, counts: { deleted_rows: progress.deleted_rows ?? 0, deleted_files: progress.deleted_files ?? 0 }, error: null };
    db.exec("INSERT INTO wb_bling_receipt(command_id,operation,request_hash,generation,unit_id,attempt_id,state,result,references_json,created_at) VALUES(?,'erp_bling_purge_apply',?,?,?,?,'committed',?,?,?)", job.command_id, job.request_hash, job.generation, job.id, job.attempt_id, JSON.stringify(result), JSON.stringify(result.references), ctx.clock.now());
    db.exec("UPDATE wb_bling_unit SET phase='committed',finished_at=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=?", ctx.clock.now(), ctx.clock.now(), job.id);
    db.exec("UPDATE wb_bling_control SET state='off',archive_bytes=(SELECT coalesce(sum(size_bytes),0) FROM wb_bling_record_version),xml_bytes=(SELECT coalesce(sum(size),0) FROM origin_fiscal__object),observed_count=(SELECT count(*) FROM origin_sync__raw_record)+(SELECT count(*) FROM wb_bling_extra_raw),updated_at=? WHERE id=1", ctx.clock.now());
    db.exec("INSERT INTO wb_bling_audit(id,actor_id,operation,command_id,generation,counts,references_json,created_at) VALUES(?,?,'erp_bling_purge_completed',?,?,?,?,?)", deps.randomId(), job.actor_id, job.command_id, job.generation, JSON.stringify(result.counts), JSON.stringify(result.references), ctx.clock.now());
    return result;
  }
  const api: ArchivePurge = {
    purgePreview(ctx, input) {
      area(ctx); const parsed = parseBlingOperationInput("erp_bling_purge_preview", input); authorizeBlingOperation(ctx, "erp_bling_purge_preview", parsed);
      authorizeScope(ctx, parsed.scope);
      return db.transaction(() => preview(parsed.scope, parsed.generation));
    },
    async purge(ctx, input) {
      area(ctx); const parsed = parseBlingOperationInput("erp_bling_purge_apply", input); authorizeBlingOperation(ctx, "erp_bling_purge_apply", parsed);
      authorizeScope(ctx, parsed.scope);
      await deps.requireBase(ctx);
      return db.transaction(() => {
        area(ctx); authorizeBlingOperation(ctx, "erp_bling_purge_apply", parsed);
        authorizeScope(ctx, parsed.scope);
        const requestHash = hash({ ...parsed, scope: { all: parsed.scope.all, entities: selected(parsed.scope) }, profile: ctx.profile });
        const existing = one(db, "SELECT * FROM wb_bling_unit WHERE command_id=?", parsed.command_id);
        if (existing) {
          if (existing.request_hash !== requestHash || existing.kind !== "purge" || existing.profile !== ctx.profile) throw new BlingError("BLING_COMMAND_CONFLICT");
          return { work_id: String(existing.id), receipt: receipt(one(db, "SELECT * FROM wb_bling_receipt WHERE command_id=?", parsed.command_id)) };
        }
        const current = control();
        if (String(current.revision) !== parsed.expected_revision) throw new BlingError("BLING_REVISION_CONFLICT");
        const checked = preview(parsed.scope, parsed.generation);
        if (checked.preview_hash !== parsed.preview_hash) throw new BlingError("BLING_REVISION_CONFLICT");
        if (checked.blocked_references) throw new BlingError("BLING_ARCHIVE_REFERENCED");
        const nextGeneration = String(BigInt(parsed.generation) + 1n); const id = deps.randomId();
        const plan = { scope: selected(parsed.scope), next_generation: nextGeneration, preview_hash: checked.preview_hash, profile: ctx.profile };
        db.exec("INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,configuration_revision,account_id,parts_revision,kind,phase,plan,progress,profile,actor_id,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'purge','queued',?,? ,?,?,?,?,?)", id, deps.randomId(), parsed.command_id, requestHash, parsed.generation, current.authorization_revision, current.credential_revision, current.revision, current.account_id, ctx.identity.partsControl?.revision ?? "0", JSON.stringify(plan), JSON.stringify({ stage: 0, deleted_rows: 0, deleted_files: 0 }), ctx.profile, ctx.identity.actor!.user_id, ctx.clock.now(), ctx.clock.now(), ctx.clock.now());
        db.exec("UPDATE wb_bling_control SET collect_enabled=0,state='purging',generation=?,authorization_revision=authorization_revision+1,revision=revision+1,approved_by=NULL,approved_at=NULL,approval_hash=NULL,updated_at=? WHERE id=1", nextGeneration, ctx.clock.now());
        db.exec("INSERT INTO wb_bling_audit(id,actor_id,operation,command_id,generation,revision_before,revision_after,counts,references_json,created_at) VALUES(?,?,'erp_bling_purge_apply',?,?,?,?,?,?,?)", deps.randomId(), ctx.identity.actor!.user_id, parsed.command_id, parsed.generation, current.revision, Number(current.revision) + 1, JSON.stringify(checked.counts), JSON.stringify({ retired_generation: parsed.generation, next_generation: nextGeneration, work_id: id }), ctx.clock.now());
        return { work_id: id, receipt: null };
      });
    },
    async runPurgeStep(ctx, workId) {
      area(ctx);
      if (ctx.origin !== "internal") throw new BlingError("BLING_ADMIN_REQUIRED");
      await deps.requireBase(ctx);
      const prior = one(db, "SELECT r.* FROM wb_bling_receipt r JOIN wb_bling_unit u ON u.command_id=r.command_id WHERE u.id=? AND u.profile=? AND u.kind='purge'", workId, ctx.profile);
      if (prior) return { done: true, receipt: receipt(prior) };
      const snapshot = db.transaction(() => assertJob(ctx, workId));
      const stages = 14;
      if (Number(snapshot.progress.stage) < stages) {
        return archiveDeleteTransaction(db, () => {
          const { job, plan, progress } = assertJob(ctx, workId); const entities = JSON.stringify(plan.scope);
          if (references(db, entities)) throw new BlingError("BLING_ARCHIVE_REFERENCED");
          let changed = 0; const stage = Number(progress.stage);
          if (stage === 0) {
            // Um PUT já iniciado pode terminar depois de aposentar a geração.
            // Conservar seu journal até o executor liberar a fase ou a posse
            // expirar; a espera é durável e nunca dorme dentro do Coordinator.
            let activeCursor = "";
            while (true) {
              const active = db.exec(`SELECT id,lease_until FROM wb_bling_unit WHERE ${affected} AND kind IN ('xml_fetch','xml_store','xml_verify','xml_commit') AND phase='fetching' AND id>? ORDER BY id LIMIT 10`, entities, activeCursor).rows;
              if (!active.length) break;
              for (const unit of active) {
                // Uma chamada viva pode ultrapassar a posse. O marcador só
                // existe neste runtime; após queda, a posse expirada permite
                // recuperação sem um bloqueio eterno do apagamento.
                if (hasPendingXmlWrite(deps.profile, String(unit.id))) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
                if (unit.lease_until !== null && Number(unit.lease_until) > ctx.clock.now()) throw new BlingError("BLING_RETRY_WAIT", { retry_at: Number(unit.lease_until) });
              }
              activeCursor = String(active[active.length - 1].id);
            }
            const journals = db.exec(`SELECT id,progress FROM wb_bling_unit WHERE ${affected} AND kind IN ('xml_fetch','xml_store','xml_verify','xml_commit') AND coalesce(json_extract(progress,'$.purge_queued'),0)=0 ORDER BY id LIMIT 1`, entities).rows;
            for (const journal of journals) {
              const hashes = journalHashes(journal.progress);
              const offset = progress.journal?.id === journal.id ? Number(progress.journal.offset) : 0;
              for (const sha of hashes.slice(offset, offset + 10)) queueObject(ctx, job, sha);
              if (offset + 10 < hashes.length) progress.journal = { id: journal.id, offset: offset + 10 };
              else {
                delete progress.journal;
                db.exec("UPDATE wb_bling_unit SET progress=json_set(progress,'$.purge_queued',1) WHERE id=? AND phase NOT IN ('committed','superseded')", journal.id);
                // Unidades terminais são imutáveis; sua remoção também preserva o journal R2.
                if (one(db, "SELECT id FROM wb_bling_unit WHERE id=? AND phase IN ('committed','superseded')", journal.id)) {
                  db.exec("DELETE FROM wb_bling_receipt WHERE command_id IN (SELECT command_id FROM wb_bling_unit WHERE id=?) AND operation<>'erp_bling_purge_apply'", journal.id);
                  db.exec("DELETE FROM wb_bling_unit WHERE id=?", journal.id);
                }
              }
            }
            changed = journals.length;
          } else if (stage === 1) {
            changed = db.exec(`UPDATE origin_fiscal__source SET current_attempt=NULL,current_revision=NULL WHERE rowid IN (SELECT rowid FROM origin_fiscal__source WHERE ${affected} AND (current_attempt IS NOT NULL OR current_revision IS NOT NULL) LIMIT 10)`, entities).rowsWritten;
          } else if (stage === 2) {
            const items = db.exec(`SELECT rowid,object_hash FROM origin_fiscal__item WHERE ${itemScope} LIMIT 10`, entities).rows;
            for (const item of items) {
              const outside = one(db, `SELECT 1 FROM origin_fiscal__item i JOIN origin_fiscal__revision r ON r.id=i.revision JOIN origin_fiscal__source s ON s.id=r.source WHERE i.object_hash=? AND s.entity NOT IN (SELECT value FROM json_each(?)) LIMIT 1`, item.object_hash, entities);
              if (!outside) queueObject(ctx, job, String(item.object_hash));
              db.exec("DELETE FROM origin_fiscal__item WHERE rowid=?", item.rowid);
            }
            changed = items.length;
          } else if (stage === 3 || stage === 4) {
            const table = stage === 3 ? "origin_fiscal__revision" : "origin_fiscal__attempt";
            changed = db.exec(`DELETE FROM ${quote(table)} WHERE rowid IN (SELECT rowid FROM ${quote(table)} WHERE ${sourceScope} LIMIT 10)`, entities).rowsWritten;
          } else if (stage >= 5 && stage <= 11) {
            const table = ["origin_fiscal__source", "erp_document_mirror__source_version", "wb_bling_record_version", "erp_sync__inbox", "origin_sync__raw_record", "wb_bling_extra_raw", "origin_sync__batch_inbox"][stage - 5];
            changed = db.exec(`DELETE FROM ${quote(table)} WHERE rowid IN (SELECT rowid FROM ${quote(table)} WHERE ${affected} LIMIT 10)`, entities).rowsWritten;
          } else if (stage === 12) {
            // Retém recibos administrativos e o tombstone desta geração. Recibos
            // de coleta são pequenos, mas deixam de identificar o conteúdo apagado.
            const rows = db.exec(`SELECT command_id FROM wb_bling_unit WHERE ${affected} AND kind NOT IN ('purge','r2_delete') LIMIT 10`, entities).rows;
            for (const row of rows) {
              db.exec("DELETE FROM wb_bling_receipt WHERE command_id=? AND operation NOT IN ('erp_bling_purge_apply')", row.command_id);
              db.exec("DELETE FROM wb_bling_unit WHERE command_id=?", row.command_id);
            }
            changed = rows.length;
          } else {
            const objects = db.exec("SELECT o.hash FROM origin_fiscal__object o WHERE NOT EXISTS(SELECT 1 FROM origin_fiscal__item i WHERE i.object_hash=o.hash) AND EXISTS(SELECT 1 FROM wb_bling_unit u WHERE u.kind='r2_delete' AND json_extract(u.plan,'$.purge_work_id')=? AND json_extract(u.plan,'$.sha256')=o.hash) LIMIT 10", workId).rows;
            for (const object of objects) db.exec("DELETE FROM origin_fiscal__object WHERE hash=?", object.hash);
            changed = objects.length;
          }
          if (!changed) progress.stage = stage + 1;
          progress.deleted_rows = Number(progress.deleted_rows ?? 0) + changed;
          db.exec("UPDATE wb_bling_unit SET progress=?,updated_at=? WHERE id=?", JSON.stringify(progress), ctx.clock.now(), workId);
          return { done: false, receipt: null };
        });
      }
      // R2 é removido somente após os ponteiros SQL. Falha/crash mantém a unidade.
      const deletion = one(db, "SELECT * FROM wb_bling_unit WHERE kind='r2_delete' AND phase NOT IN ('committed','superseded') AND json_extract(plan,'$.purge_work_id')=? ORDER BY id LIMIT 1", workId);
      if (deletion) {
        const pendingKey=JSON.stringify([ctx.profile,deletion.id]);
        if(pendingR2Deletions.has(pendingKey))throw new BlingError("BLING_RETRY_WAIT",{retry_at:ctx.clock.now()+700});
        const plan = parse(deletion.plan); const progress = parse(deletion.progress);
        if (plan.profile !== ctx.profile || !/^[a-f0-9]{64}$/.test(plan.sha256) || plan.key !== objectKey(ctx.profile, plan.sha256)) throw new BlingError("BLING_SCOPE_REQUIRED");
        if (one(db, "SELECT 1 FROM origin_fiscal__item WHERE object_hash=? LIMIT 1", plan.sha256)) {
          db.transaction(() => { assertJob(ctx, workId); db.exec("UPDATE wb_bling_unit SET phase='superseded',finished_at=?,updated_at=? WHERE id=?", ctx.clock.now(), ctx.clock.now(), deletion.id); });
          return { done: false, receipt: null };
        }
        const fence = deps.randomId();
        db.transaction(() => {
          assertJob(ctx, workId);
          const live = one(db, "SELECT * FROM wb_bling_unit WHERE id=?", deletion.id);
          if (!live || live.phase === "committed" || live.phase === "superseded") throw new BlingError("BLING_LEASE_LOST");
          if (live.lease_until !== null && Number(live.lease_until) > ctx.clock.now()) throw new BlingError("BLING_RETRY_WAIT", { retry_at: Number(live.lease_until) });
          if (Number(live.not_before) > ctx.clock.now()) throw new BlingError("BLING_RETRY_WAIT", { retry_at: Number(live.not_before) });
          db.exec("UPDATE wb_bling_unit SET phase='waiting',owner=?,fence=?,lease_until=?,updated_at=? WHERE id=?", workId, fence, ctx.clock.now() + 4_000, ctx.clock.now(), deletion.id);
        });
        try {
          pendingR2Deletions.add(pendingKey);
          const io=Promise.resolve().then(()=>progress.deleted!==true?deps.media.delete(plan.key):deps.media.get(plan.key)).finally(()=>pendingR2Deletions.delete(pendingKey));
          const result=await waitArchiveIo(ctx,ctx.clock.now()+4_000,io);
          if(progress.deleted===true&&result!==null)throw new BlingError("BLING_RETRY_WAIT");
          await deps.requireBase(ctx);
          db.transaction(() => {
            const current = assertJob(ctx, workId);
            const live = one(db, "SELECT fence,lease_until FROM wb_bling_unit WHERE id=?", deletion.id);
            if (!live || live.fence !== fence || Number(live.lease_until) <= ctx.clock.now()) throw new BlingError("BLING_LEASE_LOST");
            if (progress.deleted !== true) db.exec("UPDATE wb_bling_unit SET phase='queued',progress=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=?", JSON.stringify({ deleted: true }), ctx.clock.now(), deletion.id);
            else {
              db.exec("UPDATE wb_bling_unit SET phase='committed',finished_at=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=?", ctx.clock.now(), ctx.clock.now(), deletion.id);
              current.progress.deleted_files = Number(current.progress.deleted_files ?? 0) + 1;
              db.exec("UPDATE wb_bling_unit SET progress=?,updated_at=? WHERE id=?", JSON.stringify(current.progress), ctx.clock.now(), workId);
            }
          });
        } catch (error) {
          const retryAt = ctx.clock.now() + 30_000;
          db.transaction(() => {
            db.exec("UPDATE wb_bling_unit SET phase='waiting',progress='{}',not_before=?,error_code='BLING_RETRY_WAIT',owner=NULL,fence=NULL,lease_until=NULL,updated_at=? WHERE id=? AND fence=? AND phase NOT IN ('committed','superseded')", retryAt, ctx.clock.now(), deletion.id, fence);
          });
          if (error instanceof BlingError) throw error;
          throw new BlingError("BLING_RETRY_WAIT", { retry_at: retryAt });
        }
        return { done: false, receipt: null };
      }
      return db.transaction(() => {
        const { job, plan, progress } = assertJob(ctx, workId);
        if (references(db, JSON.stringify(plan.scope)) || db.exec("PRAGMA foreign_key_check").rows.length) throw new BlingError("BLING_ARCHIVE_REFERENCED");
        for (const table of ["origin_fiscal__source", "erp_document_mirror__source_version", "wb_bling_record_version", "erp_sync__inbox", "origin_sync__raw_record", "wb_bling_extra_raw", "origin_sync__batch_inbox"]) {
          if (one(db, `SELECT 1 FROM ${quote(table)} WHERE ${affected} LIMIT 1`, JSON.stringify(plan.scope))) throw new BlingError("BLING_REVISION_CONFLICT");
        }
        return { done: true, receipt: finish(ctx, job, plan, progress) };
      });
    },
  };
  return api;
}
