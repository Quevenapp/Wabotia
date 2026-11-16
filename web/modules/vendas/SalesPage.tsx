// Gestão → Vendas e orçamentos (módulo "vendas", docs/VENDAS.md): lista e
// detalhe das vendas (comprovante, cancelamento, devolução e a prévia da nota
// fiscal) e dos orçamentos (montar, enviar pelo WhatsApp, registrar a
// resposta, converter em venda, cancelar e imprimir). Escritas com
// Idempotency-Key; o servidor decide quem pode cancelar e devolver.
import React, { useEffect, useState } from "react";
import {
  FileCheck2,
  FileText,
  List,
  Pencil,
  Plus,
  Printer,
  Receipt,
  Send,
  ShoppingCart,
  Trash2,
  Undo2,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import type { Row } from "../../lib/api";
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
  Switch,
  Table,
  toast,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import {
  cents,
  centsInput,
  ConversationPicker,
  dateTime,
  day,
  decimal,
  lineCents,
  money,
  numberInput,
  onlineMethods,
  paymentLabels,
  phoneLabel,
  qty,
  quoteLabels,
  quoteTones,
  ReceiptDialog,
  ReturnDialog,
  saleLabels,
  saleTones,
  sourceLabels,
  stopEnter,
  useModuleWrite,
} from "./shared";
import "./vendas.css";

/** GET vendas: regras, formas ligadas e se a cobrança online está pronta. */
function useOverview() {
  const app = useApp();
  return useResource(`${app.root}/vendas`);
}
const enabledMethods = (overview: Row | null, online = true) =>
  ((overview?.payment_methods || []) as Row[])
    .map((m) => m.id as string)
    .filter((id) => online || !onlineMethods.includes(id));

function useDebounced(value: string, ms = 300) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setOut(value.trim()), ms);
    return () => clearTimeout(timer);
  }, [value]);
  return out;
}

function Lines({ record }: { record: Row }) {
  return (
    <table className="vendas-lines">
      <tbody>
        {record.lines.map((line: Row) => (
          <tr key={line.index}>
            <td>
              <strong>
                {qty(line.quantity)} {line.unit} × {line.name}
              </strong>
              <small>
                {money(line.unit_cents)} cada
                {line.discount_cents ? ` · desconto ${money(line.discount_cents)}` : ""}
                {line.sku ? ` · SKU ${line.sku}` : ""}
                {!line.product_id ? " · item avulso" : ""}
              </small>
              {line.returned_quantity > 0 && (
                <small className="vendas-returned">
                  Devolvido: {qty(line.returned_quantity)} {line.unit} ({money(line.returned_cents)})
                </small>
              )}
            </td>
            <td>{money(line.total_cents)}</td>
          </tr>
        ))}
        <tr>
          <td>Subtotal</td>
          <td>{money(record.subtotal_cents)}</td>
        </tr>
        {record.discount_cents > 0 && (
          <tr>
            <td>Descontos</td>
            <td>− {money(record.discount_cents)}</td>
          </tr>
        )}
        <tr className="total">
          <td>Total</td>
          <td>{money(record.total_cents)}</td>
        </tr>
      </tbody>
    </table>
  );
}

const customerLabel = (customer: Row) =>
  [customer?.name || "Consumidor", phoneLabel(customer?.phone)].filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------
// Vendas

