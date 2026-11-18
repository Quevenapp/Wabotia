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
  "triggers": {
    "erp_documents__audit.aa_mirror_authority": {
      "where": "INSERT em erp_documents__audit só com guardEffect antes (documents/mirror.ts): audit() de erp_document_save, _transition, _conversions, _small_writers, _settings_writers e _checkout_occurrence; documentAudit do finance/rpc/erp_document_finance.ts; Estoque com mirrorGuardEffect (document-stock, purchase-receipts, reservations, item-components). Nenhum UPDATE ou DELETE em audit no motor",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.aa_mirror_authority": {
      "where": "documents/rows.ts insertDocument e updateDocument: guardDocument (mirror.ts) antes da escrita; todo escritor de documento passa por rows.ts (nenhum INSERT, UPDATE ou DELETE cru em erp_documents__document fora dele; DELETE de documento não existe no motor)",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.ab_origin_effects": {
      "where": "documents/rows.ts updateDocument: sync.guardOriginEffectsDocument; com o Origin fora, só documento travado (originLocked) chega ao 0A000 declarado",
      "test": "tests/erp/sync/origin-off.test.mjs"
    },
    "erp_documents__document.guard_trash": {
      "where": "documents/rows.ts updateDocument: guardTrash (na lixeira nada muda; excluir e restaurar só mudam as colunas da lixeira e os metadados)",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.protect_document_finance": {
      "where": "documents/rows.ts updateDocument: finance.guardPostedDocument",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.protect_document_stock": {
      "where": "documents/rows.ts updateDocument: stock.guardPostedDocument",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.protect_purchase_receipt_document": {
      "where": "documents/rows.ts updateDocument: stock.guardDocument",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.protect_reserved_document": {
      "where": "documents/rows.ts updateDocument: stock.guardReservedDocument",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.zz_origin_sync": {
      "where": "documents/rows.ts insertDocument e updateDocument: sync.captureDocument (sem efeito com o Origin fora)",
      "test": "tests/erp/sync/origin-off.test.mjs"
    },
    "erp_documents__document.commission_operation_capture": {
      "where": "documents/rows.ts insertDocument e updateDocument: deferCaptures enfileira finance.commissionOperationCapture para venda e OS",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    },
    "erp_documents__document.cost_apply_capture": {
      "where": "documents/rows.ts insertDocument e updateDocument: deferCaptures enfileira costApplyCapture para pedido de venda",
      "test": "tests/erp/documents/document-triggers.test.mjs"
    }
  }
};
