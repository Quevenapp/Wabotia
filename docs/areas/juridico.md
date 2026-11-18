# Advogados e escritório de advocacia

Documento de proposta funcional e técnica. Data: 18/11/2026.

Modelo único: **Advocacia**, com as variações **Profissional sozinho** e **Escritório**. Tipos de trabalho: **Processo** e **Consultivo**. Nome sugerido para o conjunto na navegação: **Trabalhos jurídicos**.

Base informada: commit `efc7e54`. A versão `0.21.1` está em `package.json:3`. As referências abaixo apontam para arquivos dessa cópia do repositório.

Todo comportamento apresentado como proposta depende de implementação. Não foram usados rede, escrita de arquivos ou testes. A legislação vigente, os atos dos tribunais e as regras profissionais mencionadas estão **a conferir** em fontes oficiais antes da publicação do produto.

## 1. Quem usa e como é o dia a dia

O advogado sozinho atende, agenda, prepara documentos, acompanha processos e cobra honorários.
O escritório distribui os casos entre advogados, apoio administrativo e financeiro.
O cliente pode ser pessoa física ou representante autorizado de uma empresa.
As perguntas mais comuns são: “Houve alguma novidade?”, “Preciso mandar algum documento?” e “Quando podemos conversar?”.
Também chegam pedidos de contrato, parecer, segunda via de cobrança e atualização de dados.
O atendimento deve separar informação administrativa de orientação jurídica.
Cada caso tem um advogado responsável, inclusive quando há apoio administrativo.
No escritório, a distribuição por responsável e o registro de horas ficam ligados.
No profissional sozinho, o responsável padrão é o próprio advogado e o registro de horas fica desligado.

## 2. Tipos de trabalho

### 2.1. Decisões comuns aos dois tipos

**Atendimento inicial não será um terceiro tipo nesta versão.** Será uma triagem por formulário, protocolo e Agenda. Isso evita um registro adicional para cada contato e reduz a duplicação de pessoas e documentos.

A triagem não cria um processo contratado. Depois de verificar conflito de interesses e aceitar a atuação, o advogado cria ou confirma um Processo ou Consultivo. O cliente também pode solicitar um desses trabalhos pelo menu, mas o registro entra em **Solicitação recebida**, sem compromisso de atuação.

Um tipo próprio de Atendimento inicial pode ser reavaliado se o produto passar a exigir consultas avulsas com entrega, cobrança e acompanhamento independentes.

| Regra proposta | Definição |
|---|---|
| Identificação pública | `{numero}` representa o número interno do trabalho, com prefixo do tipo. Nunca representa o número CNJ |
| Numeração | `PROC-0001` e `CONS-0001`, com sequências próprias |
| Campos fixos | Títulos administrativos curtos. Não recebem narrativa do caso, nomes de partes ou documentos pessoais |
| Sensível | Classificação operacional de restrição. Inclui sigilo profissional, mesmo quando não for dado pessoal sensível na definição legal |
| Cliente vê | Permite exibição ao cliente autorizado. Não concede acesso à IA |
| Campos sensíveis | Não entram em mensagens, IA, notificações, exportações comuns ou telas de pessoas sem autorização |
| Etapa | Representa o trabalho contratado. Não substitui a situação oficial do processo |
| Andamento | Registro datado do que ocorreu. Não muda a etapa automaticamente |
| Prazo jurídico | Tarefa vinculada a cálculo e confirmação próprios da extensão Jurídico |
| `stale_days` | Dias corridos sem mudança de etapa para lembrar a equipe de revisar o trabalho |
| Valor zero em `stale_days` | Desliga esse aviso na etapa |
| `due_days` das tarefas padrão | Dias corridos para organização interna. Nunca é prazo processual |
| Reentrada em etapa | Cria tarefas apenas para a nova entrada. Repetição técnica do mesmo evento não duplica tarefas |
| Encerramento | Exige revisão dos prazos, tarefas, documentos e comunicações pendentes |

### 2.2. Ajustes necessários no contrato do motor

Estas constatações impedem tratar o modelo como configuração pronta para a versão atual.

| Ponto conferido | Consequência para a proposta |
|---|---|
| Os nove estados estão fixos em `src/modules/os/model.ts:6`. As transições manuais estão em `src/modules/os/model.ts:41` | Os tipos jurídicos precisam de transições por etapa. O tipo embutido mantém as regras atuais |
| Orçamento enviado, aprovado e recusado têm caminhos próprios em `src/modules/os/model.ts:35` | Entrar nas etapas de proposta e aceite deve passar pelos comandos de orçamento e decisão. Não basta editar `stage` |
| A numeração é única por área em `migrations/0035_os_orders.sql:57`. O contador também é por área em `migrations/0035_os_orders.sql:7` | Preservar `number` como identificador legado. Acrescentar `type_number` e contador por tipo. Não remover a unicidade existente |
| A paginação usa `number` em `src/modules/os/store.ts:266` | Manter o cursor legado. A numeração de exibição por tipo não deve substituí-lo |
| `counts` é formado pelos estados encontrados no banco em `src/modules/os/store.ts:257` | Preservar os nove códigos possíveis. O mapa atual pode omitir estados com zero. A fase 0 deve registrar esse detalhe |
| O acompanhamento imprime textos fixos, inclusive retirada, em `src/modules/os/store.ts:1063` | Os novos tipos precisam de apresentação própria. Mapear uma etapa para `ready` não pode gerar mensagem de retirada |
| A notificação de mudança depende de mudança do estado de base em `src/modules/os/store.ts:597` | Duas etapas jurídicas com base `in_progress` ainda precisam gerar histórico, mensagem e tarefas de etapa |
| Os lembretes atuais usam `updated` e os estados fixos em `src/modules/os/reminders.ts:48` | Acrescentar referência à última mudança de etapa. Editar uma nota não deve reiniciar o aviso de etapa parada |
| A declaração atual de `os_open` e `os_track` não tem referência ao tipo em `src/modules/os/definition.ts:28` | Acrescentar `work_type_id` ao contrato desses itens. O suporte genérico a referência já está em `src/modules/types.ts:29` |
| A filtragem atual trata telefone e notas em `src/modules/os/store.ts:166` | Implementar autorização por caso e projeções seguras antes de usar dados jurídicos |
| Android mantém estados e regras de orçamento fixos em `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:162` | A compatibilidade de códigos não garante uma interface jurídica adequada |
| iOS também mantém essas regras em `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:163` | A liberação operacional no aplicativo depende de validar rótulos, comandos, documentos e permissões |

Proposta de compatibilidade: acrescentar `work_type_id`, `type_number`, `stage`, `stage_label`, `stage_changed_at` e `next_stages`. Preservar `status`, `number` e `counts`.

Para tipos novos, um comando legado de mudança de estado só pode executar quando houver um destino inequívoco e autorizado. Se houver várias etapas possíveis com a mesma base, deve pedir a escolha da etapa. Essa restrição não altera o tipo embutido Ordem de serviço.

A aplicação do modelo deve preservar configurações manuais. O precedente de aplicação pela validação de configurações está em `src/service-templates.ts:442`. O mecanismo exato de comparação e preservação dos novos tipos fica para a fase 0.

### 2.3. Tipo Processo

| Propriedade | Valor |
|---|---|
| ID | `advocacia_processo` |
| Singular | Processo |
| Plural | Processos |
| Primeiro campo fixo | Referência do caso |
| Segundo campo fixo | Assunto resumido |
| Exemplo seguro | “Demanda judicial” / “Acompanhamento jurídico” |
| Abrangência | Processo judicial ou administrativo |
| Criação pelo cliente | Solicitação de acompanhamento, sujeita à triagem |
| Criação pela equipe | Cadastro de caso novo ou importação assistida de caso existente |

O número CNJ fica em campo próprio. Isso permite abrir um trabalho antes da distribuição e atender processos administrativos com outra numeração.

**Campos extras**

“Obrigatório” significa obrigatório no cadastro inicial, salvo a condição expressa na tabela.

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `natureza` | Natureza | `lista`: `judicial`, `administrativo` | Sim | Sim | Não |
| `numero_cnj` | Número do processo judicial | `texto` | Não; exigir quando disponível | Não | Sim |
| `numero_administrativo` | Número do processo administrativo | `texto` | Não; exigir quando disponível | Não | Sim |
| `orgao` | Tribunal ou órgão | `texto` | Não; exigir antes de confirmar prazo | Não | Sim |
| `unidade` | Vara ou unidade administrativa | `texto` | Não; exigir antes de confirmar prazo | Não | Sim |
| `comarca` | Comarca ou município de referência | `texto` | Não; exigir quando afetar o calendário | Não | Sim |
| `uf` | UF de referência | `texto` | Não; exigir quando afetar o calendário | Não | Sim |
| `sigilo` | Restrição de acesso | `lista`: `profissional`, `segredo_justica`, `restrito_adicional` | Sim | Não | Sim |
| `honorario_modalidade` | Modalidade de honorários | `lista`: `fixo`, `mensal`, `exito`, `misto` | Não; exigir na contratação | Não | Sim |
| `honorario_valor` | Valor fixo ou mensal contratado | `dinheiro` | Não; conforme contrato | Não | Sim |
| `exito_percentual` | Percentual contratual de êxito | `numero` | Não; conforme contrato | Não | Sim |

O formato visual proposto para o número CNJ é `NNNNNNN-DD.AAAA.J.TR.OOOO`. Guardar os dígitos normalizados e validar estrutura e dígito verificador. A norma de numeração única do CNJ e o algoritmo exato estão **a conferir**. Não aplicar essa validação a processos administrativos.

O percentual de êxito aceita valor entre 0 e 100. Essa validação é apenas numérica. A adequação contratual e profissional depende de revisão humana. A base de cálculo, as condições e a exigibilidade ficam no contrato. Nunca inferir êxito a partir da etapa.

**Etapas**

As mensagens são administrativas. Mesmo essas mensagens devem ser bloqueadas se o caso estiver com comunicação externa suspensa.

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso à equipe |
|---|---|---|---|---|---:|
| `recebido` | Solicitação recebida | `received` | `triagem`, `cancelado` | Recebemos sua solicitação {numero}. A equipe fará a triagem. O recebimento não confirma contratação nem atuação em prazo. | 1 dia |
| `triagem` | Triagem e análise | `analyzing` | `proposta`, `preparacao`, `cancelado` | Sua solicitação {numero} está em análise pela equipe. | 2 dias |
| `proposta` | Proposta de honorários enviada | `quoted` | `contratado`, `recusado`, `triagem`, `cancelado` | Há uma proposta de contratação para sua solicitação {numero}. Leia o escopo e as condições antes de decidir. | 3 dias |
| `contratado` | Proposta aceita; formalização | `approved` | `preparacao`, `cancelado` | Registramos o aceite da proposta {numero}. A equipe confirmará a formalização e os próximos passos. | 1 dia |
| `recusado` | Proposta recusada | `declined` | `triagem`, `cancelado` | Registramos a recusa da proposta {numero}. Se precisar esclarecer as condições, fale com a equipe. | 2 dias |
| `preparacao` | Preparação da atuação | `in_progress` | `tramitacao`, `conferencia`, `cancelado` | O trabalho {numero} está em preparação. Avisaremos se houver alguma providência sua. | 3 dias |
| `tramitacao` | Em tramitação | `in_progress` | `decisao`, `recurso`, `cumprimento`, `conferencia`, `cancelado` | O trabalho {numero} está em acompanhamento. A equipe comunicará as atualizações que exigirem sua atenção. | 30 dias |
| `decisao` | Decisão em análise | `in_progress` | `recurso`, `cumprimento`, `tramitacao`, `conferencia`, `cancelado` | Há uma atualização em análise no trabalho {numero}. O advogado responsável explicará os próximos passos. | 1 dia |
| `recurso` | Revisão ou recurso | `in_progress` | `tramitacao`, `decisao`, `cumprimento`, `conferencia`, `cancelado` | O trabalho {numero} está na etapa de revisão ou recurso. A equipe informará as providências necessárias. | 7 dias |
| `cumprimento` | Cumprimento de providências | `in_progress` | `tramitacao`, `decisao`, `conferencia`, `cancelado` | O trabalho {numero} está na etapa de cumprimento de providências. | 7 dias |
| `conferencia` | Conferência de encerramento | `ready` | `preparacao`, `tramitacao`, `recurso`, `cumprimento`, `encerrado`, `cancelado` | A equipe está conferindo as providências finais do trabalho {numero}. | 2 dias |
| `encerrado` | Trabalho encerrado | `delivered` | Nenhuma | O trabalho contratado {numero} foi encerrado. Os documentos liberados podem ser solicitados à equipe. | 0 |
| `cancelado` | Solicitação ou atuação encerrada antecipadamente | `cancelled` | Nenhuma | O atendimento {numero} foi encerrado antecipadamente. Consulte a equipe sobre as orientações e os documentos finais. | 0 |

