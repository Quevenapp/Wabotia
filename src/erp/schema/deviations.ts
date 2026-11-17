// Desvios deliberados do oráculo (Fagoo), cada um com o motivo e a decisão.
// Dois tipos:
// - "seed" (o padrão): valor inicial de dados de referência e de
//   preferências (uma linha da semeadura);
// - "function": um trecho literal no corpo de uma função do oráculo, para o
//   que a pessoa vê e não pode levar o nome do Fagoo (ex.: o nome do arquivo
//   baixado). Só texto de saída: regra, conversão, permissão e precisão do
//   banco e do motor nunca entram aqui.
// Esquema nunca entra aqui.
//
// Como vale:
// - scripts/erp/gen-sqlite.mjs confere cada item contra o oráculo e para se o
//   Fagoo mudou. "seed": a linha existe e o valor ainda é `oracle`; com
//   `applied: true`, troca o valor na semeadura (seed.generated.ts).
//   "function": o trecho `oracle` aparece exatamente uma vez no corpo da
//   função;
// - o diferencial (tests/erp/harness/dual-fixture.mjs) aplica os mesmos itens
//   no Postgres antes de começar: os dois motores rodam com o valor do
//   Wabotia. "seed": troca a linha nos dois bancos. "function": CREATE OR
//   REPLACE da função no oráculo (só o Postgres desta fixture; o motor já
//   traz o valor no código portado).
// Só texto e JSON aqui: o gerador (Node) importa este arquivo direto.

export interface SeedDeviation {
  kind?: "seed";
  /** Identificador do desvio (vários itens podem ter o mesmo). */
  id: string;
  /** Tabela do SQLite (schema__tabela). */
  table: string;
  /** Chave primária da linha alterada (valores JSON: texto, número, booleano). */
  key: Record<string, string | number | boolean>;
  column: string;
  /** Valor no Fagoo (JSON, como o Postgres devolve). */
  oracle: unknown;
  /** Valor no Wabotia. */
  value: unknown;
  reason: string;
  decided: string;
  /** false: registrado, ainda não vale na semeadura nem no diferencial. */
  applied: boolean;
}

/** Trecho literal no corpo de uma função do oráculo (pg_get_functiondef). */
export interface FunctionDeviation {
  kind: "function";
  id: string;
  /** schema.nome da função (sem sobrecarga). */
  fn: string;
  /** Trecho do Fagoo, que precisa aparecer exatamente uma vez no corpo. */
  oracle: string;
  /** Trecho do Wabotia. */
  value: string;
  reason: string;
  decided: string;
  applied: boolean;
}

export type Deviation = SeedDeviation | FunctionDeviation;
export const isFunctionDeviation = (d: Deviation): d is FunctionDeviation => d.kind === "function";
const seedOnly = (list: readonly Deviation[]) => list.filter((d): d is SeedDeviation => !isFunctionDeviation(d));

/** Quantas vezes o trecho aparece no corpo (sem sobreposição). */
const occurrences = (text: string, part: string) => (part ? text.split(part).length - 1 : 0);

/** Confere o desvio de função contra o corpo atual: null quando o trecho aparece exatamente uma vez. */
export function checkFunctionDeviation(definition: string | null, d: FunctionDeviation): string | null {
  if (definition === null) return `${d.id} ${d.fn}: a função não existe no oráculo`;
  const n = occurrences(definition, d.oracle);
  return n === 1 ? null : `${d.id} ${d.fn}: o trecho ${JSON.stringify(d.oracle)} aparece ${n} vezes (esperado: 1)`;
}

/**
 * O desvio já está no corpo (o trecho do Fagoo some e o do Wabotia aparece
 * exatamente uma vez): aplicar de novo no mesmo banco não faz nada.
 */
export const functionDeviationApplied = (definition: string | null, d: FunctionDeviation) =>
  definition !== null && occurrences(definition, d.oracle) === 0 && occurrences(definition, d.value) === 1;

/** O corpo com o trecho do Wabotia no lugar do Fagoo; lança se o trecho não aparece exatamente uma vez. */
export function applyFunctionDeviation(definition: string | null, d: FunctionDeviation): string {
  const problem = checkFunctionDeviation(definition, d);
  if (problem) throw new Error(`Desvio de função desatualizado: ${problem}`);
  return definition!.replace(d.oracle, () => d.value);
}

/** SQL que devolve o corpo da função (uma linha; sem sobrecarga). Parâmetros: schema, nome. */
export const FUNCTION_DEFINITION_SQL =
  "select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2";

const TELAS_2_CASAS =
  'Usuário (16/11): "casas decimais usamos apenas 02" e "pode deixar padrão 02 casas". Opção (a): o padrão ' +
  "das preferências vai a 2, com o limite de entrada no servidor valendo; quem precisar de mais sobe a " +
  "preferência. O banco e o motor seguem com a precisão do Fagoo (preço até 10, quantidade 6, custo 10). " +
  "decimais_peso fica em 3. Conferido para o preço de entrada: o limite só vale no que se digita (preço do " +
  "pedido de compra, erp_documents.check_preference_rules; preço e custo do lançamento e do balanço de " +
  "estoque, erp_stock.entry_price_check). A importação de XML de nota de entrada (erp_fiscal_invoice_import, " +
  "vUnCom com até 10 casas), o recebimento de compra e o custo médio não passam por ele.";

