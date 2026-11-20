// OS3: o comercial da ordem no detalhe (clássica e modelos): orçamento com
// descontos e condições, aprovação com quem e quando, reabertura com motivo,
// cobrança (Pix ou link pela Cobrança da área) e recebimento à mão, e
// impressão em A4 ou cupom de 80 mm. O recebimento chega ao Financeiro do
// ERP pela fila da fase 3 da própria ordem; nada é lançado por aqui.
import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog } from "../../../admin/shared";
import { Button, Field, Notice, toast } from "../../../ui";
import type { DecisionDetail, Order, OrderPayments, ReceiptMethod } from "../work-contracts";
import { cents, money } from "../shared";
import { dateTimeInput, dateTimeValue, instantLabel, useWorkApi, useWorkResource } from "../work-hooks";
import { QuoteEditor } from "./QuoteEditor";
import { buildPrintHtml, conditionsLines, openPrint, type PrintFormat, type PrintKind } from "./print";

/** Mesma regra do servidor: cancelar e voltar etapa pedem motivo. */
export function needsReason(from: string, to: string) {
  return to === "cancelled" ||
    (from === "ready" && to === "in_progress") ||
    (["quoted", "approved", "declined"].includes(from) && to === "analyzing");
}
export function reasonTitle(from: string, to: string) {
  return to === "cancelled" ? "Motivo do cancelamento" : from === "ready" ? "Motivo do retrabalho" : "Motivo para voltar à análise";
}