O caminho `triagem → preparacao` exige contrato vigente ou registro de atuação sem proposta financeira, com justificativa do advogado. Não serve para contornar o aceite.

A mensagem de `encerrado` se refere ao trabalho contratado. Não afirma trânsito em julgado, arquivamento definitivo ou inexistência de outras obrigações.

O encerramento antecipado de atuação já contratada exige conferência humana das providências necessárias. A validade de renúncia, substituição e comunicação ao cliente está **a conferir** conforme o caso. O botão não produz esses efeitos jurídicos.

**Recursos ligados**

| Recurso | Configuração e uso |
|---|---|
| Orçamento com aprovação | Ligado. Usado para proposta de honorários fixos com escopo definido. Validade sugerida: 7 dias corridos |
| Honorários mensais | Contrato e Mensalidade. Evitar duplicar a primeira parcela na proposta e na assinatura |
| Honorários de êxito | Registro contratual. Cobrança criada pela equipe após verificar o evento contratual e calcular o valor |
| Garantia | Desligada. Nenhuma garantia de resultado |
| Retirada | Desligada. A devolução de originais é tarefa própria, com recibo |
| Termos | Ligados, com o texto abaixo |
| Tarefas e prazos | Ligados. Tarefas internas no motor; prazos jurídicos na extensão |
| Pessoas ligadas | Ligadas. Papel não concede acesso automaticamente |
| Documentos | Ligados. Liberação individual e canal seguro |
| Lançamentos | Ligados. Andamentos, diligências e comunicações. Horas apenas na variação Escritório |

**Termo de abertura**

> Solicito a análise inicial desta demanda. Sei que o envio de informações não confirma contratação, representação nem atendimento de prazo. A equipe verificará a possibilidade de atuação e informará as condições. Se houver intimação, audiência ou data próxima, avisarei a equipe e pedirei confirmação expressa de recebimento. Não enviarei senhas nem códigos de acesso. Os dados serão tratados para avaliar e atender a solicitação, conforme o aviso de privacidade apresentado neste atendimento.

Esse aceite registra a solicitação. Não substitui procuração, contrato de honorários, aviso de privacidade ou definição de base legal.

**Tarefas padrão**

| Ao entrar em | Tarefa | Vencimento interno | Responsável |
|---|---|---:|---|
| `recebido` | Conferir conflito de interesses e encaminhar ao advogado | Mesmo dia | Advogado responsável |
| `triagem` | Confirmar escopo, documentos necessários e existência de urgência | 1 dia | Advogado responsável |
| `contratado` | Conferir contrato, poderes de representação e início da atuação | Mesmo dia | Advogado responsável |
| `preparacao` | Conferir documentos e providência inicial | 1 dia | Advogado responsável |
| `tramitacao` | Conferir a fonte oficial e registrar a próxima revisão | 7 dias | Responsável pelo acompanhamento |
| `decisao` | Ler a decisão e avaliar providências e prazos | Mesmo dia | Advogado responsável |
| `recurso` | Conferir estratégia, autorização e prazos aplicáveis | Mesmo dia | Advogado responsável |
| `cumprimento` | Registrar providências, dependências e próximos controles | 1 dia | Advogado responsável |
| `conferencia` | Conferir prazos, documentos, comunicações e encerramento | 1 dia | Advogado responsável |

A tarefa de revisão em sete dias não substitui a rotina de acompanhamento de intimações. A frequência real será definida por fonte e responsabilidade profissional.

**Pessoas ligadas**

| ID | Papel | Regra |
|---|---|---|
| `cliente` | Cliente | Pode ser pessoa física ou jurídica |
| `representante_cliente` | Representante autorizado do cliente | Exige comprovação e escopo de autorização |
| `parte_contraria` | Parte contrária | Nunca recebe acesso pelo simples vínculo |
| `advogado_contrario` | Advogado da outra parte | Contato profissional interno |
| `advogado_responsavel` | Advogado responsável | Assume as decisões jurídicas |
| `advogado_apoio` | Advogado de apoio | Acesso apenas aos casos atribuídos |
| `perito_assistente` | Perito ou assistente técnico | Sem acesso ao sistema por padrão |
| `testemunha` | Testemunha | Dados restritos; sem comunicação automática |

**Documentos**

| ID | Tipo | Cliente pode receber | Regra |
|---|---|---|---|
| `procuracao` | Procuração | Sim | Somente versão aprovada e destinada ao próprio cliente |
| `contrato_honorarios` | Contrato de honorários | Sim | Versão final ou proposta expressamente liberada |
| `peca_protocolada` | Peça protocolada | Sim | Conferir terceiros, anexos e sigilo antes da liberação |
| `decisao_liberada` | Decisão ou despacho liberado | Sim | Revisão do advogado antes do envio |
| `comprovante_protocolo` | Comprovante de protocolo | Sim | Apenas o comprovante pertinente ao caso |
| `documento_cliente` | Documento fornecido pelo cliente | Sim | Devolução ao titular ou representante autorizado |
| `prova_restrita` | Prova ou documento restrito | Não | Acesso apenas pela equipe autorizada |
| `minuta_interna` | Minuta interna | Não | Nunca vai ao bot |
| `pesquisa_interna` | Pesquisa e estratégia | Não | Nunca vai ao bot |

“Pode receber” indica elegibilidade. Não autoriza envio automático. Documentos jurídicos são entregues por acesso autenticado e auditado. O WhatsApp recebe apenas o aviso administrativo.

**Lançamentos**

| ID | Tipo | Conteúdo |
|---|---|---|
| `andamento` | Andamento | Data do fato, fonte, referência e resumo interno |
| `diligencia` | Diligência | Providência realizada, responsável e resultado |
| `comunicacao` | Comunicação | Contato relevante e orientação registrada pelo advogado |
| `horas` | Horas trabalhadas | Quantidade em horas decimais, atividade e profissional; só Escritório |

Andamento importado não vira texto público automaticamente. O resumo para o cliente é uma publicação separada, aprovada pelo advogado.

### 2.4. Tipo Consultivo

| Propriedade | Valor |
|---|---|
| ID | `advocacia_consultivo` |
| Singular | Consultivo |
| Plural | Consultivos |
| Primeiro campo fixo | Entrega solicitada |
| Segundo campo fixo | Objetivo resumido |
| Exemplo seguro | “Revisão de contrato” / “Análise jurídica” |
| Abrangência | Parecer, elaboração ou revisão de contrato, orientação documentada |
| Unidade de trabalho | Uma entrega ou conjunto de entregas com escopo definido |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|
| `entrega_tipo` | Tipo de entrega | `lista`: `parecer`, `elaboracao_contrato`, `revisao_contrato`, `orientacao_documentada` | Sim | Sim | Não |
| `data_combinada` | Data de entrega combinada | `data` | Não; exigir após contratação | Sim | Não |
| `escopo_interno` | Escopo e limites da análise | `texto_longo` | Não; exigir antes da execução | Não | Sim |
| `honorario_modalidade` | Modalidade de honorários | `lista`: `fixo`, `mensal` | Não; exigir na contratação | Não | Sim |
| `honorario_valor` | Valor fixo ou mensal contratado | `dinheiro` | Não; conforme contrato | Não | Sim |

A data combinada é comercial. Não deve receber aparência de prazo judicial nem cálculo forense.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso à equipe |
|---|---|---|---|---|---:|
| `recebido` | Solicitação recebida | `received` | `triagem`, `cancelado` | Recebemos sua solicitação {numero}. A equipe verificará o escopo e a possibilidade de atendimento. | 1 dia |
| `triagem` | Escopo em análise | `analyzing` | `proposta`, `analise`, `cancelado` | A equipe está analisando o escopo do trabalho {numero}. | 2 dias |
| `proposta` | Proposta enviada | `quoted` | `contratado`, `recusado`, `triagem`, `cancelado` | Há uma proposta para o trabalho {numero}. Confira a entrega, o prazo e as condições antes de decidir. | 3 dias |
| `contratado` | Proposta aceita; formalização | `approved` | `analise`, `cancelado` | Registramos o aceite da proposta {numero}. A equipe confirmará o início e a data combinada. | 1 dia |
| `recusado` | Proposta recusada | `declined` | `triagem`, `cancelado` | Registramos a recusa da proposta {numero}. A equipe pode esclarecer as condições. | 2 dias |
| `analise` | Em elaboração | `in_progress` | `revisao`, `cancelado` | O trabalho {numero} está em elaboração. Avisaremos se precisarmos de alguma informação sua. | 3 dias |
| `revisao` | Revisão jurídica | `in_progress` | `analise`, `disponivel`, `cancelado` | O trabalho {numero} está em revisão jurídica. | 2 dias |
| `disponivel` | Entrega disponível | `ready` | `analise`, `entregue`, `cancelado` | A entrega do trabalho {numero} está disponível no canal seguro informado pela equipe. | 3 dias |
| `entregue` | Entrega concluída | `delivered` | Nenhuma | A entrega do trabalho {numero} foi registrada. Consulte a equipe sobre dúvidas dentro do escopo contratado. | 0 |
| `cancelado` | Trabalho cancelado | `cancelled` | Nenhuma | O trabalho {numero} foi cancelado. A equipe informará as condições de encerramento. | 0 |

`triagem → analise` exige contrato mensal vigente que cubra a entrega ou justificativa de atuação sem cobrança.

Uma alteração posterior ao encerramento gera novo Consultivo vinculado ao anterior. Não reabre silenciosamente uma entrega já concluída.

**Recursos ligados**

| Recurso | Configuração e uso |
|---|---|
| Orçamento com aprovação | Ligado. Escopo, entregáveis, revisões incluídas, valor e validade |
| Garantia | Desligada |
| Retirada | Desligada |
| Termos | Ligados, com o texto abaixo |
| Tarefas | Ligadas. Coleta de informações, produção, revisão e entrega |
| Pessoas ligadas | Cliente, representante, advogado responsável, advogado revisor e interlocutor técnico |
| Documentos | Contrato de honorários, documentos de referência, versões e entrega final |
| Lançamentos | Reunião, análise, revisão, entrega e horas no Escritório |

**Termo de abertura**

> Solicito a análise inicial deste trabalho consultivo. Sei que o recebimento não confirma contratação nem reserva de prazo. O escopo, a entrega, as revisões incluídas, o valor e a data serão confirmados pela equipe. Não enviarei senhas nem códigos de acesso. Os dados serão tratados para avaliar e atender a solicitação, conforme o aviso de privacidade apresentado neste atendimento.

**Tarefas padrão**

| Ao entrar em | Tarefa | Vencimento interno | Responsável |
|---|---|---:|---|
| `recebido` | Conferir conflito de interesses e classificar a entrega | Mesmo dia | Advogado responsável |
| `contratado` | Confirmar escopo, documentos e data combinada | 1 dia | Advogado responsável |
| `analise` | Conferir informações e registrar plano de elaboração | 1 dia | Advogado responsável |
| `revisao` | Revisar conteúdo, versão e destinatário | Mesmo dia | Advogado revisor |
| `disponivel` | Conferir liberação e comunicar disponibilidade | Mesmo dia | Advogado responsável |
| `entregue` | Registrar entrega e condições de guarda | Mesmo dia | Apoio autorizado |

**Pessoas e documentos**

| Categoria | ID | Rótulo | Regra |
|---|---|---|---|
| Pessoa | `cliente` | Cliente | Titular da contratação |
| Pessoa | `representante_cliente` | Representante autorizado | Exige autorização válida |
| Pessoa | `advogado_responsavel` | Advogado responsável | Responde pelo trabalho |
| Pessoa | `advogado_revisor` | Advogado revisor | Confere a entrega |
| Pessoa | `interlocutor_tecnico` | Interlocutor técnico | Não ganha acesso pelo vínculo |
| Documento | `contrato_honorarios` | Contrato de honorários | Cliente pode receber após liberação |
| Documento | `referencia_cliente` | Documento de referência | Cliente pode receber o que lhe pertence |
| Documento | `entrega_final` | Parecer ou contrato final | Cliente pode receber após revisão |
| Documento | `minuta_interna` | Minuta de trabalho | Cliente não recebe |
| Documento | `pesquisa_interna` | Pesquisa jurídica | Cliente não recebe |

| ID | Tipo de lançamento | Conteúdo |
|---|---|---|
| `reuniao` | Reunião | Data, participantes autorizados e registro interno |
| `analise` | Análise | Atividade realizada e dependências |
| `revisao` | Revisão | Versão revisada e responsável |
| `entrega` | Entrega | Versão, destinatário e evidência |
| `horas` | Horas trabalhadas | Quantidade e atividade; só Escritório |

