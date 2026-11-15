// Falha (código 1) quando sobra marcador de conflito de merge em arquivo de
// texto do repositório. Roda em `npm run check` e antes de `npm test`, para
// uma junção mal resolvida não passar despercebida (docs incluídos).
//
// "<<<<<<< " e ">>>>>>> " no início da linha sempre contam. Uma linha só com
// "=======" conta apenas no arquivo que também tem um dos outros dois: em
// Markdown ela pode ser o sublinhado de um título.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const skipDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  ".wrangler",
  "tmp",
  ".vite",
  "coverage",
  "build",
]);
const textExt = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".sql",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
  ".py",
  ".kt",
  ".kts",
  ".swift",
  ".xml",
  ".gradle",
  ".sh",
  ".ps1",
]);

const open = /^<<<<<<< /m;
const close = /^>>>>>>> /m;

const found = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!skipDirs.has(name)) walk(path);
      continue;
    }
    if (!textExt.has(extname(name)) || stat.size > 5_000_000) continue;
    const text = readFileSync(path, "utf8");
    const strong = open.test(text) || close.test(text);
    if (!strong) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^(<<<<<<< |>>>>>>> )/.test(line) || /^=======$/.test(line))
        found.push(
          `${relative(root, path)}:${index + 1}: ${line.slice(0, 60)}`,
        );
    });
  }
}
walk(root);
if (found.length) {
  console.error(
    "Marcadores de conflito de merge não resolvidos:\n" + found.join("\n"),
  );
  process.exit(1);
}
