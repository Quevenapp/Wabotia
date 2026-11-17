// Escopo do CSS do ERP (PLANO-FAGOO-PAINEL.md, B): as folhas do Fagoo
// (web/erp/app/**/*.css) passam a valer só dentro de .fagoo-root.
//
//   :root { … }                     → .fagoo-root { … }
//   html { … } / body { … }         → .fagoo-root { … }
//   :root .x { … }                  → :root .fagoo-root .x   (mantém o +1 de especificidade)
//   :root[data-theme="dark"] { … }  → :root[data-theme="dark"] .fagoo-root
//   [data-theme="dark"] .x          → :root[data-theme="dark"] .fagoo-root .x
//   .x / button / *                 → .fagoo-root .x / .fagoo-root button / .fagoo-root *
//
// O tema continua no <html data-theme> (web/lib/theme.ts), que o Wabotia já
// mantém; dentro de @keyframes nada muda.
import type { Plugin as PostcssPlugin, Rule } from "postcss";

export const SCOPE = ".fagoo-root";
/**
 * Raízes das prévias de impressão: o Fagoo as anexa direto ao <body>, fora de
 * .fagoo-root (createPortal). Valem como escopo e mantêm o próprio seletor.
 */
export const PORTAL_ROOTS = [
  "document-print-root",
  "fiscal-print-root",
  "stock-print-root",
  "labels-print-root",
];
const PREFIX = `:is(${[SCOPE, ...PORTAL_ROOTS.map((c) => "." + c)].join(", ")})`;

/** Prefixa um seletor simples (sem vírgula). */
export function scopeSelector(selector: string): string {
  const text = selector.trim();
  // Primeiro composto: tudo até o primeiro combinador de descendência/filho/irmão fora de () e [].
  let depth = 0,
    end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) {
      end = i;
      break;
    }
  }
  const first = text.slice(0, end);
  const rest = text.slice(end).trim();
  const join = (head: string) => (rest ? `${head} ${rest}` : head);
  // body.classe-de-impressão: só o Fagoo põe essas classes no <body> (prévias).
  if (/^body\.[\w-]/.test(first)) return text;
  const root =
    /^(:root|html|body)((?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*)$/.exec(first);
  if (root) {
    const [, element, suffix] = root;
    // body:has(.x) → a raiz do ERP; :root[data-theme] → o tema mora no <html>.
    if (suffix && element === "body") return join(SCOPE + suffix);
    // Variáveis e tema valem também nas prévias anexadas ao <body>.
    if (suffix) return join(`:root${suffix} ${PREFIX}`);
    if (!rest) return PREFIX;
    // :root .x conta uma pseudoclasse a mais que .x; html/body, um elemento.
    return join(element === ":root" ? `:root ${PREFIX}` : PREFIX);
  }
  // [data-theme="dark"] .x: o tema mora no <html>.
  if (/^\[data-theme[^\]]*\]$/.test(first))
    return join(`:root${first} ${PREFIX}`);
  // A própria raiz de uma prévia de impressão (anexada ao <body>).
  if (PORTAL_ROOTS.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(first)))
    return text;
  return `${PREFIX} ${text}`;
}

/** Divide uma lista de seletores pelas vírgulas de nível zero. */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0,
    start = 0,
    quote = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) {
      if (c === quote && list[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const inKeyframes = (rule: Rule) => {
  for (let node = rule.parent; node; node = (node as any).parent)
    if (node.type === "atrule" && /keyframes$/i.test((node as any).name))
      return true;
  return false;
};

/** Plugin PostCSS: aplica scopeSelector às folhas que `include` aceita. */
export function fagooScope(include: (file: string) => boolean): PostcssPlugin {
  return {
    postcssPlugin: "wabotia-fagoo-scope",
    Once(root) {
      const file = (root.source?.input.file || "").replaceAll("\\", "/");
      if (!include(file)) return;
      root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        const scoped = [
          ...new Set(splitSelectors(rule.selector).map(scopeSelector)),
        ];
        rule.selector = scoped.join(",\n");
      });
    },
  };
}
