// Formato 2 do pacote (versão ponte): manifesto, blobs por conteúdo, índice
// v2, etapas retomáveis do atualizador, lote grande de estáticos, blobs de
// 20 MB, falha entre migrate e publish, sonda do plano pago e o degrau fixo
// (instalação no formato 1 nunca enxerga o índice v2).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  assetsForHashes,
  digest,
  latestRelease,
  MAX_ASSETS,
  MAX_BLOB,
  MAX_MIGRATIONS,
  MAX_MODULES,
  MAX_UPLOAD_BATCH,
  nextRound,
  parseManifest,
  RELEASE_ORIGIN,
  validateIndex,
  validateIndexV2,
  versionAtLeast,
} from "../src/release";
import {
  checkUpdate,
  paidPlanProbe,
  processUpdate,
  resetUpdate,
  startUpdate,
  updateStatus,
  workPrefix,
} from "../src/updates";
import { secret, setSecret } from "../src/security";
import { all, exec, one } from "../src/db";
import { type Actor, type Env, now } from "../src/types";
import { buildInfo } from "../src/build-info.generated";
import {
  excludedAsset,
  releaseOutputs,
} from "../scripts/release-plan.mjs";
import {
  buildRelease,
  serveRelease,
  type BuiltRelease,
  type ReleaseSpec,
} from "./release-v2-fixture";

const account = "c".repeat(32),
  worker = "release-v2-test",
  identity = "release-v2-identity",
  target = "f".repeat(40);
const e: Env = {
  ...env,
  WABOTIA_ACCOUNT_ID: account,
  WABOTIA_WORKER_NAME: worker,
  WABOTIA_INSTALLATION_ID: identity,
  WABOTIA_UPDATE_TOKEN: "release-v2-private-token",
};
const actor: Actor = {
  id: "release-v2-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 60,
  runLimit: 3,
};
const settings = {
  bindings: [
    { name: "WABOTIA_INSTALLATION_ID", type: "plain_text", text: identity },
    { name: "MASTER_KEY", type: "secret_text" },
    { name: "DB", type: "d1", id: "db" },
    { name: "MEDIA", type: "r2_bucket", bucket_name: "media" },
    {
      name: "COORDINATOR",
      type: "durable_object_namespace",
      class_name: "Coordinator",
    },
    { name: "ASSETS", type: "assets" },
  ],
};
const ok = (result: any) => Response.json({ success: true, result });

function baseSpec(): ReleaseSpec {
  return {
    version: "99.1.0",
    commit: target,
    modules: [{ name: "index.js", body: "export default {}" }],
    assets: [{ name: "/index.html", body: "<html></html>" }],
    migrations: [
      {
        name: "0001_v2_probe.sql",
        statements: [
          "CREATE TABLE v2_probe(id TEXT PRIMARY KEY)",
          "INSERT INTO v2_probe VALUES('one')",
        ],
      },
    ],
  };
}

