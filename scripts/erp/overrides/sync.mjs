// Decisões do conversor do domínio sync (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
// erp_stock_mirror é do Origin (fora do porte principal, PLANO-FAGOO.md item 17); a
// tabela ainda é gerada até a poda.

export const columns = {
  "erp_stock_mirror.observation.physical": {
    "codec": "dec_text",
    "scale": 12,
    "precision": 36,
    "status": "evidência",
    "evidence": "Gravada por erp_stock_mirror apply a partir de erp_stock_mirror.number(): aceita abs < 1e24 e min_scale ≤ 12 e guarda trim_scale. Até 24 inteiros + 12 casas: decimal em TEXT, escala de entrada conservada."
  },
  "erp_stock_mirror.observation.virtual": {
    "codec": "dec_text",
    "scale": 12,
    "precision": 36,
    "status": "evidência",
    "evidence": "Gravada por erp_stock_mirror apply a partir de erp_stock_mirror.number(): aceita abs < 1e24 e min_scale ≤ 12 e guarda trim_scale. Até 24 inteiros + 12 casas: decimal em TEXT, escala de entrada conservada."
  },
  "erp_stock_mirror.observation.physical_delta": {
    "codec": "dec_text",
    "scale": 12,
    "precision": 37,
    "status": "evidência",
    "evidence": "Diferença entre duas leituras de physical (mesma origem): até 2e24 e 12 casas. Gravada por erp_stock_mirror apply a partir de erp_stock_mirror.number(): aceita abs < 1e24 e min_scale ≤ 12 e guarda trim_scale. Até 24 inteiros + 12 casas: decimal em TEXT, escala de entrada conservada."
  },
  "erp_stock_mirror.observation.virtual_delta": {
    "codec": "dec_text",
    "scale": 12,
    "precision": 37,
    "status": "evidência",
    "evidence": "Diferença entre duas leituras de virtual. Gravada por erp_stock_mirror apply a partir de erp_stock_mirror.number(): aceita abs < 1e24 e min_scale ≤ 12 e guarda trim_scale. Até 24 inteiros + 12 casas: decimal em TEXT, escala de entrada conservada."
  }
};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};

/**
 * Pendências do esquema gerado (CHECK sem tradução, gatilho em PL/pgSQL) que o
 * domínio já cumpre em TS, com onde. tests/erp/schema-parity.test.mjs só conta
 * o que ninguém cobre; ao fechar o domínio, baixe os tetos de lá.
 * checks: "schema.tabela.restrição"; triggers: "schema__tabela.gatilho".
 */
export const covered = {
  "checks": {},
  "triggers": {}
};
