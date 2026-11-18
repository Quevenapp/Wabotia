# Condomínios residenciais e comerciais

Modelo de área e especificação da extensão **Condomínio**. Data: 18/11/2026.

Base informada: commit `efc7e54`. A versão `0.21.1` consta em `package.json:3`. Este documento é uma proposta. O DDL não foi executado. Não foram feitos testes, alterações de arquivos ou consultas externas.

## 1. Quem usa e como é o dia a dia

A portaria recebe encomendas, confere visitantes e registra entradas e saídas.  
O síndico acompanha ocorrências, autoriza intervenções e publica comunicados.  
A administradora mantém cadastros, cobranças e documentos das assembleias.  
O morador pode ser proprietário, inquilino ou dependente de uma unidade.  
No condomínio comercial, a unidade também pode ter uma empresa e representantes autorizados.  
Um telefone pode estar ligado a várias unidades. Cada atendimento começa pela escolha da unidade.  
As perguntas frequentes são: “Chegou encomenda?”, “Posso liberar uma visita?”, “Como reservo o salão?”, “Qual o andamento do vazamento?” e “Como obtenho a segunda via?”.  
A portaria consulta encomendas e autorizações. Não consulta dívidas, parcelas ou votos individuais.

## 2. Tipos de trabalho

### 2.1. Contrato comum e pontos de integração

O modelo usa quatro tipos do motor generalizado de Ordem de Serviço. Não cria outro motor.

| Assunto | Evidência atual | Contrato proposto |
|---|---|---|
| Estados | Os nove códigos estão em `src/modules/os/model.ts:6` | Toda etapa aponta para um desses códigos. `stage` identifica a etapa do condomínio. |
| Aprovação | A mudança direta para `approved` ou `declined` é recusada fora da decisão de orçamento em `src/modules/os/store.ts:621` | Aprovar visitante ou obra é uma decisão de etapa. Não chama a decisão de orçamento. |
| Numeração | Existe unicidade de `(profile_id, number)` em `migrations/0035_os_orders.sql:57` | Preservar `number`. Acrescentar número próprio do tipo, como `work_number`, e contador por área e tipo. Não remover a restrição existente. |
| Contagens | `counts` é montado por agrupamento de `status`, sem preencher estados ausentes, em `src/modules/os/store.ts:257` | Preservar o domínio dos nove códigos e o comportamento legado. Contagem por etapa é um campo novo. |
| Paginação | O cursor atual usa `number`, em `src/modules/os/store.ts:266` | Manter a paginação legada pelo número global. Não usar o número local do tipo como cursor global. |
| Menu por tipo | Os manipuladores atuais ignoram `_item`, em `src/modules/os/os.ts:125` e `src/modules/os/os.ts:145` | Implementar `work_type_id` como referência validada. Não presumir que o menu atual já filtra por tipo. |
| Referências de menu | O contrato aceita `reference`, em `src/modules/types.ts:29` | Declarar a referência ao cadastro dos tipos no motor generalizado. |
| Retirada | O lembrete seleciona ordens em `ready`, em `src/modules/os/reminders.ts:26` | Habilitar retirada somente para Encomenda. Ocorrência resolvida e obra em vistoria não recebem texto de retirada. |
| Texto de acompanhamento | O estado `ready` hoje acrescenta “Pronta para retirada”, em `src/modules/os/store.ts:1075` | O acompanhamento novo usa etapa e recursos do tipo. O texto legado continua no tipo embutido. |
| Identidade do cliente | A busca atual usa conversa ou telefone verificado, em `src/modules/os/store.ts:1032` | Além da identidade do canal, validar vínculo vigente com a unidade e autorização sobre o registro. |
| Permissões | A leitura atual passa por acesso à conversa e pela projeção da ordem, em `src/modules/os/os.ts:211`; a projeção trata contatos e notas em `src/modules/os/store.ts:166` | Acrescentar autorização por tipo, registro, campo e documento. Esconder uma tela não basta. |

Os aplicativos Android e iOS não foram inspecionados: **a conferir**. A Ordem de Serviço embutida deve preservar criação, transições, textos, numeração e respostas atuais. Nos tipos novos, operações específicas exigem cliente que entenda etapas. Comandos antigos não podem contornar autorização de entrada, vistoria ou votação.

**Regras comuns propostas**

| Regra | Definição |
|---|---|
| Identificadores | Tipos e cadastros do modelo usam prefixo `cond-`. Etapas e chaves de campos usam `snake_case`. |
| Unidade | O campo extra `unidade` serve para apresentação. Com a extensão, o vínculo oficial fica em `cond_work_units`. Texto digitado não concede acesso. |
| Cliente vê | Significa acesso em página autenticada ao próprio registro. Não autoriza envio do conteúdo pelo WhatsApp. |
| Sensível | É uma restrição operacional do produto. Não equivale, necessariamente, à classificação jurídica de dado pessoal sensível. |
| Campo sensível | Não entra em mensagem, IA, busca textual da IA, resumo, evento público ou exportação sem autorização. |
| Campos fixos | O texto de “Problema” dos quatro tipos e o nome de visitante precisam de política de sensibilidade própria. Esse atributo também deve alcançar campos fixos, anexos e lançamentos. |
| Mensagens | Usam apenas `{numero}` e rótulos operacionais. `{numero}` é a identificação pública do tipo, por exemplo `ENC-24`. |
| Aviso de estagnação | `stale_days` conta dias corridos desde a entrada na etapa. Zero desliga. Não substitui prazo de tarefa nem horário de expiração. |
| Tarefas | `due_days` conta dias corridos desde a entrada na etapa. Zero significa tarefa imediata. Tarefas com horário seguem o agendamento específico. |
| Reentrada em etapa | Cria tarefas para a nova passagem, com chave de idempotência própria. Cancela tarefas incompatíveis da passagem anterior. |
| Registro encerrado | Não é reaberto silenciosamente. Uma nova demanda pode referenciar o registro anterior. |
| Aprovação | Registra pessoa, papel, versão aprovada, data e condições. Alterar data, escopo ou visitante invalida a aprovação correspondente. |
| Financeiro | Nenhuma etapa cria cobrança automaticamente neste modelo. |

### 2.2. Ocorrência ou manutenção

| Campo de identificação | Valor |
|---|---|
| Singular | Ocorrência ou manutenção |
| Plural | Ocorrências e manutenções |
| ID | `cond-ocorrencia` |
| Rótulo de Item | Local ou equipamento |
| Rótulo de Problema | O que aconteceu |
| Abertura | Morador vinculado ou equipe em nome do solicitante |
| Visibilidade padrão | Solicitante e equipe autorizada. Outros moradores da unidade não recebem acesso automático. |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `unidade` | Bloco e unidade do solicitante | texto | Sim | Sim | Sim |
| `categoria` | Categoria | lista: `barulho`, `vazamento`, `elevador`, `eletrica`, `limpeza`, `outro` | Sim | Sim | Não |
| `local_detalhado` | Local exato | texto | Sim | Sim | Sim |
| `risco_imediato` | Há risco imediato? | sim_nao | Sim | Sim | Não |
| `prioridade` | Prioridade da equipe | lista: `normal`, `urgente`, `critica` | Não | Não | Não |
| `detalhes_restritos` | Informações reservadas | texto_longo | Não | Sim | Sim |

`risco_imediato=true` alerta a equipe imediatamente. Não aguarda o prazo de estagnação. A prioridade final é definida por pessoa da equipe.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `aberta` | Recebida | `received` | `triagem`, `cancelada` | Recebemos a ocorrência {numero}. A equipe vai conferir e informar o próximo passo. | 1 |
| `triagem` | Em avaliação | `analyzing` | `programada`, `em_execucao`, `cancelada` | A ocorrência {numero} está em avaliação. Se precisarmos de mais informações, entraremos em contato. | 2 |
| `programada` | Atendimento programado | `approved` | `triagem`, `em_execucao`, `cancelada` | O atendimento da ocorrência {numero} foi programado. Consulte os detalhes no acompanhamento. | 3 |
| `em_execucao` | Em execução | `in_progress` | `triagem`, `resolvida`, `cancelada` | A equipe iniciou o atendimento da ocorrência {numero}. | 2 |
| `resolvida` | Solução informada | `ready` | `em_execucao`, `encerrada` | A equipe informou a solução da ocorrência {numero}. Consulte o resultado e avise se o problema continuar. | 3 |
| `encerrada` | Encerrada | `delivered` | — | A ocorrência {numero} foi encerrada. Se houver um novo problema, abra outra ocorrência e informe este número. | 0 |
| `cancelada` | Cancelada | `cancelled` | — | A ocorrência {numero} foi cancelada. O motivo está disponível no acompanhamento. | 0 |

O encerramento exige confirmação do solicitante ou justificativa da equipe. Não ocorre apenas porque o morador deixou de responder.

**Recursos**

| Recurso | Configuração e uso |
|---|---|
| Orçamento com aprovação | Desligado. Cotação de fornecedor e aprovação de despesa são internas. A abertura pelo morador não autoriza débito. |
| Garantia | Desligada. Garantia de fornecedor pode constar em documento interno. |
| Retirada | Desligada. |
| Termos | Ligados, com o texto abaixo. |
| Pessoas ligadas | Solicitante; responsável da manutenção; prestador. A identificação de pessoa mencionada em denúncia fica restrita. |
| Documentos | Evidência do problema: não liberada automaticamente; relatório de atendimento: liberável ao solicitante após revisão; cotação do fornecedor: interna. |
| Lançamentos | Andamento; visita técnica; horas trabalhadas. Cada lançamento nasce interno e pode ter uma versão revisada para o solicitante. |

Texto de aceite:

> Solicito a avaliação desta ocorrência. O registro não autoriza cobrança nem entrada na unidade. Se for necessário acesso ao imóvel, a equipe combinará uma autorização específica comigo. Não inclua documentos pessoais ou informações de outras pessoas sem necessidade.

**Tarefas padrão**

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---|
| `aberta` | Conferir local, categoria e risco imediato | Administração | Imediato |
| `triagem` | Definir responsável e próximo passo | Síndico ou manutenção | 1 dia |
| `programada` | Confirmar horário e eventual acesso à unidade | Manutenção | Imediato; concluir antes da visita |
| `em_execucao` | Registrar serviço realizado e pendências | Manutenção | 1 dia |
| `resolvida` | Conferir resultado com o solicitante | Administração | 2 dias |

### 2.3. Encomenda

| Campo de identificação | Valor |
|---|---|
| Singular | Encomenda |
| Plural | Encomendas |
| ID | `cond-encomenda` |
| Rótulo de Item | Identificação do volume |
| Rótulo de Problema | Observação de recebimento |
| Abertura | Somente portaria |
| Visibilidade padrão | Destinatário identificado. A unidade inteira não recebe acesso automático. |

Não registrar o conteúdo presumido da embalagem. “Caixa pequena” é suficiente para identificar um volume quando não houver código.

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `unidade` | Bloco e unidade | texto | Sim | Sim | Sim |
| `volumes` | Quantidade de volumes | numero | Sim | Sim | Não |
| `transportadora` | Transportadora | texto | Não | Sim | Não |
| `codigo_rastreio` | Código de rastreio | texto | Não | Sim | Sim |
| `local_guarda` | Local de guarda | texto | Sim | Não | Sim |
| `avaria_externa` | Há avaria externa aparente? | sim_nao | Sim | Sim | Não |

`volumes` aceita inteiro de 1 a 20. Quantidade maior exige registros separados ou revisão da configuração. A portaria deve confirmar o destinatário antes de enviar o aviso.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `recebida` | Recebida na portaria | `received` | `avisada`, `retirada`, `devolvida` | — | 1 |
| `avisada` | Morador avisado | `ready` | `retirada`, `devolvida` | Há uma encomenda disponível na portaria. Identificação: {numero}. Consulte as orientações de retirada. | 3 |
| `retirada` | Retirada | `delivered` | — | A retirada da encomenda {numero} foi registrada pela portaria. Se você não reconhece a retirada, fale com a administração. | 0 |
| `devolvida` | Devolvida ao transportador | `cancelled` | — | A devolução da encomenda {numero} ao transportador foi registrada. Consulte a portaria para mais informações. | 0 |

A etapa `avisada` registra a aceitação do envio pelo canal, não a leitura pelo morador. A entrega da mensagem tem estado próprio. O envio e a transição usam a mesma chave de idempotência para evitar avisos duplicados.

Se o envio falhar, a encomenda continua disponível e a equipe recebe uma pendência. Não se deve afirmar que o morador foi avisado.

**Recursos**

| Recurso | Configuração e uso |
|---|---|
| Orçamento, garantia | Desligados. |
| Retirada | Ligada. Um lembrete após 3 dias em `avisada`. Depois, tratamento pela equipe. |
| Termos de abertura | Desligados. A portaria não aceita termos em nome do destinatário. |
| Pessoas ligadas | Destinatário; pessoa autorizada a retirar; porteiro que entregou. |
| Documentos | Foto externa do volume: interna; comprovante de retirada: liberável ao destinatário, com dados de terceiros minimizados. |
| Lançamentos | Recebimento; tentativa de aviso; autorização de retirada; retirada; devolução. |

Texto apresentado ao destinatário antes de autorizar terceiro:

> Autorizo a pessoa identificada nesta solicitação a retirar somente a encomenda indicada. A portaria conferirá a identificação no local. Esta autorização perde a validade após a retirada, o cancelamento ou o prazo informado.

Texto de confirmação presencial:

> Confirmei a identificação de quem retirou e entreguei os volumes registrados nesta encomenda.

O segundo texto é confirmado pelo porteiro identificado. Não exige fotografia de documento nem biometria.

**Tarefas padrão**

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---|
| `recebida` | Conferir destinatário, unidade e volumes | Portaria | Imediato |
| `recebida` | Avisar o destinatário pelo canal autorizado | Portaria ou envio automático validado | Imediato |
| `avisada` | Conferir encomenda ainda não retirada | Portaria | 3 dias |
| `retirada` | Conferir conclusão do comprovante de retirada | Portaria | Imediato |
| `devolvida` | Registrar motivo e identificação do recebimento pelo transportador | Portaria | Imediato |

