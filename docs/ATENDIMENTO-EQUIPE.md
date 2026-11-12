# Linhas, menus e equipe

As configurações de atendimento pertencem ao perfil e funcionam com os clientes web, Android e iOS. A migração `0009_service_team.sql` é aditiva: mantém históricos existentes, acrescenta atribuições de bots e cria as conversas internas privadas.

## Linhas de atendimento

O painel **Linhas** lista os canais Meta, QR e WhatsApp pelo Hermes, incluindo linhas que não participam de grupos do roteador. O administrador escolhe:

- **Herdar do perfil:** usa o Bot Atendente configurado no perfil.
- **Pessoa:** novos contatos entram na fila humana; bots não respondem automaticamente.
- **Bot:** usa o bot escolhido para aquela linha. O mesmo bot pode atender várias linhas.
- **Menus automáticos, sob demanda ou desativados:** controla quando as opções podem ser apresentadas.

As permissões da linha continuam valendo. Um número dedicado a uma integração pode manter menus e bots desativados; mudar apenas o tipo de atendimento não ignora essas restrições. Para ficar fora do roteador, desative **Participar do roteamento** em Função e permissões. Alterar credenciais de conexão preserva atribuições e permissões da linha.

No cadastro do bot, `line_ids: null` permite todas as linhas do perfil. Uma lista de IDs limita as linhas; `[]` deixa o bot disponível apenas para uso interno. A autorização é verificada antes de encaminhar dados ao Hermes, ao criar uma execução e antes de entregar respostas pendentes. Alterar o modo ou bot padrão da linha invalida respostas antigas das conversas que herdavam essa configuração. Uma transferência explícita para um bot permanece vinculada à conversa até nova transferência ou devolução ao padrão.

Um perfil pode ser ativado com atendimento configurado por linha, sem exigir um bot padrão global.

## Menus e submenus

O painel mostra a hierarquia em árvore. Crie um submenu e use **Adicionar opção dentro** no próprio item para cadastrar seus filhos. Um submenu recém-criado fica vazio até receber opções; ele continua visível para edição, mas não aparece para o cliente enquanto não houver uma opção disponível. O seletor de menu pai mostra o caminho completo e permite mover uma opção para outro ramo. Não é possível colocar um item dentro dele mesmo ou de um descendente.

Cada opção aceita `line_ids` (lista vazia significa todas as linhas) e `trigger`, com `automatic` ou `manual`. Os filhos herdam as restrições dos ancestrais: um submenu não reaparece em outra linha por omitir a própria lista.

Na conversa, **VOLTAR** sobe um nível e **MENU** abre o menu principal, mantendo o responsável pelo atendimento. A lista considera as permissões de cada linha: um ramo sem nenhuma opção utilizável é omitido.

Ao salvar ou excluir, o painel confere se outra aba ou pessoa alterou o menu. Em conflito, mantém a edição para revisão e não substitui silenciosamente os dados novos. Alterar o Bot Atendente ou outras configurações não reenvia uma cópia antiga da árvore.

Uma pessoa responsável pelo atendimento pode apresentar o menu principal ou um submenu. Bots também podem responder com a ação estruturada `{"action":"menu","menu_id":null}` ou com o ID de um submenu autorizado. A apresentação cria um contexto de seleção: o usuário pode digitar a opção mesmo durante atendimento humano. Navegar em submenus e abrir um aplicativo mantém o responsável; escolher atendimento humano ou um bot encaminha o atendimento correspondente.

Os menus respeitam as permissões da linha e a janela de atendimento. Na API oficial, um menu em texto exige mensagem do cliente naquele número nas últimas 24 horas. Cada nova mensagem recebida do cliente renova a janela; respostas da equipe e templates enviados não a renovam. Não há teto local de mensagens.

## Pessoas e bots

O diretório reúne pessoas e bots do perfil. Pessoas controlam sua presença por **Online/Offline**. A presença do bot depende de estar habilitado, da conexão ativa e de resposta recente do Hermes. Consultas de presença usam cache de um minuto, e chamadas bem-sucedidas ao Hermes renovam o registro. Offline não apaga o histórico nem impede escrever a uma pessoa para leitura posterior.

