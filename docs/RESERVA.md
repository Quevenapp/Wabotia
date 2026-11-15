# Reserva e check-in

O cliente reserva pelo WhatsApp um quarto, um chalé, uma quadra ou um salão,
paga o sinal por Pix ou link, faz o check-in online antes de chegar e recebe
o lembrete e a mensagem de saída. A equipe vê a ocupação de cada unidade no
painel e cria, altera, confirma e cancela à mão. Serve para pousada, aluguel
por temporada, quadra esportiva e salão de festas.

## Como ligar

1. **Gestão → Módulos**: ligue **Reserva e check-in** (vem desligado).
2. **Gestão → Unidades e regras** (administradores):
   - **Unidades**: nome, tipo, capacidade, preço, fotos (endereços https,
     opcionais) e o modo de reserva: **por diária** (entrada e saída em dias)
     ou **por hora** (início e duração).
   - **Bloqueios de datas**: dias em que uma unidade (ou toda a casa) não
     recebe reservas. Reservas já feitas não mudam.
   - **Regras**: antecedência mínima e máxima, estadia mínima e máxima,
     horário de entrada e de saída, funcionamento das unidades por hora,
     sinal (sem sinal, percentual ou valor fixo; Pix ou link; prazo para
     pagar), política de cancelamento, check-in, lembrete, saída e os textos.
3. **Gestão → Menus e ações**: ponha **Fazer reserva** e **Minhas reservas**
   no menu do WhatsApp.
4. Com sinal, configure o Mercado Pago em **Gestão → Cobrança**
   ([COBRANCA.md](COBRANCA.md)). Sem a conta, as telas da Reserva avisam que
   o sinal não pode ser cobrado.

Todos os horários são de Brasília.

## O que o cliente faz

- **Fazer reserva**: escolhe a unidade, a data de entrada (da lista ou
  digitando, ex.: 20/12) e as diárias, ou o dia, a duração e o horário;
  depois o número de pessoas. Recebe o resumo com o valor, o sinal e a
  política de cancelamento e confirma.
- **Sinal**: com sinal nas regras, a reserva fica **aguardando pagamento** e
  a unidade segura até o prazo. O cliente recebe o Pix ou o link na conversa.
  Só o Mercado Pago confirma o pagamento; "já paguei" ou comprovante não
  mudam nada. Pago, chega a confirmação; vencido o prazo, a unidade é
  liberada e o cliente é avisado.
- **Minhas reservas**: vê as reservas, faz o check-in e cancela até o prazo
  das regras (padrão: 48 horas antes da entrada). Depois disso, só a equipe.
- **Check-in**: antes da entrada (padrão: 48 horas), chega o link de uma
  página leve com os campos escolhidos (documento, acompanhantes, horário de
  chegada, perguntas a mais e o aceite das regras da casa). Fora da janela de
  24 horas da linha oficial, chega um convite pelo modelo de notificação e o
  link sai quando o cliente responde **CHECKIN**.
- **Lembrete** na véspera (padrão: 24 horas antes) e **mensagem de saída**
  (padrão: 1 hora antes do horário de saída), pelo modelo de notificação
  quando a janela de 24 horas estiver fechada.

Lista e botões nas linhas oficiais, opções numeradas nas linhas QR. MENU sai
da reserva a qualquer momento; uma pergunta sem resposta vence em 30
minutos. Duas pessoas nunca ficam com a mesma unidade no mesmo período: quem
confirma por último recebe outras datas.

## O que a equipe faz

- **Gestão → Reservas**: a **ocupação** de cada unidade dia a dia (toque num
  dia livre para reservar, numa reserva para abrir) e a **lista** com filtro
  de estado e busca por nome, telefone ou número.
- **Nova reserva**: unidade, período, pessoas e cliente (com ou sem conversa
  do WhatsApp). Ligada a uma conversa, o cliente recebe a confirmação, o
  check-in e os lembretes; dá para cobrar o sinal. A equipe não esbarra na
  antecedência nem na estadia máxima, e pode encaixar sobre um bloqueio,
  nunca sobre outra reserva.
- **Detalhe**: pagamento do sinal, respostas do check-in, e os botões
  Confirmar sem sinal (pago por fora), Cobrar o sinal, Enviar check-in,
  Alterar e Cancelar. Devolução de sinal é feita no painel do Mercado Pago.
- Se o pagamento chegar depois de a reserva ter sido liberada e a unidade já
  estiver com outra pessoa, o evento `reserva.payment_late` avisa que é
  preciso remarcar ou devolver.

## Para integrações

Rotas, formatos e eventos (`reserva.created`, `reserva.confirmed`,
`reserva.changed`, `reserva.cancelled`, `reserva.expired`,
`reserva.completed`, `reserva.payment_late`, `reserva.checkin_sent`,
`reserva.checkin_completed`) em [API.md](API.md#reserva-e-check-in) e no
OpenAPI (`/api/openapi.json`, grupo Reserva). Os aplicativos só mostram a
Reserva quando `GET /api/v1/capabilities` lista o módulo `reserva` na área.
