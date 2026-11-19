import { IntegrationStatus } from '../integrations/IntegrationStatus';
// Pedidos (módulo "pedido", docs/PEDIDO.md): quadro da cozinha com os pedidos
// em andamento por estado, lista de todos os pedidos, detalhe com itens,
// adicionais, observação, endereço, pagamento e histórico, mudança de estado,
// baixa do pagamento, comanda para imprimir e a pausa da loja. Todas as
// escritas levam Idempotency-Key.
import React, { useEffect, useState } from "react";
import {
  CircleDollarSign,
  LayoutGrid,
  List,
  Pause,
  Play,
  Printer,
  QrCode,
  ShoppingBag,
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
  Segmented,
  SkeletonRows,
  Table,
  toast,
  toastError,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import {
  activeStatuses,
  clock,
  columnLabels,
  money,
  moveLabels,
  paymentLabels,
  paymentTones,
  phoneLabel,
  since,
  statusLabels,
  statusOrder,
  statusTones,
} from "./shared";
import { qrEncode, qrPath } from "../../lib/qr-code";
import "./pedido.css";

const StatusPill = ({ status }: { status: string }) => (
  <Pill tone={statusTones[status] || "muted"}>
    {statusLabels[status] || status}
  </Pill>
);

/** "Ana · a caminho · chega 19:40" (módulo Entrega). */
const deliveryText = (d: Row) =>
  [
    d.courier_name || "Sem entregador",
    d.status_label,
    d.eta_at ? `chega ${clock(d.eta_at)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

function usePedidoWrite() {
  const app = useApp();
  const write = useIntents(app.api);
  return (path: string, method: string, body: Row = {}) =>
    write(`${app.root}/pedido${path}`, method, body);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );

/** Abre a comanda numa janela própria e chama a impressão do navegador. */
function printTicket(text: string, title: string) {
  const win = window.open("", "_blank", "width=420,height=640");
  if (!win) {
    toast("Permita janelas pop-up neste endereço para imprimir a comanda.");
    return;
  }
  win.document.write(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;padding:8px}pre{font:12px/1.35 monospace;white-space:pre;margin:0}@page{margin:4mm}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

/**
 * QR da via de entrega desenhado aqui mesmo (web/lib/qr-code.ts, sem rede):
 * o conteúdo é um acesso de uso único e não pode ir a serviço de terceiros.
 */
function qrSvg(text: string, px = 180) {
  const matrix = qrEncode(text);
  const view = matrix.size + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view} ${view}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR da entrega"><rect width="${view}" height="${view}" fill="#fff"/><path d="${qrPath(matrix)}" fill="#000"/></svg>`;
}

/** Via de entrega: comanda, título, QR do entregador e as linhas de uso. */
function printDeliverySlip(slip: Row, title: string) {
  const win = window.open("", "_blank", "width=420,height=760");
  if (!win) {
    toast("Permita janelas pop-up neste endereço para imprimir a via.");
    return;
  }
  win.document.write(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;padding:8px}pre{font:12px/1.35 monospace;white-space:pre;margin:0}.qr{text-align:center;margin:6px 0}@page{margin:4mm}</style></head><body><pre>${escapeHtml(slip.text)}\n\n${escapeHtml(slip.slip_text.title)}</pre><div class="qr">${qrSvg(slip.slip.qr)}</div><pre>${escapeHtml(slip.slip_text.lines)}</pre></body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

function CancelDialog({
  order,
  onClose,
  onDone,
}: {
  order: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const write = usePedidoWrite();
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title={`Cancelar o pedido nº ${order.number}`}
      subtitle={
        order.payment.status === "paid"
          ? "Este pedido já foi pago: depois de cancelar, devolva o valor pelo painel do provedor."
          : "O cliente recebe o aviso com o motivo pelo WhatsApp."
      }
      submitLabel="Cancelar pedido"
      danger
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        await write(`/orders/${order.id}/status`, "POST", {
          status: "cancelled",
          reason,
        });
        toast(`Pedido nº ${order.number} cancelado.`);
        onDone();
      }}
    >
      <Field
        label="Motivo (vai para o cliente)"
        value={reason}
        onChange={setReason}
        maxLength={300}
        placeholder="Ex.: acabou o pão; cliente desistiu pelo telefone."
      />
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
  const write = usePedidoWrite();
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/pedido/orders/${id}`);
  const [cancelling, setCancelling] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [slip, setSlip] = useState<Row | null>(null);
  const order: Row | null = resource.data;
  const after = async (promise: () => Promise<any>, success: string) =>
    run(
      async () => {
        await promise();
        await resource.reload();
        onChanged();
      },
      { success },
    );
  const name = (actor: string) =>
    actor === "customer"
      ? "Cliente"
      : actor === "provider"
        ? "Provedor de pagamento"
        : actor === "system"
          ? "Wabotia"
          : app.names[actor] || actor;
  if (!order)
    return (
      <Dialog title="Pedido" onClose={onClose} size="lg">
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
    (status: string) => status !== "cancelled",
  );
  const payment = order.payment;
  // Pedido de mesa (módulo Mesas): paga-se a conta da mesa, não o pedido.
  const table = order.fulfillment === "table";
  const canMarkPaid =
    !["paid", "awaiting", "tab"].includes(payment.status) &&
    order.status !== "cancelled";
  const moveLabel = (status: string) =>
    table && status === "ready"
      ? "Pronto para servir"
      : table && status === "delivered"
        ? "Servido"
        : moveLabels[status] || statusLabels[status];
  return (
    <>
      <Dialog
        title={`Pedido nº ${order.number}`}
        subtitle={
          <>
            <StatusPill status={order.status} /> {order.fulfillment_label} ·
            feito às {clock(order.created)}
          </>
        }
        onClose={onClose}
        size="lg"
        footer={
          <>
            <Button
              secondary
              icon={<Printer size={16} />}
              onClick={() =>
                // Leitura: funciona também na demonstração.
                void app
                  .api(
                    `${app.root}/pedido/orders/${order.id}/ticket?columns=32`,
                  )
                  .then((result) => setTicket(result.text))
                  .catch((error) => toastError(error))
              }
            >
              Comanda
            </Button>
            {order.fulfillment === "delivery" &&
              order.next_statuses.length > 0 &&
              app.moduleOn("entrega") && (
                <Button
                  secondary
                  icon={<QrCode size={16} />}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      // Escrita: gerar de novo revoga o QR anterior.
                      const result = await write(
                        `/orders/${order.id}/delivery-slip`,
                        "POST",
                        { columns: 32 },
                      );
                      setSlip(result);
                      await resource.reload();
                    }, {})
                  }
                >
                  Via de entrega
                </Button>
              )}
            {order.next_statuses.includes("cancelled") && (
              <Button variant="danger" onClick={() => setCancelling(true)}>
                Cancelar
              </Button>
            )}
            {moves.map((status, index) => (
              <Button
                key={status}
                variant={index === 0 ? "primary" : "secondary"}
                disabled={busy}
                onClick={() =>
                  void after(
                    () =>
                      write(`/orders/${order.id}/status`, "POST", { status }),
                    `Pedido nº ${order.number}: ${moveLabel(status)}.`,
                  )
                }
              >
                {moveLabel(status)}
              </Button>
            ))}
          </>
        }
      >
        <IntegrationStatus module={order.tab_id ? "mesas" : "pedido"} sourceId={order.integration?.source_id || order.tab_id || order.id} />
        {order.status === "awaiting_payment" && (
          <Notice tone="warn">
            {payment.status === "choosing"
              ? "O cliente ainda não escolheu como pagar. Você pode escolher por ele abaixo ou mandar para o preparo."
              : payment.status === "awaiting"
                ? "Esperando a confirmação do pagamento online. Ele vai para o preparo sozinho quando o provedor confirmar."
                : "A cobrança online não foi gerada. Combine outra forma com o cliente."}
          </Notice>
        )}
        {payment.needs_refund && (
          <Notice tone="error">
            Pagamento recebido de um pedido cancelado: devolva o valor pelo
            painel do Mercado Pago.
          </Notice>
        )}
        <table className="pedido-lines">
          <tbody>
            {order.lines.map((line: Row, index: number) => (
              <tr key={index}>
                <td>
                  <strong>
                    {line.quantity}x {line.name}
                  </strong>
                  {line.options.map((option: Row) => (
                    <small key={option.group_id + option.id}>
                      {option.group}: {option.name}
                      {option.price_cents
                        ? ` (+ ${money(option.price_cents)})`
                        : ""}
                    </small>
                  ))}
                  {line.note && <small>Obs.: {line.note}</small>}
                </td>
                <td>{money(line.total_cents)}</td>
              </tr>
            ))}
            <tr>
              <td>Subtotal</td>
              <td>{money(order.subtotal_cents)}</td>
            </tr>
            {order.fulfillment === "delivery" && (
              <tr>
                <td>Entrega</td>
                <td>{money(order.delivery_fee_cents)}</td>
              </tr>
            )}
            <tr className="total">
              <td>Total</td>
              <td>{money(order.total_cents)}</td>
            </tr>
          </tbody>
        </table>
        <dl className="pedido-facts">
          <dt>Cliente</dt>
          <dd>
            {order.customer.name || "Sem nome"} ·{" "}
            {phoneLabel(order.customer.phone)}
            {order.customer.conversation_id ? " · conversa no WhatsApp" : ""}
          </dd>
          <dt>
            {order.fulfillment === "delivery"
              ? "Entregar em"
              : table
                ? "Mesa"
                : "Retirada"}
          </dt>
          <dd>
            {order.fulfillment === "delivery"
              ? order.address_text || "—"
              : table
                ? order.fulfillment_label
                : "No balcão"}
          </dd>
          {order.delivery && (
            <>
              <dt>Entrega</dt>
              <dd>{deliveryText(order.delivery)}</dd>
            </>
          )}
          {order.note && (
            <>
              <dt>Observação do cliente</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{order.note}</dd>
            </>
          )}
          <dt>Pagamento</dt>
          <dd>
            {payment.method ? paymentLabels[payment.method] : "A definir"}{" "}
            <Pill tone={paymentTones[payment.status] || "muted"}>
              {payment.status_label}
            </Pill>
            {payment.change_for_cents
              ? ` · troco para ${money(payment.change_for_cents)}`
              : ""}
            {payment.error ? ` · ${payment.error}` : ""}
          </dd>
          {order.eta_at && (
            <>
              <dt>Previsão</dt>
              <dd>{clock(order.eta_at)}</dd>
            </>
          )}
          {order.notes && (
            <>
              <dt>Observações internas</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{order.notes}</dd>
            </>
          )}
          {order.cancel_reason && (
            <>
              <dt>Motivo do cancelamento</dt>
              <dd>{order.cancel_reason}</dd>
            </>
          )}
        </dl>
        <div className="card-actions">
          {order.status === "awaiting_payment" &&
            ["choosing", "failed"].includes(payment.status) &&
            ["cash", "card"].map((method) => (
              <Button
                key={method}
                secondary
                size="sm"
                disabled={busy}
                onClick={() =>
                  void after(
                    () =>
                      write(`/orders/${order.id}/payment`, "POST", { method }),
                    `Pagamento: ${paymentLabels[method]}.`,
                  )
                }
              >
                Vai pagar com {paymentLabels[method].toLowerCase()}
              </Button>
            ))}
          {canMarkPaid && (
            <Button
              secondary
              size="sm"
              icon={<CircleDollarSign size={16} />}
              disabled={busy}
              onClick={() =>
                void after(
                  () => write(`/orders/${order.id}/paid`, "POST", {}),
                  "Pagamento registrado.",
                )
              }
            >
              Registrar pagamento recebido
            </Button>
          )}
        </div>
        {ticket !== null && (
          <section className="card">
            <div className="section-heading">
              <h3>Comanda</h3>
              <Button
                size="sm"
                icon={<Printer size={16} />}
                onClick={() => printTicket(ticket, `Pedido ${order.number}`)}
              >
                Imprimir
              </Button>
            </div>
            <pre className="pedido-ticket">{ticket}</pre>
          </section>
        )}
        {slip !== null && (
          <section className="card">
            <div className="section-heading">
              <h3>Via de entrega</h3>
              <Button
                size="sm"
                icon={<Printer size={16} />}
                onClick={() =>
                  printDeliverySlip(slip, `Entrega ${order.number}`)
                }
              >
                Imprimir
              </Button>
            </div>
            <p className="muted">
              O entregador lê o QR no app Wabotia (Escanear pedido). Vale uma
              leitura
              {slip.slip.expires_at
                ? `, até ${clock(slip.slip.expires_at)}`
                : ""}
              ; gerar de novo invalida este.
            </p>
            <div
              className="pedido-qr"
              // SVG gerado aqui a partir do texto do QR (sem HTML externo).
              dangerouslySetInnerHTML={{ __html: qrSvg(slip.slip.qr, 200) }}
            />
            <pre className="pedido-ticket">
              {slip.slip_text.title}
              {"\n"}
              {slip.slip_text.lines}
            </pre>
          </section>
        )}
        <h3>Histórico</h3>
        <ol className="pedido-history">
          {(order.history || [])
            .slice()
            .reverse()
            .map((entry: Row) => (
              <li key={entry.id}>
                <strong>
                  {entry.kind === "created"
                    ? "Pedido feito"
                    : entry.kind === "payment"
                      ? "Pagamento"
                      : entry.kind === "edit"
                        ? "Dados alterados"
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
      {cancelling && (
        <CancelDialog
          order={order}
          onClose={() => setCancelling(false)}
          onDone={() => {
            setCancelling(false);
            void resource.reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** Quadro da cozinha: uma coluna por estado em andamento. */
function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const app = useApp();
  const write = usePedidoWrite();
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/pedido/board`);
  const view: Row | null = resource.data;
  if (!view)
    return resource.error ? (
      <Notice tone="error" onRetry={() => void resource.reload()}>
        {resource.error}
      </Notice>
    ) : (
      <SkeletonRows rows={4} avatar={false} />
    );
  const store = view.store;
  return (
    <>
      <section className="card pedido-store">
        <Pill tone={store.open ? "ok" : store.paused ? "warn" : "muted"}>
          {store.open
            ? "Loja aberta"
            : store.paused
              ? "Pausada: não recebe pedidos"
              : "Fora do horário"}
        </Pill>
        <span className="muted">
          Hoje: {view.today.orders}{" "}
          {view.today.orders === 1 ? "pedido" : "pedidos"} ·{" "}
          {money(view.today.total_cents)}
        </span>
        <span className="spacer" />
        <Button
          secondary
          size="sm"
          busy={busy}
          icon={store.paused ? <Play size={16} /> : <Pause size={16} />}
          onClick={() =>
            void run(
              async () => {
                await write("/store/pause", "POST", { paused: !store.paused });
                await resource.reload();
              },
              {
                success: store.paused
                  ? "A loja voltou a receber pedidos."
                  : "Loja pausada: o cardápio responde que não estamos recebendo pedidos.",
              },
            )
          }
        >
          {store.paused ? "Voltar a receber pedidos" : "Pausar a loja"}
        </Button>
      </section>
      <div className="pedido-board">
        {view.columns.map((column: Row) => (
          <section
            className="pedido-column"
            key={column.status}
            aria-label={columnLabels[column.status]}
          >
            <h3>
              <Pill tone={statusTones[column.status]}>
                {columnLabels[column.status]}
              </Pill>
              <b>{column.orders.length}</b>
            </h3>
            {column.orders.map((order: Row) => (
              <button
                type="button"
                key={order.id}
                className={"pedido-card" + (order.late ? " late" : "")}
                onClick={() => onOpen(order.id)}
              >
                <span className="pedido-card-top">
                  <strong>Nº {order.number}</strong>
                  <span>{order.customer.name || "Sem nome"}</span>
                  <span className="time" title="Tempo neste estado">
                    {since(order.minutes_in_status)}
                  </span>
                </span>
                <ul>
                  {order.lines.slice(0, 4).map((line: Row, index: number) => (
                    <li key={index}>
                      {line.quantity}x {line.name}
                      {line.options.length
                        ? ` (${line.options.map((o: Row) => o.name).join(", ")})`
                        : ""}
                    </li>
                  ))}
                  {order.lines.length > 4 && (
                    <li>+ {order.lines.length - 4} itens</li>
                  )}
                </ul>
                {order.delivery && (
                  <span className="pedido-delivery">
                    {deliveryText(order.delivery)}
                  </span>
                )}
                <span className="meta">
                  <span>{order.fulfillment_label}</span>
                  <span>{money(order.total_cents)}</span>
                  <Pill tone={paymentTones[order.payment.status] || "muted"}>
                    {order.payment.method
                      ? paymentLabels[order.payment.method]
                      : order.payment.status === "tab"
                        ? "Na conta"
                        : "A definir"}
                    {order.payment.status === "paid" ? " · pago" : ""}
                  </Pill>
                </span>
              </button>
            ))}
            {!column.orders.length && (
              <p className="muted" style={{ margin: "4px" }}>
                Nenhum pedido.
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function AllOrders({ onOpen }: { onOpen: (id: string) => void }) {
  const app = useApp();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams();
  if (filter === "open") params.set("open", "1");
  else if (filter !== "all") params.set("status", filter);
  if (query) params.set("q", query);
  const list = useList(`${app.root}/pedido/orders?${params.toString()}`);
  const counts: Row = list.raw?.counts || {};
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Buscar por número, cliente ou telefone"
        />
      </div>
      <div className="chip-row" role="group" aria-label="Filtrar por estado">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          Todos
        </Chip>
        <Chip
          active={filter === "open"}
          count={activeStatuses.reduce((sum, s) => sum + (counts[s] || 0), 0)}
          onClick={() => setFilter("open")}
        >
          Em andamento
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
              ["status", "Estado", (row) => <StatusPill status={row.status} />],
              ["fulfillment", "Como", (row) => row.fulfillment_label],
              ["total", "Total", (row) => money(row.total_cents)],
              [
                "payment",
                "Pagamento",
                (row) => (
                  <Pill tone={paymentTones[row.payment.status] || "muted"}>
                    {row.payment.method
                      ? paymentLabels[row.payment.method]
                      : "A definir"}
                    {row.payment.status === "paid" ? " · pago" : ""}
                  </Pill>
                ),
              ],
              ["created", "Feito em", (row) => date(row.created)],
            ]}
            action={(row) => (
              <Button secondary size="sm" onClick={() => onOpen(row.id)}>
                Abrir
              </Button>
            )}
            empty={
              <Empty
                compact
                icon={<ShoppingBag size={28} />}
                title="Nenhum pedido encontrado"
                description="Os pedidos chegam pelo item Cardápio do menu do WhatsApp, pelo catálogo da Meta ou pela ação Montar pedido da conversa."
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
    </>
  );
}

export function OrdersPage() {
  const [tab, setTab] = useState<"board" | "all">("board");
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Visão dos pedidos"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "board",
              label: "Quadro da cozinha",
              icon: <LayoutGrid size={16} />,
            },
            {
              value: "all",
              label: "Todos os pedidos",
              icon: <List size={16} />,
            },
          ]}
        />
      </div>
      {tab === "board" ? (
        <Board key={version} onOpen={setOpenId} />
      ) : (
        <AllOrders onOpen={setOpenId} />
      )}
      {openId && (
        <OrderDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
    </>
  );
}
