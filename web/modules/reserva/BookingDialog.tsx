// Nova reserva e alteração pela equipe: unidade, datas (diária) ou dia,
// horário e duração (por hora), pessoas e cliente. Mostra na hora se o período
// está livre e o valor; a equipe não esbarra em antecedência nem estadia
// máxima, e pode encaixar sobre um bloqueio (nunca sobre outra reserva).
import React, { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useIntents, type Row } from "../../lib/api";
import { Field, Notice, Switch } from "../../ui";
import { FormDialog } from "../../admin/shared";
import { addDays, at, brClock, brDate, money, type Overview } from "./model";

/** Liga a reserva a uma conversa do WhatsApp (nome ou telefone). */
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
      <div className="reserva-linked">
        <span>
          Cliente do WhatsApp: <strong>{label(value)}</strong>. Confirmação,
          check-in e lembretes chegam nessa conversa.
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
        help="Ligada à conversa, a reserva recebe confirmação, sinal, check-in e lembretes."
      />
      {found.length > 0 && (
        <div className="reserva-chips">
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
  booking,
  initial,
  onClose,
  onDone,
}: {
  overview: Overview;
  /** Alterar esta reserva. */
  booking?: Row | null;
  /** Unidade e dia vindos do calendário. */
  initial?: { unit_id?: string; date?: string };
  onClose: () => void;
  onDone: (booking: Row) => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const editing = !!booking;
  const units = overview.units.filter(
    (u) => u.active || u.id === booking?.unit_id,
  );
  const config = overview.config;
  const today = brDate(Date.now());
  const [unitId, setUnitId] = useState<string>(
    booking?.unit_id || initial?.unit_id || units[0]?.id || "",
  );
  const unit = units.find((u) => u.id === unitId);
  const daily = unit?.mode !== "hourly";
  const [start, setStart] = useState(
    booking?.start_date || initial?.date || today,
  );
  const [end, setEnd] = useState(
    booking?.mode === "daily"
      ? booking.end_date
      : addDays(
          booking?.start_date || initial?.date || today,
          config.min_nights,
        ),
  );
  const [time, setTime] = useState(
    booking?.mode === "hourly" ? booking.arrival_time : config.hourly_open,
  );
  const [duration, setDuration] = useState(
    String(booking?.duration_minutes || config.min_hours * 60),
  );
  const [guests, setGuests] = useState(String(booking?.guests || 1));
  const [name, setName] = useState(booking?.customer_name || "");
  const [phone, setPhone] = useState(booking?.customer_phone || "");
  const [notes, setNotes] = useState(booking?.notes || "");
  const [conversation, setConversation] = useState<Row | null>(null);
  const [deposit, setDeposit] = useState(false);
  const [force, setForce] = useState(false);
  const [check, setCheck] = useState<Row | null>(null);

  // Livre e valor, consultados ao mudar o período (diárias).
  useEffect(() => {
    if (!unit || !daily || !start || !end || end <= start)
      return setCheck(null);
    let alive = true;
    const timer = setTimeout(() => {
      app
        .api(
          `${app.root}/reserva/availability?staff=1&unit_id=${encodeURIComponent(unit.id)}&start_date=${start}&end_date=${end}`,
        )
        .then((result) => alive && setCheck(result.units?.[0] || null))
        .catch(() => alive && setCheck(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [unitId, start, end]);

  const period = daily
    ? { start_date: start, end_date: end }
    : { starts: at(start, time), duration_minutes: Number(duration) };
  const hourlyPrice =
    unit && !daily
      ? Math.round((unit.price_cents * Number(duration)) / 60)
      : null;
  const ownPeriod =
    editing &&
    booking.unit_id === unitId &&
    (daily
      ? booking.start_date === start && booking.end_date === end
      : booking.starts === at(start, time) &&
        booking.duration_minutes === Number(duration));
  const durations: [string, string][] = [];
  for (let m = 30; m <= 12 * 60; m += 30)
    durations.push([
      String(m),
      m % 60 ? `${Math.floor(m / 60)}h30` : `${m / 60}h`,
    ]);

  return (
    <FormDialog
      title={editing ? `Alterar reserva #${booking.number}` : "Nova reserva"}
      submitLabel={editing ? "Salvar alteração" : "Reservar"}
      size="lg"
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = {
          unit_id: unitId,
          ...period,
          guests: Number(guests) || 1,
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          notes: notes.trim(),
          ...(force ? { force: true } : {}),
        };
        const result = editing
          ? await write(
              `${app.root}/reserva/bookings/${booking.id}`,
              "PATCH",
              body,
            )
          : await write(`${app.root}/reserva/bookings`, "POST", {
              ...body,
              ...(conversation ? { conversation_id: conversation.id } : {}),
              ...(deposit ? { deposit: true } : {}),
            });
        onDone(result);
      }}
    >
      <div className="reserva-grid">
        <Field
          label="Unidade"
          value={unitId}
          onChange={setUnitId}
          options={units.map((u) => ({
            id: u.id,
            name: `${u.name} · ${money(u.price_cents)} ${u.mode === "daily" ? "a diária" : "a hora"}`,
          }))}
          emptyOption={null}
          required
        />
        <Field
          label="Pessoas"
          type="number"
          value={guests}
          onChange={setGuests}
          min={1}
          max={unit?.capacity || 1}
          help={unit ? `Até ${unit.capacity}.` : undefined}
          required
        />
        {daily ? (
          <>
            <Field
              label={`Entrada (a partir das ${config.checkin_time})`}
              type="date"
              value={start}
              onChange={(v) => {
                setStart(v);
                if (v && end <= v) setEnd(addDays(v, config.min_nights));
              }}
              required
            />
            <Field
              label={`Saída (até as ${config.checkout_time})`}
              type="date"
              value={end}
              onChange={setEnd}
              min={addDays(start, 1)}
              required
            />
          </>
        ) : (
          <>
            <Field
              label="Dia"
              type="date"
              value={start}
              onChange={setStart}
              required
            />
            <Field
              label="Início"
              type="time"
              value={time}
              onChange={setTime}
              help={`Funcionamento das ${config.hourly_open} às ${config.hourly_close}.`}
              required
            />
            <Field
              label="Duração"
              value={duration}
              onChange={setDuration}
              options={durations}
              emptyOption={null}
            />
          </>
        )}
      </div>
      {daily && check && !ownPeriod && (
        <Notice tone={check.available ? "ok" : "warn"}>
          {check.available
            ? `Livre: ${check.nights} ${check.nights === 1 ? "diária" : "diárias"}, ${money(check.price_cents)}.`
            : check.message}
        </Notice>
      )}
      {!daily && hourlyPrice !== null && (
        <p className="muted">
          Valor: {money(hourlyPrice)} ({brClock(at(start, time))} às{" "}
          {brClock(at(start, time) + Number(duration) * 60000)}).
        </p>
      )}
      {!editing && (
        <ConversationPicker value={conversation} onChange={setConversation} />
      )}
      <div className="reserva-grid">
        <Field
          label="Nome do cliente"
          value={name}
          onChange={setName}
          placeholder={conversation ? "Da conversa" : ""}
          required={!conversation && !editing}
          maxLength={120}
        />
        <Field
          label="Telefone"
          value={phone}
          onChange={setPhone}
          placeholder={conversation ? "Da conversa" : ""}
          maxLength={30}
        />
      </div>
      <Field
        label="Observação interna"
        type="textarea"
        rows={2}
        value={notes}
        onChange={setNotes}
        maxLength={1000}
      />
      {!editing && conversation && config.deposit_type !== "none" && (
        <div className="reserva-switch">
          <Switch
            checked={deposit}
            onChange={setDeposit}
            label="Cobrar o sinal"
            disabled={!overview.deposit.available}
          />
          <span>
            Cobrar o sinal das regras pela conversa (a reserva fica aguardando
            até o pagamento).
            {!overview.deposit.available && ` ${overview.deposit.message}`}
          </span>
        </div>
      )}
      <div className="reserva-switch">
        <Switch
          checked={force}
          onChange={setForce}
          label="Encaixe sobre bloqueio"
        />
        <span>
          Aceitar sobre um bloqueio de datas (nunca sobre outra reserva).
        </span>
      </div>
    </FormDialog>
  );
}