Lembrete:

> Lembrete: a encomenda {numero} continua disponível na portaria. Se precisar autorizar outra pessoa a retirar, use o acompanhamento ou fale com a portaria.

Não devolver automaticamente por falta de resposta. Prazo e condições de devolução dependem da política aprovada do condomínio.

### 2.4. Visitante ou prestador

| Campo de identificação | Valor |
|---|---|
| Singular | Visitante ou prestador |
| Plural | Visitantes e prestadores |
| ID | `cond-visitante` |
| Rótulo de Item | Nome do visitante ou prestador |
| Rótulo de Problema | Motivo da visita |
| Abertura | Morador autorizado ou portaria em nome dele |
| Visibilidade padrão | Solicitante, autorizador e portaria. |

O nome e o motivo são protegidos. Não aparecem nos avisos enviados pelo WhatsApp nem na IA.

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `unidade` | Bloco e unidade de destino | texto | Sim | Sim | Sim |
| `categoria` | Tipo de acesso | lista: `visita`, `prestador`, `entrega` | Sim | Sim | Não |
| `data_visita` | Data da visita | data | Sim | Sim | Sim |
| `hora_inicio` | Entrada permitida a partir de | texto, `HH:MM` | Sim | Sim | Sim |
| `hora_fim` | Entrada permitida até | texto, `HH:MM` | Sim | Sim | Sim |
| `empresa` | Empresa do prestador | texto | Não | Sim | Sim |
| `placa` | Placa do veículo | texto | Não | Sim | Sim |

A primeira versão admite uma visita por registro e uma janela no mesmo dia. Acessos recorrentes e jornadas que cruzem a meia-noite ficam fora desta versão.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `solicitada` | Solicitação recebida | `received` | `em_conferencia`, `cancelada` | Recebemos a solicitação de acesso {numero}. A entrada ainda depende da autorização e da conferência na portaria. | 1 |
| `em_conferencia` | Em conferência | `analyzing` | `autorizada`, `recusada`, `cancelada` | A solicitação de acesso {numero} está em conferência. | 1 |
| `autorizada` | Autorização registrada | `approved` | `entrada_registrada`, `expirada`, `cancelada` | A autorização {numero} foi registrada para o período informado. A portaria fará a conferência na chegada. | 0 |
| `entrada_registrada` | Entrada registrada | `in_progress` | `saida_registrada` | A portaria registrou a entrada referente à autorização {numero}. | 0 |
| `saida_registrada` | Saída registrada | `delivered` | — | A portaria registrou a saída referente à autorização {numero}. | 0 |
| `recusada` | Não autorizada | `cancelled` | — | A solicitação de acesso {numero} não foi autorizada. Consulte o motivo no acompanhamento. | 0 |
| `expirada` | Autorização expirada | `cancelled` | — | A autorização {numero} venceu sem registro de entrada. Para outro período, faça uma nova solicitação. | 0 |
| `cancelada` | Autorização cancelada | `cancelled` | — | A solicitação de acesso {numero} foi cancelada. | 0 |

A portaria registra entrada e saída reais. O morador autoriza a visita; isso não prova que a pessoa entrou.

Se a janela terminar após uma entrada registrada, gerar tarefa para a portaria. Não registrar saída fictícia nem expulsão automática.

**Recursos**

| Recurso | Configuração e uso |
|---|---|
| Orçamento, garantia, retirada | Desligados. |
| Termos | Ligados, com o texto abaixo. |
| Pessoas ligadas | Solicitante; autorizador da unidade; visitante ou prestador; porteiro. |
| Documentos | Autorização de acesso: recebível pelo solicitante em página autenticada; documentação do prestador: interna, somente quando necessária. |
| Lançamentos | Autorização; conferência; entrada; saída; intercorrência. |

Texto de aceite:

> Solicito o acesso desta pessoa à unidade e ao período informados. Confirmo que tenho autorização para fazer o pedido. A entrada depende da conferência da portaria e das regras vigentes do condomínio. Se houver mudança de pessoa ou de horário, farei uma nova solicitação ou pedirei a revisão.

**Tarefas padrão**

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---|
| `solicitada` | Conferir vínculo do solicitante com a unidade | Portaria | Imediato |
| `em_conferencia` | Conferir autorização e janela de acesso | Portaria | Imediato |
| `autorizada` | Conferir identificação na chegada | Portaria | Na chegada |
| `entrada_registrada` | Registrar saída quando ocorrer | Portaria | Durante a visita |
| `entrada_registrada` | Verificar ausência de registro de saída | Portaria | No fim da janela, se ainda necessário |

### 2.5. Mudança ou obra na unidade

| Campo de identificação | Valor |
|---|---|
| Singular | Mudança ou obra na unidade |
| Plural | Mudanças e obras nas unidades |
| ID | `cond-intervencao` |
| Rótulo de Item | Serviço ou mudança pretendida |
| Rótulo de Problema | Descrição do pedido |
| Abertura | Morador com permissão ou administração em nome dele |
| Visibilidade padrão | Solicitante e administração. A portaria recebe somente a autorização operacional necessária. |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `unidade` | Bloco e unidade | texto | Sim | Sim | Sim |
| `modalidade` | Modalidade | lista: `mudanca_entrada`, `mudanca_saida`, `obra` | Sim | Sim | Não |
| `data_inicio` | Data pretendida de início | data | Sim | Sim | Sim |
| `data_fim` | Data pretendida de término | data | Sim | Sim | Sim |
| `hora_inicio` | Horário diário de início | texto, `HH:MM` | Sim | Sim | Sim |
| `hora_fim` | Horário diário de término | texto, `HH:MM` | Sim | Sim | Sim |
| `usa_elevador` | Precisa reservar elevador? | sim_nao | Sim | Sim | Não |
| `responsavel_tecnico` | Responsável técnico, quando exigido | texto | Não | Sim | Sim |
| `registro_tecnico` | Identificação da ART ou RRT, quando exigida | texto | Não | Sim | Sim |

Os dois últimos campos são exigidos apenas conforme a análise técnica e a regra aplicável. A exigência normativa e o tipo de documento são **a conferir**. O bot não decide se uma intervenção dispensa responsável técnico.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Dias sem mudança |
|---|---|---|---|---|---:|
| `solicitada` | Solicitação recebida | `received` | `em_analise`, `cancelada` | Recebemos a solicitação {numero}. Aguarde a autorização antes de iniciar a mudança ou a obra. | 1 |
| `em_analise` | Em análise | `analyzing` | `ajustes`, `autorizada`, `indeferida`, `cancelada` | A solicitação {numero} está em análise pela administração. | 3 |
| `ajustes` | Aguardando ajustes | `received` | `em_analise`, `cancelada` | Há informações ou documentos pendentes na solicitação {numero}. Consulte as pendências no acompanhamento. | 3 |
| `autorizada` | Autorizada e programada | `approved` | `em_analise`, `em_andamento`, `cancelada` | A solicitação {numero} foi autorizada nas condições registradas. Confira datas, horários e orientações antes de começar. | 0 |
| `em_andamento` | Em andamento | `in_progress` | `em_vistoria` | O início da atividade referente à solicitação {numero} foi registrado. | 7 |
| `em_vistoria` | Em vistoria de conclusão | `ready` | `em_andamento`, `concluida` | A solicitação {numero} está em conferência de conclusão. A equipe verificará as pendências registradas. | 2 |
| `concluida` | Concluída | `delivered` | — | A solicitação {numero} foi concluída. O registro final está disponível no acompanhamento. | 0 |
| `indeferida` | Não autorizada | `cancelled` | — | A solicitação {numero} não foi autorizada. Consulte a justificativa no acompanhamento. | 0 |
| `cancelada` | Cancelada | `cancelled` | — | A solicitação {numero} foi cancelada. | 0 |

Após o início, interrupções são registradas como pendências e lançamentos. O registro não pode ser apagado nem convertido em “nunca ocorreu”.

**Recursos**

| Recurso | Configuração e uso |
|---|---|
| Orçamento, garantia, retirada | Desligados. Taxas eventualmente aprovadas são tratadas no financeiro. |
| Termos | Ligados, com o texto abaixo. |
| Pessoas ligadas | Solicitante; proprietário, quando necessário; empresa executora; responsável técnico; aprovador; vistoriador. |
| Documentos | Plano da intervenção e documentos técnicos: restritos; autorização aprovada: recebível pelo solicitante; vistoria final: recebível após revisão. |
| Lançamentos | Andamento; vistoria; intercorrência; pendência. |

Texto de aceite:

> Solicito a análise da mudança ou obra descrita. A atividade só poderá começar após autorização expressa, dentro das datas, horários e condições aprovados. Comprometo-me a informar alterações de escopo, equipe ou período. Este aceite não substitui documentos técnicos, autorizações de terceiros ou exigências aplicáveis.

**Tarefas padrão**

| Etapa | Tarefa | Responsável | Prazo |
|---|---|---|---|
| `solicitada` | Conferir unidade, modalidade e período | Administração | 1 dia |
| `em_analise` | Conferir documentos e condições de execução | Síndico ou pessoa designada | 2 dias |
| `ajustes` | Conferir resposta às pendências | Administração | 3 dias |
| `autorizada` | Comunicar condições operacionais à portaria | Administração | Imediato |
| `autorizada` | Conferir reserva de elevador ou proteção de áreas comuns | Administração | Antes do início |
| `em_andamento` | Acompanhar pendências da execução | Responsável designado | 1 dia |
| `em_vistoria` | Registrar vistoria de conclusão | Vistoriador | 2 dias |

A mudança pode usar uma unidade reservável “Elevador de serviço” no módulo Reserva. A aprovação só deve ocorrer depois de conferir conflito e vincular a reserva. A orquestração automática dessa vinculação é proposta; sua implementação é **a conferir**.

## 3. Vocabulário

| Conceito | Nome na área |
|---|---|
| Cliente | Morador ou responsável pela unidade |
| Clientes | Moradores e responsáveis |
| Trabalho, no conjunto | Solicitações |
| Responsável | Responsável pelo atendimento |
| Orçamento | Proposta de serviço |
| Unidade habitacional ou comercial | Unidade |
| Unidade do módulo Reserva | Espaço reservável |
| Pessoa que deve pagar | Pagador autorizado |
| Pessoa autorizada a votar | Representante habilitado da unidade |

“Morador”, “pagador” e “representante habilitado” são relações diferentes. Uma não concede automaticamente as permissões da outra.

## 4. Módulos

A identificação técnica de Formulários é `forms`, conforme `src/modules/forms/definition.ts:6`. Cobrança usa `payments`, conforme `src/modules/payments/definition.ts:6`.

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| Ordem de Serviço | Ligado | Quatro tipos deste documento. O tipo embutido permanece intacto. |
| Condomínio | Ligado na fase da extensão | Cadastro, vínculos, autorizações, comunicados segmentados e assembleias. |
| Reserva | Ligado | Salão, churrasqueira e, se necessário, elevador de serviço. |
| Mensalidade | Ligado | Taxa ordinária mensal. Valores aprovados e pagador definidos manualmente. |
| Formulários | Ligado | Enquete consultiva e pedido de atualização cadastral. |
| Cobrança | Ligado | Pix ou link, após configurar a conta de recebimento. |
| Agenda | Desligado | Nenhum serviço ou duração cadastrado. Visitas operacionais ficam nas tarefas. |
| ERP | Desligado inicialmente | Ativação posterior para financeiro, conforme decisão do produto. |
| Pedido, Mesas, Entrega e Suporte | Desligados no modelo novo | Não fazem parte deste atendimento. Em área existente, a prévia deve apontar qualquer desligamento antes de aplicar. |

### Reserva de áreas comuns

Reserva já declara criação e acompanhamento de reservas em `src/modules/reserva/definition.ts:26`. O cadastro admite preço por diária ou hora, em `migrations/0045_reserva.sql:14`.

| Espaço sugerido | Modalidade | Capacidade inicial | Duração | Taxa |
|---|---|---:|---|---|
| Salão | Por hora | 30 pessoas, a confirmar | 1 a 4 horas | Valor por hora definido pela administração |
| Churrasqueira | Por hora | 10 pessoas, a confirmar | 1 a 4 horas | Valor por hora definido pela administração |
| Elevador de serviço | Por hora | Uma utilização por intervalo | 1 a 4 horas | Sem taxa por padrão |

São valores de configuração inicial, não limites de ocupação certificados. Os espaços ficam inativos até revisão.

| Regra | Sugestão |
|---|---|
| Antecedência mínima | 48 horas |
| Horizonte | 60 dias |
| Horários | 08h às 22h, sujeitos ao regimento |
| Cancelamento pelo morador | Até 48 horas antes |
| Lembrete | 24 horas antes |
| Check-in | Aceite das regras; sem documento ou nomes de acompanhantes por padrão |
| Pagamento | Taxa definida manualmente. Se houver pagamento antecipado, informar valor e condição antes de confirmar. |
| Limite por unidade | Uma reserva ativa por espaço e data, como regra nova da extensão |
| Acesso | Exigir vínculo vigente e permissão de reservar |
| Bloqueio por dívida | Não habilitar automaticamente. Regra aplicável: **a conferir**. |

Antecedência, duração, sinal, cancelamento, check-in e lembrete têm campos no contrato atual de Reserva, em `src/modules/reserva/config.ts:23`. Limites por unidade condominial e vinculação com moradores são propostas novas.

Texto inicial para revisão:

> A reserva vale para o espaço, a data e o período confirmados. Respeite a capacidade, os horários e as regras de limpeza e uso publicadas pelo condomínio. O responsável deve comunicar qualquer ocorrência à administração. Taxas, cancelamento e eventual restituição serão apresentados antes da confirmação.

