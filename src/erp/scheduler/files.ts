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

/** Finalidades com arquivo: rodam aqui, uma por acordada, fora da rodada síncrona. */
export const FILE_PURPOSES = ["company_export", "export_cleanup"];

/** O "Supabase" local da costura (src/erp/api/local-fetch.ts): nunca recebe tráfego de rede. */
const LOCAL = "https://erp.wabotia.invalid";
const KEY = "motor-local";

const realYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function runFileTasks(env: Env, ctx: DurableObjectState, profile: string) {
  // @ts-ignore módulos JavaScript do Fagoo, sem tipos
  const platform = await import("../fagoo/workers/erp-api/src/platform.mjs");
  // @ts-ignore
  const attachmentStorage = await import("../fagoo/workers/erp-api/src/attachment-storage.mjs");
  const { PlatformError, createExportStorage } = platform as any;
  const { createAttachmentStorage } = attachmentStorage as any;
  const db = storageDriver(ctx.storage);
  const clock = engineClock(ctx);
  // A mesma resposta da rota /erp-rpc (JSON) e os mesmos erros do
  // createServiceRpc: 5xx vira 503, o resto 409, com o código do Postgres.
  const rpc = async (name: string, args: Record<string, unknown>) => {
    await realYield();
    const storage = await rpcStorage(profile, name, args, env.MEDIA, db);
    try {
      const result = callRpc(db, name, args, clock, storage);
      return JSON.parse(JSON.stringify(result ?? null));
    } catch (error) {
      if (error instanceof ErpError)
        throw new PlatformError(error.code === "0A000" ? 503 : 409, `PG_${error.code}`);
      throw error;
    }
  };
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
    erpStorage(env, profile, new Request(input, init));
  return runErpPlatformTasks({
    env,
    profile,
    rpc,
    exportStorage: createExportStorage({ baseUrl: LOCAL, key: KEY, fetchImpl }),
    attachments: createAttachmentStorage({ baseUrl: LOCAL, supabaseDeployment: "self-hosted", key: KEY, fetchImpl }),
    schedule: false,
    purposes: FILE_PURPOSES,
    maxTasks: 1,
  });
}
