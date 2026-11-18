# 1. Escolas: infantil, cursos livres, idiomas e reforço

**Proposta de modelo de área e extensão Ensino — 18/11/2026.**

Base de referência: commit `efc7e54`, informado para esta revisão. A versão declarada é `0.21.1` (`package.json:3`). Este documento propõe configurações e contratos futuros. Não representa funcionalidades já entregues. A revisão foi somente de leitura, sem rede, alterações ou execução de testes.

## 1. Quem usa e como é o dia a dia

A secretaria recebe interessados, organiza documentos e acompanha matrículas.  
A coordenação define turmas, calendário, avaliações e comunicados.  
O professor registra frequência e avaliações das próprias turmas.  
O financeiro atende o responsável pelo pagamento.  
No WhatsApp, o interlocutor principal é o responsável pelo aluno.  
Um aluno pode ter vários responsáveis, com permissões diferentes.  
As perguntas mais comuns são sobre vagas, horários, material, mensalidade, faltas e boletim.  
O cadastro central é o aluno. Matrículas, solicitações e cobranças ficam ligados a ele.  
O aluno adulto pode ser o próprio interlocutor, mediante vínculo explícito.

### Base técnica e limites da proposta

| Ponto conferido | Consequência para o desenho |
|---|---|
| Os nove estados estão em `src/modules/os/model.ts:6`. As transições manuais são fixas em `src/modules/os/model.ts:41`. | As etapas escolares exigem o motor generalizado. Não basta trocar rótulos. |
| A ordem possui `item`, `problem` e um telefone em `migrations/0035_os_orders.sql:20`. | O telefone da ordem será o contato principal. Ele não substitui o cadastro de responsáveis. |
| O acompanhamento consulta conversa ou telefone verificado em `src/modules/os/store.ts:1027`. | O acesso de outros responsáveis exige autorização adicional por aluno. |
| A projeção atual oculta telefone e notas conforme escopos em `src/modules/os/store.ts:166`. | Isso não implementa, por si só, sigilo pedagógico nem restrição por turma. |
| A numeração é única por área em `migrations/0035_os_orders.sql:57`. A paginação usa esse número em `src/modules/os/store.ts:266`. | Numeração própria por tipo precisa de contrato adicional, preservando a numeração legada. |
| `counts` resulta dos estados encontrados no banco em `src/modules/os/store.ts:257`. | O código lido não preenche necessariamente nove chaves com zero. Preservar o comportamento legado; não prometer nove chaves sempre presentes. |
| O lembrete de retirada procura `status='ready'` em `src/modules/os/reminders.ts:23`. | Etapas escolares não podem disparar retirada. O motor deve consultar os recursos do tipo. |
| O aviso de ordem parada usa `updated` e configuração comum em `src/modules/os/reminders.ts:48`. | O prazo por etapa e o significado de zero como “desligado” são contratos novos. |
| Modelos existentes usam a gravação de configurações em `src/service-templates.ts:442`. | O modelo escolar deve continuar sendo configuração comum após aplicado. |
| O registro de módulos lido não contém Ensino em `src/modules/registry.ts:31`. | `ensino`, suas rotas, papéis e menus abaixo são propostas novas. |

**Contrato comum aos dois modelos deste documento:**

| Elemento | Proposta |
|---|---|
| Registro de trabalho | Continua em `os_orders`. O aluno permanente fica separado, na extensão Ensino. |
| Etapa e estado | `stage` identifica a etapa própria. `status` mantém um dos nove códigos de base. |
| Número | Preservar `number` e sua paginação. Acrescentar número de apresentação por tipo, por exemplo `type_number`. Não remover a restrição atual. Contrato definitivo: **a conferir na fase 0**. |
| Transições | Validar pelo grafo do tipo. Não usar somente `MANUAL_TRANSITIONS` nos tipos novos. |
| Efeitos de uma etapa | Orçamento, garantia e retirada dependem dos recursos habilitados. O estado de base sozinho não autoriza esses efeitos. |
| Aviso de etapa parada | Contar desde a entrada na etapa. Zero desliga o aviso. Enviar uma vez por permanência na etapa. |
| Tarefas padrão | Criar uma vez por entrada efetiva na etapa. Repetir a mesma requisição não duplica tarefas. |
| Prazos das tarefas | `due_days` representa dias corridos desde a entrada na etapa. Zero significa o mesmo dia. |
| Mensagem vazia | Não enviar mensagem. |
| Marcadores | Usar lista permitida. Neste modelo, mensagens de trabalho usam somente `{numero}`. Não interpolar nome de criança, nota, falta ou conteúdo de ocorrência. |
| Campos sensíveis | “Sensível” é uma classificação conservadora do produto. Não significa que todo campo assim marcado seja dado pessoal sensível na classificação jurídica. |
| Aplicação do modelo | Criar com prefixo do modelo. Preservar itens existentes e edições manuais. Exibir conflitos na prévia. |
| Módulos desligados | São a configuração sugerida para uma área nova. Não desligar silenciosamente módulos já usados pela área. |
| Tipo embutido | Manter integralmente as regras e mensagens atuais de “Ordem de serviço”. |

## 2. Tipos de trabalho

### 2.1. Matrícula

| Propriedade | Valor |
|---|---|
| Identificador | `escolas_matricula` |
| Singular | Matrícula |
| Plural | Matrículas |
| Campo fixo `item` | Aluno |
| Campo fixo `problem` | Curso ou etapa pretendida |
| Unidade do registro | Uma matrícula do aluno em um curso ou ciclo letivo |
| Identidade permanente | Cadastro do aluno na extensão Ensino |
| Telefone principal | Responsável indicado para o atendimento administrativo |
| Nova matrícula | Criar na renovação de ciclo. Reutilizar o cadastro do aluno. |

O nome do aluno no campo fixo exige a mesma proteção do cadastro pedagógico. Não pode aparecer em ferramentas de IA, busca ampla, eventos ou notificações para pessoas sem autorização.

#### Campos extras

“Obrigatório” indica exigência no cadastro completo. Um interesse inicial pode ser salvo como rascunho. A ativação exige a conferência dos dados e vínculos.

| Chave | Rótulo | Tipo | Obrigatório | O cliente vê | Sensível |
|---|---|---|---|---|---|
| `modalidade` | Modalidade | `lista`: infantil, curso_livre, idiomas, reforco | Sim | Sim | Não |
| `curso` | Curso ou etapa | `texto` | Sim | Sim | Não |
| `ciclo_letivo` | Ciclo letivo | `texto` | Sim | Sim | Não |
| `turno` | Turno pretendido | `lista`: manha, tarde, noite, integral, a_definir | Sim | Sim | Não |
| `inicio_previsto` | Início previsto | `data` | Não | Sim | Não |
| `observacao_restrita` | Observação administrativa restrita | `texto_longo` | Não | Não | Sim |

Turma, responsáveis e assinatura financeira são vínculos estruturados. Não devem ser textos livres desses campos extras.

#### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `interesse` | Interesse recebido | `received` | `visita`, `documentos`, `cancelada` | Recebemos o interesse de matrícula nº {numero}. A secretaria vai conferir as opções e orientar os próximos passos. | 2 |
| `visita` | Visita ou conversa inicial | `analyzing` | `documentos`, `interesse`, `cancelada` | A matrícula nº {numero} está na etapa de visita ou conversa inicial. Use Agendar visita no menu para escolher um horário. | 3 |
| `documentos` | Documentos em conferência | `analyzing` | `contrato`, `visita`, `cancelada` | A matrícula nº {numero} está em conferência de documentos. Consulte as pendências no atendimento seguro. Não envie documentos pessoais neste chat. | 3 |
| `contrato` | Contrato para aceite | `analyzing` | `documentos`, `ativa`, `cancelada` | O contrato da matrícula nº {numero} está disponível para conferência no atendimento seguro. A matrícula depende da confirmação da secretaria. | 5 |
| `ativa` | Matrícula ativa | `in_progress` | `trancada`, `encerrada` | A matrícula nº {numero} está ativa. Calendário, material e horários estão disponíveis no menu. | 0 |
| `trancada` | Matrícula trancada | `analyzing` | `ativa`, `encerrada` | O trancamento da matrícula nº {numero} foi registrado. A secretaria informará as condições para retorno e os ajustes financeiros aplicáveis. | 0 |
| `encerrada` | Matrícula encerrada | `delivered` | Nenhuma | A matrícula nº {numero} foi encerrada. Documentos e pendências podem ser solicitados à secretaria. | 0 |
| `cancelada` | Matrícula não concluída | `cancelled` | Nenhuma | O pedido de matrícula nº {numero} foi cancelado antes da ativação. Para iniciar outro pedido, use Nova matrícula. | 0 |

**Condições das transições:**

| Transição | Conferência obrigatória |
|---|---|
| Para `contrato` | Documentos necessários conferidos; oferta e condições financeiras definidas. |
| Para `ativa` | Aluno identificado; responsável autorizado; contrato aceito por pessoa habilitada; turma com vaga; vínculo financeiro definido. |
| Para `trancada` | Data efetiva, motivo administrativo e efeito sobre a enturmação registrados. |
| De `trancada` para `ativa` | Vaga e condições de retorno conferidas novamente. |
| Para `encerrada` | Data de encerramento, situação da turma e encaminhamento financeiro registrados. |
| Renovação após encerramento | Nova matrícula ligada ao mesmo aluno. Não reabrir o registro encerrado. |

O aceite do contrato não usa a aprovação de orçamento da OS. O código atual reserva aprovação e recusa ao fluxo de orçamento (`src/modules/os/model.ts:35`). A assinatura educacional precisa registrar documento, versão, pessoa, vínculo e momento do aceite.

#### Recursos ligados

| Recurso | Configuração e uso |
|---|---|
| Orçamento com aprovação | Desligado. Valores e condições ficam no contrato e nos módulos financeiros. |
| Garantia | Desligada. |
| Retirada | Desligada. |
| Termos | Ligados. Aceite de abertura separado do contrato educacional. |
| Tarefas e prazos | Ligados. Conferência de interesse, documentos, contrato, ativação e encerramento. |
| Pessoas ligadas | Aluno; responsável pedagógico; responsável financeiro; representante habilitado para assinar; coordenador. Uma pessoa pode acumular papéis. |
| Documentos | Contrato, lista de material, calendário e declaração aprovada podem ser entregues ao destinatário autorizado. Documentos de identidade e provas de representação não têm envio automático. |
| Lançamentos | Contato administrativo, conferência documental, aceite de contrato, movimentação de matrícula. Notas e frequência ficam na extensão. |

**Texto de aceite da abertura:**

> Solicito a análise desta matrícula. Entendo que o envio do pedido não reserva vaga nem ativa a matrícula. A secretaria conferirá os dados, a representação do aluno e as condições do contrato. Li o aviso de privacidade apresentado neste atendimento.

Esse aceite não é autorização genérica para qualquer tratamento de dados. A base legal de cada finalidade será definida separadamente.

#### Tarefas padrão

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---:|
| `interesse` | Conferir interesse e disponibilidade | Secretaria | 1 dia |
| `visita` | Confirmar visita ou conversa inicial | Secretaria | 1 dia |
| `documentos` | Conferir documentos e representação do aluno | Secretaria autorizada | 2 dias |
| `contrato` | Conferir aceite e condições da matrícula | Secretaria | 2 dias |
| `ativa` | Confirmar turma, calendário e vínculo financeiro | Secretaria e financeiro | Mesmo dia |
| `trancada` | Revisar enturmação e encaminhar ajuste financeiro | Secretaria e financeiro | 1 dia |
| `encerrada` | Encerrar vínculos operacionais e revisar guarda | Secretaria | 2 dias |
| `cancelada` | Revisar pendências e prazo de guarda do pedido | Secretaria | 2 dias |

### 2.2. Ocorrência ou solicitação

| Propriedade | Valor |
|---|---|
| Identificador | `escolas_solicitacao` |
| Singular | Ocorrência ou solicitação |
| Plural | Ocorrências e solicitações |
| Campo fixo `item` | Aluno |
| Campo fixo `problem` | Assunto |
| Uso | Declaração, segunda via de documento, reunião, ajuste cadastral ou ocorrência |
| Regra do assunto | Título curto. Não registrar diagnóstico, acusação ou relato íntimo no título. |

A segunda via de pagamento segue pelo menu da Mensalidade. Este tipo atende segunda via de documento escolar.

#### Campos extras

| Chave | Rótulo | Tipo | Obrigatório | O cliente vê | Sensível |
|---|---|---|---|---|---|
| `categoria` | Categoria | `lista`: declaracao, segunda_via_documento, reuniao, ajuste_cadastral, ocorrencia | Sim | Sim | Não |
| `periodo_referencia` | Período de referência | `texto` | Não | Sim | Não |
| `retorno_preferido` | Retorno preferido | `lista`: atendimento_seguro, telefone, presencial | Sim | Sim | Não |
| `data_desejada` | Data desejada | `data` | Não | Sim | Não |
| `relato_restrito` | Relato restrito | `texto_longo` | Não | Não | Sim |

O relato restrito é recebido em atendimento humano ou formulário protegido da extensão. Não entra em formulário genérico com distribuição ampla.

#### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `recebida` | Solicitação recebida | `received` | `triagem`, `cancelada` | Recebemos a solicitação nº {numero}. A secretaria vai encaminhá-la à pessoa responsável. | 1 |
| `triagem` | Em triagem | `analyzing` | `aguardando_responsavel`, `em_atendimento`, `cancelada` | A solicitação nº {numero} está em triagem. Você receberá o próximo encaminhamento por este atendimento. | 2 |
| `aguardando_responsavel` | Aguardando responsável | `analyzing` | `triagem`, `em_atendimento`, `cancelada` | A solicitação nº {numero} precisa de uma informação sua. Consulte a pendência no atendimento seguro. | 5 |
| `em_atendimento` | Em atendimento | `in_progress` | `aguardando_responsavel`, `concluida`, `cancelada` | A solicitação nº {numero} está em atendimento. A equipe avisará quando houver uma resposta disponível. | 3 |
| `concluida` | Concluída | `delivered` | Nenhuma | A solicitação nº {numero} foi concluída. Consulte a resposta ou o documento no atendimento seguro. | 0 |
| `cancelada` | Cancelada | `cancelled` | Nenhuma | A solicitação nº {numero} foi cancelada. O motivo pode ser consultado com a secretaria. | 0 |

