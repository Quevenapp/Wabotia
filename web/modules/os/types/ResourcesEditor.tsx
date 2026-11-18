import React from "react";
import { Field } from "../../../ui";
import type { CustomWorkType } from "../work-contracts";
export function ResourcesEditor({
  type,
  onChange,
}: {
  type: CustomWorkType;
  onChange: (type: CustomWorkType) => void;
}) {
  const update = (features: Partial<CustomWorkType["features"]>) =>
    onChange({ ...type, features: { ...type.features, ...features } });
  const quote = type.features.quote;
  return (
    <>
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
