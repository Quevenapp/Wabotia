**Modelos de área: Engenheiros, Arquitetos e Construtoras**  
**Data:** 18/11/2026. **Base:** commit `efc7e54`, versão `0.21.1` (`package.json:3`).  
**Natureza:** proposta de produto e configuração. Não houve alteração de arquivos, acesso à rede nem execução de testes.

Os três modelos dependem do motor de OS generalizado descrito no plano. Campos extras, etapas configuráveis, aprovação de entregáveis, documentos com versão e lançamentos estruturados são **propostas**, não funcionalidades aqui declaradas como prontas.

**Base conferida e cuidados de implementação**

| Assunto | Evidência no repositório | Consequência para os modelos |
|---|---|---|
| Estados e transições | `src/modules/os/model.ts:6`, `src/modules/os/model.ts:41`, `src/modules/os/model.ts:53` | Preservar os nove códigos. A etapa própria terá identidade separada. |
| Aprovação atual | `src/modules/os/store.ts:826`, `src/modules/os/store.ts:839` | Hoje a decisão exige orçamento pendente. Aprovar uma prancha ou medição exige outro contrato de decisão. |
| Efeitos de entrega | `src/modules/os/store.ts:535`, `src/modules/os/store.ts:538` | O estado de base não pode, sozinho, iniciar garantia nos novos tipos. |
| Retirada | `src/modules/os/reminders.ts:23`, `src/modules/os/reminders.ts:26` | Desligar retirada em todos os tipos deste documento. Entrega digital não é retirada. |
| Aviso de ordem parada | `src/modules/os/reminders.ts:48`, `src/modules/os/reminders.ts:58` | O aviso por etapa proposto deve usar a entrada na etapa. Uma anotação comum não deve reiniciar esse prazo. |
| Numeração | `migrations/0035_os_orders.sql:7`, `migrations/0035_os_orders.sql:57` | Hoje há sequência e unicidade por área. Proposta: preservar `number` e acrescentar número por tipo, sem remover a restrição existente. |
| Paginação e contagem | `src/modules/os/store.ts:257`, `src/modules/os/store.ts:266` | Preservar o cursor legado. `counts` usa estados presentes no banco; não pressupor que sempre haverá nove chaves preenchidas. |
| Aplicativos | `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:162`, `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:163`, `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:196` | Há estados, rótulos e ações fixos. A leitura básica pode permanecer compatível, mas a operação completa dos novos tipos precisa de adaptação. |
| Referência no menu | `src/modules/types.ts:18`, `src/modules/os/definition.ts:28` | O contrato admite referência. Os itens atuais de OS ainda não declaram referência a um tipo. |
| Modelos existentes | `src/service-templates.ts:341`, `src/service-templates.ts:442` | Reutilizar a validação comum. Aplicar estes modelos apenas por mesclagem, preservando configurações existentes. |
| Infraestrutura | `docs/MODULOS.md:14`, `docs/MODULOS.md:17` | Nenhum recurso novo na Cloudflare. DDL apenas aditivo. Toda tabela nova terá `profile_id`. |

**Convenções das três propostas**

| Convenção | Definição |
|---|---|
| Obrigatório | Exigido para salvar o cadastro completo. Dados produzidos durante o serviço, como ART, RRT e protocolo municipal, não são exigidos na abertura. |
| Cliente vê | Somente o cliente autorizado daquele trabalho, em consulta autenticada. Não significa publicação ou envio automático. |
| Sensível | Classificação de acesso do produto. Campo sensível fica fora da IA, das mensagens e dos perfis sem autorização. Não equivale, necessariamente, à classificação jurídica de dado pessoal sensível. |
| Campos fixos | Sempre obrigatórios. Usar identificação curta no primeiro e descrição do escopo ou pedido no segundo. Não colocar senha, código de acesso ou documento pessoal nesses campos. |
| Dias | Dias corridos, no horário de Brasília. São referências operacionais, não prazos legais nem promessas comerciais. |
| Prazo das tarefas | Contado da entrada na etapa. O responsável ajusta ao contrato ou cronograma. Uma tarefa nasce uma vez por entrada na etapa. Reenvio de evento não a duplica. |
| Aviso de etapa parada | `stale_days: 0` desliga. Nos demais casos, avisar a equipe uma vez por permanência na etapa. |
| Mensagem vazia | Não enviar mensagem ao entrar na etapa. |
| Identificadores | Tipos, menus e cadastros usam o prefixo do modelo. Campos e etapas têm identificadores locais ao tipo. |
| JSON | Formato neutro proposto. As chaves adicionais, como `approval_stages`, `terms_text` e `module_settings`, preservam decisões necessárias à conversão. Não são contratos atuais da API. |
| Aplicação | Mostrar prévia de inclusões e mudanças. Não desligar silenciosamente módulos em uso. Conflitos ficam para decisão da pessoa que aplica. |

**Contrato comum de aprovação e documentos — proposta para o motor**

A aprovação de etapa será independente do orçamento. O cliente recebe o entregável liberado, sua versão e uma ação explícita. A confirmação registra trabalho, etapa, versão, arquivos apresentados, telefone autorizado, decisão, data e canal. Uma versão nova invalida as decisões pendentes da anterior.

O texto padrão será:

> “Trabalho {numero}: a etapa {etapa}, versão {versao}, está disponível para sua análise. Confira os arquivos liberados e escolha APROVAR ETAPA ou PEDIR AJUSTES. A aprovação vale somente para esta versão e para o escopo apresentado.”

Ao aprovar:

> “Aprovação registrada para o trabalho {numero}, etapa {etapa}, versão {versao}. A equipe seguirá o escopo aprovado.”

Ao pedir ajustes:

> “Pedido de ajustes registrado no trabalho {numero}, etapa {etapa}, versão {versao}. Descreva o que precisa mudar. A equipe verificará o escopo e o prazo antes de continuar.”

A aprovação não transfere responsabilidade técnica ao cliente. Também não autoriza obra, substitui licença pública ou constitui renúncia a direitos.

| Elemento | Regra proposta |
|---|---|
| Etapa com aprovação | Não avança sem decisão válida sobre a versão atual. Correções permanecem na mesma etapa e geram nova versão. |
| Exceção de percurso | Somente o responsável técnico registra que uma etapa não se aplica, com motivo. O cliente não dispensa exigência técnica ou administrativa. |
| Aprovação municipal | Registrada pela equipe após conferir a evidência. O botão do cliente não representa aprovação da prefeitura. |
| Documento | Identificador estável, tipo, título, versão inteira, data, autor, etapa, arquivo no R2 e indicação de versão substituída. |
| Arquivo revisado | Novo objeto no R2. Não sobrescrever o arquivo já aprovado. |
| Liberação | A permissão do tipo de documento é um teto. Cada arquivo também exige liberação humana. |
| Download | Conferir área, trabalho e autorização em cada acesso. Não usar endereço público permanente. |
| IA | Não recebe arquivos técnicos brutos, dados sensíveis ou texto extraído desses arquivos. Pode ler apenas resumos liberados e metadados não sensíveis. |
| Pessoas ligadas | Cadastrar alguém não lhe concede acesso. O acesso continua limitado ao telefone autorizado do trabalho. |
| Marcadores novos | `{etapa}`, `{versao}`, `{tarefa}` e `{vencimento}` precisam entrar no contrato de mensagens. Os valores atuais da OS estão em `src/modules/os/model.ts:306`. |

# 1. Engenheiros

## 1. Quem usa e como é o dia a dia

Engenheiro autônomo ou escritório com apoio administrativo e desenhista.  
O cliente é o proprietário, síndico, pequeno empresário ou contratante de uma obra.  
O escritório recebe pedidos de projeto, vistoria, avaliação e acompanhamento.  
O WhatsApp concentra dúvidas sobre preço, visita, documentos, alterações e prazo.  
As perguntas mais comuns são “quando fica pronto?”, “já saiu a aprovação?” e “posso executar esta versão?”.  
O responsável técnico decide o conteúdo técnico. O administrativo organiza agenda, documentos e cobrança.

## 2. Tipos de trabalho

### Projeto / Projetos

| Elemento | Configuração |
|---|---|
| ID | `engenharia_projeto` |
| Primeiro campo fixo | Imóvel ou empreendimento |
| Segundo campo fixo | Objetivo e escopo solicitado |
| Numeração apresentada | `PROJ-{numero_tipo}` |
| Escopo inicial | Projetos e acompanhamento contratados. Não presume contratação da execução da obra. |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|---|
| `disciplina` | Disciplina | lista: estrutural, elétrica, hidrossanitária, civil, outra | Sim | Sim | Não |
| `municipio` | Município e UF | texto | Sim | Sim | Não |
| `endereco` | Endereço completo do imóvel | texto_longo | Sim | Não | Sim |
| `area_m2` | Área de referência em m² | numero | Não | Sim | Não |
| `art_numero` | Número da ART | texto | Não | Sim | Não |
| `protocolo_prefeitura` | Protocolo municipal | texto | Não | Sim | Não |
| `prazo_contratado` | Data de entrega contratada | data | Não | Sim | Não |

ART é campo de referência, não prova automática de validade. A equipe confere documento, responsável, atividade e situação. Obrigatoriedade, momento do registro e regras do CREA: **a conferir**.

**Etapas**

A coluna de tarefa informa o título pronto e o vencimento inicial. As tarefas são internas, salvo indicação expressa em contrário.

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso parado | Tarefa padrão |
|---|---|---|---|---|---:|---|
| `entrada` | Solicitação recebida | `received` | `orcamento`, `cancelado` | Recebemos o pedido de projeto {numero}. A equipe conferirá o escopo e os documentos necessários. | 2 | Conferir escopo e documentos — 1 dia |
| `orcamento` | Proposta enviada | `quoted` | `contratado`, `recusado`, `entrada`, `cancelado` | A proposta do projeto {numero} está disponível. Confira escopo, entregas e condições antes de aprovar. | 3 | Acompanhar resposta à proposta — 3 dias |
| `contratado` | Proposta aprovada | `approved` | `levantamento`, `cancelado` | A proposta do projeto {numero} foi aprovada. Vamos combinar o levantamento e confirmar o cronograma. | 2 | Confirmar contrato, responsável técnico e ART aplicável — 1 dia |
| `recusado` | Proposta recusada | `declined` | `entrada`, `cancelado` | A recusa da proposta do projeto {numero} foi registrada. A equipe pode esclarecer o escopo ou encerrar a solicitação. | 3 | Verificar revisão da proposta ou encerramento — 2 dias |
| `levantamento` | Levantamento | `in_progress` | `estudo_preliminar`, `cancelado` | O projeto {numero} está em levantamento. Avisaremos se faltar alguma informação do imóvel. | 7 | Agendar visita e registrar levantamento — 3 dias |
| `estudo_preliminar` | Estudo preliminar | `in_progress` | `anteprojeto`, `cancelado` | Iniciamos o estudo preliminar do projeto {numero}. A versão para sua análise será enviada após a revisão técnica. | 7 | Revisar e liberar estudo preliminar — 7 dias |
| `anteprojeto` | Anteprojeto | `in_progress` | `projeto_legal`, `executivo`, `cancelado` | O projeto {numero} está em anteprojeto, conforme a versão anterior aprovada. | 10 | Compatibilizar e liberar anteprojeto — 7 dias |
| `projeto_legal` | Projeto para aprovação | `in_progress` | `prefeitura`, `cancelado` | Estamos preparando os documentos do projeto {numero} para o processo de aprovação aplicável. | 7 | Conferir documentos e preparar protocolo — 5 dias |
| `prefeitura` | Em análise na prefeitura | `in_progress` | `projeto_legal`, `executivo`, `cancelado` | O projeto {numero} está em análise na prefeitura. O prazo depende do órgão. Avisaremos sobre exigências ou decisão. | 14 | Consultar protocolo e registrar andamento — 7 dias |
| `executivo` | Projeto executivo | `in_progress` | `acompanhamento`, `entrega`, `cancelado` | Iniciamos o projeto executivo {numero}. Use somente documentos liberados pela equipe para a finalidade indicada. | 10 | Revisar pranchas, memoriais e compatibilização — 7 dias |
| `acompanhamento` | Acompanhamento contratado | `in_progress` | `entrega`, `cancelado` | O projeto {numero} está em acompanhamento. As visitas seguirão o escopo e o calendário contratados. | 14 | Confirmar próxima visita e emitir relatório — 7 dias |
| `entrega` | Entrega disponível | `ready` | `executivo`, `concluido`, `cancelado` | A entrega do projeto {numero} está disponível. Confira a relação de documentos e confirme o recebimento. | 3 | Conferir pacote final e solicitar recebimento — 2 dias |
| `concluido` | Concluído | `delivered` | — | O projeto {numero} foi concluído. Guarde os documentos e as versões liberadas para cada finalidade. | 0 | — |
| `cancelado` | Cancelado | `cancelled` | — | O projeto {numero} foi cancelado. As condições de encerramento serão tratadas pela equipe. | 0 | — |

**Recursos ligados**

| Recurso | Uso |
|---|---|
| Orçamento com aprovação | Ligado. Validade sugerida de 7 dias. Separar projeto, visitas e serviços adicionais. O valor nasce da proposta humana. |
| Aprovação de etapa | Levantamento, estudo preliminar, anteprojeto, projeto legal, executivo e acompanhamento. No levantamento, o cliente confirma o programa e as informações fornecidas. |
| Desvio de percurso | Anteprojeto pode seguir ao executivo quando a etapa municipal não se aplicar, com justificativa técnica. Executivo pode seguir à entrega quando não houver acompanhamento contratado. |
| Garantia | Desligada. Não aplicar automaticamente garantia de assistência técnica ao projeto. |
| Retirada | Desligada. |
| Termos | Ligados, com o texto abaixo. |
| Tarefas e prazos | Conforme a tabela. Cronograma contratual detalhado é ajustado pelo responsável. Pendências do cliente são tarefas próprias, visíveis apenas a ele. |
| Pessoas ligadas | Contratante, proprietário, responsável técnico, projetista complementar e responsável pela execução. |
| Documentos liberáveis | Proposta, contrato, ART, prancha, memorial, protocolo ou licença municipal e relatório de visita. |
| Documentos internos | Memória de cálculo e checklist de revisão. O contrato pode prever entrega específica, mediante revisão da configuração. |
| Lançamentos | Andamento, visita técnica, horas trabalhadas e solicitação de alteração. Horas são internas por padrão. Alterações aprovadas geram nova versão e eventual proposta adicional. |

**Termo de abertura**

> “Solicito a análise do projeto informado. A contratação depende da aprovação de uma proposta com escopo, entregas, preço e prazo. Confirmarei as versões apresentadas pelo canal indicado. Alterações após uma aprovação serão avaliadas pela equipe. A aprovação pelo WhatsApp não substitui revisão técnica, registro profissional ou licença exigível. A execução deve usar documentos liberados para essa finalidade.”

### Laudo ou vistoria / Laudos e vistorias

| Elemento | Configuração |
|---|---|
| ID | `engenharia_laudo` |
| Primeiro campo fixo | Imóvel ou elemento a vistoriar |
| Segundo campo fixo | Motivo e finalidade da solicitação |
| Numeração apresentada | `VIST-{numero_tipo}` |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|---|
| `modalidade` | Modalidade | lista: vistoria, inspeção, laudo, outra | Sim | Sim | Não |
| `municipio` | Município e UF | texto | Sim | Sim | Não |
| `endereco` | Endereço completo | texto_longo | Sim | Não | Sim |
| `finalidade` | Uso pretendido do documento | texto_longo | Sim | Sim | Não |
| `art_numero` | Número da ART | texto | Não | Sim | Não |
| `data_visita` | Data prevista da visita | data | Não | Sim | Não |
| `restricoes_acesso` | Restrições e cuidados de acesso | texto_longo | Não | Não | Sim |

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso parado | Tarefa padrão |
|---|---|---|---|---|---:|---|
| `entrada` | Solicitação recebida | `received` | `orcamento`, `cancelado` | Recebemos a solicitação de vistoria {numero}. A equipe verificará a finalidade e o escopo. | 1 | Conferir finalidade e prioridade — 1 dia |
| `orcamento` | Proposta enviada | `quoted` | `contratado`, `recusado`, `entrada`, `cancelado` | A proposta da vistoria {numero} está disponível. Confira o que será examinado e entregue. | 3 | Acompanhar resposta à proposta — 3 dias |
| `contratado` | Serviço contratado | `approved` | `vistoria`, `cancelado` | A proposta da vistoria {numero} foi aprovada. Vamos confirmar a visita e as condições de acesso. | 2 | Confirmar visita, acesso e ART aplicável — 1 dia |
| `recusado` | Proposta recusada | `declined` | `entrada`, `cancelado` | A recusa da proposta da vistoria {numero} foi registrada. | 3 | Verificar revisão ou encerramento — 2 dias |
| `vistoria` | Vistoria em campo | `analyzing` | `elaboracao`, `cancelado` | A vistoria {numero} está na etapa de campo. A equipe registrará o que foi examinado e as limitações encontradas. | 3 | Realizar vistoria e organizar evidências — 2 dias |
| `elaboracao` | Elaboração e revisão | `in_progress` | `vistoria`, `entrega`, `cancelado` | O documento da vistoria {numero} está em elaboração e revisão técnica. | 5 | Revisar conclusões, anexos e assinatura — 5 dias |
| `entrega` | Documento disponível | `ready` | `elaboracao`, `concluido`, `cancelado` | O documento da vistoria {numero} está disponível. Confira a versão e confirme o recebimento. | 3 | Enviar versão assinada e pedir recebimento — 1 dia |
| `concluido` | Concluído | `delivered` | — | A vistoria {numero} foi concluída. A equipe permanece como contato para esclarecimentos sobre o documento entregue. | 0 | — |
| `cancelado` | Cancelado | `cancelled` | — | A solicitação de vistoria {numero} foi cancelada. | 0 | — |

| Recurso | Uso |
|---|---|
| Orçamento | Ligado. Validade de 7 dias. Preço e escopo dependem da finalidade e das condições de inspeção. |
| Aprovação | Aceite comercial e confirmação de recebimento. O cliente não aprova nem altera a conclusão técnica. |
| Garantia e retirada | Desligadas. |
| Termos | Texto abaixo. |
| Tarefas | Conforme a tabela. Complementação de evidências volta à vistoria. |
| Pessoas ligadas | Contratante, responsável pelo acesso, responsável técnico e representante do imóvel. |
| Documentos liberáveis | Proposta, ART, relatório ou laudo assinado e registro fotográfico revisado. |
| Documentos internos | Fotos brutas, notas de campo e checklist técnico. |
| Lançamentos | Visita, evidência, limitação de inspeção, andamento e horas. Evidências e limitações ficam internas até revisão. |

