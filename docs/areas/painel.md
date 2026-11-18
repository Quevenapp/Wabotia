**Desenho das telas de tipos de trabalho — painel web do Wabotia**

Data: 18/11/2026. Base: commit `efc7e54`, versão `0.21.1` (`package.json:3`). Documento de projeto. Nenhum arquivo foi alterado. Não houve acesso à rede nem execução de testes.

As indicações **Atual** descrevem código conferido. As indicações **Proposta** descrevem o desenho a implementar. Rotas e campos novos precisam ser fechados no contrato da fase 0.

**1. Como a Ordem de Serviço funciona no painel atual**

O módulo concentra quase toda a operação em `ServiceOrdersPage.tsx`. O detalhe é um diálogo aberto por estado local. Não é uma página com endereço próprio (`web/modules/os/ServiceOrdersPage.tsx:348`, `web/modules/os/ServiceOrdersPage.tsx:645`, `web/modules/os/ServiceOrdersPage.tsx:765`).

| Arquivo | Responsabilidade atual | Referência |
|---|---|---|
| `web/modules/os/ServiceOrdersPage.tsx` | Lista, filtros, abertura, edição, orçamento, detalhe e histórico | `:65`, `:200`, `:348`, `:639` |
| `web/modules/os/ServiceOrdersSettingsPage.tsx` | Termos, prazos, mensagens e inclusão dos destinos no menu do WhatsApp | `:60`, `:87`, `:143` |
| `web/modules/os/ConversationServiceOrders.tsx` | Ordens abertas da conversa, abertura pela equipe e envio do link de abertura | `:14`, `:27`, `:70` |
| `web/modules/os/shared.ts` | Estados, rótulos, cores, verbos de transição, moeda, telefone e datas | `:5`, `:17`, `:29`, `:42`, `:50` |
| `web/modules/os/os.css` | Dados do detalhe, histórico, mensagens e adaptação para tela estreita | `:2`, `:17`, `:32`, `:36` |

A lista começa em “Abertas”. A busca espera 300 ms antes de consultar. Os filtros enviados são `open`, `status` e `q`. A tabela mostra número, cliente, item, estado, orçamento, prazo e atualização (`web/modules/os/ServiceOrdersPage.tsx:641`, `web/modules/os/ServiceOrdersPage.tsx:646`, `web/modules/os/ServiceOrdersPage.tsx:650`, `web/modules/os/ServiceOrdersPage.tsx:702`).

O responsável já existe no formulário e no detalhe. Ainda não aparece como coluna ou filtro da lista (`web/modules/os/ServiceOrdersPage.tsx:178`, `web/modules/os/ServiceOrdersPage.tsx:449`, `web/modules/os/ServiceOrdersPage.tsx:704`).

| Elemento fixo | Onde aparece | Consequência para o desenho |
|---|---|---|
| Nove estados | `web/modules/os/shared.ts:5` | Manter como códigos de compatibilidade |
| Rótulos e cores dos estados | `web/modules/os/shared.ts:17`, `web/modules/os/shared.ts:29` | Criar apresentação de etapa sem alterar o mapa legado |
| Verbos como “Iniciar serviço” e “Registrar entrega” | `web/modules/os/shared.ts:42` | Tipos novos precisam de verbos próprios |
| Encerramento em `delivered` e `cancelled` | `web/modules/os/ServiceOrdersPage.tsx:87`, `web/modules/os/ServiceOrdersPage.tsx:656` | Não deduzir encerramento pelo texto da etapa |
| Transições oferecidas pela API | `web/modules/os/ServiceOrdersPage.tsx:390` | A interface deve continuar recebendo as transições permitidas |
| Tratamento especial de orçamento | `web/modules/os/ServiceOrdersPage.tsx:238`, `web/modules/os/ServiceOrdersPage.tsx:521`, `web/modules/os/ServiceOrdersPage.tsx:552` | Etapa genérica não pode substituir aprovação de orçamento |
| Filtros dos nove estados | `web/modules/os/ServiceOrdersPage.tsx:671` | Tipos novos usam etapas; o embutido mantém os filtros atuais |
| Estado nas linhas da lista | `web/modules/os/ServiceOrdersPage.tsx:720` | Mostrar etapa com retorno ao estado legado quando necessário |
| Estado no histórico | `web/modules/os/ServiceOrdersPage.tsx:597` | Histórico novo precisa registrar também a etapa |
| `item` e `problem` no formulário | `web/modules/os/ServiceOrdersPage.tsx:79`, `web/modules/os/ServiceOrdersPage.tsx:149` | Preservar as chaves; parametrizar rótulos e ajuda |
| Item e problema no detalhe | `web/modules/os/ServiceOrdersPage.tsx:439` | Usar os rótulos do tipo |
| Item na lista e na busca | `web/modules/os/ServiceOrdersPage.tsx:665`, `web/modules/os/ServiceOrdersPage.tsx:719` | Parametrizar coluna e orientação da busca |
| Item, problema e estado na conversa | `web/modules/os/ConversationServiceOrders.tsx:58`, `web/modules/os/ConversationServiceOrders.tsx:100`, `web/modules/os/ConversationServiceOrders.tsx:108` | A abertura e o acompanhamento precisam conhecer o tipo |
| Oito mensagens predefinidas | `web/modules/os/ServiceOrdersSettingsPage.tsx:19`, `web/modules/os/ServiceOrdersSettingsPage.tsx:36` | Preservar no embutido; criar mensagens por etapa nos demais |

Os nove códigos são `received`, `analyzing`, `quoted`, `approved`, `declined`, `in_progress`, `ready`, `delivered` e `cancelled`. Eles também estão definidos no servidor (`src/modules/os/model.ts:6`).

Há duas diferenças importantes entre o contrato desejado e o atual:

