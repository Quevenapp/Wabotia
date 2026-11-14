#!/usr/bin/env node
import {
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
rmSync("output/release-worker", { recursive: true, force: true });
run(npx, [
  "wrangler",
  "deploy",
  "--dry-run",
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
function files(root, relative = "", modules = false) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(relative, entry.name).replaceAll("\\", "/");
      if (!modules && (path === "releases" || path.startsWith("releases/")))
        return [];
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
          data: raw.toString("base64"),
          sha256: hash(raw),
        },
      ];
    },
  );
}
const release = {
  format: 1,
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
  modules: files("output/release-worker", "", true),
  assets: files("dist"),
  migrations: readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      statements: unstable_splitSqlQuery(
        readFileSync(join("migrations", name), "utf8"),
      ),
    })),
};
const content = JSON.stringify(release);
// Teto igual a MAX_PACKAGE em src/release.ts. Acima de 20 MB, as instalações
// até a 0.17.0 recusam o pacote; só publique assim depois que elas tiverem
// atualizado (WABOTIA_ALLOW_OVER_20MB=1).
const size = Buffer.byteLength(content);
if (size > 24 * 1024 * 1024) throw Error("Pacote excede 24 MB.");
if (size > 20 * 1024 * 1024 && process.env.WABOTIA_ALLOW_OVER_20MB !== "1")
  throw Error(
    "Pacote excede 20 MB: instalações até a 0.17.0 não conseguiriam atualizar. Publique antes uma versão com o limite de 24 MB e use WABOTIA_ALLOW_OVER_20MB=1.",
  );
const index = {
  format: 1,
  version: pkg.version,
  commit,
  package_sha256: hash(content),
  package_size: Buffer.byteLength(content),
};
const candidate = process.argv.includes("--candidate");
const folder = candidate
  ? "output/release-candidate"
  : `public/releases/${pkg.version}`;
mkdirSync(folder, { recursive: true });
try {
  const old = JSON.parse(readFileSync(folder + "/release.json", "utf8"));
  if (!candidate && old.package_sha256 !== index.package_sha256)
    throw Error("Use uma versão nova; não substitua uma publicação existente.");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
writeFileSync(folder + "/package.json", content);
writeFileSync(folder + "/release.json", JSON.stringify(index, null, 2));
if (!candidate) {
  writeFileSync("public/releases/latest.json", JSON.stringify(index, null, 2));
  cpSync("public/releases", "dist/releases", { recursive: true });
}
console.log(
  `Pacote ${pkg.version} pronto: ${commit}; ${index.package_size} bytes. Publique o site oficial com Wrangler para disponibilizar esta versão.`,
);
