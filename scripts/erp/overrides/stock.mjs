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
  "triggers": {
    "erp_stock__item_component.guard_stock_item_component": {
      "where": "src/erp/domains/stock/rpc/item-components.ts guardItemComponent: versão inicial 1, avanço unitário, identidade preservada e comando novo",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_stock__item_component.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/item-components.ts guardItemComponent/deleteComponents: mirrorGuardEffect nas linhas novas e antigas",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_stock__item_component_command.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/item-components.ts itemComponentsReceipt: mirrorGuardEffect antes do recibo; recibo nunca atualizado ou apagado (imutabilidade já em SQL)",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__audit.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/item-components.ts itemComponentsReceipt: mirrorGuardEffect antes da auditoria",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: guardDocument preserva identidade e autoridade",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.ab_origin_effects": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: guardOriginEffectsDocument; SET restrito a version/updated_by/updated_at, permitido mesmo com efeitos",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.guard_trash": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: guardTrash recusa documento excluído e desfaz componentes",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.protect_document_finance": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: finance.guardPostedDocument; só versão e metadados mudam",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.protect_document_stock": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save recusa posted; documents.public.updateDocument chama stock.guardPostedDocument",
      "test": "tests/erp/stock/document-guards.test.mjs"
    },
    "erp_documents__document.protect_purchase_receipt_document": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: stock.guardDocument preserva o documento com recebimento ativo",
      "test": "tests/erp/stock/document-guards.test.mjs"
    },
    "erp_documents__document.protect_reserved_document": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save recusa reserved; documents.public.updateDocument chama stock.guardReservedDocument",
      "test": "tests/erp/stock/document-guards.test.mjs"
    },
    "erp_documents__document.zz_origin_sync": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: sync.captureDocument (Origin desligado conforme desvio comum)",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.commission_operation_capture": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: enfileira finance.commissionOperationCapture por UPDATE, antes de costApplyCapture",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_documents__document.cost_apply_capture": {
      "where": "src/erp/domains/stock/rpc/item-components.ts save chama documents.public.updateDocument: enfileira costApplyCapture para pedido de venda, no fim da transação",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_stock__composition.guard_stock_composition": {
      "where": "src/erp/domains/stock/rpc/compositions.ts erpStockProductCompose: único escritor, versão inicial 1, avanço unitário, identidade preservada e comando novo",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_stock__composition_item.guard_stock_composition_item": {
      "where": "src/erp/domains/stock/rpc/compositions.ts erpStockProductCompose: insere somente itens da versão e comando recém-gravados, preserva versões anteriores",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_stock__composition_command.guard_stock_composition_command": {
      "where": "src/erp/domains/stock/rpc/compositions.ts erpStockProductCompose: recibo save somente após estrutura do mesmo produto, comando e ator; replay não escreve",
      "test": "tests/erp/stock/compositions.test.mjs"
    },
    "erp_stock__document_posting.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts insertPosting/reversePosting: documents.mirrorGuardEffect antes de gravar",
      "test": "tests/erp/stock/document-stock-read.test.mjs"
    },
    "erp_stock__document_posting.guard_trash": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts insertPosting: documents.guardTrashChild recusa documento na lixeira",
      "test": "tests/erp/stock/document-stock-read.test.mjs"
    },
    "erp_stock__document_posting.protect_purchase_receipt_legacy": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts insertPosting: recusa qualquer recebimento por item anterior",
      "test": "tests/erp/stock/document-stock-read.test.mjs"
    },
    "erp_stock__document_posting.protect_reserved_posting": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts insertPosting: reserva ativa exige consumo da reserva",
      "test": "tests/erp/stock/document-stock-read.test.mjs"
    },
    "erp_stock__document_posting.post_stock_document_lots": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts insertPosting: aplica os lotes da cópia via lotApply, na ordem produto/lote",
      "test": "tests/erp/stock/document-stock.test.mjs"
    },
    "erp_stock__document_posting.immutable_document_stock_posting": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts reversePosting: somente active para reversed, versão +1 e movimento que estorna o original; não exclui nem muda a cópia",
      "test": "tests/erp/stock/document-stock.test.mjs"
    },
    "erp_stock__document_audit.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/document-stock.ts audit: documents.mirrorGuardEffect antes das auditorias",
      "test": "tests/erp/stock/document-stock-read.test.mjs"
    },
    "erp_purchase_receipts__receipt.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/purchase-receipts.ts applyWarehouse: documents.mirrorGuardEffect antes de recebimento/estorno, auditoria e recibo",
      "test": "tests/erp/stock/purchases.test.mjs"
    },
    "erp_purchase_receipts__reversal.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/purchase-receipts.ts applyWarehouse: documents.mirrorGuardEffect antes de recebimento/estorno, auditoria e recibo",
      "test": "tests/erp/stock/purchases.test.mjs"
    },
    "erp_purchase_receipts__command.aa_mirror_authority": {
      "where": "src/erp/domains/stock/rpc/purchase-receipts.ts applyWarehouse: documents.mirrorGuardEffect antes de recebimento/estorno, auditoria e recibo",
      "test": "tests/erp/stock/purchases.test.mjs"
    },
    "erp_stock__checkin.guard_stock_checkin": {
      "where": "src/erp/domains/stock/rpc/checkin.ts checkinBegin/checkinAdvance/checkinWrite: inserção in_progress v1; avanço unitário, finalizado imutável; não exclui a conferência",
      "test": "tests/erp/stock/checkin.test.mjs"
    },
    "erp_stock__checkin_item.guard_stock_checkin_item": {
      "where": "src/erp/domains/stock/rpc/checkin.ts checkinWrite/checkinAdvance: cópia só no início/reinício; conferência finalizada e item recusado protegidos",
      "test": "tests/erp/stock/checkin.test.mjs"
    },
    "erp_stock__invoice_posting.guard_stock_invoice_posting": {
      "where": "src/erp/domains/stock/rpc/invoice-stock.ts saveInvoicePosting/invoiceReverse: inserção active v1, somente estorno do próprio movimento e avanço de versão; cópia preservada",
      "test": "tests/erp/stock/invoice-stock.test.mjs"
    },
    "erp_stock__unit_conversion.guard_stock_unit_conversion": {
      "where": "src/erp/domains/stock/rpc/invoice-stock.ts erp_stock_invoice_unit_save: inserção v1 e atualização +1 com novo comando, identidade preservada",
      "test": "tests/erp/stock/invoice-stock.test.mjs"
    },
    "erp_catalog__product.protect_stock_product_unit": {
      "where": "src/erp/domains/stock/public.ts protectProductUnit, chamada por src/erp/domains/catalog/record.ts updateProduct (escrita P para o Catálogo; dono N)",
      "test": "tests/erp/stock/catalog-guards.test.mjs"
    },
    "erp_catalog__record.protect_stock_default_warehouse": {
      "where": "src/erp/domains/stock/public.ts protectDefaultWarehouse, chamada por src/erp/domains/catalog/record.ts updateRecord (escrita P para o Catálogo; dono N)",
      "test": "tests/erp/stock/catalog-guards.test.mjs"
    },
    "erp_stock__warehouse_default.guard_stock_warehouse_default": {
      "where": "src/erp/domains/stock/rpc/warehouses.ts erp_stock_warehouse_set_default: único escritor; só por comando 'default', versão +1, recibo gravado antes",
      "test": "tests/erp/stock/warehouses.test.mjs"
    },
    "erp_stock__dashboard_preference.guard_stock_dashboard_preference": {
      "where": "src/erp/domains/stock/rpc/dashboards.ts erp_stock_dashboard_preference_set: único escritor; inserção na versão 1 e atualização +1, só por comando gravado antes",
      "test": "tests/erp/stock/dashboards.test.mjs"
    },
    "erp_stock__policy.guard_stock_policy": {
      "where": "src/erp/domains/stock/rpc/policy.ts erp_stock_policy_set: único escritor; só por comando, versão +1, valor diferente, recibo gravado antes",
      "test": "tests/erp/stock/policy.test.mjs"
    }
  }
};
