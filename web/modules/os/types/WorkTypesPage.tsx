import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../../app/hooks";
import { Button, Field, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { ResourceState, useWorkApi, useWorkResource } from "../work-hooks";
import { workError } from "../work-api";
import type { AreaTemplate, CustomWorkType } from "../work-contracts";
import { FieldsEditor } from "./FieldsEditor";
import { StagesEditor } from "./StagesEditor";
import { ResourcesEditor } from "./ResourcesEditor";
import {
  downloadJson,
  messagePreview,
  newWorkType,
  parseTypeImport,
  prepareTypeSave,
  validateTypeDraft,
  labelIdentifier,
} from "./type-draft";
import { addMissingTemplateFields, addPublicPlateField, missingTemplateFields, publicPlateField, templateSource } from "./template-models";
import "../work.css";
interface TypeSettings {
  settings: { os_work_types?: CustomWorkType[] };
  settings_revision: string;
}
function Editor({
  initial,
  seed,
  settings,
  reload,
}: {
  initial?: CustomWorkType;
  seed?: CustomWorkType;
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
  const [base, setBase] = useState(settings),
    [previous, setPrevious] = useState(initial),
    [saved, setSaved] = useState(initial || newWorkType());
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedGuard(dirty);
  const next = prepareTypeSave(draft, previous);
  const errors = validateTypeDraft(next, previous);
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
              const all = base.settings.os_work_types || [];
              if (!previous && all.some((type) => type.id === next.id))
                throw new Error("Já existe um modelo com este identificador.");
              await api.saveTypes(
                previous
                  ? all.map((type) => (type.id === previous.id ? next : type))
                  : [...all, next],
                base.settings_revision,
              );
              setSaved(next);
              setDraft(next);
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
          <FieldsEditor
            fields={draft.fields}
            locked={previous?.fields.map((field) => field.id)}
            retired={draft.retired_field_ids}
            onChange={(fields) => setDraft({ ...draft, fields })}
          />
        )}
        {tab === "etapas" && (
          <StagesEditor
            type={draft}
            locked={previous?.stages.map((stage) => stage.id)}
            onChange={setDraft}
          />
        )}
        {tab === "recursos" && (
          <ResourcesEditor type={draft} onChange={setDraft} />
        )}
        {tab === "mensagens" && (
          <>
            <Notice>
              Marcadores:{" "}
              {
                "{numero}, {item}, {estado}, {tipo}, {etapa}, {numero_tipo}, {identificador}"
              }
              . Campos públicos:{" "}
              {draft.fields
                .filter((field) => field.client_visible && !field.sensitive)
                .map((field) => `{campo_${field.id}}`)
                .join(", ") || "nenhum"}
              . Mensagem vazia não envia aviso.
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
                  {messagePreview(stage.message, draft) || "Sem mensagem"}
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
              onClick={() => downloadJson(next, `${draft.id || "tipo"}.json`)}
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
                  const imported = parseTypeImport(json);
                  if (initial && imported.id !== initial.id)
                    throw new Error(
                      "Não é possível trocar o identificador de um modelo salvo.",
                    );
                  setDraft(imported);
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
                setBase(latest);
                setPrevious(
                  latest.settings.os_work_types?.find(
                    (type) => type.id === initial?.id,
                  ),
                );
                setConflict(false);
                setError(
                  "Configuração atual carregada. Seu rascunho foi preservado; revise antes de substituir este modelo.",
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
export function TemplateExamples({ templates, onChoose }: { templates: AreaTemplate[]; onChoose: (type: CustomWorkType) => void }) {
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
        <Button secondary onClick={() => onChoose(type)}>{type.labels.plural}</Button>
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
    [creating, setCreating] = useState(false),
    [examples, setExamples] = useState(false);
  const duplicate = (type: CustomWorkType) => {
    setSeed({ ...structuredClone(type), id: labelIdentifier(type.labels.singular, types.map((type) => type.id), 64), revision: 1, archived: false });
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
        key={route.typeId}
        initial={initial}
        seed={seed}
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
        <a className="button" {...linkProps({ area: "admin", page: "work-types", typeId: "novo" })} onClickCapture={() => setSeed(undefined)}>Começar do zero</a>
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
          {(missing.length > 0 || plate) && <Notice>
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
            onClick={() => downloadJson(type, type.id + ".json")}
          >
            Exportar JSON
          </Button>
        </section>
      );})}
    </div>
  );
}
