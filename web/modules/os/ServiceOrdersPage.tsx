// Ordens de serviço (módulo "os", docs/ORDEM-DE-SERVICO.md): lista com filtro
// por estado e busca, abertura no balcão, detalhe com histórico, mudança de
// estado e edição do orçamento. Todas as escritas levam Idempotency-Key.
import React, { useEffect, useState } from "react";
import {
  Pencil,
  Plus,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wrench,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { date } from "../../lib/format";
import {
  Button,
  Chip,
  Dialog,
  Empty,
  Field,
  Notice,
  Pill,
  SearchBox,
  SkeletonRows,
  Table,
  toast,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import {
  cents,
  day,
  dueFromInput,
  dueToInput,
  money,
  moveLabels,
  phoneLabel,
  statusLabels,
  statusOrder,
  statusTones,
} from "./shared";
import "./os.css";
import type { Order } from "./work-contracts";
import { DecisionDialog, ReasonDialog, WorkQuoteCommercial, needsReason, reasonTitle } from "./work/WorkQuoteCommercial";
import { OrderContractPanel, OrderSchedulePanel } from "./maintenance/OrderPanels";

const StatusPill = ({ status }: { status: string }) => (
  <Pill tone={statusTones[status] || "muted"}>
    {statusLabels[status] || status}
  </Pill>
);

function useOsWrite() {
  const app = useApp();
  const write = useIntents(app.api);
  return (path: string, method: string, body: Row = {}) =>
    write(`${app.root}/service-orders${path}`, method, body);
}

function people(team: Row[]) {
  return team
    .filter((member) => member.kind === "user")
    .map((member) => ({ id: member.id, name: member.name }));
}

export function OrderForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  onClose: () => void;
  onSaved: (order: Row) => void;
}) {
  const app = useApp();
  const write = useOsWrite();
  const [draft, setDraft] = useState<Row>(() => ({
    customer_name: initial?.customer?.name || "",
    phone: initial?.customer?.phone || "",
    item: initial?.item || "",
    problem: initial?.problem || "",
    notes: initial?.notes || "",
    assignee: initial?.assignee || "",
    due: dueToInput(initial?.due_at),
  }));
  const set = (key: string) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const closed =
    !!initial && ["delivered", "cancelled"].includes(initial.status);
  return (
    <FormDialog
      title={
        initial ? `Editar ordem nº ${initial.number}` : "Nova ordem de serviço"
      }
      subtitle={
        initial
          ? undefined
          : "Para abrir a partir de uma conversa, use a ação Abrir ordem de serviço do atendimento ou o item do menu do WhatsApp."
      }
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = closed
          ? { notes: draft.notes }
          : {
              customer_name: draft.customer_name,
              item: draft.item,
              problem: draft.problem,
              notes: draft.notes,
              assignee: draft.assignee || null,
              due_at: dueFromInput(draft.due),
            };
        if (!closed && (!initial || !initial.customer?.conversation_id))
          body.phone = draft.phone;
        const saved = initial
          ? await write(`/${initial.id}`, "PATCH", body)
          : await write("", "POST", body);
        toast(
          initial ? "Ordem atualizada." : `Ordem nº ${saved.number} aberta.`,
        );
        onSaved(saved);
      }}
    >
      {closed && (
        <Notice>
          Ordem encerrada: só as observações internas podem mudar.
        </Notice>
      )}
      <div className="form-field-grid">
        <Field
          label="Cliente"
          value={draft.customer_name}
          onChange={set("customer_name")}
          maxLength={120}
          disabled={closed}
        />
        <Field
          label="Telefone (WhatsApp)"
          value={draft.phone}
          onChange={set("phone")}
          maxLength={40}
          required={!initial}
          disabled={closed || !!initial?.customer?.conversation_id}
          help={
            initial?.customer?.conversation_id
              ? "Ligada a uma conversa do WhatsApp."
              : "Com DDD. O cliente acompanha pelo menu do WhatsApp com este número."
          }
        />
      </div>
      <Field
        label="Item ou equipamento"
        value={draft.item}
        onChange={set("item")}
        maxLength={200}
        required
        disabled={closed}
        placeholder="Ex.: celular Moto G84, bicicleta aro 29, terno azul"
      />
      <Field
        label="Relato do problema"
        type="textarea"
        rows={3}
        value={draft.problem}
        onChange={set("problem")}
        maxLength={2000}
        required
        disabled={closed}
      />
      <Field
        label="Observações internas"
        type="textarea"
        rows={2}
        value={draft.notes}
        onChange={set("notes")}
        maxLength={4000}
        help="Só a equipe vê. Ex.: acessórios deixados, senha do aparelho, estado da peça."
      />
      <div className="form-field-grid">
        <Field
          label="Responsável"
          value={draft.assignee}
          onChange={set("assignee")}
          options={people(app.team)}
          emptyOption="Sem responsável"
          disabled={closed}
        />
        <Field
          label="Prazo previsto"
          type="date"
          value={draft.due}
          onChange={set("due")}
          disabled={closed}
        />
      </div>
    </FormDialog>
  );
}