Não cancelar automaticamente uma ocorrência por falta de resposta. A equipe avalia o caso.

#### Recursos ligados

| Recurso | Configuração e uso |
|---|---|
| Orçamento, garantia e retirada | Desligados. |
| Termos | Ligados. |
| Tarefas e prazos | Triagem, pedido de informação, preparação e revisão da resposta. |
| Pessoas ligadas | Aluno, solicitante autorizado, responsável pedagógico, atendente e coordenador. |
| Documentos | Declaração aprovada, segunda via autorizada e resposta formal podem ser entregues. Evidências internas e documentos de terceiros não podem. |
| Lançamentos | Encaminhamento, contato, resposta e revisão. Relatos restritos não entram em lançamentos comuns. |

**Texto de aceite:**

> Solicito atendimento sobre o assunto informado. Entendo que a escola conferirá meu vínculo com o aluno antes de liberar informações ou documentos. Não enviarei dados de outras famílias neste pedido. Para assuntos delicados, usarei o atendimento humano indicado pela escola.

#### Tarefas padrão

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---:|
| `recebida` | Classificar solicitação e conferir vínculo | Secretaria | 1 dia |
| `triagem` | Definir responsável e prazo de resposta | Secretaria ou coordenação | 1 dia |
| `aguardando_responsavel` | Revisar pendência sem encerrar automaticamente | Atendente designado | 5 dias |
| `em_atendimento` | Preparar e revisar resposta ou documento | Setor responsável | 2 dias |
| `concluida` | Conferir destinatário e registro de entrega | Secretaria | Mesmo dia |
| `cancelada` | Registrar motivo e encaminhamento necessário | Atendente designado | Mesmo dia |

## 3. Vocabulário

| Conceito | Termo na escola |
|---|---|
| Cliente | Responsável |
| Clientes | Responsáveis |
| Pessoa atendida pedagogicamente | Aluno |
| Trabalho, no conjunto | Secretaria escolar |
| Trabalho de ingresso | Matrícula |
| Trabalho de atendimento | Ocorrência ou solicitação |
| Responsável pelo trabalho | Atendente responsável |
| Responsável pedagógico | Pessoa autorizada a acompanhar a vida escolar |
| Responsável financeiro | Pessoa autorizada a tratar das cobranças |
| Orçamento | Condições de matrícula |
| Entrega | Conclusão do atendimento |
| Técnico | Não usar este rótulo no modelo escolar |

## 4. Módulos e configurações sugeridas

Os identificadores existentes são `agenda`, `mensalidade`, `forms` e `payments`. Eles estão declarados, respectivamente, em `src/modules/agenda/definition.ts:7`, `src/modules/mensalidade/definition.ts:8`, `src/modules/forms/definition.ts:6` e `src/modules/payments/definition.ts:6`.

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| OS | Ligado | Tipos Matrícula e Ocorrência ou solicitação. |
| Ensino | Ligado quando disponível | Cadastro do aluno, vínculos autorizados, turmas, frequência, avaliações e boletins. |
| Agenda | Ligado | Visita à escola: 30 minutos. Reunião com responsável: 30 minutos. Conversa pedagógica: 45 minutos. |
| Mensalidade | Ligado | Planos mensais por curso ou modalidade. Uma assinatura por matrícula contratada, vinculada ao pagador. |
| Formulários | Ligado | Formulário público de interesse com dados mínimos do adulto. |
| Cobrança | Ligado | Pix ou link das mensalidades e taxas autorizadas. |
| Reserva | Desligado | Reunião usa Agenda. Sala e horário de turma pertencem à extensão. |
| ERP | Desligado | Sem estoque, PDV ou financeiro ERP neste modelo inicial. |
| Pedido, Mesas, Entrega e Suporte pago | Desligados | Sem uso no fluxo escolar proposto. |
| Fila | Desligada inicialmente | Ligar apenas se houver atendimento presencial por senha. |

### Agenda

Os campos de antecedência, lembrete e limite de alteração existem em `src/modules/agenda/config.ts:9`.

| Configuração | Valor proposto |
|---|---|
| Antecedência mínima | 12 horas |
| Horizonte de agendamento | 30 dias |
| Intervalo da grade | 15 minutos |
| Lembrete | 24 horas antes |
| Remarcação ou cancelamento pelo cliente | Até 12 horas antes |
| Feriados | Fecham a Agenda |
| Profissionais | Secretaria para visitas; coordenação e professores autorizados para reuniões |
| Observação do agendamento | Somente assunto administrativo curto. Sem relato pedagógico sensível. |

A seleção de professor para reunião deve respeitar o vínculo do aluno. A Agenda atual oferece escolha de serviço e profissional (`src/modules/agenda/definition.ts:24`); a restrição por vínculo escolar é nova.

### Mensalidade

| Plano inicial | Periodicidade | Valor | Condição para ativar |
|---|---|---|---|
| Infantil — mensal | Mensal | A definir pela escola | Contrato e calendário conferidos |
| Curso livre — mensal | Mensal | A definir pela escola | Carga horária e condições conferidas |
| Idiomas — mensal | Mensal | A definir pela escola | Turma e calendário conferidos |
| Reforço — mensal | Mensal | A definir pela escola | Frequência de encontros conferida |

Criar os planos como rascunhos inativos. Não usar preço zero como substituto de preço pendente.

| Regra de cobrança | Proposta |
|---|---|
| Vencimento sugerido | Dia 10, ajustável por contrato |
| Aviso antecipado | 3 dias antes |
| Aviso no vencimento | Ligado |
| Avisos de atraso | A cada 7 dias, no máximo 2 por parcela |
| Destinatário | Somente telefone autorizado do pagador |
| Efeito pedagógico | Inadimplência não altera matrícula, frequência ou liberação de boletim automaticamente |
| Trancamento | Abre tarefa financeira. Não pausa assinatura sem decisão humana |
| Encerramento | Abre tarefa financeira. Não elimina débitos nem cancela parcelas por inferência |

A Mensalidade já admite pagador com vários telefones autorizados (`docs/MENSALIDADE.md:114`). Pausar ou encerrar assinatura tem efeitos sobre parcelas futuras (`docs/MENSALIDADE.md:34`). Por isso, a etapa escolar não deve chamar essas operações silenciosamente.

### Formulário público de interesse

As respostas dos Formulários podem ir ao contato e ao protocolo (`src/modules/forms/definition.ts:9`). O formulário público não receberá documentos nem relatos sobre crianças.

| Pergunta pronta | Tipo | Obrigatória |
|---|---|---|
| Qual é o seu nome? | Texto curto | Sim |
| Qual modalidade você procura? | Escolha: Infantil; Curso livre; Idiomas; Reforço | Sim |
| Qual turno você prefere? | Escolha: Manhã; Tarde; Noite; Integral; A definir | Sim |
| Como prefere conversar com a secretaria? | Escolha: WhatsApp; Telefone; Visita | Sim |
| Li o aviso de privacidade deste atendimento. | Aceite | Sim |

Texto de abertura:

> Este formulário é para o primeiro contato com a secretaria. Informe somente seus dados de adulto responsável. Não envie nome completo do aluno, documentos, informações de saúde ou relatos pedagógicos aqui.

Os dados do aluno serão coletados depois, no fluxo protegido da extensão.

## 5. WhatsApp

### Árvore do menu

Os tipos `os_open` e `os_track` existem, mas ainda não declaram referência a tipo de trabalho (`src/modules/os/definition.ts:28`). A referência abaixo depende da generalização. Os tipos `ensino_*` são novos.

| Caminho | Rótulo | Tipo ou ação | Resultado |
|---|---|---|---|
| Principal | Matrículas | Submenu | Abre opções de matrícula |
| Matrículas → | Nova matrícula | `os_open`, referência `escolas_matricula` | Inicia pedido protegido |
| Matrículas → | Acompanhar matrícula | `os_track`, referência `escolas_matricula` | Mostra somente matrículas autorizadas |
| Matrículas → | Agendar visita | `agenda` | Oferece o serviço Visita à escola |
| Principal | Vida escolar | Submenu | Abre opções do aluno autorizado |
| Vida escolar → | Calendário e material | `ensino_resources` | Mostra publicações da turma |
| Vida escolar → | Pedir boletim | `ensino_report` | Entrega acesso ao boletim publicado |
| Vida escolar → | Reunião com responsável | `agenda` | Oferece profissionais autorizados |
| Vida escolar → | Meus agendamentos | `agenda_mine` | Confirma, remarca ou cancela |
| Principal | Mensalidades | `mensalidade_list` | Consulta parcelas do pagador autorizado |
| Principal | Segunda via de pagamento | `mensalidade_copy` | Reenvia cobrança válida |
| Principal | Secretaria | Submenu | Abre atendimento administrativo |
| Secretaria → | Abrir solicitação | `os_open`, referência `escolas_solicitacao` | Abre declaração, segunda via, reunião ou ocorrência |
| Secretaria → | Acompanhar solicitação | `os_track`, referência `escolas_solicitacao` | Mostra pedidos autorizados |
| Secretaria → | Falar com a equipe | `human` | Encaminha à secretaria |

`mensalidade_list` e `mensalidade_copy` estão declarados em `src/modules/mensalidade/definition.ts:24`. `agenda_mine` está declarado em `src/modules/agenda/definition.ts:31`.

### O responsável resolve sozinho

| Ação | Limite |
|---|---|
| Abrir interesse ou solicitação | Não cria autorização sobre um aluno por simples declaração |
| Consultar andamento | Somente registros associados ao vínculo validado |
| Enviar documento | Pelo fluxo protegido; sem enviar ao bot |
| Consultar calendário e material | Publicações da turma do aluno autorizado |
| Pedir boletim | Somente versão publicada, com permissão pedagógica |
| Agendar reunião | Somente serviços e profissionais permitidos |
| Consultar ou reenviar cobrança | Somente como telefone autorizado do pagador |
| Confirmar pendência | Somente tarefa destinada ao próprio responsável |
| Aceitar contrato | Somente pessoa habilitada para assinar; aceite versionado |

### Mensagens automáticas e lembretes

| Situação | Texto pronto | Destinatário e limite |
|---|---|---|
| Saudação | Olá! Este é o atendimento da escola. Escolha Matrículas, Vida escolar, Mensalidades ou Secretaria. Para proteger os alunos, não envie documentos ou relatos delicados neste chat. | Todos |
| Reunião marcada | Agendado: {servico} com {profissional}, em {data} às {hora}. Para alterar, use Meus agendamentos. | Quem agendou |
| Lembrete de reunião | Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma sua presença? | 24 horas antes |
| Boletim disponível | Há um boletim disponível no atendimento seguro. Use Vida escolar → Pedir boletim. | Responsável pedagógico autorizado |
| Material atualizado | A lista de material foi atualizada. Consulte Vida escolar → Calendário e material. | Responsáveis pedagógicos da turma |
| Calendário atualizado | O calendário da turma foi atualizado. Consulte as datas no atendimento seguro. | Responsáveis pedagógicos da turma |
| Pendência documental | Há uma pendência na matrícula nº {numero}. Consulte o atendimento seguro ou fale com a secretaria. | Um lembrete após 3 dias; depois, tarefa humana |
| Comunicado geral | Há um comunicado da escola disponível no atendimento seguro. Use Vida escolar → Calendário e material. | Destinatários autorizados |
| Falha na autorização | Não foi possível liberar essa informação por este atendimento. A secretaria pode conferir seu acesso. | Sem revelar existência de outro aluno |

As mensagens de cobrança devem usar os dados calculados pela Mensalidade. Não duplicar seu agendador nem manter uma segunda verdade financeira.

Comunicados para uma turma são envios individuais. A publicação exige prévia e confirmação da equipe. Não expor telefones, nomes de outros alunos ou lista de destinatários. Não enviar boletins em grupos.

Condições vigentes de templates e janelas do WhatsApp: **a conferir antes da implantação**. A documentação local trata desses requisitos em `docs/MENSALIDADE.md:196`.

## 6. Bot da área

### Instruções prontas

> Você é o assistente de informações gerais da escola. Responda em português do Brasil, com frases curtas. Use somente informações públicas aprovadas sobre cursos, horários de atendimento e funcionamento da secretaria. Não confirme vaga, matrícula, desconto, pagamento ou aprovação escolar por conta própria. Para matrícula, documento, boletim, frequência, avaliação ou ocorrência, encaminhe ao menu seguro ou à equipe. Não peça nome completo de criança, documento, diagnóstico, nota ou relato familiar. Não consulte registros pedagógicos nem anexos. Não transforme parentesco declarado em autorização. Para cobrança, encaminhe à Mensalidade; a frase “já paguei” não comprova pagamento. Não compare alunos. Não diagnostique dificuldades de aprendizagem. Não reproduza informação de outra família. Se faltar informação aprovada, diga: “A secretaria precisa conferir essa informação.” Antes de qualquer envio coletivo, peça revisão humana da mensagem e dos destinatários.

### Limites operacionais

| Categoria | Permissão proposta |
|---|---|
| Faz sozinho | Explica informações públicas aprovadas e indica o menu correto |
| Pergunta à equipe antes | Disponibilidade de vaga, exceção de horário, desconto, prazo especial, cancelamento e alteração contratual |
| Nunca faz | Avaliar aluno, alterar nota ou presença, publicar boletim, autorizar responsável, aplicar punição, bloquear acesso por dívida ou enviar comunicado coletivo |
| Não pode ler | Cadastro de menores, responsáveis e documentos; notas; frequência; boletins; ocorrências; vínculos familiares; restrições de representação; anexos; observações restritas |
| Financeiro | Direciona ao fluxo determinístico da Mensalidade. Não recebe extrato do aluno no contexto da IA |
| Documentos | Não recebe arquivo, texto extraído, miniatura, URL de download ou conteúdo de boletim |

O modo cliente atual prende a identidade à conversa e transforma escritas em propostas (`src/bot-actions/customer.ts:1`). Isso é uma base útil, mas não equivale às restrições pedagógicas propostas.

As instruções textuais não são a barreira de segurança. O servidor deve bloquear ferramentas, leituras e conteúdo antes de montar o contexto da IA. `bot.sensitive` exige segundo fator em determinadas operações; não é um mecanismo de ocultação de dados (`src/modules/types.ts:94`).