Taxa fixa por evento, caução e cobrança posterior por dano não devem ser simuladas como preço por hora. Sua implementação é **a conferir**.

### Mensalidade e Cobrança

O menu atual oferece consulta e segunda via em `src/modules/mensalidade/definition.ts:24`. A configuração contempla antecedência, aviso no vencimento, avisos de atraso e carência em `src/modules/mensalidade/model.ts:227`.

| Configuração | Sugestão |
|---|---|
| Plano | `cond-taxa-ordinaria` — Taxa condominial ordinária |
| Periodicidade | Mensal |
| Venda pelo WhatsApp | Desligada |
| Valor | Preenchido a partir do valor aprovado para cada unidade; nunca inventado pelo modelo |
| Vencimento | Dia 10 como sugestão a revisar |
| Pagador | Pessoa ou empresa formalmente indicada |
| Antecedência do aviso | 5 dias |
| Aviso no vencimento | Ligado |
| Avisos de atraso | A cada 7 dias, no máximo 2 |
| Negociação, desconto ou baixa manual | Somente financeiro autorizado |
| Segunda via | Reenvio da cobrança existente. Não cria outra obrigação. |
| Rateio variável | Fora do modelo. Valor apurado externamente ou pelo futuro financeiro integrado. |

Não vincular automaticamente todos os telefones de uma unidade ao pagador. Um dependente ou inquilino não deve obter acesso financeiro apenas por estar cadastrado na unidade.

### Formulários

O módulo descreve formulários de texto, escolha, data e aceite; as respostas vão para contato e protocolo, em `src/modules/forms/definition.ts:9`. Portanto, estes formulários não devem coletar informações reservadas sem revisar também esse destino.

| Formulário | Perguntas prontas | Tratamento |
|---|---|---|
| `cond-enquete` — Enquete consultiva | “Qual melhoria você considera prioritária?” Opções: iluminação, limpeza, jardins, outra. “Qual período você prefere para uma reunião informativa?” Opções: manhã, tarde, noite. “Deseja acrescentar uma sugestão? Não inclua nomes ou dados de outras pessoas.” | Resultado agregado. Não vale como votação de assembleia. Não anunciar anonimato sem verificá-lo. |
| `cond-atualizacao` — Solicitar atualização cadastral | “O que precisa atualizar?” Opções: telefone, vínculo com unidade, veículo, animal, outra informação. “Deseja que a administração entre em contato para conferir a alteração?” | Abre solicitação. Não altera cadastro automaticamente. Não pede documento no formulário genérico. |

## 5. WhatsApp

### Árvore do menu

Os tipos atuais de OS constam em `src/modules/os/definition.ts:28`; os de Mensalidade, em `src/modules/mensalidade/definition.ts:24`; os de Reserva, em `src/modules/reserva/definition.ts:26`. A referência ao tipo de trabalho e os itens `cond_*` abaixo são propostas.

| Caminho | Rótulo | Ação |
|---|---|---|
| Principal | Minha unidade | Escolher entre unidades vinculadas ao telefone verificado. |
| Principal → Solicitações | Abrir ocorrência | `os_open`, referência `cond-ocorrencia`. |
| Principal → Solicitações | Minhas ocorrências | `os_track`, referência `cond-ocorrencia`. |
| Principal → Solicitações | Mudança ou obra | `os_open`, referência `cond-intervencao`. |
| Principal → Solicitações | Acompanhar pedido | `os_track`, referência `cond-intervencao`. |
| Principal → Portaria | Minhas encomendas | `os_track`, referência `cond-encomenda`. |
| Principal → Portaria | Autorizar visita | `os_open`, referência `cond-visitante`. |
| Principal → Portaria | Minhas visitas | `os_track`, referência `cond-visitante`. |
| Principal → Portaria | Falar com portaria | Atendimento humano no setor Portaria. |
| Principal → Áreas comuns | Reservar espaço | `reserva`, com validação da unidade. |
| Principal → Áreas comuns | Minhas reservas | `reserva_mine`. |
| Principal → Taxas | Minhas taxas | `mensalidade_list`, limitado ao pagador autorizado. |
| Principal → Taxas | Segunda via | `mensalidade_copy`. |
| Principal → Informações | Comunicados | Lista autenticada dos comunicados destinados ao morador. |
| Principal → Informações | Regimento | Versão vigente e aprovada do documento. |
| Principal → Informações | Enquete consultiva | `form`, referência `cond-enquete`. |
| Principal → Informações | Atualizar cadastro | `form`, referência `cond-atualizacao`. |
| Principal → Informações | Assembleia | Página autenticada de pauta, presença e votação, quando disponível. |
| Principal | Falar com equipe | Atendimento humano na Administração. |

**Saudação**

> Olá! Este é o atendimento do condomínio. Você pode acompanhar solicitações, consultar encomendas, pedir autorização de visita, reservar espaços e acessar suas cobranças autorizadas. Se tiver mais de uma unidade, escolha a unidade antes de continuar. Para falar com a equipe, selecione “Falar com equipe”.

**Telefone ainda não vinculado**

> Este telefone ainda não tem uma unidade confirmada. Vou encaminhar seu pedido à administração para conferência. Não envie documentos pessoais nesta conversa.

**Mais de uma unidade**

> Encontramos mais de uma unidade vinculada a este telefone. Escolha a unidade deste atendimento. A escolha não altera seus outros vínculos.

**Risco imediato**

> Este canal não garante atendimento imediato de emergência. Se houver risco imediato, acione a portaria e o serviço de emergência adequado. Vou sinalizar sua mensagem à equipe.

### O que o morador resolve sozinho

| Ação | Limite |
|---|---|
| Abrir ocorrência | Somente na unidade vinculada ou sobre área comum, como solicitante identificado |
| Acompanhar registros | Somente registros próprios ou expressamente compartilhados |
| Consultar encomenda | Somente como destinatário ou pessoa autorizada |
| Autorizar retirada por terceiro | Para encomenda específica, com validade e confirmação |
| Pedir acesso de visitante | Conforme a permissão do vínculo; entrada real continua com a portaria |
| Pedir mudança ou obra | Envia pedido e documentos; não aprova a própria solicitação |
| Reservar espaço | Dentro das regras e da disponibilidade |
| Obter segunda via | Somente como telefone autorizado do pagador |
| Responder enquete | Consulta não deliberativa |
| Participar da assembleia | Somente após habilitação específica; morar na unidade não basta |
| Enviar documento | Por página autenticada, quando houver pendência |
| Ver tarefas pendentes | Apenas tarefas atribuídas ao próprio morador e marcadas para exibição |

### Mensagens e lembretes complementares

| Evento | Texto |
|---|---|
| Documento pendente | A solicitação {numero} tem uma pendência de documento. Consulte a página de acompanhamento para enviar o arquivo com segurança. |
| Visita próxima | A autorização {numero} está prevista para hoje. Confira o período autorizado no acompanhamento. |
| Mudança ou obra próxima | A atividade da solicitação {numero} está prevista para amanhã. Confira as condições aprovadas e avise a administração se houver alteração. |
| Comunicado geral | Há um novo comunicado do condomínio: {titulo}. Acesse a área de comunicados para ler o conteúdo completo. |
| Comunicado de bloco | Há um novo comunicado destinado ao seu bloco: {titulo}. Acesse a área de comunicados para ler o conteúdo completo. |
| Assembleia convocada | Foi publicada uma convocação de assembleia. Consulte a pauta, a data e as orientações de participação na área de assembleias. |
| Votação disponível | Há uma votação disponível para uma unidade em que você foi habilitado. Abra a área de assembleias para conferir a pauta e registrar sua escolha. |

O título de comunicado deve ser revisado e não conter dívida, acusação ou identificação de morador.

Os comunicados são enviados individualmente. Não criam grupos nem revelam a lista de destinatários. O mecanismo deve congelar o público, eliminar telefones repetidos e registrar falhas. Janela de envio e consentimento da finalidade precisam ser respeitados. O contrato documenta envio fora da janela por modelo e consentimento em `docs/MODULOS.md:128`.

## 6. Bot da área

### Instruções prontas

> Você é o assistente de atendimento do condomínio. Responda em português do Brasil, com frases curtas. Use somente o regimento vigente, os comunicados publicados e os resultados das ferramentas autorizadas. Quando citar uma regra, informe o documento e a seção. Se a regra não estiver disponível ou houver conflito, encaminhe à administração.
>
> Antes de uma ação ligada à unidade, use a seleção validada pelo sistema. Não considere bloco, número, nome, CPF ou telefone digitado como prova de vínculo. Se houver mais de uma unidade, peça a escolha. Se não houver vínculo confirmado, encaminhe à administração.
>
> Mostre somente os registros que a ferramenta autorizar para esta conversa. Compartilhar uma unidade não autoriza consultar todos os moradores, ocorrências, encomendas ou cobranças.
>
> Você pode explicar regras publicadas, mostrar etapas permitidas, abrir o formulário adequado, consultar disponibilidade, encaminhar segunda via autorizada e preparar solicitações para confirmação. Diga “solicitação registrada” quando ainda faltar aprovação. Só diga que uma ação foi concluída depois da confirmação do sistema.
>
> Não leia nem peça documentos pessoais, nomes de visitantes, placas, conteúdo de encomendas, relatos reservados, dados de menores, procurações, justificativas financeiras ou votos individuais. Oriente o envio de informações reservadas pela página autenticada. Se uma mensagem contiver esse conteúdo, encaminhe pelo fluxo protegido, sem reproduzi-lo ou resumi-lo.
>
> Não autorize a entrada de pessoas, não registre entrada ou saída física e não confirme retirada de encomenda. Não aprove obras, exceções ao regimento, multas, descontos, baixas financeiras ou alterações de cadastro. Encaminhe essas decisões à pessoa responsável.
>
> Não use comprovante enviado pelo morador como confirmação de pagamento. Não diga que uma pessoa está habilitada a votar com base no pagamento de outra unidade. Não interprete procurações, não escolha votos e não vote em nome de ninguém.
>
> Enquetes são consultas. Votações deliberativas acontecem somente na área autenticada da assembleia. Não transforme “sim”, “não” ou uma mensagem de voz em voto.
>
> Em relato de risco imediato, informe que este canal não garante resposta emergencial e oriente a acionar a portaria e o serviço de emergência adequado. Sinalize a ocorrência à equipe.
>
> Nunca informe dados de outra unidade, lista de moradores, rotina de presença, ausência de pessoas, localização de chaves, códigos de acesso ou estado financeiro de terceiros.

### Permissões do bot

| Categoria | Ações |
|---|---|
| Faz sem decisão da equipe | Consulta regras publicadas; mostra etapas autorizadas; fornece links autenticados; consulta espaços; encaminha segunda via pelos mecanismos próprios. |
| Exige confirmação do morador | Abertura de solicitação, reserva e pedido de cancelamento permitido. |
| Exige decisão da equipe | Vínculo cadastral; exceção de horário; acesso sem autorização válida; obra; devolução de encomenda; correção de retirada; comunicado; habilitação eleitoral. |
| Nunca executa | Entrada ou saída física; retirada; voto; validação de procuração; decisão de inadimplência eleitoral; baixa ou desconto; aprovação técnica. |
| Nunca lê | Relatos reservados, anexos privados, nomes de visitantes, placas, documentos, dados de menores, procurações, votos individuais e evidências financeiras. |

O texto de instruções não é barreira de segurança. As ferramentas devem receber projeções sem esses dados.

O núcleo separa ferramentas de cliente e equipe em `docs/MODULOS.md:379`. A conversa é fixada pelo sistema e o módulo deve recusar registros de outro cliente, conforme `docs/MODULOS.md:402`. O mecanismo `bot.sensitive` significa exigência de segundo fator para operações; não significa classificação de campo sensível, conforme `src/modules/types.ts:94`.

Para esta área, negar ao catálogo da IA as rotas de cadastro reservado, arquivos privados, procurações, habilitação, votos e auditoria. O recebimento de anexos e relatos reservados deve ser interceptado antes de compor o contexto da IA. A implementação desse isolamento é **a conferir** e condiciona a ativação do bot.

## 7. Equipe

### Setores e categorias de protocolo

| Setor | Categorias |
|---|---|
| Portaria | Encomenda; visitante ou prestador; falha no aviso; divergência de retirada |
| Administração | Cadastro; reserva; comunicado; mudança ou obra; documento |
| Manutenção | Vazamento; elevador; elétrica; limpeza; manutenção geral |
| Síndico | Regimento; ocorrência reservada; autorização excepcional; assembleia |
| Financeiro | Segunda via; divergência de cobrança; pagamento em conferência |

O setor direciona o atendimento. Não concede, sozinho, acesso a dados.

### Papéis propostos da extensão

| Papel | Lê | Faz | Restrições |
|---|---|---|---|
| `condominio:portaria` | Encomendas, visitas válidas e condições operacionais de mudanças | Registra recebimento, retirada, entrada, saída e intercorrência | Sem financeiro, votos, procurações ou documentos técnicos completos |
| `condominio:administracao` | Cadastro e solicitações necessárias ao atendimento | Confere vínculos, prepara comunicados, organiza reservas e documentos | Não vota pelo morador nem dá baixa financeira |
| `condominio:manutencao` | Ocorrências atribuídas e informação mínima de acesso | Atualiza execução, tarefas e relatório | Sem cadastro geral e financeiro |
| `condominio:sindico` | Solicitações e documentos necessários à gestão | Decide exceções e intervenções; aprova comunicados | Dados financeiros dependem de acesso financeiro separado |
| `condominio:financeiro` | Vinculações de cobrança e dados financeiros autorizados | Confere cobrança e produz evidência de situação por unidade | Sem poder de alterar voto ou entrada física |
| `condominio:mesa` | Pauta, presença, poderes de representação e habilitação | Abre e fecha rodadas; homologa apuração | Não altera votos nem recebe extrato financeiro detalhado |
| `condominio:auditoria` | Registros de auditoria e exportação autorizada | Consulta e verifica | Somente leitura; acesso nominal a voto exige finalidade específica |

