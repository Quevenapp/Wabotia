// Guarda: toda rota do Worker precisa ser alcançável em produção. Lá, os
// arquivos estáticos respondem primeiro e só os caminhos de `run_worker_first`
// (wrangler.jsonc) chegam ao Worker; o resto recebe o index.html do painel
// (página única). Já aconteceu duas vezes: /imagemwa e /c/<código>. Este
// teste lê as rotas registradas no código (app.get/post/…/on, inclusive em
// laços e constantes) e confere cada caminho contra os padrões. Exceção
// legítima vai em EXCEPTIONS, com o motivo.
import { describe, expect, it } from "vitest";
import wrangler from "../wrangler.jsonc?raw";

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Rotas que existem de propósito fora de `run_worker_first` (alcançadas por
 * outro meio). Caminho exatamente como registrado → motivo.
 */
const EXCEPTIONS: Record<string, string> = {};

/** Padrões de run_worker_first como expressões regulares. */
function workerFirst() {
  const match = wrangler.match(/"run_worker_first"\s*:\s*(\[[^\]]*\])/);
  if (!match)
    throw new Error("run_worker_first não encontrado em wrangler.jsonc");
  return (JSON.parse(match[1]) as string[]).map(
    (glob) =>
      new RegExp(
        "^" +
          glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$",
      ),
  );
}

/** Constantes de texto que começam com "/" (export const X = "/…"). */
function constants() {
  const out = new Map<string, string>();
  for (const src of Object.values(sources))
    for (const m of src.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])(\/[^"'`]*)\2/g,
    ))
      out.set(m[1], m[3]);
  return out;
}

interface Found {
  file: string;
  method: string;
  path: string;
}

/** Rotas registradas: o caminho literal, a constante ou os itens do laço. */
export function registeredRoutes(): { routes: Found[]; unresolved: string[] } {
  const known = constants();
  const routes: Found[] = [];
  const unresolved: string[] = [];
  const call = /\bapp\.(get|post|put|patch|delete|all|on)\(/g;
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(call)) {
      const head = src.slice(m.index! + m[0].length, m.index! + 400);
      // app.on(MÉTODO ou [MÉTODOS], caminho, …): pula o primeiro argumento.
      const args =
        m[1] === "on"
          ? head.replace(/^\s*(\[[^\]]*\]|"[^"]*"|[^,]+),\s*/, "")
          : head;
      const literal = args.match(/^\s*([`"'])(\/[^`"']*)\1/);
      if (literal) {
        routes.push({ file, method: m[1], path: literal[2] });
        continue;
      }
      const name = args.match(/^\s*([A-Za-z_$][\w$]*)\s*[,)]/)?.[1];
      if (name && known.has(name)) {
        routes.push({ file, method: m[1], path: known.get(name)! });
        continue;
      }
      // Laço logo antes: for (const … of [ "/a", ["/b", …] ]).
      const before = src.slice(Math.max(0, m.index! - 1200), m.index!);
      const loop = [
        ...before.matchAll(/for\s*\(\s*const\s+[^)]*?\bof\s*\[/g),
      ].pop();
      const items = loop
        ? [...before.slice(loop.index!).matchAll(/(["'`])(\/[^"'`]*)\1/g)].map(
            (x) => x[2],
          )
        : [];
      if (name && items.length) {
        for (const path of items) routes.push({ file, method: m[1], path });
        continue;
      }
      unresolved.push(
        `${file}: app.${m[1]}(${head.split("\n")[0].slice(0, 80)}`,
      );
    }
  }
  return { routes, unresolved };
}

describe("rotas do Worker alcançáveis em produção", () => {
  it("toda rota casa com run_worker_first ou é exceção declarada", () => {
    const patterns = workerFirst();
    const { routes, unresolved } = registeredRoutes();
    // A leitura achou as rotas (sanidade da própria guarda).
    expect(routes.length).toBeGreaterThan(100);
    expect(unresolved, "rota com caminho que a guarda não soube ler").toEqual(
      [],
    );
    const unreachable = routes
      .filter((r) => !(r.path in EXCEPTIONS))
      .filter((r) => {
        // Parâmetros e trechos ${…} viram um segmento qualquer.
        const sample = r.path
          .replace(/\$\{[^}]*\}/g, "x")
          .replace(/:[A-Za-z_]\w*/g, "x");
        return !patterns.some((p) => p.test(sample));
      })
      .map(
        (r) =>
          `${r.method.toUpperCase()} ${r.path} (${r.file.replace("../", "")})`,
      );
    expect(
      unreachable,
      "rota fora de run_worker_first: mova para /api/… ou declare em EXCEPTIONS com o motivo",
    ).toEqual([]);
  });

  it("exceções declaradas existem no código", () => {
    const paths = new Set(registeredRoutes().routes.map((r) => r.path));
    for (const path of Object.keys(EXCEPTIONS)) expect(paths).toContain(path);
  });
});
