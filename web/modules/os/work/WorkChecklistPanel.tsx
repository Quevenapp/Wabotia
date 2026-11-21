// OS6: checklist por etapa no detalhe da ordem. O modelo define os itens de
// cada etapa; aqui a equipe marca os da etapa atual (com a foto já anexada
// em Documentos, quando o item pede). A etapa só avança com os obrigatórios
// marcados; cada marcação fica no histórico. Etapas anteriores aparecem como
// registro, só leitura.
import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog } from "../../../admin/shared";
import { Button, Field, Notice, toast } from "../../../ui";
import type { Order, OrderChecklistStage } from "../work-contracts";
import { instantLabel, useWorkApi, useWorkResource } from "../work-hooks";
import { linkProps } from "../../../lib/routes";

type Item = OrderChecklistStage["items"][number];

/** OS6: ordem reaberta numa nova, ou trazida da ordem antiga do ERP. */
export function WorkLinks({ order }: { order: Order }) {
  if (!order.links?.length) return null;
  return <>{order.links.map(link => link.kind === "erp_document"
    ? <Notice key={link.kind}>{link.reason || "Trazida de uma ordem de serviço antiga do ERP."}</Notice>
    : <Notice key={link.kind}>{link.kind === "reopened_as" ? "O orçamento desta ordem foi reaberto numa ordem nova" : "Esta ordem continua o orçamento reaberto de outra ordem"}
      {link.reason ? ` (motivo: ${link.reason})` : ""}. <a {...linkProps({ area: "admin", page: "work", typeId: order.type_id, id: link.other_id })}>Abrir a outra ordem</a></Notice>)}</>;
}

function PhotoDialog({ order, item, onClose, onSubmit }: { order: Order; item: Item; onClose: () => void; onSubmit: (documentId: string) => Promise<unknown> }) {
  const app = useApp(), api = useWorkApi();
  const documents = useWorkResource(`${app.root}/os6-checklist-photos/${order.id}/${order.version}`, () => api.documents(order.id, { limit: 50 }));
  const photos = (documents.data?.data ?? []).filter(document => document.state === "ready" && document.mime_type.startsWith("image/"));
  const [choice, setChoice] = useState("");
  return <FormDialog title={`Foto: ${item.label}`} submitLabel="Marcar com esta foto" disabled={!photos.length} onClose={onClose} onSubmit={async () => {
    if (!choice) throw new Error("Escolha a foto.");
    await onSubmit(choice);
  }}>
    {!documents.data && !documents.error && <p role="status">Carregando as fotos da ordem…</p>}
    {documents.error ? <Notice tone="error">Não deu para ler os documentos da ordem agora. <Button secondary onClick={documents.reload}>Tentar de novo</Button></Notice> : null}
    {documents.data && !photos.length && <Notice>Este item pede foto. Anexe a foto na aba Documentos da ordem e volte para marcar.</Notice>}
    {photos.length > 0 && <Field label="Foto" value={choice} emptyOption="Escolha uma foto" options={photos.map(photo => ({ id: photo.id, name: photo.name }))} onChange={setChoice} />}
  </FormDialog>;
}

export function WorkChecklistPanel({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const api = useWorkApi();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [photoFor, setPhotoFor] = useState<Item>();
  const stages = order.checklist ?? [];
  if (!stages.length) return null;
  const closed = ["delivered", "cancelled"].includes(order.status);
  const mark = async (item: Item, done: boolean, photo?: string) => {
    setBusy(true); setError("");
    try {
      await api.markChecklist(order.id, { version: order.version, item_id: item.id, done, ...(photo ? { photo_document_id: photo } : {}) });
      toast(done ? "Item marcado." : "Item desmarcado."); onChanged();
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  };
  const toggle = (item: Item) => {
    if (!item.done && item.photo_required) { setPhotoFor(item); return; }
    void mark(item, !item.done).catch(() => {});
  };
  return <section className="card os-checklist" aria-label="Checklist">
    <h3>Checklist</h3>
    {stages.map(stage => <div key={stage.stage_id}>
      <h4>{stage.stage_label}{stage.current ? " (etapa atual)" : ""}</h4>
      <ul className="os-checklist-items">{stage.items.map(item => <li key={item.id}>
        <label>
          <input type="checkbox" checked={item.done} disabled={busy || closed || !stage.current} onChange={() => toggle(item)} />{" "}
          {item.label}{item.required ? " (obrigatório)" : ""}{item.photo_required ? " · com foto" : ""}
        </label>
        {item.done && item.at ? <span className="muted"> · {instantLabel(item.at)}</span> : null}
        {item.done && item.photo_document_id ? <> · <a href={api.documentUrl(order.id, item.photo_document_id, false)} target="_blank" rel="noreferrer">ver foto</a></> : null}
      </li>)}</ul>
      {stage.current && stage.missing.length > 0 && <p className="muted">Para avançar de etapa, falta marcar: {stage.missing.join(", ")}.</p>}
    </div>)}
    {error && <Notice tone="error">{error}</Notice>}
    {photoFor && <PhotoDialog order={order} item={photoFor} onClose={() => setPhotoFor(undefined)} onSubmit={async (documentId) => {
      await mark(photoFor, true, documentId); setPhotoFor(undefined);
    }} />}
  </section>;
}
