// Decisões do conversor do domínio company (docs/ERP-PORTE.md). Só a sessão dona
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
  "checks": {
    "erp_company.file.file_check": {
      "where": "src/erp/domains/company/rpc/files.ts reserve (extensão pelo tipo)",
      "test": "tests/erp/company/company.test.mjs"
    }
  },
  "triggers": {
    "erp_company__extra.extra_cnae_official": {
      "where": "src/erp/domains/reference/public.ts companyExtraCnae",
      "test": "tests/erp/company/company.test.mjs"
    },
    "erp_company__file.file_identity": {
      "where": "src/erp/domains/company/rpc/files.ts update",
      "test": "tests/erp/company/company.test.mjs"
    },
    "erp_company__logo.logo_identity": {
      "where": "src/erp/domains/company/rpc/files.ts update",
      "test": "tests/erp/company/company.test.mjs"
    }
  }
};
