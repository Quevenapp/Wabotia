import React, { useMemo, useState } from "react";
import { Button, Notice } from "../../../ui";
import { ExtraFields, parseExtra } from "../components/ExtraFields";
import type { ExtraValues, ObjectOpeningRequest, Order, ServiceObjectType, WorkField, WorkTypeView } from "../work-contracts";
import { useDraftGuard, useWorkApi } from "../work-hooks";
import { ObjectPicker, parseObjectOpening } from "./ObjectPicker";
import { useWorkOperationDialog } from "../work/WorkFormDialog";

const visitFields = new Set(["quilometragem", "combustivel", "combustivel_entrada", "nivel_combustivel", "ultima_manutencao", "ultima_manutencao_informada"]);

/** Somente a definição histórica comum pode fornecer candidatos. Rótulos nunca identificam um campo. */
export function legacyObjectPreview(order: Pick<Order, "fields" | "extra">, type: ServiceObjectType) {
  const values: ExtraValues = {}, fields: WorkField[] = [];
  for (const target of type.fields) {
    const source = order.fields.find(field => field.id === target.id);
    if (!source || source.sensitive || target.sensitive || visitFields.has(target.id) || source.kind !== target.kind || !Object.hasOwn(order.extra, source.id)) continue;
    // Mudança de significado/validação não é inferida a partir do mesmo ID.
    const shape = (field: WorkField) => JSON.stringify(field.kind === "text" ? [field.kind, field.multiline, field.max_length]
      : field.kind === "integer" || field.kind === "decimal" ? [field.kind, field.min, field.max, field.kind === "decimal" ? field.scale : null]
        : field.kind === "date" ? [field.kind, field.min, field.max]
          : field.kind === "choice" ? [field.kind, field.options.map(option => [option.id, option.label])]
            : [field.kind]);
    if (shape(source) !== shape(target)) continue;
    try {
      const parsed = parseExtra([{ ...target, required: false }], { [target.id]: order.extra[source.id] });
      if (parsed[target.id] === null || parsed[target.id] === "" || parsed[target.id] === undefined) continue;
      values[target.id] = parsed[target.id];
      fields.push(target);
    } catch { /* Um valor incompatível fica fora da prévia; nunca é reinterpretado. */ }
  }
  return { fields, values };
}

export function LegacyObjectLinkDialog({ order, type, onClose, onSaved }: {
  order: Order;
  type: WorkTypeView;
  onClose: () => void;
  onSaved: (order: Order) => void;
}) {
  const api = useWorkApi();
  const OperationDialog = useWorkOperationDialog();
  const [base, setBase] = useState(order), [value, setValue] = useState<ObjectOpeningRequest>(),
    [objectType, setObjectType] = useState<ServiceObjectType>(), [reviewed, setReviewed] = useState(false),
    [conflict, setConflict] = useState(false), [refreshKey, setRefreshKey] = useState(0);
  const close = useDraftGuard(!!value, onClose);
  const preview = useMemo(() => objectType ? legacyObjectPreview(base, objectType) : null, [base, objectType]);
  const eligible = type.kind === "custom" && !!type.object_type_id && !base.object && !!base.customer.contact_id;
  return <OperationDialog title="Vincular objeto à ordem antiga" onClose={close} submitLabel="Confirmar vínculo" disabled={!eligible || !value || !reviewed || conflict}
    onSubmit={async () => {
      if (!eligible || !reviewed) throw new Error("Confirme o contato e revise o vínculo antes de salvar.");
      try {
        const saved = await api.linkObject(base.id, { version: base.version, object: parseObjectOpening(value, objectType) });
        close.release();
        onSaved(saved);
      } catch (error) {
        if (["version_conflict", "object_archived", "object_definition_conflict"].includes((error as { code?: string }).code || "")) setConflict(true);
        throw error;
      }
    }}>
    <Notice>A ordem permanece como está, inclusive se já estiver encerrada. A cópia será marcada como “Vinculado posteriormente”, com a data deste vínculo. O vínculo não poderá ser trocado pela edição comum.</Notice>
    {!eligible ? <Notice tone="error">É necessário um modelo personalizado com objeto, sem vínculo anterior, e um contato confirmado nesta ordem.</Notice> : <>
      <p>Cliente proprietário: {base.customer.name || base.customer.contact_id}. A identificação do objeto não comprova propriedade.</p>
      <ObjectPicker key={base.customer.contact_id + ":" + type.object_type_id} contactId={base.customer.contact_id!} typeId={type.object_type_id!}
        value={value} onChange={next => { setValue(next); setReviewed(false); }} onType={setObjectType} refreshKey={refreshKey} />
      {preview && <section className="os-object-preview">
        <h3>Prévia dos campos compatíveis desta ordem</h3>
        <p>Somente estes campos comuns podem preencher um novo cadastro. Campos restritos, quilometragem, combustível na entrada e última manutenção informada permanecem na ordem.</p>
        {preview.fields.length ? <dl className="os-work-fields"><ExtraFields fields={preview.fields} values={preview.values} readOnly /></dl> : <p>Nenhum campo compatível para copiar. Informe os dados do cadastro manualmente.</p>}
        <Button secondary disabled={objectType?.archived} onClick={() => {
          if (!objectType) return;
          if (value?.mode === "new" && Object.keys(value.values).length && !window.confirm("Substituir o preenchimento do novo cadastro pelos campos desta prévia?")) return;
          setValue({ mode: "new", type_id: objectType.id, values: { ...preview.values } });
          setReviewed(false);
        }}>Criar {objectType?.labels.singular.toLowerCase()} a partir desta ordem</Button>
      </section>}
      <label className="os-object-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> Conferi o cliente, o cadastro escolhido e a prévia. Confirmo o vínculo posterior.</label>
    </>}
    {conflict && <Notice>Seu preenchimento foi preservado. <Button secondary onClick={async () => {
      const latest = await api.order(base.id);
      setBase(latest); setRefreshKey(value => value + 1); setConflict(false); setReviewed(false);
    }}>Recarregar versões para revisar</Button></Notice>}
  </OperationDialog>;
}
