**Modelos de área: clínicas médicas e clínicas veterinárias**  
**Proposta de produto e contrato técnico — 18/11/2026**

Referência: cópia do repositório no commit `efc7e54`. A versão declarada é `0.21.1` (`package.json:3`). Este documento contém propostas. Não descreve funcionalidades já entregues, salvo quando cita o código. Não houve escrita de arquivos, acesso à rede ou execução de testes.

As referências à LGPD e às normas profissionais indicam assuntos para validação. Sua redação vigente, aplicabilidade e exigências específicas estão **a conferir**. Não se fixa prazo legal de guarda sem essa validação.

Convenções para os dois modelos:

| Assunto | Regra proposta |
|---|---|
| Motor | Usar `os`. A extensão Saúde depende dele. Não criar outro motor de trabalhos. |
| Infraestrutura | Usar o Worker, o D1, o R2 e o `Coordinator` existentes. Nenhuma classe nova de Durable Object. |
| Migrações | Somente aditivas. O DDL deste documento é uma proposta não executada. |
| Tipo embutido | Preservar integralmente “Ordem de serviço”, seus textos, transições e comportamento. |
| Estados | Cada etapa aponta para um dos nove códigos existentes em `src/modules/os/model.ts:6`. |
| Aviso de estagnação | `stale_days: 0` desliga o aviso naquela etapa. Os demais valores representam dias corridos. |
| Tarefas padrão | `due_days: 0` significa concluir no dia da entrada na etapa. Não representa prazo clínico nem atendimento imediato. |
| Mensagem vazia | Não enviar mensagem ao entrar na etapa. |
| Campos sensíveis | Não enviar ao WhatsApp nem à IA. Exigir permissão explícita para leitura. |
| Identificadores | Prefixar tipos, menus e cadastros pelo identificador do modelo. |
| Aplicação | Mostrar prévia. Acrescentar configurações. Não substituir alterações manuais nem desligar módulos já usados sem decisão explícita na prévia. |
| JSON | Formato neutro proposto. Chaves complementares, como `terms_text`, `module_config` e `security`, também exigem conversão. Não são parâmetros aceitos hoje pela API. |

O contrato atual já prevê dependências, papéis e ajustes do catálogo do bot (`src/modules/types.ts:73`, `src/modules/types.ts:85`, `src/modules/types.ts:94`). Entretanto, `bot.sensitive` significa exigir segundo fator em operações. Não significa esconder dados da IA (`src/modules/types.ts:97`). O isolamento clínico exige guardas próprios.

# Clínicas médicas e consultórios

## 1. Quem usa e como é o dia a dia

Uma recepcionista organiza horários, confirma presença e trata pagamentos.  
Um a poucos médicos atendem e registram o cuidado.  
O cliente é o paciente. Um responsável pode cuidar da parte administrativa.  
O paciente pergunta sobre horários, convênio, valores, endereço e retorno.  
Também pede preparo, receitas e resultados. Esses pedidos exigem encaminhamento seguro.  
A recepção não precisa ler diagnóstico, evolução, prescrição ou resultado para organizar o atendimento.  
O modelo atende o fluxo administrativo. O prontuário pertence exclusivamente à extensão Saúde.

## 2. Tipos de trabalho

### Atendimento / Atendimentos

Uma ordem representa um episódio administrativo de consulta, retorno ou procedimento. O prontuário longitudinal pertence ao paciente e reúne vários episódios.

| Propriedade | Definição |
|---|---|
| Identificador | `clinica_medica_atendimento` |
| Singular / plural | Atendimento / Atendimentos |
| Campo fixo `item` | Identificação do atendimento |
| Exemplo de `item` | `Atendimento administrativo P0042` |
| Campo fixo `problem` | Solicitação administrativa |
| Exemplo de `problem` | `Solicitação de horário` |
| Responsável do trabalho | Pessoa responsável pela organização do episódio |
| Profissional clínico | Vínculo separado com o médico na extensão Saúde |
| Abertura pelo cliente | Apenas solicitação administrativa. Não pedir sintomas. |
| Criação pela Agenda | Criar ou vincular uma única ordem ao agendamento, com chave de idempotência. |

Não usar “Queixa”, “Sintomas” ou “Diagnóstico” como rótulos dos campos comuns. A resposta atual da OS inclui `item`, `problem`, `notes` e histórico (`src/modules/os/store.ts:108`, `src/modules/os/store.ts:144`). Isso não constitui um prontuário com isolamento clínico.

O cadastro da pessoa, sua identificação civil e seus representantes ficam na extensão. A ordem guarda somente a projeção administrativa necessária.

### Campos extras

| Chave | Rótulo | Tipo e opções | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `modalidade` | Modalidade | `lista`: consulta, retorno, procedimento | Sim, antes de agendar | Não | Sim |
| `pagamento_tipo` | Forma de atendimento | `lista`: particular, convenio | Sim, antes de cobrar | Não | Sim |
| `convenio_nome` | Convênio informado | `texto` | Se convênio | Não | Sim |
| `autorizacao_convenio` | Situação da autorização | `lista`: nao_se_aplica, pendente, confirmada, negada | Sim, antes de confirmar cobertura | Não | Sim |
| `contato_administrativo` | Contato administrativo | `lista`: paciente, responsavel_verificado | Sim | Não | Sim |

A validação condicional precisa ser descrita no contrato do tipo. O booleano `required` do formato neutro não expressa sozinho “obrigatório quando”.

Não guardar número de carteirinha, CPF, documento do responsável, CID ou foto de guia nesses campos. Quando necessários, ficam em cadastro protegido da extensão. A classificação sensível aqui é uma regra de proteção do produto. Não pretende classificar juridicamente cada campo de forma isolada.

### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `solicitado` | Solicitação recebida | `received` | `agendado`, `cancelado` | Recebemos a solicitação nº {numero}. A recepção dará continuidade por este canal. Não envie informações de saúde aqui. | 1 |
| `agendado` | Horário reservado | `analyzing` | `confirmado`, `cancelado`, `ausente` | Vazio | 0 |
| `confirmado` | Presença confirmada | `approved` | `agendado`, `em_atendimento`, `cancelado`, `ausente` | Vazio | 0 |
| `em_atendimento` | Atendimento iniciado | `in_progress` | `concluido` | Vazio | 0 |
| `concluido` | Atendimento concluído | `delivered` | Nenhuma | Vazio | 0 |
| `cancelado` | Cancelado | `cancelled` | Nenhuma | A solicitação nº {numero} foi cancelada. Para um novo horário, acesse Agendar no menu. | 0 |
| `ausente` | Não compareceu | `cancelled` | Nenhuma | Vazio | 0 |

Regras das etapas:

| Regra | Comportamento |
|---|---|
| Confirmação | `approved` representa presença confirmada neste tipo. Não representa consentimento clínico nem aprovação de orçamento. |
| Remarcação | Voltar de `confirmado` para `agendado`. Invalidar a confirmação anterior. |
| Ausência | A recepção registra após conferir o horário. O bot não presume ausência. |
| Início e conclusão | Exigir confirmação da equipe clínica. Recepção não conclui cuidado clínico. |
| Cancelamento após início | Não usar para apagar atendimento realizado. Concluir o episódio e registrar a situação no prontuário. |
| Retorno | Criar outro Atendimento, ligado ao mesmo paciente e ao episódio de origem. Não reabrir o atendimento concluído. |
| Mensagens da Agenda | São a fonte de confirmação e lembrete. Evitar mensagens duplicadas da OS. |

Essas transições são propostas do tipo. Hoje, `approved` e `declined` são tratados como respostas a orçamento no motor fixo (`src/modules/os/model.ts:35`, `src/modules/os/store.ts:619`). A generalização precisa separar a etapa própria desse efeito legado.

### Recursos ligados

| Recurso | Configuração e uso |
|---|---|
| Orçamento com aprovação | Desligado. A recepção informa valores administrativos e gera cobrança autorizada. Procedimentos que exigirem proposta detalhada precisam de fluxo protegido e validação posterior. |
| Garantia | Desligada. Não aplicar garantia de conserto a atendimento médico. |
| Retirada | Desligada. Não enviar lembrete de retirada de prontuário ou resultado. |
| Termos | Ligados, apenas para o canal administrativo. Texto abaixo. |
| Tarefas e prazos | Ligados. Apenas tarefas administrativas no motor comum. |
| Pessoas ligadas | Paciente, responsável legal verificado, contato autorizado e médico responsável. O vínculo não concede acesso clínico automaticamente. |
| Documentos comuns | Recibo administrativo e orientações de acesso à unidade. Ambos podem ser entregues ao destinatário verificado. Sem diagnóstico, exame ou prescrição. |
| Lançamentos comuns | Contato administrativo, conferência de cadastro e ocorrência de agenda. Sem texto clínico. |
| Documentos clínicos | Exclusivamente na extensão Saúde. Não usar a tabela genérica de documentos do trabalho. |

**Termo administrativo pronto:**

> Solicito atendimento administrativo por este canal. Os horários dependem de confirmação. Não enviarei sintomas, exames, receitas ou documentos de saúde pelo WhatsApp. Informações e autorizações clínicas serão tratadas com a equipe pelo canal protegido indicado pela clínica. Este aceite não autoriza procedimento e não substitui consentimento específico.

O termo não deve funcionar como consentimento genérico para todo tratamento de dados. A finalidade, a base legal e o aviso de privacidade precisam ser definidos separadamente.

### Tarefas padrão

| Etapa | Tarefa | Responsável | Vencimento |
|---|---|---|---|
| `solicitado` | Conferir identidade e contato administrativo autorizado | Recepção | Mesmo dia |
| `agendado` | Conferir cobertura informada ou valor particular | Recepção | Mesmo dia |
| `confirmado` | Conferir pendências administrativas do horário | Recepção | Mesmo dia |
| `em_atendimento` | Conferir vínculo com o profissional responsável | Equipe clínica | Mesmo dia |
| `concluido` | Encerrar pendências administrativas do episódio | Recepção | Mesmo dia |
| `cancelado` | Conferir cobrança pendente e necessidade de estorno | Financeiro | Mesmo dia |
| `ausente` | Registrar ocorrência administrativa da agenda | Recepção | Mesmo dia |

Essas tarefas não substituem prescrição, acompanhamento clínico ou avaliação de risco. Prazos clínicos ficam na extensão, com data definida por profissional.

## 3. Vocabulário

| Conceito | Nome na área |
|---|---|
| Cliente | Paciente |
| Clientes | Pacientes |
| Trabalho | Atendimento |
| Conjunto de trabalhos | Atendimentos |
| Responsável pelo trabalho | Responsável administrativo |
| Profissional | Médico responsável |
| Orçamento | Proposta de valores |
| Pessoa que fala pelo paciente | Responsável ou contato autorizado |
| Registro clínico longitudinal | Prontuário |

“Responsável administrativo” e “responsável legal pelo paciente” são relações diferentes. A interface deve mostrar os dois nomes completos.

## 4. Módulos

### Ativação e configuração sugerida

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| Agenda | Ligado | Agenda por médico. Antecedência mínima de 120 minutos. Horizonte de 30 dias. Grade de 10 minutos. Lembrete de 24 horas. Remarcação pelo cliente até 2 horas antes. |
| Mensalidade | Desligado | Nenhum plano criado. Não presumir assinatura de serviços médicos. |
| Formulários | Ligado | Somente preferência administrativa de contato. Sem anamnese, sintomas ou documentos clínicos. |
| Cobrança | Ligado | Vincular a conta da clínica. Descrição externa neutra: “Serviço administrativo nº {numero}”. Valores definidos pela equipe. |
| Reserva | Desligado | Não usar como agenda de consultório. |
| ERP | Desligado | Nenhum lançamento financeiro automático neste modelo. |
| OS | Ligado | Tipo `clinica_medica_atendimento`. |
| Saúde | Obrigatório para uso clínico | Instalar e validar antes de guardar dados clínicos ou atender menores pelo fluxo proposto. |

A Agenda já possui serviços com duração e profissionais vinculados a serviços (`src/modules/agenda/catalog.ts:24`, `src/modules/agenda/catalog.ts:40`). Os parâmetros de antecedência, lembrete e remarcação estão em `src/modules/agenda/config.ts:9`.

### Serviços da Agenda

| Serviço interno | Duração inicial | Quem pode reservar | Regra |
|---|---:|---|---|
| Consulta | 30 minutos | Paciente ou recepção | Médico escolhe os serviços que oferece. |
| Retorno | 20 minutos | Recepção; paciente após liberação | Não presumir gratuidade nem prazo clínico de retorno. |
| Procedimento | 60 minutos | Recepção | Horário liberado após avaliação do profissional. Não abrir autoagendamento genérico. |

As durações são parâmetros administrativos iniciais. O médico deve ajustá-las antes da publicação.

### Formulário administrativo

| Pergunta pronta | Tipo | Obrigatória | Destino |
|---|---|---|---|
| Você prefere receber avisos administrativos por este WhatsApp? | `sim_nao` | Sim | Preferência de comunicação |
| Em qual período podemos entrar em contato? | `lista`: manhã, tarde, indiferente | Sim | Recepção |
| Deseja falar com a recepção sobre cadastro ou cobrança? | `lista`: cadastro, cobrança, nenhum | Sim | Encaminhamento administrativo |

Título: **Preferências de contato**.

Texto inicial:

> Este formulário trata apenas do contato administrativo. Não inclua informações sobre saúde. Para atualizar documentos ou dados do paciente, fale com a recepção.

O tipo de menu `form` e sua referência `form_id` já existem (`src/modules/forms/definition.ts:19`). O formulário protegido de saúde proposto na extensão não é um formulário comum desse módulo.

### Confirmações sem exposição clínica

Texto de reserva:

> Horário reservado para {data} às {hora}. Para confirmar, remarcar ou cancelar, use Meus horários no menu.

Texto de lembrete:

> Você tem um horário reservado para {data} às {hora}. Confirma sua presença?

Texto de cancelamento:

> O horário de {data} às {hora} foi cancelado. Para solicitar outro, use Agendar no menu.

Não incluir especialidade, procedimento, motivo ou resultado nas mensagens. Também não incluir nome completo quando o telefone for compartilhado.

A configuração de textos, sozinha, não garante essa neutralidade em todos os caminhos. Há mensagens da Agenda montadas diretamente com serviço e profissional (`src/modules/agenda/chat.ts:500`, `src/modules/agenda/chat.ts:559`). Todos esses caminhos precisam ser revisados antes da ativação.

## 5. WhatsApp

### Árvore do menu

Todos os itens abaixo ficam na raiz. As referências indicadas são propostas de configuração.