export const ERP_DEVIATIONS: readonly Deviation[] = [
  {
    id: "origin-fora",
    table: "erp_sync__settings",
    key: { singleton: true },
    column: "enabled",
    oracle: true,
    value: false,
    reason:
      "O Origin sai da instalação principal (PLANO-FAGOO.md, item 17): o ERP é portado com o Origin desligado. " +
      "No Fagoo a migração 202610220009 liga a sincronização de fábrica (enabled=true); aqui ela nasce desligada, " +
      "e erp_sync.enqueue não grava a fila. O contrato genérico de integração vem na última etapa.",
    decided: "usuário, 16/11/2026 (item 17)",
    applied: true,
  },
  {
    id: "telas-2-casas",
    table: "erp_preferences__definition",
    key: { key: "empresa.decimais_preco_saida" },
    column: "default_value",
    oracle: 10,
    value: 2,
    reason: TELAS_2_CASAS,
    decided: "usuário, 16/11/2026",
    applied: true,
  },
  {
    id: "telas-2-casas",
    table: "erp_preferences__definition",
    key: { key: "empresa.decimais_preco_entrada" },
    column: "default_value",
    oracle: 10,
    value: 2,
    reason: TELAS_2_CASAS,
    decided: "usuário, 16/11/2026",
    applied: true,
  },
  {
    id: "telas-2-casas",
    table: "erp_preferences__definition",
    key: { key: "empresa.decimais_quantidade" },
    column: "default_value",
    oracle: 6,
    value: 2,
    reason: TELAS_2_CASAS,
    decided: "usuário, 16/11/2026",
    applied: true,
  },
  {
    kind: "function",
    id: "exportacao-wabotia",
    fn: "public.erp_platform_export_link",
    oracle: "'brufap-exportacao-'",
    value: "'wabotia-exportacao-'",
    reason:
      "O arquivo da exportação da empresa vai para a pasta de downloads da pessoa: o nome não leva o nome do " +
      "Fagoo. O resto do link (validade, tamanho, SHA-256, chave do objeto) segue igual; o adaptador da erp-api " +
      "(platform.mjs, parseExportLink) confere o formato novo.",
    decided: "orquestração, 17/11/2026",
    applied: true,
  },
];

interface SeedTable {
  table: string;
  columns: string[];
  rows: unknown[][];
}

/** Valor JSON → forma da coluna no SQLite (json: texto; booleano: 0/1; o resto como está). */
export const liteValue = (codec: string, value: unknown) =>
  codec === "json" || codec.startsWith("array:")
    ? JSON.stringify(value)
    : codec === "bool" && typeof value === "boolean"
      ? value
        ? 1
        : 0
      : value;

/** Linhas da semeadura que casam com a chave do desvio. */
function matching(t: SeedTable | undefined, d: SeedDeviation, codecOf: (table: string, column: string) => string) {
  if (!t) return { col: -1, hits: [] as unknown[][] };
  const col = t.columns.indexOf(d.column);
  const keys = Object.entries(d.key).map(([k, v]) => [t.columns.indexOf(k), liteValue(codecOf(d.table, k), v)] as const);
  const hits = col >= 0 && keys.every(([i]) => i >= 0) ? t.rows.filter((r) => keys.every(([i, v]) => r[i] === v)) : [];
  return { col, hits };
}

/**
 * Confere cada desvio de semeadura contra a do oráculo: linha única e valor do
 * Fagoo igual a `oracle`. Os de função são conferidos contra o corpo da função
 * (checkFunctionDeviation), com o oráculo aberto.
 */
export function checkDeviations(
  seed: readonly SeedTable[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
) {
  const problems: string[] = [];
  for (const d of seedOnly(deviations)) {
    const { col, hits } = matching(
      seed.find((x) => x.table === d.table),
      d,
      codecOf,
    );
    if (hits.length !== 1) problems.push(`${d.id} ${d.table} ${JSON.stringify(d.key)}: ${hits.length} linhas`);
    else if (hits[0][col] !== liteValue(codecOf(d.table, d.column), d.oracle))
      problems.push(`${d.id} ${d.table} ${JSON.stringify(d.key)}: o Fagoo tem ${String(hits[0][col])}, o desvio espera ${JSON.stringify(d.oracle)}`);
  }
  return problems;
}

/**
 * Semeadura com os desvios dados trocados (só os de semeadura). Cada desvio
 * precisa achar exatamente uma linha; senão lança (desvio desatualizado).
 */
export function applyDeviations<T extends SeedTable>(
  seed: readonly T[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
): T[] {
  const out = seed.map((t) => ({ ...t, rows: t.rows.map((r) => [...r]) }));
  for (const d of seedOnly(deviations)) {
    const { col, hits } = matching(
      out.find((x) => x.table === d.table),
      d,
      codecOf,
    );
    if (hits.length !== 1) throw new Error(`Desvio ${d.id} (${d.table} ${JSON.stringify(d.key)}): ${hits.length} linhas na semeadura.`);
    hits[0][col] = liteValue(codecOf(d.table, d.column), d.value);
  }
  return out;
}
