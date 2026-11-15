// Ações da Agenda numa conversa: "Agendar para este cliente" (a equipe
// escolhe o horário) e "Enviar link para agendar" (o cliente escolhe).
// Pronto para entrar no painel de informações da conversa
// (web/conversations/InfoPanel.tsx, arquivo do núcleo):
//   {app.moduleOn("agenda") && <ConversationAgenda conversation={c} name={name} />}
import React, { useEffect, useState } from "react";
import { CalendarPlus, Send } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { Button } from "../../ui";
import { BookingDialog } from "./BookingDialog";
import { dayLabel, type Overview } from "./model";

export function ConversationAgenda({
  conversation,
  name,
}: {
  conversation: Row;
  name: string;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [open, setOpen] = useState(false);
  const [upcoming, setUpcoming] = useState<Row[]>([]);
  const load = () =>
    app
      .api(
        `${app.root}/agenda/appointments?conversation_id=${encodeURIComponent(conversation.id)}&from=${Date.now()}&to=${Date.now() + 60 * 86_400_000}&status=booked,confirmed`,
      )
      .then((result) => setUpcoming(result.data || []))
      .catch(() => setUpcoming([]));
  useEffect(() => {
    void load();
  }, [conversation.id]);
  if (conversation.chat_type === "group" || !app.moduleOn("agenda"))
    return null;
  return (
    <section className="info-section agenda-conversation">
      <h4>Agenda</h4>
      {upcoming.length ? (
        <ul>
          {upcoming.map((a) => (
            <li key={a.id}>
              {dayLabel(a.date)} {a.time} · {a.service_name} com{" "}
              {a.professional_name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nenhum agendamento marcado.</p>
      )}
      <div className="card-actions">
        <Button
          secondary
          size="sm"
          icon={<CalendarPlus size={16} />}
          onClick={async () => {
            if (!overview) setOverview(await app.api(app.root + "/agenda"));
            setOpen(true);
          }}
        >
          Agendar para este cliente
        </Button>
        <Button
          secondary
          size="sm"
          busy={busy}
          icon={<Send size={16} />}
          onClick={() =>
            void run(
              () =>
                write(
                  `${app.root}/conversations/${conversation.id}/actions`,
                  "POST",
                  {
                    action: "agenda_link",
                  },
                ),
              { success: "Enviado ao cliente." },
            )
          }
        >
          Enviar link para agendar
        </Button>
      </div>
      {open && overview && (
        <BookingDialog
          overview={overview}
          conversation={{ id: conversation.id, name }}
          onClose={() => setOpen(false)}
          onDone={() => void load()}
        />
      )}
    </section>
  );
}
