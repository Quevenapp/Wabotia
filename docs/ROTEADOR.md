# Roteador de números WhatsApp

A versão 0.6.0 permite cadastrar até **20 números por conta empresarial do WhatsApp (WABA)**, receber todos pelo mesmo webhook e escolher o remetente pela API: um número específico ou um grupo autorizado. É para **Meta direto no Worker**. QR e transporte Hermes continuam separados. Hermes não precisa de alteração para este recurso.

## Franquia, janela e cobrança

O [FAQ oficial da Meta](https://whatsappbusiness.com/resources/faq/), consultado em 06/11/2026, informa uma franquia de 1.000 mensagens de atendimento por número empresarial/mês desde 01/10/2026. Modelos de marketing, utilidade e autenticação têm suas próprias regras de cobrança. Consulte a Meta para as condições e tarifas da sua conta.

- **Atendimento:** o cliente precisa ter enviado mensagem para aquele mesmo número nas últimas 24 horas. Ter saldo em outro número não transfere essa janela.
- **Remetente fixo:** depois da primeira escolha, o atendimento permanece no número original. Pausa, fim de cota ou falha não provocam envio por outro número.
- **Novos clientes:** divulgue o link público do grupo. Ele abre o WhatsApp num número ativo com saldo; o cliente inicia a conversa. O link sozinho não envia nada nem reserva uma mensagem.
- **Modelos pagos:** cada pedido precisa de `allow_paid: true`, comprovação do consentimento e modelo aprovado. A aplicação, a origem e o grupo precisam autorizar pagos. Uma configuração geral não substitui a autorização por envio.
- **Notificações automáticas de números gerenciados:** não são convertidas em modelos pagos. Ao acabar a janela, falham com orientação para pedir nova mensagem ou usar o envio explícito de modelo.

O teto local pode ser de 0 a 1.000. O Wabotia não oferece autorização automática para cobrar a 1.001ª mensagem de atendimento. Um modelo pago autorizado continua possível mesmo com a cota de atendimento esgotada.

## 1. Prepare a conta Meta

Primeiro número ou dúvida sobre tokens? Siga o [guia do chip à API](META-WHATSAPP.md), com requisitos da empresa, cadastro do telefone, conta de mensagens, aplicativo, token de produção, App Secret e webhook. Há uma [versão ilustrada no site](https://wabotia.queven.app/install#meta-whatsapp).

No aplicativo Meta, confira os números cadastrados na WABA, sua habilitação na Cloud API e a qualidade dos números. O Wabotia não cria números, registra SIM nem amplia o limite concedido pela Meta.

Tenha: **WABA ID**, token Meta com acesso aos números (`whatsapp_business_management` para descoberta/modelos e `whatsapp_business_messaging` para enviar), **App Secret** do aplicativo e um **Verify Token** escolhido por você. Os nomes e acessos disponíveis dependem do aplicativo e da sua conta Meta. Não use uma chave Wabotia no lugar do token Meta.

No painel, escolha o perfil e abra **Roteador de números → Cadastrar ou editar a conta Meta**. Preencha nome, WABA ID, fuso igual ao da conta Meta e os três campos protegidos. Clique **Salvar conta Meta**. O WABA ID não pode ser trocado depois; o fuso deve estar correto antes de adicionar números. Para atualizar credenciais, use **Editar**; campo vazio mantém o valor anterior.

## 2. Configure um webhook compartilhado

Copie a URL exibida: `https://SUA-INSTALACAO/webhooks/meta-accounts/ID_DA_CONTA`.

No aplicativo Meta, abra **WhatsApp → Configuração → Webhook** (o nome pode variar). Cole a URL e o mesmo Verify Token. Verifique e salve; assine o campo **messages**. A WABA deve estar inscrita nesse aplicativo (`/{WABA_ID}/subscribed_apps` na Graph API, conforme o fluxo Meta). Se usa chamadas ou grupos, mantenha também os eventos exigidos por esses recursos. O App Secret valida a assinatura de cada entrega.

Não repita uma URL por telefone: o Wabotia separa as entradas pelo Phone Number ID e confere o WABA ID. Números desconhecidos são ignorados. Mantenha apenas um consumidor ativo por número, evitando que um Hermes/QR antigo responda ao mesmo atendimento.

## 3. Adicione os números e o consumo inicial

1. Clique **Buscar números na Meta**. A busca apenas consulta a conta.
2. Escolha um número encontrado e dê um nome fácil de reconhecer.
3. Confira na Meta quantas mensagens de atendimento esse número já usou no mês. Informe em **Mensagens de atendimento já usadas neste mês**. Zero somente se realmente não houve uso.
4. Defina o **Teto local**, no máximo 1.000. Confirme o uso inicial e o fuso, depois clique **Adicionar ao roteador**. Repita para até 20 números.
5. Os números entram pausados. Confira o webhook e clique **Ativar** na lista de uso. O perfil também precisa estar pronto para o atendimento normal.

Se o telefone já está em Conexões, pause-o e reconcilie filas desconhecidas antes de adotá-lo no roteador. Aguarde os comprovantes de entregas anteriores aceitas pela Meta; não basta o estado `sent`. O histórico e a identidade da conexão são preservados. O contador inicial não deve ser reiniciado para obter saldo artificial.

**Como ler o painel:** uso protegido = histórico inicial do mês + entregas de atendimento + reservas de envios ainda não confirmados. Um anexo é uma mensagem; texto separado é outra. Envios humanos, bots e API no número gerenciado compartilham o mesmo contador. Falha definitiva e cancelamento antes do envio liberam a reserva. `unknown` mantém a reserva e exige conferência. Na mudança de mês, o histórico inicial deixa de contar; mensagens ainda sem confirmação continuam reservadas.

Recibos Meta registram mensagens gratuitas, cobradas e sem informação de cobrança. Recibos repetidos não somam novamente. O horário da entrega, no fuso da conta, define o mês confirmado. Envios feitos fora do Wabotia só são observados se seus recibos chegarem a esse webhook; podem consumir saldo antes de o Wabotia saber. **O contador é uma proteção local e não garante uma fatura sem cobrança.** Confira o WhatsApp Manager, sobretudo após interrupções ou se outro sistema usar o número. O painel não estima preço em reais.

## 4. Crie um grupo

Em **Grupos de números → Criar grupo de roteamento**, informe um nome, selecione membros da mesma conta e escolha:

| Estratégia | Escolha para um novo atendimento |
|---|---|
| Menor consumo | Menor uso protegido; alterna os empates |
| Em sequência | Próximo número disponível |
| Aleatório | Sorteio entre números disponíveis |

Ative o grupo. Marque **Criar link público** para divulgar uma entrada única. Se desejar modelos pagos, marque a opção específica; ela só habilita pedidos individualmente autorizados. Salve e copie o ID para integrações. Um número pode estar em vários grupos; seu consumo continua único.

## 5. Autorize cada programa externo

Crie a aplicação e sua chave em **API e integrações**, concedendo acesso ao perfil. Depois, em **Roteador de números → Autorizar programas externos**, selecione a aplicação e marque seus números diretos ou grupos. A seleção de um grupo autoriza os membros atuais e futuros desse grupo. Para usar `number_id` diretamente, dê a permissão individual.

Salvar adiciona `routing:read`, `routing:send`, `conversations:read` e `conversations:write`. A opção de modelos pagos adiciona `routing:paid` e habilita pagos nas origens selecionadas. Remover essa opção revoga a autorização paga dessas origens; o escopo pode continuar necessário em outro perfil. Para anexos, conceda também `media:read/write`. Para acompanhar eventos, use `events:read`/`webhooks:manage` conforme o uso.

Aplicações não recebem tokens Meta nem segredos. O autor é definido pela chave Bearer. As permissões são conferidas na fila e novamente antes de enviar; revogar a origem cancela uma entrega ainda pendente.

## 6. Envie pela API

Base: `/api/v1/profiles/{perfil}`. Todas as escritas exigem `Idempotency-Key`. Guarde a chave da intenção e reutilize-a com conteúdo idêntico após falha de rede. Não gere uma nova automaticamente.

| Método e caminho | Resultado |
|---|---|
| `GET /router` | Números, grupos autorizados, saldo e reservas |
| `POST /router/messages` | `202`, `delivery_id`, conversa e remetente escolhido |
| `GET /router/messages/{delivery_id}` | Fila, aceitação e recibo Meta quando disponível |
| `POST /router/messages/{delivery_id}/cancel` | Cancela somente `pending`, pelo autor ou administrador |

Escolha **um** `number_id` ou `pool_id` retornado pela API, nunca ambos. `external_id` é um identificador estável do cliente/atendimento no integrador, separado por aplicação. Reutilize-o para esse destinatário e origem, inclusive ao abrir novos protocolos; não troque esse ID para tentar outro remetente. `conversation_id` é opcional para vincular uma conversa autorizada. `to` é obrigatório no primeiro pedido; use DDI/DDD e só dígitos.

Exemplo de atendimento, salve em `mensagem.json`:

```json
{"pool_id":"ID_GRUPO","to":"5511999991111","external_id":"cliente-123","text":"Olá! Como podemos ajudar?"}
```

O cliente precisa ter falado com esse número. Para escolher um número, substitua `pool_id` por `number_id`. O envio assume a conversa na identidade da aplicação; outro responsável precisa transferir/liberar antes.

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

Erros relevantes: `source_not_allowed` (origem), `paid_disabled` (grupo), `consent_revoked` (aceite retirado), `number_quota_exhausted` (teto), `sender_pinned` (tentativa de trocar origem), `sender_unavailable` (remetente vinculado indisponível) e `no_eligible_sender` (sem número com janela/condições). Atendimento nunca faz fallback para modelo pago. Uma conversa criada por modelo pago não abre 24 horas até o cliente responder de verdade.

Acompanhe `message.sent`, `message.updated` e `conversation.updated` nos eventos/webhooks já existentes, correlacionando conversa e `source_key` quando disponível. Para entrega individual, use o GET acima. OpenAPI 3.1 e documentação interativa: `/api/openapi.json` e `/api-docs`.

## 7. Homologue antes de atender clientes

Use números/destinatários autorizados. Confira recebimento em cada telefone; envio individual; escolha de grupo; remetente fixo; janela vencida; negativa de pago sem autorização; um modelo autorizado; status e contagem Meta. Repita a mesma chave para verificar ausência de duplicação. Pause um número, simule teto menor e confirme que novos atendimentos vão para outro disponível. Não aumente artificialmente a franquia. Compare o contador com a Meta no fuso correto. Testes simulados aprovados não substituem esta homologação real.