**Regra de implantação:** o bot escolar recebe somente perguntas gerais em fluxo separado e conhecimento público aprovado. Conversas de vida escolar, documentos e ocorrências ficam fora do contexto da IA. Enquanto essa separação não estiver implementada e verificada, manter o bot desligado nessa área.

## 7. Equipe

### Setores e categorias

| Setor | Categorias de protocolo |
|---|---|
| Secretaria | Interesse; Matrícula; Documento; Ajuste cadastral |
| Coordenação pedagógica | Reunião; Frequência; Avaliação; Ocorrência restrita |
| Financeiro | Mensalidade; Segunda via de pagamento; Negociação |
| Direção | Reclamação; Revisão de acesso; Privacidade |

### Papéis propostos

Os papéis abaixo são novos. O contrato existente permite declarar papéis de módulo e verificá-los com `ctx.granted` (`docs/MODULOS.md:624`).

| Papel | Pode ler | Pode fazer | Restrição |
|---|---|---|---|
| `ensino:secretaria` | Cadastro mínimo, matrículas, vínculos e solicitações administrativas | Cadastrar aluno, preparar matrícula, conferir documentos e organizar enturmação | Sem acesso geral a notas ou relatos restritos |
| `ensino:coordenacao` | Dados pedagógicos da área | Gerir turmas, regras de avaliação, revisão de frequência e publicação de boletins | Sem dados financeiros além do necessário ao encaminhamento |
| `ensino:professor` | Alunos, encontros e avaliações das turmas às quais está vinculado | Registrar frequência e avaliações em períodos abertos | Não vê outras turmas, documentos familiares ou cobranças |
| `ensino:financeiro` | Identificação mínima e vínculo financeiro | Encaminhar cobranças e operar conforme permissões da Mensalidade | Não vê notas, frequência, boletins ou ocorrências |
| `ensino:privacidade` | Metadados de acesso e solicitações de titulares | Revisar acesso, guarda e atendimento de direitos | Conteúdo somente quando necessário e autorizado |
| Administrador | Conforme poderes administrativos e política da escola | Configurar acessos e aprovar ações excepcionais | Não usar conta administrativa na rotina docente |
| Responsável pedagógico | Dados publicados dos alunos autorizados | Pedir boletim, material, reunião e solicitações | Sem dados de outras famílias |
| Responsável financeiro | Cobranças autorizadas | Consultar e pagar | Não ganha acesso pedagógico por pagar |

Um funcionário pode acumular papéis. Isso deve ser explícito. O acesso genérico ao módulo não concede acesso a todas as turmas.

O contrato atual dá acesso amplo ao administrador (`docs/MODULOS.md:669`). Uma separação absoluta entre administração técnica e conteúdo escolar seria alteração adicional, **a conferir com o dono do produto**.

## 8. Passos manuais após aplicar o modelo

| Ordem | Passo | Quem conclui |
|---:|---|---|
| 1 | Escolher as modalidades realmente atendidas e ocultar opções sem uso | Direção |
| 2 | Definir cursos, ciclos, calendário, turmas, horários e capacidade | Coordenação |
| 3 | Cadastrar professores e vinculá-los às respectivas turmas | Coordenação |
| 4 | Definir preços, vencimentos, planos e condições de trancamento | Direção e financeiro |
| 5 | Configurar conta de cobrança e validar mensagens financeiras | Financeiro |
| 6 | Publicar contrato e aviso de privacidade revisados | Direção |
| 7 | Definir base legal, finalidade e prazo de guarda por categoria de dado | Responsável pela privacidade |
| 8 | Conferir alunos e responsáveis antes de habilitar acesso remoto | Secretaria |
| 9 | Cadastrar regras de avaliação adequadas a cada modalidade | Coordenação |
| 10 | Publicar calendário e lista de material | Secretaria |
| 11 | Revisar destinatários e autorizações para comunicados | Secretaria |
| 12 | Validar restrições de acesso com contas de cada papel | Administrador |
| 13 | Habilitar bot somente após garantir a separação de dados | Administrador |
| 14 | Liberar operação com menores somente com os controles da extensão ativos | Direção |

## 9. Extensão Ensino

### 9.1. O que o modelo sozinho não resolve

| Necessidade | Por que exige extensão |
|---|---|
| Cadastro permanente do aluno | Matrícula é um processo. O aluno continua existindo entre ciclos. |
| Vários responsáveis | Telefone principal da ordem não expressa representação nem permissões diferentes. |
| Enturmação | Precisa controlar período, capacidade, mudança e histórico. |
| Professor nas próprias turmas | Exige autorização por registro, além do acesso ao módulo. |
| Frequência | Precisa relacionar encontro, matrícula na turma e presença. |
| Avaliações | Precisa validar escala, pesos, período e tratamento de pendências. |
| Boletim | Precisa de cálculo reproduzível, revisão, publicação e acesso protegido. |
| Comunicado por turma | Precisa resolver destinatários, evitar duplicidade e revalidar permissões. |
| Guarda e auditoria | Precisa registrar leitura, exportação, publicação e revogação. |

**Dependência proposta:** `ensino` declara `requires: ["os"]`. O mecanismo de dependências existe em `src/modules/types.ts:72`.

Agenda e Mensalidade são integrações opcionais. Se a implementação importar seus contratos públicos diretamente, deve declarar as dependências correspondentes, conforme `docs/MODULOS.md:107`. A alternativa é usar integração opcional por leitura pública e eventos, com módulo habilitado e autorização verificados.

Nenhuma classe nova de Durable Object. Usar o Worker, D1, R2 e Coordinator existentes. Não criar novo recurso Cloudflare.

### 9.2. Modelo de dados

| Entidade | Função |
|---|---|
| Aluno | Identidade permanente da pessoa atendida |
| Responsável | Adulto ou aluno adulto com contato verificado |
| Vínculo aluno–responsável | Poderes pedagógicos, financeiros e de assinatura, com validade |
| Vínculo de trabalho | Liga matrícula ou solicitação ao aluno |
| Vínculo financeiro | Liga matrícula à assinatura da Mensalidade |
| Turma | Curso, ciclo, período de funcionamento e capacidade |
| Professor da turma | Escopo temporal de acesso docente |
| Horário | Recorrência semanal da turma |
| Enturmação | Participação do aluno na turma durante um intervalo |
| Encontro | Aula efetivamente prevista, realizada ou cancelada |
| Frequência | Registro individual de presença por encontro |
| Período avaliativo | Intervalo aberto ou fechado para avaliação |
| Regra de avaliação | Método e configuração versionados |
| Avaliação | Instrumento com escala, peso e data |
| Resultado | Nota, conceito ou situação de um aluno |
| Boletim | Versão publicada ou em revisão, com fotografia dos dados usados |
| Publicação da turma | Comunicado, calendário ou lista de material |
| Entrega de comunicado | Controle individual de envio |
| Auditoria | Leitura e alteração sem copiar o conteúdo protegido |
| Política de dados | Finalidade, base legal e guarda por categoria |

### 9.3. DDL SQLite proposto

DDL de desenho. Não foi executado. Validação no ambiente D1, limites de consultas e integração com migrações: **a conferir na implementação**.

Todas as novas tabelas possuem `profile_id`. Chaves estrangeiras entre entidades da extensão incluem a área. Referências a usuários, arquivos e assinaturas existentes também exigem validação de área no serviço.

```sql
-- Índice aditivo para referências compostas à ordem existente.
CREATE UNIQUE INDEX IF NOT EXISTS ensino_os_profile_id
  ON os_orders(profile_id, id);

CREATE TABLE ensino_students (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  birth_date TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE TABLE ensino_responsibles (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  verified_at INTEGER,
  verified_by TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX ensino_responsibles_phone
  ON ensino_responsibles(profile_id, phone);

CREATE TABLE ensino_student_responsibles (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  responsible_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  pedagogical INTEGER NOT NULL DEFAULT 0
    CHECK (pedagogical IN (0, 1)),
  financial INTEGER NOT NULL DEFAULT 0
    CHECK (financial IN (0, 1)),
  can_sign INTEGER NOT NULL DEFAULT 0
    CHECK (can_sign IN (0, 1)),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  verified_at INTEGER NOT NULL,
  verified_by TEXT NOT NULL,
  authority_evidence_ref TEXT,
  revoked_at INTEGER,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, student_id)
    REFERENCES ensino_students(profile_id, id),
  FOREIGN KEY (profile_id, responsible_id)
    REFERENCES ensino_responsibles(profile_id, id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX ensino_student_responsible_active
  ON ensino_student_responsibles(
    profile_id, student_id, responsible_id
  )
  WHERE revoked_at IS NULL AND valid_until IS NULL;

CREATE TABLE ensino_work_links (
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('enrollment', 'request', 'private_student')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, order_id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id),
  FOREIGN KEY (profile_id, student_id)
    REFERENCES ensino_students(profile_id, id)
);

CREATE TABLE ensino_billing_links (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES ensino_work_links(profile_id, order_id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX ensino_billing_active
  ON ensino_billing_links(profile_id, subscription_id)
  WHERE valid_until IS NULL;

CREATE TABLE ensino_classes (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  course TEXT NOT NULL,
  modality TEXT NOT NULL
    CHECK (modality IN ('infantil', 'curso_livre', 'idiomas', 'reforco')),
  cycle TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'active', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE ensino_class_teachers (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  assigned_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE INDEX ensino_class_teachers_user
  ON ensino_class_teachers(profile_id, user_id, valid_from, valid_until);

CREATE TABLE ensino_class_schedules (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  room TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  CHECK (end_minute > start_minute),
  CHECK (valid_until >= valid_from)
);

CREATE TABLE ensino_enrollments (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('active', 'paused', 'ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  FOREIGN KEY (profile_id, student_id)
    REFERENCES ensino_students(profile_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES ensino_work_links(profile_id, order_id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE UNIQUE INDEX ensino_enrollments_active
  ON ensino_enrollments(profile_id, class_id, student_id)
  WHERE state = 'active' AND ends_on IS NULL;

CREATE INDEX ensino_enrollments_student
  ON ensino_enrollments(profile_id, student_id, starts_on);

CREATE TABLE ensino_sessions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  subject TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('planned', 'held', 'cancelled')),
  replaces_session_id TEXT,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  FOREIGN KEY (profile_id, replaces_session_id)
    REFERENCES ensino_sessions(profile_id, id),
  CHECK (ends_at > starts_at)
);

CREATE INDEX ensino_sessions_class_date
  ON ensino_sessions(profile_id, class_id, starts_at);

CREATE TABLE ensino_attendance (
  profile_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('present', 'absent', 'justified', 'not_applicable')),
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (profile_id, session_id, enrollment_id),
  FOREIGN KEY (profile_id, session_id)
    REFERENCES ensino_sessions(profile_id, id),
  FOREIGN KEY (profile_id, enrollment_id)
    REFERENCES ensino_enrollments(profile_id, id)
);

CREATE TABLE ensino_periods (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('open', 'closed')),
  closed_at INTEGER,
  closed_by TEXT,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE ensino_grading_rules (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  component TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  method TEXT NOT NULL
    CHECK (method IN ('arithmetic', 'weighted', 'qualitative')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  locked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, period_id, component, version),
  FOREIGN KEY (profile_id, period_id)
    REFERENCES ensino_periods(profile_id, id)
);

CREATE TABLE ensino_assessments (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  title TEXT NOT NULL,
  occurs_on TEXT NOT NULL,
  max_score_hundredths INTEGER,
  weight_thousandths INTEGER NOT NULL DEFAULT 1000
    CHECK (weight_thousandths > 0),
  state TEXT NOT NULL
    CHECK (state IN ('draft', 'open', 'closed', 'cancelled')),
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, rule_id)
    REFERENCES ensino_grading_rules(profile_id, id),
  CHECK (max_score_hundredths IS NULL OR max_score_hundredths > 0)
);

CREATE TABLE ensino_results (
  profile_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('graded', 'missing', 'excused', 'pending')),
  score_hundredths INTEGER,
  concept TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (profile_id, assessment_id, enrollment_id),
  FOREIGN KEY (profile_id, assessment_id)
    REFERENCES ensino_assessments(profile_id, id),
  FOREIGN KEY (profile_id, enrollment_id)
    REFERENCES ensino_enrollments(profile_id, id),
  CHECK (score_hundredths IS NULL OR score_hundredths >= 0),
  CHECK (score_hundredths IS NULL OR concept IS NULL),
  CHECK (
    (status = 'graded'
      AND (score_hundredths IS NOT NULL OR concept IS NOT NULL))
    OR
    (status <> 'graded'
      AND score_hundredths IS NULL AND concept IS NULL)
  )
);

CREATE TABLE ensino_reports (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  state TEXT NOT NULL
    CHECK (state IN ('draft', 'published', 'superseded', 'revoked')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  object_key TEXT,
  object_sha256 TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  published_by TEXT,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, student_id, class_id, period_id, version),
  FOREIGN KEY (profile_id, student_id)
    REFERENCES ensino_students(profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  FOREIGN KEY (profile_id, period_id)
    REFERENCES ensino_periods(profile_id, id)
);

CREATE TABLE ensino_notices (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('notice', 'materials', 'calendar')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  object_key TEXT,
  event_starts_at INTEGER,
  event_ends_at INTEGER,
  version INTEGER NOT NULL CHECK (version > 0),
  state TEXT NOT NULL
    CHECK (state IN ('draft', 'published', 'revoked')),
  created_by TEXT NOT NULL,
  published_by TEXT,
  published_at INTEGER,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, class_id)
    REFERENCES ensino_classes(profile_id, id),
  CHECK (
    event_ends_at IS NULL OR event_starts_at IS NULL
    OR event_ends_at >= event_starts_at
  )
);

CREATE TABLE ensino_notice_deliveries (
  profile_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  responsible_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  lease_until INTEGER,
  sent_at INTEGER,
  message_ref TEXT,
  last_error_code TEXT,
  PRIMARY KEY (profile_id, notice_id, responsible_id),
  FOREIGN KEY (profile_id, notice_id)
    REFERENCES ensino_notices(profile_id, id),
  FOREIGN KEY (profile_id, responsible_id)
    REFERENCES ensino_responsibles(profile_id, id)
);

CREATE INDEX ensino_notice_deliveries_due
  ON ensino_notice_deliveries(profile_id, state, next_attempt_at);

CREATE TABLE ensino_audit (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  student_id TEXT,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('allowed', 'denied', 'failed')),
  reason_code TEXT,
  change_summary_json TEXT CHECK (
    change_summary_json IS NULL OR json_valid(change_summary_json)
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX ensino_audit_resource
  ON ensino_audit(profile_id, resource_type, resource_id, created_at);

CREATE TABLE ensino_data_policies (
  profile_id TEXT NOT NULL,
  category TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  purpose TEXT NOT NULL,
  legal_basis TEXT NOT NULL,
  retention_trigger TEXT NOT NULL,
  retention_days INTEGER CHECK (retention_days >= 0),
  retention_rule TEXT,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, category, version),
  CHECK (retention_days IS NOT NULL OR retention_rule IS NOT NULL)
);
```