| Ponto atual | Evidência | Exigência da generalização |
|---|---|---|
| `counts` agrupa toda a área. Não acompanha os filtros da lista. Estados sem registros podem não aparecer no objeto | `src/modules/os/store.ts:257` | Preservar a semântica legada. Acrescentar contagem por etapa separada |
| Paginação e ordenação usam o número da ordem | `src/modules/os/store.ts:266`, `src/modules/os/store.ts:279` | Números repetidos entre tipos exigem cursor sem ambiguidades nas consultas que misturam tipos |

**Rotas atuais usadas pelas telas**

Na tabela, `P` significa `/api/v1/profiles/{perfil}`. No painel, `app.root` contém `v1/profiles/{perfil}` (`web/app/AppContext.tsx:131`).

| Método e rota | Uso atual | Referência |
|---|---|---|
| `GET P/service-orders` | Lista, busca, filtros, paginação e contadores | `src/modules/os/os.ts:211` |
| `GET P/service-orders/{id}` | Detalhe com histórico | `src/modules/os/os.ts:220` |
| `POST P/service-orders` | Abertura | `src/modules/os/os.ts:230` |
| `PATCH P/service-orders/{id}` | Edição | `src/modules/os/os.ts:256` |
| `POST P/service-orders/{id}/status` | Mudança de estado | `src/modules/os/os.ts:267` |
| `PUT P/service-orders/{id}/quote` | Salvar orçamento | `src/modules/os/os.ts:289` |
| `POST P/service-orders/{id}/quote/send` | Enviar orçamento | `src/modules/os/os.ts:304` |
| `POST P/service-orders/{id}/decision` | Registrar aprovação ou recusa do orçamento | `src/modules/os/os.ts:322` |
| `POST P/conversations/{id}/actions` | Ação `service_order`: abrir ou enviar formulário | `web/modules/os/ConversationServiceOrders.tsx:37` |
| `GET P/menus` e `PUT P/settings` | Incluir destino no menu com revisão da lista | `web/modules/os/ServiceOrdersSettingsPage.tsx:108` |
| `PUT P/settings` | Salvar `service_orders` | `web/modules/os/ServiceOrdersSettingsPage.tsx:151` |

**Componentes e estilos que devem ser reaproveitados**

| Peça existente | O que oferece | Referência |
|---|---|---|
| `useResource` | Leitura, atualização periódica e proteção contra resposta de outro endereço | `web/admin/shared.tsx:15` |
| `useList` e `Pager` | Lista por cursor, reinício ao mudar filtros e avanço de página | `web/admin/shared.tsx:41`, `web/admin/shared.tsx:72` |
| `FormDialog` | Formulário com progresso e erro sem fechar o diálogo | `web/admin/shared.tsx:102` |
| `Table` | Colunas com renderização própria e rótulos para apresentação estreita | `web/ui/misc.tsx:137`, `web/ui/misc.tsx:182` |
| `Field`, `Button`, `Pill`, `Chip`, `Switch` | Campos, ações, etapas, filtros e opções | `web/ui/controls.tsx:320`, `:20`, `:116`, `:138`, `:187` |
| `Segmented` | Abas com seleção e navegação por setas | `web/ui/controls.tsx:216` |
| `Dialog`, `Confirm`, `MenuButton` | Edição curta, confirmação e ações secundárias | `web/ui/overlay.tsx:66`, `:141`, `:295` |
| `Empty`, `Notice`, `SkeletonRows`, `toast` | Vazio, falha, carregamento e resultado | `web/ui/feedback.tsx:13`, `:72`, `:46`, `:131` |
| `useAction`, `useUnsavedGuard` | Retorno das operações e proteção do rascunho | `web/app/hooks.ts:43`, `web/app/hooks.ts:7` |
| `useIntents` | Reutilização da chave de idempotência após falha de comunicação | `web/lib/api.ts:111`, `web/lib/api.ts:144` |

Os outros módulos oferecem precedentes úteis:

| Referência | Padrão aproveitável |
|---|---|
| `web/modules/agenda/AgendaPage.tsx:134` | Filtros por período e profissional |
| `web/modules/reserva/ReservaPage.tsx:261` | Consulta apenas da visão ativa |
| `web/modules/mensalidade/MensalidadesPage.tsx:1217` | Abas que montam componentes separados; `PayersTab` já fica em outro arquivo |
| `web/modules/suporte/SuportePage.tsx:352` | Página pequena que coordena suas abas |
| `web/modules/pedido/OrdersPage.tsx:810` | Separação entre visão operacional e lista |
| `web/modules/mesas/MesasPage.tsx:35` | Reaproveitamento explícito de um detalhe de outro módulo |
| `web/admin/FormsPage.tsx:90` | Editor de campos com obrigatoriedade e botões de subir e descer |
| `web/admin/TemplatesPage.tsx:91`, `web/admin/TemplatesPage.tsx:125` | Árvore de menu, resultado da aplicação e pendências |

`FieldEditor`, `MenuPreview` e `Result` são funções locais nesses arquivos. Seu reaproveitamento direto exigiria extração. Para evitar conflitos nesta entrega, a proposta é reaproveitar o padrão visual e os controles comuns, sem tornar as telas novas dependentes dessas funções internas.

Os estilos globais entram por `web/main.tsx:5`. Gestão acrescenta `admin.css` em `web/admin/AdminArea.tsx:54`. A OS importa seu CSS local em `web/modules/os/ServiceOrdersPage.tsx:44`. As telas novas devem seguir essa separação.

**2. Contrato comum das telas propostas**

O módulo continua sendo `os`. Tipo de trabalho é cadastro da área. Não é um novo módulo nem uma nova entrada fixa no código para cada profissão.

O tipo embutido conserva nomes, mensagens, ações e regras atuais. Recursos novos ficam desligados por padrão nele. A modernização visual não deve obrigar quem usa apenas a OS atual a preencher campos novos ou atravessar novas etapas.

