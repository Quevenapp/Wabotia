// Gestão → Serviços e horários (módulo "agenda"): serviços, profissionais com
// horário de trabalho, folgas e bloqueios, e as regras da agenda.
import React, { useState } from "react";
import {
  CalendarOff,
  Clock,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  User,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { FormDialog, toggled, useResource } from "../../admin/shared";
import {
  Button,
  Confirm,
  Empty,
  Field,
  Notice,
  Pill,
  Switch,
  toast,
} from "../../ui";
import {
  brClock,
  brDate,
  brStart,
  cents,
  dayLabel,
  DAY_MS,
  money,
  WEEKDAYS,
  type Overview,
} from "./model";
import "./agenda.css";

// --- Serviços ---------------------------------------------------------------

function ServiceDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [form, setForm] = useState<Row>({
    ...initial,
    price:
      initial.price_cents === null || initial.price_cents === undefined
        ? ""
        : String(initial.price_cents / 100).replace(".", ","),
  });
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={initial.id ? "Editar serviço" : "Novo serviço"}
      onClose={onClose}
      onSubmit={async () => {
        const body = {
          name: form.name,
          description: form.description || "",
          duration_minutes: Number(form.duration_minutes),
          price_cents: cents(String(form.price || "")),
          active: form.active !== false,
        };
        await write(
          `${app.root}/agenda/services${initial.id ? "/" + initial.id : ""}`,
          initial.id ? "PUT" : "POST",
          body,
        );
        toast("Serviço salvo.");
        onSaved();
        onClose();
      }}
    >
      <Field
        label="Nome"
        value={form.name || ""}
        onChange={set("name")}
        maxLength={80}
        required
      />
      <Field
        label="Descrição (opcional)"
        value={form.description || ""}
        onChange={set("description")}
        maxLength={300}
      />
      <div className="form-field-grid">
        <Field
          label="Duração (minutos)"
          type="number"
          min={5}
          max={720}
          value={form.duration_minutes ?? 30}
          onChange={set("duration_minutes")}
          help="Múltiplos de 5."
          required
        />
        <Field
          label="Preço (opcional)"
          value={form.price}
          onChange={set("price")}
          placeholder="R$ 0,00"
          help="Em branco, o cliente não vê preço."
        />
      </div>
      <div className="form-enabled">
        <Switch
          label="Serviço ativo"
          checked={form.active !== false}
          onChange={set("active")}
        />
        <span>Ativo: aparece para o cliente no WhatsApp.</span>
      </div>
    </FormDialog>
  );
}

// --- Profissionais ------------------------------------------------------------

type DayHours = {
  on: boolean;
  start: string;
  end: string;
  pause: boolean;
  start2: string;
  end2: string;
};

function hoursToDays(hours: Row[]): DayHours[] {
  return WEEKDAYS.map((_, weekday) => {
    const list = hours.filter((h) => h.weekday === weekday);
    return {
      on: list.length > 0,
      start: list[0]?.start || "09:00",
      end: list[0]?.end || "18:00",
      pause: list.length > 1,
      start2: list[1]?.start || "14:00",
      end2: list[1]?.end || "18:00",
    };
  });
}
function daysToHours(days: DayHours[]) {
  return days.flatMap((d, weekday) =>
    !d.on
      ? []
      : [
          { weekday, start: d.start, end: d.end },
          ...(d.pause ? [{ weekday, start: d.start2, end: d.end2 }] : []),
        ],
  );
}