**Termo de abertura**

> “Solicito proposta para a vistoria e a finalidade informadas. A equipe confirmará o escopo, as condições de acesso e os limites do serviço. A abertura não constitui avaliação técnica do imóvel. O documento será emitido após análise do profissional responsável. Confirmar o recebimento não significa concordar com a conclusão nem impede pedir esclarecimentos.”

## 3. Vocabulário

| Conceito | Nome na área |
|---|---|
| Cliente | Contratante |
| Trabalho | Projeto ou laudo/vistoria |
| Conjunto dos tipos | Trabalhos |
| Responsável | Engenheiro responsável |
| Orçamento | Proposta de serviços |
| Entrega | Pacote de documentos ou documento técnico |

## 4. Módulos

Cobrança usa o ID `payments`, não `cobranca` (`src/modules/payments/definition.ts:6`). Formulários usa `forms` (`src/modules/forms/definition.ts:6`).

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| OS | Ligado | Tipos Projeto e Laudo ou vistoria. |
| Agenda | Ligado | Reunião inicial: 30 min; levantamento: 90 min; vistoria: 90 min; acompanhamento: 60 min. |
| Mensalidade | Desligado | Nenhum plano criado. Acompanhamento recorrente exige contratação específica antes de ligar. |
| Formulários | Ligado | Formulário “Informações iniciais do projeto”, abaixo. |
| Cobrança | Ligado | Entrada e parcelas conforme proposta humana. Não criar cobrança pela simples abertura. |
| Reserva | Desligado | Sem catálogo. |
| ERP | Desligado | Sem cadastro financeiro ou estoque criado pelo modelo. |

A Agenda já admite duração por serviço (`src/modules/agenda/catalog.ts:24`) e parâmetros de antecedência e lembrete (`src/modules/agenda/config.ts:9`).

| Parâmetro da Agenda | Sugestão |
|---|---|
| Antecedência mínima | 48 horas |
| Janela futura | 30 dias |
| Grade | 30 minutos |
| Lembrete | 24 horas antes |
| Remarcação pelo cliente | Até 24 horas antes |
| Disponibilidade | Cadastrada manualmente. Bloquear deslocamento entre visitas. |
| Endereço | Confirmado pela equipe em canal protegido. Não enviado ao bot. |

**Formulário “Informações iniciais do projeto”**

| Pergunta pronta | Tipo | Obrigatória |
|---|---|---|
| Qual é o nome ou a identificação curta do imóvel? | texto | Sim |
| Em qual município e UF fica o imóvel? | texto | Sim |
| O que você pretende construir, reformar ou regularizar? | texto_longo | Sim |
| Qual disciplina você precisa? | lista: estrutural, elétrica, hidrossanitária, civil, não sei | Sim |
| Qual é a área aproximada em m², se souber? | numero | Não |
| Existe uma data desejada? | data | Não |

O vínculo automático entre a resposta desse formulário e o trabalho é **a conferir**. Até existir contrato próprio, a equipe confere e transfere as informações.

## 5. WhatsApp

| Caminho do menu | Ação |
|---|---|
| Solicitar projeto | `os_open`, referência `engenharia_projeto` |
| Solicitar vistoria | `os_open`, referência `engenharia_laudo` |
| Acompanhar → Projetos | `os_track`, referência `engenharia_projeto` |
| Acompanhar → Vistorias | `os_track`, referência `engenharia_laudo` |
| Agendar atendimento | Agenda |
| Meus agendamentos | Consulta, remarcação e cancelamento permitidos pela Agenda |
| Informações do projeto | Formulário inicial |
| Pagamentos | Atendimento humano do Financeiro |
| Falar com a equipe | Atendimento humano do Atendimento |

O cliente abre solicitações, consulta trabalhos próprios, agenda horários disponíveis, responde pendências e recebe arquivos liberados. Nos novos fluxos, aprova orçamento ou versão de etapa com confirmação explícita. O envio de arquivo exige selecionar o trabalho e confirmar a associação.

| Disparo | Texto pronto | Regra |
|---|---|---|
| Confirmação da Agenda | “Agendado: {servico} com {profissional}, em {data} às {hora}. A equipe confirmará as condições de acesso quando houver visita.” | Após agendamento confirmado |
| Lembrete da Agenda | “Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma?” | 24 horas antes |
| Aprovação pendente | “O projeto {numero} aguarda sua análise da etapa {etapa}, versão {versao}. Abra a solicitação para aprovar ou pedir ajustes.” | Uma vez, após 3 dias |
| Tarefa do cliente | “No trabalho {numero}, falta concluir: {tarefa}. Prazo combinado: {vencimento}. Se precisar ajustar, fale com a equipe.” | Um dia antes; somente tarefa visível ao cliente |
| Etapa parada | “Trabalho {numero}: etapa {etapa} sem avanço. Confira o cronograma e registre a próxima ação.” | Equipe; conforme tabela |
| Possível risco | “Não é possível avaliar a segurança do imóvel por esta conversa. Afaste-se da situação de risco e procure o atendimento de emergência competente. Vou sinalizar o relato à equipe.” | Encaminhamento prioritário; sem diagnóstico |

As mensagens automáticas respeitam disponibilidade e regras do canal. A configuração concreta de modelos aprovados e envio fora da janela de atendimento é **a conferir**. O próprio modelo de central existente registra essa dependência em `src/service-templates.ts:239`.

## 6. Bot da área

**Texto para o campo de instruções**

> “Você atende os contratantes deste escritório de engenharia. Consulte somente trabalhos vinculados ao telefone desta conversa e informações liberadas ao cliente. Ajude a abrir solicitações, consultar etapas, responder pendências e usar a Agenda. Mostre apenas prazos registrados pela equipe. Nunca calcule, diagnostique, libere execução, prometa aprovação pública ou declare uma estrutura segura. Não aprove propostas nem etapas pelo cliente. Peça confirmação explícita nas ações disponíveis. Encaminhe dúvidas técnicas, alterações de escopo, descontos e conflitos à equipe. Não leia campos sensíveis, documentos brutos, memórias de cálculo, fotos privadas ou notas internas. Em relato de risco, envie a orientação de segurança cadastrada e sinalize prioridade à equipe.”

| Nível | Ações |
|---|---|
| Sozinho | Informar etapa e prazo liberados; localizar pendência própria; apresentar serviços e horários. |
| Com confirmação do cliente | Propor abertura, agendamento e envio de resposta pelos mecanismos autorizados. |
| Consulta a equipe antes | Alteração de escopo, prazo, prioridade, preço, responsável ou documentos liberados. |
| Nunca | Emitir conclusão técnica, escolher solução construtiva, validar ART, aprovar etapa pelo cliente ou afirmar aprovação municipal sem registro humano. |
| Não pode ler | Endereço sensível, restrições de acesso, arquivos técnicos brutos, fotos privadas, documentos pessoais, notas e custos internos. |

Instruções de texto não bastam para impedir acesso. A filtragem deve ocorrer antes da resposta das ferramentas. O contrato atual já distingue ferramentas do cliente e da equipe e prevê tratamento de dados pessoais (`docs/MODULOS.md:379`, `docs/MODULOS.md:403`, `docs/MODULOS.md:520`).

## 7. Equipe

A matriz abaixo é proposta para o motor generalizado. Hoje a declaração de OS contém o papel `technician` (`src/modules/os/definition.ts:61`). Os papéis adicionais não devem ser apresentados como prontos.

| Papel | Vê | Faz |
|---|---|---|
| Atendimento | Identificação, etapa, agenda e pendências liberadas | Abre solicitação, organiza atendimento e cobra documentos necessários |
| Engenheiro responsável | Dados técnicos e sensíveis dos trabalhos atribuídos | Define escopo, revisa, libera versões e registra decisões técnicas |
| Projetista | Trabalhos atribuídos e documentos necessários | Produz versões, registra horas e responde tarefas; não libera sozinho |
| Financeiro | Contratante, proposta aprovada e cobranças | Emite cobranças e registra tratativas financeiras |
| Gestor | Operação e permissões concedidas | Distribui trabalhos, configura modelos e acompanha prazos |

| Organização | Valores |
|---|---|
| Setores | Atendimento; Engenharia; Financeiro |
| Categorias de protocolo | Novo projeto; Vistoria; Documentos; Alteração de escopo; Aprovação; Prazo; Pagamento; Relato de risco |

## 8. Passos manuais

| Ordem | Ação |
|---:|---|
| 1 | Cadastrar responsáveis, atribuições profissionais e acessos. |
| 2 | Ajustar disciplinas, escopo dos serviços e preços. |
| 3 | Revisar termos, política de privacidade e retenção documental. |
| 4 | Cadastrar horários e bloqueios de deslocamento na Agenda. |
| 5 | Configurar a conta de cobrança e os responsáveis financeiros. |
| 6 | Definir quais entregas precisam de ART e conferir as regras aplicáveis. |
| 7 | Definir responsável pela liberação de cada versão e pelo protocolo municipal. |
| 8 | Configurar mensagens do canal e validar o fluxo com dados fictícios antes de publicar. |

## 10. Dúvidas e decisões

| Decisão | Proposta |
|---|---|
| Nome do conjunto | “Trabalhos”. |
| Acompanhamento | Opcional por contrato. Não confundir acompanhamento pontual com responsabilidade pela execução. |
| Arquivos editáveis | Não liberar por padrão. Definir no contrato. |
| Aprovação de etapa | Usar o contrato comum, separado do orçamento. |
| Privacidade e guarda | Política por documento e finalidade. Prazos legais e profissionais: **a conferir**. |
| ART e exigências locais | Responsável técnico confirma por atividade e localidade. **A conferir**. |
| Aplicativos antigos | Não habilitar decisões ambíguas de etapa até fechar o contrato de compatibilidade. |

**Modelo neutro**