| Informação proposta | Finalidade |
|---|---|
| `type_id` e revisão do tipo | Identificar a definição aplicada ao trabalho |
| `stage` | Identificar a etapa própria, sem substituir `status` |
| Definição das etapas | Rótulo, estado de base e ações possíveis |
| `extra_fields` | Valores adicionais validados pelo servidor |
| `stage_counts` | Contagem por etapa, separada de `counts` |
| Capacidades da resposta | Informar se a pessoa pode editar, transicionar, concluir tarefa ou compartilhar documento |
| Revisão do registro | Detectar edição concorrente |
| Resumo de tarefas | Próximo vencimento e quantidade pendente, sem buscar cada trabalho separadamente |

Esses nomes são propostas. O contrato definitivo é **a conferir na fase 0**.

A interface não deve calcular permissões apenas pelo papel visível. Hoje, a navegação combina perfil administrativo, módulo e acesso da pessoa (`web/workspace-navigation.ts:302`, `web/workspace-navigation.ts:314`). As rotas da OS conferem leitura e escrita no servidor (`src/modules/os/os.ts:212`, `src/modules/os/os.ts:232`). O novo controle por campo e por recurso deve ampliar essa proteção.

| Tela ou recurso | Quem vê — proposta |
|---|---|
| Lista e resumo | Pessoas com leitura do módulo e acesso ao tipo e ao registro |
| Criar, editar e mudar etapa | Pessoas com a capacidade correspondente devolvida pela API |
| Meus prazos | Pessoa autenticada, apenas suas tarefas em registros acessíveis |
| Editor de tipos | Administradores da área |
| Modelos de área | Administradores, inclusive quando `os` ainda estiver desligado |
| Dados sensíveis | Apenas os papéis autorizados para aquele dado |
| Documentos e histórico | Mesmas restrições do conteúdo de origem |
| Cliente pelo WhatsApp | Fora do painel interno. Acesso limitado ao telefone autenticado e ao conteúdo liberado |

Ser responsável por um trabalho não deve conceder acesso automaticamente. Estar na lista de pessoas ligadas também não.

**3. Lista de trabalhos de um tipo**

Serve para acompanhar a operação de um tipo: “Processos”, “Projetos”, “Obras”. Com um único tipo, abre diretamente. Com vários, mantém um seletor de tipo no cabeçalho.

| Campo ou ação | Comportamento proposto |
|---|---|
| Tipo | Nome plural. Seletor apenas quando houver mais de um tipo acessível |
| Busca | Número, contato e campos básicos permitidos. Não pesquisar dados sensíveis sem autorização |
| Etapa | Todas, abertas e etapas do tipo. Contadores vindos de `stage_counts` |
| Responsável | Todos, eu, sem responsável e pessoas elegíveis da área |
| Prazo do trabalho | Todos, atrasados, hoje, próximos sete dias, sem prazo e intervalo |
| Número | Exibir junto ao tipo sempre que o contexto misturar tipos |
| Contato principal | Nome e telefone, quando autorizados |
| Primeiro campo básico | Rótulo do tipo: equipamento, processo, animal ou outro |
| Etapa atual | Texto e cor. Não depender apenas da cor |
| Responsável | Nome ou “Sem responsável” |
| Prazo do trabalho | Data e indicação textual de atraso |
| Próxima tarefa | Vencimento e quantidade pendente, se o recurso estiver ligado |
| Orçamento | Somente quando habilitado no tipo |
| Novo trabalho | Abre formulário já vinculado ao tipo |
| Abrir | Link para o detalhe, preservando filtros ao voltar |
| Limpar filtros e paginar | Ações explícitas |

O filtro “Prazo do trabalho” atua sobre o prazo geral. Não deve misturar esse prazo com o vencimento de tarefas. “Meus prazos” atende ao segundo caso.

A criação pede contato principal, os dois campos básicos, campos extras, responsável e prazo. O tipo não pode ser trocado livremente depois de criado: isso exige conversão de dados e etapas, fora desta primeira entrega.

**Dependências:** leitura dos tipos; lista existente ampliada com `type_id`, `stage`, `assignee` e intervalo de prazo; criação existente ampliada com tipo e campos extras. Todos os filtros devem executar no servidor.

**Reaproveitamento:** `Table`, `SearchBox`, `Chip`, `Field`, `Pager`, `FormDialog`, `useList` e estados de retorno da lista atual (`web/modules/os/ServiceOrdersPage.tsx:654`, `web/modules/os/ServiceOrdersPage.tsx:693`, `web/modules/os/ServiceOrdersPage.tsx:748`).

**4. Detalhe do trabalho**

Para tipos novos, o detalhe deve ocupar uma página com endereço próprio. Seis abas não cabem bem como conteúdo crescente de um diálogo. Diálogos continuam reservados a operações curtas.

| Elemento permanente | Conteúdo ou ação |
|---|---|
| Caminho de retorno | Tipo e volta à lista, com os filtros anteriores |
| Identificação | Nome singular do tipo, número e título |
| Situação | Etapa, responsável e prazo geral |
| Ação principal | Próxima ação permitida pelo servidor |
| Outras ações | Editar, trocar responsável, transições alternativas e cancelamento |
| Conversa | Abrir a conversa vinculada, se houver permissão |
| Abas | Resumo, Tarefas e prazos, Pessoas, Documentos, Lançamentos e Histórico |
| Retorno da operação | Progresso, sucesso e erro junto à ação |

As abas opcionais aparecem somente quando o recurso estiver habilitado. Resumo e Histórico permanecem. A desativação de um recurso com dados precisa preservar uma forma autorizada de consultar os registros antigos.