function FiscalDialog({ sale, onClose }: { sale: Row; onClose: () => void }) {
  const app = useApp();
  const [model, setModel] = useState<"nfce" | "nfe">("nfce");
  const preview = useResource(`${app.root}/vendas/sales/${sale.id}/fiscal?model=${model}`);
  const data: Row | null = preview.data;
  return (
    <Dialog
      title={`Nota fiscal da venda nº ${sale.number}`}
      subtitle="Prévia do que iria para a nota e o que falta para emitir."
      onClose={onClose}
      size="lg"
      footer={
        <Button secondary onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="toolbar">
        <Segmented
          label="Modelo da nota"
          value={model}
          onChange={setModel}
          options={[
            { value: "nfce", label: "NFC-e (consumidor)" },
            { value: "nfe", label: "NF-e" },
          ]}
        />
      </div>
      {!data ? (
        preview.error ? (
          <Notice tone="error" onRetry={() => void preview.reload()}>
            {preview.error}
          </Notice>
        ) : (
          <SkeletonRows rows={3} avatar={false} />
        )
      ) : (
        <>
          {!data.provider && (
            <Notice tone="warn">
              Emissão de nota ainda não ligada: o administrador escolhe o emissor em Regras e nota fiscal.
            </Notice>
          )}
          {data.ready ? (
            <Notice tone="ok">Tudo pronto para emitir pelo emissor {data.provider?.name}.</Notice>
          ) : data.issues.length ? (
            <>
              <h3 className="vendas-h3">
                Pendências <Pill tone="warn">{data.issues.length}</Pill>
              </h3>
              <ul className="vendas-issues">
                {data.issues.map((issue: Row, index: number) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </>
          ) : (
            <Notice tone="ok">Os dados da venda e do emitente estão completos para a nota.</Notice>
          )}
          <dl className="vendas-facts">
            <dt>Itens</dt>
            <dd>{data.document?.items?.length ?? 0}</dd>
            <dt>Total da nota</dt>
            <dd>{money(data.document?.totals?.total_cents)}</dd>
            <dt>Ambiente</dt>
            <dd>{data.document?.environment === "producao" ? "Produção" : "Homologação (testes)"}</dd>
            {data.document?.recipient?.document && (
              <>
                <dt>Destinatário</dt>
                <dd>
                  {data.document.recipient.name || "—"} · {data.document.recipient.document}
                </dd>
              </>
            )}
          </dl>
        </>
      )}
    </Dialog>
  );
}

function CancelSaleDialog({ sale, onClose, onDone }: { sale: Row; onClose: () => void; onDone: () => void }) {
  const write = useModuleWrite();
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title={`Cancelar a venda nº ${sale.number}`}
      subtitle="O estoque volta. Venda de caixa já fechado não se cancela: registre uma devolução no caixa aberto."
      submitLabel="Cancelar venda"
      danger
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        const result = await write(`vendas/sales/${sale.id}/cancel`, "POST", { reason });
        toast(
          result?.needs_refund
            ? `Venda nº ${sale.number} cancelada. Devolva o valor pelo painel do Mercado Pago.`
            : `Venda nº ${sale.number} cancelada.`,
        );
        onDone();
      }}
    >
      <Field label="Motivo" value={reason} onChange={setReason} maxLength={300} placeholder="Ex.: cliente desistiu; item lançado errado" />
    </FormDialog>
  );
}

