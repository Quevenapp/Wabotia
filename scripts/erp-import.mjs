// Copia o painel do ERP Fagoo para dentro do Vinki (PLANO-FAGOO-PAINEL.md, B).
//
//   node scripts/erp-import.mjs <raiz do Fagoo>
//
// O Fagoo é só leitura. Copia:
//   apps/erp/src/**          → web/erp/app/**   (quase intacto)
//   apps/erp/*-qa.html, qa.html → web/erp/qa/    (fora do build)
//   apps/erp/test/**         → web/erp/test/**  (testes de modelo, `npm run test:erp`)
//   packages/**              → packages/**      (só os arquivos alcançados pelos acima)
//   workers/erp-api, tools/qa → web/erp/test/upstream/** (referência dos testes)
// Caminhos relativos que mudam de lugar são reescritos e anotados. Ao fim
// grava web/erp/ORIGEM.json com a origem e o SHA-256 de cada arquivo.
//
// Arquivos que o Vinki alterou ou removeu depois da cópia (ORIGEM.json,
// `local`, com o motivo) não são sobrescritos nem recriados. Ao trazer uma
// versão nova do Fagoo, compare o sha256 de origem para ver o que mudou lá.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

const fagoo = resolve(process.argv[2] || "D:/Code/Fagoo");
const root = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  "..",
);
const manifestPath = join(root, "web/erp/ORIGEM.json");
const previous = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { files: {} };

// Testes que dependem do assinador e do DANFE do gateway A1 (xmldom, xml-crypto,
// pkijs, qrcode): o bloco A1/SEFAZ não é portado (PLANO-FAGOO.md, decisão 7).
const excludedTests = new Set([
  "fiscal-accountant-package-ui.test.mjs",
  "fiscal-danfe-access.test.mjs",
  "fiscal-danfe-client.test.mjs",
  "fiscal-danfe-ui.test.mjs",
  "fiscal-danfe.test.mjs",
  "fiscal-processed-document-access.test.mjs",
  "fiscal-processed-document-client.test.mjs",
  "fiscal-processed-document-parent.test.mjs",
  "fiscal-processed-document-ui.test.mjs",
  "fiscal-receipt-query-processed-ui.test.mjs",
  "fiscal-return-search-ui.test.mjs",
  "fiscal-wave-f-ui.test.mjs",
]);

const posixPath = (path) => path.replaceAll("\\", "/");
const rel = (path) => posixPath(relative(fagoo, path));

