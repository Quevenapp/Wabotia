// Formato 2 do pacote: manifesto, blobs por conteúdo, índice v2 assinado
// (Ed25519) com prazo, etapas retomáveis do atualizador, lote grande de
// estáticos, blobs de 20 MB, falha entre migrate e publish, sonda do plano
// pago, ordem das versões, limpeza do R2 e as regras de publicação.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  assetsForHashes,
  assetUploadV2,
  CloudflareCallError,
  digest,
  MAX_ASSETS,
  MAX_BLOB,
  MAX_MIGRATIONS,
  MAX_MODULES,
  MAX_UPLOAD_BATCH,
  MAX_UPLOAD_BATCH_BYTES,
  nextRound,
  parseIndex,
  parseManifest,
  releaseCloudflare,
  scriptPath,
  OFFICIAL_RELEASE_ORIGIN,
  RELEASE_ORIGIN,
  SIGNATURE_DOMAIN,
  validateIndexV2,
  verifySignature,
  versionAtLeast,
  versionGreater,
} from "../src/release";
import {
  automaticUpdateTick,
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
  checkStaticAssetSize,
  MAX_STATIC_ASSET_BYTES,
  excludedAsset,
  insideRepository,
  LAST_FORMAT1,
  LEGACY_MAX_PACKAGE,
  legacyProblems,
  releaseOutputs,
  renewalNotice,
  slimAsset,
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
    expect(() => validateIndexV2(index, at - 2 * 86400000)).toThrow(/futuro/);
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
    // A 0.21.0 é a última publicada só no formato 1; a ponte vem depois dela.
    expect(LAST_FORMAT1).toBe("0.21.0");
    expect(() =>
      checkVersionOrder({
        version: "0.21.0",
        current: null,
        frozen,
        manifestSha: "a",
      }),
    ).toThrow(/maior que a 0\.21\.0/);
    checkVersionOrder({
      version: "0.21.1",
      current: null,
      frozen,
      manifestSha: "a",
    });
    const current = { version: "0.21.1", manifest_sha256: "a" };
    expect(() =>
      checkVersionOrder({
        version: "0.21.0",
        current,
        frozen,
        manifestSha: "b",
      }),
    ).toThrow(/maior que a 0\.21\.0/);
    expect(() =>
      checkVersionOrder({
        version: "0.21.1",
        current: { version: "0.22.0", manifest_sha256: "a" },
        frozen,
        manifestSha: "b",
      }),
    ).toThrow(/menor que a publicada/);
    // Mesma versão: só com o mesmo manifesto (renovação).
    checkVersionOrder({ version: "0.21.1", current, frozen, manifestSha: "a" });
    expect(() =>
      checkVersionOrder({
        version: "0.21.1",
        current,
        frozen,
        manifestSha: "b",
      }),
    ).toThrow(/versão nova/);
    checkVersionOrder({ version: "0.22.0", current, frozen, manifestSha: "b" });
    expect(insideRepository("/repo/chaves/x.pem", "/repo")).toBe(true);
    expect(insideRepository("/repo", "/repo")).toBe(true);
    expect(insideRepository("/fora/chaves/x.pem", "/repo")).toBe(false);
    expect(insideRepository("/repo-irmao/x.pem", "/repo")).toBe(false);
    // Lembrete de renovação: nada até 60 dias, aviso depois, e o vencido.
    const day = 86400000,
      issued = { version: "0.21.0", issued_at: 0, expires: 90 * day };
    expect(renewalNotice(null)).toBeNull();
    expect(renewalNotice(issued, 59 * day)).toBeNull();
    expect(renewalNotice(issued, 60 * day)).toMatch(/vence em 30 dia/);
    expect(renewalNotice(issued, 91 * day)).toMatch(/VENCEU/);
  });

  it("ponte: só uma, sem versão mínima; as seguintes exigem a ponte e nunca escrevem o formato 1", () => {
    // A primeira ponte.
    expect(
      releaseOutputs({ bridge: true, version: "0.21.1", bridgeRecord: null }),
    ).toEqual({ legacy: true, min_version: "0.0.0" });
    // Refazer a mesma ponte (mesma versão) ainda vale; outra ponte, não.
    const bridgeRecord = { version: "0.21.1", commit: "a".repeat(40) };
    releaseOutputs({ bridge: true, version: "0.21.1", bridgeRecord });
    expect(() =>
      releaseOutputs({ bridge: true, version: "0.22.0", bridgeRecord }),
    ).toThrow(/ponte já foi publicada \(0\.21\.1\)/);
    expect(() =>
      releaseOutputs({
        bridge: true,
        version: "0.21.1",
        bridgeRecord: null,
        minVersion: "0.21.0",
      }),
    ).toThrow(/não exige versão mínima/);
    // Sem ponte publicada, nenhuma versão só de formato 2.
    expect(() =>
      releaseOutputs({ bridge: false, version: "0.22.0", bridgeRecord: null }),
    ).toThrow(/Publique antes a versão ponte/);
    // Depois dela: formato 2 só, exigindo a ponte (ou mais) instalada.
    expect(
      releaseOutputs({ bridge: false, version: "0.22.0", bridgeRecord }),
    ).toEqual({ legacy: false, min_version: "0.21.1" });
    expect(
      releaseOutputs({
        bridge: false,
        version: "0.23.0",
        bridgeRecord,
        minVersion: "0.22.0",
      }).min_version,
    ).toBe("0.22.0");
    expect(() =>
      releaseOutputs({
        bridge: false,
        version: "0.22.0",
        bridgeRecord,
        minVersion: "0.21.0",
      }),
    ).toThrow(/menor que a ponte/);
  });

  it("ponte: o pacote de formato 1 respeita as travas do leitor da 0.21.0; a enxuta só tira as telas do ERP", () => {
    const file = (name: string) => ({
      name,
      type: "text/plain",
      data: "",
      sha256: "",
    });
    const good = () => ({
      main_module: "index.js",
      modules: [{ ...file("index.js"), type: "application/javascript+module" }],
      assets: [file("/index.html"), file("/assets/erp-fiscal-telas-x.js")],
      migrations: [{ name: "0001_core.sql", statements: ["SELECT 1"] }],
      durable_migrations: [{ tag: "v1", new_sqlite_classes: ["Coordinator"] }],
      assets_config: {
        not_found_handling: "single-page-application",
        run_worker_first: ["/api/*", "/webhooks/*", "/internal/*"],
      },
    });
    expect(legacyProblems(good(), 1000)).toEqual([]);
    expect(LEGACY_MAX_PACKAGE).toBe(24 * 1024 * 1024);
    expect(legacyProblems(good(), LEGACY_MAX_PACKAGE + 1).join()).toMatch(
      /acima de/,
    );
    const many = good();
    many.assets = Array.from({ length: 101 }, (_, i) => file(`/a${i}.js`));
    expect(legacyProblems(many, 1000).join()).toMatch(/101 estáticos/);
    const migration = good();
    migration.migrations = [
      { name: "0002_x.sql", statements: Array(101).fill("SELECT 1") },
    ];
    expect(legacyProblems(migration, 1000).join()).toMatch(/migração fora/);
    const durable = good();
    durable.durable_migrations = [
      { tag: "v2", new_sqlite_classes: ["Coordinator", "Outro"] },
    ];
    expect(legacyProblems(durable, 1000).join()).toMatch(/durable_migrations/);
    // Enxuta: só os chunks do ERP do painel; o resto do painel fica.
    expect(slimAsset("/assets/erp-fiscal-telas-BFmA_FTA.js")).toBe(true);
    expect(slimAsset("/assets/erp-estilos-CBGO-jh0.css")).toBe(true);
    expect(slimAsset("/assets/painel-DNr8UNmD.js")).toBe(false);
    expect(slimAsset("/index.html")).toBe(false);
    expect(slimAsset("/assets/sub/erp-x.js")).toBe(false);
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
      await verifySignature(
        "index",
        reserva.indexBytes,
        reserva.indexSignature,
      ),
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
    await expect(parseManifest(r.index, r.manifestBytes, null)).rejects.toThrow(
      /sem assinatura/,
    );
    await expect(
      parseIndex(r.indexBytes, Buffer.from("<html>")),
    ).rejects.toThrow(/arquivo de assinatura inválido/);
    // A assinatura do índice não vale como a do manifesto (e vice-versa).
    const asManifest = await signFile("index", r.manifestBytes, keys.principal);
    await expect(
      parseManifest(r.index, r.manifestBytes, asManifest),
    ).rejects.toThrow(/conteúdo alterado/);
    expect(SIGNATURE_DOMAIN.index).not.toBe(SIGNATURE_DOMAIN.manifest);
    // Build oficial: qualquer test_origin é recusado, mesmo assinado e mesmo
    // com o próprio endereço oficial (aqui RELEASE_ORIGIN é o oficial).
    expect(RELEASE_ORIGIN).toBe(OFFICIAL_RELEASE_ORIGIN);
    for (const origin of [
      OFFICIAL_RELEASE_ORIGIN,
      "https://teste.example/api/test-catalog",
    ]) {
      const testIndex = Buffer.from(
        JSON.stringify({ ...r.index, test_origin: origin }),
      );
      await expect(
        parseIndex(
          testIndex,
          await signFile("index", testIndex, keys.principal),
        ),
      ).rejects.toThrow(/pacote de teste/);
      const testManifest = Buffer.from(
        JSON.stringify({ ...r.manifest, test_origin: origin }),
      );
      await expect(
        parseManifest(
          {
            ...r.index,
            test_origin: origin,
            manifest_sha256: await digest(testManifest),
            manifest_size: testManifest.length,
          },
          testManifest,
          await signFile("manifest", testManifest, keys.principal),
        ),
      ).rejects.toThrow(/pacote de teste/);
    }
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
    expect(
      nextRound([{ size: 10e6 }, { size: 6e6 }, { size: 2e6 }], 0),
    ).toHaveLength(2);
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

  it("recusa lote acima de 32 MiB antes de ler qualquer blob e aceita o limite", async () => {
    const r = await buildRelease(baseSpec());
    const items = [0, 1].map((i) => ({
      hash: String(i),
      file: { ...r.manifest.assets[0], size: MAX_UPLOAD_BATCH_BYTES / 2 },
    }));
    const read = vi.fn(async () => new Uint8Array(0));
    items[1].file.size++;
    expect(MAX_UPLOAD_BATCH_BYTES).toBe(32 * 1024 * 1024);
    await expect(assetUploadV2(items, read)).rejects.toThrow(/excede 32 MiB/);
    expect(read).not.toHaveBeenCalled();
    items[1].file.size--;
    await expect(assetUploadV2(items, read)).resolves.toBeInstanceOf(FormData);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("publicador recusa estático acima de 24 MiB, dentro do orçamento do leitor", () => {
    // Um estático do tamanho máximo cabe sozinho num lote do atualizador.
    expect(MAX_STATIC_ASSET_BYTES).toBe(24 * 1024 * 1024);
    expect(MAX_STATIC_ASSET_BYTES).toBeLessThan(MAX_UPLOAD_BATCH_BYTES);
    expect(() =>
      checkStaticAssetSize("/grande.bin", MAX_STATIC_ASSET_BYTES),
    ).not.toThrow();
    expect(() =>
      checkStaticAssetSize("/grande.bin", MAX_STATIC_ASSET_BYTES + 1),
    ).toThrow(/estático.*24 MiB/);
  });
});

describe("atualizador do formato 2", () => {
  let release: BuiltRelease,
    calls: { url: string; method: string; body: any }[],
    publishFails: false | "hard" = false,
    bucketsFor: (hashes: string[]) => string[][] = (h) => [h],
    override: (url: URL) => Response | null | Promise<Response | null> = () =>
      null,
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
      const replaced = await override(url);
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
            {
              success: false,
              errors: [{ code: 10021, message: "Uncaught Error: no module" }],
            },
            { status: 400 },
          );
        return ok({ id: worker, etag: "etag" });
      }
      throw Error("Unexpected request " + request.url);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const run = async (times: number) => {
    for (let i = 0; i < times; i++) await processUpdate(e);
  };
  const state = () => secret(e, "system:release-state");

  const untilPhase = async (phase: string) => {
    for (let i = 0; i < 30 && (await state()).phase !== phase; i++)
      await processUpdate(e);
    expect(await state()).toMatchObject({ phase, status: "pending" });
  };

  it("três rodadas interrompidas sem catch deixam recibo e encerram pending", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    // Estado da ponte: nenhum dos campos novos existe ainda.
    expect((await state()).round_started_at).toBeUndefined();
    let checkpoint: any;
    override = async (url) => {
      if (url.pathname.endsWith("/manifest.json")) checkpoint = await state();
      return null;
    };
    for (let i = 1; i <= 3; i++) {
      await processUpdate(e);
      expect(checkpoint).toMatchObject({
        status: "pending",
        phase: "manifest",
        rounds_without_progress: i,
        round_started_at: expect.any(Number),
        last_progress_at: expect.any(Number),
      });
      // Simula morte da invocação: só sobrevive o recibo anterior ao trabalho,
      // sem as escritas finais nem as do catch.
      await setSecret(e, "system:release-state", checkpoint);
    }
    const before = calls.length;
    await processUpdate(e);
    expect(await state()).toMatchObject({
      status: "failed",
      retryable: false,
      error: expect.stringMatching(/três rodadas seguidas sem avanço/),
    });
    expect(calls).toHaveLength(before);
  });

  it("avanço dentro de blobs, assets e migrate zera as rodadas sem avanço", async () => {
    const spec = baseSpec();
    spec.assets = Array.from({ length: 85 }, (_, i) => ({
      name: `/p${i}.txt`,
      body: `p${i}`,
    }));
    spec.migrations = Array.from({ length: 5 }, (_, i) => ({
      name: `000${i}_progress.sql`,
      statements: ["SELECT 1"],
    }));
    release = await buildRelease(spec);
    bucketsFor = (h) =>
      Array.from({ length: 5 }, (_, i) => h.slice(i * 20, (i + 1) * 20));
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40 && (await state()).status === "pending"; i++) {
      const phase = (await state()).phase;
      counts[phase] = (counts[phase] || 0) + 1;
      await processUpdate(e);
      if ((await state()).status === "pending")
        expect((await state()).rounds_without_progress).toBe(0);
    }
    for (const phase of ["blobs", "assets", "migrate"])
      expect(counts[phase]).toBeGreaterThanOrEqual(5);
    expect((await state()).status).toBe("requested");
  });

  it("reset aceita pending parado por mais de 30 minutos, inclusive sem campos novos", async () => {
    const at = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(at);
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    const job = await state();
    const reset = () =>
      resetUpdate(e, actor, { confirmed_build_stopped: true });
    // O painel só mostra "Liberar nova tentativa" com review_required.
    const review = async () => (await updateStatus(e)).review_required;
    for (const progress of [at, at - 30 * 60000]) {
      await setSecret(e, "system:release-state", {
        ...job,
        created: at - 3600000,
        updated: at - 3600000,
        last_progress_at: progress,
      });
      expect(await review()).toBe(false);
      await expect(reset()).rejects.toThrow(/Confira/);
    }
    await setSecret(e, "system:release-state", {
      ...job,
      created: at - 3600000,
      updated: at,
      last_progress_at: at - 30 * 60000 - 1,
    });
    expect(await review()).toBe(true);
    await expect(reset()).resolves.toMatchObject({ status: "cancelled" });
    await setSecret(e, "system:release-state", {
      ...job,
      created: at - 3600000,
      updated: at - 3600000,
    });
    expect(await review()).toBe(true);
    await expect(reset()).resolves.toMatchObject({ status: "cancelled" });
  });

  it("consulta comum de status não pega a trava; só quando há o que gravar", async () => {
    const locks: string[] = [];
    const db = new Proxy(env.DB, {
      get(target: any, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            if (sql.includes("system_update_locks")) locks.push(sql);
            return target.prepare(sql);
          };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const watched = { ...e, DB: db } as Env;
    // Sem trabalho, com trabalho andando e com trabalho falho: só lê.
    await updateStatus(watched);
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await updateStatus(watched);
    await processUpdate(e);
    await updateStatus(watched);
    await setSecret(e, "system:release-state", {
      ...(await state()),
      status: "failed",
    });
    await updateStatus(watched);
    // Nenhuma escrita no D1 pela trava, e nada que dê 409 a um "Atualizar"
    // clicado no mesmo instante.
    expect(locks).toEqual([]);
    // A consulta que precisa concluir pega a trava.
    await setSecret(e, "system:release-state", {
      ...(await state()),
      target: buildInfo.commit,
      status: "requested",
    });
    expect((await updateStatus(watched)).state?.status).toBe("completed");
    expect(locks.length).toBeGreaterThan(0);
  });

  it("cache recente vencido é consultado de novo; início recusa índice fora do prazo", async () => {
    const at = Date.now();
    const expired = await buildRelease({
      ...baseSpec(),
      issued_at: at - 60000,
      expires: at - 1,
    });
    await setSecret(e, "system:release-latest", {
      ...expired.index,
      checked_at: at,
    });
    expect((await checkUpdate(e)).expires).toBe(release.index.expires);
    expect(calls.some((c) => c.url.endsWith("/v2/latest.json"))).toBe(true);
    release = expired;
    await setSecret(e, "system:release-latest", {
      ...expired.index,
      checked_at: at,
    });
    await expect(startUpdate(e, actor, { commit: target })).rejects.toThrow(
      /venceu/,
    );
    expect((await state()).id).toBeUndefined();
  });

  it("início valida também a data do índice em cache e trabalho iniciado continua após expires", async () => {
    const at = Date.now();
    await setSecret(e, "system:release-latest", {
      ...release.index,
      checked_at: at,
      issued_at: at + 2 * 86400000,
    });
    // A recusa do prazo chega ao painel com a mensagem, não como erro 500.
    await expect(
      startUpdate(e, actor, { commit: target }),
    ).rejects.toMatchObject({
      status: 502,
      code: "update_check_failed",
      message: expect.stringMatching(/futuro/),
    });
    release = await buildRelease({ ...baseSpec(), expires: at + 60000 });
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    vi.spyOn(Date, "now").mockReturnValue(at + 120000);
    await run(20);
    expect((await state()).status).toBe("requested");
  });

  it("automático repete publish antes de sending, sem reaplicar migrações", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await untilPhase("publish");
    await setSecret(e, "system:release-state", {
      ...(await state()),
      source: "automatic",
    });
    override = (url) =>
      url.pathname.endsWith("/settings")
        ? new Response("indisponível", { status: 503 })
        : null;
    await processUpdate(e);
    expect(await state()).toMatchObject({
      status: "failed",
      phase: "publish",
      retryable: true,
      retry_at: expect.any(Number),
    });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    override = () => null;
    const retryAt = (await state()).retry_at;
    vi.spyOn(Date, "now").mockReturnValue(retryAt);
    const hour = Number(
      new Intl.DateTimeFormat("en", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(retryAt),
    );
    await setSecret(e, "system:release-automatic-config", {
      enabled: true,
      hour,
      window_hours: 2,
    });
    const sessions = () =>
      calls.filter((c) => c.url.endsWith("/assets-upload-session")).length;
    const before = sessions();
    await automaticUpdateTick(e);
    // Volta a `prepare`: o token de conclusão (uma hora) pode ter vencido
    // se a nova tentativa ficou para a janela seguinte.
    expect(await state()).toMatchObject({
      status: "pending",
      phase: "prepare",
      attempt: 2,
    });
    await run(20);
    expect((await state()).status).toBe("requested");
    expect(sessions()).toBe(before + 1);
    expect(await all(e, "SELECT id FROM v2_probe")).toEqual([{ id: "one" }]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("automático não repete publish após o PUT ambíguo", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await untilPhase("publish");
    await setSecret(e, "system:release-state", {
      ...(await state()),
      source: "automatic",
    });
    override = (url) =>
      url.pathname.endsWith(`/scripts/${worker}`)
        ? new Response("indisponível", { status: 503 })
        : null;
    await processUpdate(e);
    expect(await state()).toMatchObject({
      status: "unknown",
      phase: "publish",
      retryable: false,
      retry_at: null,
    });
    await run(3);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it.each([401, 403])(
    "assets renova uma sessão vencida (%s) e envia só o que falta",
    async (status) => {
      const spec = baseSpec();
      spec.assets.push({ name: "/outro.txt", body: "outro" });
      release = await buildRelease(spec);
      bucketsFor = (h) => h.map((hash) => [hash]);
      await startUpdate(e, actor, {
        commit: (await checkUpdate(e, true)).commit,
      });
      await untilPhase("assets");
      await processUpdate(e); // primeiro lote aceito
      override = (url) =>
        url.pathname.endsWith("/assets/upload")
          ? new Response("sessão vencida", { status })
          : null;
      await processUpdate(e);
      expect(await state()).toMatchObject({
        status: "pending",
        phase: "prepare",
        upload_session_renewals: 1,
      });
      override = (url) =>
        url.pathname.endsWith("/assets-upload-session")
          ? ok({
              jwt: "renovada",
              buckets: [[release.manifest.assets[1].sha256.slice(0, 32)]],
            })
          : null;
      await run(15);
      expect((await state()).status).toBe("requested");
      expect(
        calls.filter((c) => c.url.endsWith("/assets-upload-session")),
      ).toHaveLength(2);
      const sent = calls.filter((c) => c.url.includes("/assets/upload"));
      expect([...(sent.at(-1)!.body as FormData).keys()]).toEqual([
        release.manifest.assets[1].sha256.slice(0, 32),
      ]);
    },
  );

  it("segunda recusa de sessão para sem laço nem nova tentativa automática", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await untilPhase("assets");
    await setSecret(e, "system:release-state", {
      ...(await state()),
      source: "automatic",
    });
    override = (url) =>
      url.pathname.endsWith("/assets/upload")
        ? new Response("negado", { status: 403 })
        : null;
    await run(10);
    expect(await state()).toMatchObject({
      status: "failed",
      phase: "assets",
      upload_session_renewals: 1,
      retryable: false,
    });
    expect(
      calls.filter((c) => c.url.endsWith("/assets-upload-session")),
    ).toHaveLength(2);
  });

  it("403 HTML da Cloudflare tem status e não permite repetição automática", async () => {
    override = (url) =>
      url.pathname.endsWith("/settings")
        ? new Response("<html>Forbidden</html>", { status: 403 })
        : null;
    await expect(
      releaseCloudflare("token", scriptPath(account, worker) + "/settings"),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Cloudflare HTTP 403"),
    });
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await setSecret(e, "system:release-state", {
      ...(await state()),
      source: "automatic",
      started_at: Date.now(),
    });
    await run(10);
    expect(await state()).toMatchObject({
      status: "failed",
      phase: "prepare",
      retryable: false,
      retry_at: null,
    });
  });

  it("assets falha pelo orçamento do lote antes de ler blobs ou enviar", async () => {
    // Metadados assinados grandes, sem alocar 50 MiB: a recusa precede a leitura.
    release = await buildRelease({
      ...baseSpec(),
      assets: [
        { name: "/a.bin", body: "a" },
        { name: "/b.bin", body: "b" },
      ],
    });
    for (const file of release.manifest.assets) file.size = MAX_BLOB;
    release.manifestBytes = Buffer.from(JSON.stringify(release.manifest));
    release.manifestSignature = await signFile(
      "manifest",
      release.manifestBytes,
      (await testKeys()).principal,
    );
    release.index.manifest_size = release.manifestBytes.length;
    release.index.manifest_sha256 = await digest(release.manifestBytes);
    release.index.total_size = [
      ...release.manifest.assets,
      ...release.manifest.modules,
      ...release.manifest.migrations,
    ].reduce((sum, file) => sum + file.size, 0);
    release.indexBytes = Buffer.from(JSON.stringify(release.index));
    release.indexSignature = await signFile(
      "index",
      release.indexBytes,
      (await testKeys()).principal,
    );
    const job = await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await processUpdate(e); // guarda o manifesto
    await setSecret(e, "system:release-state", {
      ...(await state()),
      phase: "assets",
      bucket: 0,
      upload: {
        jwt: "upload",
        buckets: [release.manifest.assets.map((f) => f.sha256.slice(0, 32))],
      },
    });
    const reads: string[] = [];
    const media = new Proxy(env.MEDIA, {
      get(target: any, prop) {
        if (prop === "get")
          return async (key: string) => {
            reads.push(key);
            return target.get(key);
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await processUpdate({ ...e, MEDIA: media } as Env);
    expect(await state()).toMatchObject({
      status: "failed",
      phase: "assets",
      error: expect.stringMatching(/excede 32 MiB/),
    });
    expect(reads).toEqual([
      workPrefix(job!.id) + "manifest.json",
      workPrefix(job!.id) + "manifest.sig",
    ]);
    expect(
      calls.filter(
        (c) => c.url.includes("/assets/upload") || c.method === "PUT",
      ),
    ).toHaveLength(0);
  });

  it("decisão usa o status de CloudflareCallError mesmo se o texto disser outro HTTP", async () => {
    override = (url) => {
      if (url.pathname.endsWith("/manifest.json"))
        throw new CloudflareCallError("Cloudflare HTTP 503", false, 403);
      return null;
    };
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await setSecret(e, "system:release-state", {
      ...(await state()),
      source: "automatic",
      started_at: Date.now(),
    });
    await processUpdate(e);
    expect(await state()).toMatchObject({ status: "failed", retryable: false });
  });

  it("passa pelas etapas na ordem e lê só o que cada rodada usa", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
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
    expect(calls.filter((c) => c.url.endsWith("manifest.json"))).toHaveLength(
      1,
    );
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
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
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
    // 300 blobs pela fila (15 rodadas de 20) e 40 rodadas do atualizador.
    // Medido sozinho no Linux de 12 núcleos (17/11): 1,95 a 2,04 s quente,
    // 4,0 s e 12,9 s nas duas primeiras rodadas a frio; 7 a 8 s no Windows
    // com duas suítes ao lado. Os 5 s padrão não cabem a frio nem sob carga.
  }, 30000);

  it("blobs sintéticos de 20 MB: um por rodada, conferidos, sem reler o pacote", async () => {
    const s = baseSpec();
    const big = (seed: number) => {
      const bytes = new Uint8Array(20 * 1000 * 1000);
      for (let i = 0; i < bytes.length; i += 4096)
        bytes[i] = (i / 4096 + seed) & 255;
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
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
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
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await run(20);
    const failed = await state();
    expect(failed).toMatchObject({ status: "failed", phase: "publish" });
    // O que a Cloudflare disse, e não um palpite sobre permissão do token.
    expect(failed.error).toBe(
      "Cloudflare HTTP 400 (código 10021: Uncaught Error: no module).",
    );
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

  // Cada cenário percorre o atualizador com D1/R2. Testes separados mantêm
  // os nove casos e as mesmas verificações sem somar tudo no timeout de 5 s.
  // Regra de antes da mensagem nova: 4xx (fora o 429) não tenta de novo;
  // 429, 5xx e resposta 200 sem sucesso tentam (trabalho automático).
  const cloudflareErrorCases: [number, any, boolean, RegExp][] = [
    [
      400,
      [{ code: 10021, message: "bad script" }],
      false,
      /^Cloudflare HTTP 400 \(código 10021: bad script\)\.$/,
    ],
    [
      401,
      [{ code: 10000, message: "Authentication error" }],
      false,
      /^Cloudflare HTTP 401 \(código 10000: Authentication error\)\. Confira a conta e a permissão Workers Scripts: Edit do token\.$/,
    ],
    [403, [], false, /^Cloudflare HTTP 403\. Confira a conta e a permissão/],
    [404, [{ code: 10007 }], false, /^Cloudflare HTTP 404 \(código 10007\)\.$/],
    [
      429,
      [{ code: 971, message: "Please wait" }],
      true,
      /^Cloudflare HTTP 429 \(código 971: Please wait\)\.$/,
    ],
    [
      500,
      [{ message: "Internal" }],
      true,
      /^Cloudflare HTTP 500 \(Internal\)\.$/,
    ],
    [503, undefined, true, /^Cloudflare HTTP 503\.$/],
    // A mensagem de fora citando "HTTP 403" não vira um 4xx para a regra.
    [
      502,
      [{ message: "upstream HTTP 403\nforbidden" }],
      true,
      /^Cloudflare HTTP 502 \(upstream http 403 forbidden\)\.$/,
    ],
    [
      200,
      [{ message: "HTTP 400 lá dentro" }],
      true,
      /^Cloudflare HTTP 200 \(http 400 lá dentro\)\.$/,
    ],
  ];
  it.each(cloudflareErrorCases)(
    "erro da Cloudflare HTTP %s: texto com errors[], e a decisão de tentar de novo não muda",
    async (status, errors, retryable, text) => {
      override = (url) =>
        url.pathname.endsWith("/assets-upload-session")
          ? Response.json({ success: false, errors }, { status })
          : null;
      await startUpdate(e, actor, {
        commit: (await checkUpdate(e, true)).commit,
      });
      await setSecret(e, "system:release-state", {
        ...(await state()),
        source: "automatic",
        started_at: Date.now(),
      });
      await run(20);
      const job = await state();
      expect([status, job.phase, job.status]).toEqual([
        status,
        "prepare",
        "failed",
      ]);
      expect([status, job.error]).toEqual([
        status,
        expect.stringMatching(text),
      ]);
      expect([status, job.retryable]).toEqual([status, retryable]);
    },
  );

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
                      throw new Error(
                        "Too many API requests by single worker invocation.",
                      );
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

  it("ACHADO 2: limpeza lenta de A não pode apagar o trabalho B criado no meio", async () => {
    // Regressão de achado2.patch; inclui o vencimento da trava durante o R2.
    await setSecret(e, "system:release-state", {
      id: "trabalho-a",
      index: { format: 2 },
      target: buildInfo.commit,
      version: "0.0.1",
      status: "completed",
      phase: "publish",
      created: Date.now() - 60000,
      updated: Date.now() - 60000,
      source: "manual",
      cleanup_pending: true,
    });
    let entered!: () => void, releaseCleanup!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (releaseCleanup = r));
    const media = new Proxy(env.MEDIA, {
      get(target: any, prop) {
        if (prop === "list")
          return async (...a: any[]) => {
            entered();
            await gate;
            return target.list(...a);
          };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const status = updateStatus({ ...e, MEDIA: media } as Env);
    await inside;
    let b: any;
    try {
      const commit = (await checkUpdate(e, true)).commit;
      // Enquanto a trava vale, B não começa e outra consulta só lê.
      await expect(startUpdate(e, actor, { commit })).rejects.toMatchObject({
        code: "update_busy",
      });
      expect((await updateStatus(e)).state?.id).toBe("trabalho-a");
      expect((await state()).cleanup_pending).toBe(true);
      // A chamada ao R2 demora mais que a concessão; B pode adquirir a trava.
      await exec(
        e,
        "UPDATE system_update_locks SET expires=0 WHERE name='release'",
      );
      b = await startUpdate(e, actor, { commit });
      expect(b.id).not.toBe("trabalho-a");
    } finally {
      releaseCleanup();
      await status;
    }
    expect((await state()).id).toBe(b.id);
    expect((await state()).status).toBe("pending");
  });

  it("consulta com trava ocupada não conclui nem limpa o trabalho", async () => {
    const job = {
      id: "ocupado",
      index: { format: 2 },
      target: buildInfo.commit,
      status: "requested",
      phase: "publish",
      cleanup_pending: true,
    };
    await setSecret(e, "system:release-state", job);
    await env.MEDIA.put(workPrefix(job.id) + "resto", "conteúdo");
    await exec(
      e,
      "INSERT INTO system_update_locks(name,owner,expires) VALUES('release','outro',?)",
      Date.now() + 180000,
    );
    expect((await updateStatus(e)).state?.status).toBe("requested");
    expect(await state()).toEqual(job);
    expect(await env.MEDIA.head(workPrefix(job.id) + "resto")).not.toBeNull();
  });

  it("concluída, os temporários do R2 são apagados", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
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
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
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
    await setSecret(e, "system:release-state", {
      ...job,
      target: buildInfo.commit,
    });
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

  // Herança do formato 1: o que o atualizador da 0.21.0 deixou guardado
  // quando a ponte começa a rodar.
  const format1Job = (patch: Record<string, unknown>) => ({
    id: "trabalho-formato-1",
    index: {
      format: 1,
      version: "0.21.1",
      commit: buildInfo.commit,
      package_sha256: "a".repeat(64),
      package_size: 23_670_000,
    },
    target: buildInfo.commit,
    version: "0.21.1",
    previous: "b".repeat(40),
    status: "requested",
    phase: "publish",
    created: Date.now() - 60000,
    updated: Date.now() - 30000,
    source: "manual",
    attempt: 1,
    package_key: "system/releases/trabalho-formato-1.json",
    ...patch,
  });

  it("herança do formato 1: o trabalho que publicou a ponte fecha e o pacote antigo sai do R2", async () => {
    await env.MEDIA.put("system/releases/trabalho-formato-1.json", "{}");
    await setSecret(e, "system:release-state", format1Job({}));
    const status = await updateStatus(e);
    expect(status.state).toMatchObject({
      id: "trabalho-formato-1",
      status: "completed",
    });
    expect(await state()).toMatchObject({
      format1_settled: true,
      cleanup_pending: false,
      retryable: false,
    });
    // Fora do prefixo system/releases/<id>/: antes ficava esquecido.
    expect(
      await env.MEDIA.get("system/releases/trabalho-formato-1.json"),
    ).toBeNull();
    // Uma vez só: a próxima consulta não regrava o estado.
    const settled = await state();
    await updateStatus(e);
    expect((await state()).updated).toBe(settled.updated);
  });

  it("herança do formato 1: o índice antigo em cache é ignorado e consultado de novo", async () => {
    await setSecret(e, "system:release-latest", {
      format: 1,
      version: "0.21.1",
      commit: "d".repeat(40),
      package_sha256: "a".repeat(64),
      package_size: 23_670_000,
      checked_at: Date.now(),
    });
    // O painel não oferece o que este atualizador não instala.
    const status = await updateStatus(e);
    expect(status.latest).toBeNull();
    expect(status.available).toBe(false);
    // Sem força, o cache do formato 1 não vale: lê o índice v2.
    const fetched = calls.length;
    const index = await checkUpdate(e);
    expect(index).toMatchObject({ format: 2, commit: target });
    expect(
      calls.slice(fetched).some((c) => c.url.endsWith("/v2/latest.json")),
    ).toBe(true);
    // E o do formato 2 vale como cache, como antes.
    const again = calls.length;
    await checkUpdate(e);
    expect(calls.length).toBe(again);
  });

  it("herança do formato 1: um trabalho antigo ainda ativo para, sem nova tentativa, e a atualização recomeça no formato 2", async () => {
    await env.MEDIA.put("system/releases/trabalho-formato-1.json", "{}");
    await setSecret(
      e,
      "system:release-state",
      format1Job({
        target: "d".repeat(40),
        status: "pending",
        phase: "download",
        source: "automatic",
        retryable: true,
      }),
    );
    const fetched = calls.length;
    await processUpdate(e);
    // Nada baixado do catálogo: o formato 2 não continua o trabalho antigo.
    expect(calls.length).toBe(fetched);
    expect(await state()).toMatchObject({
      status: "failed",
      retryable: false,
      retry_at: null,
      format1_settled: true,
      error: expect.stringMatching(/formato antigo/),
    });
    // Liberar e atualizar de novo: o pacote antigo sai e o formato 2 vai até o fim.
    await resetUpdate(e, actor, { confirmed_build_stopped: true });
    expect(
      await env.MEDIA.get("system/releases/trabalho-formato-1.json"),
    ).toBeNull();
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    expect(await state()).toMatchObject({
      status: "pending",
      phase: "manifest",
    });
    await run(20);
    expect((await state()).status).toBe("requested");
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
      await expect(startUpdate(e, actor, { commit: target })).rejects.toThrow();
      expect(await state()).toEqual({});
    }
  });

  it("reserva assina e a atualização vai até o fim", async () => {
    release = await buildRelease({ ...baseSpec(), signer: "reserva" });
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await run(20);
    expect((await state()).status).toBe("requested");
  });

  it("manifesto alterado em um byte: para na etapa manifest sem gravar nada", async () => {
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    const altered = Buffer.from(release.manifestBytes);
    altered[5] ^= 1;
    override = (url) =>
      url.pathname.endsWith("/manifest.json")
        ? new Response(altered, {
            headers: { "Content-Type": "application/json" },
          })
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
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await run(10);
    const job = await state();
    expect(job).toMatchObject({ status: "failed", phase: "prepare" });
    expect(job.error).toMatch(/Migração inválida.*0002_quebrada/);
    expect(
      await one(env, "SELECT name FROM sqlite_master WHERE name='v2_probe'"),
    ).toBeNull();
    expect(
      await one(
        env,
        "SELECT name FROM sqlite_master WHERE name='d1_migrations'",
      ),
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
    await startUpdate(e, actor, {
      commit: (await checkUpdate(e, true)).commit,
    });
    await run(10);
    const failed = await state();
    expect(failed).toMatchObject({ status: "failed", phase: "assets" });
    expect(
      await all(env, "SELECT name FROM sqlite_master WHERE name='v2_probe'"),
    ).toHaveLength(0);
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
