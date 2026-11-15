// Novo agendamento, remarcação e "Agendar para este cliente": escolhe
// serviço, profissional e dia, mostra os horários livres (a equipe não tem
// antecedência mínima) e permite encaixe fora do horário de trabalho.
import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useIntents, type Row } from "../../lib/api";
import { Field, Notice, Spinner, Switch, toast } from "../../ui";
import { FormDialog } from "../../admin/shared";
import { at, brClock, brDate, dayLabel, money, type Overview } from "./model";

/** Liga o agendamento a uma conversa do WhatsApp (nome ou telefone). */
function ConversationPicker({
  value,
  onChange,
}: {
  value: Row | null;
  onChange: (next: Row | null) => void;
}) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Row[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) return setFound([]);
    let alive = true;
    const timer = setTimeout(() => {
      app
        .api(`${app.root}/conversations?limit=5&q=${encodeURIComponent(q)}`)
        .then(
          (result) =>
            alive &&
            setFound(
              (result.data || []).filter((c: Row) => c.chat_type !== "group"),
            ),
        )
        .catch(() => alive && setFound([]));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  const label = (c: Row) =>
    [c.contact_name || c.title, c.phone].filter(Boolean).join(" · ") ||
    "Conversa";
  if (value)
    return (
      <div className="agenda-squeeze">
        <span>
          Cliente do WhatsApp: <strong>{label(value)}</strong>. A confirmação e
          o lembrete chegam nessa conversa.
        </span>
        <button
          type="button"
          className="text-link"
          onClick={() => onChange(null)}
        >
          Trocar
        </button>
      </div>
    );
  return (
    <div>
      <Field
        label="Cliente do WhatsApp (opcional)"
        value={query}
        onChange={setQuery}
        placeholder="Nome ou telefone"
        help="Ligado à conversa, o cliente recebe a confirmação e o lembrete."
      />
      {found.length > 0 && (
        <div className="agenda-slot-grid agenda-picker">
          {found.map((c) => (
            <button
              key={c.id}
              type="button"
              className="chip"
              onClick={() => onChange(c)}
            >
              {label(c)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BookingDialog({
  overview,
  appointment,
  conversation,
  initialDate,
  onClose,
  onDone,
}: {
  overview: Overview;
  /** Remarcar este agendamento. */
  appointment?: Row | null;
  /** Agendar para o cliente desta conversa. */
  conversation?: { id: string; name: string } | null;
  initialDate?: string;
  onClose: () => void;
  onDone: (appointment: Row) => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const moving = !!appointment;
  const services = overview.services.filter(
    (s) => s.active || s.id === appointment?.service_id,
  );
  const [service, setService] = useState<string>(
    appointment?.service_id || (services.length === 1 ? services[0].id : ""),
  );
  const [professional, setProfessional] = useState<string>(
    appointment?.professional_id || "",
  );
  const [date, setDate] = useState(
    appointment?.date || initialDate || brDate(Date.now()),
  );
  const [slot, setSlot] = useState<number | null>(null);
  const [squeeze, setSqueeze] = useState(false);
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [linked, setLinked] = useState<Row | null>(null);
  const [slots, setSlots] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const people = useMemo(
    () =>
      overview.professionals.filter(
        (p) => p.active && (!service || p.service_ids.includes(service)),
      ),
    [overview.professionals, service],
  );

  useEffect(() => {
    setSlot(null);
    if (!service || !date || squeeze) return setSlots(null);
    let alive = true;
    setSlots(null);
    setError("");
    app
      .api(
        `${app.root}/agenda/availability?staff=1&service_id=${encodeURIComponent(service)}&date=${date}${professional ? `&professional_id=${encodeURIComponent(professional)}` : ""}`,
      )
      .then((result) => alive && setSlots(result.days?.[0]?.slots || []))
      .catch((e) => alive && (setSlots([]), setError(e.message)));
    return () => {
      alive = false;
    };
  }, [service, professional, date, squeeze]);

  const chosen = overview.services.find((s) => s.id === service);
  const starts = squeeze
    ? /^\d{2}:\d{2}$/.test(time)
      ? at(date, time)
      : null
    : slot;
  return (
    <FormDialog
      title={
        moving
          ? "Remarcar agendamento"
          : conversation
            ? `Agendar para ${conversation.name}`
            : "Novo agendamento"
      }
      subtitle={
        moving
          ? `${appointment!.customer_name || "Cliente"} · ${appointment!.service_name}, ${dayLabel(appointment!.date)} às ${appointment!.time}`
          : undefined
      }
      size="lg"
      submitLabel={moving ? "Remarcar" : "Agendar"}
      disabled={!service || !starts || (squeeze && !professional)}
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = {
          starts,
          professional_id: professional || null,
          ...(squeeze ? { force: true } : {}),
        };
        let result: Row;
        if (moving)
          result = await write(
            `${app.root}/agenda/appointments/${appointment!.id}/move`,
            "POST",
            body,
          );
        else if (conversation)
          result = await write(
            `${app.root}/conversations/${conversation.id}/actions`,
            "POST",
            { action: "agenda", service_id: service, notes, ...body },
          );
        else if (linked)
          result = await write(`${app.root}/agenda/appointments`, "POST", {
            service_id: service,
            conversation_id: linked.id,
            notes,
            ...body,
          });
        else
          result = await write(`${app.root}/agenda/appointments`, "POST", {
            service_id: service,
            customer_name: name,
            customer_phone: phone,
            notes,
            ...body,
          });
        toast(moving ? "Agendamento remarcado." : "Agendamento criado.");
        onDone(result);
        onClose();
      }}
    >
      {!moving && (
        <Field
          label="Serviço"
          value={service}
          onChange={(value) => {
            setService(value);
            setProfessional("");
          }}
          options={services.map((s) => ({
            id: s.id,
            name: `${s.name} · ${s.duration_minutes} min${s.price_cents !== null ? " · " + money(s.price_cents) : ""}`,
          }))}
          required
        />
      )}
      <div className="form-field-grid">
        <Field
          label="Profissional"
          value={professional}
          onChange={setProfessional}
          options={people}
          emptyOption="Qualquer um livre"
        />
        <Field
          label="Dia"
          type="date"
          value={date}
          onChange={setDate}
          required
        />
      </div>
      <div className="agenda-squeeze">
        <Switch
          label="Encaixe fora do horário"
          checked={squeeze}
          onChange={setSqueeze}
        />
        <span>
          Encaixe fora do horário de trabalho ou sobre um bloqueio. Nunca
          sobrepõe outro agendamento.
        </span>
      </div>
      {squeeze ? (
        <>
          <Field
            label="Horário"
            type="time"
            value={time}
            onChange={setTime}
            required
          />
          {!professional && (
            <Notice tone="warn">Para encaixe, escolha o profissional.</Notice>
          )}
        </>
      ) : (
        <fieldset className="agenda-slots">
          <legend>
            Horários livres{chosen ? ` · ${chosen.duration_minutes} min` : ""}
          </legend>
          {!service ? (
            <p className="muted">Escolha o serviço.</p>
          ) : slots === null ? (
            <Spinner label="Procurando horários" />
          ) : slots.length ? (
            <div className="agenda-slot-grid">
              {slots.map((s) => (
                <button
                  key={s.starts}
                  type="button"
                  className={"chip" + (slot === s.starts ? " active" : "")}
                  aria-pressed={slot === s.starts}
                  onClick={() => setSlot(s.starts)}
                >
                  {brClock(s.starts)}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              Nenhum horário livre em {dayLabel(date, true)}. Escolha outro dia
              ou use o encaixe.
            </p>
          )}
        </fieldset>
      )}
      {!moving && !conversation && (
        <ConversationPicker value={linked} onChange={setLinked} />
      )}
      {!moving && !conversation && !linked && (
        <div className="form-field-grid">
          <Field
            label="Nome do cliente"
            value={name}
            onChange={setName}
            maxLength={120}
            required
          />
          <Field
            label="Telefone (opcional)"
            type="tel"
            value={phone}
            onChange={setPhone}
            maxLength={20}
          />
        </div>
      )}
      {!moving && (
        <Field
          label="Observação (opcional)"
          type="textarea"
          rows={2}
          value={notes}
          onChange={setNotes}
          maxLength={1000}
        />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {conversation && !moving && (
        <p className="muted">
          O cliente recebe a confirmação no WhatsApp (pelo modelo de
          notificação, se a janela de 24 horas estiver fechada).
        </p>
      )}
    </FormDialog>
  );
}