export function OrderDetail({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const write = useOsWrite();
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/service-orders/${id}`);
  const [editing, setEditing] = useState<"data" | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [decisionFor, setDecisionFor] = useState<"approve" | "decline" | null>(null);
  const order: Row | null = resource.data;
  const after = async (promise: Promise<any>, success: string) =>
    run(
      async () => {
        await promise;
        await resource.reload();
        onChanged();
      },
      { success },
    );
  const name = (actor: string) =>
    actor?.startsWith("customer:")
      ? "Cliente pelo WhatsApp"
      : actor === "customer"
        ? "Cliente"
        : app.names[actor] || actor;
  if (!order)
    return (
      <Dialog title="Ordem de serviço" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const moves: string[] = order.next_statuses.filter(
    (status: string) => !["quoted", "approved", "declined"].includes(status),
  );
  const quote = order.quote;
  return (
    <>
      <Dialog
        title={`Ordem de serviço nº ${order.number}`}
        subtitle={
          <>
            <StatusPill status={order.status} /> Aberta em {date(order.created)}
          </>
        }
        onClose={onClose}
        size="lg"
        footer={
          <>
            <Button
              secondary
              icon={<Pencil size={16} />}
              onClick={() => setEditing("data")}
            >
              Editar dados
            </Button>
            {moves.map((status) => (
              <Button
                key={status}
                variant={status === "cancelled" ? "danger" : "secondary"}
                disabled={busy}
                onClick={() =>
                  // OS3: cancelar e voltar etapa pedem motivo antes de enviar.
                  needsReason(order.status, status)
                    ? setReasonFor(status)
                    : void after(
                        write(`/${order.id}/status`, "POST", { status }),
                        `Ordem: ${statusLabels[status]}.`,
                      )
                }
              >
                {moveLabels[status] || statusLabels[status]}
              </Button>
            ))}
          </>
        }
      >
        <dl className="os-facts">
          <dt>Cliente</dt>
          <dd>
            {order.customer.name || "Sem nome"} ·{" "}
            {phoneLabel(order.customer.phone)}
            {order.customer.conversation_id ? " · conversa no WhatsApp" : ""}
          </dd>
          <dt>Item</dt>
          <dd>{order.item}</dd>
          <dt>Problema</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{order.problem}</dd>
          {order.notes && (
            <>
              <dt>Observações internas</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{order.notes}</dd>
            </>
          )}
          <dt>Responsável</dt>
          <dd>{order.assignee ? name(order.assignee) : "—"}</dd>
          <dt>Prazo previsto</dt>
          <dd>{day(order.due_at)}</dd>
          {order.terms && (
            <>
              <dt>Termos</dt>
              <dd>Aceitos pelo cliente em {date(order.terms.accepted_at)}</dd>
            </>
          )}
          {order.warranty_until && (
            <>
              <dt>Garantia</dt>
              <dd>Até {day(order.warranty_until)}</dd>
            </>
          )}
        </dl>
        {/* OS4: contrato que cobre a ordem e execução agendada. */}
        <OrderContractPanel order={order as Order} onChanged={() => { void resource.reload(); onChanged(); }} />
        <OrderSchedulePanel order={order as Order} onChanged={onChanged} />

        <section className="card">
          <div className="section-heading">
            <h3>Orçamento</h3>
            {quote && (
              <Pill
                tone={
                  quote.expired && order.status === "quoted"
                    ? "danger"
                    : "muted"
                }
              >
                {quote.sent_at
                  ? quote.expired
                    ? `Venceu em ${day(quote.valid_until)}`
                    : `Válido até ${day(quote.valid_until)}`
                  : "Não enviado"}
              </Pill>
            )}
          </div>
          {quote?.note ? <p className="muted">{quote.note}</p> : null}
          {order.decision && (
            <p className="muted">
              Registrado por {name(order.decision.by)} em {date(order.decision.at)}
            </p>
          )}
          <WorkQuoteCommercial
            order={order as Order}
            editable={["received", "analyzing", "quoted", "declined"].includes(order.status)}
            onChanged={() => {
              void resource.reload();
              onChanged();
            }}
          />
          <div className="card-actions">
            {quote && order.next_statuses.includes("quoted") && (
              <Button
                icon={<Send size={16} />}
                disabled={busy}
                onClick={() =>
                  void after(
                    write(`/${order.id}/quote/send`, "POST", {
                      notify: !!order.customer.conversation_id,
                    }),
                    order.customer.conversation_id
                      ? "Orçamento enviado pelo WhatsApp."
                      : "Orçamento registrado (sem conversa no WhatsApp).",
                  )
                }
              >
                {order.status === "quoted"
                  ? "Reenviar orçamento"
                  : "Enviar orçamento"}
              </Button>
            )}
            {order.status === "quoted" && (
              <>
                <Button
                  secondary
                  icon={<ThumbsUp size={16} />}
                  disabled={busy || quote?.expired}
                  onClick={() => setDecisionFor("approve")}
                >
                  Cliente aprovou
                </Button>
                <Button
                  secondary
                  icon={<ThumbsDown size={16} />}
                  disabled={busy || quote?.expired}
                  onClick={() => setDecisionFor("decline")}
                >
                  Cliente recusou
                </Button>
              </>
            )}
          </div>
        </section>

        <h3>Histórico</h3>
        <ol className="os-history">
          {(order.history || [])
            .slice()
            .reverse()
            .map((entry: Row) => (
              <li key={entry.id}>
                <strong>
                  {entry.kind === "opened"
                    ? "Ordem aberta"
                    : entry.kind === "edit"
                      ? "Dados alterados"
                      : entry.from_status === entry.to_status
                        ? "Orçamento"
                        : `${statusLabels[entry.from_status] || "—"} → ${statusLabels[entry.to_status]}`}
                </strong>{" "}
                <span className="muted">
                  {name(entry.actor)} · {date(entry.created)}
                </span>
                {entry.note && <div>{entry.note}</div>}
              </li>
            ))}
        </ol>
      </Dialog>
      {editing === "data" && (
        <OrderForm
          initial={order}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void resource.reload();
            onChanged();
          }}
        />
      )}
      {reasonFor && (
        <ReasonDialog
          title={reasonTitle(order.status, reasonFor)}
          danger={reasonFor === "cancelled"}
          submitLabel={reasonFor === "cancelled" ? "Cancelar a ordem" : moveLabels[reasonFor] || statusLabels[reasonFor]}
          onClose={() => setReasonFor(null)}
          onSubmit={async (note) => {
            const status = reasonFor;
            setReasonFor(null);
            await after(write(`/${order.id}/status`, "POST", { status, note }), `Ordem: ${statusLabels[status]}.`);
          }}
        />
      )}
      {decisionFor && (
        <DecisionDialog
          order={order as Order}
          decision={decisionFor}
          onClose={() => setDecisionFor(null)}
          onSubmit={async ({ note, detail }) => {
            const decision = decisionFor;
            setDecisionFor(null);
            await after(
              write(`/${order.id}/decision`, "POST", { decision, quote_version: order.quote?.version, ...(note ? { note } : {}), detail }),
              decision === "approve" ? "Aprovação registrada." : "Recusa registrada.",
            );
          }}
        />
      )}
    </>
  );
}

export function ServiceOrdersPage({ typeId }: { typeId?: "service_order" } = {}) {
  const app = useApp();
  const [filter, setFilter] = useState<string>("open");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams();
  if (typeId) params.set("type_id", typeId);
  if (filter === "open") params.set("open", "1");
  else if (filter !== "all") params.set("status", filter);
  if (query) params.set("q", query);
  const list = useList(`${app.root}/service-orders?${params.toString()}`);
  const counts: Row = list.raw?.counts || {};
  const openCount = statusOrder
    .filter((s) => !["delivered", "cancelled"].includes(s))
    .reduce((sum, s) => sum + (counts[s] || 0), 0);
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Buscar por número, cliente, telefone ou item"
        />
        <Button icon={<Plus size={17} />} onClick={() => setCreating(true)}>
          Nova ordem
        </Button>
      </div>
      <div className="chip-row" role="group" aria-label="Filtrar por estado">
        <Chip
          active={filter === "open"}
          count={openCount}
          onClick={() => setFilter("open")}
        >
          Abertas
        </Chip>
        {statusOrder.map((status) => (
          <Chip
            key={status}
            active={filter === status}
            count={counts[status] || 0}
            onClick={() => setFilter(status)}
          >
            {statusLabels[status]}
          </Chip>
        ))}
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          Todas
        </Chip>
      </div>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["number", "Nº"],
              [
                "customer",
                "Cliente",
                (row) => (
                  <>
                    {row.customer.name || "Sem nome"}
                    <br />
                    <small className="muted">
                      {phoneLabel(row.customer.phone)}
                    </small>
                  </>
                ),
              ],
              ["item", "Item"],
              ["status", "Estado", (row) => <StatusPill status={row.status} />],
              [
                "quote",
                "Orçamento",
                (row) => (row.quote ? money(row.quote.total_cents) : "—"),
              ],
              ["due_at", "Prazo", (row) => day(row.due_at)],
              ["updated", "Atualizada", (row) => date(row.updated)],
            ]}
            action={(row) => (
              <Button secondary size="sm" onClick={() => setOpenId(row.id)}>
                Abrir
              </Button>
            )}
            empty={
              <Empty
                compact
                icon={<Wrench size={28} />}
                title={
                  query || filter !== "open"
                    ? "Nenhuma ordem encontrada"
                    : "Nenhuma ordem aberta"
                }
                description="Abra pelo botão Nova ordem, pela conversa (Abrir ordem de serviço) ou deixe o cliente abrir pelo menu do WhatsApp."
              />
            }
          />
        )}
        <Pager
          cursor={list.cursor}
          nextCursor={list.nextCursor}
          setCursor={list.setCursor}
        />
      </section>
      {creating && (
        <OrderForm
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={(order) => {
            setCreating(false);
            void list.reload();
            setOpenId(order.id);
          }}
        />
      )}
      {openId && (
        <OrderDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void list.reload()}
        />
      )}
    </>
  );
}
