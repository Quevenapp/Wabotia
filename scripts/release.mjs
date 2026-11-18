#!/usr/bin/env node
// Publicação de uma versão no formato 2, assinada (docs/ATUALIZACOES.md,
// "Publicar uma versão", e docs/ATUALIZACOES-FORMATO.md).
//
//   npm run release                         versão oficial, assinada
//   npm run release -- --renew              renova o prazo do índice publicado
//   npm run release -- --candidate          candidato SEM assinatura (recusado
//                                           pelas instalações)
//   npm run release -- --test-origin <url>  build de teste: catálogo e Worker
//                                           apontam para <url>; não publicar
//   --workers-paid, --min-version x.y.z     condições do índice
//   --bridge [--slim]                       a versão ponte: também o pacote de
//                                           formato 1 que a 0.21.0 lê (--slim:
//                                           sem as telas do ERP nesse pacote)
//
// A chave privada vem de WABOTIA_RELEASE_KEY (caminho do .pem) ou de
// release-signing.local.json ({"key": "<caminho>"}), sempre fora do
// repositório. Sem chave não sai versão oficial. A chave nunca é impressa,
// registrada em log, copiada nem passada a subprocessos.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
} from "node:fs";
import { join, extname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { parse } from "jsonc-parser";
import { unstable_splitSqlQuery } from "wrangler";
import {
  checkVersionOrder,
  excludedAsset,
  insideRepository,
  LAST_FORMAT1,
  legacyProblems,
  releaseOutputs,
  renewalNotice,
  slimAsset,
} from "./release-plan.mjs";
import { signatureFile, signerFor, withValidity } from "./release-sign.mjs";

const OFFICIAL_ORIGIN = "https://wabotia.queven.app";
const TEST_CONSTANT = "__WABOTIA_TEST_RELEASE_ORIGIN__";
const TEST_KEYS_CONSTANT = "__WABOTIA_TEST_RELEASE_KEYS__";
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw Error(`Informe o valor de ${name}.`);
  return value;
};
const candidate = args.includes("--candidate");
const renew = args.includes("--renew");
const testInstallation = option("--test-origin");
const minVersion = option("--min-version");
const bridge = args.includes("--bridge");
const slim = args.includes("--slim");
if ([candidate, renew, !!testInstallation].filter(Boolean).length > 1)
  throw Error("Use só uma de --candidate, --renew e --test-origin.");
if (minVersion && !/^\d+\.\d+\.\d+$/.test(minVersion))
  throw Error("--min-version inválida.");
if (slim && !bridge) throw Error("--slim só vale com --bridge.");
if (renew && bridge) throw Error("--renew não publica a ponte.");
let testOrigin;
if (testInstallation) {
  const url = new URL(testInstallation);
  if (
    url.protocol !== "https:" ||
    url.origin !== testInstallation ||
    url.origin === OFFICIAL_ORIGIN
  )
    throw Error("--test-origin deve ser só a origem HTTPS da instalação de teste.");
  // A instalação de teste serve o próprio catálogo do R2 nesta rota
  // (src/index.ts; enviado por scripts/release-test-upload.mjs).
  testOrigin = url.origin + "/api/test-catalog";
}
// Uma origem de teste (e a chave do ensaio) só entra pelo --test-origin,
// nunca por acidente.
const config = parse(readFileSync("wrangler.jsonc", "utf8"));
if (
  !testOrigin &&
  (process.env.WABOTIA_TEST_RELEASE_ORIGIN ||
    process.env.WABOTIA_TEST_RELEASE_KEY ||
    config.define?.[TEST_CONSTANT] ||
    config.define?.[TEST_KEYS_CONSTANT])
)
  throw Error(
    "Origem ou chave de teste configurada (WABOTIA_TEST_RELEASE_ORIGIN, WABOTIA_TEST_RELEASE_KEY ou define no wrangler.jsonc): um pacote oficial não sai assim.",
  );

