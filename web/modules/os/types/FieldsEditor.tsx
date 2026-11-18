import React from "react";
import { Button, Field } from "../../../ui";
import type { WorkField } from "../work-contracts";
import { newField } from "./type-draft";
export function FieldsEditor({
  fields,
  onChange,
  locked = [],
}: {
  fields: WorkField[];
  onChange: (fields: WorkField[]) => void;
  locked?: string[];
}) {
  const update = (index: number, field: WorkField) =>
    onChange(fields.map((old, i) => (i === index ? field : old)));
  return (
    <>
      {fields.map((field, index) => (
        <fieldset key={index}>
          <legend>Campo {index + 1}</legend>
          <Field
            label="Identificador"
            value={field.id}
            disabled={locked.includes(field.id)}
            onChange={(id) => update(index, { ...field, id })}
            maxLength={32}
            required
          />
          <Field
            label="Rótulo"
            value={field.label}
            onChange={(label) => update(index, { ...field, label })}
            maxLength={80}
            required
          />
          <Field
            label="Ajuda"
            value={field.help}
            onChange={(help) => update(index, { ...field, help })}
            maxLength={240}
          />
          <Field
            label="Formato"
            value={field.kind}
            emptyOption={null}
            options={[
              ["text", "Texto"],
              ["integer", "Inteiro"],
              ["decimal", "Decimal"],
              ["boolean", "Sim ou não"],
              ["date", "Data"],
              ["choice", "Escolha"],
            ].map(([id, name]) => ({ id, name }))}
            onChange={(kind) =>
              update(index, {
                ...newField(kind as WorkField["kind"]),
                id: field.id,
                label: field.label,
                help: field.help,
                required: field.required,
                sensitive: field.sensitive,
                client_visible: field.client_visible,
              })
            }
          />
          {(["required", "client_visible", "sensitive"] as const).map((key) => (
            <label className="os-work-check" key={key}>
              <input
                type="checkbox"
                checked={field[key]}
                onChange={(event) =>
                  update(index, { ...field, [key]: event.target.checked })
                }
              />
              {key === "required"
                ? "Obrigatório"
                : key === "client_visible"
                  ? "Visível ao cliente"
                  : "Sensível"}
            </label>
          ))}
          {field.kind === "text" && (
            <>
              <label className="os-work-check">
                <input
                  type="checkbox"
                  checked={field.multiline}
                  onChange={(event) =>
                    update(index, { ...field, multiline: event.target.checked })
                  }
                />
                Várias linhas
              </label>
              <Field
                label="Limite de caracteres"
                type="number"
                value={field.max_length}
                min={1}
                max={2000}
                onChange={(value) =>
                  update(index, { ...field, max_length: Number(value) })
                }
              />
            </>
          )}
          {(field.kind === "integer" || field.kind === "decimal") && (
            <>
              <Field
                label="Mínimo"
                type="number"
                value={field.min}
                onChange={(value) =>
                  update(index, { ...field, min: Number(value) })
                }
              />
              <Field
                label="Máximo"
                type="number"
                value={field.max}
                onChange={(value) =>
                  update(index, { ...field, max: Number(value) })
                }
              />
              {field.kind === "decimal" && (
                <Field
                  label="Casas decimais"
                  type="number"
                  min={0}
                  max={6}
                  value={field.scale}
                  onChange={(value) =>
                    update(index, { ...field, scale: Number(value) })
                  }
                />
              )}
            </>
          )}
          {field.kind === "date" && (
            <>
              <Field
                label="Data mínima"
                type="date"
                value={field.min || ""}
                onChange={(min) =>
                  update(index, { ...field, min: min || null })
                }
              />
              <Field
                label="Data máxima"
                type="date"
                value={field.max || ""}
                onChange={(max) =>
                  update(index, { ...field, max: max || null })
                }
              />
            </>
          )}
          {field.kind === "choice" && (
            <>
              <Field
                label="Opções (identificador: rótulo, uma por linha)"
                type="textarea"
                value={field.options
                  .map((option) => `${option.id}: ${option.label}`)
                  .join("\n")}
                onChange={(value) =>
                  update(index, {
                    ...field,
                    options: value.split("\n").map((line) => {
                      const [id, ...parts] = line.split(":");
                      return { id: id.trim(), label: parts.join(":").trim() };
                    }),
                  })
                }
              />
            </>
          )}
          <div className="card-actions">
            <Button
              secondary
              disabled={!index}
              onClick={() => {
                const next = [...fields];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange(next);
              }}
            >
              Subir
            </Button>
            <Button
              secondary
              disabled={index === fields.length - 1}
              onClick={() => {
                const next = [...fields];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                onChange(next);
              }}
            >
              Descer
            </Button>
            <Button
              secondary
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              Aposentar campo
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        secondary
        disabled={fields.length >= 24}
        onClick={() => onChange([...fields, newField()])}
      >
        Adicionar campo
      </Button>
    </>
  );
}