Papéis de módulo já fazem parte do contrato, em `src/modules/types.ts:85`. O papel atual de OS é “Técnico”, em `src/modules/os/definition.ts:61`; ele não deve ser reutilizado para liberar todos os dados de condomínio.

O contrato atual registra que administradores acessam tudo em `docs/MODULOS.md:669`. Por isso, o porteiro não deve receber o papel administrativo global. Separação mais forte entre administrador técnico e dados reservados é **a conferir** no contrato central.

Para administradora com vários condomínios, a proposta é **uma área por condomínio**. Autorizações, consultas, arquivos e relatórios devem ser limitados por `profile_id`. A atribuição diferenciada de papéis por condomínio precisa ser validada antes de prometer isolamento entre carteiras da mesma administradora.

## 8. Passos manuais depois de aplicar o modelo

| Ordem | Passo | Responsável |
|---:|---|---|
| 1 | Confirmar que a área representa apenas um condomínio e revisar quais módulos serão desligados | Administrador |
| 2 | Cadastrar blocos e unidades. Usar “Bloco único” quando não houver blocos | Administração |
| 3 | Conferir frações ideais com a documentação oficial | Administração e responsável jurídico |
| 4 | Cadastrar pessoas, empresas, vínculos e períodos. Conferir proprietários, inquilinos e representantes | Administração |
| 5 | Confirmar os telefones e suas permissões. Não importar telefone como vínculo automaticamente | Administração |
| 6 | Vincular pagador e assinatura a cada unidade. Conferir cobranças já existentes para evitar duplicidade | Financeiro |
| 7 | Configurar conta de recebimento, valores, vencimentos e condições | Financeiro |
| 8 | Revisar espaços reserváveis, capacidade, horários, taxas e cancelamento antes de ativá-los | Síndico |
| 9 | Publicar regimento e convenção vigentes, com versão e data. Selecionar a fonte que o bot poderá consultar | Síndico |
| 10 | Definir horários de obra, mudança, visitas, retirada e procedimento para urgências | Síndico e portaria |
| 11 | Distribuir papéis. Revisar especialmente administradores globais e contas compartilhadas | Administrador |
| 12 | Aprovar aviso de privacidade, finalidades de contato, prazos de guarda e tratamento de dependentes menores | Responsável pelo tratamento |
| 13 | Configurar modelos de mensagem e contatos para falhas de entrega | Administração |
| 14 | Conferir os quatro fluxos com dados fictícios antes da operação real | Equipe |
| 15 | Para cada assembleia, aprovar convocação, pauta, quórum, forma de representação e regra de votação | Síndico e mesa |

No modo sem extensão, a unidade fica como informação textual e sua conferência é manual. Esse modo não entrega cadastro confiável por unidade, segmentação automática por bloco ou assembleia. A ligação de visitantes e encomendas a moradores deve ser conferida pela equipe.

## 9. Extensão Condomínio

### 9.1. Escopo e arquitetura

| O modelo sozinho entrega | A extensão acrescenta |
|---|---|
| Formulários e etapas de ocorrências, encomendas, visitas e intervenções | Cadastro oficial de blocos, unidades e vínculos |
| Unidade como informação do registro | Validação de unidade a partir do telefone verificado |
| Encaminhamento para portaria e administração | Permissões por vínculo e por registro |
| Reserva e cobrança nos módulos existentes | Vinculação da reserva e da cobrança à unidade |
| Mensagens individuais de acompanhamento | Comunicados para todo o condomínio ou para um bloco |
| Enquete consultiva | Assembleia, pauta, presença, procuração, habilitação e voto por unidade |
| Documentos dos trabalhos | Documentos institucionais e evidências de representação |

Identificador proposto: `condominio`. Dependência obrigatória: `requires: ["os"]`.

O contrato exige declarar dependências quando houver importação de `public.ts` e proíbe acesso direto às tabelas de outro módulo, em `docs/MODULOS.md:101`. Assim:

| Integração | Contrato proposto |
|---|---|
| Motor OS | Expor contrato público para criar, consultar e mover etapas, validar acesso e registrar histórico. |
| Mensalidade | Consultar por API autorizada, com vínculo explícito à assinatura. Não importar arquivos internos nem consultar suas tabelas diretamente. |
| Reserva | Consultar e operar pela API autorizada; persistir a relação entre reserva e unidade condominial na extensão. |
| ERP | Futuro contrato de integração. Não gravar diretamente nas tabelas do ERP. |
| Mensagens | Usar o mecanismo de envio do núcleo, com idempotência e regras do canal. |
| Arquivos | Usar o R2 existente, por rotas autenticadas. |
| Agendamento | Usar o Coordinator e os ganchos periódicos existentes. |

Os vínculos configurados hoje incluem D1 `DB`, R2 `MEDIA` e a classe `Coordinator`, em `wrangler.jsonc:13`. A proposta não adiciona serviço, bucket ou classe de Durable Object.

### 9.2. Regras de cadastro e identidade

| Regra | Comportamento |
|---|---|
| Um condomínio por área | `profile_id` é obrigatório em todas as tabelas e consultas. |
| Telefone e unidade | Telefone verificado → pessoa → vínculos vigentes → unidades disponíveis. |
| Várias unidades | O mesmo telefone pode acessar várias unidades por meio dos vínculos da mesma pessoa. |
| Telefone compartilhado | Não fundir identidades. Exigir conferência e restringir funções pessoais, especialmente voto. |
| Proprietário não residente | Pode ter vínculo de proprietário sem residir na unidade. |
| Copropriedade | Vários proprietários são permitidos. Isso não multiplica o voto da unidade. |
| Inquilino | Tem permissões operacionais configuradas. Direito de votar depende de habilitação específica. |
| Dependente | Não recebe autorização financeira ou eleitoral automaticamente. |
| Empresa | Pode ser titular de vínculo. A ação autenticada deve identificar uma pessoa física representante e sua evidência de poderes. |
| Período | Usar início inclusivo e fim exclusivo. Vínculo encerrado não autoriza novas ações. |
| Mudança de ocupante | Encerrar vínculo anterior, revisar telefones e autorizações futuras. Não transferir histórico privado ao novo ocupante. |
| Histórico próprio | Ex-morador pode receber acesso excepcional a registro próprio por fluxo revisado. Não manter acesso geral ao condomínio. |
| Revogação | Revalidar vínculos a cada leitura, download e comando; não confiar apenas na seleção anterior da unidade. |
| Veículo e animal | Pertencem à unidade, com responsável indicado. Não são documentos de autorização de acesso. |

O contrato do núcleo determina que a identidade por telefone venha de `verifiedPhone(c)`, não de identificador livre, em `docs/MODULOS.md:124`.

### 9.3. DDL SQLite proposto

DDL exclusivamente aditivo. Não altera nem recria tabelas atuais. Os nomes de migração serão definidos na implementação.

Datas operacionais usam inteiro em milissegundos UTC. A interface apresenta o fuso configurado. Campos JSON são validados pela aplicação. As chaves externas compostas impedem relacionamentos entre áreas nas tabelas da extensão.

Os IDs de OS, Reserva e Mensalidade são referências externas. Sua existência e seu `profile_id` devem ser conferidos pela API do módulo dono. Não há escrita direta nesses módulos.

```sql
CREATE TABLE cond_settings (
  profile_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE cond_blocks (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, name)
);

CREATE TABLE cond_units (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  number TEXT NOT NULL,
  use_kind TEXT NOT NULL
    CHECK (use_kind IN ('residencial','comercial','mista')),
  fraction_ppb INTEGER
    CHECK (fraction_ppb > 0 AND fraction_ppb <= 1000000000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, block_id, number),
  FOREIGN KEY (profile_id, block_id)
    REFERENCES cond_blocks(profile_id, id)
);

CREATE TABLE cond_people (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pessoa','empresa')),
  name TEXT NOT NULL,
  is_minor INTEGER NOT NULL DEFAULT 0 CHECK (is_minor IN (0,1)),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE TABLE cond_files (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('rascunho','aprovado','revogado')),
  customer_can_receive INTEGER NOT NULL DEFAULT 0
    CHECK (customer_can_receive IN (0,1)),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, object_key),
  FOREIGN KEY (profile_id, supersedes_id)
    REFERENCES cond_files(profile_id, id)
);

CREATE TABLE cond_memberships (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('proprietario','inquilino','dependente','responsavel_empresa')
  ),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  proof_file_id TEXT,
  verified_at INTEGER,
  verified_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, unit_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, person_id)
    REFERENCES cond_people(profile_id, id),
  FOREIGN KEY (profile_id, proof_file_id)
    REFERENCES cond_files(profile_id, id)
);

CREATE TABLE cond_phones (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  verified_at INTEGER NOT NULL,
  verified_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (profile_id, person_id)
    REFERENCES cond_people(profile_id, id)
);

CREATE UNIQUE INDEX cond_phones_current
  ON cond_phones(profile_id, phone)
  WHERE ends_at IS NULL;

CREATE TABLE cond_vehicles (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  responsible_person_id TEXT NOT NULL,
  plate TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  PRIMARY KEY (profile_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, responsible_person_id)
    REFERENCES cond_people(profile_id, id)
);

CREATE TABLE cond_animals (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  responsible_person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  species TEXT NOT NULL,
  breed TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  PRIMARY KEY (profile_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, responsible_person_id)
    REFERENCES cond_people(profile_id, id)
);

CREATE TABLE cond_work_units (
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  requester_membership_id TEXT,
  recipient_membership_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, order_id),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, unit_id, requester_membership_id)
    REFERENCES cond_memberships(profile_id, unit_id, id),
  FOREIGN KEY (profile_id, unit_id, recipient_membership_id)
    REFERENCES cond_memberships(profile_id, unit_id, id)
);

CREATE TABLE cond_reservation_links (
  profile_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  order_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, booking_id),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, unit_id, membership_id)
    REFERENCES cond_memberships(profile_id, unit_id, id)
);

CREATE TABLE cond_billing_links (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  charge_kind TEXT NOT NULL CHECK (charge_kind IN ('ordinaria','outra')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  created_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, subscription_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id)
);

CREATE UNIQUE INDEX cond_billing_current_ordinary
  ON cond_billing_links(profile_id, unit_id)
  WHERE ends_at IS NULL AND charge_kind = 'ordinaria';

CREATE TABLE cond_assemblies (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('rascunho','convocada','em_andamento','encerrada','cancelada')
  ),
  first_call_at INTEGER NOT NULL,
  second_call_at INTEGER,
  notice_file_id TEXT,
  minutes_file_id TEXT,
  rules_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, notice_file_id)
    REFERENCES cond_files(profile_id, id),
  FOREIGN KEY (profile_id, minutes_file_id)
    REFERENCES cond_files(profile_id, id)
);

CREATE TABLE cond_agenda_items (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assembly_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  proposal_text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, assembly_id, id),
  UNIQUE (profile_id, assembly_id, position),
  FOREIGN KEY (profile_id, assembly_id)
    REFERENCES cond_assemblies(profile_id, id)
);

CREATE TABLE cond_proxies (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assembly_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  grantor_membership_id TEXT NOT NULL,
  representative_person_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  agenda_scope_json TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pendente','aprovada','recusada','revogada')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (profile_id, id),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (profile_id, assembly_id)
    REFERENCES cond_assemblies(profile_id, id),
  FOREIGN KEY (profile_id, unit_id, grantor_membership_id)
    REFERENCES cond_memberships(profile_id, unit_id, id),
  FOREIGN KEY (profile_id, representative_person_id)
    REFERENCES cond_people(profile_id, id),
  FOREIGN KEY (profile_id, file_id)
    REFERENCES cond_files(profile_id, id)
);

CREATE TABLE cond_attendance (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assembly_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  left_at INTEGER,
  method TEXT NOT NULL CHECK (method IN ('presencial','remota')),
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  CHECK (left_at IS NULL OR left_at >= entered_at),
  FOREIGN KEY (profile_id, assembly_id)
    REFERENCES cond_assemblies(profile_id, id),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, person_id)
    REFERENCES cond_people(profile_id, id)
);

CREATE UNIQUE INDEX cond_attendance_open
  ON cond_attendance(profile_id, assembly_id, unit_id, person_id)
  WHERE left_at IS NULL;

CREATE TABLE cond_vote_rounds (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assembly_id TEXT NOT NULL,
  agenda_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL
    CHECK (status IN ('preparacao','aberta','fechada','anulada')),
  rules_snapshot_json TEXT NOT NULL,
  agenda_snapshot_json TEXT NOT NULL,
  opened_at INTEGER,
  closes_at INTEGER,
  closed_at INTEGER,
  result_json TEXT,
  homologated_by TEXT,
  homologated_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, agenda_id, sequence),
  FOREIGN KEY (profile_id, assembly_id, agenda_id)
    REFERENCES cond_agenda_items(profile_id, assembly_id, id)
);

CREATE TABLE cond_electorate (
  profile_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  voter_person_id TEXT,
  principal_membership_id TEXT,
  proxy_id TEXT,
  eligible INTEGER NOT NULL CHECK (eligible IN (0,1)),
  reason_code TEXT NOT NULL,
  debt_state TEXT NOT NULL
    CHECK (debt_state IN ('regular','pendente','desconhecida')),
  financial_evidence_json TEXT NOT NULL DEFAULT '{}',
  weight_integer INTEGER NOT NULL CHECK (weight_integer > 0),
  presence_snapshot_json TEXT NOT NULL,
  qualified_at INTEGER NOT NULL,
  qualified_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, round_id, unit_id),
  CHECK (eligible = 0 OR voter_person_id IS NOT NULL),
  FOREIGN KEY (profile_id, round_id)
    REFERENCES cond_vote_rounds(profile_id, id),
  FOREIGN KEY (profile_id, unit_id)
    REFERENCES cond_units(profile_id, id),
  FOREIGN KEY (profile_id, voter_person_id)
    REFERENCES cond_people(profile_id, id),
  FOREIGN KEY (profile_id, unit_id, principal_membership_id)
    REFERENCES cond_memberships(profile_id, unit_id, id),
  FOREIGN KEY (profile_id, proxy_id)
    REFERENCES cond_proxies(profile_id, id)
);

CREATE TABLE cond_votes (
  profile_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  voter_person_id TEXT NOT NULL,
  choice_key TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  cast_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, round_id, unit_id),
  UNIQUE (profile_id, receipt_id),
  UNIQUE (profile_id, idempotency_key),
  FOREIGN KEY (profile_id, round_id, unit_id)
    REFERENCES cond_electorate(profile_id, round_id, unit_id),
  FOREIGN KEY (profile_id, voter_person_id)
    REFERENCES cond_people(profile_id, id)
);

CREATE TABLE cond_notices (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('condominio','bloco')),
  block_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('rascunho','aprovado','enviando','concluido','cancelado')),
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  CHECK (
    (audience = 'condominio' AND block_id IS NULL)
    OR (audience = 'bloco' AND block_id IS NOT NULL)
  ),
  FOREIGN KEY (profile_id, block_id)
    REFERENCES cond_blocks(profile_id, id)
);

CREATE TABLE cond_notice_deliveries (
  profile_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  recipient_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pendente','enviada','entregue','falhou','cancelada')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  provider_message_id TEXT,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, notice_id, phone),
  FOREIGN KEY (profile_id, notice_id)
    REFERENCES cond_notices(profile_id, id)
);

CREATE TABLE cond_audit (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE TABLE cond_retention_holds (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX cond_memberships_person
  ON cond_memberships(profile_id, person_id, starts_at, ends_at);
CREATE INDEX cond_memberships_unit
  ON cond_memberships(profile_id, unit_id, ends_at);
CREATE INDEX cond_phones_person
  ON cond_phones(profile_id, person_id, ends_at);
CREATE INDEX cond_vehicles_unit
  ON cond_vehicles(profile_id, unit_id, ends_at);
CREATE INDEX cond_animals_unit
  ON cond_animals(profile_id, unit_id, ends_at);
CREATE INDEX cond_work_units_unit
  ON cond_work_units(profile_id, unit_id, order_id);
CREATE INDEX cond_reservations_unit
  ON cond_reservation_links(profile_id, unit_id);
CREATE INDEX cond_proxies_assembly
  ON cond_proxies(profile_id, assembly_id, unit_id, status);
CREATE INDEX cond_attendance_assembly
  ON cond_attendance(profile_id, assembly_id, unit_id);
CREATE INDEX cond_rounds_due
  ON cond_vote_rounds(profile_id, status, closes_at);
CREATE INDEX cond_electorate_voter
  ON cond_electorate(profile_id, voter_person_id, round_id);
CREATE INDEX cond_deliveries_due
  ON cond_notice_deliveries(profile_id, status, next_attempt_at);
CREATE INDEX cond_audit_resource
  ON cond_audit(profile_id, resource_kind, resource_id, created_at);
CREATE INDEX cond_holds_resource
  ON cond_retention_holds(profile_id, resource_kind, resource_id, released_at);
```