| Aba | Campos e ações propostas | Dependências |
|---|---|---|
| **Resumo** | Contato principal; dois campos básicos; campos extras por seção; responsável; prazo; observações internas; termos aceitos. Editar e mudar etapa. Orçamento, garantia e retirada apenas quando habilitados | Detalhe, edição, transição e rotas existentes de orçamento |
| **Tarefas e prazos** | Título; descrição; responsável; vencimento; fuso; situação; aviso; visibilidade ao cliente. Criar, editar, concluir, reabrir e cancelar | Lista e comandos de tarefas do trabalho |
| **Pessoas** | Nome; papel no trabalho; contato; vínculo com cadastro existente; indicação do contato principal. Vincular, editar vínculo e desvincular | Lista e comandos de pessoas ligadas |
| **Documentos** | Nome; categoria; tamanho; data; autor; origem; permissão de entrega ao cliente; restrição de acesso. Anexar, baixar, alterar metadados e enviar ao destinatário autorizado | Lista, upload, vínculo do arquivo, download autorizado e envio |
| **Lançamentos** | Tipo; texto; quantidade opcional; unidade; data da ocorrência; autor; visibilidade. Registrar e retificar com rastreabilidade | Lista e comandos de lançamentos |
| **Histórico** | Data; pessoa ou sistema; ação; etapa anterior e posterior; recurso afetado. Filtrar e paginar | Histórico paginado e autorizado |

A aba Resumo deve reaproveitar a organização de dados em `os-facts`. O histórico pode reaproveitar a linha do tempo de `os-history` (`web/modules/os/os.css:2`, `web/modules/os/os.css:17`).

As abas usam `Segmented`, com painéis associados e foco coerente. A montagem apenas da aba ativa segue o precedente de Mensalidade e Suporte (`web/modules/mensalidade/MensalidadesPage.tsx:1232`, `web/modules/suporte/SuportePage.tsx:369`).

Os formulários de tarefa, pessoa e lançamento usam `FormDialog`. O formulário de documento precisa de controle próprio de arquivo e progresso.

Há um transporte de upload em partes no painel (`web/conversations/upload.ts:5`). Seu reaproveitamento para documentos persistentes depende de conferir retenção, autorização e vínculo no servidor. O fato de retornar um identificador de mídia não prova que ele já atende ao novo recurso.

**Regras de interação**

| Situação | Comportamento proposto |
|---|---|
| Mudar etapa | Mostrar apenas destinos permitidos. Solicitar justificativa quando exigida |
| Aprovação de etapa | Operação própria. Não reutilizar a decisão de orçamento |
| Enviar documento | Mostrar destinatário e arquivo antes de confirmar |
| Pessoa ligada | Não ganha acesso ao acompanhamento só por estar vinculada |
| Documento liberado ao cliente | Pode ser entregue ao destinatário autorizado. Não vira arquivo público |
| Campo sensível | Ausente da resposta para quem não pode ler. Nunca enviado à IA ou incluído em mensagens |
| Histórico de dado sensível | Não repetir valores protegidos em texto livre |
| Conflito de edição | Preservar rascunho, informar conflito e permitir recarregar |
| Falha numa aba | Mostrar erro e repetição naquela aba. Manter o restante do detalhe |
| Fechar formulário com alterações | Confirmar descarte |
| Alteração salva | Atualizar a aba, o resumo afetado e a lista de origem |

A aprovação de orçamento atual possui rota e regras próprias. O modelo também distingue suas transições das mudanças manuais (`src/modules/os/model.ts:34`). Essa distinção precisa sobreviver à generalização.

**5. Meus prazos**

Serve para organizar as tarefas da pessoa em todos os tipos da **área de atendimento atual**. Não agrega outras áreas silenciosamente.

| Campo ou ação | Comportamento proposto |
|---|---|
| Responsável | Pessoa autenticada. Sem seletor de outro usuário nesta tela |
| Período | Atrasadas, hoje, próximos sete dias, intervalo e sem vencimento |
| Tipo | Todos os tipos acessíveis ou um tipo específico |
| Situação | Pendentes por padrão; concluídas e canceladas sob filtro |
| Linha da tarefa | Vencimento, título, tipo, número do trabalho, contato autorizado e etapa |
| Ordenação | Vencimento crescente, com desempate estável |
| Sem vencimento | Grupo separado, depois das tarefas datadas |
| Abrir trabalho | Link direto para a aba de tarefas |
| Concluir | Ação rápida, quando permitida |
| Editar prazo ou reabrir | Diálogo curto, quando permitido |

**Dependências:** uma consulta agregada de tarefas por pessoa. Não buscar todas as ordens e depois consultar cada uma.

**Reaproveitamento:** `Table`, `Chip`, `Field`, `Pager`, `FormDialog` e `useList`. Os controles de período e profissional da Agenda servem de referência visual (`web/modules/agenda/AgendaPage.tsx:141`).

A conclusão de tarefa não muda a etapa do trabalho por inferência. Qualquer automação desse tipo precisa estar declarada no contrato.

**6. Editor de tipos de trabalho — Personalizado**

“Personalizado” deve abrir o mesmo editor usado para ajustar os tipos instalados por modelos. Não é um runtime separado.

A página inicial lista tipos. A edição ocupa página própria. Os blocos podem usar abas, mas compartilham um único rascunho e um único salvamento.

| Bloco | Campos propostos | Ações |
|---|---|---|
| Identificação | Identificador estável; nome singular; plural; descrição; ativo | Criar, duplicar, editar e desativar |
| Vocabulário | Rótulo do contato principal; rótulos e ajuda dos dois campos básicos; textos das ações principais | Editar e visualizar exemplo |
| Campos extras | Chave estável; rótulo; tipo; ajuda; obrigatoriedade; opções; limites; ordem; visibilidade ao cliente; sensibilidade; papéis autorizados | Adicionar, editar, subir, descer e desativar |
| Etapas | Chave estável; nome; estado de base; etapa inicial; posição | Adicionar, editar e ordenar |
| Transições | Origem; destino; rótulo da ação; autorização; justificativa; aprovação exigida | Adicionar e remover ligação |
| Recursos | Orçamento; garantia; retirada; termos; tarefas; pessoas; documentos; lançamentos | Ligar e desligar conforme compatibilidade |
| Mensagens | Etapa ou evento; texto; marcadores permitidos; prévia fictícia | Editar e validar |
| Exportação e importação | Versão do formato; nome; conteúdo declarativo; resultado da validação | Exportar JSON, importar, revisar e salvar |

