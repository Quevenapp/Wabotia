#!/usr/bin/env node
// Cloudflare Builds entry point. The Git repository stays unchanged; only this build's checkout is updated.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "jsonc-parser";

const upstream = "https://github.com/Quevenapp/Wabotia.git";
const checkedSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function preserveDeployment(current, next) {
  if (
    !current.name ||
    !current.d1_databases?.find((b) => b.binding === "DB") ||
    !current.r2_buckets?.find((b) => b.binding === "MEDIA")
  )
    throw Error(
      "Configuração da instalação incompleta. Nenhum deploy foi iniciado.",
    );
  const merged = structuredClone(current);
  for (const key of [
    "main",
    "compatibility_date",
    "compatibility_flags",
    "assets",
  ])
    if (Object.hasOwn(next, key)) merged[key] = next[key];
  // Keep account, domains, environments, resources, limits and variables from this installation.
  merged.triggers = {
    ...current.triggers,
    crons: [
      ...new Set([
        ...(current.triggers?.crons || []),
        ...(next.triggers?.crons || []),
      ]),
    ],
  };
  merged.vars = { ...next.vars, ...current.vars };
  // New bindings need a deliberate provisioning step, never silently replace DB or MEDIA.
  for (const group of [
    "d1_databases",
    "r2_buckets",
    "kv_namespaces",
    "services",
  ])
    for (const required of next[group] || [])
      if (!current[group]?.some((b) => b.binding === required.binding))
        throw Error(
          `A versão exige uma nova ligação ${required.binding}. Atualize pelo guia.`,
        );
  for (const required of next.durable_objects?.bindings || [])
    if (
      !current.durable_objects?.bindings?.some(
        (b) =>
          b.name === required.name &&
          b.class_name === required.class_name &&
          b.script_name === required.script_name,
      )
    )
      throw Error(
        "A versão altera Durable Objects. Atualização manual necessária.",
      );
  for (const key of Object.keys(next))
    if (
      ![
        "$schema",
        "name",
        "main",
        "account_id",
        "compatibility_date",
        "compatibility_flags",
        "assets",
        "vars",
        "d1_databases",
        "r2_buckets",
        "kv_namespaces",
        "services",
        "durable_objects",
        "migrations",
        "triggers",
        "observability",
        "workers_dev",
        "preview_urls",
        "routes",
        "route",
        "placement",
        "limits",
        "logpush",
      ].includes(key) &&
      !isDeepStrictEqual(next[key], current[key])
    )
      throw Error(
        `A versão altera a configuração ${key}. Atualização manual necessária.`,
      );
  const migrations = new Map((current.migrations || []).map((m) => [m.tag, m]));
  for (const migration of next.migrations || []) {
    if (
      !migrations.has(migration.tag) ||
      !isDeepStrictEqual(migrations.get(migration.tag), migration)
    )
      throw Error("Conflito em uma migração Durable Object já aplicada.");
    migrations.set(migration.tag, migration);
  }
  merged.migrations = [...migrations.values()];
  return merged;
}
function assertRegularTree(path) {
  if (lstatSync(path).isSymbolicLink())
    throw Error("O pacote contém um link simbólico inesperado.");
  if (lstatSync(path).isDirectory())
    for (const name of readdirSync(path)) assertRegularTree(join(path, name));
}
async function main() {
  const origin = process.env.WABOTIA_UPDATE_ORIGIN;
  if (!origin) {
    execFileSync("npm", ["run", "build"], { stdio: "inherit" });
    return;
  }
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error(
      "WABOTIA_UPDATE_ORIGIN deve ser apenas a origem HTTPS da instalação.",
    );
  let target;
  const response = await fetch(new URL("/api/system/update-plan", url), {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (
    response.ok &&
    response.headers.get("content-type")?.includes("application/json")
  ) {
    const plan = await response.json();
    if (plan.repository !== "Quevenapp/Wabotia" || !checkedSha(plan.commit))
      throw Error("Plano de atualização inválido.");
    target = plan.commit;
  } else if (
    process.env.WABOTIA_BOOTSTRAP_COMMIT &&
    checkedSha(process.env.WABOTIA_BOOTSTRAP_COMMIT)
  ) {
    // Only the first upgrade from a version without the update endpoint uses this explicitly pinned SHA.
    target = process.env.WABOTIA_BOOTSTRAP_COMMIT;
  } else
    throw Error(
      "Não foi possível ler o plano da instalação. Nenhum deploy foi iniciado.",
    );
  const current = parse(readFileSync("wrangler.jsonc", "utf8"));
  const packageName = JSON.parse(readFileSync("package.json", "utf8")).name;
  const stage = mkdtempSync(join(tmpdir(), "wabotia-source-"));
  try {
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", upstream, stage],
      { stdio: "inherit" },
    );
    execFileSync("git", [
      "-C",
      stage,
      "merge-base",
      "--is-ancestor",
      target,
      "origin/main",
    ]);
    execFileSync("git", ["-C", stage, "checkout", "--detach", target], {
      stdio: "inherit",
    });
    const merged = preserveDeployment(
      current,
      parse(readFileSync(join(stage, "wrangler.jsonc"), "utf8")),
    );
    const files = [
      "src",
      "web",
      "public",
      "migrations",
      "scripts",
      "package.json",
      "package-lock.json",
      "vite.config.ts",
      "tsconfig.json",
      "index.html",
      "wabotia-build.mjs",
    ];
    for (const file of files) {
      const path = join(stage, file);
      if (existsSync(path)) {
        assertRegularTree(path);
        cpSync(path, resolve(file), { recursive: true });
      }
    }
    writeFileSync("wrangler.jsonc", JSON.stringify(merged, null, 2) + "\n");
    for (const file of ["package.json", "package-lock.json"]) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.name = packageName;
      if (data.packages?.[""]) data.packages[""].name = packageName;
      writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    }
    writeFileSync(".wabotia-source-commit", target + "\n");
    console.log(
      `Wabotia: preparando versão oficial ${target.slice(0, 12)}; recursos da instalação preservados.`,
    );
    execFileSync("npm", ["ci"], { stdio: "inherit" });
    execFileSync("npm", ["run", "check"], { stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
