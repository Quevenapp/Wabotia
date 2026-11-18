#!/usr/bin/env node
// Confere uma versão gerada pelo scripts/release.mjs (candidato ou oficial)
// com os mesmos leitores que vão lê-la nas instalações, compilados aqui sem
// alteração:
//
// - formato 2 (todas as versões): parseIndex, parseManifest, checkBlob e
//   migrationStatements do src/release.ts atual. Sem os .sig (candidato), o
//   índice e o manifesto são assinados em memória com uma chave temporária,
//   só para passar pelo resto das conferências; a assinatura de verdade só
//   existe na versão oficial.
// - formato 1 (só a ponte): parsePackage e validateIndex do src/release.ts
//   da 0.21.0 (LEGACY_READER), o atualizador que vai ler o pacote na
//   instalação; e o pacote de formato 1 tem o mesmo código do formato 2.
//
// Confere também as ligações de uma instalação 0.20.0/0.21.0 e que o
// wrangler.jsonc não mudou ligações nem Durable Objects em relação ao
// origin/main.
//
//   node scripts/erp/check-candidate.mjs output/release-candidate/0.21.1
import {
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { signatureFile } from "../release-sign.mjs";
import { slimAsset } from "../release-plan.mjs";

/** O atualizador de formato 1 que as instalações 0.21.0 rodam. */
const LEGACY_READER = "fca4bb2";

const require = createRequire(import.meta.url);
// O esbuild do Wrangler, aninhado ou içado (ver scripts/release.mjs).
const { build } = createRequire(require.resolve("wrangler/package.json"))(
  "esbuild",
);
const out = "output/erp-check";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const compile = async (entry, name) => {
  await build({
    entryPoints: [entry],
    outfile: `${out}/${name}.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  return import(pathToFileURL(`${out}/${name}.mjs`).href);
};
const current = await compile("src/release.ts", "release");
writeFileSync(
  `${out}/release-0.21.0.ts`,
  execFileSync("git", ["show", `${LEGACY_READER}:src/release.ts`], {
    encoding: "utf8",
  }),
);
const legacyReader = await compile(
  `${out}/release-0.21.0.ts`,
  "release-0.21.0",
);

const folder = (process.argv[2] || "").replace(/[\\/]+$/, "");
if (!folder || !existsSync(`${folder}/manifest.json`))
  throw Error(
    "Informe a pasta da versão (com manifest.json), por exemplo output/release-candidate/0.21.1.",
  );
const root = dirname(folder);
const bytes = (path) => new Uint8Array(readFileSync(path));
const maybe = (path) => (existsSync(path) ? bytes(path) : null);

// --- Formato 2 -------------------------------------------------------------
const indexBytes = bytes(`${folder}/release-v2.json`);
const manifestBytes = bytes(`${folder}/manifest.json`);
let indexSig = maybe(`${folder}/release-v2.sig`);
let manifestSig = maybe(`${folder}/manifest.sig`);
const signed = !!(indexSig && manifestSig);
if (!signed) {
  // Candidato: chave temporária, confiada só neste processo.
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x;
  const keys = [{ id: "candidato", ed25519: x }];
  current.trustReleaseKeysForTests(keys);
  const signer = { id: "candidato", key: privateKey };
  indexSig = Buffer.from(signatureFile("index", indexBytes, signer, keys));
  manifestSig = Buffer.from(
    signatureFile("manifest", manifestBytes, signer, keys),
  );
}
const index = await current.parseIndex(indexBytes, indexSig, Date.now());
const manifest = await current.parseManifest(index, manifestBytes, manifestSig);
for (const ref of current.uniqueBlobs(manifest)) {
  const blob = bytes(join(root, "blobs", ref.sha256));
  await current.checkBlob(ref, blob);
}
for (const ref of manifest.migrations)
  current.migrationStatements(ref, bytes(join(root, "blobs", ref.sha256)));

// --- Formato 1 (só a ponte) -----------------------------------------------
let legacy = null;
if (existsSync(`${folder}/package.json`)) {
  const legacyIndex = legacyReader.validateIndex(
    JSON.parse(readFileSync(`${folder}/release.json`, "utf8")),
  );
  const pkg = await legacyReader.parsePackage(
    legacyIndex,
    bytes(`${folder}/package.json`),
  );
  // O mesmo código nos dois formatos: módulos e migrações iguais; estáticos
  // iguais, ou (ponte enxuta) só sem as telas do ERP.
  const shas = (files) => files.map((f) => `${f.name} ${f.sha256}`).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(shas(pkg.modules), shas(manifest.modules)))
    throw Error("Os módulos do pacote de formato 1 diferem do manifesto.");
  const legacyAssets = new Set(shas(pkg.assets));
  const missing = shas(manifest.assets).filter((f) => !legacyAssets.has(f));
  if (shas(pkg.assets).some((f) => !shas(manifest.assets).includes(f)))
    throw Error("O pacote de formato 1 tem estáticos fora do manifesto.");
  if (missing.some((f) => !slimAsset(f.split(" ")[0])))
    throw Error(
      `Faltam estáticos no pacote de formato 1: ${missing.filter((f) => !slimAsset(f.split(" ")[0])).join(", ")}.`,
    );
  const migrationText = JSON.stringify(
    pkg.migrations.map((m) => [m.name, m.statements]),
  );
  const manifestMigrations = JSON.stringify(
    manifest.migrations.map((ref) => [
      ref.name,
      current.migrationStatements(ref, bytes(join(root, "blobs", ref.sha256))),
    ]),
  );
  if (migrationText !== manifestMigrations)
    throw Error("As migrações do pacote de formato 1 diferem do manifesto.");
  for (const key of [
    "version",
    "commit",
    "main_module",
    "compatibility_date",
    "compatibility_flags",
    "durable_migrations",
    "assets_config",
  ])
    if (!same(pkg[key], manifest[key]))
      throw Error(`O pacote de formato 1 difere do manifesto em ${key}.`);
  legacy = {
    package_bytes: legacyIndex.package_size,
    max_package: legacyReader.MAX_PACKAGE,
    headroom_bytes: legacyReader.MAX_PACKAGE - legacyIndex.package_size,
    assets: pkg.assets.length,
    slim_left_out: missing.length,
    migrations: pkg.migrations.length,
  };
}

// --- Ligações de uma instalação 0.20.0/0.21.0 ------------------------------
const installation = "inst-teste";
const settings = {
  bindings: [
    { name: "WABOTIA_INSTALLATION_ID", type: "plain_text", text: installation },
    { name: "DB", type: "d1" },
    { name: "MEDIA", type: "r2_bucket" },
    {
      name: "COORDINATOR",
      type: "durable_object_namespace",
      class_name: "Coordinator",
    },
    { name: "ASSETS", type: "assets" },
    { name: "MASTER_KEY", type: "secret_text" },
    { name: "SETUP_TOKEN", type: "secret_text" },
  ],
  migration_tag: "v1",
};
current.validateInstalledSettings(settings, installation);
legacyReader.validateInstalledSettings(settings, installation);

// wrangler.jsonc igual ao do origin/main nos pontos que o atualizador não muda.
const here = parse(readFileSync("wrangler.jsonc", "utf8"));
const main = parse(
  execFileSync("git", ["show", "origin/main:wrangler.jsonc"], {
    encoding: "utf8",
  }),
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
  throw Error(
    "wrangler.jsonc mudou bindings ou durable_migrations em relação ao origin/main.",
  );
// As flags de compatibilidade vão no pacote e o atualizador as aplica, então
// podem ganhar itens; nenhuma das que a instalação já usa pode sumir.
const missingFlags = (main.compatibility_flags || []).filter(
  (flag) => !(here.compatibility_flags || []).includes(flag),
);
if (missingFlags.length)
  throw Error(
    `wrangler.jsonc perdeu flags de compatibilidade: ${missingFlags.join(", ")}.`,
  );
if (
  JSON.stringify(manifest.compatibility_flags) !==
  JSON.stringify(here.compatibility_flags)
)
  throw Error("As flags do pacote diferem das do wrangler.jsonc.");

const main_ = manifest.modules.find((f) => f.name === manifest.main_module);
console.log(
  JSON.stringify(
    {
      ok: true,
      version: manifest.version,
      commit: manifest.commit,
      signed,
      min_version: index.requires.min_version,
      total_bytes: index.total_size,
      modules: manifest.modules.length,
      main_module_bytes: main_.size,
      assets: manifest.assets.length,
      migrations: manifest.migrations.length,
      durable_migrations: manifest.durable_migrations,
      format1: legacy,
    },
    null,
    1,
  ),
);