O DDL não substitui validações de negócio. O serviço deve conferir datas reais, sobreposição de vínculos, pertencimento à mesma turma, limite de nota, legitimidade de assinatura e capacidade.

### 9.4. Rotas propostas

Prefixo: `/api/v1/profiles/{profile}/ensino`.

Todas as escritas exigem identidade, autorização, chave de idempotência e controle de versão quando alterarem um registro existente. IDs enviados pelo cliente não concedem acesso.

| Método | Rota | Função | Quem pode usar |
|---|---|---|---|
| GET, POST | `/students` | Listar ou cadastrar alunos | Secretaria; coordenação |
| GET, PATCH | `/students/{id}` | Consultar ou corrigir cadastro | Conforme projeção do papel |
| POST | `/students/{id}/responsibles` | Preparar vínculo de responsável | Secretaria |
| POST | `/responsible-links/{id}/verify` | Confirmar identidade e poderes | Secretaria autorizada |
| POST | `/responsible-links/{id}/revoke` | Revogar vínculo | Secretaria autorizada; direção |
| POST | `/work-links` | Vincular ordem ao aluno | Secretaria |
| GET, POST | `/billing-links` | Consultar ou associar assinatura | Financeiro; projeção mínima para secretaria |
| GET, POST | `/classes` | Listar ou criar turmas | Coordenação; professor só lê as próprias |
| GET, PATCH | `/classes/{id}` | Consultar ou alterar turma | Coordenação; leitura docente limitada |
| GET, PUT | `/classes/{id}/teachers` | Consultar ou definir docentes | Coordenação |
| GET, PUT | `/classes/{id}/schedules` | Consultar ou definir horários | Coordenação; professor lê os próprios |
| GET, POST | `/classes/{id}/enrollments` | Listar ou enturmar | Secretaria e coordenação |
| POST | `/enrollments/{id}/transfer` | Encerrar vínculo antigo e criar o novo | Secretaria e coordenação |
| POST | `/enrollments/{id}/pause` | Registrar suspensão e data | Secretaria |
| POST | `/enrollments/{id}/end` | Encerrar participação | Secretaria |
| GET, POST | `/classes/{id}/sessions` | Listar ou criar encontros | Coordenação; professor autorizado |
| PATCH | `/sessions/{id}` | Corrigir, realizar ou cancelar encontro | Coordenação; professor autorizado |
| GET, PUT | `/sessions/{id}/attendance` | Consultar ou registrar chamada | Professor da turma; coordenação |
| GET, POST | `/classes/{id}/periods` | Consultar ou criar períodos | Coordenação |
| POST | `/periods/{id}/close` | Fechar período | Coordenação |
| POST | `/periods/{id}/reopen` | Reabrir com justificativa | Coordenação |
| GET, POST | `/periods/{id}/rules` | Consultar ou criar versão da regra | Coordenação; professor lê |
| GET, POST | `/rules/{id}/assessments` | Consultar ou criar avaliações | Professor da turma; coordenação |
| GET, PUT | `/assessments/{id}/results` | Consultar ou registrar resultados | Professor da turma; coordenação |
| POST | `/reports/preview` | Calcular prévia sem publicar | Coordenação; professor da turma |
| POST | `/reports` | Gerar versão para revisão | Coordenação |
| POST | `/reports/{id}/publish` | Publicar boletim | Coordenação |
| POST | `/reports/{id}/revoke` | Retirar acesso à versão incorreta | Coordenação |
| GET | `/reports/{id}/file` | Baixar versão autorizada | Responsável pedagógico; coordenação; professor autorizado |
| GET, POST | `/classes/{id}/notices` | Consultar ou preparar publicação | Secretaria e coordenação; professor prepara rascunho |
| POST | `/notices/{id}/preview-recipients` | Mostrar prévia de destinatários | Secretaria e coordenação |
| POST | `/notices/{id}/publish` | Publicar e iniciar envios individuais | Secretaria ou coordenação, após confirmação |
| GET | `/me/students` | Listar alunos autorizados | Interlocutor autenticado |
| GET | `/me/students/{id}/resources` | Consultar calendário e material | Responsável pedagógico |
| GET | `/me/students/{id}/reports` | Consultar boletins publicados | Responsável pedagógico |
| GET | `/audit` | Consultar trilha de acesso | Privacidade; direção autorizada |
| GET, POST | `/data-policies` | Consultar ou versionar política de dados | Privacidade; direção |

As rotas `/me` são fluxos determinísticos. Não expõem seu resultado ao modelo de IA.

### 9.5. Regras de negócio

#### Aluno, responsável e matrícula

| Regra | Comportamento |
|---|---|
| Identidade do aluno | Não deduplicar automaticamente por nome. A secretaria confere possíveis duplicidades. |
| Mais de um responsável | Cada vínculo tem poderes próprios. Parentesco não concede acesso automaticamente. |
| Responsável financeiro | A permissão escolar financeira não autoriza telefone no pagador da Mensalidade por si só. Exigir os dois vínculos. |
| Responsável pedagógico | Pode consultar dados publicados, conforme vigência e eventual restrição registrada. |
| Assinatura | Exige `can_sign`, vínculo válido e prova de aceite da versão do documento. |
| Telefone compartilhado | Não usar como prova suficiente da identidade de uma pessoa. Casos ambíguos seguem para validação humana. |
| Troca de telefone | Revalidar identidade e revogar sessões e links anteriores. |
| Aluno adulto | Pode representar a si mesmo após validação. A maioridade não mantém automaticamente o acesso anterior dos responsáveis. |
| Matrículas simultâneas | Permitidas em cursos diferentes. Conflitos de horário devem ser sinalizados. |
| Mudança de turma | Encerrar a enturmação anterior com data. Criar outra. Preservar frequência e avaliações antigas. |
| Trancamento | Encerrar ou suspender o intervalo de participação conforme regra aprovada. Não apagar a turma anterior. |
| Capacidade | Conferir atomicamente antes de ativar enturmação. Requisições simultâneas não podem exceder a capacidade. |

#### Turmas, horários e frequência

| Regra | Comportamento |
|---|---|
| Horário recorrente | Gera encontros previstos somente dentro da vigência da turma. |
| Calendário | Feriados, recessos e cancelamentos alteram encontros futuros. Não alteram retroativamente aulas realizadas. |
| Agenda | Reuniões usam Agenda. Horários de turma usam Ensino. Conflitos de professor entre ambos precisam de verificação integrada ou bloqueio manual até essa integração existir. |
| Professor substituto | Recebe vínculo temporário e auditado à turma. |
| Chamada não feita | Ausência de registro significa pendente. Nunca significa falta automática. |
| Aula cancelada | Não entra no denominador da frequência. |
| Enturmação | Só registrar presença de aluno vinculado à turma na data do encontro. |
| Falta justificada | É categoria distinta. Seu efeito percentual deve ser configurado. |
| Reposição | Novo encontro ligado ao substituído. A regra deve evitar contar duas vezes o mesmo encontro substituído. |
| Correção | Exige justificativa e revisão incrementada. Preservar trilha da alteração. |

Não guardar diagnóstico ou documento médico na justificativa comum de frequência. Se houver necessidade de dado de saúde, encaminhar a fluxo próprio, fora deste modelo.

#### Notas e regra de cálculo

| Modalidade de regra | Proposta |
|---|---|
| Média aritmética | Normalizar cada nota pela escala da avaliação e calcular a média simples. |
| Média ponderada | `soma(nota_normalizada × peso) / soma(pesos)`. Pesos devem ser positivos. |
| Qualitativa | Conceitos definidos pela escola. Sem conversão automática em nota. |
| Educação infantil | Padrão qualitativo. Sem classificação automática de aprovação ou reprovação. Adequação pedagógica e normativa: **a conferir**. |

Configuração inicial para curso que usa notas:

| Campo da regra | Valor inicial sugerido |
|---|---|
| Escala de apresentação | 0 a 10 |
| Casas decimais | 1 |
| Arredondamento | Metade para cima, somente no resultado final |
| Resultado pendente | Bloqueia publicação final |
| Falta em avaliação | Não vira zero automaticamente |
| Avaliação dispensada | Exclui do denominador somente quando a dispensa estiver registrada |
| Recuperação | Desligada inicialmente |
| Resultado final | Sem aprovação automática até a escola definir sua regra |
| Frequência mínima | Não predefinir percentual universal |
| Conceitos | Em desenvolvimento; Desenvolvimento consistente; Objetivo alcançado |

Se a recuperação for habilitada, escolher uma regra explícita: substituição de avaliação identificada ou combinação com a média anterior. Fixar pesos e limite de resultado. Não permitir expressão JavaScript ou SQL livre.

A regra fica imutável após publicação de boletim. Mudança posterior cria nova versão. O boletim guarda as avaliações, frequências e versões de regra usadas. Uma correção gera nova versão do boletim, identifica a anterior como substituída e registra quem aprovou.

#### Boletim pedido pelo WhatsApp

| Etapa | Comportamento |
|---:|---|
| 1 | O responsável escolhe Pedir boletim. |
| 2 | O servidor identifica a conversa e verifica o telefone pelo canal. |
| 3 | Resolve os vínculos válidos e a permissão pedagógica. |
| 4 | Se houver mais de um aluno, a seleção ocorre em página autenticada. |
| 5 | Lista somente períodos com boletim publicado. |
| 6 | Gera acesso curto, vinculado à sessão e ao destinatário. |
| 7 | Revalida a autorização no download. |
| 8 | Registra a leitura na auditoria. |

Não usar CPF ou data de nascimento como senha. O número do boletim também não é credencial. O link não pode ser um arquivo público do R2.

#### Comunicados, lista de material e calendário

| Regra | Comportamento |
|---|---|
| Rascunho | Professor pode preparar texto para a própria turma. |
| Publicação | Secretaria ou coordenação revisa conteúdo e destinatários. |
| Lista de material | Documento versionado por turma ou curso, publicado como recurso da turma. |
| Calendário | Eventos com data e hora; atualização cria nova publicação ou versão controlada. |
| Destinatários | Responsáveis pedagógicos válidos de alunos enturmados no período aplicável. |
| Irmãos na mesma turma | Um envio por responsável e publicação. |
| Irmãos em turmas diferentes | Cada publicação mantém seu contexto. |
| Revogação antes do envio | Cancelar o envio pendente. |
| Falha de envio | Repetir em lote limitado, com chave estável. Exibir falhas à secretaria. |
| Confirmação de leitura | Não confundir recibo do canal com ciência formal do responsável. |
| Conteúdo proibido | Listas de devedores, ranking de alunos, dados de outras famílias ou relatos individuais. |

### 9.6. Autorização e proteção contra vazamento

A autorização deve combinar área, papel, registro e vínculo temporal. Filtrar apenas a tela não basta.

| Superfície | Proteção exigida |
|---|---|
| Listagens e busca | Filtrar no servidor antes de paginar. Professor só encontra turmas autorizadas. |
| Contadores | Agregar somente registros que o ator pode consultar. |
| Ordem de serviço | Aplicar o mesmo controle às ordens ligadas a Ensino. |
| Histórico | Não replicar nota, diagnóstico, relato ou documento em `os_history`. Registrar somente o fato e o identificador autorizado. |
| Eventos e notificações | Enviar metadados mínimos. Não colocar nomes de menores ou resultados no payload amplo. |
| Arquivos | Autorizar cada download. Não expor chave R2 nem endereço público. |
| Exportação | Mesma regra de acesso da leitura individual, com auditoria. |
| Bot interno da equipe | Também não recebe conteúdo pedagógico. Ser funcionário não remove a restrição à IA. |
| Módulo desligado | Negar acesso. Não deixar dados escolares acessíveis por rotas genéricas da OS ou de mídia. |
| Professor removido | Perde acesso imediatamente, inclusive a links ainda não usados. |
| Responsável revogado | Perde acesso e sai de envios pendentes. |
| Erro de autorização | Resposta neutra, sem confirmar a existência de aluno de outra família. |

O histórico atual é lido por ordem e área (`src/modules/os/store.ts:206`). A proteção adicional por aluno e papel deve ser implementada também nessa rota.

### 9.7. Privacidade e guarda

A LGPD, o Estatuto da Criança e do Adolescente e as regras educacionais aplicáveis precisam de revisão antes da implantação. Base legal por finalidade, representação, obrigações de guarda e exigências locais: **a conferir**. Este documento não fixa prazo legal nem presume que consentimento resolva todas as finalidades.

**Aviso curto proposto para revisão:**

> Usamos os dados informados para atender pedidos, administrar matrículas e prestar o serviço educacional contratado. O acesso é limitado à equipe autorizada e às pessoas cujo vínculo com o aluno foi conferido. Informações pedagógicas e documentos não são enviados à inteligência artificial. O aviso completo apresenta as finalidades, os prazos de guarda e o canal para exercer seus direitos.

O aviso completo deve conter o nome da escola, contato responsável, finalidades, compartilhamentos, medidas de acesso e política de guarda. Não publicar esses elementos em branco.