Os tipos de campo iniciais sugeridos são texto curto, texto longo, escolha, número, data e sim/não. O conjunto definitivo e seus limites são **a conferir na fase 0**. Arquivos ficam em Documentos.

| Validação proposta | Resultado na tela |
|---|---|
| Chave duplicada | Erro junto ao campo |
| Etapa sem estado de base | Impedir salvamento |
| Nenhuma etapa inicial ou mais de uma | Impedir salvamento |
| Transição com destino inexistente | Identificar origem e destino inválidos |
| Campo sensível também marcado para entrega ao cliente | Exigir correção; não resolver silenciosamente |
| Marcador sensível em mensagem | Impedir salvamento |
| Exclusão de campo ou etapa já utilizada | Oferecer desativação ou migração explícita |
| Recurso desligado com dados existentes | Informar impacto e preservar consulta autorizada |
| Importação inválida | Mostrar caminho do erro no JSON, sem gravar parcialmente |
| Alteração concorrente | Exigir nova leitura antes de substituir a configuração |

O editor de transições deve ser uma lista “de → para”. Um editor gráfico por arrastar não é necessário.

**Dependências:** leitura do catálogo de tipos; validação da definição; salvamento com revisão. Recomenda-se que os tipos sejam configuração comum, exposta em `settings.work_types`, com escrita validada pelo fluxo de configurações. Nome da chave, revisão e formato são propostas.

Essa escolha precisa ser decidida cedo: `reference` hoje aponta para uma chave de configuração, não para qualquer endpoint de cadastro (`src/modules/types.ts:24`).

**Reaproveitamento:** `Field`, `Switch`, `Button`, `Confirm`, `Notice` e `useUnsavedGuard`. O editor de Formulários já mostra campos ordenáveis e obrigatórios (`web/admin/FormsPage.tsx:90`, `web/admin/FormsPage.tsx:142`).

O tipo embutido deve aparecer identificado como tal. Suas regras estruturais ficam protegidas. “Duplicar como personalizado” permite criar uma variação. As configurações já disponíveis na OS continuam editáveis.

**7. Modelos de área**

Serve para instalar uma configuração inicial e mostrar exatamente o que será gravado.

Deve existir em Gestão mesmo com `os` desligado. É uma porta de entrada da configuração, não uma página dependente de o módulo já estar ativo.

| Etapa | O que mostra | Ação |
|---|---|---|
| Catálogo | Nome, descrição, tipos incluídos, módulos envolvidos e extensões necessárias | Escolher modelo |
| Prévia | Área de destino; tipos; campos; etapas; vocabulário; menus; setores; categorias; mensagens; módulos; sugestões de bot | Revisar |
| Comparação | Valor atual, valor proposto e resultado: criar, manter, alterar ou conflito | Resolver escolhas necessárias |
| Aplicação | Resumo consolidado e pendências impeditivas | Aplicar |
| Resultado | Alterações efetivas, itens preservados, conflitos e tarefas manuais | Abrir os cadastros correspondentes |

| Conteúdo da prévia | Informação obrigatória |
|---|---|
| Tipos | Identificadores, origem do modelo e alterações propostas |
| Módulos | Ligados e desligados antes e depois; dependências |
| Menus | Destino e tipo de trabalho de cada opção |
| Vocabulário | Escopo da troca e exemplos |
| Bots | Instruções e permissões sugeridas, sem conceder acesso sensível |
| Configuração manual existente | O que será preservado |
| Reaplicação | O que já existe e o que foi editado depois da instalação |
| Extensões ausentes | Funcionalidades indisponíveis e próximos passos |
| Trabalho manual restante | Pessoas nos setores, revisão de mensagens e demais pendências |

**Dependências:** catálogo de modelos; prévia calculada pelo servidor; aplicação idempotente sobre a mesma revisão da prévia; retorno das pendências.

**Reaproveitamento:** cartões, árvore de menu, grupos de resultado e atalhos do fluxo atual de modelos (`web/admin/TemplatesPage.tsx:91`, `web/admin/TemplatesPage.tsx:184`, `web/admin/TemplatesPage.tsx:213`). O CSS já tem catálogo, prévia e coluna de aplicação (`web/styles/admin.css:507`, `web/styles/admin.css:554`).

A tela atual oferece “Acrescentar” e “Substituir”. O texto de “Substituir” informa a remoção de configurações manuais (`web/admin/TemplatesPage.tsx:430`, `web/admin/TemplatesPage.tsx:450`). Esse modo não deve entrar em Modelos de área.

Aplicar novamente deve preservar alterações manuais. Prefixo de identificador ajuda a reconhecer a origem, mas não basta para distinguir a versão instalada de uma edição posterior. A prévia precisa considerar versão e procedência.

**8. Rotas propostas e navegação**

As rotas desta seção são propostas, não endpoints existentes.

| Tela | Endereço web proposto |
|---|---|
| Entrada de trabalhos | `/app/gestao/trabalhos` |
| Lista de um tipo | `/app/gestao/trabalhos/{tipo}` |
| Detalhe | `/app/gestao/trabalhos/{tipo}/{id}` |
| Aba do detalhe | Mesmo endereço com `?aba=tarefas`, `pessoas`, `documentos`, `lancamentos` ou `historico` |
| Meus prazos | `/app/gestao/meus-prazos` |
| Tipos de trabalho | `/app/gestao/tipos-de-trabalho` |
| Editor de tipo | `/app/gestao/tipos-de-trabalho/{tipo}` |
| Modelos de área | `/app/gestao/modelos-de-area` |

