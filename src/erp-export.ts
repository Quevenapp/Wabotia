// Tarefas da plataforma do ERP com a exportação da empresa em fatias.
//
// O runPlatformTasks do Fagoo (platform.mjs) chama TASK_HANDLERS por dentro,
// e o company_export de lá monta o pacote inteiro na memória (createZip) e o
// copia de novo no finish: até 50 MiB, mais de 100 MB num isolado de 128 MB.
// Aqui o laço é o mesmo, com as mesmas RPCs e a mesma regra (plan, chunk de
// 500 linhas, task_progress a cada 20 arquivos, complete, task_finish), e o
// company_export troca createZip + exportStorage.put por createZipStream +
// createErpUpload (src/erp-zip.ts, src/erp-storage.ts): cada página do
// export_chunk é comprimida e vai embora; a memória fica em uma parte de
// 5 MiB e num arquivo anexo por vez. As outras tarefas (notificações, limpeza
// das exportações vencidas) são as do Fagoo, sem mudança.
import { createErpUpload } from "./erp-storage";
import { createZipStream } from "./erp-zip";
import { ApiError, type Env } from "./types";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
interface Deps {
  rpc: Rpc;
  exportStorage: unknown;
  attachments: { get(key: string): Promise<Response> };
}
type Handler = (task: any, lease: string, deps: Deps) => Promise<unknown>;

