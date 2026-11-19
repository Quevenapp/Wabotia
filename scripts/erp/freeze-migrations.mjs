#!/usr/bin/env node
// Congela as migrações do Postgres do Fagoo como material de teste (fora do
// pacote): copia para tests/erp/oracle/migrations/ e grava MANIFEST.json com o
// SHA-256 de cada arquivo. O Fagoo é só leitura.
//   node scripts/erp/freeze-migrations.mjs D:\Code\Fagoo\supabase\migrations
//   node scripts/erp/freeze-migrations.mjs --check   (confere a cópia)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = "tests/erp/oracle/migrations";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (process.argv[2] === "--check") {
  const manifest = JSON.parse(readFileSync(join(target, "MANIFEST.json"), "utf8"));
  const present = readdirSync(target).filter((n) => n.endsWith(".sql")).sort();
  const listed = manifest.files.map((f) => f.name);
  if (JSON.stringify(present) !== JSON.stringify(listed))
    throw Error("Arquivos diferentes do manifesto.");
  // O SHA-256 é do texto com LF (o checkout do Git no Windows pode trazer CRLF).
  for (const f of manifest.files)
    if (sha(Buffer.from(readFileSync(join(target, f.name), "utf8").replace(/\r\n/g, "\n"))) !== f.sha256)
      throw Error(`SHA-256 diferente: ${f.name}`);
  console.log(`${manifest.files.length} migrações conferem com o manifesto.`);
  process.exit(0);
}

const source = process.argv[2];
if (!source) throw Error("Informe a pasta supabase/migrations do ERP de origem.");
mkdirSync(target, { recursive: true });
const names = readdirSync(source).filter((n) => n.endsWith(".sql")).sort();
const files = names.map((name) => {
  // Normaliza o fim de linha (o checkout do Fagoo pode ter CRLF); o SHA-256 é
  // o do arquivo copiado.
  const text = readFileSync(join(source, name), "utf8").replace(/\r\n/g, "\n");
  writeFileSync(join(target, name), text);
  return { name, bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) };
});
writeFileSync(
  join(target, "MANIFEST.json"),
  JSON.stringify(
    {
      source: "Fagoo supabase/migrations (somente leitura)",
      frozen_at: new Date().toISOString().slice(0, 10),
      count: files.length,
      total_bytes: files.reduce((s, f) => s + f.bytes, 0),
      skipped_by_oracle: ["202610160088_financial_import_authorization_waits.sql"],
      files,
    },
    null,
    1,
  ) + "\n",
);
console.log(`${files.length} migrações congeladas em ${target}.`);
