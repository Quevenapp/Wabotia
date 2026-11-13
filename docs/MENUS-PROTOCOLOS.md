# Menus, setores e consulta de protocolos

Em **Automação → Menus e ações**, cada opção pode abrir um submenu, enviar uma mensagem informativa ou um link, chamar um bot específico, encaminhar para uma fila humana, abrir um protocolo, consultar protocolos ou pedir uma avaliação.

Na Meta, até três opções com títulos de até 20 caracteres usam botões de resposta. Até dez opções usam uma lista, inclusive quando os títulos precisam de mais espaço. Outros canais e menus maiores usam texto numerado. A apresentação segue os formatos de [mensagens interativas documentados pela Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/interactive/). Cada número mantém suas permissões e a janela de atendimento; um menu não autoriza enviar fora dela.

As respostas dos botões identificam uma opção da apresentação enviada, da conversa e da sessão. A apresentação expira após 24 horas. Botões antigos, de outra conversa ou de uma opção removida/desabilitada não executam ações: o cliente recebe a orientação para enviar **MENU**. Reordenar opções no painel não muda o significado de um botão já enviado. Nos menus de texto, os números seguem a ordem da apresentação enviada enquanto ela estiver ativa.

## Cadastrar a hierarquia

1. Clique **Adicionar item** e escolha **Submenu** para organizar opções, por exemplo **Suporte Técnico**. Ele pode ser salvo antes dos filhos.
2. Use **Adicionar item** no submenu. Escolha **Ação** para enviar uma mensagem, abrir um link, consultar protocolos ou encaminhar para equipe/bot; escolha **Submenu** para abrir mais um nível de opções.
3. A árvore mostra o caminho completo. Arraste pela alça para soltar **antes**, **depois** ou **dentro** de um submenu. O destaque mostra onde o item ficará, e a mudança é salva ao soltar. Um submenu leva seus filhos junto, mantendo os IDs, conteúdo e ordem interna.
4. Para retirar um ramo de um submenu, arraste para o destino **Menu principal** ou para antes/depois de um item da raiz. Também é possível usar **Subir**/**Descer** para ordenar e **Editar / mover** para escolher o pai, sem arrastar.

Não é possível soltar dentro de uma ação, do próprio item ou de seus descendentes. Um submenu com filhos precisa continuar sendo submenu até que os filhos sejam movidos ou removidos. Pressionar Escape, cancelar o gesto ou soltar fora de um destino válido não salva. Se a árvore mudar em outra aba durante o arraste, o painel recarrega os dados e pede que o movimento seja revisto.

Um submenu vazio permanece no editor com indicação de que falta cadastrar opções. Ele não aparece para o cliente enquanto não tiver um destino utilizável. A mesma regra vale quando todos os filhos estão desabilitados ou indisponíveis para aquela linha. **VOLTAR** sobe para o menu pai; **MENU** abre o principal. Navegar entre níveis mantém o responsável pela conversa.

A exclusão de um ramo pede confirmação mostrando os itens envolvidos. Se outra aba alterar o item ou o ramo durante a edição, o painel informa o conflito e preserva o rascunho, sem substituir os dados novos. Reabra a edição para revisar a versão atual antes de salvar novamente.

## Setores de atendimento

No fim da tela de menus, abra **Setores de atendimento → Adicionar setor**, dê um nome e selecione pessoas com acesso ao perfil. Depois escolha esse setor no destino **Equipe humana** de uma opção.

O encaminhamento coloca a conversa na fila do setor e pausa o bot. Somente membros autorizados do setor ou administradores podem assumir, responder, transferir ou atualizar seus protocolos. A presença continua manual. Se nenhum membro estiver disponível, o Wabotia cria um protocolo com o prazo padrão configurado e informa ao cliente como consultá-lo.

Administradores podem intervir em qualquer setor. Setores organizam responsabilidade e filas dentro de um perfil; não substituem os perfis como separação de acesso aos dados. Desativar um setor retira seus destinos dos menus. As conversas já encaminhadas continuam identificadas, para o administrador realocá-las.

Na conversa, **Protocolos, avaliação e setores** permite encaminhar para outro setor, enviar uma consulta de protocolo ou solicitar uma nota. A pessoa precisa assumir o atendimento antes das ações, com a exceção administrativa já existente.

## Consulta pelo cliente, bot ou pessoa

O cliente pode:

- escolher uma opção **Consultar protocolos**;
- escrever **CONSULTAR PROTOCOLO**, **MEUS PROTOCOLOS** ou uma frase equivalente;
- digitar o número completo, como `WA-ABC123-1A2B`.

A lista mostra até dez protocolos recentes. Um número completo consulta também protocolos mais antigos. A resposta apresenta estado, aplicativo (quando o protocolo tem categoria), solicitação, prazo da primeira resposta enquanto o protocolo está ativo e último andamento público. Notas internas e IDs de responsáveis não são enviados.

A identificação usa o telefone recebido de um canal autenticado, dentro do mesmo perfil, e reúne os protocolos desse telefone em outras linhas. Uma aplicação que informa um telefone pela API não recebe acesso aos protocolos de conversas reais desse número. Conversas sem uma identidade de canal verificável consultam apenas seus próprios protocolos. A consulta de um número de outra pessoa e a consulta de um número inexistente produzem a mesma resposta. Consultas individuais não são feitas em grupos.

O bot usa a ação estruturada `protocols`, com `protocol_number` opcional, e recebe a mesma verificação de titularidade. A equipe pode usar o botão da conversa ou a API:

```json
{ "action": "protocols", "number": "WA-ABC123-1A2B" }
```

Envie para `POST /api/v1/profiles/{profile}/conversations/{id}/actions`, com a autenticação e `Idempotency-Key` normais. Omitir `number` solicita a lista recente. O endpoint envia a consulta ao cliente e devolve os registros públicos consultados.

## Abrir protocolo pelo cliente

Desde a 0.14.0 o cliente pode registrar um pedido sem entrar na fila humana:

- escolhendo uma opção de menu do tipo **Abrir protocolo** (`type: "ticket"`);
- escrevendo **PROTOCOLO**, **ABRIR PROTOCOLO** ou **NOVO PROTOCOLO**, sozinho na mensagem, sem diferenciar maiúsculas, acentos e pontuação final. **MEUS PROTOCOLOS** e **CONSULTAR PROTOCOLO** continuam sendo consulta.

O Wabotia envia a pergunta (a do destino, ou "Descreva em uma mensagem o que você precisa. Se puder, diga o que tentou e o que aconteceu.") e aguarda a descrição por até 30 minutos. A próxima mensagem de texto vira o protocolo: os primeiros 300 caracteres formam o título e o texto completo entra como primeiro andamento público. O cliente recebe então a mensagem de confirmação.

O protocolo aparece em **Protocolos** como **Recebido**, sem responsável e com a categoria do destino, quando houver. A conversa **não** vai para a fila, o estado e o responsável não mudam, e um protocolo novo é sempre criado, mesmo que a conversa já tenha outro ativo. A regra de um protocolo ativo por conversa vale só para a abertura automática, quando a equipe está ausente.

Enquanto a pergunta está aberta:

- **MENU** ou **VOLTAR** cancelam com o aviso "Abertura de protocolo cancelada."; quando a linha tem menu, ele é reapresentado (VOLTAR mostra o nível em que o cliente estava);
- **MEUS PROTOCOLOS**, **CONSULTAR PROTOCOLO**, um número de protocolo sozinho ou o toque em um botão deixam a pergunta e seguem o caminho normal;
- **PROTOCOLO** de novo repete a pergunta;
- uma mensagem sem texto (só anexo) recebe um lembrete e a pergunta continua aberta;
- uma pesquisa de avaliação pendente é cancelada quando a pergunta é feita, para que "3 dias sem acesso" não vire nota 3. O inverso também vale: pedir uma avaliação ou uma pessoa assumir a conversa encerra a pergunta.

O destino e as palavras exigem as mesmas permissões de `protocols` e `survey`: mensagens de serviço na linha e menus ou bots habilitados. Não existem em grupos. Repetir o processamento de uma mensagem não cria um segundo protocolo.

O bot atendente pode abrir o mesmo protocolo com a ação estruturada `ticket`: `text` com o pedido e `category_id` com uma categoria da lista `categories` que ele recebe, ou `null`. A conversa continua com o bot e o cliente recebe a confirmação.

## Estados, categorias, prazo e confirmação

| Estado | Para a equipe | Para o cliente | Ativo |
|---|---|---|---|
| `open` | Recebido | Recebido | sim |
| `in_progress` | Em análise | Em análise | sim |
| `waiting_customer` | Aguardando cliente | Aguardando você | sim |
| `waiting_third` | Aguardando terceiro | Aguardando atualização | sim |
| `resolved` | Resolvido | Resolvido | não |
| `closed` | Encerrado | Encerrado | não |

Protocolo **ativo** é o que não está resolvido nem encerrado. Só os ativos contam para a regra de um protocolo por conversa na ausência da equipe, para os alertas de prazo, para o filtro de atrasados, para receber um responsável quando alguém assume a conversa e para a marcação da primeira resposta. Qualquer transição entre os seis estados é aceita, com as permissões de sempre. Quando o cliente escreve em uma conversa com protocolo em **Aguardando cliente**, o protocolo volta sozinho para **Em análise**.

**Categorias** (`ticket_categories`) identificam o aplicativo ou o assunto: até 50 itens `{ "id", "name", "enabled" }`. O protocolo guarda o `id`; a consulta do cliente mostra "Aplicativo: nome". Remover uma categoria não altera protocolos antigos, que passam a mostrar o `id` gravado. Uma categoria em uso por um destino **Abrir protocolo** não pode ser removida antes do destino.

**Prazo da primeira resposta**: `protocol_response_unit` escolhe entre `hours` (padrão, horas corridas de `protocol_response_hours`) e `business_days` (`protocol_response_days`, de 1 a 60). Em dias úteis, a contagem parte do momento da abertura quando ele cai no horário de atendimento de um dia útil, ou da próxima abertura; o prazo é a mesma hora do relógio, N dias úteis depois, sempre no horário de Brasília. Com segunda a sexta, 09:00–18:00 e 3 dias: aberto terça 14:00 vence sexta 14:00; aberto sábado 10:00 ou sexta 19:30 parte de segunda 09:00 e vence quinta 09:00. `business_hours` guarda `days` (0 = domingo), `start`, `end` e `holidays` (até 100 datas `AAAA-MM-DD`). Mudar a configuração não recalcula protocolos já abertos.

**Confirmação** (`protocol_confirmation`, até 1500 caracteres) aceita os marcadores `{numero}`, `{assunto}`, `{aplicativo}` e `{prazo}`. A linha cujo marcador não tem valor (sem categoria, sem prazo) é omitida inteira. Ela é enviada quando um protocolo é aberto para o cliente: destino de menu, palavra PROTOCOLO, ação do bot e equipe ausente no encaminhamento, caso em que vem depois das instruções de ausência. Protocolo aberto por atendente não envia confirmação.

**Saudação do menu principal** (`menu_greeting`, até 900 caracteres): quando preenchida, abre o menu principal no lugar de "Como podemos ajudar?", na lista interativa e no menu numerado. Submenus continuam usando o próprio título. Vazio volta ao texto padrão.

## Modelos de atendimento

**Automação → Modelos de atendimento** aplica um modelo pronto. O modelo **Central de aplicativos** cria quatro setores (sem pessoas), nove categorias, o prazo de 3 dias úteis e um menu com Ajuda gratuita, Meus protocolos, Já tenho contrato, Contratar serviços, Compras e licenças e Conhecer aplicativos. **Acrescentar** cria só o que ainda não existe e não altera o que você já configurou; **Substituir** troca menus, setores, categorias, prazo, horário e textos pelos do modelo, mantendo as pessoas já colocadas nos setores do modelo e os feriados. Conversas e protocolos nunca são tocados. O resumo da aplicação lista o que ainda depende de você: colocar pessoas nos setores, revisar os textos, cadastrar conhecimento e configurar o modelo de notificação. Detalhes em [Central de atendimento por modelo](CENTRAL-ATENDIMENTO.md).

## Avaliações e links

O destino **Avaliar atendimento** pode ter uma pergunta própria. O cliente responde de 1 a 5, com comentário opcional. A equipe também pode usar `{ "action": "survey" }` na mesma rota de ações. Enviar **MENU** cancela a pesquisa pendente e apresenta as opções novamente, impedindo que uma escolha numerada de menu seja interpretada como nota. Respostas de pesquisas pendentes são aceitas durante 24 horas.

Para conteúdo simples, use **Mensagem informativa**. Para direcionar a uma página, use **Conteúdo com link** com endereço público HTTPS e texto explicativo. Para operações de sistema, como segunda via de boleto, use o bot especialista no Hermes, com suas próprias credenciais e permissões.

## Contrato de configuração

`PUT /api/v1/profiles/{profile}/settings` aceita atualizações parciais:

```json
{
  "departments": [
    { "id": "financeiro", "name": "Financeiro", "members": ["id-da-pessoa"], "enabled": true }
  ],
  "menus": [
    { "id": "fin", "label": "Financeiro", "type": "human", "department_id": "financeiro", "enabled": true },
    { "id": "protocolos", "label": "Meus protocolos", "type": "protocols", "enabled": true },
    { "id": "abrir", "label": "Abrir protocolo", "type": "ticket", "category_id": "printher", "content": "Conte o que aconteceu.", "enabled": true },
    { "id": "nota", "label": "Avaliar", "type": "survey", "enabled": true },
    { "id": "ajuda", "label": "Ajuda", "type": "link", "url": "https://example.com/ajuda", "content": "Veja nosso guia.", "enabled": true }
  ]
}
```

No destino `ticket`, `category_id` (uma categoria de `ticket_categories`) e `content` (a pergunta, até 3500 caracteres) são opcionais. Os destinos existentes `human`, `bot`, `app` e `submenu` permanecem compatíveis. A migração aditiva `0012_service_destinations.sql` acrescenta o setor e o estado de apresentação dos menus às conversas. Nenhum protocolo anterior é apagado ou renumerado.

Para editar menus pela API, consulte `GET /api/v1/profiles/{profile}/menus` sem filtro. A resposta contém a lista completa em `data` e sua `revision`. Envie `{"menus":[...],"menus_revision":"REVISAO_RECEBIDA"}` para substituir a lista. Se outra alteração tiver sido salva, a API retorna `409 menus_changed` e mantém a configuração atual. Recarregue, revise a árvore e envie uma nova intenção. A revisão é opcional para compatibilidade com clientes antigos; sem ela, a substituição da lista não detecta alterações concorrentes. Não use uma lista filtrada por telefone para substituir a configuração inteira.

`parent_id` guarda o ID de outro item do tipo `submenu`, ou `null` para o menu principal. Todos os itens continuam na mesma lista; ciclos, pais ausentes e pais de outro tipo são recusados. Não é necessário informar IDs manualmente no painel.

A posição na lista `menus` define a ordem entre itens do mesmo pai. Para reordenar pela API, envie a lista completa na nova ordem e a revisão atual, preservando IDs e `parent_id`; para mudar de nível, altere também o pai. A alteração vale para novas apresentações do menu. Números e botões de uma apresentação ainda válida mantêm os IDs originalmente apresentados; uma opção movida para outro pai deixa de ser selecionável no menu antigo.