## 3. Vocabulário

| Conceito | Nome usado |
|---|---|
| Cliente | Cliente |
| Clientes | Clientes |
| Conjunto dos trabalhos | Trabalhos jurídicos |
| Trabalho judicial ou administrativo | Processo |
| Trabalho de parecer ou contrato | Consultivo |
| Responsável | Advogado responsável |
| Orçamento | Proposta de honorários |
| Aprovação | Aceite da proposta |
| Prazo de entrega consultiva | Data combinada |
| Prazo jurídico confirmado | Prazo jurídico confirmado |
| Prazo ainda não validado | Cálculo pendente de confirmação |
| Registro de movimentação | Andamento |
| Encerramento | Encerramento do trabalho contratado |

“Cliente” não deve ser substituído por “parte”. Um cliente pode ter vários papéis processuais e vários trabalhos.

## 4. Módulos

Os identificadores reais de Formulários e Cobrança são `forms` e `payments`, respectivamente: `src/modules/forms/definition.ts:6` e `src/modules/payments/definition.ts:6`.

A tabela descreve a configuração sugerida para uma área nova. Em uma área existente, o aplicador mostra diferenças e mantém configurações manuais até a escolha explícita na prévia.

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| Ordem de Serviço — `os` | Ligado | Dois tipos jurídicos. Tipo embutido preservado |
| Agenda — `agenda` | Ligado | Consulta inicial, retorno e reunião de trabalho |
| Mensalidade — `mensalidade` | Ligado | Modelo de assessoria mensal inativo até preencher valor e contrato |
| Formulários — `forms` | Ligado | Triagem administrativa mínima |
| Cobrança — `payments` | Ligado | Honorários fixos, parcelas e cobranças de êxito aprovadas pela equipe |
| Reserva — `reserva` | Desligado | Sem necessidade no modelo |
| ERP — `erp` | Desligado | Não cria lançamentos financeiros nem documentos fiscais neste plano |
| Jurídico — `juridico` | Ligado quando instalado | Depende de `os`. Cálculo fica indisponível até aprovar calendários e regras |

O contrato permite declarar dependências em `src/modules/types.ts:77`. A proposta é `requires: ["os"]`.

### Agenda

A Agenda já declara duração e preço por serviço em `src/modules/agenda/catalog.ts:22`. Há configuração de antecedência e lembrete em `src/modules/agenda/config.ts:11`.

| Serviço proposto | Duração | Configuração |
|---|---:|---|
| Consulta inicial | 45 minutos | Agendamento público após triagem mínima |
| Retorno de cliente | 30 minutos | Para cliente identificado |
| Reunião sobre processo | 60 minutos | Confirmação da equipe |
| Alinhamento de contrato ou parecer | 45 minutos | Vincular a um Consultivo quando existir |

Antecedência mínima sugerida: 24 horas. Lembrete: 24 horas antes. Preço público vazio. A equipe informa as condições em conversa privada antes da contratação.

Audiência e prazo fatal não são horários disponíveis para autoagendamento. Devem bloquear a disponibilidade do profissional por mecanismo próprio. A forma de integração desses bloqueios está **a conferir**.

### Mensalidade e Cobrança

| Configuração | Proposta |
|---|---|
| Plano inicial | Assessoria jurídica mensal |
| Estado inicial | Inativo |
| Valor | Preenchido pela equipe conforme contrato |
| Vencimento sugerido | Dia 10, editável |
| Escopo | Definido no contrato; sem “consultas ilimitadas” por padrão |
| Ativação | Após contratação e confirmação do pagador |
| Lembretes sugeridos | Três dias antes e no vencimento |
| Atraso | Encaminhar à equipe após três dias; sem interromper atuação automaticamente |
| Êxito | Cálculo e autorização humanos. Não nasce da etapa `decisao` ou `encerrado` |
| Pagador diferente | Exige vínculo autorizado. Não recebe acesso ao caso |
| Baixa | Por confirmação do provedor ou ação humana autorizada. Nunca pela afirmação do cliente |

A Mensalidade armazena plano e valor do contrato em `src/modules/mensalidade/contracts.ts:98`. O encaixe exato dos lembretes sugeridos na configuração atual está **a conferir**.

Valores não devem aparecer em publicidade ou menus de captação. A revisão das regras vigentes de publicidade da OAB está **a conferir**.

### Formulário de triagem

| Chave | Pergunta pronta | Tipo | Obrigatório |
|---|---|---|---|
| `nome_preferido` | Como você prefere ser chamado? | `texto` | Sim |
| `objetivo` | Você quer conversar sobre um processo, um contrato, um parecer ou outro atendimento? | `lista`: Processo, Contrato, Parecer, Outro | Sim |
| `tem_data_proxima` | Você recebeu uma comunicação com data próxima ou tem uma urgência? | `sim_nao` | Sim |
| `data_informada` | Qual é a data informada nessa comunicação? | `data` | Se respondeu Sim |
| `periodo_contato` | Em qual período podemos falar com você? | `lista`: Manhã, Tarde | Sim |
| `ciencia` | Estou ciente de que o envio não confirma contratação nem atendimento de prazo. | `sim_nao` | Sim; deve ser Sim |

Não pedir relato livre, CPF, nomes de partes ou anexos nessa triagem. A data informada gera um aviso para conferência humana. Não gera cálculo ou promessa de cumprimento.

## 5. WhatsApp

### Árvore do menu

Os tipos `os_open` e `os_track` já são declarados em `src/modules/os/definition.ts:28`. A referência ao tipo de trabalho é proposta nova. Os tipos `agenda`, `agenda_mine` e `mensalidade_list` estão em `src/modules/agenda/definition.ts:26`, `src/modules/agenda/definition.ts:32` e `src/modules/mensalidade/definition.ts:26`.

| Caminho | Rótulo | Tipo | Ação |
|---|---|---|---|
| Principal | Primeiro atendimento | `form` | Abre a triagem administrativa |
| Principal | Solicitar trabalho | `submenu` | Mostra os dois tipos |
| Solicitar trabalho | Processo | `os_open` | Abre solicitação do tipo `advocacia_processo` |
| Solicitar trabalho | Contrato ou parecer | `os_open` | Abre solicitação do tipo `advocacia_consultivo` |
| Principal | Meus trabalhos | `submenu` | Mostra os acompanhamentos |
| Meus trabalhos | Meus processos | `os_track` | Mostra apenas a projeção administrativa autorizada dos próprios Processos |
| Meus trabalhos | Meus consultivos | `os_track` | Mostra etapa e data combinada dos próprios Consultivos |
| Meus trabalhos | Documentos e pendências | `human` | Equipe confere identidade e envia acesso seguro |
| Principal | Agendar conversa | `agenda` | Oferece horários autorizados |
| Principal | Meus agendamentos | `agenda_mine` | Consulta os agendamentos do próprio cliente |
| Principal | Honorários e pagamentos | `submenu` | Separa mensalidade e outras cobranças |
| Honorários e pagamentos | Minhas mensalidades | `mensalidade_list` | Consulta as próprias parcelas |
| Honorários e pagamentos | Outras cobranças | `human` | Encaminha ao financeiro |
| Principal | Falar com a equipe | `human` | Encaminha à recepção jurídica |
| Principal | Informar urgência | `human` | Encaminha ao jurídico com aviso prioritário |

Na primeira entrega, documentos e pendências usam encaminhamento humano. Quando o motor comum oferecer uma página autenticada de tarefas e arquivos, esse item poderá apontar para ela. O nome desse novo tipo de menu está **a conferir** na fase 0.

### O que o cliente resolve sozinho

| Ação | Limite |
|---|---|
| Solicitar atendimento ou trabalho | Não confirma aceitação do caso |
| Consultar etapa | Apenas informação administrativa liberada |
| Agendar e consultar horários | Conforme disponibilidade e regras da Agenda |
| Aceitar ou recusar proposta | Apenas a proposta vigente e destinada ao próprio cliente |
| Consultar mensalidade | Somente obrigações do pagador autorizado |
| Enviar documento | Pelo canal seguro, após autenticação e vínculo ao caso |
| Receber documento | Apenas arquivo liberado para aquele destinatário |
| Ver tarefa pendente | Apenas tarefa atribuída ao cliente e publicada para ele |

O acompanhamento atual busca por conversa ou telefone verificado em `src/modules/os/store.ts:1032`. Para advocacia, o telefone é condição necessária, mas insuficiente para conceder acesso ao conteúdo do caso.

Representante, sócio, cônjuge ou pagador não recebe acesso só porque conhece o número do processo. Troca de telefone exige conferência humana e revogação do vínculo anterior.

### Mensagens automáticas e lembretes

| Situação | Texto pronto |
|---|---|
| Saudação | Olá. Este é o atendimento de {estabelecimento}. Podemos ajudar com agendamentos, solicitações e informações administrativas. Para falar sobre o conteúdo de um caso, escolha Falar com a equipe. |
| Urgência | Registrei seu pedido de contato prioritário. Este canal não confirma atendimento imediato nem cumprimento de prazo. Se houver data próxima, procure também o contato de urgência informado pelo escritório. |
| Recebimento de documento | O arquivo do trabalho {numero} foi recebido pelo canal seguro. A equipe ainda fará a conferência. |
| Documento disponível | Há um documento liberado no trabalho {numero}. Acesse o canal seguro informado pela equipe. |
| Pendência do cliente | Há uma providência sua pendente no trabalho {numero}. Consulte o canal seguro ou fale com a equipe. |
| Lembrete de pendência | A providência do trabalho {numero} continua pendente. Se precisar de orientação, fale com a equipe. |
| Agendamento | Lembrete: sua conversa com {estabelecimento} está marcada para {data}, às {hora}. Para consultar as opções, acesse Meus agendamentos. |
| Mensalidade próxima | Há uma mensalidade com vencimento em {data}. Consulte Honorários e pagamentos para verificar os dados. |
| Atraso | Identificamos uma pendência de pagamento. Se você já pagou ou precisa conversar sobre a cobrança, fale com o financeiro. |
| Sem atualização publicada | Não há nova atualização liberada para você neste atendimento. Posso encaminhar seu pedido à equipe. |
| Recusa de acesso | Não foi possível disponibilizar essas informações neste atendimento. A equipe pode conferir seu acesso. |

Lembrete de pendência: um aviso dois dias antes da data informada e um no dia, se a tarefa continuar aberta. Para pedido sem vencimento, um único lembrete após três dias.

Os marcadores `{data}`, `{hora}` e `{estabelecimento}` são nomes neutros deste documento. A conversão para os marcadores de cada módulo está **a conferir**.

Nenhuma mensagem inclui número CNJ, parte contrária, estratégia, documento pessoal, resultado judicial ou prazo fatal. O advogado pode comunicar conteúdo jurídico ao cliente por canal autorizado, fora do bot.

## 6. Bot da área

### Instruções prontas

> Você é o assistente administrativo de um atendimento de advocacia. Identifique-se como assistente virtual. Ajude com menus, horários, solicitações, etapas administrativas liberadas e encaminhamento à equipe.
>
> Use apenas as ferramentas autorizadas para a conversa atual. Nunca consulte outro cliente, outro telefone ou outro caso citado na mensagem. Não peça CPF, documentos, senhas, códigos de acesso ou relato detalhado do caso.
>
> Para questões sobre direitos, estratégia, provas, decisões, acordos ou prazos, responda: “Essa questão precisa da análise do advogado responsável. Vou encaminhar seu pedido à equipe.”
>
> Se houver menção a intimação, audiência, vencimento ou urgência, responda: “Vou sinalizar seu pedido à equipe. Este atendimento não confirma cumprimento de prazo. Procure também o contato de urgência informado pelo escritório.”
>
> Não calcule prazos. Não interprete decisões. Não estime chance de êxito. Não prometa resultado, rapidez de julgamento ou aceitação do caso. Não aprove acordos, descontos ou alterações contratuais.
>
> Não faça captação insistente. Não ofereça promoções, gratuidade como chamariz ou comparação com outros profissionais. Não use depoimentos, resultados de casos ou títulos não aprovados pela equipe.
>
> Uma solicitação recebida não é contratação. Um aceite de proposta não é procuração. Um comprovante enviado pelo cliente não confirma pagamento.
>
> Não leia documentos jurídicos, narrativas, notas internas, dados de partes, cálculos de prazo ou registros de acesso. Se esse conteúdo chegar à conversa, encaminhe para atendimento humano sem resumir ou reproduzir o conteúdo.
>
> Se uma ferramenta falhar, informe que não foi possível concluir e encaminhe à equipe. Não invente situação, data, valor ou providência.

### Limites de atuação

