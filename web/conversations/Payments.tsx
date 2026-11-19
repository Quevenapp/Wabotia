// Cobranças da conversa (docs/COBRANCA.md): estado de cada uma e a ação
// "Cobrar" (Pix ou link de pagamento pelo Mercado Pago da área).
import React, { useState } from "react";
import { Ban, CreditCard, Plus } from "lucide-react";
import type { Row } from "../lib/api";
import { whenLabel } from "../lib/format";
import { Button, Confirm, Field, Pill, toast, type PillTone } from "../ui";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import { FormDialog } from "../admin/shared";

export const paymentStates: Record<string, [string, PillTone]> = {
  created: ["Aguardando", "warn"],
  paid: ["Paga", "ok"],
  expired: ["Expirada", "muted"],
  cancelled: ["Cancelada", "muted"],
  refunded: ["Estornada", "danger"],
};
const money = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** "12,50" ou "12.50" → 1250; inválido → NaN. */
export const parseAmount = (value: string) => {
  const clean = value.replace(/[^\d,.]/g, "");
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  return /^\d+(\.\d{1,2})?$/.test(normalized)
    ? Math.round(Number(normalized) * 100)
    : NaN;
};

function ChargeDialog({
  conversationId,
  onClose,
  onDone,
}: {
  conversationId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const app = useApp();
  const [method, setMethod] = useState("pix"),
    [amount, setAmount] = useState(""),
    [description, setDescription] = useState("");
  return (
    <FormDialog
      title="Cobrar"
      subtitle="O cliente recebe o botão de pagamento na conversa."
      size="sm"
      submitLabel="Enviar cobrança"
      onClose={onClose}
      onSubmit={async () => {
        const cents = parseAmount(amount);
        if (!Number.isFinite(cents) || cents < 1)
          throw new Error("Informe o valor, por exemplo 49,90.");
        await app.api(
          `${app.root}/conversations/${conversationId}/actions`,
          "POST",
          { action: "charge", method, amount_cents: cents, description },
        );
        toast("Cobrança enviada ao cliente.");
        onDone();
        onClose();
      }}
    >
      <Field
        label="Forma de pagamento"
        value={method}
        onChange={setMethod}
        emptyOption=""
        options={[
          { id: "pix", name: "Pix (QR Code e copia e cola)" },
          { id: "link", name: "Link de pagamento (cartão, Pix e outros)" },
        ]}
      />
      <Field
        label="Valor (R$)"
        value={amount}
        onChange={setAmount}
        placeholder="49,90"
        required
      />
      <Field
        label="Descrição"
        value={description}
        onChange={setDescription}
        maxLength={120}
        required
        placeholder="Consulta de 15/11"
      />
    </FormDialog>
  );
}

export function PaymentsSection({
  conversationId,
  payments,
  canCharge,
  refresh,
}: {
  conversationId: string;
  payments: Row[];
  canCharge: boolean;
  refresh: () => Promise<any>;
}) {
  const app = useApp();
  const { busy, run } = useAction();
  const [charging, setCharging] = useState(false),
    [cancelling, setCancelling] = useState<Row | null>(null);
  if (!payments.length && !canCharge) return null;
  return (
    <section className="info-section">
      <h4>
        Cobranças
        {canCharge && (
          <button
            type="button"
            className="text-link"
            onClick={() => setCharging(true)}
          >
            <Plus size={14} /> Cobrar
          </button>
        )}
      </h4>
      {payments.length ? (
        <div className="info-web-steps">
          {payments.map((payment) => {
            const [label, tone] = paymentStates[payment.status] || [
              payment.status,
              "muted",
            ];
            return (
              <div className="info-web-step" key={payment.id}>
                <span className="info-ticket-top">
                  <strong className="truncate">
                    <CreditCard size={13} /> {money(payment.amount_cents)}
                  </strong>
                  <Pill tone={tone}>{label}</Pill>
                </span>
                <small className="truncate">{payment.description}</small>
                <small>
                  {payment.method === "pix" ? "Pix" : "Link de pagamento"} ·{" "}
                  {payment.status === "paid" && payment.paid_at
                    ? "paga " + whenLabel(payment.paid_at, app.now)
                    : "enviada " + whenLabel(payment.created, app.now)}
                </small>
                {payment.review_required && <p role="alert">{payment.review_reason === "refund_amount_unconfirmed"
                  ? "Reembolso com valor total não comprovado. Confira o total devolvido no provedor antes de conciliar o estorno."
                  : "Este pagamento precisa de conferência pela equipe financeira."}</p>}
                {payment.status === "created" && canCharge && (
                  <Button
                    secondary
                    size="sm"
                    icon={<Ban size={14} />}
                    disabled={busy}
                    onClick={() => setCancelling(payment)}
                  >
                    Cancelar cobrança
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">Nenhuma cobrança nesta conversa.</p>
      )}
      {charging && (
        <ChargeDialog
          conversationId={conversationId}
          onClose={() => setCharging(false)}
          onDone={() => void refresh()}
        />
      )}
      {cancelling && (
        <Confirm
          title="Cancelar esta cobrança?"
          confirmLabel="Cancelar cobrança"
          cancelLabel="Voltar"
          danger
          onClose={() => setCancelling(null)}
          onConfirm={() => {
            const target = cancelling;
            setCancelling(null);
            void run(
              async () => {
                await app.api(
                  `${app.root}/payments/${target.id}/cancel`,
                  "POST",
                  {},
                );
                await refresh();
              },
              { success: "Cobrança cancelada." },
            );
          }}
        >
          <p>
            O link e o código Pix deixam de valer. Se o cliente já pagou, o
            pagamento confirmado pelo Mercado Pago aparece aqui mesmo assim.
          </p>
        </Confirm>
      )}
    </section>
  );
}
