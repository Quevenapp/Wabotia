// Orçamento da ordem (todos os modelos, inclusive a clássica): peças e
// serviços do catálogo do ERP ou itens avulsos, desconto por item e no total,
// e as condições de pagamento. Cada linha guarda o próprio id: o vínculo de
// catálogo fica preso a ele e não se perde ao editar por qualquer tela.
import React, { useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { Button, Field, Notice, toast } from "../../../ui";
import type { Order, QuoteTerms } from "../work-contracts";
import { cents } from "../shared";
import { useDraftGuard, useWorkApi } from "../work-hooks";
import { ConflictRecovery, useConflictRecovery } from "../components/ConflictRecovery";
import { money } from "../shared";
import { CatalogSearch, QuoteTermsFields, termsDraft, termsBody, type TermsDraft } from "./QuoteParts";

type Kind = "material" | "service" | "free";
export interface QuoteLine {
  id: string;
  kind: Kind;
  unit: string;
  code: string;
  description: string;
  quantity: string;
  price: string;
  discount: string;
  /** Produto escolhido nesta edição: o vínculo é gravado depois de salvar. */
  pick: string | null;
  /** Produto já vinculado (na tabela de vínculos do ERP). */
  linked: string | null;
  /** OS4: coberto pelo contrato de manutenção (valor zero). */
  covered?: boolean;
}
const blank = (): QuoteLine => ({ id: crypto.randomUUID(), kind: "free", unit: "UN", code: "", description: "", quantity: "1", price: "", discount: "", pick: null, linked: null });
const decimal = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
/** Bruto da linha em centavos (quantidade decimal), como o servidor. */
export function lineCents(line: Pick<QuoteLine, "quantity" | "price">) {
  const unit = cents(line.price), quantity = Number(String(line.quantity).replace(",", "."));
  return unit === null || !Number.isFinite(quantity) ? 0 : Math.round(quantity * unit);
}
export function draftTotals(lines: QuoteLine[], discount: string) {
  const subtotal = lines.reduce((sum, line) => sum + lineCents(line), 0);
  const items = lines.reduce((sum, line) => sum + (cents(line.discount) ?? 0), 0);
  const order = cents(discount) ?? 0;
  return { subtotal, discounts: items + order, total: subtotal - items - order };
}

export function QuoteEditor({
  order,
  onClose,
  onSaved,
  links,
  products,
  finance,
  reserved,
}: {
  order: Order;
  onClose: () => void;
  onSaved: () => void;
  /** Vínculos atuais (id da linha → produto), de GET …/payments. */
  links?: Record<string, { erp_item_id: string; version: number }>;
  /** Parte Produtos e serviços ligada: busca no catálogo. */
  products?: boolean;
  /** Parte Financeiro ligada: parcelas. */
  finance?: boolean;
  /** Modelo de área sensível: pede a confirmação do pagador adulto. */
  reserved?: boolean;
}) {
  const api = useWorkApi();
  const recovery = useConflictRecovery(order, async () => ({ record: await api.order(order.id) }));
  const [lines, setLines] = useState<QuoteLine[]>(() =>
    order.quote?.items.map((item) => ({
      id: item.id || crypto.randomUUID(),
      kind: (item.kind || "free") as Kind,
      unit: item.unit || "UN",
      code: item.code || "",
      description: item.description,
      quantity: String(item.quantity),
      price: decimal(item.unit_cents),
      discount: item.discount_cents ? decimal(item.discount_cents) : "",
      pick: null,
      linked: (item.id && links?.[item.id]?.erp_item_id) || item.product_id || null,
      covered: item.covered === true,
    })) || [blank()],
  );
  // OS4: ordem coberta por contrato: cada item pode entrar como coberto (valor zero).
  const [coverable] = useState(() => !!order.quote?.items.some((item) => item.covered));
  const [note, setNote] = useState(order.quote?.note || ""),
    [days, setDays] = useState(order.quote?.valid_days == null ? "" : String(order.quote.valid_days)),
    [discount, setDiscount] = useState(order.quote?.discount_cents ? decimal(order.quote.discount_cents) : ""),
    [terms, setTerms] = useState<TermsDraft>(() => termsDraft(order.quote?.terms as QuoteTerms | null | undefined)),
    [touchedTerms, setTouchedTerms] = useState(false),
    [adult, setAdult] = useState(false),
    [dirty, setDirty] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  const change = (index: number, patch: Partial<QuoteLine>) => {
    setDirty(true);
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  const totals = draftTotals(lines, discount);
  return (
    <FormDialog
      title={`Orçamento · ${order.display_number}`}
      subtitle={order.status === "quoted"
        ? "Este orçamento já foi enviado. Ao salvar, ele volta para análise até você enviar de novo."
        : "Salve e depois envie ao cliente pelo WhatsApp ou registre a aprovação."}
      size="lg"
      onClose={close}
      disabled={recovery.conflict}
      onSubmit={async () => {
        const items = lines.map((line, index) => {
          const unit_cents = cents(line.price),
            quantity = Number(String(line.quantity).replace(",", "."));
          if (unit_cents == null || !Number.isFinite(quantity) || quantity <= 0)
            throw new Error(`Confira preço e quantidade do item ${index + 1}. Use, por exemplo, 150,00.`);
          const discount_cents = line.discount.trim() ? cents(line.discount) : 0;
          if (discount_cents == null || discount_cents > lineCents(line))
            throw new Error(`O desconto do item ${index + 1} precisa ser um valor até o total do item.`);
          return {
            id: line.id, unit: line.unit, kind: line.kind, description: line.description, quantity, unit_cents,
            ...(discount_cents ? { discount_cents } : {}),
            ...(line.code ? { code: line.code } : {}),
            ...(line.covered ? { covered: true } : {}),
          };
        });
        const total_discount = discount.trim() ? cents(discount) : 0;
        if (total_discount == null || totals.total < 0) throw new Error("O desconto passa do valor dos itens.");
        const previousTerms = !!order.quote?.terms;
        await recovery.run(() => api.quote(order.id, {
          items, note, version: recovery.base!.version,
          ...(days.trim() ? { valid_days: Number(days) } : {}),
          ...(total_discount || order.quote?.discount_cents ? { discount_cents: total_discount } : {}),
          ...(touchedTerms || previousTerms ? { terms: termsBody(terms, finance !== false) } : {}),
          ...(reserved && adult ? { adult_payer_confirmed: true } : {}),
        }));
        // Vínculo de catálogo: depois de a linha existir, pela rota da fase 3.
        const failed: string[] = [];
        for (const line of lines.filter((line) => line.pick !== null && line.pick !== line.linked))
          await api.linkCatalog(order.id, line.id, { erp_item_id: line.pick, version: links?.[line.id]?.version ?? 0 })
            .catch((error: Error) => failed.push(`${line.description}: ${error.message}`));
        if (failed.length) toast(`Orçamento salvo. Vínculo com o catálogo não gravado: ${failed.join("; ")}`);
        setDirty(false);
        onSaved();
      }}
    >
      <ConflictRecovery recovery={recovery}>
        {recovery.latest?.record?.quote && <>
          <ul>{recovery.latest.record.quote.items.map((item, index) => <li key={index}>{item.description} · {item.quantity} × {money(item.unit_cents)}</li>)}</ul>
          <p>{recovery.latest.record.quote.note} · Validade: {recovery.latest.record.quote.valid_days} dias</p>
        </>}
      </ConflictRecovery>
      {products
        ? <CatalogSearch onPick={(item) => {
            const empty = lines.length === 1 && !lines[0].description && !lines[0].price;
            const line: QuoteLine = { ...blank(), kind: item.kind, unit: item.unit || "UN", code: item.code || "", description: item.name.slice(0, 200),
              price: item.price_cents === null ? "" : decimal(item.price_cents), pick: item.id };
            setDirty(true);
            setLines(empty ? [line] : [...lines, line]);
          }} />
        : <Notice>Itens avulsos: digite descrição e valor. Para buscar peças e serviços do catálogo, ligue Produtos e serviços em Gestão → Módulos.</Notice>}
      {lines.map((line, index) => (
        <fieldset key={line.id} className="os-quote-line">
          <legend>Item {index + 1}{line.kind !== "free" ? ` · ${line.kind === "service" ? "Serviço" : "Peça"} do catálogo` : " · Avulso"}{line.code ? ` · ${line.code}` : ""}</legend>
          <Field label="Descrição" required value={line.description} maxLength={200} onChange={(value) => change(index, { description: value })} />
          <div className="form-field-grid">
            <Field label="Quantidade" required value={line.quantity} onChange={(value) => change(index, { quantity: value })} />
            <Field label="Preço unitário (R$)" required value={line.price} disabled={line.covered} onChange={(value) => change(index, { price: value })} placeholder="0,00" />
            <Field label="Desconto do item (R$)" value={line.discount} disabled={line.covered} onChange={(value) => change(index, { discount: value })} placeholder="0,00" />
          </div>
          {(coverable || line.covered) && <label className="os-check"><input type="checkbox" checked={!!line.covered}
            onChange={(event) => change(index, event.target.checked ? { covered: true, price: "0,00", discount: "" } : { covered: false })} /> Coberto pelo contrato (valor zero)</label>}
          <p className="muted">Total do item: {money(lineCents(line) - (cents(line.discount) ?? 0))}
            {line.kind !== "free" && !(line.pick ?? line.linked) && " · Sem vínculo: não baixa estoque"}</p>
          {line.kind !== "free" && (
            <Button secondary onClick={() => change(index, { kind: "free", pick: line.linked ? null : line.pick, code: "" })}>Tornar avulso</Button>
          )}
          <Button
            secondary
            onClick={() => {
              setDirty(true);
              setLines(lines.filter((_, i) => i !== index));
            }}
            disabled={lines.length === 1}
          >
            Remover item
          </Button>
        </fieldset>
      ))}
      {lines.length < 50 && (
        <Button
          secondary
          onClick={() => {
            setDirty(true);
            setLines([...lines, blank()]);
          }}
        >
          Adicionar item avulso
        </Button>
      )}
      <div className="form-field-grid">
        <Field label="Desconto no total (R$)" value={discount} placeholder="0,00" onChange={(value) => { setDirty(true); setDiscount(value); }} />
        <Field
          label="Validade em dias"
          help="Deixe vazio para usar a validade configurada no modelo."
          type="number"
          value={days}
          onChange={(value) => {
            setDirty(true);
            setDays(value);
          }}
          min={1}
          max={90}
        />
      </div>
      <p className="os-quote-totals">
        Subtotal {money(totals.subtotal)}{totals.discounts ? ` · Descontos ${money(totals.discounts)}` : ""} · <strong>Total {money(totals.total)}</strong>
      </p>
      <QuoteTermsFields value={terms} total={totals.total} finance={finance !== false} customerName={order.customer?.name || ""}
        onChange={(value) => { setDirty(true); setTouchedTerms(true); setTerms(value); }} />
      {reserved && (
        <label className="check">
          <input type="checkbox" checked={adult} onChange={(event) => { setDirty(true); setAdult(event.target.checked); }} />{" "}
          Confirmo que o pagador é maior de idade e responsável financeiro.
        </label>
      )}
      <Field
        label="Observação do orçamento"
        type="textarea"
        value={note}
        onChange={(value) => {
          setDirty(true);
          setNote(value);
        }}
      />
    </FormDialog>
  );
}
