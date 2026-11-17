#!/usr/bin/env node
// Só para o ensaio do atualizador (docs/ATUALIZACOES-FORMATO.md, "Roteiro").
// Envia o catálogo de teste (output/release-test, gerado por
// `npm run release -- --test-origin <url>`) para o R2 da instalação de teste,
// no prefixo test-catalog/, de onde o build de teste o serve em
// /api/test-catalog/releases/... Nunca toca no catálogo oficial.
//
//   node scripts/release-test-upload.mjs --config wrangler.staging.local.json
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "jsonc-parser";

const args = process.argv.slice(2);
const configPath = args[args.indexOf("--config") + 1];
if (!args.includes("--config") || !configPath)
  throw Error("Informe --config com o wrangler da instalação de teste.");
const config = parse(readFileSync(configPath, "utf8"));
const bucket = config.r2_buckets?.find((b) => b.binding === "MEDIA")?.bucket_name;
if (!bucket) throw Error("O wrangler informado não tem o bucket MEDIA.");
const root = "output/release-test";
const index = JSON.parse(readFileSync(`${root}/v2/latest.json`, "utf8"));
if (!index.test_origin)
  throw Error("output/release-test não é um catálogo de teste.");
const types = { ".json": "application/json", ".sig": "application/json" };
const files = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const path = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return files(path);
    return path === "install-wabotia.mjs" ? [] : [path];
  });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const list = files("");
for (const [i, path] of list.entries()) {
  execFileSync(
    npx,
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/test-catalog/releases/${path}`,
      "--file",
      join(root, path),
      "--content-type",
      types[extname(path)] || "application/octet-stream",
      "--remote",
      "--config",
      configPath,
    ],
    { stdio: "ignore", shell: process.platform === "win32" },
  );
  console.log(`${i + 1}/${list.length} ${path}`);
}
console.log(
  `Catálogo de teste da ${index.version} enviado para ${bucket}/test-catalog/. Servido em ${index.test_origin}/releases/...`,
);