```json
{
  "id": "engenharia",
  "name": "Engenheiros",
  "labels": {
    "customer": "Contratante",
    "customers": "Contratantes",
    "work_collection": "Trabalhos",
    "responsible": "Engenheiro responsável",
    "quote": "Proposta de serviços"
  },
  "modules": {
    "on": ["os", "agenda", "forms", "payments"],
    "off": ["mensalidade", "reserva", "erp"]
  },
  "policies": {
    "apply_mode": "merge",
    "sensitive_to_ai": false,
    "raw_files_to_ai": false,
    "file_versions_immutable": true,
    "file_release_requires_human": true,
    "approval_scope": "work_stage_version_files",
    "approval_reminder_days": 3,
    "task_days": "calendar",
    "customer_task_reminder_days_before": 1
  },
  "work_types": [
    {
      "id": "engenharia_projeto",
      "singular": "Projeto",
      "plural": "Projetos",
      "item_label": "Imóvel ou empreendimento",
      "problem_label": "Objetivo e escopo solicitado",
      "number_prefix": "PROJ",
      "features": {"quote": true, "warranty": false, "pickup": false, "terms": true, "tasks": true, "people": true, "files": true, "entries": true},
      "quote_valid_days": 7,
      "terms_text": "Solicito a análise do projeto informado. A contratação depende da aprovação de uma proposta com escopo, entregas, preço e prazo. Confirmarei as versões apresentadas pelo canal indicado. Alterações após uma aprovação serão avaliadas pela equipe. A aprovação pelo WhatsApp não substitui revisão técnica, registro profissional ou licença exigível. A execução deve usar documentos liberados para essa finalidade.",
      "fields": [
        {"key": "disciplina", "label": "Disciplina", "type": "lista", "required": true, "customer_visible": true, "sensitive": false, "options": ["estrutural", "elétrica", "hidrossanitária", "civil", "outra"]},
        {"key": "municipio", "label": "Município e UF", "type": "texto", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "endereco", "label": "Endereço completo do imóvel", "type": "texto_longo", "required": true, "customer_visible": false, "sensitive": true, "options": []},
        {"key": "area_m2", "label": "Área de referência em m²", "type": "numero", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "art_numero", "label": "Número da ART", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "protocolo_prefeitura", "label": "Protocolo municipal", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "prazo_contratado", "label": "Data de entrega contratada", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []}
      ],
      "stages": [
        {"id": "entrada", "label": "Solicitação recebida", "base": "received", "next": ["orcamento", "cancelado"], "message": "Recebemos o pedido de projeto {numero}. A equipe conferirá o escopo e os documentos necessários.", "stale_days": 2},
        {"id": "orcamento", "label": "Proposta enviada", "base": "quoted", "next": ["contratado", "recusado", "entrada", "cancelado"], "message": "A proposta do projeto {numero} está disponível. Confira escopo, entregas e condições antes de aprovar.", "stale_days": 3},
        {"id": "contratado", "label": "Proposta aprovada", "base": "approved", "next": ["levantamento", "cancelado"], "message": "A proposta do projeto {numero} foi aprovada. Vamos combinar o levantamento e confirmar o cronograma.", "stale_days": 2},
        {"id": "recusado", "label": "Proposta recusada", "base": "declined", "next": ["entrada", "cancelado"], "message": "A recusa da proposta do projeto {numero} foi registrada. A equipe pode esclarecer o escopo ou encerrar a solicitação.", "stale_days": 3},
        {"id": "levantamento", "label": "Levantamento", "base": "in_progress", "next": ["estudo_preliminar", "cancelado"], "message": "O projeto {numero} está em levantamento. Avisaremos se faltar alguma informação do imóvel.", "stale_days": 7},
        {"id": "estudo_preliminar", "label": "Estudo preliminar", "base": "in_progress", "next": ["anteprojeto", "cancelado"], "message": "Iniciamos o estudo preliminar do projeto {numero}. A versão para sua análise será enviada após a revisão técnica.", "stale_days": 7},
        {"id": "anteprojeto", "label": "Anteprojeto", "base": "in_progress", "next": ["projeto_legal", "executivo", "cancelado"], "message": "O projeto {numero} está em anteprojeto, conforme a versão anterior aprovada.", "stale_days": 10},
        {"id": "projeto_legal", "label": "Projeto para aprovação", "base": "in_progress", "next": ["prefeitura", "cancelado"], "message": "Estamos preparando os documentos do projeto {numero} para o processo de aprovação aplicável.", "stale_days": 7},
        {"id": "prefeitura", "label": "Em análise na prefeitura", "base": "in_progress", "next": ["projeto_legal", "executivo", "cancelado"], "message": "O projeto {numero} está em análise na prefeitura. O prazo depende do órgão. Avisaremos sobre exigências ou decisão.", "stale_days": 14},
        {"id": "executivo", "label": "Projeto executivo", "base": "in_progress", "next": ["acompanhamento", "entrega", "cancelado"], "message": "Iniciamos o projeto executivo {numero}. Use somente documentos liberados pela equipe para a finalidade indicada.", "stale_days": 10},
        {"id": "acompanhamento", "label": "Acompanhamento contratado", "base": "in_progress", "next": ["entrega", "cancelado"], "message": "O projeto {numero} está em acompanhamento. As visitas seguirão o escopo e o calendário contratados.", "stale_days": 14},
        {"id": "entrega", "label": "Entrega disponível", "base": "ready", "next": ["executivo", "concluido", "cancelado"], "message": "A entrega do projeto {numero} está disponível. Confira a relação de documentos e confirme o recebimento.", "stale_days": 3},
        {"id": "concluido", "label": "Concluído", "base": "delivered", "next": [], "message": "O projeto {numero} foi concluído. Guarde os documentos e as versões liberadas para cada finalidade.", "stale_days": 0},
        {"id": "cancelado", "label": "Cancelado", "base": "cancelled", "next": [], "message": "O projeto {numero} foi cancelado. As condições de encerramento serão tratadas pela equipe.", "stale_days": 0}
      ],
      "approval_stages": ["levantamento", "estudo_preliminar", "anteprojeto", "projeto_legal", "executivo", "acompanhamento"],
      "receipt_stages": ["entrega"],
      "transition_guards": [
        {"from": "anteprojeto", "to": "executivo", "rule": "Responsável técnico registra que a etapa municipal não se aplica."},
        {"from": "prefeitura", "to": "executivo", "rule": "Equipe confere e registra a aprovação administrativa aplicável."},
        {"from": "executivo", "to": "entrega", "rule": "Não há acompanhamento contratado."}
      ],
      "people_roles": [
        {"id": "contratante", "label": "Contratante"},
        {"id": "proprietario", "label": "Proprietário"},
        {"id": "responsavel_tecnico", "label": "Responsável técnico"},
        {"id": "projetista_complementar", "label": "Projetista complementar"},
        {"id": "responsavel_execucao", "label": "Responsável pela execução"}
      ],
      "entry_kinds": [
        {"id": "andamento", "label": "Andamento"},
        {"id": "visita", "label": "Visita técnica"},
        {"id": "horas", "label": "Horas trabalhadas"},
        {"id": "alteracao", "label": "Solicitação de alteração"}
      ],
      "file_kinds": [
        {"id": "proposta", "label": "Proposta", "customer_can_receive": true},
        {"id": "contrato", "label": "Contrato", "customer_can_receive": true},
        {"id": "art", "label": "ART", "customer_can_receive": true},
        {"id": "prancha", "label": "Prancha", "customer_can_receive": true},
        {"id": "memorial", "label": "Memorial", "customer_can_receive": true},
        {"id": "documento_municipal", "label": "Protocolo ou licença municipal", "customer_can_receive": true},
        {"id": "relatorio_visita", "label": "Relatório de visita", "customer_can_receive": true},
        {"id": "memoria_calculo", "label": "Memória de cálculo", "customer_can_receive": false},
        {"id": "checklist", "label": "Checklist de revisão", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "entrada", "title": "Conferir escopo e documentos", "due_days": 1},
        {"stage": "orcamento", "title": "Acompanhar resposta à proposta", "due_days": 3},
        {"stage": "contratado", "title": "Confirmar contrato, responsável técnico e ART aplicável", "due_days": 1},
        {"stage": "recusado", "title": "Verificar revisão da proposta ou encerramento", "due_days": 2},
        {"stage": "levantamento", "title": "Agendar visita e registrar levantamento", "due_days": 3},
        {"stage": "estudo_preliminar", "title": "Revisar e liberar estudo preliminar", "due_days": 7},
        {"stage": "anteprojeto", "title": "Compatibilizar e liberar anteprojeto", "due_days": 7},
        {"stage": "projeto_legal", "title": "Conferir documentos e preparar protocolo", "due_days": 5},
        {"stage": "prefeitura", "title": "Consultar protocolo e registrar andamento", "due_days": 7},
        {"stage": "executivo", "title": "Revisar pranchas, memoriais e compatibilização", "due_days": 7},
        {"stage": "acompanhamento", "title": "Confirmar próxima visita e emitir relatório", "due_days": 7},
        {"stage": "entrega", "title": "Conferir pacote final e solicitar recebimento", "due_days": 2}
      ]
    },
    {
      "id": "engenharia_laudo",
      "singular": "Laudo ou vistoria",
      "plural": "Laudos e vistorias",
      "item_label": "Imóvel ou elemento a vistoriar",
      "problem_label": "Motivo e finalidade da solicitação",
      "number_prefix": "VIST",
      "features": {"quote": true, "warranty": false, "pickup": false, "terms": true, "tasks": true, "people": true, "files": true, "entries": true},
      "quote_valid_days": 7,
      "terms_text": "Solicito proposta para a vistoria e a finalidade informadas. A equipe confirmará o escopo, as condições de acesso e os limites do serviço. A abertura não constitui avaliação técnica do imóvel. O documento será emitido após análise do profissional responsável. Confirmar o recebimento não significa concordar com a conclusão nem impede pedir esclarecimentos.",
      "fields": [
        {"key": "modalidade", "label": "Modalidade", "type": "lista", "required": true, "customer_visible": true, "sensitive": false, "options": ["vistoria", "inspeção", "laudo", "outra"]},
        {"key": "municipio", "label": "Município e UF", "type": "texto", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "endereco", "label": "Endereço completo", "type": "texto_longo", "required": true, "customer_visible": false, "sensitive": true, "options": []},
        {"key": "finalidade", "label": "Uso pretendido do documento", "type": "texto_longo", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "art_numero", "label": "Número da ART", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "data_visita", "label": "Data prevista da visita", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "restricoes_acesso", "label": "Restrições e cuidados de acesso", "type": "texto_longo", "required": false, "customer_visible": false, "sensitive": true, "options": []}
      ],
      "stages": [
        {"id": "entrada", "label": "Solicitação recebida", "base": "received", "next": ["orcamento", "cancelado"], "message": "Recebemos a solicitação de vistoria {numero}. A equipe verificará a finalidade e o escopo.", "stale_days": 1},
        {"id": "orcamento", "label": "Proposta enviada", "base": "quoted", "next": ["contratado", "recusado", "entrada", "cancelado"], "message": "A proposta da vistoria {numero} está disponível. Confira o que será examinado e entregue.", "stale_days": 3},
        {"id": "contratado", "label": "Serviço contratado", "base": "approved", "next": ["vistoria", "cancelado"], "message": "A proposta da vistoria {numero} foi aprovada. Vamos confirmar a visita e as condições de acesso.", "stale_days": 2},
        {"id": "recusado", "label": "Proposta recusada", "base": "declined", "next": ["entrada", "cancelado"], "message": "A recusa da proposta da vistoria {numero} foi registrada.", "stale_days": 3},
        {"id": "vistoria", "label": "Vistoria em campo", "base": "analyzing", "next": ["elaboracao", "cancelado"], "message": "A vistoria {numero} está na etapa de campo. A equipe registrará o que foi examinado e as limitações encontradas.", "stale_days": 3},
        {"id": "elaboracao", "label": "Elaboração e revisão", "base": "in_progress", "next": ["vistoria", "entrega", "cancelado"], "message": "O documento da vistoria {numero} está em elaboração e revisão técnica.", "stale_days": 5},
        {"id": "entrega", "label": "Documento disponível", "base": "ready", "next": ["elaboracao", "concluido", "cancelado"], "message": "O documento da vistoria {numero} está disponível. Confira a versão e confirme o recebimento.", "stale_days": 3},
        {"id": "concluido", "label": "Concluído", "base": "delivered", "next": [], "message": "A vistoria {numero} foi concluída. A equipe permanece como contato para esclarecimentos sobre o documento entregue.", "stale_days": 0},
        {"id": "cancelado", "label": "Cancelado", "base": "cancelled", "next": [], "message": "A solicitação de vistoria {numero} foi cancelada.", "stale_days": 0}
      ],
      "approval_stages": [],
      "receipt_stages": ["entrega"],
      "people_roles": [
        {"id": "contratante", "label": "Contratante"},
        {"id": "acesso", "label": "Responsável pelo acesso"},
        {"id": "responsavel_tecnico", "label": "Responsável técnico"},
        {"id": "representante", "label": "Representante do imóvel"}
      ],
      "entry_kinds": [
        {"id": "visita", "label": "Visita"},
        {"id": "evidencia", "label": "Evidência"},
        {"id": "limitacao", "label": "Limitação de inspeção"},
        {"id": "andamento", "label": "Andamento"},
        {"id": "horas", "label": "Horas"}
      ],
      "file_kinds": [
        {"id": "proposta", "label": "Proposta", "customer_can_receive": true},
        {"id": "art", "label": "ART", "customer_can_receive": true},
        {"id": "laudo", "label": "Relatório ou laudo assinado", "customer_can_receive": true},
        {"id": "fotos_revisadas", "label": "Registro fotográfico revisado", "customer_can_receive": true},
        {"id": "fotos_brutas", "label": "Fotos brutas", "customer_can_receive": false},
        {"id": "notas_campo", "label": "Notas de campo", "customer_can_receive": false},
        {"id": "checklist", "label": "Checklist técnico", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "entrada", "title": "Conferir finalidade e prioridade", "due_days": 1},
        {"stage": "orcamento", "title": "Acompanhar resposta à proposta", "due_days": 3},
        {"stage": "contratado", "title": "Confirmar visita, acesso e ART aplicável", "due_days": 1},
        {"stage": "recusado", "title": "Verificar revisão ou encerramento", "due_days": 2},
        {"stage": "vistoria", "title": "Realizar vistoria e organizar evidências", "due_days": 2},
        {"stage": "elaboracao", "title": "Revisar conclusões, anexos e assinatura", "due_days": 5},
        {"stage": "entrega", "title": "Enviar versão assinada e pedir recebimento", "due_days": 1}
      ]
    }
  ],
  "module_settings": {
    "agenda": {
      "min_notice_minutes": 2880,
      "max_days_ahead": 30,
      "slot_step_minutes": 30,
      "reminder_hours": 24,
      "customer_change_hours": 24,
      "booked_text": "Agendado: {servico} com {profissional}, em {data} às {hora}. A equipe confirmará as condições de acesso quando houver visita.",
      "reminder_text": "Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma?",
      "services": [
        {"id": "engenharia_reuniao", "name": "Reunião inicial", "duration_minutes": 30},
        {"id": "engenharia_levantamento", "name": "Levantamento", "duration_minutes": 90},
        {"id": "engenharia_vistoria", "name": "Vistoria", "duration_minutes": 90},
        {"id": "engenharia_acompanhamento", "name": "Acompanhamento", "duration_minutes": 60}
      ]
    },
    "mensalidade": {"plans": []},
    "payments": {"automatic_on_open": false, "schedule_source": "proposta aprovada"},
    "forms": [
      {
        "id": "engenharia_inicial",
        "name": "Informações iniciais do projeto",
        "questions": [
          {"key": "imovel", "label": "Qual é o nome ou a identificação curta do imóvel?", "type": "texto", "required": true},
          {"key": "municipio", "label": "Em qual município e UF fica o imóvel?", "type": "texto", "required": true},
          {"key": "objetivo", "label": "O que você pretende construir, reformar ou regularizar?", "type": "texto_longo", "required": true},
          {"key": "disciplina", "label": "Qual disciplina você precisa?", "type": "lista", "required": true, "options": ["estrutural", "elétrica", "hidrossanitária", "civil", "não sei"]},
          {"key": "area_m2", "label": "Qual é a área aproximada em m², se souber?", "type": "numero", "required": false},
          {"key": "data_desejada", "label": "Existe uma data desejada?", "type": "data", "required": false}
        ]
      }
    ]
  },
  "menus": [
    {"id": "engenharia_abrir_projeto", "label": "Solicitar projeto", "type": "os_open", "parent_id": null, "content": "", "work_type_id": "engenharia_projeto"},
    {"id": "engenharia_abrir_laudo", "label": "Solicitar vistoria", "type": "os_open", "parent_id": null, "content": "", "work_type_id": "engenharia_laudo"},
    {"id": "engenharia_acompanhar", "label": "Acompanhar", "type": "submenu", "parent_id": null, "content": ""},
    {"id": "engenharia_ver_projetos", "label": "Projetos", "type": "os_track", "parent_id": "engenharia_acompanhar", "content": "", "work_type_id": "engenharia_projeto"},
    {"id": "engenharia_ver_vistorias", "label": "Vistorias", "type": "os_track", "parent_id": "engenharia_acompanhar", "content": "", "work_type_id": "engenharia_laudo"},
    {"id": "engenharia_agendar", "label": "Agendar atendimento", "type": "agenda", "parent_id": null, "content": ""},
    {"id": "engenharia_agendamentos", "label": "Meus agendamentos", "type": "agenda_mine", "parent_id": null, "content": ""},
    {"id": "engenharia_formulario", "label": "Informações do projeto", "type": "form", "parent_id": null, "content": "", "form_id": "engenharia_inicial"},
    {"id": "engenharia_pagamentos", "label": "Pagamentos", "type": "human", "parent_id": null, "content": "Vou encaminhar sua solicitação ao Financeiro.", "department": "Financeiro"},
    {"id": "engenharia_equipe", "label": "Falar com a equipe", "type": "human", "parent_id": null, "content": "Vou encaminhar sua mensagem ao Atendimento.", "department": "Atendimento"}
  ],
  "departments": ["Atendimento", "Engenharia", "Financeiro"],
  "ticket_categories": ["Novo projeto", "Vistoria", "Documentos", "Alteração de escopo", "Aprovação", "Prazo", "Pagamento", "Relato de risco"],
  "bot_instructions": "Você atende os contratantes deste escritório de engenharia. Consulte somente trabalhos vinculados ao telefone desta conversa e informações liberadas ao cliente. Ajude a abrir solicitações, consultar etapas, responder pendências e usar a Agenda. Mostre apenas prazos registrados pela equipe. Nunca calcule, diagnostique, libere execução, prometa aprovação pública ou declare uma estrutura segura. Não aprove propostas nem etapas pelo cliente. Peça confirmação explícita nas ações disponíveis. Encaminhe dúvidas técnicas, alterações de escopo, descontos e conflitos à equipe. Não leia campos sensíveis, documentos brutos, memórias de cálculo, fotos privadas ou notas internas. Em relato de risco, envie a orientação de segurança cadastrada e sinalize prioridade à equipe.",
  "manual_steps": [
    "Cadastrar responsáveis, atribuições profissionais e acessos.",
    "Ajustar disciplinas, escopo dos serviços e preços.",
    "Revisar termos, privacidade e retenção documental.",
    "Cadastrar horários e bloqueios de deslocamento.",
    "Configurar a conta de cobrança e os responsáveis financeiros.",
    "Conferir ART e regras aplicáveis a cada serviço.",
    "Definir quem libera versões e acompanha protocolos municipais.",
    "Configurar mensagens do canal e validar o fluxo antes da publicação."
  ]
}
```

# 2. Arquitetos

## 1. Quem usa e como é o dia a dia

Arquiteto autônomo ou escritório pequeno com assistente e parceiros de projetos complementares.  
O cliente costuma ser proprietário de residência, loja ou pequeno empreendimento.  
O trabalho começa com necessidades, referências, medidas e limite de investimento.  
Depois vêm alternativas, decisões de projeto, aprovação municipal e detalhamento.  
O WhatsApp recebe referências, pedidos de alteração e perguntas sobre materiais, visitas e entrega.  
O escritório precisa deixar claro qual versão foi aprovada e o que está incluído no contrato.

## 2. Tipos de trabalho

### Projeto / Projetos

| Elemento | Configuração |
|---|---|
| ID | `arquitetura_projeto` |
| Primeiro campo fixo | Imóvel ou ambiente |
| Segundo campo fixo | Necessidades e escopo solicitado |
| Numeração apresentada | `PROJ-{numero_tipo}` |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|---|
| `modalidade` | Modalidade | lista: edificação, reforma, interiores, regularização, outra | Sim | Sim | Não |
| `municipio` | Município e UF | texto | Sim | Sim | Não |
| `endereco` | Endereço completo | texto_longo | Sim | Não | Sim |
| `area_m2` | Área de referência em m² | numero | Não | Sim | Não |
| `investimento_referencia` | Investimento de referência | dinheiro | Não | Não | Sim |
| `rrt_numero` | Número do RRT | texto | Não | Sim | Não |
| `protocolo_prefeitura` | Protocolo municipal | texto | Não | Sim | Não |
| `prazo_contratado` | Data de entrega contratada | data | Não | Sim | Não |

O investimento de referência orienta o atendimento humano. Não vira orçamento de obra nem autorização de compra. Dinheiro será armazenado em centavos no contrato proposto.

O RRT é referência documental. Aplicabilidade, atividade e situação devem ser conferidas pelo profissional. Regras do CAU: **a conferir**.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso parado | Tarefa padrão |
|---|---|---|---|---|---:|---|
| `entrada` | Solicitação recebida | `received` | `orcamento`, `cancelado` | Recebemos o pedido de projeto {numero}. Vamos entender suas necessidades e conferir o escopo. | 2 | Conferir necessidades e modalidade — 1 dia |
| `orcamento` | Proposta enviada | `quoted` | `contratado`, `recusado`, `entrada`, `cancelado` | A proposta do projeto {numero} está disponível. Confira etapas, entregas, revisões incluídas e condições. | 3 | Acompanhar resposta à proposta — 3 dias |
| `contratado` | Proposta aprovada | `approved` | `levantamento`, `cancelado` | A proposta do projeto {numero} foi aprovada. Vamos combinar o levantamento e o calendário das apresentações. | 2 | Confirmar contrato, responsável e RRT aplicável — 1 dia |
| `recusado` | Proposta recusada | `declined` | `entrada`, `cancelado` | A recusa da proposta do projeto {numero} foi registrada. | 3 | Verificar revisão da proposta ou encerramento — 2 dias |
| `levantamento` | Levantamento e programa | `in_progress` | `estudo_preliminar`, `cancelado` | O projeto {numero} está em levantamento. Vamos conferir medidas, usos e necessidades dos ambientes. | 7 | Conferir medidas e apresentar programa de necessidades — 3 dias |
| `estudo_preliminar` | Estudo preliminar | `in_progress` | `anteprojeto`, `cancelado` | Iniciamos o estudo preliminar do projeto {numero}. As alternativas serão apresentadas para sua análise. | 7 | Revisar e apresentar estudo preliminar — 7 dias |
| `anteprojeto` | Anteprojeto | `in_progress` | `projeto_legal`, `executivo`, `cancelado` | O projeto {numero} está em anteprojeto, com desenvolvimento da solução aprovada. | 10 | Revisar soluções e compatibilizar disciplinas — 7 dias |
| `projeto_legal` | Projeto legal | `in_progress` | `prefeitura`, `cancelado` | Estamos preparando o projeto {numero} para o processo de aprovação aplicável. | 7 | Conferir peças e documentos para protocolo — 5 dias |
| `prefeitura` | Em análise na prefeitura | `in_progress` | `projeto_legal`, `executivo`, `cancelado` | O projeto {numero} está em análise na prefeitura. Avisaremos quando houver exigência ou decisão registrada. | 14 | Consultar protocolo e registrar andamento — 7 dias |
| `executivo` | Executivo e detalhamento | `in_progress` | `acompanhamento`, `entrega`, `cancelado` | O projeto {numero} está em detalhamento executivo. Use somente as versões liberadas para a finalidade indicada. | 10 | Revisar detalhes, pranchas e memorial — 7 dias |
| `acompanhamento` | Acompanhamento contratado | `in_progress` | `entrega`, `cancelado` | O projeto {numero} está em acompanhamento. As visitas seguirão o escopo contratado. | 14 | Confirmar visita e registrar decisões de campo — 7 dias |
| `entrega` | Entrega disponível | `ready` | `executivo`, `concluido`, `cancelado` | O pacote final do projeto {numero} está disponível. Confira os documentos e confirme o recebimento. | 3 | Conferir pacote final e solicitar recebimento — 2 dias |
| `concluido` | Concluído | `delivered` | — | O projeto {numero} foi concluído. Guarde as versões liberadas e os registros de aprovação. | 0 | — |
| `cancelado` | Cancelado | `cancelled` | — | O projeto {numero} foi cancelado. A equipe tratará as condições de encerramento. | 0 | — |

| Recurso | Uso |
|---|---|
| Orçamento | Ligado. Validade sugerida de 7 dias. Informar revisões incluídas, entregáveis, visitas e arquivos fornecidos. |
| Aprovação de etapa | Levantamento/programa, estudo preliminar, anteprojeto, projeto legal, executivo e acompanhamento. |
| Projeto sem prefeitura | Anteprojeto segue ao executivo somente com justificativa do responsável sobre a etapa não aplicável. |
| Garantia e retirada | Desligadas. |
| Termos | Texto abaixo. |
| Tarefas | Conforme a tabela. Acrescentar escolhas do cliente como tarefas: “Confirmar alternativa de layout”, “Confirmar acabamento apresentado” e “Enviar documento solicitado”. Cada uma recebe prazo combinado. |
| Pessoas ligadas | Contratante, coproprietário, arquiteto responsável, projetista complementar e responsável pela execução. |
| Documentos liberáveis | Proposta, contrato, RRT, prancha, memorial, apresentação de estudo, documento municipal e relatório de visita. |
| Documentos internos | Arquivo editável, orçamento de fornecedor e imagens privadas do imóvel. |
| Lançamentos | Andamento, decisão de projeto, visita, pedido de alteração e horas trabalhadas. |

Referência visual enviada pelo cliente não constitui aprovação. A aprovação vale para uma versão identificada do entregável.

**Termo de abertura**

> “Solicito a análise do projeto informado. A contratação depende de proposta com etapas, entregas, revisões incluídas, preço e prazo. As escolhas serão registradas por versão. Alterações após a aprovação serão avaliadas quanto ao escopo, custo e prazo. Imagens de referência não substituem os documentos liberados. A aprovação pelo WhatsApp não substitui revisão técnica, registro profissional ou licença exigível.”

### Laudo ou vistoria / Laudos e vistorias