Os endereços atuais da OS devem continuar válidos. Seus slugs estão em `web/lib/routes.ts:60`.

Hoje, `parseRoute` retorna apenas a página para Gestão. `href` também não inclui identificador ou subdivisão nessa área (`web/lib/routes.ts:101`, `web/lib/routes.ts:119`). Portanto, registrar um slug não basta. Será necessário ampliar leitura, geração, comparação e proteção de navegação.

A proteção atual considera saída da área ou troca de página. Trocar o tipo dentro da mesma página exigirá tratamento adicional para não perder rascunho (`web/lib/routes.ts:185`).

| API proposta | Finalidade e telas dependentes |
|---|---|
| `GET P/work-types` | Definições autorizadas para navegação, lista, detalhe e editor |
| `PUT P/settings` com configuração de tipos e revisão | Salvar tipos e vocabulário pelo editor |
| `POST P/work-types/validate` | Validar definição ou importação sem gravar |
| `GET P/service-orders` com novos filtros | Lista por tipo, etapa, responsável e prazo |
| `POST/PATCH P/service-orders[/{id}]` ampliados | Criar e editar campos extras |
| `POST P/service-orders/{id}/stage` | Transição própria, preservando `/status` |
| `POST P/service-orders/{id}/stage-decisions` | Aprovação ou recusa de etapa, separada do orçamento |
| `GET/POST P/service-orders/{id}/tasks` | Listar e criar tarefas |
| `PATCH P/service-orders/{id}/tasks/{taskId}` | Editar, concluir, reabrir ou cancelar tarefa, conforme ação validada |
| `GET P/work-tasks?assignee=me` | Meus prazos, com período, tipo, situação e cursor |
| `GET/POST P/service-orders/{id}/people` e `PATCH .../people/{linkId}` | Pessoas ligadas |
| `GET/POST P/service-orders/{id}/documents` e `PATCH .../documents/{documentId}` | Documentos e metadados |
| `GET .../documents/{documentId}/download` e `POST .../documents/{documentId}/send` | Download autorizado e envio |
| `GET/POST P/service-orders/{id}/entries` e `PATCH .../entries/{entryId}` | Lançamentos e retificações |
| `GET P/service-orders/{id}/history` | Histórico paginado |
| `GET /api/v1/area-templates` | Catálogo de modelos |
| `POST P/area-templates/{modelo}/preview` | Comparação sem gravação |
| `POST P/area-templates/{modelo}/apply` | Aplicação vinculada à revisão da prévia |

O transporte de arquivos e o descarte de uploads não vinculados ficam **a conferir**. As rotas de mídia existentes só devem ser reutilizadas depois dessa conferência.

Os prefixos `work-types` e `work-tasks` continuam pertencendo ao módulo `os`. Modelos de área precisam de acesso administrativo disponível antes da ativação dele. O contrato atual bloqueia os prefixos declarados quando o módulo está desligado (`src/modules/types.ts:54`).

| Situação da área | Navegação proposta |
|---|---|
| Um tipo acessível | Um item no trilho com seu nome plural. Abre a lista diretamente |
| Vários tipos acessíveis | Um item “Trabalhos”. Abre a última escolha válida ou um seletor |
| Vários tipos | Seletor dentro da área de trabalho. Não criar um item no trilho para cada tipo |
| Tarefas habilitadas | “Meus prazos” como entrada da navegação interna de Trabalhos |
| Administrador | Gestão → Tipos de trabalho e Gestão → Modelos de área |
| Celular | Mesmo destino em Mais, com o mesmo rótulo do computador |
| Sem tipos acessíveis | Estado vazio adequado à permissão. Administrador recebe atalho de configuração |
| Apenas OS embutida | Preservar “Ordens” no trilho e os nomes atuais das páginas |

O trilho e Mais já consomem `railPages`, mas apresentam o rótulo estático do registro (`web/app/Shell.tsx:94`, `web/app/MoreArea.tsx:60`). Ambos precisarão usar o mesmo resolvedor de nome.

**9. Vocabulário**

A troca deve ocorrer no momento de apresentar o dado. Não deve ser uma substituição global de palavras.

| Lugar | Troca proposta |
|---|---|
| Trilho, Mais, grupo e cabeçalho | Plural do tipo ou “Trabalhos” |
| Título do detalhe | Singular do tipo e número |
| Novo registro, edição e estados vazios | Textos completos definidos pelo vocabulário |
| Campos básicos | Rótulos próprios para `item` e `problem` |
| Contato principal | Cliente, contratante, tutor, responsável ou outro papel definido |
| Busca e filtros | Rótulos coerentes com os campos apresentados |
| Painel da conversa | Tipo, etapa, ação de abertura e destino do link |
| Avisos de sucesso e erro da interface | Nome adequado do registro |
| Histórico | Papel do participante e etapa registrados, sem reescrever o fato histórico |
| Mensagens | Apenas modelos configurados e marcadores autorizados |

Os textos fixos atuais aparecem no formulário, detalhe, histórico e conversa (`web/modules/os/ServiceOrdersPage.tsx:129`, `web/modules/os/ServiceOrdersPage.tsx:373`, `web/modules/os/ServiceOrdersPage.tsx:433`, `web/modules/os/ConversationServiceOrders.tsx:44`).

| Lugar | O que não trocar |
|---|---|
| API e banco | `status`, `item`, `problem`, `customer`, identificadores e códigos estáveis |
| Integrações | Prefixo `os.*`, rotas legadas e chaves públicas existentes |
| Histórico e documentos | Texto original de termos aceitos, arquivos e mensagens já enviados |
| Outros módulos | Pedido, Reserva, Cobrança e demais conceitos próprios |
| ERP | Documento Ordem de Serviço do ERP |
| Cadastros globais | “Contatos”, “Pessoas e acessos” e nomes de permissões |
| Texto livre da equipe | Não reescrever automaticamente |

