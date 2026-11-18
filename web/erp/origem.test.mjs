// Confere a cópia do Fagoo contra web/erp/ORIGEM.json (scripts/erp-import.mjs):
//   - cada arquivo copiado tem o SHA-256 registrado (o da cópia, quando os
//     caminhos foram reescritos), salvo os da lista "local";
//   - os "removido"/"movido" da lista não existem mais;
//   - nenhum arquivo nas pastas copiadas fica fora do manifesto.
// Mudou um arquivo do Fagoo de propósito? Registre-o em "local", com o motivo.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./ORIGEM.json", import.meta.url), "utf8"),
);
const copied = ["web/erp/app", "web/erp/test", "web/erp/qa", "packages"];
const sha = (path) =>
  createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test("cada arquivo copiado do Fagoo é o da origem, salvo os da lista local", () => {
  const changed = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (manifest.local[path]) continue;
    if (!existsSync(join(root, path))) changed.push(`${path}: ausente`);
    else if (sha(path) !== (entry.sha256_copy ?? entry.sha256))
      changed.push(`${path}: alterado`);
  }
  assert.deepEqual(changed, [], "registre em ORIGEM.json (local) o motivo");
});

test("os arquivos removidos ou movidos da lista local não voltaram", () => {
  const back = Object.entries(manifest.local)
    .filter(([, reason]) => /^(removido|movido)/.test(reason))
    .map(([path]) => path)
    .filter((path) => existsSync(join(root, path)));
  assert.deepEqual(back, []);
});

test("o gerador de QR movido para web/lib continua byte a byte o do Fagoo", () => {
  // A mesma cópia entra por outro branch (via de entrega do Pedido); conteúdo
  // idêntico faz os dois se juntarem sem conflito.
  assert.equal(
    sha("web/lib/qr-code.ts"),
    manifest.files["web/erp/app/lib/qr-code.ts"].sha256,
  );
});

test("nenhum arquivo nas pastas copiadas fica fora do manifesto", () => {
  const known = new Set([
    ...Object.keys(manifest.files),
    ...Object.keys(manifest.local),
  ]);
  const extra = copied.flatMap((dir) => walk(dir)).filter((p) => !known.has(p));
  assert.deepEqual(extra, []);
});
