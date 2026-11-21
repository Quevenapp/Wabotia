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
  /** O que faz o papel no Vinki. */
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
    reason: "Login, sessão e segundo fator são do núcleo do Vinki, não do ERP.",
    replaced_by:
      "Porta de identidade (src/erp/engine/identity.ts): o Worker manda o envelope com quem chama (papel erp:<papel>, sessão, aal, fator) e as pessoas da área; o motor nunca consulta o D1. Fase 3: o preenchimento a partir do núcleo.",
  },
  {
    id: "membership-papel",
    oracle: "erp_access.membership gravada pelos RPCs de usuários (convite, user_save)",
    reason: "O papel do ERP vem do acesso por pessoa do Vinki (erp:admin|consulta|vendas|financeiro|estoque|fiscal; o administrador do Vinki vale erp:admin).",
    replaced_by:
      "Projeção antes de cada RPC (src/erp/domains/access/identity.ts): membership e profile seguem o envelope; sem erp:* a pessoa fica inativa e recebe 403. A tabela continua, com o último papel, e nenhum RPC grava papel.",
  },
  {
    id: "usuarios-supabase",
    oracle:
      "erp_access_user_invite_begin, user_invite_complete, users_list_v2, user_get, user_save, user_command, user_security, mfa_reset",
    reason: "Gestão de pessoas, convite, sessões e redefinição do segundo fator são telas do núcleo (Pessoas, login e MFA).",
    replaced_by:
      "Telas de Pessoas do Vinki: lista de pessoas com papel erp:*, convite, sessões e fator. Ficam no ERP: permissões finas e horário (user_controls), política de MFA do ERP, portão (gate_v2), atividade. Os 8 RPCs não são registrados: a erp-api responde 0A000 (501).",
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
    reason: "Integrações e agentes são aplicações do Vinki com chave e escopo.",
    replaced_by: "Aplicações do Vinki com escopos erp:read e erp:write (fase 3). O /mcp do Fagoo é bloco externo (src/erp/blocks.ts).",
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
    reason: "O armazenamento do Vinki é o R2 (binding MEDIA).",
    replaced_by:
      "storage_ready não lança; ctx.objects (registerRpc(…, { objects })) e ctx.listing (registerRpc(…, { listing: true })) lidos do R2 antes da transação, em erp-storage/<área>/<bucket>/<nome>.",
  },
  {
    id: "certificado-a1",
    oracle: "bucket brufap-a1-vault (202610160041_a1_custody): custódia do certificado A1 no Storage",
    reason: "Decisão do usuário: o certificado A1 nunca fica no Vinki, que tem bots e integrações; ele mora no cofre da NFapi, separado.",
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
    reason: "O token é o da sessão do Vinki.",
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
    reason: "No Vinki o ERP mora no objeto erp:<área>, que tem alarme próprio; o cron do Worker só acorda.",
    replaced_by:
      "Despachante no alarme do objeto (src/erp/scheduler/, docs/ERP-AGENDADOR.md) com a tabela wb_routine (estado das rotinas: próximo horário, último resultado, falhas), do Vinki, criada pelo migrate como a erp_meta (WB_ROUTINE_DDL), fora do DDL gerado e do backup.",
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
    id: "reforma-calculo",
    oracle:
      "Nada: o Fagoo não calcula IBS, CBS nem IS, não guarda alíquotas por ano da transição nem a opção do Simples pelo regime regular.",
    reason:
      "Reforma tributária do consumo: a partir de 2026 a NF-e leva o grupo IBS/CBS (informativo em 2026, alíquotas de teste de 0,9% e 0,1%) e as propostas e pedidos mostram os valores. O cofre da NFapi recebe os valores calculados pelo ERP.",
    replaced_by:
      "Tabelas só do motor (schema/engine-tables.ts, versão 26): erp_fiscal_reform__settings (opção do Simples pelo regime regular e alíquotas informadas para anos não publicados) e erp_fiscal_reform__product_selective (Imposto Seletivo do produto). Tabela de classificações e alíquotas por ano como dado em domains/fiscal/reform-table.ts; cálculo puro em domains/fiscal/reform-calc.ts; RPCs só do motor em domains/fiscal/reform.ts.",
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
  {
    id: "receber-bling",
    oracle: "Coletor externo com posse, checkpoints, bruto, espelhos e sincronização operacional.",
    reason: "Receber e preservar os dados no Coordinator da área, com precisão e histórico, sem produzir registros operacionais ou habilitar envio.",
    replaced_by: "Versão 11 aditiva (10→11, também na subida desde 9): wb_bling_control, wb_bling_unit, wb_bling_receipt, wb_bling_extra_raw, wb_bling_record_version e wb_bling_audit. As 18 entidades conservam raw_record/batch_inbox e os CHECKs legados; source_version guarda versões anteriores. Credenciais ficam somente no cofre do núcleo. Backup exclui credenciais e OAuth e restaura a coleta desligada, sem posses ou aprovação de instalação. Montagem inicial indisponível; a sincronização operacional permanece desligada.",
  },
  {
    id: "adotar-bling",
    oracle: "Importações revisadas do coletor externo (erp_catalog.origin, taxonomy_source, erp_warehouse_import.binding) com estados e candidatos próprios de cada domínio.",
    reason: "Fatia B1: a pessoa transforma os cadastros do acervo em cadastros do ERP, com revisão, pelas mesmas RPCs das telas; nada é escrito no Bling e erp_sync__settings continua desligado.",
    replaced_by: "Versão 12 aditiva (11→12): wb_bling_adoption_link (vínculo entidade/id no Bling → cadastro, com versão e hash coletados), wb_bling_adoption_review (pendências e ignorados, com motivo e candidatos), wb_bling_adoption_job (trabalho em lote retomável pelo alarme) e wb_bling_adoption_command (recibos imutáveis dos comandos). Desligar do Bling apaga só o vínculo; o cadastro do ERP fica.",
  },
  {
    id: "adotar-bling-b2",
    oracle: "Importações do coletor externo para propostas (origin_proposal_import), pedidos (origin_*_readiness), contas (origin_financial_import) e o espelho de documentos (document_origin_mirror, authority 'origin').",
    reason: "Fatia B2: documentos e contas em aberto no Bling viram documentos e títulos do ERP pelas mesmas RPCs das telas, sem efeitos de estoque, contas ou nota; os encerrados ficam só para consulta, fora das tabelas de documento e de título.",
    replaced_by: "Versão 13 aditiva (12→13): wb_bling_adoption_doc_link (vínculo de proposta, pedido de venda, pedido de compra, conta a receber e a pagar ao documento ou título do ERP), wb_bling_adoption_doc_review (pendências com o cadastro que falta adotar) e wb_bling_adoption_history (índice do espelho histórico: número, contato, data, situação e total do que já está encerrado no Bling; o documento como veio continua no acervo). Desligar do Bling apaga só o vínculo.",
  },
  {
    id: "cupom-nfce",
    oracle: "A NFC-e do PDV é preparada pela tela de notas fiscais legada (homologação), a partir do pedido, com certificado no ERP.",
    reason: "Fatia balcão com NFC-e: a venda do caixa pede o cupom ao cofre da NFapi pela mesma máquina da NF-e comercial (revisão imutável, reivindicação durável, retomada por consulta, cancelamento, efeitos e auditoria), sem a venda esperar a nota.",
    replaced_by: "Versão 14 aditiva (13→14): counter_emission, counter_revision, counter_command, counter_cancel, counter_effect e counter_audit em erp_fiscal_vault, com o DDL da versão 10 e a chave de acesso do modelo 65, e counter_settings (natureza do cupom). A conexão, o ambiente e a habilitação de produção são os de commercial_settings. Série, CSC e contingência ficam no cofre.",
  },
  {
    id: "corte-bling",
    oracle: "Corte do coletor externo (erp_cutover, abertura do estoque e do financeiro pelo espelho), nunca concluído: reconciled false.",
    reason: "Fatia C: a pessoa escolhe a data a partir da qual o ERP vale; contas parciais pelo saldo, saldos de abertura das contas financeiras, estoque de abertura por depósito, notas emitidas no Bling só para consulta, pacote do contador e conferência final que só conclui sem pendência não justificada.",
    replaced_by: "Versão 15 aditiva (14→15): wb_bling_cutover (data de corte confirmada por um administrador, conclusão e fotografia da conferência) e wb_bling_cutover_item (o que cada etapa gravou: parcial adotada, saldo de abertura, estoque de abertura por depósito, pacote do contador e suas partes no R2, justificativas e conflitos decididos). Os lançamentos passam pelas RPCs das telas (erp_finance_title_execute, erp_finance_cash_execute, erp_stock_post).",
  },
  {
    id: "nota-servico-os",
    oracle: "A ordem de serviço do ERP não emite NFS-e; a nota de serviço é feita fora do sistema.",
    reason: "Ordem de serviço, parte 5: a ordem com orçamento aprovado emite a NFS-e do Sistema Nacional (serviços) e a NF-e modelo 55 (peças) pelo cofre da NFapi, pela mesma máquina da NF-e comercial, sem lançar estoque nem financeiro de novo (os efeitos são os da fase 3).",
    replaced_by: "Versão 16 aditiva (15→16): service_emission, service_revision, service_command, service_cancel, service_effect e service_audit em erp_fiscal_vault, com o DDL da versão 10 e os limites da NFS-e (série de até 5 dígitos, número da DPS de até 15, chave nacional de até 50 caracteres e o número da NFS-e na coluna protocol), e service_settings (código de tributação, NBS, ISS e município de prestação, com exceções por serviço). Inscrição municipal, série da DPS e regime especial ficam no cofre.",
  },
  {
    id: "compra-nota-recebida",
    oracle: "Importação de XML da NF-e de entrada para a nota fiscal do ERP (erp_fiscal_invoice_import, não portada no motor) e conferência pelo check-in do recebimento; o Fagoo não dá entrada direta da nota recebida no estoque, no custo e nas contas a pagar.",
    reason: "Compra pela nota do fornecedor, como no Bling: a nota recebida (do cofre da NFapi ou importada à mão) é conferida e dá entrada no estoque, no custo de entrada e nas contas a pagar pelas rotinas das telas (erp_stock_launch, erp_stock_lot_launch, erp_finance_title_execute), numa transação idempotente pela chave da nota; estorno pelas guardas existentes (erp_stock_reverse, title_cancel).",
    replaced_by: "Versão 17 aditiva (16→17): erp_purchase_inbound__note (índice da nota; o XML fica no R2 da área), erp_purchase_inbound__entry (a entrada, uma ativa por nota, com o que foi feito e o estorno) e erp_purchase_inbound__settings (interruptor do administrador para manifestar, desligado). O vínculo código do fornecedor → produto é o erp_catalog__product_supplier e a conversão de unidade, o erp_stock__unit_conversion. A situação no cofre continua em erp_fiscal_vault__received/_change/_cursor e a manifestação, em erp_fiscal_vault__event (versão 9).",
  },
  {
    id: "eventos-nfe",
    oracle: "Carta de correção, inutilização e devolução pela tela de notas fiscais legada (event_request e nota de devolução no formulário), só em homologação e sem efeito no estoque nem nas contas.",
    reason: "Fiscal, depois da nota autorizada: a carta de correção e a inutilização vão pelo cofre da NFapi, e a devolução de venda vira uma NF-e de devolução (finalidade 4, nota referenciada) emitida pelo cofre, com entrada no estoque e efeito nas contas uma vez só.",
    replaced_by: "Versão 18 aditiva (17→18): order_correction (cartas da NF-e do pedido, sequência de 1 a 20, texto e XML do evento), void_range (inutilizações de NF-e e NFC-e por série e faixa) e order_return (devolução de venda: itens e quantidades, corpo da NF-e de devolução, resultado do cofre e o estado de cada efeito, estoque e financeiro, que só muda de pendente para aplicado uma vez). Número, assinatura e transmissão continuam no cofre.",
  },
  {
    id: "mao-dupla-bling",
    oracle: "Mão dupla do coletor externo (erp_sync: settings, link, outbox, inbox, issue, run, stock_pair), com gatilhos nas tabelas do ERP que enfileiravam toda alteração e um executor externo que reivindicava a fila.",
    reason: "Mão dupla com o Bling depois do corte: a coleta incremental aplica no ERP, pelas mesmas funções da adoção, o que mudou no Bling, e o que muda no ERP volta ao Bling por uma fila retomável no alarme do Coordinator, sem gatilho nas tabelas do domínio. Interruptor por entidade e sentido, todos desligados; resposta incerta nunca é repetida sem conferir no Bling; conflito dos dois lados vira pendência; nunca nota fiscal nem ordem de serviço.",
    replaced_by: "Versão 19 aditiva (18→19): wb_bling_twoway (ritmo e últimas rodadas), wb_bling_twoway_setting (interruptor por entidade e sentido), wb_bling_twoway_state (linha de base de cada registro: impressão do ERP e versão do Bling na última sincronização), wb_bling_twoway_outbox (fila de saída com id estável, conferência por GET), wb_bling_twoway_issue (pendências e conflitos com os dois lados) e wb_bling_twoway_audit (quem ligou ou desligou, imutável). A mudança no ERP é achada pela impressão do que seria enviado, sem gatilho.",
  },
  {
    id: "campos-contato",
    oracle: "Campos customizados só de produtos (erp_catalog.custom_field com CHECK module='products'); o contato não tem onde guardar campos próprios.",
    reason: "Cadastros: campos próprios de contato (texto, número, data, lista e sim/não), por tipo de contato, com obrigatório, coluna e filtro da lista, exportação e importação, e o campo sensível que só vai para listagens, ficha do atendimento, IA e bots quando o administrador libera.",
    replaced_by: "Versão 20 aditiva (19→20): contact_field (definição, opções da lista, tipos de contato, sensível e liberação com quem e quando), contact_field_value (valor por contato e campo) e contact_field_audit (registro imutável das alterações, inclusive liberar e recolher campo sensível) em erp_catalog. RPCs só do motor erp_catalog_contact_field_* (domains/catalog/contact-fields.ts), na parte Cadastros; a rota do Vinki /api/v1/profiles/:profile/erp-contato-campos (src/erp/contact-fields) atende o painel, a ficha do atendimento e os bots.",
  },
  {
    id: "relatorios-dre-equipe",
    oracle: "O Financeiro classifica as categorias do primeiro nível em grupos de DRE sem Custos e não tem pagamento de funcionário: o funcionário do cadastro não é contato e não recebe conta a pagar.",
    reason: "Relatórios do ERP: DRE gerencial com Custos separados das despesas, e o pagamento da equipe (salário, comissão, adiantamento e vale) como conta a pagar com a pessoa ligada, o período e, na comissão de vendedor, a base e o percentual conferidos.",
    replaced_by: "Versão 21 aditiva (20→21): erp_finance__dre_cost (a categoria de despesa do primeiro nível que o DRE mostra em Custos; o dre_group continua o do oráculo, Despesas Operacionais) e erp_finance__team_payment (a conta a pagar, funcionário ou vendedor, tipo, período, base e percentual). A conta a pagar é a do Financeiro (erp_finance__title), no contato do vendedor ou no contato com o CPF do funcionário.",
  },
  {
    id: "contador-pacote",
    oracle: "O espaço do contador monta no navegador um ZIP com os XML importados da competência (até mil notas por tipo, sem cartas de correção, inutilizações nem PDFs) e nada fica gravado.",
    reason: "Para o contador: o pacote do período com os XML das notas emitidas pelo emissor do Vinki (NF-e, NFC-e e NFS-e, com cancelamentos, cartas de correção e inutilizações), das recebidas com entrada e do acervo do Bling, os PDFs que o emissor oferece e a planilha de índice, montado aos poucos no alarme do objeto da área, com as partes no R2, para baixar pela tela ou pelo link enviado ao contador.",
    replaced_by: "Versão 22 aditiva (21→22): erp_contador__package (um pacote por ambiente e período, com etapa, cursor, contagens, avisos e o deslocamento do ZIP) e erp_contador__part (cada parte gravada no R2, com os arquivos e as linhas da planilha). O cadastro do contador, os envios e os links ficam no D1 (migração 0195).",
  },
  {
    id: "ordem-producao",
    oracle: "O Estoque tem composição (estrutura e kit) e lotes, mas não tem ordem de produção: transformar insumos em produto acabado era um lançamento manual de saída e outro de entrada, sem custo do acabado.",
    reason: "Produção: a ordem de produção (produto acabado, quantidade, depósitos de insumos e do acabado, data, responsável) com os insumos vindos da composição e editáveis, a conclusão total ou parcial que dá baixa dos insumos e entrada do acabado numa transação, com o custo dos insumos mais o custo adicional, o estorno pelas guardas do Estoque e o planejamento a partir dos pedidos de venda em aberto.",
    replaced_by: "Versão 23 aditiva (22→23): erp_production__order, erp_production__order_input, erp_production__completion, erp_production__completion_input e erp_production__command. Os lançamentos são os do Estoque (erp_stock_post para a saída dos insumos, erp_stock_launch ou erp_stock_lot_launch para a entrada do acabado com o custo, erp_stock_reverse no estorno); RPCs só do motor erp_production_* (domains/production), na parte Produção; a rota do Vinki /api/v1/profiles/:profile/erp-producao (src/erp/production) atende o painel e os bots.",
  },
  {
    id: "adotar-bling-d",
    oracle: "O coletor externo não lia listas de preços, naturezas de operação, campos customizados, contratos, NFS-e, lotes nem fornecedores de produto do Bling; esses dados ficavam fora do ERP.",
    reason: "Fatia D do Bling: o coletor lê esses recursos (cada um desligado e não confirmado até o dono conferir) e a adoção revisada os leva às listas de preços, às naturezas do fiscal (sem trocar a padrão), aos campos próprios de produto e de contato, aos lotes do estoque, ao fornecedor do produto e ao contrato de manutenção da ordem de serviço; NFS-e fica só de consulta. Listas e campos entram na mão dupla com interruptores desligados.",
    replaced_by: "Versão 24 aditiva (23→24; 22 e 23 são de outras frentes): wb_bling_adoption_extra_link (vínculo por entidade e id no Bling, com a impressão do ERP), wb_bling_adoption_extra_review (pendências com o motivo), wb_bling_adoption_extra_twoway (interruptor por tipo e sentido, desligados), wb_bling_adoption_extra_outbox (fila de saída das listas e dos campos) e wb_bling_adoption_extra_audit (quem ligou ou desligou, imutável). O acervo bruto continua em wb_bling_extra_raw (versão 11).",
  },
  {
    id: "expedicao",
    oracle: "O pedido de venda tem conferência (checkout) por pedido e transportadora, mas não tem separação de vários pedidos juntos, embalagens, volumes com peso e medidas, etiqueta de volume, romaneio assinado nem devolução física fora da nota fiscal.",
    reason: "Expedição (parte erp-expedicao, depende de Vendas e Estoque): lista de separação consolidada por produto e endereço, situação do pedido na expedição (a separar, em separação, separado, embalado, expedido), pendência quando falta quantidade, embalagens e volumes que alimentam o transporte do pedido, etiquetas e romaneio, entrega local pelo módulo Entrega e devolução física com entrada no estoque.",
    replaced_by: "Versão 25 aditiva (24→25): erp_shipping__package, __order, __pick_list, __pick_line, __pending, __volume, __return e __command. A situação comercial do pedido não muda; a pendência também entra como ocorrência do pedido; o transporte do pedido (volumes e peso bruto) é gravado pelo salvamento do próprio pedido; a entrada no estoque é a do Estoque (erp_stock.post, recebimento); a devolução fiscal continua a da NF-e (só o atalho).",
  },
  {
    id: "lojas",
    oracle: "A área tem uma empresa só: depósitos, contas financeiras (e caixas do PDV), pedidos, propostas, compras e contas a pagar ou receber não têm loja, e o papel da pessoa vale para tudo.",
    reason: "Lojas e filiais do mesmo dono (mesmo cofre de notas): cadastro de lojas com endereço, telefone, CNPJ da filial, depósito padrão, série e caixas; a loja vai com cada operação (padrão: a loja em uso da pessoa), as listas e os relatórios filtram e comparam por loja, o administrador pode limitar uma pessoa a algumas lojas e o bot respeita a pessoa por quem age somada ao limite do bot. Com uma loja só nada aparece de novo.",
    replaced_by: "Versão 27 aditiva (26→27; a 26 é de outra frente): erp_store__store, __warehouse, __account, __document, __title, __person, __selection, __command e __audit. Nenhuma coluna nova nas tabelas do oráculo: sem vínculo, o depósito, a conta e o documento são da loja principal (que nasce com os dados da empresa); o documento sem vínculo segue a loja do depósito dele; o que nasce com duas lojas ou mais ganha o vínculo na mesma transação (domains/stores). Transferência entre lojas é a transferência entre depósitos (erp_stock_transfer_batch).",
  },
  {
    id: "importacao-fiscal",
    oracle: "A importação por planilha cobre produtos, contatos, compras, vendas, estoque, contas, composições, campos customizados, fornecedores de produto e lotes; o CHECK de kind de erp_preferences.import_job só aceita esses tipos e não há planilha fiscal, de naturezas nem de saldos iniciais.",
    reason: "Quem vem de outro sistema traz por planilha os dados fiscais dos produtos (NCM, CEST, origem, unidade e GTIN tributáveis, CST/CSOSN e alíquotas por natureza, benefício fiscal), as naturezas de operação com as regras fiscais e o saldo inicial das contas financeiras, com prévia, lote, idempotência e relatório de erros da importação existente.",
    replaced_by: "Versão 28 aditiva (27→28; 26 e 27 são de outras frentes): erp_preferences__import_job_kind (job_id, kind product_taxes | natures | opening_balances). O lote continua em import_job com um tipo de apoio (products, nfe ou receivables), import_row e import_command; as leituras do lote, a lista, as partes e o registro de atividades usam o tipo desta tabela quando ela tem a linha. As linhas gravam pelas RPCs dos domínios (erp_catalog_product_save, erp_fiscal_nature_execute e o lançamento do Financeiro).",
  },
  {
    id: "obrigacoes-arquivo",
    oracle: "O ERP não gera SPED Fiscal (EFD ICMS/IPI), EFD-Contribuições nem SINTEGRA: quem precisava dos arquivos pedia ao contador ou gerava em outro sistema.",
    reason: "Obrigações fiscais em arquivo: a conferência do que falta (IE, NCM, unidade, documento do participante, nota sem item) com o atalho para corrigir, e a geração do SPED Fiscal, da EFD-Contribuições e do SINTEGRA do período a partir dos XML das notas emitidas pelo emissor e das recebidas com entrada, do inventário do Estoque e dos cadastros, montada aos poucos no alarme do objeto da área, com as partes do texto no R2. Nada é transmitido ao governo: o arquivo é para o contador ou para o validador oficial (PVA).",
    replaced_by: "Versão 29 aditiva (28→29): erp_sped__settings (configuração do arquivo: perfil, atividade, contador do registro 0100, regime do PIS/COFINS e códigos do SINTEGRA), erp_sped__file (um arquivo por tipo, ambiente e período, com etapa, cursor, contagens, pendências, avisos, partes e o resumo do texto) e erp_sped__doc (as notas lidas e normalizadas do arquivo em montagem, apagadas quando ele fica pronto). Os pedidos de envio ao contador esperando o pacote ficam no D1 (migração 0240).",
  },
  {
    id: "conciliacao",
    oracle: "A conciliação bancária importa só OFX com FITID, sugere um único lançamento de mesmo valor em até 3 dias, oculta linhas sem motivo e não tem regras salvas, saldo do banco por dia nem conciliação das vendas de cartão com a adquirente.",
    reason: "O dono importa o extrato do banco em OFX ou planilha (com o modelo de colunas salvo por banco), recebe sugestões com grau de confiança (baixas, lançamentos, transferências, contas em aberto pelo valor, vencimento e nome do pagador, e as regras que ele mesmo salvou), concilia, baixa ou lança com um clique, ignora com motivo, desfaz e compara o saldo do banco com o do sistema por dia; e importa o extrato de vendas e de recebíveis da adquirente, casa com as vendas do PDV e dos pedidos, confere a taxa cobrada com a contratada, vê o que ainda vai cair e baixa o recebimento na conta.",
    replaced_by: "Versão 30 aditiva (29→30; a 29 é de outra frente): erp_reconciliation__layout, __rule, __bank_line, __bank_balance, __card_rate, __card_import, __card_line, __command e __audit. Nenhuma coluna nova nas tabelas do Financeiro: a linha do extrato, os vínculos, a baixa, o lançamento e o desfazer continuam pelas RPCs dele (erp_finance_reconciliation_execute e erp_finance_execute); linha de planilha sem identificador ganha um FITID estável pela data, valor, descrição e ordem no arquivo; ignorar é ocultar a linha com o motivo guardado aqui. Domínio em src/erp/domains/reconciliation, rotas em src/erp/conciliacao.",
  },
  {
    id: "contratos",
    oracle: "Não há contrato de serviço genérico: a conta recorrente do Financeiro repete um valor, sem itens, vigência, reajuste por índice, aditivo nem renovação; o contrato de manutenção é da Ordem de Serviço, sobre a Mensalidade.",
    reason: "Contratos de serviço (parte Contratos, depende do Financeiro, desligada por padrão): cliente, objeto, itens do catálogo, vigência com fim ou prazo indeterminado, periodicidade, dia de vencimento, forma, categoria, vendedor e anexos; o alarme gera a conta a receber de cada período uma vez só (a cobrança nasce desligada por contrato); reajuste por IPCA, IGP-M, INPC (percentual informado na tabela de índices) ou percentual fixo no mês de aniversário; aviso de renovação, renovação e aditivo com histórico; adoção dos contratos do acervo do Bling.",
    replaced_by: "Versão 31 aditiva (30→31; 29 e 30 são de outras frentes): erp_contract__contract, __item, __invoice, __event, __index_rate, __attachment, __notice, __bling_link e __command. A conta a receber é a do Financeiro (erp_finance__title, insertTitle), com o contrato na referência; a fatura do período tem chave única (contrato, início do período). O arquivo do anexo fica no R2 da área; aqui só o índice. O envio da cobrança pelo WhatsApp é o que existe (erp-conversa, conta); a NFS-e fica marcada a emitir quando o fiscal de serviço está configurado.",
  },
  {
    id: "bling-conta-real",
    oracle: "O coletor externo do Bling só lia: a nota emitida, a situação do pedido e o rastreio nunca voltavam ao Bling, e não havia aviso do Bling (webhook) para adiantar a coleta.",
    reason: "Bling numa conta real: o pedido que veio do Bling e foi atendido aqui devolve ao Bling a chave, o número e a série da NF-e autorizada, a situação (separado, faturado, enviado, entregue, cancelado, pelo id de situação que o dono escolhe) e o código de rastreio da Expedição, pela fila de saída da mão dupla (id estável, conferência por GET antes de reenviar, pendência com motivo). O aviso do Bling (webhook assinado) adianta a coleta das entidades que ele cobre; a consulta periódica continua como reserva. Interruptores próprios, desligados, só do administrador.",
    replaced_by: "Versão 32 aditiva (31→32): wb_bling_return_setting (interruptores da nota, da situação e rastreio e do webhook, com o mapa de situações), wb_bling_return_outbox (fila da volta ao Bling: id estável por pedido, tipo e impressão do que vai, passo de leitura e de escrita) e wb_bling_webhook_hint (entidade avisada pelo webhook, a coletar já). As pendências usam wb_bling_twoway_issue (entidade sales_orders, chave ret:). O evento do webhook passa pela tabela erp_bling_webhook_event do D1 (migração 0280), conferido pela assinatura do Bling.",
  },
  {
    id: "regua-cobranca",
    oracle: "As preferências de envio automático de boletos (dias antes, no dia e dias depois do vencimento) só eram guardadas: nenhuma rotina enviava; a conta recorrente só era gerada à mão, em Gerar contas.",
    reason: "Régua de cobrança (desligada por padrão, ligada pelo administrador com aviso): pelos dias da régua (em branco, os das preferências de Contas a receber, que são da Cobrança bancária), o aviso antes do vencimento, no dia e depois, pelo envio de conta pelo WhatsApp que já existe (com Pix, link ou boleto) e pelo e-mail quando o canal existir; uma vez por conta e etapa, no horário comercial e só a quem pode receber (janela de 24 horas ou modelo com consentimento); conta paga, baixada ou cancelada sai da régua. Contas recorrentes marcadas como automáticas são geradas pelo alarme na data de emissão, uma vez por período, com a opção de já enviar a cobrança.",
    replaced_by: "Versão 34 aditiva (33→34; 32 e 33 são de outras frentes): erp_finance__dunning_step (etapa por conta, etapa e canal, com a situação: a enviar, enviando, enviada, falhou, pulada, cancelada), erp_finance__recurrence_auto (recorrência automática e envio ao gerar) e erp_finance__recurrence_run (o que o alarme fez em cada período). Nenhuma coluna nova nas tabelas do Financeiro: a conta é gerada por recurrenceTitle, como em Gerar contas. Quem ligou a régua, os dias, o canal e o horário ficam no D1 (migração 0290); o envio é o da conversa (erp-conversa, conta), chamado pelo alarme da área.",
  },
];
