// Formato 2 do pacote: manifesto, blobs por conteúdo, índice v2 assinado
// (Ed25519) com prazo, etapas retomáveis do atualizador, lote grande de
// estáticos, blobs de 20 MB, falha entre migrate e publish, sonda do plano
// pago, ordem das versões, limpeza do R2 e as regras de publicação.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  assetsForHashes,
  digest,
  MAX_ASSETS,
  MAX_BLOB,
  MAX_MIGRATIONS,
  MAX_MODULES,
  MAX_UPLOAD_BATCH,
  nextRound,
  parseIndex,
  parseManifest,
  SIGNATURE_DOMAIN,
  validateIndexV2,
  verifySignature,
  versionAtLeast,
  versionGreater,
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
import { type Actor, type Env } from "../src/types";
import { buildInfo } from "../src/build-info.generated";
import {
  checkVersionOrder,
  excludedAsset,
  insideRepository,
  LAST_FORMAT1,
} from "../scripts/release-plan.mjs";
import {
  buildRelease,
  serveRelease,
  signFile,
  testKeys,
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
  it("valida o índice v2 e o prazo", async () => {
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
    // Prazo: obrigatório, depois da emissão, no máximo 180 dias.
    expect(() => validateIndexV2({ ...index, expires: undefined })).toThrow();
    expect(() =>
      validateIndexV2({ ...index, expires: index.issued_at }),
    ).toThrow();
    expect(() =>
      validateIndexV2({
        ...index,
        expires: index.issued_at + 181 * 86400000,
      }),
    ).toThrow();
    const at = index.issued_at;
    expect(() => validateIndexV2(index, index.expires + 1)).toThrow(/venceu/);
    expect(() => validateIndexV2(index, at - 2 * 86400000)).toThrow(
      /futuro/,
    );
    // Pacote de teste não vale no build oficial.
    expect(() =>
      validateIndexV2({ ...index, test_origin: "https://teste.example" }),
    ).toThrow(/pacote de teste/);
    expect(versionAtLeast("0.21.0", "0.21.0")).toBe(true);
    expect(versionAtLeast("0.20.9", "0.21.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.99.99")).toBe(true);
    expect(versionGreater("0.21.0", "0.21.0")).toBe(false);
    expect(versionGreater("0.21.1", "0.21.0")).toBe(true);
  });

  it("aplica os limites novos e mantém as travas de Durable Object e rotas", async () => {
    const check = async (patch: (s: ReleaseSpec) => void, error: RegExp) => {
      const s = baseSpec();
      patch(s);
      const r = await buildRelease(s);
      await expect(
        parseManifest(r.index, r.manifestBytes, r.manifestSignature),
      ).rejects.toThrow(error);
    };
    const keys = await testKeys();
    const r = await buildRelease(baseSpec());
    expect(
      (await parseManifest(r.index, r.manifestBytes, r.manifestSignature))
        .version,
    ).toBe("99.1.0");
    // Assinado, mas não é o manifesto que o índice fixa.
    const other = Buffer.from("x");
    await expect(
      parseManifest(
        r.index,
        other,
        await signFile("manifest", other, keys.principal),
      ),
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
    await expect(
      parseManifest(bad, bytes, t.manifestSignature),
    ).rejects.toThrow(/tamanho total/);
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
        await signFile("manifest", bigBytes, keys.principal),
      ),
    ).rejects.toThrow(/Arquivo inválido/);
  });

  it("regras de publicação: estáticos fora do pacote, ordem das versões, chave fora do repositório", () => {
    expect(excludedAsset("guide/wabotia-instalacao.pdf")).toBe(true);
    expect(excludedAsset("releases/blobs/x")).toBe(true);
    expect(excludedAsset("assets/app.js")).toBe(false);
    const frozen = { version: LAST_FORMAT1 };
    expect(LAST_FORMAT1).toBe("0.20.0");
    // A primeira de formato 2 passa da última do formato 1.
    expect(() =>
      checkVersionOrder({ version: "0.20.0", current: null, frozen, manifestSha: "a" }),
    ).toThrow(/maior que a 0\.20\.0/);
    checkVersionOrder({ version: "0.21.0", current: null, frozen, manifestSha: "a" });
    const current = { version: "0.21.0", manifest_sha256: "a" };
    expect(() =>
      checkVersionOrder({ version: "0.20.5", current, frozen, manifestSha: "b" }),
    ).toThrow(/menor que a publicada/);
    // Mesma versão: só com o mesmo manifesto (renovação).
    checkVersionOrder({ version: "0.21.0", current, frozen, manifestSha: "a" });
    expect(() =>
      checkVersionOrder({ version: "0.21.0", current, frozen, manifestSha: "b" }),
    ).toThrow(/versão nova/);
    checkVersionOrder({ version: "0.22.0", current, frozen, manifestSha: "b" });
    expect(insideRepository("/repo/chaves/x.pem", "/repo")).toBe(true);
    expect(insideRepository("/repo", "/repo")).toBe(true);
    expect(insideRepository("/fora/chaves/x.pem", "/repo")).toBe(false);
    expect(insideRepository("/repo-irmao/x.pem", "/repo")).toBe(false);
  });
});

