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

test("o pacote inicial do painel cabe no orçamento", () => {
  // Medido em 16/11/2026 no integra/erp-painel (Vite 8): 1.227 kB (357 kB gz),
  // contra 1.190 kB (341 kB gz) do tronco integra/erp sem o ERP no mesmo Vite.
  // Do ERP entram ErpArea, modules.ts e o /v1/me antecipado de fetch-port.ts
  // (7,6 kB); o resto da diferença (~29 kB) é a ordem estrita de execução
  // (vite.config.ts), que vale para o pacote todo. Aqui, em KiB de caracteres.
  const initial = initialChunks();
  const raw = initial.reduce((sum, c) => sum + c.code.length, 0);
  const gz = initial.reduce((sum, c) => sum + gzipSync(c.code).length, 0);
  assert.ok(
    raw <= 1200 * 1024,
    `pacote inicial com ${(raw / 1024).toFixed(1)} kB`,
  );
  assert.ok(
    gz <= 352 * 1024,
    `pacote inicial com ${(gz / 1024).toFixed(1)} kB gz`,
  );
  const erp = initial
    .flatMap((c) => Object.entries(c.modules))
    .filter(([id]) => /\/web\/erp\//.test(norm(id)))
    .reduce((sum, [, m]) => sum + m.renderedLength, 0);
  assert.ok(
    erp <= 8 * 1024,
    `casca do ERP no pacote inicial com ${(erp / 1024).toFixed(1)} kB`,
  );
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

test("o núcleo do ERP não baixa telas dos blocos opcionais (Fiscal, Cobrança, PDV, Origin)", () => {
  const byName = new Map(chunks().map((chunk) => [chunk.fileName, chunk]));
  const closure = (chunk) => {
    const seen = new Set([chunk.fileName]),
      stack = [chunk];
    while (stack.length)
      for (const name of stack.pop().imports)
        if (!seen.has(name)) {
          seen.add(name);
          stack.push(byName.get(name));
        }
    return [...seen];
  };
  // A casca do ERP e as telas do núcleo (web/erp/screens, um arquivo por módulo).
  const core =
    /\/web\/erp\/(mount\.tsx|app\/components\/RealAccess\.tsx|screens\/(cadastros|documentos|estoque|financeiro|preferencias)\.ts)$/;
  const offenders = [],
    report = [];
  for (const chunk of chunks()) {
    const entry = chunk.moduleIds.map(norm).find((id) => core.test(id));
    if (!entry) continue;
    const blocks = closure(chunk).filter((name) =>
      /erp-(fiscal|cobranca|pdv)-/.test(name),
    );
    report.push(
      `${entry.replace(/^.*\/web\/erp\//, "")}: ${blocks.join(", ") || "nenhum"}`,
    );
    for (const name of blocks)
      if (/-telas-/.test(name)) offenders.push(`${entry} → ${name}`);
  }
  if (process.env.ERP_BUILD_REPORT)
    console.log("Arquivos de blocos que o núcleo baixa:\n" + report.join("\n"));
  assert.ok(report.length >= 6, "casca e telas do núcleo encontradas");
  assert.deepEqual(offenders, []);
});

test("a política de conteúdo libera só o CSS do boleto, pelo hash", async () => {
  // A prévia do boleto (ItauBoletoPreview) é um iframe srcdoc com um <style>
  // fixo (packages/boleto-preview); style-src não tem 'unsafe-inline'.
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../packages/boleto-preview/src/index.mjs", import.meta.url),
    "utf8",
  );
  const css = /const CSS = `([^`]*)`/.exec(source)?.[1];
  assert.ok(css && !css.includes("${"), "CSS fixo do boleto");
  const hash = `'sha256-${createHash("sha256").update(css).digest("base64")}'`;
  const headers = await readFile(
    new URL("../../public/_headers", import.meta.url),
    "utf8",
  );
  const styleSrc = /style-src ([^;]+);/.exec(headers)?.[1] ?? "";
  assert.ok(styleSrc.includes(hash), `style-src precisa de ${hash}`);
  assert.ok(!styleSrc.includes("'unsafe-inline'"));
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