| Categoria | Permitido |
|---|---|
| Faz sozinho | Explica o menu; informa horários publicados; consulta projeção administrativa autorizada; registra pedido de contato |
| Com confirmação do cliente | Operações administrativas permitidas, como agendamento e aceite da própria proposta |
| Pergunta à equipe antes | Prioridade excepcional, desconto, nova condição de pagamento, alteração de escopo, liberação de arquivo e troca de representante |
| Nunca faz | Orientação jurídica individual, contagem de prazo, protocolo, assinatura, acordo, renúncia, reconhecimento de fato ou promessa de resultado |
| Não pode ler | Número CNJ, narrativas, provas, peças, contratos jurídicos, pesquisas, estratégia, partes, calendário aplicado ao caso, cálculo de prazo e auditoria |
| Não pode divulgar | Existência de vínculo de outra pessoa com o escritório, resultados de casos, dados de terceiros e informação não publicada ao cliente |

As restrições precisam existir no servidor. O contrato prevê `deny`, `sensitive` e `hints` em `src/modules/types.ts:94`. Nesse contrato, `sensitive` trata confirmação com segundo fator; não equivale à classificação de campo sigiloso.

A documentação prevê ferramentas limitadas à conversa em `docs/MODULOS.md:342` e descreve a remoção de dados pessoais para IA em `docs/MODULOS.md:520`. Para este modelo, será necessária uma lista explícita de campos permitidos, além dessa filtragem geral.

**Condição de ativação:** o bot não pode receber o histórico bruto de uma conversa que contenha material jurídico. O atendimento muda para humano antes da coleta de documentos ou narrativa. Se chegar conteúdo jurídico espontâneo, a implementação deve impedir sua inclusão nas próximas chamadas à IA. A capacidade atual de garantir essa separação está **a conferir**.

Até essa condição ser comprovada, o bot fica desligado nas conversas jurídicas. Menus e respostas determinísticas continuam disponíveis.

As referências profissionais a revisar são o Estatuto da Advocacia, o Código de Ética e Disciplina da OAB e as regras vigentes de publicidade e marketing jurídico da OAB. Aplicação concreta e redação final: **a conferir**.

## 7. Equipe

### Setores e categorias

| Setor | Uso |
|---|---|
| Recepção jurídica | Primeiro atendimento, agenda e encaminhamento |
| Jurídico | Casos, documentos, orientação e prazos |
| Financeiro | Contratos financeiros, mensalidades e cobranças |

No profissional sozinho, os três setores podem apontar para a mesma pessoa. No escritório, recebem membros distintos.

| Categoria de protocolo | Uso |
|---|---|
| Primeiro atendimento | Triagem |
| Atualização de trabalho | Pedido de informação |
| Documento pendente | Envio, recebimento ou liberação |
| Agendamento | Consulta e remarcação |
| Honorários e pagamentos | Cobrança |
| Urgência informada | Data próxima ou situação urgente relatada |
| Privacidade e acesso | Correção cadastral, acesso e representação |

O título do protocolo deve ser neutro. Não copiar a narrativa jurídica para listas gerais de atendimento.

### Papéis propostos

O mecanismo atual de papéis está em `src/modules/types.ts:79`. O papel declarado pelo módulo OS é “Técnico”, em `src/modules/os/definition.ts:61`. Os papéis abaixo são novos e exigem autorização efetiva nas leituras e escritas.

| Papel | Pode ler | Pode fazer |
|---|---|---|
| Administrador da área | Configurações e dados administrativos | Aplicar modelo, convidar pessoas e configurar integrações |
| Advogado gestor | Casos aos quais tem acesso e controles jurídicos autorizados | Distribuir casos, autorizar acessos e revisar regras |
| Advogado responsável | Conteúdo integral dos próprios casos autorizados | Alterar etapas, revisar documentos, confirmar prazos e encerrar trabalho |
| Advogado de apoio ou revisor | Casos explicitamente atribuídos | Produzir documentos, registrar andamentos e preparar cálculos |
| Apoio administrativo | Agenda, pendências e documentos especificamente liberados | Cadastrar metadados, organizar agenda e preparar tarefas |
| Financeiro | Dados de contratação e cobrança necessários | Emitir cobranças e acompanhar pagamentos |
| Auditor autorizado | Metadados de acesso e alterações | Consultar auditoria; sem acesso automático ao conteúdo |
| Bot | Projeção administrativa mínima | Apenas ações descritas na seção 6 |

Ser administrador não concede leitura automática de todos os casos. A concessão excepcional deve ser identificada e auditada.

No escritório, cada trabalho exige responsável e substituto. A distribuição sugerida considera área de atuação, disponibilidade e ausência de conflito. A escolha é humana. Não distribuir casos sensíveis automaticamente.

Horas registradas não viram cobrança automática. O advogado ou financeiro confere o contrato antes de cobrar.

## 8. Passos manuais após aplicar o modelo

| Ordem | Passo | Responsável |
|---:|---|---|
| 1 | Escolher Profissional sozinho ou Escritório | Dono da área |
| 2 | Informar nome profissional, identificação da OAB, horários e contatos oficiais | Advogado |
| 3 | Revisar publicidade, textos e apresentação profissional | Advogado |
| 4 | Cadastrar pessoas, papéis e acessos por caso | Gestor |
| 5 | Definir procedimento de conflito de interesses | Advogado |
| 6 | Revisar termos de abertura, contratos e procurações | Advogado |
| 7 | Publicar aviso de privacidade e definir bases legais por finalidade | Responsável pelo tratamento |
| 8 | Definir política de guarda, revisão e eliminação | Advogado e responsável pelo tratamento |
| 9 | Cadastrar serviços, profissionais e disponibilidade da Agenda | Equipe |
| 10 | Configurar provedor de pagamento e valores contratuais | Financeiro |
| 11 | Ativar somente os planos mensais efetivamente oferecidos | Financeiro |
| 12 | Cadastrar tribunais, órgãos, calendários e regras de prazo | Advogado |
| 13 | Aprovar cobertura do calendário e responsáveis pelos alertas | Advogado |
| 14 | Conferir identidade, telefone e representação dos clientes importados | Equipe autorizada |
| 15 | Revisar acesso e classificação dos documentos importados | Advogado |
| 16 | Validar o bloqueio de dados jurídicos na IA antes de ativar o bot | Administrador e advogado |
| 17 | Conferir todos os prazos ativos importados contra as fontes oficiais | Advogado |
| 18 | Validar mensagens, menus e comportamento dos aplicativos | Dono do produto |

A reaplicação usa IDs estáveis com prefixo `advocacia_`. Mostra criação, manutenção e conflito. Não substitui configuração editada manualmente sem escolha expressa na prévia.

## 9. Extensão Jurídico

### 9.1. Escopo

A extensão acrescenta calendários forenses, regras versionadas, memória de cálculo, confirmação humana, alertas de prazo fatal e auditoria.

Ela não duplica o cadastro de trabalho. O processo continua no motor `os`. Pessoas, documentos, tarefas e lançamentos usam as peças comuns previstas na fase 2.

| O modelo sozinho resolve | A extensão acrescenta |
|---|---|
| Etapas e mensagens | Contagem de dias úteis conforme regra aprovada |
| Tarefas com data manual | Memória reproduzível da contagem |
| Andamentos manuais | Associação entre evento e prazo |
| Organização de documentos | Evidência da publicação, ciência e regra usada |
| Responsável pelo trabalho | Responsável e revisor do prazo |
| Avisos de trabalho parado | Alertas duráveis de prazo fatal |

Proposta de execução: leituras no Worker; mutações serializadas no `Coordinator` existente; dados no D1; evidências e arquivos no R2 existente. Os bindings atuais estão em `wrangler.jsonc:13`, `wrangler.jsonc:20` e `wrangler.jsonc:22`.

Não criar classe de Durable Object, banco, bucket, fila ou serviço novo.

### 9.2. Regras de cálculo

A primeira versão deve aceitar apenas regras de dias úteis expressamente cadastradas e aprovadas. Não assumir que todo prazo judicial ou administrativo usa a mesma regra.

| Etapa | Regra |
|---:|---|
| 1 | Identificar processo, órgão, unidade, regime e ato a praticar |
| 2 | Registrar fonte, documento e forma de comunicação |
| 3 | Separar disponibilização, publicação, ciência e termo inicial |
| 4 | O advogado determina o termo inicial aplicável |
| 5 | Escolher regra versionada, quantidade e calendário |
| 6 | Validar cobertura integral do calendário |
| 7 | Gerar simulação com todos os dias considerados |
| 8 | Exibir exclusões, suspensões, prorrogações e fontes |
| 9 | Advogado confirma ou rejeita o cálculo |
| 10 | Sincronizar a tarefa comum e programar alertas |
| 11 | Qualquer alteração relevante exige nova revisão |
| 12 | Conclusão exige evidência da providência realizada |

Não calcular o termo inicial pela simples data de recebimento de uma mensagem.

**Calendários**

Cada versão representa um calendário efetivo para uma combinação de ramo, tribunal ou órgão, UF, município e unidade. A versão reúne as camadas aplicáveis. Não depende de um calendário global editável silenciosamente.

| Ocorrência | Tratamento |
|---|---|
| Sábado e domingo | Conforme a regra aprovada |
| Feriado nacional | Registrar data, fonte e efeito |
| Feriado estadual | Aplicar apenas à UF e competência pertinentes |
| Feriado municipal | Aplicar apenas à localidade pertinente |
| Feriado do tribunal | Exigir ato oficial e âmbito |
| Suspensão de prazos | Não consumir dias durante o intervalo aplicável |
| Recesso | Registrar o efeito do ato. Não equiparar automaticamente a suspensão de todos os prazos |
| Ausência de expediente | Pode afetar início ou vencimento. Não implica necessariamente suspensão de toda a contagem |
| Expediente parcial | Registrar restrição e exigir regra compatível |
| Indisponibilidade de sistema | Exigir ato ou evidência aceita e revisão humana |
| Interrupção do prazo | Exige novo cálculo com justificativa. Não tratar como suspensão |
| Exceção ou plantão | Aplicação expressa e revisada. Nunca inferida pelo bot |

O Código de Processo Civil, a legislação processual trabalhista, a legislação processual penal, as regras de processo administrativo, a legislação de processo eletrônico e os atos de cada órgão são referências possíveis. A aplicabilidade e a versão de cada uma estão **a conferir**.

Prazos materiais, prescricionais, decadenciais, penais, eleitorais ou administrativos sem regra aprovada ficam em **controle manual**. O sistema pode guardar data e evidência, mas não afirmar que fez contagem forense válida.

### 9.3. Modelo de dados proposto

Todo o DDL abaixo é **proposta**, não código existente. É somente aditivo. Não foi executado.

Datas civis usam `YYYY-MM-DD`. Instantes usam milissegundos UTC. O fuso fica explícito no calendário e no cálculo.

As referências a pessoas e tarefas comuns são IDs opacos. Os nomes e contratos das tabelas de tarefas da fase 2 estão **a conferir**. Por isso, o DDL não inventa uma chave estrangeira para uma tabela ainda não definida.

| Tabela | Finalidade |
|---|---|
| `jur_cases` | Política jurídica e de guarda vinculada ao trabalho |
| `jur_case_access` | Autorizações humanas por caso |
| `jur_calendar_versions` | Versões imutáveis de calendário após aprovação |
| `jur_calendar_events` | Feriados, suspensões e demais ocorrências |
| `jur_rule_versions` | Regras de contagem versionadas |
| `jur_deadlines` | Prazo e vínculo com tarefa comum |
| `jur_calculations` | Cálculos, evidências e confirmação |
| `jur_alerts` | Entrega, repetição e reconhecimento de alertas |
| `jur_audit` | Leitura, alteração, liberação e tentativa negada |