**Validações que o DDL não substitui**

| Validação | Regra |
|---|---|
| Períodos de telefone | Não permitir atribuições sobrepostas do mesmo telefone a pessoas diferentes. |
| Vínculo vigente | Validar início, fim, verificação e permissões antes de agir. |
| Representação | Conferir se representante, procuração, unidade e pauta pertencem ao mesmo contexto. |
| Referência de arquivo | Só permitir arquivos da mesma área e autorizados para aquela finalidade. |
| Cadastro de criança | Sem telefone próprio, CPF, documento ou data de nascimento por padrão. Representação pelo responsável. |
| Frações ideais | Conferir escala, soma e documento de origem. Não arredondar ou redistribuir automaticamente. |
| Voto | Conferir opção da pauta, eleitor habilitado, presença aplicável, prazo e rodada aberta. |
| Alterações concorrentes | Usar versão esperada e comando serializado. |
| Referências a módulos | Validar pelo módulo dono e pela área. |
| Avisos | Confirmar finalidade e vínculo antes do envio, mesmo após a geração da lista. |

### 9.4. Rotas propostas

Prefixo de equipe: `/api/v1/profiles/{profile}/condominio`.

Todas as rotas abaixo são novas. Os nomes são parte da proposta, não descrição de implementação existente.

| Método e rota | Finalidade | Quem pode usar |
|---|---|---|
| `GET /settings` e `PUT /settings` | Regras da extensão, documentos vigentes e política de guarda | Administração autorizada |
| `GET /blocks`, `POST /blocks`, `PATCH /blocks/{id}` | Cadastrar e arquivar blocos | Administração |
| `GET /units`, `POST /units`, `PATCH /units/{id}` | Cadastrar unidades e frações | Administração; alteração de fração exige revisão |
| `GET /people`, `POST /people`, `PATCH /people/{id}` | Pessoas e empresas | Administração |
| `POST /people/{id}/phones` | Registrar telefone após conferência | Administração |
| `POST /phones/{id}/end` | Encerrar autorização do telefone | Administração |
| `GET /units/{id}/memberships`, `POST /units/{id}/memberships` | Consultar e propor vínculo | Administração |
| `POST /memberships/{id}/verify` e `POST /memberships/{id}/end` | Confirmar ou encerrar vínculo | Administração |
| `GET /units/{id}/vehicles`, `POST /units/{id}/vehicles`, `PATCH /vehicles/{id}` | Veículos da unidade | Administração; portaria recebe projeção mínima |
| `GET /units/{id}/animals`, `POST /units/{id}/animals`, `PATCH /animals/{id}` | Animais da unidade | Administração |
| `POST /work-links` | Vincular trabalho e unidade após conferência | Motor e equipe autorizada |
| `GET /portaria` | Visão de encomendas, visitas e atividades do período | Portaria |
| `POST /works/{id}/authorize` | Registrar autorização válida | Morador habilitado ou equipe competente, conforme o tipo |
| `POST /works/{id}/entry` e `POST /works/{id}/exit` | Registrar presença física | Portaria |
| `POST /works/{id}/pickup` | Registrar retirada | Portaria |
| `GET /units/{id}/billing-links`, `POST /units/{id}/billing-links` | Vincular assinatura e pagador | Financeiro |
| `POST /billing-links/{id}/end` | Encerrar vínculo financeiro | Financeiro |
| `POST /files` e `GET /files/{id}/content` | Enviar e receber arquivo com autorização | Conforme finalidade e recurso pai |
| `POST /files/{id}/approve` | Aprovar versão institucional | Síndico ou pessoa designada |
| `GET /notices`, `POST /notices`, `PATCH /notices/{id}` | Preparar comunicados | Administração |
| `POST /notices/{id}/approve` e `POST /notices/{id}/send` | Aprovar público e iniciar envio | Síndico ou pessoa designada |
| `GET /assemblies`, `POST /assemblies`, `PATCH /assemblies/{id}` | Preparar assembleia | Síndico e mesa |
| `POST /assemblies/{id}/publish` | Publicar convocação conferida | Síndico e mesa |
| `POST /assemblies/{id}/agenda` e `PATCH /agenda/{id}` | Preparar pauta e regras | Mesa, antes de abrir votação |
| `POST /assemblies/{id}/proxies` | Receber procuração | Pessoa autorizada ou administração |
| `POST /proxies/{id}/review` e `POST /proxies/{id}/revoke` | Conferir ou revogar poderes | Mesa |
| `POST /assemblies/{id}/attendance` e `POST /attendance/{id}/leave` | Registrar presença e saída | Mesa; participante por fluxo autenticado |
| `POST /agenda/{id}/rounds` | Preparar rodada com regras e opções congeladas | Mesa |
| `POST /rounds/{id}/qualify` | Preparar e revisar eleitorado | Mesa, com evidência financeira do papel competente |
| `POST /rounds/{id}/open` | Abrir rodada | Mesa |
| `POST /rounds/{id}/close` e `POST /rounds/{id}/annul` | Encerrar ou anular com justificativa | Mesa |
| `GET /rounds/{id}/results` e `POST /rounds/{id}/homologate` | Apurar e homologar | Mesa; resultado publicado para participantes |
| `GET /audit` | Consultar auditoria | Auditoria autorizada |
| `POST /retention-holds` e `POST /retention-holds/{id}/release` | Preservação por obrigação ou litígio | Responsável autorizado |

Prefixo do morador: `/api/v1/profiles/{profile}/condominio/me`. Exige sessão ou credencial curta vinculada ao telefone verificado.

| Método e rota | Finalidade | Limite |
|---|---|---|
| `GET /units` | Escolher unidade | Apenas vínculos vigentes |
| `GET /works` | Acompanhar solicitações | Apenas registros autorizados |
| `GET /tasks` | Consultar pendências | Apenas tarefas destinadas à pessoa |
| `GET /notices` | Ler comunicados | Público do condomínio ou bloco autorizado |
| `GET /assemblies` | Consultar assembleias | Conforme vínculo e público da convocação |
| `POST /assemblies/{id}/presence` | Confirmar presença remota | Autenticação; não equivale a habilitação |
| `POST /assemblies/{id}/proxies` | Enviar procuração | Recebimento pendente de conferência |
| `GET /rounds/{id}/ballot?unit_id={id}` | Ler cédula e condição de participação | Somente unidade autorizada |
| `POST /rounds/{id}/votes` | Registrar escolha | Pessoa habilitada, unidade e rodada explícitas |
| `GET /votes/{receipt_id}` | Consultar recibo | Somente autor ou auditor autorizado |

Nenhuma rota aceita `phone` enviado no corpo como prova de identidade. IDs fora do alcance do ator retornam resposta sem revelar a existência do registro.

### 9.5. Assembleia e votação por unidade

As opções abaixo são capacidades do produto. Não são afirmações sobre sua validade para qualquer condomínio. A aplicação do Código Civil, da convenção, do regimento e das regras de assembleia eletrônica é **a conferir** com o responsável jurídico.

| Etapa | Regra |
|---|---|
| Preparação | Cadastrar convocação, datas, modalidade, pauta, opções e regras de quórum. |
| Convocação | Congelar documento e público. Registrar envio e falhas. Entrega pelo WhatsApp, isoladamente, não é tratada como prova suficiente de convocação válida. |
| Presença | Registrar pessoa, unidade, forma de participação e período. Presença não equivale a direito de voto. |
| Representação | Conferir proprietário, representante de empresa ou procurador. Coproprietários resolvem a representação da unidade antes da votação. |
| Procuração | Registrar outorgante, unidade, representante, assembleia, pautas abrangidas, validade, documento e revisão humana. |
| Habilitação | Definir exatamente uma pessoa votante por unidade e rodada. |
| Abertura | Congelar texto da pauta, opções, pesos, eleitorado, quórum e evidência de situação financeira. |
| Voto | Exibir unidade, pauta e escolha. Exigir confirmação explícita na página autenticada. |
| Fechamento | Impedir novos votos pelo horário do servidor, mesmo se o processamento periódico estiver atrasado. |
| Apuração | Calcular resultados com o retrato congelado. |
| Homologação | Mesa confere quórum, resultado e ocorrências. Publicar ata ou resultado autorizado. |
| Correção | Anular rodada com motivo e abrir outra. Não editar voto nem recalcular silenciosamente com novas regras. |

**Regras configuráveis**

| Opção | Valores e comportamento |
|---|---|
| Peso | `unidade`: peso 1. `fracao_ideal`: inteiro proporcional à fração documental, na escala de 1 bilhão. |
| Situação financeira | `nao_aplicar` ou `exigir_regularidade`. A escolha depende de validação jurídica e deve constar da regra aprovada. |
| Situação desconhecida | Sempre exige revisão. Não equivale automaticamente a regularidade nem a dívida. |
| Data de referência | Definida na regra da rodada e guardada na evidência. |
| Quórum de instalação | Definido para a convocação pertinente. |
| Quórum de aprovação | Por pauta, com numerador, denominador e relação explícitos: `>` ou `>=`. |
| Denominador | Unidades totais, peso total, presentes habilitados ou votos válidos, conforme regra aprovada. |
| Abstenção | Opção explícita. Sua inclusão no denominador deve ser definida. |
| Empate | Não aprovar automaticamente. Encaminhar conforme a regra previamente definida. |
| Retificação de voto | Desligada na primeira versão. Voto confirmado é imutável. |
| Voto secreto | Fora da primeira versão. O sistema guarda relação entre unidade, pessoa e voto para auditoria restrita. |
| Várias unidades | A mesma pessoa pode votar por unidades diferentes quando estiver habilitada em cada uma. Cada unidade recebe cédula e recibo próprios. |

A soma de frações precisa ser conferida antes de usar o peso por fração ideal. Nenhuma unidade sem fração válida participa desse cálculo por estimativa.

**Situação financeira por unidade**

A função atual `situationByPhone` escolhe a situação mais favorável entre pagadores do telefone, em `src/modules/mensalidade/public.ts:153`. A situação do pagador também considera assinaturas e carência, em `src/modules/mensalidade/public.ts:104` e `src/modules/mensalidade/public.ts:125`.

Esse resultado não pode ser usado diretamente para habilitação eleitoral.

A extensão deve considerar as obrigações atribuídas à unidade, a regra aprovada e a data de referência. A consulta pública necessária por assinatura e competência é **a conferir**. Até existir contrato suficiente, a habilitação financeira exige revisão humana documentada. Não se deve concluir que uma unidade está regular porque o mesmo telefone pagou a taxa de outra.

**Concorrência e unicidade**

