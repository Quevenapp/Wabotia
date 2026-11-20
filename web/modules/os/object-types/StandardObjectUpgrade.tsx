import React, { useState } from "react";
import { Button, Field, Notice } from "../../../ui";
import type { CustomWorkType, ServiceObjectType } from "../work-contracts";
import { labelIdentifier } from "../types/type-draft";
import { planObjectUpgrade, type ObjectUpgradeInput, type ObjectUpgradePlan } from "../../../../src/area-templates/object-upgrades";

export interface StandardObjectUpgradeProps {
  current: CustomWorkType;
  standard: CustomWorkType;
  objectType: ServiceObjectType;
  existingObjectType?: ServiceObjectType;
  previousStandard?: CustomWorkType;
  availableObjectTypes?: ServiceObjectType[];
  workTypes?: CustomWorkType[];
  busy?: boolean;
  onApply: (plan: ObjectUpgradePlan) => void;
}

/** Sem a versão anterior do padrão, nenhuma mudança de localização é presumida. */
export function standardUpgradePreview(
  props: Omit<StandardObjectUpgradeProps, "onApply" | "busy">,
  resolutions: ObjectUpgradeInput["resolutions"] = {},
  ruleResolution?: ObjectUpgradeInput["rule_resolution"],
): ObjectUpgradePlan {
  const candidates = props.current.fields.filter((field) =>
    !props.standard.fields.some((item) => item.id === field.id) &&
    props.objectType.fields.some((item) => item.id === field.id));
  const effective = { ...resolutions };
  if (!props.previousStandard) for (const field of candidates)
    effective[field.id] ??= "keep";
  const plan = planObjectUpgrade({
    current: props.current,
    previous_standard: props.previousStandard ?? props.current,
    standard: props.standard,
    object_type: props.objectType,
    existing_object_type: props.existingObjectType,
    resolutions: effective,
    rule_resolution: ruleResolution ?? (!props.previousStandard ? "keep" : undefined),
  });
  if (!props.previousStandard) {
    for (const field of candidates) if (!resolutions[field.id]) plan.conflicts.push({
      path: `fields.${field.id}`, code: "review_required",
      message: `${field.label}: revise o significado e escolha a localização. A versão anterior do padrão não está disponível.`,
    });
    if (!ruleResolution) plan.conflicts.push({
      path: "rules", code: "review_required",
      message: "Escolha preservar as exigências, colunas e filtros atuais ou adotar os do padrão.",
    });
  }
  plan.can_apply = plan.conflicts.length === 0;
  return plan;
}