```sql
-- Proposta de migração aditiva. Não executada.
-- Permite referências compostas com isolamento por área.
CREATE UNIQUE INDEX IF NOT EXISTS jur_os_profile_id
ON os_orders(profile_id, id);

CREATE TABLE IF NOT EXISTS jur_cases (
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'restricted'
    CHECK (access_mode IN ('restricted', 'extra_restricted')),
  customer_access_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (customer_access_enabled IN (0, 1)),
  external_messages_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (external_messages_enabled IN (0, 1)),
  retention_policy TEXT NOT NULL,
  retention_review_on TEXT,
  legal_hold INTEGER NOT NULL DEFAULT 0
    CHECK (legal_hold IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, order_id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id)
);

CREATE TABLE IF NOT EXISTS jur_case_access (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_role TEXT NOT NULL
    CHECK (access_role IN (
      'responsible', 'reviewer', 'support', 'finance', 'auditor'
    )),
  scope_json TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_by TEXT,
  revoked_at INTEGER,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES jur_cases(profile_id, order_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS jur_case_access_active
ON jur_case_access(profile_id, order_id, user_id, access_role)
WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS jur_calendar_versions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  calendar_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  authority_code TEXT NOT NULL,
  state_code TEXT,
  municipality_code TEXT,
  court_unit TEXT,
  timezone TEXT NOT NULL,
  coverage_from TEXT NOT NULL,
  coverage_to TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'approved', 'superseded')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  content_hash TEXT,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, calendar_key, revision),
  CHECK (coverage_from <= coverage_to),
  CHECK (
    state = 'draft'
    OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND content_hash IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS jur_calendar_events (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  calendar_version_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN (
      'national_holiday', 'state_holiday', 'municipal_holiday',
      'court_holiday', 'suspension', 'recess',
      'partial_hours', 'system_outage', 'exception'
    )),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  effect TEXT NOT NULL
    CHECK (effect IN (
      'skip_count', 'extend_end', 'shift_start',
      'manual_review', 'informational'
    )),
  applies_json TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_url TEXT,
  evidence_r2_key TEXT,
  evidence_sha256 TEXT,
  source_published_on TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, calendar_version_id)
    REFERENCES jur_calendar_versions(profile_id, id),
  CHECK (starts_on <= ends_on)
);

CREATE INDEX IF NOT EXISTS jur_calendar_events_dates
ON jur_calendar_events(
  profile_id, calendar_version_id, starts_on, ends_on
);

CREATE TABLE IF NOT EXISTS jur_rule_versions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  regime TEXT NOT NULL,
  mode TEXT NOT NULL
    CHECK (mode IN ('business_days', 'manual')),
  exclude_trigger_day INTEGER NOT NULL
    CHECK (exclude_trigger_day IN (0, 1)),
  roll_end_forward INTEGER NOT NULL
    CHECK (roll_end_forward IN (0, 1)),
  config_json TEXT NOT NULL,
  legal_source_text TEXT NOT NULL,
  legal_source_url TEXT,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'approved', 'superseded')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  content_hash TEXT,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, rule_key, revision),
  CHECK (
    state = 'draft'
    OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND content_hash IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS jur_deadlines (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  responsible_user_id TEXT NOT NULL,
  backup_user_id TEXT,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN (
      'draft', 'pending_review', 'confirmed',
      'needs_review', 'completed', 'cancelled'
    )),
  current_revision INTEGER NOT NULL DEFAULT 0,
  effective_due_at INTEGER,
  previous_due_at INTEGER,
  safety_due_at INTEGER,
  completion_evidence_json TEXT,
  cancellation_reason TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, task_id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES jur_cases(profile_id, order_id)
);

CREATE INDEX IF NOT EXISTS jur_deadlines_due
ON jur_deadlines(profile_id, state, effective_due_at);

CREATE TABLE IF NOT EXISTS jur_calculations (
  profile_id TEXT NOT NULL,
  deadline_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  mode TEXT NOT NULL
    CHECK (mode IN ('business_days', 'manual')),
  calendar_version_id TEXT,
  rule_version_id TEXT,
  quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
  communication_kind TEXT NOT NULL,
  made_available_at INTEGER,
  published_on TEXT,
  acknowledged_at INTEGER,
  trigger_on TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  timezone TEXT NOT NULL,
  cutoff_local_time TEXT NOT NULL,
  input_json TEXT NOT NULL,
  source_evidence_json TEXT NOT NULL,
  calendar_snapshot_json TEXT NOT NULL,
  rule_snapshot_json TEXT NOT NULL,
  day_trace_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  due_on TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  calculation_hash TEXT NOT NULL,
  calculated_by TEXT NOT NULL,
  calculated_at INTEGER NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'confirmed', 'rejected')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_reason TEXT,
  PRIMARY KEY (profile_id, deadline_id, revision),
  FOREIGN KEY (profile_id, deadline_id)
    REFERENCES jur_deadlines(profile_id, id),
  FOREIGN KEY (profile_id, calendar_version_id)
    REFERENCES jur_calendar_versions(profile_id, id),
  FOREIGN KEY (profile_id, rule_version_id)
    REFERENCES jur_rule_versions(profile_id, id),
  CHECK (
    mode = 'manual'
    OR (
      calendar_version_id IS NOT NULL
      AND rule_version_id IS NOT NULL
      AND quantity IS NOT NULL
    )
  ),
  CHECK (
    review_state = 'pending'
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS jur_alerts (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  deadline_id TEXT NOT NULL,
  calculation_revision INTEGER NOT NULL,
  alert_kind TEXT NOT NULL
    CHECK (alert_kind IN (
      'review_required', 'advance', 'fatal_today',
      'overdue', 'delivery_failed'
    )),
  recipient_user_id TEXT NOT NULL,
  channel TEXT NOT NULL
    CHECK (channel IN ('panel', 'authorized_notification')),
  scheduled_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN (
      'pending', 'sending', 'sent', 'acknowledged',
      'failed', 'superseded'
    )),
  idempotency_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_until INTEGER,
  sent_at INTEGER,
  acknowledged_at INTEGER,
  provider_reference TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, idempotency_key),
  FOREIGN KEY (
    profile_id, deadline_id, calculation_revision
  ) REFERENCES jur_calculations(
    profile_id, deadline_id, revision
  )
);

CREATE INDEX IF NOT EXISTS jur_alerts_due
ON jur_alerts(profile_id, state, next_attempt_at, scheduled_at);

CREATE TABLE IF NOT EXISTS jur_audit (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  purpose TEXT,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('allowed', 'denied', 'failed')),
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX IF NOT EXISTS jur_audit_target
ON jur_audit(profile_id, target_kind, target_id, created_at);

CREATE INDEX IF NOT EXISTS jur_audit_case
ON jur_audit(profile_id, order_id, created_at);
```

### 9.4. Integridade e validação

| Regra | Implementação proposta |
|---|---|
| Isolamento | Todas as consultas recebem `profile_id` obtido da sessão. Nunca do corpo como autoridade |
| Caso protegido | Qualquer trabalho jurídico sem política de acesso válida fica bloqueado |
| Relações | Conferir que trabalho, tarefa, pessoa, arquivo e prazo pertencem à mesma área e ao mesmo caso |
| Datas | Validar formato e existência da data na aplicação. `TEXT` no SQLite não faz essa validação |
| JSON | Validar esquema, tamanho e campos permitidos antes da escrita |
| Calendário aprovado | Conteúdo imutável. Correção cria nova versão |
| Regra aprovada | Conteúdo imutável. Mudança exige nova versão |
| Cálculo | Entradas e memória imutáveis. Revisão humana não altera os dados calculados |
| Prazo vigente | `current_revision` deve apontar para cálculo existente. Confirmação e troca de revisão ocorrem atomicamente |
| Tarefa comum | A data jurídica não pode ser editada diretamente pela rota genérica de tarefas |
| Concorrência | Usar versão esperada. Alteração concorrente retorna conflito |
| Repetição de comando | Chave idempotente. Não duplicar prazo, cálculo ou alerta |
| Auditoria | Registrar ator efetivo, eventual representação, ação e resultado |
| Exclusão | Sem exclusão direta de prazo confirmado. Usar cancelamento motivado |
| Visão antiga | APIs antigas, busca, exportação, histórico e contadores também aplicam as permissões jurídicas |

A escrita de comandos pelo `Coordinator`, com idempotência e auditoria, consta no contrato em `docs/MODULOS.md:161`. A extensão deverá usar esse caminho.

A auditoria não guarda narrativas, conteúdo de documentos ou segredos. Guarda identificadores, classes de ação e motivos controlados. Uma trilha em D1 não deve ser anunciada como registro inviolável.

### 9.5. Rotas propostas

Prefixo: `/api/v1/profiles/{profile_id}/juridico`.

Todas as rotas abaixo são novas. O papel indicado ainda depende de acesso ao caso quando houver caso envolvido.

| Método | Rota | Uso | Quem executa |
|---|---|---|---|
| `GET` | `/cases/{order_id}/policy` | Consultar política do caso | Advogado autorizado |
| `PUT` | `/cases/{order_id}/policy` | Definir acesso externo e guarda | Advogado gestor autorizado |
| `GET` | `/cases/{order_id}/access` | Listar acessos | Gestor do caso |
| `POST` | `/cases/{order_id}/access` | Conceder acesso humano | Gestor do caso |
| `POST` | `/cases/{order_id}/access/{id}/revoke` | Revogar acesso | Gestor do caso |
| `GET` | `/calendars` | Listar calendários e cobertura | Equipe autorizada |
| `POST` | `/calendars/versions` | Criar versão em rascunho | Curador jurídico |
| `POST` | `/calendars/versions/{id}/events` | Registrar ocorrência | Curador jurídico |
| `PATCH` | `/calendars/versions/{id}/events/{event_id}` | Corrigir ocorrência em rascunho | Curador jurídico |
| `POST` | `/calendars/versions/{id}/approve` | Aprovar versão | Advogado revisor |
| `GET` | `/rules` | Consultar regras | Equipe autorizada |
| `POST` | `/rules/versions` | Criar regra em rascunho | Curador jurídico |
| `POST` | `/rules/versions/{id}/approve` | Aprovar regra | Advogado revisor |
| `GET` | `/cases/{order_id}/deadlines` | Listar prazos do caso | Equipe autorizada |
| `POST` | `/cases/{order_id}/deadlines` | Criar controle e tarefa vinculada | Advogado ou apoio autorizado |
| `POST` | `/deadlines/{id}/calculations` | Gerar cálculo preliminar | Advogado ou apoio autorizado |
| `GET` | `/deadlines/{id}/calculations/{revision}` | Ler memória de cálculo | Equipe jurídica autorizada |
| `POST` | `/deadlines/{id}/calculations/{revision}/confirm` | Confirmar prazo | Advogado responsável ou revisor |
| `POST` | `/deadlines/{id}/calculations/{revision}/reject` | Rejeitar cálculo | Advogado responsável ou revisor |
| `POST` | `/deadlines/{id}/complete` | Registrar cumprimento e evidência | Advogado autorizado |
| `POST` | `/deadlines/{id}/cancel` | Cancelar com justificativa | Advogado responsável |
| `GET` | `/alerts` | Consultar alertas destinados ao usuário | Próprio usuário ou gestor autorizado |
| `POST` | `/alerts/{id}/acknowledge` | Reconhecer alerta | Destinatário |
| `GET` | `/audit` | Consultar trilha com filtros | Auditor autorizado |

A edição e a remoção de eventos de calendário aprovado são proibidas. Em rascunho, a remoção pode ser representada por uma nova versão corrigida, sem necessidade de rota de exclusão.

Erros propostos: `404` para recurso fora do acesso; `409` para versão concorrente ou estado incompatível; `422` para calendário incompleto ou regra inadequada. O código de erro deve explicar a correção necessária sem revelar outro caso.

### 9.6. Memória de cálculo e confirmação

| Campo | Conteúdo |
|---|---|
| Ato | Providência a cumprir |
| Comunicação | Meio e documento que originaram a análise |
| Disponibilização | Instante informado, quando aplicável |
| Publicação | Data juridicamente considerada, quando aplicável |
| Ciência | Instante ou data de ciência, quando aplicável |
| Termo inicial | Data definida pelo advogado |
| Quantidade | Número de dias da regra aplicável |
| Calendário | ID, revisão, cobertura e hash |
| Regra | ID, revisão, fundamento e hash |
| Caminho diário | Data, contado ou excluído, motivo e fonte |
| Vencimento calculado | Data local, horário limite, fuso e instante UTC |
| Ressalvas | Exceções, incertezas e pendências |
| Responsável | Quem preparou |
| Revisor | Quem confirmou |
| Evidência | Documento, fonte e referência de guarda |

Não usar automaticamente `23:59` como limite. O horário depende do ato, do meio e da regra aplicável. Se o horário não estiver determinado, o prazo não pode ser confirmado como cálculo completo.

No profissional sozinho, a mesma pessoa pode preparar e confirmar, em ações separadas e auditadas. No escritório, sugerir revisão por outra pessoa. A política pode exigir revisão independente para determinados casos.

### 9.7. Mudança de calendário e prazo fatal

A aprovação de um calendário novo procura prazos ativos atingidos pelo período e âmbito alterados.

| Situação | Comportamento |
|---|---|
| Nova suspensão ou feriado | Gerar revisão pendente. Não substituir silenciosamente o prazo confirmado |
| Possível vencimento anterior | Alertar imediatamente o responsável e o substituto |
| Possível vencimento posterior | Manter a data anterior como referência conservadora até a revisão |
| Calendário insuficiente | Bloquear a confirmação automática |
| Prazo recalculado | Guardar as duas memórias e a justificativa |
| Prazo cumprido | Preservar cálculo e evidência. Não reabrir automaticamente |
| Trabalho encerrado com prazo ativo | Bloquear encerramento até resolver ou transferir formalmente o controle |