| Situação | Tratamento |
|---|---|
| Duas pessoas tentam votar pela mesma unidade | A chave de `(profile_id, round_id, unit_id)` admite um único voto. A segunda tentativa recebe conflito. |
| Reenvio da mesma requisição | Retornar o mesmo recibo, se o conteúdo for idêntico. |
| Mesma chave com outra escolha | Recusar. |
| Voto após o prazo | Recusar pelo horário do servidor. |
| Procuração revogada durante a rodada | Suspender novas ações da representação e encaminhar à mesa. Se afetar a integridade da rodada, anular e refazer. |
| Dívida contestada ou pagamento tardio | Não alterar eleitorado aberto silenciosamente. Encaminhar à mesa para tratamento documentado. |
| Pauta alterada após abertura | Criar nova rodada e preservar a anterior. |
| Falha durante a gravação | Voto, recibo e auditoria devem ser gravados atomicamente. Notificação vem depois. |

### 9.6. Privacidade, leitura e guarda

| Informação | Leitura permitida |
|---|---|
| Cadastro de unidade | Administração; morador vê apenas seus vínculos e dados autorizados |
| Telefones | Administração e fluxos determinísticos de comunicação |
| Veículos | Administração; portaria vê somente o necessário à conferência |
| Animais | Administração e responsável autorizado; sem prontuário veterinário |
| Ocorrência reservada | Solicitante e equipe designada |
| Visita | Solicitante, autorizador e portaria, durante a finalidade |
| Documento técnico | Administração e analista designado |
| Cobrança | Pagador autorizado e financeiro |
| Procuração | Outorgante, representante e mesa autorizada |
| Evidência de inadimplência | Financeiro e revisão restrita. A mesa recebe o resultado necessário à habilitação |
| Voto individual | Autor e auditoria eleitoral restrita |
| Resultado publicado | Público autorizado da assembleia, preferencialmente agregado |
| Logs de acesso | Auditoria autorizada |

O sinalizador `customer_can_receive` é necessário, mas não suficiente. O servidor também verifica o vínculo com o recurso, a finalidade, o papel, a vigência e eventual revogação.

Arquivos não recebem URL pública permanente. O download passa por autorização. Cada leitura de procuração, documento reservado e exportação eleitoral gera auditoria. URLs, conteúdo de documentos e votos não devem aparecer em logs comuns.

**Política inicial de guarda para decisão**

Os períodos abaixo são propostas operacionais. Não são prazos legais confirmados.

| Classe | Proposta inicial | Pendência |
|---|---|---|
| Visitas e registros de acesso | 90 dias após a saída | Validar necessidade e obrigações aplicáveis |
| Encomendas e comprovantes | 180 dias após retirada ou devolução | Validar tratamento de reclamações |
| Veículos e animais | Enquanto houver vínculo; revisão de descarte 90 dias depois | Validar finalidade e necessidade histórica |
| Ocorrências comuns | 24 meses após encerramento | Separar reclamação, sinistro e litígio |
| Obras e documentos técnicos | Política específica por classe documental | Prazo **a conferir** antes da ativação |
| Financeiro | Política do módulo financeiro e das obrigações aplicáveis | Prazo **a conferir** |
| Convocação, procuração, presença, voto e ata | Política eleitoral aprovada | Prazo **a conferir**; nenhuma eliminação automática antes dessa definição |
| Auditoria e comprovantes de envio | Conforme a classe do registro auditado | Evitar cópia desnecessária de conteúdo pessoal |

Preservação por obrigação ou litígio suspende a eliminação dos registros relacionados. A liberação exige responsável identificado. A política deve cobrir D1, R2, exportações, cópias e registros de envio.

A LGPD, o Código Civil e as regras aplicáveis a crianças e adolescentes são **a conferir** para base legal, informação aos titulares, representação e guarda. Aceite do fluxo operacional não deve ser apresentado como consentimento genérico para todo tratamento.

### 9.7. Comunicados

| Regra | Comportamento |
|---|---|
| Público geral | Pessoas com vínculo vigente e finalidade de comunicação habilitada |
| Público de bloco | Pessoas com vínculo vigente em unidade do bloco |
| Proprietário não residente | Pode receber, conforme finalidade configurada |
| Dependente menor | Comunicação pelo responsável, por padrão |
| Vários vínculos no público | Um envio por telefone para o mesmo comunicado |
| Aprovação | Pessoa autorizada revisa conteúdo, público e quantidade de destinatários |
| Rascunho | Não dispara mensagens |
| Alteração após aprovação | Invalida aprovação e exige nova revisão |
| Falha | Tentativa controlada, com limite e pendência visível |
| Conteúdo financeiro individual | Nunca é comunicado coletivo |
| Conteúdo reservado | Não entra em título nem resumo de mensagem |

### 9.8. Dinheiro, ERP e limites

Rateio de despesas, prestação de contas, conciliação, balancete e contabilidade ficam fora da extensão.

A ligação futura com o ERP deve usar referência de área, unidade, competência e origem. Cada lançamento precisa de chave de idempotência. O condomínio apenas identifica a origem; o financeiro define obrigação, pagamento, estorno e classificação.

Não criar cópia paralela do saldo no cadastro de unidade. Não alterar uma cobrança porque o morador enviou comprovante. O contrato de bot já diferencia comprovante de confirmação financeira em `docs/MODULOS.md:413`.

A separação das telas e permissões do ERP para esse perfil não foi inspecionada: **a conferir**.

| Fora da primeira versão | Motivo |
|---|---|
| Catraca, fechadura ou portão automático | Exige integração física e regras próprias |
| Reconhecimento facial e biometria | Fora do escopo de cadastro mínimo |
| Leitura de câmeras | Fora do atendimento proposto |
| Acesso recorrente permanente de prestador | Exige política e revogação específicas |
| Apuração de eleição complexa com várias cadeiras | Exige regra própria além de uma escolha por pauta |
| Voto secreto com garantias criptográficas | O desenho atual é nominal com acesso restrito |
| Assinatura eletrônica qualificada | Não é entregue por um aceite simples |
| Multa automática | Exige apuração e procedimento próprios |
| Rateio, balancete e prestação de contas | Responsabilidade do financeiro |
| Diagnóstico técnico de obra | Exige profissional responsável |
| Prontuário de animal | Fora do cadastro condominial |

### 9.9. Limites de consulta e condições de entrega

O orçamento de consultas D1 por invocação é **a conferir**. Não foi consultada documentação externa nem executada medição.

| Operação | Diretriz |
|---|---|
| Seleção de unidade | Consulta por telefone e vínculos indexados. Sem carregar documentos ou financeiro. |
| Painel da portaria | Página limitada por período e tipo. Sem consultar cada morador separadamente. |
| Detalhe do trabalho | Carregar tarefas, pessoas, documentos e lançamentos apenas quando necessário. |
| Preparação eleitoral | Processar por lotes retomáveis. Não varrer todas as unidades em cada voto. |
| Voto | Consultar rodada e habilitação congelada; gravar voto e auditoria. |
| Comunicado | Preparar destinatários por lotes e enviar em rodadas limitadas. |
| Arquivo | Validar um recurso e sua autorização. Não listar o bucket. |

O lembrete atual de OS já usa lote de 50 registros, em `src/modules/os/reminders.ts:9`. Isso é uma referência de implementação existente, não prova de que o mesmo tamanho seja adequado à extensão.

| Condição de entrega | Critério |
|---|---|
| Compatibilidade | Tipo embutido preservado; nenhuma alteração destrutiva em esquema |
| Isolamento | Pessoa de outra área, unidade ou registro não obtém informação por lista, detalhe, busca, arquivo ou exportação |
| Portaria | Não acessa financeiro nem dados eleitorais |
| Vínculos | Encerramento revoga ações futuras e acesso indevido |
| Retirada | Somente Encomenda recebe lembrete de retirada |
| Etapas | Aprovação de visitante ou obra não passa pelo fluxo de orçamento |
| Votação | Um voto por unidade e rodada, inclusive sob concorrência |
| Apuração | Quórum, peso, abstenção e regra de situação financeira ficam congelados |
| IA | Dados vedados não entram no contexto nem nos resultados das ferramentas |
| Operação | Falhas de envio, pendências e reprocessamentos ficam visíveis |
| D1 | Consultas e lotes medidos dentro dos limites efetivos da instalação |

São critérios para a implementação futura. Nenhum foi validado por execução nesta tarefa.

## 10. Dúvidas e decisões do dono do produto

| Decisão | Recomendação |
|---|---|
| Nome do conjunto | “Solicitações” na área Condomínio |
| Um ou vários condomínios por área | Um condomínio por área |
| Acesso de outros moradores à mesma ocorrência | Fechado por padrão; compartilhamento explícito |
| Retirada de encomenda por terceiro | Autorização específica e temporária |
| Retirada por menor | Não habilitar por padrão; política **a conferir** |
| Aprovação de visitante | Morador com permissão; conferência física pela portaria |
| Prazo de devolução de encomenda | Definir em política local; sem devolução automática |
| Taxa de reserva | Configurar após decisão aprovada; não inventar valores no modelo |
| Limite de reservas por unidade | Uma ativa por espaço e data na primeira versão |
| Voto por fração ideal | Habilitar somente com cadastro e regra documental conferidos |
| Regra de inadimplência | Configuração revisada por assembleia/pauta; sem inferência pelo telefone |
| Voto secreto | Fora da primeira versão |
| Alterar voto já confirmado | Não permitir na primeira versão |
| Assinatura e procuração | Conferência humana; nível de assinatura e requisitos **a conferir** |
| Dependentes menores | Cadastro mínimo, representado por responsável, após política específica |
| Guarda eleitoral e técnica | Definir antes de operar assembleias e documentos técnicos |
| Contrato do motor | Incluir sensibilidade de campos fixos e autorização por tipo antes de ativar o modelo |
| Aplicativos antigos | Conferir leitura, filtros, contagens e impedimento de comandos incompatíveis |
| Ordem de entrega | Modelo operacional após o motor; cadastro e identidade antes de comunicados segmentados e assembleia |

### Modelo neutro para conversão

O JSON abaixo descreve o alvo, com a extensão disponível. Não é uma carga diretamente aceita pela versão atual. As propriedades adicionais registram políticas necessárias à conversão. Referências de menu, termos, documentos, regras e permissões devem ser convertidos para o contrato aprovado na fase 0.

