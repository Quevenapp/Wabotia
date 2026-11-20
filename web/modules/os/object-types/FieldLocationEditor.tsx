import React, { useState } from "react";
import { Button, Field, Notice } from "../../../ui";
import type { CustomWorkType, FieldRef, ServiceObjectType, StageFieldRule, WorkField } from "../work-contracts";
import { labelIdentifier, moveFieldLocation } from "../types/type-draft";

export interface FieldLocationEditorProps {
  type: CustomWorkType;
  objectType?: ServiceObjectType;
  field: WorkField;
  scope: FieldRef["scope"];
  onChange: (type: CustomWorkType, objectType?: ServiceObjectType) => void;
  moveBlocked?: string;
}

/** Controles da referência qualificada; valores continuam nos seus formulários. */
export function FieldLocationEditor({ type, objectType, field, scope, onChange, moveBlocked }: FieldLocationEditorProps) {
  const [moving, setMoving] = useState(false);
  const [destination, setDestination] = useState("new");
  const [error, setError] = useState("");
  const rules = type.stage_field_rules ?? [];
  const requirement = scope === "order" ? rules.find((rule) => rule.field_id === field.id) : undefined;
  const list = type.list_fields ?? [];
  const selected = list.find((rule) => rule.ref.scope === scope && rule.ref.field_id === field.id);
  const columns = list.filter((rule) => rule.column).length;
  const filters = list.filter((rule) => rule.filter).length;
  const filterAllowed = !field.sensitive && (field.kind !== "text" || (!field.multiline && field.max_length <= 240));
  const changeRequirement = (next: StageFieldRule) => {
    const remaining = rules.filter((rule) => rule.field_id !== field.id);
    if (next.required_from_stage || next.required_on_exit?.length) remaining.push(next);
    const updated = { ...type };
    if (remaining.length) updated.stage_field_rules = remaining;
    else delete updated.stage_field_rules;
    onChange(updated);
  };
  const changeList = (key: "column" | "filter", checked: boolean) => {
    const remaining = list.filter((rule) => rule.ref.scope !== scope || rule.ref.field_id !== field.id);
    const next = { ...selected, ref: { scope, field_id: field.id }, [key]: checked };
    if (!next.column) delete next.column;
    if (!next.filter) delete next.filter;
    if (next.column || next.filter) remaining.push(next);
    const updated = { ...type };
    if (remaining.length) updated.list_fields = remaining;
    else delete updated.list_fields;
    onChange(updated);
  };
  const targetFields = scope === "order" ? objectType?.fields ?? [] : type.fields;
  const targetRetired = scope === "order" ? objectType?.retired_field_ids ?? [] : type.retired_field_ids;
  const newId = labelIdentifier(field.id || field.label, [...targetFields.map((entry) => entry.id), ...targetRetired]);
  return <div className="os2-field-location">
    <p><strong>{scope === "object" ? `Do objeto · ${objectType?.labels.singular ?? "Objeto"}` : "Desta ordem"}</strong> <code>{scope}:{field.id || "novo_campo"}</code></p>
    {scope === "order" && <fieldset className="os2-requirements" disabled={field.sensitive || !field.id}>
      <legend>Obrigatoriedade por etapa</legend>
      <Field label="Obrigatório a partir da entrada na etapa" value={requirement?.required_from_stage ?? ""}
        emptyOption="Sem exigência na entrada"
        options={type.stages.filter((stage) => stage.base_status !== "cancelled").map((stage) => ({ id: stage.id, name: stage.label }))}
        onChange={(value) => {
          const next = { ...requirement, field_id: field.id };
          if (value) next.required_from_stage = value;
          else delete next.required_from_stage;
          changeRequirement(next);
        }} />
      <span>Obrigatório ao sair da etapa:</span>
      {type.stages.filter((stage) => !["delivered", "cancelled"].includes(stage.base_status)).map((stage) => <label className="os2-check" key={stage.id}>
        <input type="checkbox" checked={requirement?.required_on_exit?.includes(stage.id) ?? false}
          onChange={(event) => {
            const exits = requirement?.required_on_exit ?? [];
            const next = { ...requirement, field_id: field.id,
              required_on_exit: event.target.checked ? [...exits, stage.id] : exits.filter((id) => id !== stage.id) };
            if (!next.required_on_exit.length) delete (next as StageFieldRule).required_on_exit;
            changeRequirement(next);
          }} />{stage.label}
      </label>)}
    </fieldset>}
    {scope === "object" && <p className="os2-field-help">Obrigatoriedade apenas no cadastro do objeto. A cópia de uma ordem anterior não será preenchida depois.</p>}
    <fieldset className="os2-list-options" disabled={field.sensitive || !field.id}>
      <legend>Colunas e filtros deste modelo</legend>
      <label className="os2-check"><input type="checkbox" checked={selected?.column ?? false}
        disabled={!selected?.column && columns >= 4}
        onChange={(event) => changeList("column", event.target.checked)} />Coluna própria ({columns}/4)</label>
      <label className="os2-check"><input type="checkbox" checked={selected?.filter ?? false}
        disabled={!selected?.filter && (!filterAllowed || filters >= 4)}
        onChange={(event) => changeList("filter", event.target.checked)} />Filtro próprio ({filters}/4)</label>
      {!filterAllowed && !field.sensitive && <p className="os2-field-help">Texto filtrável deve ter uma linha e limite de até 240 caracteres.</p>}
      {filterAllowed && <p className="os2-field-help">{["integer", "decimal", "date"].includes(field.kind)
        ? "Igualdade ou intervalo fechado. Intervalos ordenam pelo valor crescente."
        : field.kind === "text" ? "Igualdade de texto normalizado, sem busca por trecho." : "Filtro por igualdade."} Apenas um filtro próprio ativo por consulta.</p>}
    </fieldset>
    {objectType && <>
      <Button secondary disabled={!!moveBlocked || !field.id} onClick={() => { setMoving(!moving); setError(""); }}>
        Alterar localização
      </Button>
      {moveBlocked && <p className="os2-field-help">{moveBlocked}</p>}
      {moving && <div className="os2-move-review">
        <p>Mover para {scope === "order" ? `o objeto ${objectType.labels.singular}` : "esta ordem"} aposenta o ID na origem. Nenhum valor histórico será transferido.</p>
        <Field label="Campo no destino" value={destination} emptyOption={null}
          options={[{ id: "new", name: `Criar novo campo (${newId})` }, ...targetFields.map((entry) => ({ id: `ref:${entry.id}`, name: `Referenciar ${entry.label} (${entry.id})` }))]}
          onChange={setDestination} />
        <Button secondary onClick={() => {
          try {
            const result = moveFieldLocation(type, objectType, scope, field.id,
              destination === "new" ? newId : destination.slice(4));
            onChange(result.work_type, result.object_type);
            setMoving(false);
            setError("");
          } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a localização."); }
        }}>Confirmar mudança de localização</Button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>}
    </>}
  </div>;
}
