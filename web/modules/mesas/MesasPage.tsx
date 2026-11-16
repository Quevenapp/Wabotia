// Mesas (módulo "mesas", docs/MESAS.md): mapa das mesas e comandas com o
// estado (livre, ocupada, fechando), a conta de cada uma, lançar itens para a
// cozinha do Pedido, pedir a conta, pagamentos parciais, conta dividida para
// imprimir, transferir, juntar e fechar. O garçom usa o app; esta é a tela
// mínima do painel. Todas as escritas levam Idempotency-Key.
import React, { useMemo, useState } from "react";
import {
  Armchair,
  ArrowRightLeft,
  CircleDollarSign,
  Combine,
  Plus,
  Printer,
  Receipt,
  Settings2,
  Trash2,
} from "lucide-react";
import { useApp, useAppEvents } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { date } from "../../lib/format";
import {
  Button,
  Dialog,
  Empty,
  Field,
  Notice,
  Pill,
  SkeletonRows,
  Switch,
  toast,
  toastError,
} from "../../ui";
import { FormDialog, useResource } from "../../admin/shared";
import { OrderDetail } from "../pedido/OrdersPage";
import {
  cents,
  centsInput,
  clock,
  money,
  since,
  statusTones,
} from "../pedido/shared";
import "./mesas.css";

const stateTones: Record<string, "ok" | "warn" | "brand" | "muted"> = {
  free: "ok",
  occupied: "brand",
  closing: "warn",
};
const payLabels: Record<string, string> = {
  cash: "Dinheiro",
  card: "Cartão",
  pix: "Pix",
  other: "Outro",
};
const PAY_OPTIONS = Object.entries(payLabels);

function useMesasWrite() {
  const app = useApp();
  const write = useIntents(app.api);
  return (path: string, method: string, body: Row = {}) =>
    write(`${app.root}/mesas${path}`, method, body);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );

