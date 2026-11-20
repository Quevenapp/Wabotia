import React, { useState } from "react";
import { Button, Field, Notice } from "../../../ui";
import type { CustomWorkType, ServiceObjectType, WorkField } from "../work-contracts";
import { ExtraFields } from "../components/ExtraFields";
import { FieldsEditor } from "../types/FieldsEditor";
import { newObjectType, prepareField } from "../types/type-draft";
import { FieldLocationEditor } from "./FieldLocationEditor";
import "./object-types.css";

export interface ObjectTypesEditorProps {
  type: CustomWorkType;
  objectTypes: ServiceObjectType[];
  workTypes: CustomWorkType[];
  previousObjectTypes?: ServiceObjectType[];
  previousType?: CustomWorkType;
  onChange: (type: CustomWorkType, objectTypes: ServiceObjectType[], affectedTypes?: CustomWorkType[]) => void;
}

function retireRemoved(previous: WorkField[], fields: WorkField[], retired: string[]) {
  // IDs ainda não salvos podem acompanhar a digitação do rótulo.
  if (fields.length >= previous.length) return retired;
  return [...new Set([...retired, ...previous.filter((field) => field.id && !fields.some((entry) => entry.id === field.id)).map((field) => field.id)])];
}

/** Remove somente referências deste rascunho que o administrador acaba de aposentar. */
function reconcileRules(type: CustomWorkType, object?: ServiceObjectType): CustomWorkType {
  const next = { ...type };
  if (next.stage_field_rules) {
    next.stage_field_rules = next.stage_field_rules.filter((rule) => type.fields.some((field) => field.id === rule.field_id && !field.sensitive));
    if (!next.stage_field_rules.length) delete next.stage_field_rules;
  }
  if (next.list_fields) {
    next.list_fields = next.list_fields.filter((rule) => {
      const field = (rule.ref.scope === "object" ? object?.fields : type.fields)?.find((entry) => entry.id === rule.ref.field_id);
      return field && !field.sensitive;
    });
    if (!next.list_fields.length) delete next.list_fields;
  }
  return next;
}

