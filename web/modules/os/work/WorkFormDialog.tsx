import React, { useState } from "react";
import { flushSync } from "react-dom";
import { FormDialog } from "../../../admin/shared";
import { Field, Button, Notice } from "../../../ui";
import type {
  CreateOrderRequest,
  Order,
  WorkTypeView,
} from "../work-contracts";
import {
  ExtraFields,
  commonExtra,
  parseExtra,
} from "../components/ExtraFields";
import { AssigneeField } from "../components/AssigneeField";
import {
  dateTimeInput,
  dateTimeValue,
  useDraftGuard,
  useWorkApi,
} from "../work-hooks";

export function WorkFormDialog({
  type,
  initial,
  conversationId,
  onClose,
  onSaved,
}: {
  type: WorkTypeView;
  initial?: Order;
  conversationId?: string;
  onClose: () => void;
  onSaved: (order: Order) => void;
}) {
  const api = useWorkApi();
  const [base, setBase] = useState(initial);
  const fields = base?.fields || type.fields;
  const labels = base?.labels || type.labels;
  const [draft, setDraft] = useState<CreateOrderRequest>({
    customer_name: initial?.customer.name || "",
    phone: initial?.customer.phone || "",
    item: initial?.item || "",
    problem: initial?.problem || "",
    notes: initial?.notes || "",
    assignee: initial?.assignee || null,
    extra: commonExtra(fields, initial?.extra || {}),
  });
  const [due, setDue] = useState(dateTimeInput(initial?.due_at));
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  const change = <K extends keyof CreateOrderRequest>(
    key: K,
    value: CreateOrderRequest[K],
  ) => {
    setDirty(true);
    setDraft((old) => ({ ...old, [key]: value }));
  };
  const closed = base && ["delivered", "cancelled"].includes(base.status);
  return (
    <FormDialog
      title={`${base ? "Editar" : "Criar"}: ${labels.singular}`}
      onClose={close}
      disabled={conflict}
      onSubmit={async () => {
        try {
          const body = {
            ...draft,
            due_at: dateTimeValue(due),
            extra: parseExtra(fields, draft.extra || {}),
          };
          if (base?.customer.conversation_id || conversationId)
            delete body.phone;
          const saved = base
            ? await api.update(
                base.id,
                closed
                  ? { notes: draft.notes, version: base.version }
                  : { ...body, version: base.version },
              )
            : await api.create({
                ...body,
                type_id: type.id,
                conversation_id: conversationId,
              });
          // Renderiza já sem rascunho: onSaved costuma navegar para o
          // trabalho salvo, e a guarda de navegação lê o estado renderizado.
          flushSync(() => setDirty(false));
          onSaved(saved);
        } catch (error) {
          if ((error as { code?: string }).code === "version_conflict")
            setConflict(true);
          throw error;
        }
      }}
    >
      {conflict && (
        <Notice>
          Rascunho preservado.{" "}
          <Button
            secondary
            onClick={async () => {
              const latest = await api.order(base!.id);
              setBase(latest);
              setConflict(false);
              setReloaded(true);
            }}
          >
            Recarregar versão atual
          </Button>
        </Notice>
      )}
      {reloaded && (
        <Notice>
          Versão atual carregada. Revise seu rascunho antes de substituir os
          campos.
        </Notice>
      )}
      {closed ? (
        <Notice>
          Trabalho encerrado: somente observações internas podem mudar.
        </Notice>
      ) : (
        <>
          <Field
            label={labels.customer_singular}
            value={draft.customer_name}
            onChange={(value) => change("customer_name", value)}
            maxLength={120}
          />
          {!conversationId && (
            <Field
              label="Telefone (WhatsApp)"
              value={draft.phone}
              onChange={(value) => change("phone", value)}
              required={!base}
              disabled={!!base?.customer.conversation_id}
              maxLength={40}
            />
          )}
          <Field
            label={labels.item}
            value={draft.item}
            onChange={(value) => change("item", value)}
            required
            maxLength={200}
          />
          <Field
            label={labels.problem}
            value={draft.problem}
            onChange={(value) => change("problem", value)}
            required
            type="textarea"
            maxLength={2000}
          />
          <ExtraFields
            fields={fields}
            values={draft.extra || {}}
            onChange={(value) => change("extra", value)}
          />
          <AssigneeField
            value={draft.assignee || null}
            onChange={(value) => change("assignee", value || null)}
          />
          <Field
            label="Prazo geral · horário de Brasília"
            type="datetime-local"
            value={due}
            onChange={(value) => {
              setDirty(true);
              setDue(value);
            }}
          />
        </>
      )}
      <Field
        label="Observações internas"
        value={draft.notes}
        onChange={(value) => change("notes", value)}
        type="textarea"
        maxLength={4000}
      />
    </FormDialog>
  );
}
