# Suporte pago

Para quem vende suporte técnico: o atendimento humano só depois de conferir
o pagamento. O cliente escolhe **Atendimento humano (pago)** no menu do
WhatsApp; o Wabotia reconhece quem paga, confere a mensalidade e passa para a
equipe quem está em dia. Quem não está pode pagar ali mesmo, comprar suporte
avulso ou contratar um plano mensal. A IA continua grátis. API em
[API.md](API.md#suporte-pago-módulo-suporte).

## Ligar

1. **Gestão → Módulos**: ligue **Mensalidade** e depois **Suporte pago**, que
   depende dela (desligar a Mensalidade desliga o Suporte junto). Para vender
   só suporte avulso, desmarque "Oferecer planos mensais" nas regras.
2. **Gestão → Cobrança**: configure o Mercado Pago ([COBRANCA.md](COBRANCA.md)).
   Sem ele, nada é vendido pelo WhatsApp.
3. **Mensalidades → Planos e regras**: marque **Vender pelo WhatsApp** nos
   planos mensais oferecidos.
4. **Suporte pago → Regras do suporte**: setor que recebe a conversa,
   identificação, pacotes avulsos (preço e validade: até o protocolo fechar ou
   por horas), planos oferecidos, formas de pagamento, carência e textos.
5. **Menus e ações**: por exemplo, um submenu **Falar com atendente** com
   **Falar com a IA (grátis)** (item de bot) e **Atendimento humano (pago)**
   (item deste módulo).

## Como o cliente é atendido

1. **Identificação.** Pelo telefone da conversa, entre os telefones
   autorizados dos pagadores (Mensalidades → Pagadores). Se não achar, pede o
   CPF ou CNPJ de quem paga, com os dígitos conferidos (aceita o CNPJ com
   letras), em até 3 tentativas por vez (configurável). Por telefone e por
   dia: no máximo 3 documentos diferentes e 10 tentativas.
2. **CPF/CNPJ de um cadastro, vindo de telefone que ele não autorizou.**
   Documento não é prova de identidade (CNPJ é público, CPF vaza). O cliente
   recebe sempre a mesma resposta ("vamos confirmar com a nossa equipe"), sem
   nada do cadastro (plano, valor, vencimento, cobrança), e a conversa **não**
   vai para a fila: fica **aguardando confirmação** (evento
   `suporte.awaiting_team`, aba **Aguardando confirmação** do Suporte pago).
   O atendente confere com o cliente e, em **Dados da conversa → Suporte
   pago**, usa **Confirmar identidade e liberar** (vincula o telefone e libera
   se o pagador está em dia) ou **Vincular ao pagador**. Nada pelo WhatsApp
   vincula telefone nem contrata em nome de um cadastro que já existe.
3. **Situação** (Mensalidade, com a carência das regras), só para o pagador
   que autorizou o telefone:
   - **em dia**: liberado;
   - **em atraso**: o cliente paga a parcela em aberto (Pix ou link) e é
     liberado quando o pagamento é confirmado;
   - **sem assinatura**: escolhe **Suporte avulso** (pacotes) ou **Plano
     mensal** (planos vendáveis). Sem cadastro, informa CPF/CNPJ (ainda não
     cadastrado) e nome. O plano cobra a primeira mensalidade na hora; o
     pagador (com este telefone), a assinatura e a parcela paga só nascem
     quando o Mercado Pago confirma o pagamento.
4. **Pagamento** pela Cobrança: Pix copia e cola na conversa ou link de
   pagamento (cartão e outros meios). "Já paguei" ou um comprovante enviado
   pelo cliente **não libera**: só o webhook do Mercado Pago, depois da
   consulta do pagamento. Enquanto espera, o cliente responde 1 para receber o
   código de novo ou 2 para trocar a forma. A mensalidade paga libera só a
   conversa em que a cobrança foi feita, ou (baixa manual, pagamento por outro
   caminho) um telefone autorizado do pagador que pediu atendimento há pouco.
5. **Liberação.** Fica gravado quem foi liberado, como (assinatura em dia,
   mensalidade paga, avulso, cortesia, confirmado pela equipe), por qual
   pagador e até quando, e a conversa vai para o setor configurado com um
   resumo para o atendente.
6. **Cortesia.** O atendente (com a conversa assumida) ou um administrador
   libera sem pagamento em **Dados da conversa → Suporte pago**, com motivo.

**Suporte pago → Suporte pago** lista as liberações e as compras avulsas,
com filtro, e busca pagadores.

## Validade da liberação

Toda liberação fica presa ao **protocolo** e à **sessão da conversa** em que
foi dada. Se a conversa não tem protocolo ativo, o Suporte abre um ("Suporte
pago: …") na hora de liberar.

- **Até o fim deste atendimento** (assinatura em dia, mensalidade paga,
  pacote "até o protocolo fechar", cortesia sem horas, confirmação da equipe):
  vale enquanto aquele protocolo estiver ativo e a conversa não for resolvida.
  Fechar o protocolo ou resolver a conversa encerra a liberação; um protocolo
  aberto depois pelo cliente não a revive.
- **Por horas** (pacote ou cortesia com horas): vale até a hora marcada.
- **Prazo máximo:** 7 dias para "até o fim deste atendimento" e 30 dias para
  qualquer liberação, mesmo com o protocolo aberto.
- **Telefone não vinculado ao pagador:** no máximo 4 horas.
- **Assinatura e confirmação da equipe:** a cada pedido de humano a situação
  do pagador é consultada de novo; fora do dia, a liberação acaba.
- **Estorno:** o estorno da mensalidade ou do pacote que liberou encerra a
  liberação.

O encerramento acontece no próximo pedido de humano e na rotina periódica do
módulo (evento `suporte.release_ended`, com o motivo).

## Compras e estornos

- Uma compra por sessão e pacote, com **uma cobrança valendo por vez**:
  trocar a forma de pagamento ou pedir o código depois de vencido cancela a
  cobrança aberta antes de criar outra. Abrir outra compra (outro pacote,
  outra sessão) cancela a que estava aberta na conversa. O mesmo vale para a
  contratação de plano.
- **Pagamento em dobro** (a cobrança antiga paga junto com a nova, link pago
  duas vezes): não libera de novo; a compra fica com a pendência **Pago em
  dobro: estornar** e sai o evento `suporte.purchase_attention`.
- **Paga depois de cancelada:** libera (o cliente pagou), com a pendência
  "conferir" para a equipe ver se ele não pagou a outra também.
- **Estorno ou chargeback:** a compra fica estornada, a liberação acaba e a
  pendência **Estornada depois de liberar** avisa a equipe. Estorno de
  mensalidade encerra a liberação que ela deu.

## Nenhum caminho contorna o pagamento

Com o Suporte ligado, **toda passagem automática para humano** passa pela
regra (`onHandoffRequest` do núcleo): outro item "humano" do menu, a
palavra-chave "atendente", o bot de IA que decide transferir, a falha do bot
ou um anexo. Sem liberação ativa nem assinatura em dia, a passagem é segurada
e o cliente entra no mesmo fluxo de identificação e pagamento. Só a equipe
(transferir, assumir) passa por cima, de propósito. A liberação usa a
passagem do núcleo para módulos (`ctx.handoff`), com o resumo e os marcadores
("telefone não vinculado") no detalhe da conversa.

## O que só uma conta real confirma

Os testes simulam o Mercado Pago e não enviam nada ao WhatsApp. Antes de
vender, confira numa linha Zernio e numa conta do Mercado Pago reais: a lista
de opções e de formas de pagamento, o Pix e o link chegando na conversa, a
confirmação pelo webhook liberando a conversa e o resumo que o atendente vê.