| Categoria | Guarda proposta |
|---|---|
| Interesse sem matrícula | Prazo curto configurável após o encerramento. Sugestão operacional: 90 dias, sujeita a revisão. |
| Cadastro e contrato | Prazo definido conforme serviço, finalidade e obrigações aplicáveis. **A conferir**. |
| Frequência, avaliações e boletins | Política específica por modalidade e natureza do documento. **A conferir**. |
| Documento de representação | Guardar apenas o necessário para comprovar a autorização e suas alterações. |
| Link de acesso | Expiração curta. Proposta inicial: 10 minutos, vinculada à sessão. |
| Arquivo de boletim | Segue a política do registro pedagógico. Não a duração do link. |
| Auditoria | Prazo próprio, aprovado e documentado. Não guardar conteúdo integral. |
| Cópias de segurança | Incluir no calendário de guarda e no procedimento de restauração. |
| Bloqueio de descarte | Suspender descarte quando houver obrigação ou necessidade formalmente registrada. |

As migrações aditivas não impedem uma política posterior de descarte de dados. A manutenção do esquema e a eliminação autorizada de registros são assuntos distintos.

**Limite do modelo:** não coletar prontuário, diagnóstico, medicação, biometria, imagem promocional ou relato clínico. Uma necessidade real desse tipo exige avaliação específica e fluxo protegido próprio.

### 9.8. Operação e critérios de aceitação

| Critério | Resultado exigido antes da liberação |
|---|---|
| OS embutida | Comportamento atual preservado e suíte existente sem alteração na fase 1 |
| Dois responsáveis | Permissões distintas para o mesmo aluno, sem compartilhamento automático |
| Professor | Tentativa de consultar outra turma é recusada em lista, detalhe, exportação e arquivo |
| Revogação | Link antigo e envio pendente deixam de funcionar |
| Concorrência | Duas matrículas na última vaga não excedem a capacidade |
| Frequência | Aula cancelada e chamada pendente não viram falta |
| Cálculo | Casos conhecidos produzem resultado reproduzível, incluindo arredondamento e dispensas |
| Boletim | Somente publicado; revisão não altera silenciosamente documento anterior |
| Comunicado | Repetição do processamento não duplica envio |
| Financeiro | Mudança de etapa escolar não baixa, isenta ou pausa cobrança automaticamente |
| IA | Nenhum dado protegido entra em contexto, ferramenta, log de prompt ou conhecimento |
| D1 | Paginação e lotes limitados; sem consulta individual por aluno em listagens |
| Recursos | Nenhuma nova classe de Durable Object ou recurso Cloudflare |

Esses são critérios futuros. Nenhuma verificação foi executada nesta revisão. Limites efetivos do D1, custo por invocação e comportamento dos aplicativos antigos: **a conferir**.

### 9.9. Fora do escopo

| Item | Limite |
|---|---|
| Censo e integrações governamentais | Não incluídos |
| Histórico escolar oficial | Não emitido |
| Certificação oficial e diploma | Não incluídos |
| Assinatura digital com validade específica | Não presumida pelo aceite simples |
| Currículo oficial completo | Não incluído |
| Transporte escolar e autorização de retirada | Não incluídos |
| Controle de acesso físico ou biometria | Não incluído |
| Prontuário e saúde escolar | Não incluídos |
| Folha de pagamento | Não incluída |
| Contabilidade e prestação de contas | Não incluídas |
| Ambiente virtual de aprendizagem | Não incluído |
| Avaliação por IA | Proibida neste desenho |

## 10. Dúvidas e decisões do dono do produto

| Decisão | Proposta |
|---|---|
| Nome do conjunto | Secretaria escolar |
| Lançamento para menores | Somente após os controles de identidade, vínculo e sigilo da extensão |
| Educação infantil | Acompanhamento qualitativo, sem aprovação automática |
| Boletim | Documento de acompanhamento. Não apresentar como histórico oficial |
| Acesso administrativo | Manter poderes atuais, com conta administrativa fora da rotina; separação técnica adicional a decidir |
| Mensalidade familiar | Começar com uma assinatura por matrícula. Contrato familiar compartilhado fica para evolução posterior |
| Acesso de responsável apenas financeiro | Sem boletim, nota ou frequência |
| Comunicação de atraso financeiro | Somente ao pagador, fora dos comunicados pedagógicos |
| Agenda e horário de turma | Integrar conflitos antes de oferecer reunião automática com professor; até lá, bloqueio manual |
| Política de guarda | Aprovação por modalidade antes de produção |
| Implantação gradual | Primeiro cadastro e permissões; depois frequência; depois avaliações e boletim |
| Nome e numeração no aplicativo antigo | Contrato a conferir na fase 0, sem alterar o tipo embutido |

### Modelo neutro em JSON

O JSON usa os identificadores existentes quando conferidos. `ensino`, seus papéis e menus são propostos. `reference`, `module_settings`, `policies` e `extension` são extensões do formato neutro, não payloads prontos da API atual.

```json
{
  "id": "area-escolas",
  "name": "Escolas",
  "labels": {
    "customer": "Responsável",
    "customers": "Responsáveis",
    "work_collection": "Secretaria escolar",
    "assignee": "Atendente responsável",
    "quote": "Condições de matrícula"
  },
  "modules": {
    "on": ["os", "ensino", "agenda", "mensalidade", "forms", "payments"],
    "off": ["queue", "reserva", "pedido", "mesas", "entrega", "suporte", "erp", "erp-fiscal", "erp-cobranca", "erp-pdv"]
  },
  "policies": {
    "preserve_existing": true,
    "module_off_is_initial_recommendation": true,
    "sensitive_data_to_ai": false,
    "minor_data_requires_ensino": true,
    "bulk_messages_require_human_review": true,
    "stale_zero_disables": true,
    "task_due_days_basis": "calendar_days",
    "numbering_contract": "preserve_legacy_number_add_type_number",
    "bot_enabled_after_isolation_review": false
  },
  "work_types": [
    {
      "id": "escolas_matricula",
      "singular": "Matrícula",
      "plural": "Matrículas",
      "item_label": "Aluno",
      "problem_label": "Curso ou etapa pretendida",
      "features": {
        "quote": false,
        "warranty": false,
        "pickup": false,
        "terms": true,
        "tasks": true,
        "people": true,
        "files": true,
        "entries": true
      },
      "terms_text": "Solicito a análise desta matrícula. Entendo que o envio do pedido não reserva vaga nem ativa a matrícula. A secretaria conferirá os dados, a representação do aluno e as condições do contrato. Li o aviso de privacidade apresentado neste atendimento.",
      "fields": [
        {"key":"modalidade","label":"Modalidade","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["infantil","curso_livre","idiomas","reforco"]},
        {"key":"curso","label":"Curso ou etapa","type":"texto","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"ciclo_letivo","label":"Ciclo letivo","type":"texto","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"turno","label":"Turno pretendido","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["manha","tarde","noite","integral","a_definir"]},
        {"key":"inicio_previsto","label":"Início previsto","type":"data","required":false,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"observacao_restrita","label":"Observação administrativa restrita","type":"texto_longo","required":false,"customer_visible":false,"sensitive":true,"options":[]}
      ],
      "stages": [
        {"id":"interesse","label":"Interesse recebido","base":"received","next":["visita","documentos","cancelada"],"message":"Recebemos o interesse de matrícula nº {numero}. A secretaria vai conferir as opções e orientar os próximos passos.","stale_days":2},
        {"id":"visita","label":"Visita ou conversa inicial","base":"analyzing","next":["documentos","interesse","cancelada"],"message":"A matrícula nº {numero} está na etapa de visita ou conversa inicial. Use Agendar visita no menu para escolher um horário.","stale_days":3},
        {"id":"documentos","label":"Documentos em conferência","base":"analyzing","next":["contrato","visita","cancelada"],"message":"A matrícula nº {numero} está em conferência de documentos. Consulte as pendências no atendimento seguro. Não envie documentos pessoais neste chat.","stale_days":3},
        {"id":"contrato","label":"Contrato para aceite","base":"analyzing","next":["documentos","ativa","cancelada"],"message":"O contrato da matrícula nº {numero} está disponível para conferência no atendimento seguro. A matrícula depende da confirmação da secretaria.","stale_days":5},
        {"id":"ativa","label":"Matrícula ativa","base":"in_progress","next":["trancada","encerrada"],"message":"A matrícula nº {numero} está ativa. Calendário, material e horários estão disponíveis no menu.","stale_days":0},
        {"id":"trancada","label":"Matrícula trancada","base":"analyzing","next":["ativa","encerrada"],"message":"O trancamento da matrícula nº {numero} foi registrado. A secretaria informará as condições para retorno e os ajustes financeiros aplicáveis.","stale_days":0},
        {"id":"encerrada","label":"Matrícula encerrada","base":"delivered","next":[],"message":"A matrícula nº {numero} foi encerrada. Documentos e pendências podem ser solicitados à secretaria.","stale_days":0},
        {"id":"cancelada","label":"Matrícula não concluída","base":"cancelled","next":[],"message":"O pedido de matrícula nº {numero} foi cancelado antes da ativação. Para iniciar outro pedido, use Nova matrícula.","stale_days":0}
      ],
      "people_roles": [
        {"id":"aluno","label":"Aluno"},
        {"id":"responsavel_pedagogico","label":"Responsável pedagógico"},
        {"id":"responsavel_financeiro","label":"Responsável financeiro"},
        {"id":"representante_assinante","label":"Representante habilitado para assinar"},
        {"id":"coordenador","label":"Coordenador"}
      ],
      "entry_kinds": [
        {"id":"contato_administrativo","label":"Contato administrativo"},
        {"id":"conferencia_documental","label":"Conferência documental"},
        {"id":"aceite_contrato","label":"Aceite de contrato"},
        {"id":"movimentacao_matricula","label":"Movimentação de matrícula"}
      ],
      "file_kinds": [
        {"id":"contrato","label":"Contrato","customer_can_receive":true},
        {"id":"lista_material","label":"Lista de material","customer_can_receive":true},
        {"id":"calendario","label":"Calendário","customer_can_receive":true},
        {"id":"declaracao","label":"Declaração aprovada","customer_can_receive":true},
        {"id":"identificacao","label":"Documento de identificação","customer_can_receive":false},
        {"id":"representacao","label":"Comprovação de representação","customer_can_receive":false}
      ],
      "default_tasks": [
        {"stage":"interesse","title":"Conferir interesse e disponibilidade","due_days":1},
        {"stage":"visita","title":"Confirmar visita ou conversa inicial","due_days":1},
        {"stage":"documentos","title":"Conferir documentos e representação do aluno","due_days":2},
        {"stage":"contrato","title":"Conferir aceite e condições da matrícula","due_days":2},
        {"stage":"ativa","title":"Confirmar turma, calendário e vínculo financeiro","due_days":0},
        {"stage":"trancada","title":"Revisar enturmação e encaminhar ajuste financeiro","due_days":1},
        {"stage":"encerrada","title":"Encerrar vínculos operacionais e revisar guarda","due_days":2},
        {"stage":"cancelada","title":"Revisar pendências e prazo de guarda do pedido","due_days":2}
      ]
    },
    {
      "id": "escolas_solicitacao",
      "singular": "Ocorrência ou solicitação",
      "plural": "Ocorrências e solicitações",
      "item_label": "Aluno",
      "problem_label": "Assunto",
      "features": {
        "quote": false,
        "warranty": false,
        "pickup": false,
        "terms": true,
        "tasks": true,
        "people": true,
        "files": true,
        "entries": true
      },
      "terms_text": "Solicito atendimento sobre o assunto informado. Entendo que a escola conferirá meu vínculo com o aluno antes de liberar informações ou documentos. Não enviarei dados de outras famílias neste pedido. Para assuntos delicados, usarei o atendimento humano indicado pela escola.",
      "fields": [
        {"key":"categoria","label":"Categoria","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["declaracao","segunda_via_documento","reuniao","ajuste_cadastral","ocorrencia"]},
        {"key":"periodo_referencia","label":"Período de referência","type":"texto","required":false,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"retorno_preferido","label":"Retorno preferido","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["atendimento_seguro","telefone","presencial"]},
        {"key":"data_desejada","label":"Data desejada","type":"data","required":false,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"relato_restrito","label":"Relato restrito","type":"texto_longo","required":false,"customer_visible":false,"sensitive":true,"options":[]}
      ],
      "stages": [
        {"id":"recebida","label":"Solicitação recebida","base":"received","next":["triagem","cancelada"],"message":"Recebemos a solicitação nº {numero}. A secretaria vai encaminhá-la à pessoa responsável.","stale_days":1},
        {"id":"triagem","label":"Em triagem","base":"analyzing","next":["aguardando_responsavel","em_atendimento","cancelada"],"message":"A solicitação nº {numero} está em triagem. Você receberá o próximo encaminhamento por este atendimento.","stale_days":2},
        {"id":"aguardando_responsavel","label":"Aguardando responsável","base":"analyzing","next":["triagem","em_atendimento","cancelada"],"message":"A solicitação nº {numero} precisa de uma informação sua. Consulte a pendência no atendimento seguro.","stale_days":5},
        {"id":"em_atendimento","label":"Em atendimento","base":"in_progress","next":["aguardando_responsavel","concluida","cancelada"],"message":"A solicitação nº {numero} está em atendimento. A equipe avisará quando houver uma resposta disponível.","stale_days":3},
        {"id":"concluida","label":"Concluída","base":"delivered","next":[],"message":"A solicitação nº {numero} foi concluída. Consulte a resposta ou o documento no atendimento seguro.","stale_days":0},
        {"id":"cancelada","label":"Cancelada","base":"cancelled","next":[],"message":"A solicitação nº {numero} foi cancelada. O motivo pode ser consultado com a secretaria.","stale_days":0}
      ],
      "people_roles": [
        {"id":"aluno","label":"Aluno"},
        {"id":"solicitante","label":"Solicitante autorizado"},
        {"id":"responsavel_pedagogico","label":"Responsável pedagógico"},
        {"id":"atendente","label":"Atendente"},
        {"id":"coordenador","label":"Coordenador"}
      ],
      "entry_kinds": [
        {"id":"encaminhamento","label":"Encaminhamento"},
        {"id":"contato","label":"Contato"},
        {"id":"resposta","label":"Resposta"},
        {"id":"revisao","label":"Revisão"}
      ],
      "file_kinds": [
        {"id":"declaracao","label":"Declaração aprovada","customer_can_receive":true},
        {"id":"segunda_via","label":"Segunda via autorizada","customer_can_receive":true},
        {"id":"resposta_formal","label":"Resposta formal","customer_can_receive":true},
        {"id":"evidencia_interna","label":"Evidência interna","customer_can_receive":false},
        {"id":"documento_terceiro","label":"Documento de terceiro","customer_can_receive":false}
      ],
      "default_tasks": [
        {"stage":"recebida","title":"Classificar solicitação e conferir vínculo","due_days":1},
        {"stage":"triagem","title":"Definir responsável e prazo de resposta","due_days":1},
        {"stage":"aguardando_responsavel","title":"Revisar pendência sem encerrar automaticamente","due_days":5},
        {"stage":"em_atendimento","title":"Preparar e revisar resposta ou documento","due_days":2},
        {"stage":"concluida","title":"Conferir destinatário e registro de entrega","due_days":0},
        {"stage":"cancelada","title":"Registrar motivo e encaminhamento necessário","due_days":0}
      ]
    }
  ],
  "module_settings": {
    "agenda": {
      "min_notice_minutes": 720,
      "max_days_ahead": 30,
      "slot_step_minutes": 15,
      "reminder_hours": 24,
      "customer_change_hours": 12,
      "close_on_holidays": true,
      "services": [
        {"id":"escolas_visita","name":"Visita à escola","duration_minutes":30},
        {"id":"escolas_reuniao","name":"Reunião com responsável","duration_minutes":30},
        {"id":"escolas_conversa","name":"Conversa pedagógica","duration_minutes":45}
      ],
      "booked_text": "Agendado: {servico} com {profissional}, em {data} às {hora}. Para alterar, use Meus agendamentos.",
      "reminder_text": "Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma sua presença?"
    },
    "mensalidade": {
      "suggested_due_day": 10,
      "days_before": 3,
      "notice_on_due_date": true,
      "overdue_every_days": 7,
      "overdue_max": 2,
      "plans": [
        {"id":"escolas_infantil","name":"Infantil — mensal","period":"monthly","price_cents":null,"active":false},
        {"id":"escolas_curso_livre","name":"Curso livre — mensal","period":"monthly","price_cents":null,"active":false},
        {"id":"escolas_idiomas","name":"Idiomas — mensal","period":"monthly","price_cents":null,"active":false},
        {"id":"escolas_reforco","name":"Reforço — mensal","period":"monthly","price_cents":null,"active":false}
      ]
    },
    "forms": [
      {
        "id":"escolas_interesse_publico",
        "name":"Primeiro contato com a secretaria",
        "intro":"Este formulário é para o primeiro contato com a secretaria. Informe somente seus dados de adulto responsável. Não envie nome completo do aluno, documentos, informações de saúde ou relatos pedagógicos aqui.",
        "questions":[
          {"key":"nome_adulto","label":"Qual é o seu nome?","type":"texto","required":true,"options":[]},
          {"key":"modalidade","label":"Qual modalidade você procura?","type":"lista","required":true,"options":["Infantil","Curso livre","Idiomas","Reforço"]},
          {"key":"turno","label":"Qual turno você prefere?","type":"lista","required":true,"options":["Manhã","Tarde","Noite","Integral","A definir"]},
          {"key":"retorno","label":"Como prefere conversar com a secretaria?","type":"lista","required":true,"options":["WhatsApp","Telefone","Visita"]},
          {"key":"aviso_lido","label":"Li o aviso de privacidade deste atendimento.","type":"sim_nao","required":true,"options":[]}
        ]
      }
    ]
  },
  "menus": [
    {"id":"escolas_menu_matriculas","label":"Matrículas","type":"submenu","parent_id":null,"content":""},
    {"id":"escolas_menu_nova","label":"Nova matrícula","type":"os_open","parent_id":"escolas_menu_matriculas","content":"","reference":{"kind":"work_type","id":"escolas_matricula"}},
    {"id":"escolas_menu_acompanhar","label":"Acompanhar matrícula","type":"os_track","parent_id":"escolas_menu_matriculas","content":"","reference":{"kind":"work_type","id":"escolas_matricula"}},
    {"id":"escolas_menu_visita","label":"Agendar visita","type":"agenda","parent_id":"escolas_menu_matriculas","content":"","reference":{"kind":"service","id":"escolas_visita"}},
    {"id":"escolas_menu_vida","label":"Vida escolar","type":"submenu","parent_id":null,"content":""},
    {"id":"escolas_menu_recursos","label":"Calendário e material","type":"ensino_resources","parent_id":"escolas_menu_vida","content":""},
    {"id":"escolas_menu_boletim","label":"Pedir boletim","type":"ensino_report","parent_id":"escolas_menu_vida","content":""},
    {"id":"escolas_menu_reuniao","label":"Reunião com responsável","type":"agenda","parent_id":"escolas_menu_vida","content":"","reference":{"kind":"service","id":"escolas_reuniao"}},
    {"id":"escolas_menu_agendamentos","label":"Meus agendamentos","type":"agenda_mine","parent_id":"escolas_menu_vida","content":""},
    {"id":"escolas_menu_mensalidades","label":"Mensalidades","type":"mensalidade_list","parent_id":null,"content":""},
    {"id":"escolas_menu_pagamento","label":"Segunda via de pagamento","type":"mensalidade_copy","parent_id":null,"content":""},
    {"id":"escolas_menu_secretaria","label":"Secretaria","type":"submenu","parent_id":null,"content":""},
    {"id":"escolas_menu_solicitar","label":"Abrir solicitação","type":"os_open","parent_id":"escolas_menu_secretaria","content":"","reference":{"kind":"work_type","id":"escolas_solicitacao"}},
    {"id":"escolas_menu_solicitacoes","label":"Acompanhar solicitação","type":"os_track","parent_id":"escolas_menu_secretaria","content":"","reference":{"kind":"work_type","id":"escolas_solicitacao"}},
    {"id":"escolas_menu_humano","label":"Falar com a equipe","type":"human","parent_id":"escolas_menu_secretaria","content":"Vou encaminhar você à secretaria.","reference":{"kind":"department","id":"escolas_secretaria"}}
  ],
  "departments": ["Secretaria", "Coordenação pedagógica", "Financeiro", "Direção"],
  "ticket_categories": ["Interesse", "Matrícula", "Documento", "Ajuste cadastral", "Reunião", "Frequência", "Avaliação", "Ocorrência restrita", "Mensalidade", "Segunda via de pagamento", "Negociação", "Reclamação", "Revisão de acesso", "Privacidade"],
  "bot_instructions": "Você é o assistente de informações gerais da escola. Responda em português do Brasil, com frases curtas. Use somente informações públicas aprovadas sobre cursos, horários de atendimento e funcionamento da secretaria. Não confirme vaga, matrícula, desconto, pagamento ou aprovação escolar por conta própria. Para matrícula, documento, boletim, frequência, avaliação ou ocorrência, encaminhe ao menu seguro ou à equipe. Não peça nome completo de criança, documento, diagnóstico, nota ou relato familiar. Não consulte registros pedagógicos nem anexos. Não transforme parentesco declarado em autorização. Para cobrança, encaminhe à Mensalidade; a frase “já paguei” não comprova pagamento. Não compare alunos. Não diagnostique dificuldades de aprendizagem. Não reproduza informação de outra família. Se faltar informação aprovada, diga: “A secretaria precisa conferir essa informação.” Antes de qualquer envio coletivo, peça revisão humana da mensagem e dos destinatários.",
  "extension": {
    "id": "ensino",
    "requires": ["os"],
    "roles": ["secretaria", "coordenacao", "professor", "financeiro", "privacidade"],
    "schema_section": "1.9.3",
    "routes_section": "1.9.4",
    "default_grading": {
      "infantil": "qualitative",
      "other_modalities": "manual_configuration",
      "automatic_pass_fail": false
    }
  },
  "manual_steps": [
    "Escolher modalidades e ocultar opções sem uso.",
    "Cadastrar cursos, ciclos, turmas, horários e capacidade.",
    "Vincular professores às próprias turmas.",
    "Definir preços, vencimentos e condições de trancamento.",
    "Configurar cobrança e revisar mensagens financeiras.",
    "Publicar contrato e aviso de privacidade revisados.",
    "Aprovar finalidade, base legal e guarda por categoria de dado.",
    "Conferir alunos, responsáveis e poderes de assinatura.",
    "Cadastrar e revisar regras de avaliação.",
    "Publicar calendário e lista de material.",
    "Revisar destinatários dos comunicados.",
    "Validar autorização em telas, APIs, arquivos, eventos e exportações.",
    "Habilitar bot somente após separar o conteúdo protegido.",
    "Liberar dados de menores somente com os controles da extensão ativos."
  ]
}
```

