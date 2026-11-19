// Diferenças estruturais com o oráculo (Fagoo): partes que não existem no
// motor por decisão de arquitetura, cada uma com o motivo e com o que a
// substitui. Não são desvios de semeadura (deviations.ts): o diferencial não
// as compara, e quem porta não as reproduz. Decisões em PLANO-FAGOO.md
// (itens 16 e 17) e nas mensagens da orquestração de 16/11/2026.

export interface StructuralDifference {
  id: string;
  /** O que existe no Fagoo. */
  oracle: string;
  reason: string;
  /** O que faz o papel no Wabotia. */
  replaced_by: string;
  /** Rotas da erp-api afetadas (para o painel), quando há. */
  routes?: string[];
}

export const ERP_STRUCTURAL: readonly StructuralDifference[] = [
  {
    id: "erp-partes",
    oracle: "Núcleo único com todas as rotinas disponíveis pelo papel, sem chaves por parte.",
    reason: "Fase 2: partes ligadas independentemente pela área, preservando o banco completo e o modo diferencial todo ligado.",
    replaced_by: "Nove módulos; migração D1 0133; fotografia revisionada no envelope e KV do Coordinator existente; requisitos compartilhados entre rotas, RPCs, painel e agendador. Nenhuma alteração no esquema ERP. Os comportamentos condicionais estão em ERP_PART_BEHAVIORS, separados das substituições aplicadas ao oráculo. Limites e manutenção: docs/ERP-FASE2.md.",
    routes: ["GET /v1/sistema/manutencao-efeitos", "POST /v1/sistema/manutencao-efeitos"],
  },
  {
    id: "auth",
    oracle: "schema auth do Supabase: users, sessions, mfa_factors, mfa_challenges",
    reason: "Login, sessão e segundo fator são do núcleo do Wabotia, não do ERP.",
    replaced_by:
      "Porta de identidade (src/erp/engine/identity.ts): o Worker manda o envelope com quem chama (papel erp:<papel>, sessão, aal, fator) e as pessoas da área; o motor nunca consulta o D1. Fase 3: o preenchimento a partir do núcleo.",
  },
  {
    id: "membership-papel",
    oracle: "erp_access.membership gravada pelos RPCs de usuários (convite, user_save)",
    reason: "O papel do ERP vem do acesso por pessoa do Wabotia (erp:admin|consulta|vendas|financeiro|estoque|fiscal; o administrador do Wabotia vale erp:admin).",
    replaced_by:
      "Projeção antes de cada RPC (src/erp/domains/access/identity.ts): membership e profile seguem o envelope; sem erp:* a pessoa fica inativa e recebe 403. A tabela continua, com o último papel, e nenhum RPC grava papel.",
  },
  {
    id: "usuarios-supabase",
    oracle:
      "erp_access_user_invite_begin, user_invite_complete, users_list_v2, user_get, user_save, user_command, user_security, mfa_reset",
    reason: "Gestão de pessoas, convite, sessões e redefinição do segundo fator são telas do núcleo (Pessoas, login e MFA).",
    replaced_by:
      "Telas de Pessoas do Wabotia: lista de pessoas com papel erp:*, convite, sessões e fator. Ficam no ERP: permissões finas e horário (user_controls), política de MFA do ERP, portão (gate_v2), atividade. Os 8 RPCs não são registrados: a erp-api responde 0A000 (501).",
    routes: [
      "GET /v1/usuarios",
      "GET /v1/usuarios/:user_id",
      "POST /v1/usuarios/:user_id",
      "POST /v1/usuarios/convites",
      "GET /v1/usuarios/comandos/:command_id",
      "GET /v1/sistema/usuarios/:user_id/seguranca",
      "POST /v1/seguranca/usuarios/:user_id/redefinir-mfa",
    ],
  },
  {
    id: "agentes",
    oracle: "erp_access.agent, agent_token e erp_access_agent_resolve (token de agente do MCP do Fagoo)",
    reason: "Integrações e agentes são aplicações do Wabotia com chave e escopo.",
    replaced_by: "Aplicações do Wabotia com escopos erp:read e erp:write (fase 3). O /mcp do Fagoo é bloco externo (src/erp/blocks.ts).",
  },
  {
    id: "rotulo-autor",
    oracle: "erp_activity.actor_label: nome do perfil, senão o e-mail de auth.users",
    reason: "O objeto não tem auth.users.",
    replaced_by: "Nome de erp_access.profile, mantido pela projeção a partir do envelope; sem perfil, 'Usuário xxxxxxxx'.",
  },
  {
    id: "storage",
    oracle: "storage.buckets e storage.objects do Supabase (erp_attachments.storage_ready, *_finish, erp_access_storage)",
    reason: "O armazenamento do Wabotia é o R2 (binding MEDIA).",
    replaced_by:
      "storage_ready não lança; ctx.objects (registerRpc(…, { objects })) e ctx.listing (registerRpc(…, { listing: true })) lidos do R2 antes da transação, em erp-storage/<área>/<bucket>/<nome>.",
  },
  {
    id: "certificado-a1",
    oracle: "bucket brufap-a1-vault (202610160041_a1_custody): custódia do certificado A1 no Storage",
    reason: "Decisão do usuário: o certificado A1 nunca fica no Wabotia, que tem bots e integrações; ele mora no cofre da NFapi, separado.",
    replaced_by:
      "O bucket fica fora do mapa do armazenamento (src/erp-storage.ts, ERP_BUCKETS): gravar, ler, apagar e assinar dão 404 mesmo com erp-fiscal ligado (tests/erp-storage.test.ts). A emissão usa o cofre (src/erp/emissor).",
  },
  {
    id: "tarefas-plataforma-laco",
    oracle:
      "runPlatformTasks e o company_export (runExport) de src/erp/fagoo/workers/erp-api/src/platform.mjs: o laço chama TASK_HANDLERS por dentro, e o runExport monta o pacote inteiro na memória (createZip) e o copia de novo no finish",
    reason:
      "Até 50 MiB por pacote: mais de 100 MB num isolado de 128 MB. O laço do Fagoo não aceita outro manipulador (TASK_HANDLERS congelado), então foi copiado.",
    replaced_by:
      "src/erp-export.ts: runErpPlatformTasks (cópia do laço, mesmas RPCs e o mesmo tratamento de erro) com runExportStreamed (createZipStream + createErpUpload, em fatias no R2); as outras tarefas são as do Fagoo. A paridade é segurada por tests/erp-export.test.ts: os dois laços sobre a mesma fila (tarefa comum, exportação, falha, posse perdida) gravam e respondem igual, salvo o manipulador da exportação.",
  },
  {
    id: "sessao-token",
    oracle: "session_id e aal lidos das claims do token do Supabase pela erp-api (tokenSession) e enviados ao erp_access_gate_v2",
    reason: "O token é o da sessão do Wabotia.",
    replaced_by: "aal e session_id do envelope de identidade; a costura (src/erp/api/local-fetch.ts) passa a mandá-los na fase 3.",
  },
  {
    id: "sequencias",
    oracle: "nextval('erp_preferences.transition_version'), a única sequência do Fagoo (erp_preferences.transition_save)",
    reason: "O SQLite do objeto não tem sequências; uma tabela só para isso não se paga.",
    replaced_by:
      "Maior número já emitido + 1, lido da trilha imutável (framework_audit.after_data.version), na mesma transação (domínio Preferências, sessão G): a linha da transição pode ser apagada, a trilha não. O nextval do transition_save vem depois de todas as validações, então uma chamada recusada não consome número em nenhum dos motores. Diferença que sobra: o Postgres pula um número se a transação de fora for desfeita depois de um transition_save aceito; no motor o número volta junto.",
  },
  {
    id: "origin",
    oracle: "domínio 12 (Origin): coletor do Bling, espelhos, mão dupla, virada, capturas de preço",
    reason: "O Origin sai da instalação principal (PLANO-FAGOO.md, item 17).",
    replaced_by: "Componente externo pela API pública; no ERP, só o contrato genérico de integração (docs/ERP-FASE0.md, \"Origin fora\").",
  },
  {
    id: "agendador",
    oracle:
      "Cron Trigger */2 do Worker erp-api, que só roda o Origin: erp_platform_schedule (notificações de hora em hora, limpeza diária das exportações) nunca dispara no Fagoo",
    reason: "No Wabotia o ERP mora no objeto erp:<área>, que tem alarme próprio; o cron do Worker só acorda.",
    replaced_by:
      "Despachante no alarme do objeto (src/erp/scheduler/, docs/ERP-AGENDADOR.md) com a tabela wb_routine (estado das rotinas: próximo horário, último resultado, falhas), do Wabotia, criada pelo migrate como a erp_meta (WB_ROUTINE_DDL), fora do DDL gerado e do backup.",
  },
  {
    id: "retencao-tarefas",
    oracle:
      "erp_platform.task e task_attempt imutáveis por desenho: task_guard e attempt_guard recusam DELETE, e nada as limpa (crescem para sempre)",
    reason:
      "O histórico da fila serve à tela de gestão de ações e ao suporte; depois de 90 dias só ocupa o SQLite do objeto (limite de tamanho por objeto).",
    replaced_by:
      "Rotina retention (diária, 03:10 de São Paulo, src/erp/scheduler/routines.ts): apaga tarefa done/failed terminada há mais de 90 dias, com as tentativas, em lotes de 100. Fica a tarefa ligada a uma exportação (linha imutável com FK). Os gatilhos do Fagoo são cumpridos em código no motor (domains/preferences/platform.ts), e o SQLite não tem gatilho contra o DELETE. Os recibos de comando (tabelas *command) ficam de fora.",
  },
  {
    id: "certificado-a1-cofre",
    oracle:
      "erp_pos.certificate_state() lê erp_a1.head e erp_a1.credential (o A1 guardado no banco do Fagoo) e devolve missing, unknown, expired ou valid no contexto da frente de caixa (erp_pos_context.certificate)",
    reason:
      "O certificado A1 fica no cofre da NFapi, não no banco do ERP; o motor não chama o cofre dentro da transação (decisão 3 do plano do PDV, orquestração, 17/11/2026).",
    replaced_by:
      "erp_pos_context devolve certificate='missing' (src/erp/domains/pos/internal.ts, certificateState). Quando o Fiscal chegar ao bloco de emissão, o Worker leva o estado do cofre (GET /v1/cofre, certificado.validoAte) num envelope, como a identidade, e o motor troca o missing por ele. O aviso principal do certificado fica na tela do emissor fiscal.",
    routes: ["GET /v1/frente-caixa"],
  },
  {
    id: "reforma-classificacao",
    oracle:
      "Nada: o Fagoo não tem campo de IBS, CBS nem IS (o motor de impostos os deixa \"como digitados\" e o complemento os exclui, not_included_in_profile); as regras da natureza só aceitam icms, ipi, pis, cofins e ii (nature_rule_tax_check).",
    reason:
      "Reforma tributária do consumo: a nota leva o grupo IBS/CBS (CST e cClassTrib) e o cofre da NFapi o aceita. Decisão da orquestração (17/11/2026, plano do Fiscal): classificar no cadastro sem mudar os checks nem as colunas do Fagoo; quem calcula os valores (cofre ou ERP) ainda é decisão do usuário, então o motor guarda a classificação e o resultado, não a regra.",
    replaced_by:
      "Tabelas só do motor (schema/engine-tables.ts, versão 7): erp_fiscal_reform__nature_class (padrão e exceções por NCM, produto ou grupo de cada natureza; RPCs erp_fiscal_reform_nature_class_get e _save, só do motor) e erp_fiscal_reform__product_class (do produto, com NBS do serviço; a escrita é combinada com o Catálogo). Resolução: produto > exceção da natureza > padrão da natureza (domains/fiscal/reform.ts).",
  },
  {
    id: "emissao-cofre",
    oracle:
      "Emissão própria do Fagoo: erp_fiscal_authorization.attempt (hash assinado, envelope, impressão do certificado, nonce), as filas unsigned_*/signed_*, numbering_* e reconciliation_*; eventos em erp_fiscal_invoices.event_request, cujo CHECK aceita só environment='2' (homologação).",
    reason:
      "A NF-e e a NFC-e são emitidas pelo cofre da NFapi, que guarda o A1, numera e transmite (plano do Fiscal aprovado pela orquestração, 17/11/2026, decisões 1 e 2). Nenhuma tabela do Fagoo guarda o pedido ao cofre sem distorcer, e o event_request não aceita a nota de produção registrada pela importação.",
    replaced_by:
      "Tabelas só do motor (schema/engine-tables.ts, versão 9): erp_fiscal_vault__emission (o pedido, com body que nunca vai para log nem atividade, a referência wb.<rascunho>.v<versão>, a situação e o resultado; a produção autorizada vira nota do ERP pela regra da importação de XML, invoice_id; a homologação fica só aqui) e erp_fiscal_vault__event (cancelamento, carta de correção, inutilização e manifestação do destinatário; alvo invoice_id, emission_id ou received_id conforme o tipo). As FKs para erp_fiscal_drafts__draft e erp_fiscal_invoices__invoice barram apagar de vez um rascunho ou nota com emissão ou evento: o Fagoo não apaga esses cabeçalhos (só os itens), e uma limpeza futura de rascunho ficaria barrada, o que é desejado.",
  },
  {
    id: "notas-recebidas-cofre",
    oracle:
      "erp_dfe (202610160045 e 202610210359): a coleta própria na distribuição DF-e (canal por CNPJ, NSU com checkpoint, tentativas com lease, objetos no Storage, resumo extraído), desligada no Fagoo; 14 funções e as rotas /v1/notas-recebidas.",
    reason:
      "A distribuição DF-e e a manifestação do destinatário são feitas pelo cofre da NFapi (0.9.0): o NSU, a espera do Ambiente Nacional e o bloqueio por consumo indevido são dele. O ERP só lê o que o cofre guardou e nunca fala com o governo (desenho aprovado pela orquestração, 17/11/2026).",
    replaced_by:
      "Tabelas só do motor (schema/engine-tables.ts, versão 9): erp_fiscal_vault__received (a última versão de cada nota recebida, com o vínculo à nota do ERP depois da importação), erp_fiscal_vault__received_change (cada mudança pela sequência do cofre, só acréscimo, com gatilhos de imutabilidade) e erp_fiscal_vault__cursor (a ultimaSequencia por conexão). A manifestação é um erp_fiscal_vault__event (emissao-cofre). O erp_dfe do Fagoo não é portado.",
  },
  {
    id: "comercial-nfe",
    oracle: "A emissão legada exige rascunho e restringe notas locais à homologação; não representa o pedido comercial emitido pelo cofre nos dois ambientes.",
    reason: "Fatia vender com NF-e: manter identidade fiscal e corpo persistidos, impedir repetição de nota e efeito e conservar evidência externa mesmo após falha local. Número, assinatura, transmissão, certificado e DANFE continuam no cofre.",
    replaced_by: "Versão 10 aditiva (9→10): commercial_settings, order_emission, order_revision, order_command, order_cancel, order_effect e order_audit em erp_fiscal_vault. Revisão e auditoria são imutáveis; pedido/versão, referência, comando e eixo têm unicidade. Corpo, resposta e XML são restritos, separados da auditoria resumida; nenhuma credencial é coluna do esquema. Emissões comerciais não são projetadas no acervo fiscal legado. Backup/restauração inclui ERP_ENGINE_TABLES; nenhuma migração D1 ou novo recurso.",
  },
];
