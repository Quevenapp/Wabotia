import React, { useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { Field } from "../../../ui";
import { AssigneeField } from "../components/AssigneeField";
import {
  VisibilityFields,
  assertVisibility,
} from "../components/ChildCollection";
import type { CreateTaskRequest, Task } from "../work-contracts";
import {
  dateTimeInput,
  dateTimeValue,
  useDraftGuard,
  useWorkApi,
} from "../work-hooks";
export function TaskDialog({
  workId,
  initial,
  onClose,
  onSaved,
}: {
  workId: string;
  initial?: Task;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  const [draft, setDraft] = useState<CreateTaskRequest>({
    title: initial?.title || "",
    description: initial?.description || "",
    assignee: initial?.assignee || null,
    audience: initial?.audience || "staff",
    client_visible: initial?.client_visible || false,
    sensitive: initial?.sensitive || false,
  });
  const [due, setDue] = useState(dateTimeInput(initial?.due_at)),
    [remind, setRemind] = useState(dateTimeInput(initial?.remind_at));
  const [dirty, setDirty] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  const change = (patch: Partial<CreateTaskRequest>) => {
    setDirty(true);
    setDraft((old) => ({ ...old, ...patch }));
  };
  return (
    <FormDialog
      title={initial ? "Editar tarefa" : "Criar tarefa"}
      onClose={close}
      onSubmit={async () => {
        assertVisibility(draft);
        const body = {
          ...draft,
          due_at: dateTimeValue(due),
          remind_at: dateTimeValue(remind),
        };
        if (
          body.remind_at != null &&
          (body.due_at == null || body.remind_at > body.due_at)
        )
          throw new Error("O aviso precisa ocorrer até o vencimento.");
        if (
          body.audience === "customer" &&
          (!body.client_visible || body.sensitive)
        )
          throw new Error(
            "Uma tarefa do cliente precisa ser visível e não sensível.",
          );
        if (initial)
          await api.updateTask(workId, initial.id, {
            ...body,
            version: initial.version,
          });
        else await api.createTask(workId, body);
        setDirty(false);
        onSaved();
      }}
    >
      <Field
        label="Título"
        value={draft.title}
        onChange={(title) => change({ title })}
        required
        maxLength={160}
      />
      <Field
        label="Descrição"
        value={draft.description}
        onChange={(description) => change({ description })}
        type="textarea"
        maxLength={4000}
      />
      <AssigneeField
        value={draft.assignee || null}
        onChange={(assignee) => change({ assignee: assignee || null })}
      />
      <Field
        label="Destinatário"
        value={draft.audience}
        emptyOption={null}
        options={[
          { id: "staff", name: "Equipe" },
          { id: "customer", name: "Cliente" },
        ]}
        onChange={(audience) =>
          change({ audience: audience as "staff" | "customer" })
        }
      />
      <Field
        label="Vencimento · horário de Brasília"
        type="datetime-local"
        value={due}
        onChange={(value) => {
          setDirty(true);
          setDue(value);
        }}
      />
      <Field
        label="Aviso · horário de Brasília"
        type="datetime-local"
        value={remind}
        onChange={(value) => {
          setDirty(true);
          setRemind(value);
        }}
      />
      <VisibilityFields
        value={draft}
        onChange={change}
        lockedSensitive={!!initial?.sensitive}
      />
    </FormDialog>
  );
}