function printText(text: string, title: string) {
  const win = window.open("", "_blank", "width=420,height=640");
  if (!win) {
    toast("Permita janelas pop-up neste endereço para imprimir a conta.");
    return;
  }
  win.document.write(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;padding:8px}pre{font:12px/1.35 monospace;white-space:pre;margin:0}@page{margin:4mm}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

/** Rótulo do estado do pedido na mesa (pronto é "para servir"). */
const orderStatus = (status: string, label: string) =>
  status === "ready" ? "Pronto para servir" : label;

// ---------------------------------------------------------------------------
// Abrir a mesa

function OpenDialog({
  table,
  onClose,
  onOpened,
}: {
  table: Row;
  onClose: () => void;
  onOpened: (tabId: string) => void;
}) {
  const write = useMesasWrite();
  const [guests, setGuests] = useState("");
  const [name, setName] = useState("");
  return (
    <FormDialog
      title={`Abrir ${table.name}`}
      submitLabel="Abrir a mesa"
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        const tab = await write("/tabs", "POST", {
          table_id: table.id,
          guests: Number(guests) || 0,
          customer_name: name,
        });
        toast(`${table.name} aberta.`);
        onOpened(tab.id);
      }}
    >
      <Field
        label="Pessoas na mesa"
        type="number"
        min={0}
        max={99}
        value={guests}
        onChange={setGuests}
      />
      <Field
        label="Nome do cliente (opcional)"
        value={name}
        onChange={setName}
        maxLength={80}
      />
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Lançar itens: cardápio do Pedido, montagem com adicionais e observação.

interface Draft {
  item: Row;
  quantity: number;
  options: Record<string, string[]>;
  note: string;
}

function draftCents(d: Draft) {
  const extra = d.item.option_groups
    .flatMap((g: Row) =>
      g.options.filter((o: Row) => (d.options[g.id] || []).includes(o.id)),
    )
    .reduce((sum: number, o: Row) => sum + (o.price_cents || 0), 0);
  return (d.item.price_cents + extra) * d.quantity;
}

function ItemEditor({
  item,
  onAdd,
  onCancel,
}: {
  item: Row;
  onAdd: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
  const draft = { item, quantity, options, note };
  const missing = item.option_groups.find(
    (g: Row) => (options[g.id] || []).length < g.min,
  );
  const toggle = (group: Row, id: string) =>
    setOptions((current) => {
      const chosen = current[group.id] || [];
      if (chosen.includes(id))
        return { ...current, [group.id]: chosen.filter((x) => x !== id) };
      if (group.max === 1) return { ...current, [group.id]: [id] };
      if (chosen.length >= group.max) return current;
      return { ...current, [group.id]: [...chosen, id] };
    });
  return (
    <section className="card mesas-editor">
      <div className="section-heading">
        <h3>{item.name}</h3>
        <span>{money(draftCents(draft))}</span>
      </div>
      {item.option_groups.map((group: Row) => (
        <fieldset key={group.id} className="mesas-group">
          <legend>
            {group.name}{" "}
            <small className="muted">
              {group.min ? `escolha ${group.min}` : "opcional"}
              {group.max > 1 ? `, até ${group.max}` : ""}
            </small>
          </legend>
          {group.options.map((option: Row) => (
            <label key={option.id} className="mesas-option">
              <input
                type={group.max === 1 ? "radio" : "checkbox"}
                name={`${item.id}-${group.id}`}
                disabled={!option.available}
                checked={(options[group.id] || []).includes(option.id)}
                onChange={() => toggle(group, option.id)}
              />
              <span>
                {option.name}
                {option.price_cents ? ` (+ ${money(option.price_cents)})` : ""}
                {!option.available ? " · esgotado" : ""}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="mesas-row">
        <Field
          label="Quantidade"
          type="number"
          min={1}
          max={item.max_quantity || 20}
          value={String(quantity)}
          onChange={(v) => setQuantity(Math.max(1, Number(v) || 1))}
        />
        <Field
          label="Observação"
          value={note}
          onChange={setNote}
          maxLength={140}
          placeholder="Ex.: sem cebola"
        />
      </div>
      <div className="card-actions">
        <Button secondary size="sm" onClick={onCancel}>
          Voltar
        </Button>
        <Button
          size="sm"
          disabled={!!missing}
          onClick={() => onAdd(draft)}
          icon={<Plus size={16} />}
        >
          {missing ? `Escolha ${missing.name.toLowerCase()}` : "Adicionar"}
        </Button>
      </div>
    </section>
  );
}

function AddItemsDialog({
  tab,
  onClose,
  onSent,
}: {
  tab: Row;
  onClose: () => void;
  onSent: () => void;
}) {
  const app = useApp();
  const write = useMesasWrite();
  const { busy, run } = useAction();
  const menu = useResource(`${app.root}/pedido/menu`);
  const [editing, setEditing] = useState<Row | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [note, setNote] = useState("");
  const categories: Row[] = menu.data?.categories || [];
  const groups: Row[] = menu.data?.groups || [];
  // GET pedido/menu traz os grupos à parte; o item só tem group_ids.
  const expand = (item: Row): Row => ({
    ...item,
    option_groups: (item.group_ids || [])
      .map((id: string) => groups.find((g) => g.id === id))
      .filter(Boolean),
  });
  const total = drafts.reduce((sum, d) => sum + draftCents(d), 0);
  const send = () =>
    run(
      async () => {
        await write(`/tabs/${tab.id}/orders`, "POST", {
          items: drafts.map((d) => ({
            item_id: d.item.id,
            quantity: d.quantity,
            options: d.options,
            ...(d.note ? { note: d.note } : {}),
          })),
          ...(note ? { note } : {}),
        });
        onSent();
      },
      { success: `Pedido de ${tab.table.name} enviado para a cozinha.` },
    );
  return (
    <Dialog
      title={`Lançar itens · ${tab.table.name}`}
      subtitle="Os itens vão para o quadro da cozinha como um pedido."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button secondary onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!drafts.length || busy}
            busy={busy}
            onClick={() => void send()}
          >
            Enviar para a cozinha · {money(total)}
          </Button>
        </>
      }
    >
      {menu.error && <Notice tone="error">{menu.error}</Notice>}
      {!menu.data && !menu.error && <SkeletonRows rows={4} avatar={false} />}
      {editing ? (
        <ItemEditor
          item={editing}
          onCancel={() => setEditing(null)}
          onAdd={(draft) => {
            setDrafts((list) => [...list, draft]);
            setEditing(null);
          }}
        />
      ) : (
        categories.map((category) => (
          <section key={category.id} className="mesas-category">
            <h3>{category.name}</h3>
            <div className="mesas-items">
              {category.items.map((item: Row) => (
                <button
                  type="button"
                  key={item.id}
                  className="mesas-item"
                  disabled={!item.available}
                  onClick={() => setEditing(expand(item))}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.available ? money(item.price_cents) : "Esgotado"}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
      {!!drafts.length && (
        <section className="card">
          <h3>Neste pedido</h3>
          <ul className="mesas-drafts">
            {drafts.map((d, index) => (
              <li key={index}>
                <span>
                  {d.quantity}x {d.item.name}
                  {Object.values(d.options).flat().length
                    ? ` (${d.item.option_groups
                        .flatMap((g: Row) =>
                          g.options.filter((o: Row) =>
                            (d.options[g.id] || []).includes(o.id),
                          ),
                        )
                        .map((o: Row) => o.name)
                        .join(", ")})`
                    : ""}
                  {d.note ? ` — ${d.note}` : ""}
                </span>
                <span>{money(draftCents(d))}</span>
                <Button
                  size="sm"
                  secondary
                  aria-label="Tirar"
                  icon={<Trash2 size={14} />}
                  onClick={() =>
                    setDrafts((list) => list.filter((_, i) => i !== index))
                  }
                />
              </li>
            ))}
          </ul>
          <Field
            label="Observação para a cozinha"
            value={note}
            onChange={setNote}
            maxLength={300}
          />
        </section>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pagamento (parcial ou fechamento)

function PaymentDialog({
  tab,
  close,
  onClose,
  onDone,
}: {
  tab: Row;
  close: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const write = useMesasWrite();
  const due = tab.bill.due_cents;
  const [method, setMethod] = useState("card");
  const [amount, setAmount] = useState(centsInput(due));
  const [tendered, setTendered] = useState("");
  const value = cents(amount);
  const given = cents(tendered);
  return (
    <FormDialog
      title={close ? `Fechar ${tab.table.name}` : "Pagamento parcial"}
      subtitle={`Falta ${money(due)} de ${money(tab.bill.total_cents)}.`}
      submitLabel={close ? "Fechar a conta" : "Registrar pagamento"}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        const payment = {
          method,
          amount_cents: value,
          ...(method === "cash" && given ? { tendered_cents: given } : {}),
        };
        if (close)
          await write(`/tabs/${tab.id}/close`, "POST", {
            payments: due ? [payment] : [],
          });
        else await write(`/tabs/${tab.id}/payments`, "POST", payment);
        toast(close ? `${tab.table.name} fechada.` : "Pagamento registrado.");
        onDone();
      }}
    >
      {!!due && (
        <>
          <Field
            label="Forma de pagamento"
            value={method}
            onChange={setMethod}
            options={PAY_OPTIONS}
            emptyOption={null}
          />
          <Field
            label="Valor (R$)"
            value={amount}
            onChange={setAmount}
            help={
              close
                ? "Para fechar, o valor precisa cobrir o que falta."
                : "Parte de uma pessoa ou qualquer valor até o que falta."
            }
          />
          {method === "cash" && (
            <Field
              label="Valor entregue (troco)"
              value={tendered}
              onChange={setTendered}
              help={
                given && value && given >= value
                  ? `Troco: ${money(given - value)}`
                  : undefined
              }
            />
          )}
        </>
      )}
      {!due && <p>A conta já está paga. Fechar libera a mesa.</p>}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Conta para imprimir (com divisão)

function BillDialog({ tab, onClose }: { tab: Row; onClose: () => void }) {
  const app = useApp();
  const [split, setSplit] = useState(String(tab.guests > 1 ? tab.guests : ""));
  const people = Number(split);
  const url = `${app.root}/mesas/tabs/${tab.id}/bill?columns=32${people >= 2 ? `&split=${people}` : ""}`;
  const bill = useResource(url);
  return (
    <Dialog
      title={`Conta · ${tab.table.name}`}
      onClose={onClose}
      footer={
        <Button
          icon={<Printer size={16} />}
          disabled={!bill.data}
          onClick={() => printText(bill.data.text, `Conta ${tab.table.name}`)}
        >
          Imprimir
        </Button>
      }
    >
      <Field
        label="Dividir entre (pessoas)"
        type="number"
        min={0}
        max={app.settings.mesas?.split_max || 20}
        value={split}
        onChange={setSplit}
        help="Vazio ou 1: sem divisão."
      />
      {bill.error && <Notice tone="error">{bill.error}</Notice>}
      {bill.data && <pre className="pedido-ticket">{bill.data.text}</pre>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Transferir e juntar

function MoveDialog({
  tab,
  mode,
  tables,
  onClose,
  onDone,
}: {
  tab: Row;
  mode: "transfer" | "merge";
  tables: Row[];
  onClose: () => void;
  onDone: () => void;
}) {
  const write = useMesasWrite();
  const choices = tables.filter((t) =>
    mode === "transfer"
      ? t.state === "free"
      : t.state !== "free" && t.tab?.id !== tab.id,
  );
  const [target, setTarget] = useState("");
  return (
    <FormDialog
      title={
        mode === "transfer"
          ? `Transferir ${tab.table.name}`
          : `Juntar outra mesa em ${tab.table.name}`
      }
      subtitle={
        mode === "transfer"
          ? "A conta, os pedidos e os pagamentos vão para a mesa escolhida."
          : "Os pedidos e pagamentos da mesa escolhida passam para esta, e ela fica livre."
      }
      submitLabel={mode === "transfer" ? "Transferir" : "Juntar"}
      size="sm"
      disabled={!target}
      onClose={onClose}
      onSubmit={async () => {
        await write(`/tabs/${tab.id}/${mode}`, "POST", { table_id: target });
        toast(mode === "transfer" ? "Mesa transferida." : "Mesas juntadas.");
        onDone();
      }}
    >
      {choices.length ? (
        <Field
          label={mode === "transfer" ? "Mesa livre" : "Mesa ocupada"}
          value={target}
          onChange={setTarget}
          options={choices.map((t) => [
            t.id,
            mode === "merge" && t.tab
              ? `${t.name} · ${money(t.tab.bill.total_cents)}`
              : t.name,
          ])}
        />
      ) : (
        <p className="muted">
          {mode === "transfer"
            ? "Nenhuma mesa livre agora."
            : "Nenhuma outra mesa ocupada."}
        </p>
      )}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Conta da mesa

function TabDialog({
  id,
  tables,
  canOperate,
  onClose,
  onChanged,
}: {
  id: string;
  tables: Row[];
  /** Papel Garçom ou administrador; sem ele, só a leitura. */
  canOperate: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const write = useMesasWrite();
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/mesas/tabs/${id}`);
  const [dialog, setDialog] = useState<
    null | "items" | "pay" | "close" | "bill" | "transfer" | "merge" | "cancel"
  >(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const tab: Row | null = resource.data;
  const reload = async () => {
    await resource.reload();
    onChanged();
  };
  const act = (path: string, body: Row, success: string, method = "POST") =>
    run(
      async () => {
        await write(`/tabs/${id}${path}`, method, body);
        await reload();
      },
      { success },
    );
  if (!tab)
    return (
      <Dialog title="Conta" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const live =
    canOperate && (tab.status === "open" || tab.status === "closing");
  const bill = tab.bill;
  return (
    <>
      <Dialog
        title={`${tab.table.name} · conta nº ${tab.number}`}
        subtitle={
          <>
            <Pill tone={tab.status === "closing" ? "warn" : "brand"}>
              {tab.status_label}
            </Pill>{" "}
            {tab.guests ? `${tab.guests} pessoas · ` : ""}aberta às{" "}
            {clock(tab.opened_at)} ({since(tab.minutes_open)})
            {tab.waiter_id ? ` · ${app.names[tab.waiter_id] || "garçom"}` : ""}
          </>
        }
        size="lg"
        onClose={onClose}
        footer={
          live ? (
            <>
              <Button
                secondary
                icon={<Printer size={16} />}
                onClick={() => setDialog("bill")}
              >
                Conta
              </Button>
              {tab.status === "open" ? (
                <Button
                  secondary
                  icon={<Receipt size={16} />}
                  disabled={busy}
                  onClick={() => void act("/bill", {}, "Conta pedida.")}
                >
                  Pedir a conta
                </Button>
              ) : (
                <Button
                  secondary
                  disabled={busy}
                  onClick={() => void act("/reopen", {}, "Conta reaberta.")}
                >
                  Reabrir
                </Button>
              )}
              <Button
                secondary
                icon={<CircleDollarSign size={16} />}
                disabled={!bill.due_cents}
                onClick={() => setDialog("pay")}
              >
                Pagamento parcial
              </Button>
              <Button onClick={() => setDialog("close")}>Fechar a conta</Button>
              <Button
                icon={<Plus size={16} />}
                onClick={() => setDialog("items")}
              >
                Lançar itens
              </Button>
            </>
          ) : (
            <Button
              secondary
              icon={<Printer size={16} />}
              onClick={() => setDialog("bill")}
            >
              Conta
            </Button>
          )
        }
      >
        {bill.overpaid_cents > 0 && (
          <Notice tone="warn">
            Pago a mais: devolva {money(bill.overpaid_cents)} ao cliente.
          </Notice>
        )}
        <h3>Pedidos na cozinha</h3>
        {!tab.orders.length && (
          <p className="muted">Nenhum item lançado ainda.</p>
        )}
        <ul className="mesas-orders">
          {tab.orders.map((order: Row) => (
            <li key={order.id}>
              <button type="button" onClick={() => setOrderId(order.id)}>
                <span className="mesas-order-top">
                  <strong>Nº {order.number}</strong>
                  <Pill tone={statusTones[order.status] || "muted"}>
                    {orderStatus(order.status, order.status_label)}
                  </Pill>
                  <span>{clock(order.created)}</span>
                  <span className="spacer" />
                  <span>{money(order.total_cents)}</span>
                </span>
                <span className="muted">
                  {order.lines
                    .map(
                      (line: Row) =>
                        `${line.quantity}x ${line.name}${
                          line.options.length
                            ? ` (${line.options.map((o: Row) => o.name).join(", ")})`
                            : ""
                        }`,
                    )
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <table className="pedido-lines">
          <tbody>
            <tr>
              <td>Subtotal</td>
              <td>{money(bill.subtotal_cents)}</td>
            </tr>
            <tr>
              <td>
                <span className="mesas-service">
                  Serviço ({String(bill.service_percent).replace(".", ",")}%)
                  {live && bill.service_percent > 0 && (
                    <Switch
                      label="Cobrar taxa de serviço"
                      checked={bill.service_on}
                      busy={busy}
                      onChange={(next) =>
                        void act(
                          "",
                          { service: next },
                          next ? "Taxa incluída." : "Taxa retirada.",
                          "PATCH",
                        )
                      }
                    />
                  )}
                </span>
              </td>
              <td>{money(bill.service_cents)}</td>
            </tr>
            <tr className="total">
              <td>Total</td>
              <td>{money(bill.total_cents)}</td>
            </tr>
            {bill.paid_cents > 0 && (
              <>
                <tr>
                  <td>Pago</td>
                  <td>{money(bill.paid_cents)}</td>
                </tr>
                <tr className="total">
                  <td>A pagar</td>
                  <td>{money(bill.due_cents)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
        {!!tab.payments.length && (
          <>
            <h3>Pagamentos</h3>
            <ul className="mesas-payments">
              {tab.payments.map((p: Row) => (
                <li key={p.id} className={p.status === "void" ? "void" : ""}>
                  <span>
                    {p.method_label} {money(p.amount_cents)}
                    {p.change_cents ? ` · troco ${money(p.change_cents)}` : ""}
                    {p.status === "void"
                      ? ` · desfeito (${p.void_reason})`
                      : ""}
                  </span>
                  <span className="muted">
                    {app.names[p.created_by] || ""} · {clock(p.created)}
                  </span>
                  {live && p.status === "ok" && (
                    <Button
                      size="sm"
                      secondary
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt("Motivo para desfazer:");
                        if (!reason) return;
                        void run(
                          async () => {
                            await write(`/payments/${p.id}/void`, "POST", {
                              reason,
                            });
                            await reload();
                          },
                          { success: "Pagamento desfeito." },
                        );
                      }}
                    >
                      Desfazer
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {live && (
          <div className="card-actions">
            <Button
              secondary
              size="sm"
              icon={<ArrowRightLeft size={16} />}
              onClick={() => setDialog("transfer")}
            >
              Transferir
            </Button>
            <Button
              secondary
              size="sm"
              icon={<Combine size={16} />}
              onClick={() => setDialog("merge")}
            >
              Juntar mesa
            </Button>
            {!tab.orders_count && !bill.paid_cents && (
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act("/cancel", {}, `${tab.table.name} liberada.`)
                }
              >
                Cancelar conta
              </Button>
            )}
          </div>
        )}
        <h3>Histórico</h3>
        <ol className="pedido-history">
          {(tab.history || [])
            .slice()
            .reverse()
            .map((entry: Row) => (
              <li key={entry.id}>
                {entry.note || entry.kind}{" "}
                <span className="muted">
                  {app.names[entry.actor] || entry.actor} ·{" "}
                  {date(entry.created)}
                </span>
              </li>
            ))}
        </ol>
      </Dialog>
      {dialog === "items" && (
        <AddItemsDialog
          tab={tab}
          onClose={() => setDialog(null)}
          onSent={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {(dialog === "pay" || dialog === "close") && (
        <PaymentDialog
          tab={tab}
          close={dialog === "close"}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            if (dialog === "close") {
              onChanged();
              onClose();
            } else void reload();
          }}
        />
      )}
      {dialog === "bill" && (
        <BillDialog tab={tab} onClose={() => setDialog(null)} />
      )}
      {(dialog === "transfer" || dialog === "merge") && (
        <MoveDialog
          tab={tab}
          mode={dialog}
          tables={tables}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
      {orderId && (
        <OrderDetail
          id={orderId}
          onClose={() => setOrderId(null)}
          onChanged={() => void reload()}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cadastro (administrador)

function TablesDialog({
  tables,
  onClose,
  onChanged,
}: {
  tables: Row[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const write = useMesasWrite();
  const { busy, run } = useAction();
  const [prefix, setPrefix] = useState("Mesa");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("10");
  const [section, setSection] = useState("");
  const [kind, setKind] = useState("table");
  const cfg: Row = app.settings.mesas || {};
  const [service, setService] = useState(
    String(cfg.service_percent ?? 10).replace(".", ","),
  );
  return (
    <Dialog title="Mesas e comandas" size="lg" onClose={onClose}>
      <section className="card">
        <h3>Cadastrar várias</h3>
        <div className="mesas-row">
          <Field
            label="Tipo"
            value={kind}
            onChange={(v) => {
              setKind(v);
              setPrefix(v === "card" ? "Comanda" : "Mesa");
            }}
            options={[
              ["table", "Mesa"],
              ["card", "Comanda"],
            ]}
            emptyOption={null}
          />
          <Field label="Nome" value={prefix} onChange={setPrefix} />
          <Field
            label="De"
            type="number"
            min={0}
            value={from}
            onChange={setFrom}
          />
          <Field
            label="Até"
            type="number"
            min={0}
            value={to}
            onChange={setTo}
          />
          <Field
            label="Ambiente"
            value={section}
            onChange={setSection}
            placeholder="Salão"
          />
        </div>
        <div className="card-actions">
          <Button
            size="sm"
            busy={busy}
            icon={<Plus size={16} />}
            onClick={() =>
              void run(async () => {
                const result = await write("/tables", "POST", {
                  prefix,
                  from: Number(from),
                  to: Number(to),
                  kind,
                  section,
                });
                onChanged();
                toast(
                  `${result.data.length} cadastradas${result.skipped.length ? `; ${result.skipped.length} já existiam` : ""}.`,
                );
              }, {})
            }
          >
            Cadastrar
          </Button>
        </div>
      </section>
      <section className="card">
        <h3>Taxa de serviço</h3>
        <div className="mesas-row">
          <Field
            label="Percentual (0 desliga)"
            value={service}
            onChange={setService}
          />
        </div>
        <div className="card-actions">
          <Button
            size="sm"
            secondary
            busy={busy}
            onClick={() =>
              void run(
                async () => {
                  const value = Number(service.replace(",", "."));
                  await app.api(app.root + "/settings", "PUT", {
                    mesas: { service_percent: value },
                  });
                  await app.refresh();
                  onChanged();
                },
                {
                  success: "Taxa de serviço salva. Vale para as contas novas.",
                },
              )
            }
          >
            Salvar taxa
          </Button>
        </div>
      </section>
      {tables.length ? (
        <ul className="mesas-admin-list">
          {tables.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.name}</strong>{" "}
                <span className="muted">
                  {t.kind === "card" ? "Comanda" : "Mesa"}
                  {t.section ? ` · ${t.section}` : ""}
                </span>
              </span>
              <Pill tone={stateTones[t.state]}>{t.state_label}</Pill>
              <Button
                size="sm"
                secondary
                aria-label={`Apagar ${t.name}`}
                icon={<Trash2 size={14} />}
                disabled={busy || t.state !== "free"}
                onClick={() =>
                  void run(
                    async () => {
                      await write(`/tables/${t.id}`, "DELETE");
                      onChanged();
                    },
                    { success: `${t.name} apagada.` },
                  )
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nenhuma mesa cadastrada.</p>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Mapa das mesas

export function MesasPage() {
  const app = useApp();
  const resource = useResource(`${app.root}/mesas`);
  const [opening, setOpening] = useState<Row | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const view: Row | null = resource.data;
  useAppEvents((events: Row[]) => {
    if (
      events.some(
        (e) =>
          String(e.kind).startsWith("mesas.") ||
          (String(e.kind).startsWith("pedido.") && e.payload?.tab_id),
      )
    )
      void resource.reload();
  });
  const sections = useMemo(() => {
    const groups = new Map<string, Row[]>();
    for (const t of view?.tables || [])
      groups.set(t.section, [...(groups.get(t.section) || []), t]);
    return [...groups.entries()];
  }, [view]);
  if (!view)
    return resource.error ? (
      <Notice tone="error" onRetry={() => void resource.reload()}>
        {resource.error}
      </Notice>
    ) : (
      <SkeletonRows rows={4} avatar={false} />
    );
  return (
    <>
      <section className="card mesas-summary">
        <Pill tone="ok">{view.counts.free} livres</Pill>
        <Pill tone="brand">{view.counts.occupied} ocupadas</Pill>
        <Pill tone="warn">{view.counts.closing} fechando</Pill>
        <span className="spacer" />
        {app.isAdmin && (
          <Button
            secondary
            size="sm"
            icon={<Settings2 size={16} />}
            onClick={() => setAdmin(true)}
          >
            Mesas e comandas
          </Button>
        )}
      </section>
      {view.can_operate === false && (
        <Notice tone="info">
          Você vê as mesas, mas só quem tem o papel Garçom (Gestão → Pessoas e
          acessos) ou é administrador abre, lança e fecha contas.
        </Notice>
      )}
      {!view.tables.length && (
        <Empty
          icon={<Armchair size={28} />}
          title="Nenhuma mesa cadastrada"
          description={
            app.isAdmin
              ? "Cadastre as mesas e comandas para o garçom abrir as contas."
              : "Peça a um administrador para cadastrar as mesas."
          }
        />
      )}
      {sections.map(([section, list]) => (
        <section key={section} className="mesas-section">
          {section && <h3>{section}</h3>}
          <div className="mesas-grid">
            {list.map((t) => (
              <button
                type="button"
                key={t.id}
                className={`mesas-table ${t.state}`}
                onClick={() =>
                  t.tab
                    ? setTabId(t.tab.id)
                    : view.can_operate !== false
                      ? setOpening(t)
                      : toast(
                          "Para abrir mesas, peça ao administrador o papel Garçom.",
                        )
                }
              >
                <span className="mesas-table-top">
                  <strong>{t.name}</strong>
                  <Pill tone={stateTones[t.state]}>{t.state_label}</Pill>
                </span>
                {t.tab ? (
                  <>
                    <span>{money(t.tab.bill.total_cents)}</span>
                    <span className="muted">
                      {t.tab.guests ? `${t.tab.guests} pessoas · ` : ""}
                      {since(t.tab.minutes_open)}
                    </span>
                    {(t.tab.kitchen_count > 0 || t.tab.ready_count > 0) && (
                      <span className="muted">
                        {t.tab.kitchen_count
                          ? `${t.tab.kitchen_count} na cozinha`
                          : ""}
                        {t.tab.kitchen_count && t.tab.ready_count ? " · " : ""}
                        {t.tab.ready_count
                          ? `${t.tab.ready_count} pronto para servir`
                          : ""}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="muted">
                    {t.seats ? `${t.seats} lugares` : "Toque para abrir"}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
      {opening && (
        <OpenDialog
          table={opening}
          onClose={() => setOpening(null)}
          onOpened={(id) => {
            setOpening(null);
            void resource.reload();
            setTabId(id);
          }}
        />
      )}
      {tabId && (
        <TabDialog
          id={tabId}
          tables={view.tables}
          canOperate={view.can_operate !== false}
          onClose={() => setTabId(null)}
          onChanged={() => void resource.reload()}
        />
      )}
      {admin && (
        <TablesDialog
          tables={view.tables}
          onClose={() => setAdmin(false)}
          onChanged={() => void resource.reload()}
        />
      )}
    </>
  );
}

export { toastError };
