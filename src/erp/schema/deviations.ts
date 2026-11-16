// Desvios deliberados do oráculo (Fagoo): só valores iniciais de dados de
// referência e de preferências, cada um com o motivo. Esquema, regras de
// conversão e precisão do banco e do motor nunca entram aqui.
//
// Como vale:
// - scripts/erp/gen-sqlite.mjs confere cada item contra o oráculo (a linha
//   existe e o valor do Fagoo ainda é `oracle`; se o Fagoo mudou, a geração
//   para e o desvio é revisto) e, com `applied: true`, troca o valor na
//   semeadura (seed.generated.ts);
// - o diferencial (tests/erp/harness/dual-fixture.mjs) aplica os mesmos
//   itens no Postgres antes de começar: os dois motores rodam com o valor do
//   Wabotia, e a semeadura diferente não aparece como divergência.
// Só texto e JSON aqui: o gerador (Node) importa este arquivo direto.

export interface Deviation {
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

const TELAS_2_CASAS =
  "Decisão do usuário: nas telas, padrão de 2 casas para preço e quantidade, configurável por empresa. " +
  "O banco e o motor continuam com a precisão do Fagoo (preço até 10, quantidade 6, custo 10, alíquotas 4). " +
  "Atenção: no Fagoo estas preferências também limitam a ENTRADA no servidor (preço: migrações 164/287, " +
  "lançamento de estoque 277; quantidade: 287), não só a exibição. Com 2, o servidor recusa 3 casas ou mais " +
  "até a empresa subir o valor. Aplicar só depois de confirmar esse efeito.";

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
    applied: false,
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
    applied: false,
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
    applied: false,
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
function matching(t: SeedTable | undefined, d: Deviation, codecOf: (table: string, column: string) => string) {
  if (!t) return { col: -1, hits: [] as unknown[][] };
  const col = t.columns.indexOf(d.column);
  const keys = Object.entries(d.key).map(([k, v]) => [t.columns.indexOf(k), liteValue(codecOf(d.table, k), v)] as const);
  const hits = col >= 0 && keys.every(([i]) => i >= 0) ? t.rows.filter((r) => keys.every(([i, v]) => r[i] === v)) : [];
  return { col, hits };
}

/** Confere cada desvio contra a semeadura do oráculo: linha única e valor do Fagoo igual a `oracle`. */
export function checkDeviations(
  seed: readonly SeedTable[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
) {
  const problems: string[] = [];
  for (const d of deviations) {
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
 * Semeadura com os desvios dados trocados. Cada desvio precisa achar
 * exatamente uma linha; senão lança (desvio desatualizado).
 */
export function applyDeviations<T extends SeedTable>(
  seed: readonly T[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
): T[] {
  const out = seed.map((t) => ({ ...t, rows: t.rows.map((r) => [...r]) }));
  for (const d of deviations) {
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