export function StandardObjectUpgrade(props: StandardObjectUpgradeProps) {
  const [resolutions, setResolutions] = useState<NonNullable<ObjectUpgradeInput["resolutions"]>>({});
  const [ruleResolution, setRuleResolution] = useState<ObjectUpgradeInput["rule_resolution"]>();
  const [reviewed, setReviewed] = useState(false);
  const [objectChoice, setObjectChoice] = useState("proposed");
  const availableObjects = props.availableObjectTypes ?? [];
  const chosen = objectChoice.startsWith("existing:") ? availableObjects.find((object) => object.id === objectChoice.slice(9)) : undefined;
  const proposed = objectChoice === "new"
    ? { ...props.objectType, id: labelIdentifier(props.objectType.id, availableObjects.map((object) => object.id), 64), revision: 1 }
    : chosen ? { ...props.objectType, id: chosen.id } : props.objectType;
  const existing = objectChoice === "new" ? undefined : chosen ?? props.existingObjectType;
  const previewProps = { ...props, objectType: proposed, existingObjectType: existing,
    standard: { ...props.standard, object_type_id: proposed.id } };
  const candidates = props.current.fields.filter((field) =>
    !props.standard.fields.some((item) => item.id === field.id) &&
    props.objectType.fields.some((item) => item.id === field.id));
  let plan: ObjectUpgradePlan | undefined, error = "";
  try { plan = standardUpgradePreview(previewProps, resolutions, ruleResolution); }
  catch (cause) { error = cause instanceof Error ? cause.message : "Não foi possível preparar a atualização."; }
  const label = (id: string) => props.current.fields.find((field) => field.id === id)?.label
    ?? props.standard.fields.find((field) => field.id === id)?.label ?? id;
  const stageLabel = (id: string) => props.current.stages.find((stage) => stage.id === id)?.label ?? id;
  return <section className="os2-config" aria-label="Revisão do padrão">
    <h3>O modelo padrão mudou: revisar e aplicar</h3>
    {availableObjects.length > 0 && <Field label="Tipo de objeto da atualização" value={objectChoice} emptyOption={null}
      options={[{ id: "proposed", name: "Tipo previsto pelo padrão" }, { id: "new", name: "Criar tipo independente, preservando os atuais" },
        ...availableObjects.filter((object) => !object.archived).map((object) => ({ id: `existing:${object.id}`, name: `Usar ${object.labels.singular} (${object.id})` }))]}
      onChange={(value) => { setObjectChoice(value); setReviewed(false); }} />}
    <p>{existing ? "Usar tipo de objeto" : "Criar tipo de objeto"}: <strong>{existing?.labels.singular ?? proposed.labels.singular}</strong> · {proposed.id}.</p>
    {existing && <p>Modelos que compartilham este tipo: {props.workTypes?.filter((type) => type.object_type_id === existing.id).map((type) => type.labels.singular).join(", ") || "nenhum"}.</p>}
    {!props.previousStandard && <Notice>A versão anterior do padrão não está disponível. Confirme cada campo e as regras antes de aplicar; nomes parecidos não comprovam o mesmo significado.</Notice>}
    {candidates.map((field) => <Field key={field.id}
      label={`${field.label} · localização no novo padrão`}
      value={resolutions[field.id] ?? ""}
      options={[
        { id: "keep", name: "Manter nesta ordem" },
        ...(!field.sensitive ? [{ id: "move", name: "Confirmar significado e passar ao objeto" }] : []),
      ]}
      onChange={(value) => { setResolutions({ ...resolutions, [field.id]: value as "move" | "keep" }); setReviewed(false); }}
    />)}
    {candidates.some((field) => field.sensitive) && <Notice>Campos sensíveis permanecem protegidos na ordem. Uma identificação pública deve ser informada expressamente no novo cadastro.</Notice>}
    <Field label="Exigências, colunas e filtros" value={ruleResolution ?? ""}
      options={[{ id: "keep", name: "Preservar configurações atuais" }, { id: "standard", name: "Adotar configurações do padrão" }]}
      onChange={(value) => { setRuleResolution(value ? value as "keep" | "standard" : undefined); setReviewed(false); }} />
    <details>
      <summary>Exigências, colunas e filtros propostos pelo padrão</summary>
      <ul>
        {props.standard.fields.filter((field) => field.required).map((field) => <li key={`opening:${field.id}`}>{field.label}: obrigatório na abertura.</li>)}
        {(props.standard.stage_field_rules ?? []).map((rule) => <li key={rule.field_id}>
          {label(rule.field_id)}: {rule.required_from_stage ? `a partir de ${stageLabel(rule.required_from_stage)}` : ""}
          {rule.required_on_exit?.length ? ` ao sair de ${rule.required_on_exit.map(stageLabel).join(", ")}` : ""}.
        </li>)}
        {(props.standard.list_fields ?? []).map((rule) => <li key={`${rule.ref.scope}:${rule.ref.field_id}`}>
          {rule.ref.scope === "object" ? "Do objeto" : "Desta ordem"} · {label(rule.ref.field_id)}: {[rule.column && "coluna", rule.filter && "filtro"].filter(Boolean).join(" e ")}.
        </li>)}
      </ul>
    </details>
    {plan && <>
      <p>Permanecem nesta ordem: {plan.retained_fields.map(label).join(", ") || "nenhum campo extra"}.</p>
      <p>Passam ao objeto: {plan.moved_fields.map(label).join(", ") || "nenhum campo confirmado"}.</p>
      <p>Novos campos desta ordem: {plan.added_fields.map(label).join(", ") || "nenhum"}.</p>
      <p>Campos do objeto: {plan.object_type.fields.map((field) => field.label).join(", ")}.</p>
      <Notice>{plan.notice}</Notice>
      {plan.conflicts.length > 0 && <Notice tone="error"><ul>{plan.conflicts.map((conflict, index) => <li key={index}>{conflict.message}</li>)}</ul></Notice>}
      <label className="os2-config-check"><input type="checkbox" checked={reviewed} disabled={!plan.can_apply}
        onChange={(event) => setReviewed(event.target.checked)} />Revisei a prévia e os modelos que compartilham este objeto.</label>
      <Button disabled={props.busy || !plan.can_apply || !reviewed} onClick={() => plan && props.onApply(plan)}>Aplicar atualização revisada</Button>
    </>}
    {error && <Notice tone="error">{error}</Notice>}
  </section>;
}
