import React, { useState } from "react";
import { parseAreaTemplate } from "./template-import";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { Button, Field, Notice } from "../../ui";
import { linkProps } from "../../lib/routes";
import {
  ResourceState,
  useWorkApi,
  useWorkResource,
} from "../../modules/os/work-hooks";
import { workError } from "../../modules/os/work-api";
import type {
  AreaTemplate,
  AreaTemplateApplyResult,
  AreaTemplatePreview,
  AreaTemplateSelection,
  AreaModuleId,
} from "../../modules/os/work-contracts";
import { downloadJson } from "../../modules/os/types/type-draft";
import { equivalentWorkTypes } from "../../../src/area-templates/equivalent-types";
import "../../modules/os/work.css";
/** O modelo traz menus da Ordem de serviço embutida (type_id service_order). */
export const usesBuiltin = (template: AreaTemplate) =>
  template.menus.some(
    (menu) => "type_id" in menu && menu.type_id === "service_order",
  );
export function templateSelection(
  template: AreaTemplate,
): AreaTemplateSelection {
  return {
    work_type_ids: [
      ...(usesBuiltin(template) ? ["service_order"] : []),
      ...template.work_types.map((type) => type.id),
    ],
    // Por padrão o modelo só liga módulos. Desligar um módulo já ligado é
    // escolha explícita na revisão. Fiscal permanece disponível para ligar,
    // mas exige seleção explícita enquanto não há emissor.
    module_ids: Object.entries(template.modules)
      .filter(([id, enabled]) => enabled && id !== "erp-fiscal")
      .map(([id]) => id) as AreaModuleId[],
    menus: true,
    departments: true,
    ticket_categories: true,
    vocabulary: true,
    texts: true,
    bot_suggestions: true,
  };
}
const MODULE_NAMES: Record<string, string> = {
  os: "Ordem de serviço",
  queue: "Fila presencial",
  forms: "Formulários",
  agenda: "Agenda",
  reserva: "Reservas",
  pedido: "Pedidos",
  mensalidade: "Mensalidade",
  suporte: "Suporte",
  mesas: "Mesas",
  entrega: "Entrega",
  payments: "Cobrança",
  erp: "ERP",
  "erp-fiscal": "Fiscal",
};
/** Texto da linha do módulo na revisão do modelo. */
export function moduleLabel(
  id: string,
  current: boolean | undefined,
  proposed: boolean,
  selected: boolean,
) {
  const name = MODULE_NAMES[id] || id;
  const now = current ? "ligado" : "desligado";
  if (!!current === proposed) return `${name}: ${now}, sem mudança`;
  if (proposed) return selected
    ? `${name}: ${now} → ligar`
    : `${name}: ${now}, continua desligado (marque para ligar)`;
  return selected
    ? `${name}: ligado → será DESLIGADO`
    : `${name}: ligado, continua ligado (marque para desligar como o modelo sugere)`;
}
function Preview({
  template,
  imported,
  onBack,
}: {
  template: AreaTemplate;
  imported: boolean;
  onBack: () => void;
}) {
  const api = useWorkApi(),
    app = useApp(),
    action = useAction();
  const [selection, setSelection] = useState(templateSelection(template)),
    [preview, setPreview] = useState<AreaTemplatePreview | null>(null),
    [result, setResult] = useState<AreaTemplateApplyResult | null>(null),
    [error, setError] = useState("");
  const source = imported
    ? { manifest: template }
    : { template_id: template.id };
  const change = (next: AreaTemplateSelection) => {
    setSelection(next);
    setPreview(null);
    setResult(null);
    setError("");
  };
  return (
    <div className="os-work">
      <Button secondary onClick={onBack}>
        ← Catálogo
      </Button>
      <h2>{template.name}</h2>
      <p>{template.description}</p>
      <Notice>
        Destino: {app.profileName}. Configurações manuais serão preservadas.
        Aplicar sugestões de bot não concede papéis nem permissões.
      </Notice>
      {usesBuiltin(template) && (
        <section className="os-work-record">
          <label className="os-work-check">
            <input
              type="checkbox"
              disabled={action.busy}
              checked={selection.work_type_ids.includes("service_order")}
              onChange={(event) =>
                change({
                  ...selection,
                  work_type_ids: event.target.checked
                    ? ["service_order", ...selection.work_type_ids]
                    : selection.work_type_ids.filter(
                        (id) => id !== "service_order",
                      ),
                })
              }
            />
            Ordem de serviço embutida · service_order
          </label>
          <p>
            Inclui os menus do modelo para abrir e acompanhar a Ordem de
            serviço. A estrutura e as configurações atuais da Ordem de serviço
            não mudam.
          </p>
        </section>
      )}
      {template.work_types.map((type) => (
        <section className="os-work-record" key={type.id}>
          <label className="os-work-check">
            <input
              type="checkbox"
              disabled={action.busy}
              checked={selection.work_type_ids.includes(type.id)}
              onChange={(event) =>
                change({
                  ...selection,
                  work_type_ids: event.target.checked
                    ? [...selection.work_type_ids, type.id]
                    : selection.work_type_ids.filter((id) => id !== type.id),
                })
              }
            />
            {type.labels.plural} · {type.id}
          </label>
          <p>
            Campos: {type.labels.item}, {type.labels.problem}
            {type.fields.map((field) => `, ${field.label}`).join("")}
          </p>
          <p>Etapas: {type.stages.map((stage) => stage.label).join(" → ")}</p>
          {equivalentWorkTypes(type, app.settings.os_work_types || [], template.id).length > 0 && (
            <Notice>
              Já existe um modelo equivalente nesta área. Aplicar criará outro modelo de {type.labels.plural};
              os modelos existentes e suas ordens serão preservados. Desmarque este modelo se preferir usar o existente.
            </Notice>
          )}
        </section>
      ))}
      <fieldset>
        <legend>Módulos</legend>
        {Object.entries(template.modules).some(([id, enabled]) => id === "erp-fiscal" && enabled) && <p>Fiscal começa desmarcado porque a emissão fiscal ainda não está disponível. Você pode selecionar essa parte.</p>}
        {Object.entries(template.modules).map(([id, enabled]) => (
          <label key={id} className="os-work-check">
            <input
              type="checkbox"
              disabled={action.busy}
              checked={selection.module_ids.includes(id as AreaModuleId)}
              onChange={(event) =>
                change({
                  ...selection,
                  module_ids: event.target.checked
                    ? [...selection.module_ids, id as AreaModuleId]
                    : selection.module_ids.filter((key) => key !== id),
                })
              }
            />
            {moduleLabel(id, app.modules?.[id], enabled, selection.module_ids.includes(id as AreaModuleId))}
          </label>
        ))}
      </fieldset>
      {(
        [
          ["menus", "Menus"],
          ["departments", "Setores"],
          ["ticket_categories", "Categorias"],
          ["vocabulary", "Vocabulário"],
          ["texts", "Mensagens"],
          ["bot_suggestions", "Sugestões de bot"],
        ] as const
      ).map(([key, label]) => (
        <label className="os-work-check" key={key}>
          <input
            type="checkbox"
            disabled={action.busy}
            checked={selection[key]}
            onChange={(event) =>
              change({ ...selection, [key]: event.target.checked })
            }
          />
          {label}
        </label>
      ))}
      <details>
        <summary>Conteúdo do modelo</summary>
        <h3>Menus</h3>
        <ul>
          {template.menus.map((menu) => (
            <li key={menu.id}>
              {menu.label} · {menu.type}
              {"type_id" in menu ? ` · ${menu.type_id}` : ""}
            </li>
          ))}
        </ul>
        <p>
          Setores:{" "}
          {template.departments.map((item) => item.name).join(", ") || "Nenhum"}
        </p>
        <p>
          Categorias:{" "}
          {template.ticket_categories.map((item) => item.name).join(", ") ||
            "Nenhuma"}
        </p>
        <p>Vocabulário: {Object.values(template.vocabulary).join(" · ")}</p>
        {Object.entries(template.texts).map(([key, value]) => (
          <p key={key}>
            {key}: {value}
          </p>
        ))}
        <h3>Sugestões de bot</h3>
        <p>{template.bot.instructions}</p>
        <p>Operações sugeridas: {template.bot.allowed_operations.join(", ")}</p>
        <p>Operações negadas: {template.bot.denied_operations.join(", ")}</p>
        <p>Papéis sugeridos: {template.bot.suggested_roles.join(", ")}</p>
      </details>
      <Button
        secondary
        disabled={action.busy}
        onClick={() => downloadJson(template, template.id + ".json")}
      >
        Exportar modelo JSON
      </Button>
      <Button
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            setError("");
            setResult(null);
            setPreview(null);
            try {
              setPreview(await api.preview({ ...source, selection }));
            } catch (error) {
              setError(workError(error));
            }
          })
        }
      >
        Gerar prévia
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      {preview && (
        <section>
          <h3>Prévia da aplicação</h3>
          <ul>
            {preview.changes.map((change, index) => (
              <li key={index}>
                <strong>
                  {
                    {
                      add: "Criar",
                      set: "Alterar",
                      keep: "Manter",
                      skip: "Ignorar",
                    }[change.action]
                  }
                </strong>{" "}
                · {change.path}: {change.reason}
              </li>
            ))}
          </ul>
          {preview.conflicts.map((conflict, index) => (
            <Notice key={index} tone="error">
              {conflict.path}: {conflict.message}
            </Notice>
          ))}
          <h4>Pendências manuais</h4>
          <ul>
            {preview.manual_steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ul>
          <Button
            disabled={!preview.can_apply || action.busy || !!result}
            onClick={() =>
              void action.run(async () => {
                try {
                  const applied = await api.apply({
                    ...source,
                    selection,
                    preview_hash: preview.preview_hash,
                  });
                  setResult(applied);
                  await app.refresh();
                } catch (error) {
                  setError(workError(error));
                  if ((error as { code?: string }).code === "preview_stale")
                    setPreview(null);
                }
              })
            }
          >
            Aplicar esta prévia
          </Button>
        </section>
      )}
      {result && (
        <section>
          <Notice>
            {result.applied
              ? "Modelo aplicado."
              : "Este modelo já estava aplicado. Nenhuma alteração necessária."}
          </Notice>
          <ul>
            {result.changes.map((change, index) => (
              <li key={index}>
                {change.path}: {change.reason}
              </li>
            ))}
          </ul>
          <h3>Próximos passos</h3>
          <ul>
            {result.manual_steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ul>
          <a {...linkProps({ area: "admin", page: "work-types" })}>
            Abrir modelos de ordem de serviço
          </a>
        </section>
      )}
    </div>
  );
}
export function AreaTemplatesPage() {
  const app = useApp(),
    api = useWorkApi(),
    action = useAction();
  const catalog = useWorkResource(app.root + "/area-templates", () =>
    api.templates(),
  );
  const [chosen, setChosen] = useState<{
      template: AreaTemplate;
      imported: boolean;
    } | null>(null),
    [json, setJson] = useState(""),
    [error, setError] = useState("");
  if (chosen)
    return (
      <Preview
        key={chosen.template.id}
        {...chosen}
        onBack={() => setChosen(null)}
      />
    );
  return (
    <div className="os-work">
      <ResourceState resource={catalog} />
      {catalog.data?.data.map((item) => (
        <section className="os-work-record" key={item.id}>
          <h2>{item.name}</h2>
          <p>{item.description}</p>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                try {
                  setChosen({
                    template: await api.template(item.id),
                    imported: false,
                  });
                } catch (error) {
                  setError(workError(error));
                }
              })
            }
          >
            Revisar modelo
          </Button>
        </section>
      ))}
      <details>
        <summary>Importar modelo JSON</summary>
        <Field
          label="Manifesto declarativo (até 128 KiB)"
          type="textarea"
          rows={12}
          value={json}
          onChange={setJson}
        />
        <Button
          secondary
          onClick={() => {
            try {
              const template = parseAreaTemplate(json);
              setChosen({ template, imported: true });
              setError("");
            } catch (error) {
              setError(workError(error));
            }
          }}
        >
          Revisar importação
        </Button>
      </details>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