# 2. Professores particulares e autônomos

## 1. Quem usa e como é o dia a dia

O professor atende sozinho ou com um auxiliar administrativo.  
O cliente pode ser o aluno adulto ou o responsável por um menor.  
O registro central é o acompanhamento do aluno.  
O professor combina objetivo, formato, duração e pacote de aulas.  
A Agenda organiza os encontros e as remarcações.  
O WhatsApp concentra dúvidas sobre horário, pagamento, material e reposição.  
O professor confirma as aulas realizadas e confere o saldo do pacote.  
Não há promessa automática de resultado pedagógico.  
Dados de menores dependem dos controles de vínculo e sigilo da extensão Ensino.

Este modelo usa o mesmo motor generalizado descrito na área Escolas. Não cria outro motor nem altera o tipo embutido de OS.

## 2. Tipos de trabalho

### 2.1. Aluno

| Propriedade | Valor |
|---|---|
| Identificador | `professores_aluno` |
| Singular | Aluno |
| Plural | Alunos |
| Campo fixo `item` | Nome do aluno |
| Campo fixo `problem` | Disciplina ou objetivo |
| Unidade do registro | Acompanhamento contínuo do aluno com o professor |
| Pacotes | Ciclos comerciais registrados por lançamentos e documentos |
| Contato | Aluno adulto ou responsável autorizado |
| Retorno após encerramento | Novo acompanhamento ligado ao mesmo cadastro de pessoa, quando disponível |

Não criar um novo “aluno” a cada pagamento. Um novo pacote gera lançamento próprio no acompanhamento existente. Se o acompanhamento foi encerrado, o retorno abre um novo registro.

#### Campos extras

| Chave | Rótulo | Tipo | Obrigatório | O cliente vê | Sensível |
|---|---|---|---|---|---|
| `disciplina` | Disciplina | `texto` | Sim | Sim | Não |
| `modalidade` | Formato das aulas | `lista`: online, presencial, hibrido | Sim | Sim | Não |
| `aulas_por_pacote` | Aulas do pacote contratado | `numero`, inteiro positivo | Sim | Sim | Não |
| `duracao_minutos` | Duração de cada aula | `numero`, inteiro positivo | Sim | Sim | Não |
| `inicio_pacote` | Início do pacote atual | `data` | Não | Sim | Não |
| `validade_pacote` | Validade contratada do pacote | `data` | Não | Sim | Não |
| `objetivo_restrito` | Observação pedagógica restrita | `texto_longo` | Não | Não | Sim |

`aulas_por_pacote` descreve o pacote atual. Não é o saldo. O saldo resulta dos lançamentos conferidos. Alterar esse campo não cria créditos.

Não guardar diagnóstico, laudo ou dados de saúde na observação pedagógica.

#### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `interesse` | Interesse recebido | `received` | `conversa_inicial`, `cancelado` | Recebi seu interesse em aulas, registro nº {numero}. Vou conferir a disciplina, o formato e os horários disponíveis. | 2 |
| `conversa_inicial` | Conversa inicial | `analyzing` | `combinado`, `cancelado` | O registro nº {numero} está na conversa inicial. Vamos combinar objetivo, horários e condições antes de começar. | 3 |
| `combinado` | Condições para aceite | `analyzing` | `ativo`, `conversa_inicial`, `cancelado` | As condições do registro nº {numero} estão disponíveis para conferência. As aulas começam após a confirmação do professor. | 5 |
| `ativo` | Aulas em andamento | `in_progress` | `pausado`, `renovacao`, `concluido` | As aulas do registro nº {numero} estão em andamento. Use Meus agendamentos para consultar os próximos horários. | 0 |
| `pausado` | Aulas pausadas | `analyzing` | `ativo`, `concluido` | A pausa do registro nº {numero} foi registrada. O professor vai confirmar o retorno e as condições do pacote. | 0 |
| `renovacao` | Revisão do pacote | `ready` | `ativo`, `pausado`, `concluido` | O pacote do registro nº {numero} está em revisão. Fale com o professor para conferir saldo, reposições e continuidade. | 7 |
| `concluido` | Acompanhamento encerrado | `delivered` | Nenhuma | O acompanhamento nº {numero} foi encerrado. O professor pode informar as condições para um novo período de aulas. | 0 |
| `cancelado` | Interesse cancelado | `cancelled` | Nenhuma | O pedido nº {numero} foi cancelado antes do início das aulas. | 0 |

`renovacao` usa `ready` apenas como estado de compatibilidade. Como retirada e garantia estão desligadas, não deve enviar nenhuma mensagem de retirada ou garantia.

O código atual altera datas e efeitos conforme o estado em `src/modules/os/store.ts:535` e envia textos por estado em `src/modules/os/store.ts:597`. A generalização precisa separar esses efeitos das etapas deste tipo.

#### Recursos ligados

| Recurso | Configuração e uso |
|---|---|
| Orçamento com aprovação | Desligado. As condições comerciais são aceitas em documento próprio. |
| Garantia | Desligada. |
| Retirada | Desligada. |
| Termos | Ligados. |
| Tarefas e prazos | Conversa inicial, conferência de contratação, planejamento e revisão de pacote. |
| Pessoas ligadas | Aluno, responsável pedagógico, responsável financeiro e professor. |
| Documentos | Condições contratadas, plano de estudos compartilhável, material didático autorizado e resumo de acompanhamento aprovado. |
| Lançamentos | Pacote contratado, aula realizada, ausência, remarcação, reposição realizada, ajuste de créditos e anotação pedagógica restrita. |

**Texto de aceite inicial:**

> Solicito atendimento para aulas particulares. Antes do início, receberei as condições de quantidade, duração, preço, validade e remarcação. Entendo que este pedido não confirma horário nem contratação. Quando o aluno for menor, o professor conferirá o responsável autorizado.

**Texto das condições comerciais, após preenchimento pelo professor:**

