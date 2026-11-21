import React from "react";
import { Button, Field } from "../../../ui";
import type { CustomWorkType, BaseStatus } from "../work-contracts";
import { statusOrder, statusLabels } from "../shared";
import { labelIdentifier, messagePreview, renameStage } from "./type-draft";

type Stage = CustomWorkType["stages"][number];
/** OS6: itens do checklist da etapa (texto, obrigatório, foto obrigatória). */
function ChecklistEditor({ stage, documents, onChange }: { stage: Stage; documents: boolean; onChange: (stage: Stage) => void }) {
  const items = stage.checklist ?? [];
  const set = (next: NonNullable<Stage["checklist"]>) => {
    const { checklist: _old, ...rest } = stage;
    onChange(next.length ? { ...rest, checklist: next } : rest);
  };
  if (["delivered", "cancelled"].includes(stage.base_status)) return null;
  return <details open={items.length > 0}>
    <summary>Checklist da etapa ({items.length})</summary>
    <p>A etapa só avança com os itens obrigatórios marcados. Cancelar e voltar etapa não dependem do checklist.</p>
    {items.map((item, index) => <div key={index} className="os-checklist-edit">
      <Field label={`Item ${index + 1}`} value={item.label} required maxLength={120}
        onChange={(label) => set(items.map((entry, i) => i !== index ? entry : {
          ...entry, label, id: !entry.id || entry.id === labelIdentifier(entry.label, items.filter((_, j) => j !== index).map(other => other.id))
            ? labelIdentifier(label, items.filter((_, j) => j !== index).map(other => other.id)) : entry.id,
        }))} />
      <label className="os-work-check"><input type="checkbox" checked={item.required}
        onChange={(event) => set(items.map((entry, i) => i === index ? { ...entry, required: event.target.checked } : entry))} /> Obrigatório</label>
      <label className="os-work-check"><input type="checkbox" checked={item.photo_required} disabled={!documents && !item.photo_required}
        onChange={(event) => set(items.map((entry, i) => i === index ? { ...entry, photo_required: event.target.checked } : entry))} /> Com foto obrigatória</label>
      <Button secondary size="sm" onClick={() => set(items.filter((_, i) => i !== index))}>Remover item</Button>
    </div>)}
    {!documents && <small>Para pedir foto, ligue Documentos nos recursos do modelo.</small>}
    <Button secondary size="sm" disabled={items.length >= 20}
      onClick={() => set([...items, { id: "", label: "", required: true, photo_required: false }])}>Adicionar item ao checklist</Button>
  </details>;
}

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
      <p>Configure as exigências de preenchimento em Campos extras: na abertura, a partir de uma etapa ou ao sair dela. Depois de ativada, a exigência continua valendo nos retornos. Cancelar continua possível sem completar o formulário.</p>
      <p>Rascunho significa salvar o preenchimento parcial de uma ordem já aberta, sem avançar a etapa. A abertura continua exigindo os campos obrigatórios iniciais.</p>
      <Field
        label="Etapa inicial"
        value={type.initial_stage}
        options={options}
        onChange={(initial_stage) => onChange({ ...type, initial_stage })}
        required
      />
      {/* OS6: resumo do checklist da etapa no acompanhamento pelo WhatsApp. */}
      <label className="os-work-check"><input type="checkbox" checked={type.features.checklist_customer_summary === true}
        onChange={(event) => {
          const { checklist_customer_summary: _old, ...features } = type.features;
          onChange({ ...type, features: event.target.checked ? { ...features, checklist_customer_summary: true } : features });
        }} /> Mostrar ao cliente o resumo do checklist da etapa no acompanhamento pelo WhatsApp</label>
      {type.stages.map((stage, index) => (
        <fieldset key={index}>
          <legend>Etapa {index + 1}</legend>
          <details>
            <summary>Avançado</summary>
            <Field
            label="Identificador"
            value={stage.id}
            disabled={locked.includes(stage.id)}
            onChange={(id) =>
              onChange(renameStage(type, index, id))
            }
            required
            maxLength={32}
          />
          </details>
          <Field
            label="Nome"
            value={stage.label}
            onChange={(label) =>
              onChange(renameStage(type, index,
                !locked.includes(stage.id) && (!stage.id || stage.id === labelIdentifier(stage.label, [...type.retired_stage_ids, ...locked, ...type.stages.filter((_, i) => i !== index).map((item) => item.id)]))
                  ? labelIdentifier(label, [...type.retired_stage_ids, ...locked, ...type.stages.filter((_, i) => i !== index).map((item) => item.id)])
                  : stage.id, label))
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
          <ChecklistEditor stage={stage} documents={type.features.documents}
            onChange={(next) => onChange({ ...type, stages: type.stages.map((s, i) => i === index ? next : s) })} />
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
              disabled={type.stage_field_rules?.some((rule) => rule.required_from_stage === stage.id || rule.required_on_exit?.includes(stage.id))}
              onClick={() =>
                onChange({
                  ...type,
                  stages: type.stages.filter((_, i) => i !== index),
                })
              }
            >
              Aposentar etapa
            </Button>
            {type.stage_field_rules?.some((rule) => rule.required_from_stage === stage.id || rule.required_on_exit?.includes(stage.id)) && <small>Remova ou altere as exigências desta etapa em Campos extras antes de aposentá-la.</small>}
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
            <details>
              <summary>Avançado</summary>
              <Field
              label="Identificador"
              value={transition.id}
              onChange={(id) => update({ id })}
              required
              maxLength={32}
            />
            </details>
            <Field
              label="Ação"
              value={transition.label}
              onChange={(label) => update({ label, id: !transition.id || transition.id === labelIdentifier(transition.label, type.transitions.filter((_, i) => i !== index).map((item) => item.id))
                ? labelIdentifier(label, type.transitions.filter((_, i) => i !== index).map((item) => item.id)) : transition.id })}
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
                <small>Use {"{objeto}"} para a identificação pública capturada na ordem. Prévia fictícia: {messagePreview(transition.request_text, type) || "Sem mensagem"}</small>
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