| Elemento | Configuração |
|---|---|
| ID | `arquitetura_laudo` |
| Primeiro campo fixo | Imóvel ou ambiente a vistoriar |
| Segundo campo fixo | Motivo e finalidade da solicitação |
| Numeração apresentada | `VIST-{numero_tipo}` |
| Limite | Oferecer somente atividades compatíveis com a habilitação e atribuição do profissional. Verificação: **a conferir**. |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|---|
| `modalidade` | Modalidade | lista: vistoria de entrega, vistoria de reforma, avaliação de acessibilidade, laudo, outra | Sim | Sim | Não |
| `municipio` | Município e UF | texto | Sim | Sim | Não |
| `endereco` | Endereço completo | texto_longo | Sim | Não | Sim |
| `finalidade` | Uso pretendido do documento | texto_longo | Sim | Sim | Não |
| `rrt_numero` | Número do RRT | texto | Não | Sim | Não |
| `data_visita` | Data prevista da visita | data | Não | Sim | Não |
| `restricoes_acesso` | Restrições e cuidados de acesso | texto_longo | Não | Não | Sim |

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso parado | Tarefa padrão |
|---|---|---|---|---|---:|---|
| `entrada` | Solicitação recebida | `received` | `orcamento`, `cancelado` | Recebemos a solicitação de vistoria {numero}. Vamos conferir a finalidade e o serviço necessário. | 1 | Conferir finalidade, atribuição e prioridade — 1 dia |
| `orcamento` | Proposta enviada | `quoted` | `contratado`, `recusado`, `entrada`, `cancelado` | A proposta da vistoria {numero} está disponível. Confira o escopo e os documentos previstos. | 3 | Acompanhar resposta à proposta — 3 dias |
| `contratado` | Serviço contratado | `approved` | `vistoria`, `cancelado` | A proposta da vistoria {numero} foi aprovada. Vamos confirmar a visita e o acesso ao imóvel. | 2 | Confirmar visita, acesso e RRT aplicável — 1 dia |
| `recusado` | Proposta recusada | `declined` | `entrada`, `cancelado` | A recusa da proposta da vistoria {numero} foi registrada. | 3 | Verificar revisão ou encerramento — 2 dias |
| `vistoria` | Vistoria em campo | `analyzing` | `elaboracao`, `cancelado` | A vistoria {numero} está na etapa de campo. A equipe registrará as condições examinadas. | 3 | Realizar vistoria e organizar registros — 2 dias |
| `elaboracao` | Elaboração e revisão | `in_progress` | `vistoria`, `entrega`, `cancelado` | O documento da vistoria {numero} está em elaboração e revisão pelo responsável. | 5 | Revisar conclusões, anexos e assinatura — 5 dias |
| `entrega` | Documento disponível | `ready` | `elaboracao`, `concluido`, `cancelado` | O documento da vistoria {numero} está disponível. Confira a versão e confirme o recebimento. | 3 | Enviar versão assinada e pedir recebimento — 1 dia |
| `concluido` | Concluído | `delivered` | — | A vistoria {numero} foi concluída. Dúvidas sobre o documento serão encaminhadas ao responsável. | 0 | — |
| `cancelado` | Cancelado | `cancelled` | — | A solicitação de vistoria {numero} foi cancelada. | 0 | — |

| Recurso | Uso |
|---|---|
| Orçamento | Ligado. Validade de 7 dias. |
| Aprovação | Proposta comercial e confirmação de recebimento. A conclusão técnica permanece sob responsabilidade profissional. |
| Garantia e retirada | Desligadas. |
| Termos | Texto abaixo. |
| Tarefas | Conforme a tabela. |
| Pessoas ligadas | Contratante, responsável pelo acesso, arquiteto responsável e representante do imóvel. |
| Documentos liberáveis | Proposta, RRT, laudo ou relatório assinado e registro fotográfico revisado. |
| Documentos internos | Fotos brutas, notas de campo e checklist técnico. |
| Lançamentos | Visita, evidência, limitação de vistoria, andamento e horas. |

**Termo de abertura**

> “Solicito proposta para a vistoria informada. O profissional confirmará a finalidade, o escopo e as condições de acesso. O atendimento pelo WhatsApp não constitui laudo nem avaliação de segurança. O documento será emitido após análise técnica. A confirmação de recebimento registra a entrega e não impede pedidos de esclarecimento.”

## 3. Vocabulário

| Conceito | Nome na área |
|---|---|
| Cliente | Contratante |
| Trabalho | Projeto ou laudo/vistoria |
| Conjunto dos tipos | Trabalhos |
| Responsável | Arquiteto responsável |
| Orçamento | Proposta de serviços |
| Pendência do cliente | Escolha ou informação pendente |

## 4. Módulos

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| OS | Ligado | Projeto e Laudo ou vistoria. |
| Agenda | Ligado | Reunião inicial: 45 min; levantamento: 90 min; apresentação: 60 min; vistoria: 90 min; acompanhamento: 60 min. |
| Mensalidade | Desligado | Nenhum plano criado. |
| Formulários | Ligado | “Necessidades do projeto”, abaixo. |
| Cobrança | Ligado | Cobranças conforme proposta aprovada. Não cobrar automaticamente por etapa sem regra contratual confirmada. |
| Reserva | Desligado | Sem catálogo. |
| ERP | Desligado | Sem configuração comercial ou estoque. |

Agenda: antecedência mínima de 48 horas, janela de 30 dias, grade de 15 minutos, lembrete de 24 horas e remarcação até 24 horas antes. Horários e deslocamentos serão cadastrados manualmente.

**Formulário “Necessidades do projeto”**

| Pergunta pronta | Tipo | Obrigatória |
|---|---|---|
| Como você identifica o imóvel ou ambiente? | texto | Sim |
| Em qual município e UF fica o imóvel? | texto | Sim |
| O que você pretende fazer? | lista: construir, reformar, planejar interiores, regularizar, não sei | Sim |
| Quais ambientes precisam entrar no projeto? | texto_longo | Sim |
| O que precisa funcionar melhor nesses ambientes? | texto_longo | Sim |
| Existe uma data desejada? | data | Não |
| Você tem medidas ou plantas anteriores? | sim_nao | Não |

Não coletar nomes, condições de saúde ou rotina detalhada dos moradores nesse formulário. Necessidades específicas de acessibilidade serão tratadas com o profissional, com coleta mínima. A ligação automática da resposta ao trabalho é **a conferir**.

## 5. WhatsApp

| Caminho do menu | Ação |
|---|---|
| Solicitar projeto | `os_open`, referência `arquitetura_projeto` |
| Solicitar vistoria | `os_open`, referência `arquitetura_laudo` |
| Acompanhar → Projetos | `os_track`, referência `arquitetura_projeto` |
| Acompanhar → Vistorias | `os_track`, referência `arquitetura_laudo` |
| Agendar atendimento | Agenda |
| Meus agendamentos | Consulta e alterações permitidas |
| Necessidades do projeto | Formulário inicial |
| Pagamentos | Financeiro humano |
| Falar com a equipe | Atendimento humano |

O cliente resolve a abertura, o acompanhamento, a agenda, as escolhas pendentes e o aceite explícito de versões. Pedidos de mudança após aprovação seguem para avaliação humana.

| Disparo | Texto pronto | Regra |
|---|---|---|
| Agendamento | “Agendado: {servico} com {profissional}, em {data} às {hora}. Se houver visita, a equipe confirmará o acesso.” | Após confirmação |
| Lembrete | “Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma?” | 24 horas antes |
| Versão pendente | “O projeto {numero} aguarda sua análise da etapa {etapa}, versão {versao}. Confira os arquivos antes de aprovar ou pedir ajustes.” | Uma vez após 3 dias |
| Escolha pendente | “No projeto {numero}, falta concluir: {tarefa}. Prazo combinado: {vencimento}. Se precisar de orientação, fale com a equipe.” | Um dia antes do prazo |
| Alteração recebida | “Recebemos seu pedido de alteração no projeto {numero}. A equipe avaliará o impacto no escopo, no valor e no prazo antes de confirmar.” | Após registrar o pedido |
| Risco relatado | “Não é possível avaliar a segurança do imóvel por esta conversa. Afaste-se da situação de risco e procure o atendimento de emergência competente. Vou sinalizar o relato à equipe.” | Encaminhamento prioritário |

## 6. Bot da área

**Texto para o campo de instruções**

> “Você atende os contratantes deste escritório de arquitetura. Consulte somente trabalhos do telefone desta conversa e informações liberadas. Ajude a abrir solicitações, consultar etapas, usar a Agenda e localizar escolhas pendentes. Diferencie referência, estudo e documento liberado para execução. Não invente prazo, preço, material, medida ou solução técnica. Não aprove etapas pelo cliente nem trate uma imagem enviada como aceite. Encaminhe alterações, dúvidas técnicas, negociação e aprovação municipal à equipe. Não leia campos sensíveis, arquivos editáveis, fotos privadas, investimento de referência ou notas internas. Não prometa aprovação pública nem declare um imóvel seguro. Em relato de risco, envie a orientação cadastrada e sinalize prioridade à equipe.”

| Nível | Ações |
|---|---|
| Sozinho | Explicar o fluxo cadastrado; consultar etapa; indicar escolhas pendentes; mostrar horários. |
| Com confirmação | Propor abertura, agendamento e resposta a pendência autorizada. |
| Consulta a equipe antes | Troca de material, mudança de layout aprovado, revisão extra, antecipação, desconto e entrega de editáveis. |
| Nunca | Dimensionar, definir solução técnica, validar RRT, aprovar projeto em nome do cliente ou garantir licença. |
| Não pode ler | Endereço sensível, investimento de referência, rotina de moradores, fotos privadas, arquivos brutos e notas internas. |

## 7. Equipe

| Papel | Vê | Faz |
|---|---|---|
| Atendimento | Etapa, agenda e pendências liberadas | Organiza informações e encaminha solicitações |
| Arquiteto responsável | Dados técnicos e sensíveis necessários | Revisa e libera versões; decide escopo e encaminhamentos |
| Assistente de projeto | Trabalhos atribuídos e arquivos de produção | Produz versões e registra tarefas; não libera sozinho |
| Financeiro | Proposta, cobrança e dados mínimos do contratante | Trata pagamentos e negociação autorizada |
| Gestor | Operação e permissões concedidas | Distribui trabalhos e configura o modelo |

| Organização | Valores |
|---|---|
| Setores | Atendimento; Arquitetura; Financeiro |
| Categorias de protocolo | Novo projeto; Vistoria; Referências; Escolhas; Alteração de projeto; Documentos; Aprovação; Pagamento; Relato de risco |

Os papéis detalhados são proposta. O papel atual de OS e seus limites declarados estão em `src/modules/os/definition.ts:61`.

## 8. Passos manuais

| Ordem | Ação |
|---:|---|
| 1 | Cadastrar profissionais e revisar atribuições e acessos. |
| 2 | Definir modalidades atendidas, entregáveis e revisões incluídas. |
| 3 | Ajustar termos, privacidade, retenção e entrega de arquivos editáveis. |
| 4 | Cadastrar agenda, profissionais e bloqueios de deslocamento. |
| 5 | Configurar cobrança e parcelas contratuais. |
| 6 | Definir conferência de RRT e de exigências municipais. |
| 7 | Definir quais versões podem ser enviadas e quem as libera. |
| 8 | Configurar mensagens do canal e validar o fluxo antes de publicar. |

## 10. Dúvidas e decisões

| Decisão | Proposta |
|---|---|
| Revisões incluídas | Definir por contrato. O modelo não fixa quantidade comercial. |
| Editáveis | Entrega desligada por padrão. |
| Acompanhamento | Serviço opcional. Definir frequência, finalidade e responsabilidade. |
| Dados de moradores | Coletar somente o necessário, em atendimento humano quando houver informação sensível. |
| RRT e exigências públicas | Responsável confere por atividade e município. **A conferir**. |
| Guarda | Definir por finalidade e documento. LGPD e regras profissionais aplicáveis: **a conferir**. |
| Projetos multidisciplinares | Uma ART ou um RRT no campo principal não representa todos os registros. Documentos e pessoas ligadas devem aceitar vários responsáveis e registros. |

**Modelo neutro**

