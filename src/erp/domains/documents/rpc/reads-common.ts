// Utilitários das leituras do Documentos (sessão L): o que o SQL das leituras
// faz com ordem, texto e jsonb, com a semântica do oráculo.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { jsonbText } from "../../../engine/json.ts";
import { pgCompareText } from "../../../engine/text.ts";

/** ORDER BY de uuid no Postgres: os 16 bytes, a mesma ordem do texto em minúsculas. */
export const cmpUuid = (a: unknown, b: unknown) => pgCompareText(a === null || a === undefined ? null : String(a), b === null || b === undefined ? null : String(b));

/** Comparação de text[] do Postgres: elemento a elemento (collation C), depois o tamanho. */
export function cmpTextArray(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = pgCompareText(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** Junta comparadores (ORDER BY x, y, …). */
export const by =
  <T>(...cmps: ((a: T, b: T) => number)[]) =>
  (a: T, b: T) => {
    for (const c of cmps) {
      const r = c(a, b);
      if (r) return r;
    }
    return 0;
  };

/** jsonb ? texto: chave de objeto, elemento texto de array ou o próprio texto escalar. */
export function jsonbHas(v: unknown, key: string): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.some((x) => x === key);
  if (typeof v === "object") return Object.prototype.hasOwnProperty.call(v, key);
  return v === key;
}

/** exists(select 1 from erp_access.membership where user_id=? and active and role='admin') */
export const isAdmin = (db: SqlDriver, user: string | null) =>
  user !== null && !!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user);

/** Validação comum de uuid[] das leituras: 1 a `max`, sem nulo e sem repetição. */
export const validIdList = (ids: unknown, max = 250): ids is string[] =>
  Array.isArray(ids) && ids.length >= 1 && ids.length <= max && !ids.includes(null) && new Set(ids).size === ids.length;

/** Booleano lido do SQLite (0/1). */
export const bool = (v: unknown) => v === 1 || v === "1" || v === true;

/** v #>> '{a,b,…}': o texto no caminho (objetos; índice inteiro em array), ou null. */
export function jsonPathText(v: unknown, path: string[]): string | null {
  let cur: unknown = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return null;
    if (Array.isArray(cur)) {
      if (!/^-?[0-9]+$/.test(k)) return null;
      const i = Number(k);
      cur = cur[i < 0 ? cur.length + i : i];
    } else cur = (cur as Record<string, unknown>)[k];
    if (cur === undefined) return null;
  }
  if (cur === null) return null;
  return typeof cur === "string" ? cur : jsonbText(cur);
}

/** erp_documents.rich_text_plain(p_value): o texto dos blocos (runs juntos, blocos por quebra de linha); null sem blocos. */
export function richTextPlain(value: unknown): string | null {
  const blocks = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).blocks : undefined;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return blocks
    .map((b) => {
      const runs = b !== null && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>).runs : undefined;
      if (!Array.isArray(runs)) return "";
      return runs
        .map((r) => (r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>).text : undefined))
        .filter((t) => t !== undefined && t !== null)
        .map((t) => (typeof t === "string" ? t : jsonbText(t)))
        .join("");
    })
    .join("\n");
}
