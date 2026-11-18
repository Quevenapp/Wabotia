import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../../app/hooks";
import { Button, Field, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { hasWorkMenu } from "../../../menu-tree";
import { useIntents } from "../../../lib/api";
import { ResourceState, useWorkApi, useWorkResource } from "../work-hooks";
import { workError } from "../work-api";
import type { CustomWorkType } from "../work-contracts";
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
} from "./type-draft";
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
  const app = useApp(),
    api = useWorkApi(),
    action = useAction();
  const [draft, setDraft] = useState<CustomWorkType>(
      () => initial || seed || newWorkType(),
    ),
    [tab, setTab] = useState("identidade"),
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
        ← Tipos de trabalho
      </a>
      <h2>
        {initial
          ? `Editar ${initial.labels.singular}`
          : "Criar tipo de trabalho"}
      </h2>
      <Notice>
        As alterações valem para novas aberturas. Trabalhos existentes conservam
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
                throw new Error("Já existe um tipo com este identificador.");
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
            <Field
              label="Identificador estável"
              value={draft.id}
              disabled={!!initial}
              onChange={(id) => setDraft({ ...draft, id })}
              required
              maxLength={64}
            />
            {Object.entries(labelNames).map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={draft.labels[key as keyof typeof labelNames]}
                onChange={(value) =>
                  setDraft({
                    ...draft,
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
              Exportar tipo JSON
            </Button>
            <Field
              label="Importar tipo JSON para revisão"
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
                      "Não é possível trocar o identificador de um tipo salvo.",
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
                  "Configuração atual carregada. Seu rascunho foi preservado; revise antes de substituir este tipo.",
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
          Salvar tipo
        </Button>
      </form>
    </div>
  );
}
function TypeMenus({ type }: { type: CustomWorkType }) {
  const app = useApp(),
    action = useAction(),
    write = useIntents(app.api);
  return (
    <div className="card-actions">
      {(["os_open", "os_track"] as const).map((menuType) => (
        <Button
          secondary
          key={menuType}
          disabled={
            action.busy ||
            (menuType === "os_open" &&
              (type.archived || !type.features.customer_open))
          }
          onClick={() =>
            void action.run(
              async () => {
                const latest = await app.api(app.root + "/menus");
                if (hasWorkMenu(latest.data || [], menuType, type.id)) return;
                await write(app.root + "/settings", "PUT", {
                  menus_revision: latest.revision,
                  menus: [
                    ...(latest.data || []),
                    {
                      id: `work_${crypto.randomUUID().replaceAll("-", "")}`,
                      type: menuType,
                      type_id: type.id,
                      label: `${menuType === "os_open" ? "Abrir" : "Acompanhar"} ${type.labels.singular}`,
                      enabled: true,
                    },
                  ],
                });
                await app.refresh();
              },
              { success: "Opção disponível no menu." },
            )
          }
        >
          {menuType === "os_open"
            ? "Adicionar Abrir ao menu"
            : "Adicionar Acompanhar ao menu"}
        </Button>
      ))}
    </div>
  );
}
export function WorkTypesPage() {
  const app = useApp(),
    route = useRoute(),
    api = useWorkApi(),
    action = useAction();
  const [seed, setSeed] = useState<CustomWorkType>();
  const duplicate = (type: CustomWorkType) => {
    setSeed({ ...type, id: "", revision: 1, archived: false });
    navigate({ area: "admin", page: "work-types", typeId: "novo" });
  };
  // A configuração integral é administrativa; catálogo filtrado nunca substitui os tipos salvos.
  const resource = useWorkResource<TypeSettings>(
    app.root + "/type-settings",
    () => app.api(app.root + "/status"),
  );
  if (!resource.data) return <ResourceState resource={resource} />;
  const types = resource.data.settings.os_work_types || [];
  if (route.typeId) {
    const initial = types.find((type) => type.id === route.typeId);
    if (route.typeId !== "novo" && !initial)
      return <Notice>Tipo não encontrado.</Notice>;
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
      <a
        className="button"
        {...linkProps({ area: "admin", page: "work-types", typeId: "novo" })}
        onClickCapture={() => setSeed(undefined)}
      >
        Criar tipo de trabalho
      </a>
      <section className="os-work-record">
        <h3>Ordem de serviço · Embutido</h3>
        <p>
          Estrutura preservada. Termos, mensagens e prazos continuam nas
          configurações atuais.
        </p>
        <a {...linkProps({ area: "admin", page: "service-orders-settings" })}>
          Configurar Ordem de serviço
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
          Duplicar como personalizado
        </Button>
      </section>
      {types.map((type) => (
        <section className="os-work-record" key={type.id}>
          <h3>
            {type.labels.plural}
            {type.archived ? " · Arquivado" : ""}
          </h3>
          <span>
            {type.id} · revisão {type.revision}
          </span>
          <a
            {...linkProps({
              area: "admin",
              page: "work-types",
              typeId: type.id,
            })}
          >
            Editar tipo
          </a>
          <Button secondary onClick={() => duplicate(type)}>
            Duplicar tipo
          </Button>
          <Button
            secondary
            onClick={() => downloadJson(type, type.id + ".json")}
          >
            Exportar JSON
          </Button>
          <TypeMenus type={type} />
        </section>
      ))}
    </div>
  );
}
