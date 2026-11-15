# Mensalidade

Cobrança recorrente pelo WhatsApp para escola de idiomas, escolinha de
esporte, academia pequena, contador e condomínio. Cada cliente tem uma
**assinatura** de um **plano**; cada período gera uma **parcela**; alguns dias
antes do vencimento o cliente recebe o Pix (ou o link de pagamento) na
conversa, e a parcela fica paga quando o Mercado Pago confirma. API em
[API.md](API.md#mensalidade-módulo-mensalidade); contrato dos módulos em
[MODULOS.md](MODULOS.md).

## Ligar

1. **Gestão → Módulos**: ligue **Mensalidade** (vem desligado).
2. **Gestão → Cobrança**: configure a conta do Mercado Pago
   ([COBRANCA.md](COBRANCA.md)). Sem ela o módulo funciona, mas os avisos
   saem sem Pix (com as instruções que você escrever) e a baixa é manual.
3. **Gestão → Planos e regras**: crie os planos (nome, valor, mensal,
   trimestral ou anual, dia de vencimento), ajuste as regras e adicione
   **Minhas mensalidades** e **Segunda via** ao menu do WhatsApp.
4. **Gestão → Mensalidades → Assinaturas**: crie uma por cliente ou use
   **Importar** colando linhas de uma planilha
   (`nome; telefone; plano; desconto; dia`).

## Como as parcelas nascem

- Uma parcela por período, com o mês de vencimento como competência. O
  gancho periódico do núcleo (a cada 1 a 5 minutos) cria as parcelas que
  vencem nos próximos 31 dias e marca como **vencida** a que passou do dia.
  Rodadas repetidas não duplicam.
- Dia 31 (ou 29 e 30) vence no último dia dos meses curtos e volta ao dia
  certo no mês seguinte.
- Início no passado gera as parcelas atrasadas como **retroativas**: ficam
  vencidas, sem aviso automático (dê baixa ou isente).
- **Pausar** e **encerrar** cancelam as parcelas abertas que ainda não
  venceram; as vencidas continuam devidas. **Retomar** volta a gerar a partir
  de hoje, sem cobrar os meses da pausa.
- Valor e desconto valem para as parcelas futuras; as já geradas não mudam.

Estados da parcela: **aberta**, **paga**, **vencida**, **cancelada** e
**isenta**.

## Cobrança e avisos

| Quando | O que o cliente recebe |
|---|---|
| `days_before` dias antes (padrão 3) | A cobrança: valor, "vence em…", botão ou link e o Pix copia e cola |
| No dia (se ligado) | "Vence hoje" com o código que ainda vale |
| Depois de vencer | "Venceu em… está em aberto há N dias", a cada `overdue_every_days` dias, até `overdue_max` avisos por parcela (padrão 3 a cada 3 dias) |
| Ao pagar | Comprovante em texto (cliente, plano, competência, valor, data, forma e código) |

- A cobrança vale até 7 dias depois do vencimento; vencida, o próximo aviso
  cria outra. Um mesmo código é reaproveitado enquanto valer.
- **A parcela só fica paga** pelo webhook assinado do Mercado Pago (depois da
  consulta do pagamento) ou pela **baixa manual** de um administrador, que
  registra quem deu baixa, a data e a observação. Mensagem ou comprovante
  enviado pelo cliente nunca dá baixa.
- Pagamento que chega depois de uma baixa manual fica registrado como
  duplicado (evento `mensalidade.paid` com `duplicate: true`) para a equipe
  estornar no Mercado Pago. Estorno reabre a parcela.
- O cliente precisa ter **uma conversa** com a área (ter escrito ao menos uma
  vez). O módulo procura a conversa pelo telefone da assinatura; sem ela, o
  aviso não sai e a parcela mostra "Sem conversa no WhatsApp…".

## No WhatsApp

- **Minhas mensalidades**: parcelas em aberto e as três últimas pagas do
  telefone da conversa, com a lista para receber o Pix de uma parcela (na
  linha QR, o cliente responde com o número).
- **Segunda via**: reenvia o código da parcela em aberto (ou pergunta qual,
  se houver mais de uma).

## Pagadores

Cada assinatura pertence a um **pagador**: quem paga, com CPF ou CNPJ (os
dígitos são conferidos; o CNPJ com letras, válido a partir de julho de 2026,
também), nome e **vários telefones autorizados**. Uma empresa paga e vários
funcionários pedem suporte; uma mãe paga as aulas de dois filhos.

- Informe o CPF ou CNPJ ao criar a assinatura (ou na importação, coluna
  `document`): assinaturas do mesmo documento ficam no mesmo pagador e o
  telefone da assinatura passa a ser autorizado.
- Sem documento, cada assinatura cria um pagador com o próprio telefone. As
  assinaturas anteriores a esta versão viraram pagadores assim (migração 0051).
- **Mensalidades → Pagadores**: busca por nome, documento ou telefone,
  telefones autorizados (com quem é cada um) e a situação.
- **Situação**: em dia, em atraso ou sem assinatura. A **carência** (Planos e
  regras) é quantos dias depois do vencimento o pagador ainda conta como em
  dia. A primeira parcela de um plano contratado pelo WhatsApp só conta
  depois de paga.

## Para outros módulos (`src/modules/mensalidade/public.ts`)

Enquanto o núcleo não tem `requires` entre módulos, quem depende da
Mensalidade (o Suporte pago) importa direto deste arquivo e confere antes
`mensalidadeAvailable(env, profile)`. As funções agem como o módulo
`mensalidade`: cobranças, eventos e o gancho de pagamento continuam com ele.

| Função | Para quê |
|---|---|
| `situationByPhone(env, p, phone)` | Situação entre os pagadores que autorizaram o telefone (vale a mais favorável); `null` sem pagador |
| `situationByDocument(env, p, doc, {phone})` | Situação pelo CPF/CNPJ (400 inválido, `null` sem pagador); `phone_linked` diz se o telefone é autorizado |
| `validDocument(valor)` | Confere o documento sem consultar nada |
| `sellablePlans(env, p)` | Planos ativos marcados "Vender pelo WhatsApp" |
| `contractPlan(env, p, {conversation, plan_id, document?, payer_id?, name?, method?, sourceKey, actor})` | Acha ou cria o pagador (autorizando o telefone da conversa), cria a assinatura e cobra a primeira parcela na hora; mesma `sourceKey` não duplica |
| `chargeInstallment(env, p, {conversation, installment_id, method?, key})` | Cobra de novo a parcela em aberto (reaproveita o código que vale ou cria outra cobrança) |
| `linkPhone(env, p, payer_id, phone, actor)` | Autoriza um telefone ("vincular com um toque") |
| `findPayers(env, p, query)` | Busca de pagadores para o painel |
| `onInstallmentPaid(módulo, ouvinte)` | Avisa quando uma parcela é paga pelo provedor ou por baixa manual |

## Fora da janela de 24 horas (linha oficial)

Quase sempre o cliente não escreveu nas últimas 24 horas, então os avisos,
a cobrança e o comprovante saem como **notificação** (`notification: true`),
pelo modelo configurado em **Regras de atendimento → Notificações**. Para
funcionar a área precisa de:

1. Um modelo da categoria **UTILITY** aprovado na conta WhatsApp Business
   (pela Integração Zernio), no idioma configurado (`pt_BR`), com duas
   variáveis no corpo: `{{1}}` recebe "Atendimento" e `{{2}}` o texto do
   aviso (até 1000 caracteres). Sugestão de corpo:
   `Mensagem sobre {{1}}: {{2}}`.
2. Notificações ligadas na área com o nome desse modelo.
3. **Consentimento** do cliente registrado na conversa: hoje o núcleo só
   envia notificação fora da janela para conversas com consentimento
   `granted` (o mesmo das notificações de protocolo). Sem ele, a mensagem
   fica na fila até o cliente escrever.

Custo: cada notificação fora da janela é uma mensagem de modelo **utilitário**
cobrada pela Meta. No Brasil a ordem de grandeza é de US$ 0,0065 a 0,0068 por
mensagem (com desconto por volume), e a Meta passou a faturar o Brasil em
reais; confira a tabela atual em
[Pricing on the WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/pricing).
Uma parcela típica gera até 1 (cobrança) + 1 (no dia) + 3 (atraso) + 1
(comprovante) mensagens; a confirmação "Pagamento recebido" do núcleo soma
mais uma. Dentro da janela aberta as mensagens não são de modelo.

## O que só uma conta real confirma

Os testes simulam o Mercado Pago e não enviam nada ao WhatsApp. Antes de usar
em produção, confira numa linha Zernio e numa conta do Mercado Pago reais: a
cobrança criada com `notification: true` fora da janela, o modelo UTILITY com
quebras de linha no texto (a Meta recusa parâmetros com quebra de linha ou
tabulação), a lista "Receber o Pix" e o comprovante.
