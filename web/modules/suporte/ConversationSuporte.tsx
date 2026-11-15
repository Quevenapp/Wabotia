// Dados da conversa → Suporte pago: se o cliente está liberado, por quê e até
// quando; aviso de telefone não vinculado com "Vincular ao pagador"; confirmar
// (modo só telefone vinculado) e liberar como cortesia, com motivo.
import React, { useState } from "react";
import { Gift, Link2, ShieldCheck } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { Button, Field, Notice, Pill } from "../../ui";
import { FormDialog, useResource } from "../../admin/shared";
import type { ConversationExtensionProps } from "../conversation";
import { kindLabels, stampLabel } from "./shared";

export function ConversationSuporte({
  conversation,
}: ConversationExtensionProps) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const status = useResource(
    `${app.root}/suporte/conversations/${conversation.id}`,
  );
  const [courtesy, setCourtesy] = useState(false);
  const [reason, setReason] = useState("");
  const data: Row | null = status.data;
  if (!data) return null;
  const act = (path: string, success: string, body: Row = {}) =>
    void run(
      async () => {
        await write(
          `${app.root}/suporte/conversations/${conversation.id}/${path}`,
          "POST",
          body,
        );
        await status.reload();
      },
      { success },
    );
  return (
    <section className="info-section">
      <h3>Suporte pago</h3>
      {data.release ? (
        <p>
          <Pill tone="ok">Liberado</Pill>{" "}
          {kindLabels[data.release.kind] || data.release.kind}
          {data.release.payer_name ? ` · ${data.release.payer_name}` : ""}
          <br />
          <small className="muted">
            {data.release.valid_until
              ? `Até ${stampLabel(data.release.valid_until)}`
              : `Até o protocolo fechar (no máximo ${stampLabel(data.release.expires_at)})`}
            {data.release.reason ? ` · ${data.release.reason}` : ""}
          </small>
        </p>
      ) : (
        <p>
          <Pill tone={data.allowed ? "ok" : "muted"}>
            {data.allowed ? "Assinatura em dia" : "Sem liberação"}
          </Pill>
        </p>
      )}
      {data.awaiting_team ? (
        <Notice tone="warn">
          O cliente digitou o CPF/CNPJ de{" "}
          {data.unlinked_phone?.payer_name || "um cadastro"}, mas este telefone
          não é autorizado por ele. Nada foi liberado nem mostrado. Confirme a
          identidade antes de liberar.
        </Notice>
      ) : (
        data.unlinked_phone && (
          <Notice tone="warn">
            Telefone não vinculado ao pagador {data.unlinked_phone.payer_name}.
            Confira com o cliente.
          </Notice>
        )
      )}
      <div className="card-actions">
        {data.unlinked_phone && (
          <Button
            secondary
            size="sm"
            icon={<Link2 size={15} />}
            disabled={busy}
            onClick={() => act("link-phone", "Telefone vinculado ao pagador.")}
          >
            Vincular ao pagador
          </Button>
        )}
        {data.awaiting_team && (
          <Button
            secondary
            size="sm"
            icon={<ShieldCheck size={15} />}
            disabled={busy}
            onClick={() =>
              act("confirm", "Identidade confirmada e suporte liberado.", {
                link: true,
              })
            }
          >
            Confirmar identidade e liberar
          </Button>
        )}
        {!data.release && (
          <Button
            secondary
            size="sm"
            icon={<Gift size={15} />}
            onClick={() => setCourtesy(true)}
          >
            Liberar como cortesia
          </Button>
        )}
      </div>
      {courtesy && (
        <FormDialog
          title="Liberar como cortesia"
          subtitle="Fica registrado quem liberou e o motivo."
          submitLabel="Liberar"
          onClose={() => setCourtesy(false)}
          onSubmit={async () => {
            await write(
              `${app.root}/suporte/conversations/${conversation.id}/courtesy`,
              "POST",
              { reason },
            );
            setCourtesy(false);
            setReason("");
            await status.reload();
          }}
        >
          <Field
            label="Motivo"
            value={reason}
            onChange={setReason}
            maxLength={300}
            required
            placeholder="Ex.: cliente antigo, falha nossa, primeira vez"
          />
        </FormDialog>
      )}
    </section>
  );
}