```json
{
  "id": "arquitetura",
  "name": "Arquitetos",
  "labels": {
    "customer": "Contratante",
    "customers": "Contratantes",
    "work_collection": "Trabalhos",
    "responsible": "Arquiteto responsável",
    "quote": "Proposta de serviços"
  },
  "modules": {
    "on": ["os", "agenda", "forms", "payments"],
    "off": ["mensalidade", "reserva", "erp"]
  },
  "policies": {
    "apply_mode": "merge",
    "sensitive_to_ai": false,
    "raw_files_to_ai": false,
    "file_versions_immutable": true,
    "file_release_requires_human": true,
    "approval_scope": "work_stage_version_files",
    "approval_reminder_days": 3,
    "task_days": "calendar",
    "customer_task_reminder_days_before": 1
  },
  "work_types": [
    {
      "id": "arquitetura_projeto",
      "singular": "Projeto",
      "plural": "Projetos",
      "item_label": "Imóvel ou ambiente",
      "problem_label": "Necessidades e escopo solicitado",
      "number_prefix": "PROJ",
      "features": {"quote": true, "warranty": false, "pickup": false, "terms": true, "tasks": true, "people": true, "files": true, "entries": true},
      "quote_valid_days": 7,
      "terms_text": "Solicito a análise do projeto informado. A contratação depende de proposta com etapas, entregas, revisões incluídas, preço e prazo. As escolhas serão registradas por versão. Alterações após a aprovação serão avaliadas quanto ao escopo, custo e prazo. Imagens de referência não substituem os documentos liberados. A aprovação pelo WhatsApp não substitui revisão técnica, registro profissional ou licença exigível.",
      "fields": [
        {"key": "modalidade", "label": "Modalidade", "type": "lista", "required": true, "customer_visible": true, "sensitive": false, "options": ["edificação", "reforma", "interiores", "regularização", "outra"]},
        {"key": "municipio", "label": "Município e UF", "type": "texto", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "endereco", "label": "Endereço completo", "type": "texto_longo", "required": true, "customer_visible": false, "sensitive": true, "options": []},
        {"key": "area_m2", "label": "Área de referência em m²", "type": "numero", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "investimento_referencia", "label": "Investimento de referência", "type": "dinheiro", "required": false, "customer_visible": false, "sensitive": true, "options": []},
        {"key": "rrt_numero", "label": "Número do RRT", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "protocolo_prefeitura", "label": "Protocolo municipal", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "prazo_contratado", "label": "Data de entrega contratada", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []}
      ],
      "stages": [
        {"id": "entrada", "label": "Solicitação recebida", "base": "received", "next": ["orcamento", "cancelado"], "message": "Recebemos o pedido de projeto {numero}. Vamos entender suas necessidades e conferir o escopo.", "stale_days": 2},
        {"id": "orcamento", "label": "Proposta enviada", "base": "quoted", "next": ["contratado", "recusado", "entrada", "cancelado"], "message": "A proposta do projeto {numero} está disponível. Confira etapas, entregas, revisões incluídas e condições.", "stale_days": 3},
        {"id": "contratado", "label": "Proposta aprovada", "base": "approved", "next": ["levantamento", "cancelado"], "message": "A proposta do projeto {numero} foi aprovada. Vamos combinar o levantamento e o calendário das apresentações.", "stale_days": 2},
        {"id": "recusado", "label": "Proposta recusada", "base": "declined", "next": ["entrada", "cancelado"], "message": "A recusa da proposta do projeto {numero} foi registrada.", "stale_days": 3},
        {"id": "levantamento", "label": "Levantamento e programa", "base": "in_progress", "next": ["estudo_preliminar", "cancelado"], "message": "O projeto {numero} está em levantamento. Vamos conferir medidas, usos e necessidades dos ambientes.", "stale_days": 7},
        {"id": "estudo_preliminar", "label": "Estudo preliminar", "base": "in_progress", "next": ["anteprojeto", "cancelado"], "message": "Iniciamos o estudo preliminar do projeto {numero}. As alternativas serão apresentadas para sua análise.", "stale_days": 7},
        {"id": "anteprojeto", "label": "Anteprojeto", "base": "in_progress", "next": ["projeto_legal", "executivo", "cancelado"], "message": "O projeto {numero} está em anteprojeto, com desenvolvimento da solução aprovada.", "stale_days": 10},
        {"id": "projeto_legal", "label": "Projeto legal", "base": "in_progress", "next": ["prefeitura", "cancelado"], "message": "Estamos preparando o projeto {numero} para o processo de aprovação aplicável.", "stale_days": 7},
        {"id": "prefeitura", "label": "Em análise na prefeitura", "base": "in_progress", "next": ["projeto_legal", "executivo", "cancelado"], "message": "O projeto {numero} está em análise na prefeitura. Avisaremos quando houver exigência ou decisão registrada.", "stale_days": 14},
        {"id": "executivo", "label": "Executivo e detalhamento", "base": "in_progress", "next": ["acompanhamento", "entrega", "cancelado"], "message": "O projeto {numero} está em detalhamento executivo. Use somente as versões liberadas para a finalidade indicada.", "stale_days": 10},
        {"id": "acompanhamento", "label": "Acompanhamento contratado", "base": "in_progress", "next": ["entrega", "cancelado"], "message": "O projeto {numero} está em acompanhamento. As visitas seguirão o escopo contratado.", "stale_days": 14},
        {"id": "entrega", "label": "Entrega disponível", "base": "ready", "next": ["executivo", "concluido", "cancelado"], "message": "O pacote final do projeto {numero} está disponível. Confira os documentos e confirme o recebimento.", "stale_days": 3},
        {"id": "concluido", "label": "Concluído", "base": "delivered", "next": [], "message": "O projeto {numero} foi concluído. Guarde as versões liberadas e os registros de aprovação.", "stale_days": 0},
        {"id": "cancelado", "label": "Cancelado", "base": "cancelled", "next": [], "message": "O projeto {numero} foi cancelado. A equipe tratará as condições de encerramento.", "stale_days": 0}
      ],
      "approval_stages": ["levantamento", "estudo_preliminar", "anteprojeto", "projeto_legal", "executivo", "acompanhamento"],
      "receipt_stages": ["entrega"],
      "transition_guards": [
        {"from": "anteprojeto", "to": "executivo", "rule": "Responsável registra que a etapa municipal não se aplica."},
        {"from": "prefeitura", "to": "executivo", "rule": "Equipe confere e registra a aprovação administrativa aplicável."},
        {"from": "executivo", "to": "entrega", "rule": "Não há acompanhamento contratado."}
      ],
      "people_roles": [
        {"id": "contratante", "label": "Contratante"},
        {"id": "coproprietario", "label": "Coproprietário"},
        {"id": "responsavel_tecnico", "label": "Arquiteto responsável"},
        {"id": "projetista_complementar", "label": "Projetista complementar"},
        {"id": "responsavel_execucao", "label": "Responsável pela execução"}
      ],
      "entry_kinds": [
        {"id": "andamento", "label": "Andamento"},
        {"id": "decisao", "label": "Decisão de projeto"},
        {"id": "visita", "label": "Visita"},
        {"id": "alteracao", "label": "Pedido de alteração"},
        {"id": "horas", "label": "Horas trabalhadas"}
      ],
      "file_kinds": [
        {"id": "proposta", "label": "Proposta", "customer_can_receive": true},
        {"id": "contrato", "label": "Contrato", "customer_can_receive": true},
        {"id": "rrt", "label": "RRT", "customer_can_receive": true},
        {"id": "prancha", "label": "Prancha", "customer_can_receive": true},
        {"id": "memorial", "label": "Memorial", "customer_can_receive": true},
        {"id": "apresentacao", "label": "Apresentação de estudo", "customer_can_receive": true},
        {"id": "documento_municipal", "label": "Documento municipal", "customer_can_receive": true},
        {"id": "relatorio_visita", "label": "Relatório de visita", "customer_can_receive": true},
        {"id": "editavel", "label": "Arquivo editável", "customer_can_receive": false},
        {"id": "orcamento_fornecedor", "label": "Orçamento de fornecedor", "customer_can_receive": false},
        {"id": "foto_privada", "label": "Imagem privada do imóvel", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "entrada", "title": "Conferir necessidades e modalidade", "due_days": 1},
        {"stage": "orcamento", "title": "Acompanhar resposta à proposta", "due_days": 3},
        {"stage": "contratado", "title": "Confirmar contrato, responsável e RRT aplicável", "due_days": 1},
        {"stage": "recusado", "title": "Verificar revisão da proposta ou encerramento", "due_days": 2},
        {"stage": "levantamento", "title": "Conferir medidas e apresentar programa de necessidades", "due_days": 3},
        {"stage": "estudo_preliminar", "title": "Revisar e apresentar estudo preliminar", "due_days": 7},
        {"stage": "anteprojeto", "title": "Revisar soluções e compatibilizar disciplinas", "due_days": 7},
        {"stage": "projeto_legal", "title": "Conferir peças e documentos para protocolo", "due_days": 5},
        {"stage": "prefeitura", "title": "Consultar protocolo e registrar andamento", "due_days": 7},
        {"stage": "executivo", "title": "Revisar detalhes, pranchas e memorial", "due_days": 7},
        {"stage": "acompanhamento", "title": "Confirmar visita e registrar decisões de campo", "due_days": 7},
        {"stage": "entrega", "title": "Conferir pacote final e solicitar recebimento", "due_days": 2}
      ]
    },
    {
      "id": "arquitetura_laudo",
      "singular": "Laudo ou vistoria",
      "plural": "Laudos e vistorias",
      "item_label": "Imóvel ou ambiente a vistoriar",
      "problem_label": "Motivo e finalidade da solicitação",
      "number_prefix": "VIST",
      "features": {"quote": true, "warranty": false, "pickup": false, "terms": true, "tasks": true, "people": true, "files": true, "entries": true},
      "quote_valid_days": 7,
      "terms_text": "Solicito proposta para a vistoria informada. O profissional confirmará a finalidade, o escopo e as condições de acesso. O atendimento pelo WhatsApp não constitui laudo nem avaliação de segurança. O documento será emitido após análise técnica. A confirmação de recebimento registra a entrega e não impede pedidos de esclarecimento.",
      "fields": [
        {"key": "modalidade", "label": "Modalidade", "type": "lista", "required": true, "customer_visible": true, "sensitive": false, "options": ["vistoria de entrega", "vistoria de reforma", "avaliação de acessibilidade", "laudo", "outra"]},
        {"key": "municipio", "label": "Município e UF", "type": "texto", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "endereco", "label": "Endereço completo", "type": "texto_longo", "required": true, "customer_visible": false, "sensitive": true, "options": []},
        {"key": "finalidade", "label": "Uso pretendido do documento", "type": "texto_longo", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "rrt_numero", "label": "Número do RRT", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "data_visita", "label": "Data prevista da visita", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "restricoes_acesso", "label": "Restrições e cuidados de acesso", "type": "texto_longo", "required": false, "customer_visible": false, "sensitive": true, "options": []}
      ],
      "stages": [
        {"id": "entrada", "label": "Solicitação recebida", "base": "received", "next": ["orcamento", "cancelado"], "message": "Recebemos a solicitação de vistoria {numero}. Vamos conferir a finalidade e o serviço necessário.", "stale_days": 1},
        {"id": "orcamento", "label": "Proposta enviada", "base": "quoted", "next": ["contratado", "recusado", "entrada", "cancelado"], "message": "A proposta da vistoria {numero} está disponível. Confira o escopo e os documentos previstos.", "stale_days": 3},
        {"id": "contratado", "label": "Serviço contratado", "base": "approved", "next": ["vistoria", "cancelado"], "message": "A proposta da vistoria {numero} foi aprovada. Vamos confirmar a visita e o acesso ao imóvel.", "stale_days": 2},
        {"id": "recusado", "label": "Proposta recusada", "base": "declined", "next": ["entrada", "cancelado"], "message": "A recusa da proposta da vistoria {numero} foi registrada.", "stale_days": 3},
        {"id": "vistoria", "label": "Vistoria em campo", "base": "analyzing", "next": ["elaboracao", "cancelado"], "message": "A vistoria {numero} está na etapa de campo. A equipe registrará as condições examinadas.", "stale_days": 3},
        {"id": "elaboracao", "label": "Elaboração e revisão", "base": "in_progress", "next": ["vistoria", "entrega", "cancelado"], "message": "O documento da vistoria {numero} está em elaboração e revisão pelo responsável.", "stale_days": 5},
        {"id": "entrega", "label": "Documento disponível", "base": "ready", "next": ["elaboracao", "concluido", "cancelado"], "message": "O documento da vistoria {numero} está disponível. Confira a versão e confirme o recebimento.", "stale_days": 3},
        {"id": "concluido", "label": "Concluído", "base": "delivered", "next": [], "message": "A vistoria {numero} foi concluída. Dúvidas sobre o documento serão encaminhadas ao responsável.", "stale_days": 0},
        {"id": "cancelado", "label": "Cancelado", "base": "cancelled", "next": [], "message": "A solicitação de vistoria {numero} foi cancelada.", "stale_days": 0}
      ],
      "approval_stages": [],
      "receipt_stages": ["entrega"],
      "people_roles": [
        {"id": "contratante", "label": "Contratante"},
        {"id": "acesso", "label": "Responsável pelo acesso"},
        {"id": "responsavel_tecnico", "label": "Arquiteto responsável"},
        {"id": "representante", "label": "Representante do imóvel"}
      ],
      "entry_kinds": [
        {"id": "visita", "label": "Visita"},
        {"id": "evidencia", "label": "Evidência"},
        {"id": "limitacao", "label": "Limitação de vistoria"},
        {"id": "andamento", "label": "Andamento"},
        {"id": "horas", "label": "Horas"}
      ],
      "file_kinds": [
        {"id": "proposta", "label": "Proposta", "customer_can_receive": true},
        {"id": "rrt", "label": "RRT", "customer_can_receive": true},
        {"id": "laudo", "label": "Laudo ou relatório assinado", "customer_can_receive": true},
        {"id": "fotos_revisadas", "label": "Registro fotográfico revisado", "customer_can_receive": true},
        {"id": "fotos_brutas", "label": "Fotos brutas", "customer_can_receive": false},
        {"id": "notas_campo", "label": "Notas de campo", "customer_can_receive": false},
        {"id": "checklist", "label": "Checklist técnico", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "entrada", "title": "Conferir finalidade, atribuição e prioridade", "due_days": 1},
        {"stage": "orcamento", "title": "Acompanhar resposta à proposta", "due_days": 3},
        {"stage": "contratado", "title": "Confirmar visita, acesso e RRT aplicável", "due_days": 1},
        {"stage": "recusado", "title": "Verificar revisão ou encerramento", "due_days": 2},
        {"stage": "vistoria", "title": "Realizar vistoria e organizar registros", "due_days": 2},
        {"stage": "elaboracao", "title": "Revisar conclusões, anexos e assinatura", "due_days": 5},
        {"stage": "entrega", "title": "Enviar versão assinada e pedir recebimento", "due_days": 1}
      ]
    }
  ],
  "module_settings": {
    "agenda": {
      "min_notice_minutes": 2880,
      "max_days_ahead": 30,
      "slot_step_minutes": 15,
      "reminder_hours": 24,
      "customer_change_hours": 24,
      "booked_text": "Agendado: {servico} com {profissional}, em {data} às {hora}. Se houver visita, a equipe confirmará o acesso.",
      "reminder_text": "Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma?",
      "services": [
        {"id": "arquitetura_reuniao", "name": "Reunião inicial", "duration_minutes": 45},
        {"id": "arquitetura_levantamento", "name": "Levantamento", "duration_minutes": 90},
        {"id": "arquitetura_apresentacao", "name": "Apresentação de projeto", "duration_minutes": 60},
        {"id": "arquitetura_vistoria", "name": "Vistoria", "duration_minutes": 90},
        {"id": "arquitetura_acompanhamento", "name": "Acompanhamento", "duration_minutes": 60}
      ]
    },
    "mensalidade": {"plans": []},
    "payments": {"automatic_on_open": false, "schedule_source": "proposta aprovada"},
    "forms": [
      {
        "id": "arquitetura_necessidades",
        "name": "Necessidades do projeto",
        "questions": [
          {"key": "imovel", "label": "Como você identifica o imóvel ou ambiente?", "type": "texto", "required": true},
          {"key": "municipio", "label": "Em qual município e UF fica o imóvel?", "type": "texto", "required": true},
          {"key": "objetivo", "label": "O que você pretende fazer?", "type": "lista", "required": true, "options": ["construir", "reformar", "planejar interiores", "regularizar", "não sei"]},
          {"key": "ambientes", "label": "Quais ambientes precisam entrar no projeto?", "type": "texto_longo", "required": true},
          {"key": "necessidades", "label": "O que precisa funcionar melhor nesses ambientes?", "type": "texto_longo", "required": true},
          {"key": "data_desejada", "label": "Existe uma data desejada?", "type": "data", "required": false},
          {"key": "plantas", "label": "Você tem medidas ou plantas anteriores?", "type": "sim_nao", "required": false}
        ]
      }
    ]
  },
  "menus": [
    {"id": "arquitetura_abrir_projeto", "label": "Solicitar projeto", "type": "os_open", "parent_id": null, "content": "", "work_type_id": "arquitetura_projeto"},
    {"id": "arquitetura_abrir_laudo", "label": "Solicitar vistoria", "type": "os_open", "parent_id": null, "content": "", "work_type_id": "arquitetura_laudo"},
    {"id": "arquitetura_acompanhar", "label": "Acompanhar", "type": "submenu", "parent_id": null, "content": ""},
    {"id": "arquitetura_ver_projetos", "label": "Projetos", "type": "os_track", "parent_id": "arquitetura_acompanhar", "content": "", "work_type_id": "arquitetura_projeto"},
    {"id": "arquitetura_ver_vistorias", "label": "Vistorias", "type": "os_track", "parent_id": "arquitetura_acompanhar", "content": "", "work_type_id": "arquitetura_laudo"},
    {"id": "arquitetura_agendar", "label": "Agendar atendimento", "type": "agenda", "parent_id": null, "content": ""},
    {"id": "arquitetura_agendamentos", "label": "Meus agendamentos", "type": "agenda_mine", "parent_id": null, "content": ""},
    {"id": "arquitetura_formulario", "label": "Necessidades do projeto", "type": "form", "parent_id": null, "content": "", "form_id": "arquitetura_necessidades"},
    {"id": "arquitetura_pagamentos", "label": "Pagamentos", "type": "human", "parent_id": null, "content": "Vou encaminhar sua solicitação ao Financeiro.", "department": "Financeiro"},
    {"id": "arquitetura_equipe", "label": "Falar com a equipe", "type": "human", "parent_id": null, "content": "Vou encaminhar sua mensagem ao Atendimento.", "department": "Atendimento"}
  ],
  "departments": ["Atendimento", "Arquitetura", "Financeiro"],
  "ticket_categories": ["Novo projeto", "Vistoria", "Referências", "Escolhas", "Alteração de projeto", "Documentos", "Aprovação", "Pagamento", "Relato de risco"],
  "bot_instructions": "Você atende os contratantes deste escritório de arquitetura. Consulte somente trabalhos do telefone desta conversa e informações liberadas. Ajude a abrir solicitações, consultar etapas, usar a Agenda e localizar escolhas pendentes. Diferencie referência, estudo e documento liberado para execução. Não invente prazo, preço, material, medida ou solução técnica. Não aprove etapas pelo cliente nem trate uma imagem enviada como aceite. Encaminhe alterações, dúvidas técnicas, negociação e aprovação municipal à equipe. Não leia campos sensíveis, arquivos editáveis, fotos privadas, investimento de referência ou notas internas. Não prometa aprovação pública nem declare um imóvel seguro. Em relato de risco, envie a orientação cadastrada e sinalize prioridade à equipe.",
  "manual_steps": [
    "Cadastrar profissionais e revisar atribuições e acessos.",
    "Definir modalidades, entregáveis e revisões incluídas.",
    "Revisar termos, privacidade, retenção e entrega de editáveis.",
    "Cadastrar agenda e bloqueios de deslocamento.",
    "Configurar cobrança e parcelas contratuais.",
    "Definir conferência de RRT e exigências municipais.",
    "Definir quem libera versões e quais arquivos podem ser enviados.",
    "Configurar mensagens do canal e validar o fluxo antes da publicação."
  ]
}
```

# 3. Construtoras

## 1. Quem usa e como é o dia a dia

Pequena construtora com gestor, responsável técnico, encarregado e apoio administrativo.  
O cliente é o contratante da obra ou o comprador que solicita assistência após a entrega.  
O dia a dia combina execução, equipes, materiais, visitas, medições e decisões de campo.  
O WhatsApp recebe perguntas sobre andamento, atrasos, alterações e pagamentos.  
No pós-obra, recebe relatos de problemas e pedidos de visita.  
A equipe precisa distinguir execução física, aceite do cliente, medição e cobrança.  
O vínculo entre uma compra do ERP e a obra será opcional.

## 2. Tipos de trabalho

### Obra / Obras

| Elemento | Configuração |
|---|---|
| ID | `construtora_obra` |
| Primeiro campo fixo | Obra ou empreendimento |
| Segundo campo fixo | Escopo contratado ou solicitado |
| Numeração apresentada | `OBRA-{numero_tipo}` |
| Limite do modelo | Controle operacional simplificado. Não substitui planejamento técnico especializado. |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|---|
| `modalidade` | Modalidade | lista: construção, reforma, ampliação, manutenção, outra | Sim | Sim | Não |
| `municipio` | Município e UF | texto | Sim | Sim | Não |
| `endereco` | Endereço completo da obra | texto_longo | Sim | Não | Sim |
| `area_m2` | Área contratada em m² | numero | Não | Sim | Não |
| `art_numero` | ART principal | texto | Não | Sim | Não |
| `rrt_numero` | RRT principal | texto | Não | Sim | Não |
| `protocolo_prefeitura` | Protocolo municipal | texto | Não | Sim | Não |
| `inicio_previsto` | Início previsto | data | Não | Sim | Não |
| `entrega_prevista` | Entrega prevista | data | Não | Sim | Não |
| `valor_contratado` | Valor contratado | dinheiro | Não | Sim | Não |

Os campos ART e RRT não indicam que ambos são sempre exigidos. O profissional define os registros aplicáveis. Todos os documentos pertinentes ficam vinculados, mesmo quando houver mais de um registro.

**Etapas**

A etapa principal resume a obra. Frentes paralelas ficam em tarefas e lançamentos. Não forçar toda atividade real a uma fila única.

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso parado | Tarefa padrão |
|---|---|---|---|---|---:|---|
| `entrada` | Solicitação recebida | `received` | `orcamento`, `cancelado` | Recebemos a solicitação da obra {numero}. Vamos conferir o escopo e as informações necessárias. | 2 | Conferir escopo e documentos iniciais — 1 dia |
| `orcamento` | Proposta enviada | `quoted` | `contratada`, `recusada`, `entrada`, `cancelado` | A proposta da obra {numero} está disponível. Confira escopo, etapas, medições e condições de pagamento. | 3 | Acompanhar resposta à proposta — 3 dias |
| `contratada` | Obra contratada | `approved` | `licencas`, `mobilizacao`, `cancelado` | A proposta da obra {numero} foi aprovada. A equipe confirmará documentos, condições de início e cronograma. | 3 | Conferir contrato, projetos e registros profissionais — 2 dias |
| `recusada` | Proposta recusada | `declined` | `entrada`, `cancelado` | A recusa da proposta da obra {numero} foi registrada. | 3 | Verificar revisão ou encerramento — 2 dias |
| `licencas` | Aprovações e licenças | `analyzing` | `mobilizacao`, `cancelado` | A obra {numero} está na conferência das aprovações e licenças aplicáveis. O início depende da liberação responsável. | 14 | Conferir protocolo municipal e pendências — 7 dias |
| `mobilizacao` | Mobilização | `in_progress` | `fundacoes`, `estrutura`, `instalacoes`, `acabamentos`, `cancelado` | Iniciamos a mobilização da obra {numero}, conforme as condições liberadas pela equipe. | 7 | Confirmar equipe, acesso e cronograma de frentes — 2 dias |
| `fundacoes` | Fundações | `in_progress` | `estrutura`, `cancelado` | A obra {numero} entrou na etapa de fundações. O andamento será informado após conferência da equipe. | 7 | Conferir execução, registros e medição da etapa — 7 dias |
| `estrutura` | Estrutura e vedações | `in_progress` | `instalacoes`, `cancelado` | A obra {numero} entrou na etapa de estrutura e vedações. | 7 | Conferir frentes, registros e medição da etapa — 7 dias |
| `instalacoes` | Instalações | `in_progress` | `acabamentos`, `cancelado` | A obra {numero} entrou na etapa de instalações. Os serviços seguirão os projetos liberados. | 7 | Conferir instalações, testes previstos e medição — 7 dias |
| `acabamentos` | Acabamentos | `in_progress` | `vistoria_entrega`, `cancelado` | A obra {numero} entrou na etapa de acabamentos. As escolhas pendentes serão enviadas separadamente. | 7 | Conferir acabamentos e preparar lista de pendências — 7 dias |
| `vistoria_entrega` | Vistoria de entrega | `ready` | `acabamentos`, `entregue`, `cancelado` | A obra {numero} está disponível para vistoria de entrega. Vamos registrar as verificações e eventuais pendências. | 3 | Agendar vistoria e conferir pacote de entrega — 2 dias |
| `entregue` | Entregue | `delivered` | — | A entrega da obra {numero} foi registrada. Guarde os documentos recebidos. Solicitações posteriores podem ser abertas em Pós-obra. | 0 | — |
| `cancelado` | Cancelada | `cancelled` | — | A obra {numero} foi cancelada no acompanhamento. A equipe tratará o encerramento contratual e as pendências. | 0 | — |

