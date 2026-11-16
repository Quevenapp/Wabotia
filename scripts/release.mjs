#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
} from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parse } from "jsonc-parser";
import { unstable_splitSqlQuery } from "wrangler";
import {
  BRIDGE_LEGACY_LIMIT,
  excludedAsset,
  releaseOutputs,
} from "./release-plan.mjs";
const require = createRequire(import.meta.url);
const { build } = require("../node_modules/wrangler/node_modules/esbuild");
const config = parse(readFileSync("wrangler.jsonc", "utf8"));
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
await build({
  entryPoints: ["scripts/install-release.ts"],
  outfile: "public/install-wabotia.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
// No Windows os executáveis do npm são .cmd (mesma regra de scripts/deploy.mjs).
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (command, args) =>
  execFileSync(command, args, {
    stdio: "inherit",
    // Node 22 só executa arquivos .cmd através do shell.
    shell: process.platform === "win32",
    env: { ...process.env, WABOTIA_SOURCE_COMMIT: commit },
  });
run(npm, ["run", "build"]);
run(npm, ["run", "build"]);
rmSync("output/release-worker", { recursive: true, force: true });
// --minify só na linha de comando: no wrangler.jsonc mudaria também o
// `wrangler deploy` das instalações por Git (docs/ATUALIZACOES-FORMATO.md).
run(npx, [
  "wrangler",
  "deploy",
  "--dry-run",
  "--minify",
  "--outdir",
  "output/release-worker",
  "--config",
  "wrangler.jsonc",
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
// Cada arquivo: nome, tipo e bytes crus (o formato 1 converte para base64).
function files(root, relative = "", modules = false) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(relative, entry.name).replaceAll("\\", "/");
      // O catálogo de versões e o guia em PDF ficam só no site oficial.
      if (!modules && excludedAsset(path)) return [];
      if (entry.isDirectory()) return files(root, path, modules);
      if (
        modules &&
        (entry.name.endsWith(".map") || entry.name === "README.md")
      )
        return [];
      const raw = readFileSync(join(root, path));
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
const common = {
  version: pkg.version,
  commit,
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
};

const candidate = process.argv.includes("--candidate");
const bridge = process.argv.includes("--bridge");
const root = candidate ? "output/release-candidate" : "public/releases";
const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
const plan = releaseOutputs({
  bridge,
  version: pkg.version,
  // O candidato confere contra o catálogo publicado.
  existingBridge: read("public/releases/v2/bridge.json"),
});
const folder = `${root}/${pkg.version}`;
mkdirSync(`${root}/v2`, { recursive: true });
mkdirSync(`${root}/blobs`, { recursive: true });
mkdirSync(folder, { recursive: true });

// Formato 2: blobs por conteúdo (compartilhados entre versões) e manifesto.
const ref = ({ name, type, raw, sha256 }) => ({
  name,
  type,
  size: raw.length,
  sha256,
});
const unique = new Map();
for (const f of [...modules, ...migrations, ...assets]) unique.set(f.sha256, f);
for (const [sha, f] of unique) {
  const path = `${root}/blobs/${sha}`;
  if (!existsSync(path)) writeFileSync(path, f.raw);
}
const manifest = {
  format: 2,
  ...common,
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
const indexV2 = {
  format: 2,
  version: pkg.version,
  commit,
  manifest_sha256: hash(manifestText),
  manifest_size: Buffer.byteLength(manifestText),
  total_size: total,
  requires: {
    min_version: plan.min_version,
    workers_paid: process.argv.includes("--workers-paid"),
  },
};
const previous = read(`${folder}/release-v2.json`);
if (!candidate && previous && previous.manifest_sha256 !== indexV2.manifest_sha256)
  throw Error("Use uma versão nova; não substitua uma publicação existente.");
writeFileSync(`${folder}/manifest.json`, manifestText);
writeFileSync(`${folder}/release-v2.json`, JSON.stringify(indexV2, null, 2));
writeFileSync(`${root}/v2/latest.json`, JSON.stringify(indexV2, null, 2));

// Formato 1, só na ponte: o pacote único que as instalações antigas leem.
let legacySize = 0;
if (plan.legacy) {
  const content = JSON.stringify({
    format: 1,
    ...common,
    modules: modules.map(({ name, type, raw, sha256 }) => ({
      name,
      type,
      data: raw.toString("base64"),
      sha256,
    })),
    assets: assets.map(({ name, type, raw, sha256 }) => ({
      name,
      type,
      data: raw.toString("base64"),
      sha256,
    })),
    migrations: migrations.map(({ name, statements }) => ({ name, statements })),
  });
  legacySize = Buffer.byteLength(content);
  // Instalações até a 0.17.0 aceitam no máximo 20 MB.
  if (legacySize > BRIDGE_LEGACY_LIMIT)
    throw Error(
      `Pacote da ponte com ${legacySize} bytes: passa dos 20 MB que as instalações até a 0.17.0 aceitam.`,
    );
  const index = {
    format: 1,
    version: pkg.version,
    commit,
    package_sha256: hash(content),
    package_size: legacySize,
  };
  const old = read(`${folder}/release.json`);
  if (!candidate && old && old.package_sha256 !== index.package_sha256)
    throw Error("Use uma versão nova; não substitua uma publicação existente.");
  writeFileSync(`${folder}/package.json`, content);
  writeFileSync(`${folder}/release.json`, JSON.stringify(index, null, 2));
  // Congela o índice antigo na ponte e registra a ponte para as próximas.
  writeFileSync(`${root}/latest.json`, JSON.stringify(index, null, 2));
  writeFileSync(
    `${root}/v2/bridge.json`,
    JSON.stringify({ version: pkg.version, commit }, null, 2),
  );
}
if (!candidate) cpSync("public/releases", "dist/releases", { recursive: true });
console.log(
  `Versão ${pkg.version} pronta: ${commit}. Formato 2: manifesto ${indexV2.manifest_size} bytes, ${unique.size} arquivos únicos, ${total} bytes (Worker ${modulesTotal}).` +
    (plan.legacy
      ? ` Ponte: pacote de formato 1 com ${legacySize} bytes; releases/latest.json congelado nesta versão.`
      : " releases/latest.json não muda (continua na ponte).") +
    " Publique o site oficial com Wrangler para disponibilizar esta versão.",
);