describe("formato 2: índice e manifesto", () => {
  it("valida o índice v2 e recusa o formato 1 nele (e vice-versa)", async () => {
    const { index } = await buildRelease(baseSpec());
    expect(validateIndexV2(index).requires).toEqual({
      min_version: "0.0.1",
      workers_paid: false,
    });
    expect(() => validateIndexV2({ ...index, format: 1 })).toThrow();
    expect(() => validateIndexV2({ ...index, manifest_size: 3e6 })).toThrow();
    expect(() => validateIndexV2({ ...index, total_size: 200e6 })).toThrow();
    expect(() =>
      validateIndexV2({ ...index, requires: { min_version: "x" } }),
    ).toThrow();
    // Uma instalação no formato 1 recusa o índice novo.
    expect(() => validateIndex(index)).toThrow(/pacote de publicação válido/);
    expect(versionAtLeast("0.21.0", "0.21.0")).toBe(true);
    expect(versionAtLeast("0.20.9", "0.21.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.99.99")).toBe(true);
  });

  it("aplica os limites novos e mantém as travas de Durable Object e rotas", async () => {
    const check = async (patch: (s: ReleaseSpec) => void, error: RegExp) => {
      const s = baseSpec();
      patch(s);
      const r = await buildRelease(s);
      await expect(parseManifest(r.index, r.manifestBytes)).rejects.toThrow(
        error,
      );
    };
    const r = await buildRelease(baseSpec());
    expect((await parseManifest(r.index, r.manifestBytes)).version).toBe(
      "99.1.0",
    );
    await expect(
      parseManifest(r.index, Buffer.from("x")),
    ).rejects.toThrow(/integridade/);
    await check((s) => {
      s.modules.push(
        ...Array.from({ length: MAX_MODULES }, (_, i) => ({
          name: `m${i}.js`,
          body: "m" + i,
        })),
      );
    }, /Estrutura/);
    await check((s) => {
      s.assets = Array.from({ length: MAX_ASSETS + 1 }, (_, i) => ({
        name: `/a${i}.txt`,
        body: "a" + i,
      }));
    }, /Estrutura/);
    await check((s) => {
      s.migrations = Array.from({ length: MAX_MIGRATIONS + 1 }, (_, i) => ({
        name: `${String(i).padStart(4, "0")}_m.sql`,
        statements: ["SELECT 1"],
      }));
    }, /Estrutura/);
    await check((s) => {
      s.assets[0].name = "/../segredo";
    }, /Arquivo inválido/);
    await check((s) => {
      s.migrations.unshift({ name: "0009_late.sql", statements: ["SELECT 1"] });
    }, /fora de ordem/);
    await check((s) => {
      s.durable_migrations = [
        { tag: "v1", new_sqlite_classes: ["Coordinator"] },
        { tag: "v2", new_sqlite_classes: ["Outra"] },
      ];
    }, /Durable Objects/);
    await check((s) => {
      s.assets_config = {
        not_found_handling: "single-page-application",
        run_worker_first: ["/*"],
      };
    }, /Configuração de arquivos/);
    // total_size do índice precisa bater com os arquivos únicos.
    const t = await buildRelease(baseSpec());
    const bad = { ...t.index, total_size: t.index.total_size + 1 };
    const bytes = Buffer.from(JSON.stringify(t.manifest));
    bad.manifest_sha256 = await digest(bytes);
    await expect(parseManifest(bad, bytes)).rejects.toThrow(/tamanho total/);
    // Arquivo acima de 25 MiB não entra no manifesto.
    const big = JSON.parse(JSON.stringify(t.manifest));
    big.assets[0].size = MAX_BLOB + 1;
    const bigBytes = Buffer.from(JSON.stringify(big));
    await expect(
      parseManifest(
        {
          ...t.index,
          manifest_sha256: await digest(bigBytes),
          manifest_size: bigBytes.length,
        },
        bigBytes,
      ),
    ).rejects.toThrow(/Arquivo inválido/);
  });

  it("rodadas de até 20 arquivos ou 16 MiB, sempre com ao menos um", () => {
    const small = Array.from({ length: 45 }, () => ({ size: 1000 }));
    expect(nextRound(small, 0)).toHaveLength(20);
    expect(nextRound(small, 40)).toHaveLength(5);
    const large = [{ size: 20e6 }, { size: 20e6 }, { size: 1 }];
    expect(nextRound(large, 0)).toHaveLength(1);
    expect(nextRound(large, 1)).toHaveLength(1);
    expect(nextRound([{ size: 10e6 }, { size: 6e6 }, { size: 2e6 }], 0)).toHaveLength(2);
  });

  it("lote de envio de estáticos aceita 250 e até 2.000 hashes", async () => {
    const s = baseSpec();
    s.assets = Array.from({ length: 2001 }, (_, i) => ({
      name: `/a/${i}.txt`,
      body: "arquivo " + i,
    }));
    const r = await buildRelease(s);
    const hashes = r.manifest.assets.map((a) => a.sha256.slice(0, 32));
    expect(assetsForHashes(r.manifest, hashes.slice(0, 250))).toHaveLength(250);
    expect(
      assetsForHashes(r.manifest, hashes.slice(0, MAX_UPLOAD_BATCH)),
    ).toHaveLength(MAX_UPLOAD_BATCH);
    expect(() => assetsForHashes(r.manifest, hashes)).toThrow(/Lote/);
    expect(() => assetsForHashes(r.manifest, ["0".repeat(32)])).toThrow(
      /fora da versão/,
    );
  });
});