| ID | Rótulo | Tipo | Referência / ação |
|---|---|---|---|
| `clinica_medica_agendar` | Agendar | `agenda` | Oferecer apenas serviços liberados para autoagendamento. |
| `clinica_medica_horarios` | Meus horários | `agenda_mine` | Confirmar, remarcar ou cancelar os horários autorizados. |
| `clinica_medica_solicitar` | Solicitar atendimento | `os_open` | Tipo `clinica_medica_atendimento`; formulário administrativo sem texto clínico livre. |
| `clinica_medica_acompanhar` | Minhas solicitações | `os_track` | Tipo `clinica_medica_atendimento`; somente projeção administrativa. |
| `clinica_medica_preparo` | Preparo e documentos | `content` | Texto pronto abaixo. |
| `clinica_medica_preferencias` | Preferências de contato | `form` | `clinica_medica_preferencias_contato`. |
| `clinica_medica_recepcao` | Falar com a recepção | `queue` | Setor Recepção. |
| `clinica_medica_urgencia` | Sobre urgências | `content` | Texto pronto abaixo. |

**Preparo e documentos:**

> Para receber preparo, solicitar documento ou tratar de exames e receitas, fale com a recepção. A equipe indicará o canal protegido. Não envie documentos de saúde por este WhatsApp.

**Sobre urgências:**

> Este canal não realiza atendimento de urgência e não é acompanhado continuamente. Em uma urgência, procure um serviço de emergência.

### O que o paciente resolve sozinho

| Ação | Limite |
|---|---|
| Solicitar horário | Sem sintomas ou motivo clínico. |
| Confirmar ou remarcar | Apenas agendamentos vinculados ao seu acesso administrativo. |
| Cancelar | Dentro da antecedência permitida. Fora dela, encaminhar à recepção. |
| Acompanhar solicitação | Número, situação administrativa e pendências não clínicas. |
| Receber cobrança | Somente cobrança preparada pela equipe e dirigida ao pagador correto. |
| Pedir retorno | Solicita o horário. Não determina indicação, gratuidade ou prazo. |
| Pedir documento | Abre solicitação administrativa. Não baixa prontuário pelo WhatsApp. |

O telefone identifica o canal administrativo. Ele não comprova representação legal nem autoriza leitura de prontuário.

### Automações e lembretes

| Gatilho | Destino | Texto / ação |
|---|---|---|
| Horário reservado | Contato autorizado | Texto de reserva da seção 4. |
| 24 horas antes | Contato autorizado | Texto de lembrete da seção 4. |
| Solicitação parada por 1 dia | Recepção | “A solicitação nº {numero} aguarda conferência administrativa.” |
| Retorno definido pelo médico | Recepção | Criar tarefa protegida na data indicada. |
| Convite para agendar retorno | Paciente, após liberação | “A recepção pode ajudar a organizar um novo horário. Acesse Agendar ou fale conosco.” |
| Preparo disponível | Paciente, após conferência | “Há uma orientação disponível no canal protegido da clínica. Fale com a recepção para acessar.” |
| Resultado disponível | Sem automação no WhatsApp | Profissional define o fluxo de comunicação no canal protegido. |

A indicação clínica de retorno e o conteúdo do preparo não são copiados para a tarefa comum ou para a mensagem.

## 6. Bot da área

### Instruções prontas

> Você é o assistente administrativo da clínica. Ajude com endereço, horários de funcionamento, agendamento e contato com a recepção usando somente informações administrativas autorizadas. Não peça sintomas, diagnóstico, medicamentos, exames, receitas, documentos de saúde ou informações sobre gravidez. Não forneça orientação clínica, não interprete resultados e não avalie urgência. Não confirme cobertura de convênio sem validação da recepção. Não leia prontuários, anexos clínicos, dados de menores ou mensagens clínicas recebidas. Não use dados de um familiar para responder sobre outro paciente. Pedidos sobre preparo, retorno clínico, receitas e resultados devem ser encaminhados à equipe pelo fluxo protegido. Não prometa prazo de resposta clínica. Para urgências, use apenas: “Este canal não realiza atendimento de urgência. Em uma urgência, procure um serviço de emergência.”

### Permissões operacionais

| Categoria | Permissão |
|---|---|
| Faz sozinho | Exibir informações institucionais aprovadas. Acionar fluxos determinísticos de Agenda. Consultar situação administrativa autorizada. |
| Pergunta à equipe | Encaixe, atendimento fora da grade, cobertura de convênio, gratuidade de retorno, desconto, estorno e identidade de representante. |
| Nunca faz | Orientação clínica, diagnóstico, interpretação de exame, prescrição, renovação de receita, definição de preparo, autorização de procedimento ou decisão sobre prioridade clínica. |
| Não pode ler | Prontuário, arquivos clínicos, prescrições, exames, evolução, formulários clínicos, dados de menores, justificativas de acesso e mensagens clínicas recebidas. |

### Bloqueio técnico obrigatório

As instruções não bastam para cumprir “a IA nunca lê”.

O padrão deste modelo é **IA generativa desligada nas conversas da área**. Menu, Agenda e respostas fixas continuam disponíveis por fluxos determinísticos.

Texto, áudio, imagem e documento enviados pelo paciente não podem entrar em transcrição por IA, OCR por IA, resumo de conversa, memória, busca semântica ou contexto de bot interno. Não usar um modelo de IA para decidir se o conteúdo é clínico: isso já entregaria o conteúdo à IA.

Uma futura ativação de IA deve receber somente comandos estruturados e dados administrativos previamente autorizados. Até esse isolamento existir, permanece desligada.

## 7. Equipe

### Setores e categorias

| Setores | Categorias de protocolo |
|---|---|
| Recepção | Agendamento |
| Equipe clínica | Cadastro e representação |
| Financeiro | Convênio |
| Privacidade e documentos | Cobrança |
|  | Solicitação de documento |
|  | Privacidade |

Protocolos comuns não devem conter a narrativa clínica. Registrar apenas a necessidade de encaminhamento.

### Papéis

| Papel proposto | Vê | Faz | Não pode |
|---|---|---|---|
| Recepção | Agenda e projeção administrativa | Agendar, confirmar identidade administrativa, encaminhar pedidos | Ler prontuário ou liberar resultado |
| Financeiro | Pagador, valores e situação da cobrança | Cobrar, conciliar e tratar estorno autorizado | Ler conteúdo clínico |
| `saude:clinician` | Prontuários atribuídos e autorizados | Ler, registrar e fechar evoluções; registrar prescrição interna; revisar exames | Atuar em prontuário sem vínculo e finalidade |
| `saude:assistant` | Conteúdo necessário ao cuidado autorizado | Registrar rascunho identificado | Assinar como médico ou emitir prescrição |
| `saude:custodian` | Cadastro de representação e solicitações de cópia | Conferir destinatário e executar entrega autorizada | Ler todo o conteúdo clínico automaticamente |
| `saude:auditor` | Metadados de acesso | Investigar acessos e exportar auditoria autorizada | Ler o conteúdo dos documentos |
| Gestor técnico | Configuração e disponibilidade | Administrar a instalação | Ganhar leitura clínica apenas por ser administrador |

Os papéis existentes são declarados por módulo, e a documentação distingue acesso ao módulo de papel profissional (`docs/MODULOS.md:630`). O administrador tem acesso geral no núcleo, mas não recebe papéis automaticamente (`docs/MODULOS.md:669`). A extensão precisa exigir papel clínico explícito **e** autorização por prontuário, inclusive para administradores.

Conceder acesso técnico ao banco é uma capacidade operacional diferente. Essa pessoa pode alcançar dados fora da interface. A política de chaves, manutenção e auditoria precisa contemplar esse risco.

## 8. Passos manuais

| Ordem | Passo |
|---:|---|
| 1 | Informar nome da clínica, endereço, contato institucional e responsável técnico. |
| 2 | Validar aviso de privacidade, finalidades, bases legais e política de guarda. |
| 3 | Cadastrar médicos, registro profissional e serviços que cada um realiza. |
| 4 | Ajustar duração, expediente, intervalos, bloqueios e feriados. |
| 5 | Conferir valores, convênios aceitos e procedimento de autorização. |
| 6 | Definir regra administrativa de retorno. A indicação clínica continua individual. |
| 7 | Cadastrar pessoas da equipe e conceder somente os papéis necessários. |
| 8 | Validar representação de pacientes que dependem de responsável. |
| 9 | Configurar cobrança e destinatários dos recibos. |
| 10 | Cadastrar preparos revisados pelo médico no ambiente protegido. |
| 11 | Configurar retenção, cópia protegida, recuperação e resposta a incidentes. |
| 12 | Validar o bloqueio de IA em todos os canais da área antes da publicação. |
| 13 | Liberar o uso clínico somente depois da validação normativa e técnica da extensão. |

## 9. Extensão Saúde

### 9.1. Escopo e separação de dados

A extensão proposta chama-se `saude` e declara `requires: ["os"]`.

| Camada | Guarda | Pode aparecer no WhatsApp |
|---|---|---|
| Trabalho comum | Número, situação administrativa, responsável administrativo e pendências neutras | Somente projeção autorizada |
| Cadastro protegido | Paciente, identificação, contatos e representação | Não como retorno automático de consulta |
| Prontuário | Evolução, prescrição, exames, anexos e decisões clínicas | Nunca |
| Auditoria | Quem acessou, o quê, quando, por qual finalidade e com qual resultado | Nunca |
| Entrega protegida | Cópia autorizada, destinatário e comprovante de entrega | Apenas aviso neutro, sem documento ou credencial de acesso |

O prontuário não deve ficar em `os_orders.notes`, `os_history.note`, anexos comuns ou campos extras. O evento atual de mudança de estado inclui `note` (`src/modules/os/store.ts:578`). Por isso, notas clínicas também não podem circular como justificativa de transição.

O histórico comum registra apenas ações administrativas. A auditoria clínica é separada. Não publicar em eventos comuns que determinado paciente teve exame, evolução ou prescrição.

### 9.2. Modelo de dados

O mesmo conjunto de tabelas atende medicina e veterinária. Cada prontuário possui um sujeito longitudinal. Cada episódio liga esse sujeito a uma ordem administrativa.

| Tabela proposta | Finalidade |
|---|---|
| `saude_subjects` | Paciente humano ou animal. Identificação protegida. |
| `saude_people_links` | Paciente, representante ou tutor vinculado e verificado. |
| `saude_professionals` | Profissional habilitado e registro conferido. |
| `saude_record_access` | Autorização de acesso por prontuário, pessoa e capacidade. |
| `saude_episodes` | Atendimento clínico ligado a uma ordem administrativa. |
| `saude_evolutions` | Evoluções e adendos, com autoria e fechamento. |
| `saude_prescriptions` | Prescrições internas. Sem emissão de receita com validade legal neste escopo. |
| `saude_exams` | Solicitações, resultados recebidos e retificações. |
| `saude_attachments` | Arquivos privados no R2, com hash e vínculo clínico. |
| `saude_access_audit` | Leituras, tentativas, escritas, entregas e atos de guarda. |
| `saude_disclosure_requests` | Pedidos de cópia e entrega protegida. |
| `saude_retention_actions` | Solicitação, aprovação e execução de descarte. |

### 9.3. DDL SQLite proposto

`payload_enc` representa um envelope cifrado autenticado. Deve incluir versão da chave, nonce, conteúdo e autenticação. Não é JSON clínico em texto aberto. As chaves não ficam no D1 nem nos objetos do R2.

Datas com horário usam milissegundos UTC. A política de retenção define `retention_until`. Valor nulo bloqueia descarte automático.

As relações com usuários, contatos e OS exigem validação pelo contrato público do módulo correspondente. O DDL não cria dependências diretas dessas tabelas internas. O contrato de módulos orienta a usar `public.ts` e não acessar tabelas alheias (`docs/MODULOS.md:101`).

