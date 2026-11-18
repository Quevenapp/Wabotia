import React from "react";
import { Button, Field } from "../../../ui";
import type { CustomWorkType, BaseStatus } from "../work-contracts";
import { statusOrder, statusLabels } from "../shared";
export function StagesEditor({
  type,
  onChange,
  locked = [],
}: {
  type: CustomWorkType;
  onChange: (type: CustomWorkType) => void;
  locked?: string[];
}) {
  const options = type.stages.map((stage) => ({
    id: stage.id,
    name: stage.label || stage.id,
  }));
  return (
    <>
      <Field
        label="Etapa inicial"
        value={type.initial_stage}
        options={options}
        onChange={(initial_stage) => onChange({ ...type, initial_stage })}
        required
      />
      {type.stages.map((stage, index) => (
        <fieldset key={index}>
          <legend>Etapa {index + 1}</legend>
          <Field
            label="Identificador"
            value={stage.id}
            disabled={locked.includes(stage.id)}
            onChange={(id) =>
              onChange({
                ...type,
                stages: type.stages.map((s, i) =>
                  i === index ? { ...s, id } : s,
                ),
              })
            }
            required
            maxLength={32}
          />
          <Field
            label="Nome"
            value={stage.label}
            onChange={(label) =>
              onChange({
                ...type,
                stages: type.stages.map((s, i) =>
                  i === index ? { ...s, label } : s,
                ),
              })
            }
            required
            maxLength={80}
          />
          <Field
            label="Estado de base"
            value={stage.base_status}
            emptyOption={null}
            options={statusOrder.map((id) => ({ id, name: statusLabels[id] }))}
            onChange={(base_status) =>
              onChange({
                ...type,
                stages: type.stages.map((s, i) =>
                  i === index
                    ? { ...s, base_status: base_status as BaseStatus }
                    : s,
                ),
              })
            }
          />
          <div className="card-actions">
            <Button
              secondary
              disabled={!index}
              onClick={() => {
                const stages = [...type.stages];
                [stages[index - 1], stages[index]] = [
                  stages[index],
                  stages[index - 1],
                ];
                onChange({ ...type, stages });
              }}
            >
              Subir
            </Button>
            <Button
              secondary
              onClick={() =>
                onChange({
                  ...type,
                  stages: type.stages.filter((_, i) => i !== index),
                })
              }
            >
              Aposentar etapa
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        secondary
        disabled={type.stages.length >= 32}
        onClick={() =>
          onChange({
            ...type,
            stages: [
              ...type.stages,
              { id: "", label: "", base_status: "in_progress", message: "" },
            ],
          })
        }
      >
        Adicionar etapa
      </Button>
      <h3>Transições</h3>
      {type.transitions.map((transition, index) => {
        const update = (patch: object) =>
          onChange({
            ...type,
            transitions: type.transitions.map((t, i) =>
              i === index ? { ...t, ...patch } : t,
            ),
          });
        return (
          <fieldset key={index}>
            <legend>Transição {index + 1}</legend>
            <Field
              label="Identificador"
              value={transition.id}
              onChange={(id) => update({ id })}
              required
              maxLength={32}
            />
            <Field
              label="Ação"
              value={transition.label}
              onChange={(label) => update({ label })}
              required
              maxLength={80}
            />
            <Field
              label="De"
              value={transition.from}
              options={options}
              onChange={(from) => update({ from })}
            />
            <Field
              label="Para"
              value={transition.to}
              options={options}
              onChange={(to) => update({ to })}
            />
            <Field
              label="Autorização"
              value={transition.kind}
              emptyOption={null}
              options={[
                { id: "manual", name: "Equipe" },
                { id: "customer_approval", name: "Aprovação do cliente" },
              ]}
              onChange={(kind) => {
                const { id, from, to, label } = transition;
                onChange({
                  ...type,
                  transitions: type.transitions.map((t, i) =>
                    i !== index
                      ? t
                      : kind === "manual"
                        ? { id, from, to, label, kind: "manual" }
                        : {
                            id,
                            from,
                            to,
                            label,
                            kind: "customer_approval",
                            valid_hours: 72,
                            request_text: "",
                          },
                  ),
                });
              }}
            />
            {transition.kind === "customer_approval" && (
              <>
                <Field
                  label="Validade (horas)"
                  type="number"
                  value={transition.valid_hours}
                  min={1}
                  max={720}
                  onChange={(value) => update({ valid_hours: Number(value) })}
                />
                <Field
                  label="Pedido de aprovação"
                  type="textarea"
                  value={transition.request_text}
                  onChange={(request_text) => update({ request_text })}
                  maxLength={900}
                />
              </>
            )}
            <Button
              secondary
              onClick={() =>
                onChange({
                  ...type,
                  transitions: type.transitions.filter((_, i) => i !== index),
                })
              }
            >
              Remover transição
            </Button>
          </fieldset>
        );
      })}
      <Button
        secondary
        disabled={type.transitions.length >= 128}
        onClick={() =>
          onChange({
            ...type,
            transitions: [
              ...type.transitions,
              {
                id: "",
                from: type.initial_stage,
                to: "",
                label: "",
                kind: "manual",
              },
            ],
          })
        }
      >
        Adicionar transição
      </Button>
    </>
  );
}
