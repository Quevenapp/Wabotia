// Decisões do conversor do domínio company (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};

/**
 * Pendências do esquema gerado (CHECK sem tradução, gatilho em PL/pgSQL) que o
 * domínio já cumpre em TS, com onde. tests/erp/schema-parity.test.mjs só conta
 * o que ninguém cobre; ao fechar o domínio, baixe os tetos de lá.
 * checks: "schema.tabela.restrição"; triggers: "schema__tabela.gatilho".
 */
export const covered = {
  "checks": {
    "erp_company.file.file_check": "src/erp/domains/company/rpc/files.ts reserve (extensão pelo tipo)"
  },
  "triggers": {
    "erp_company__extra.extra_cnae_official": "src/erp/domains/reference/public.ts companyExtraCnae",
    "erp_company__file.file_identity": "src/erp/domains/company/rpc/files.ts update",
    "erp_company__logo.logo_identity": "src/erp/domains/company/rpc/files.ts update"
  }
};