| Recurso | Uso |
|---|---|
| Orçamento | Ligado. Validade inicial de 7 dias. Proposta contratual discrimina etapas, inclusões, exclusões, medições e condições de pagamento. |
| Aprovação de etapa | Mobilização, fundações, estrutura, instalações e acabamentos. O cliente confirma o relatório e a medição apresentada. A liberação técnica continua humana. |
| Licenças | Só sair para mobilização após conferência técnica. Pular `licencas` exige justificativa de que as autorizações aplicáveis já foram conferidas ou não se aplicam. |
| Reformas parciais | Mobilização pode seguir diretamente à frente contratada. O responsável registra as etapas não aplicáveis. |
| Garantia automática | Desligada na Obra. Coberturas e documentos são tratados por sistema ou serviço. Não iniciar um único prazo universal na entrega. |
| Retirada | Desligada. |
| Termos | Texto abaixo. |
| Tarefas | Cronograma por frente, responsável e data. Criar tarefa “Registrar diário do dia” em cada dia de atividade programado. Essa recorrência é requisito proposto do motor. |
| Pessoas ligadas | Contratante, responsável técnico, encarregado, líder de equipe, prestador e fiscal do contratante. |
| Documentos liberáveis | Proposta, contrato, ART, RRT, licença, prancha liberada, memorial, relatório de medição, relatório de vistoria e manual de entrega. |
| Documentos internos | Diário bruto, cotação, documentação de pessoal e arquivo de segurança ou acesso. |
| Lançamentos | Diário de obra, medição, andamento, ocorrência, horas e decisão de alteração. |
| Cliente | Recebe relatório revisado. Não recebe automaticamente todo o diário interno. |

**Termo de abertura**

> “Solicito a análise da obra informada. A execução depende de contrato, condições de início e liberações aplicáveis. Etapas, medições, alterações e documentos serão apresentados com identificação e versão. A aprovação de uma medição não confirma pagamento. O aceite pelo WhatsApp não substitui conferência técnica, licença ou documento exigível. A entrega registrará eventuais pendências, sem renúncia a direitos.”

**Medição como lançamento estruturado**

Este contrato precisa integrar a peça genérica de lançamentos. Não é parte da extensão de compras.

| Campo proposto | Tipo | Regra |
|---|---|---|
| `service_code` | texto | Identifica o item contratual medido |
| `period_start`, `period_end` | data | Período medido, com fim igual ou posterior ao início |
| `unit` | lista | `m`, `m2`, `m3`, `un`, `hora`, `percentual` |
| `quantity` | numero | Quantidade decimal positiva; precisão definida por unidade |
| `unit_value_cents` | dinheiro | Valor unitário contratual |
| `total_cents` | dinheiro | Quantidade × valor unitário, com arredondamento explícito para centavos |
| `version` | numero | Versão da medição |
| `decision` | lista | rascunho, liberada, aprovada, ajustes, substituída |
| `evidence_file_ids` | referências de documentos | Evidências e relatório apresentados |
| `supersedes_id` | referência de lançamento | Corrige por substituição, preservando histórico |

Exemplo: 12,50 m² × R$ 80,00 = R$ 1.000,00.

O acumulado considera apenas versões vigentes e aprovadas do mesmo item. Não soma rascunhos, versões substituídas nem a mesma medição duas vezes. Ultrapassar a quantidade contratada exige justificativa e tratamento humano de aditivo.

A quantidade do orçamento atual da OS aceita apenas inteiros (`src/modules/os/model.ts:246`, `src/modules/os/model.ts:248`). Não reutilizar esse validador para medição física decimal.

**Texto de aprovação de medição**

> “Obra {numero}: confira a medição {medicao}, versão {versao}, do período {periodo}, no total de {total}. Escolha APROVAR MEDIÇÃO ou PEDIR AJUSTES. Esta decisão registra a análise da medição; o pagamento segue as condições contratadas.”

Os marcadores específicos da medição são propostos.

### Chamado de pós-obra / Chamados de pós-obra

| Elemento | Configuração |
|---|---|
| ID | `construtora_pos_obra` |
| Primeiro campo fixo | Empreendimento e unidade |
| Segundo campo fixo | Problema observado |
| Numeração apresentada | `POS-{numero_tipo}` |
| Abertura | Não exige decisão prévia de cobertura. O relato é recebido antes da análise. |

**Campos extras**

| Chave | Rótulo | Tipo | Obrigatório | Cliente vê | Sensível |
|---|---|---|---|---|---|---|
| `obra_origem` | Referência da obra de origem | texto | Não | Sim | Não |
| `unidade` | Unidade ou local afetado | texto | Sim | Sim | Não |
| `sistema` | Sistema afetado | lista: estrutura, cobertura, impermeabilização, elétrica, hidráulica, acabamento, outro | Sim | Sim | Não |
| `data_percebida` | Quando percebeu o problema? | data | Não | Sim | Não |
| `data_entrega` | Data de entrega conferida | data | Não | Sim | Não |
| `cobertura` | Análise de cobertura | lista: em análise, coberto, proposta de serviço pago, em revisão | Não | Não | Não |
| `garantia_ate` | Referência de garantia contratual conferida | data | Não | Não | Não |
| `restricoes_acesso` | Restrições de acesso | texto_longo | Não | Não | Sim |

A equipe confirma a obra de origem. Texto informado pelo cliente não concede acesso à obra. `cobertura`, `data_entrega` e `garantia_ate` são editáveis apenas pela equipe autorizada.

**Etapas**

| ID | Rótulo | Base | Pode ir para | Mensagem ao entrar | Aviso parado | Tarefa padrão |
|---|---|---|---|---|---:|---|
| `recebido` | Chamado recebido | `received` | `triagem`, `cancelado` | Recebemos o chamado de pós-obra {numero}. A equipe conferirá o relato e os próximos passos. | 1 | Conferir contato, unidade e prioridade — 1 dia |
| `triagem` | Triagem | `analyzing` | `vistoria`, `analise`, `cancelado` | O chamado {numero} está em triagem. Podemos solicitar informações adicionais antes de agendar a visita. | 1 | Conferir relato e necessidade de visita — 1 dia |
| `vistoria` | Vistoria | `analyzing` | `analise`, `cancelado` | O chamado {numero} está na etapa de vistoria. O horário será confirmado pela Agenda. | 3 | Realizar vistoria e registrar evidências — 2 dias |
| `analise` | Análise técnica e de cobertura | `analyzing` | `execucao`, `orcamento`, `encerrado`, `cancelado` | A equipe está analisando o chamado {numero}. A conclusão e a proposta de atendimento serão comunicadas por uma pessoa responsável. | 3 | Revisar parecer e condições de atendimento — 2 dias |
| `orcamento` | Proposta de serviço enviada | `quoted` | `autorizado`, `recusado`, `analise`, `cancelado` | Há uma proposta de serviço para o chamado {numero}. A equipe explicará o escopo e as condições antes de qualquer autorização. | 3 | Acompanhar resposta à proposta — 3 dias |
| `autorizado` | Serviço autorizado | `approved` | `execucao`, `cancelado` | A proposta do chamado {numero} foi aprovada. Vamos confirmar a execução. | 2 | Confirmar equipe, materiais e visita — 2 dias |
| `recusado` | Proposta recusada | `declined` | `analise`, `cancelado` | A recusa da proposta do chamado {numero} foi registrada. Você pode solicitar revisão da análise à equipe. | 2 | Verificar revisão solicitada ou encerramento — 2 dias |
| `execucao` | Atendimento em execução | `in_progress` | `conferencia`, `cancelado` | O atendimento do chamado {numero} está em execução. Avisaremos quando estiver disponível para conferência. | 3 | Executar atendimento e registrar serviço realizado — 3 dias |
| `conferencia` | Conferência do atendimento | `ready` | `execucao`, `encerrado`, `cancelado` | O atendimento do chamado {numero} está disponível para conferência. Informe se ficou alguma pendência. | 3 | Solicitar conferência e registrar pendências — 2 dias |
| `encerrado` | Encerrado | `delivered` | — | O encerramento do chamado {numero} foi registrado com o resultado informado pela equipe. Para uma nova ocorrência, abra outro chamado e cite este número. | 0 | — |
| `cancelado` | Cancelado | `cancelled` | — | O chamado {numero} foi cancelado. O histórico do atendimento será preservado conforme a política de guarda. | 0 | — |

| Recurso | Uso |
|---|---|
| Orçamento | Ligado, mas opcional. Só enviar proposta paga após análise humana e explicação ao solicitante. |
| Garantia | Ligada como controle de referências, documentos e cobertura analisada. Não aplicar automaticamente o prazo padrão de 90 dias da OS embutida. |
| Retirada | Desligada. |
| Termos | Texto abaixo. |
| Tarefas | Conforme a tabela. Relatos de risco recebem prioridade humana imediata, sem esperar o vencimento da tarefa. |
| Pessoas ligadas | Solicitante, comprador, responsável pelo acesso, técnico responsável e prestador. |
| Documentos liberáveis | Relatório de vistoria, parecer de atendimento, proposta, relatório do serviço e orientação de uso revisada. |
| Documentos internos | Fotos brutas, parecer jurídico, notas de cobertura e registros de acesso. |
| Lançamentos | Relato, vistoria, análise de cobertura, execução, retorno e pendência. |
| Encerramento sem execução | Exige decisão humana, justificativa e comunicação. Não encerrar automaticamente por silêncio, vencimento ou negativa de cobertura. |
| Garantia após reparo | Eventual efeito do reparo sobre a cobertura depende de análise aplicável. Não reiniciar nem extinguir prazo automaticamente. |

**Termo de abertura**

> “Registro a ocorrência descrita e autorizo o contato para organizar a análise e o acesso necessário. A abertura não define cobertura de garantia nem autoriza serviço pago. A equipe comunicará a análise e as condições de atendimento. Qualquer proposta paga dependerá de aprovação específica. O encerramento registrará o resultado e eventuais pendências, sem renúncia a direitos.”

## 3. Vocabulário

| Conceito | Nome na área |
|---|---|
| Cliente da Obra | Contratante |
| Cliente do Pós-obra | Solicitante ou comprador |
| Conjunto dos tipos | Obras e pós-obra |
| Responsável da Obra | Responsável técnico |
| Responsável do chamado | Técnico responsável |
| Orçamento | Proposta |
| Lançamento físico | Medição |
| Registro cotidiano | Diário de obra |

## 4. Módulos

| Módulo | Estado sugerido | Configuração |
|---|---|---|
| OS | Ligado | Obra e Chamado de pós-obra. |
| Agenda | Ligado | Visita inicial: 60 min; reunião de obra: 30 min; vistoria de entrega: 90 min; vistoria de pós-obra: 60 min. |
| Mensalidade | Desligado | Nenhum plano. Parcelas da obra seguem o contrato, sem criar assinatura artificial. |
| Formulários | Ligado | “Informações para a visita de pós-obra”, abaixo. |
| Cobrança | Ligado | Cobranças conforme contrato ou proposta paga aprovada. Medição aprovada não gera cobrança automática nesta proposta. |
| Reserva | Desligado | Sem catálogo. |
| ERP | Ligado | Compras e financeiro conforme permissões existentes. O vínculo com a obra depende da extensão. |
| ERP: Caixa/PDV | Desligado | Sem frente de caixa. |
| ERP: Fiscal e Cobrança bancária | Desligados inicialmente | Ativar somente após configuração específica da empresa. |

O núcleo do ERP reúne cadastros, documentos, estoque e financeiro. Fiscal, Cobrança bancária e Caixa/PDV são opcionais separados (`src/modules/erp/definition.ts:1`, `src/modules/erp/definition.ts:88`, `src/modules/erp/definition.ts:96`, `src/modules/erp/definition.ts:104`). Ocultar todas as telas não utilizadas por um perfil específico continua **a conferir**.

Agenda: antecedência mínima de 24 horas, janela de 30 dias, grade de 30 minutos, lembrete de 24 horas e remarcação até 12 horas antes. Só oferecer horários compatíveis com a equipe e o acesso.

**Formulário “Informações para a visita de pós-obra”**

| Pergunta pronta | Tipo | Obrigatória |
|---|---|---|
| Qual é o número do chamado? | texto | Sim |
| Qual é o empreendimento e a unidade? | texto | Sim |
| Em qual ambiente o problema aparece? | texto | Sim |
| Desde quando você percebe o problema? | data | Não |
| O problema acontece sempre ou em alguma situação específica? | texto_longo | Sim |
| Há alguma restrição de horário para a visita? | texto | Não |

O formulário complementa o chamado. Não substitui a triagem de risco. A equipe confere o vínculo antes de associar respostas. Não pedir senhas, códigos de portaria ou imagens de documentos pessoais.

## 5. WhatsApp

| Caminho do menu | Ação |
|---|---|
| Solicitar obra | `os_open`, referência `construtora_obra` |
| Acompanhar obra | `os_track`, referência `construtora_obra` |
| Pós-obra → Abrir chamado | `os_open`, referência `construtora_pos_obra` |
| Pós-obra → Meus chamados | `os_track`, referência `construtora_pos_obra` |
| Pós-obra → Informações para visita | Formulário complementar |
| Agendar visita | Agenda |
| Meus agendamentos | Consulta e alterações permitidas |
| Pagamentos | Financeiro humano |
| Falar com a equipe | Atendimento humano |

O cliente consulta andamento, aprova relatórios e medições liberados, pede ajustes, recebe documentos, agenda visitas e abre pós-obra. Não acessa compras, fornecedores, margem, diário bruto ou dados de outros compradores.

| Disparo | Texto pronto | Regra |
|---|---|---|
| Agendamento | “Agendado: {servico} com {profissional}, em {data} às {hora}. A equipe confirmará as condições de acesso.” | Após confirmação |
| Lembrete | “Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma?” | 24 horas antes |
| Medição pendente | “A obra {numero} tem uma medição disponível para análise. Confira a versão apresentada e escolha aprovar ou pedir ajustes.” | Uma vez após 3 dias |
| Pendência do cliente | “Na obra {numero}, falta concluir: {tarefa}. Prazo combinado: {vencimento}. Fale com a equipe se precisar ajustar.” | Um dia antes |
| Diário pendente | “Obra {numero}: falta registrar o diário do dia de atividade. Informe serviços, equipe, ocorrências e impedimentos.” | Equipe, no fim do dia programado |
| Conferência de pós-obra | “O chamado {numero} aguarda sua conferência. Informe se ficou alguma pendência no atendimento realizado.” | Uma vez após 3 dias; sem encerramento automático |
| Risco relatado | “Não é possível avaliar a segurança por esta conversa. Afaste-se da situação de risco e procure o atendimento de emergência competente. Vou sinalizar o relato à equipe.” | Prioridade imediata |

## 6. Bot da área

**Texto para o campo de instruções**

> “Você atende contratantes e solicitantes de pós-obra desta construtora. Consulte somente registros vinculados ao telefone da conversa e informações liberadas. Ajude a abrir solicitações, consultar etapas, localizar pendências e usar a Agenda. Informe apenas prazos, medições e documentos liberados pela equipe. Não aprove medição, etapa ou proposta pelo cliente. Não determine cobertura de garantia, causa de defeito, segurança da construção ou responsabilidade de pessoas. Não prometa data nova, reparo gratuito, desconto ou indenização. Encaminhe alterações, riscos, atrasos, conflitos e dúvidas técnicas à equipe. Não leia compras, custos internos, dados de trabalhadores, documentos brutos, fotos privadas ou restrições sensíveis de acesso. Em relato de risco, envie a orientação cadastrada e sinalize prioridade humana.”

| Nível | Ações |
|---|---|
| Sozinho | Consultar etapa, pendência e horário; explicar o fluxo cadastrado. |
| Com confirmação | Propor abertura e agendamento; apresentar ação explícita para resposta do cliente. |
| Consulta a equipe antes | Mudança de escopo, data, medição, cobertura, valor, acesso de outra pessoa ou liberação de arquivo. |
| Nunca | Declarar defeito coberto ou excluído, diagnosticar segurança, aprovar compra, baixar pagamento ou encerrar conflito por silêncio. |
| Não pode ler | Compras do ERP, custos, folha, documentos de trabalhadores, fotos brutas, notas de cobertura e campos sensíveis. |

## 7. Equipe

| Papel | Vê | Faz |
|---|---|---|
| Atendimento | Solicitações, etapas, agenda e resumos liberados | Abre chamados, organiza visitas e encaminha relatos |
| Responsável técnico | Obra, registros técnicos e dados necessários | Libera etapas, documentos, medições e pareceres |
| Encarregado | Obras atribuídas, tarefas, projetos liberados e equipe necessária | Registra diário, avanço e impedimentos |
| Pós-obra | Chamados atribuídos e documentos necessários | Faz triagem, agenda, registra visita e execução |
| Compras | Requisições autorizadas e pedidos de compra permitidos no ERP | Opera compras e, com a extensão, vincula pedidos à obra |
| Financeiro | Contratos, medições liberadas e dados financeiros autorizados | Trata cobranças e pagamentos |
| Gestor | Operação e permissões concedidas | Distribui responsáveis e configura acessos |

O ERP permite escrita de pedidos de compra aos papéis `admin` e `estoque` (`src/erp/domains/documents/public.ts:75`). O papel comercial “Compras” deve ser mapeado a essa permissão, sem conceder administração geral desnecessária.

| Organização | Valores |
|---|---|
| Setores | Atendimento; Obras; Pós-obra; Compras; Financeiro |
| Categorias de protocolo | Nova obra; Cronograma; Medição; Alteração de escopo; Documentos; Visita; Pós-obra; Pagamento; Relato de risco |

## 8. Passos manuais

