import React, { useState } from "react";
import { useAction } from "../../../app/hooks";
import { Button, Field } from "../../../ui";
import { ChildCollection } from "../components/ChildCollection";
import type { Task, TaskState } from "../work-contracts";
import { instantLabel, useWorkApi } from "../work-hooks";
import { TaskDialog } from "./TaskDialog";
export const taskStateLabel = {
  open: "Pendente",
  done: "Concluída",
  cancelled: "Cancelada",
};
export function WorkTasksTab({
  workId,
  onChanged,
}: {
  workId: string;
  onChanged: () => void;
}) {
  const api = useWorkApi(),
    action = useAction();
  const [state, setState] = useState(""),
    [editing, setEditing] = useState<Task | "new" | null>(null),
    [revision, setRevision] = useState(0);
  const changed = () => {
    setEditing(null);
    setRevision((n) => n + 1);
    onChanged();
  };
  return (
    <>
      <Field
        label="Situação"
        value={state}
        onChange={setState}
        emptyOption="Todas"
        options={Object.entries(taskStateLabel).map(([id, name]) => ({
          id,
          name,
        }))}
      />
      <ChildCollection<Task>
        key={state}
        workId={workId}
        collection={"tasks/" + state}
        revision={revision}
        load={(cursor) =>
          api.tasks(workId, {
            cursor,
            limit: 50,
            state: state ? (state as TaskState) : undefined,
          })
        }
        create={() => (
          <Button onClick={() => setEditing("new")}>Criar tarefa</Button>
        )}
        render={(task) => (
          <>
            <strong>{task.title}</strong>
            <span>
              {taskStateLabel[task.state]} · {instantLabel(task.due_at)}
            </span>
            <p>{task.description}</p>
            <div className="card-actions">
              <Button secondary onClick={() => setEditing(task)}>
                Editar
              </Button>
              {(["open", "done", "cancelled"] as const)
                .filter((state) => state !== task.state)
                .map((state) => (
                  <Button
                    key={state}
                    secondary
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api.updateTask(workId, task.id, {
                          version: task.version,
                          state,
                        }, task.sensitive);
                        changed();
                      })
                    }
                  >
                    {state === "open"
                      ? "Reabrir"
                      : state === "done"
                        ? "Concluir"
                        : "Cancelar"}
                  </Button>
                ))}
            </div>
          </>
        )}
      />
      {editing && (
        <TaskDialog
          workId={workId}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </>
  );
}
