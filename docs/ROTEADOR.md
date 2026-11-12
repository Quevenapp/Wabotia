# Roteador de telefones WhatsApp

O roteador permite importar telefones WhatsApp conectados à mesma integração Zernio, receber pelo mesmo webhook e escolher o remetente pela API: um telefone específico ou um grupo autorizado. O Wabotia não impõe um limite fixo de linhas. QR e transporte Hermes continuam separados.

## Mensagens entregues e janela de atendimento

O Wabotia não configura limites locais de mensagens. O painel acompanha mensagens entregues no mês, separadas por categoria. Consulte a [cobrança de WhatsApp pela Zernio](https://docs.zernio.com/platforms/whatsapp/pricing) para as condições do provedor; os totais não estimam preços.

- **Atendimento:** cada nova mensagem recebida do cliente renova a janela até 24 horas após o horário dessa mensagem, no mesmo telefone. O painel mostra a última mensagem do cliente e o vencimento. Recibos, respostas da equipe e templates enviados não renovam a janela. Eventos antigos não fazem o relógio voltar; horários inválidos não abrem uma janela artificial.
- **Remetente fixo:** depois da primeira escolha, o atendimento permanece no telefone original. Pausa, falha ou perda de permissão não provocam envio por outro remetente.
- **Novos clientes:** divulgue o link público do grupo. Ele alterna os telefones ativos e autorizados desde a primeira entrada; o cliente inicia a conversa. O link sozinho não envia mensagens.
- **Modelos pagos:** cada pedido precisa de `allow_paid: true`, comprovação do consentimento e modelo aprovado. A aplicação, a origem e o grupo precisam autorizar pagos. Uma configuração geral não substitui a autorização por envio.
- **Notificações automáticas de telefones gerenciados:** não são convertidas em modelos pagos. Ao acabar a janela, falham com orientação para pedir nova mensagem ou usar o envio explícito de modelo.

Os antigos campos de limite, uso inicial e `policy.service_overage` deixam de afetar os envios. O histórico é preservado. A rota antiga de alteração de limite retorna `410 number_limit_removed`.

O campo legado `free_only: true` passa a significar somente que o pedido não pode usar template; não garante gratuidade nem exige saldo local. Aplicações pareadas como **Vinki** mantêm essa restrição a templates, inclusive nos envios diretos. Permissões, consentimento, autorização individual para templates e a janela real continuam sendo conferidos antes do envio.

## 1. Prepare a integração Zernio

Siga o [guia WhatsApp pela Zernio](ZERNIO-WHATSAPP.md). Em **Integração Zernio**, cadastre nome, API key, fuso e segredo de assinatura do webhook. Depois de salvar, use **Encontrar ID na Zernio** e confirme a integração pelo nome. Em **Telefones**, busque e importe somente os telefones já cadastrados na Zernio. Campos de credencial vazios na edição mantêm os valores atuais; o cadastro do telefone no provedor é gerenciado no painel Zernio.

## 2. Configure o webhook na Zernio

Copie a URL exibida, terminada em /webhooks/zernio-accounts/ID_DA_CONTA. Cadastre-a nos webhooks da Zernio, com o mesmo segredo de assinatura, e habilite os eventos de recebimento, envio, entrega, leitura e falha. A assinatura é verificada pelo Wabotia.

## 3. Adicione os telefones

1. Clique **Buscar telefones na Zernio**. A busca apenas consulta a integração.
2. Escolha um telefone encontrado e dê um nome fácil de reconhecer.
3. Clique **Adicionar telefone ao Wabotia**. Não é necessário informar uso anterior ou limite de mensagens.
4. Os telefones entram pausados. Confira o webhook e clique **Ativar** na lista de uso. A área de atendimento também precisa estar pronta para o atendimento normal.

Para telefones de uma integração Meta anterior, resolva operações em andamento ou sem confirmação e exclua a linha antiga antes de importar pela Zernio. O histórico anterior é preservado separado da nova conexão.

**Como ler o painel:** conta cada mensagem com confirmação `delivered` ou `read`, uma vez por ID do provedor. Não conta fila, aceitação `sent`, envios sem confirmação, falhas sem entrega ou uso inicial manual. Um anexo é uma mensagem; texto enviado separadamente é outra. Envios humanos, bots e API compartilham os totais do telefone.

As categorias são **Atendimento na janela de 24 horas** (sem template), **Atendimento por template** (UTILITY) e **Marketing por template**. Autenticação e mensagens cuja categoria não pôde ser identificada aparecem separadamente quando houver uso. A categoria do template é a aprovada na Zernio: um template UTILITY sem cobrança continua na categoria de template.

O mês usa o fuso da integração e a primeira confirmação conhecida de entrega/leitura, desde a data de início do acompanhamento. Recibos atrasados podem corrigir o mês; recibos repetidos não somam novamente. Envios feitos fora do Wabotia só aparecem se seus recibos chegarem ao webhook. O painel informa o início do acompanhamento e não recupera automaticamente meses anteriores na Zernio.

Em cada telefone, abra **Templates da Zernio** para consultar nome, texto, idioma, categoria e status dos templates já cadastrados. A busca não cria nem envia mensagens. A aprovação e a gestão dos templates continuam na Zernio. Somente templates aprovados podem ser enviados, respeitando as permissões e o consentimento.

## 3.1. Defina o que cada telefone pode fazer

Na etapa **Telefones**, cada cartão em **Seus telefones e consumo** tem **Função e permissões**:

1. Abra **Função e permissões** no telefone desejado.
2. Escolha **Atendimento oficial** para seu telefone de contato permanente, ou **Integração com janela de 24 horas (Vinki)** para uma linha utilizada por sistemas externos.
3. Confira as opções individuais. Alterá-las muda a função para **Personalizado**.
4. Clique **Salvar função e permissões** e aguarde a confirmação. Salvar não ativa o canal nem a automação da área de atendimento.

| Opção | Atendimento oficial | Integração de 24 horas |
|---|---|---|
| Respostas sem template dentro de 24 horas | Sim | Sim |
| Templates aprovados, autorizados por envio | Sim | Bloqueados |
| Atendimento manual no painel/Telegram | Sim | Bloqueado por padrão |
| Envios de aplicações já autorizadas | Sim | Sim |
| Menu e saudação automática | Sim | Desligados |
| Bots Hermes autorizados na área de atendimento | Sim | Desligados |
| Participar dos grupos em que estiver cadastrado | Não por padrão | Sim |

As opções podem ser combinadas. Por exemplo, para uma linha que só envia templates, desmarque **Respostas dentro de 24 horas** e mantenha **Templates aprovados**, além da origem humana/API correspondente. Para permitir atendimento manual na linha de integração, marque essa opção. Receber mensagens e consultar o histórico continuam disponíveis, inclusive quando nenhuma resposta está permitida.

![Função e permissões de uma linha de integração; dados fictícios](screenshots/43-router-funcoes.jpg)

Menu e bots utilizam a configuração da área de atendimento e só respondem quando a automação dessa área de atendimento está ativa. Desligar ambos impede saudações, menus, respostas de bots e avisos automáticos ao cliente. Solicitações de revogação de consentimento continuam registradas. Os programas recebem os eventos normalmente e só enviam dentro das permissões concedidas. Notas internas e acompanhamento continuam disponíveis.

Uma permissão de grupo ou de aplicação nunca libera o que o telefone bloqueou. A verificação ocorre antes de entrar na fila e novamente antes do envio. Desligar uma opção bloqueia entregas ainda pendentes; não apaga mensagens já enviadas nem transfere conversas. Contadores e consentimentos são preservados. Ao atualizar, telefones existentes mantêm suas opções anteriores até o administrador escolher e salvar uma função.

**Contadores:** os totais representam mensagens entregues, não clientes ou atendimentos. Confirmação, chamada da senha e lembrete entregues somam três mensagens, mesmo na mesma janela.

**Exemplos além do Vinki:** retirada de pedidos em restaurantes/lojas, check-in e chamada de recepção, estacionamento/valet e solicitações de documentos no ERP. O cliente abre o link e envia a mensagem; as respostas retornam pelo mesmo telefone durante a janela. Para documentos e dados pessoais, valide a identidade e as permissões no sistema de origem antes de entregar. Lembretes para dias seguintes precisam de template autorizado ou de nova mensagem do cliente.

## 4. Crie um grupo

Antes de criar o grupo, configure a função de cada telefone conforme o passo abaixo.

Em **Distribuição → Criar grupo de roteamento**, informe um nome e selecione membros da mesma integração. O grupo usa **rodízio** entre telefones disponíveis e autorizados, sem considerar limites locais. Grupos antigos configurados como menor consumo ou aleatório também seguem essa regra.

Entradas simultâneas são serializadas por área de atendimento. Respostas de conversas já vinculadas mantêm seu telefone e não avançam a vez de novos atendimentos. Por exemplo: com três linhas disponíveis, as seis próximas entradas serão A, B, C, A, B, C; a conversa de A continua vinculada a A.

Ative o grupo. Marque **Criar link público** para divulgar uma entrada única. Se desejar modelos pagos, marque a opção específica; ela só habilita pedidos individualmente autorizados. Salve e copie o ID para integrações. Um telefone pode estar em vários grupos; seu consumo continua único.

## 5. Autorize cada programa externo

Crie a aplicação e sua chave em **API e integrações**, concedendo acesso à área de atendimento. Depois, em **Integração Zernio → Acesso dos sistemas**, selecione a aplicação e marque seus telefones diretos ou grupos. A seleção de um grupo autoriza os membros atuais e futuros desse grupo. Para usar `number_id` diretamente, dê a permissão individual.

Salvar adiciona `routing:read`, `routing:send`, `conversations:read` e `conversations:write`. A opção de modelos pagos adiciona `routing:paid` e habilita pagos nas origens selecionadas. Remover essa opção revoga a autorização paga dessas origens; o escopo pode continuar necessário para outras origens autorizadas. Para anexos, conceda também `media:read/write`. Para acompanhar eventos, use `events:read`/`webhooks:manage` conforme o uso.

Aplicações não recebem chaves Zernio nem segredos. O autor é definido pela chave Bearer. As permissões são conferidas na fila e novamente antes de enviar; revogar a origem cancela uma entrega ainda pendente.

## 6. Envie pela API

Base: `/api/v1/profiles/{area_id}`, substituindo `{area_id}` pelo ID da área de atendimento. O caminho técnico da API permanece o mesmo. Todas as escritas exigem `Idempotency-Key`. Guarde a chave da intenção e reutilize-a com conteúdo idêntico após falha de rede. Não gere uma nova automaticamente.

| Método e caminho | Resultado |
|---|---|
| `GET /router` | Telefones, grupos autorizados e mensagens entregues no mês por categoria |
| `GET /router/numbers/{id}/templates` | Templates da Zernio; filtros `name`, `category`, `language` e `status` |
| `POST /router/messages` | `202`, `delivery_id`, conversa e remetente escolhido |
| `GET /router/messages/{delivery_id}` | Fila, aceitação e recibo do provedor quando disponível |
| `POST /router/messages/{delivery_id}/cancel` | Cancela somente `pending`, pelo autor ou administrador |

Escolha **um** `number_id` ou `pool_id` retornado pela API, nunca ambos. `external_id` é um identificador estável do cliente/atendimento no integrador, separado por aplicação. Reutilize-o para esse destinatário e origem, inclusive ao abrir novos protocolos; não troque esse ID para tentar outro remetente. `conversation_id` é opcional para vincular uma conversa autorizada. `to` é obrigatório no primeiro pedido; use DDI/DDD e só dígitos.

Para avisos com prazo, informe `expires_at` como inteiro em milissegundos Unix: deve estar no futuro e no máximo 24 horas adiante. O prazo fica salvo com a mensagem e o envio é cancelado se vencer antes da entrega ao canal. A resposta e a consulta do envio mostram `free_only` efetivo e `expires_at` (ou `null`); o payload interno não é exposto.

Exemplo de atendimento, salve em `mensagem.json`:

```json
{"pool_id":"ID_GRUPO","to":"5511999991111","external_id":"cliente-123","text":"Olá! Como podemos ajudar?"}
```

O cliente precisa ter falado com esse telefone nas últimas 24 horas. A resposta informa `billing.mode: service`, sem estimativa de cobrança; `usage` contém os totais de entregas confirmadas. Os campos antigos de saldo, limite e reserva foram removidos. Para escolher um telefone, substitua `pool_id` por `number_id`. O envio assume a conversa na identidade da aplicação; outro responsável precisa transferir/liberar antes.

```sh
curl --fail-with-body "$WABOTIA_URL/api/v1/profiles/$WABOTIA_PROFILE/router/messages" \
  -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $WABOTIA_REQUEST_ID" --data-binary @mensagem.json
```

Modelo pago, use um modelo **realmente aprovado** e consentimento da mesma categoria:

```json
{
  "pool_id": "ID_GRUPO", "to": "5511999992222", "external_id": "cliente-456",
  "allow_paid": true,
  "consent": {"granted": true, "category": "utility", "reference": "Aceite no pedido 456"},
  "template": {"name": "pedido_atualizado", "language": "pt_BR", "components": [
    {"type": "body", "parameters": [{"type": "text", "text": "456"}]}
  ]}
}
```

Suporta texto posicional/nomeado, cabeçalho de imagem/vídeo/documento com `media_id` privado e botões URL/OTP, resposta rápida e copiar código. Não use URLs públicas para anexos privados. Exemplo de cabeçalho: `{"type":"header","parameters":[{"type":"image","media_id":"ID_ARQUIVO_WABOTIA"}]}`. Carrosséis e outros componentes não implementados são recusados. A Meta faz a validação final e pode rejeitar um modelo alterado/suspenso depois da consulta.

JavaScript e Python executáveis, alternativas ao cURL:

```sh
node examples/router-message.mjs mensagem.json
python3 examples/router-message.py mensagem.json
# Para um pedido de modelo pago: JSON com allow_paid:true E confirmação no comando.
node examples/router-message.mjs modelo-pago.json --allow-paid
```

Configure `WABOTIA_URL`, `WABOTIA_KEY`, `WABOTIA_PROFILE` e `WABOTIA_REQUEST_ID` no servidor do seu sistema. **Esses exemplos enviam de verdade quando apontados para sua instalação.** Escolha uma alternativa; não execute todas para o mesmo pedido. Os testes do repositório usam servidor fictício local.

`pending` significa na fila; `sent` significa aceito pelo canal, não prova de recebimento. `provider_status: delivered/read` confirma o recibo. `billable: null` significa que a Meta ainda não informou a cobrança. Estado `unknown` não autoriza tentativa automática. Conferir uma nova tentativa de modelo em Entregas exige nova autorização explícita de cobrança.

Erros relevantes: `source_not_allowed` (origem), `paid_disabled` (grupo), `consent_revoked` (aceite retirado), `sender_pinned` (tentativa de trocar origem), `sender_unavailable` (remetente vinculado indisponível) e `no_eligible_sender` (sem telefone com janela/condições). Atendimento nunca faz fallback para modelo pago. Uma conversa criada por modelo pago não abre 24 horas até o cliente responder de verdade.

Acompanhe `message.sent`, `message.updated` e `conversation.updated` nos eventos/webhooks já existentes, correlacionando conversa e `source_key` quando disponível. Para entrega individual, use o GET acima. OpenAPI 3.1 e documentação interativa: `/api/openapi.json` e `/api-docs`.

## 7. Homologue antes de atender clientes

Use telefones/destinatários autorizados. Confira recebimento, envio individual, rodízio, remetente fixo, janela vencida e recusa de template sem autorização. Verifique renovação da janela por nova mensagem do cliente e ausência de renovação por respostas ou templates. Repita a mesma chave para conferir ausência de duplicação. Confira contagem por categoria somente após recibos de entrega/leitura. Pause um telefone e confira que sai do rodízio. Testes simulados aprovados não substituem esta homologação real.