describe("degrau fixo: formato 1 nunca enxerga o índice v2", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("o leitor do formato 1 só pede releases/latest.json e recusa o índice v2", async () => {
    const r = await buildRelease(baseSpec());
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: any) => {
      urls.push(String(input instanceof Request ? input.url : input));
      // Mesmo se a origem respondesse o índice novo, o formato 1 recusa.
      return Response.json(r.index);
    });
    await expect(latestRelease()).rejects.toThrow(/pacote de publicação/);
    expect(urls).toEqual([RELEASE_ORIGIN + "/releases/latest.json"]);
  });

  it("depois da ponte, a publicação só grava o índice v2", () => {
    expect(() =>
      releaseOutputs({ bridge: false, version: "0.22.0", existingBridge: null }),
    ).toThrow(/ponte/);
    expect(
      releaseOutputs({ bridge: true, version: "0.21.0", existingBridge: null }),
    ).toMatchObject({
      legacy: true,
      min_version: "0.21.0",
      files: expect.arrayContaining(["releases/latest.json"]),
    });
    const after = releaseOutputs({
      bridge: false,
      version: "0.22.0",
      existingBridge: { version: "0.21.0" },
    });
    expect(after).toEqual({
      legacy: false,
      files: ["releases/v2/latest.json"],
      min_version: "0.21.0",
    });
    expect(() =>
      releaseOutputs({
        bridge: true,
        version: "0.22.0",
        existingBridge: { version: "0.21.0" },
      }),
    ).toThrow(/já foi publicada/);
    expect(excludedAsset("guide/wabotia-instalacao.pdf")).toBe(true);
    expect(excludedAsset("releases/blobs/x")).toBe(true);
    expect(excludedAsset("assets/app.js")).toBe(false);
  });
});