**Alertas sugeridos**

| Momento | Destinatário | Texto |
|---|---|---|
| Cálculo pendente | Responsável | Há um cálculo de prazo pendente de confirmação no trabalho {numero}. Abra o painel jurídico. |
| Cinco dias úteis antes | Responsável | Há um prazo confirmado próximo no trabalho {numero}. Confira a providência e a documentação no painel. |
| Dois dias úteis antes | Responsável e substituto | O prazo do trabalho {numero} está próximo. Confirme a preparação da providência no painel jurídico. |
| Um dia útil antes | Responsável e substituto | Confira hoje a providência vinculada ao trabalho {numero}. O controle de prazo exige sua atenção. |
| No dia, no início do expediente | Responsável e substituto | PRAZO FATAL HOJE: há uma providência com vencimento hoje no trabalho {numero}. Confira o horário e registre o cumprimento no painel. |
| Após o vencimento sem conclusão | Responsável e gestor | ATENÇÃO: o prazo do trabalho {numero} está vencido no controle e sem evidência de cumprimento. Confira imediatamente a situação real. |

Os intervalos anteriores ao vencimento usam o calendário aprovado do prazo. O disparo no dia usa o horário configurado do escritório, antecipado quando necessário para ocorrer antes do limite.

Alertas jurídicos são internos. Nenhum deles é enviado ao cliente automaticamente.

Cada alerta tem destinatário, revisão do cálculo e chave idempotente. Falhas ficam persistidas e são reenviadas. Uma tentativa de envio não equivale a entrega. Entrega não equivale a reconhecimento. Reconhecimento não equivale a cumprimento.

Se houver falha, o painel mantém a pendência e notifica o substituto pelo canal já disponível e autorizado. Não criar infraestrutura nova para esse fluxo.

O processamento deve usar lotes limitados, índices de vencimento e continuação entre rodadas. O limite efetivo de consultas D1 por invocação e o orçamento disponível na instalação estão **a conferir**. Não há número de capacidade presumido neste plano.

### 9.8. Privacidade, leitura e guarda

| Tema | Regra proposta |
|---|---|
| Segredo profissional | Acesso mínimo por caso. Não depende apenas de pertencer à área |
| IA | Sem acesso a conteúdo jurídico, partes, documentos, cálculos e auditoria |
| Cliente | Só a própria projeção publicada. Acesso externo começa desligado |
| Representante | Vínculo verificado, escopo e possibilidade de revogação |
| Financeiro | Dados mínimos para cobrança. Sem narrativa e provas |
| Apoio | Acesso por tarefa e documento, conforme concessão |
| R2 | Chaves privadas e nomes opacos. Não usar CNJ ou nome de pessoa no caminho público |
| Download | Autenticar, conferir destinatário e registrar leitura ou download |
| Notificação | Sem anexo jurídico ou conteúdo do caso |
| Histórico | Registrar mudança sem copiar documentos e narrativas em eventos gerais |
| Retenção | Política por finalidade e categoria documental |
| Encerramento | Agenda revisão de guarda; não apaga automaticamente |
| Preservação | `legal_hold` bloqueia eliminação enquanto houver fundamento registrado |
| Eliminação | Aprovação humana, remoção coordenada no D1 e R2 e registro mínimo da operação |
| Cópias e exportações | Aplicar a mesma política de acesso e guarda |
| Backups | Capacidade e prazo real de expurgo estão **a conferir** |

A Lei Geral de Proteção de Dados Pessoais, as regras de sigilo da advocacia e as obrigações de guarda aplicáveis ao caso precisam orientar a política. Bases legais, prazos e exceções estão **a conferir**. Não fixar “cinco anos para tudo” nem usar consentimento como fundamento universal.

O contrato de honorários e a procuração podem ser entregues ao próprio cliente por canal seguro. Isso não autoriza sua leitura pela IA nem seu envio a terceiros.

### 9.9. Consulta futura de andamentos

Esta parte é desenho. Não inclui integração, coleta nem implementação.

| Fonte pública possível | Uso possível | Limite a conferir |
|---|---|---|
| API Pública do DataJud, do CNJ | Metadados e movimentações disponíveis | Cobertura, atualização, autenticação, limites e exclusão de dados sigilosos |
| Diário de Justiça Eletrônico Nacional | Publicações oficiais | Consulta estruturada, identificação, integração e alcance |
| Diários eletrônicos dos tribunais | Publicações dos respectivos órgãos | Formato, termos de uso, paginação e estabilidade |
| Consulta pública dos tribunais | Andamentos e documentos efetivamente públicos | Disponibilidade, autorização de automação e proteção contra acesso indevido |
| Portais de processo administrativo | Andamentos públicos administrativos | Regras específicas de cada órgão |
| Serviços oficiais conveniados | Consulta autenticada quando formalmente autorizada | Credenciais, convênio, finalidade e limites |

DataJud e consulta pública não devem ser apresentados como fonte única de intimação ou prova de ciência. Atualização pública não significa que o cliente já foi juridicamente intimado.

| Etapa da futura integração | Regra |
|---|---|
| Ativação | Por tribunal e por caso autorizado |
| Identificação | Número normalizado e órgão. Não buscar pessoas por nome como padrão |
| Consulta | Adaptador específico, com limites e termos revisados |
| Armazenamento | Referência da fonte, instante da coleta, ID externo e hash |
| Deduplicação | Chave por área, caso, fonte e evento externo |
| Registro | Lançamento interno com texto da fonte separado do resumo humano |
| Conferência | Advogado aprova publicação ao cliente |
| Possível prazo | Criar tarefa de análise. Nunca prazo confirmado automaticamente |
| Falha da fonte | Mostrar última consulta bem-sucedida e erro. Não afirmar “sem andamento” |
| Sigilo | Não tentar contornar autenticação, CAPTCHA ou restrição |
| Credenciais | Armazenar apenas pelo mecanismo seguro existente, cuja adequação está **a conferir** |

Rotas futuras sugeridas: `POST /cases/{order_id}/sources`, `POST /cases/{order_id}/sources/{id}/sync` e `GET /cases/{order_id}/source-events`. Elas ficam fora da primeira entrega da extensão.

### 9.10. Fora do escopo

| Item | Motivo |
|---|---|
| Peticionamento eletrônico | Exige integração e autorização próprias |
| Assinatura com certificado | Não faz parte do controle de trabalho |
| Leitura automática de intimações por IA | Incompatível com a restrição definida |
| Parecer ou estratégia automática | Exige atuação do advogado |
| Cálculo automático de êxito | Depende do contrato e do caso |
| Cálculo universal de qualquer prazo | Regimes e exceções diferentes |
| Controle contábil completo | Escopo financeiro separado |
| Emissão fiscal | Depende do projeto fiscal do ERP |
| Repositório de jurisprudência | Não necessário para esta entrega |
| Consulta a processo sigiloso por fonte pública | Incompatível com a restrição de acesso |

## 10. Dúvidas e decisões do dono do produto

| Decisão | Proposta |
|---|---|
| Nome do conjunto | Trabalhos jurídicos |
| Dois modelos ou duas variações | Um modelo com variação Profissional sozinho e Escritório |
| Atendimento inicial | Formulário, protocolo e Agenda. Sem terceiro tipo |
| Horas trabalhadas | Desligadas no profissional sozinho; ligadas no escritório |
| Distribuição | Responsável padrão no profissional sozinho; atribuição humana no escritório |
| Primeiro regime automatizado | Escolher um ramo e conjunto de tribunais para homologação |
| Prazos administrativos | Controle manual até aprovar regra específica |
| Revisão independente | Sugerida no escritório; obrigatória apenas conforme política definida |
| Bot | Ativar somente após comprovar separação de conteúdo jurídico |
| Documentos no WhatsApp | Aviso administrativo; entrega em canal autenticado |
| Numeração por tipo | Novo `type_number`; manter `number` legado |
| Aplicativos antigos | Validar acesso e comandos antes de habilitar operação jurídica |
| Guarda documental | Política aprovada pelo escritório, sem prazo universal |
| Calendário desatualizado | Bloquear confirmação e alertar; nunca completar feriados por suposição |
| Contrato de êxito | Cadastro e cobrança humanos |
| Andamentos externos | Fase posterior, por fonte oficial validada |

### Modelo neutro para conversão

O JSON é uma especificação declarativa proposta. Não é um payload aceito pela versão atual.

Os campos adicionais `terms_text`, `variants`, `module_settings`, `access_policy` e `extension` completam o formato neutro. `work_type_id` nos menus depende do contrato da fase 0. Recursos que dependem da extensão ou do motor generalizado não devem ser ativados antes da implementação.