describe("assinatura do índice e do manifesto", () => {
  it("aceita principal e reserva; recusa chave desconhecida, ausente, alterada e trocada de papel", async () => {
    const keys = await testKeys();
    const r = await buildRelease(baseSpec());
    expect(await verifySignature("index", r.indexBytes, r.indexSignature)).toBe(
      "principal",
    );
    const reserva = await buildRelease({ ...baseSpec(), signer: "reserva" });
    expect(
      await verifySignature("index", reserva.indexBytes, reserva.indexSignature),
    ).toBe("reserva");
    expect(
      (
        await parseManifest(
          reserva.index,
          reserva.manifestBytes,
          reserva.manifestSignature,
        )
      ).version,
    ).toBe("99.1.0");
    // Manifesto alterado em um byte.
    const altered = Buffer.from(r.manifestBytes);
    altered[altered.length - 2] ^= 1;
    await expect(
      parseManifest(r.index, altered, r.manifestSignature),
    ).rejects.toThrow(/conteúdo alterado/);
    // Chave fora da lista.
    const unknown = await buildRelease({ ...baseSpec(), signer: "unknown" });
    await expect(
      parseIndex(unknown.indexBytes, unknown.indexSignature),
    ).rejects.toThrow(/chave desconhecida/);
    // Chave fora da lista usando o nome de uma confiável.
    const forged = await signFile(
      "index",
      r.indexBytes,
      keys.unknown,
      "principal",
    );
    await expect(parseIndex(r.indexBytes, forged)).rejects.toThrow(
      /conteúdo alterado ou chave errada/,
    );
    // Sem assinatura, ou com um arquivo que não é assinatura.
    await expect(parseIndex(r.indexBytes, null)).rejects.toThrow(
      /sem assinatura/,
    );
    await expect(
      parseManifest(r.index, r.manifestBytes, null),
    ).rejects.toThrow(/sem assinatura/);
    await expect(
      parseIndex(r.indexBytes, Buffer.from("<html>")),
    ).rejects.toThrow(/arquivo de assinatura inválido/);
    // A assinatura do índice não vale como a do manifesto (e vice-versa).
    const asManifest = await signFile("index", r.manifestBytes, keys.principal);
    await expect(
      parseManifest(r.index, r.manifestBytes, asManifest),
    ).rejects.toThrow(/conteúdo alterado/);
    expect(SIGNATURE_DOMAIN.index).not.toBe(SIGNATURE_DOMAIN.manifest);
    // Índice assinado, mas vencido.
    const old = await buildRelease({
      ...baseSpec(),
      issued_at: Date.now() - 100 * 86400000,
      expires: Date.now() - 10 * 86400000,
    });
    await expect(
      parseIndex(old.indexBytes, old.indexSignature),
    ).rejects.toThrow(/venceu/);
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

describe("atualizador do formato 2", () => {
  let release: BuiltRelease,
    calls: { url: string; method: string; body: any }[],
    publishFails: false | "hard" = false,
    bucketsFor: (hashes: string[]) => string[][] = (h) => [h],
    override: (url: URL) => Response | null = () => null,
    crashUpload = 0;
  beforeEach(async () => {
    calls = [];
    publishFails = false;
    bucketsFor = (h) => [h];
    override = () => null;
    crashUpload = 0;
    await exec(env, "DELETE FROM secrets WHERE id LIKE 'system:release-%'");
    await exec(env, "DELETE FROM system_update_locks");
    await exec(env, "DROP TABLE IF EXISTS v2_probe");
    await exec(env, "DROP TABLE IF EXISTS d1_migrations");
    release = await buildRelease(baseSpec());
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      calls.push({ url: request.url, method: request.method, body: init.body });
      const replaced = override(url);
      if (replaced) return replaced;
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
        // Queda de rede no envio número `crashUpload`.
        if (sent.length === crashUpload) throw new TypeError("network lost");
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
    // A Cloudflare monta lotes que cabem num envio: aqui, um por arquivo.
    bucketsFor = (h) => h.map((x) => [x]);
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
    // Confere ~40 MB por SHA-256 várias vezes: lento com a suíte inteira.
  }, 60000);

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
  });

  it("limpeza: concluída antes de limpar, limpeza repetida se o R2 falhar, e restos de trabalhos antigos apagados no início", async () => {
    await env.MEDIA.put("system/releases/trabalho-antigo/b/x", "resto");
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    expect(
      (await env.MEDIA.list({ prefix: "system/releases/trabalho-antigo/" }))
        .objects,
    ).toHaveLength(0);
    await run(20);
    const job = await state();
    let broken = true;
    const media = new Proxy(env.MEDIA, {
      get(target: any, prop) {
        if (prop === "list" && broken)
          return async () => {
            throw new Error("R2 indisponível");
          };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const flaky = { ...e, MEDIA: media } as Env;
    await setSecret(e, "system:release-state", { ...job, target: buildInfo.commit });
    expect((await updateStatus(flaky)).state?.status).toBe("completed");
    expect(await state()).toMatchObject({ cleanup_pending: true });
    expect(
      (await env.MEDIA.list({ prefix: workPrefix(job.id) })).objects.length,
    ).toBeGreaterThan(0);
    broken = false;
    await updateStatus(flaky);
    expect(await state()).toMatchObject({
      status: "completed",
      cleanup_pending: false,
    });
    expect(
      (await env.MEDIA.list({ prefix: workPrefix(job.id) })).objects,
    ).toHaveLength(0);
  });

  it("sem assinatura, chave desconhecida ou índice vencido: nenhuma atualização começa", async () => {
    for (const spec of [
      { ...baseSpec(), signer: null },
      { ...baseSpec(), signer: "unknown" as const },
      {
        ...baseSpec(),
        issued_at: Date.now() - 100 * 86400000,
        expires: Date.now() - 86400000,
      },
    ]) {
      release = await buildRelease(spec);
      await expect(checkUpdate(e, true)).rejects.toThrow(
        /sem assinatura|chave desconhecida|venceu/,
      );
      await expect(
        startUpdate(e, actor, { commit: target }),
      ).rejects.toThrow();
      expect(await state()).toEqual({});
    }
  });

  it("reserva assina e a atualização vai até o fim", async () => {
    release = await buildRelease({ ...baseSpec(), signer: "reserva" });
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await run(20);
    expect((await state()).status).toBe("requested");
  });

  it("manifesto alterado em um byte: para na etapa manifest sem gravar nada", async () => {
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    const altered = Buffer.from(release.manifestBytes);
    altered[5] ^= 1;
    override = (url) =>
      url.pathname.endsWith("/manifest.json")
        ? new Response(altered, { headers: { "Content-Type": "application/json" } })
        : null;
    await run(3);
    const job = await state();
    expect(job).toMatchObject({ status: "failed", phase: "manifest" });
    expect(job.error).toMatch(/assinatura/);
    expect(
      (await env.MEDIA.list({ prefix: workPrefix(job.id) })).objects,
    ).toHaveLength(0);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it.each(["trocado", "corrompido"])(
    "blob %s: para na etapa blobs, sem migrar nem publicar",
    async (kind) => {
      const [first, second] = [...release.blobs.keys()];
      const bytes =
        kind === "trocado"
          ? release.blobs.get(second)!
          : (() => {
              const copy = new Uint8Array(release.blobs.get(first)!);
              copy[0] ^= 1;
              return copy;
            })();
      override = (url) =>
        url.pathname.endsWith("/blobs/" + first)
          ? new Response(bytes, {
              headers: { "Content-Type": "application/octet-stream" },
            })
          : null;
      await startUpdate(e, actor, {
        commit: (await checkUpdate(e, true)).commit,
      });
      await run(5);
      const job = await state();
      expect(job).toMatchObject({ status: "failed", phase: "blobs" });
      expect(job.error).toMatch(/corrompido/);
      expect(
        await one(env, "SELECT name FROM sqlite_master WHERE name='v2_probe'"),
      ).toBeNull();
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    },
  );

  it("segunda migração malformada: nenhuma é aplicada", async () => {
    const s = baseSpec();
    s.migrations.push({ name: "0002_quebrada.sql", statements: [] });
    release = await buildRelease(s);
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await run(10);
    const job = await state();
    expect(job).toMatchObject({ status: "failed", phase: "prepare" });
    expect(job.error).toMatch(/Migração inválida.*0002_quebrada/);
    expect(
      await one(env, "SELECT name FROM sqlite_master WHERE name='v2_probe'"),
    ).toBeNull();
    expect(
      await one(env, "SELECT name FROM sqlite_master WHERE name='d1_migrations'"),
    ).toBeNull();
    // Nem a sessão de envio de estáticos foi aberta.
    expect(
      calls.filter((c) => c.url.endsWith("/assets-upload-session")),
    ).toHaveLength(0);
  });

  it("queda no meio de assets: a nova tentativa abre outra sessão e conclui", async () => {
    const s = baseSpec();
    s.assets = Array.from({ length: 3 }, (_, i) => ({
      name: `/q/${i}.txt`,
      type: "text/plain",
      body: "arquivo " + i,
    }));
    release = await buildRelease(s);
    bucketsFor = (h) => [h.slice(0, 1), h.slice(1)];
    crashUpload = 1; // o segundo envio cai
    await startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit });
    await run(10);
    const failed = await state();
    expect(failed).toMatchObject({ status: "failed", phase: "assets" });
    expect(await all(env, "SELECT name FROM sqlite_master WHERE name='v2_probe'")).toHaveLength(0);
    // Mesma regra da nova tentativa automática: `assets` volta a `prepare`.
    crashUpload = 0;
    await setSecret(e, "system:release-state", {
      ...failed,
      status: "pending",
      phase: "prepare",
      error: null,
    });
    await run(10);
    expect((await state()).status).toBe("requested");
    expect(
      calls.filter((c) => c.url.endsWith("/assets-upload-session")),
    ).toHaveLength(2);
    const put = calls.find((c) => c.method === "PUT")!;
    const metadata = JSON.parse(
      await ((put.body as FormData).get("metadata") as Blob).text(),
    );
    expect(metadata.assets.jwt).toBe("completion");
  });

  it("ordem das versões: nunca volta nem troca o código da versão instalada", async () => {
    for (const version of ["0.0.1", buildInfo.version]) {
      release = await buildRelease({ ...baseSpec(), version });
      await expect(
        startUpdate(e, actor, { commit: (await checkUpdate(e, true)).commit }),
      ).rejects.toThrow(/não volta de versão/);
      expect(await state()).toEqual({});
    }
  });
});
