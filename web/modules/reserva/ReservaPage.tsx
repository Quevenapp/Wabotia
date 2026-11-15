// Reservas (módulo "reserva", docs/RESERVA.md): ocupação por unidade e dia,
// lista com filtro de estado, detalhe com pagamento e check-in, e as ações da
// equipe (criar, alterar, confirmar, cobrar o sinal, enviar check-in,
// cancelar).
import React, { useState } from "react";
import {
  BedDouble,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Pencil,
  Plus,
  Wallet,
  X,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { useResource } from "../../admin/shared";
import {
  Button,
  Dialog,
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
  checkinInfo,
  dayLabel,
  money,
  moment,
  paymentErrors,
  paymentInfo,
  statusInfo,
  stayLabel,
  type Overview,
} from "./model";
import "./reserva.css";

type View = "calendar" | "list";
const FILTERS: { value: string; label: string; status: string }[] = [
  { value: "active", label: "Ativas", status: "pending_payment,confirmed" },
  { value: "pending", label: "Aguardando sinal", status: "pending_payment" },
  {
    value: "closed",
    label: "Encerradas",
    status: "completed,cancelled,expired",
  },
  { value: "all", label: "Todas", status: "" },
];
const DAYS = 14;

function StatusPill({ b }: { b: Row }) {
  const info = statusInfo[b.status] || statusInfo.confirmed;
  return <Pill tone={info.tone}>{info.label}</Pill>;
}

function Detail({
  b,
  questions,
  busy,
  onClose,
  onEdit,
  act,
  onCancel,
}: {
  b: Row;
  /** Perguntas a mais do check-in (rótulos de pergunta_1…). */
  questions: string[];
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  act: (path: string, success: string) => void;
  onCancel: () => void;
}) {
  const answers: Row = b.checkin_answers || {};
  const labels: Record<string, string> = {
    documento: "Documento",
    acompanhantes: "Acompanhantes",
    chegada: "Chegada prevista",
    regras: "Regras da casa",
  };
  const pending = b.status === "pending_payment";
  return (
    <Dialog
      title={`Reserva #${b.number}`}
      subtitle={b.unit_name}
      onClose={onClose}
      size="lg"
      footer={
        active(b) ? (
          <div className="card-actions">
            {pending && (
              <Button
                secondary
                icon={<Check size={16} />}
                disabled={busy}
                onClick={() => act(`/${b.id}/confirm`, "Reserva confirmada.")}
              >
                Confirmar sem sinal
              </Button>
            )}
            {pending && b.conversation_id && b.payment_status !== "created" && (
              <Button
                secondary
                icon={<Wallet size={16} />}
                disabled={busy}
                onClick={() =>
                  act(`/${b.id}/deposit`, "Cobrança do sinal enviada.")
                }
              >
                Cobrar o sinal
              </Button>
            )}
            {b.status === "confirmed" &&
              b.conversation_id &&
              b.checkin_status !== "completed" && (
                <Button
                  secondary
                  icon={<ClipboardCheck size={16} />}
                  disabled={busy}
                  onClick={() => act(`/${b.id}/checkin`, "Check-in enviado.")}
                >
                  {b.checkin_status === "sent"
                    ? "Reenviar check-in"
                    : "Enviar check-in"}
                </Button>
              )}
            <Button
              secondary
              icon={<Pencil size={16} />}
              disabled={busy}
              onClick={onEdit}
            >
              Alterar
            </Button>
            <Button
              variant="danger"
              icon={<X size={16} />}
              disabled={busy}
              onClick={onCancel}
            >
              Cancelar reserva
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="reserva-detail">
        <div>
          <StatusPill b={b} />
        </div>
        <dl>
          <dt>Período</dt>
          <dd>{stayLabel(b)}</dd>
          <dt>Cliente</dt>
          <dd>
            {[b.customer_name || "Sem nome", b.customer_phone]
              .filter(Boolean)
              .join(" · ")}
            {b.conversation_id ? " (WhatsApp)" : ""}
          </dd>
          <dt>Pessoas</dt>
          <dd>{b.guests}</dd>
          <dt>Valor</dt>
          <dd>{money(b.price_cents)}</dd>
          {b.deposit_cents > 0 && (
            <>
              <dt>Sinal</dt>
              <dd>
                {money(b.deposit_cents)} ·{" "}
                {b.payment_status
                  ? paymentInfo[b.payment_status]
                  : "Não cobrado"}
                {pending && b.payment_due_at
                  ? `, prazo ${moment(b.payment_due_at)}`
                  : ""}
                {b.paid_at ? `, pago ${moment(b.paid_at)}` : ""}
              </dd>
            </>
          )}
          <dt>Check-in</dt>
          <dd>
            {checkinInfo[b.checkin_status]}
            {b.checkin_at ? ` em ${moment(b.checkin_at)}` : ""}
          </dd>
          {b.notes && (
            <>
              <dt>Observação</dt>
              <dd>{b.notes}</dd>
            </>
          )}
          {b.cancel_reason && (
            <>
              <dt>Motivo</dt>
              <dd>{b.cancel_reason}</dd>
            </>
          )}
        </dl>
        {b.payment_error && pending && (
          <Notice tone="warn">
            O sinal não foi cobrado:{" "}
            {paymentErrors[b.payment_error] || b.payment_error}
          </Notice>
        )}
        {b.checkin_answers && (
          <section>
            <h3>Respostas do check-in</h3>
            <dl>
              {Object.entries(answers).map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt>
                    {labels[key] ||
                      questions[Number(key.replace("pergunta_", "")) - 1] ||
                      key}
                  </dt>
                  <dd className="reserva-pre">
                    {value === true
                      ? "Aceito"
                      : value === false
                        ? "Não"
                        : String(value || "—")}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        )}
      </div>
    </Dialog>
  );
}

export function ReservaPage() {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const base = app.root + "/reserva";
  const overview = useResource(base);
  const data = overview.data as Overview | null;
  const [view, setView] = useState<View>("calendar");
  const [from, setFrom] = useState(brDate(Date.now()));
  const [filter, setFilter] = useState("active");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Row | null>(null);
  const [editing, setEditing] = useState<{
    booking?: Row;
    initial?: { unit_id?: string; date?: string };
  } | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const calendar = useResource(
    view === "calendar"
      ? `${base}/calendar?from_date=${from}&to_date=${addDays(from, DAYS - 1)}`
      : null,
  );
  const status = FILTERS.find((f) => f.value === filter)!.status;
  const list = useResource(
    view === "list"
      ? `${base}/bookings?limit=300${status ? "&status=" + status : ""}${query.trim() ? "&q=" + encodeURIComponent(query.trim()) : ""}`
      : null,
  );
  const reload = async () => {
    await Promise.all([calendar.reload(), list.reload()]);
  };
  const act = (path: string, success: string) =>
    run(
      async () => {
        const updated = await write(`${base}/bookings${path}`, "POST", {});
        setOpen(updated);
        await reload();
      },
      { success },
    );
  const byId = new Map<string, Row>(
    (calendar.data?.bookings || []).map((b: Row) => [b.id, b]),
  );

  if (data && !data.units.length)
    return (
      <div className="card">
        <Empty
          icon={<BedDouble size={28} />}
          title="Cadastre as unidades"
          description={
            app.isAdmin
              ? "Em Gestão → Unidades e regras, cadastre os quartos, chalés, quadras ou salões, com preço e modo de reserva. Depois, ponha Fazer reserva e Minhas reservas no menu do WhatsApp."
              : "Peça a um administrador para cadastrar as unidades em Gestão → Unidades e regras."
          }
        />
      </div>
    );
  return (
    <>
      {data &&
        data.config.deposit_type !== "none" &&
        !data.deposit.available && (
          <Notice tone="warn">{data.deposit.message}</Notice>
        )}
      <div className="toolbar reserva-toolbar">
        <Segmented
          label="Visão"
          value={view}
          onChange={setView}
          options={[
            { value: "calendar", label: "Ocupação" },
            { value: "list", label: "Lista" },
          ]}
        />
        {view === "calendar" ? (
          <div className="reserva-nav">
            <IconButton
              label="Semana anterior"
              onClick={() => setFrom(addDays(from, -7))}
            >
              <ChevronLeft size={18} />
            </IconButton>
            <Field
              label="A partir de"
              type="date"
              value={from}
              onChange={(v) => v && setFrom(v)}
            />
            <IconButton
              label="Próxima semana"
              onClick={() => setFrom(addDays(from, 7))}
            >
              <ChevronRight size={18} />
            </IconButton>
          </div>
        ) : (
          <div className="reserva-nav reserva-filters">
            <Segmented
              label="Estado"
              value={filter}
              onChange={setFilter}
              options={FILTERS.map(({ value, label }) => ({ value, label }))}
            />
            <Field
              label="Buscar"
              value={query}
              onChange={setQuery}
              placeholder="Nome, telefone ou #número"
            />
          </div>
        )}
        <Button
          icon={<Plus size={17} />}
          disabled={!data}
          onClick={() => setEditing({})}
        >
          Nova reserva
        </Button>
      </div>

      {view === "calendar" && (
        <section className="card">
          {!calendar.data ? (
            <SkeletonRows />
          ) : (
            <div className="table-scroll">
              <table className="reserva-grid-table">
                <thead>
                  <tr>
                    <th>Unidade</th>
                    {calendar.data.days.map((d: string) => (
                      <th
                        key={d}
                        className={d === brDate(Date.now()) ? "today" : ""}
                      >
                        {dayLabel(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calendar.data.units.map((u: Row) => (
                    <tr key={u.unit_id}>
                      <td className="reserva-unit">
                        <strong>{u.name}</strong>
                        <small className="muted">
                          {u.mode === "daily" ? "Diárias" : "Por hora"}
                          {u.active ? "" : " · inativa"}
                        </small>
                      </td>
                      {u.cells.map((cell: Row) => {
                        const first = byId.get(cell.booking_ids[0]);
                        const label =
                          cell.state === "blocked"
                            ? "Bloqueado"
                            : first
                              ? u.mode === "daily"
                                ? first.customer_name || `#${first.number}`
                                : `${cell.booking_ids.length} ${cell.booking_ids.length === 1 ? "reserva" : "reservas"}`
                              : "";
                        return (
                          <td
                            key={cell.date}
                            className={`reserva-cell state-${cell.state}`}
                          >
                            <button
                              type="button"
                              title={
                                first
                                  ? `#${first.number} · ${first.customer_name} · ${statusInfo[first.status]?.label}`
                                  : cell.state === "blocked"
                                    ? "Bloqueado"
                                    : "Livre: nova reserva"
                              }
                              onClick={() =>
                                first
                                  ? setOpen(first)
                                  : cell.state !== "blocked" &&
                                    setEditing({
                                      initial: {
                                        unit_id: u.unit_id,
                                        date: cell.date,
                                      },
                                    })
                              }
                            >
                              {label}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="reserva-legend">
            <span className="state-confirmed">Confirmada</span>
            <span className="state-pending_payment">Aguardando sinal</span>
            <span className="state-partial">Ocupada em parte</span>
            <span className="state-blocked">Bloqueada</span>
          </div>
        </section>
      )}

      {view === "list" && (
        <section className="card">
          {!list.data ? (
            <SkeletonRows />
          ) : !list.data.data.length ? (
            <Empty
              compact
              icon={<BedDouble size={24} />}
              title="Nenhuma reserva"
              description="Nada neste filtro."
            />
          ) : (
            <div className="table-scroll">
              <table className="reserva-list">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Cliente</th>
                    <th>Unidade</th>
                    <th>Período</th>
                    <th>Estado</th>
                    <th>Sinal</th>
                    <th>Check-in</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((b: Row) => (
                    <tr
                      key={b.id}
                      className="reserva-row"
                      onClick={() => setOpen(b)}
                    >
                      <td>{b.number}</td>
                      <td>
                        {b.customer_name || "Sem nome"}
                        {b.customer_phone && (
                          <small className="muted"> {b.customer_phone}</small>
                        )}
                      </td>
                      <td>{b.unit_name}</td>
                      <td>{stayLabel(b)}</td>
                      <td>
                        <StatusPill b={b} />
                      </td>
                      <td>
                        {b.deposit_cents
                          ? `${money(b.deposit_cents)} · ${b.payment_status ? paymentInfo[b.payment_status] : "não cobrado"}`
                          : "—"}
                      </td>
                      <td>
                        {b.checkin_status === "completed"
                          ? "Feito"
                          : b.checkin_status === "none"
                            ? "—"
                            : "Enviado"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {open && (
        <Detail
          b={open}
          questions={data?.config.checkin_questions || []}
          busy={busy}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setEditing({ booking: open });
            setOpen(null);
          }}
          act={act}
          onCancel={() => {
            setReason("");
            setCancelling(open);
          }}
        />
      )}
      {editing && data && (
        <BookingDialog
          overview={data}
          booking={editing.booking}
          initial={editing.initial}
          onClose={() => setEditing(null)}
          onDone={async (b) => {
            setEditing(null);
            setOpen(b);
            await reload();
          }}
        />
      )}
      {cancelling && (
        <Dialog
          title={`Cancelar a reserva #${cancelling.number}?`}
          onClose={() => setCancelling(null)}
          size="sm"
          footer={
            <>
              <Button secondary onClick={() => setCancelling(null)}>
                Voltar
              </Button>
              <Button
                variant="danger"
                busy={busy}
                onClick={() =>
                  run(
                    async () => {
                      await write(
                        `${base}/bookings/${cancelling.id}/cancel`,
                        "POST",
                        {
                          reason: reason.trim(),
                        },
                      );
                      setCancelling(null);
                      setOpen(null);
                      await reload();
                    },
                    { success: "Reserva cancelada." },
                  )
                }
              >
                Cancelar reserva
              </Button>
            </>
          }
        >
          <p>
            A unidade fica livre de novo.
            {cancelling.conversation_id
              ? " O cliente recebe o aviso no WhatsApp."
              : ""}
            {cancelling.payment_status === "paid"
              ? " O sinal já foi pago: a devolução é feita no painel do Mercado Pago."
              : ""}
          </p>
          <Field
            label="Motivo (opcional)"
            value={reason}
            onChange={setReason}
            maxLength={300}
          />
        </Dialog>
      )}
    </>
  );
}