/** Destino no Vinki de um arquivo do Fagoo (caminho relativo à raiz), ou null. */
function target(source) {
  const r = rel(source);
  if (r.startsWith("apps/erp/src/")) return "web/erp/app/" + r.slice(13);
  if (r.startsWith("apps/erp/test/")) return "web/erp/test/" + r.slice(14);
  if (/^apps\/erp\/[^/]+\.html$/.test(r) && !r.endsWith("/index.html"))
    return "web/erp/qa/" + r.slice(9);
  // Bibliotecas que só os testes usam, guardadas no node_modules de um pacote
  // (jsQR, para ler o QR gerado): node_modules/ é ignorado pelo git.
  const vendored = /^packages\/[^/]+\/node_modules\/(.+)$/.exec(r);
  if (vendored) return "web/erp/test/upstream/vendor/" + vendored[1];
  if (r.startsWith("packages/")) return r;
  if (
    r.startsWith("..") ||
    (r.startsWith("apps/") && !r.startsWith("apps/erp/"))
  )
    return null;
  // API, ferramentas e fixtures que os testes leem: só referência.
  return "web/erp/test/upstream/" + r;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const code = /\.(?:[cm]?js|[cm]?tsx?|html)$/;
function resolveFile(from, spec) {
  const base = resolve(dirname(from), spec.split(/[?#]/)[0]);
  for (const candidate of [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".mjs",
    base + ".js",
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.mjs"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

// Literais './…' e '../…' (e src="/src/…" das páginas de QA).
const literal = /(['"`])(\.{1,2}\/[^'"`\n]*?)\1/g;
const htmlSrc = /(src|href)="\/src\/([^"]+)"/g;

function references(file, text) {
  const found = [];
  for (const match of text.matchAll(literal)) {
    const resolved = resolveFile(file, match[2]);
    if (resolved) found.push({ spec: match[2], resolved });
  }
  if (file.endsWith(".html"))
    for (const match of text.matchAll(htmlSrc)) {
      const resolved = resolveFile(
        join(fagoo, "apps/erp/index.html"),
        "./src/" + match[2],
      );
      if (resolved)
        found.push({ spec: "/src/" + match[2], resolved, html: true });
    }
  return found;
}

// 1. Entradas: o app inteiro, as páginas de QA e os testes (menos os do A1).
const entries = [
  ...walk(join(fagoo, "apps/erp/src")),
  ...readdirSync(join(fagoo, "apps/erp"))
    .filter((name) => name.endsWith(".html") && name !== "index.html")
    .map((name) => join(fagoo, "apps/erp", name)),
  ...walk(join(fagoo, "apps/erp/test")).filter(
    (path) => !excludedTests.has(posix.basename(rel(path))),
  ),
];

// 2. Fecho: tudo o que as entradas alcançam por caminho relativo.
const files = new Map();
const stack = [...entries];
while (stack.length) {
  const file = stack.pop();
  if (files.has(file)) continue;
  const to = target(file);
  if (!to) throw new Error(`Fora do mapa de cópia: ${rel(file)}`);
  files.set(file, to);
  // Biblioteca de terceiros: a licença e o package.json (que diz se o código é
  // CommonJS) vão junto.
  const library =
    /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(file);
  if (library)
    for (const name of ["LICENSE", "package.json"]) {
      const extra = join(library[1], name);
      if (existsSync(extra) && !files.has(extra)) stack.push(extra);
    }
  // Declarações de tipo ao lado do .mjs/.js (o TypeScript as lê no lugar do JS).
  for (const declaration of [
    file.replace(/\.mjs$/, ".d.mts"),
    file.replace(/\.js$/, ".d.ts"),
  ])
    if (
      declaration !== file &&
      existsSync(declaration) &&
      !files.has(declaration)
    )
      stack.push(declaration);
  if (code.test(file))
    for (const { resolved } of references(file, readFileSync(file, "utf8")))
      if (!files.has(resolved)) stack.push(resolved);
}

// 3. Cópia com reescrita dos caminhos que mudam de profundidade.
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = {
  source: {
    repository: "Fagoo",
    path: posixPath(fagoo),
    commit: fagooCommit(),
    copied_at: new Date().toISOString().slice(0, 10),
  },
  map: {
    "apps/erp/src": "web/erp/app",
    "apps/erp/*.html (QA)": "web/erp/qa",
    "apps/erp/test": "web/erp/test",
    packages: "packages",
    "workers/erp-api, tools/qa": "web/erp/test/upstream",
  },
  excluded_tests: [...excludedTests],
  local: previous.local || {},
  files: {},
};
let written = 0,
  rewritten = 0,
  kept = 0;
for (const [source, to] of [...files].sort((a, b) =>
  a[1].localeCompare(b[1]),
)) {
  const bytes = readFileSync(source);
  let out = bytes;
  let changed = false;
  if (code.test(source)) {
    let text = bytes.toString("utf8");
    for (const ref of references(source, text)) {
      if (!files.has(ref.resolved)) continue;
      let next;
      if (ref.html) next = "/" + files.get(ref.resolved);
      else {
        // Mantém a forma escrita (sem extensão, pasta com index): o mapa é por prefixo.
        const dest = target(
          resolve(dirname(source), ref.spec.split(/[?#]/)[0]),
        );
        if (!dest) continue;
        next =
          posix.relative(posix.dirname(to), dest) +
          ref.spec.slice(ref.spec.split(/[?#]/)[0].length);
        if (!next.startsWith(".")) next = "./" + next;
      }
      if (next !== ref.spec) {
        text = text.split(`'${ref.spec}'`).join(`'${next}'`);
        text = text.split(`"${ref.spec}"`).join(`"${next}"`);
        text = text.split("`" + ref.spec + "`").join("`" + next + "`");
        changed = true;
      }
    }
    // Testes: caminhos montados em texto (template strings, entryPoints do
    // esbuild relativos à raiz) que o resolvedor acima não enxerga.
    if (
      to.startsWith("web/erp/test/") &&
      !to.startsWith("web/erp/test/upstream/")
    ) {
      const before = text;
      text = text
        .replaceAll("../src/", "../app/")
        .replaceAll("apps/erp/src/", "web/erp/app/")
        .replaceAll("apps/erp/test/", "web/erp/test/");
      if (text !== before) changed = true;
    }
    if (changed) out = Buffer.from(text, "utf8");
  }
  const destination = join(root, to);
  const upstream = sha(bytes);
  // Alterado ou removido no Vinki (ORIGEM.json, `local`): fica como está.
  const local = manifest.local[to];
  if (local) {
    kept++;
    manifest.files[to] = {
      from: rel(source),
      sha256: upstream,
      ...(changed ? { rewritten: true } : {}),
    };
    continue;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, out);
  written++;
  if (changed) rewritten++;
  manifest.files[to] = {
    from: rel(source),
    sha256: upstream,
    ...(changed ? { rewritten: true, sha256_copy: sha(out) } : {}),
  };
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");

const byArea = {};
for (const to of Object.keys(manifest.files)) {
  const key = to.startsWith("packages/")
    ? to.split("/").slice(0, 2).join("/")
    : to.split("/").slice(0, 3).join("/");
  byArea[key] = (byArea[key] || 0) + 1;
}
console.log(
  `${written} copiados (${rewritten} com caminhos reescritos), ${kept} locais mantidos.`,
);
console.log(byArea);

function fagooCommit() {
  try {
    let gitdir = join(fagoo, ".git");
    if (statSync(gitdir).isFile())
      gitdir = readFileSync(gitdir, "utf8")
        .replace(/^gitdir:\s*/, "")
        .trim();
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const common = existsSync(join(gitdir, "commondir"))
      ? resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim())
      : gitdir;
    for (const dir of [gitdir, common]) {
      const loose = join(dir, ref);
      if (existsSync(loose))
        return `${ref.replace("refs/heads/", "")}@${readFileSync(loose, "utf8").trim()}`;
      const packed = join(dir, "packed-refs");
      if (existsSync(packed)) {
        const line = readFileSync(packed, "utf8")
          .split("\n")
          .find((l) => l.endsWith(" " + ref));
        if (line)
          return `${ref.replace("refs/heads/", "")}@${line.split(" ")[0]}`;
      }
    }
    return ref;
  } catch {
    return "desconhecido";
  }
}
