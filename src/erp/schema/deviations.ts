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
  /** Chave primária da linha alterada. */
  key: Record<string, string>;
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

/** Valor JSON → forma da coluna no SQLite (json: texto; o resto como está). */
export const liteValue = (codec: string, value: unknown) =>
  codec === "json" || codec.startsWith("array:") ? JSON.stringify(value) : value;

/** Confere cada desvio contra a semeadura do oráculo: linha única e valor do Fagoo igual a `oracle`. */
export function checkDeviations(
  seed: readonly SeedTable[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
) {
  const problems: string[] = [];
  for (const d of deviations) {
    const t = seed.find((x) => x.table === d.table);
    const col = t?.columns.indexOf(d.column) ?? -1;
    const keys = Object.entries(d.key).map(([k, v]) => [t?.columns.indexOf(k) ?? -1, v] as const);
    const hits = t && col >= 0 && keys.every(([i]) => i >= 0) ? t.rows.filter((r) => keys.every(([i, v]) => r[i] === v)) : [];
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
    const t = out.find((x) => x.table === d.table);
    const col = t?.columns.indexOf(d.column) ?? -1;
    const keys = Object.entries(d.key).map(([k, v]) => [t?.columns.indexOf(k) ?? -1, v] as const);
    const hits = t && col >= 0 && keys.every(([i]) => i >= 0) ? t.rows.filter((r) => keys.every(([i, v]) => r[i] === v)) : [];
    if (hits.length !== 1) throw new Error(`Desvio ${d.id} (${d.table} ${JSON.stringify(d.key)}): ${hits.length} linhas na semeadura.`);
    hits[0][col] = liteValue(codecOf(d.table, d.column), d.value);
  }
  return out;
}
