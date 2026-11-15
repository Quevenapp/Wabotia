# Cobrança (Pix e link de pagamento)

A equipe e os módulos cobram o cliente pela própria conversa do WhatsApp. O
cliente recebe um botão de pagamento (linha oficial) ou o link no texto
(linha QR) e, no Pix, também o código **copia e cola** numa mensagem
separada. A confirmação vem **só do provedor**: o webhook assinado chega, o
Wabotia consulta o pagamento na API e só então marca como pago. Uma mensagem
do cliente ("já paguei", comprovante) nunca muda o estado.

Primeiro provedor: **Mercado Pago**. O código fica atrás de uma interface
(`src/payments-provider.ts`); o Asaas entra depois sem mudar as verticais.

## Configurar o Mercado Pago

Feito uma vez por área de atendimento, por um administrador.

1. Entre em [Suas integrações](https://www.mercadopago.com.br/developers/panel/app)
   no Mercado Pago com a conta que vai receber e crie uma aplicação (ou use
   uma existente).
2. Na aplicação, abra **Credenciais de produção** e copie o **Access Token**
   (começa com `APP_USR-`).
3. No Wabotia, abra **Gestão → Automação → Cobrança**, cole o Access Token,
   informe o **e-mail do pagador** (o Pix do Mercado Pago exige um e-mail;
   vale o do contato quando ele tem) e salve. O Wabotia mostra o **endereço
   do webhook** desta área.
4. No Mercado Pago, abra **Webhooks → Configurar notificações**, escolha o
   **modo produtivo**, cole o endereço do webhook e marque o evento
   **Pagamentos**. Salve.
5. O Mercado Pago gera a **assinatura secreta** do webhook. Copie e cole no
   campo **Assinatura secreta do webhook** do Wabotia e salve de novo.
6. Use **Testar credenciais**: o Wabotia consulta a conta e mostra o nome
   dela. Sem a assinatura secreta, nenhum pagamento é confirmado.

O Access Token e a assinatura ficam cifrados com a `MASTER_KEY`, como as
chaves da Zernio e dos provedores de IA, e nunca voltam nas leituras: a tela
mostra só "guardado". Para trocar, cole o novo valor e salve.

## Cobrar

- **Pela conversa:** em **Dados da conversa → Cobranças → Cobrar**, escolha
  Pix ou link, valor e descrição. É preciso ter assumido a conversa (ou ser
  administrador). Na linha oficial, o cliente precisa ter escrito nas
  últimas 24 horas.
- **Pela API:** `POST /api/v1/profiles/{area}/conversations/{id}/actions` com
  `{"action":"charge","method":"pix","amount_cents":4990,"description":"Consulta"}`.
- **Pelos módulos:** `ctx.charge(c, {...})` (veja `docs/MODULOS.md`). O
  módulo confere antes com `ctx.paymentsReady()`, cancela uma cobrança dele
  com `ctx.cancelCharge(id)` e, com `receipt: false`, manda o próprio
  comprovante em vez do "Pagamento recebido" do núcleo.

O código Pix copia e cola chega numa mensagem só dele, separada do botão,
para o cliente copiar sem sair do WhatsApp. Com a janela de 24 horas fechada
na linha oficial (cobrança de módulo com `notification: true`), tudo vai numa
mensagem só pelo modelo de notificação: link e, no Pix, o código.

| Forma | O cliente recebe | No Mercado Pago |
|---|---|---|
| Pix | Botão "Ver QR Code Pix" (página do Mercado Pago com QR) e o código copia e cola | Pagamento Pix (`POST /v1/payments`) |
| Link | Botão "Pagar agora" para o checkout (cartão, Pix e outros meios) | Preferência do Checkout Pro (`POST /checkout/preferences`) |

Validade: de 30 minutos a 30 dias, padrão 24 horas. Vencida, a cobrança
expira no Wabotia e é cancelada no provedor.

## Estados

| Estado | Quando |
|---|---|
| `created` | Criada no provedor e enviada ao cliente |
| `paid` | Pagamento aprovado (`approved`) confirmado na API |
| `expired` | Passou da validade sem pagamento |
| `cancelled` | Cancelada pela equipe, pelo módulo que a abriu ou pelo provedor |
| `refunded` | Estornada ou contestada (`refunded`, `charged_back`) depois de paga |

Dinheiro confirmado vence: se o pagamento for aprovado depois de expirar ou de
cancelado no Wabotia, a cobrança passa a `paid`. Cada mudança publica
`payment.created`, `payment.paid`, `payment.expired`, `payment.cancelled` ou
`payment.refunded` (com `conversation_id`), registra uma nota interna na
conversa e, ao pagar, envia "Pagamento recebido" ao cliente (pelo modelo de
notificação se a janela de 24 horas estiver fechada).

- **Estorno antes do primeiro aviso** (aprovado e estornado antes de o
  webhook chegar): o "paga" fica registrado no histórico, sem comprovante ao
  cliente; o módulo que abriu a cobrança vê só o estorno.
- **Pagamento em duplicidade** (o link pago duas vezes, com outro id no
  Mercado Pago): a cobrança continua `paid`, o segundo pagamento fica em
  `duplicate_payments`, sai `payment.duplicate` (com
  `duplicate_provider_payment_id` e `needs_refund: true`) e uma nota interna
  pede para estornar o valor a mais. Cada pagamento duplicado avisa uma vez.

## Como a confirmação funciona

1. O Mercado Pago chama `POST /webhooks/payments/mercadopago/{conta}` com
   `?data.id=<pagamento>&type=payment` e os cabeçalhos `x-signature`
   (`ts=…,v1=…`) e `x-request-id`.
2. O Wabotia monta `id:<data.id em minúsculas>;request-id:<x-request-id>;ts:<ts>;`
   e confere o HMAC-SHA256 com a assinatura secreta. Diferente: `401` e nada
   muda. O `ts` assinado precisa estar a até 15 minutos do relógio; o
   `data.id` vale só o da consulta (o do corpo, se vier, tem de ser igual);
   sem `data.id` na consulta, o aviso é ignorado. Cada IP tem um limite de
   avisos por minuto.
3. Consulta `GET /v1/payments/{id}` com o Access Token, encontra a cobrança
   pelo `external_reference` (o id da cobrança no Wabotia) e confere valor e
   moeda.
4. Muda o estado com uma atualização condicionada: webhooks repetidos (o
   Mercado Pago reenvia até receber 200) não repetem evento nem mensagem.

Notificações que não são de pagamento recebem `200` e são ignoradas. Falha ao
consultar o Mercado Pago responde erro, e o Mercado Pago tenta de novo.

## O que só uma conta real confirma

Os testes usam respostas simuladas; nenhuma chamada saiu para o Mercado Pago.
Antes de usar em produção, confira com uma conta real:

- Que o Pix é criado com o e-mail configurado e devolve `qr_code`,
  `qr_code_base64` e `ticket_url`, e que `date_of_expiration` no horário de
  Brasília é aceita.
- Que a preferência do Checkout Pro com `expires`/`expiration_date_to` abre o
  checkout e que o pagamento feito por ela traz o `external_reference`.
- Que o webhook configurado no painel chega com `x-signature` válida para
  pagamentos criados com `notification_url` e que o `data.id` da query é o id
  do pagamento.
- Os estados de um Pix vencido (`cancelled` com `status_detail` `expired`) e
  de um estorno (`refunded`).
- `GET /users/me` em **Testar credenciais**.
- A exibição do botão com URL e do código copia e cola numa linha Zernio real.
