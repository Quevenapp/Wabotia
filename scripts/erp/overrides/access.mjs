// Decisões do conversor do domínio access (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};

/**
 * Pendências do esquema gerado (CHECK sem tradução, gatilho em PL/pgSQL) que o
 * domínio cumpre em TS. Cada item diz onde (where) e qual teste prova (test,
 * caminho do arquivo; o teste precisa exercitar a recusa nos dois motores).
 * tests/erp/schema-parity.test.mjs só conta o que ninguém cobre, recusa item
 * que não está pendente e item sem arquivo de teste; ao cobrir, baixe os tetos
 * de lá. Chaves: checks "schema.tabela.restrição"; triggers "schema__tabela.gatilho".
 */
export const covered = {
  "checks": {},
  "triggers": {}
};
