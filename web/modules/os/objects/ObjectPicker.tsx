import React, { useEffect, useRef, useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Button, Field, Notice } from "../../../ui";
import { commonExtra, ExtraFields, parseExtra } from "../components/ExtraFields";
import type { ExtraValues, ObjectOpeningRequest, ServiceObjectType } from "../work-contracts";
import { ResourceState, useWorkApi, useWorkResource } from "../work-hooks";

export function parseObjectOpening(value: ObjectOpeningRequest | undefined, type?: ServiceObjectType): ObjectOpeningRequest {
  if (!value) throw new Error("Selecione um objeto ou escolha Cadastrar outro.");
  if (value.mode === "existing") return { mode: "existing", id: value.id, version: value.version };
  if (!type || type.id !== value.type_id || type.archived) throw new Error("Recarregue o tipo de objeto antes de cadastrar.");
  return { mode: "new", type_id: type.id, values: parseExtra(type.fields, value.values) };
}

export function ObjectPicker({ contactId, typeId, value, onChange, onType, initialObjectId, refreshKey = 0 }: {
  contactId: string;
  typeId: string;
  value?: ObjectOpeningRequest;
  onChange: (value: ObjectOpeningRequest | undefined) => void;
  onType?: (type: ServiceObjectType) => void;
  initialObjectId?: string;
  refreshKey?: number;
}) {
  const app = useApp(), api = useWorkApi();
  const [inline, setInline] = useState<ExtraValues>(value?.mode === "new" ? value.values : {});
  const catalog = useWorkResource(app.identityKey + "/object-types/picker/" + typeId, () => api.objectTypes(), String(refreshKey));
  const objects = useWorkResource(contactId ? app.identityKey + "/object-choices/" + contactId + "/" + typeId : null,
    () => api.objects({ contact_id: contactId, type_id: typeId, include_archived: "0", limit: 30 }), String(refreshKey));
  const type = catalog.data?.data.find(candidate => candidate.id === typeId);
  const choices = objects.data?.data.filter(object => !object.archived && object.type_id === typeId && (!object.contact_id || object.contact_id === contactId)) || [];
  const selected = value?.mode === "existing" ? choices.find(object => object.id === value.id) : undefined;
  const callbacks = useRef({ onChange, onType });
  callbacks.current = { onChange, onType };
  const initialized = useRef(false);
  useEffect(() => { if (type) callbacks.current.onType?.(type); }, [type]);
  useEffect(() => {
    if (initialized.current || !initialObjectId || !objects.data) return;
    initialized.current = true;
    const object = objects.data.data.find(candidate => candidate.id === initialObjectId && !candidate.archived && candidate.type_id === typeId && (!candidate.contact_id || candidate.contact_id === contactId));
    if (object && !value) callbacks.current.onChange({ mode: "existing", id: object.id, version: object.version });
  }, [objects.data, initialObjectId, typeId, contactId, value]);
  if (!contactId) return <Notice>Selecione o contato confirmado antes de escolher o objeto do serviço.</Notice>;
  return <fieldset className="os-object-picker">
    <legend>{type?.labels.singular || "Objeto do serviço"}</legend>
    <ResourceState resource={catalog} />
    <ResourceState resource={objects} />
    {catalog.data && !type && <Notice tone="error">O tipo de objeto não está disponível. Recarregue o modelo antes de abrir a ordem.</Notice>}
    {objects.data && <Field label={`Selecionar ${type?.labels.singular.toLowerCase() || "objeto"}`} value={value?.mode === "existing" ? value.id : value?.mode === "new" ? "__new" : ""}
      emptyOption="Selecione um cadastro" options={[
        ...choices.map(object => ({ id: object.id, name: object.identifier })),
        ...(type && !type.archived ? [{ id: "__new", name: "Cadastrar outro" }] : []),
      ]} onChange={id => {
        if (value?.mode === "new") setInline(value.values);
        if (id === "__new" && type && !type.archived) onChange({ mode: "new", type_id: type.id, values: inline });
        else {
          const object = choices.find(candidate => candidate.id === id);
          onChange(object ? { mode: "existing", id: object.id, version: object.version } : undefined);
        }
      }} />}
    {value?.mode === "existing" && objects.data && (!selected || selected.version !== value.version) && <Notice tone="error">
      O cadastro selecionado mudou ou não está mais disponível. O preenchimento desta ordem foi preservado. Revise e selecione o cadastro novamente.
      {selected && <Button secondary onClick={() => onChange({ mode: "existing", id: selected.id, version: selected.version })}>Usar versão atual revisada</Button>}
    </Notice>}
    {selected && <>
      <p>Cadastro selecionado · versão {selected.version}, revisão {selected.type_revision}.</p>
      {type && selected.type_revision < type.revision && <Notice>Há uma revisão mais nova da definição. Esta abertura usa a definição adotada pelo cadastro; atualize a ficha separadamente se necessário.</Notice>}
      <dl className="os-work-fields"><ExtraFields fields={selected.type.fields} values={selected.values} readOnly /></dl>
    </>}
    {value?.mode === "new" && type && <>
      <p>Dados do objeto. O cadastro será salvo junto com a ordem.</p>
      <ExtraFields fields={type.fields} values={value.values} onChange={values => {
        const safe = commonExtra(type.fields, values);
        setInline(safe);
        onChange({ mode: "new", type_id: type.id, values: safe });
      }} />
    </>}
    <Button secondary onClick={() => { objects.reload(); catalog.reload(); }}>Recarregar cadastros</Button>
  </fieldset>;
}