```sql
CREATE TABLE saude_subjects (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'animal')),
  payload_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retention_until INTEGER,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1)),
  deleted_at INTEGER,
  PRIMARY KEY (profile_id, id),
  CHECK (deleted_at IS NOT NULL OR payload_enc IS NOT NULL)
);

CREATE TABLE saude_people_links (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('patient', 'legal_representative', 'authorized_contact', 'tutor')
  ),
  payload_enc TEXT NOT NULL,
  verified_by TEXT,
  verified_at INTEGER,
  valid_until INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, subject_id)
    REFERENCES saude_subjects(profile_id, id)
);

CREATE INDEX saude_people_links_contact
  ON saude_people_links(profile_id, contact_id, revoked_at);

CREATE TABLE saude_professionals (
  profile_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  profession TEXT NOT NULL CHECK (profession IN ('medical', 'veterinary')),
  registration_enc TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  disabled_at INTEGER,
  PRIMARY KEY (profile_id, user_id)
);

CREATE TABLE saude_record_access (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (
    capability IN ('read', 'draft', 'sign', 'disclose')
  ),
  granted_by TEXT NOT NULL,
  purpose_enc TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  valid_until INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, subject_id)
    REFERENCES saude_subjects(profile_id, id)
);

CREATE INDEX saude_record_access_lookup
  ON saude_record_access(profile_id, subject_id, user_id, capability, revoked_at);

CREATE TABLE saude_episodes (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  professional_user_id TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, order_id),
  FOREIGN KEY (profile_id, subject_id)
    REFERENCES saude_subjects(profile_id, id),
  FOREIGN KEY (profile_id, professional_user_id)
    REFERENCES saude_professionals(profile_id, user_id)
);

CREATE INDEX saude_episodes_subject
  ON saude_episodes(profile_id, subject_id, opened_at);

CREATE TABLE saude_evolutions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  previous_id TEXT,
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN ('draft', 'evolution', 'addendum')
  ),
  payload_enc TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sealed_by TEXT,
  sealed_at INTEGER,
  content_sha256 TEXT,
  signature_enc TEXT,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, episode_id)
    REFERENCES saude_episodes(profile_id, id),
  FOREIGN KEY (profile_id, previous_id)
    REFERENCES saude_evolutions(profile_id, id),
  FOREIGN KEY (profile_id, sealed_by)
    REFERENCES saude_professionals(profile_id, user_id),
  CHECK (
    (entry_kind = 'draft' AND sealed_at IS NULL AND sealed_by IS NULL)
    OR
    (entry_kind IN ('evolution', 'addendum')
      AND sealed_at IS NOT NULL AND sealed_by IS NOT NULL
      AND content_sha256 IS NOT NULL AND signature_enc IS NOT NULL)
  )
);

CREATE INDEX saude_evolutions_episode
  ON saude_evolutions(profile_id, episode_id, created_at);

CREATE TABLE saude_prescriptions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  previous_id TEXT,
  author_user_id TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  signature_enc TEXT,
  legal_status TEXT NOT NULL DEFAULT 'not_issued'
    CHECK (legal_status = 'not_issued'),
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, episode_id)
    REFERENCES saude_episodes(profile_id, id),
  FOREIGN KEY (profile_id, previous_id)
    REFERENCES saude_prescriptions(profile_id, id),
  FOREIGN KEY (profile_id, author_user_id)
    REFERENCES saude_professionals(profile_id, user_id)
);

CREATE INDEX saude_prescriptions_episode
  ON saude_prescriptions(profile_id, episode_id, created_at);

CREATE TABLE saude_exams (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  previous_id TEXT,
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN ('request', 'received_result', 'correction')
  ),
  payload_enc TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, episode_id)
    REFERENCES saude_episodes(profile_id, id),
  FOREIGN KEY (profile_id, previous_id)
    REFERENCES saude_exams(profile_id, id)
);

CREATE INDEX saude_exams_episode
  ON saude_exams(profile_id, episode_id, created_at);

CREATE TABLE saude_attachments (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  evolution_id TEXT,
  prescription_id TEXT,
  exam_id TEXT,
  object_key TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, object_key),
  FOREIGN KEY (profile_id, episode_id)
    REFERENCES saude_episodes(profile_id, id),
  FOREIGN KEY (profile_id, evolution_id)
    REFERENCES saude_evolutions(profile_id, id),
  FOREIGN KEY (profile_id, prescription_id)
    REFERENCES saude_prescriptions(profile_id, id),
  FOREIGN KEY (profile_id, exam_id)
    REFERENCES saude_exams(profile_id, id),
  CHECK (
    (evolution_id IS NOT NULL) +
    (prescription_id IS NOT NULL) +
    (exam_id IS NOT NULL) <= 1
  )
);

CREATE INDEX saude_attachments_episode
  ON saude_attachments(profile_id, episode_id, created_at);

CREATE TABLE saude_access_audit (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_ref TEXT,
  resource_type TEXT NOT NULL,
  resource_ref TEXT,
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  purpose_code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX saude_access_audit_subject
  ON saude_access_audit(profile_id, subject_ref, occurred_at);

CREATE INDEX saude_access_audit_actor
  ON saude_access_audit(profile_id, actor_ref, occurred_at);

CREATE TABLE saude_disclosure_requests (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  recipient_link_id TEXT NOT NULL,
  scope_enc TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  expires_at INTEGER,
  delivered_at INTEGER,
  revoked_at INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('requested', 'approved', 'delivered', 'denied', 'revoked', 'expired')
  ),
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, subject_id)
    REFERENCES saude_subjects(profile_id, id),
  FOREIGN KEY (profile_id, recipient_link_id)
    REFERENCES saude_people_links(profile_id, id)
);

CREATE TABLE saude_retention_actions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  not_before INTEGER,
  finished_at INTEGER,
  reason_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('requested', 'approved', 'executing', 'completed', 'denied')
  ),
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, subject_id)
    REFERENCES saude_subjects(profile_id, id)
);

CREATE INDEX saude_retention_actions_subject
  ON saude_retention_actions(profile_id, subject_id, status);

CREATE TRIGGER saude_evolutions_no_update
BEFORE UPDATE ON saude_evolutions
BEGIN
  SELECT RAISE(ABORT, 'immutable_clinical_record');
END;

CREATE TRIGGER saude_prescriptions_no_update
BEFORE UPDATE ON saude_prescriptions
BEGIN
  SELECT RAISE(ABORT, 'immutable_clinical_record');
END;

CREATE TRIGGER saude_exams_no_update
BEFORE UPDATE ON saude_exams
BEGIN
  SELECT RAISE(ABORT, 'immutable_clinical_record');
END;

CREATE TRIGGER saude_attachments_no_update
BEFORE UPDATE ON saude_attachments
BEGIN
  SELECT RAISE(ABORT, 'immutable_clinical_record');
END;

CREATE TRIGGER saude_access_audit_no_update
BEFORE UPDATE ON saude_access_audit
BEGIN
  SELECT RAISE(ABORT, 'immutable_audit_record');
END;
```

O DDL impede alteração dos documentos existentes. Não é, sozinho, a política completa de segurança. As rotas comuns não terão `DELETE` clínico. O descarte será uma operação administrativa restrita, com verificações de retenção, bloqueio legal e autorização. As exclusões deverão usar condições SQL que repitam essas verificações no momento da execução.

Também são obrigatórias as seguintes validações:

| Validação | Regra |
|---|---|
| Isolamento | Todo acesso filtra `profile_id`. Nunca confiar no perfil informado dentro do corpo da requisição. |
| Relações clínicas | Documento anterior, exame, prescrição e anexo devem pertencer ao mesmo episódio ou a relação longitudinal explicitamente permitida. |
| Representação | O destinatário da cópia deve estar ligado ao mesmo sujeito da solicitação. |
| Registro profissional | Médico só fecha documentos de paciente humano. Veterinário só fecha documentos de animal. |
| Concorrência | Fechamento recebe a versão esperada do rascunho. Conflito exige nova leitura. |
| Idempotência | Repetir comando com a mesma chave não cria duas evoluções, cobranças ou entregas. |
| Dados administrativos | Ligações com OS e Agenda não carregam o conteúdo do prontuário. |
| Autoria | Usuário autor não vem livremente do cliente. É obtido da sessão autenticada. |

### 9.4. Rotas propostas

Prefixo de todas as rotas: `/api/v1/profiles/{profile}/saude`.

| Método | Rota | Finalidade | Acesso |
|---|---|---|---|
| `POST` | `/subjects` | Criar paciente ou animal | Cadastro autorizado |
| `GET` | `/subjects/{id}` | Ler cadastro protegido | Permissão específica e vínculo |
| `PATCH` | `/subjects/{id}` | Corrigir cadastro, com auditoria | Cadastro autorizado |
| `POST` | `/subjects/{id}/people-links` | Registrar representante ou tutor | Custódia |
| `POST` | `/people-links/{id}/verify` | Conferir identidade e representação | Custódia |
| `POST` | `/people-links/{id}/revoke` | Revogar vínculo | Custódia |
| `POST` | `/subjects/{id}/access` | Conceder acesso ao prontuário | Responsável autorizado |
| `POST` | `/access/{id}/revoke` | Revogar autorização | Responsável autorizado |
| `POST` | `/episodes` | Vincular atendimento ao prontuário | Equipe autorizada |
| `GET` | `/subjects/{id}/timeline` | Ler histórico clínico paginado | Profissional com acesso |
| `POST` | `/episodes/{id}/evolutions` | Criar nova versão de rascunho | Profissional ou auxiliar autorizado |
| `POST` | `/evolutions/{id}/seal` | Fechar versão e registrar assinatura | Profissional habilitado |
| `POST` | `/evolutions/{id}/addenda` | Acrescentar correção identificada | Profissional habilitado |
| `POST` | `/episodes/{id}/prescriptions` | Registrar prescrição interna | Profissional habilitado |
| `GET` | `/prescriptions/{id}` | Ler prescrição interna | Profissional com acesso |
| `POST` | `/episodes/{id}/exams` | Registrar pedido ou resultado recebido | Equipe clínica autorizada |
| `GET` | `/exams/{id}` | Ler documento de exame | Profissional com acesso |
| `POST` | `/episodes/{id}/attachments` | Enviar arquivo clínico privado | Equipe clínica autorizada |
| `GET` | `/attachments/{id}/content` | Ler arquivo por fluxo autenticado | Autorização clínica ou entrega específica |
| `POST` | `/disclosure-requests` | Solicitar cópia protegida | Custódia ou titular autenticado |
| `POST` | `/disclosure-requests/{id}/approve` | Aprovar escopo e destinatário | Profissional e custódia, conforme política |
| `GET` | `/disclosure-requests/{id}/content` | Entregar somente a cópia aprovada | Destinatário novamente autenticado |
| `GET` | `/audit` | Consultar trilha de acesso | Auditor |
| `POST` | `/retention-actions` | Solicitar avaliação de descarte | Custódia |
| `POST` | `/retention-actions/{id}/approve` | Aprovar após verificar impedimentos | Responsável pela guarda |
| `POST` | `/retention-actions/{id}/execute` | Executar descarte autorizado | Operação restrita de manutenção |

Não criar busca geral de prontuário por telefone para bots, aplicativos de terceiros ou links públicos.

### 9.5. Leitura, assinatura e imutabilidade

| Tema | Regra |
|---|---|
| Leitura | Exigir sessão humana, papel explícito, vínculo com o prontuário e finalidade. |
| Recepção | Não recebe permissão clínica por acessar a OS ou a Agenda. |
| Administrador | Não contorna a guarda clínica das rotas. |
| Bot e integração | Negar todas as rotas clínicas, inclusive leitura e downloads. |
| Auditoria | Registrar cada recurso lido, inclusive visualização, busca com dados identificáveis, prévia, download e cópia. |
| Falha de auditoria | Não devolver o conteúdo clínico. |
| Cache | Não colocar conteúdo clínico em cache público, prévia de link ou armazenamento persistente comum do aplicativo. |
| Rascunho | Cada salvamento cria uma versão. Não substituir o registro anterior. |
| Fechamento | Reautenticar o profissional. Fixar conteúdo, autoria, registro profissional, horário, digest e evidência de assinatura. |
| Correção | Criar adendo com referência ao registro anterior, motivo e autoria. Mostrar ambos. |
| Anexo | Chave R2 opaca e exclusiva. Nunca substituir os bytes de um objeto já vinculado. |
| Resultado externo | Registrar origem e recebimento. Não tratar arquivo recebido como resultado revisado pelo médico. |
| Logs | Não gravar conteúdo clínico, nomes de arquivos ou parâmetros clínicos em logs comuns. |

Login, digest e trilha de auditoria fornecem autoria operacional e detecção de alteração. Não devem ser anunciados como assinatura com validade legal suficiente sem validação das exigências aplicáveis.

As exigências de assinatura, sistema de prontuário eletrônico, eventual certificação e guarda de documentos segundo o CFM estão **a conferir**. Essa validação é condição de liberação do uso clínico.

### 9.6. Guarda, exclusão e entrega ao titular

| Situação | Tratamento |
|---|---|
| Pedido de exclusão | Registrar pedido. Verificar obrigação de guarda e demais fundamentos aplicáveis. Não apagar automaticamente. |
| Prazo desconhecido | Bloquear descarte. Resolver a política antes de liberar o prontuário em produção. |
| Atendimento de menor | Verificar identidade, representação, finalidade e direitos envolvidos. Não liberar tudo ao contato que conhece o telefone do paciente. |
| Revogação de representante | Revogar acessos e entregas futuras imediatamente. Preservar histórico legítimo. |
| Correção de cadastro | Guardar autoria e alteração. Não reescrever evolução assinada. |
| Bloqueio legal | Impedir descarte mesmo depois do prazo configurado. |
| Encerramento da clínica | Definir custódia e acesso continuado antes de desativar a instalação. |
| Cópia do prontuário | Gerar pacote específico, revisado e autenticado. Registrar escopo e destinatário. |
| Exportação comum | Excluir conteúdo clínico de CSV, relatórios, exportação de conversa e exportação de modelo. |
| Backup técnico | Pode conter dados clínicos cifrados. Exigir acesso restrito, prazo definido e política de restauração. |
| Descarte | Remover conteúdo elegível do D1 e objetos do R2. Registrar conclusão e tratar cópias técnicas conforme sua política. |
| Restauração | Reaplicar o registro de descartes para não reintroduzir dados já eliminados. |

A imutabilidade vale durante a guarda. Ela não justifica retenção eterna. O descarte autorizado é uma operação separada de edição ou exclusão cotidiana.

A LGPD, as normas do CFM sobre prontuário e o Código de Ética Médica precisam ser considerados. Bases legais, prazos, direitos de acesso, representação e requisitos técnicos: **a conferir**.

### 9.7. O que nunca sai pelo fluxo comum

| Conteúdo | WhatsApp | IA | Exportação comum |
|---|---|---|---|
| Evolução e diagnóstico | Nunca | Nunca | Nunca |
| Prescrição e medicamentos | Nunca | Nunca | Nunca |
| Resultado e imagem de exame | Nunca | Nunca | Nunca |
| Anamnese e formulário clínico | Nunca | Nunca | Nunca |
| Assinatura e credencial profissional | Nunca | Nunca | Nunca |
| Identidade e documento de representação | Nunca | Nunca | Nunca |
| Justificativa de acesso excepcional | Nunca | Nunca | Nunca |

A cópia protegida ao titular ou representante legitimado é uma operação própria. Não se confunde com exportação comum nem com encaminhamento por WhatsApp.

### 9.8. Receita com validade legal: fora do escopo

Para evoluir até a emissão legal, seria necessário validar pelo menos:

| Requisito a validar | Decisão necessária |
|---|---|
| Profissional | Identidade, habilitação, registro e situação profissional. |
| Documento | Identificação exigida do paciente e do prescritor, medicamento, forma de uso, data e demais elementos aplicáveis. |
| Assinatura | Modalidade de assinatura eletrônica admitida para cada documento e categoria de medicamento. |
| Verificação | Meio de conferir autenticidade, integridade e situação do documento. |
| Controle especial | Regras sanitárias, formulários, numeração e canais exigidos para categorias sujeitas a controle. |
| Entrega | Identificação do destinatário, integridade do arquivo e registro da entrega. |
| Retificação | Cancelamento, substituição e preservação da versão anterior. |

Normas do CFM, legislação de assinatura eletrônica e regras sanitárias da Anvisa: **a conferir**.

Neste escopo, o sistema guarda prescrição interna com identificação clara: **“Registro interno. Não constitui receita emitida para dispensação.”** Não emitir PDF com aparência de receita válida, QR de autenticação ou promessa de validade legal.

### 9.9. Integração e compatibilidade

| Ponto | Exigência |
|---|---|
| `status` | Manter os nove códigos de base. Adicionar `stage` e identificação do tipo. |
| `counts` | Usar apenas os códigos de base. Hoje o agrupamento retorna os estados encontrados; não preenche necessariamente nove chaves (`src/modules/os/store.ts:257`). |
| Numeração | Preservar `number` legado. A numeração por tipo deve ser adicional. Existe unicidade por área e número (`migrations/0035_os_orders.sql:57`). |
| Aplicativos antigos | Preservar o tipo embutido. Não permitir que ações antigas concluam ou aprovem etapas clínicas. |
| Ações por etapa | Usar endpoint próprio com etapa e versão esperadas. Não deduzir a etapa apenas de `status`. |
| Efeitos legados | Não calcular garantia, retirada ou mensagens apenas porque a base é `ready` ou `delivered`. Hoje esses efeitos estão ligados ao estado (`src/modules/os/store.ts:535`). |
| Extensão → OS | Criar contrato público administrativo. Não importar o armazenamento interno da OS. |
| Consultas D1 | Paginar episódios, documentos e auditoria. Não carregar todos os filhos na listagem de ordens. Orçamento de consultas por rota: **a conferir**. |

