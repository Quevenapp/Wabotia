import { all } from "../../db";
import type { Actor } from "../../types";
import type { BinaryDownload, ModuleContext } from "../api";
import { audit, clinical, decrypt, subject } from "./access";
import { downloadAttachment, attachmentView } from "./documents";
import { fail, type Attachment, type RecordRow } from "./model";
import { recordView } from "./store";

/** NDJSON: conteúdo completo, revisões e bytes dos anexos, com memória limitada.
 * Nenhum pacote/URL público é persistido. Última linha distingue cópia completa.
 */
export async function exportRecord(ctx: ModuleContext, actor: Actor, subjectId: string): Promise<BinaryDownload> {
  await clinical(ctx, actor);
  const row = await subject(ctx, subjectId);
  await audit(ctx, actor, "export.begin", subjectId, [subjectId]);
  const encoder = new TextEncoder();
  async function* lines() {
    yield { type: "subject", id: row.id, ...await decrypt(ctx, row.id, row.payload_enc!) };
    for (const table of ["saude_episodes", "saude_records", "saude_revisions", "saude_attachments"] as const) {
      let cursor = "";
      while (true) {
        // Pagina por chave composta na tabela de versões; nomes de tabela são constantes.
        if ((await subject(ctx, subjectId)).version !== row.version) fail(409, "version_conflict");
        const key = table === "saude_revisions" ? "record_id || '_' || printf('%010d',version)" : "id";
        const rows = await all<any>(ctx.env,
          `SELECT *,${key} AS export_key FROM ${table} WHERE profile_id=? AND subject_id=? AND ${key}>? ORDER BY ${key} LIMIT 50`, ctx.profile, subjectId, cursor);
        if (!rows.length) break;
        await audit(ctx, actor, "export.read", subjectId, rows.map(r => `${table}:${r.export_key}`));
        for (const item of rows) {
          if (table === "saude_episodes") yield { type: "episode", id: item.id, order_id: item.order_id, created: item.created };
          if (table === "saude_records") yield { type: "record", ...await recordView(ctx, item as RecordRow) };
          if (table === "saude_revisions") yield { type: "revision", record_id: item.record_id,
            version: item.version, author: item.author, created: item.created,
            ...await decrypt(ctx, item.record_id, item.payload_enc) };
          if (table === "saude_attachments") {
            yield { type: "attachment", ...await attachmentView(ctx, item as Attachment) };
            if (item.state === "ready") {
              const download = await downloadAttachment(ctx, actor, subjectId, item.id);
              const bytes = new Uint8Array(await new Response(download.body).arrayBuffer());
              // Cada linha traz até 48 KiB; concatene os bytes decodificados por id/offset.
              for (let offset = 0; offset < bytes.length; offset += 49152) {
                let binary = "";
                for (const byte of bytes.subarray(offset, offset + 49152)) binary += String.fromCharCode(byte);
                yield { type: "attachment_bytes", id: item.id, offset, base64: btoa(binary) };
              }
            }
          }
        }
        cursor = rows.at(-1)!.export_key;
      }
    }
    if ((await subject(ctx, subjectId)).version !== row.version) fail(409, "version_conflict");
    await audit(ctx, actor, "export.complete", subjectId, [subjectId]);
    yield { type: "complete", subject_id: subjectId };
  }
  const iterator = lines();
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(JSON.stringify(next.value) + "\n"));
        } catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return(undefined); },
    }),
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="prontuario.ndjson"', "Cache-Control": "no-store" },
  };
}
