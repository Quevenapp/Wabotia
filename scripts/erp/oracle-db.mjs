#!/usr/bin/env node
// Oráculo do ERP: o Postgres do Fagoo em PGlite, com as 347 migrações
// congeladas em tests/erp/oracle/migrations/ (mesmo bootstrap das fixtures do
// Fagoo: papéis, auth.users, storage; a 088 é pulada como nelas). O diretório
// de dados fica em cache em output/erp-oracle/<sha>.tgz (chave: manifesto +
// bootstrap), para os testes não reaplicarem as migrações a cada execução.
//   node scripts/erp/oracle-db.mjs    (constrói e mede)
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const MIGRATIONS = join(root, "tests/erp/oracle/migrations");
export const SKIP = new Set(["202610160088_financial_import_authorization_waits.sql"]);

// tools/migration/helpers/stock-reservation-fixture.mjs (bootstrap) e
// workers/erp-api/test/helpers/pos-fixture.mjs (AUTH), do Fagoo.
export const BOOTSTRAP =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;";
export const AUTH =
  "alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;" +
  "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);" +
  "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);" +
  "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);";

export const migrationNames = () =>
  readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql") && !SKIP.has(n))
    .sort();

const cacheKey = () =>
  createHash("sha256")
    .update(readFileSync(join(MIGRATIONS, "MANIFEST.json")))
    .update(BOOTSTRAP + AUTH)
    .digest("hex")
    .slice(0, 16);

/** Constrói o banco do zero; devolve o PGlite e o tempo de cada etapa. */
export async function buildOracle() {
  const started = performance.now();
  const db = new PGlite();
  await db.waitReady;
  await db.exec(BOOTSTRAP);
  await db.exec(AUTH);
  const slow = [];
  for (const name of migrationNames()) {
    const t = performance.now();
    // Sempre LF (o manifesto é calculado assim; CRLF de um checkout com
    // core.autocrlf quebrava corpos de função: 42601). Ver .gitattributes.
    await db.exec(readFileSync(join(MIGRATIONS, name), "utf8").replace(/\r\n/g, "\n"));
    const ms = performance.now() - t;
    if (ms > 500) slow.push({ name, ms: Math.round(ms) });
  }
  return { db, ms: Math.round(performance.now() - started), slow };
}

/**
 * PGlite pronto (do cache, se houver). Cada chamada devolve um banco novo e
 * independente, com o esquema e os dados de referência das migrações.
 */
export async function oracleDb() {
  const dir = join(root, "output/erp-oracle");
  const file = join(dir, cacheKey() + ".tgz");
  if (!existsSync(file)) {
    const { db } = await buildOracle();
    const dump = await db.dumpDataDir("gzip");
    mkdirSync(dir, { recursive: true });
    // Os arquivos de teste rodam em processos paralelos: sem cache, vários
    // constroem ao mesmo tempo. Escrita em arquivo próprio e troca de nome
    // atômica; antes, um lia o .tgz pela metade (Z_BUF_ERROR).
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, Buffer.from(await dump.arrayBuffer()));
    try {
      renameSync(temp, file);
    } catch (error) {
      // Outro processo já pôs o seu (e pode estar lendo): fica o dele.
      rmSync(temp, { force: true });
      if (!existsSync(file)) throw error;
    }
    await db.close();
  }
  const blob = new Blob([readFileSync(file)]);
  const db = new PGlite({ loadDataDir: blob });
  await db.waitReady;
  // O Postgres do Fagoo em produção roda em UTC; o PGlite herdaria o fuso da
  // máquina e mudaria o texto de timestamptz no JSON ("…-03:00").
  await db.exec("set timezone = 'UTC'");
  return db;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { db, ms, slow } = await buildOracle();
  const counts = (
    await db.query(
      "select (select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema','auth','storage'))::int tables, (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema'))::int functions, (select count(*) from pg_trigger where not tgisinternal)::int triggers",
    )
  ).rows[0];
  console.log(JSON.stringify({ migrations: migrationNames().length, ms, ...counts, slow }, null, 1));
  await db.close();
}