O iOS possui textos de ação como “Marcar como pronta” e “Registrar entrega” (`mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:191`). O Android também monta ações a partir de `nextStatuses` (`mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:189`). Compatibilidade de leitura não significa que esses aplicativos possam operar corretamente um prontuário.

### 9.10. Fora do escopo

| Item | Destino |
|---|---|
| Receita eletrônica com validade legal | Projeto posterior, após validação específica |
| Teleconsulta | Fora deste modelo |
| Diagnóstico ou decisão clínica por IA | Proibido neste desenho |
| Integração com laboratórios | Fase posterior |
| Faturamento de convênio e troca padronizada de guias | Fase própria; padrões aplicáveis a conferir |
| Estoque e administração de medicamentos | Projeto próprio |
| Triagem clínica automatizada | Fora do escopo |
| Certificação de conformidade | Depende de avaliação específica; não presumida pelo DDL |

## 10. Dúvidas e decisões

| Decisão | Proposta |
|---|---|
| Prontuário entra no produto? | Sim, somente com extensão e liberação técnica e normativa própria. |
| Atender menores no primeiro lançamento? | Apenas depois de implementar representação, segregação e revisão normativa. |
| IA generativa na área? | Desligada por padrão. |
| Convênio no primeiro lançamento? | Conferência administrativa manual. Sem promessa automática de cobertura. |
| Cobrança de procedimento | Definir fluxo protegido de proposta antes de ativar esse caso. |
| Cópia ao paciente | Entrega autenticada e restrita, sem documento no WhatsApp. |
| Assinatura de evolução | Definir mecanismo admissível antes de liberar uso clínico. |
| Guarda | Definir política validada. Não usar prazo presumido. |
| Aplicativos antigos | Uso administrativo limitado. Operação clínica exige interface compatível. |
| Retorno | Política administrativa da clínica, sem automatizar indicação médica. |

### Modelo neutro — clínica médica

```json
{
  "id": "clinica_medica",
  "name": "Clínica médica e consultório",
  "labels": {
    "customer": "Paciente",
    "customers": "Pacientes",
    "work": "Atendimento",
    "works": "Atendimentos",
    "assignee": "Responsável administrativo",
    "quote": "Proposta de valores"
  },
  "modules": {
    "on": ["os", "agenda", "forms", "payments"],
    "off": ["mensalidade", "reserva", "erp"]
  },
  "extension": {
    "id": "saude",
    "required_for_clinical_use": true,
    "subject_kind": "human"
  },
  "security": {
    "generative_ai_enabled": false,
    "clinical_data_in_generic_work": false,
    "clinical_data_in_whatsapp": false,
    "clinical_data_in_common_exports": false,
    "phone_is_clinical_authorization": false
  },
  "work_types": [
    {
      "id": "clinica_medica_atendimento",
      "singular": "Atendimento",
      "plural": "Atendimentos",
      "item_label": "Identificação do atendimento",
      "problem_label": "Solicitação administrativa",
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
      "terms_text": "Solicito atendimento administrativo por este canal. Os horários dependem de confirmação. Não enviarei sintomas, exames, receitas ou documentos de saúde pelo WhatsApp. Informações e autorizações clínicas serão tratadas com a equipe pelo canal protegido indicado pela clínica. Este aceite não autoriza procedimento e não substitui consentimento específico.",
      "fields": [
        {"key":"modalidade","label":"Modalidade","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["consulta","retorno","procedimento"]},
        {"key":"pagamento_tipo","label":"Forma de atendimento","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["particular","convenio"]},
        {"key":"convenio_nome","label":"Convênio informado","type":"texto","required":false,"customer_visible":false,"sensitive":true,"options":[]},
        {"key":"autorizacao_convenio","label":"Situação da autorização","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["nao_se_aplica","pendente","confirmada","negada"]},
        {"key":"contato_administrativo","label":"Contato administrativo","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["paciente","responsavel_verificado"]}
      ],
      "field_rules": [
        {"field":"modalidade","required_before":["agendado"]},
        {"field":"pagamento_tipo","required_before_action":"charge"},
        {"field":"convenio_nome","required_when":{"pagamento_tipo":"convenio"}},
        {"field":"autorizacao_convenio","required_before_action":"confirm_coverage"}
      ],
      "stages": [
        {"id":"solicitado","label":"Solicitação recebida","base":"received","next":["agendado","cancelado"],"message":"Recebemos a solicitação nº {numero}. A recepção dará continuidade por este canal. Não envie informações de saúde aqui.","stale_days":1},
        {"id":"agendado","label":"Horário reservado","base":"analyzing","next":["confirmado","cancelado","ausente"],"message":"","stale_days":0},
        {"id":"confirmado","label":"Presença confirmada","base":"approved","next":["agendado","em_atendimento","cancelado","ausente"],"message":"","stale_days":0},
        {"id":"em_atendimento","label":"Atendimento iniciado","base":"in_progress","next":["concluido"],"message":"","stale_days":0},
        {"id":"concluido","label":"Atendimento concluído","base":"delivered","next":[],"message":"","stale_days":0},
        {"id":"cancelado","label":"Cancelado","base":"cancelled","next":[],"message":"A solicitação nº {numero} foi cancelada. Para um novo horário, acesse Agendar no menu.","stale_days":0},
        {"id":"ausente","label":"Não compareceu","base":"cancelled","next":[],"message":"","stale_days":0}
      ],
      "people_roles": [
        {"id":"paciente","label":"Paciente"},
        {"id":"responsavel_legal","label":"Responsável legal verificado"},
        {"id":"contato_autorizado","label":"Contato autorizado"},
        {"id":"medico","label":"Médico responsável"}
      ],
      "entry_kinds": [
        {"id":"contato_administrativo","label":"Contato administrativo"},
        {"id":"conferencia_cadastro","label":"Conferência de cadastro"},
        {"id":"ocorrencia_agenda","label":"Ocorrência de agenda"}
      ],
      "file_kinds": [
        {"id":"recibo_administrativo","label":"Recibo administrativo","customer_can_receive":true},
        {"id":"acesso_unidade","label":"Orientações de acesso à unidade","customer_can_receive":true}
      ],
      "default_tasks": [
        {"stage":"solicitado","title":"Conferir identidade e contato administrativo autorizado","due_days":0,"assignee_role":"recepcao"},
        {"stage":"agendado","title":"Conferir cobertura informada ou valor particular","due_days":0,"assignee_role":"recepcao"},
        {"stage":"confirmado","title":"Conferir pendências administrativas do horário","due_days":0,"assignee_role":"recepcao"},
        {"stage":"em_atendimento","title":"Conferir vínculo com o profissional responsável","due_days":0,"assignee_role":"saude:clinician"},
        {"stage":"concluido","title":"Encerrar pendências administrativas do episódio","due_days":0,"assignee_role":"recepcao"},
        {"stage":"cancelado","title":"Conferir cobrança pendente e necessidade de estorno","due_days":0,"assignee_role":"financeiro"},
        {"stage":"ausente","title":"Registrar ocorrência administrativa da agenda","due_days":0,"assignee_role":"recepcao"}
      ]
    }
  ],
  "module_config": {
    "agenda": {
      "min_notice_minutes":120,
      "max_days_ahead":30,
      "slot_step_minutes":10,
      "reminder_hours":24,
      "customer_change_hours":2,
      "close_on_holidays":true,
      "booked_text":"Horário reservado para {data} às {hora}. Para confirmar, remarcar ou cancelar, use Meus horários no menu.",
      "reminder_text":"Você tem um horário reservado para {data} às {hora}. Confirma sua presença?",
      "cancelled_text":"O horário de {data} às {hora} foi cancelado. Para solicitar outro, use Agendar no menu.",
      "services":[
        {"id":"clinica_medica_consulta","name":"Consulta","duration_minutes":30,"self_booking":true},
        {"id":"clinica_medica_retorno","name":"Retorno","duration_minutes":20,"self_booking":"after_release"},
        {"id":"clinica_medica_procedimento","name":"Procedimento","duration_minutes":60,"self_booking":false}
      ]
    },
    "mensalidade":{"plans":[]},
    "forms":{
      "forms":[
        {
          "id":"clinica_medica_preferencias_contato",
          "title":"Preferências de contato",
          "intro":"Este formulário trata apenas do contato administrativo. Não inclua informações sobre saúde. Para atualizar documentos ou dados do paciente, fale com a recepção.",
          "questions":[
            {"key":"avisos_whatsapp","label":"Você prefere receber avisos administrativos por este WhatsApp?","type":"sim_nao","required":true},
            {"key":"periodo","label":"Em qual período podemos entrar em contato?","type":"lista","required":true,"options":["manhã","tarde","indiferente"]},
            {"key":"assunto","label":"Deseja falar com a recepção sobre cadastro ou cobrança?","type":"lista","required":true,"options":["cadastro","cobrança","nenhum"]}
          ]
        }
      ]
    },
    "payments":{"automatic_charge":false,"description":"Serviço administrativo nº {numero}"}
  },
  "menus": [
    {"id":"clinica_medica_agendar","label":"Agendar","type":"agenda","parent_id":null,"content":""},
    {"id":"clinica_medica_horarios","label":"Meus horários","type":"agenda_mine","parent_id":null,"content":""},
    {"id":"clinica_medica_solicitar","label":"Solicitar atendimento","type":"os_open","parent_id":null,"content":"","reference":{"work_type_id":"clinica_medica_atendimento"}},
    {"id":"clinica_medica_acompanhar","label":"Minhas solicitações","type":"os_track","parent_id":null,"content":"","reference":{"work_type_id":"clinica_medica_atendimento"}},
    {"id":"clinica_medica_preparo","label":"Preparo e documentos","type":"content","parent_id":null,"content":"Para receber preparo, solicitar documento ou tratar de exames e receitas, fale com a recepção. A equipe indicará o canal protegido. Não envie documentos de saúde por este WhatsApp."},
    {"id":"clinica_medica_preferencias","label":"Preferências de contato","type":"form","parent_id":null,"content":"","reference":{"form_id":"clinica_medica_preferencias_contato"}},
    {"id":"clinica_medica_recepcao","label":"Falar com a recepção","type":"queue","parent_id":null,"content":"","reference":{"department":"Recepção"}},
    {"id":"clinica_medica_urgencia","label":"Sobre urgências","type":"content","parent_id":null,"content":"Este canal não realiza atendimento de urgência e não é acompanhado continuamente. Em uma urgência, procure um serviço de emergência."}
  ],
  "departments":["Recepção","Equipe clínica","Financeiro","Privacidade e documentos"],
  "ticket_categories":["Agendamento","Cadastro e representação","Convênio","Cobrança","Solicitação de documento","Privacidade"],
  "bot_instructions":"Você é o assistente administrativo da clínica. Ajude com endereço, horários de funcionamento, agendamento e contato com a recepção usando somente informações administrativas autorizadas. Não peça sintomas, diagnóstico, medicamentos, exames, receitas, documentos de saúde ou informações sobre gravidez. Não forneça orientação clínica, não interprete resultados e não avalie urgência. Não confirme cobertura de convênio sem validação da recepção. Não leia prontuários, anexos clínicos, dados de menores ou mensagens clínicas recebidas. Não use dados de um familiar para responder sobre outro paciente. Pedidos sobre preparo, retorno clínico, receitas e resultados devem ser encaminhados à equipe pelo fluxo protegido. Não prometa prazo de resposta clínica. Para urgências, use apenas: “Este canal não realiza atendimento de urgência. Em uma urgência, procure um serviço de emergência.”",
  "manual_steps":[
    "Informar identidade, endereço e responsável técnico da clínica.",
    "Validar aviso de privacidade, bases legais, representação e política de guarda.",
    "Cadastrar médicos, registros profissionais, serviços, horários e bloqueios.",
    "Conferir valores, convênios e regra administrativa de retorno.",
    "Conceder papéis mínimos e validar representantes.",
    "Configurar cobrança e destinatários dos recibos.",
    "Cadastrar preparos revisados no ambiente protegido.",
    "Validar assinatura, cópia protegida, recuperação e resposta a incidentes.",
    "Validar o bloqueio de IA em todos os canais.",
    "Liberar uso clínico apenas após validação técnica e normativa."
  ]
}
```

# Clínicas veterinárias

## 1. Quem usa e como é o dia a dia

A recepção organiza horários, identifica o tutor e seleciona o animal correto.  
O veterinário registra o cuidado e define retornos, reforços e alta.  
Um tutor pode ter vários animais. Um animal pode ter mais de um tutor autorizado.  
O tutor pergunta sobre consulta, vacina, retorno, internação, valores e banho e tosa.  
A equipe de banho e tosa precisa de instruções operacionais, sem acesso ao prontuário.  
A internação exige continuidade de registros e passagem de plantão.  
O WhatsApp organiza o contato. Não substitui comunicação clínica nem vigilância da internação.

## 2. Tipos de trabalho

Os tipos compartilham o cadastro longitudinal do animal. Cada trabalho possui uma ordem própria.

O nome do animal é um rótulo. O identificador estável da extensão é a identidade do registro. Dois animais chamados “Mel” nunca podem ser associados apenas pelo nome ou telefone do tutor.

### Atendimento / Atendimentos

| Propriedade | Definição |
|---|---|
| Identificador | `clinica_veterinaria_atendimento` |
| Campo fixo `item` | Animal |
| Exemplo de `item` | `Mel · A0038` |
| Campo fixo `problem` | Solicitação administrativa |
| Exemplo de `problem` | `Solicitação de consulta` |
| Sujeito central | Animal |
| Cliente do WhatsApp | Tutor verificado |
| Modalidades | Consulta, retorno, procedimento e atendimento preventivo |

#### Campos extras

| Chave | Rótulo | Tipo e opções | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `modalidade` | Modalidade | `lista`: consulta, retorno, procedimento, preventivo | Sim | Não | Sim |
| `origem` | Origem do atendimento | `lista`: agendado, encaixe, encaminhamento | Sim | Não | Não |
| `pagador` | Pagador | `lista`: tutor_principal, outro_autorizado | Sim, antes da cobrança | Não | Sim |

Espécie, raça, sexo, nascimento aproximado, microchip e identificação dos tutores ficam no cadastro do animal. Peso clínico, alergias, condição reprodutiva, diagnóstico e medicamentos ficam no prontuário. Não duplicar esses dados nos campos comuns.

#### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `solicitado` | Solicitação recebida | `received` | `agendado`, `cancelado` | Recebemos a solicitação nº {numero}. A recepção vai conferir o animal e o horário com você. | 1 |
| `agendado` | Horário reservado | `analyzing` | `aguardando_autorizacao`, `em_atendimento`, `cancelado` | Vazio | 0 |
| `aguardando_autorizacao` | Proposta enviada | `quoted` | `autorizado`, `recusado`, `agendado`, `cancelado` | A proposta administrativa nº {numero} está disponível para sua decisão. A aprovação de valores não substitui autorização clínica específica. | 1 |
| `autorizado` | Valores aprovados | `approved` | `em_atendimento`, `cancelado` | A aprovação de valores da solicitação nº {numero} foi registrada. A equipe dará continuidade ao atendimento. | 1 |
| `recusado` | Proposta recusada | `declined` | `agendado`, `cancelado` | A recusa da proposta nº {numero} foi registrada. A recepção pode esclarecer as próximas providências. | 1 |
| `em_atendimento` | Atendimento iniciado | `in_progress` | `concluido` | Vazio | 0 |
| `concluido` | Atendimento concluído | `delivered` | Nenhuma | Vazio | 0 |
| `cancelado` | Cancelado | `cancelled` | Nenhuma | A solicitação nº {numero} foi cancelada. Para um novo horário, fale com a recepção. | 0 |

A passagem direta de `agendado` para `em_atendimento` é permitida para atendimento sem proposta pendente. A situação financeira não define prioridade clínica. O profissional decide o cuidado e registra as autorizações necessárias no prontuário.

#### Recursos ligados

| Recurso | Uso |
|---|---|
| Orçamento | Ligado para valores administrativos. Exige decisão do tutor autorizado e versão da proposta. |
| Garantia | Desligada. |
| Retirada | Desligada. |
| Termos | Ligados, com o termo veterinário abaixo. |
| Pessoas | Tutor principal, tutor adicional autorizado, pagador e veterinário responsável. |
| Documentos comuns | Proposta administrativa e recibo. Ambos podem ser recebidos pelo destinatário verificado. |
| Lançamentos | Contato administrativo, autorização de valores e ocorrência de agenda. |
| Prontuário | Evolução, exame, prescrição, vacina e vermífugo ficam exclusivamente na extensão. |

**Termo veterinário administrativo:**

> Solicito o atendimento administrativo do animal identificado neste registro e declaro que a recepção deve conferir minha autorização como tutor ou representante. Valores serão informados antes da cobrança. Aprovar valores não substitui autorização clínica específica. Exames, receitas, orientações e informações clínicas serão tratados com a equipe pelo canal protegido indicado pela clínica.

#### Tarefas padrão

| Etapa | Tarefa | Responsável | Vencimento |
|---|---|---|---|
| `solicitado` | Conferir animal e tutor autorizado | Recepção | Mesmo dia |
| `agendado` | Conferir horário e profissional | Recepção | Mesmo dia |
| `aguardando_autorizacao` | Conferir destinatário e validade da proposta | Recepção | Mesmo dia |
| `autorizado` | Conferir autorização administrativa registrada | Recepção | Mesmo dia |
| `recusado` | Encaminhar decisão ao responsável pelo atendimento | Recepção | Mesmo dia |
| `em_atendimento` | Conferir vínculo com o veterinário responsável | Equipe clínica | Mesmo dia |
| `concluido` | Encerrar pendências administrativas | Recepção | Mesmo dia |
| `cancelado` | Conferir cobrança e eventual estorno | Financeiro | Mesmo dia |

### Internação / Internações

Criar somente em clínicas que ofereçam internação e possuam equipe, estrutura e rotina compatíveis. O tipo fica oculto no autoatendimento.

| Propriedade | Definição |
|---|---|
| Identificador | `clinica_veterinaria_internacao` |
| Campo fixo `item` | Animal |
| Campo fixo `problem` | Referência administrativa da admissão |
| Exemplo de `problem` | `Admissão vinculada ao atendimento nº 42` |
| Abertura | Somente equipe |
| Decisão de internação e alta | Veterinário habilitado |
| Registro clínico | Episódio próprio no mesmo prontuário do animal |

#### Campos extras

| Chave | Rótulo | Tipo e opções | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `acomodacao_codigo` | Código da acomodação | `texto` | Antes da acomodação | Não | Não |
| `contato_prioritario` | Contato prioritário | `lista`: tutor_principal, tutor_adicional | Sim | Não | Sim |
| `janela_contato` | Período administrativo de contato | `lista`: manha, tarde, noite, combinado | Sim | Sim | Não |

Não incluir prognóstico, classificação de risco, medicação, sinais vitais ou “estado geral” nos campos comuns.

#### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `admissao` | Admissão em organização | `received` | `aguardando_autorizacao`, `internado`, `cancelado` | A recepção está organizando o registro nº {numero}. Confirme com a equipe qual contato está autorizado. | 0 |
| `aguardando_autorizacao` | Proposta enviada | `quoted` | `autorizado`, `recusado`, `admissao`, `cancelado` | A proposta administrativa nº {numero} está disponível. Fale com a equipe para esclarecer valores e autorizações. | 1 |
| `autorizado` | Valores aprovados | `approved` | `internado`, `cancelado` | A aprovação de valores do registro nº {numero} foi registrada. | 0 |
| `recusado` | Proposta recusada | `declined` | `admissao`, `internado`, `cancelado` | A decisão sobre a proposta nº {numero} foi registrada. A equipe entrará em contato. | 0 |
| `internado` | Internação em andamento | `in_progress` | `alta_liberada`, `encerrado` | Vazio | 0 |
| `alta_liberada` | Saída autorizada pela equipe | `ready` | `internado`, `encerrado` | Há uma providência presencial pendente no registro nº {numero}. Fale com a recepção para combinar o atendimento. | 1 |
| `encerrado` | Internação encerrada | `delivered` | Nenhuma | Vazio | 0 |
| `cancelado` | Admissão cancelada | `cancelled` | Nenhuma | O registro administrativo nº {numero} foi cancelado. Fale com a recepção se precisar de esclarecimentos. | 0 |

Regras específicas:

| Situação | Regra |
|---|---|
| Entrada sem aprovação financeira | Somente decisão humana autorizada. A equipe clínica decide a assistência. |
| Alta | Exige registro protegido e confirmação do veterinário. Pagamento não dispara alta. |
| Transferência ou óbito | Encerrar por comando clínico específico. Guardar motivo no prontuário. Não enviar mensagem de retirada. |
| Retorno de `alta_liberada` | Veterinário revoga a liberação. Cancelar lembretes pendentes. |
| Conta durante internação | Lançar valores administrativos separados. Não publicar procedimentos clínicos no chat. |
| Aumento de orçamento | Exigir proposta complementar identificada. Não alterar silenciosamente proposta aprovada. O fluxo complementar depende de contrato próprio do motor. |
| Vigilância | `stale_days` não monitora o animal. Não usar aviso de ordem parada como alarme clínico. |

#### Recursos ligados

| Recurso | Uso |
|---|---|
| Orçamento | Ligado para proposta inicial. Alterações posteriores dependem de nova aprovação administrativa. |
| Garantia | Desligada. |
| Retirada | Ligada somente após liberação clínica. Lembrete administrativo após 1 dia. Não impede saída nem substitui contato humano. |
| Termos | Ligados, com texto abaixo. |
| Pessoas | Tutor principal, tutor adicional autorizado, pagador e veterinário responsável pelo plantão. |
| Documentos comuns | Proposta administrativa e recibo. |
| Lançamentos comuns | Contato com tutor, conferência de valores e passagem administrativa de plantão. |
| Registros clínicos | Evoluções de plantão, prescrições, exames, intercorrências e alta ficam no prontuário. |

**Termo administrativo da internação:**

> Solicito a organização administrativa da internação do animal identificado. A equipe conferirá quem pode receber informações e decidir sobre valores. A proposta pode exigir complementação identificada e nova aprovação. Este aceite não autoriza procedimentos clínicos de forma genérica. Internação, procedimentos e alta dependem da equipe veterinária e dos registros próprios.

#### Tarefas padrão

| Etapa | Tarefa | Responsável | Vencimento |
|---|---|---|---|
| `admissao` | Conferir identidade do animal e contatos autorizados | Recepção | Mesmo dia |
| `aguardando_autorizacao` | Conferir destinatário da proposta inicial | Recepção | Mesmo dia |
| `autorizado` | Registrar responsável pela comunicação administrativa | Recepção | Mesmo dia |
| `recusado` | Encaminhar decisão ao veterinário responsável | Recepção | Mesmo dia |
| `internado` | Conferir pendências administrativas do turno | Recepção | Mesmo dia |
| `alta_liberada` | Conferir pessoa autorizada para retirada | Recepção | Mesmo dia |
| `encerrado` | Encerrar conta administrativa e registrar entrega | Financeiro | Mesmo dia |
| `cancelado` | Conferir cobrança e eventual estorno | Financeiro | Mesmo dia |

A passagem clínica de plantão exige rotina própria na extensão. Não é resolvida pela tarefa genérica diária.

### Banho e tosa / Serviços de banho e tosa

É um tipo opcional. Não deve aparecer em clínicas que não prestem esse serviço.

| Propriedade | Definição |
|---|---|
| Identificador | `clinica_veterinaria_banho_tosa` |
| Campo fixo `item` | Animal |
| Campo fixo `problem` | Serviço solicitado |
| Exemplo de `problem` | `Banho e tosa estética` |
| Abertura | Tutor ou recepção |
| Restrição | Não realizar prescrição, sedação ou avaliação clínica nesse fluxo. |

#### Campos extras

| Chave | Rótulo | Tipo e opções | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `servico` | Serviço | `lista`: banho, banho_e_tosa, tosa_higienica | Sim | Sim | Não |
| `porte` | Porte para orçamento | `lista`: pequeno, medio, grande, gigante | Sim | Sim | Não |
| `preferencia_estetica` | Preferência estética | `texto_longo` | Não | Sim | Não |

O campo de preferência é exclusivamente estético. Questões de saúde ou segurança devem ser encaminhadas à equipe, sem converter a observação em prontuário comum.

#### Etapas

| ID | Rótulo | Estado de base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `recebido` | Solicitação recebida | `received` | `orcamento`, `cancelado` | Recebemos a solicitação nº {numero} para {item}. A equipe confirmará serviço, horário e valor. | 1 |
| `orcamento` | Aguardando aprovação | `quoted` | `aprovado`, `recusado`, `recebido`, `cancelado` | A proposta nº {numero} para {item} está disponível. Confira o serviço e o valor antes de aprovar. | 1 |
| `aprovado` | Aprovado | `approved` | `em_execucao`, `cancelado` | A proposta nº {numero} foi aprovada. O horário será confirmado pela equipe. | 0 |
| `recusado` | Recusado | `declined` | `recebido`, `pronto`, `cancelado` | A proposta nº {numero} foi recusada. Se o animal estiver na clínica, combine a retirada com a equipe. | 0 |
| `em_execucao` | Serviço em execução | `in_progress` | `pronto` | Vazio | 0 |
| `pronto` | Aguardando retirada | `ready` | `entregue` | {item}, do serviço nº {numero}, está disponível para retirada. Combine a chegada com a equipe. | 1 |
| `entregue` | Animal entregue | `delivered` | Nenhuma | Registramos a entrega de {item}, serviço nº {numero}. Obrigado pela confiança. | 0 |
| `cancelado` | Cancelado | `cancelled` | Nenhuma | A solicitação nº {numero} foi cancelada. | 0 |

A transição de `recusado` para `pronto` exige presença física do animal na clínica. Não significa serviço executado. O registro de entrega deve identificar a pessoa autorizada.

Problema durante a execução suspende o serviço e aciona a equipe humana. A descrição clínica vai para a extensão. A etapa pública não deve revelar a intercorrência.

#### Recursos ligados

| Recurso | Uso |
|---|---|
| Orçamento | Ligado. Aprovação antes do início. |
| Garantia | Desligada. Reclamação gera avaliação humana, sem promessa automática de resultado. |
| Retirada | Ligada. Lembrete após 1 dia, com contato humano no mesmo expediente se houver atraso. |
| Termos | Ligados, com texto abaixo. |
| Pessoas | Tutor, pessoa autorizada para retirada e profissional de banho e tosa. |
| Documentos | Proposta, recibo e foto estética autorizada do animal. Podem ser recebidos pelo tutor verificado. |
| Lançamentos | Conferência de entrada, execução administrativa e entrega. |
| Dados clínicos | Banho e tosa não pode ler o prontuário. Recebe apenas decisão operacional da equipe habilitada, quando necessária. |

**Termo de banho e tosa:**

> Autorizo somente o serviço estético descrito na proposta aprovada para o animal identificado. Mudanças de serviço ou valor exigem nova autorização. Este aceite não autoriza sedação, medicação ou procedimento clínico. A equipe pode interromper o serviço e entrar em contato se precisar de avaliação ou de nova decisão.

#### Tarefas padrão

| Etapa | Tarefa | Responsável | Vencimento |
|---|---|---|---|
| `recebido` | Conferir animal, serviço e pessoa autorizada para retirada | Recepção | Mesmo dia |
| `orcamento` | Conferir proposta e destinatário | Recepção | Mesmo dia |
| `aprovado` | Confirmar horário e profissional | Recepção | Mesmo dia |
| `recusado` | Conferir se há retirada pendente | Recepção | Mesmo dia |
| `em_execucao` | Conferir serviço aprovado antes de executar | Banho e tosa | Mesmo dia |
| `pronto` | Contatar tutor para retirada no expediente | Recepção | Mesmo dia |
| `entregue` | Registrar quem retirou o animal | Recepção | Mesmo dia |
| `cancelado` | Conferir cobrança e eventual estorno | Financeiro | Mesmo dia |

## 3. Vocabulário

| Conceito | Nome na área |
|---|---|
| Cliente | Tutor |
| Clientes | Tutores |
| Sujeito do prontuário | Animal |
| Trabalho clínico | Atendimento |
| Trabalho de permanência | Internação |
| Trabalho estético | Serviço de banho e tosa |
| Conjunto de trabalhos | Atendimentos e serviços |
| Responsável clínico | Veterinário responsável |
| Responsável administrativo | Responsável administrativo |
| Orçamento | Proposta de valores |
| Pessoa que retira | Pessoa autorizada para retirada |

No cabeçalho, mostrar “Animal” e “Tutor” em campos separados. Não chamar o animal de cliente nem usar o nome do tutor como identidade do prontuário.

## 4. Módulos

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| Agenda | Ligado | Agenda por veterinário ou profissional de banho e tosa. Antecedência mínima de 120 minutos. Horizonte de 30 dias. Grade de 10 minutos. Lembrete de 24 horas. |
| Mensalidade | Desligado inicialmente | Plano opcional somente para banho e tosa, se contratado pela clínica. |
| Formulários | Ligado | Cadastro administrativo inicial do animal e preferência de contato. Sem histórico clínico. |
| Cobrança | Ligado | Proposta aprovada e pagador verificado. Separar proposta inicial de complementação. |
| Reserva | Desligado | Não usar para controlar leitos ou alta de internação. |
| ERP | Desligado | Estoque, compras e financeiro dependem de configuração específica posterior. |
| OS | Ligado | Atendimento. Internação e Banho e tosa são opcionais na aplicação do modelo. |
| Saúde | Obrigatório para uso clínico | Prontuário por animal e vínculos verificados de tutores. |

