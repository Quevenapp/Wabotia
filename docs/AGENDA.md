# Agenda

O cliente marca horário pelo WhatsApp, recebe um lembrete antes e confirma,
remarca ou cancela sem falar com ninguém. A equipe vê a agenda do dia e da
semana no painel e marca, remarca e cancela à mão. Serve para salão,
barbearia, clínica, estúdio, aula particular: tudo o que tem serviço,
profissional e horário.

## Como ligar

1. **Gestão → Módulos**: ligue **Agenda** (vem desligada).
2. **Gestão → Serviços e horários** (administradores):
   - **Serviços**: nome, duração (múltiplos de 5 minutos) e preço opcional.
     Sem preço, o cliente não vê valor.
   - **Profissionais**: nome mostrado ao cliente, pessoa da equipe (opcional),
     serviços que atende e o horário de trabalho de cada dia, com até dois
     turnos (ex.: 09:00 às 12:00 e 13:00 às 18:00).
   - **Folgas e bloqueios**: dias inteiros ou um horário do dia, para uma
     pessoa ou para todos (a casa fecha).
   - **Regras da agenda**: antecedência mínima (padrão 60 minutos) e máxima
     (30 dias), intervalo entre horários (30 minutos), lembrete (24 horas
     antes; 0 desliga), prazo para o cliente mudar (2 horas antes) e os
     textos. Os feriados de Regras de atendimento → Horário fecham a agenda,
     se você deixar ligado.
3. **Gestão → Menus e ações**: ponha os destinos **Agendar horário** e
   **Meus agendamentos** no menu do WhatsApp.

Todos os horários são de Brasília.

## O que o cliente faz

- **Agendar horário**: escolhe o serviço, o profissional (ou "qualquer um"),
  o dia e o horário, e recebe a confirmação na conversa.
- **Meus agendamentos**: vê o que marcou e confirma, remarca ou cancela, até o
  prazo das regras. Depois do prazo, só a equipe muda.
- **Lembrete**: antes do horário (24 horas, por padrão), chega a mensagem com
  Confirmar, Remarcar e Cancelar. Quem marcou já dentro desse prazo não recebe
  lembrete. Fora da janela de 24 horas da linha oficial, o lembrete sai pelo
  modelo de notificação.

Nesta versão a escolha acontece numa página leve aberta pelo link que chega no
WhatsApp (serviço, profissional e dia; depois o horário), e a confirmação
volta para a conversa. A versão toda dentro do chat, com lista e botões nas
linhas oficiais e números nas linhas QR, já está pronta e entra quando o
atendimento passar a entregar à Agenda a resposta seguinte do cliente.

Dois clientes nunca ficam com o mesmo horário: se alguém pegar o horário
enquanto o outro ainda escolhe, o segundo recebe os horários que sobraram.

## O que a equipe faz

- **Gestão → Agenda**: agenda do dia (uma coluna por profissional) ou da
  semana. Botões em cada agendamento: confirmar, remarcar, marcar ausência
  (depois do início) e cancelar. O cliente ligado a uma conversa recebe o aviso
  de remarcação e de cancelamento.
- **Novo agendamento**: escolha serviço, profissional e dia e toque num dos
  horários livres. Ligue a uma conversa do WhatsApp (busca por nome ou
  telefone) para o cliente receber confirmação e lembrete. **Encaixe fora do
  horário** aceita um horário fora do expediente ou sobre um bloqueio, nunca
  sobre outro agendamento.
- **Na conversa**: "Agendar para este cliente" e "Enviar link para agendar"
  (o cliente escolhe sozinho). Só quem assumiu a conversa, ou um
  administrador.

## Para integrações

Rotas, formatos e eventos (`agenda.booked`, `agenda.rescheduled`,
`agenda.cancelled`, `agenda.confirmed`, `agenda.no_show`) em
[API.md](API.md#agenda) e no OpenAPI (`/api/openapi.json`, grupo Agenda).
Os aplicativos só mostram a Agenda quando `GET /api/v1/capabilities` lista o
módulo `agenda` na área.
