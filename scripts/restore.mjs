#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [config, dir, confirmation] = process.argv.slice(2);
if (!config || !dir || confirmation !== "--empty-target")
  throw Error(
    "Uso: node scripts/restore.mjs CONFIG_DE_DESTINO PASTA_DO_BACKUP --empty-target. Use um banco NOVO, vazio.",
  );
const cfg = parse(await readFile(config, "utf8")),
  manifest = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ),
  wrangler = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
if (!manifest.complete) throw Error("Backup incompleto.");
function run(args, capture = false) {
  const r = spawnSync(
    process.execPath,
    [wrangler, ...args, "--config", config],
    {
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
    },
  );
  if (r.status !== 0)
    throw Error("Restauração interrompida; não ative o atendimento.");
  return r.stdout;
}
const state = JSON.parse(
  run(
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--command",
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      "--json",
    ],
    true,
  ),
);
if (state.some((r) => r.results?.length))
  throw Error("Destino contém tabelas. Nenhum dado foi substituído.");
run([
  "d1",
  "execute",
  "DB",
  "--remote",
  "--file",
  path.join(dir, "database.sql"),
]);
for (const row of manifest.media)
  run([
    "r2",
    "object",
    "put",
    cfg.r2_buckets[0].bucket_name + "/" + row.object_key,
    "--remote",
    "--file",
    path.join(dir, "media", row.id),
  ]);
console.log(
  "Dados restaurados. Configure a MASTER_KEY original por Workers Secrets, publique o código da mesma versão, confira o diagnóstico e teste antes de ativar.",
);