### Serviços da Agenda

| Serviço | Duração inicial | Autoagendamento |
|---|---:|---|
| Consulta veterinária | 30 minutos | Sim |
| Retorno | 20 minutos | Após liberação |
| Atendimento preventivo | 20 minutos | Solicitação de horário; indicação confirmada pelo veterinário |
| Procedimento | 60 minutos | Não |
| Banho | 60 minutos | Após configurar capacidade e profissional |
| Banho e tosa | 90 minutos | Após configurar capacidade e profissional |
| Tosa higiênica | 30 minutos | Após configurar capacidade e profissional |

A grade por profissional não deve ser confundida com capacidade de salas, equipamentos ou acomodação. A existência de controle simultâneo desses recursos está **a conferir**. Até existir, bloquear conflitos por configuração conservadora ou conferência manual.

### Plano opcional de Mensalidade

| Plano | Configuração proposta |
|---|---|
| Banho mensal | Quatro banhos por ciclo mensal. Preço definido pela clínica. Sem renovação clínica, vacina, medicamento ou promessa de cobertura médica. |
| Uso do módulo | Cobrar a recorrência contratada. |
| Controle das sessões | Necessita regra de crédito e consumo ligada às ordens. Suporte atual a esse saldo: **a conferir**. |
| Ativação | Não criar contrato nem ligar Mensalidade automaticamente na aplicação básica. |

### Formulário administrativo do animal

| Pergunta pronta | Tipo | Obrigatória | Observação |
|---|---|---|---|
| Qual é o nome do animal? | `texto` | Sim | Não identifica sozinho o animal. |
| Qual é a espécie? | `lista`: cão, gato, outra | Sim | Outra exige conferência da clínica. |
| O animal já tem cadastro nesta clínica? | `sim_nao` | Sim | Recepção localiza sem revelar cadastros de terceiros. |
| Você é o tutor ou um contato autorizado? | `lista`: tutor, contato_autorizado | Sim | Resposta não substitui verificação. |
| Aceita receber lembretes administrativos por este WhatsApp? | `sim_nao` | Sim | Preferência revogável. |

Texto inicial:

> Informe apenas dados administrativos do animal. Não envie sintomas, medicamentos, vacinas anteriores, exames ou receitas neste formulário. A equipe conferirá o cadastro e sua autorização.

O formulário produz uma solicitação de cadastro. Não cria automaticamente um tutor autorizado nem funde animais pelo nome.

## 5. WhatsApp

### Árvore do menu

| ID | Rótulo | Tipo | Referência / ação |
|---|---|---|---|
| `clinica_veterinaria_agendar` | Agendar | `agenda` | Escolher animal autorizado e depois serviço e profissional. |
| `clinica_veterinaria_horarios` | Meus horários | `agenda_mine` | Horários vinculados ao tutor autorizado. |
| `clinica_veterinaria_solicitar` | Solicitar atendimento | `os_open` | `clinica_veterinaria_atendimento`. |
| `clinica_veterinaria_acompanhar` | Acompanhar solicitações | `os_track` | `clinica_veterinaria_atendimento`. |
| `clinica_veterinaria_internacao` | Contato sobre internação | `queue` | Equipe responsável. Não exibir boletim clínico. |
| `clinica_veterinaria_banho` | Banho e tosa | `os_open` | `clinica_veterinaria_banho_tosa`, quando ativado. |
| `clinica_veterinaria_banho_status` | Retirada do banho | `os_track` | `clinica_veterinaria_banho_tosa`, quando ativado. |
| `clinica_veterinaria_cadastro` | Cadastrar animal | `form` | Cadastro administrativo inicial. |
| `clinica_veterinaria_documentos` | Vacinas e documentos | `content` | Texto abaixo. |
| `clinica_veterinaria_recepcao` | Falar com a recepção | `queue` | Recepção. |

**Vacinas e documentos:**

> Para tratar de vacinas, vermífugos, preparo, exames ou receitas, fale com a equipe. O veterinário define a indicação e a data de reforço. Documentos clínicos são tratados pelo canal protegido da clínica.

Antes de mostrar uma lista de animais, validar o vínculo do contato. Em telefone compartilhado, não revelar todos os animais ou todos os titulares por simples coincidência do número.

### Mensagens e lembretes

| Gatilho | Texto pronto | Regra |
|---|---|---|
| Agendamento | Horário reservado para {data} às {hora}. Use Meus horários para confirmar, remarcar ou cancelar. | Não incluir motivo clínico. |
| 24 horas antes | Você tem um horário reservado para {data} às {hora}. Confirma sua presença? | Uma mensagem por agendamento vigente. |
| Retorno liberado | A equipe pode ajudar a organizar um novo horário. Fale com a recepção. | Data definida por veterinário. |
| Reforço próximo | Há um acompanhamento programado para {data}. Fale com a equipe para conferir o agendamento. | Data autorizada; sem medicamento ou dose. |
| Reforço vencido | Há um acompanhamento pendente. Fale com a equipe para conferir a próxima data. | Enviar uma vez. Não propor nova data clínica. |
| Banho aguardando retirada | {item}, do serviço nº {numero}, aguarda retirada. Entre em contato com a recepção. | Somente com presença do animal confirmada. |
| Internação com saída liberada | Há uma providência presencial pendente no registro nº {numero}. Fale com a recepção. | Somente após liberação clínica vigente. |
| Pedido clínico pelo chat | A equipe precisa tratar desse assunto pelo canal protegido. Não envie exames ou receitas por aqui. | Resposta fixa; sem interpretação do conteúdo. |

### O que o tutor resolve sozinho

| Ação | Limite |
|---|---|
| Selecionar animal | Apenas entre os animais com vínculo verificado. |
| Agendar e confirmar | Serviços liberados e horários disponíveis. |
| Aprovar proposta | Somente valores e escopo administrativo da versão apresentada. |
| Solicitar banho e tosa | Sem autorização de medicação ou sedação. |
| Acompanhar retirada | Situação administrativa do serviço. |
| Pedir retorno ou reforço | Solicitar agendamento, sem decidir indicação clínica. |
| Solicitar cópia | Abrir pedido. Acesso ao documento exige fluxo protegido. |
| Tratar de internação | Pedir contato humano. Não receber boletim gerado pelo bot. |

## 6. Bot da área

### Instruções prontas

> Você é o assistente administrativo da clínica veterinária. Ajude com horários, endereço, agendamento, propostas administrativas e retirada de banho e tosa. Antes de agir, use o animal escolhido entre os vínculos autorizados do tutor. Nunca suponha que animais com o mesmo nome são o mesmo cadastro. Não peça nem interprete sintomas, exames, receitas, vacinas anteriores ou medicamentos. Não indique tratamento, produto, dose, intervalo de vacina ou vermífugo, preparo ou conduta de emergência. Não leia prontuário, boletim de internação, evolução ou arquivo clínico. Aprovação de valores não autoriza procedimento clínico. Pedidos clínicos devem ser encaminhados à equipe. Não informe alta, prognóstico ou resultado de exame. Para urgências, use apenas: “Este canal não acompanha urgências. Procure atendimento veterinário de emergência.”

### Permissões

| Categoria | Permissão |
|---|---|
| Faz sozinho | Informações institucionais, fluxos administrativos autorizados, horários e situação do banho e tosa. |
| Pergunta à equipe | Encaixe, animal sem vínculo, tutor adicional, mudança de pagador, desconto, estorno, complementação de proposta e retirada por terceiro. |
| Nunca faz | Orientação clínica, triagem, receita, reforço calculado, interpretação de exame, boletim de internação ou alta. |
| Não pode ler | Prontuário, prescrição, exames, dados clínicos de prevenção, anexos clínicos e mensagens clínicas recebidas. |

A IA generativa também fica desligada por padrão nesta área. A clínica recebe conteúdo clínico espontâneo no chat. Banho e tosa dentro da mesma área não é motivo suficiente para enviar o histórico inteiro à IA.

Uma área separada de serviço estético pode ser avaliada depois. Ela precisaria manter isolamento real de conversas, anexos e contexto. Não basta mudar o texto do bot.

## 7. Equipe

### Setores e categorias

| Setores | Categorias de protocolo |
|---|---|
| Recepção | Agendamento |
| Equipe veterinária | Cadastro de animal e tutor |
| Internação | Proposta e cobrança |
| Banho e tosa | Retirada |
| Financeiro | Contato sobre internação |
| Privacidade e documentos | Solicitação de documento |
|  | Privacidade |

### Papéis

| Papel | Vê | Faz | Não pode |
|---|---|---|---|
| Recepção | Animal identificado, tutores autorizados e dados administrativos | Agendar, conferir vínculos, cobrar e organizar retirada | Ler prontuário ou explicar resultado |
| Banho e tosa | Serviço aprovado e instruções operacionais necessárias | Executar serviço estético e registrar entrega | Ler prontuário, medicar ou decidir sedação |
| `saude:clinician` veterinário | Prontuários atribuídos de animais | Evoluir, registrar prescrição interna, revisar exame, definir reforço e alta | Fechar prontuário humano |
| `saude:assistant` | Dados necessários às tarefas autorizadas | Registrar rascunho e informações de execução identificadas | Assinar como veterinário ou prescrever |
| Financeiro | Valores, pagadores e aprovações | Cobrança e conciliação | Ler conteúdo clínico |
| `saude:custodian` | Representação e pedidos de cópia | Conferir tutor e entregar cópia autorizada | Liberar acesso amplo por telefone |
| `saude:auditor` | Metadados de acesso | Auditar uso e entrega | Ler conteúdo clínico por padrão |

Em uma clínica pequena, a mesma pessoa pode acumular funções. A sessão deve registrar qual capacidade autorizou cada ação. Acúmulo de função não elimina auditoria.

## 8. Passos manuais

| Ordem | Passo |
|---:|---|
| 1 | Confirmar quais serviços existem: consultas, internação e banho e tosa. |
| 2 | Ocultar tipos e menus dos serviços não oferecidos. |
| 3 | Cadastrar veterinários, registros profissionais e responsáveis por plantão. |
| 4 | Definir espécie atendida, horários, duração e capacidade operacional. |
| 5 | Revisar cadastros duplicados de animais antes de importar. |
| 6 | Verificar tutores, contatos adicionais, pagadores e pessoas autorizadas para retirada. |
| 7 | Configurar propostas, cobranças e política de complementação de valores. |
| 8 | Definir passagem de plantão, alta e comunicação clínica. |
| 9 | Cadastrar retornos e reforços somente a partir de indicação profissional. |
| 10 | Definir guarda, representação, cópia protegida e descarte. |
| 11 | Configurar Mensalidade apenas se houver contrato e controle de sessões definidos. |
| 12 | Validar bloqueio de IA e de saída clínica pelo WhatsApp. |
| 13 | Validar exigências do CFMV e liberar a extensão antes do uso clínico. |

## 9. Extensão Saúde na veterinária

### 9.1. Reutilização do contrato comum

A veterinária usa as tabelas e rotas da seção 9 da área médica. Não cria outro prontuário nem outro módulo Saúde.

As diferenças são obrigatórias:

| Tema | Veterinária |
|---|---|
| Sujeito | Animal, com `kind = 'animal'`. |
| Identidade longitudinal | Identificador próprio. Nunca telefone do tutor. |
| Responsável pelo canal | Tutor ou contato autorizado verificado. |
| Multiplicidade | Um tutor pode ter vários animais. Um animal pode ter vários vínculos autorizados. |
| Profissional | `profession = 'veterinary'`, com registro conferido. |
| Alta | Decisão clínica, registrada e assinada pelo veterinário. |
| Cópia | Verificar legitimidade do solicitante, escopo e eventual conflito entre tutores. |
| Troca de tutor | Atualizar vínculo com evidência e auditoria. Não apagar o histórico do animal. |
| Dados do tutor | Proteger identificação, contato, pagamento e documentos pessoais. |
| Menor como contato | Não presumir capacidade de representação. Exigir conferência humana. |

O dado clínico de um animal não deve ser automaticamente equiparado ao dado pessoal sensível de saúde de uma pessoa. Ainda assim, o prontuário pode conter dados pessoais dos tutores e informações protegidas por dever profissional. A aplicação da LGPD, das normas do CFMV e do Código de Ética do Médico-Veterinário está **a conferir**.

O produto adota o mesmo isolamento técnico forte para os dois domínios.

### 9.2. Cadastro do animal

Campos protegidos dentro de `saude_subjects.payload_enc`:

| Chave proposta | Conteúdo |
|---|---|
| `animal_name` | Nome do animal |
| `species` | Espécie |
| `breed` | Raça ou identificação equivalente |
| `sex` | Sexo informado e conferido quando necessário |
| `birth_date` | Data de nascimento, quando conhecida |
| `birth_date_estimated` | Indicação de data estimada |
| `identification_marks` | Características de identificação |
| `microchip` | Microchip, quando houver |
| `administrative_alias` | Rótulo autorizado para a interface administrativa |

Peso, condição clínica e intervenções não devem ser tratados como atributos cadastrais sobrescritos sem histórico. Devem entrar em registros clínicos datados.

A projeção administrativa pode mostrar nome, espécie e código do animal a quem precisa identificá-lo. Não libera o restante do prontuário.

### 9.3. Vacinas e vermífugos

O modelo comum não calcula protocolos preventivos. A extensão registra aplicação ou administração, autoria e próxima data definida pelo veterinário.

| Registro | Regra |
|---|---|
| Aplicação realizada | Registrar produto, lote, data, profissional e demais dados exigidos. Campos normativos: **a conferir**. |
| Informação trazida pelo tutor | Marcar como informação externa ainda não conferida. Não tratar como aplicação realizada na clínica. |
| Próximo reforço | Data expressamente definida pelo profissional. |
| Vermífugo | Não calcular dose ou frequência por espécie, peso ou idade no bot. |
| Lembrete | Usar somente data e texto administrativo neutro. |
| Data vencida | Solicitar contato com a equipe. Não calcular nova indicação. |
| Correção | Acrescentar novo registro ligado ao anterior. Não sobrescrever. |
| Cartão ou comprovante | Documento clínico protegido. Não encaminhar pelo WhatsApp neste desenho. |

### 9.4. DDL adicional da veterinária

A tabela abaixo complementa o DDL comum. Sua leitura também exige auditoria.

