// OS6: "Trazer para a ordem de serviço" de uma ordem antiga do ERP, uma por
// vez e com prévia. A lista do ERP (só leitura com o módulo ligado) abre esta
// tela com ?erp_document=<id>. Copia cliente, itens (como orçamento em
// análise) e a situação; as duas ficam ligadas e a antiga fica migrada.
import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog } from "../../../admin/shared";
import { Field, Notice, Button, toast } from "../../../ui";
import { navigate } from "../../../lib/routes";
import type { WorkTypeView } from "../work-contracts";
import { money } from "../shared";
import { useWorkApi, useWorkResource } from "../work-hooks";

export function ErpLegacyImportDialog({ documentId, types, onClose }: { documentId: string; types: readonly WorkTypeView[]; onClose: () => void }) {
  const app = useApp(), api = useWorkApi();
  const preview = useWorkResource(`${app.root}/os6-erp-legacy/${documentId}`, () => api.erpLegacy(documentId));
  const choices = types.filter(type => !type.archived && !type.object_type_id);
  const [typeId, setTypeId] = useState(choices.some(type => type.id === "service_order") ? "service_order" : choices[0]?.id ?? "");
  const data = preview.data;
  return <FormDialog title="Trazer para a ordem de serviço" submitLabel="Trazer" disabled={!data?.can_import || !typeId} onClose={onClose} onSubmit={async () => {
    const order = await api.importErpLegacy(documentId, { type_id: typeId });
    toast(`Ordem ${order.display_number} criada a partir da ordem do ERP.`);
    navigate({ area: "admin", page: "work", typeId: order.type_id, id: order.id });
  }}>
    {!data && !preview.error && <p role="status">Lendo a ordem do ERP…</p>}
    {preview.error ? <Notice tone="error">{(preview.error as Error).message || "Não deu para ler a ordem do ERP agora."} <Button secondary onClick={preview.reload}>Tentar de novo</Button></Notice> : null}
    {data && <>
      <p>Ordem do ERP nº {data.number ?? "—"}{data.date ? ` de ${data.date.split("-").reverse().join("/")}` : ""} · situação: {data.status_label}</p>
      <dl className="os-work-facts">
        <div><dt>Cliente</dt><dd>{data.customer.name ?? "Sem cliente"}{!data.customer.found && data.customer.name ? " (fora do cadastro da área)" : ""}</dd></div>
        <div><dt>Item</dt><dd>{data.item}</dd></div>
        <div><dt>Problema</dt><dd>{data.problem}</dd></div>
      </dl>
      {data.items.length > 0 ? <ul>{data.items.map((item, index) => <li key={index}>{item.quantity} {item.unit} × {item.description} · {money(item.unit_cents)}</li>)}</ul>
        : <p className="muted">Sem itens: a ordem nova abre sem orçamento.</p>}
      {data.items.length > 0 && <p>Total dos itens: <strong>{money(data.total_cents)}</strong></p>}
      <p className="muted">A ordem nova abre com estes itens como orçamento em análise (envie e registre a aprovação de novo). A situação do ERP fica no histórico e nas observações. Nada muda no ERP: a ordem antiga continua lá, só leitura, ligada à nova.</p>
      {data.migrated && <Notice>Esta ordem do ERP já foi trazida. <a href={`/app/erp/modulos/trabalhos?origem=${encodeURIComponent(data.migrated.order_id)}`}>Abrir a ordem {data.migrated.display_number}</a></Notice>}
      {data.blockers.length > 0 && !data.migrated && <Notice tone="error"><ul>{data.blockers.map(text => <li key={text}>{text}</li>)}</ul></Notice>}
      {data.can_import && choices.length > 1 && <Field label="Modelo da ordem nova" value={typeId} emptyOption={null}
        options={choices.map(type => ({ id: type.id, name: type.labels.singular }))} onChange={setTypeId} />}
    </>}
  </FormDialog>;
}
