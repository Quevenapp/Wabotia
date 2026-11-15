// Ordem de Serviço no painel da conversa: ordens abertas deste cliente,
// "Abrir ordem de serviço" (a equipe preenche) e "Enviar link de abertura"
// (o cliente preenche). Ligado em web/modules/conversation.tsx.
import React, { useEffect, useState } from "react";
import { FilePlus2, Send } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { navigate } from "../../lib/routes";
import { Button, Field, Pill, toast } from "../../ui";
import { FormDialog } from "../../admin/shared";
import { statusLabels, statusTones } from "./shared";

export function ConversationServiceOrders({
  conversation,
}: {
  conversation: Row;
  name: string;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const [orders, setOrders] = useState<Row[]>([]);
  const [opening, setOpening] = useState(false);
  const [item, setItem] = useState(""),
    [problem, setProblem] = useState("");
  const load = () =>
    app
      .api(
        `${app.root}/service-orders?open=1&conversation_id=${encodeURIComponent(conversation.id)}`,
      )
      .then((result) => setOrders(result.data || []))
      .catch(() => setOrders([]));
  useEffect(() => {
    void load();
  }, [conversation.id]);
  const action = (body: Row) =>
    write(`${app.root}/conversations/${conversation.id}/actions`, "POST", {
      action: "service_order",
      ...body,
    });
  return (
    <section className="info-section">
      <h4>Ordens de serviço</h4>
      {orders.length ? (
        <div className="info-web-steps">
          {orders.map((order) => (
            <button
              type="button"
              key={order.id}
              className="info-web-step os-conversation-order"
              onClick={() =>
                navigate({ area: "admin", page: "service-orders" as any })
              }
            >
              <span className="info-ticket-top">
                <strong className="truncate">
                  Nº {order.number} · {order.item}
                </strong>
                <Pill tone={statusTones[order.status] || "muted"}>
                  {statusLabels[order.status] || order.status}
                </Pill>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Nenhuma ordem aberta para este cliente.</p>
      )}
      <div className="card-actions">
        <Button
          secondary
          size="sm"
          icon={<FilePlus2 size={16} />}
          onClick={() => setOpening(true)}
        >
          Abrir ordem de serviço
        </Button>
        <Button
          secondary
          size="sm"
          busy={busy}
          icon={<Send size={16} />}
          onClick={() =>
            void run(() => action({ send_form: true }), {
              success: "Link de abertura enviado ao cliente.",
            })
          }
        >
          Enviar link de abertura
        </Button>
      </div>
      {opening && (
        <FormDialog
          title="Abrir ordem de serviço"
          size="sm"
          submitLabel="Abrir ordem"
          onClose={() => setOpening(false)}
          onSubmit={async () => {
            await action({ item, problem });
            toast("Ordem de serviço aberta.");
            setOpening(false);
            setItem("");
            setProblem("");
            await load();
          }}
        >
          <Field
            label="Item (aparelho, peça, roupa…)"
            value={item}
            onChange={setItem}
            maxLength={120}
            required
          />
          <Field
            label="Problema relatado"
            type="textarea"
            rows={3}
            value={problem}
            onChange={setProblem}
            required
          />
        </FormDialog>
      )}
    </section>
  );
}
