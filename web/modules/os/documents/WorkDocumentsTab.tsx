import React, { useRef, useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { useAction } from "../../../app/hooks";
import { Button, Notice } from "../../../ui";
import {
  ChildCollection,
  VisibilityFields,
  assertVisibility,
} from "../components/ChildCollection";
import type {
  DocumentMetadata,
  DocumentReservation,
  Order,
} from "../work-contracts";
import { uploadDocument } from "../work-api";
import { instantLabel, useDraftGuard, useWorkApi } from "../work-hooks";
function UploadDialog({
  workId,
  onClose,
  onSaved,
}: {
  workId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  const [file, setFile] = useState<File | null>(null),
    [visibility, setVisibility] = useState({
      client_visible: false,
      sensitive: false,
    });
  const [progress, setProgress] = useState("");
  const reservation = useRef<DocumentReservation | null>(null),
    uploadKey = useRef(crypto.randomUUID());
  const close = useDraftGuard(!!file, onClose);
  return (
    <FormDialog
      title="Anexar documento"
      onClose={close}
      onSubmit={async () => {
        assertVisibility(visibility);
        if (!file || !file.size || file.size > 10 * 1024 * 1024)
          throw new Error("Selecione um arquivo entre 1 byte e 10 MiB.");
        setProgress("Reservando documento…");
        if (!reservation.current)
          reservation.current = await api.reserveDocument(workId, {
            name: file.name,
            mime_type: file.type || "application/octet-stream",
            expected_bytes: file.size,
            ...visibility,
          });
        const saved = reservation.current;
        setProgress("Enviando arquivo…");
        // Endpoint derivado de IDs autorizados: não seguimos uma URL externa da resposta.
        const uploaded = await uploadDocument(
          api.documentUrl(workId, saved.id),
          file,
          saved.version,
          uploadKey.current,
        );
        setProgress("Confirmando arquivo…");
        await api.completeDocument(workId, saved.id, {
          version: uploaded.version,
          upload_attempt: uploaded.upload_attempt,
        });
        onSaved();
      }}
    >
      <label className="field">
        <span>Arquivo (máximo 10 MiB)</span>
        <input
          type="file"
          disabled={!!reservation.current}
          onChange={(event) => {
            setFile(event.target.files?.[0] || null);
            reservation.current = null;
            uploadKey.current = crypto.randomUUID();
          }}
          required
        />
      </label>
      {file && (
        <p>
          {file.name} · {file.size.toLocaleString("pt-BR")} bytes
        </p>
      )}
      {!reservation.current && (
        <VisibilityFields value={visibility} onChange={setVisibility} />
      )}
      {progress && (
        <Notice>
          <span role="status">{progress}</span> Repetir após falha retoma o
          mesmo documento.
        </Notice>
      )}
    </FormDialog>
  );
}
export function WorkDocumentsTab({
  order,
  onChanged,
}: {
  order: Order;
  onChanged: () => void;
}) {
  const api = useWorkApi(),
    action = useAction();
  const [uploading, setUploading] = useState(false),
    [sending, setSending] = useState<DocumentMetadata | null>(null),
    [revision, setRevision] = useState(0);
  const changed = () => {
    setUploading(false);
    setSending(null);
    setRevision((n) => n + 1);
    onChanged();
  };
  return (
    <>
      <ChildCollection<DocumentMetadata>
        workId={order.id}
        collection="documents"
        revision={revision}
        load={(cursor) => api.documents(order.id, { cursor, limit: 50 })}
        create={() => (
          <Button onClick={() => setUploading(true)}>Anexar documento</Button>
        )}
        render={(document) => (
          <>
            <strong>{document.name}</strong>
            <span>
              {document.byte_length ?? document.expected_bytes} bytes ·{" "}
              {instantLabel(document.created)}
            </span>
            <span>
              {document.state === "ready"
                ? "Disponível"
                : document.state === "pending"
                  ? "Envio pendente"
                  : "Envio interrompido"}{" "}
              ·{" "}
              {document.sensitive
                ? "Restrito"
                : document.client_visible
                  ? "Pode ser entregue ao cliente"
                  : "Somente equipe"}
            </span>
            <div className="card-actions">
              {document.state === "ready" && (
                <a
                  className="button secondary"
                  href={api.documentUrl(order.id, document.id)}
                  download={document.name}
                >
                  Baixar
                </a>
              )}
              {document.state === "ready" &&
                document.client_visible &&
                !document.sensitive &&
                order.customer.conversation_id && (
                  <Button secondary onClick={() => setSending(document)}>
                    Enviar ao cliente
                  </Button>
                )}
              <Button
                secondary
                disabled={action.busy}
                onClick={() => {
                  if (window.confirm(`Arquivar ${document.name}?`))
                    void action.run(async () => {
                      await api.archive(
                        order.id,
                        "documents",
                        document.id,
                        document.version,
                      );
                      changed();
                    });
                }}
              >
                Arquivar
              </Button>
            </div>
          </>
        )}
      />
      {uploading && (
        <UploadDialog
          workId={order.id}
          onClose={() => setUploading(false)}
          onSaved={changed}
        />
      )}
      {sending && (
        <FormDialog
          title="Enviar documento"
          submitLabel="Enviar"
          onClose={() => setSending(null)}
          onSubmit={async () => {
            await api.sendDocument(order.id, sending.id, sending.version);
            changed();
          }}
        >
          <p>
            Arquivo: <strong>{sending.name}</strong>
          </p>
          <p>
            Destinatário: <strong>{order.customer.name}</strong>
            {order.customer.phone ? ` · ${order.customer.phone}` : ""}
          </p>
          <Notice>
            O documento será enviado à conversa do titular deste trabalho.
          </Notice>
        </FormDialog>
      )}
    </>
  );
}