// @ts-ignore módulo JavaScript do Fagoo, sem tipos (só carrega quando roda)
const platform = () => import("./erp/fagoo/workers/erp-api/src/platform.mjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A exportação da empresa (tarefa company_export) gravada em fatias no R2 da
 * área. Mesma entrada, mesmas RPCs e o mesmo pacote (dados/<conjunto>.json,
 * arquivos/<chave>, manifesto.json) do runExport do Fagoo.
 */
export async function runExportStreamed(
  env: Env,
  profile: string,
  task: any,
  lease: string,
  { rpc, attachments }: Deps,
) {
  const {
    PlatformError,
    EXPORT_BUCKET,
    EXPORT_MAX_BYTES,
    EXPORT_FILES_BUDGET,
  } = await platform();
  const bad = () => {
    throw new PlatformError(502, "ERP_UPSTREAM_INVALID_RESPONSE");
  };
  const held = { p_task: task.id, p_lease: lease };
  const plan = await rpc("erp_platform_export_plan", held);
  if (
    !isObject(plan) ||
    !UUID.test(plan.export_id || "") ||
    plan.export_id !== task.payload?.export_id ||
    !Array.isArray(plan.datasets) ||
    !Array.isArray(plan.files)
  )
    bad();
  const upload = await createErpUpload(
    env,
    profile,
    EXPORT_BUCKET,
    "application/zip",
  );
  try {
    const zip = createZipStream(
      (bytes) => upload.write(bytes),
      new Date(plan.as_of),
    );
    const encoder = new TextEncoder();
    const datasets: { name: string; rows: number; bytes: number }[] = [];
    let rows = 0;
    for (const name of plan.datasets) {
      if (typeof name !== "string" || !/^[a-z_]+\.[a-z0-9_]+$/.test(name))
        bad();
      // O mesmo texto do Fagoo ("[\n" + linhas separadas por ",\n" + "\n]\n"),
      // escrito página por página.
      const entry = await zip.entry(`dados/${name}.json`);
      let bytes = 0;
      const put = async (text: string) => {
        const chunk = encoder.encode(text);
        bytes += chunk.length;
        await entry.write(chunk);
      };
      let offset: number | null = 0;
      let count = 0;
      await put("[\n");
      while (offset !== null) {
        const page = await rpc("erp_platform_export_chunk", {
          ...held,
          p_dataset: name,
          p_offset: offset,
          p_limit: 500,
        });
        if (
          !isObject(page) ||
          page.dataset !== name ||
          page.offset !== offset ||
          !Array.isArray(page.rows) ||
          (page.next_offset !== null && page.next_offset <= offset)
        )
          bad();
        if (page.rows.length)
          await put(
            (count ? ",\n" : "") +
              page.rows.map((row: unknown) => JSON.stringify(row)).join(",\n"),
          );
        count += page.rows.length;
        offset = page.next_offset;
      }
      await put("\n]\n");
      await entry.close();
      datasets.push({ name, rows: count, bytes });
      rows += count;
      if (zip.size > EXPORT_MAX_BYTES - 1024 * 1024)
        throw new PlatformError(413, "ERP_EXPORT_TOO_LARGE");
    }
    let files = 0;
    const skipped: { key: string; reason: string }[] = [];
    for (const [index, file] of plan.files.entries()) {
      if (!isObject(file) || typeof file.key !== "string") bad();
      if (zip.size + (file.size ?? 0) > EXPORT_FILES_BUDGET) {
        skipped.push({ key: file.key, reason: "limite_do_pacote" });
        continue;
      }
      let bytes: Uint8Array | null = null;
      try {
        const response = await attachments.get(file.key);
        if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
        else void response.body?.cancel().catch(() => {});
      } catch {
        bytes = null;
      }
      if (!bytes) {
        skipped.push({ key: file.key, reason: "indisponivel" });
        continue;
      }
      await zip.add(`arquivos/${file.key}`, bytes);
      files++;
      if (index % 20 === 19)
        await rpc("erp_platform_task_progress", {
          ...held,
          p_progress: { summary: { datasets: datasets.length, rows, files } },
        });
    }
    const summary = {
      datasets: datasets.length,
      rows,
      files,
      files_skipped: skipped.length,
    };
    // O manifesto do Fagoo, campo a campo.
    const manifest = {
      formato: "brufap-exportacao-v1",
      empresa: "dados desta instalação do ERP do Vinki",
      gerado_em: new Date().toISOString(),
      dados_ate: plan.as_of,
      escopo:
        "Tabelas da empresa (cadastros, documentos, finanças, estoque, notas, empresa, preferências, frente de caixa, preços, anexos, atividades, cobrança e cópia espelhada do Origin) e os arquivos anexados.",
      fora_do_pacote: plan.excluded,
      conjuntos: datasets,
      arquivos_omitidos: skipped.slice(0, 200),
      resumo: summary,
    };
    await zip.add(
      "manifesto.json",
      encoder.encode(JSON.stringify(manifest, null, 2)),
    );
    await zip.finish();
    if (upload.size > EXPORT_MAX_BYTES)
      throw new PlatformError(413, "ERP_EXPORT_TOO_LARGE");
    const stored = await upload.finish(
      (sha) => `exports/${plan.export_id}/${sha}.zip`,
    );
    const done = await rpc("erp_platform_export_complete", {
      ...held,
      p_object_key: stored.path,
      p_size_bytes: stored.size,
      p_sha256: stored.sha256,
      p_manifest: {
        summary: { ...summary, bytes: stored.size },
        datasets: datasets
          .slice(0, 120)
          .map((d) => ({ name: d.name, rows: d.rows })),
      },
    });
    if (!isObject(done) || done.export?.id !== plan.export_id) bad();
    return {
      export_id: plan.export_id,
      size_bytes: stored.size,
      sha256: stored.sha256,
      rows,
      files,
      files_skipped: skipped.length,
    };
  } catch (error) {
    await upload.abort().catch(() => {});
    // Passou do teto do bucket ao escrever (createErpUpload): o erro do Fagoo.
    if (error instanceof ApiError && error.status === 413)
      throw new PlatformError(413, "ERP_EXPORT_TOO_LARGE");
    throw error;
  }
}

/**
 * O runPlatformTasks do Fagoo com a exportação em fatias: mesmo laço,
 * mesmas RPCs (schedule, task_claim, task_finish) e o mesmo tratamento de
 * erro. O agendador do ERP chama este, não o do Fagoo.
 */
export async function runErpPlatformTasks({
  env,
  profile,
  rpc,
  exportStorage,
  attachments,
  schedule = false,
  purposes = null,
  budgetMs = 25000,
  maxTasks = 10,
  now = () => Date.now(),
  lease = () => crypto.randomUUID(),
}: Deps & {
  env: Env;
  profile: string;
  schedule?: boolean;
  purposes?: string[] | null;
  budgetMs?: number;
  maxTasks?: number;
  now?: () => number;
  lease?: () => string;
}) {
  const { TASK_HANDLERS, PlatformError } = await platform();
  const handlers: Record<string, Handler> = {
    ...TASK_HANDLERS,
    company_export: (task, token, deps) =>
      runExportStreamed(env, profile, task, token, deps),
  };
  const bad = () => {
    throw new PlatformError(502, "ERP_UPSTREAM_INVALID_RESPONSE");
  };
  const started = now();
  const ran: { id: string; purpose: string; ok: boolean; code?: string }[] = [];
  if (schedule)
    await rpc("erp_platform_schedule", {
      p_now: new Date(started).toISOString(),
    });
  while (ran.length < maxTasks && now() - started < budgetMs) {
    const token = lease();
    const claimed = await rpc("erp_platform_task_claim", {
      p_lease: token,
      p_purposes: purposes,
    });
    if (!isObject(claimed) || claimed.scope !== "platform_task") bad();
    const task = claimed.task;
    if (task === null) break;
    if (
      !isObject(task) ||
      !UUID.test(task.id || "") ||
      !Object.hasOwn(handlers, task.purpose)
    )
      bad();
    try {
      const result = await handlers[task.purpose](task, token, {
        rpc,
        exportStorage,
        attachments,
      });
      await rpc("erp_platform_task_finish", {
        p_task: task.id,
        p_lease: token,
        p_ok: true,
        p_result: result,
        p_error: null,
      });
      ran.push({ id: task.id, purpose: task.purpose, ok: true });
    } catch (error) {
      // Concessão perdida (40001): outra rodada pegou a tarefa.
      const code =
        error instanceof PlatformError
          ? (error as { code: string }).code
          : "ERP_TASK_FAILED";
      if (code !== "PG_40001") {
        try {
          await rpc("erp_platform_task_finish", {
            p_task: task.id,
            p_lease: token,
            p_ok: false,
            p_result: null,
            p_error: code.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80),
          });
        } catch {
          // A concessão vence.
        }
      }
      ran.push({ id: task.id, purpose: task.purpose, ok: false, code });
    }
  }
  return ran;
}
