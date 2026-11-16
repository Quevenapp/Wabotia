// Decisões do conversor do domínio fiscal (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {
  "erp_fiscal_invoices.invoice_item.quantity": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "CHECK < 1e11, = trunc(x, 4). Quantidade comercial da NF-e (4 casas no leiaute)."
  },
  "erp_fiscal_invoices.invoice_item.unit_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 21,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e11, = trunc(x, 10). 11 inteiros + 10 casas = 21 dígitos, acima do i64. Valor unitário da NF-e (até 10 casas no leiaute)."
  },
  "erp_fiscal_invoices.invoice_order_item.quantity": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "CHECK < 1e11, = trunc(x, 4). Quantidade comercial da NF-e (4 casas no leiaute)."
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
