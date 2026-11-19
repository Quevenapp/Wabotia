#!/usr/bin/env node
// Copia, sem alteração, o código do Fagoo que a erp-api usa: a própria
// erp-api, o origin-sync e os pacotes compartilhados, na mesma árvore
// relativa (src/erp/fagoo/workers/…, src/erp/fagoo/packages/…), para os
// imports "../../../packages/…" continuarem valendo. O Fagoo é só leitura.
//   node scripts/erp/copy-fagoo.mjs D:\Code\Fagoo
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const source = process.argv[2];
if (!source) throw Error("Informe a pasta do ERP de origem.");
const target = "src/erp/fagoo";
const parts = [
  "workers/erp-api/src",
  "workers/origin-sync/src",
  ...readdirSync(join(source, "packages"))
    .filter((p) => statSync(join(source, "packages", p, "src"), { throwIfNoEntry: false })?.isDirectory())
    .map((p) => `packages/${p}/src`),
];
rmSync(target, { recursive: true, force: true });
// Só o que a erp-api alcança pelos imports (todo arquivo de workers/erp-api/src
// é entrada): o bloco fiscal A1/SEFAZ/DANFE que ela não importa fica de fora.
const reachable = new Set();
const queue = [];
const walkAll = (dir) => {
  for (const e of readdirSync(join(source, dir), { withFileTypes: true }))
    if (e.isDirectory()) walkAll(join(dir, e.name));
    else if (/\.(mjs|js|json)$/.test(e.name)) queue.push(join(dir, e.name).replaceAll("\\", "/"));
};
walkAll("workers/erp-api/src");
while (queue.length) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  reachable.add(file);
  if (!/\.(mjs|js)$/.test(file)) continue;
  const text = readFileSync(join(source, file), "utf8");
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const next = join(file, "..", m[1]).replaceAll("\\", "/");
    if (statSync(join(source, next), { throwIfNoEntry: false })?.isFile()) queue.push(next);
  }
}
const files = [];
for (const file of [...reachable].sort()) {
  cpSync(join(source, file), join(target, file));
  const bytes = readFileSync(join(source, file));
  files.push({ path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const used = [...new Set(files.map((f) => f.path.split("/").slice(0, 2).join("/")))];
writeFileSync(
  join(target, "MANIFEST.json"),
  JSON.stringify({ source: "Fagoo (somente leitura)", copied_at: new Date().toISOString().slice(0, 10), used, files }, null, 1) + "\n",
);
console.log(`${files.length} arquivos, ${files.reduce((s, f) => s + f.bytes, 0)} bytes, em ${target}: ${used.join(", ")}`);
void parts;
void relative;