```sql
CREATE TABLE saude_preventive_records (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  previous_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('vaccine', 'deworming')),
  source TEXT NOT NULL CHECK (
    source IN ('performed_here', 'external_unverified', 'external_verified')
  ),
  payload_enc TEXT NOT NULL,
  performed_on TEXT,
  next_due_on TEXT,
  professional_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  signature_enc TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, episode_id)
    REFERENCES saude_episodes(profile_id, id),
  FOREIGN KEY (profile_id, previous_id)
    REFERENCES saude_preventive_records(profile_id, id),
  FOREIGN KEY (profile_id, professional_user_id)
    REFERENCES saude_professionals(profile_id, user_id)
);

CREATE INDEX saude_preventive_due
  ON saude_preventive_records(profile_id, next_due_on);

CREATE TABLE saude_preventive_notices (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  preventive_record_id TEXT NOT NULL,
  recipient_link_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  sent_at INTEGER,
  cancelled_at INTEGER,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, idempotency_key),
  FOREIGN KEY (profile_id, preventive_record_id)
    REFERENCES saude_preventive_records(profile_id, id),
  FOREIGN KEY (profile_id, recipient_link_id)
    REFERENCES saude_people_links(profile_id, id)
);

CREATE INDEX saude_preventive_notices_due
  ON saude_preventive_notices(profile_id, scheduled_at, sent_at, cancelled_at);

CREATE TRIGGER saude_preventive_records_no_update
BEFORE UPDATE ON saude_preventive_records
BEGIN
  SELECT RAISE(ABORT, 'immutable_clinical_record');
END;
```

O serviço valida datas no formato `AAAA-MM-DD`, vínculo com animal e habilitação veterinária. Uma correção cancela avisos futuros do registro anterior e cria novos avisos. Antes de enviar, conferir novamente vínculo do tutor, preferência de contato e vigência do registro.

O descarte dessas tabelas integra a mesma operação de retenção do prontuário. Não manter produto, lote, dose ou justificativa em dados da tarefa comum.

### 9.5. Rotas adicionais

Prefixo: `/api/v1/profiles/{profile}/saude`.

| Método | Rota | Uso | Acesso |
|---|---|---|---|
| `POST` | `/episodes/{id}/preventive-records` | Registrar vacina ou vermífugo e próxima data | Veterinário autorizado |
| `GET` | `/subjects/{id}/preventive-records` | Ler histórico preventivo | Equipe clínica autorizada |
| `POST` | `/preventive-records/{id}/corrections` | Retificar por novo registro | Veterinário autorizado |
| `POST` | `/preventive-records/{id}/notices` | Programar aviso neutro para data autorizada | Serviço determinístico autorizado |
| `POST` | `/episodes/{id}/discharge` | Registrar alta clínica e liberar etapa administrativa | Veterinário autorizado |
| `POST` | `/episodes/{id}/discharge-revocation` | Revogar liberação, com adendo | Veterinário autorizado |
| `POST` | `/episodes/{id}/close` | Encerrar por alta, transferência ou outro motivo protegido | Veterinário autorizado |

O encerramento protegido publica para o motor apenas o comando administrativo necessário. Não publica motivo clínico em eventos comuns.

### 9.6. Internação: o que o modelo não resolve

| Necessidade | Tratamento |
|---|---|
| Evolução por plantão | Registros clínicos assinados na extensão. |
| Passagem de plantão | Leitura auditada e confirmação do profissional que assume. |
| Prescrição interna | Registro protegido. Não é ordem automática de administração. |
| Administração de medicamento | Controle de execução e checagem exige desenho próprio. Fora deste primeiro escopo. |
| Sinais vitais e monitoramento | Registro clínico pode guardar observações. Alarmes e vigilância contínua ficam fora. |
| Boletim ao tutor | Comunicação humana pelo canal protegido, com destinatário verificado. |
| Alta | Registro clínico e liberação explícita. |
| Óbito ou transferência | Registro protegido e contato humano. Nenhuma mensagem genérica de retirada. |
| Cobrança de diárias | Regra administrativa separada. Não inferir dias faturáveis a partir de sinais clínicos. |

A extensão não deve ser vendida como sistema completo de gestão de internação enquanto prescrição executável, checagem de administração e continuidade assistencial não estiverem contempladas.

### 9.7. Privacidade, guarda e assinatura

Aplicam-se as mesmas barreiras técnicas da área médica:

| Controle | Aplicação veterinária |
|---|---|
| IA | Nenhuma leitura do prontuário ou de conteúdo clínico recebido. |
| WhatsApp | Nenhum resultado, receita, evolução, boletim ou documento clínico. |
| Exportação comum | Excluir conteúdo clínico e identidade documental dos tutores. |
| Leitura | Registrar usuário, recurso, finalidade, horário e resultado. |
| Assinatura | Fixar autoria, registro profissional, conteúdo e evidência de fechamento. |
| Correção | Adendo ou nova versão vinculada. |
| Guarda | Política específica veterinária. Não copiar automaticamente o prazo médico. |
| Exclusão | Avaliar obrigação de guarda e impedimentos. Descarte restrito e auditado. |
| Cópia ao tutor | Destinatário verificado e escopo autorizado. |
| Disputa entre tutores | Suspender entrega automática e encaminhar à custódia responsável. |

Normas do CFMV sobre prontuários, documentos, identificação, assinatura, acesso e guarda: **a conferir**. A duração da guarda e as exigências de documento devem ser validadas antes do uso clínico.

### 9.8. Receita veterinária com validade legal: fora do escopo

Além dos controles comuns de identidade, integridade e assinatura, seria necessário conferir:

| Tema | Validação necessária |
|---|---|
| Prescritor | Habilitação e registro veterinário. |
| Identificação | Animal, tutor e demais dados exigidos. |
| Conteúdo | Medicamento, apresentação, quantidade, uso e elementos obrigatórios. |
| Categoria do produto | Regras sanitárias e de controle aplicáveis. |
| Assinatura | Modalidade aceita para o documento e sua finalidade. |
| Documento controlado | Formulários, registros, numeração e procedimentos específicos, quando exigidos. |
| Autenticidade | Forma de verificação por quem recebe ou dispensa. |

Normas do CFMV e regras aplicáveis da Anvisa e do Ministério da Agricultura e Pecuária: **a conferir conforme produto e documento**.

O lançamento proposto permanece um registro interno. Não produz receita válida para dispensação.

## 10. Dúvidas e decisões

| Decisão | Proposta |
|---|---|
| Internação no modelo básico? | Disponível como opção, desativada até configuração da clínica. |
| Banho e tosa? | Opcional, com tipo e menus próprios. |
| Um tutor com vários animais? | Suportar desde o primeiro cadastro longitudinal. |
| Vários tutores para um animal? | Suportar com vínculo, finalidade e verificação individuais. |
| Transferência de tutor? | Conferência humana e histórico preservado. |
| Reforços automáticos? | Apenas lembrete de data definida pelo veterinário. |
| Boletim de internação no WhatsApp? | Não neste desenho. |
| Mensalidade de banho? | Só após definir cobrança, crédito de sessões e regras de consumo. |
| Gestão completa da internação? | Fase posterior. Não confundir registro de evolução com controle assistencial completo. |
| Guarda e receita legal? | Validar normas específicas. Emissão legal de receita fica fora. |
| IA generativa? | Desligada por padrão na área clínica. |
| Propostas complementares | Definir contrato antes de automatizar aumento de conta durante internação. |

### Modelo neutro — clínica veterinária