/** Pede o motivo antes de enviar; o motivo vai para o histórico da ordem. */
export function ReasonDialog({ title, help, submitLabel = "Confirmar", danger, onClose, onSubmit }: {
  title: string; help?: string; submitLabel?: string; danger?: boolean;
  onClose: () => void; onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  return <FormDialog title={title} onClose={onClose} submitLabel={submitLabel} danger={danger} onSubmit={async () => {
    if (!reason.trim()) throw new Error("Informe o motivo. Ele fica registrado no histórico da ordem.");
    await onSubmit(reason.trim());
  }}>
    <Field label="Motivo" type="textarea" required maxLength={500} value={reason} onChange={setReason}
      help={help || "Fica no histórico da ordem, com quem fez e quando."} />
  </FormDialog>;
}

const CHANNELS = [
  { id: "phone", name: "Telefone" }, { id: "counter", name: "Balcão" }, { id: "whatsapp", name: "WhatsApp" },
  { id: "email", name: "E-mail" }, { id: "other", name: "Outro meio" },
];
/** Registro à mão da resposta do cliente: quem respondeu, quando e por onde. */
export function DecisionDialog({ order, decision, onClose, onSubmit }: {
  order: Order; decision: "approve" | "decline"; onClose: () => void;
  onSubmit: (body: { note: string; detail: { by_name: string; at: number; channel: DecisionDetail["channel"] } }) => Promise<unknown>;
}) {
  const [name, setName] = useState(order.customer?.name || ""), [when, setWhen] = useState(dateTimeInput(Date.now()));
  const [channel, setChannel] = useState("phone"), [reason, setReason] = useState("");
  const approve = decision === "approve";
  return <FormDialog title={approve ? "Registrar aprovação do orçamento" : "Registrar recusa do orçamento"} onClose={onClose}
    submitLabel={approve ? "Registrar aprovação" : "Registrar recusa"} danger={!approve} onSubmit={async () => {
      if (!name.trim()) throw new Error("Informe quem respondeu.");
      const at = dateTimeValue(when);
      if (!at) throw new Error("Informe quando o cliente respondeu.");
      await onSubmit({ note: reason.trim(), detail: { by_name: name.trim(), at, channel: channel as DecisionDetail["channel"] } });
    }}>
    <p>Total: <strong>{money(order.quote?.total_cents)}</strong>{approve ? ". Depois de aprovado, o orçamento fica travado; mudar exige reabrir com motivo." : ""}</p>
    <Field label={approve ? "Quem aprovou" : "Quem recusou"} required maxLength={120} value={name} onChange={setName} />
    <div className="form-field-grid">
      <Field label="Quando" type="datetime-local" required value={when} onChange={setWhen} />
      <Field label="Por onde" value={channel} emptyOption={null} options={CHANNELS} onChange={setChannel} />
    </div>
    <Field label={approve ? "Observação (opcional)" : "Motivo da recusa"} type="textarea" maxLength={500} value={reason} onChange={setReason} />
  </FormDialog>;
}

const METHODS: { id: ReceiptMethod; name: string }[] = [
  { id: "pix", name: "Pix" }, { id: "cash", name: "Dinheiro" }, { id: "card", name: "Cartão" }, { id: "other", name: "Outra forma" },
];
function ReceiptDialog({ payments, onClose, onSubmit }: {
  payments: OrderPayments; onClose: () => void; onSubmit: (body: { amount_cents: number; method: ReceiptMethod; occurred_at: number; note: string }) => Promise<unknown>;
}) {
  const [amount, setAmount] = useState(payments.balance_cents ? (payments.balance_cents / 100).toFixed(2).replace(".", ",") : "");
  const [method, setMethod] = useState<string>("pix"), [when, setWhen] = useState(dateTimeInput(Date.now())), [note, setNote] = useState("");
  return <FormDialog title="Registrar recebimento" onClose={onClose} submitLabel="Registrar" onSubmit={async () => {
    const value = cents(amount);
    if (!value || value <= 0) throw new Error("Informe o valor recebido, por exemplo 150,00.");
    const at = dateTimeValue(when);
    if (!at) throw new Error("Informe quando recebeu.");
    if (at > Date.now() + 5 * 60_000) throw new Error("A data do recebimento não pode estar no futuro.");
    await onSubmit({ amount_cents: value, method: method as ReceiptMethod, occurred_at: at, note: note.trim() });
  }}>
    <p>Total {money(payments.total_cents)} · Recebido {money(payments.received_cents)} · Saldo <strong>{money(payments.balance_cents)}</strong></p>
    <div className="form-field-grid">
      <Field label="Valor recebido (R$)" required value={amount} onChange={setAmount} placeholder="0,00" />
      <Field label="Forma" value={method} emptyOption={null} options={METHODS} onChange={setMethod} />
      <Field label="Quando" type="datetime-local" required value={when} onChange={setWhen} />
    </div>
    <Field label="Observação (opcional)" maxLength={200} value={note} onChange={setNote} />
    {!payments.finance.enabled && <Notice>O Financeiro do ERP está desligado: o recebimento fica registrado só na ordem.</Notice>}
    {payments.finance.enabled && !payments.finance.obligation && <Notice>A conta a receber desta ordem é criada no Financeiro quando o serviço começa. Este recebimento segue para lá junto com ela.</Notice>}
  </FormDialog>;
}

const PAYABLE = ["approved", "in_progress", "ready", "delivered"];
const RECEIPT_LABELS: Record<string, string> = { pix: "Pix", cash: "Dinheiro", card: "Cartão", other: "Outra forma", unknown: "Forma não informada" };
const CHARGE_STATUS: Record<string, string> = { created: "aguardando pagamento", paid: "paga", expired: "vencida", cancelled: "cancelada", refunded: "estornada" };

export function WorkQuoteCommercial({ order, onChanged, editable }: {
  order: Order;
  onChanged: () => void;
  /** Etapa atual permite montar/editar o orçamento. */
  editable: boolean;
}) {
  const app = useApp(), api = useWorkApi();
  const payments = useWorkResource(`${app.root}/os3-payments/${order.id}/${order.version}`, () => api.payments(order.id));
  const [editing, setEditing] = useState(false), [reopen, setReopen] = useState(false), [receipt, setReceipt] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const data = payments.data, quote = order.quote;
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError("");
    try { await action(); toast(success); onChanged(); payments.reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const print = async (kind: PrintKind, format: PrintFormat) => {
    try {
      const company = await api.establishment().catch(() => null);
      const html = buildPrintHtml({ order, company, privacy: data?.privacy, received_cents: data?.received_cents }, kind, format);
      if (!openPrint(html)) setError("Permita janelas pop-up neste endereço para imprimir ou salvar em PDF.");
    } catch (e) { setError((e as Error).message); }
  };
  const payable = PAYABLE.includes(order.status) && order.decision?.decision !== "declined" && !!quote;
  const detail = order.decision?.detail;
  const discount = (quote?.items_discount_cents ?? 0) + (quote?.discount_cents ?? 0);
  return <section className="card os-quote-commercial" aria-label="Orçamento e recebimento">
    <h3>Orçamento e recebimento</h3>
    {quote ? <>
      <ul className="os-quote-summary">{quote.items.map((item, index) => <li key={item.id || index}>
        {item.quantity} × {item.description}{item.code ? ` (${item.code})` : ""} · {money(item.unit_cents)}{item.discount_cents ? ` · desconto ${money(item.discount_cents)}` : ""}
        {item.kind && item.kind !== "free" ? ` · ${item.kind === "service" ? "serviço" : "peça"} do catálogo${data?.catalog_links[item.id || ""] ? "" : " (sem vínculo)"}` : ""}
      </li>)}</ul>
      <p>{discount ? <>Subtotal {money(quote.subtotal_cents)} · Descontos {money(discount)} · </> : null}<strong>Total {money(quote.total_cents)}</strong></p>
      {conditionsLines(order).map((line) => <p key={line} className="muted">{line}</p>)}
      {order.decision && <p className="muted">{order.decision.decision === "approved" ? "Aprovado" : "Recusado"}
        {detail ? ` por ${detail.by_name} (${CHANNELS.find((c) => c.id === detail.channel)?.name.toLowerCase() || detail.channel}) em ${instantLabel(detail.at)}`
          : ` em ${instantLabel(order.decision.at)}${order.decision.via === "whatsapp" ? " pelo cliente no WhatsApp" : ""}`}
        {detail?.reason ? ` · ${detail.reason}` : ""}</p>}
      {order.status === "approved" && <Notice>Orçamento aprovado e travado. Para mudar, reabra com o motivo (fica no histórico).</Notice>}
    </> : <p className="muted">Nenhum orçamento ainda.</p>}
    <div className="card-actions">
      {editable && <Button secondary onClick={() => setEditing(true)}>{quote ? "Editar orçamento" : "Montar orçamento"}</Button>}
      {order.status === "approved" && <Button secondary disabled={busy} onClick={() => setReopen(true)}>Reabrir orçamento</Button>}
      <Button secondary onClick={() => void print("quote", "a4")} disabled={!quote}>Imprimir orçamento (A4)</Button>
      <Button secondary onClick={() => void print("order", "a4")}>Imprimir ordem (A4)</Button>
      <Button secondary onClick={() => void print(order.status === "quoted" || order.status === "analyzing" ? "quote" : "order", "cupom")}>Cupom 80 mm</Button>
    </div>
    {payable && data && <div className="os-quote-payments">
      <p>Total {money(data.total_cents)} · Recebido {money(data.received_cents)} · Saldo <strong>{money(data.balance_cents)}</strong></p>
      {data.receipts.length > 0 && <ul>{data.receipts.map((r) => <li key={r.receipt_key}>
        {r.kind === "reverse" ? "Estorno" : "Recebido"} {money(r.amount_cents)} · {RECEIPT_LABELS[r.method] || r.method} · {instantLabel(r.occurred_ms)}{r.evidence === "provider" ? " · pela Cobrança" : ""}
      </li>)}</ul>}
      {data.charges.length > 0 && <ul>{data.charges.map((c) => <li key={c.id}>
        {c.method === "pix" ? "Pix" : "Link"} de {money(c.amount_cents)} · {CHARGE_STATUS[c.status] || c.status}
        {c.status === "created" && c.url ? <> · <a href={c.url} target="_blank" rel="noreferrer">abrir link</a></> : null}
        {c.status === "created" && c.pix_code ? <> · <Button secondary size="sm" onClick={() => void navigator.clipboard?.writeText(c.pix_code!).then(() => toast("Código Pix copiado."))}>Copiar código Pix</Button></> : null}
      </li>)}</ul>}
      <div className="card-actions">
        {data.balance_cents > 0 && data.provider.ready && order.customer?.conversation_id && data.provider.methods.includes("pix") &&
          <Button secondary disabled={busy} onClick={() => void run(() => api.charge(order.id, { method: "pix" }), "Pix enviado na conversa.")}>Gerar Pix ({money(data.balance_cents)})</Button>}
        {data.balance_cents > 0 && data.provider.ready && order.customer?.conversation_id && data.provider.methods.includes("link") &&
          <Button secondary disabled={busy} onClick={() => void run(() => api.charge(order.id, { method: "link" }), "Link de pagamento enviado na conversa.")}>Gerar link de pagamento</Button>}
        <Button secondary disabled={busy} onClick={() => setReceipt(true)}>Registrar recebimento</Button>
      </div>
      {!data.provider.ready && <p className="muted">Sem cobrança automática: {data.provider.message || "configure a Cobrança da área."} Registre o recebimento à mão.</p>}
      {data.provider.ready && !order.customer?.conversation_id && <p className="muted">Para enviar Pix ou link, a ordem precisa estar ligada a uma conversa do WhatsApp.</p>}
      {!data.finance.enabled && <p className="muted">Financeiro do ERP desligado: os recebimentos ficam registrados só na ordem.</p>}
    </div>}
    {payable && payments.error ? <Notice tone="error">Não foi possível ler os recebimentos agora. <Button secondary onClick={payments.reload}>Tentar novamente</Button></Notice> : null}
    {error && <Notice tone="error">{error}</Notice>}
    {editing && <QuoteEditor order={order} links={data?.catalog_links} products={data?.parts.products} finance={data ? data.parts.finance : false}
      reserved={data?.privacy === "reserved"} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); payments.reload(); }} />}
    {reopen && <ReasonDialog title="Reabrir orçamento aprovado" submitLabel="Reabrir"
      help="A aprovação deixa de valer: o orçamento volta para análise e precisa ser enviado e aprovado de novo. O motivo fica no histórico."
      onClose={() => setReopen(false)} onSubmit={async (reason) => {
        await api.reopenQuote(order.id, { version: order.version, reason });
        setReopen(false); toast("Orçamento reaberto."); onChanged();
      }} />}
    {receipt && data && <ReceiptDialog payments={data} onClose={() => setReceipt(false)} onSubmit={async (body) => {
      await api.receipt(order.id, body);
      setReceipt(false); toast("Recebimento registrado."); onChanged(); payments.reload();
    }} />}
  </section>;
}
