// DDL aplicado no objeto: o esquema gerado de catalog.json
// (scripts/erp/gen-sqlite.mjs) e, no fim, as tabelas só do motor
// (engine-tables.ts). Mudou o gerado, a semeadura ou uma tabela do motor,
// suba ERP_DDL_VERSION e escreva o passo N→N+1 em migrate.ts (STEPS).
// 6: semeadura com as colunas __fold preenchidas (passo 5→6).
// 7: tabelas da classificação da reforma tributária (engine-tables.ts, passo 6→7).
// 8: gatilhos do override sqlTriggers (os 6 de imutabilidade do CNAB) e gatilhos
//    criados em ordem inversa do nome (ordem de disparo do Postgres); passo 7→8,
//    recreateTriggers.
// 9: tabelas do cofre da NFapi: notas recebidas (received, received_change com
//    os 2 gatilhos de imutabilidade, cursor) e emissão (emission, event); passo
//    8→9, createEngineTables.
// 10: contratos comerciais do pedido de NF-e, comandos, revisões imutáveis,
//     efeitos e auditoria (passo 9→10, somente tabelas novas do motor).
// 11: seis tabelas da coleta e do acervo do Bling (10→11, somente adição).
// 12: quatro tabelas da adoção dos cadastros do Bling (11→12, somente adição).
// 13: três tabelas da adoção de documentos e contas do Bling e do espelho
//     histórico dos encerrados (12→13, somente adição).
// 14: sete tabelas do balcão com NFC-e (counter_*: as irmãs do modelo 65 e a
//     natureza do cupom; 13→14, somente adição).
// 15: duas tabelas do corte do Bling (data de corte confirmada e o registro de
//     cada etapa; 14→15, somente adição).
// 16: sete tabelas da nota de serviço da ordem (service_*: as irmãs da NFS-e
//     e o cadastro fiscal do serviço; 15→16, somente adição).
// 17: três tabelas da compra pela nota recebida (erp_purchase_inbound: nota,
//     entrada e configuração; 16→17, somente adição).
// 18: três tabelas do que vem depois da NF-e autorizada (order_correction,
//     void_range e order_return: carta de correção, inutilização de numeração
//     e devolução de venda; 17→18, somente adição).
// 19: seis tabelas da mão dupla com o Bling (interruptores, linha de base,
//     fila de saída, pendências e conflitos, registro dos interruptores;
//     18→19, somente adição).
// 20: três tabelas dos campos próprios de contato (definição, valor por contato
//     e registro das alterações; 19→20, somente adição).
// 21: duas tabelas do DRE gerencial e do pagamento da equipe (dre_cost e
//     team_payment em erp_finance; 20→21, somente adição).
// 22: duas tabelas do pacote do contador (package e part em erp_contador;
//     21→22, somente adição).
// 23: cinco tabelas da ordem de produção (order, order_input, completion,
//     completion_input e command em erp_production; 22→23, somente adição).
// 24: cinco tabelas da fatia D do Bling (vínculo, pendência, interruptor,
//     fila de saída e registro das listas de preços, naturezas, campos,
//     contratos, NFS-e, lotes e fornecedores; 23→24, somente adição).
// 25: oito tabelas da Expedição (erp_shipping: embalagens, situação do pedido
//     na expedição, lista e linhas de separação, pendências, volumes,
//     devoluções físicas e recibos; 24→25, somente adição).
// 26: duas tabelas do cálculo da reforma tributária (erp_fiscal_reform:
//     configuração da empresa e Imposto Seletivo do produto; 25→26, somente
//     adição).
// 27: nove tabelas das lojas e filiais (erp_store: lojas, vínculos de
//     depósito, conta, documento e conta a pagar/receber, restrição da pessoa,
//     loja em uso, recibos e auditoria; 26→27, somente adição).
// 28: uma tabela do tipo das importações por planilha fiscal, de naturezas e
//     de saldos iniciais (import_job_kind em erp_preferences; 27→28, somente
//     adição). 26 e 27 são de outras frentes: aqui os passos 25→26 e 26→27
//     só criam as tabelas do motor dessas versões (nenhuma nesta frente).
// 29: três tabelas das obrigações fiscais em arquivo (erp_sped: configuração,
//     arquivo pedido e as notas lidas do arquivo em montagem; 28→29, somente
//     adição).
// 30: nove tabelas da conciliação bancária e de cartões (erp_reconciliation:
//     modelos de planilha, regras, origem e motivo da linha do extrato, saldo
//     do banco por dia, taxas do cartão, importações e linhas da adquirente,
//     recibos e auditoria; 29→30, somente adição). A 29 é de outra frente:
//     aqui o passo 28→29 só cria as tabelas do motor dessa versão (nenhuma
//     nesta frente).
// 29 e 30: de outras frentes (nesta base, passos sem tabela).
// 31: nove tabelas dos contratos de serviço (erp_contract: contrato, linhas
//     com validade, fatura do período, histórico, tabela de índices, anexos,
//     avisos, vínculo com o Bling e comandos; 30→31, somente adição).
// 32: Bling numa conta real (wb_bling_return_setting, wb_bling_return_outbox e
//     wb_bling_webhook_hint: nota, situação e rastreio de volta ao Bling e o
//     aviso do webhook; 31→32, somente adição).
import { createHash } from "node:crypto";
import { ERP_DDL_GENERATED, ERP_DDL_HASH as GENERATED_HASH } from "./ddl.generated.ts";
import { ERP_ENGINE_DDL } from "./engine-tables.ts";

export const ERP_DDL_VERSION = 32;
export const ERP_DDL: readonly string[] = [...ERP_DDL_GENERATED, ...ERP_ENGINE_DDL];
/** Hash do esquema: o do gerado; com tabelas do motor, o do gerado mais o DDL delas. */
export const ERP_DDL_HASH: string = ERP_ENGINE_DDL.length
  ? createHash("sha256").update(GENERATED_HASH + "\n" + ERP_ENGINE_DDL.join("\n"), "utf8").digest("hex")
  : GENERATED_HASH;
