#!/usr/bin/env node
// Build local apenas: nunca chama release, publica, instala dependências ou altera uma branch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REFERENCE = "20e15da9";
export const MAX_DELTA = 524_288;
export const MAX_TOTAL = 41_943_040;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const normalized = path => path.replaceAll("\\", "/");

/** Mesmas exclusões de scripts/release.mjs: sourcemaps e README não são módulos enviados. */
export function measureModules(directory) {
  const files = [];
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Módulo é um vínculo, medição recusada: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (!entry.name.endsWith(".map") && entry.name !== "README.md") {
        const bytes = readFileSync(path);
        files.push({ name: normalized(relative(directory, path)), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  visit(directory);
  if (!files.some(file => file.name === "index.js")) throw Error("Build sem index.js: não há pacote Worker para medir.");
  return { bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

export function checkBudget(base, current) {
  for (const [name, value] of Object.entries({ base, current })) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw Error(`Medição ${name} inválida.`);
  }
  const delta = current.bytes - base.bytes;
  return { baseBytes: base.bytes, currentBytes: current.bytes, deltaBytes: delta,
    maxDeltaBytes: MAX_DELTA, maxTotalBytes: MAX_TOTAL,
    passed: delta <= MAX_DELTA && current.bytes <= MAX_TOTAL };
}

function insideWorkspace(path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../"))
    throw Error("Saída do build resolve para fora desta cópia de trabalho.");
  return path;
}

function runNode(source, args, environment) {
  execFileSync(process.execPath, args, {
    cwd: source, stdio: "inherit", windowsHide: true, env: environment,
    timeout: 10 * 60_000,
  });
}

/** Invocação idêntica à parte Worker do release, sem executar o release inteiro. */
export function buildBundle(source, outdir, commit) {
  insideWorkspace(source);
  mkdirSync(outdir, { recursive: true });
  insideWorkspace(outdir);
  const configHome = join(outdir, "..", "config");
  mkdirSync(configHome, { recursive: true });
  insideWorkspace(configHome);
  const require = createRequire(join(root, "package.json"));
  const wranglerPackage = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(wranglerPackage, "utf8"));
  const cli = resolve(dirname(wranglerPackage), typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler);
  // Credenciais não são necessárias ao dry-run, obrigatório e sem opção de publicação.
  const environment = { ...process.env, WABOTIA_SOURCE_COMMIT: commit, WRANGLER_SEND_METRICS: "false",
    CI: "true", XDG_CONFIG_HOME: configHome, WRANGLER_LOG_PATH: join(configHome, "wrangler.log") };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN", "CF_API_KEY", "CF_EMAIL", "CLOUDFLARE_ENV"])
    delete environment[key];
  runNode(source, [join(source, "scripts", "build-info.mjs")], environment);
  // Assets não entram no somatório dos módulos. No snapshot basta uma pasta vazia.
  if (!existsSync(join(source, "dist"))) mkdirSync(join(source, "dist"));
  const command = [cli, "deploy", "--dry-run", "--minify", "--outdir", outdir, "--config", join(source, "wrangler.jsonc")];
  runNode(source, command, environment);
  return { ...measureModules(outdir), wranglerVersion: pkg.version,
    command: ["node", normalized(relative(root, cli)), ...command.slice(1)].map(normalized) };
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

/** Identifica também fontes não commitadas; o HEAD sozinho não identifica o resultado. */
export function workingTreeFingerprint() {
  const names = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  const entries = [...new Set(names)].map(name => ({ name,
    sha256: existsSync(join(root, name)) && statSync(join(root, name)).isFile() ? hash(readFileSync(join(root, name))) : null }));
  return { sha256: hash(JSON.stringify(entries)), files: entries,
    dirty: Boolean(git(["status", "--porcelain=v1", "--untracked-files=all"]).trim()) };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    assert.equal(checkBudget({ bytes: 100 }, { bytes: 100 + MAX_DELTA }).passed, true);
    assert.equal(checkBudget({ bytes: 100 }, { bytes: 101 + MAX_DELTA }).passed, false);
    assert.equal(checkBudget({ bytes: MAX_TOTAL }, { bytes: MAX_TOTAL + 1 }).passed, false);
    assert.equal(checkBudget({ bytes: 200 }, { bytes: 100 }).deltaBytes, -100);
    assert.throws(() => checkBudget({ bytes: NaN }, { bytes: 1 }));
    const folder = join(root, "output", "cn-aceite", "self-test");
    mkdirSync(folder, { recursive: true });
    insideWorkspace(folder);
    const fixture = mkdtempSync(join(folder, "bundle-"));
    writeFileSync(join(fixture, "index.js"), "/* árvore sintética: não é o Worker */\n", "utf8");
    writeFileSync(join(fixture, "README.md"), "não enviado", "utf8");
    writeFileSync(join(fixture, "index.js.map"), "não enviado", "utf8");
    writeFileSync(join(fixture, "extra.wasm"), Buffer.from([0, 97, 115, 109]));
    const measured = measureModules(fixture);
    assert.deepEqual(measured.files.map(file => file.name), ["extra.wasm", "index.js"]);
    assert.equal(measured.bytes, Buffer.byteLength("/* árvore sintética: não é o Worker */\n") + 4);
    console.log("Autotestes do orçamento aprovados; nenhum build ou medição do Worker foi executado.");
    return;
  }
  if (process.argv.length > 2) throw Error("Opção desconhecida. Use sem argumentos ou --self-test.");
  const { ensureBaseline } = await import("./cn-baseline.mjs");
  const snapshot = await ensureBaseline(root);
  const referencePath = join(root, "output", "cn-aceite", "baseline-reference.json");
  const reference = JSON.parse(readFileSync(referencePath, "utf8"));
  if (reference.reference !== REFERENCE || !/^[a-f0-9]{40}$/.test(reference.commit))
    throw Error("Baseline não identifica o commit contratual 20e15da9.");
  const baseline = snapshot?.directory || join(root, "output", "cn-aceite", "baseline");
  const commit = git(["rev-parse", "HEAD"]).trim();
  const source = workingTreeFingerprint();
  const folder = join(root, "output", "cn-aceite", "bundle");
  mkdirSync(folder, { recursive: true });
  insideWorkspace(folder);
  // Diretório novo impede aprovar módulos antigos após build interrompido.
  const run = mkdtempSync(join(folder, "run-"));
  const base = buildBundle(baseline, join(run, "base"), reference.commit);
  const current = buildBundle(root, join(run, "current"), commit);
  if (base.wranglerVersion !== current.wranglerVersion) throw Error("Builds usaram versões diferentes do Wrangler.");
  if (workingTreeFingerprint().sha256 !== source.sha256)
    throw Error("As fontes mudaram durante a medição; repita o build antes de aceitar o pacote.");
  const budget = checkBudget(base, current);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), reference,
    result: { commit, source }, base, current, budget, published: false };
  writeFileSync(join(root, "output", "cn-aceite", "bundle.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(budget, null, 2));
  if (!budget.passed) throw Error("Pacote reprovado: delta ou teto absoluto de A1 excedido. Consulte output/cn-aceite/bundle.json.");
  console.log("Pacote aprovado pelos limites de A1. Nada foi publicado.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
