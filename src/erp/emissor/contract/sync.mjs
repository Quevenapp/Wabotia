// Atualiza a cópia versionada do contrato do cofre NFapi e regera os tipos.
//
//   node src/erp/emissor/contract/sync.mjs <caminho do openapi.json>
//   node src/erp/emissor/contract/sync.mjs            (só regera os tipos)
//
// Depois: rode tests/erp/emissor (o teste de contrato aponta o que o cliente
// precisa acompanhar) e confira a lista de diferenças impressa aqui.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractDiff, generateTypes } from "./generate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pinnedPath = join(here, "openapi.json");
const typesPath = join(here, "types.generated.ts");
const source = process.argv[2];

const pinned = JSON.parse(readFileSync(pinnedPath, "utf8"));
let spec = pinned;
if (source) {
  const text = readFileSync(source, "utf8");
  spec = JSON.parse(text);
  const differences = contractDiff(pinned, spec);
  console.log(
    differences.length
      ? `Diferenças para a cópia anterior (${pinned.info.version} → ${spec.info.version}):\n- ${differences.join("\n- ")}`
      : `Sem diferença de forma (${pinned.info.version} → ${spec.info.version}).`,
  );
  writeFileSync(pinnedPath, text.endsWith("\n") ? text : text + "\n");
}
writeFileSync(typesPath, generateTypes(spec));
console.log(`Tipos gerados: ${typesPath}`);
