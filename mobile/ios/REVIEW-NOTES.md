# Notas para a revisão da App Store (modo aparelho, guichê e verticais)

Texto para o campo **Notas** de "Informações para a revisão do app" no App Store Connect. O revisor não precisa de
conta nem de servidor: a demonstração da primeira tela responde em memória e nada sai do aparelho.

## Português

> O Wabotia é usado por equipes de atendimento pelo WhatsApp. Sem servidor da empresa, toque em **Conhecer o app
> (demonstração)** na primeira tela: abre uma instalação fictícia, sem conta e sem enviar nada. Na aba
> **Atendimento**, em **Guichê da fila de senhas**, o atendente escolhe um guichê, abre, chama a próxima senha, rechama,
> conclui e transfere.
>
> Também na aba **Atendimento**: **Agenda** (uma barbearia de exemplo: agenda do dia por profissional e da
> semana; toque num horário para confirmar, remarcar, marcar ausência ou cancelar; o **+** agenda um cliente num dos
> horários livres) e **Ordens de serviço** (uma assistência técnica de exemplo: lista por estado, busca, detalhe com
> histórico, orçamento, mudança de estado, registro de entrega e comprovante impresso). Na conversa de um cliente, o
> menu **⋯** traz **Agendar para este cliente** e **Abrir ordem de serviço**. Na demonstração, um cliente fictício marca
> um horário depois de 40 segundos e outro aprova um orçamento depois de um minuto, e as telas abertas se atualizam.
>
> Ainda na aba **Atendimento**: **Reservas** (uma pousada de exemplo: ocupação das acomodações por dia, lista de
> reservas, detalhe com sinal e check-in; o **+** reserva uma acomodação ou o salão por hora) e **Mensalidades** (uma
> escola de idiomas de exemplo: resumo do mês, parcelas, assinaturas e inadimplentes; numa parcela, reenviar a cobrança,
> dar baixa ou isentar; na assinatura e nos inadimplentes, o pagador com CPF ou CNPJ e os telefones autorizados).
>
> E **Pedidos** (uma lanchonete de exemplo: quadro da cozinha por estado, com o tempo de cada pedido e os atrasados em
> vermelho; lista com filtro; cardápio para marcar item ou adicional como esgotado; **Pausar a loja**; no pedido,
> mudar o estado, cancelar com motivo, registrar o pagamento na entrega e imprimir a comanda). Na conversa de **Ricardo
> Almeida**, a faixa no topo mostra que o Suporte pago passou o cliente à equipe, com o resumo e os avisos ("telefone
> não vinculado ao pagador"); o menu **⋯** e os dados da conversa trazem **Vincular telefone**, **Confirmar e liberar**
> e **Liberar como cortesia**. Nenhum pagamento é feito no app: a cobrança é do servidor da empresa.
>
> Na conversa de **Mariana Costa**, a faixa no topo mostra o Pix do frete aguardando pagamento e o formulário
> respondido; o menu **⋯** traz **Enviar formulário** e **Cobrar** (Pix ou link de pagamento). Na demonstração, o
> formulário enviado é respondido sozinho e a cobrança fictícia é confirmada em 15 segundos. O app só pede a
> cobrança ao servidor da empresa, que cobra pelo Mercado Pago dela; o app não processa pagamento nem vende nada.
>
> O mesmo app também transforma um iPad ou iPhone da recepção em totem de senhas ou painel de chamadas. Para ver: na
> primeira tela, toque em **Ver o modo painel ou totem (demonstração)** → **Gerar código** (o código de exemplo é
> aprovado sozinho em 2 segundos) → escolha **Totem**, **Painel de chamadas** ou **Painel híbrido**. O totem emite a
> senha (o cupom só é impresso se houver uma impressora térmica escolhida; sem ela, a senha fica na tela). O painel
> mostra e fala as chamadas; uma atendente fictícia chama uma senha a cada 20 segundos. A engrenagem no canto abre os
> ajustes; **Sair da demonstração** volta à primeira tela. Para o visitante não sair do app, os ajustes ensinam a ligar
> o Acesso Guiado (**Travar na tela**); num iPad supervisionado cujo perfil MDM libera o app, ele inicia o Modo de App
> Único por `UIAccessibility.requestGuidedAccessSession`, e nos demais aparelhos nada acontece.
>
> Bluetooth e rede local são pedidos só quando a pessoa procura uma impressora térmica para o cupom.

## English

> Wabotia is used by customer-service teams on WhatsApp. Without a company server, tap **Conhecer o app
> (demonstração)** on the first screen: it opens a fictitious installation with no account, and nothing is sent. In the
> **Atendimento** tab, under **Guichê da fila de senhas**, the agent picks a service desk, opens it, calls the next ticket,
> recalls, finishes and transfers it.
>
> Also in the **Atendimento** tab: **Agenda** (a sample barbershop: the day per professional and the week; tap an
> appointment to confirm, reschedule, mark a no-show or cancel; **+** books a customer into one of the free slots) and
> **Ordens de serviço** (a sample repair shop: list by status, search, detail with history, quote, status changes,
> delivery and a printed receipt). In a customer's conversation, the **⋯** menu offers **Agendar para este cliente**
> (book for this customer) and **Abrir ordem de serviço** (open a service order). In the demo, a fictitious customer
> books a slot after 40 seconds and another approves a quote after one minute, and the open screens update themselves.
>
> Also in the **Atendimento** tab: **Reservas** (a sample guesthouse: daily occupancy of the rooms, the bookings list,
> detail with deposit and check-in; **+** books a room or the hall by the hour) and **Mensalidades** (a sample language
> school: the month's summary, installments, subscriptions and overdue customers; on an installment, resend the charge,
> record a payment or waive it; on a subscription and in the overdue list, the payer with CPF or CNPJ and the
> authorized phones).
>
> And **Pedidos** (a sample snack bar: the kitchen board by status, with each order's time and late orders in red; a
> filtered list; the menu, where an item or add-on is marked sold out; **Pausar a loja** to stop taking orders; on an
> order, change its status, cancel with a reason, record a payment on delivery and print the kitchen ticket). In
> **Ricardo Almeida**'s conversation, the strip at the top shows that the paid-support module handed the customer to
> the team, with a summary and warnings ("phone not linked to the payer"); the **⋯** menu and the conversation details
> offer **Vincular telefone** (link phone), **Confirmar e liberar** (confirm and release) and **Liberar como cortesia**
> (release as a courtesy). No payment happens in the app: charging is done by the company's server.
>
> In **Mariana Costa**'s conversation, the strip at the top shows the shipping Pix awaiting payment and the answered
> form; the **⋯** menu offers **Enviar formulário** (send a form) and **Cobrar** (charge by Pix or payment link). In the
> demo, a sent form is answered by itself and the fictitious charge is confirmed after 15 seconds. The app only asks
> the company's server to charge the customer through the company's own Mercado Pago account; the app does not
> process payments or sell anything.
>
> The same app also turns a front-desk iPad or iPhone into a ticket kiosk or a call display. To see it: on the first
> screen tap **Ver o modo painel ou totem (demonstração)** → **Gerar código** (the sample code is approved by itself
> in 2 seconds) → choose **Totem**, **Painel de chamadas** or **Painel híbrido**. The kiosk issues a ticket (a receipt is
> printed only if a thermal printer was set up; otherwise the ticket stays on screen). The display shows and speaks the
> calls; a fictitious agent calls a ticket every 20 seconds. The gear icon opens the settings; **Sair da demonstração**
> returns to the first screen. To keep visitors inside the app, the settings explain how to turn on Guided Access
> (**Travar na tela**); on a supervised iPad whose MDM profile allows the app, it starts Single App Mode with
> `UIAccessibility.requestGuidedAccessSession`, and on other devices nothing happens.
>
> Bluetooth and local network access are requested only when the user searches for a thermal receipt printer.
