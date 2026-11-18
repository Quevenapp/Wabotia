// Executa os mesmos casos puros do vitest sem iniciar Worker nem acessar rede.
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { piiCases } from "../tests/pii-cases.mjs";
const api = {};
for (const file of ["pii-mask", "pii-pdf", "bot-tools"]) {
  const source = await readFile(
    new URL(`../src/${file}.ts`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  Object.assign(
    api,
    await import(
      `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
    ),
  );
}
for (const [name, check] of piiCases(api)) {
  await check();
  console.log(`OK: ${name}`);
}