const publicKeys = JSON.parse(readFileSync("src/release-keys.json", "utf8")).keys;
/**
 * Build de teste: assinado só pela chave do ensaio (WABOTIA_TEST_RELEASE_KEY,
 * um .pem descartável fora do repositório, de scripts/release-keygen.mjs).
 * A pública dela vai embutida só no build de teste, no lugar das oficiais; a
 * chave oficial nem é procurada. Uma chave oficial como chave de ensaio é
 * recusada.
 */
let testKeys = null;
function loadTestSigner() {
  const given = process.env.WABOTIA_TEST_RELEASE_KEY;
  if (!given)
    throw Error(
      "Build de teste sem chave do ensaio: defina WABOTIA_TEST_RELEASE_KEY com o caminho de um .pem descartável (node scripts/release-keygen.mjs --id teste --out <fora do repositório>). A chave oficial não assina build de teste.",
    );
  const path = resolve(given);
  if (insideRepository(path, process.cwd()))
    throw Error("A chave do ensaio não pode ficar dentro do repositório.");
  let key;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch {
    throw Error(`Não foi possível ler a chave do ensaio em ${path}.`);
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("A chave do ensaio precisa ser Ed25519.");
  const x = createPublicKey(key).export({ format: "jwk" }).x;
  if (publicKeys.some((k) => k.ed25519 === x))
    throw Error(
      "A chave do ensaio é uma chave oficial (src/release-keys.json). Use uma chave descartável.",
    );
  testKeys = [{ id: "ensaio", ed25519: x }];
  return signerFor(key, testKeys);
}
/** Carrega a chave de assinatura; null só para o candidato. */
function loadSigner() {
  if (testOrigin) return loadTestSigner();
  let path = process.env.WABOTIA_RELEASE_KEY;
  if (!path && existsSync("release-signing.local.json"))
    path = JSON.parse(readFileSync("release-signing.local.json", "utf8")).key;
  if (!path) {
    if (candidate) return null;
    throw Error(
      "Sem chave de assinatura: defina WABOTIA_RELEASE_KEY ou release-signing.local.json com o caminho do .pem (docs/ATUALIZACOES.md). Sem assinatura, use --candidate.",
    );
  }
  path = resolve(path);
  if (insideRepository(path, process.cwd()))
    throw Error("A chave de assinatura não pode ficar dentro do repositório.");
  let key;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch {
    // A mensagem original pode trazer trechos do arquivo: não repassa.
    throw Error(`Não foi possível ler a chave de assinatura em ${path}.`);
  }
  return signerFor(key, publicKeys);
}
// O candidato nunca assina, mesmo com a chave configurada.
const signer = candidate ? null : loadSigner();
// As públicas que conferem as assinaturas desta execução.
const signingKeys = testKeys || publicKeys;
const root = candidate
  ? "output/release-candidate"
  : testOrigin
    ? "output/release-test"
    : "public/releases";
const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Lembrete de renovação do índice oficial, em qualquer execução.
const notice = renewalNotice(read("public/releases/v2/latest.json"));
if (notice) console.warn(`AVISO: ${notice}`);
const writeIndex = (index) => {
  const text = JSON.stringify(index, null, 2);
  const folder = `${root}/${index.version}`;
  writeFileSync(`${folder}/release-v2.json`, text);
  writeFileSync(`${root}/v2/latest.json`, text);
  if (signer) {
    const sig = signatureFile("index", Buffer.from(text), signer, signingKeys);
    writeFileSync(`${folder}/release-v2.sig`, sig);
    writeFileSync(`${root}/v2/latest.sig`, sig);
  }
};

if (renew) {
  // Renova só o prazo do índice publicado: mesma versão, mesmo manifesto.
  const current = read(`${root}/v2/latest.json`);
  if (!current) throw Error("Nada publicado em releases/v2 para renovar.");
  const manifest = readFileSync(`${root}/${current.version}/manifest.json`);
  if (hash(manifest) !== current.manifest_sha256)
    throw Error("O manifesto publicado não confere com o índice.");
  const renewed = withValidity(current);
  writeIndex(renewed);
  cpSync("public/releases", "dist/releases", { recursive: true });
  console.log(
    `Índice da ${current.version} renovado por ${signer.id} até ${new Date(renewed.expires).toISOString().slice(0, 10)}. Publique o site oficial com Wrangler.`,
  );
  process.exit(0);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error("Versão inválida.");
if (
  JSON.stringify(config.durable_objects?.bindings) !==
    JSON.stringify([{ name: "COORDINATOR", class_name: "Coordinator" }]) ||
  config.d1_databases?.length !== 1 ||
  config.r2_buckets?.length !== 1 ||
  config.kv_namespaces ||
  config.queues ||
  config.services
)
  throw Error("Novos recursos exigem revisão do formato de publicação.");
// Build de teste: a origem do catálogo de teste e as públicas do ensaio, no
// lugar das oficiais (src/release.ts).
const define = testOrigin
  ? {
      [TEST_CONSTANT]: JSON.stringify(testOrigin),
      [TEST_KEYS_CONSTANT]: JSON.stringify(testKeys),
    }
  : {};
const require = createRequire(import.meta.url);
// O esbuild do Wrangler, esteja ele dentro de wrangler/node_modules ou içado
// para node_modules (depende de como o npm montou a árvore).
const { build } = createRequire(require.resolve("wrangler/package.json"))(
  "esbuild",
);
const installer = testOrigin
  ? `${root}/install-wabotia.mjs`
  : "public/install-wabotia.mjs";
await build({
  entryPoints: ["scripts/install-release.ts"],
  outfile: installer,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  define,
});
// No Windows os executáveis do npm são .cmd (mesma regra de scripts/deploy.mjs).
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (command, commandArgs) =>
  execFileSync(command, commandArgs, {
    stdio: "inherit",
    // Node 22 só executa arquivos .cmd através do shell.
    shell: process.platform === "win32",
    env: { ...process.env, WABOTIA_SOURCE_COMMIT: commit },
  });
run(npm, ["run", "build"]);
rmSync("output/release-worker", { recursive: true, force: true });
// Build de teste: a constante vai por um wrangler temporário (ignorado pelo
// Git) e não por --define, que o shell do Windows desmontaria nas aspas.
const workerConfig = testOrigin
  ? "wrangler.release-test.local.json"
  : "wrangler.jsonc";
if (testOrigin)
  writeFileSync(workerConfig, JSON.stringify({ ...config, define }, null, 2));
// --minify só na linha de comando: no wrangler.jsonc mudaria também o
// `wrangler deploy` de quem publica pelo código-fonte.
try {
  run(npx, [
    "wrangler",
    "deploy",
    "--dry-run",
    "--minify",
    "--outdir",
    "output/release-worker",
    "--config",
    workerConfig,
  ]);
} finally {
  if (testOrigin) rmSync(workerConfig, { force: true });
}
// O Worker e o instalador gerados apontam para a origem certa.
for (const file of ["output/release-worker/index.js", installer]) {
  const code = readFileSync(file, "utf8");
  if (!code.includes(testOrigin || OFFICIAL_ORIGIN))
    throw Error(`${file} não aponta para ${testOrigin || OFFICIAL_ORIGIN}.`);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wasm": "application/wasm",
  // Plugin do Hermes servido em /hermes-plugin/ (docs/HERMES-PLUGIN.md).
  ".sh": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
};
function files(base, relative = "", modules = false) {
  return readdirSync(join(base, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(relative, entry.name).replaceAll("\\", "/");
      // O catálogo de versões e o guia em PDF ficam só no site oficial.
      if (!modules && excludedAsset(path)) return [];
      if (entry.isDirectory()) return files(base, path, modules);
      if (
        modules &&
        (entry.name.endsWith(".map") || entry.name === "README.md")
      )
        return [];
      const raw = readFileSync(join(base, path));
      return [
        {
          name: modules ? path : "/" + path,
          type:
            modules && /\.m?js$/.test(path)
              ? "application/javascript+module"
              : mime[extname(path)] || "application/octet-stream",
          raw,
          sha256: hash(raw),
        },
      ];
    },
  );
}
const modules = files("output/release-worker", "", true);
const assets = files("dist");
const migrations = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => {
    const statements = unstable_splitSqlQuery(
      readFileSync(join("migrations", name), "utf8"),
    );
    const raw = Buffer.from(JSON.stringify(statements));
    return {
      name,
      statements,
      type: "application/json",
      raw,
      sha256: hash(raw),
    };
  });

const ref = ({ name, type, raw, sha256 }) => ({
  name,
  type,
  size: raw.length,
  sha256,
});
const unique = new Map();
for (const f of [...modules, ...migrations, ...assets]) unique.set(f.sha256, f);
const manifest = {
  format: 2,
  version: pkg.version,
  commit,
  ...(testOrigin ? { test_origin: testOrigin } : {}),
  main_module: "index.js",
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  assets_config: {
    not_found_handling: config.assets.not_found_handling,
    run_worker_first: config.assets.run_worker_first,
    // The direct Cloudflare API expects this text in metadata. Uploading the
    // _headers file as a static asset alone does not apply its policies.
    _headers: readFileSync("dist/_headers", "utf8"),
  },
  durable_migrations: config.migrations,
  modules: modules.map(ref),
  assets: assets.map(ref),
  migrations: migrations.map(ref),
};
const manifestText = JSON.stringify(manifest);
const sizes = [...unique.values()].map((f) => f.raw.length);
const total = sizes.reduce((a, b) => a + b, 0);
const modulesTotal = modules.reduce((a, f) => a + f.raw.length, 0);
// Mesmos tetos de src/release.ts.
if (Buffer.byteLength(manifestText) > 2 * 1024 * 1024)
  throw Error("Manifesto excede 2 MiB.");
if (Math.max(...sizes) > 25 * 1024 * 1024)
  throw Error("Um arquivo excede 25 MiB (teto de um estático da Cloudflare).");
if (modulesTotal > 40 * 1024 * 1024) throw Error("Worker excede 40 MiB.");
if (total > 160 * 1024 * 1024) throw Error("Versão excede 160 MiB.");
if (modules.length > 256 || assets.length > 2000 || migrations.length > 1000)
  throw Error("Arquivos demais para o formato 2.");
const manifestSha = hash(manifestText);

// O índice do formato 1 (releases/latest.json) e o registro da ponte. O
// candidato confere contra o catálogo publicado.
const catalog = (path) =>
  read(`${root}/${path}`) ??
  (candidate ? read(`public/releases/${path}`) : null);
const frozen = catalog("latest.json");
// Ordem das versões: maior que a publicada e que a última do formato 1 (na
// ponte, a 0.21.0; depois dela, a própria ponte). Também vale para uma versão
// já publicada com outro manifesto.
const order = () =>
  checkVersionOrder({
    version: pkg.version,
    current: read(`${root}/v2/latest.json`),
    frozen: frozen || { version: LAST_FORMAT1 },
    manifestSha,
  });
const published = read(`${root}/${pkg.version}/release-v2.json`);
let plan;
if (candidate) {
  try {
    order();
  } catch (e) {
    console.warn(`Aviso (candidato): ${e.message}`);
  }
  try {
    plan = releaseOutputs({
      bridge,
      version: pkg.version,
      bridgeRecord: catalog("v2/bridge.json"),
      minVersion,
    });
  } catch (e) {
    console.warn(`Aviso (candidato): ${e.message}`);
    plan = { legacy: bridge, min_version: minVersion || "0.0.0" };
  }
} else {
  order();
  if (published && published.manifest_sha256 !== manifestSha)
    throw Error("Use uma versão nova; não substitua uma publicação existente.");
  plan = releaseOutputs({
    bridge,
    version: pkg.version,
    bridgeRecord: read(`${root}/v2/bridge.json`),
    minVersion,
  });
}

// Formato 1, só na ponte: o pacote único que a 0.21.0 lê, com as travas do
// leitor dela conferidas antes de gravar qualquer coisa.
let legacy = null;
if (plan.legacy) {
  const encode = ({ name, type, raw, sha256 }) => ({
    name,
    type,
    data: raw.toString("base64"),
    sha256,
  });
  const legacyAssets = slim ? assets.filter((f) => !slimAsset(f.name)) : assets;
  const legacyPackage = {
    format: 1,
    version: pkg.version,
    commit,
    main_module: manifest.main_module,
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags,
    assets_config: manifest.assets_config,
    durable_migrations: manifest.durable_migrations,
    modules: modules.map(encode),
    assets: legacyAssets.map(encode),
    migrations: migrations.map(({ name, statements }) => ({
      name,
      statements,
    })),
  };
  const content = JSON.stringify(legacyPackage);
  const size = Buffer.byteLength(content);
  const problems = legacyProblems(legacyPackage, size);
  if (problems.length)
    throw Error(
      `O pacote de formato 1 da ponte não passa no leitor da 0.21.0: ${problems.join("; ")}.`,
    );
  const index = {
    format: 1,
    version: pkg.version,
    commit,
    package_sha256: hash(content),
    package_size: size,
  };
  const old = read(`${root}/${pkg.version}/release.json`);
  if (!candidate && old && old.package_sha256 !== index.package_sha256)
    throw Error("Use uma versão nova; não substitua uma publicação existente.");
  legacy = {
    content,
    index,
    left: assets.length - legacyAssets.length,
  };
}

const folder = `${root}/${pkg.version}`;
mkdirSync(`${root}/v2`, { recursive: true });
mkdirSync(`${root}/blobs`, { recursive: true });
mkdirSync(folder, { recursive: true });
for (const [sha, f] of unique) {
  const path = `${root}/blobs/${sha}`;
  if (!existsSync(path)) writeFileSync(path, f.raw);
}
writeFileSync(`${folder}/manifest.json`, manifestText);
if (signer)
  writeFileSync(
    `${folder}/manifest.sig`,
    signatureFile("manifest", Buffer.from(manifestText), signer, signingKeys),
  );
const index = withValidity({
  format: 2,
  version: pkg.version,
  commit,
  manifest_sha256: manifestSha,
  manifest_size: Buffer.byteLength(manifestText),
  total_size: total,
  requires: {
    min_version: plan.min_version,
    workers_paid: args.includes("--workers-paid"),
  },
  ...(testOrigin ? { test_origin: testOrigin } : {}),
  ...(candidate ? { candidate: true } : {}),
});
writeIndex(index);
// releases/latest.json (formato 1) só é escrito pela ponte, que o congela em
// si mesma e se registra em v2/bridge.json; nenhuma versão depois o muda.
if (legacy) {
  writeFileSync(`${folder}/package.json`, legacy.content);
  const text = JSON.stringify(legacy.index, null, 2);
  writeFileSync(`${folder}/release.json`, text);
  writeFileSync(`${root}/latest.json`, text);
  writeFileSync(
    `${root}/v2/bridge.json`,
    JSON.stringify({ version: pkg.version, commit }, null, 2),
  );
}
if (!candidate && !testOrigin)
  cpSync("public/releases", "dist/releases", { recursive: true });
const summary =
  `Versão ${pkg.version} (${commit}): manifesto ${index.manifest_size} bytes, ${unique.size} arquivos únicos, ${total} bytes (Worker ${modulesTotal}).` +
  (legacy
    ? ` PONTE: pacote de formato 1 com ${legacy.index.package_size} bytes (teto ${24 * 1024 * 1024})${slim ? `, enxuta: ${legacy.left} estáticos do ERP fora dele` : ""}; releases/latest.json congelado nesta versão.`
    : ` Exige a ${plan.min_version} instalada; releases/latest.json não muda.`);
if (candidate)
  console.log(
    `${summary}\nCANDIDATO SEM ASSINATURA em ${root}: as instalações recusam. Não publicar.`,
  );
else if (testOrigin)
  console.log(
    `${summary} Assinada por ${signer.id}, válida até ${new Date(index.expires).toISOString().slice(0, 10)}.\nBUILD DE TESTE (${testOrigin}) em ${root}: não publicar no site oficial.`,
  );
else
  console.log(
    `${summary} Assinada por ${signer.id}, válida até ${new Date(index.expires).toISOString().slice(0, 10)}. Publique o site oficial com Wrangler para disponibilizar esta versão.`,
  );
