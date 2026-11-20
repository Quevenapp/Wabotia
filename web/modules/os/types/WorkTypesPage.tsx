import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../../app/hooks";
import { Button, Field, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { ResourceState, useWorkApi, useWorkResource } from "../work-hooks";
import { workError } from "../work-api";
import type { AreaTemplate, CustomWorkType, Os2AiAccess, ServiceObjectType } from "../work-contracts";
import { ObjectTypesEditor } from "../object-types/ObjectTypesEditor";
import { StandardObjectUpgrade } from "../object-types/StandardObjectUpgrade";
import { StagesEditor } from "./StagesEditor";
import { ResourcesEditor } from "./ResourcesEditor";
import {
  downloadJson,
  messagePreview,
  newWorkType,
  parseConfigurationImport,
  exportConfiguration,
  prepareConfigurationSave,
  prepareObjectTypeSave,
  validateConfigurationDraft,
  prepareTypeSave,
  validateTypeDraft,
  labelIdentifier,
} from "./type-draft";
import { addMissingTemplateFields, addPublicPlateField, missingTemplateFields, publicPlateField, templateSource } from "./template-models";
import "../work.css";
import "../object-types/object-types.css";
interface TypeSettings {
  settings: { os_work_types?: CustomWorkType[]; os_object_types?: ServiceObjectType[]; os2_ai_access?: Os2AiAccess };
  settings_revision: string;
}
export function FieldIndexConfiguration({ type, dirty }: { type: CustomWorkType; dirty: boolean }) {
  const app = useApp(), api = useWorkApi(), action = useAction();
  const resource = useWorkResource(
    app.root + "/field-index-configuration/" + type.id,
    () => api.fieldIndex(type.id),
  );
  const state = resource.data;
  return <section className="os2-config" aria-label="Construção dos filtros">
    <h3>Construção do índice</h3>
    <p>A lista comum continua disponível. Cada comando processa até cinco ordens; retome até concluir.</p>
    <ResourceState resource={resource} />
    {(resource.error as { code?: string } | undefined)?.code === "not_found" && <Button secondary busy={action.busy} disabled={dirty || action.busy}
      onClick={() => void action.run(async () => { await api.rebuildFieldIndex(type.id, {}); resource.reload(); })}>Iniciar construção</Button>}
    {state && <>
      <p role="status">{state.status === "ready" ? "Filtros prontos" : "Em construção: filtros indisponíveis"} · Progresso: {state.cursor_number} / {state.ceiling_number}.</p>
      <p>Versões excluídas por incompatibilidade ou privacidade: {state.excluded_count}.</p>
      <Button secondary busy={action.busy} disabled={dirty || action.busy || state.status === "ready"}
        onClick={() => void action.run(async () => {
          await api.rebuildFieldIndex(type.id, { generation: state.generation, cursor_number: state.cursor_number });
          resource.reload();
        })}>Iniciar ou retomar construção</Button>
    </>}
    {dirty && <Notice>Salve as alterações antes de construir o índice da configuração publicada.</Notice>}
  </section>;
}
function Editor({
  initial,
  seed,
  seedObjects,
  settings,
  reload,
}: {
  initial?: CustomWorkType;
  seed?: CustomWorkType;
  seedObjects?: ServiceObjectType[];
  settings: TypeSettings;
  reload: () => void;
}) {
  const app = useApp(), route = useRoute(),
    api = useWorkApi(),
    action = useAction();
  const [draft, setDraft] = useState<CustomWorkType>(
      () => initial || seed || { ...newWorkType(), id: labelIdentifier("Trabalho", settings.settings.os_work_types?.map((type) => type.id), 64) },
    ),
    [tab, setTab] = useState(route.filters?.editor === "recursos" ? "recursos" : "identidade"),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [json, setJson] = useState("");
  const [objectDrafts, setObjectDrafts] = useState<ServiceObjectType[]>(() => [...(settings.settings.os_object_types || []), ...(seedObjects || [])]);
  const [relatedDrafts, setRelatedDrafts] = useState<CustomWorkType[]>([]);
  const [savedObjects, setSavedObjects] = useState(settings.settings.os_object_types || []);
  const [aiAccess, setAiAccess] = useState<Os2AiAccess>(() => settings.settings.os2_ai_access ?? { enabled: false, internal: false, sensitive: false });
  const [base, setBase] = useState(settings),
    [previous, setPrevious] = useState(initial),
    [saved, setSaved] = useState(initial || newWorkType());
  const aiChanged = JSON.stringify(aiAccess) !== JSON.stringify(base.settings.os2_ai_access ?? { enabled: false, internal: false, sensitive: false });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || JSON.stringify(objectDrafts) !== JSON.stringify(savedObjects) || relatedDrafts.length > 0 || aiChanged;
  useUnsavedGuard(dirty);
  const next = prepareTypeSave(draft, previous);
  const otherTypes = (base.settings.os_work_types || []).map((type) => relatedDrafts.find((entry) => entry.id === type.id) ?? type);
  const allTypes = previous
    ? otherTypes.map((type) => type.id === previous.id ? draft : type)
    : [...otherTypes, draft];
  const configuredObjects = objectDrafts.length || base.settings.os_object_types !== undefined ? objectDrafts : undefined;
  const errors = validateConfigurationDraft(allTypes, configuredObjects, base.settings);
  const labelNames = {
    singular: "Nome singular",
    plural: "Nome plural",
    item: "Primeiro campo básico",
    problem: "Segundo campo básico",
    customer_singular: "Contato principal (singular)",
    customer_plural: "Contatos principais (plural)",
  };
  return (
    <div className="os-work">
      <a {...linkProps({ area: "admin", page: "work-types" })}>
        ← Modelos de ordem de serviço
      </a>
      <h2>
        {initial
          ? `Editar modelo: ${initial.labels.singular}`
          : "Criar modelo"}
      </h2>
      <Notice>
        As alterações valem para novas ordens. Ordens existentes conservam
        sua definição.
      </Notice>
      <div className="os-work-toolbar">
        {Object.entries({
          identidade: "Identificação e vocabulário",
          campos: "Campos extras",
          etapas: "Etapas e transições",
          recursos: "Recursos",
          mensagens: "Mensagens",
          json: "Importar e exportar",
        }).map(([id, label]) => (
          <Button
            key={id}
            secondary
            disabled={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (action.busy || conflict || errors.length) return;
          setError("");
          void action.run(async () => {
            try {
              const payload = prepareConfigurationSave(allTypes, configuredObjects, base.settings, base.settings_revision);
              if (aiChanged) await app.api(app.root + "/settings", "PUT", { ...payload, os2_ai_access: aiAccess });
              else await api.saveTypes(payload.os_work_types, payload.settings_revision, payload.os_object_types);
              setSaved(next);
              setDraft(next);
              setSavedObjects(payload.os_object_types || []);
              await app.refresh();
              navigate({ area: "admin", page: "work-types" }, { force: true });
              reload();
            } catch (error) {
              setError(workError(error));
              if ((error as { code?: string }).code === "settings_conflict")
                setConflict(true);
            }
          });
        }}
      >
        {tab === "identidade" && (
          <>
            <details>
              <summary>Avançado</summary>
              <Field
              label="Identificador estável"
              value={draft.id}
              disabled={!!initial}
              onChange={(id) => setDraft({ ...draft, id })}
              required
              maxLength={64}
            />
            </details>
            {Object.entries(labelNames).map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={draft.labels[key as keyof typeof labelNames]}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    id: key === "singular" && !initial && (!draft.id || draft.id === labelIdentifier(draft.labels.singular, base.settings.os_work_types?.map((type) => type.id), 64))
                      ? labelIdentifier(value, base.settings.os_work_types?.map((type) => type.id), 64) : draft.id,
                    labels: { ...draft.labels, [key]: value },
                  })
                }
                required
                maxLength={80}
              />
            ))}
            <Field
              label="Prefixo da numeração"
              value={draft.number_prefix}
              onChange={(number_prefix) =>
                setDraft({ ...draft, number_prefix })
              }
              maxLength={12}
            />
            <label className="os-work-check">
              <input
                type="checkbox"
                checked={draft.archived}
                onChange={(event) =>
                  setDraft({ ...draft, archived: event.target.checked })
                }
              />
              Arquivar (impede novas aberturas)
            </label>
            <p>
              Exemplo: {draft.labels.singular} {draft.number_prefix}1 ·{" "}
              {draft.labels.item} · {draft.labels.customer_singular}
            </p>
          </>
        )}
        {tab === "campos" && (
          <>
            <ObjectTypesEditor type={draft} objectTypes={objectDrafts} workTypes={allTypes}
              previousObjectTypes={base.settings.os_object_types} previousType={previous}
              onChange={(type, objects, affectedTypes) => {
                setDraft(type); setObjectDrafts(objects);
                if (affectedTypes) setRelatedDrafts((current) => [
                  ...current.filter((entry) => !affectedTypes.some((affected) => affected.id === entry.id)), ...affectedTypes,
                ]);
              }} />
            {relatedDrafts.length > 0 && <Notice>Modelos com referências revisadas nesta operação: {relatedDrafts.map((type) => type.labels.singular).join(", ")}. Todos serão salvos junto com o tipo de objeto.</Notice>}
            {previous?.list_fields?.some((rule) => rule.filter) && <FieldIndexConfiguration key={app.root + previous.id + base.settings_revision} type={previous} dirty={dirty} />}
            {!previous?.list_fields?.some((rule) => rule.filter) && draft.list_fields?.some((rule) => rule.filter) && <Notice>Salve o modelo para iniciar e acompanhar a construção dos filtros.</Notice>}
          </>
        )}
        {tab === "etapas" && (
          <StagesEditor
            type={draft}
            locked={previous?.stages.map((stage) => stage.id)}
            onChange={setDraft}
          />
        )}
        {tab === "recursos" && (
          <ResourcesEditor type={draft} onChange={setDraft}
            aiAccess={objectDrafts.length ? aiAccess : undefined} onAiAccessChange={objectDrafts.length ? setAiAccess : undefined} />
        )}
        {tab === "mensagens" && (
          <>
            <Notice>
              Marcadores:{" "}
              {
                "{numero}, {item}, {estado}, {tipo}, {etapa}, {numero_tipo}, {identificador}, {objeto}"
              }
              . Campos públicos:{" "}
              {draft.fields
                .filter((field) => field.client_visible && !field.sensitive)
                .map((field) => `{campo_${field.id}}`)
                .join(", ") || "nenhum"}
              . Mensagem vazia não envia aviso. {"{objeto}"} usa a identificação pública capturada na ordem; sem objeto, fica vazio.
            </Notice>
            {draft.stages.map((stage, index) => (
              <div key={stage.id || index}>
                <Field
                  label={`Ao entrar em ${stage.label}`}
                  value={stage.message}
                  type="textarea"
                  maxLength={900}
                  onChange={(message) =>
                    setDraft({
                      ...draft,
                      stages: draft.stages.map((s, i) =>
                        i === index ? { ...s, message } : s,
                      ),
                    })
                  }
                />
                <small>
                  Prévia fictícia:{" "}
                  {messagePreview(stage.message, draft, objectDrafts.find((object) => object.id === draft.object_type_id)) || "Sem mensagem"}
                </small>
              </div>
            ))}
            <Field
              label="Lembrete de retirada"
              type="textarea"
              value={draft.pickup_reminder_text}
              maxLength={900}
              onChange={(pickup_reminder_text) =>
                setDraft({ ...draft, pickup_reminder_text })
              }
            />
          </>
        )}
        {tab === "json" && (
          <>
            <Button
              secondary
              onClick={() => downloadJson(exportConfiguration(next, objectDrafts), `${draft.id || "tipo"}.json`)}
            >
              Exportar modelo JSON
            </Button>
            <Field
              label="Importar modelo JSON para revisão"
              type="textarea"
              rows={15}
              value={json}
              onChange={setJson}
            />
            <Button
              secondary
              onClick={() => {
                try {
                  const bundle = parseConfigurationImport(json);
                  const imported = bundle.work_type;
                  if (initial && imported.id !== initial.id)
                    throw new Error(
                      "Não é possível trocar o identificador de um modelo salvo.",
                    );
                  const objects = [...objectDrafts];
                  for (const object of bundle.object_types || []) {
                    const existing = objects.find((entry) => entry.id === object.id);
                    if (existing && prepareObjectTypeSave(object, existing).revision !== existing.revision)
                      throw new Error(`O tipo de objeto ${object.labels.singular} já existe com outra definição. Revise os campos compartilhados antes de importar.`);
                    if (!existing) objects.push({ ...object, revision: 1 });
                  }
                  setDraft(imported);
                  setObjectDrafts(objects);
                  setError("");
                } catch (error) {
                  setError(workError(error));
                }
              }}
            >
              Ler rascunho importado
            </Button>
          </>
        )}
        {errors.length > 0 && (
          <Notice tone="error">
            <ul>
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {conflict && (
          <Button
            secondary
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const latest: TypeSettings = await app.api(
                  app.root + "/status",
                );
                if (!aiChanged) setAiAccess(latest.settings.os2_ai_access ?? { enabled: false, internal: false, sensitive: false });
                // Reaplica apenas a revisão das referências, preservando demais
                // personalizações que chegaram enquanto o formulário estava aberto.
                setRelatedDrafts((drafts) => drafts.map((local) => {
                  const remote = latest.settings.os_work_types?.find((entry) => entry.id === local.id);
                  const before = base.settings.os_work_types?.find((entry) => entry.id === local.id);
                  if (!remote || !before) return local;
                  const removed = (before.list_fields || []).filter((rule) => !(local.list_fields || []).some((entry) =>
                    entry.ref.scope === rule.ref.scope && entry.ref.field_id === rule.ref.field_id));
                  const list = (remote.list_fields || []).filter((rule) => !removed.some((entry) =>
                    entry.ref.scope === rule.ref.scope && entry.ref.field_id === rule.ref.field_id)).map((rule) => {
                    const old = before.list_fields?.find((entry) => entry.ref.scope === rule.ref.scope && entry.ref.field_id === rule.ref.field_id);
                    const edited = local.list_fields?.find((entry) => entry.ref.scope === rule.ref.scope && entry.ref.field_id === rule.ref.field_id);
                    if (old?.filter && edited && !edited.filter) { const next = { ...rule }; delete next.filter; return next; }
                    return rule;
                  }).filter((rule) => rule.column || rule.filter);
                  const result = { ...remote };
                  if (list.length) result.list_fields = list; else delete result.list_fields;
                  return result;
                }));
                // Mantém apenas alterações locais; incorpora os tipos que outra pessoa editou.
                const editedObjects = objectDrafts.filter((object) => JSON.stringify(object) !==
                  JSON.stringify(base.settings.os_object_types?.find((old) => old.id === object.id)));
                const mergedObjects = [...(latest.settings.os_object_types || [])];
                for (const object of editedObjects) {
                  const index = mergedObjects.findIndex((entry) => entry.id === object.id);
                  if (index < 0) mergedObjects.push(object); else mergedObjects[index] = object;
                }
                setObjectDrafts(mergedObjects);
                setSavedObjects(latest.settings.os_object_types || []);
                setBase(latest);
                setPrevious(
                  latest.settings.os_work_types?.find(
                    (type) => type.id === initial?.id,
                  ),
                );
                setConflict(false);
                setError(
                  "Configuração atual carregada. Seu rascunho e os campos compartilhados editados foram preservados; revise os modelos afetados antes de substituir.",
                );
              })
            }
          >
            Recarregar configuração mantendo rascunho
          </Button>
        )}
        <Button
          type="submit"
          busy={action.busy}
          disabled={conflict || !!errors.length}
        >
          Salvar modelo
        </Button>
      </form>
    </div>
  );
}
export function TemplateExamples({ templates, onChoose }: { templates: AreaTemplate[]; onChoose: (type: CustomWorkType, objectTypes?: ServiceObjectType[]) => void }) {
  const [search, setSearch] = useState("");
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const groups = templates.map((template) => ({ ...template, work_types: template.work_types.filter((type) =>
    normalize([template.name, template.description, type.labels.plural, type.labels.item, ...type.fields.map((field) => field.label)].join(" ")).includes(normalize(search.trim())))
  })).filter((template) => template.work_types.length);
  return <section>
    <h3>Começar de um exemplo</h3>
    <p>Escolha um modelo e adapte seus campos e etapas. Só o modelo escolhido será copiado; as outras configurações da área permanecem iguais.</p>
    <Field label="Buscar exemplos" value={search} onChange={setSearch} />
    {groups.map((template) => <section className="os-work-record" key={template.id}>
      <h4>{template.name}</h4>
      <p>{template.description}</p>
      {template.work_types.map((type) => <div key={type.id}>
        <Button secondary onClick={() => onChoose(type, template.object_types)}>{type.labels.plural}</Button>
        <p>{type.labels.item} · {type.fields.slice(0, 4).map((field) => field.label).join(", ") || type.labels.problem}</p>
      </div>)}
    </section>)}
    {!groups.length && <p>Nenhum exemplo encontrado.</p>}
  </section>;
}
export function WorkTypesPage() {
  const app = useApp(),
    route = useRoute(),
    api = useWorkApi(),
    action = useAction();
  const [seed, setSeed] = useState<CustomWorkType>(),
    [seedObjects, setSeedObjects] = useState<ServiceObjectType[]>(),
    [seedScope, setSeedScope] = useState(app.root),
    [creating, setCreating] = useState(false),
    [examples, setExamples] = useState(false);
  const duplicate = (type: CustomWorkType, exampleObjects?: ServiceObjectType[]) => {
    const copy = { ...structuredClone(type), id: labelIdentifier(type.labels.singular, types.map((type) => type.id), 64), revision: 1, archived: false };
    let objects: ServiceObjectType[] | undefined;
    if (type.object_type_id && exampleObjects) {
      const source = exampleObjects.find((entry) => entry.id === type.object_type_id);
      if (!source) throw new Error("O exemplo não contém a definição do objeto. Recarregue o catálogo.");
      const object = { ...structuredClone(source), id: labelIdentifier(source.labels.singular, resource.data?.settings.os_object_types?.map((entry) => entry.id), 64), revision: 1, archived: false };
      copy.object_type_id = object.id;
      objects = [object];
    }
    setSeed(copy);
    setSeedObjects(objects);
    setSeedScope(app.root);
    navigate({ area: "admin", page: "work-types", typeId: "novo" });
  };
  // A configuração integral é administrativa; catálogo filtrado nunca substitui os tipos salvos.
  const resource = useWorkResource<TypeSettings>(
    app.root + "/type-settings",
    () => app.api(app.root + "/status"),
  );
  const templates = useWorkResource(app.root + "/model-examples", async () => {
    const catalog = await api.templates();
    return Promise.all(catalog.data.map((template) => api.template(template.id)));
  });
  if (!resource.data) return <ResourceState resource={resource} />;
  const types = resource.data.settings.os_work_types || [];
  if (route.typeId) {
    const initial = types.find((type) => type.id === route.typeId);
    if (route.typeId !== "novo" && !initial)
      return <Notice>Modelo não encontrado.</Notice>;
    return (
      <Editor
        key={app.root + ":" + route.typeId}
        initial={initial}
        seed={route.typeId === "novo" && seedScope === app.root ? seed : undefined}
        seedObjects={route.typeId === "novo" && seedScope === app.root ? seedObjects : undefined}
        settings={resource.data}
        reload={resource.reload}
      />
    );
  }
  return (
    <div className="os-work">
      <h2>Modelos de ordem de serviço</h2>
      <p>Um modelo define os campos, as etapas e as mensagens de um tipo de serviço. Cada segmento tem o seu: uma oficina registra placa e quilometragem; uma decoração de festa, a data e o tema.</p>
      {Boolean(templates.error) && <ResourceState resource={templates} />}
      <Button onClick={() => setCreating(!creating)}>Criar modelo</Button>
      {creating && <section className="os-work-record">
        <a className="button" {...linkProps({ area: "admin", page: "work-types", typeId: "novo" })} onClickCapture={() => { setSeed(undefined); setSeedObjects(undefined); }}>Começar do zero</a>
        <Button secondary onClick={() => setExamples(true)}>Começar de um exemplo</Button>
        {examples && <><ResourceState resource={templates} />{templates.data && <TemplateExamples templates={templates.data} onChoose={duplicate} />}</>}
      </section>}
      <section className="os-work-record">
        <h3>Ordem de serviço · Modelo clássico</h3>
        <p>
          O modelo clássico usa os campos e as etapas tradicionais. Configure termos e mensagens em WhatsApp e os prazos em Prazos e garantia.
        </p>
        <a {...linkProps({ area: "admin", page: "work-types", filters: { tab: "whatsapp" } })}>
          Configurar WhatsApp
        </a>
        <Button
          secondary
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const builtin = await api.type("service_order");
              duplicate({ ...builtin, kind: "custom", id: "", revision: 1 });
            })
          }
        >
          Duplicar modelo
        </Button>
      </section>
      {types.map((type) => {
        const source = templateSource(type, templates.data || []);
        const sourceObject = source?.template.object_types?.find((object) => object.id === source.type.object_type_id);
        const proposedObject = sourceObject && source ? { ...sourceObject, id: `area_${source.template.id}__${sourceObject.id}`, revision: 1 } : undefined;
        const existingObject = resource.data!.settings.os_object_types?.find((object) => object.id === proposedObject?.id);
        const missing = source ? missingTemplateFields(type, source.type) : [];
        const plate = source?.type.fields.some((field) => field.id === "placa" && field.client_visible && !field.sensitive)
          && type.fields.some((field) => field.id === "placa" && field.sensitive);
        const saveUpdate = (update: () => CustomWorkType) => action.run(async () => {
          const updated = update();
          const next = prepareTypeSave(updated, type);
          const errors = validateTypeDraft(next, type);
          if (errors.length) throw new Error(errors.join("\n"));
          await api.saveTypes(types.map((existing) => existing.id === type.id ? next : existing), resource.data!.settings_revision);
          await app.refresh();
          resource.reload();
        }, { success: "Modelo atualizado para as próximas ordens." });
        return (
        <section className="os-work-record" key={type.id}>
          <h3>
            {type.labels.plural}
            {type.archived ? " · Arquivado" : ""}
          </h3>
          {source && <p>Modelo de área: {source.template.name}</p>}
          {!source && types.filter((other) => other.labels.plural === type.labels.plural).length > 1 && <p>Modelo personalizado</p>}
          <small>Revisão {type.revision}</small>
          {proposedObject && source && <details className="os2-config">
            <summary>O modelo padrão mudou: revisar objeto e campos</summary>
            <Button secondary disabled={action.busy} onClick={resource.reload}>Recarregar configuração para revisar novamente</Button>
            {existingObject && <p>Tipo compartilhado com: {types.filter((entry) => entry.object_type_id === existingObject.id).map((entry) => entry.labels.singular).join(", ") || "nenhum modelo ainda"}.</p>}
            <StandardObjectUpgrade key={resource.data!.settings_revision + type.id}
              current={type} standard={{ ...source.type, id: type.id, object_type_id: proposedObject.id }}
              objectType={proposedObject} existingObjectType={existingObject} busy={action.busy}
              availableObjectTypes={resource.data!.settings.os_object_types || []} workTypes={types}
              onApply={(plan) => void action.run(async () => {
                const objects = [...(resource.data!.settings.os_object_types || [])];
                if (!objects.some((object) => object.id === plan.object_type.id)) objects.push(plan.object_type);
                const payload = prepareConfigurationSave(types.map((entry) => entry.id === type.id ? plan.work_type : entry), objects,
                  resource.data!.settings, resource.data!.settings_revision);
                await api.saveTypes(payload.os_work_types, payload.settings_revision, payload.os_object_types);
                await app.refresh();
                resource.reload();
              }, { success: "Padrão atualizado para as próximas ordens." })} />
          </details>}
          {!proposedObject && (missing.length > 0 || plate) && <Notice>
            {missing.length > 0 && <p>O modelo padrão ganhou campos: {missing.map((field) => field.label).join(", ")}. <Button secondary disabled={action.busy} onClick={() => void saveUpdate(() => addMissingTemplateFields(type, source!.type))}>Adicionar</Button></p>}
            <p>As alterações valem para as próximas ordens. As ordens abertas guardam a definição com que nasceram.</p>
            {plate && <p>A Placa existente continua sensível: essa classificação não pode ser removida. Um novo campo Placa visível ao cliente começa vazio, sem copiar dados do campo sensível. {publicPlateField(type) ? <Button secondary disabled={action.busy} onClick={() => void saveUpdate(() => addPublicPlateField(type))}>Criar nova Placa visível</Button> : "O novo campo visível não está disponível neste modelo; revise os campos em Editar modelo."}</p>}
          </Notice>}
          <a
            {...linkProps({
              area: "admin",
              page: "work-types",
              typeId: type.id,
            })}
          >
            Editar modelo
          </a>
          <Button secondary onClick={() => duplicate(type)}>
            Duplicar modelo
          </Button>
          <Button
            secondary
            onClick={() => downloadJson(exportConfiguration(type, resource.data!.settings.os_object_types || []), type.id + ".json")}
          >
            Exportar JSON
          </Button>
        </section>
      );})}
    </div>
  );
}
