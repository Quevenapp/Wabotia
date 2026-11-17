#!/usr/bin/env node
// Suíte de cada rodada do tronco (docs/ERP-PORTE.md, "Suíte do tronco"):
//   1. npm run check (build-info, marcas de conflito, codificação, tsc 5.9);
//   2. tsc 7, quando houver (ERP_TSC7 ou o do worktree do painel);
//   3. test:erp (3 arquivos ao mesmo tempo);
//   4. vitest com 3 trabalhadores: inteiro ou só o do motor.
// Vitest inteiro quando:
//   - --full (rodada cujo hash vai à instalação de teste sem a junção da M);
//   - a junção traz migração do D1 (migrations/);
//   - a junção toca arquivo fora de src/erp, tests/erp, scripts/erp e docs;
//   - a costura ou a montagem mudou (src/erp/api, src/index.ts);
//   - guarda: o último vitest inteiro foi há mais de 24 h ou há 2 rodadas.
// Senão, só o do motor: tests/erp-*.test.ts, tests/erp/**/*.test.ts e o que
// importa ../src/erp.
// No fim imprime qual vitest rodou e por quê, as contagens e os tempos.
//   node scripts/erp/test-trunk.mjs [--base <ref>] [--full] [--plan]
// --plan: só diz qual vitest rodaria e por quê.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = arg("--base") ?? "origin/feat/erp-motor";
const STATE = "output/test-trunk-state.json";
const DAY = 24 * 3600 * 1000;

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const changed = git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
const outside = changed.filter((f) => !/^(src\/erp\/|tests\/erp\/|tests\/erp-[^/]*\.test\.ts$|scripts\/erp\/|docs\/)/.test(f));
const migrations = changed.filter((f) => f.startsWith("migrations/"));
const seam = changed.filter((f) => f.startsWith("src/erp/api/") || f === "src/index.ts");
let state = { at: 0, rounds: 0 };
try {
  state = JSON.parse(readFileSync(STATE, "utf8"));
} catch {}
const reasons = [];
if (args.includes("--full")) reasons.push("--full (hash para a instalação de teste)");
if (migrations.length) reasons.push(`migração do D1: ${migrations.join(", ")}`);
if (outside.length) reasons.push(`${outside.length} arquivo(s) fora do motor (ex.: ${outside.slice(0, 3).join(", ")})`);
if (seam.length) reasons.push(`costura ou montagem: ${seam.join(", ")}`);
if (Date.now() - state.at > DAY) reasons.push("guarda: último vitest inteiro há mais de 24 h");
else if (state.rounds >= 2) reasons.push(`guarda: ${state.rounds} rodadas sem vitest inteiro`);
const full = reasons.length > 0;

const results = [];
function step(label, cmd, cmdArgs, { parse } = {}) {
  const t = Date.now();
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 512 * 1024 * 1024 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const minutes = ((Date.now() - t) / 60000).toFixed(1);
  const summary = parse ? parse(out) : "";
  results.push({ label, ok: r.status === 0, minutes, summary });
  mkdirSync("output", { recursive: true });
  writeFileSync(join("output", `test-trunk-${label.replace(/[^a-z0-9]+/gi, "-")}.log`), out);
  console.log(`${r.status === 0 ? "ok  " : "FALHA"} ${label} (${minutes} min) ${summary}`);
  return r.status === 0;
}
const tapCounts = (out) => ["tests", "pass", "fail", "todo"].map((k) => `${k} ${(new RegExp(`^# ${k} (\\d+)`, "m").exec(out) ?? [])[1] ?? "?"}`).join(", ");
const vitestCounts = (out) => [/Test Files\s+(.*)/.exec(out)?.[1], /Tests\s+(.*)/.exec(out)?.[1]].filter(Boolean).join(" | ");

if (args.includes("--plan")) {
  console.log(full ? `vitest INTEIRO, porque: ${reasons.join("; ")}.` : "vitest só do MOTOR.");
  process.exit(0);
}
let ok = step("check", "npm", ["run", "check"]);
const tsc7 = process.env.ERP_TSC7 ?? "D:/Code/wabotia/Wabotia-erp-painel/node_modules/.bin/tsc.cmd";
if (existsSync(tsc7)) ok = step("tsc 7", tsc7, ["--noEmit", "-p", "."]) && ok;
ok = step("test:erp", "npm", ["run", "test:erp"], { parse: tapCounts }) && ok;
let vitestFiles = [];
if (!full) {
  const top = readdirSync("tests").filter((n) => n.endsWith(".test.ts"));
  const engine = top.filter((n) => n.startsWith("erp-") || /from ["']\.\.\/src\/erp\//.test(readFileSync(join("tests", n), "utf8")));
  const nested = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? nested(join(dir, e.name)) : e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
  vitestFiles = [...engine.map((n) => join("tests", n)), ...(existsSync("tests/erp") ? nested("tests/erp") : [])].map((f) => f.replace(/\\/g, "/"));
}
ok = step(full ? "vitest inteiro" : "vitest do motor", "npx", ["vitest", "run", "--maxWorkers=3", ...vitestFiles], { parse: vitestCounts }) && ok;
if (ok) writeFileSync(STATE, JSON.stringify(full ? { at: Date.now(), rounds: 0 } : { ...state, rounds: state.rounds + 1 }));

console.log("\n== Suíte do tronco ==");
console.log(`base ${base} (${changed.length} arquivo(s) na junção)`);
console.log(full ? `vitest INTEIRO, porque: ${reasons.join("; ")}.` : `vitest só do MOTOR (${vitestFiles.length} arquivos): a junção não toca o núcleo, não traz migração e o vitest inteiro rodou há ${state.rounds} rodada(s).`);
for (const r of results) console.log(`- ${r.label}: ${r.ok ? "ok" : "FALHA"}, ${r.minutes} min${r.summary ? `, ${r.summary}` : ""}`);
process.exit(ok ? 0 : 1);