describe("atualizador do formato 2", () => {
  let release: BuiltRelease,
    calls: { url: string; method: string; body: any }[],
    publishFails: false | "hard" = false,
    bucketsFor: (hashes: string[]) => string[][] = (h) => [h];
  beforeEach(async () => {
    calls = [];
    publishFails = false;
    bucketsFor = (h) => [h];
    await exec(env, "DELETE FROM secrets WHERE id LIKE 'system:release-%'");
    await exec(env, "DELETE FROM system_update_locks");
    await exec(env, "DROP TABLE IF EXISTS v2_probe");
    await exec(env, "DROP TABLE IF EXISTS d1_migrations");
    release = await buildRelease(baseSpec());
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      calls.push({ url: request.url, method: request.method, body: init.body });
      const served = serveRelease(url, release);
      if (served) return served;
      if (url.pathname.includes("/workers/services/"))
        return ok({ default_environment: { script: { migration_tag: "v1" } } });
      if (url.pathname.endsWith("/settings")) return ok(settings);
      if (url.pathname.endsWith("/assets-upload-session")) {
        const manifest = JSON.parse(init.body).manifest;
        const hashes = Object.values(manifest).map((m: any) => m.hash);
        return ok({ jwt: "upload", buckets: bucketsFor(hashes) });
      }
      if (url.pathname.endsWith("/assets/upload")) {
        const sent = calls.filter((c) => c.url.includes("/assets/upload"));
        const total = bucketsFor(
          release.manifest.assets.map((a) => a.sha256.slice(0, 32)),
        ).flat().length;
        const uploaded = sent.reduce(
          (n, c) => n + [...(c.body as FormData).keys()].length,
          0,
        );
        return ok(uploaded >= total ? { jwt: "completion" } : {});
      }
      if (request.method === "PUT") {
        if (publishFails === "hard")
          return Response.json(
            { success: false, errors: [{ message: "bad" }] },
            { status: 400 },
          );
        return ok({ id: worker, etag: "etag" });
      }
      throw Error("Unexpected request " + request.url);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = async (times: number) => {
    for (let i = 0; i < times; i++) await processUpdate(e);
  };
  const state = () => secret(e, "system:release-state");

  it("passa pelas etapas na ordem e lê só o que cada rodada usa", async () => {
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    const phases: string[] = [];
    for (let i = 0; i < 10; i++) {
      const before = (await state()).phase;
      if (phases.at(-1) !== before) phases.push(before);
      await processUpdate(e);
      if ((await state()).status !== "pending") break;
    }
    expect(phases).toEqual([
      "manifest",
      "blobs",
      "prepare",
      "assets",
      "migrate",
      "publish",
    ]);
    expect((await state()).status).toBe("requested");
    expect((await one(env, "SELECT id FROM v2_probe")).id).toBe("one");
    // Cada blob foi baixado uma vez; o manifesto, uma vez.
    const fetched = calls.filter((c) => c.url.includes("/releases/blobs/"));
    expect(fetched).toHaveLength(release.blobs.size);
    expect(calls.filter((c) => c.url.endsWith("manifest.json"))).toHaveLength(1);
  });

  it("exige a versão mínima instalada", async () => {
    const s = baseSpec();
    s.requires = { min_version: "999.0.0", workers_paid: false };
    release = await buildRelease(s);
    await expect(
      startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit }),
    ).rejects.toThrow(/exige a 999\.0\.0/);
  });

  it("lote da Cloudflare com 250 hashes (300 estáticos) sai inteiro e confirma no fim", async () => {
    const s = baseSpec();
    s.assets = Array.from({ length: 300 }, (_, i) => ({
      name: `/e/${i}.js`,
      type: "application/javascript",
      body: `console.log(${i})`,
    }));
    release = await buildRelease(s);
    bucketsFor = (h) => [h.slice(0, 250), h.slice(250)];
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await run(40);
    expect((await state()).status).toBe("requested");
    const uploads = calls.filter((c) => c.url.includes("/assets/upload"));
    expect(uploads).toHaveLength(2);
    expect([...(uploads[0].body as FormData).keys()]).toHaveLength(250);
    expect([...(uploads[1].body as FormData).keys()]).toHaveLength(50);
    const put = calls.find((c) => c.method === "PUT")!;
    const metadata = JSON.parse(
      await ((put.body as FormData).get("metadata") as Blob).text(),
    );
    expect(metadata.assets.jwt).toBe("completion");
  });

  it("blobs sintéticos de 20 MB: um por rodada, conferidos, sem reler o pacote", async () => {
    const s = baseSpec();
    const big = (seed: number) => {
      const bytes = new Uint8Array(20 * 1000 * 1000);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096 + seed) & 255;
      return bytes;
    };
    s.assets = [
      { name: "/a.bin", type: "application/octet-stream", body: big(1) },
      { name: "/b.bin", type: "application/octet-stream", body: big(2) },
      { name: "/index.html", body: "<html></html>" },
    ];
    release = await buildRelease(s);
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await processUpdate(e); // manifest
    const job = await state();
    expect(job.phase).toBe("blobs");
    const rounds: number[] = [];
    while ((await state()).phase === "blobs") {
      const before = calls.length;
      await processUpdate(e);
      rounds.push(
        calls.slice(before).filter((c) => c.url.includes("/releases/blobs/"))
          .length,
      );
    }
    // Ordem: módulo e migração (pequenos), depois os dois de 20 MB, um por
    // rodada (passam de 16 MiB juntos), e o resto.
    expect(rounds.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...rounds)).toBeLessThanOrEqual(20);
    for (const [sha, bytes] of release.blobs) {
      const stored = await env.MEDIA.head(`${workPrefix(job.id)}b/${sha}`);
      expect(stored?.size).toBe(bytes.length);
    }
    // Retomada: voltando a etapa, só o blob que sumiu do R2 é baixado de novo.
    const [lost] = [...release.blobs.keys()];
    await env.MEDIA.delete(`${workPrefix(job.id)}b/${lost}`);
    await setSecret(e, "system:release-state", {
      ...(await state()),
      phase: "blobs",
      blob: 0,
    });
    const before = calls.length;
    while ((await state()).phase === "blobs") await processUpdate(e);
    expect(
      calls.slice(before).filter((c) => c.url.includes("/releases/blobs/")),
    ).toHaveLength(1);
    await run(30);
    expect((await state()).status).toBe("requested");
  });

  it("falha entre migrate e publish: banco migrado, nova tentativa não reaplica", async () => {
    publishFails = "hard";
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await run(20);
    const failed = await state();
    expect(failed).toMatchObject({ status: "failed", phase: "publish" });
    expect(await all(env, "SELECT name FROM d1_migrations")).toHaveLength(1);
    // A equipe libera a nova tentativa: os temporários somem e tudo recomeça,
    // mas a migração aplicada fica registrada e não roda de novo.
    expect(
      (await resetUpdate(e, actor, { confirmed_build_stopped: true }))?.status,
    ).toBe("cancelled");
    expect(
      (await env.MEDIA.list({ prefix: workPrefix(failed.id) })).objects,
    ).toHaveLength(0);
    publishFails = false;
    await startUpdate(e, actor, { commit: target });
    await run(20);
    expect((await state()).status).toBe("requested");
    expect(await all(env, "SELECT name FROM d1_migrations")).toHaveLength(1);
    expect((await one(env, "SELECT count(*) n FROM v2_probe")).n).toBe(1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("sonda do plano pago antes de migrar: no gratuito para sem tocar no banco", async () => {
    const s = baseSpec();
    s.requires = { min_version: "0.0.1", workers_paid: true };
    release = await buildRelease(s);
    // D1 do plano gratuito simulado: a 51ª consulta da invocação falha.
    let queries = 0;
    const db = new Proxy(env.DB, {
      get(target: any, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(s: any, p) {
                if (p === "first" && /^SELECT 1$/.test(sql))
                  return (...a: any[]) => {
                    if (++queries > 50)
                      throw new Error("Too many API requests by single worker invocation.");
                    return s.first(...a);
                  };
                const v = s[p];
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const free = { ...e, DB: db } as Env;
    await expect(paidPlanProbe(free)).rejects.toMatchObject({
      code: "workers_paid_required",
    });
    queries = 0;
    await startUpdate(free, actor, {
      commit: (await checkUpdate(free, true)).commit,
    });
    for (let i = 0; i < 20; i++) {
      queries = 0;
      await processUpdate(free);
    }
    expect(await state()).toMatchObject({ status: "failed", phase: "migrate" });
    expect((await state()).error).toMatch(/Workers Paid/);
    expect(
      await one(env, "SELECT name FROM sqlite_master WHERE name='v2_probe'"),
    ).toBeNull();
    // No pago (sem limite), a sonda passa.
    await expect(paidPlanProbe(e)).resolves.toBeUndefined();
  });

  it("concluída, os temporários do R2 são apagados", async () => {
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await run(20);
    const job = await state();
    expect(
      (await env.MEDIA.list({ prefix: workPrefix(job.id) })).objects.length,
    ).toBeGreaterThan(0);
    await setSecret(e, "system:release-state", {
      ...job,
      target: buildInfo.commit,
    });
    expect((await updateStatus(e)).state?.status).toBe("completed");
    expect(
      (await env.MEDIA.list({ prefix: workPrefix(job.id) })).objects,
    ).toHaveLength(0);
    void now;
  });
});
