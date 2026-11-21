# Documentos do ERP por e-mail

Proposta, pedido de venda, pedido de compra, NF-e autorizada (DANFE e XML), NFC-e e conta a receber (boleto, Pix ou
link) pelo e-mail da instalação (`src/email.ts`, o mesmo do pacote do contador). Sem e-mail configurado, a tela diz
onde configurar: Gestão → Sistema → E-mail.

## Quem pode

- Pessoa da área com o documento visível no ERP (o documento é lido como ela, pelas rotas do painel) e a parte do
  ERP do documento ligada (proposta e pedido: Vendas; compra: Compras; nota: Fiscal; NFC-e: Fiscal e Caixa / PDV;
  conta: Financeiro). Desligada: `409 module_disabled` dizendo qual ligar; o botão some.
- Bot: só as operações concedidas (assunto "Enviar documentos por e-mail"). Enviar e reenviar são sensíveis (o bot
  propõe, a pessoa confirma) e só vão a e-mail do cadastro.

## Rotas (`/api/v1/profiles/{área}/erp-email`)

| Rota | Operação | O quê |
|---|---|---|
| `GET /` | `erp.email.situacao` | E-mail da instalação configurado e onde configurar. |
| `GET /{tipo}/{id}[?pagamento]` | `erp.email.preparar` | Destinatário sugerido, cópias, modelo, prévia, anexos e envios. |
| `GET /{tipo}/{id}/envios` | `erp.email.envios` | Registro dos envios do documento. |
| `POST /{tipo}/{id}/enviar` `{para, copias?, assunto?, mensagem?, xml?, pagamento?}` | `erp.email.enviar` | Envia (Idempotency-Key). |
| `POST /{tipo}/{id}/envios/{envio}/reenviar` | `erp.email.reenviar` | Repete um envio (mesmos destinatários e texto; anexos lidos de novo). |

Tipos: `proposta`, `pedido`, `compra`, `nota`, `nfce`, `conta`.

## Modelos

Assunto, texto, cópias, nome do remetente e responder-para vêm das Preferências de cada documento (blocos de e-mail de
Propostas, Vendas, Compras, NF-e e "E-mails de cobranças" do Contas a receber); vazio, valem os padrões de
`templates.ts`. Variáveis: `{cliente}`, `{numero}`, `{valor}`, `{vencimento}`, `{link}` e `{empresa}` (o link não vai
no assunto). Destinatário: nas notas, o "E-mail para envio da NFe" do cadastro (ou o principal); na cobrança, o que a
preferência "E-mail do contato" manda; nos demais, o principal.

## Registro e envio automático

Cada envio fica em `erp_email_sends` (migração 0285) com quando, para quem, cópias, assunto, anexos e situação
(enviado, na fila, devolvido ou falhou e por quê); o provedor registra também em `email_log`. A NF-e autorizada pelo
ERP vai sozinha ao destinatário com a preferência "Enviar e-Mail após emitir NF-e automaticamente" ligada (nasce
desligada), uma vez por nota (`src/erp/commercial-nfe/routes.ts` chama `autoSendInvoiceEmail`); o que não sai fica
no registro da nota.

## A conferir com a conta real

Os campos `cc`, `reply_to` e `attachments` (base64, `filename`, `type`, `disposition`) do pedido à API de envio da
Cloudflare seguem o formato documentado do envio, ainda não conferido numa conta real (como o resto de `docs/EMAIL.md`).