> O pacote inclui {quantidade_aulas} aulas de {duracao_minutos} minutos, no formato {modalidade}, pelo valor total de {valor_pacote}. A validade combinada é {validade_pacote}. Você pode remarcar pelo menu até 24 horas antes. Pedidos posteriores serão analisados pelo professor conforme o contrato. Aula cancelada pelo professor será remarcada sem consumir outra aula do pacote. Descontos, reembolso, pausa e situações excepcionais dependem de confirmação expressa. Declaro que li e aceito estas condições.

Quando não houver validade contratada, substituir `{validade_pacote}` por “sem vencimento automático previsto neste contrato”. Não calcular vencimento por suposição.

As condições comerciais precisam de revisão antes do uso. Regras de consumo, cancelamento e reembolso aplicáveis: **a conferir**.

#### Tarefas padrão

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---:|
| `interesse` | Conferir disciplina, formato e disponibilidade | Professor | 1 dia |
| `conversa_inicial` | Realizar conversa inicial e preparar condições | Professor | 2 dias |
| `combinado` | Conferir aceite, contratação e primeiro horário | Professor ou auxiliar | 1 dia |
| `ativo` | Conferir agenda e lançamentos do pacote | Professor | 7 dias |
| `pausado` | Registrar retorno previsto e revisar cobranças | Professor | 1 dia |
| `renovacao` | Conferir saldo, reposições e proposta de continuidade | Professor | 2 dias |
| `concluido` | Conferir saldo final, documentos e guarda | Professor | 2 dias |
| `cancelado` | Revisar pendências do interesse cancelado | Professor | 1 dia |

A tarefa de revisão na etapa `ativo` nasce uma vez. Uma rotina semanal recorrente exige recurso de recorrência ou organização manual. Não está implícita em `default_tasks`.

### Controle de pacote, remarcação e reposição

O modelo inicial usa lançamentos e conferência humana. Não presume que a Mensalidade controle créditos de aula.

| Evento | Efeito proposto |
|---|---|
| Contratação de pacote | Professor registra quantidade, documento e referência financeira |
| Agendamento | Reserva horário. Não consome crédito |
| Aula realizada | Professor registra uma utilização, ligada ao agendamento |
| Remarcação dentro do prazo | Mantém o mesmo compromisso lógico. Não consome crédito adicional |
| Cancelamento pelo professor | Não consome crédito. Abre tarefa de reposição |
| Ausência do aluno | Registra ocorrência. Consumo depende da regra contratada e da confirmação humana |
| Reposição | Informa qual encontro substitui. Não debita duas vezes o mesmo direito |
| Ajuste | Exige quantidade, motivo, autor e referência ao lançamento corrigido |
| Pagamento confirmado | Atualiza financeiro. Não cria créditos automaticamente no modelo inicial |
| Renovação mensal | Não repete créditos sem uma confirmação vinculada à competência |
| Saldo | Créditos confirmados menos consumos confirmados, com ajustes identificados |

Cada utilização deve ter referência única ao encontro. Se o contrato genérico de lançamentos não suportar essa referência e a prevenção de duplicidade, o saldo continuará sendo conferido manualmente. O formato dessa referência é **a conferir na fase 2**.

## 3. Vocabulário

| Conceito | Termo |
|---|---|
| Cliente adulto | Aluno |
| Interlocutor de menor | Responsável |
| Trabalho, no conjunto | Alunos |
| Responsável pelo trabalho | Professor |
| Orçamento | Condições das aulas |
| Unidade comercial | Pacote de aulas |
| Unidade de agenda | Aula |
| Entrega | Encerramento do acompanhamento |
| Garantia | Não usar |
| Retirada | Não usar |

## 4. Módulos e configurações sugeridas

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| OS | Ligado | Tipo Aluno |
| Agenda | Ligado | Conversa inicial: 20 minutos. Aula: 50 minutos. Reunião com responsável: 20 minutos. |
| Mensalidade | Ligado | Planos recorrentes de acompanhamento |
| Cobrança | Ligado | Pacote avulso e cobranças autorizadas |
| Formulários | Desligado inicialmente | Cadastro usa o fluxo do trabalho; evita duplicar dados |
| Reserva | Desligado | Aula usa Agenda |
| ERP | Desligado | Sem estoque, PDV ou financeiro ERP |
| Ensino | Condicional | Obrigatório para menores enquanto não houver controle equivalente aprovado no motor comum |
| Fila, Pedido, Mesas, Entrega e Suporte pago | Desligados | Sem uso no modelo inicial |

### Agenda

| Configuração | Valor proposto |
|---|---|
| Antecedência mínima | 12 horas |
| Horizonte | 30 dias |
| Intervalo de início | 10 minutos |
| Lembrete | 24 horas antes |
| Remarcação pelo cliente | Até 24 horas antes |
| Feriados | Fecham a Agenda |
| Profissional | O professor; auxiliares não aparecem como docentes |
| Duração alternativa | Criar outro serviço para aula de 60 ou 90 minutos |

O módulo já oferece consulta, remarcação e cancelamento de agendamentos (`src/modules/agenda/definition.ts:31`). O vínculo entre agendamento e saldo de pacote é uma proposta adicional.

### Planos e cobrança

| Produto | Módulo | Configuração inicial |
|---|---|---|
| Acompanhamento mensal — 4 aulas de 50 minutos | Mensalidade | Mensal; preço pendente; inativo |
| Acompanhamento mensal — 8 aulas de 50 minutos | Mensalidade | Mensal; preço pendente; inativo |
| Pacote avulso | Cobrança | Quantidade, valor e validade conferidos pelo professor |
| Aula avulsa | Cobrança | Valor definido antes da confirmação |

As periodicidades existentes da Mensalidade são mensal, trimestral e anual (`src/modules/mensalidade/model.ts:11`). Um pacote avulso não deve ser representado como assinatura recorrente por conveniência.

| Regra | Proposta |
|---|---|
| Vencimento sugerido | Dia 10 |
| Aviso antecipado | 3 dias |
| Aviso no vencimento | Ligado |
| Aviso de atraso | A cada 7 dias, no máximo 2 |
| Falta ou remarcação | Não altera valor automaticamente |
| Pausa das aulas | Abre revisão financeira; não pausa assinatura automaticamente |
| Semana com feriado | Professor confere o calendário e as condições do pacote |
| Mês com cinco semanas | Não presumir aula adicional nem cobrança extra |

## 5. WhatsApp

### Árvore do menu

| Caminho | Rótulo | Tipo ou ação | Resultado |
|---|---|---|---|
| Principal | Quero começar | `os_open`, referência `professores_aluno` | Abre interesse |
| Principal | Meu acompanhamento | `os_track`, referência `professores_aluno` | Mostra etapa e dados administrativos permitidos |
| Principal | Aulas e horários | Submenu | Abre opções da Agenda |
| Aulas e horários → | Agendar aula | `agenda` | Oferece serviço Aula |
| Aulas e horários → | Meus agendamentos | `agenda_mine` | Consulta, confirma, remarca ou cancela |
| Aulas e horários → | Conversa inicial | `agenda` | Oferece conversa de 20 minutos |
| Principal | Mensalidades | `mensalidade_list` | Mostra parcelas autorizadas |
| Principal | Segunda via de pagamento | `mensalidade_copy` | Reenvia cobrança válida |
| Principal | Pacote e reposições | `human` | Professor confere saldo e pedidos |
| Principal | Material das aulas | `human` | Professor envia somente material autorizado |
| Principal | Falar com o professor | `human` | Atendimento humano |

No modelo inicial, “Pacote e reposições” não informa saldo automático. Esse fluxo é humano até existir cálculo confiável a partir dos lançamentos.

### O cliente resolve sozinho

| Ação | Limite |
|---|---|
| Abrir interesse | Não confirma contratação |
| Consultar acompanhamento | Somente o próprio registro autorizado |
| Agendar aula | Conforme disponibilidade; a elegibilidade do pacote precisa estar conferida |
| Remarcar | Dentro do prazo configurado |
| Cancelar agendamento | Não decide automaticamente consumo ou reembolso |
| Consultar pagamento | Somente cobranças do pagador autorizado |
| Aceitar condições | Depois de receber documento completo e versionado |

Até existir validação automática do pacote no agendamento, usar confirmação humana para a primeira aula e para alunos sem elegibilidade já conferida.

### Mensagens e lembretes

| Situação | Texto pronto | Regra |
|---|---|---|
| Saudação | Olá! Escolha Quero começar, Aulas e horários, Mensalidades ou Falar com o professor. Para consultar saldo ou pedir reposição, use Pacote e reposições. | Entrada |
| Aula marcada | Aula agendada: {servico} com {profissional}, em {data} às {hora}. Para alterar, use Meus agendamentos. | Confirmação |
| Lembrete | Lembrete da sua aula: {data} às {hora}, com {profissional}. Você confirma? | 24 horas antes |
| Pedido de reposição | Recebi seu pedido de reposição. Vou conferir o encontro original e as condições do pacote antes de confirmar outro horário. | Atendimento humano |
| Revisão do pacote | Vou conferir as aulas realizadas, as reposições e o saldo do seu pacote. A confirmação será enviada por este atendimento. | Atendimento humano |
| Cancelamento pelo professor | Precisei cancelar a aula combinada. Ela será remarcada sem consumir outra aula do pacote. Vou enviar opções de horário. | Após decisão do professor |
| Material disponível | Há material das aulas disponível para você. O professor enviará o acesso pelo atendimento seguro. | Sem nome de menor ou descrição pedagógica |
| Vínculo pendente | Preciso conferir o responsável autorizado antes de liberar essas informações. | Sem revelar dados do aluno |

## 6. Bot da área

### Instruções prontas

> Você é o assistente administrativo do professor. Responda em português do Brasil, com frases curtas. Informe somente disciplinas, formatos, serviços e condições públicas aprovadas. Encaminhe horários à Agenda e pagamentos à Mensalidade. Não invente saldo de aulas, preço, desconto ou vaga. Para saldo, falta, reposição, pausa, reembolso ou exceção de remarcação, encaminhe ao professor. Não confirme pagamento por relato ou imagem de comprovante. Não faça diagnóstico, avaliação pedagógica ou promessa de resultado. Não leia anotações de aprendizagem, documentos ou dados de menores. Não peça nome completo de criança, escola, laudo ou informação familiar. Para aluno menor, use somente o responsável validado pelo atendimento seguro. Se faltar uma regra, diga: “O professor precisa conferir essa condição antes de confirmar.”

| Categoria | Permissão |
|---|---|
| Faz sozinho | Explica serviços públicos e orienta uso do menu |
| Pergunta ao professor | Reposição, saldo divergente, exceção de prazo, desconto, validade e reembolso |
| Nunca faz | Debitar aula, conceder crédito, alterar contrato, avaliar aprendizagem ou prometer aprovação |
| Não pode ler | Observações pedagógicas, documentos, dados de menores, vínculos familiares e relatos privados |
| Operação financeira | Somente encaminhamento ao módulo financeiro |
| Menores | Mesmo bloqueio de contexto e ferramentas definido no modelo Escolas |

O bot não precisa receber os lançamentos de aula para orientar o cliente. O saldo, quando automatizado no futuro, deve ser calculado por código e entregue por fluxo determinístico.

## 7. Equipe

| Setor | Categorias |
|---|---|
| Aulas | Interesse; Agendamento; Material; Acompanhamento |
| Administração | Pacote; Reposição; Remarcação; Pausa |
| Financeiro | Mensalidade; Segunda via; Pagamento; Reembolso |

| Papel funcional | Pode ler | Pode fazer |
|---|---|---|
| Professor titular | Próprios alunos e registros pedagógicos necessários | Planejar, registrar aula, conferir saldo e decidir reposição |
| Auxiliar administrativo | Agenda e dados mínimos de contato | Agendar, encaminhar documentos e organizar tarefas |
| Financeiro | Contratação e cobranças autorizadas | Operar conforme permissões financeiras |
| Responsável pedagógico | Material e informações compartilhadas do aluno autorizado | Pedir reunião e acompanhar |
| Responsável financeiro | Cobranças autorizadas | Consultar e pagar |
| Aluno adulto | Seus registros compartilháveis | Agendar, aceitar condições e acompanhar |

O papel atual da OS é `os:technician`, com finalidade de execução e seleção de responsável (`src/modules/os/definition.ts:61`). Ele não deve ser apresentado como prova de isolamento entre professores.

Se dois professores compartilharem a área, o motor deve restringir registros por responsável ou pela extensão Ensino. Enquanto essa restrição não existir, usar uma área por professor. Não conceder acesso amplo esperando que cada pessoa consulte apenas seus alunos.

## 8. Passos manuais após aplicar o modelo

| Ordem | Passo | Quem conclui |
|---:|---|---|
| 1 | Definir disciplinas, formatos e duração das aulas | Professor |
| 2 | Publicar disponibilidade, folgas e feriados | Professor |
| 3 | Definir preços e distinguir pacote avulso de recorrência mensal | Professor |
| 4 | Revisar contrato, remarcação, falta, reposição e reembolso | Professor |
| 5 | Configurar cobrança e pagador autorizado | Professor ou financeiro |
| 6 | Conferir o primeiro horário antes de ativar o acompanhamento | Professor |
| 7 | Registrar os créditos iniciais e a referência da contratação | Professor |
| 8 | Registrar cada aula realizada e conferir saldo periodicamente | Professor |
| 9 | Definir acesso do auxiliar e separar dados pedagógicos | Professor |
| 10 | Validar responsáveis antes de atender menores no sistema | Professor |
| 11 | Definir aviso de privacidade e guarda | Professor |
| 12 | Revisar materiais e autorização de compartilhamento | Professor |
| 13 | Manter bot desligado até garantir isolamento dos dados | Administrador |

## 9. Extensão

Não é proposta uma extensão separada para professores particulares. O modelo usa as peças genéricas do motor e, quando necessário, a extensão Ensino descrita na área Escolas.

| Situação | Solução |
|---|---|
| Professor atende somente adultos | Motor generalizado, Agenda, Mensalidade e Cobrança |
| Professor atende menores | Cadastro e vínculos da extensão Ensino; sem obrigação de usar notas ou turmas |
| Professor trabalha com grupos | Turmas, horários, enturmação e frequência da mesma extensão |
| Professor precisa de avaliação por período | Regras e boletim da mesma extensão |
| Professor precisa apenas de pacote e reposição | Lançamentos genéricos e conferência humana |
| Desejo de saldo automático | Evolução do motor comum para referência única de aula, consumo e ajuste; **a conferir na fase 2** |

