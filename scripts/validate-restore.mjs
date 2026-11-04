#!/usr/bin/env node
// Creates an empty, disposable Cloudflare D1/R2 destination and removes it only after a successful roundtrip.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "jsonc-parser";
const source = process.argv[2],
  backup = process.argv[3];
if (!source?.includes("staging") || !backup)
  throw Error(
    "Use: node scripts/validate-restore.mjs wrangler.staging.local.json PASTA_BACKUP",
  );
const name = "wabotia-restore-" + Date.now(),
  config = "wrangler.restore.local.json";
const cfg = parse(await readFile(source, "utf8")),
  manifest = JSON.parse(await readFile(backup + "/manifest.json", "utf8"));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
function run(args, capture = true, configPath = config) {
  const r = spawnSync(npx, ["wrangler", ...args, "--config", configPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (r.status !== 0) throw Error("Falhou: " + args.slice(0, 3).join(" "));
  return r.stdout;
}
const created = run(["d1", "create", name, "--no-update-config"], true, source);
const id = created.match(/"database_id"\s*:\s*"([a-f0-9-]+)"/)?.[1];
if (!id)
  throw Error(
    "Não foi possível identificar o banco recém-criado. Confira " + name,
  );
cfg.name = name;
delete cfg.routes;
cfg.d1_databases = [
  {
    binding: "DB",
    database_name: name,
    database_id: id,
    migrations_dir: "migrations",
  },
];
cfg.r2_buckets = [{ binding: "MEDIA", bucket_name: name }];
await writeFile(config, JSON.stringify(cfg, null, 2));
run(["r2", "bucket", "create", name]);
console.log("Destino vazio criado; restaurando cópia sintética.");
const restored = spawnSync(
  process.execPath,
  ["scripts/restore.mjs", config, backup, "--empty-target"],
  { stdio: "inherit" },
);
if (restored.status !== 0)
  throw Error(
    "Restauração falhou; destino preservado para diagnóstico: " + name,
  );
function query(configPath, sql) {
  return JSON.parse(
    run(
      ["d1", "execute", "DB", "--remote", "--command", sql, "--json"],
      true,
      configPath,
    ),
  ).flatMap((r) => r.results || []);
}
const sql =
  "SELECT 'profiles' resource,count(*) total FROM profiles UNION ALL SELECT 'conversations',count(*) FROM conversations UNION ALL SELECT 'tickets',count(*) FROM tickets UNION ALL SELECT 'media',count(*) FROM media UNION ALL SELECT 'knowledge_search',count(*) FROM chunks WHERE chunks MATCH 'atendimento'";
const original = query(source, sql),
  recovered = query(config, sql);
if (JSON.stringify(original) !== JSON.stringify(recovered))
  throw Error("Contagens não correspondem; destino preservado.");
await mkdir("tmp/restore-validation", { recursive: true });
const hashes = [];
for (const row of manifest.media) {
  const file = "tmp/restore-validation/" + row.id;
  run([
    "r2",
    "object",
    "get",
    name + "/" + row.object_key,
    "--remote",
    "--file",
    file,
  ]);
  const digest = async (f) =>
    createHash("sha256")
      .update(await readFile(f))
      .digest("hex");
  if ((await digest(file)) !== (await digest(backup + "/media/" + row.id)))
    throw Error("Mídia difere: " + row.id);
  hashes.push({ id: row.id, sha256: await digest(file) });
}
const second = spawnSync(
  process.execPath,
  ["scripts/restore.mjs", config, backup, "--empty-target"],
  { encoding: "utf8" },
);
if (second.status === 0) throw Error("Proteção de banco não vazio falhou.");
for (const row of manifest.media)
  run(["r2", "object", "delete", name + "/" + row.object_key, "--remote"]);
run(["r2", "bucket", "delete", name]);
run(["d1", "delete", name, "--skip-confirmation"]);
await writeFile(
  "docs/reference/restore-validation.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      source: "staging",
      remote_d1: true,
      remote_r2: true,
      counts: recovered,
      media: hashes,
      nonempty_target_refused: true,
      disposable_target_removed: true,
    },
    null,
    2,
  ),
);
console.log(
  "Restauração D1/FTS/R2 conferida; proteção contra sobrescrita validada; recursos temporários removidos.",
);