export function ObjectTypesEditor({ type, objectTypes, workTypes, previousObjectTypes = [], previousType, onChange }: ObjectTypesEditorProps) {
  const [managedId, setManagedId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{
    object: ServiceObjectType;
    type: CustomWorkType;
    affectedTypes: CustomWorkType[];
    changes: Array<{ model: string; field: string; removed: string }>;
  }>();
  const [preview, setPreview] = useState<"staff" | "customer">("staff");
  const selected = objectTypes.find((entry) => entry.id === type.object_type_id);
  const managed = objectTypes.find((entry) => entry.id === (managedId || type.object_type_id));
  const previousObject = previousObjectTypes.find((entry) => entry.id === managed?.id);
  const affected = managed ? workTypes.filter((entry) => entry.id !== type.id && entry.object_type_id === managed.id) : [];
  const total = type.fields.length + (selected?.fields.length ?? 0);
  const changeObject = (next: ServiceObjectType, nextType = type) => {
    const affectedTypes: CustomWorkType[] = [];
    const changes: Array<{ model: string; field: string; removed: string }> = [];
    for (const model of workTypes.filter((entry) => entry.id !== nextType.id && entry.object_type_id === next.id)) {
      const list = (model.list_fields ?? []).flatMap((rule) => {
        if (rule.ref.scope !== "object") return [rule];
        const field = next.fields.find((entry) => entry.id === rule.ref.field_id);
        const before = objectTypes.find((entry) => entry.id === next.id)?.fields.find((entry) => entry.id === rule.ref.field_id);
        if (!field || field.sensitive) {
          changes.push({ model: model.labels.singular, field: before?.label || rule.ref.field_id,
            removed: [rule.column ? "coluna" : "", rule.filter ? "filtro" : ""].filter(Boolean).join(" e ") });
          return [];
        }
        if (rule.filter && field.kind === "text" && (field.multiline || field.max_length > 240)) {
          changes.push({ model: model.labels.singular, field: field.label, removed: "filtro (a coluna, se marcada, permanece)" });
          if (!rule.column) return [];
          const remaining = { ...rule };
          delete remaining.filter;
          return [remaining];
        }
        return [rule];
      });
      if (JSON.stringify(list) !== JSON.stringify(model.list_fields ?? [])) {
        const updated = { ...model };
        if (list.length) updated.list_fields = list;
        else delete updated.list_fields;
        affectedTypes.push(updated);
      }
    }
    if (affectedTypes.length) {
      setPending({ object: next, type: nextType, affectedTypes, changes });
      return;
    }
    const objectList = objectTypes.map((entry) => entry.id === next.id ? next : entry);
    onChange(reconcileRules(nextType, objectList.find((entry) => entry.id === nextType.object_type_id)), objectList);
  };
  const setObjectFields = (fields: WorkField[]) => {
    if (!managed) return;
    setError("");
    const identifierIndex = managed.fields.findIndex((field) => field.id === managed.identifier_field_id);
    const identifier = fields.length === managed.fields.length && identifierIndex >= 0 &&
      !fields.some((field) => field.id === managed.identifier_field_id)
      ? fields[identifierIndex]?.id || managed.identifier_field_id : managed.identifier_field_id;
    changeObject({ ...managed, fields, identifier_field_id: identifier,
      retired_field_ids: retireRemoved(managed.fields, fields, managed.retired_field_ids) });
  };
  const visibleFields = (fields: WorkField[]) => fields.filter((field) => !field.sensitive && (preview === "staff" || field.client_visible)).map(prepareField);
  return <section className="os2-object-editor">
    {pending && <section className="os2-move-review" aria-label="Revisar modelos afetados">
      <h3>Revisar modelos afetados</h3>
      <p>Esta mudança no tipo compartilhado exige remover referências incompatíveis. Os campos dos demais modelos permanecem iguais.</p>
      <ul>{pending.changes.map((change, index) => <li key={index}>{change.model}: {change.field} — remover {change.removed}.</li>)}</ul>
      <p>As definições do objeto e dos modelos serão enviadas juntas ao salvar, com a revisão observada. Ordens existentes não mudam.</p>
      <div className="card-actions"><Button secondary onClick={() => {
        const objectList = objectTypes.map((entry) => entry.id === pending.object.id ? pending.object : entry);
        onChange(reconcileRules(pending.type, objectList.find((entry) => entry.id === pending.type.object_type_id)), objectList, pending.affectedTypes);
        setPending(undefined);
      }}>Confirmar alterações nos modelos afetados</Button>
        <Button secondary onClick={() => setPending(undefined)}>Cancelar mudança</Button></div>
    </section>}
    <fieldset className="os2-config" disabled={!!pending}>
    <Field label="Objeto do serviço" value={type.object_type_id ?? ""} emptyOption="Sem objeto"
      options={objectTypes.filter((entry) => !entry.archived || entry.id === type.object_type_id).map((entry) => ({ id: entry.id, name: `${entry.labels.singular}${entry.archived ? " · Arquivado" : ""}` }))}
      onChange={(id) => {
        const next = { ...type };
        if (id) next.object_type_id = id;
        else delete next.object_type_id;
        if (next.list_fields) {
          next.list_fields = next.list_fields.filter((rule) => rule.ref.scope === "order");
          if (!next.list_fields.length) delete next.list_fields;
        }
        setManagedId(id);
        onChange(next, objectTypes);
      }} />
    <p>O objeto pertence a um cliente e reúne o histórico dos serviços. Campos desta ordem registram cada atendimento, como a quilometragem na visita.</p>
    <Button secondary disabled={objectTypes.length >= 20} onClick={() => {
      const object = newObjectType(objectTypes.map((entry) => entry.id));
      setManagedId(object.id);
      const next = { ...type, object_type_id: object.id };
      if (next.list_fields) {
        next.list_fields = next.list_fields.filter((rule) => rule.ref.scope === "order");
        if (!next.list_fields.length) delete next.list_fields;
      }
      onChange(next, [...objectTypes, object]);
    }}>Criar tipo de objeto</Button>
    <p className="os2-field-help">Até 20 tipos por área, incluindo arquivados. Tipos atuais: {objectTypes.length}/20.</p>
    {objectTypes.length > 0 && <details className="os2-manage-objects" open={!!managed}>
      <summary>Editar tipos de objeto desta área</summary>
      <Field label="Tipo de objeto para editar" value={managed?.id ?? ""} emptyOption="Selecione um tipo"
        options={objectTypes.map((entry) => ({ id: entry.id, name: `${entry.labels.singular}${entry.archived ? " · Arquivado" : ""}` }))}
        onChange={setManagedId} />
      {managed && <>
        <Notice>Compartilhado com: {[...(type.object_type_id === managed.id ? [type.labels.singular] : []), ...affected.map((entry) => entry.labels.singular)].join(", ") || "nenhum modelo"}. Alterações serão salvas juntas, com revisão. Objetos e ordens existentes conservam a definição adotada.</Notice>
        <Field label="Nome do objeto (singular)" value={managed.labels.singular} maxLength={80} required
          onChange={(value) => changeObject({ ...managed, labels: { ...managed.labels, singular: value } })} />
        <Field label="Nome dos objetos (plural)" value={managed.labels.plural} maxLength={80} required
          onChange={(value) => changeObject({ ...managed, labels: { ...managed.labels, plural: value } })} />
        <details><summary>Identificador estável do tipo</summary><code>{managed.id}</code><p>Não muda depois da criação.</p></details>
        <label className="os2-check"><input type="checkbox" checked={managed.archived}
          onChange={(event) => changeObject({ ...managed, archived: event.target.checked })} />Arquivar tipo de objeto</label>
        {managed.archived && <Notice>Tipo arquivado: não pode ser selecionado para novos cadastros. O histórico permanece disponível.</Notice>}
        <Field label="Campo identificador do objeto" value={managed.identifier_field_id} emptyOption="Selecione um campo de texto"
          options={managed.fields.filter((field) => field.kind === "text" && !field.multiline && !field.sensitive && field.max_length <= 120).map((field) => ({ id: field.id, name: field.label || field.id }))}
          onChange={(identifier_field_id) => changeObject({ ...managed, identifier_field_id })} />
        <p className="os2-field-help">O identificador pode ser opcional: texto de uma linha, não sensível, até 120 caracteres. Sem valor ou quando interno, o cliente vê “{managed.labels.singular} · 7D2A91”. Placa, série ou nome nunca comprovam propriedade e não precisam ser únicos.</p>
      </>}
    </details>}
    <div className="os2-fields-list">
      <h3>Campos do formulário</h3>
      <p>{total}/24 campos no conjunto objeto + ordem. Cada referência indica a sua localização.</p>
      <p>Até quatro colunas próprias e quatro campos filtráveis por modelo, com um filtro próprio ativo por consulta. Filtros por igualdade ordenam pelo número da ordem, do maior para o menor.</p>
      <Notice>Obrigatório na abertura exige preenchimento ao criar a ordem. A entrada ou saída da etapa ativa uma exigência permanente; entrar na etapa inicial também exige o campo na abertura. Cancelar continua possível sem completar o formulário. Rascunho significa salvar uma ordem já aberta sem avançar etapa; não existe rascunho de abertura.</Notice>
      {managed && <section>
        <h4>Do objeto · {managed.labels.singular}{managed.id !== selected?.id ? " (não selecionado neste modelo)" : ""}</h4>
        <FieldsEditor fields={managed.fields} locked={previousObject?.fields.map((field) => field.id)}
          sensitiveLocked={previousObject?.fields.filter((field) => field.sensitive).map((field) => field.id)}
          sensitiveDisabled={[managed.identifier_field_id]} retired={managed.retired_field_ids}
          requiredLabel="Obrigatório no cadastro do objeto" location={`Do objeto · ${managed.labels.singular}`}
          limit={Math.max(managed.fields.length, Math.min(24, ...workTypes.filter((entry) => entry.object_type_id === managed.id && entry.id !== type.id).map((entry) => 24 - entry.fields.length), managed.id === selected?.id ? 24 - type.fields.length : 24))}
          onChange={setObjectFields}
          renderField={(field) => managed.id === selected?.id ? <FieldLocationEditor type={type} objectType={managed} field={field} scope="object"
            onChange={(next, object) => object ? changeObject(object, next) : onChange(next, objectTypes)} /> : null} />
      </section>}
      <section>
        <h4>Desta ordem</h4>
        <FieldsEditor fields={type.fields} locked={previousType?.fields.map((field) => field.id)}
          sensitiveLocked={previousType?.fields.filter((field) => field.sensitive).map((field) => field.id)}
          retired={type.retired_field_ids} location="Desta ordem" limit={Math.max(type.fields.length, 24 - (selected?.fields.length ?? 0))}
          onChange={(fields) => onChange(reconcileRules({ ...type, fields, retired_field_ids: retireRemoved(type.fields, fields, type.retired_field_ids) }, selected), objectTypes)}
          renderField={(field) => <FieldLocationEditor type={type} objectType={selected} field={field} scope="order"
            onChange={(next, object) => object ? changeObject(object, next) : onChange(next, objectTypes)} />} />
      </section>
    </div>
    </fieldset>
    {error && <Notice tone="error">{error}</Notice>}
    <details className="os2-form-preview">
      <summary>Prévia do formulário</summary>
      <Field label="Ver formulário como" value={preview} emptyOption={null} options={[{ id: "staff", name: "Equipe" }, { id: "customer", name: "Cliente" }]}
        onChange={(value) => setPreview(value as "staff" | "customer")} />
      <p>Prévia de campos vazios. Campos sensíveis usam acesso privado separado; a disponibilidade para IA depende da configuração do administrador. O cliente recebe apenas os próprios dados autorizados.</p>
      <fieldset disabled className="os2-preview-fields"><legend>{preview === "staff" ? "Formulário da equipe" : "Formulário do cliente"}</legend>
        {selected && <section><h4>Do objeto · {selected.labels.singular}</h4><ExtraFields fields={visibleFields(selected.fields)} values={{}} /></section>}
        <section><h4>Desta ordem</h4><ExtraFields fields={visibleFields(type.fields)} values={{}} /></section>
      </fieldset>
    </details>
  </section>;
}
