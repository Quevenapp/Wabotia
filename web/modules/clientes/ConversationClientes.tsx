// Dados da conversa → Cadastro: a ficha do cliente (mascarada) pelo telefone
// confirmado da conversa, link de autocadastro e pedido de exclusão aberto.
import React from "react";
import { IdCard, Send } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { Button, Notice, Pill } from "../../ui";
import { useResource } from "../../admin/shared";
import type { ConversationExtensionProps } from "../conversation";
import { erasureLabels, kindLabels } from "./shared";

export function ConversationClientes({ conversation }: ConversationExtensionProps) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const status = useResource(`${app.root}/clientes/conversations/${conversation.id}`);
  const data: Row | null = status.data;
  if (!data) return null;
  const customer: Row | null = data.customer;
  return (
    <section className="info-section">
      <h4>Cadastro</h4>
      {customer ? (
        <p>
          <IdCard size={14} /> {customer.name || "—"} <Pill tone="muted">{kindLabels[customer.kind]}</Pill>
          <br />
          <small className="muted">
            {customer.document_display || "sem CPF/CNPJ"} · {customer.email || "sem e-mail"}
            {customer.address?.city ? ` · ${customer.address.city}/${customer.address.uf}` : ""}
          </small>
        </p>
      ) : (
        <p className="muted">Sem ficha para este telefone.</p>
      )}
      {customer?.erasure && (
        <Notice tone="warn">Exclusão dos dados: {erasureLabels[customer.erasure.status]?.toLowerCase()}.</Notice>
      )}
      {data.phone_verified && (!customer || customer.status === "active") ? (
        <div className="card-actions">
          <Button
            secondary
            size="sm"
            icon={<Send size={15} />}
            disabled={busy}
            onClick={() =>
              void run(
                async () => {
                  await write(`${app.root}/clientes/invites`, "POST", { conversation_id: conversation.id });
                  await status.reload();
                },
                { success: customer ? "Link de correção enviado." : "Link de cadastro enviado." },
              )
            }
          >
            {customer ? "Enviar link para corrigir" : "Enviar link de cadastro"}
          </Button>
        </div>
      ) : (
        !data.phone_verified && (
          <small className="muted">Conversa sem telefone confirmado pelo WhatsApp: o cadastro não se liga a ela.</small>
        )
      )}
    </section>
  );
}
