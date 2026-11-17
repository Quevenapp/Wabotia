// Exportação da empresa em fatias (src/erp-export.ts): o mesmo pacote e as
// mesmas RPCs do runExport do Fagoo, gravado no R2 sem montar o ZIP na
// memória. As RPCs e os anexos são de mentira; o R2 é o do teste.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runErpPlatformTasks, runExportStreamed } from "../src/erp-export";
import { erpStorageKey } from "../src/erp-storage";
import { crc32 } from "../src/erp-zip";
import {
  TASK_HANDLERS,
  runPlatformTasks,
  PlatformError,
  // @ts-ignore módulo JavaScript do Fagoo, sem tipos
} from "../src/erp/fagoo/workers/erp-api/src/platform.mjs";

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Entradas de um ZIP pelo diretório central (só para o teste). */
async function unzip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      zip.subarray(at + 46, at + 46 + nameLength),
    );
    const start =
      offset +
      30 +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    const data = new Uint8Array(
      await new Response(
        new Blob([zip.subarray(start, start + compressed)])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

/** Uma empresa de mentira: conjuntos paginados e anexos (um some). */
const newIds = () => ({
  exportId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  present: `documents/${crypto.randomUUID()}/${crypto.randomUUID()}/${"a".repeat(64)}`,
  missing: `contacts/${crypto.randomUUID()}/${crypto.randomUUID()}/${"b".repeat(64)}`,
});
function company({ exportId, taskId, present, missing } = newIds()) {
  const sizes: Record<string, number> = {
    "erp_catalog.record": 0,
    "erp_finance.title": 1203,
    "erp_documents.document": 37,
  };
  const attachment = new TextEncoder().encode("%PDF-1.4 anexo");
  const calls: { name: string; args: any }[] = [];
  const rpc = async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === "erp_platform_export_plan")
      return {
        export_id: exportId,
        as_of: "2026-11-16T12:00:00.000Z",
        datasets: Object.keys(sizes),
        files: [
          { key: present, size: attachment.length },
          { key: missing, size: 10 },
        ],
        excluded: ["auth.users"],
      };
    if (name === "erp_platform_export_chunk") {
      const total = sizes[args.p_dataset];
      const end = Math.min(total, args.p_offset + args.p_limit);
      return {
        dataset: args.p_dataset,
        offset: args.p_offset,
        rows: Array.from({ length: end - args.p_offset }, (_, i) => ({
          id: args.p_offset + i,
          nome: `linha ${args.p_offset + i} — ação`,
          valor: ((args.p_offset + i) * 37) % 9999,
        })),
        next_offset: end < total ? end : null,
      };
    }
    if (name === "erp_platform_export_complete")
      return { export: { id: exportId } };
    return null;
  };
  const attachments = {
    get: async (key: string) =>
      key === present
        ? new Response(attachment)
        : new Response("não achei", { status: 404 }),
  };
  const task = { id: taskId, payload: { export_id: exportId } };
  return { exportId, rpc, calls, attachments, task };
}

/**
 * O manifesto sem o que difere de propósito do Fagoo: a hora (gerado_em) e
 * o nome do sistema (formato e empresa: Wabotia no lugar de Brufap).
 */
const withoutTime = (manifest: Uint8Array) => {
  const { gerado_em, formato, empresa, ...rest } = JSON.parse(
    new TextDecoder().decode(manifest),
  );
  expect(typeof gerado_em).toBe("string");
  expect([formato, empresa]).toHaveLength(2);
  return rest;
};
/** Os dois campos do nome do sistema no manifesto. */
const systemName = (manifest: Uint8Array) => {
  const { formato, empresa } = JSON.parse(new TextDecoder().decode(manifest));
  return { formato, empresa };
};

