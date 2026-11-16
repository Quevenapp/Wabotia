#!/usr/bin/env node
// Testes do ERP de um domínio só, para validar um bloco sem pagar a suíte
// inteira (máquina compartilhada: docs/ERP-PORTE.md, "Testes na máquina
// compartilhada"). Roda, com no máximo 3 arquivos ao mesmo tempo:
//   - tests/erp/<domínio>/*.test.mjs;
//   - tests/erp/fagoo/<domínio>-*.test.mjs;
//   - tests/erp/<domínio>-*.test.mjs (diferenciais na raiz);
//   - com --harness, também tests/erp/harness/*.test.mjs;
//   - com --base, também os testes do motor (schema-parity, signatures, check-errors, deviations, text).
//   npm run test:erp:domain -- catalog [--harness] [--base]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const domain = args.find((a) => !a.startsWith("--"));
if (!domain || !/^[a-z]+$/.test(domain)) {
  console.error("Uso: npm run test:erp:domain -- <domínio> [--harness] [--base]");
  process.exit(2);
}
const list = (dir, keep) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".test.mjs") && keep(n)).map((n) => join(dir, n)) : []);
const files = [
  ...list(join("tests/erp", domain), () => true),
  ...list("tests/erp/fagoo", (n) => n.startsWith(`${domain}-`)),
  ...list("tests/erp", (n) => n.startsWith(`${domain}-`)),
  ...(args.includes("--harness") ? list("tests/erp/harness", () => true) : []),
  ...(args.includes("--base")
    ? ["schema-parity", "signatures", "check-errors", "deviations", "text"].map((n) => join("tests/erp", `${n}.test.mjs`))
    : []),
];
if (!files.length) {
  console.error(`Nenhum teste para o domínio "${domain}".`);
  process.exit(2);
}
console.log(`${files.length} arquivos:\n  ${files.join("\n  ")}`);
const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-concurrency=3", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