| Ordem | Ação |
|---:|---|
| 1 | Cadastrar responsáveis técnicos, encarregados, prestadores e acessos. |
| 2 | Adaptar etapas ao tipo de obra e registrar critérios de liberação. |
| 3 | Cadastrar cronograma real, frentes, dias de atividade e responsáveis. |
| 4 | Revisar itens contratuais, unidades de medição e arredondamento. |
| 5 | Conferir projetos, ART/RRT, licenças e documentos exigíveis. |
| 6 | Configurar ERP, fornecedores, permissões e cobrança. |
| 7 | Definir análise de pós-obra, cobertura por sistema e documentos de entrega. |
| 8 | Revisar termos, privacidade, retenção e acesso a fotos e registros de trabalhadores. |
| 9 | Configurar agenda, mensagens e responsáveis por relatos urgentes. |
| 10 | Ativar compra por obra somente depois da implementação e validação da extensão. |

## 9. Extensão: compra por obra

### Objetivo e limite

**Proposta de módulo opcional:** `obra-compras`, com `requires: ["os", "erp"]`.

A extensão liga um pedido de compra existente no ERP a uma Obra do motor generalizado. Ela não cria um segundo pedido, não copia o financeiro e não controla estoque.

O mecanismo de dependências de módulos está definido em `src/modules/types.ts:76` e `docs/MODULOS.md:82`. O ERP já trabalha com documentos `purchase_orders` (`src/erp/domains/documents/public.ts:67`).

**Sem a extensão**, o modelo resolve etapas físicas, cronograma, diário, equipes, documentos, medições, visitas e pós-obra. Compras continuam operadas no ERP. Uma referência digitada em anotação pode ajudar a equipe, mas não constitui vínculo validado nem relatório confiável de custo por obra.

### Escopo da primeira versão

| Tema | Regra proposta |
|---|---|
| Cardinalidade | Uma obra pode ter vários pedidos. Um pedido pode ter apenas uma obra ativa vinculada. |
| Pedido compartilhado | Fora da primeira versão. Não ratear por item ou percentual. |
| Fonte de verdade da compra | ERP. |
| Fonte de verdade do vínculo | D1 do atendimento. |
| Identidade | ID estável do pedido, nunca apenas número exibido. |
| Área | Obra e pedido precisam pertencer ao mesmo `profile_id`. |
| Tipo da OS | Aceitar somente `construtora_obra`. Não vincular a chamado de pós-obra. |
| Alteração do vínculo | Desvincular com motivo e criar outro vínculo. Preservar histórico. |
| Cancelamento no ERP | Não apagar vínculo. Mostrar a situação atual e seu efeito informativo. |
| Valores | Consultados no ERP com permissão. Não duplicar totais ou pagamentos na tabela de vínculo. |
| Efeito financeiro | Nenhum. Vincular não lança conta, não recebe mercadoria e não confirma pagamento. |
| Acesso do cliente | Nenhum acesso a pedidos ou vínculos de compra. |
| IA | Rotas fora do catálogo do bot na primeira versão. |

O salvamento de documento do ERP contém caminho de automação financeira que retorna operação ainda não portada em determinadas condições (`src/erp/domains/documents/rpc/erp_document_save.ts:128`, `src/erp/domains/documents/rpc/erp_document_save.ts:157`). A extensão não deve depender desse caminho.

### Tabelas propostas

DDL de desenho. Não executado. Todos os comandos são aditivos.

```sql
-- A chave composta permite validar área e obra no mesmo vínculo.
-- O id atual da OS já é chave primária.
CREATE UNIQUE INDEX IF NOT EXISTS
  os_orders_profile_id_id_for_purchase_link
ON os_orders(profile_id, id);

CREATE TABLE IF NOT EXISTS obra_purchase_links (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  erp_document_id TEXT NOT NULL,
  erp_document_kind TEXT NOT NULL DEFAULT 'purchase_orders'
    CHECK (erp_document_kind = 'purchase_orders'),
  erp_version_seen INTEGER NOT NULL
    CHECK (erp_version_seen >= 1),
  verified_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'detached')),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  detached_at INTEGER,
  detached_by TEXT,
  detach_reason TEXT,
  UNIQUE (profile_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id),
  CHECK (
    (
      state = 'active'
      AND detached_at IS NULL
      AND detached_by IS NULL
      AND detach_reason IS NULL
    )
    OR
    (
      state = 'detached'
      AND detached_at IS NOT NULL
      AND detached_by IS NOT NULL
      AND detach_reason IS NOT NULL
      AND length(trim(detach_reason)) > 0
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  obra_purchase_links_one_active_order
ON obra_purchase_links(profile_id, erp_document_id)
WHERE state = 'active';

CREATE INDEX IF NOT EXISTS
  obra_purchase_links_by_work
ON obra_purchase_links(profile_id, order_id, state, created_at, id);

CREATE TABLE IF NOT EXISTS obra_purchase_link_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('linked', 'detached', 'verified')),
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  link_version INTEGER NOT NULL
    CHECK (link_version >= 1),
  erp_version_seen INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  UNIQUE (profile_id, command_key),
  FOREIGN KEY (profile_id, link_id)
    REFERENCES obra_purchase_links(profile_id, id)
);

CREATE INDEX IF NOT EXISTS
  obra_purchase_link_events_by_link
ON obra_purchase_link_events(profile_id, link_id, created_at, id);
```

A estrutura atual de `os_orders` contém `id` como chave primária e `profile_id` obrigatório (`migrations/0035_os_orders.sql:12`). O índice composto proposto não remove nem altera a unicidade de numeração existente.

Não há chave estrangeira para o pedido do ERP. O módulo declara que o ERP mantém banco próprio da área (`src/modules/erp/definition.ts:34`). A existência e a autorização do pedido serão verificadas pela interface pública do ERP, sem acesso direto às tabelas de outro armazenamento.

`result_json` armazena apenas o resultado mínimo do comando de vínculo. Não guarda documento de compra, fornecedor, preços ou dados bancários.

### Rotas propostas

Prefixo: `/api/v1/profiles/{profile}/obra-compras`.

Estas rotas **não existem por força deste documento**. A rota pública exata para consultar o pedido no ERP é **a conferir**.

| Método e rota | Entrada | Resultado e autorização |
|---|---|---|
| `GET /obras/{order_id}/vinculos` | Cursor e limite | Lista paginada dos vínculos da obra. Exige leitura da obra e autorização de compras. |
| `POST /obras/{order_id}/vinculos` | `erp_document_id`, `expected_erp_version`, `command_key` | Confere o pedido e cria o vínculo. Exige escrita de vínculo e permissão de compra no ERP. |
| `GET /vinculos/{link_id}` | — | Dados do vínculo e situação consultada no ERP, conforme permissões. |
| `POST /vinculos/{link_id}/verificar` | `expected_version`, `command_key` | Atualiza a versão observada após nova consulta autorizada ao ERP. |
| `POST /vinculos/{link_id}/desvincular` | `expected_version`, `reason`, `command_key` | Desativa o vínculo sem apagar histórico. Exige escrita e justificativa. |

| Situação | Resposta proposta |
|---|---|
| Recurso inexistente ou de outra área | `404` sem revelar existência externa |
| Ator sem permissão no módulo | `403` |
| Versão divergente | `409` |
| Pedido já vinculado ativamente a outra obra | `409` |
| Reutilização da chave com conteúdo diferente | `409` |
| ERP indisponível durante criação ou verificação | Falhar sem gravar vínculo novo |
| ERP indisponível durante leitura | Mostrar vínculo local com “consulta ao ERP indisponível”; não afirmar situação atual |

### Regras de negócio e consistência

| Regra | Comportamento |
|---|---|
| Identidade do ator | Usar a identidade da pessoa no ERP. Não usar administrador técnico para contornar permissões. |
| Escrita | Exigir permissão na extensão, acesso à obra e permissão adequada no ERP. |
| Validação | Conferir área, tipo `purchase_orders`, existência, visibilidade e versão observada. |
| Pedido cancelado | Impedir novo vínculo na primeira versão. Preservar vínculos anteriores. |
| Obra encerrada | Permitir vínculo tardio somente a gestor autorizado, com motivo auditado. |
| Idempotência | Mesmo `command_key`, ator e conteúdo retornam o resultado anterior. Conteúdo diferente gera conflito. |
| Concorrência | Comparar versão do vínculo. O índice parcial impede dois vínculos ativos para o mesmo pedido. |
| Transação local | Gravar vínculo, evento e referência no histórico da OS na mesma unidade transacional local suportada. Forma exata no D1: **a conferir**. |
| Dois armazenamentos | Não presumir transação atômica entre D1 e ERP. Guardar a versão observada e informar a data de verificação. |
| Mudança posterior no ERP | O vínculo continua apontando para o mesmo documento. Nova verificação registra a versão atual. |
| Desvinculação | Não cancela pedido nem estorna lançamento do ERP. |
| Histórico da OS | Registrar ação, autor e referência do vínculo. Não incluir preços em histórico acessível ao cliente. |
| Consultas | Paginar vínculos e buscar pedidos em lote quando a API permitir. Evitar uma consulta remota por linha. Limites de D1 e interface de lote: **a conferir**. |

A versão observada não congela o pedido do ERP. Ela registra o que foi conferido. Uma mudança posterior deve aparecer como mudança do documento, sem reescrever o evento anterior.

### Leitura, escrita, privacidade e guarda

| Perfil | Leitura | Escrita |
|---|---|---|
| Compras autorizado | Vínculos e compras permitidos pelo ERP | Vincular, verificar e desvincular |
| Gestor autorizado | Vínculos e documentos permitidos | Mesmas ações; vínculo tardio com motivo |
| Financeiro | Vínculos e dados permitidos no ERP | Sem escrita de vínculo por padrão |
| Encarregado e pós-obra | Sem acesso ao pedido por padrão | Nenhuma |
| Cliente | Nenhuma | Nenhuma |
| Bot | Nenhuma nesta versão | Nenhuma |

Não replicar dados pessoais de fornecedores, empregados ou compradores. O histórico registra identificadores da pessoa que executou a ação.

A política de guarda precisa acompanhar a finalidade contratual, fiscal e de auditoria da obra e da compra. O prazo numérico depende da política aprovada e das obrigações aplicáveis: **a conferir**. Não oferecer exclusão automática dessa trilha antes dessa definição.

Solicitações de correção devem preservar a rastreabilidade. A eventual eliminação ou anonimização precisa tratar vínculo, eventos, histórico da OS, exportações e cópias de segurança de modo coordenado. LGPD e obrigações de guarda aplicáveis: **a conferir**.

### Fora do escopo

| Item | Destino |
|---|---|
| Rateio de um pedido entre obras | Evolução futura, se houver pedido explícito |
| Custo real ou margem da obra | Projeto financeiro próprio |
| Requisição e aprovação de compra | Fluxo do ERP ou evolução separada |
| Cotação entre fornecedores | ERP |
| Recebimento de materiais e estoque por canteiro | ERP; eventual integração futura |
| Pagamento e contas a pagar | ERP |
| Compra disparada por medição | Fora desta extensão |
| Automação fiscal | Fora desta extensão |
| Integração com fornecedores | Fora desta extensão |
| Nova classe de Durable Object | Proibida pelo limite do plano |

## 10. Dúvidas e decisões

| Decisão | Proposta |
|---|---|
| Nome do conjunto | “Obras e pós-obra”. |
| Modelo de obra | Começar com construção e reforma pequenas. Frentes simultâneas em tarefas. |
| Medição | Exigir contrato estruturado de quantidade, unidade, valor, versão e aprovação antes de publicar a funcionalidade. |
| Cobrança por medição | Sem automação inicial. Definir separadamente o lançamento financeiro dos módulos. |
| Garantia | Sem prazo universal. Cobertura por sistema e serviço, revisada por pessoa responsável. |
| Regras de garantia e entrega | Legislação contratual e de consumo, normas técnicas e obrigações profissionais: **a conferir**. |
| Encerramento do pós-obra | Não automático por silêncio ou negativa. Registrar resultado e comunicação. |
| Compra por obra | Primeira versão com um pedido ligado a uma única obra. |
| Dados da equipe | Somente o necessário à operação. Documentação trabalhista fora do bot e do cliente. |
| Retenção | Aprovar política por classe documental antes da publicação. |

**Modelo neutro**

