// Pedido no painel da conversa: pedidos em andamento deste cliente e a ação
// "Montar pedido para este cliente", que envia o link do carrinho pelo
// WhatsApp. Ligado em web/modules/conversation.tsx.
import React, { useEffect, useState } from "react";
import { ShoppingCart } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { Button, Pill } from "../../ui";
import { OrderDetail } from "./OrdersPage";
import { money, statusLabels, statusTones } from "./shared";

export function ConversationPedido({
  conversation,
}: {
  conversation: Row;
  name: string;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const [orders, setOrders] = useState<Row[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = () =>
    app
      .api(
        `${app.root}/pedido/orders?open=1&conversation_id=${encodeURIComponent(conversation.id)}`,
      )
      .then((result) => setOrders(result.data || []))
      .catch(() => setOrders([]));
  useEffect(() => {
    void load();
  }, [conversation.id]);
  return (
    <section className="info-section">
      <h4>Pedidos</h4>
      {orders.length ? (
        <div className="info-web-steps">
          {orders.map((order) => (
            <button
              type="button"
              key={order.id}
              className="info-web-step"
              onClick={() => setOpenId(order.id)}
            >
              <span className="info-ticket-top">
                <strong className="truncate">
                  Nº {order.number} · {money(order.total_cents)}
                </strong>
                <Pill tone={statusTones[order.status] || "muted"}>
                  {statusLabels[order.status] || order.status}
                </Pill>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Nenhum pedido em andamento deste cliente.</p>
      )}
      <div className="card-actions">
        <Button
          secondary
          size="sm"
          busy={busy}
          icon={<ShoppingCart size={16} />}
          onClick={() =>
            void run(
              async () => {
                const result = await write(
                  `${app.root}/conversations/${conversation.id}/actions`,
                  "POST",
                  { action: "pedido_link" },
                );
                if (!result?.sent)
                  throw new Error(
                    result?.reason === "empty_menu"
                      ? "Cadastre o cardápio antes de enviar o link."
                      : "A loja está fechada agora: o cliente recebeu o horário de funcionamento.",
                  );
              },
              { success: "Link do carrinho enviado ao cliente.", retry: false },
            )
          }
        >
          Montar pedido para este cliente
        </Button>
      </div>
      {openId && (
        <OrderDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}
