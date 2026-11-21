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
// 19: seis tabelas da mão dupla com o Bling (interruptores, linha de base,
//     fila de saída, pendências e conflitos, registro dos interruptores;
//     18→19, somente adição). 17 e 18 pertencem a outras frentes: aqui os
//     passos 16→17 e 17→18 só criam as tabelas que elas declararem.
import { createHash } from "node:crypto";
import { ERP_DDL_GENERATED, ERP_DDL_HASH as GENERATED_HASH } from "./ddl.generated.ts";
import { ERP_ENGINE_DDL } from "./engine-tables.ts";

export const ERP_DDL_VERSION = 19;
export const ERP_DDL: readonly string[] = [...ERP_DDL_GENERATED, ...ERP_ENGINE_DDL];
/** Hash do esquema: o do gerado; com tabelas do motor, o do gerado mais o DDL delas. */
export const ERP_DDL_HASH: string = ERP_ENGINE_DDL.length
  ? createHash("sha256").update(GENERATED_HASH + "\n" + ERP_ENGINE_DDL.join("\n"), "utf8").digest("hex")
  : GENERATED_HASH;
