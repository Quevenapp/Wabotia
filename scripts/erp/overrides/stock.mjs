// Decisões do conversor do domínio stock (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {
  "erp_stock.checkin_event.quantity": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "Sem CHECK. As funções do recebimento copiam de erp_stock.checkin_item.quantity/received (trunc 4, < 1e11) e formatam ::numeric(24,4): herda escala 4."
  },
  "erp_stock.checkin_event.previous": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "Sem CHECK. Valor anterior da mesma coluna de checkin_item (trunc 4, < 1e11): herda escala 4."
  },
  "erp_stock.checkin_item.quantity": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "CHECK < 1e11, = trunc(x, 4). Quantidade da nota recebida."
  },
  "erp_stock.checkin_item.unit_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 21,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e11, = trunc(x, 10). 11 inteiros + 10 casas = 21 dígitos, acima do i64."
  },
  "erp_stock.checkin_item.received": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "CHECK < 1e11, = trunc(x, 4). Quantidade conferida (CHECK >= 0)."
  },
  "erp_stock.checkin_item.issue_quantity": {
    "codec": "dec",
    "scale": 4,
    "precision": 15,
    "status": "evidência",
    "evidence": "CHECK < 1e11, = trunc(x, 4). Quantidade com problema (CHECK > 0, ≤ quantity)."
  },
  "erp_stock.movement_detail.unit_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 24,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e14, = trunc(x, 10). erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64."
  },
  "erp_stock.movement_detail.unit_cost": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 24,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e14, = trunc(x, 10). Custo unitário com o mesmo teto do preço. erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64."
  }
};

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