```json
{
  "id": "area-condominios",
  "name": "Condomínios",
  "version": 1,
  "labels": {
    "customer": "Morador ou responsável",
    "customers": "Moradores e responsáveis",
    "work": "Solicitação",
    "works": "Solicitações",
    "assignee": "Responsável pelo atendimento",
    "quote": "Proposta de serviço"
  },
  "modules": {
    "on": ["os", "condominio", "reserva", "mensalidade", "forms", "payments"],
    "off": ["agenda", "erp", "pedido", "mesas", "entrega", "suporte"]
  },
  "application_policy": {
    "mode": "preview_and_merge",
    "preserve_manual_records": true,
    "preserve_modified_template_records": true,
    "id_prefix": "cond-",
    "one_condominium_per_profile": true,
    "existing_module_disables_require_review": true
  },
  "work_type_policy": {
    "unit_field_is_authorization": false,
    "canonical_unit_link": "cond_work_units",
    "customer_visible_means_authenticated_page": true,
    "sensitive_data_allowed_in_messages": false,
    "sensitive_data_allowed_in_ai": false,
    "stale_days_zero_disables": true,
    "due_days_basis": "calendar_days_from_stage_entry",
    "tasks_idempotency": "order_stage_entry_task",
    "quote_approval_is_stage_approval": false,
    "automatic_financial_charge": false
  },
  "work_types": [
    {
      "id": "cond-ocorrencia",
      "singular": "Ocorrência ou manutenção",
      "plural": "Ocorrências e manutenções",
      "item_label": "Local ou equipamento",
      "problem_label": "O que aconteceu",
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
      "create_roles": ["customer_with_membership", "condominio:administracao", "condominio:sindico"],
      "visibility": "requester_and_authorized_team",
      "fixed_field_policy": {
        "item": {"sensitive": true, "customer_visible": true},
        "problem": {"sensitive": true, "customer_visible": true}
      },
      "terms_text": "Solicito a avaliação desta ocorrência. O registro não autoriza cobrança nem entrada na unidade. Se for necessário acesso ao imóvel, a equipe combinará uma autorização específica comigo. Não inclua documentos pessoais ou informações de outras pessoas sem necessidade.",
      "fields": [
        {"key":"unidade","label":"Bloco e unidade do solicitante","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"categoria","label":"Categoria","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["barulho","vazamento","elevador","eletrica","limpeza","outro"]},
        {"key":"local_detalhado","label":"Local exato","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"risco_imediato","label":"Há risco imediato?","type":"sim_nao","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"prioridade","label":"Prioridade da equipe","type":"lista","required":false,"customer_visible":false,"sensitive":false,"options":["normal","urgente","critica"]},
        {"key":"detalhes_restritos","label":"Informações reservadas","type":"texto_longo","required":false,"customer_visible":true,"sensitive":true,"options":[]}
      ],
      "stages": [
        {"id":"aberta","label":"Recebida","base":"received","next":["triagem","cancelada"],"message":"Recebemos a ocorrência {numero}. A equipe vai conferir e informar o próximo passo.","stale_days":1},
        {"id":"triagem","label":"Em avaliação","base":"analyzing","next":["programada","em_execucao","cancelada"],"message":"A ocorrência {numero} está em avaliação. Se precisarmos de mais informações, entraremos em contato.","stale_days":2},
        {"id":"programada","label":"Atendimento programado","base":"approved","next":["triagem","em_execucao","cancelada"],"message":"O atendimento da ocorrência {numero} foi programado. Consulte os detalhes no acompanhamento.","stale_days":3},
        {"id":"em_execucao","label":"Em execução","base":"in_progress","next":["triagem","resolvida","cancelada"],"message":"A equipe iniciou o atendimento da ocorrência {numero}.","stale_days":2},
        {"id":"resolvida","label":"Solução informada","base":"ready","next":["em_execucao","encerrada"],"message":"A equipe informou a solução da ocorrência {numero}. Consulte o resultado e avise se o problema continuar.","stale_days":3},
        {"id":"encerrada","label":"Encerrada","base":"delivered","next":[],"message":"A ocorrência {numero} foi encerrada. Se houver um novo problema, abra outra ocorrência e informe este número.","stale_days":0},
        {"id":"cancelada","label":"Cancelada","base":"cancelled","next":[],"message":"A ocorrência {numero} foi cancelada. O motivo está disponível no acompanhamento.","stale_days":0}
      ],
      "people_roles": [
        {"id":"solicitante","label":"Solicitante"},
        {"id":"responsavel_manutencao","label":"Responsável da manutenção"},
        {"id":"prestador","label":"Prestador"}
      ],
      "entry_kinds": [
        {"id":"andamento","label":"Andamento"},
        {"id":"visita_tecnica","label":"Visita técnica"},
        {"id":"horas","label":"Horas trabalhadas"}
      ],
      "file_kinds": [
        {"id":"evidencia","label":"Evidência do problema","customer_can_receive":false},
        {"id":"relatorio","label":"Relatório de atendimento revisado","customer_can_receive":true},
        {"id":"cotacao","label":"Cotação do fornecedor","customer_can_receive":false}
      ],
      "default_tasks": [
        {"stage":"aberta","title":"Conferir local, categoria e risco imediato","due_days":0},
        {"stage":"triagem","title":"Definir responsável e próximo passo","due_days":1},
        {"stage":"programada","title":"Confirmar horário e eventual acesso à unidade","due_days":0},
        {"stage":"em_execucao","title":"Registrar serviço realizado e pendências","due_days":1},
        {"stage":"resolvida","title":"Conferir resultado com o solicitante","due_days":2}
      ]
    },
    {
      "id": "cond-encomenda",
      "singular": "Encomenda",
      "plural": "Encomendas",
      "item_label": "Identificação do volume",
      "problem_label": "Observação de recebimento",
      "features": {
        "quote": false,
        "warranty": false,
        "pickup": true,
        "terms": false,
        "tasks": true,
        "people": true,
        "files": true,
        "entries": true
      },
      "create_roles": ["condominio:portaria"],
      "visibility": "recipient_and_authorized_team",
      "fixed_field_policy": {
        "item": {"sensitive": true, "customer_visible": true},
        "problem": {"sensitive": true, "customer_visible": true}
      },
      "pickup": {
        "reminder_days": 3,
        "reminder_max_per_stage_entry": 1,
        "reminder_message": "Lembrete: a encomenda {numero} continua disponível na portaria. Se precisar autorizar outra pessoa a retirar, use o acompanhamento ou fale com a portaria.",
        "automatic_return": false,
        "delegate_terms": "Autorizo a pessoa identificada nesta solicitação a retirar somente a encomenda indicada. A portaria conferirá a identificação no local. Esta autorização perde a validade após a retirada, o cancelamento ou o prazo informado.",
        "staff_confirmation": "Confirmei a identificação de quem retirou e entreguei os volumes registrados nesta encomenda."
      },
      "fields": [
        {"key":"unidade","label":"Bloco e unidade","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"volumes","label":"Quantidade de volumes","type":"numero","required":true,"customer_visible":true,"sensitive":false,"options":[],"min":1,"max":20,"integer":true},
        {"key":"transportadora","label":"Transportadora","type":"texto","required":false,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"codigo_rastreio","label":"Código de rastreio","type":"texto","required":false,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"local_guarda","label":"Local de guarda","type":"texto","required":true,"customer_visible":false,"sensitive":true,"options":[]},
        {"key":"avaria_externa","label":"Há avaria externa aparente?","type":"sim_nao","required":true,"customer_visible":true,"sensitive":false,"options":[]}
      ],
      "stages": [
        {"id":"recebida","label":"Recebida na portaria","base":"received","next":["avisada","retirada","devolvida"],"message":"","stale_days":1},
        {"id":"avisada","label":"Morador avisado","base":"ready","next":["retirada","devolvida"],"message":"Há uma encomenda disponível na portaria. Identificação: {numero}. Consulte as orientações de retirada.","stale_days":3},
        {"id":"retirada","label":"Retirada","base":"delivered","next":[],"message":"A retirada da encomenda {numero} foi registrada pela portaria. Se você não reconhece a retirada, fale com a administração.","stale_days":0},
        {"id":"devolvida","label":"Devolvida ao transportador","base":"cancelled","next":[],"message":"A devolução da encomenda {numero} ao transportador foi registrada. Consulte a portaria para mais informações.","stale_days":0}
      ],
      "people_roles": [
        {"id":"destinatario","label":"Destinatário"},
        {"id":"retirante_autorizado","label":"Pessoa autorizada a retirar"},
        {"id":"porteiro","label":"Porteiro"}
      ],
      "entry_kinds": [
        {"id":"recebimento","label":"Recebimento"},
        {"id":"tentativa_aviso","label":"Tentativa de aviso"},
        {"id":"autorizacao_retirada","label":"Autorização de retirada"},
        {"id":"retirada","label":"Retirada"},
        {"id":"devolucao","label":"Devolução"}
      ],
      "file_kinds": [
        {"id":"foto_volume","label":"Foto externa do volume","customer_can_receive":false},
        {"id":"comprovante_retirada","label":"Comprovante de retirada revisado","customer_can_receive":true}
      ],
      "default_tasks": [
        {"stage":"recebida","title":"Conferir destinatário, unidade e volumes","due_days":0},
        {"stage":"recebida","title":"Avisar o destinatário pelo canal autorizado","due_days":0},
        {"stage":"avisada","title":"Conferir encomenda ainda não retirada","due_days":3},
        {"stage":"retirada","title":"Conferir conclusão do comprovante de retirada","due_days":0},
        {"stage":"devolvida","title":"Registrar motivo e identificação do recebimento pelo transportador","due_days":0}
      ]
    },
    {
      "id": "cond-visitante",
      "singular": "Visitante ou prestador",
      "plural": "Visitantes e prestadores",
      "item_label": "Nome do visitante ou prestador",
      "problem_label": "Motivo da visita",
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
      "create_roles": ["customer_with_visit_permission", "condominio:portaria"],
      "visibility": "requester_authorizer_and_portaria",
      "fixed_field_policy": {
        "item": {"sensitive": true, "customer_visible": true},
        "problem": {"sensitive": true, "customer_visible": true}
      },
      "terms_text": "Solicito o acesso desta pessoa à unidade e ao período informados. Confirmo que tenho autorização para fazer o pedido. A entrada depende da conferência da portaria e das regras vigentes do condomínio. Se houver mudança de pessoa ou de horário, farei uma nova solicitação ou pedirei a revisão.",
      "fields": [
        {"key":"unidade","label":"Bloco e unidade de destino","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"categoria","label":"Tipo de acesso","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["visita","prestador","entrega"]},
        {"key":"data_visita","label":"Data da visita","type":"data","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"hora_inicio","label":"Entrada permitida a partir de","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[],"format":"HH:MM"},
        {"key":"hora_fim","label":"Entrada permitida até","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[],"format":"HH:MM"},
        {"key":"empresa","label":"Empresa do prestador","type":"texto","required":false,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"placa","label":"Placa do veículo","type":"texto","required":false,"customer_visible":true,"sensitive":true,"options":[]}
      ],
      "stages": [
        {"id":"solicitada","label":"Solicitação recebida","base":"received","next":["em_conferencia","cancelada"],"message":"Recebemos a solicitação de acesso {numero}. A entrada ainda depende da autorização e da conferência na portaria.","stale_days":1},
        {"id":"em_conferencia","label":"Em conferência","base":"analyzing","next":["autorizada","recusada","cancelada"],"message":"A solicitação de acesso {numero} está em conferência.","stale_days":1},
        {"id":"autorizada","label":"Autorização registrada","base":"approved","next":["entrada_registrada","expirada","cancelada"],"message":"A autorização {numero} foi registrada para o período informado. A portaria fará a conferência na chegada.","stale_days":0},
        {"id":"entrada_registrada","label":"Entrada registrada","base":"in_progress","next":["saida_registrada"],"message":"A portaria registrou a entrada referente à autorização {numero}.","stale_days":0},
        {"id":"saida_registrada","label":"Saída registrada","base":"delivered","next":[],"message":"A portaria registrou a saída referente à autorização {numero}.","stale_days":0},
        {"id":"recusada","label":"Não autorizada","base":"cancelled","next":[],"message":"A solicitação de acesso {numero} não foi autorizada. Consulte o motivo no acompanhamento.","stale_days":0},
        {"id":"expirada","label":"Autorização expirada","base":"cancelled","next":[],"message":"A autorização {numero} venceu sem registro de entrada. Para outro período, faça uma nova solicitação.","stale_days":0},
        {"id":"cancelada","label":"Autorização cancelada","base":"cancelled","next":[],"message":"A solicitação de acesso {numero} foi cancelada.","stale_days":0}
      ],
      "people_roles": [
        {"id":"solicitante","label":"Solicitante"},
        {"id":"autorizador","label":"Autorizador da unidade"},
        {"id":"visitante","label":"Visitante ou prestador"},
        {"id":"porteiro","label":"Porteiro"}
      ],
      "entry_kinds": [
        {"id":"autorizacao","label":"Autorização"},
        {"id":"conferencia","label":"Conferência"},
        {"id":"entrada","label":"Entrada"},
        {"id":"saida","label":"Saída"},
        {"id":"intercorrencia","label":"Intercorrência"}
      ],
      "file_kinds": [
        {"id":"autorizacao","label":"Autorização de acesso","customer_can_receive":true},
        {"id":"documentacao_prestador","label":"Documentação necessária do prestador","customer_can_receive":false}
      ],
      "default_tasks": [
        {"stage":"solicitada","title":"Conferir vínculo do solicitante com a unidade","due_days":0},
        {"stage":"em_conferencia","title":"Conferir autorização e janela de acesso","due_days":0},
        {"stage":"autorizada","title":"Conferir identificação na chegada","due_days":0,"schedule_override":"on_arrival"},
        {"stage":"entrada_registrada","title":"Registrar saída quando ocorrer","due_days":0,"schedule_override":"on_departure"}
      ],
      "timers": [
        {"when":"window_ended_without_entry","action":"transition","stage":"expirada"},
        {"when":"window_ended_after_entry_without_exit","action":"create_staff_task","title":"Verificar ausência de registro de saída"}
      ]
    },
    {
      "id": "cond-intervencao",
      "singular": "Mudança ou obra na unidade",
      "plural": "Mudanças e obras nas unidades",
      "item_label": "Serviço ou mudança pretendida",
      "problem_label": "Descrição do pedido",
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
      "create_roles": ["customer_with_intervention_permission", "condominio:administracao"],
      "visibility": "requester_and_administration",
      "portaria_projection": "approved_operational_conditions_only",
      "fixed_field_policy": {
        "item": {"sensitive": true, "customer_visible": true},
        "problem": {"sensitive": true, "customer_visible": true}
      },
      "terms_text": "Solicito a análise da mudança ou obra descrita. A atividade só poderá começar após autorização expressa, dentro das datas, horários e condições aprovados. Comprometo-me a informar alterações de escopo, equipe ou período. Este aceite não substitui documentos técnicos, autorizações de terceiros ou exigências aplicáveis.",
      "fields": [
        {"key":"unidade","label":"Bloco e unidade","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"modalidade","label":"Modalidade","type":"lista","required":true,"customer_visible":true,"sensitive":false,"options":["mudanca_entrada","mudanca_saida","obra"]},
        {"key":"data_inicio","label":"Data pretendida de início","type":"data","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"data_fim","label":"Data pretendida de término","type":"data","required":true,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"hora_inicio","label":"Horário diário de início","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[],"format":"HH:MM"},
        {"key":"hora_fim","label":"Horário diário de término","type":"texto","required":true,"customer_visible":true,"sensitive":true,"options":[],"format":"HH:MM"},
        {"key":"usa_elevador","label":"Precisa reservar elevador?","type":"sim_nao","required":true,"customer_visible":true,"sensitive":false,"options":[]},
        {"key":"responsavel_tecnico","label":"Responsável técnico, quando exigido","type":"texto","required":false,"customer_visible":true,"sensitive":true,"options":[]},
        {"key":"registro_tecnico","label":"Identificação da ART ou RRT, quando exigida","type":"texto","required":false,"customer_visible":true,"sensitive":true,"options":[]}
      ],
      "stages": [
        {"id":"solicitada","label":"Solicitação recebida","base":"received","next":["em_analise","cancelada"],"message":"Recebemos a solicitação {numero}. Aguarde a autorização antes de iniciar a mudança ou a obra.","stale_days":1},
        {"id":"em_analise","label":"Em análise","base":"analyzing","next":["ajustes","autorizada","indeferida","cancelada"],"message":"A solicitação {numero} está em análise pela administração.","stale_days":3},
        {"id":"ajustes","label":"Aguardando ajustes","base":"received","next":["em_analise","cancelada"],"message":"Há informações ou documentos pendentes na solicitação {numero}. Consulte as pendências no acompanhamento.","stale_days":3},
        {"id":"autorizada","label":"Autorizada e programada","base":"approved","next":["em_analise","em_andamento","cancelada"],"message":"A solicitação {numero} foi autorizada nas condições registradas. Confira datas, horários e orientações antes de começar.","stale_days":0},
        {"id":"em_andamento","label":"Em andamento","base":"in_progress","next":["em_vistoria"],"message":"O início da atividade referente à solicitação {numero} foi registrado.","stale_days":7},
        {"id":"em_vistoria","label":"Em vistoria de conclusão","base":"ready","next":["em_andamento","concluida"],"message":"A solicitação {numero} está em conferência de conclusão. A equipe verificará as pendências registradas.","stale_days":2},
        {"id":"concluida","label":"Concluída","base":"delivered","next":[],"message":"A solicitação {numero} foi concluída. O registro final está disponível no acompanhamento.","stale_days":0},
        {"id":"indeferida","label":"Não autorizada","base":"cancelled","next":[],"message":"A solicitação {numero} não foi autorizada. Consulte a justificativa no acompanhamento.","stale_days":0},
        {"id":"cancelada","label":"Cancelada","base":"cancelled","next":[],"message":"A solicitação {numero} foi cancelada.","stale_days":0}
      ],
      "people_roles": [
        {"id":"solicitante","label":"Solicitante"},
        {"id":"proprietario","label":"Proprietário"},
        {"id":"empresa_executora","label":"Empresa executora"},
        {"id":"responsavel_tecnico","label":"Responsável técnico"},
        {"id":"aprovador","label":"Aprovador"},
        {"id":"vistoriador","label":"Vistoriador"}
      ],
      "entry_kinds": [
        {"id":"andamento","label":"Andamento"},
        {"id":"vistoria","label":"Vistoria"},
        {"id":"intercorrencia","label":"Intercorrência"},
        {"id":"pendencia","label":"Pendência"}
      ],
      "file_kinds": [
        {"id":"plano_intervencao","label":"Plano da intervenção","customer_can_receive":false},
        {"id":"documento_tecnico","label":"Documento técnico","customer_can_receive":false},
        {"id":"autorizacao","label":"Autorização aprovada","customer_can_receive":true},
        {"id":"vistoria_final","label":"Vistoria final revisada","customer_can_receive":true}
      ],
      "default_tasks": [
        {"stage":"solicitada","title":"Conferir unidade, modalidade e período","due_days":1},
        {"stage":"em_analise","title":"Conferir documentos e condições de execução","due_days":2},
        {"stage":"ajustes","title":"Conferir resposta às pendências","due_days":3},
        {"stage":"autorizada","title":"Comunicar condições operacionais à portaria","due_days":0},
        {"stage":"autorizada","title":"Conferir reserva de elevador ou proteção de áreas comuns","due_days":0,"schedule_override":"before_start"},
        {"stage":"em_andamento","title":"Acompanhar pendências da execução","due_days":1},
        {"stage":"em_vistoria","title":"Registrar vistoria de conclusão","due_days":2}
      ]
    }
  ],
  "module_configuration": {
    "agenda": {"services":[]},
    "reserva": {
      "activate_after_review": true,
      "min_notice_hours": 48,
      "max_days_ahead": 60,
      "hourly_open": "08:00",
      "hourly_close": "22:00",
      "hourly_step_minutes": 60,
      "min_hours": 1,
      "max_hours": 4,
      "customer_cancel_hours": 48,
      "reminder_hours": 24,
      "checkin_fields": {
        "document": false,
        "companions": false,
        "arrival_time": false,
        "rules": true
      },
      "house_rules": "A reserva vale para o espaço, a data e o período confirmados. Respeite a capacidade, os horários e as regras de limpeza e uso publicadas pelo condomínio. O responsável deve comunicar qualquer ocorrência à administração. Taxas, cancelamento e eventual restituição serão apresentados antes da confirmação.",
      "spaces": [
        {"id":"cond-salao","name":"Salão","mode":"hourly","capacity":30,"price_cents":null,"active":false},
        {"id":"cond-churrasqueira","name":"Churrasqueira","mode":"hourly","capacity":10,"price_cents":null,"active":false},
        {"id":"cond-elevador","name":"Elevador de serviço","mode":"hourly","capacity":1,"price_cents":0,"active":false}
      ],
      "unit_rule": "one_active_booking_per_space_and_date"
    },
    "mensalidade": {
      "days_before": 5,
      "due_today": true,
      "overdue_every_days": 7,
      "overdue_max": 2,
      "plans": [
        {
          "id":"cond-taxa-ordinaria",
          "name":"Taxa condominial ordinária",
          "period":"monthly",
          "amount_cents":null,
          "suggested_due_day":10,
          "sellable":false,
          "activate_after_review":true
        }
      ]
    },
    "forms": [
      {
        "id":"cond-enquete",
        "name":"Enquete consultiva",
        "binding_vote":false,
        "questions":[
          {"key":"prioridade","label":"Qual melhoria você considera prioritária?","type":"lista","options":["iluminação","limpeza","jardins","outra"]},
          {"key":"periodo","label":"Qual período você prefere para uma reunião informativa?","type":"lista","options":["manhã","tarde","noite"]},
          {"key":"sugestao","label":"Deseja acrescentar uma sugestão? Não inclua nomes ou dados de outras pessoas.","type":"texto_longo","required":false}
        ]
      },
      {
        "id":"cond-atualizacao",
        "name":"Solicitar atualização cadastral",
        "automatic_update":false,
        "questions":[
          {"key":"assunto","label":"O que precisa atualizar?","type":"lista","options":["telefone","vínculo com unidade","veículo","animal","outra informação"]},
          {"key":"contato","label":"Deseja que a administração entre em contato para conferir a alteração?","type":"sim_nao"}
        ]
      }
    ]
  },
  "menus": [
    {"id":"cond-menu-unidade","label":"Minha unidade","type":"cond_unit","parent_id":null,"content":""},
    {"id":"cond-menu-solicitacoes","label":"Solicitações","type":"submenu","parent_id":null,"content":""},
    {"id":"cond-menu-ocorrencia","label":"Abrir ocorrência","type":"os_open","parent_id":"cond-menu-solicitacoes","content":"","work_type_id":"cond-ocorrencia"},
    {"id":"cond-menu-ocorrencias","label":"Minhas ocorrências","type":"os_track","parent_id":"cond-menu-solicitacoes","content":"","work_type_id":"cond-ocorrencia"},
    {"id":"cond-menu-intervencao","label":"Mudança ou obra","type":"os_open","parent_id":"cond-menu-solicitacoes","content":"","work_type_id":"cond-intervencao"},
    {"id":"cond-menu-intervencoes","label":"Acompanhar pedido","type":"os_track","parent_id":"cond-menu-solicitacoes","content":"","work_type_id":"cond-intervencao"},
    {"id":"cond-menu-portaria","label":"Portaria","type":"submenu","parent_id":null,"content":""},
    {"id":"cond-menu-encomendas","label":"Minhas encomendas","type":"os_track","parent_id":"cond-menu-portaria","content":"","work_type_id":"cond-encomenda"},
    {"id":"cond-menu-visita","label":"Autorizar visita","type":"os_open","parent_id":"cond-menu-portaria","content":"","work_type_id":"cond-visitante"},
    {"id":"cond-menu-visitas","label":"Minhas visitas","type":"os_track","parent_id":"cond-menu-portaria","content":"","work_type_id":"cond-visitante"},
    {"id":"cond-menu-portaria-humana","label":"Falar com portaria","type":"human","parent_id":"cond-menu-portaria","content":"","department_id":"cond-portaria"},
    {"id":"cond-menu-espacos","label":"Áreas comuns","type":"submenu","parent_id":null,"content":""},
    {"id":"cond-menu-reservar","label":"Reservar espaço","type":"reserva","parent_id":"cond-menu-espacos","content":""},
    {"id":"cond-menu-reservas","label":"Minhas reservas","type":"reserva_mine","parent_id":"cond-menu-espacos","content":""},
    {"id":"cond-menu-taxas","label":"Taxas","type":"submenu","parent_id":null,"content":""},
    {"id":"cond-menu-mensalidades","label":"Minhas taxas","type":"mensalidade_list","parent_id":"cond-menu-taxas","content":""},
    {"id":"cond-menu-segunda-via","label":"Segunda via","type":"mensalidade_copy","parent_id":"cond-menu-taxas","content":""},
    {"id":"cond-menu-info","label":"Informações","type":"submenu","parent_id":null,"content":""},
    {"id":"cond-menu-comunicados","label":"Comunicados","type":"cond_notices","parent_id":"cond-menu-info","content":""},
    {"id":"cond-menu-regimento","label":"Regimento","type":"cond_rules","parent_id":"cond-menu-info","content":""},
    {"id":"cond-menu-enquete","label":"Enquete consultiva","type":"form","parent_id":"cond-menu-info","content":"","form_id":"cond-enquete"},
    {"id":"cond-menu-atualizacao","label":"Atualizar cadastro","type":"form","parent_id":"cond-menu-info","content":"","form_id":"cond-atualizacao"},
    {"id":"cond-menu-assembleia","label":"Assembleia","type":"cond_assembly","parent_id":"cond-menu-info","content":""},
    {"id":"cond-menu-equipe","label":"Falar com equipe","type":"human","parent_id":null,"content":"","department_id":"cond-administracao"}
  ],
  "departments": [
    "Portaria",
    "Administração",
    "Manutenção",
    "Síndico",
    "Financeiro"
  ],
  "department_ids": {
    "Portaria":"cond-portaria",
    "Administração":"cond-administracao",
    "Manutenção":"cond-manutencao",
    "Síndico":"cond-sindico",
    "Financeiro":"cond-financeiro"
  },
  "ticket_categories": [
    "Encomenda",
    "Visitante ou prestador",
    "Falha no aviso",
    "Divergência de retirada",
    "Cadastro",
    "Reserva",
    "Comunicado",
    "Mudança ou obra",
    "Documento",
    "Vazamento",
    "Elevador",
    "Elétrica",
    "Limpeza",
    "Manutenção geral",
    "Regimento",
    "Ocorrência reservada",
    "Assembleia",
    "Segunda via",
    "Divergência de cobrança",
    "Pagamento em conferência"
  ],
  "bot_instructions": "Você é o assistente de atendimento do condomínio. Responda em português do Brasil, com frases curtas. Use somente o regimento vigente, os comunicados publicados e os resultados das ferramentas autorizadas. Quando citar uma regra, informe o documento e a seção. Se a regra não estiver disponível ou houver conflito, encaminhe à administração.\n\nAntes de uma ação ligada à unidade, use a seleção validada pelo sistema. Não considere bloco, número, nome, CPF ou telefone digitado como prova de vínculo. Se houver mais de uma unidade, peça a escolha. Se não houver vínculo confirmado, encaminhe à administração.\n\nMostre somente os registros que a ferramenta autorizar para esta conversa. Compartilhar uma unidade não autoriza consultar todos os moradores, ocorrências, encomendas ou cobranças.\n\nVocê pode explicar regras publicadas, mostrar etapas permitidas, abrir o formulário adequado, consultar disponibilidade, encaminhar segunda via autorizada e preparar solicitações para confirmação. Diga “solicitação registrada” quando ainda faltar aprovação. Só diga que uma ação foi concluída depois da confirmação do sistema.\n\nNão leia nem peça documentos pessoais, nomes de visitantes, placas, conteúdo de encomendas, relatos reservados, dados de menores, procurações, justificativas financeiras ou votos individuais. Oriente o envio de informações reservadas pela página autenticada. Se uma mensagem contiver esse conteúdo, encaminhe pelo fluxo protegido, sem reproduzi-lo ou resumi-lo.\n\nNão autorize a entrada de pessoas, não registre entrada ou saída física e não confirme retirada de encomenda. Não aprove obras, exceções ao regimento, multas, descontos, baixas financeiras ou alterações de cadastro. Encaminhe essas decisões à pessoa responsável.\n\nNão use comprovante enviado pelo morador como confirmação de pagamento. Não diga que uma pessoa está habilitada a votar com base no pagamento de outra unidade. Não interprete procurações, não escolha votos e não vote em nome de ninguém.\n\nEnquetes são consultas. Votações deliberativas acontecem somente na área autenticada da assembleia. Não transforme “sim”, “não” ou uma mensagem de voz em voto.\n\nEm relato de risco imediato, informe que este canal não garante resposta emergencial e oriente a acionar a portaria e o serviço de emergência adequado. Sinalize a ocorrência à equipe.\n\nNunca informe dados de outra unidade, lista de moradores, rotina de presença, ausência de pessoas, localização de chaves, códigos de acesso ou estado financeiro de terceiros.",
  "extension": {
    "id":"condominio",
    "requires":["os"],
    "new_durable_object_classes":[],
    "new_cloudflare_resources":[],
    "migration_policy":"additive_only",
    "phone_identity":"verified_channel_phone",
    "unit_access":"verified_current_membership",
    "assembly": {
      "enabled_after_manual_review":true,
      "one_vote_per_unit_per_round":true,
      "weight_options":["unidade","fracao_ideal"],
      "fraction_scale":1000000000,
      "debt_rule_options":["nao_aplicar","exigir_regularidade"],
      "unknown_financial_status":"manual_review",
      "eligibility_by_phone_best_payer":false,
      "proxy_review":"human",
      "secret_ballot":false,
      "vote_change_after_confirmation":false,
      "rules_change_after_open":"annul_and_create_new_round",
      "legal_rules_status":"a conferir"
    },
    "privacy": {
      "minor_default":"minimum_data_and_responsible_representative",
      "public_permanent_file_urls":false,
      "sensitive_read_audit":true,
      "ai_access_to_sensitive_data":false,
      "financial_data_for_portaria":false,
      "retention_policy_requires_review":true
    }
  },
  "manual_steps": [
    "Confirmar uma área por condomínio e revisar os módulos que serão desligados.",
    "Cadastrar blocos e unidades; usar Bloco único quando necessário.",
    "Conferir as frações ideais com a documentação oficial.",
    "Cadastrar pessoas, empresas, vínculos e períodos.",
    "Conferir telefones e permissões antes de habilitar acesso.",
    "Vincular pagadores e assinaturas às unidades sem duplicar cobranças.",
    "Configurar recebimento, valores, vencimentos e condições aprovadas.",
    "Revisar capacidade, horários, taxas e regras dos espaços antes de ativá-los.",
    "Publicar regimento e convenção vigentes e selecionar as fontes permitidas do bot.",
    "Definir regras de visitas, retiradas, mudanças, obras e urgências.",
    "Distribuir papéis e revisar administradores globais e contas compartilhadas.",
    "Aprovar aviso de privacidade, finalidades de contato e política de guarda.",
    "Configurar modelos de mensagem e tratamento de falhas de entrega.",
    "Conferir os fluxos com dados fictícios antes da operação real.",
    "Revisar convocação, pauta, quórum, representação e regras antes de cada assembleia."
  ]
}
```