```json
{
  "id": "advocacia",
  "name": "Advocacia",
  "labels": {
    "customer": "Cliente",
    "customers": "Clientes",
    "work": "Trabalho jurídico",
    "works": "Trabalhos jurídicos",
    "responsible": "Advogado responsável",
    "quote": "Proposta de honorários"
  },
  "modules": {
    "on": ["os", "agenda", "mensalidade", "forms", "payments"],
    "off": ["reserva", "erp"]
  },
  "variants": [
    {
      "id": "profissional_sozinho",
      "name": "Profissional sozinho",
      "assignment_mode": "default_responsible",
      "time_entries_enabled": false,
      "independent_review_required": false
    },
    {
      "id": "escritorio",
      "name": "Escritório de advocacia",
      "assignment_mode": "manual_distribution",
      "time_entries_enabled": true,
      "backup_responsible_required": true,
      "independent_review_required": false,
      "independent_review_recommended": true
    }
  ],
  "application_policy": {
    "id_prefix": "advocacia_",
    "preview_required": true,
    "preserve_manual_changes": true,
    "replace_conflicts_automatically": false
  },
  "access_policy": {
    "case_access_required": true,
    "customer_access_default": false,
    "external_messages_default": false,
    "linked_person_grants_access": false,
    "phone_alone_grants_case_content": false,
    "sensitive_fields_in_messages": false,
    "sensitive_fields_in_ai": false,
    "legal_files_in_ai": false,
    "legal_conversation_history_in_ai": false,
    "document_delivery": "authenticated_channel",
    "document_release_requires_human": true,
    "administrator_has_automatic_case_access": false
  },
  "work_types": [
    {
      "id": "advocacia_processo",
      "singular": "Processo",
      "plural": "Processos",
      "number_prefix": "PROC",
      "item_label": "Referência do caso",
      "problem_label": "Assunto resumido",
      "fixed_fields_policy": "Usar títulos administrativos. Não inserir narrativa, nomes de partes ou documentos pessoais.",
      "features": {
        "quote": true,
        "warranty": false,
        "pickup": false,
        "terms": true,
        "tasks": true,
        "people": true,
        "files": true,
        "entries": true
      },
      "quote_valid_days": 7,
      "terms_text": "Solicito a análise inicial desta demanda. Sei que o envio de informações não confirma contratação, representação nem atendimento de prazo. A equipe verificará a possibilidade de atuação e informará as condições. Se houver intimação, audiência ou data próxima, avisarei a equipe e pedirei confirmação expressa de recebimento. Não enviarei senhas nem códigos de acesso. Os dados serão tratados para avaliar e atender a solicitação, conforme o aviso de privacidade apresentado neste atendimento.",
      "fields": [
        {
          "key": "natureza",
          "label": "Natureza",
          "type": "lista",
          "required": true,
          "customer_visible": true,
          "sensitive": false,
          "options": ["judicial", "administrativo"]
        },
        {
          "key": "numero_cnj",
          "label": "Número do processo judicial",
          "type": "texto",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "numero_administrativo",
          "label": "Número do processo administrativo",
          "type": "texto",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "orgao",
          "label": "Tribunal ou órgão",
          "type": "texto",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "unidade",
          "label": "Vara ou unidade administrativa",
          "type": "texto",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "comarca",
          "label": "Comarca ou município de referência",
          "type": "texto",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "uf",
          "label": "UF de referência",
          "type": "texto",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "sigilo",
          "label": "Restrição de acesso",
          "type": "lista",
          "required": true,
          "customer_visible": false,
          "sensitive": true,
          "options": [
            "profissional",
            "segredo_justica",
            "restrito_adicional"
          ]
        },
        {
          "key": "honorario_modalidade",
          "label": "Modalidade de honorários",
          "type": "lista",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": ["fixo", "mensal", "exito", "misto"]
        },
        {
          "key": "honorario_valor",
          "label": "Valor fixo ou mensal contratado",
          "type": "dinheiro",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "exito_percentual",
          "label": "Percentual contratual de êxito",
          "type": "numero",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        }
      ],
      "stages": [
        {
          "id": "recebido",
          "label": "Solicitação recebida",
          "base": "received",
          "next": ["triagem", "cancelado"],
          "message": "Recebemos sua solicitação {numero}. A equipe fará a triagem. O recebimento não confirma contratação nem atuação em prazo.",
          "stale_days": 1
        },
        {
          "id": "triagem",
          "label": "Triagem e análise",
          "base": "analyzing",
          "next": ["proposta", "preparacao", "cancelado"],
          "message": "Sua solicitação {numero} está em análise pela equipe.",
          "stale_days": 2
        },
        {
          "id": "proposta",
          "label": "Proposta de honorários enviada",
          "base": "quoted",
          "next": ["contratado", "recusado", "triagem", "cancelado"],
          "message": "Há uma proposta de contratação para sua solicitação {numero}. Leia o escopo e as condições antes de decidir.",
          "stale_days": 3
        },
        {
          "id": "contratado",
          "label": "Proposta aceita; formalização",
          "base": "approved",
          "next": ["preparacao", "cancelado"],
          "message": "Registramos o aceite da proposta {numero}. A equipe confirmará a formalização e os próximos passos.",
          "stale_days": 1
        },
        {
          "id": "recusado",
          "label": "Proposta recusada",
          "base": "declined",
          "next": ["triagem", "cancelado"],
          "message": "Registramos a recusa da proposta {numero}. Se precisar esclarecer as condições, fale com a equipe.",
          "stale_days": 2
        },
        {
          "id": "preparacao",
          "label": "Preparação da atuação",
          "base": "in_progress",
          "next": ["tramitacao", "conferencia", "cancelado"],
          "message": "O trabalho {numero} está em preparação. Avisaremos se houver alguma providência sua.",
          "stale_days": 3
        },
        {
          "id": "tramitacao",
          "label": "Em tramitação",
          "base": "in_progress",
          "next": [
            "decisao",
            "recurso",
            "cumprimento",
            "conferencia",
            "cancelado"
          ],
          "message": "O trabalho {numero} está em acompanhamento. A equipe comunicará as atualizações que exigirem sua atenção.",
          "stale_days": 30
        },
        {
          "id": "decisao",
          "label": "Decisão em análise",
          "base": "in_progress",
          "next": [
            "recurso",
            "cumprimento",
            "tramitacao",
            "conferencia",
            "cancelado"
          ],
          "message": "Há uma atualização em análise no trabalho {numero}. O advogado responsável explicará os próximos passos.",
          "stale_days": 1
        },
        {
          "id": "recurso",
          "label": "Revisão ou recurso",
          "base": "in_progress",
          "next": [
            "tramitacao",
            "decisao",
            "cumprimento",
            "conferencia",
            "cancelado"
          ],
          "message": "O trabalho {numero} está na etapa de revisão ou recurso. A equipe informará as providências necessárias.",
          "stale_days": 7
        },
        {
          "id": "cumprimento",
          "label": "Cumprimento de providências",
          "base": "in_progress",
          "next": ["tramitacao", "decisao", "conferencia", "cancelado"],
          "message": "O trabalho {numero} está na etapa de cumprimento de providências.",
          "stale_days": 7
        },
        {
          "id": "conferencia",
          "label": "Conferência de encerramento",
          "base": "ready",
          "next": [
            "preparacao",
            "tramitacao",
            "recurso",
            "cumprimento",
            "encerrado",
            "cancelado"
          ],
          "message": "A equipe está conferindo as providências finais do trabalho {numero}.",
          "stale_days": 2
        },
        {
          "id": "encerrado",
          "label": "Trabalho encerrado",
          "base": "delivered",
          "next": [],
          "message": "O trabalho contratado {numero} foi encerrado. Os documentos liberados podem ser solicitados à equipe.",
          "stale_days": 0
        },
        {
          "id": "cancelado",
          "label": "Solicitação ou atuação encerrada antecipadamente",
          "base": "cancelled",
          "next": [],
          "message": "O atendimento {numero} foi encerrado antecipadamente. Consulte a equipe sobre as orientações e os documentos finais.",
          "stale_days": 0
        }
      ],
      "transition_guards": [
        {
          "to": "proposta",
          "require": "valid_quote_send"
        },
        {
          "from": "proposta",
          "to": "contratado",
          "require": "current_quote_customer_acceptance"
        },
        {
          "from": "proposta",
          "to": "recusado",
          "require": "current_quote_customer_decline"
        },
        {
          "from": "triagem",
          "to": "preparacao",
          "require": "existing_contract_or_lawyer_justification"
        },
        {
          "to": "encerrado",
          "require": "lawyer_closure_review_and_no_unresolved_deadlines"
        },
        {
          "to": "cancelado",
          "require": "lawyer_review_when_engagement_exists"
        }
      ],
      "people_roles": [
        {"id": "cliente", "label": "Cliente"},
        {"id": "representante_cliente", "label": "Representante autorizado do cliente"},
        {"id": "parte_contraria", "label": "Parte contrária"},
        {"id": "advogado_contrario", "label": "Advogado da outra parte"},
        {"id": "advogado_responsavel", "label": "Advogado responsável"},
        {"id": "advogado_apoio", "label": "Advogado de apoio"},
        {"id": "perito_assistente", "label": "Perito ou assistente técnico"},
        {"id": "testemunha", "label": "Testemunha"}
      ],
      "entry_kinds": [
        {"id": "andamento", "label": "Andamento"},
        {"id": "diligencia", "label": "Diligência"},
        {"id": "comunicacao", "label": "Comunicação"},
        {"id": "horas", "label": "Horas trabalhadas"}
      ],
      "file_kinds": [
        {"id": "procuracao", "label": "Procuração", "customer_can_receive": true},
        {"id": "contrato_honorarios", "label": "Contrato de honorários", "customer_can_receive": true},
        {"id": "peca_protocolada", "label": "Peça protocolada", "customer_can_receive": true},
        {"id": "decisao_liberada", "label": "Decisão ou despacho liberado", "customer_can_receive": true},
        {"id": "comprovante_protocolo", "label": "Comprovante de protocolo", "customer_can_receive": true},
        {"id": "documento_cliente", "label": "Documento fornecido pelo cliente", "customer_can_receive": true},
        {"id": "prova_restrita", "label": "Prova ou documento restrito", "customer_can_receive": false},
        {"id": "minuta_interna", "label": "Minuta interna", "customer_can_receive": false},
        {"id": "pesquisa_interna", "label": "Pesquisa e estratégia", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "recebido", "title": "Conferir conflito de interesses e encaminhar ao advogado", "due_days": 0},
        {"stage": "triagem", "title": "Confirmar escopo, documentos necessários e existência de urgência", "due_days": 1},
        {"stage": "contratado", "title": "Conferir contrato, poderes de representação e início da atuação", "due_days": 0},
        {"stage": "preparacao", "title": "Conferir documentos e providência inicial", "due_days": 1},
        {"stage": "tramitacao", "title": "Conferir a fonte oficial e registrar a próxima revisão", "due_days": 7},
        {"stage": "decisao", "title": "Ler a decisão e avaliar providências e prazos", "due_days": 0},
        {"stage": "recurso", "title": "Conferir estratégia, autorização e prazos aplicáveis", "due_days": 0},
        {"stage": "cumprimento", "title": "Registrar providências, dependências e próximos controles", "due_days": 1},
        {"stage": "conferencia", "title": "Conferir prazos, documentos, comunicações e encerramento", "due_days": 1}
      ]
    },
    {
      "id": "advocacia_consultivo",
      "singular": "Consultivo",
      "plural": "Consultivos",
      "number_prefix": "CONS",
      "item_label": "Entrega solicitada",
      "problem_label": "Objetivo resumido",
      "fixed_fields_policy": "Usar títulos administrativos. Não inserir narrativa, nomes de partes ou documentos pessoais.",
      "features": {
        "quote": true,
        "warranty": false,
        "pickup": false,
        "terms": true,
        "tasks": true,
        "people": true,
        "files": true,
        "entries": true
      },
      "quote_valid_days": 7,
      "terms_text": "Solicito a análise inicial deste trabalho consultivo. Sei que o recebimento não confirma contratação nem reserva de prazo. O escopo, a entrega, as revisões incluídas, o valor e a data serão confirmados pela equipe. Não enviarei senhas nem códigos de acesso. Os dados serão tratados para avaliar e atender a solicitação, conforme o aviso de privacidade apresentado neste atendimento.",
      "fields": [
        {
          "key": "entrega_tipo",
          "label": "Tipo de entrega",
          "type": "lista",
          "required": true,
          "customer_visible": true,
          "sensitive": false,
          "options": [
            "parecer",
            "elaboracao_contrato",
            "revisao_contrato",
            "orientacao_documentada"
          ]
        },
        {
          "key": "data_combinada",
          "label": "Data de entrega combinada",
          "type": "data",
          "required": false,
          "customer_visible": true,
          "sensitive": false,
          "options": []
        },
        {
          "key": "escopo_interno",
          "label": "Escopo e limites da análise",
          "type": "texto_longo",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        },
        {
          "key": "honorario_modalidade",
          "label": "Modalidade de honorários",
          "type": "lista",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": ["fixo", "mensal"]
        },
        {
          "key": "honorario_valor",
          "label": "Valor fixo ou mensal contratado",
          "type": "dinheiro",
          "required": false,
          "customer_visible": false,
          "sensitive": true,
          "options": []
        }
      ],
      "stages": [
        {
          "id": "recebido",
          "label": "Solicitação recebida",
          "base": "received",
          "next": ["triagem", "cancelado"],
          "message": "Recebemos sua solicitação {numero}. A equipe verificará o escopo e a possibilidade de atendimento.",
          "stale_days": 1
        },
        {
          "id": "triagem",
          "label": "Escopo em análise",
          "base": "analyzing",
          "next": ["proposta", "analise", "cancelado"],
          "message": "A equipe está analisando o escopo do trabalho {numero}.",
          "stale_days": 2
        },
        {
          "id": "proposta",
          "label": "Proposta enviada",
          "base": "quoted",
          "next": ["contratado", "recusado", "triagem", "cancelado"],
          "message": "Há uma proposta para o trabalho {numero}. Confira a entrega, o prazo e as condições antes de decidir.",
          "stale_days": 3
        },
        {
          "id": "contratado",
          "label": "Proposta aceita; formalização",
          "base": "approved",
          "next": ["analise", "cancelado"],
          "message": "Registramos o aceite da proposta {numero}. A equipe confirmará o início e a data combinada.",
          "stale_days": 1
        },
        {
          "id": "recusado",
          "label": "Proposta recusada",
          "base": "declined",
          "next": ["triagem", "cancelado"],
          "message": "Registramos a recusa da proposta {numero}. A equipe pode esclarecer as condições.",
          "stale_days": 2
        },
        {
          "id": "analise",
          "label": "Em elaboração",
          "base": "in_progress",
          "next": ["revisao", "cancelado"],
          "message": "O trabalho {numero} está em elaboração. Avisaremos se precisarmos de alguma informação sua.",
          "stale_days": 3
        },
        {
          "id": "revisao",
          "label": "Revisão jurídica",
          "base": "in_progress",
          "next": ["analise", "disponivel", "cancelado"],
          "message": "O trabalho {numero} está em revisão jurídica.",
          "stale_days": 2
        },
        {
          "id": "disponivel",
          "label": "Entrega disponível",
          "base": "ready",
          "next": ["analise", "entregue", "cancelado"],
          "message": "A entrega do trabalho {numero} está disponível no canal seguro informado pela equipe.",
          "stale_days": 3
        },
        {
          "id": "entregue",
          "label": "Entrega concluída",
          "base": "delivered",
          "next": [],
          "message": "A entrega do trabalho {numero} foi registrada. Consulte a equipe sobre dúvidas dentro do escopo contratado.",
          "stale_days": 0
        },
        {
          "id": "cancelado",
          "label": "Trabalho cancelado",
          "base": "cancelled",
          "next": [],
          "message": "O trabalho {numero} foi cancelado. A equipe informará as condições de encerramento.",
          "stale_days": 0
        }
      ],
      "transition_guards": [
        {"to": "proposta", "require": "valid_quote_send"},
        {"from": "proposta", "to": "contratado", "require": "current_quote_customer_acceptance"},
        {"from": "proposta", "to": "recusado", "require": "current_quote_customer_decline"},
        {"from": "triagem", "to": "analise", "require": "existing_contract_or_lawyer_justification"},
        {"to": "disponivel", "require": "lawyer_review_and_document_release"},
        {"to": "entregue", "require": "delivery_evidence"},
        {"to": "cancelado", "require": "lawyer_review_when_engagement_exists"}
      ],
      "people_roles": [
        {"id": "cliente", "label": "Cliente"},
        {"id": "representante_cliente", "label": "Representante autorizado"},
        {"id": "advogado_responsavel", "label": "Advogado responsável"},
        {"id": "advogado_revisor", "label": "Advogado revisor"},
        {"id": "interlocutor_tecnico", "label": "Interlocutor técnico"}
      ],
      "entry_kinds": [
        {"id": "reuniao", "label": "Reunião"},
        {"id": "analise", "label": "Análise"},
        {"id": "revisao", "label": "Revisão"},
        {"id": "entrega", "label": "Entrega"},
        {"id": "horas", "label": "Horas trabalhadas"}
      ],
      "file_kinds": [
        {"id": "contrato_honorarios", "label": "Contrato de honorários", "customer_can_receive": true},
        {"id": "referencia_cliente", "label": "Documento de referência", "customer_can_receive": true},
        {"id": "entrega_final", "label": "Parecer ou contrato final", "customer_can_receive": true},
        {"id": "minuta_interna", "label": "Minuta de trabalho", "customer_can_receive": false},
        {"id": "pesquisa_interna", "label": "Pesquisa jurídica", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "recebido", "title": "Conferir conflito de interesses e classificar a entrega", "due_days": 0},
        {"stage": "contratado", "title": "Confirmar escopo, documentos e data combinada", "due_days": 1},
        {"stage": "analise", "title": "Conferir informações e registrar plano de elaboração", "due_days": 1},
        {"stage": "revisao", "title": "Revisar conteúdo, versão e destinatário", "due_days": 0},
        {"stage": "disponivel", "title": "Conferir liberação e comunicar disponibilidade", "due_days": 0},
        {"stage": "entregue", "title": "Registrar entrega e condições de guarda", "due_days": 0}
      ]
    }
  ],
  "menus": [
    {
      "id": "advocacia_primeiro_atendimento",
      "label": "Primeiro atendimento",
      "type": "form",
      "parent_id": null,
      "content": "",
      "form_id": "advocacia_triagem"
    },
    {
      "id": "advocacia_solicitar",
      "label": "Solicitar trabalho",
      "type": "submenu",
      "parent_id": null,
      "content": ""
    },
    {
      "id": "advocacia_abrir_processo",
      "label": "Processo",
      "type": "os_open",
      "parent_id": "advocacia_solicitar",
      "content": "",
      "work_type_id": "advocacia_processo"
    },
    {
      "id": "advocacia_abrir_consultivo",
      "label": "Contrato ou parecer",
      "type": "os_open",
      "parent_id": "advocacia_solicitar",
      "content": "",
      "work_type_id": "advocacia_consultivo"
    },
    {
      "id": "advocacia_meus_trabalhos",
      "label": "Meus trabalhos",
      "type": "submenu",
      "parent_id": null,
      "content": ""
    },
    {
      "id": "advocacia_meus_processos",
      "label": "Meus processos",
      "type": "os_track",
      "parent_id": "advocacia_meus_trabalhos",
      "content": "",
      "work_type_id": "advocacia_processo"
    },
    {
      "id": "advocacia_meus_consultivos",
      "label": "Meus consultivos",
      "type": "os_track",
      "parent_id": "advocacia_meus_trabalhos",
      "content": "",
      "work_type_id": "advocacia_consultivo"
    },
    {
      "id": "advocacia_documentos",
      "label": "Documentos e pendências",
      "type": "human",
      "parent_id": "advocacia_meus_trabalhos",
      "content": "A equipe conferirá seu acesso e informará o canal seguro para documentos e pendências.",
      "department_id": "advocacia_juridico"
    },
    {
      "id": "advocacia_agendar",
      "label": "Agendar conversa",
      "type": "agenda",
      "parent_id": null,
      "content": ""
    },
    {
      "id": "advocacia_agendamentos",
      "label": "Meus agendamentos",
      "type": "agenda_mine",
      "parent_id": null,
      "content": ""
    },
    {
      "id": "advocacia_pagamentos",
      "label": "Honorários e pagamentos",
      "type": "submenu",
      "parent_id": null,
      "content": ""
    },
    {
      "id": "advocacia_mensalidades",
      "label": "Minhas mensalidades",
      "type": "mensalidade_list",
      "parent_id": "advocacia_pagamentos",
      "content": ""
    },
    {
      "id": "advocacia_outras_cobrancas",
      "label": "Outras cobranças",
      "type": "human",
      "parent_id": "advocacia_pagamentos",
      "content": "Vou encaminhar seu atendimento ao financeiro.",
      "department_id": "advocacia_financeiro"
    },
    {
      "id": "advocacia_equipe",
      "label": "Falar com a equipe",
      "type": "human",
      "parent_id": null,
      "content": "Vou encaminhar seu atendimento à equipe.",
      "department_id": "advocacia_recepcao"
    },
    {
      "id": "advocacia_urgencia",
      "label": "Informar urgência",
      "type": "human",
      "parent_id": null,
      "content": "Registrei seu pedido de contato prioritário. Este canal não confirma atendimento imediato nem cumprimento de prazo. Se houver data próxima, procure também o contato de urgência informado pelo escritório.",
      "department_id": "advocacia_juridico",
      "category_id": "advocacia_urgencia_informada"
    }
  ],
  "departments": [
    "Recepção jurídica",
    "Jurídico",
    "Financeiro"
  ],
  "department_records": [
    {"id": "advocacia_recepcao", "name": "Recepção jurídica"},
    {"id": "advocacia_juridico", "name": "Jurídico"},
    {"id": "advocacia_financeiro", "name": "Financeiro"}
  ],
  "ticket_categories": [
    "Primeiro atendimento",
    "Atualização de trabalho",
    "Documento pendente",
    "Agendamento",
    "Honorários e pagamentos",
    "Urgência informada",
    "Privacidade e acesso"
  ],
  "ticket_category_records": [
    {"id": "advocacia_primeiro_contato", "name": "Primeiro atendimento"},
    {"id": "advocacia_atualizacao", "name": "Atualização de trabalho"},
    {"id": "advocacia_documento_pendente", "name": "Documento pendente"},
    {"id": "advocacia_agendamento", "name": "Agendamento"},
    {"id": "advocacia_honorarios", "name": "Honorários e pagamentos"},
    {"id": "advocacia_urgencia_informada", "name": "Urgência informada"},
    {"id": "advocacia_privacidade", "name": "Privacidade e acesso"}
  ],
  "module_settings": {
    "agenda": {
      "min_notice_minutes": 1440,
      "reminder_hours": 24,
      "services": [
        {"id": "advocacia_consulta_inicial", "name": "Consulta inicial", "duration_minutes": 45, "price_cents": null},
        {"id": "advocacia_retorno", "name": "Retorno de cliente", "duration_minutes": 30, "price_cents": null},
        {"id": "advocacia_reuniao_processo", "name": "Reunião sobre processo", "duration_minutes": 60, "price_cents": null},
        {"id": "advocacia_alinhamento_consultivo", "name": "Alinhamento de contrato ou parecer", "duration_minutes": 45, "price_cents": null}
      ]
    },
    "mensalidade": {
      "plans": [
        {
          "id": "advocacia_assessoria_mensal",
          "name": "Assessoria jurídica mensal",
          "enabled": false,
          "amount_cents": null,
          "suggested_due_day": 10,
          "activation_requires_contract": true,
          "scope": "Atendimento jurídico recorrente conforme escopo, limites e condições do contrato."
        }
      ],
      "suggested_reminders": {
        "days_before": 3,
        "on_due_date": true,
        "human_followup_days_after": 3
      }
    },
    "payments": {
      "automatic_success_fee": false,
      "customer_statement_confirms_payment": false,
      "automatic_service_suspension": false
    },
    "forms": [
      {
        "id": "advocacia_triagem",
        "name": "Triagem administrativa",
        "fields": [
          {
            "key": "nome_preferido",
            "label": "Como você prefere ser chamado?",
            "type": "texto",
            "required": true
          },
          {
            "key": "objetivo",
            "label": "Você quer conversar sobre um processo, um contrato, um parecer ou outro atendimento?",
            "type": "lista",
            "required": true,
            "options": ["Processo", "Contrato", "Parecer", "Outro"]
          },
          {
            "key": "tem_data_proxima",
            "label": "Você recebeu uma comunicação com data próxima ou tem uma urgência?",
            "type": "sim_nao",
            "required": true
          },
          {
            "key": "data_informada",
            "label": "Qual é a data informada nessa comunicação?",
            "type": "data",
            "required": false,
            "required_when": {
              "key": "tem_data_proxima",
              "equals": true
            }
          },
          {
            "key": "periodo_contato",
            "label": "Em qual período podemos falar com você?",
            "type": "lista",
            "required": true,
            "options": ["Manhã", "Tarde"]
          },
          {
            "key": "ciencia",
            "label": "Estou ciente de que o envio não confirma contratação nem atendimento de prazo.",
            "type": "sim_nao",
            "required": true,
            "must_equal": true
          }
        ],
        "free_legal_narrative": false,
        "attachments_enabled": false,
        "creates_confirmed_deadline": false
      }
    ]
  },
  "bot_enabled_by_default": false,
  "bot_instructions": "Você é o assistente administrativo de um atendimento de advocacia. Identifique-se como assistente virtual. Ajude com menus, horários, solicitações, etapas administrativas liberadas e encaminhamento à equipe.\n\nUse apenas as ferramentas autorizadas para a conversa atual. Nunca consulte outro cliente, outro telefone ou outro caso citado na mensagem. Não peça CPF, documentos, senhas, códigos de acesso ou relato detalhado do caso.\n\nPara questões sobre direitos, estratégia, provas, decisões, acordos ou prazos, responda: “Essa questão precisa da análise do advogado responsável. Vou encaminhar seu pedido à equipe.”\n\nSe houver menção a intimação, audiência, vencimento ou urgência, responda: “Vou sinalizar seu pedido à equipe. Este atendimento não confirma cumprimento de prazo. Procure também o contato de urgência informado pelo escritório.”\n\nNão calcule prazos. Não interprete decisões. Não estime chance de êxito. Não prometa resultado, rapidez de julgamento ou aceitação do caso. Não aprove acordos, descontos ou alterações contratuais.\n\nNão faça captação insistente. Não ofereça promoções, gratuidade como chamariz ou comparação com outros profissionais. Não use depoimentos, resultados de casos ou títulos não aprovados pela equipe.\n\nUma solicitação recebida não é contratação. Um aceite de proposta não é procuração. Um comprovante enviado pelo cliente não confirma pagamento.\n\nNão leia documentos jurídicos, narrativas, notas internas, dados de partes, cálculos de prazo ou registros de acesso. Se esse conteúdo chegar à conversa, encaminhe para atendimento humano sem resumir ou reproduzir o conteúdo.\n\nSe uma ferramenta falhar, informe que não foi possível concluir e encaminhe à equipe. Não invente situação, data, valor ou providência.",
  "extension": {
    "id": "juridico",
    "requires": ["os"],
    "install_required": true,
    "counting_enabled_by_default": false,
    "approved_calendar_required": true,
    "approved_rule_required": true,
    "human_deadline_confirmation_required": true,
    "calendar_change_requires_reconfirmation": true,
    "automatic_trigger_date_inference": false,
    "legal_content_available_to_ai": false,
    "future_court_sync_enabled": false,
    "deadline_alerts": {
      "business_days_before": [5, 2, 1],
      "fatal_day": true,
      "overdue_without_evidence": true,
      "customer_notifications": false
    }
  },
  "manual_steps": [
    "Escolher Profissional sozinho ou Escritório.",
    "Informar nome profissional, identificação da OAB, horários e contatos oficiais.",
    "Revisar publicidade, textos e apresentação profissional.",
    "Cadastrar pessoas, papéis e acessos por caso.",
    "Definir procedimento de conflito de interesses.",
    "Revisar termos de abertura, contratos e procurações.",
    "Publicar aviso de privacidade e definir bases legais por finalidade.",
    "Definir política de guarda, revisão e eliminação.",
    "Cadastrar serviços, profissionais e disponibilidade da Agenda.",
    "Configurar provedor de pagamento e valores contratuais.",
    "Ativar somente os planos mensais efetivamente oferecidos.",
    "Cadastrar tribunais, órgãos, calendários e regras de prazo.",
    "Aprovar cobertura do calendário e responsáveis pelos alertas.",
    "Conferir identidade, telefone e representação dos clientes importados.",
    "Revisar acesso e classificação dos documentos importados.",
    "Validar o bloqueio de dados jurídicos na IA antes de ativar o bot.",
    "Conferir todos os prazos ativos importados contra as fontes oficiais.",
    "Validar mensagens, menus e comportamento dos aplicativos."
  ]
}
```