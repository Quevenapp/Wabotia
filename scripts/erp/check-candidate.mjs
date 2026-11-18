#!/usr/bin/env node
// Fase 0 do ERP, prova 3: o pacote candidato (node scripts/release.mjs
// --candidate) passa pelas mesmas conferências que o atualizador da
// instalação faz: parsePackage e validateInstalledSettings de src/release.ts,
// compilados aqui sem alteração. Confere também que wrangler.jsonc (bindings
// e durable_migrations) é idêntico ao do origin/main.
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";

const require = createRequire(import.meta.url);
// O esbuild do Wrangler, aninhado ou içado (ver scripts/release.mjs).
const { build } = createRequire(require.resolve("wrangler/package.json"))(
  "esbuild",
);
const out = "output/erp-check";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["src/release.ts"],
  outfile: `${out}/release.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const { parsePackage, validateInstalledSettings } = await import(
  pathToFileURL(`${out}/release.mjs`).href
);

const folder = process.argv[2] || "output/release-candidate";
const index = JSON.parse(readFileSync(`${folder}/release.json`, "utf8"));
const bytes = new Uint8Array(readFileSync(`${folder}/package.json`));
const pkg = await parsePackage(index, bytes);

// Configuração da Cloudflare de uma instalação 0.20.0 (como o atualizador a
// lê em installedSettings): as mesmas ligações e a etiqueta v1.
const installation = "inst-teste";
const settings = {
  bindings: [
    { name: "WABOTIA_INSTALLATION_ID", type: "plain_text", text: installation },
    { name: "DB", type: "d1" },
    { name: "MEDIA", type: "r2_bucket" },
    { name: "COORDINATOR", type: "durable_object_namespace", class_name: "Coordinator" },
    { name: "ASSETS", type: "assets" },
    { name: "MASTER_KEY", type: "secret_text" },
    { name: "SETUP_TOKEN", type: "secret_text" },
  ],
  migration_tag: "v1",
};
validateInstalledSettings(settings, installation);

// wrangler.jsonc igual ao do origin/main nos pontos que o atualizador não muda.
const here = parse(readFileSync("wrangler.jsonc", "utf8"));
const main = parse(
  execFileSync("git", ["show", "origin/main:wrangler.jsonc"], { encoding: "utf8" }),
);
const pick = (c) =>
  JSON.stringify({
    durable_objects: c.durable_objects,
    migrations: c.migrations,
    d1: c.d1_databases,
    r2: c.r2_buckets,
    kv: c.kv_namespaces,
    queues: c.queues,
    services: c.services,
  });
if (pick(here) !== pick(main))
  throw Error("wrangler.jsonc mudou bindings ou durable_migrations em relação ao origin/main.");
// As flags de compatibilidade vão no pacote e o atualizador as aplica
// (src/release.ts, metadata.compatibility_flags), então podem ganhar itens;
// nenhuma das que a instalação já usa pode sumir.
const missingFlags = (main.compatibility_flags || []).filter(
  (flag) => !(here.compatibility_flags || []).includes(flag),
);
if (missingFlags.length)
  throw Error(`wrangler.jsonc perdeu flags de compatibilidade: ${missingFlags.join(", ")}.`);
if (JSON.stringify(pkg.compatibility_flags) !== JSON.stringify(here.compatibility_flags))
  throw Error("As flags do pacote diferem das do wrangler.jsonc.");
if (
  JSON.stringify(pkg.durable_migrations) !==
  JSON.stringify([{ tag: "v1", new_sqlite_classes: ["Coordinator"] }])
)
  throw Error("durable_migrations do pacote mudou.");

const moduleBytes = pkg.modules.reduce((s, f) => s + Buffer.from(f.data, "base64").length, 0);
const main_ = pkg.modules.find((f) => f.name === pkg.main_module);
console.log(
  JSON.stringify(
    {
      ok: true,
      version: pkg.version,
      commit: pkg.commit,
      package_bytes: index.package_size,
      modules: pkg.modules.length,
      module_bytes: moduleBytes,
      main_module_bytes: Buffer.from(main_.data, "base64").length,
      assets: pkg.assets.length,
      migrations: pkg.migrations.length,
      durable_migrations: pkg.durable_migrations,
    },
    null,
    1,
  ),
);
