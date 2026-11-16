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
- Baixa manual, isenção, pausa e encerramento cancelam no Mercado Pago o Pix
  ou link que ainda estava aberto. Se mesmo assim entrar um pagamento (o
  cliente pagou no mesmo instante), ele fica registrado como duplicado
  (evento `mensalidade.paid` com `duplicate: true`) para a equipe estornar.
  Estorno reabre a parcela.
- O módulo procura a conversa pelo telefone da assinatura (com ou sem o 9) e,
  se o cliente nunca escreveu, abre uma na linha oficial (veja "Fora da
  janela de 24 horas").

## No WhatsApp

- **Minhas mensalidades**: parcelas em aberto e as três últimas pagas do
  telefone da conversa, com a lista para receber o Pix de uma parcela (na
  linha QR, o cliente responde com o número).
- **Segunda via**: reenvia o código da parcela em aberto (ou pergunta qual,
  se houver mais de uma).

### No bot de IA (ferramentas do cliente)

O bot que atende o cliente (provedor direto ou Hermes com a chave presa à
conversa) só alcança o pagador **do telefone verificado da conversa**. Um
CPF/CNPJ dito pelo cliente nunca é consultado, e "já paguei" ou um
comprovante não mudam nada: só o webhook do Mercado Pago dá baixa.

| Ferramenta | O que faz | Botão de confirmação |
|---|---|---|
| `mensalidade_situacao` | Em dia, em atraso ou sem assinatura, com as parcelas em aberto | não |
| `mensalidade_segunda_via` | Reenvia o Pix ou link de uma parcela em aberto do próprio cliente | não |
| `mensalidade_pedir_dispensa` | Pede à equipe a dispensa de uma parcela em aberto | não (só registra o pedido) |
| `mensalidade_pedir_desconto` | Pede à equipe um desconto numa parcela em aberto | não (só registra o pedido) |

**Dispensa e desconto com aprovação** (`src/modules/mensalidade/requests.ts`):

- O bot só registra o pedido (`ctx.requestApproval`) e diz ao cliente que a
  equipe vai responder. Parcela de outro cliente: 404.
- O cartão vai à conversa interna dos **administradores** (quem hoje isenta
  parcela) e ao painel, com dados lidos do banco: cliente, plano, a parcela,
  assinatura desde, parcelas pagas e em aberto, histórico de atrasos e
  dispensas ou descontos anteriores. O que o cliente disse aparece à parte,
  como resumo do bot não verificado.
- **Dispensa aprovada**: a parcela fica isenta (como o "Isentar" do painel,
  evento `mensalidade.waived`).
- **Desconto aprovado**: o administrador informa o valor em reais (de
  R$ 0,01 até o valor menos um centavo; o valor inteiro é dispensa). A
  cobrança aberta é cancelada antes, o valor da parcela cai (colunas
  `discount_cents` e `discount_ref`, migração 0053, evento
  `mensalidade.discounted`) e o cliente recebe o código novo. Se a cobrança
  aberta não puder ser cancelada (o cliente pode ter acabado de pagar), nada
  muda e o pedido volta a pendente.
- **Recusado**: o cliente é avisado. **Assumir**: a conversa vai para quem
  tocou. **Sem resposta em 2 horas**: o cliente é avisado e a conversa vai
  para a fila da equipe.
- Pedir de novo a mesma coisa para a mesma parcela devolve o mesmo pedido
  (com o estado dele), sem cartão novo.

No bot da conversa interna (modo equipe), toda escrita da Mensalidade é
`sensitive` (`definition.bot`): confirmar exige segundo fator.

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
  dia.

### Contratar pelo WhatsApp

Um plano vendável contratado pela conversa (pelo Suporte pago) vira primeiro
um **contrato pendente** (`mensalidade_contracts`, evento
`mensalidade.contract_created`) com o plano, quem paga e a cobrança da
primeira mensalidade. Nada muda no cadastro até o Mercado Pago confirmar o
pagamento; aí nascem o pagador (com o documento, o nome e o telefone da
conversa), a assinatura e a primeira parcela, já paga.

- Só contrata em nome de um pagador existente o **telefone que ele
  autorizou**. Um CPF/CNPJ digitado que já tem cadastro é recusado
  (`payer_exists`): a equipe confirma o telefone antes.
- Se, entre a cobrança e o pagamento, o documento passar a ser de outro
  pagador, a assinatura fica com ele, mas o telefone **não** é vinculado, e
  a equipe é avisada (evento `mensalidade.contract_unlinked` e nota na
  conversa): uma parcela não paga dessa assinatura deixaria o pagador de
  verdade em atraso.
- O pagador que nasce da contratação é **provisório** (`provisional: true`,
  `created_by` = `contrato:<id>`): documento e telefone vieram de quem
  digitou. Na confirmação do Suporte pago, a equipe vê os telefones do
  pagador e quem cadastrou cada um.
- Trocar a forma de pagamento cancela a cobrança aberta antes de criar outra
  (vale também para as parcelas).

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
| `contractPlan(env, p, {conversation, plan_id, payer_id?, document?, name?, method?, sourceKey, actor})` | Contrato pendente e cobrança da primeira mensalidade (`{contract, installment}`); `payer_id` só do pagador que autorizou o telefone (`403 phone_not_linked`), `document` só ainda não cadastrado (`409 payer_exists`); quem já assina o plano recebe a cobrança da parcela em aberto; mesma `sourceKey` não duplica |
| `chargeContractAgain(env, p, {conversation, contract_id, method?, key})` | Reenvia o código que vale ou troca a forma (cancela a cobrança aberta) |
| `chargeInstallment(env, p, {conversation, installment_id, method?, key})` | Cobra de novo a parcela em aberto (reaproveita o código que vale ou cria outra cobrança, cancelando a aberta) |
| `linkPhone(env, p, payer_id, phone, actor)` | Autoriza um telefone ("vincular com um toque"); só depois de a equipe confirmar a identidade |
| `findPayers(env, p, query)` | Busca de pagadores para o painel |
| `onInstallmentPaid(módulo, ouvinte)` | Avisa quando uma parcela é paga pelo provedor ou por baixa manual, com `conversation_id` da cobrança paga (null na baixa manual) e `contract_id` |
| `onInstallmentRefunded(módulo, ouvinte)` | Avisa quando o pagamento de uma parcela é estornado |

## Quem pode o quê

- **Atendente**: cadastra assinaturas e pagadores pelo valor do plano,
  começando hoje e sem fim, corrige nome, telefone, dia e observações,
  reenvia cobrança. Na lista de pagadores vê o documento mascarado (completo
  no detalhe).
- **Administrador** (ou aplicação com `billing:write`): baixa manual,
  isenção, planos, importação, pausar/retomar/encerrar, valor, desconto,
  plano, início fora de hoje e fim da assinatura, autorizar telefone num
  pagador, trocar o documento e
  registrar o aceite de cobrança (com a evidência). `conversations:write` não
  basta para uma aplicação; aparelhos pareados do Vinki e do Fagoo não
  recebem `billing:write`.
- **Aplicações** só recebem documento, e-mail e telefones com
  `contacts:read`, e observações com `notes:read`.
- **WhatsApp**: o cliente é reconhecido só pelo telefone verificado pelo
  canal. Numa conversa criada por integração, nada é procurado nem vinculado
  pelo telefone.

## Fora da janela de 24 horas (linha oficial)

Quase sempre o cliente não escreveu nas últimas 24 horas, então os avisos,
a cobrança e o comprovante saem como **notificação** (`notification: true`),
pelo modelo configurado em **Regras de atendimento → Notificações**. Para
funcionar a área precisa de:

1. Um modelo da categoria **UTILITY** aprovado na conta WhatsApp Business
   (pela Integração Zernio), no idioma configurado (`pt_BR`), com duas
   variáveis no corpo: `{{1}}` recebe "Atendimento" e `{{2}}` o texto do
   aviso (até 1000 caracteres; o núcleo tira as quebras de linha, que a Meta
   não aceita em parâmetros). Sugestão de corpo:
   `Mensagem sobre {{1}}: {{2}}`.
2. Notificações ligadas na área com o nome desse modelo.
3. **Aceite de cobranças** (finalidade `billing`) registrado para o cliente:
   - automático quando ele contrata um plano pela conversa (módulo Suporte);
   - por um **administrador**, marcando "O cliente aceitou receber as
     cobranças e avisos pelo WhatsApp" ao criar a assinatura ou importar e
     dizendo onde ele aceitou (contrato, ficha ou pedido do cliente). Na API:
     `billing_consent: true` com `billing_consent_evidence` (5 a 500
     caracteres); sem a evidência, `400 consent_evidence_required`. A
     evidência fica gravada no aceite.
   Sem o aceite, a mensagem fica na fila até o cliente escrever. REVOGAR na
   conversa revoga todas as finalidades.

O cliente que nunca escreveu para a área ganha uma conversa na linha oficial
quando o primeiro aviso sai (ou quando a equipe registra o aceite); a resposta
dele cai na mesma conversa. Sem linha oficial na área, o aviso não sai e a
parcela mostra "Sem conversa no WhatsApp…".

Custo: cada notificação fora da janela é uma mensagem de modelo **utilitário**
cobrada pela Meta. No Brasil a ordem de grandeza é de US$ 0,0065 a 0,0068 por
mensagem (com desconto por volume), e a Meta passou a faturar o Brasil em
reais; confira a tabela atual em
[Pricing on the WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/pricing).
Uma parcela típica gera até 1 (cobrança) + 1 (no dia) + 3 (atraso) + 1
(comprovante) mensagens; o núcleo não manda o "Pagamento recebido" dele para
as cobranças da Mensalidade (`receipt: false`), só o comprovante do módulo.
Dentro da janela aberta as mensagens não são de modelo.

## O que só uma conta real confirma

Os testes simulam o Mercado Pago e não enviam nada ao WhatsApp. Antes de usar
em produção, confira numa linha Zernio e numa conta do Mercado Pago reais: a
cobrança criada com `notification: true` fora da janela, o modelo UTILITY com
quebras de linha no texto (a Meta recusa parâmetros com quebra de linha ou
tabulação), a lista "Receber o Pix" e o comprovante.