```json
{
  "id": "construtora",
  "name": "Construtoras",
  "labels": {
    "customer": "Contratante",
    "customers": "Contratantes",
    "work_collection": "Obras e pós-obra",
    "responsible": "Responsável técnico",
    "quote": "Proposta"
  },
  "modules": {
    "on": ["os", "agenda", "forms", "payments", "erp"],
    "off": ["mensalidade", "reserva", "erp-pdv", "erp-fiscal", "erp-cobranca"]
  },
  "policies": {
    "apply_mode": "merge",
    "sensitive_to_ai": false,
    "raw_files_to_ai": false,
    "purchase_data_to_ai": false,
    "file_versions_immutable": true,
    "file_release_requires_human": true,
    "approval_scope": "work_stage_version_files",
    "approval_reminder_days": 3,
    "task_days": "calendar",
    "customer_task_reminder_days_before": 1,
    "automatic_billing_on_measurement": false,
    "automatic_warranty_start": false
  },
  "work_types": [
    {
      "id": "construtora_obra",
      "singular": "Obra",
      "plural": "Obras",
      "item_label": "Obra ou empreendimento",
      "problem_label": "Escopo contratado ou solicitado",
      "number_prefix": "OBRA",
      "features": {"quote": true, "warranty": false, "pickup": false, "terms": true, "tasks": true, "people": true, "files": true, "entries": true},
      "quote_valid_days": 7,
      "terms_text": "Solicito a análise da obra informada. A execução depende de contrato, condições de início e liberações aplicáveis. Etapas, medições, alterações e documentos serão apresentados com identificação e versão. A aprovação de uma medição não confirma pagamento. O aceite pelo WhatsApp não substitui conferência técnica, licença ou documento exigível. A entrega registrará eventuais pendências, sem renúncia a direitos.",
      "fields": [
        {"key": "modalidade", "label": "Modalidade", "type": "lista", "required": true, "customer_visible": true, "sensitive": false, "options": ["construção", "reforma", "ampliação", "manutenção", "outra"]},
        {"key": "municipio", "label": "Município e UF", "type": "texto", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "endereco", "label": "Endereço completo da obra", "type": "texto_longo", "required": true, "customer_visible": false, "sensitive": true, "options": []},
        {"key": "area_m2", "label": "Área contratada em m²", "type": "numero", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "art_numero", "label": "ART principal", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "rrt_numero", "label": "RRT principal", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "protocolo_prefeitura", "label": "Protocolo municipal", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "inicio_previsto", "label": "Início previsto", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "entrega_prevista", "label": "Entrega prevista", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "valor_contratado", "label": "Valor contratado", "type": "dinheiro", "required": false, "customer_visible": true, "sensitive": false, "options": []}
      ],
      "stages": [
        {"id": "entrada", "label": "Solicitação recebida", "base": "received", "next": ["orcamento", "cancelado"], "message": "Recebemos a solicitação da obra {numero}. Vamos conferir o escopo e as informações necessárias.", "stale_days": 2},
        {"id": "orcamento", "label": "Proposta enviada", "base": "quoted", "next": ["contratada", "recusada", "entrada", "cancelado"], "message": "A proposta da obra {numero} está disponível. Confira escopo, etapas, medições e condições de pagamento.", "stale_days": 3},
        {"id": "contratada", "label": "Obra contratada", "base": "approved", "next": ["licencas", "mobilizacao", "cancelado"], "message": "A proposta da obra {numero} foi aprovada. A equipe confirmará documentos, condições de início e cronograma.", "stale_days": 3},
        {"id": "recusada", "label": "Proposta recusada", "base": "declined", "next": ["entrada", "cancelado"], "message": "A recusa da proposta da obra {numero} foi registrada.", "stale_days": 3},
        {"id": "licencas", "label": "Aprovações e licenças", "base": "analyzing", "next": ["mobilizacao", "cancelado"], "message": "A obra {numero} está na conferência das aprovações e licenças aplicáveis. O início depende da liberação responsável.", "stale_days": 14},
        {"id": "mobilizacao", "label": "Mobilização", "base": "in_progress", "next": ["fundacoes", "estrutura", "instalacoes", "acabamentos", "cancelado"], "message": "Iniciamos a mobilização da obra {numero}, conforme as condições liberadas pela equipe.", "stale_days": 7},
        {"id": "fundacoes", "label": "Fundações", "base": "in_progress", "next": ["estrutura", "cancelado"], "message": "A obra {numero} entrou na etapa de fundações. O andamento será informado após conferência da equipe.", "stale_days": 7},
        {"id": "estrutura", "label": "Estrutura e vedações", "base": "in_progress", "next": ["instalacoes", "cancelado"], "message": "A obra {numero} entrou na etapa de estrutura e vedações.", "stale_days": 7},
        {"id": "instalacoes", "label": "Instalações", "base": "in_progress", "next": ["acabamentos", "cancelado"], "message": "A obra {numero} entrou na etapa de instalações. Os serviços seguirão os projetos liberados.", "stale_days": 7},
        {"id": "acabamentos", "label": "Acabamentos", "base": "in_progress", "next": ["vistoria_entrega", "cancelado"], "message": "A obra {numero} entrou na etapa de acabamentos. As escolhas pendentes serão enviadas separadamente.", "stale_days": 7},
        {"id": "vistoria_entrega", "label": "Vistoria de entrega", "base": "ready", "next": ["acabamentos", "entregue", "cancelado"], "message": "A obra {numero} está disponível para vistoria de entrega. Vamos registrar as verificações e eventuais pendências.", "stale_days": 3},
        {"id": "entregue", "label": "Entregue", "base": "delivered", "next": [], "message": "A entrega da obra {numero} foi registrada. Guarde os documentos recebidos. Solicitações posteriores podem ser abertas em Pós-obra.", "stale_days": 0},
        {"id": "cancelado", "label": "Cancelada", "base": "cancelled", "next": [], "message": "A obra {numero} foi cancelada no acompanhamento. A equipe tratará o encerramento contratual e as pendências.", "stale_days": 0}
      ],
      "approval_stages": ["mobilizacao", "fundacoes", "estrutura", "instalacoes", "acabamentos"],
      "receipt_stages": ["vistoria_entrega"],
      "transition_guards": [
        {"from": "contratada", "to": "mobilizacao", "rule": "Responsável registra conferência das autorizações aplicáveis ou sua não aplicação."},
        {"from": "licencas", "to": "mobilizacao", "rule": "Responsável confere e registra liberações aplicáveis."},
        {"from": "mobilizacao", "to": "estrutura", "rule": "Responsável registra que fundações não integram o escopo."},
        {"from": "mobilizacao", "to": "instalacoes", "rule": "Responsável registra as etapas anteriores fora do escopo."},
        {"from": "mobilizacao", "to": "acabamentos", "rule": "Responsável registra as etapas anteriores fora do escopo."}
      ],
      "people_roles": [
        {"id": "contratante", "label": "Contratante"},
        {"id": "responsavel_tecnico", "label": "Responsável técnico"},
        {"id": "encarregado", "label": "Encarregado"},
        {"id": "lider_equipe", "label": "Líder de equipe"},
        {"id": "prestador", "label": "Prestador"},
        {"id": "fiscal_contratante", "label": "Fiscal do contratante"}
      ],
      "entry_kinds": [
        {"id": "diario", "label": "Diário de obra"},
        {"id": "medicao", "label": "Medição"},
        {"id": "andamento", "label": "Andamento"},
        {"id": "ocorrencia", "label": "Ocorrência"},
        {"id": "horas", "label": "Horas"},
        {"id": "alteracao", "label": "Decisão de alteração"}
      ],
      "entry_schemas": {
        "medicao": {
          "fields": [
            {"key": "service_code", "type": "texto", "required": true},
            {"key": "period_start", "type": "data", "required": true},
            {"key": "period_end", "type": "data", "required": true},
            {"key": "unit", "type": "lista", "required": true, "options": ["m", "m2", "m3", "un", "hora", "percentual"]},
            {"key": "quantity", "type": "numero", "required": true},
            {"key": "unit_value_cents", "type": "dinheiro", "required": true},
            {"key": "total_cents", "type": "dinheiro", "required": true},
            {"key": "version", "type": "numero", "required": true},
            {"key": "decision", "type": "lista", "required": true, "options": ["rascunho", "liberada", "aprovada", "ajustes", "substituída"]}
          ],
          "evidence_file_ids": true,
          "supersedes_id": true,
          "approved_versions_immutable": true,
          "automatic_billing": false
        }
      },
      "file_kinds": [
        {"id": "proposta", "label": "Proposta", "customer_can_receive": true},
        {"id": "contrato", "label": "Contrato", "customer_can_receive": true},
        {"id": "art", "label": "ART", "customer_can_receive": true},
        {"id": "rrt", "label": "RRT", "customer_can_receive": true},
        {"id": "licenca", "label": "Licença", "customer_can_receive": true},
        {"id": "prancha", "label": "Prancha liberada", "customer_can_receive": true},
        {"id": "memorial", "label": "Memorial", "customer_can_receive": true},
        {"id": "medicao", "label": "Relatório de medição", "customer_can_receive": true},
        {"id": "vistoria", "label": "Relatório de vistoria", "customer_can_receive": true},
        {"id": "manual_entrega", "label": "Manual de entrega", "customer_can_receive": true},
        {"id": "diario_bruto", "label": "Diário bruto", "customer_can_receive": false},
        {"id": "cotacao", "label": "Cotação", "customer_can_receive": false},
        {"id": "pessoal", "label": "Documentação de pessoal", "customer_can_receive": false},
        {"id": "seguranca_acesso", "label": "Segurança e acesso", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "entrada", "title": "Conferir escopo e documentos iniciais", "due_days": 1},
        {"stage": "orcamento", "title": "Acompanhar resposta à proposta", "due_days": 3},
        {"stage": "contratada", "title": "Conferir contrato, projetos e registros profissionais", "due_days": 2},
        {"stage": "recusada", "title": "Verificar revisão ou encerramento", "due_days": 2},
        {"stage": "licencas", "title": "Conferir protocolo municipal e pendências", "due_days": 7},
        {"stage": "mobilizacao", "title": "Confirmar equipe, acesso e cronograma de frentes", "due_days": 2},
        {"stage": "fundacoes", "title": "Conferir execução, registros e medição da etapa", "due_days": 7},
        {"stage": "estrutura", "title": "Conferir frentes, registros e medição da etapa", "due_days": 7},
        {"stage": "instalacoes", "title": "Conferir instalações, testes previstos e medição", "due_days": 7},
        {"stage": "acabamentos", "title": "Conferir acabamentos e preparar lista de pendências", "due_days": 7},
        {"stage": "vistoria_entrega", "title": "Agendar vistoria e conferir pacote de entrega", "due_days": 2}
      ],
      "recurring_tasks": [
        {"title": "Registrar diário do dia", "when": "cada dia de atividade programado", "responsible_role": "encarregado", "customer_visible": false}
      ]
    },
    {
      "id": "construtora_pos_obra",
      "singular": "Chamado de pós-obra",
      "plural": "Chamados de pós-obra",
      "item_label": "Empreendimento e unidade",
      "problem_label": "Problema observado",
      "number_prefix": "POS",
      "customer_label": "Solicitante",
      "features": {"quote": true, "warranty": true, "pickup": false, "terms": true, "tasks": true, "people": true, "files": true, "entries": true},
      "quote_valid_days": 7,
      "warranty_policy": {
        "mode": "human_review_per_system",
        "default_days": null,
        "automatic_start_on_delivered": false,
        "automatic_reset_after_repair": false
      },
      "terms_text": "Registro a ocorrência descrita e autorizo o contato para organizar a análise e o acesso necessário. A abertura não define cobertura de garantia nem autoriza serviço pago. A equipe comunicará a análise e as condições de atendimento. Qualquer proposta paga dependerá de aprovação específica. O encerramento registrará o resultado e eventuais pendências, sem renúncia a direitos.",
      "fields": [
        {"key": "obra_origem", "label": "Referência da obra de origem", "type": "texto", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "unidade", "label": "Unidade ou local afetado", "type": "texto", "required": true, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "sistema", "label": "Sistema afetado", "type": "lista", "required": true, "customer_visible": true, "sensitive": false, "options": ["estrutura", "cobertura", "impermeabilização", "elétrica", "hidráulica", "acabamento", "outro"]},
        {"key": "data_percebida", "label": "Quando percebeu o problema?", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": []},
        {"key": "data_entrega", "label": "Data de entrega conferida", "type": "data", "required": false, "customer_visible": true, "sensitive": false, "options": [], "customer_editable": false},
        {"key": "cobertura", "label": "Análise de cobertura", "type": "lista", "required": false, "customer_visible": false, "sensitive": false, "options": ["em análise", "coberto", "proposta de serviço pago", "em revisão"], "customer_editable": false},
        {"key": "garantia_ate", "label": "Referência de garantia contratual conferida", "type": "data", "required": false, "customer_visible": false, "sensitive": false, "options": [], "customer_editable": false},
        {"key": "restricoes_acesso", "label": "Restrições de acesso", "type": "texto_longo", "required": false, "customer_visible": false, "sensitive": true, "options": []}
      ],
      "stages": [
        {"id": "recebido", "label": "Chamado recebido", "base": "received", "next": ["triagem", "cancelado"], "message": "Recebemos o chamado de pós-obra {numero}. A equipe conferirá o relato e os próximos passos.", "stale_days": 1},
        {"id": "triagem", "label": "Triagem", "base": "analyzing", "next": ["vistoria", "analise", "cancelado"], "message": "O chamado {numero} está em triagem. Podemos solicitar informações adicionais antes de agendar a visita.", "stale_days": 1},
        {"id": "vistoria", "label": "Vistoria", "base": "analyzing", "next": ["analise", "cancelado"], "message": "O chamado {numero} está na etapa de vistoria. O horário será confirmado pela Agenda.", "stale_days": 3},
        {"id": "analise", "label": "Análise técnica e de cobertura", "base": "analyzing", "next": ["execucao", "orcamento", "encerrado", "cancelado"], "message": "A equipe está analisando o chamado {numero}. A conclusão e a proposta de atendimento serão comunicadas por uma pessoa responsável.", "stale_days": 3},
        {"id": "orcamento", "label": "Proposta de serviço enviada", "base": "quoted", "next": ["autorizado", "recusado", "analise", "cancelado"], "message": "Há uma proposta de serviço para o chamado {numero}. A equipe explicará o escopo e as condições antes de qualquer autorização.", "stale_days": 3},
        {"id": "autorizado", "label": "Serviço autorizado", "base": "approved", "next": ["execucao", "cancelado"], "message": "A proposta do chamado {numero} foi aprovada. Vamos confirmar a execução.", "stale_days": 2},
        {"id": "recusado", "label": "Proposta recusada", "base": "declined", "next": ["analise", "cancelado"], "message": "A recusa da proposta do chamado {numero} foi registrada. Você pode solicitar revisão da análise à equipe.", "stale_days": 2},
        {"id": "execucao", "label": "Atendimento em execução", "base": "in_progress", "next": ["conferencia", "cancelado"], "message": "O atendimento do chamado {numero} está em execução. Avisaremos quando estiver disponível para conferência.", "stale_days": 3},
        {"id": "conferencia", "label": "Conferência do atendimento", "base": "ready", "next": ["execucao", "encerrado", "cancelado"], "message": "O atendimento do chamado {numero} está disponível para conferência. Informe se ficou alguma pendência.", "stale_days": 3},
        {"id": "encerrado", "label": "Encerrado", "base": "delivered", "next": [], "message": "O encerramento do chamado {numero} foi registrado com o resultado informado pela equipe. Para uma nova ocorrência, abra outro chamado e cite este número.", "stale_days": 0},
        {"id": "cancelado", "label": "Cancelado", "base": "cancelled", "next": [], "message": "O chamado {numero} foi cancelado. O histórico do atendimento será preservado conforme a política de guarda.", "stale_days": 0}
      ],
      "approval_stages": [],
      "receipt_stages": ["conferencia"],
      "transition_guards": [
        {"from": "analise", "to": "execucao", "rule": "Equipe registra atendimento autorizado sem proposta paga pendente."},
        {"from": "analise", "to": "orcamento", "rule": "Equipe registra análise e explica as condições do serviço pago."},
        {"from": "analise", "to": "encerrado", "rule": "Decisão humana com justificativa e comunicação; nunca por silêncio ou negativa automática."}
      ],
      "people_roles": [
        {"id": "solicitante", "label": "Solicitante"},
        {"id": "comprador", "label": "Comprador"},
        {"id": "acesso", "label": "Responsável pelo acesso"},
        {"id": "tecnico", "label": "Técnico responsável"},
        {"id": "prestador", "label": "Prestador"}
      ],
      "entry_kinds": [
        {"id": "relato", "label": "Relato"},
        {"id": "vistoria", "label": "Vistoria"},
        {"id": "cobertura", "label": "Análise de cobertura"},
        {"id": "execucao", "label": "Execução"},
        {"id": "retorno", "label": "Retorno"},
        {"id": "pendencia", "label": "Pendência"}
      ],
      "file_kinds": [
        {"id": "vistoria", "label": "Relatório de vistoria", "customer_can_receive": true},
        {"id": "parecer", "label": "Parecer de atendimento", "customer_can_receive": true},
        {"id": "proposta", "label": "Proposta", "customer_can_receive": true},
        {"id": "servico", "label": "Relatório do serviço", "customer_can_receive": true},
        {"id": "orientacao", "label": "Orientação de uso revisada", "customer_can_receive": true},
        {"id": "fotos_brutas", "label": "Fotos brutas", "customer_can_receive": false},
        {"id": "parecer_juridico", "label": "Parecer jurídico", "customer_can_receive": false},
        {"id": "notas_cobertura", "label": "Notas de cobertura", "customer_can_receive": false},
        {"id": "acesso", "label": "Registros de acesso", "customer_can_receive": false}
      ],
      "default_tasks": [
        {"stage": "recebido", "title": "Conferir contato, unidade e prioridade", "due_days": 1},
        {"stage": "triagem", "title": "Conferir relato e necessidade de visita", "due_days": 1},
        {"stage": "vistoria", "title": "Realizar vistoria e registrar evidências", "due_days": 2},
        {"stage": "analise", "title": "Revisar parecer e condições de atendimento", "due_days": 2},
        {"stage": "orcamento", "title": "Acompanhar resposta à proposta", "due_days": 3},
        {"stage": "autorizado", "title": "Confirmar equipe, materiais e visita", "due_days": 2},
        {"stage": "recusado", "title": "Verificar revisão solicitada ou encerramento", "due_days": 2},
        {"stage": "execucao", "title": "Executar atendimento e registrar serviço realizado", "due_days": 3},
        {"stage": "conferencia", "title": "Solicitar conferência e registrar pendências", "due_days": 2}
      ]
    }
  ],
  "module_settings": {
    "agenda": {
      "min_notice_minutes": 1440,
      "max_days_ahead": 30,
      "slot_step_minutes": 30,
      "reminder_hours": 24,
      "customer_change_hours": 12,
      "booked_text": "Agendado: {servico} com {profissional}, em {data} às {hora}. A equipe confirmará as condições de acesso.",
      "reminder_text": "Lembrete: {servico} com {profissional}, em {data} às {hora}. Você confirma?",
      "services": [
        {"id": "construtora_visita_inicial", "name": "Visita inicial", "duration_minutes": 60},
        {"id": "construtora_reuniao_obra", "name": "Reunião de obra", "duration_minutes": 30},
        {"id": "construtora_vistoria_entrega", "name": "Vistoria de entrega", "duration_minutes": 90},
        {"id": "construtora_vistoria_pos_obra", "name": "Vistoria de pós-obra", "duration_minutes": 60}
      ]
    },
    "mensalidade": {"plans": []},
    "payments": {
      "automatic_on_open": false,
      "automatic_on_measurement": false,
      "schedule_source": "contrato ou proposta paga aprovada"
    },
    "erp": {
      "purpose": "Compras e financeiro conforme permissões",
      "automatic_work_posting": false
    },
    "forms": [
      {
        "id": "construtora_visita_pos_obra",
        "name": "Informações para a visita de pós-obra",
        "questions": [
          {"key": "chamado", "label": "Qual é o número do chamado?", "type": "texto", "required": true},
          {"key": "unidade", "label": "Qual é o empreendimento e a unidade?", "type": "texto", "required": true},
          {"key": "ambiente", "label": "Em qual ambiente o problema aparece?", "type": "texto", "required": true},
          {"key": "data_percebida", "label": "Desde quando você percebe o problema?", "type": "data", "required": false},
          {"key": "ocorrencia", "label": "O problema acontece sempre ou em alguma situação específica?", "type": "texto_longo", "required": true},
          {"key": "horario", "label": "Há alguma restrição de horário para a visita?", "type": "texto", "required": false}
        ]
      }
    ]
  },
  "menus": [
    {"id": "construtora_abrir_obra", "label": "Solicitar obra", "type": "os_open", "parent_id": null, "content": "", "work_type_id": "construtora_obra"},
    {"id": "construtora_ver_obra", "label": "Acompanhar obra", "type": "os_track", "parent_id": null, "content": "", "work_type_id": "construtora_obra"},
    {"id": "construtora_pos_obra_menu", "label": "Pós-obra", "type": "submenu", "parent_id": null, "content": ""},
    {"id": "construtora_abrir_chamado", "label": "Abrir chamado", "type": "os_open", "parent_id": "construtora_pos_obra_menu", "content": "", "work_type_id": "construtora_pos_obra"},
    {"id": "construtora_ver_chamados", "label": "Meus chamados", "type": "os_track", "parent_id": "construtora_pos_obra_menu", "content": "", "work_type_id": "construtora_pos_obra"},
    {"id": "construtora_formulario", "label": "Informações para visita", "type": "form", "parent_id": "construtora_pos_obra_menu", "content": "", "form_id": "construtora_visita_pos_obra"},
    {"id": "construtora_agendar", "label": "Agendar visita", "type": "agenda", "parent_id": null, "content": ""},
    {"id": "construtora_agendamentos", "label": "Meus agendamentos", "type": "agenda_mine", "parent_id": null, "content": ""},
    {"id": "construtora_pagamentos", "label": "Pagamentos", "type": "human", "parent_id": null, "content": "Vou encaminhar sua solicitação ao Financeiro.", "department": "Financeiro"},
    {"id": "construtora_equipe", "label": "Falar com a equipe", "type": "human", "parent_id": null, "content": "Vou encaminhar sua mensagem ao Atendimento.", "department": "Atendimento"}
  ],
  "departments": ["Atendimento", "Obras", "Pós-obra", "Compras", "Financeiro"],
  "ticket_categories": ["Nova obra", "Cronograma", "Medição", "Alteração de escopo", "Documentos", "Visita", "Pós-obra", "Pagamento", "Relato de risco"],
  "bot_instructions": "Você atende contratantes e solicitantes de pós-obra desta construtora. Consulte somente registros vinculados ao telefone da conversa e informações liberadas. Ajude a abrir solicitações, consultar etapas, localizar pendências e usar a Agenda. Informe apenas prazos, medições e documentos liberados pela equipe. Não aprove medição, etapa ou proposta pelo cliente. Não determine cobertura de garantia, causa de defeito, segurança da construção ou responsabilidade de pessoas. Não prometa data nova, reparo gratuito, desconto ou indenização. Encaminhe alterações, riscos, atrasos, conflitos e dúvidas técnicas à equipe. Não leia compras, custos internos, dados de trabalhadores, documentos brutos, fotos privadas ou restrições sensíveis de acesso. Em relato de risco, envie a orientação cadastrada e sinalize prioridade humana.",
  "extensions": [
    {
      "id": "obra-compras",
      "name": "Compra por obra",
      "status": "proposta",
      "enabled": false,
      "requires": ["os", "erp"],
      "work_type_id": "construtora_obra",
      "erp_document_kind": "purchase_orders",
      "one_active_work_per_purchase": true,
      "automatic_finance": false,
      "automatic_stock": false,
      "customer_access": false,
      "bot_access": false
    }
  ],
  "manual_steps": [
    "Cadastrar responsáveis técnicos, encarregados, prestadores e acessos.",
    "Adaptar etapas e critérios de liberação ao tipo de obra.",
    "Cadastrar cronograma, frentes, dias de atividade e responsáveis.",
    "Revisar itens contratuais, unidades de medição e arredondamento.",
    "Conferir projetos, ART/RRT, licenças e documentos exigíveis.",
    "Configurar ERP, fornecedores, permissões e cobrança.",
    "Definir análise de pós-obra e cobertura por sistema.",
    "Revisar termos, privacidade e retenção documental.",
    "Configurar agenda, mensagens e atendimento de relatos urgentes.",
    "Ativar compra por obra somente após implementação e validação da extensão."
  ]
}
```