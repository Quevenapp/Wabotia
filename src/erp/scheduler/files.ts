// Tarefas da plataforma com arquivo, no alarme do objeto erp:<área>
// (docs/ERP-AGENDADOR.md, "Finalidades da fila"): a exportação da empresa
// (company_export) e a limpeza das exportações vencidas (export_cleanup).
// Quem roda é o runErpPlatformTasks da A (src/erp-export.ts: o laço do Fagoo
// com a exportação em fatias no R2), com três adaptadores locais, sem ida ao
// Worker nem volta ao objeto e sem ator:
// - rpc: o callRpc no SQLite do próprio objeto, com os erros do
//   createServiceRpc do Fagoo (PlatformError "PG_<código>"; a posse perdida,
//   PG_40001, segue a regra do laço);
// - exportStorage e attachments: os do Fagoo, com um fetch que responde o
//   /storage/v1 pelo erpStorage direto no R2 da área (os dois buckets são do
//   bloco erp: o erpStorage não lê o D1).
// A exportação não retoma em outra acordada (o estado do ZIP fica na
// memória): uma por acordada, sozinha (maxTasks 1).
import { runErpPlatformTasks } from "../../erp-export";
import { erpStorage } from "../../erp-storage";
import type { Env } from "../../types";
import { storageDriver } from "../engine/driver.ts";
import { ErpError } from "../engine/errors.ts";
import { callRpc } from "../engine/registry.ts";
import { engineClock, rpcStorage } from "../engine/rpc-endpoint.ts";
import type { ErpParts } from "../parts.ts";
import { currentErpParts, ErpPartsControlError } from "../parts-control.ts";
import { claimEligibleTask, claimedTaskDto, releaseBlockedTask, taskEligible, type ClaimedTask } from "./dispatch.ts";

/** Finalidades com arquivo: rodam aqui, uma por acordada, fora da rodada síncrona. */
export const FILE_PURPOSES = ["company_export", "export_cleanup"];

/** O "Supabase" local da costura (src/erp/api/local-fetch.ts): nunca recebe tráfego de rede. */
const LOCAL = "https://erp.wabotia.invalid";
const KEY = "motor-local";

const realYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Cada operação externa revalida antes e depois, inclusive multipart do exportador. */
export function guardedFileBucket(bucket: R2Bucket, check: () => Promise<unknown>): R2Bucket {
  const wrap = (target: any, multipart = false): any => new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      return async (...args: any[]) => {
        // Abort e remoção de temporários são compensações, permitidas após suspensão.
        const temporaryDelete = key === "delete" && (Array.isArray(args[0]) ? args[0] : [args[0]])
          .every((path: unknown) => typeof path === "string" && path.includes("/.upload/"));
        const cleanup = multipart && key === "abort" || temporaryDelete;
        if (!cleanup) await check();
        const result = await value.apply(object, args);
        if (!cleanup) {
          try { await check(); } catch (error) {
            if (key === "createMultipartUpload") await result.abort().catch(() => {});
            throw error;
          }
        }
        return key === "createMultipartUpload" ? wrap(result, true) : result;
      };
    },
  });
  return wrap(bucket);
}

export async function runFileTasks(env: Env, ctx: DurableObjectState, profile: string, control: {
  parts: Readonly<ErpParts>;
  readParts: () => Promise<Readonly<ErpParts> | null>;
}) {
  const db = storageDriver(ctx.storage);
  const clock = engineClock(ctx);
  let held: ClaimedTask | null = null;
  let completed: { id: string; lease: string; response: unknown } | null = null;
  let stopped = false;
  let parts = control.parts;
  const suspend = (): never => {
    stopped = true;
    if (held) releaseBlockedTask(db, held);
    throw new ErpPartsControlError("erp_parts_unavailable");
  };
  const check = async () => {
    const current = await control.readParts().catch(() => null);
    if (stopped || !current?.customers || held && !taskEligible(held.purpose, held.payload, current)) return suspend();
    return parts = current;
  };
  try {
    await check();
    // @ts-ignore módulos JavaScript do Fagoo, sem tipos
    const platform = await import("../fagoo/workers/erp-api/src/platform.mjs");
    await check();
    // @ts-ignore
    const attachmentStorage = await import("../fagoo/workers/erp-api/src/attachment-storage.mjs");
    await check();
    const { PlatformError, createExportStorage } = platform as any;
    const { createAttachmentStorage } = attachmentStorage as any;
    const guardedEnv = { ...env, MEDIA: guardedFileBucket(env.MEDIA, check) };
    const rpc = async (name: string, args: Record<string, unknown>) => {
      // O laço externo confirma depois de um await. A exportação já foi
      // concluída atomicamente abaixo: repetir essa confirmação não é trabalho novo.
      if (name === "erp_platform_task_finish" && args.p_ok === true && completed &&
          args.p_task === completed.id && args.p_lease === completed.lease) return completed.response;
      await realYield();
      await check();
      if (name === "erp_platform_task_claim") {
        held = claimEligibleTask(db, String(args.p_lease), FILE_PURPOSES, clock, parts);
        return { scope: "platform_task", data_mode: "erp_native", task: held ? claimedTaskDto(db, held) : null };
      }
      const storage = await rpcStorage(profile, name, args, guardedEnv.MEDIA, db);
      await check();
      try {
        let finished: typeof completed = null;
        const result = db.transaction(() => {
          const value = callRpc(db, name, args, clock, { ...storage, parts });
          if (name === "erp_platform_export_complete" && held) {
            // Não deixa uma exportação pronta voltar à fila se a Base cair
            // antes do finish: uma nova geração teria outro hash de arquivo.
            const summary = (args.p_manifest as { summary: Record<string, unknown> }).summary;
            const response = callRpc(db, "erp_platform_task_finish", {
              p_task: held.id, p_lease: held.lease, p_ok: true, p_error: null,
              p_result: { export_id: (value as { export: { id: string } }).export.id,
                size_bytes: args.p_size_bytes, sha256: args.p_sha256,
                rows: summary.rows, files: summary.files, files_skipped: summary.files_skipped },
            }, clock, { parts });
            finished = { id: held.id, lease: held.lease, response };
          }
          return value;
        });
        if (finished) { completed = finished; held = null; }
        if (name === "erp_platform_task_finish") held = null;
        return JSON.parse(JSON.stringify(result ?? null));
      } catch (error) {
        if (error instanceof ErpError)
          throw new PlatformError(error.code === "0A000" ? 503 : 409, `PG_${error.code}`);
        throw error;
      }
    };
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      await check();
      const snapshot = await currentErpParts(ctx.storage, profile);
      if (!snapshot?.parts.customers) return suspend();
      const result = await erpStorage(guardedEnv, profile, new Request(input, init), { snapshot, administrativeExport: true });
      await check();
      return result;
    };
    const result = await runErpPlatformTasks({
      env: guardedEnv, profile, rpc,
      exportStorage: createExportStorage({ baseUrl: LOCAL, key: KEY, fetchImpl }),
      attachments: createAttachmentStorage({ baseUrl: LOCAL, supabaseDeployment: "self-hosted", key: KEY, fetchImpl }),
      schedule: false, purposes: FILE_PURPOSES, maxTasks: 1,
    });
    await check();
    return result;
  } catch (error) {
    if (!stopped) throw error;
    return []; // Suspensão não é tentativa operacional, nem erro a repetir.
  }
}