describe("exportação da empresa em fatias", () => {
  it("mesmo pacote e mesmas RPCs do runExport do Fagoo, gravado no R2", async () => {
    const profile = crypto.randomUUID();
    // Fagoo: o pacote inteiro na memória, entregue ao exportStorage.put.
    // As duas rodadas exportam a mesma empresa (mesmos ids).
    const ids = newIds();
    const fagoo = company(ids);
    let fagooZip: Uint8Array | null = null;
    const exportStorage = {
      put: async (_key: string, bytes: Uint8Array) => {
        fagooZip = bytes;
      },
    };
    await TASK_HANDLERS.company_export(fagoo.task, "lease-1", {
      rpc: fagoo.rpc,
      exportStorage,
      attachments: fagoo.attachments,
    });
    // Wabotia: em fatias, direto no R2.
    const ours = company(ids);
    const result = await runExportStreamed(env, profile, ours.task, "lease-1", {
      rpc: ours.rpc,
      exportStorage: null,
      attachments: ours.attachments,
    });
    const complete = ours.calls.at(-1)!;
    expect(complete.name).toBe("erp_platform_export_complete");
    const key = complete.args.p_object_key as string;
    expect(key).toBe(`exports/${ours.exportId}/${result.sha256}.zip`);
    const stored = await env.MEDIA.get(
      erpStorageKey(profile, "brufap-exports", key),
    );
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(await hex(bytes)).toBe(result.sha256);
    expect(bytes.length).toBe(complete.args.p_size_bytes);
    expect(stored!.httpMetadata?.contentType).toBe("application/zip");

    // Mesmas entradas, com os mesmos bytes (o manifesto, salvo a hora).
    const a = await unzip(fagooZip!);
    const b = await unzip(bytes);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [name, data] of a)
      if (name === "manifesto.json")
        expect(withoutTime(b.get(name)!)).toEqual(withoutTime(data));
      else expect(b.get(name), name).toEqual(data);
    // O nome do sistema no manifesto: o do Wabotia (o Fagoo diz Brufap).
    expect(systemName(b.get("manifesto.json")!)).toEqual({
      formato: "wabotia-exportacao-v1",
      empresa: "dados desta instalação do Wabotia",
    });
    expect(systemName(a.get("manifesto.json")!).formato).toBe(
      "brufap-exportacao-v1",
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(b.get("dados/erp_finance.title.json")!),
      ),
    ).toHaveLength(1203);

    // Mesmas RPCs, na mesma ordem; no complete, só a chave, o tamanho e o
    // SHA-256 mudam (o ZIP em fatias leva o descritor de dados).
    const strip = (calls: { name: string; args: any }[]) =>
      calls.map(({ name, args }) =>
        name === "erp_platform_export_complete"
          ? {
              name,
              args: {
                ...args,
                p_object_key: "*",
                p_size_bytes: "*",
                p_sha256: "*",
                p_manifest: {
                  ...args.p_manifest,
                  summary: { ...args.p_manifest.summary, bytes: "*" },
                },
              },
            }
          : { name, args },
      );
    expect(strip(ours.calls)).toEqual(strip(fagoo.calls));
    expect(result).toMatchObject({ rows: 1240, files: 1, files_skipped: 1 });
    // Nenhuma parte temporária sobrou.
    expect(
      (
        await env.MEDIA.list({
          prefix: erpStorageKey(profile, "brufap-exports", ".upload/"),
        })
      ).objects,
    ).toEqual([]);
  });

  it("o laço de tarefas usa a exportação em fatias e registra o fim", async () => {
    const profile = crypto.randomUUID();
    const c = company();
    let claimed = false;
    const rpc = async (name: string, args: any) => {
      if (name === "erp_platform_task_claim") {
        if (claimed) return { scope: "platform_task", task: null };
        claimed = true;
        return {
          scope: "platform_task",
          task: { ...c.task, purpose: "company_export" },
        };
      }
      return c.rpc(name, args);
    };
    const ran = await runErpPlatformTasks({
      env,
      profile,
      rpc,
      exportStorage: null,
      attachments: c.attachments,
    });
    expect(ran).toEqual([
      { id: c.task.id, purpose: "company_export", ok: true },
    ]);
    const finish = c.calls.find((x) => x.name === "erp_platform_task_finish");
    expect(finish?.args).toMatchObject({ p_task: c.task.id, p_ok: true });
    const key = c.calls.find((x) => x.name === "erp_platform_export_complete")!
      .args.p_object_key;
    expect(
      await env.MEDIA.head(erpStorageKey(profile, "brufap-exports", key)),
    ).not.toBeNull();
  });

  it("falha no meio: apaga as partes, registra o erro e não grava o pacote", async () => {
    const profile = crypto.randomUUID();
    const c = company();
    let claimed = false;
    const rpc = async (name: string, args: any) => {
      if (name === "erp_platform_task_claim") {
        if (claimed) return { scope: "platform_task", task: null };
        claimed = true;
        return {
          scope: "platform_task",
          task: { ...c.task, purpose: "company_export" },
        };
      }
      // Página inválida no segundo conjunto.
      if (
        name === "erp_platform_export_chunk" &&
        args.p_dataset === "erp_finance.title" &&
        args.p_offset === 500
      )
        return { dataset: "outro", offset: 500, rows: [], next_offset: null };
      return c.rpc(name, args);
    };
    const ran = await runErpPlatformTasks({
      env,
      profile,
      rpc,
      exportStorage: null,
      attachments: c.attachments,
    });
    expect(ran).toEqual([
      {
        id: c.task.id,
        purpose: "company_export",
        ok: false,
        code: "ERP_UPSTREAM_INVALID_RESPONSE",
      },
    ]);
    expect(
      (
        await env.MEDIA.list({
          prefix: erpStorageKey(profile, "brufap-exports", ""),
        })
      ).objects,
    ).toEqual([]);
  });
});

