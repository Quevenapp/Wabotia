import { CatalogLinkPicker } from '../../integrations/CatalogLinkPicker';
import type { CommercialItem } from '../../integrations/contracts';
import React, { useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { Button, Field } from "../../../ui";
import type { Order } from "../work-contracts";
import { cents } from "../shared";
import { useDraftGuard, useWorkApi } from "../work-hooks";
import { ConflictRecovery, useConflictRecovery } from "../components/ConflictRecovery";
import { money } from "../shared";
export function QuoteEditor({
  order,
  onClose,
  onSaved,
}: {
  order: Order;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  const recovery = useConflictRecovery(order, async () => ({ record: await api.order(order.id) }));
  const [lines, setLines] = useState(
    order.quote?.items.map((item) => ({
      id: (item as typeof item & Partial<CommercialItem>).id || crypto.randomUUID(),
      product_id: (item as typeof item & Partial<CommercialItem>).product_id || null,
      unit: (item as typeof item & Partial<CommercialItem>).unit || "UN",
      kind: (item as typeof item & Partial<CommercialItem>).kind || "free",
      description: item.description,
      quantity: String(item.quantity),
      price: String(item.unit_cents / 100),
    })) || [{ id: crypto.randomUUID(), product_id: null as string | null, unit: "UN", kind: "free" as CommercialItem["kind"], description: "", quantity: "1", price: "" }],
  );
  const [note, setNote] = useState(order.quote?.note || ""),
    [days, setDays] = useState(order.quote?.valid_days == null ? "" : String(order.quote.valid_days)),
    [dirty, setDirty] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  return (
    <FormDialog
      title={`Orçamento · ${order.display_number}`}
      onClose={close}
      disabled={recovery.conflict}
      onSubmit={async () => {
        const items = lines.map((line) => {
          const unit_cents = cents(line.price),
            quantity = Number(line.quantity);
          if (unit_cents == null || !Number.isFinite(quantity) || quantity <= 0)
            throw new Error("Confira preço e quantidade dos itens.");
          return { id: line.id, product_id: line.product_id, unit: line.unit, kind: line.kind, description: line.description, quantity, unit_cents };
        });
        await recovery.run(() => api.quote(order.id, {
          items, note, version: recovery.base!.version,
          ...(days.trim() ? { valid_days: Number(days) } : {}),
        }));
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
      {lines.map((line, index) => (
        <fieldset key={line.id}>
          <legend>Item {index + 1}</legend>
          {(["description", "quantity", "price"] as const).map((key) => (
            <Field
              key={key}
              label={
                key === "description"
                  ? "Descrição"
                  : key === "quantity"
                    ? "Quantidade"
                    : "Preço unitário (R$)"
              }
              required
              value={line[key]}
              onChange={(value) => {
                setDirty(true);
                setLines(
                  lines.map((item, i) =>
                    i === index ? { ...item, [key]: value } : item,
                  ),
                );
              }}
            />
          ))}
          <CatalogLinkPicker value={{ erp_item_id: line.product_id, version: 0 }} onChange={(value, item) => {
            setDirty(true);
            setLines(lines.map((row, i) => i === index ? { ...row, product_id: value.erp_item_id, unit: item?.unit || row.unit, kind: item ? (item.kind === 'S' ? 'service' : 'material') : 'free' } : row));
          }} />
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
      <Button
        secondary
        onClick={() => {
          setDirty(true);
          setLines([...lines, { id: crypto.randomUUID(), product_id: null as string | null, unit: "UN", kind: "free" as CommercialItem["kind"], description: "", quantity: "1", price: "" }]);
        }}
      >
        Adicionar item
      </Button>
      <Field
        label="Validade em dias"
        help="Deixe vazio para usar a validade configurada na abertura do trabalho."
        type="number"
        value={days}
        onChange={(value) => {
          setDirty(true);
          setDays(value);
        }}
        min={1}
        max={90}
      />
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