“Paciente” não é necessariamente o dono do telefone. Na veterinária, o animal pode ocupar o primeiro campo básico, enquanto o tutor é o contato principal. Em ensino, aluno e responsável também são papéis diferentes. O editor deve representar essa distinção.

Textos como “Nova”, “Aberta” e “Atualizada” precisam de frases completas configuradas ou de uma regra explícita de flexão. Concatenar um nome variável com adjetivos fixos produzirá erros.

**10. Celular e acessibilidade**

O painel já usa `759px` como limite de modo compacto (`web/app/hooks.ts:37`). A tabela se transforma em blocos quando seu contêiner tem até `559px` (`web/styles/base.css:1341`). Os formulários passam para uma coluna em `560px` (`web/styles/admin.css:845`).

| Elemento | Comportamento proposto em tela estreita |
|---|---|
| Cabeçalho | Voltar, nome do tipo e ação principal. Ações secundárias em menu |
| Busca | Uma linha completa |
| Filtros | Etapa resumida e botão “Filtros”, com quantidade aplicada |
| Tabela | Blocos com rótulo e valor. Sem esconder responsável ou vencimento |
| Etapas numerosas | Seletor pesquisável ou campo de escolha. Não exigir percorrer dezenas de chips |
| Detalhe | Página de uma coluna |
| Abas | Rótulos completos. Rolagem horizontal limitada à barra ou quebra controlada |
| Dados básicos | Rótulo acima do valor; textos longos com quebra |
| Formulários | Uma coluna, erro perto da ação e botão de salvar acessível |
| Editor de etapas | Lista “de → para”, com botões de subir e descer |
| Documentos | Nome quebrável, tamanho e progresso por arquivo |
| Prévia de modelo | Comparação atual/proposto empilhada |
| Aplicação do modelo | Botão após a revisão, sem cobrir conteúdo |
| Prazo e etapa | Texto além da cor |
| Controles | Área de toque confortável e foco visível |

`Segmented` já permite quebra e rolagem horizontal no CSS (`web/styles/base.css:490`). Será preciso validar a combinação com seis rótulos longos. O componente oferece navegação por setas, mas a tela ainda deve associar cada aba ao seu painel (`web/ui/controls.tsx:230`).

Os diálogos atuais viram folhas inferiores no celular. Não ficam automaticamente em tela inteira (`web/styles/base.css:1224`). Essa é outra razão para usar página própria no detalhe longo.

A paleta deve vir dos tokens do painel (`web/styles/tokens.css:1`). Cores específicas por profissão não são necessárias.

**11. Divisão de arquivos e responsabilidade de integração**

A divisão abaixo é proposta. Nenhum arquivo novo foi criado.

Antes de distribuir telas, uma pessoa deve fechar contratos, nomes de propriedades, rotas e capacidades. Depois disso, cada frente trabalha em arquivos próprios.

| Frente | Arquivos novos propostos | Responsabilidade exclusiva |
|---|---|---|
| Contrato comum | `web/modules/os/work-contracts.ts`, `work-api.ts`, `work-vocabulary.ts`, `work-navigation.ts` | Tipos de dados, chamadas, vocabulário e resolução da navegação |
| Controles do domínio | `web/modules/os/components/StagePill.tsx`, `WorkTabs.tsx`, `ExtraFields.tsx`, `AssigneeField.tsx` | Apresentação compartilhada, sem buscar dados por conta própria |
| Lista | `web/modules/os/work/WorkListPage.tsx`, `WorkFilters.tsx`, `WorkFormDialog.tsx`, `work-list.css` | Lista, filtros e criação |
| Estrutura do detalhe | `web/modules/os/work/WorkDetailPage.tsx`, `WorkHeader.tsx`, `work-detail.css` | Carregar resumo, coordenar abas e tratar transições |
| Resumo e orçamento | `web/modules/os/work/WorkSummaryTab.tsx`, `QuoteEditor.tsx` | Campos básicos, extras e orçamento |
| Tarefas | `web/modules/os/tasks/WorkTasksTab.tsx`, `TaskDialog.tsx`, `tasks.css` | Tarefas dentro do trabalho |
| Meus prazos | `web/modules/os/tasks/MyDeadlinesPage.tsx`, `deadline-filters.ts` | Consulta agregada e ordenação |
| Pessoas | `web/modules/os/people/WorkPeopleTab.tsx`, `PersonLinkDialog.tsx`, `people.css` | Vínculos e papéis |
| Documentos | `web/modules/os/documents/WorkDocumentsTab.tsx`, `DocumentUploadDialog.tsx`, `DocumentSendDialog.tsx`, `documents.css` | Arquivos e entrega autorizada |
| Lançamentos | `web/modules/os/entries/WorkEntriesTab.tsx`, `EntryDialog.tsx`, `entries.css` | Registros e retificações |
| Histórico | `web/modules/os/history/WorkHistoryTab.tsx`, `history-labels.ts`, `history.css` | Eventos e paginação |
| Editor | `web/modules/os/types/WorkTypesPage.tsx`, `WorkTypeEditorPage.tsx`, `FieldsEditor.tsx`, `StagesEditor.tsx`, `ResourcesEditor.tsx`, `MessagesEditor.tsx`, `TypeImportDialog.tsx`, `types.css` | Tipos e JSON |
| Modelos de área | `web/admin/area-templates/AreaTemplatesPage.tsx`, `AreaTemplatePreview.tsx`, `AreaTemplateResult.tsx`, `area-templates.css` | Catálogo, comparação, aplicação e pendências |

Cada aba recebe `profile`, `workId`, definição autorizada do tipo e capacidades. A aba controla sua consulta e seu formulário. Comunica alterações ao detalhe por um contrato pequeno, como `onChanged`. Não edita diretamente o estado das outras abas.