export function SaleDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const app = useApp();
  const write = useModuleWrite();
  const overview = useOverview();
  const resource = useResource(`${app.root}/vendas/sales/${id}`);
  const [dialog, setDialog] = useState<"receipt" | "cancel" | "return" | "fiscal" | null>(null);
  const sale: Row | null = resource.data;
  const changed = () => {
    setDialog(null);
    void resource.reload();
    onChanged();
  };
  if (!sale)
    return (
      <Dialog title="Venda" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const canCancel = ["awaiting_payment", "completed"].includes(sale.status) && !sale.refunded_cents;
  const canReturn = sale.status === "completed";
  const methods = enabledMethods(overview.data, false);
  return (
    <>
      <Dialog
        title={`Venda nº ${sale.number}`}
        subtitle={
          <>
            <Pill tone={saleTones[sale.status] || "muted"}>{sale.status_label}</Pill> {sourceLabels[sale.source] || sale.source} ·{" "}
            {dateTime(sale.created)}
          </>
        }
        onClose={onClose}
        size="lg"
        footer={
          <>
            <Button secondary icon={<Printer size={16} />} onClick={() => setDialog("receipt")}>
              Comprovante
            </Button>
            <Button secondary icon={<FileCheck2 size={16} />} onClick={() => setDialog("fiscal")}>
              Nota fiscal
            </Button>
            {canReturn && (
              <Button secondary icon={<Undo2 size={16} />} onClick={() => setDialog("return")}>
                Devolver
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" onClick={() => setDialog("cancel")}>
                Cancelar venda
              </Button>
            )}
          </>
        }
      >
        {sale.status === "awaiting_payment" && (
          <Notice tone="warn">Esperando a confirmação do pagamento online. A venda conclui sozinha quando o provedor confirmar.</Notice>
        )}
        {sale.needs_refund && (
          <Notice tone="error">Pagamento recebido de uma venda cancelada: devolva o valor pelo painel do Mercado Pago.</Notice>
        )}
        <Lines record={sale} />
        <dl className="vendas-facts">
          <dt>Cliente</dt>
          <dd>
            {customerLabel(sale.customer)}
            {sale.customer?.document ? ` · CPF/CNPJ ${sale.customer.document}` : ""}
          </dd>
          <dt>Pagamento</dt>
          <dd>
            {sale.payments.length
              ? sale.payments.map((p: Row) => `${p.method_label} ${money(p.amount_cents)}`).join(" + ")
              : "—"}
            {sale.change_cents > 0 && ` · troco ${money(sale.change_cents)}`}
          </dd>
          {sale.refunded_cents > 0 && (
            <>
              <dt>Devolvido</dt>
              <dd>{money(sale.refunded_cents)}</dd>
            </>
          )}
          <dt>Registrada por</dt>
          <dd>{app.names[sale.created_by] || sale.created_by}</dd>
          {sale.note && (
            <>
              <dt>Observação</dt>
              <dd className="pre">{sale.note}</dd>
            </>
          )}
          {sale.notes && (
            <>
              <dt>Observações internas</dt>
              <dd className="pre">{sale.notes}</dd>
            </>
          )}
          {sale.cancel_reason && (
            <>
              <dt>Motivo do cancelamento</dt>
              <dd>
                {sale.cancel_reason}
                {sale.cancelled_by ? ` · ${app.names[sale.cancelled_by] || sale.cancelled_by}` : ""}
              </dd>
            </>
          )}
          {sale.fiscal_status && sale.fiscal_status !== "none" && (
            <>
              <dt>Nota fiscal</dt>
              <dd>{sale.fiscal_status}</dd>
            </>
          )}
        </dl>
        {(sale.returns || []).length > 0 && (
          <>
            <h3 className="vendas-h3">Devoluções</h3>
            <ul className="vendas-history">
              {sale.returns.map((r: Row) => (
                <li key={r.id}>
                  <strong>
                    {money(r.amount_cents)} em {r.method_label}
                  </strong>{" "}
                  <span className="muted">
                    {dateTime(r.created)} · {app.names[r.actor] || r.actor}
                  </span>
                  <div>
                    {r.lines.map((l: Row) => `${qty(l.quantity)} × ${l.name}`).join(", ")}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {(sale.fiscal_documents || []).length > 0 && (
          <>
            <h3 className="vendas-h3">Notas fiscais</h3>
            <ul className="vendas-history">
              {sale.fiscal_documents.map((doc: Row) => (
                <li key={doc.id}>
                  <strong>
                    {String(doc.model).toUpperCase()} {doc.number ? `nº ${doc.number}` : ""} · {doc.status}
                  </strong>
                  {doc.message && <div>{doc.message}</div>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Dialog>
      {dialog === "receipt" && (
        <ReceiptDialog title={`Comprovante da venda nº ${sale.number}`} url={`${app.root}/vendas/sales/${sale.id}/receipt`} onClose={() => setDialog(null)} />
      )}
      {dialog === "fiscal" && <FiscalDialog sale={sale} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && <CancelSaleDialog sale={sale} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog === "return" && (
        <ReturnDialog
          sale={sale}
          methods={methods.length ? methods : ["cash"]}
          onClose={() => setDialog(null)}
          submit={async (body) => {
            const result = await write(`vendas/sales/${sale.id}/return`, "POST", body);
            changed();
            return result;
          }}
        />
      )}
    </>
  );
}

function SalesList({ onOpen }: { onOpen: (id: string) => void }) {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (query) params.set("q", query);
  const list = useList(`${app.root}/vendas/sales?${params.toString()}`);
  return (
    <>
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Buscar por número, cliente, telefone ou CPF" />
      </div>
      <div className="chip-row" role="group" aria-label="Filtrar por situação">
        <Chip active={!status} onClick={() => setStatus("")}>
          Todas
        </Chip>
        {Object.entries(saleLabels).map(([id, label]) => (
          <Chip key={id} active={status === id} onClick={() => setStatus(id)}>
            {label}
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
              ["created", "Data", (row) => dateTime(row.created)],
              ["customer", "Cliente", (row) => row.customer?.name || "Consumidor"],
              ["total", "Total", (row) => money(row.total_cents)],
              ["payments", "Formas", (row) => row.payments.map((p: Row) => p.method_label).join(" + ") || "—"],
              ["status", "Situação", (row) => <Pill tone={saleTones[row.status] || "muted"}>{row.status_label}</Pill>],
              ["source", "Origem", (row) => sourceLabels[row.source] || row.source],
            ]}
            action={(row) => (
              <Button secondary size="sm" onClick={() => onOpen(row.id)}>
                Abrir
              </Button>
            )}
            empty={
              <Empty
                compact
                icon={<ShoppingCart size={28} />}
                title="Nenhuma venda encontrada"
                description="As vendas chegam pelo Caixa, pelos orçamentos convertidos e pelas integrações."
              />
            }
          />
        )}
        <Pager cursor={list.cursor} nextCursor={list.nextCursor} setCursor={list.setCursor} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Orçamentos

type LineDraft = {
  key: string;
  product_id: string | null;
  name: string;
  unit: string;
  fractional: boolean;
  quantity: string;
  price: string;
  discount: string;
};

const newKey = () => Math.random().toString(36).slice(2);

function ProductSearch({ onPick }: { onPick: (product: Row) => void }) {
  const app = useApp();
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const [found, setFound] = useState<Row[]>([]);
  useEffect(() => {
    if (!query) return setFound([]);
    let alive = true;
    app
      .api(`${app.root}/vendas/products?limit=8&q=${encodeURIComponent(query)}`)
      .then((result) => alive && setFound(result.data || []))
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
  }, [query]);
  return (
    <div onKeyDown={stopEnter}>
      <SearchBox value={search} onChange={setSearch} placeholder="Adicionar produto do catálogo: nome, SKU ou código" />
      {found.length > 0 && (
        <div className="vendas-picker">
          {found.map((product) => (
            <button
              key={product.id}
              type="button"
              className="chip"
              onClick={() => {
                onPick(product);
                setSearch("");
              }}
            >
              {product.name} · {money(product.price_cents)}/{product.unit}
              {product.out_of_stock ? " · sem saldo" : ""}
            </button>
          ))}
        </div>
      )}
      {query && !found.length && <small className="muted">Nenhum produto ativo com “{query}”.</small>}
    </div>
  );
}

function QuoteEditor({ initial, onClose, onSaved }: { initial: Row; onClose: () => void; onSaved: (quote: Row) => void }) {
  const app = useApp();
  const write = useModuleWrite();
  const creating = !initial.id;
  const lineDiscounts = (initial.lines || []).reduce((s: number, l: Row) => s + (l.discount_cents || 0), 0);
  const saleDiscount = (initial.discount_cents || 0) - lineDiscounts;
  const [lines, setLines] = useState<LineDraft[]>(() =>
    (initial.lines || []).map((l: Row) => ({
      key: newKey(),
      product_id: l.product_id,
      name: l.name,
      unit: l.unit,
      fractional: true,
      quantity: numberInput(l.quantity),
      price: centsInput(l.unit_cents),
      discount: l.discount_cents ? centsInput(l.discount_cents) : "",
    })),
  );
  const [customer, setCustomer] = useState({
    name: initial.customer?.name || "",
    phone: initial.customer?.phone || "",
    document: initial.customer?.document || "",
  });
  const [conversation, setConversation] = useState<Row | null>(
    initial.customer?.conversation_id ? { id: initial.customer.conversation_id } : null,
  );
  const [discountMode, setDiscountMode] = useState<"value" | "percent">("value");
  const [discount, setDiscount] = useState(saleDiscount > 0 ? centsInput(saleDiscount) : "");
  const [validDays, setValidDays] = useState(initial.valid_days ? String(initial.valid_days) : "");
  const [note, setNote] = useState(initial.note || "");
  const [notes, setNotes] = useState(initial.notes || "");
  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineTotal = (l: LineDraft) => {
    const price = cents(l.price) ?? 0;
    const quantity = decimal(l.quantity) ?? 0;
    return Math.max(0, lineCents(price, quantity) - (cents(l.discount) ?? 0));
  };
  const afterLines = lines.reduce((s, l) => s + lineTotal(l), 0);
  const saleOff =
    discountMode === "percent"
      ? Math.round((afterLines * Math.min(100, decimal(discount) ?? 0)) / 100)
      : (cents(discount) ?? 0);
  const total = Math.max(0, afterLines - saleOff);
  const defaultDays = app.settings.vendas?.quote_valid_days ?? 7;
  return (
    <FormDialog
      title={creating ? "Novo orçamento" : `Editar orçamento nº ${initial.number}`}
      subtitle={
        !creating && ["sent", "approved", "declined", "expired"].includes(initial.status)
          ? "Salvar volta o orçamento para rascunho: envie de novo para o cliente aprovar o valor novo."
          : undefined
      }
      size="xl"
      disabled={!lines.length}
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = {
          lines: lines.map((l, index) => {
            const quantity = decimal(l.quantity);
            if (quantity === null || quantity <= 0) throw new Error(`Item ${index + 1}: informe a quantidade.`);
            const price = cents(l.price);
            if (price === null) throw new Error(`Item ${index + 1}: informe o preço (ex.: 12,90).`);
            const off = l.discount.trim() ? cents(l.discount) : 0;
            if (off === null) throw new Error(`Item ${index + 1}: desconto inválido.`);
            return {
              ...(l.product_id ? { product_id: l.product_id } : { name: l.name }),
              quantity,
              unit_cents: price,
              ...(off ? { discount_cents: off } : {}),
            };
          }),
          customer_name: customer.name,
          customer_phone: customer.phone,
          customer_document: customer.document,
          valid_days: validDays.trim() ? Number(validDays) : null,
          note,
          notes,
        };
        if (discount.trim()) {
          if (discountMode === "percent") {
            const p = decimal(discount);
            if (p === null || p < 0 || p > 100) throw new Error("Desconto: de 0 a 100%.");
            body.discount_percent = p;
          } else {
            const value = cents(discount);
            if (value === null) throw new Error("Desconto inválido (ex.: 10,00).");
            body.discount_cents = value;
          }
        } else body.discount_cents = 0;
        const linked = initial.customer?.conversation_id || null;
        if ((conversation?.id || null) !== linked) body.conversation_id = conversation?.id || null;
        const saved = creating
          ? await write("vendas/quotes", "POST", body)
          : await write(`vendas/quotes/${initial.id}`, "PUT", body);
        toast(creating ? `Orçamento nº ${saved.number} criado.` : "Orçamento salvo.");
        onSaved(saved);
      }}
    >
      <fieldset className="form-field-editor">
        <legend>Cliente</legend>
        <ConversationPicker value={conversation} onChange={setConversation} />
        <div className="vendas-grid-3">
          <Field label="Nome" value={customer.name} onChange={(name) => setCustomer({ ...customer, name })} maxLength={80} help="Em branco, usa o nome do contato da conversa." />
          <Field label="Telefone" value={customer.phone} onChange={(phone) => setCustomer({ ...customer, phone })} placeholder="(11) 98888-7777" />
          <Field label="CPF ou CNPJ (opcional)" value={customer.document} onChange={(document) => setCustomer({ ...customer, document })} maxLength={20} />
        </div>
      </fieldset>
      <fieldset className="form-field-editor">
        <legend>Itens</legend>
        <ProductSearch
          onPick={(product) =>
            setLines([
              ...lines,
              {
                key: newKey(),
                product_id: product.id,
                name: product.name,
                unit: product.unit,
                fractional: !!product.fractional,
                quantity: "1",
                price: centsInput(product.price_cents),
                discount: "",
              },
            ])
          }
        />
        <div className="vendas-quote-lines">
          {lines.map((l, index) => (
            <div className="vendas-quote-line" key={l.key}>
              {l.product_id ? (
                <div className="field">
                  <span>Item {index + 1}</span>
                  <p className="vendas-static">
                    <strong>{l.name}</strong> <small className="muted">({l.unit})</small>
                  </p>
                </div>
              ) : (
                <Field label={`Item avulso ${index + 1}`} value={l.name} onChange={(name) => setLine(l.key, { name })} maxLength={120} required placeholder="Ex.: Instalação, frete" />
              )}
              <Field label="Quantidade" value={l.quantity} onChange={(quantity) => setLine(l.key, { quantity })} required />
              <Field label="Preço unitário (R$)" value={l.price} onChange={(price) => setLine(l.key, { price })} required placeholder="0,00" />
              <Field label="Desconto (R$)" value={l.discount} onChange={(discount) => setLine(l.key, { discount })} placeholder="0,00" />
              <div className="vendas-quote-line-total">
                <strong>{money(lineTotal(l))}</strong>
                <button
                  type="button"
                  className="icon-button sm"
                  aria-label={`Remover ${l.name || `item ${index + 1}`}`}
                  onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <Button
          secondary
          size="sm"
          icon={<Plus size={16} />}
          disabled={lines.length >= 200}
          onClick={() =>
            setLines([
              ...lines,
              { key: newKey(), product_id: null, name: "", unit: "UN", fractional: true, quantity: "1", price: "", discount: "" },
            ])
          }
        >
          Item avulso (serviço, frete…)
        </Button>
      </fieldset>
      <div className="vendas-grid-3">
        <div className="field">
          <span>Desconto do orçamento</span>
          <div className="vendas-inline">
            <Segmented
              label="Tipo de desconto"
              value={discountMode}
              onChange={setDiscountMode}
              options={[
                { value: "value", label: "R$" },
                { value: "percent", label: "%" },
              ]}
            />
            <input aria-label="Valor do desconto" value={discount} onChange={(event) => setDiscount(event.target.value)} placeholder={discountMode === "percent" ? "0" : "0,00"} />
          </div>
        </div>
        <Field label="Validade (dias)" type="number" min={1} max={90} value={validDays} onChange={setValidDays} help={`Em branco, ${defaultDays} dias (regra da área), contados do envio.`} />
        <div className="field">
          <span>Total</span>
          <p className="vendas-total">{money(total)}</p>
        </div>
      </div>
      <Field label="Observação ao cliente" type="textarea" rows={2} value={note} onChange={setNote} maxLength={1000} placeholder="Ex.: prazo de entrega de 5 dias úteis" />
      <Field label="Observações internas (só a equipe)" type="textarea" rows={2} value={notes} onChange={setNotes} maxLength={2000} />
    </FormDialog>
  );
}

function SendQuoteDialog({ quote, onClose, onDone }: { quote: Row; onClose: () => void; onDone: () => void }) {
  const write = useModuleWrite();
  const linked = !!quote.customer?.conversation_id;
  const [via, setVia] = useState<"buttons" | "link">("buttons");
  const [notify, setNotify] = useState(linked);
  return (
    <FormDialog
      title={`Enviar orçamento nº ${quote.number}`}
      subtitle="Fixa a validade a partir de hoje. O cliente responde e o orçamento muda sozinho para Aprovado ou Recusado."
      submitLabel={notify ? "Enviar pelo WhatsApp" : "Registrar envio"}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        await write(`vendas/quotes/${quote.id}/send`, "POST", notify ? { via, notify: true } : { notify: false });
        toast(notify ? `Orçamento nº ${quote.number} enviado.` : `Envio do orçamento nº ${quote.number} registrado.`);
        onDone();
      }}
    >
      {!linked && (
        <Notice tone="warn">
          Este orçamento não está ligado a uma conversa do WhatsApp. Ligue uma conversa em Editar, ou só registre que foi entregue
          (impresso ou por outro meio) e registre a resposta depois.
        </Notice>
      )}
      <label className="vendas-toggle">
        <Switch label="Enviar mensagem ao cliente" checked={notify} disabled={!linked} onChange={setNotify} />
        {notify ? "Mandar o orçamento na conversa" : "Só registrar o envio (entregue em mãos)"}
      </label>
      {notify && (
        <div className="field">
          <span>Como o cliente responde</span>
          <Segmented
            label="Como o cliente responde"
            value={via}
            onChange={setVia}
            options={[
              { value: "buttons", label: "Botões Aprovar e Recusar" },
              { value: "link", label: "Link com o orçamento" },
            ]}
          />
          <small>
            {via === "buttons"
              ? "Texto com os itens e dois botões na própria conversa."
              : "Um link para uma página com os itens, onde o cliente aprova ou recusa e pode deixar uma observação."}
          </small>
        </div>
      )}
    </FormDialog>
  );
}

function DecisionDialog({ quote, onClose, onDone }: { quote: Row; onClose: () => void; onDone: () => void }) {
  const write = useModuleWrite();
  const [decision, setDecision] = useState<"approve" | "decline">("approve");
  const [note, setNote] = useState("");
  return (
    <FormDialog
      title={`Resposta ao orçamento nº ${quote.number}`}
      subtitle="Use quando o cliente respondeu por telefone, pessoalmente ou fora dos botões."
      submitLabel={decision === "approve" ? "Registrar aprovação" : "Registrar recusa"}
      danger={decision === "decline"}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        await write(`vendas/quotes/${quote.id}/decision`, "POST", { decision, note });
        toast(decision === "approve" ? "Orçamento aprovado." : "Orçamento recusado.");
        onDone();
      }}
    >
      <Segmented
        label="Resposta do cliente"
        value={decision}
        onChange={setDecision}
        full
        options={[
          { value: "approve", label: "Aprovou" },
          { value: "decline", label: "Recusou" },
        ]}
      />
      <Field label="Observação (opcional)" value={note} onChange={setNote} maxLength={500} />
    </FormDialog>
  );
}

type PaymentDraft = { key: string; method: string; amount: string };

/** Formas de pagamento da venda (uma ou mais; troco só em dinheiro). */
function PaymentsEditor({
  total,
  methods,
  value,
  onChange,
}: {
  total: number;
  methods: string[];
  value: PaymentDraft[];
  onChange: (next: PaymentDraft[]) => void;
}) {
  const paid = value.reduce((s, p) => s + (cents(p.amount) ?? 0), 0);
  const options = methods.map((id) => ({ id, name: paymentLabels[id] || id }));
  return (
    <div className="vendas-payments">
      {value.map((p) => (
        <div className="vendas-payment-row" key={p.key}>
          <Field label="Forma" value={p.method} options={options} emptyOption={null} onChange={(method) => onChange(value.map((x) => (x.key === p.key ? { ...x, method } : x)))} />
          <Field
            label={p.method === "cash" ? "Valor recebido (R$)" : "Valor (R$)"}
            value={p.amount}
            onChange={(amount) => onChange(value.map((x) => (x.key === p.key ? { ...x, amount } : x)))}
            placeholder="0,00"
          />
          {value.length > 1 && (
            <button type="button" className="icon-button sm" aria-label="Remover forma" onClick={() => onChange(value.filter((x) => x.key !== p.key))}>
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ))}
      <div className="vendas-inline">
        {value.length < 6 && (
          <Button
            secondary
            size="sm"
            icon={<Plus size={16} />}
            onClick={() => onChange([...value, { key: newKey(), method: methods[0] || "cash", amount: centsInput(Math.max(0, total - paid)) }])}
          >
            Outra forma
          </Button>
        )}
        <span className="muted">
          {paid < total ? `Faltam ${money(total - paid)}` : paid > total ? `Troco: ${money(paid - total)}` : "Valor exato"}
        </span>
      </div>
    </div>
  );
}

function ConvertDialog({ quote, onClose, onDone }: { quote: Row; onClose: () => void; onDone: (sale: Row) => void }) {
  const write = useModuleWrite();
  const overview = useOverview();
  const methods = enabledMethods(overview.data, !!overview.data?.online_payments?.ready);
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  useEffect(() => {
    if (!payments.length && methods.length)
      setPayments([{ key: newKey(), method: methods.includes("cash") ? "cash" : methods[0], amount: centsInput(quote.total_cents) }]);
  }, [methods.join(",")]);
  return (
    <FormDialog
      title={`Converter o orçamento nº ${quote.number} em venda`}
      subtitle={`Total ${money(quote.total_cents)}, com os preços e descontos do orçamento. O estoque baixa agora.`}
      submitLabel="Registrar venda"
      size="md"
      disabled={!payments.length}
      onClose={onClose}
      onSubmit={async () => {
        const body = payments.map((p, index) => {
          const amount = cents(p.amount);
          if (!amount) throw new Error(`Forma ${index + 1}: informe o valor.`);
          return { method: p.method, amount_cents: amount };
        });
        const result = await write(`vendas/quotes/${quote.id}/convert`, "POST", { payments: body });
        toast(`Venda nº ${result.sale.number} registrada.`);
        onDone(result.sale);
      }}
    >
      {quote.status !== "approved" && (
        <Notice tone="warn">Este orçamento não foi aprovado pelo cliente. Só administradores convertem assim.</Notice>
      )}
      {!overview.data ? (
        <SkeletonRows rows={2} avatar={false} />
      ) : (
        <PaymentsEditor total={quote.total_cents} methods={methods} value={payments} onChange={setPayments} />
      )}
      {methods.some((m) => onlineMethods.includes(m)) && (
        <small className="muted">Pix ou link do Mercado Pago cobram o total sozinhos, pela conversa do orçamento.</small>
      )}
    </FormDialog>
  );
}

function CancelQuoteDialog({ quote, onClose, onDone }: { quote: Row; onClose: () => void; onDone: () => void }) {
  const write = useModuleWrite();
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title={`Cancelar o orçamento nº ${quote.number}`}
      subtitle="O orçamento cancelado não volta; o link enviado ao cliente para de funcionar."
      submitLabel="Cancelar orçamento"
      danger
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        await write(`vendas/quotes/${quote.id}/cancel`, "POST", { reason });
        toast(`Orçamento nº ${quote.number} cancelado.`);
        onDone();
      }}
    >
      <Field label="Motivo (opcional)" value={reason} onChange={setReason} maxLength={300} />
    </FormDialog>
  );
}

const editable = ["draft", "sent", "approved", "declined", "expired"];

function QuoteDetail({
  id,
  onClose,
  onChanged,
  onOpenSale,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenSale: (id: string) => void;
}) {
  const app = useApp();
  const resource = useResource(`${app.root}/vendas/quotes/${id}`);
  const [dialog, setDialog] = useState<"edit" | "send" | "decision" | "convert" | "cancel" | "print" | null>(null);
  const quote: Row | null = resource.data;
  const changed = () => {
    setDialog(null);
    void resource.reload();
    onChanged();
  };
  if (!quote)
    return (
      <Dialog title="Orçamento" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const canEdit = editable.includes(quote.status);
  const canConvert = quote.status === "approved" || (app.isAdmin && ["draft", "sent", "expired"].includes(quote.status));
  return (
    <>
      <Dialog
        title={`Orçamento nº ${quote.number}`}
        subtitle={
          <>
            <Pill tone={quoteTones[quote.status] || "muted"}>{quote.status_label}</Pill> criado em {dateTime(quote.created)}
          </>
        }
        onClose={onClose}
        size="lg"
        footer={
          <>
            <Button secondary icon={<Printer size={16} />} onClick={() => setDialog("print")}>
              Imprimir
            </Button>
            {quote.status !== "converted" && quote.status !== "cancelled" && (
              <Button variant="ghost" onClick={() => setDialog("cancel")}>
                Cancelar
              </Button>
            )}
            {canEdit && (
              <Button secondary icon={<Pencil size={16} />} onClick={() => setDialog("edit")}>
                Editar
              </Button>
            )}
            {quote.status === "sent" && (
              <Button secondary onClick={() => setDialog("decision")}>
                Registrar resposta
              </Button>
            )}
            {canEdit && (
              <Button secondary={quote.status !== "draft"} icon={<Send size={16} />} onClick={() => setDialog("send")}>
                {quote.sent_at ? "Enviar de novo" : "Enviar"}
              </Button>
            )}
            {canConvert && (
              <Button icon={<ShoppingCart size={16} />} onClick={() => setDialog("convert")}>
                Converter em venda
              </Button>
            )}
            {quote.sale_id && (
              <Button icon={<Receipt size={16} />} onClick={() => onOpenSale(quote.sale_id)}>
                Abrir a venda
              </Button>
            )}
          </>
        }
      >
        <Lines record={quote} />
        <dl className="vendas-facts">
          <dt>Cliente</dt>
          <dd>
            {customerLabel(quote.customer)}
            {quote.customer?.document ? ` · CPF/CNPJ ${quote.customer.document}` : ""}
            {quote.customer?.conversation_id ? " · conversa no WhatsApp" : ""}
          </dd>
          <dt>Validade</dt>
          <dd>
            {quote.valid_until
              ? `até ${day(quote.valid_until)}`
              : `${quote.valid_days || app.settings.vendas?.quote_valid_days || 7} dias a partir do envio`}
          </dd>
          {quote.sent_at && (
            <>
              <dt>Enviado</dt>
              <dd>
                {dateTime(quote.sent_at)} ·{" "}
                {quote.sent_via === "buttons" ? "botões no WhatsApp" : quote.sent_via === "link" ? "link no WhatsApp" : "registrado (entregue em mãos)"}
              </dd>
            </>
          )}
          {quote.decided_at && (
            <>
              <dt>Resposta</dt>
              <dd>
                {quote.status === "declined" ? "Recusado" : "Aprovado"} em {dateTime(quote.decided_at)}
                {quote.decided_via === "panel" ? ` · registrado por ${app.names[quote.decided_by] || quote.decided_by}` : " · pelo cliente"}
                {quote.decision_note ? ` · “${quote.decision_note}”` : ""}
              </dd>
            </>
          )}
          {quote.status === "cancelled" && quote.decision_note && (
            <>
              <dt>Motivo do cancelamento</dt>
              <dd>{quote.decision_note}</dd>
            </>
          )}
          {quote.note && (
            <>
              <dt>Observação ao cliente</dt>
              <dd className="pre">{quote.note}</dd>
            </>
          )}
          {quote.notes && (
            <>
              <dt>Observações internas</dt>
              <dd className="pre">{quote.notes}</dd>
            </>
          )}
          <dt>Criado por</dt>
          <dd>{app.names[quote.created_by] || quote.created_by}</dd>
        </dl>
      </Dialog>
      {dialog === "edit" && <QuoteEditor initial={quote} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === "send" && <SendQuoteDialog quote={quote} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog === "decision" && <DecisionDialog quote={quote} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog === "cancel" && <CancelQuoteDialog quote={quote} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog === "convert" && (
        <ConvertDialog
          quote={quote}
          onClose={() => setDialog(null)}
          onDone={(sale) => {
            changed();
            onOpenSale(sale.id);
          }}
        />
      )}
      {dialog === "print" && (
        <ReceiptDialog title={`Orçamento nº ${quote.number}`} url={`${app.root}/vendas/quotes/${quote.id}/print`} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function QuotesList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (query) params.set("q", query);
  const list = useList(`${app.root}/vendas/quotes?${params.toString()}`);
  return (
    <>
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Buscar por número, cliente ou telefone" />
        <Button icon={<Plus size={16} />} onClick={onNew}>
          Novo orçamento
        </Button>
      </div>
      <div className="chip-row" role="group" aria-label="Filtrar por situação">
        <Chip active={!status} onClick={() => setStatus("")}>
          Todos
        </Chip>
        {Object.entries(quoteLabels).map(([id, label]) => (
          <Chip key={id} active={status === id} onClick={() => setStatus(id)}>
            {label}
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
              ["customer", "Cliente", (row) => row.customer?.name || "Sem nome"],
              ["total", "Total", (row) => money(row.total_cents)],
              ["status", "Situação", (row) => <Pill tone={quoteTones[row.status] || "muted"}>{row.status_label}</Pill>],
              [
                "valid",
                "Validade",
                (row) =>
                  row.valid_until ? (
                    <span className={row.status === "expired" ? "vendas-late" : ""}>até {day(row.valid_until)}</span>
                  ) : (
                    `${row.valid_days || app.settings.vendas?.quote_valid_days || 7} dias após o envio`
                  ),
              ],
              ["updated", "Atualizado", (row) => dateTime(row.updated)],
            ]}
            action={(row) => (
              <Button secondary size="sm" onClick={() => onOpen(row.id)}>
                Abrir
              </Button>
            )}
            empty={
              <Empty
                compact
                icon={<FileText size={28} />}
                title="Nenhum orçamento encontrado"
                description="Monte um orçamento com produtos do catálogo e itens avulsos e envie para o cliente aprovar pelo WhatsApp."
              />
            }
          />
        )}
        <Pager cursor={list.cursor} nextCursor={list.nextCursor} setCursor={list.setCursor} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

export function SalesPage() {
  const [tab, setTab] = useState<"sales" | "quotes">("sales");
  const [sale, setSale] = useState<string | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  return (
    <div className="vendas-page">
      <div className="toolbar">
        <Segmented
          label="Vendas e orçamentos"
          value={tab}
          onChange={setTab}
          options={[
            { value: "sales", label: "Vendas", icon: <List size={16} /> },
            { value: "quotes", label: "Orçamentos", icon: <FileText size={16} /> },
          ]}
        />
      </div>
      {tab === "sales" ? (
        <SalesList key={version} onOpen={setSale} />
      ) : (
        <QuotesList key={version} onOpen={setQuote} onNew={() => setCreating(true)} />
      )}
      {quote && (
        <QuoteDetail
          id={quote}
          onClose={() => setQuote(null)}
          onChanged={bump}
          onOpenSale={(id) => {
            setQuote(null);
            setSale(id);
          }}
        />
      )}
      {sale && <SaleDetail id={sale} onClose={() => setSale(null)} onChanged={bump} />}
      {creating && (
        <QuoteEditor
          initial={{}}
          onClose={() => setCreating(false)}
          onSaved={(saved) => {
            setCreating(false);
            bump();
            setQuote(saved.id);
          }}
        />
      )}
    </div>
  );
}