```json
{
  "id": "clinica_veterinaria",
  "name": "Clínica veterinária",
  "labels": {
    "customer":"Tutor",
    "customers":"Tutores",
    "subject":"Animal",
    "subjects":"Animais",
    "work":"Atendimento",
    "works":"Atendimentos e serviços",
    "assignee":"Responsável administrativo",
    "quote":"Proposta de valores"
  },
  "modules": {
    "on":["os","agenda","forms","payments"],
    "off":["mensalidade","reserva","erp"]
  },
  "extension": {
    "id":"saude",
    "required_for_clinical_use":true,
    "subject_kind":"animal"
  },
  "security": {
    "generative_ai_enabled":false,
    "clinical_data_in_generic_work":false,
    "clinical_data_in_whatsapp":false,
    "clinical_data_in_common_exports":false,
    "phone_is_clinical_authorization":false,
    "verified_animal_link_required":true
  },
  "work_types": [
    {
      "id":"clinica_veterinaria_atendimento",
      "singular":"Atendimento",
      "plural":"Atendimentos",
      "item_label":"Animal",
      "problem_label":"Solicitação administrativa",
      "features":{"quote":true,"warranty":false,"pickup":false,"terms":true,"tasks":true,"people":true,"files":true,"entries":true},
      "terms_text":"Solicito o atendimento administrativo do animal identificado neste registro e declaro que a recepção deve conferir minha autorização como tutor ou representante. Valores serão informados antes da cobrança. Aprovar valores não substitui autorização clínica específica. Exames, receitas, orientações e informações clínicas serão tratados com a equipe pelo canal protegido indicado pela clínica.",
      "fields":[
        {"key":"modalidade","label":"Modalidade","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["consulta","retorno","procedimento","preventivo"]},
        {"key":"origem","label":"Origem do atendimento","type":"lista","required":true,"customer_visible":false,"sensitive":false,"options":["agendado","encaixe","encaminhamento"]},
        {"key":"pagador","label":"Pagador","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["tutor_principal","outro_autorizado"]}
      ],
      "field_rules":[
        {"field":"pagador","required_before_action":"charge"}
      ],
      "stages":[
        {"id":"solicitado","label":"Solicitação recebida","base":"received","next":["agendado","cancelado"],"message":"Recebemos a solicitação nº {numero}. A recepção vai conferir o animal e o horário com você.","stale_days":1},
        {"id":"agendado","label":"Horário reservado","base":"analyzing","next":["aguardando_autorizacao","em_atendimento","cancelado"],"message":"","stale_days":0},
        {"id":"aguardando_autorizacao","label":"Proposta enviada","base":"quoted","next":["autorizado","recusado","agendado","cancelado"],"message":"A proposta administrativa nº {numero} está disponível para sua decisão. A aprovação de valores não substitui autorização clínica específica.","stale_days":1},
        {"id":"autorizado","label":"Valores aprovados","base":"approved","next":["em_atendimento","cancelado"],"message":"A aprovação de valores da solicitação nº {numero} foi registrada. A equipe dará continuidade ao atendimento.","stale_days":1},
        {"id":"recusado","label":"Proposta recusada","base":"declined","next":["agendado","cancelado"],"message":"A recusa da proposta nº {numero} foi registrada. A recepção pode esclarecer as próximas providências.","stale_days":1},
        {"id":"em_atendimento","label":"Atendimento iniciado","base":"in_progress","next":["concluido"],"message":"","stale_days":0},
        {"id":"concluido","label":"Atendimento concluído","base":"delivered","next":[],"message":"","stale_days":0},
        {"id":"cancelado","label":"Cancelado","base":"cancelled","next":[],"message":"A solicitação nº {numero} foi cancelada. Para um novo horário, fale com a recepção.","stale_days":0}
      ],
      "people_roles":[
        {"id":"tutor_principal","label":"Tutor principal"},
        {"id":"tutor_adicional","label":"Tutor adicional autorizado"},
        {"id":"pagador","label":"Pagador"},
        {"id":"veterinario","label":"Veterinário responsável"}
      ],
      "entry_kinds":[
        {"id":"contato_administrativo","label":"Contato administrativo"},
        {"id":"autorizacao_valores","label":"Autorização de valores"},
        {"id":"ocorrencia_agenda","label":"Ocorrência de agenda"}
      ],
      "file_kinds":[
        {"id":"proposta_administrativa","label":"Proposta administrativa","customer_can_receive":true},
        {"id":"recibo","label":"Recibo","customer_can_receive":true}
      ],
      "default_tasks":[
        {"stage":"solicitado","title":"Conferir animal e tutor autorizado","due_days":0,"assignee_role":"recepcao"},
        {"stage":"agendado","title":"Conferir horário e profissional","due_days":0,"assignee_role":"recepcao"},
        {"stage":"aguardando_autorizacao","title":"Conferir destinatário e validade da proposta","due_days":0,"assignee_role":"recepcao"},
        {"stage":"autorizado","title":"Conferir autorização administrativa registrada","due_days":0,"assignee_role":"recepcao"},
        {"stage":"recusado","title":"Encaminhar decisão ao responsável pelo atendimento","due_days":0,"assignee_role":"recepcao"},
        {"stage":"em_atendimento","title":"Conferir vínculo com o veterinário responsável","due_days":0,"assignee_role":"saude:clinician"},
        {"stage":"concluido","title":"Encerrar pendências administrativas","due_days":0,"assignee_role":"recepcao"},
        {"stage":"cancelado","title":"Conferir cobrança e eventual estorno","due_days":0,"assignee_role":"financeiro"}
      ]
    },
    {
      "id":"clinica_veterinaria_internacao",
      "singular":"Internação",
      "plural":"Internações",
      "optional":true,
      "customer_can_open":false,
      "item_label":"Animal",
      "problem_label":"Referência administrativa da admissão",
      "features":{"quote":true,"warranty":false,"pickup":true,"terms":true,"tasks":true,"people":true,"files":true,"entries":true},
      "pickup_reminder_days":1,
      "pickup_requires_clinical_release":true,
      "pickup_reminder_text":"Há uma providência presencial pendente no registro nº {numero}. Fale com a recepção.",
      "terms_text":"Solicito a organização administrativa da internação do animal identificado. A equipe conferirá quem pode receber informações e decidir sobre valores. A proposta pode exigir complementação identificada e nova aprovação. Este aceite não autoriza procedimentos clínicos de forma genérica. Internação, procedimentos e alta dependem da equipe veterinária e dos registros próprios.",
      "fields":[
        {"key":"acomodacao_codigo","label":"Código da acomodação","type":"texto","required":false,"customer_visible":false,"sensitive":false,"options":[]},
        {"key":"contato_prioritario","label":"Contato prioritário","type":"lista","required":true,"customer_visible":false,"sensitive":true,"options":["tutor_principal","tutor_adicional"]},
        {"key":"janela_contato","label":"Período administrativo de contato","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["manha","tarde","noite","combinado"]}
      ],
      "field_rules":[
        {"field":"acomodacao_codigo","required_before":["internado"]}
      ],
      "stages":[
        {"id":"admissao","label":"Admissão em organização","base":"received","next":["aguardando_autorizacao","internado","cancelado"],"message":"A recepção está organizando o registro nº {numero}. Confirme com a equipe qual contato está autorizado.","stale_days":0},
        {"id":"aguardando_autorizacao","label":"Proposta enviada","base":"quoted","next":["autorizado","recusado","admissao","cancelado"],"message":"A proposta administrativa nº {numero} está disponível. Fale com a equipe para esclarecer valores e autorizações.","stale_days":1},
        {"id":"autorizado","label":"Valores aprovados","base":"approved","next":["internado","cancelado"],"message":"A aprovação de valores do registro nº {numero} foi registrada.","stale_days":0},
        {"id":"recusado","label":"Proposta recusada","base":"declined","next":["admissao","internado","cancelado"],"message":"A decisão sobre a proposta nº {numero} foi registrada. A equipe entrará em contato.","stale_days":0},
        {"id":"internado","label":"Internação em andamento","base":"in_progress","next":["alta_liberada","encerrado"],"message":"","stale_days":0},
        {"id":"alta_liberada","label":"Saída autorizada pela equipe","base":"ready","next":["internado","encerrado"],"message":"Há uma providência presencial pendente no registro nº {numero}. Fale com a recepção para combinar o atendimento.","stale_days":1},
        {"id":"encerrado","label":"Internação encerrada","base":"delivered","next":[],"message":"","stale_days":0},
        {"id":"cancelado","label":"Admissão cancelada","base":"cancelled","next":[],"message":"O registro administrativo nº {numero} foi cancelado. Fale com a recepção se precisar de esclarecimentos.","stale_days":0}
      ],
      "people_roles":[
        {"id":"tutor_principal","label":"Tutor principal"},
        {"id":"tutor_adicional","label":"Tutor adicional autorizado"},
        {"id":"pagador","label":"Pagador"},
        {"id":"veterinario_plantao","label":"Veterinário responsável pelo plantão"}
      ],
      "entry_kinds":[
        {"id":"contato_tutor","label":"Contato administrativo com tutor"},
        {"id":"conferencia_valores","label":"Conferência de valores"},
        {"id":"passagem_administrativa","label":"Passagem administrativa de plantão"}
      ],
      "file_kinds":[
        {"id":"proposta_administrativa","label":"Proposta administrativa","customer_can_receive":true},
        {"id":"recibo","label":"Recibo","customer_can_receive":true}
      ],
      "default_tasks":[
        {"stage":"admissao","title":"Conferir identidade do animal e contatos autorizados","due_days":0,"assignee_role":"recepcao"},
        {"stage":"aguardando_autorizacao","title":"Conferir destinatário da proposta inicial","due_days":0,"assignee_role":"recepcao"},
        {"stage":"autorizado","title":"Registrar responsável pela comunicação administrativa","due_days":0,"assignee_role":"recepcao"},
        {"stage":"recusado","title":"Encaminhar decisão ao veterinário responsável","due_days":0,"assignee_role":"recepcao"},
        {"stage":"internado","title":"Conferir pendências administrativas do turno","due_days":0,"assignee_role":"recepcao"},
        {"stage":"alta_liberada","title":"Conferir pessoa autorizada para retirada","due_days":0,"assignee_role":"recepcao"},
        {"stage":"encerrado","title":"Encerrar conta administrativa e registrar entrega","due_days":0,"assignee_role":"financeiro"},
        {"stage":"cancelado","title":"Conferir cobrança e eventual estorno","due_days":0,"assignee_role":"financeiro"}
      ]
    },
    {
      "id":"clinica_veterinaria_banho_tosa",
      "singular":"Banho e tosa",
      "plural":"Serviços de banho e tosa",
      "optional":true,
      "item_label":"Animal",
      "problem_label":"Serviço solicitado",
      "features":{"quote":true,"warranty":false,"pickup":true,"terms":true,"tasks":true,"people":true,"files":true,"entries":true},
      "pickup_reminder_days":1,
      "pickup_reminder_text":"{item}, do serviço nº {numero}, aguarda retirada. Entre em contato com a recepção.",
      "terms_text":"Autorizo somente o serviço estético descrito na proposta aprovada para o animal identificado. Mudanças de serviço ou valor exigem nova autorização. Este aceite não autoriza sedação, medicação ou procedimento clínico. A equipe pode interromper o serviço e entrar em contato se precisar de avaliação ou de nova decisão.",
      "fields":[
        {"key":"servico","label":"Serviço","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["banho","banho_e_tosa","tosa_higienica"]},
        {"key":"porte","label":"Porte para orçamento","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["pequeno","medio","grande","gigante"]},
        {"key":"preferencia_estetica","label":"Preferência estética","type":"texto_longo","required":false,"customer_visible":true,"sensitive":false,"options":[]}
      ],
      "stages":[
        {"id":"recebido","label":"Solicitação recebida","base":"received","next":["orcamento","cancelado"],"message":"Recebemos a solicitação nº {numero} para {item}. A equipe confirmará serviço, horário e valor.","stale_days":1},
        {"id":"orcamento","label":"Aguardando aprovação","base":"quoted","next":["aprovado","recusado","recebido","cancelado"],"message":"A proposta nº {numero} para {item} está disponível. Confira o serviço e o valor antes de aprovar.","stale_days":1},
        {"id":"aprovado","label":"Aprovado","base":"approved","next":["em_execucao","cancelado"],"message":"A proposta nº {numero} foi aprovada. O horário será confirmado pela equipe.","stale_days":0},
        {"id":"recusado","label":"Recusado","base":"declined","next":["recebido","pronto","cancelado"],"message":"A proposta nº {numero} foi recusada. Se o animal estiver na clínica, combine a retirada com a equipe.","stale_days":0},
        {"id":"em_execucao","label":"Serviço em execução","base":"in_progress","next":["pronto"],"message":"","stale_days":0},
        {"id":"pronto","label":"Aguardando retirada","base":"ready","next":["entregue"],"message":"{item}, do serviço nº {numero}, está disponível para retirada. Combine a chegada com a equipe.","stale_days":1},
        {"id":"entregue","label":"Animal entregue","base":"delivered","next":[],"message":"Registramos a entrega de {item}, serviço nº {numero}. Obrigado pela confiança.","stale_days":0},
        {"id":"cancelado","label":"Cancelado","base":"cancelled","next":[],"message":"A solicitação nº {numero} foi cancelada.","stale_days":0}
      ],
      "people_roles":[
        {"id":"tutor","label":"Tutor"},
        {"id":"retirada","label":"Pessoa autorizada para retirada"},
        {"id":"profissional_estetica","label":"Profissional de banho e tosa"}
      ],
      "entry_kinds":[
        {"id":"conferencia_entrada","label":"Conferência de entrada"},
        {"id":"execucao_administrativa","label":"Execução administrativa"},
        {"id":"entrega","label":"Entrega do animal"}
      ],
      "file_kinds":[
        {"id":"proposta","label":"Proposta","customer_can_receive":true},
        {"id":"recibo","label":"Recibo","customer_can_receive":true},
        {"id":"foto_estetica","label":"Foto estética autorizada do animal","customer_can_receive":true}
      ],
      "default_tasks":[
        {"stage":"recebido","title":"Conferir animal, serviço e pessoa autorizada para retirada","due_days":0,"assignee_role":"recepcao"},
        {"stage":"orcamento","title":"Conferir proposta e destinatário","due_days":0,"assignee_role":"recepcao"},
        {"stage":"aprovado","title":"Confirmar horário e profissional","due_days":0,"assignee_role":"recepcao"},
        {"stage":"recusado","title":"Conferir se há retirada pendente","due_days":0,"assignee_role":"recepcao"},
        {"stage":"em_execucao","title":"Conferir serviço aprovado antes de executar","due_days":0,"assignee_role":"banho_tosa"},
        {"stage":"pronto","title":"Contatar tutor para retirada no expediente","due_days":0,"assignee_role":"recepcao"},
        {"stage":"entregue","title":"Registrar quem retirou o animal","due_days":0,"assignee_role":"recepcao"},
        {"stage":"cancelado","title":"Conferir cobrança e eventual estorno","due_days":0,"assignee_role":"financeiro"}
      ]
    }
  ],
  "module_config":{
    "agenda":{
      "min_notice_minutes":120,
      "max_days_ahead":30,
      "slot_step_minutes":10,
      "reminder_hours":24,
      "customer_change_hours":2,
      "close_on_holidays":true,
      "booked_text":"Horário reservado para {data} às {hora}. Use Meus horários para confirmar, remarcar ou cancelar.",
      "reminder_text":"Você tem um horário reservado para {data} às {hora}. Confirma sua presença?",
      "services":[
        {"id":"clinica_veterinaria_consulta","name":"Consulta veterinária","duration_minutes":30,"self_booking":true},
        {"id":"clinica_veterinaria_retorno","name":"Retorno","duration_minutes":20,"self_booking":"after_release"},
        {"id":"clinica_veterinaria_preventivo","name":"Atendimento preventivo","duration_minutes":20,"self_booking":"request_only"},
        {"id":"clinica_veterinaria_procedimento","name":"Procedimento","duration_minutes":60,"self_booking":false},
        {"id":"clinica_veterinaria_banho","name":"Banho","duration_minutes":60,"self_booking":"after_capacity_setup","optional":true},
        {"id":"clinica_veterinaria_banho_e_tosa","name":"Banho e tosa","duration_minutes":90,"self_booking":"after_capacity_setup","optional":true},
        {"id":"clinica_veterinaria_tosa_higienica","name":"Tosa higiênica","duration_minutes":30,"self_booking":"after_capacity_setup","optional":true}
      ]
    },
    "mensalidade":{
      "plans":[],
      "optional_plans":[
        {"id":"clinica_veterinaria_banho_mensal","name":"Banho mensal","sessions_per_cycle":4,"cycle":"monthly","price_cents":null,"activation_requires_session_credit_contract":true}
      ]
    },
    "forms":{
      "forms":[
        {
          "id":"clinica_veterinaria_cadastro_animal",
          "title":"Cadastro administrativo do animal",
          "intro":"Informe apenas dados administrativos do animal. Não envie sintomas, medicamentos, vacinas anteriores, exames ou receitas neste formulário. A equipe conferirá o cadastro e sua autorização.",
          "questions":[
            {"key":"animal_nome","label":"Qual é o nome do animal?","type":"texto","required":true},
            {"key":"especie","label":"Qual é a espécie?","type":"lista","required":true,"options":["cão","gato","outra"]},
            {"key":"ja_cadastrado","label":"O animal já tem cadastro nesta clínica?","type":"sim_nao","required":true},
            {"key":"vinculo","label":"Você é o tutor ou um contato autorizado?","type":"lista","required":true,"options":["tutor","contato_autorizado"]},
            {"key":"avisos_whatsapp","label":"Aceita receber lembretes administrativos por este WhatsApp?","type":"sim_nao","required":true}
          ]
        }
      ]
    },
    "payments":{
      "automatic_charge":false,
      "verified_payer_required":true,
      "supplement_requires_new_approval":true
    }
  },
  "menus":[
    {"id":"clinica_veterinaria_agendar","label":"Agendar","type":"agenda","parent_id":null,"content":""},
    {"id":"clinica_veterinaria_horarios","label":"Meus horários","type":"agenda_mine","parent_id":null,"content":""},
    {"id":"clinica_veterinaria_solicitar","label":"Solicitar atendimento","type":"os_open","parent_id":null,"content":"","reference":{"work_type_id":"clinica_veterinaria_atendimento"}},
    {"id":"clinica_veterinaria_acompanhar","label":"Acompanhar solicitações","type":"os_track","parent_id":null,"content":"","reference":{"work_type_id":"clinica_veterinaria_atendimento"}},
    {"id":"clinica_veterinaria_internacao","label":"Contato sobre internação","type":"queue","parent_id":null,"content":"","reference":{"department":"Internação"},"requires_work_type":"clinica_veterinaria_internacao"},
    {"id":"clinica_veterinaria_banho","label":"Banho e tosa","type":"os_open","parent_id":null,"content":"","reference":{"work_type_id":"clinica_veterinaria_banho_tosa"},"requires_work_type":"clinica_veterinaria_banho_tosa"},
    {"id":"clinica_veterinaria_banho_status","label":"Retirada do banho","type":"os_track","parent_id":null,"content":"","reference":{"work_type_id":"clinica_veterinaria_banho_tosa"},"requires_work_type":"clinica_veterinaria_banho_tosa"},
    {"id":"clinica_veterinaria_cadastro","label":"Cadastrar animal","type":"form","parent_id":null,"content":"","reference":{"form_id":"clinica_veterinaria_cadastro_animal"}},
    {"id":"clinica_veterinaria_documentos","label":"Vacinas e documentos","type":"content","parent_id":null,"content":"Para tratar de vacinas, vermífugos, preparo, exames ou receitas, fale com a equipe. O veterinário define a indicação e a data de reforço. Documentos clínicos são tratados pelo canal protegido da clínica."},
    {"id":"clinica_veterinaria_recepcao","label":"Falar com a recepção","type":"queue","parent_id":null,"content":"","reference":{"department":"Recepção"}}
  ],
  "departments":["Recepção","Equipe veterinária","Internação","Banho e tosa","Financeiro","Privacidade e documentos"],
  "ticket_categories":["Agendamento","Cadastro de animal e tutor","Proposta e cobrança","Retirada","Contato sobre internação","Solicitação de documento","Privacidade"],
  "bot_instructions":"Você é o assistente administrativo da clínica veterinária. Ajude com horários, endereço, agendamento, propostas administrativas e retirada de banho e tosa. Antes de agir, use o animal escolhido entre os vínculos autorizados do tutor. Nunca suponha que animais com o mesmo nome são o mesmo cadastro. Não peça nem interprete sintomas, exames, receitas, vacinas anteriores ou medicamentos. Não indique tratamento, produto, dose, intervalo de vacina ou vermífugo, preparo ou conduta de emergência. Não leia prontuário, boletim de internação, evolução ou arquivo clínico. Aprovação de valores não autoriza procedimento clínico. Pedidos clínicos devem ser encaminhados à equipe. Não informe alta, prognóstico ou resultado de exame. Para urgências, use apenas: “Este canal não acompanha urgências. Procure atendimento veterinário de emergência.”",
  "manual_steps":[
    "Confirmar serviços oferecidos e ocultar tipos e menus não utilizados.",
    "Cadastrar veterinários, registros profissionais e responsáveis por plantão.",
    "Definir espécies atendidas, horários, durações e capacidade.",
    "Revisar duplicidades de animais antes de importar cadastros.",
    "Verificar tutores, contatos adicionais, pagadores e pessoas autorizadas para retirada.",
    "Configurar propostas, cobranças e complementação de valores.",
    "Definir passagem de plantão, alta e comunicação clínica.",
    "Cadastrar retornos e reforços apenas com indicação profissional.",
    "Validar guarda, representação, cópia protegida e descarte.",
    "Ativar Mensalidade somente com contrato e controle de sessões definidos.",
    "Validar bloqueio de IA e de saída clínica pelo WhatsApp.",
    "Validar exigências do CFMV antes de liberar uso clínico."
  ]
}
```