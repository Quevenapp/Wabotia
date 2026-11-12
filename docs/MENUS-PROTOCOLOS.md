# Menus, setores e consulta de protocolos

Em **Automação → Menus e ações**, cada opção pode abrir um submenu, enviar uma mensagem informativa ou um link, chamar um bot específico, encaminhar para uma fila humana, consultar protocolos ou pedir uma avaliação.

Na Meta, até três opções com títulos de até 20 caracteres usam botões de resposta. Até dez opções usam uma lista, inclusive quando os títulos precisam de mais espaço. Outros canais e menus maiores usam texto numerado. A apresentação segue os formatos de [mensagens interativas documentados pela Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/interactive/). Cada número mantém suas permissões e a janela de atendimento; um menu não autoriza enviar fora dela.

As respostas dos botões identificam uma opção da apresentação enviada, da conversa e da sessão. A apresentação expira após 24 horas. Botões antigos, de outra conversa ou de uma opção removida/desabilitada não executam ações: o cliente recebe a orientação para enviar **MENU**. Reordenar opções no painel não muda o significado de um botão já enviado. Nos menus de texto, os números seguem a ordem da apresentação enviada enquanto ela estiver ativa.

## Cadastrar a hierarquia

1. Crie um submenu, por exemplo **Suporte Técnico**. Ele organiza as opções e pode ser salvo antes dos filhos.
2. No submenu, clique **Adicionar opção dentro**. Dê um nome à opção e escolha o destino: equipe, bot, mensagem, link ou outro submenu.
3. Para criar mais níveis, adicione outro submenu dentro do primeiro e cadastre suas opções da mesma forma. A árvore mostra o caminho completo; salvar e reabrir mantém os vínculos.
4. Para mover um item, edite o menu pai. O seletor exclui o próprio item e seus descendentes. Um submenu com filhos precisa continuar sendo submenu até que os filhos sejam movidos ou removidos.

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

A lista mostra até dez protocolos recentes. Um número completo consulta também protocolos mais antigos. A resposta apresenta estado, solicitação, prazo da primeira resposta e último andamento público. Notas internas e IDs de responsáveis não são enviados.

A identificação usa o telefone recebido de um canal autenticado, dentro do mesmo perfil, e reúne os protocolos desse telefone em outras linhas. Uma aplicação que informa um telefone pela API não recebe acesso aos protocolos de conversas reais desse número. Conversas sem uma identidade de canal verificável consultam apenas seus próprios protocolos. A consulta de um número de outra pessoa e a consulta de um número inexistente produzem a mesma resposta. Consultas individuais não são feitas em grupos.

O bot usa a ação estruturada `protocols`, com `protocol_number` opcional, e recebe a mesma verificação de titularidade. A equipe pode usar o botão da conversa ou a API:

```json
{ "action": "protocols", "number": "WA-ABC123-1A2B" }
```

Envie para `POST /api/v1/profiles/{profile}/conversations/{id}/actions`, com a autenticação e `Idempotency-Key` normais. Omitir `number` solicita a lista recente. O endpoint envia a consulta ao cliente e devolve os registros públicos consultados.

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
    { "id": "nota", "label": "Avaliar", "type": "survey", "enabled": true },
    { "id": "ajuda", "label": "Ajuda", "type": "link", "url": "https://example.com/ajuda", "content": "Veja nosso guia.", "enabled": true }
  ]
}
```

Os destinos existentes `human`, `bot`, `app` e `submenu` permanecem compatíveis. A migração aditiva `0012_service_destinations.sql` acrescenta o setor e o estado de apresentação dos menus às conversas. Nenhum protocolo anterior é apagado ou renumerado.

Para editar menus pela API, consulte `GET /api/v1/profiles/{profile}/menus` sem filtro. A resposta contém a lista completa em `data` e sua `revision`. Envie `{"menus":[...],"menus_revision":"REVISAO_RECEBIDA"}` para substituir a lista. Se outra alteração tiver sido salva, a API retorna `409 menus_changed` e mantém a configuração atual. Recarregue, revise a árvore e envie uma nova intenção. A revisão é opcional para compatibilidade com clientes antigos; sem ela, a substituição da lista não detecta alterações concorrentes. Não use uma lista filtrada por telefone para substituir a configuração inteira.

`parent_id` guarda o ID de outro item do tipo `submenu`, ou `null` para o menu principal. Todos os itens continuam na mesma lista; ciclos, pais ausentes e pais de outro tipo são recusados. Não é necessário informar IDs manualmente no painel.