function ProfessionalDialog({
  initial,
  services,
  onClose,
  onSaved,
}: {
  initial: Row;
  services: Row[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [name, setName] = useState(initial.name || "");
  const [person, setPerson] = useState(initial.user_id || "");
  const [active, setActive] = useState(initial.active !== false);
  const [chosen, setChosen] = useState<string[]>(
    initial.service_ids || services.map((s) => s.id),
  );
  const [days, setDays] = useState<DayHours[]>(
    initial.id
      ? hoursToDays(initial.hours || [])
      : hoursToDays(
          [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            start: "09:00",
            end: "18:00",
          })),
        ),
  );
  const setDay = (index: number, patch: Partial<DayHours>) =>
    setDays((current) =>
      current.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    );
  const people = app.team.filter((item: Row) => item.kind === "user");
  return (
    <FormDialog
      title={initial.id ? "Editar profissional" : "Novo profissional"}
      size="lg"
      onClose={onClose}
      onSubmit={async () => {
        await write(
          `${app.root}/agenda/professionals${initial.id ? "/" + initial.id : ""}`,
          initial.id ? "PUT" : "POST",
          {
            name,
            user_id: person || null,
            active,
            service_ids: chosen,
            hours: daysToHours(days),
          },
        );
        toast("Profissional salvo.");
        onSaved();
        onClose();
      }}
    >
      <div className="form-field-grid">
        <Field
          label="Nome mostrado ao cliente"
          value={name}
          onChange={setName}
          maxLength={80}
          required
        />
        <Field
          label="Pessoa da equipe (opcional)"
          value={person}
          onChange={setPerson}
          options={people}
          emptyOption="Nenhuma"
        />
      </div>
      <fieldset className="agenda-fieldset">
        <legend>Serviços que atende</legend>
        {services.length ? (
          services.map((s) => (
            <label className="check" key={s.id}>
              <input
                type="checkbox"
                checked={chosen.includes(s.id)}
                onChange={(event) =>
                  setChosen(toggled(chosen, s.id, event.target.checked))
                }
              />
              {s.name}
            </label>
          ))
        ) : (
          <p className="muted">Cadastre os serviços antes.</p>
        )}
      </fieldset>
      <fieldset className="agenda-fieldset agenda-hours">
        <legend>Horário de trabalho (Brasília)</legend>
        {days.map((d, index) => (
          <div className="agenda-hours-row" key={index}>
            <label className="check">
              <input
                type="checkbox"
                checked={d.on}
                onChange={(event) =>
                  setDay(index, { on: event.target.checked })
                }
              />
              {WEEKDAYS[index]}
            </label>
            {d.on ? (
              <>
                <input
                  type="time"
                  aria-label={`${WEEKDAYS[index]}: início`}
                  value={d.start}
                  onChange={(e) => setDay(index, { start: e.target.value })}
                />
                <span>às</span>
                <input
                  type="time"
                  aria-label={`${WEEKDAYS[index]}: fim`}
                  value={d.end}
                  onChange={(e) => setDay(index, { end: e.target.value })}
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={d.pause}
                    onChange={(event) =>
                      setDay(index, { pause: event.target.checked })
                    }
                  />
                  Segundo turno
                </label>
                {d.pause && (
                  <>
                    <input
                      type="time"
                      aria-label={`${WEEKDAYS[index]}: início do segundo turno`}
                      value={d.start2}
                      onChange={(e) =>
                        setDay(index, { start2: e.target.value })
                      }
                    />
                    <span>às</span>
                    <input
                      type="time"
                      aria-label={`${WEEKDAYS[index]}: fim do segundo turno`}
                      value={d.end2}
                      onChange={(e) => setDay(index, { end2: e.target.value })}
                    />
                  </>
                )}
              </>
            ) : (
              <span className="muted">Folga</span>
            )}
          </div>
        ))}
      </fieldset>
      <div className="form-enabled">
        <Switch
          label="Profissional ativo"
          checked={active}
          onChange={setActive}
        />
        <span>Ativo: recebe agendamentos.</span>
      </div>
    </FormDialog>
  );
}

// --- Folgas e bloqueios -------------------------------------------------------

