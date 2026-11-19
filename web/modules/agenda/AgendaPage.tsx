import { AppointmentCommercialActions } from '../integrations/ReceiptForm';
import { CatalogRecordLinks } from '../integrations/CatalogLinkPicker';
import { IntegrationStatus } from '../integrations/IntegrationStatus';
// Agenda do dia e da semana, por profissional (módulo "agenda",
// docs/AGENDA.md): criar, remarcar, confirmar, cancelar e marcar ausência.
import React, { useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  RefreshCw,
  UserX,
  X,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { useResource } from "../../admin/shared";
import {
  Button,
  Confirm,
  Empty,
  Field,
  IconButton,
  Notice,
  Pill,
  Segmented,
  SkeletonRows,
} from "../../ui";
import { BookingDialog } from "./BookingDialog";
import {
  active,
  addDays,
  brDate,
  brStart,
  DAY_MS,
  dayLabel,
  statusInfo,
  weekStart,
  type Overview,
} from "./model";
import "./agenda.css";

type View = "day" | "week";

function AppointmentCard({
  a,
  showProfessional,
  busy,
  onConfirm,
  onMove,
  onCancel,
  onNoShow,
}: {
  a: Row;
  showProfessional: boolean;
  busy: boolean;
  onConfirm: () => void;
  onMove: () => void;
  onCancel: () => void;
  onNoShow: () => void;
}) {
  const info = statusInfo[a.status] || statusInfo.booked;
  const started = a.starts <= Date.now();
  return (
    <article className={"agenda-item" + (active(a) ? "" : " closed")}>
      <div className="agenda-item-time">
        <strong>{a.time}</strong>
        <small>{Math.round((a.ends - a.starts) / 60000)} min</small>
      </div>
      <div className="agenda-item-body">
        <div className="agenda-item-title">
          <strong className="truncate">{a.customer_name || "Cliente"}</strong>
          <Pill tone={info.tone}>{info.label}</Pill>
        </div>
        <span className="truncate">
          {a.service_name}
          {showProfessional ? ` · ${a.professional_name}` : ""}
        </span>
        {(a.customer_phone || a.notes) && (
          <small className="muted truncate">
            {[a.customer_phone, a.notes].filter(Boolean).join(" · ")}
          </small>
        )}
        {a.reminded_at && a.status === "booked" && (
          <small className="muted">Lembrete enviado</small>
        )}
        {active(a) && (
          <div className="agenda-item-actions">
            {a.status === "booked" && (
              <IconButton
                size="sm"
                label="Confirmar"
                disabled={busy}
                onClick={onConfirm}
              >
                <Check size={16} />
              </IconButton>
            )}
            <IconButton
              size="sm"
              label="Remarcar"
              disabled={busy}
              onClick={onMove}
            >
              <Clock size={16} />
            </IconButton>
            {started && (
              <IconButton
                size="sm"
                label="Marcar ausência"
                disabled={busy}
                onClick={onNoShow}
              >
                <UserX size={16} />
              </IconButton>
            )}
            <IconButton
              size="sm"
              label="Cancelar"
              tone="danger"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
      </div>
    </article>
  );
}

export function AgendaPage() {
  const app = useApp();
  const [commercial, setCommercial] = useState<Row | null>(null);
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const base = app.root + "/agenda";
  const overview = useResource(base);
  const data = overview.data as Overview | null;
  const [view, setView] = useState<View>("day");
  const [date, setDate] = useState(brDate(Date.now()));
  const [professional, setProfessional] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [booking, setBooking] = useState<{ appointment?: Row } | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const first = view === "day" ? date : weekStart(date);
  const from = brStart(first),
    to = from + (view === "day" ? 1 : 7) * DAY_MS;
  const list = useResource(
    `${base}/appointments?from=${from}&to=${to}${professional ? "&professional_id=" + encodeURIComponent(professional) : ""}`,
  );
  const rows: Row[] = (list.data?.data || []).filter(
    (a: Row) => showClosed || active(a),
  );
  const people: Row[] = useMemo(
    () =>
      (data?.professionals || []).filter(
        (p) =>
          (!professional || p.id === professional) &&
          (p.active || rows.some((a) => a.professional_id === p.id)),
      ),
    [data, professional, rows],
  );
  const act = (path: string, body: Row, success: string) =>
    run(
      async () => {
        await write(path, "POST", body);
        await list.reload();
      },
      { success },
    );
  const card = (a: Row, showProfessional: boolean) => (
    <React.Fragment key={a.id}><AppointmentCard
      a={a}
      showProfessional={showProfessional}
      busy={busy}
      onConfirm={() =>
        act(
          `${base}/appointments/${a.id}/confirm`,
          {},
          "Agendamento confirmado.",
        )
      }
      onMove={() => setBooking({ appointment: a })}
      onCancel={() => setCancelling(a)}
      onNoShow={() =>
        act(`${base}/appointments/${a.id}/no-show`, {}, "Ausência registrada.")
      }
    /><Button secondary onClick={() => setCommercial(a)}>Integração deste atendimento</Button></React.Fragment>
  );
  const step = view === "day" ? 1 : 7;
  const counts = rows.filter(active).length;

  if (data && !data.services.length)
    return (
      <div className="card">
        <Empty
          icon={<CalendarDays size={28} />}
          title="Cadastre os serviços e os profissionais"
          description={
            app.isAdmin
              ? "Em Gestão → Serviços e horários, cadastre o que a casa oferece, quem atende e em que horários. Depois, ponha o item Agendar horário no menu do WhatsApp."
              : "Peça a um administrador para cadastrar os serviços e os horários em Gestão → Serviços e horários."
          }
        />
      </div>
    );
  return (
    <>
      <IntegrationStatus module="agenda" compact />
      {data && <CatalogRecordLinks module="agenda" kind="service" records={data.services} />}
      {commercial && <section className="card"><IntegrationStatus module="agenda" sourceId={commercial.integration?.source_id || commercial.id} />
        <AppointmentCommercialActions id={commercial.id} version={commercial.commercial?.revision ?? commercial.version ?? null} priceCents={commercial.commercial?.price_cents ?? commercial.price_cents ?? null} onSaved={() => { setCommercial(null); void list.reload(); }} />
        <Button secondary onClick={() => setCommercial(null)}>Fechar integração</Button>
      </section>}
      <div className="toolbar agenda-toolbar">
        <div className="agenda-nav">
          <IconButton
            label={view === "day" ? "Dia anterior" : "Semana anterior"}
            onClick={() => setDate(addDays(date, -step))}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <Field
            label="Dia"
            type="date"
            value={date}
            onChange={(v) => v && setDate(v)}
          />
          <IconButton
            label={view === "day" ? "Próximo dia" : "Próxima semana"}
            onClick={() => setDate(addDays(date, step))}
          >
            <ChevronRight size={18} />
          </IconButton>
          <Button
            secondary
            size="sm"
            onClick={() => setDate(brDate(Date.now()))}
          >
            Hoje
          </Button>
        </div>
        <Segmented
          label="Período"
          value={view}
          onChange={setView}
          options={[
            { value: "day", label: "Dia" },
            { value: "week", label: "Semana" },
          ]}
        />
        <Field
          label="Profissional"
          value={professional}
          onChange={setProfessional}
          options={data?.professionals || []}
          emptyOption="Todos"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(event) => setShowClosed(event.target.checked)}
          />
          Mostrar cancelados e faltas
        </label>
        <span className="spacer" />
        <IconButton label="Atualizar" onClick={() => void list.reload()}>
          <RefreshCw size={17} />
        </IconButton>
        <Button
          icon={<Plus size={17} />}
          disabled={!data}
          onClick={() => setBooking({})}
        >
          Novo agendamento
        </Button>
      </div>
      <p className="agenda-summary">
        {view === "day"
          ? dayLabel(date, true)
          : `Semana de ${dayLabel(first)} a ${dayLabel(addDays(first, 6))}`}
        {" · "}
        {counts} {counts === 1 ? "agendamento" : "agendamentos"}
      </p>
      {(overview.error || list.error) && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {overview.error || list.error}
        </Notice>
      )}
      {!data || !list.loaded ? (
        <SkeletonRows rows={5} avatar={false} />
      ) : view === "day" ? (
        <div className="agenda-columns">
          {people.map((p) => {
            const mine = rows.filter((a) => a.professional_id === p.id);
            return (
              <section className="card agenda-column" key={p.id}>
                <h2>
                  {p.name}
                  <small>{mine.filter(active).length}</small>
                </h2>
                {mine.length ? (
                  mine.map((a) => card(a, false))
                ) : (
                  <p className="muted">Nada marcado.</p>
                )}
              </section>
            );
          })}
          {!people.length && (
            <div className="card">
              <Empty compact title="Nenhum profissional ativo" />
            </div>
          )}
        </div>
      ) : (
        <div className="agenda-week">
          {Array.from({ length: 7 }, (_, index) => addDays(first, index)).map(
            (day) => {
              const mine = rows.filter((a) => a.date === day);
              return (
                <section
                  className={
                    "card agenda-day" +
                    (day === brDate(Date.now()) ? " today" : "")
                  }
                  key={day}
                >
                  <h2>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => {
                        setDate(day);
                        setView("day");
                      }}
                    >
                      {dayLabel(day, true)}
                    </button>
                    <small>{mine.filter(active).length}</small>
                  </h2>
                  {mine.length ? (
                    mine.map((a) => card(a, true))
                  ) : (
                    <p className="muted">Livre.</p>
                  )}
                </section>
              );
            },
          )}
        </div>
      )}
      {booking && data && (
        <BookingDialog
          overview={data}
          appointment={booking.appointment}
          initialDate={date}
          onClose={() => setBooking(null)}
          onDone={() => void list.reload()}
        />
      )}
      {cancelling && (
        <Confirm
          title="Cancelar agendamento?"
          confirmLabel="Cancelar agendamento"
          cancelLabel="Voltar"
          danger
          onClose={() => setCancelling(null)}
          onConfirm={() => {
            const target = cancelling;
            setCancelling(null);
            void act(
              `${base}/appointments/${target.id}/cancel`,
              { reason: "Cancelado pela equipe" },
              "Agendamento cancelado.",
            );
          }}
        >
          <p>
            {cancelling.customer_name || "Cliente"} · {cancelling.service_name},{" "}
            {dayLabel(cancelling.date)} às {cancelling.time}.
            {cancelling.conversation_id
              ? " O cliente recebe o aviso no WhatsApp."
              : ""}
          </p>
        </Confirm>
      )}
    </>
  );
}
