// Gera web/erp/scope.css: dentro de .fagoo-root, desfaz as regras globais do
// painel que alcançariam as telas do Fagoo (PLANO-FAGOO-PAINEL.md, B).
//
//   node scripts/erp-scope-css.mjs          grava web/erp/scope.css
//   node scripts/erp-scope-css.mjs --check  falha se o arquivo estiver velho
//
// Entram as regras do painel (web/**/*.css, fora de web/erp) cujo seletor não
// tem classe nem id (elementos, atributos, pseudoclasses) e as que usam uma das
// classes que o Fagoo também usa. Cada uma vira
//   :where(.fagoo-root) <seletor> { <propriedades>: revert }
// com a mesma especificidade da original e depois dela: vence o painel e perde
// para qualquer regra do Fagoo (que leva .fagoo-root, uma classe a mais).
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";

const root = join(import.meta.dirname, "..");
const out = join(root, "web/erp/scope.css");

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== join(root, "web/erp")) walk(path, files);
    } else if (name.endsWith(".css")) files.push(path);
  }
  return files;
}
const panel = walk(join(root, "web")).sort();

const classesOf = (css) =>
  new Set(
    [
      ...css
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/url\([^)]*\)/g, "")
        .replace(/"[^"\n]*"|'[^'\n]*'/g, "")
        .matchAll(/\.(-?[_a-zA-Z][\w-]*)/g),
    ].map((m) => m[1]),
  );
const panelClasses = new Set();
for (const file of panel)
  for (const c of classesOf(readFileSync(file, "utf8"))) panelClasses.add(c);
const fagooClasses = new Set();
function walkAll(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkAll(path);
    else if (/\.css$/.test(name))
      for (const c of classesOf(readFileSync(path, "utf8")))
        fagooClasses.add(c);
    else if (/\.tsx?$/.test(name))
      for (const m of readFileSync(path, "utf8").matchAll(
        /className=\{?["'`]([^"'`]+)["'`]/g,
      ))
        m[1]
          .split(/\s+/)
          .forEach((c) => /^[\w-]+$/.test(c) && fagooClasses.add(c));
  }
}
walkAll(join(root, "web/erp/app"));
const shared = [...panelClasses].filter((c) => fagooClasses.has(c)).sort();

// Seletores de nível zero.
function split(list) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}
// Raízes do ERP: a área e as prévias de impressão anexadas ao <body> (web/erp/css-scope.ts).
const ROOTS = [
  ".fagoo-root",
  ".document-print-root",
  ".fiscal-print-root",
  ".stock-print-root",
  ".labels-print-root",
];
const WHERE = `:where(${ROOTS.join(", ")})`;
const themeHead = /^((?:html|:root)?\[data-theme[^\]]*\]|html|:root)(\s+|$)/;
function scoped(selector) {
  const head = themeHead.exec(selector);
  if (head && !head[2]) return null; // a própria raiz: tratada à parte
  if (head) return `${head[1]} ${WHERE} ${selector.slice(head[0].length)}`;
  if (/^body(\s|$)/.test(selector)) return null;
  return `${WHERE} ${selector}`;
}
const touches = (selector) => {
  const classes = [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(
    (m) => m[1],
  );
  // Sem classe nem id (elementos), ou só com classes que o Fagoo também usa.
  return !selector.includes("#") && classes.every((c) => shared.includes(c));
};

const blocks = [];
const seen = new Set();
for (const file of panel) {
  const tree = postcss.parse(readFileSync(file, "utf8"), { from: file });
  tree.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name))
      return;
    const selectors = split(rule.selector)
      .filter(touches)
      .map(scoped)
      .filter(Boolean);
    if (!selectors.length) return;
    const props = [
      ...new Set(
        rule.nodes
          .filter((n) => n.type === "decl" && !n.prop.startsWith("--"))
          .map((n) => n.prop),
      ),
    ];
    if (!props.length) return;
    let text = `${selectors.join(",\n")} {\n${props.map((p) => `  ${p}: revert;`).join("\n")}\n}`;
    for (
      let node = rule.parent;
      node && node.type === "atrule";
      node = node.parent
    )
      text = `@${node.name} ${node.params} {\n${text.replace(/^/gm, "  ")}\n}`;
    if (seen.has(text)) return;
    seen.add(text);
    blocks.push(`/* ${relative(root, file).replaceAll("\\", "/")} */\n${text}`);
  });
}

const css = `/*
 * GERADO por scripts/erp-scope-css.mjs: não edite à mão.
 * Desfaz dentro do ERP (.fagoo-root) as regras globais do painel: seletores de
 * elemento e as classes que os dois usam (${shared.join(", ")}).
 * A raiz volta ao tamanho de letra do navegador, que é a base do Fagoo.
 */
${ROOTS.join(",\n")} {
  font-size: medium;
  -webkit-font-smoothing: auto;
  text-rendering: auto;
}

${blocks.join("\n\n")}
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  if (current !== css) {
    console.error(
      "web/erp/scope.css está desatualizado: rode node scripts/erp-scope-css.mjs",
    );
    process.exit(1);
  }
} else {
  writeFileSync(out, css);
  console.log(
    `scope.css: ${blocks.length} regras, classes em comum: ${shared.join(" ")}`,
  );
}
