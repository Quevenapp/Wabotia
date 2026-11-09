#!/usr/bin/env node
import { readFile, writeFile, mkdir, appendFile, rm } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const config = process.argv[2] || "wrangler.production.local.json",
  dir =
    process.argv[3] ||
    "backup-" + new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(path.join(dir, "media"), { recursive: true, mode: 0o700 });
await rm(path.join(dir, "manifest.json"), { force: true });
const cfg = parse(await readFile(config, "utf8")),
  wrangler = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
function run(args, capture = false) {
  const r = spawnSync(
    process.execPath,
    [wrangler, ...args, "--config", config],
    {
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (r.status !== 0)
    throw Error("Backup interrompido; não considere esta cópia completa.");
  return r.stdout;
}
function query(sql) {
  return JSON.parse(
    run(["d1", "execute", "DB", "--remote", "--command", sql, "--json"], true),
  ).flatMap((r) => r.results || []);
}
const schema = query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'chunks%' ORDER BY name",
);
console.log(
  "Exportando tabelas operacionais; o índice FTS será reconstruído na restauração.",
);
run(
  [
    "d1",
    "export",
    "DB",
    "--remote",
    "--output",
    path.join(dir, "database.sql"),
    "--skip-confirmation",
    "--table",
    ...schema.map((r) => r.name),
  ],
  true,
);
await appendFile(
  path.join(dir, "database.sql"),
  "\nCREATE VIRTUAL TABLE chunks USING fts5(profile_id UNINDEXED,document_id UNINDEXED,text,url UNINDEXED);\n",
);
const sqlValue = (v) =>
  v === null
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : "'" + String(v).replaceAll("'", "''") + "'";
let cursor = 0;
for (;;) {
  const rows = query(
    "SELECT rowid,profile_id,document_id,text,url FROM chunks WHERE rowid>" +
      cursor +
      " ORDER BY rowid LIMIT 500",
  );
  if (!rows.length) break;
  await appendFile(
    path.join(dir, "database.sql"),
    rows
      .map(
        (row) =>
          "INSERT INTO chunks(rowid,profile_id,document_id,text,url) VALUES(" +
          [row.rowid, row.profile_id, row.document_id, row.text, row.url]
            .map(sqlValue)
            .join(",") +
          ");",
      )
      .join("\n") + "\n",
  );
  cursor = rows.at(-1).rowid;
}
const raw = run(
  [
    "d1",
    "execute",
    "DB",
    "--remote",
    "--command",
    "SELECT id,object_key FROM media ORDER BY id",
    "--json",
  ],
  true,
);
const rows = JSON.parse(raw).flatMap((r) => r.results || []);
for (const row of rows)
  run([
    "r2",
    "object",
    "get",
    cfg.r2_buckets[0].bucket_name + "/" + row.object_key,
    "--remote",
    "--file",
    path.join(dir, "media", row.id),
  ]);
await writeFile(
  path.join(dir, "manifest.json"),
  JSON.stringify(
    {
      version: 1,
      created: new Date().toISOString(),
      media: rows,
      complete: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  "Backup concluído em " +
    dir +
    ". Guarde separadamente a MASTER_KEY. Mantenha o atendimento pausado durante cópias consistentes de banco e mídias.",
);
