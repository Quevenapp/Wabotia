import React from "react";
import { Field } from "../../../ui";
import type { CustomWorkType, Os2AiAccess } from "../work-contracts";
import "../object-types/object-types.css";
export function ResourcesEditor({
  type,
  onChange,
  aiAccess,
  onAiAccessChange,
}: {
  type: CustomWorkType;
  onChange: (type: CustomWorkType) => void;
  aiAccess?: Os2AiAccess;
  onAiAccessChange?: (value: Os2AiAccess) => void;
}) {
  const update = (features: Partial<CustomWorkType["features"]>) =>
    onChange({ ...type, features: { ...type.features, ...features } });
  const quote = type.features.quote;
  const access = aiAccess ?? { enabled: false, internal: false, sensitive: false };
  return (
    <>
      {onAiAccessChange && <fieldset className="os2-ai-access">
        <legend>Acesso da IA aos objetos — configuração da área</legend>
        <p>Estas permissões valem para todos os modelos desta área. Começam desligadas; o administrador define o acesso, validado pelo servidor.</p>
        <label className="os2-config-check"><input type="checkbox" checked={access.enabled}
          onChange={(event) => onAiAccessChange(event.target.checked
            ? { ...access, enabled: true }
            : { enabled: false, internal: false, sensitive: false })} />Permitir acesso da IA aos dados dos objetos</label>
        <label className="os2-config-check"><input type="checkbox" checked={access.internal} disabled={!access.enabled}
          onChange={(event) => onAiAccessChange({ ...access, internal: event.target.checked })} />Incluir campos internos</label>
        <label className="os2-config-check"><input type="checkbox" checked={access.sensitive} disabled={!access.enabled}
          onChange={(event) => onAiAccessChange({ ...access, sensitive: event.target.checked })} />Incluir campos sensíveis</label>
        <p>O acesso externo, inclusive pelo WhatsApp, continua limitado aos dados autorizados do próprio cliente. Identificadores de objetos não comprovam propriedade. Desligar o acesso também desliga a inclusão de campos internos e sensíveis.</p>
      </fieldset>}
      {(
        [
          ["customer_open", "Abertura pelo cliente"],
          ["tasks", "Tarefas e prazos"],
          ["people", "Pessoas"],
          ["documents", "Documentos"],
          ["entries", "Lançamentos"],
        ] as const
      ).map(([key, label]) => (
        <label className="os-work-check" key={key}>
          <input
            type="checkbox"
            checked={type.features[key]}
            onChange={(event) => update({ [key]: event.target.checked })}
          />
          {label}
        </label>
      ))}
      {(
        [
          ["warranty_days", "Garantia (dias)", 3650],
          ["pickup_reminder_days", "Aviso de retirada (dias)", 365],
          ["stale_days", "Aviso de paralisação (dias)", 365],
        ] as const
      ).map(([key, label, max]) => (
        <Field
          key={key}
          label={label}
          type="number"
          value={type.features[key]}
          min={0}
          max={max}
          onChange={(value) => update({ [key]: Number(value) })}
        />
      ))}
      <Field
        label="Termos"
        value={type.terms || ""}
        type="textarea"
        maxLength={1400}
        onChange={(terms) => onChange({ ...type, terms: terms || null })}
      />
      <label className="os-work-check">
        <input
          type="checkbox"
          checked={!!quote}
          onChange={(event) =>
            update({
              quote: event.target.checked
                ? {
                    default_valid_days: 7,
                    source_stages: [],
                    sent_stage: "",
                    approved_stage: "",
                    declined_stage: "",
                    edited_stage: "",
                  }
                : null,
            })
          }
        />
        Orçamento
      </label>
      {quote && (
        <fieldset>
          <legend>Política de orçamento</legend>
          <Field
            label="Validade padrão (dias)"
            type="number"
            min={1}
            value={quote.default_valid_days}
            onChange={(value) =>
              update({ quote: { ...quote, default_valid_days: Number(value) } })
            }
          />
          {(
            [
              "sent_stage",
              "approved_stage",
              "declined_stage",
              "edited_stage",
            ] as const
          ).map((key, index) => (
            <Field
              key={key}
              label={
                [
                  "Etapa de envio",
                  "Etapa de aprovação",
                  "Etapa de recusa",
                  "Etapa após editar orçamento enviado",
                ][index]
              }
              value={quote[key]}
              options={type.stages.map((stage) => ({
                id: stage.id,
                name: stage.label,
              }))}
              onChange={(value) =>
                update({ quote: { ...quote, [key]: value } })
              }
            />
          ))}
          <p>Etapas que permitem editar orçamento:</p>
          {type.stages.map((stage) => (
            <label className="os-work-check" key={stage.id}>
              <input
                type="checkbox"
                checked={quote.source_stages.includes(stage.id)}
                onChange={(event) =>
                  update({
                    quote: {
                      ...quote,
                      source_stages: event.target.checked
                        ? [...quote.source_stages, stage.id]
                        : quote.source_stages.filter((id) => id !== stage.id),
                    },
                  })
                }
              />
              {stage.label}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
