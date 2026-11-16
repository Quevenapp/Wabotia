// Texto com a semântica do Postgres do oráculo (ctype C.UTF-8), para todos os
// domínios. Não use toLowerCase/toUpperCase nem \s do JS onde o Fagoo usa
// lower/upper ou \s/[[:space:]]/[[:cntrl:]]:
// - lower/upper do Postgres são caractere a caractere (mapeamento simples):
//   sem sigma final ('ΟΔΟΣ' → 'οδοσ'), 'İ' → 'i', 'ß' → 'ẞ' no upper, e a
//   tabela Unicode do Postgres (alguns caracteres novos ficam como estão);
// - \s do Postgres não pega NBSP (U+00A0), U+1680, U+2007, U+202F, U+FEFF e
//   pega U+0085; o \s do JS é o contrário nesses;
// - [[:cntrl:]] pega C0, DEL e C1 (U+0080–U+009F).
// Tabelas em text.generated.ts (scripts/erp/gen-text.mjs); prova em
// tests/erp/text.test.mjs contra o oráculo.
import { PG_CNTRL_CLASS, PG_LOWER, PG_SPACE_CLASS, PG_UPPER } from "./text.generated.ts";

function mapChars(s: string, table: Record<number, number>, js: (c: string) => string) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const fixed = table[cp];
    out += fixed !== undefined ? String.fromCodePoint(fixed) : js(ch);
  }
  return out;
}

/** lower() do Postgres. */
export const pgLower = (s: string) => mapChars(s, PG_LOWER, (c) => c.toLowerCase());
/** upper() do Postgres. */
export const pgUpper = (s: string) => mapChars(s, PG_UPPER, (c) => c.toUpperCase());

/** Classe \s / [[:space:]] do Postgres, para montar RegExp com a flag "u". */
export const PG_SPACE = PG_SPACE_CLASS;
/** Classe [[:cntrl:]] do Postgres, para RegExp com a flag "u". */
export const PG_CNTRL = PG_CNTRL_CLASS;
/** RegExp prontas (flag "u"). */
export const pgHasSpace = new RegExp(PG_SPACE, "u");
export const pgHasCntrl = new RegExp(PG_CNTRL, "u");

/** btrim(x) do Postgres: só espaço (U+0020) nas pontas. */
export const pgBtrim = (s: string) => s.replace(/^ +| +$/g, "");
/** length() do Postgres: caracteres (pontos de código), não unidades UTF-16. */
export const pgLength = (s: string) => [...s].length;
/** left(x, n) do Postgres. */
export const pgLeft = (s: string, n: number) => [...s].slice(0, Math.max(n, 0)).join("");
