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
    id: "numero-json",
    oracle:
      "jsonb guarda o número como numeric, com o texto digitado: '1.0'::jsonb->>'x' é '1.0', não '1'. Regra que lê número como texto recusa o que não está na forma canônica; no lote do save, erp_documents.rich_text (b->>'indent' !~ '^[0-5]$', r->>'size' not in('8',…,'36')) recusa indent 1.0 ou size 1e1",
    reason:
      "O corpo do RPC chega ao motor por JSON.parse (rpc-endpoint.ts: request.json(); args.ts: jsonbArg), que transforma 1.0, 1e1 e 10.50 no número do JavaScript e perde o texto. O painel e os clientes em JavaScript nunca mandam essas formas (JSON.stringify escreve 1, 10 e 10.5); só um cliente montado à mão as manda.",
    replaced_by:
      "O motor aceita indent 1.0 e size 1e1 no texto rico (validados pelo valor) e grava o número na forma canônica. Fechar custa cerca de meio dia: ler o corpo com request.text() e JSON.parse com reviver, que guarda o texto original do número fora do canônico (context.source, disponível no Node 22 e no V8 do Workers) num WeakMap do objeto que o contém; jsonbText e o rich_text consultam esse texto; o harness passa a mandar o corpo em texto. O que é copiado por spread ou structuredClone perde o texto, por isso a correção vale só onde o objeto chega intacto.",
  },
];
