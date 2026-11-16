// Teste de build do ERP no painel (PLANO-FAGOO-PAINEL.md, B): roda o build do
// Vite em memória e confere a divisão dos arquivos.
//   - nada de web/erp/app, packages/ ou do react-router no pacote inicial;
//   - o ERP em 30 a 50 arquivos JS, agrupados por módulo do menu;
//   - a demonstração (web/erp/demo) num chunk próprio, sem o resto do ERP;
//   - nenhum arquivo de QA nem marcador sintético do Fagoo na saída.
// `ERP_BUILD_REPORT=1` imprime a tabela de tamanhos.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { inspectBuildFile } from "./test/upstream/tools/qa/check-erp-build.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const norm = (id) => id.replaceAll("\\", "/");
const isErp = (id) => /\/web\/erp\/(app|screens)\/|\/packages\//.test(norm(id));
const isDemo = (id) => /\/web\/erp\/demo\//.test(norm(id));

let output;
test.before(async () => {
  const result = await build({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "silent",
    build: { write: false, outDir: "dist-test-erp" },
  });
  output = (Array.isArray(result) ? result[0] : result).output;
});

const chunks = () => output.filter((item) => item.type === "chunk");
function initialChunks() {
  const byName = new Map(chunks().map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks().find(
    (chunk) => chunk.isEntry && /index/.test(chunk.name),
  );
  assert.ok(entry, "chunk de entrada do painel");
  const seen = new Set([entry.fileName]),
    stack = [entry];
  while (stack.length)
    for (const name of stack.pop().imports)
      if (!seen.has(name)) {
        seen.add(name);
        stack.push(byName.get(name));
      }
  return [...seen].map((name) => byName.get(name));
}

test("o pacote inicial do painel não leva o ERP, a demonstração nem o react-router", () => {
  const offenders = initialChunks().flatMap((chunk) =>
    chunk.moduleIds
      .filter(
        (id) =>
          isErp(id) ||
          isDemo(id) ||
          /node_modules\/react-router/.test(norm(id)),
      )
      .map((id) => `${chunk.fileName}: ${norm(id).replace(norm(root), "")}`),
  );
  assert.deepEqual(offenders, []);
});

test("o ERP fica em 30 a 50 arquivos JS, e a demonstração num chunk só dela", () => {
  const erp = chunks().filter((chunk) => chunk.moduleIds.some(isErp));
  const demo = chunks().filter((chunk) => chunk.moduleIds.some(isDemo));
  if (process.env.ERP_BUILD_REPORT) {
    const rows = [...erp, ...demo.filter((c) => !erp.includes(c))]
      .map((c) => [c.fileName, c.code.length, gzipSync(c.code).length])
      .sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((sum, r) => sum + r[1], 0),
      gz = rows.reduce((sum, r) => sum + r[2], 0);
    for (const [name, size, zipped] of rows)
      console.log(
        `${name.padEnd(60)} ${(size / 1024).toFixed(1).padStart(8)} kB ${(zipped / 1024).toFixed(1).padStart(7)} kB gz`,
      );
    console.log(
      `ERP: ${erp.length} arquivos JS, ${(total / 1024).toFixed(0)} kB (${(gz / 1024).toFixed(0)} kB gz)`,
    );
    const initial = initialChunks();
    const size = initial.reduce((sum, c) => sum + c.code.length, 0);
    console.log(
      `Pacote inicial: ${initial.length} arquivo(s), ${(size / 1024).toFixed(1)} kB (${(initial.reduce((s, c) => s + gzipSync(c.code).length, 0) / 1024).toFixed(1)} kB gz)`,
    );
  }
  assert.ok(
    erp.length >= 30 && erp.length <= 50,
    `ERP em ${erp.length} arquivos`,
  );
  assert.ok(demo.length >= 1, "demonstração presente");
  for (const chunk of demo)
    assert.ok(
      !chunk.moduleIds.some(isErp),
      `${chunk.fileName} mistura demo e ERP`,
    );
});

test("nenhum arquivo nem marcador de QA do Fagoo na saída", () => {
  const failures = output
    .map((item) =>
      inspectBuildFile(
        item.fileName,
        item.type === "chunk" ? item.code : item.source,
      ),
    )
    .filter((report) => report.failures.length);
  assert.deepEqual(failures, []);
  assert.ok(
    !output.some((item) =>
      /(^|\/)[^/]*-qa\.html$|(^|\/)qa\.html$/.test(item.fileName),
    ),
  );
});