A ação **Transferir** aceita outra pessoa ou um bot habilitado para a linha. A transferência para bot inclui a pergunta recente, o histórico público, fontes da base de conhecimento e menus/ações autorizados. Ela começa imediatamente quando a janela está aberta, mantendo o número da conversa e invalidando respostas do responsável anterior.

## Conversas internas privadas

O chat interno não envia mensagens ao WhatsApp e não entra nos totais das linhas. Entre pessoas, o histórico pertence exclusivamente aos dois participantes. Com bots, uma execução Hermes recebe apenas o histórico daquela conversa interna; o resultado volta ao chat interno.

Administradores que não participam da conversa não têm acesso pelo painel, API, eventos ou exportação de execuções. O acesso ao banco pela infraestrutura continua sendo responsabilidade do proprietário da instalação. Remover ou desabilitar um contato preserva o histórico para o outro participante e impede novos envios. A tela recebe as 500 mensagens mais recentes; os registros anteriores permanecem no banco.

O chat interno de bots oferece mensagens de texto. Artefatos e anexos gerados pelo bot não são importados para esse canal privado. Falhas, cancelamentos e execuções sem confirmação aparecem no estado da solicitação; o sistema não repete silenciosamente a execução.

## Contrato REST

Todas as rotas abaixo começam com `/api/v1/profiles/{profile}`. Escritas exigem `Idempotency-Key` e autenticação; alterações de configuração exigem administrador.

| Método e caminho                     | Corpo ou resultado                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /lines`                         | `{data:[{id,name,kind,mode,status,number,number_policy,service}]}`                                                           |
| `PUT /lines/{id}`                    | `{service:{mode,bot_id,menu_mode},number_policy?:{...}}`                                                                     |
| `GET /menus?connection_id=...`       | `{data:[...],revision:"..."}`; o parâmetro filtra opções permitidas naquela linha; sem filtro retorna a lista completa para edição |
| `PUT /settings`                      | `{menus:[...],menus_revision:"..."}`; revisão opcional protege contra sobrescrita concorrente; preserva os demais campos omitidos |
| `PATCH /bots/{id}`                   | `{line_ids:null,enabled?:boolean,name?:string}`; `line_ids` também aceita uma lista de IDs. Campos omitidos são preservados. |
| `GET /team`                          | `{data:[{id,kind,name,online,bot_id?,line_ids?}]}`; ID de bot: `bot:{id}`                                                    |
| `POST /conversations/{id}/actions`   | `{action:"transfer",target:"ID_PESSOA"}`; `target` também aceita `"bot:ID_BOT"`.                                             |
| `POST /conversations/{id}/actions`   | `{action:"menu",menu_id:null}`; `menu_id` também aceita `"ID_SUBMENU"`.                                                      |
| `GET /internal-chats`                | `{data:[{id,profile_id,member_a,member_b,created,updated,peer}]}`                                                            |
| `POST /internal-chats`               | `{peer_id:"ID_PESSOA"}`; `peer_id` também aceita `"bot:ID_BOT"`. Reutiliza o chat existente.                                 |
| `GET /internal-chats/{id}`           | Dados do chat, `peer` e `messages:[{id,author,text,created,status,run_id}]`                                                  |
| `POST /internal-chats/{id}/messages` | `{text:"..."}`; retorna a mensagem e, para bot, `run_id`                                                                     |

O evento `internal.message` contém apenas o identificador do chat e é visível exclusivamente a seus participantes. Aplicações externas não acessam os chats internos. `line_ids` no retorno existente de `/bots` é JSON serializado, seguindo a representação persistida dos bots.

## Verificação

`tests/service-team.test.ts` cobre isolamento entre participantes e perfis, leitura e relatórios de execuções privadas, autorização de linhas, menus manuais durante atendimento humano, janela de 24 horas, transferência imediata para bot, revogação antes da entrega QR, histórico recente, presença Hermes e preservação das configurações ao editar credenciais.