function BlockDialog({
  professionals,
  onClose,
  onSaved,
}: {
  professionals: Row[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const today = brDate(Date.now());
  const [form, setForm] = useState<Row>({
    professional_id: "",
    date: today,
    until: today,
    whole: true,
    start: "12:00",
    end: "13:00",
    reason: "",
  });
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title="Nova folga ou bloqueio"
      onClose={onClose}
      onSubmit={async () => {
        await write(`${app.root}/agenda/blocks`, "POST", {
          professional_id: form.professional_id || null,
          date: form.date,
          ...(form.whole
            ? { until: form.until || form.date }
            : { start: form.start, end: form.end }),
          reason: form.reason,
        });
        toast("Bloqueio salvo.");
        onSaved();
        onClose();
      }}
    >
      <Field
        label="Quem"
        value={form.professional_id}
        onChange={set("professional_id")}
        options={professionals}
        emptyOption="Todos (a casa fecha)"
      />
      <div className="form-enabled">
        <Switch
          label="Dia inteiro"
          checked={form.whole}
          onChange={set("whole")}
        />
        <span>{form.whole ? "Dias inteiros" : "Só um horário do dia"}</span>
      </div>
      <div className="form-field-grid">
        <Field
          label={form.whole ? "De" : "Dia"}
          type="date"
          value={form.date}
          onChange={set("date")}
          required
        />
        {form.whole ? (
          <Field
            label="Até"
            type="date"
            value={form.until}
            onChange={set("until")}
            required
          />
        ) : (
          <div className="form-field-grid">
            <Field
              label="Início"
              type="time"
              value={form.start}
              onChange={set("start")}
              required
            />
            <Field
              label="Fim"
              type="time"
              value={form.end}
              onChange={set("end")}
              required
            />
          </div>
        )}
      </div>
      <Field
        label="Motivo (opcional)"
        value={form.reason}
        onChange={set("reason")}
        maxLength={120}
        placeholder="Folga, feriado, curso…"
      />
      <p className="muted">
        Agendamentos já marcados no período continuam; remarque-os na Agenda.
      </p>
    </FormDialog>
  );
}

// --- Regras ---------------------------------------------------------------------

const RULES: [string, string, number, number, string][] = [
  [
    "min_notice_minutes",
    "Antecedência mínima (minutos)",
    0,
    10080,
    "O cliente não marca para daqui a menos que isso.",
  ],
  [
    "max_days_ahead",
    "Antecedência máxima (dias)",
    1,
    365,
    "Até quantos dias à frente o cliente vê horários.",
  ],
  [
    "slot_step_minutes",
    "Intervalo entre horários (minutos)",
    5,
    240,
    "Ex.: 30 oferece 09:00, 09:30, 10:00…",
  ],
  [
    "reminder_hours",
    "Lembrete (horas antes)",
    0,
    168,
    "0 desliga. O lembrete pede Confirmar, Remarcar ou Cancelar.",
  ],
  [
    "customer_change_hours",
    "Prazo para o cliente mudar (horas)",
    0,
    168,
    "Depois disso, só a equipe remarca ou cancela.",
  ],
];
const TEXTS: [string, string, number][] = [
  ["intro_text", "Abertura do agendamento", 600],
  ["booked_text", "Mensagem de agendamento feito", 900],
  ["reminder_text", "Mensagem de lembrete", 900],
  ["cancelled_text", "Mensagem de cancelamento", 900],
];

function RulesCard({ config, onSaved }: { config: Row; onSaved: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [form, setForm] = useState<Row>(config);
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  const changed = JSON.stringify(form) !== JSON.stringify(config);
  return (
    <section className="card">
      <h2>Regras da agenda</h2>
      <div className="agenda-rules">
        {RULES.map(([key, label, min, max, help]) => (
          <Field
            key={key}
            label={label}
            type="number"
            min={min}
            max={max}
            value={form[key]}
            onChange={(v) => set(key)(Number(v))}
            help={help}
          />
        ))}
      </div>
      <div className="form-enabled">
        <Switch
          label="Feriados fecham a agenda"
          checked={form.close_on_holidays !== false}
          onChange={set("close_on_holidays")}
        />
        <span>
          Os feriados de Regras de atendimento → Horário fecham a agenda.
        </span>
      </div>
      <div className="form-enabled">
        <Switch
          label="Escolher numa página"
          checked={!!form.web_page}
          onChange={set("web_page")}
        />
        <span>
          Desligado: o cliente escolhe na própria conversa, com lista e botões.
          Ligado: recebe um link para escolher numa página e volta ao WhatsApp.
        </span>
      </div>
      {TEXTS.map(([key, label, max]) => (
        <Field
          key={key}
          label={label}
          type="textarea"
          rows={2}
          value={form[key]}
          onChange={set(key)}
          maxLength={max}
        />
      ))}
      <p className="muted">
        Nas mensagens, {"{servico}"}, {"{profissional}"}, {"{data}"}, {"{hora}"}{" "}
        e {"{nome}"} são trocados.
      </p>
      <div className="card-actions">
        <Button
          disabled={!changed}
          busy={busy}
          onClick={() =>
            void run(
              async () => {
                await app.api(app.root + "/settings", "PUT", { agenda: form });
                onSaved();
              },
              { success: "Regras salvas." },
            )
          }
        >
          Salvar regras
        </Button>
      </div>
    </section>
  );
}

// --- Página ---------------------------------------------------------------------

export function AgendaSettingsPage() {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const overview = useResource(app.root + "/agenda");
  const data = overview.data as Overview | null;
  const from = brStart(brDate(Date.now()));
  const blocks = useResource(
    `${app.root}/agenda/blocks?from=${from}&to=${from + 60 * DAY_MS}`,
  );
  const [service, setService] = useState<Row | null>(null);
  const [professional, setProfessional] = useState<Row | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [removing, setRemoving] = useState<{ kind: string; row: Row } | null>(
    null,
  );
  const reload = () => {
    void overview.reload();
    void blocks.reload();
  };
  if (!data)
    return overview.error ? (
      <Notice tone="error" onRetry={() => void overview.reload()}>
        {overview.error}
      </Notice>
    ) : null;
  const serviceName = (id: string) =>
    data.services.find((s) => s.id === id)?.name;
  const proName = (id: string | null) =>
    id
      ? data.professionals.find((p) => p.id === id)?.name || "Profissional"
      : "Todos";
  return (
    <>
      <section className="card">
        <h2>Agendamento pelo WhatsApp</h2>
        <p className="workspace-help">
          Cadastre os serviços, quem atende e em que horários. Depois, em Menus
          e ações, ponha os destinos Agendar horário e Meus agendamentos. O
          cliente escolhe serviço, profissional, dia e horário, recebe o
          lembrete antes e pode confirmar, remarcar ou cancelar.
        </p>
      </section>

      <div className="toolbar">
        <h2 className="agenda-heading">
          <Scissors size={18} /> Serviços
        </h2>
        <Button
          icon={<Plus size={17} />}
          onClick={() => setService({ duration_minutes: 30, active: true })}
        >
          Novo serviço
        </Button>
      </div>
      {data.services.length ? (
        <div className="cards-grid">
          {data.services.map((s) => (
            <section className="card" key={s.id}>
              <div className="section-heading">
                <h2>{s.name}</h2>
                <Pill tone={s.active ? "ok" : "muted"}>
                  {s.active ? "Ativo" : "Desativado"}
                </Pill>
              </div>
              <p>
                {s.duration_minutes} min
                {s.price_cents !== null ? ` · ${money(s.price_cents)}` : ""}
              </p>
              <small className="muted">
                {[
                  s.description,
                  data.professionals
                    .filter((p) => p.service_ids.includes(s.id))
                    .map((p) => p.name)
                    .join(", ") || "Ninguém atende ainda",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              <div className="card-actions">
                <Button
                  secondary
                  icon={<Pencil size={16} />}
                  onClick={() => setService(s)}
                >
                  Editar
                </Button>
                <Button
                  secondary
                  icon={<Trash2 size={16} />}
                  onClick={() => setRemoving({ kind: "services", row: s })}
                >
                  Excluir
                </Button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty
            compact
            icon={<Scissors size={24} />}
            title="Nenhum serviço"
            description="Corte, consulta, aula, avaliação: o que o cliente pode agendar."
          />
        </div>
      )}

      <div className="toolbar">
        <h2 className="agenda-heading">
          <User size={18} /> Profissionais
        </h2>
        <Button
          icon={<Plus size={17} />}
          disabled={!data.services.length}
          onClick={() => setProfessional({})}
        >
          Novo profissional
        </Button>
      </div>
      {data.professionals.length ? (
        <div className="cards-grid">
          {data.professionals.map((p) => (
            <section className="card" key={p.id}>
              <div className="section-heading">
                <h2>{p.name}</h2>
                <Pill tone={p.active ? "ok" : "muted"}>
                  {p.active ? "Ativo" : "Desativado"}
                </Pill>
              </div>
              <p>
                {p.service_ids.map(serviceName).filter(Boolean).join(", ") ||
                  "Sem serviços"}
              </p>
              <small className="muted">
                <Clock size={13} />{" "}
                {p.hours.length
                  ? WEEKDAYS.map((day, weekday) => {
                      const list = p.hours.filter(
                        (h: Row) => h.weekday === weekday,
                      );
                      return list.length
                        ? `${day.slice(0, 3)} ${list.map((h: Row) => `${h.start}–${h.end}`).join(", ")}`
                        : null;
                    })
                      .filter(Boolean)
                      .join(" · ")
                  : "Sem horário"}
              </small>
              <div className="card-actions">
                <Button
                  secondary
                  icon={<Pencil size={16} />}
                  onClick={() => setProfessional(p)}
                >
                  Editar
                </Button>
                <Button
                  secondary
                  icon={<Trash2 size={16} />}
                  onClick={() => setRemoving({ kind: "professionals", row: p })}
                >
                  Excluir
                </Button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty
            compact
            icon={<User size={24} />}
            title="Nenhum profissional"
            description="Quem atende, os serviços de cada um e os horários de trabalho."
          />
        </div>
      )}

      <div className="toolbar">
        <h2 className="agenda-heading">
          <CalendarOff size={18} /> Folgas e bloqueios (próximos 60 dias)
        </h2>
        <Button icon={<Plus size={17} />} onClick={() => setBlocking(true)}>
          Novo bloqueio
        </Button>
      </div>
      <section className="card">
        {(blocks.data?.data || []).length ? (
          <ul className="agenda-blocks">
            {(blocks.data.data as Row[]).map((b) => {
              const days = Math.round((b.ends - b.starts) / DAY_MS);
              const whole =
                brClock(b.starts) === "00:00" && brClock(b.ends) === "00:00";
              return (
                <li key={b.id}>
                  <strong>{proName(b.professional_id)}</strong>
                  <span>
                    {whole
                      ? days > 1
                        ? `${dayLabel(brDate(b.starts))} a ${dayLabel(brDate(b.ends - 1))}`
                        : dayLabel(brDate(b.starts))
                      : `${dayLabel(brDate(b.starts))}, ${brClock(b.starts)}–${brClock(b.ends)}`}
                    {b.reason ? ` · ${b.reason}` : ""}
                  </span>
                  <Button
                    secondary
                    size="sm"
                    icon={<Trash2 size={15} />}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        async () => {
                          await write(
                            `${app.root}/agenda/blocks/${b.id}`,
                            "DELETE",
                            {},
                          );
                          reload();
                        },
                        { success: "Bloqueio removido." },
                      )
                    }
                  >
                    Remover
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">
            Nenhuma folga ou bloqueio nos próximos 60 dias.
          </p>
        )}
      </section>

      <RulesCard
        key={JSON.stringify(data.config)}
        config={data.config}
        onSaved={reload}
      />

      {service && (
        <ServiceDialog
          initial={service}
          onClose={() => setService(null)}
          onSaved={reload}
        />
      )}
      {professional && (
        <ProfessionalDialog
          initial={professional}
          services={data.services}
          onClose={() => setProfessional(null)}
          onSaved={reload}
        />
      )}
      {blocking && (
        <BlockDialog
          professionals={data.professionals}
          onClose={() => setBlocking(false)}
          onSaved={reload}
        />
      )}
      {removing && (
        <Confirm
          title={`Excluir “${removing.row.name}”?`}
          confirmLabel="Excluir"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(
              async () => {
                await write(
                  `${app.root}/agenda/${target.kind}/${target.row.id}`,
                  "DELETE",
                  {},
                );
                reload();
              },
              { success: "Excluído." },
            );
          }}
        >
          <p>
            Os agendamentos já feitos continuam na Agenda com o nome de agora.
          </p>
        </Confirm>
      )}
    </>
  );
}
