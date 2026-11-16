// Decisões do conversor do domínio documents (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {
  "erp_documents.item.unit_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 20,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e10, = trunc(x, 10). unit_price(p_value, 10) do documento: 10 inteiros + 10 casas = 20 dígitos, acima do i64 (19)."
  }
};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};
