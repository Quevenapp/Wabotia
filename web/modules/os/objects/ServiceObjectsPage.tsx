import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Pager } from "../../../admin/shared";
import { ContactProfile } from "../../../contact-profile/ContactProfile";
import { Button, Dialog, Empty, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { ExtraFields, commonExtra, parseExtra } from "../components/ExtraFields";
import { StagePill } from "../components/StagePill";
import { WorkFormDialog, useWorkOperationAction, useWorkOperationDialog } from "../work/WorkFormDialog";
import { ResourceState, instantLabel, useDraftGuard, useWorkApi, useWorkResource } from "../work-hooks";
import type { ObjectPrivateFields, ServiceObjectType, ServiceObjectView, WorkField, WorkTypeView } from "../work-contracts";
import { ContractsInForce } from "../maintenance/ContractsPage";
import "../work.css";

export function ObjectLastCompleted({ completed }: { completed: ServiceObjectView["latest_completed"] }) {
  return <section aria-label="Último atendimento"><h3>Último atendimento</h3>
    {completed ? <p><a {...linkProps({ area: "erp", page: "work", typeId: "_", id: completed.id })}>Ordem #{completed.number}</a> · {completed.delivered_at == null ? "Data de conclusão indisponível" : instantLabel(completed.delivered_at)}</p>
      : <p>{completed === undefined ? "Último atendimento indisponível." : "Nenhuma ordem concluída registrada."}</p>}
    <p>Considera somente ordens com situação concluída, pela data de conclusão. Não usa o nome da etapa ou a data de abertura como conclusão.</p>
  </section>;
}

export function objectRevisionPreview(current: ServiceObjectView["type"], next: ServiceObjectType) {
  const common = (fields: WorkField[]) => fields.filter(field => !field.sensitive);
  return {
    added: common(next.fields).filter(field => !current.fields.some(old => old.id === field.id)),
    removed: common(current.fields).filter(field => !next.fields.some(newField => newField.id === field.id && !newField.sensitive)),
    changed: common(next.fields).filter(field => current.fields.some(old => old.id === field.id && !old.sensitive && JSON.stringify(old) !== JSON.stringify(field))),
  };
}

function ObjectEditor({ object, adoption, onClose, onSaved }: {
  object: ServiceObjectView;
  adoption?: ServiceObjectType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  const OperationDialog = useWorkOperationDialog();
  const [base, setBase] = useState(object), [values, setValues] = useState(commonExtra(object.type.fields, object.values)),
    [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false), [reviewed, setReviewed] = useState(false);
  const close = useDraftGuard(dirty, onClose), fields = adoption?.fields || base.type.fields;
  const changes = adoption ? objectRevisionPreview(base.type, adoption) : null;
  return <OperationDialog title={adoption ? "Revisar atualização da definição" : "Editar cadastro atual"} onClose={close}
    disabled={conflict || (!!adoption && !reviewed)} onSubmit={async () => {
      try {
        await api.updateObject(base.id, { version: base.version, values: parseExtra(fields, values), ...(adoption ? { adopt_revision: adoption.revision } : {}) });
        close.release(); onSaved();
      } catch (error) {
        if (["version_conflict", "object_definition_conflict"].includes((error as { code?: string }).code || "")) setConflict(true);
        throw error;
      }
    }}>
    <Notice>Somente o cadastro atual será alterado. As cópias nas ordens anteriores permanecem iguais.</Notice>
    {adoption && changes && <section className="os-object-preview">
      <p>Revisão adotada: {base.type_revision}. Revisão proposta: {adoption.revision}.</p>
      <p>Novos campos: {changes.added.map(field => field.label).join(", ") || "nenhum"}.</p>
      <p>Campos retirados do cadastro atual: {changes.removed.map(field => field.label).join(", ") || "nenhum"}.</p>
      <p>Definições alteradas: {changes.changed.map(field => field.label).join(", ") || "nenhuma"}.</p>
      <label className="os-object-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> Revisei a definição e os valores antes de adotar esta revisão.</label>
    </section>}
    <ExtraFields fields={fields} values={values} onChange={next => { setDirty(true); setValues(next); }} />
    {conflict && <Notice>Preenchimento preservado. <Button secondary onClick={async () => {
      const latest = await api.object(base.id);
      if (adoption) {
        const catalog = await api.objectTypes();
        const current = catalog.data.find(type => type.id === adoption.id);
        if (!current || current.revision !== adoption.revision) throw new Error("A definição mudou. Feche esta prévia e abra a revisão atual antes de adotar.");
      }
      setBase(latest); setConflict(false); setReviewed(false);
    }}>Recarregar versão e revisar</Button></Notice>}
  </OperationDialog>;
}

function PrivateEditor({ objectId, authorized, onClose, onSaved }: { objectId: string; authorized: ObjectPrivateFields; onClose: () => void; onSaved: () => void }) {
  const api = useWorkApi();
  const OperationDialog = useWorkOperationDialog();
  const [base, setBase] = useState(authorized), [values, setValues] = useState(authorized.values),
    [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false);
  // O endpoint privado autoriza antes de disponibilizar campos ao renderizador comum.
  const fields = base.fields.filter(field => field.sensitive).map(field => ({ ...field, sensitive: false }));
  const close = useDraftGuard(dirty, onClose);
  return <OperationDialog title="Campos restritos do cadastro atual" onClose={close} disabled={conflict} onSubmit={async () => {
    try {
      await api.updateObjectPrivateFields(objectId, { version: base.version, values: parseExtra(fields, values) });
      close.release(); onSaved();
    } catch (error) {
      if ((error as { code?: string }).code === "version_conflict") setConflict(true);
      throw error;
    }
  }}>
    <Notice>Leitura e escrita autorizadas separadamente pelo servidor. Estes valores não aparecem na ficha comum nem nas cópias exibidas aqui.</Notice>
    <ExtraFields fields={fields} values={values} onChange={next => { setDirty(true); setValues(next); }} />
    {conflict && <Notice>Seu preenchimento foi preservado. <Button secondary onClick={async () => { setBase(await api.objectPrivateFields(objectId)); setConflict(false); }}>Recarregar versão</Button></Notice>}
  </OperationDialog>;
}

function ObjectPrivateDialog({ objectId, onClose, onSaved }: { objectId: string; onClose: () => void; onSaved: () => void }) {
  const app = useApp(), api = useWorkApi();
  const resource = useWorkResource(app.identityKey + "/object-private/" + objectId, () => api.objectPrivateFields(objectId));
  if (!resource.data) return <><ResourceState resource={resource} /><Button secondary onClick={onClose}>Fechar campos restritos</Button></>;
  return <PrivateEditor objectId={objectId} authorized={resource.data} onClose={onClose} onSaved={onSaved} />;
}

function ObjectDetail({ object, reload }: { object: ServiceObjectView; reload: () => void }) {
  const app = useApp(), api = useWorkApi(), action = useWorkOperationAction();
  const [cursor, setCursor] = useState(""), [editing, setEditing] = useState(false), [adopting, setAdopting] = useState(false),
    [privateOpen, setPrivateOpen] = useState(false), [contactOpen, setContactOpen] = useState(false), [choosing, setChoosing] = useState(false), [opening, setOpening] = useState<WorkTypeView>();
  const catalog = useWorkResource(app.identityKey + "/object-work-types/" + object.id, () => api.types());
  const definitions = useWorkResource(app.identityKey + "/object-definitions/" + object.id, () => api.objectTypes());
  const orders = useWorkResource(app.identityKey + "/object-orders/" + object.id + "/" + cursor,
    () => api.objectOrders(object.id, { cursor: cursor || undefined, limit: 50 }), String(object.version));
  const currentType = definitions.data?.data.find(type => type.id === object.type_id && !type.archived);
  const compatible = catalog.data?.data.filter(type => type.kind === "custom" && !type.archived && type.object_type_id === object.type_id) || [];
  const changed = () => { setEditing(false); setAdopting(false); setPrivateOpen(false); reload(); };
  return <div className="os-work">
    <a {...linkProps({ area: "erp", page: "work" })}>← Ordens de serviço</a>
    <div className="os-work-toolbar"><h2>{object.type.labels.singular} · {object.identifier}</h2><span>{object.archived ? "Arquivado" : "Ativo"}</span></div>
    <p>Cadastro atual · versão {object.version} · definição adotada na revisão {object.type_revision}.</p>
    <p>Contato proprietário: {object.contact_id ? <Button secondary onClick={() => setContactOpen(true)}>Abrir ficha do cliente</Button> : "Informação indisponível"}.</p>
    <dl className="os-work-fields"><ExtraFields fields={object.type.fields} values={object.values} readOnly /></dl>
    <div className="card-actions">
      <Button secondary onClick={() => setEditing(true)}>Editar cadastro atual</Button>
      <Button secondary onClick={reload}>Recarregar cadastro atual</Button>
      <Button secondary disabled={action.busy} onClick={() => {
        if (!window.confirm(object.archived ? "Desarquivar este cadastro para novas ordens?" : "Arquivar este cadastro? O histórico e as ordens atuais serão preservados.")) return;
        void action.run(async () => { await api.archiveObject(object.id, { version: object.version, archived: !object.archived }); reload(); });
      }}>{object.archived ? "Desarquivar" : "Arquivar"}</Button>
      {Array.isArray(app.me.access) && app.me.access.includes("os:sensitive") && <Button secondary onClick={() => setPrivateOpen(true)}>Campos restritos</Button>}
      <Button disabled={object.archived || !object.contact_id || !compatible.length} onClick={() => setChoosing(true)}>Nova ordem para este objeto</Button>
    </div>
    {object.archived && <Notice>Cadastro arquivado: indisponível para novas seleções. O histórico e as cópias existentes permanecem acessíveis.</Notice>}
    <ResourceState resource={definitions} />
    {currentType && currentType.revision > object.type_revision && <Notice>Há uma revisão mais nova da definição. <Button secondary onClick={() => setAdopting(true)}>Revisar atualização da definição</Button></Notice>}
    <ObjectLastCompleted completed={object.latest_completed} />
    {/* OS4: contrato de manutenção vigente que cobre este objeto. */}
    <ContractsInForce objectId={object.id} />
    <section aria-label="Histórico das ordens"><h3>Histórico das ordens</h3><p>Por data de abertura, da mais recente para a mais antiga. Os campos abaixo pertencem a cada atendimento.</p>
      <ResourceState resource={orders} />
      {orders.data && <>
        {!orders.data.data.length && <p>Nenhuma ordem nesta página.</p>}
        <ul className="os-work-records">{orders.data.data.map(order => <li className="os-work-record" key={order.id}>
          <a {...linkProps({ area: "erp", page: "work", typeId: order.type_id, id: order.id })}>{order.display_number} · {order.type_label}</a>
          <p>Abertura: {instantLabel(order.created)}</p><StagePill status={order.status} label={order.stage_label} />
          <dl className="os-work-fields"><ExtraFields fields={order.fields} values={order.extra} readOnly /></dl>
        </li>)}</ul>
        <Pager cursor={cursor} nextCursor={orders.data.next_cursor} setCursor={setCursor} />
      </>}
    </section>
    <ResourceState resource={catalog} />
    {choosing && <Dialog title="Modelo da nova ordem" onClose={() => setChoosing(false)}><ul className="os-work-records">{compatible.map(type => <li key={type.id}>
      <Button secondary onClick={() => { setChoosing(false); setOpening(type); }}>{type.labels.singular}</Button>
    </li>)}</ul></Dialog>}
    {opening && <WorkFormDialog type={opening} initialContactId={object.contact_id} initialObjectId={object.id} onClose={() => setOpening(undefined)} onSaved={order => {
      setOpening(undefined); navigate({ area: "erp", page: "work", typeId: order.type_id, id: order.id });
    }} />}
    {editing && <ObjectEditor object={object} onClose={() => setEditing(false)} onSaved={changed} />}
    {adopting && currentType && <ObjectEditor object={object} adoption={currentType} onClose={() => setAdopting(false)} onSaved={changed} />}
    {privateOpen && <ObjectPrivateDialog objectId={object.id} onClose={() => setPrivateOpen(false)} onSaved={changed} />}
    {contactOpen && object.contact_id && <ContactProfile api={app.api} root={app.root} contactId={object.contact_id} scopeKey={app.identityKey}
      demo={app.demo} onClose={() => setContactOpen(false)} />}
  </div>;
}

/** Exportação da folha: os2-fecha a instala no ponto central installOs2Pages. */
export function ServiceObjectsPage({ objectId }: { objectId?: string }) {
  const app = useApp(), api = useWorkApi(), route = useRoute(), id = objectId || route.id;
  const resource = useWorkResource(id ? app.identityKey + "/service-object/" + id : null, () => api.object(id!));
  if (!id) return <Empty title="Selecione um objeto do cliente" description="Abra a ficha do contato ou o vínculo em uma ordem para consultar o cadastro atual e seu histórico." />;
  if (!resource.data) return <ResourceState resource={resource} />;
  return <ObjectDetail key={app.identityKey + ":" + id} object={resource.data} reload={resource.reload} />;
}

export const os2OperationalPages = { ServiceObjectsPage };