As escritas usam o adaptador comum com idempotência. Os estilos ficam prefixados pelo domínio. Só a frente de integração altera navegação, contexto e registros centrais.

**Pontos de registro no código atual**

O contrato de módulos já enumera os registros de página necessários (`docs/MODULOS.md:1027`).

| Ponto | Registro ou ajuste |
|---|---|
| `web/workspace-navigation.ts:41` | Uma entrada em `sections` por página nova |
| `web/workspace-navigation.ts:121` | Incluir páginas nos grupos |
| `web/workspace-navigation.ts:202` | Marcar editor e modelos como administrativos |
| `web/workspace-navigation.ts:231` | Associar páginas operacionais e editor a `os` |
| `web/workspace-navigation.ts:258` | Reutilizar a entrada de OS no trilho. Não registrar cada tipo |
| `web/workspace-navigation.ts:343` | Descrições das páginas |
| `web/lib/routes.ts:34` | Slugs novos |
| `web/admin/AdminArea.tsx:119` | Importação e `case` por página nova |
| `src/modules/os/definition.ts:14` | Declarar navegação nova pertencente ao módulo |
| `src/modules/os/definition.ts:28` | Acrescentar `reference` a `os_open` e `os_track` |
| `src/modules/os/definition.ts:51` | Declarar a nova configuração de tipos |
| `src/modules/os/definition.ts:58` | Associar novos prefixos de API ao mesmo módulo |
| `web/modules/conversation.tsx:24` | Manter uma extensão de `os`; adaptar o componente existente |
| `web/lib/demo.ts:469` | Atualizar metadados de referência da demonstração |

Nem toda mudança cabe em uma linha de registro:

| Integração estrutural | Trabalho necessário |
|---|---|
| Rotas de Gestão | Suportar tipo, trabalho, aba, filtros e comparação de endereço |
| Cabeçalhos e menus | Resolver o vocabulário em `AdminArea`, `Shell` e `MoreArea` |
| Contexto da área | Carregar tipos autorizados e invalidá-los ao trocar de área |
| Guarda de rascunho | Cobrir mudança de tipo, registro e aba |
| Conversa | Escolher tipo, usar o formulário comum e abrir diretamente o trabalho |
| Configurações de OS | Separar configurações do embutido e edição dos tipos novos |
| Menus do WhatsApp | Diferenciar o par tipo de item + tipo de trabalho |
| Demonstração | Criar respostas locais para as telas novas, além dos metadados |

Hoje, a inclusão dos destinos no menu verifica somente `item.type`. Isso impediria tratar corretamente dois destinos `os_open` para tipos diferentes (`web/modules/os/ServiceOrdersSettingsPage.tsx:80`, `web/modules/os/ServiceOrdersSettingsPage.tsx:110`).

Também não basta declarar `reference` para obter um seletor automático: o contrato do painel informa que campos extras de destinos devem ser oferecidos pela tela do módulo (`docs/MODULOS.md:1048`). O editor de tipos deve permitir adicionar “Abrir” e “Acompanhar” ao menu já com a referência preenchida.

**12. Dúvidas e decisões pendentes**

| Dúvida | Recomendação ou ponto a conferir |
|---|---|
| Nome do conjunto | Usar “Trabalhos” quando houver vários tipos. Decisão do usuário |
| Onde ficam as definições | Preferir configuração comum em `settings.work_types`. Confirmar formato, limites e revisão na fase 0 |
| Compatibilidade dos aplicativos | A conferir. Este levantamento não inspecionou Android e iOS |
| Etapas que compartilham estado de base | Definir transições por etapa. Não inferir destino apenas de `status` |
| Efeitos de `ready` e `delivered` | Mapeamento de etapa não deve ativar retirada ou garantia sem o recurso correspondente |
| Edição de tipos em uso | Definir revisão, desativação e eventual migração de registros. Não apagar referências históricas |
| Paginação entre tipos | A conferir no contrato. Número isolado deixa de ser suficiente |
| Contagens por etapa | Definir quais filtros afetam `stage_counts`. Não alterar silenciosamente `counts` |
| Responsáveis elegíveis | A interface atual seleciona usuários da equipe; o servidor verifica acesso à área. Confirmar se o novo cadastro exigirá papel específico (`web/modules/os/ServiceOrdersPage.tsx:59`, `src/modules/os/store.ts:71`) |
| Prazo com horário | Definir data simples, data e hora e fuso. O conversor atual fixa o prazo em 18h de Brasília (`web/modules/os/shared.ts:78`) |
| Prazos forenses | Não calcular no editor genérico. Dependem da extensão jurídica |
| Contato principal e pessoas ligadas | Definir quem recebe mensagens e quem pode acompanhar cada registro |
| Permissões sensíveis | Definir papéis e autorização no servidor. A redação atual trata telefone e notas, sem representar a nova matriz por campo (`src/modules/os/store.ts:166`) |
| Arquivos | A conferir retenção, formatos, tamanho, descarte de upload órfão e registro de acesso |
| Aprovação de etapa | Definir identidade do aprovador, texto aceito e distinção entre decisão do cliente e registro feito pela equipe |
| Reaplicação de modelos | Definir procedência e revisão para preservar alterações manuais |
| Módulos desligados pelo modelo | A prévia deve explicitar impacto e conflitos. Não apagar dados |
| Saúde e menores | O editor genérico não libera prontuário nem dados escolares sensíveis. Dependem das extensões previstas |
| Limites de D1 | A conferir. O desenho prevê paginação, resumos agregados e consulta apenas da aba ativa; não houve medição |
| Ordem das entregas | Fechar contrato e navegação primeiro. Lista e resumo na fase 1; abas operacionais e Meus prazos na fase 2; modelos e editor completo na fase 3 |