describe("laço das tarefas: a cópia (runErpPlatformTasks) e o do Fagoo", () => {
  it("mesma fila, mesma ordem de claim/finish, mesmos status e gravações; só a exportação muda", async () => {
    const ids = newIds();
    const tasks = [
      {
        id: crypto.randomUUID(),
        purpose: "notifications_generate",
        payload: {},
      },
      {
        id: ids.taskId,
        purpose: "company_export",
        payload: { export_id: ids.exportId },
      },
      // Falha: a lista de vencidas vem inválida.
      { id: crypto.randomUUID(), purpose: "export_cleanup", payload: {} },
      // Posse perdida (40001): outra rodada pegou; nada é registrado.
      {
        id: crypto.randomUUID(),
        purpose: "notifications_generate",
        payload: { lost: true },
      },
    ];
    /** Uma fila de tarefas de mentira, igual para os dois laços. */
    const queue = () => {
      const c = company(ids);
      const pending = [...tasks];
      const rpc = async (name: string, args: any) => {
        if (name === "erp_platform_schedule") {
          c.calls.push({ name, args });
          return { scheduled: 0 };
        }
        if (name === "erp_platform_task_claim") {
          c.calls.push({ name, args });
          return { scope: "platform_task", task: pending.shift() ?? null };
        }
        if (name === "erp_platform_notifications_run") {
          c.calls.push({ name, args });
          if (args.p_task === tasks[3].id)
            throw new PlatformError(409, "PG_40001");
          return {
            scope: "platform_notifications",
            day: "2026-11-17",
            created: 2,
            members: 3,
          };
        }
        if (name === "erp_platform_export_expired") {
          c.calls.push({ name, args });
          return { items: [{ id: "não é uuid" }] };
        }
        if (name === "erp_platform_task_finish") {
          c.calls.push({ name, args });
          return { ok: true };
        }
        return c.rpc(name, args);
      };
      let n = 0;
      const lease = () =>
        `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      return { c, rpc, lease };
    };
    const options = {
      schedule: true,
      budgetMs: 60_000,
      maxTasks: 10,
      now: () => 1_794_880_000_000,
    };

    const a = queue();
    const exportStorage = { put: async () => {}, remove: async () => {} };
    const fagooRan = await runPlatformTasks({
      ...options,
      rpc: a.rpc,
      lease: a.lease,
      exportStorage,
      attachments: a.c.attachments,
    });
    const b = queue();
    const oursRan = await runErpPlatformTasks({
      ...options,
      env,
      profile: crypto.randomUUID(),
      rpc: b.rpc,
      lease: b.lease,
      exportStorage,
      attachments: b.c.attachments,
    });

    expect(oursRan).toEqual(fagooRan);
    expect(oursRan.map((r: any) => [r.purpose, r.ok, r.code ?? null])).toEqual([
      ["notifications_generate", true, null],
      ["company_export", true, null],
      ["export_cleanup", false, expect.any(String)],
      ["notifications_generate", false, "PG_40001"],
    ]);
    // Mesmas chamadas, na mesma ordem e com os mesmos argumentos; na
    // exportação, só a chave, o tamanho e o SHA-256 do pacote mudam (e o
    // resultado gravado no task_finish, que os leva).
    const mask = (calls: { name: string; args: any }[]) =>
      calls.map(({ name, args }) => {
        if (name === "erp_platform_export_complete")
          return {
            name,
            args: {
              ...args,
              p_object_key: "*",
              p_size_bytes: "*",
              p_sha256: "*",
              p_manifest: {
                ...args.p_manifest,
                summary: { ...args.p_manifest.summary, bytes: "*" },
              },
            },
          };
        if (name === "erp_platform_task_finish" && args.p_result?.sha256)
          return {
            name,
            args: {
              ...args,
              p_result: { ...args.p_result, sha256: "*", size_bytes: "*" },
            },
          };
        return { name, args };
      });
    expect(mask(b.c.calls)).toEqual(mask(a.c.calls));
    // Nenhum task_finish para a posse perdida.
    expect(
      b.c.calls
        .filter((x) => x.name === "erp_platform_task_finish")
        .map((x) => x.args.p_task),
    ).toEqual([tasks[0].id, tasks[1].id, tasks[2].id]);
  });
});
