import React from "react";
import { Field } from "../../../ui";
import type { ExtraValues, WorkField, FieldValue } from "../work-contracts";

// Campos privados têm fluxo próprio. Não entram em formulários comuns, nem por engano.
export const commonFields = (fields: WorkField[]) =>
  fields.filter((field) => !field.sensitive);
export function fieldValue(field: WorkField, input: string): FieldValue {
  if (input === "") return null;
  if (field.kind === "boolean") return input === "true";
  if (field.kind === "integer" || field.kind === "decimal") {
    const number = Number(input);
    if (
      !Number.isFinite(number) ||
      (field.kind === "integer" && !Number.isSafeInteger(number))
    )
      return input;
    return number;
  }
  return input;
}
export function commonExtra(
  fields: WorkField[],
  extra: ExtraValues,
): ExtraValues {
  return Object.fromEntries(
    commonFields(fields)
      .filter((field) => Object.hasOwn(extra, field.id))
      .map((field) => [field.id, extra[field.id]]),
  );
}
export function ExtraFields({
  fields,
  values,
  onChange,
  readOnly = false,
}: {
  fields: WorkField[];
  values: ExtraValues;
  onChange?: (values: ExtraValues) => void;
  readOnly?: boolean;
}) {
  return (
    <>
      {commonFields(fields).map((field) => {
        const value = values[field.id];
        if (readOnly)
          return (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd>
                {value == null
                  ? "—"
                  : field.kind === "boolean"
                    ? value
                      ? "Sim"
                      : "Não"
                    : field.kind === "choice"
                      ? field.options.find((option) => option.id === value)
                          ?.label || String(value)
                      : String(value)}
              </dd>
            </div>
          );
        return (
          <Field
            key={field.id}
            label={field.label}
            help={field.help}
            required={field.required}
            value={value == null ? "" : String(value)}
            onChange={(input) =>
              onChange?.({
                ...values,
                [field.id]:
                  field.kind === "integer" || field.kind === "decimal"
                    ? input
                    : fieldValue(field, input),
              })
            }
            type={
              field.kind === "date"
                ? "date"
                : field.kind === "text" && field.multiline
                  ? "textarea"
                  : "text"
            }
            maxLength={field.kind === "text" ? field.max_length : undefined}
            options={
              field.kind === "boolean"
                ? [
                    { id: "true", name: "Sim" },
                    { id: "false", name: "Não" },
                  ]
                : field.kind === "choice"
                  ? field.options.map((option) => ({
                      id: option.id,
                      name: option.label,
                    }))
                  : undefined
            }
          />
        );
      })}
    </>
  );
}

/** Converte só ao salvar para preservar entradas parciais, como "1,". */
export function parseExtra(
  fields: WorkField[],
  draft: ExtraValues,
): ExtraValues {
  const values = commonExtra(fields, draft);
  for (const field of commonFields(fields)) {
    const raw = values[field.id];
    if (
      raw === undefined ||
      raw === null ||
      (typeof raw === "string" && raw.trim() === "")
    ) {
      if (field.required)
        throw new Error(`${field.label}: preenchimento obrigatório.`);
      if (raw !== undefined && (field.kind === "integer" || field.kind === "decimal"))
        values[field.id] = null;
      continue;
    }
    if (field.kind === "integer" || field.kind === "decimal") {
      const text = String(raw).trim().replace(",", ".");
      if (!/^-?\d+(?:\.\d+)?$/.test(text))
        throw new Error(`${field.label}: número inválido.`);
      const number = Number(text);
      if (
        !Number.isFinite(number) ||
        number < field.min ||
        number > field.max ||
        (field.kind === "integer" && !Number.isSafeInteger(number)) ||
        (field.kind === "decimal" &&
          (text.split(".")[1]?.length || 0) > field.scale)
      )
        throw new Error(`${field.label}: confira limites e casas decimais.`);
      values[field.id] = number;
    } else if (field.kind === "date") {
      const text = String(raw),
        date = new Date(text + "T00:00:00Z");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== text ||
        (field.min && text < field.min) ||
        (field.max && text > field.max)
      )
        throw new Error(`${field.label}: data inválida.`);
    } else if (
      field.kind === "choice" &&
      !field.options.some((option) => option.id === raw)
    )
      throw new Error(`${field.label}: escolha uma opção válida.`);
    else if (field.kind === "boolean" && typeof raw !== "boolean")
      throw new Error(`${field.label}: escolha Sim ou Não.`);
    else if (
      field.kind === "text" &&
      (typeof raw !== "string" || [...raw.trim()].length > field.max_length)
    )
      throw new Error(`${field.label}: texto fora do limite.`);
  }
  return values;
}
