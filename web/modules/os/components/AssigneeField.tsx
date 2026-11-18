import React from "react";
import { useApp } from "../../../app/AppContext";
import { Field } from "../../../ui";
export function AssigneeField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string) => void;
}) {
  const app = useApp();
  const options = app.team
    .filter((member) => member.kind === "user")
    .map((member) => ({ id: member.id, name: member.name }));
  if (value && !options.some((option) => option.id === value))
    options.push({ id: value, name: app.names[value] || value });
  return (
    <Field
      label="Responsável"
      value={value || ""}
      onChange={onChange}
      options={options}
      emptyOption="Sem responsável"
    />
  );
}