Para o vínculo do aluno particular, usar `ensino_work_links.purpose = 'private_student'`. Não criar matrícula escolar fictícia apenas para cadastrar um menor.

As tabelas, rotas, permissões, privacidade e guarda são as da seção 9 da área Escolas. Não há DDL adicional nesta área.

**Ficam de fora:** censo, histórico escolar oficial, certificado com validade regulatória presumida, ambiente de provas, correção por IA, aulas por videoconferência próprias e cálculo automático de créditos ainda não contratado no motor comum.

## 10. Dúvidas e decisões do dono do produto

| Decisão | Proposta |
|---|---|
| Nome do conjunto | Alunos |
| Pacote ou mensalidade | Oferecer ambos, com fluxos distintos |
| Saldo inicial | Conferência humana, sem promessa de cálculo automático |
| Falta do aluno | Regra contratual explícita; sem débito automático no primeiro modelo |
| Reposição por cancelamento do professor | Não consumir nova aula |
| Renovação de pacote | Lançamento novo no mesmo acompanhamento |
| Mais de um professor | Exigir isolamento por responsável ou turma |
| Atendimento de menores | Reutilizar os controles da extensão Ensino |
| Notas e boletim | Opcionais; desligados no modelo inicial |
| Bot | Somente informações administrativas públicas |
| Guarda | Aprovar política antes de registrar dados pedagógicos |
| Integração com ERP | Fora desta entrega |

### Modelo neutro em JSON

```json
{
  "id": "area-professores",
  "name": "Professores particulares",
  "labels": {
    "customer": "Aluno ou responsável",
    "customers": "Alunos e responsáveis",
    "work_collection": "Alunos",
    "assignee": "Professor",
    "quote": "Condições das aulas"
  },
  "modules": {
    "on": ["os", "agenda", "mensalidade", "payments"],
    "off": ["queue", "forms", "reserva", "pedido", "mesas", "entrega", "suporte", "erp", "erp-fiscal", "erp-cobranca", "erp-pdv"]
  },
  "conditional_modules": [
    {
      "id": "ensino",
      "when": "Atendimento de menores ou uso de turmas, frequência ou boletim",
      "required_for_minors": true
    }
  ],
  "policies": {
    "preserve_existing": true,
    "module_off_is_initial_recommendation": true,
    "sensitive_data_to_ai": false,
    "automatic_lesson_balance": false,
    "automatic_credit_from_payment": false,
    "automatic_absence_debit": false,
    "stale_zero_disables": true,
    "task_due_days_basis": "calendar_days",
    "bot_enabled_after_isolation_review": false
  },
  "work_types": [
    {
      "id": "professores_aluno",
      "singular": "Aluno",
      "plural": "Alunos",
      "item_label": "Nome do aluno",
      "problem_label": "Disciplina ou objetivo",
      "features": {
        "quote": false,
        "warranty": false,
        "pickup": false,
        "terms": true,
        "tasks": true,
        "people": true,
        "files": true,
        "entries": true
      },
      "terms_text": "Solicito atendimento para aulas particulares. Antes do início, receberei as condições de quantidade, duração, preço, validade e remarcação. Entendo que este pedido não confirma horário nem contratação. Quando o aluno for menor, o professor conferirá o responsável autorizado.",
      "commercial_terms_text": "O pacote inclui {quantidade_aulas} aulas de {duracao_minutos} minutos, no formato {modalidade}, pelo valor total de {valor_pacote}. A validade combinada é {validade_pacote}. Você pode remarcar pelo menu até 24 horas antes. Pedidos posteriores serão analisados pelo professor conforme o contrato. Aula cancelada pelo professor será remarcada sem consumir outra aula do pacote. Descontos, reembolso, pausa e situações excepcionais dependem de confirmação expressa. Declaro que li e aceito estas condições.",
      "fields": [
        {"key":"disciplina","label":"Disciplina","type":"texto","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"modalidade","label":"Formato das aulas","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["online","presencial","hibrido"]},
        {"key":"aulas_por_pacote","label":"Aulas do pacote contratado","type":"numero","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"duracao_minutos","label":"Duração de cada aula","type":"numero","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"inicio_pacote","label":"Início do pacote atual","type":"data","required":false,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"validade_pacote","label":"Validade contratada do pacote","type":"data","required":false,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"objetivo_restrito","label":"Observação pedagógica restrita","type":"texto_longo","required":false,"customer_visible":false,"sensitive":true,"options":[]}
      ],
      "stages": [
        {"id":"interesse","label":"Interesse recebido","base":"received","next":["conversa_inicial","cancelado"],"message":"Recebi seu interesse em aulas, registro nº {numero}. Vou conferir a disciplina, o formato e os horários disponíveis.","stale_days":2},
        {"id":"conversa_inicial","label":"Conversa inicial","base":"analyzing","next":["combinado","cancelado"],"message":"O registro nº {numero} está na conversa inicial. Vamos combinar objetivo, horários e condições antes de começar.","stale_days":3},
        {"id":"combinado","label":"Condições para aceite","base":"analyzing","next":["ativo","conversa_inicial","cancelado"],"message":"As condições do registro nº {numero} estão disponíveis para conferência. As aulas começam após a confirmação do professor.","stale_days":5},
        {"id":"ativo","label":"Aulas em andamento","base":"in_progress","next":["pausado","renovacao","concluido"],"message":"As aulas do registro nº {numero} estão em andamento. Use Meus agendamentos para consultar os próximos horários.","stale_days":0},
        {"id":"pausado","label":"Aulas pausadas","base":"analyzing","next":["ativo","concluido"],"message":"A pausa do registro nº {numero} foi registrada. O professor vai confirmar o retorno e as condições do pacote.","stale_days":0},
        {"id":"renovacao","label":"Revisão do pacote","base":"ready","next":["ativo","pausado","concluido"],"message":"O pacote do registro nº {numero} está em revisão. Fale com o professor para conferir saldo, reposições e continuidade.","stale_days":7},
        {"id":"concluido","label":"Acompanhamento encerrado","base":"delivered","next":[],"message":"O acompanhamento nº {numero} foi encerrado. O professor pode informar as condições para um novo período de aulas.","stale_days":0},
        {"id":"cancelado","label":"Interesse cancelado","base":"cancelled","next":[],"message":"O pedido nº {numero} foi cancelado antes do início das aulas.","stale_days":0}
      ],
      "people_roles": [
        {"id":"aluno","label":"Aluno"},
        {"id":"responsavel_pedagogico","label":"Responsável pedagógico"},
        {"id":"responsavel_financeiro","label":"Responsável financeiro"},
        {"id":"professor","label":"Professor"}
      ],
      "entry_kinds": [
        {"id":"pacote_contratado","label":"Pacote contratado"},
        {"id":"aula_realizada","label":"Aula realizada"},
        {"id":"ausencia","label":"Ausência"},
        {"id":"remarcacao","label":"Remarcação"},
        {"id":"reposicao_realizada","label":"Reposição realizada"},
        {"id":"ajuste_creditos","label":"Ajuste de créditos"},
        {"id":"anotacao_pedagogica_restrita","label":"Anotação pedagógica restrita"}
      ],
      "file_kinds": [
        {"id":"condicoes","label":"Condições contratadas","customer_can_receive":true},
        {"id":"plano_estudos","label":"Plano de estudos compartilhável","customer_can_receive":true},
        {"id":"material","label":"Material didático autorizado","customer_can_receive":true},
        {"id":"resumo","label":"Resumo de acompanhamento aprovado","customer_can_receive":true},
        {"id":"registro_interno","label":"Registro pedagógico interno","customer_can_receive":false},
        {"id":"representacao","label":"Comprovação de representação","customer_can_receive":false}
      ],
      "default_tasks": [
        {"stage":"interesse","title":"Conferir disciplina, formato e disponibilidade","due_days":1},
        {"stage":"conversa_inicial","title":"Realizar conversa inicial e preparar condições","due_days":2},
        {"stage":"combinado","title":"Conferir aceite, contratação e primeiro horário","due_days":1},
        {"stage":"ativo","title":"Conferir agenda e lançamentos do pacote","due_days":7},
        {"stage":"pausado","title":"Registrar retorno previsto e revisar cobranças","due_days":1},
        {"stage":"renovacao","title":"Conferir saldo, reposições e proposta de continuidade","due_days":2},
        {"stage":"concluido","title":"Conferir saldo final, documentos e guarda","due_days":2},
        {"stage":"cancelado","title":"Revisar pendências do interesse cancelado","due_days":1}
      ]
    }
  ],
  "module_settings": {
    "agenda": {
      "min_notice_minutes": 720,
      "max_days_ahead": 30,
      "slot_step_minutes": 10,
      "reminder_hours": 24,
      "customer_change_hours": 24,
      "close_on_holidays": true,
      "services": [
        {"id":"professores_conversa","name":"Conversa inicial","duration_minutes":20},
        {"id":"professores_aula","name":"Aula","duration_minutes":50},
        {"id":"professores_reuniao","name":"Reunião com responsável","duration_minutes":20}
      ],
      "booked_text": "Aula agendada: {servico} com {profissional}, em {data} às {hora}. Para alterar, use Meus agendamentos.",
      "reminder_text": "Lembrete da sua aula: {data} às {hora}, com {profissional}. Você confirma?"
    },
    "mensalidade": {
      "suggested_due_day": 10,
      "days_before": 3,
      "notice_on_due_date": true,
      "overdue_every_days": 7,
      "overdue_max": 2,
      "plans": [
        {"id":"professores_mensal_4","name":"Acompanhamento mensal — 4 aulas de 50 minutos","period":"monthly","price_cents":null,"active":false},
        {"id":"professores_mensal_8","name":"Acompanhamento mensal — 8 aulas de 50 minutos","period":"monthly","price_cents":null,"active":false}
      ]
    },
    "payments": {
      "one_time_products": ["Pacote avulso", "Aula avulsa"],
      "price_requires_manual_definition": true
    }
  },
  "menus": [
    {"id":"professores_menu_comecar","label":"Quero começar","type":"os_open","parent_id":null,"content":"","reference":{"kind":"work_type","id":"professores_aluno"}},
    {"id":"professores_menu_acompanhar","label":"Meu acompanhamento","type":"os_track","parent_id":null,"content":"","reference":{"kind":"work_type","id":"professores_aluno"}},
    {"id":"professores_menu_aulas","label":"Aulas e horários","type":"submenu","parent_id":null,"content":""},
    {"id":"professores_menu_agendar","label":"Agendar aula","type":"agenda","parent_id":"professores_menu_aulas","content":"","reference":{"kind":"service","id":"professores_aula"}},
    {"id":"professores_menu_agendamentos","label":"Meus agendamentos","type":"agenda_mine","parent_id":"professores_menu_aulas","content":""},
    {"id":"professores_menu_conversa","label":"Conversa inicial","type":"agenda","parent_id":"professores_menu_aulas","content":"","reference":{"kind":"service","id":"professores_conversa"}},
    {"id":"professores_menu_mensalidades","label":"Mensalidades","type":"mensalidade_list","parent_id":null,"content":""},
    {"id":"professores_menu_segunda_via","label":"Segunda via de pagamento","type":"mensalidade_copy","parent_id":null,"content":""},
    {"id":"professores_menu_pacote","label":"Pacote e reposições","type":"human","parent_id":null,"content":"Vou conferir as aulas realizadas, as reposições e o saldo do seu pacote. A confirmação será enviada por este atendimento.","reference":{"kind":"department","id":"professores_administracao"}},
    {"id":"professores_menu_material","label":"Material das aulas","type":"human","parent_id":null,"content":"O professor vai conferir o material autorizado para este atendimento.","reference":{"kind":"department","id":"professores_aulas"}},
    {"id":"professores_menu_humano","label":"Falar com o professor","type":"human","parent_id":null,"content":"Vou encaminhar você ao professor.","reference":{"kind":"department","id":"professores_aulas"}}
  ],
  "departments": ["Aulas", "Administração", "Financeiro"],
  "ticket_categories": ["Interesse", "Agendamento", "Material", "Acompanhamento", "Pacote", "Reposição", "Remarcação", "Pausa", "Mensalidade", "Segunda via", "Pagamento", "Reembolso"],
  "bot_instructions": "Você é o assistente administrativo do professor. Responda em português do Brasil, com frases curtas. Informe somente disciplinas, formatos, serviços e condições públicas aprovadas. Encaminhe horários à Agenda e pagamentos à Mensalidade. Não invente saldo de aulas, preço, desconto ou vaga. Para saldo, falta, reposição, pausa, reembolso ou exceção de remarcação, encaminhe ao professor. Não confirme pagamento por relato ou imagem de comprovante. Não faça diagnóstico, avaliação pedagógica ou promessa de resultado. Não leia anotações de aprendizagem, documentos ou dados de menores. Não peça nome completo de criança, escola, laudo ou informação familiar. Para aluno menor, use somente o responsável validado pelo atendimento seguro. Se faltar uma regra, diga: “O professor precisa conferir essa condição antes de confirmar.”",
  "extension": {
    "id": "ensino",
    "reuse_school_extension": true,
    "work_link_purpose": "private_student",
    "required_for_minors": true,
    "classes_optional": true,
    "grading_optional": true,
    "additional_tables": []
  },
  "manual_steps": [
    "Definir disciplinas, formatos e duração das aulas.",
    "Publicar disponibilidade, folgas e feriados.",
    "Definir preços e separar pacote avulso de assinatura mensal.",
    "Revisar contrato, remarcação, falta, reposição e reembolso.",
    "Configurar cobrança e pagador autorizado.",
    "Conferir o primeiro horário antes de ativar o acompanhamento.",
    "Registrar créditos iniciais e referência da contratação.",
    "Registrar aulas realizadas e conferir saldo periodicamente.",
    "Restringir acesso do auxiliar aos dados administrativos.",
    "Validar responsáveis antes de atender menores no sistema.",
    "Definir aviso de privacidade e política de guarda.",
    "Revisar materiais e autorização de compartilhamento.",
    "Manter bot desligado até garantir isolamento dos dados."
  ]
}
```