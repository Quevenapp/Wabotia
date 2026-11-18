// Executa os mesmos casos puros do vitest sem iniciar Worker nem acessar rede.
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { piiCases } from "../tests/pii-cases.mjs";
import { pdfCases } from "../tests/pdf-cases.mjs";
const api = {};
const modules = {};
for (const file of ["pdf-reader", "pii-mask", "pii-pdf", "bot-tools"]) {
  const source = await readFile(
    new URL(`../src/${file}.ts`, import.meta.url),
    "utf8",
  );
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  for (const [name, url] of Object.entries(modules))
    outputText = outputText.replaceAll(`"./${name}"`, JSON.stringify(url));
  modules[file] = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  Object.assign(api, await import(modules[file]));
}
for (const [name, check] of [...piiCases(api), ...pdfCases(api)]) {
  await check();
  console.log(`OK: ${name}`);
}
