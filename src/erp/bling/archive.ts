/** Montagem injetável do acervo. A integração do alarme fica em org-fecha. */
import type { ArchivePort } from "./ports.ts";
import type { SqlDriver } from "../engine/driver.ts";
import { BlingError, type BlingContext, type BlingRawRecord, type BlingRecordView } from "./contracts.ts";
import { authorizeArchiveRecord, createArchiveQueries } from "./queries.ts";
import { MAPPER_VERSION, projectRecord, resolveOrderReference, validateCapture } from "./projection.ts";

export interface ArchiveDependencies {
  db: SqlDriver;
  profile: string;
  xml: Pick<ArchivePort, "listXml" | "archiveXml" | "readXml">;
  purge: Pick<ArchivePort, "purgePreview" | "purge">;
}
export function createArchive(deps: ArchiveDependencies): ArchivePort & {
  getRecord(ctx: BlingContext, input: { entity: BlingRawRecord["identity"]["entity"]; id: string; version?: string }): BlingRecordView;
} {
  const queries = createArchiveQueries(deps);
  const project: ArchivePort["project"] = (ctx,record) => {
    authorizeArchiveRecord(ctx,record.identity,record.version);
    if (ctx.profile !== deps.profile || record.identity.profile !== deps.profile) throw new BlingError("BLING_ACCOUNT_MISMATCH");
    if (!ctx.identity.parts?.customers) throw new BlingError("BLING_DISABLED");
    // O commit pode projetar antes de persistir. A consulta acrescenta os
    // metadados duráveis, inclusive a primeira observação, abaixo.
    return {historical:projectRecord(record),metadata:{identity:record.identity,version:record.version,semantic_hash:record.semantic_hash,
      payload_bytes:new TextEncoder().encode(record.payload_text).byteLength,first_observed_at:record.observed_at,last_observed_at:record.observed_at,
      source_updated_at:record.source_updated_at,source_time_quality:record.source_time_quality,deleted:record.deleted,mapper_version:MAPPER_VERSION,capture_revision:record.capture?.revision??null}};
  };
  return {
    ...queries,
    ...deps.xml,
    ...deps.purge,
    validateCapture(ctx, input) {
      if (ctx.profile !== deps.profile || input.record.identity.profile !== deps.profile) throw new BlingError("BLING_ACCOUNT_MISMATCH");
      if (!ctx.identity.parts?.customers) throw new BlingError("BLING_DISABLED");
      // A coluna e o parser compartilham 128 KiB. Parar antes do SQL preserva
      // o checkpoint e nunca trunca uma evidência lexical extensa.
      if(input.record.capture&&new TextEncoder().encode(JSON.stringify(input.record.capture)).byteLength>131_072)throw new BlingError("BLING_CAPACITY_STOP");
      return validateCapture(input.record,input.bytes);
    },
    project,
    getRecord(ctx,input) {
      return deps.db.transaction(() => {
        const account = deps.db.exec("SELECT account_id FROM wb_bling_control WHERE id=1").rows[0]?.account_id;
        if (!account) throw new BlingError("BLING_AUTH_REQUIRED");
        const record = queries.readVersion(ctx,{profile:deps.profile,account_id:String(account),entity:input.entity,source_id:input.id},input.version);
        if (!record) throw new BlingError("BLING_RESPONSE_INVALID");
        const links = deps.db.exec("SELECT entity,record_id,origin_id,CAST(pulled_version AS TEXT) AS pulled_version,pulled_hash,deleted FROM erp_sync__link WHERE entity=? AND origin_id=?",input.entity,input.id).rows;
        const historical=project(ctx,record).historical;
        historical.unresolved_references=historical.unresolved_references.map(reference=>{
          if (!reference.invoice_source_id || !reference.order_source_id) return reference;
          // Não inferir ausência/ambiguidade a partir de uma visão fiscal parcial.
          if (ctx.identity.actor?.is_agent && !["nfe","nfce"].every(entity=>ctx.authorization?.bot?.allowed_entities.includes(entity as "nfe"|"nfce"))) return reference;
          const candidates=deps.db.exec("SELECT entity,source_id,CAST(version AS TEXT) AS version FROM origin_sync__raw_record WHERE entity IN ('nfe','nfce') AND source_id=?",reference.invoice_source_id).rows;
          return resolveOrderReference(reference,candidates.map(row=>({identity:{profile:deps.profile,account_id:String(account),entity:row.entity as "nfe"|"nfce",source_id:String(row.source_id)},version:String(row.version)})));
        });
        return { raw:record,historical,metadata:{...queries.recordMetadata(ctx,record),mapper_version:MAPPER_VERSION},existing_links: links as BlingRecordView["existing_links"] };
      });
    },
  };
}
