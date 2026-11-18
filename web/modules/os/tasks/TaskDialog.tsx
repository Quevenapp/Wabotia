import React, { useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { Field } from "../../../ui";
import { AssigneeField } from "../components/AssigneeField";
import { ConflictRecovery, useConflictRecovery } from "../components/ConflictRecovery";
import { findWorkChild } from "../work-api";
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
  const recovery = useConflictRecovery(initial, async () => ({
    record: await findWorkChild((cursor) => api.tasks(workId, { cursor, limit: 100 }), initial!.id),
  }));
  const current = recovery.latest?.record;
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
      disabled={recovery.conflict}
      onSubmit={async () => {
        const body = {
          ...draft,
          sensitive: !!recovery.base?.sensitive || draft.sensitive,
          due_at: dateTimeValue(due),
          remind_at: dateTimeValue(remind),
        };
        assertVisibility(body);
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
        await recovery.run(async () => {
          if (recovery.base)
            await api.updateTask(workId, recovery.base.id, {
              ...body,
              version: recovery.base.version,
            }, recovery.base.sensitive);
          else await api.createTask(workId, body);
        });
        setDirty(false);
        onSaved();
      }}
    >
      <ConflictRecovery recovery={recovery}>
        {current && <dl>
          <dt>Título e descrição atuais</dt><dd>{current.title} · {current.description}</dd>
          <dt>Responsável / situação</dt><dd>{current.assignee || "Sem responsável"} · {current.state}</dd>
          <dt>Vencimento / aviso</dt><dd>{dateTimeInput(current.due_at)} / {dateTimeInput(current.remind_at)}</dd>
          <dt>Visibilidade</dt><dd>{current.sensitive ? "Restrito" : current.client_visible ? "Cliente" : "Equipe"} · {current.audience}</dd>
        </dl>}
      </ConflictRecovery>
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
        value={{ ...draft, sensitive: !!recovery.base?.sensitive || draft.sensitive }}
        onChange={change}
        lockedSensitive={!!recovery.base?.sensitive}
      />
    </FormDialog>
  );
}
